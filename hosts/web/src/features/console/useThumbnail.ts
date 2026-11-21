// Live thumbnails for the Screens wall (C8, REMOTE-CONSOLE 6.8 / 10):
// refreshed about every 5 s, only while the tile is in the viewport and the
// tab is visible, one request in flight per tile, object URLs revoked when
// replaced or unmounted.

import { useQueryClient } from '@tanstack/react-query';
import { type RefObject, useEffect, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from '../../api/client';
import { t } from '../../lib/i18n';

export const THUMB_REFRESH_MS = 5_000;
const RETRY_MS = 10_000;
const RATE_LIMIT_MS = 30_000;

export type ThumbState =
  | { kind: 'loading' }
  | { kind: 'image'; url: string; stale: boolean }
  | { kind: 'no_screen' }
  | { kind: 'stopped' }
  | { kind: 'denied'; reason: string }
  | { kind: 'error'; message: string };

function subscribeVisibility(fn: () => void): () => void {
  document.addEventListener('visibilitychange', fn);
  return () => document.removeEventListener('visibilitychange', fn);
}

/** True while the document is visible (not a background tab). */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

/** True while the element intersects the viewport (with a small margin). */
export function useInViewport(ref: RefObject<Element | null>, margin = '100px'): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
  return visible;
}

interface Options {
  serverId: string;
  guestId: string;
  /** False for stopped guests and without console permission: nothing is requested. */
  enabled: boolean;
  /** Tile in the viewport and the tab visible. */
  visible: boolean;
}

export function useThumbnail({ serverId, guestId, enabled, visible }: Options): ThumbState {
  const qc = useQueryClient();
  const [state, setState] = useState<ThumbState>({ kind: 'loading' });
  // Terminal answers (no screen, stopped, denied) stop the polling until the inputs change.
  const [final, setFinal] = useState(false);

  useEffect(() => {
    setState({ kind: 'loading' });
    setFinal(false);
  }, [serverId, guestId, enabled]);

  useEffect(() => {
    if (!enabled || !visible || final) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ctrl: AbortController | null = null;
    const schedule = (ms: number) => {
      if (!stopped) timer = setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      ctrl = new AbortController();
      try {
        const blob = await api.thumbnail(serverId, guestId, ctrl.signal);
        if (stopped) return;
        setState({ kind: 'image', url: URL.createObjectURL(blob), stale: false });
        schedule(THUMB_REFRESH_MS);
      } catch (err) {
        if (stopped || (err instanceof DOMException && err.name === 'AbortError')) return;
        if (err instanceof ApiError) {
          if (err.status === 404 && (err.code === 'no_screen' || !err.code)) {
            setState({ kind: 'no_screen' });
            setFinal(true);
            return;
          }
          if (err.status === 409 && err.code === 'guest_not_running') {
            setState({ kind: 'stopped' });
            setFinal(true);
            void qc.invalidateQueries({ queryKey: ['server', serverId] });
            void qc.invalidateQueries({ queryKey: ['guests', serverId] });
            return;
          }
          if (err.status === 403 || err.status === 401) {
            setState({ kind: 'denied', reason: err.message || t('Requires the console permission') });
            setFinal(true);
            return;
          }
          if (err.status === 429) {
            setState((s) => (s.kind === 'image' ? { ...s, stale: true } : s));
            schedule(RATE_LIMIT_MS);
            return;
          }
        }
        const message = err instanceof Error ? err.message : 'Thumbnail unavailable';
        setState((s) => (s.kind === 'image' ? { ...s, stale: true } : { kind: 'error', message }));
        schedule(RETRY_MS);
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ctrl?.abort();
    };
  }, [serverId, guestId, enabled, visible, final, qc]);

  // Revoke each object URL once it has been replaced, and on unmount.
  const url = state.kind === 'image' ? state.url : null;
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return state;
}
