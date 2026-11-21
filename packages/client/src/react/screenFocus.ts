/**
 * Whether the screen a read is on is in view, for apps that keep screens mounted out of view (the phone's tabs and
 * the pages under the top one). A read on a screen out of view isn't fetched again for a realtime frame, on coming back
 * to the app or on getting online: realtime still patches what it holds, and when the screen shows again it reads
 * once more only what went out of date meanwhile (invalidated, failed, or never read). Without a provider (the web) a
 * read is always in view and nothing changes.
 *
 * Out of view counts through `enabled`, read when TanStack Query asks (a function, so it needs no render: a screen
 * out of view may not render at all), rather than `subscribed: false`: that would let the cache drop the screen's data
 * after a few minutes out of view and read everything again on every return.
 */
import { hashKey, type Query, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';

export interface ScreenFocus {
  /** True while the screen is in view (and every screen it is drawn inside). */
  shown(): boolean;
  /** Called after `shown()` may have changed. */
  subscribe(listener: () => void): () => void;
}

export interface ScreenFocusSource extends ScreenFocus {
  /** Ask again whether the screen is in view (after a navigation event); listeners hear of a change. */
  update(): void;
  /** Follow the screen it is drawn inside: an update whenever that one changes. */
  follow(): () => void;
}

/**
 * A screen's focus: its own `inView()` and, inside another screen (a tab inside the tabs' page), that one's. Updated by
 * the caller from navigation events (`update`), never from a render.
 */
export function createScreenFocus(
  inView: () => boolean,
  parent: ScreenFocus | null = null,
): ScreenFocusSource {
  const listeners = new Set<() => void>();
  const compute = () => inView() && (parent ? parent.shown() : true);
  let shown = compute();
  const update = () => {
    const next = compute();
    if (next === shown) return;
    shown = next;
    for (const l of [...listeners]) l();
  };
  return {
    shown: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update,
    follow: () => {
      const off = parent?.subscribe(update);
      update();
      return () => off?.();
    },
  };
}

export const ScreenFocusContext = createContext<ScreenFocus | null>(null);

// biome-ignore lint/suspicious/noExplicitAny: any query's `enabled`
type AnyQuery = Query<any, any, any, any>;
type Enabled = boolean | ((query: AnyQuery) => boolean) | undefined;

/**
 * The `enabled` a read hook passes on: off while its screen is out of view, the caller's own otherwise. Coming into
 * view again, its read is fetched if it went out of date meanwhile. Undefined (the caller's own) without a screen.
 */
export function useScreenFocusEnabled<E extends Enabled>(enabled: E, queryKey: QueryKey): E {
  const focus = useContext(ScreenFocusContext);
  const qc = useQueryClient();
  const key = useRef(queryKey);
  key.current = queryKey;
  const hash = hashKey(queryKey);
  // A new function when the caller's own `enabled` changes: TanStack Query sees the change and fetches if it should.
  const gated = useMemo(
    () =>
      focus
        ? (query: AnyQuery) =>
            focus.shown() && (typeof enabled === 'function' ? enabled(query) : enabled) !== false
        : undefined,
    [focus, enabled],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `hash` stands for the key (a new array of the same key is the same read); another key is another read, mounted anew.
  useEffect(() => {
    if (!focus) return;
    let was = focus.shown();
    // Drawn out of view (the tabs under a page restored at start): what mounting would have read, read when it shows.
    let owedSince = was ? null : Date.now();
    return focus.subscribe(() => {
      const now = focus.shown();
      if (now && !was) {
        catchUp(qc, key.current, owedSince);
        owedSince = null;
      }
      was = now;
    });
  }, [focus, qc, hash]);
  return (gated ?? enabled) as E;
}

/**
 * A read in view again: fetched if it went out of date while it wasn't, or if it was drawn out of view and hasn't been
 * read since (`owedSince`). One fetch for every hook on it.
 */
function catchUp(qc: ReturnType<typeof useQueryClient>, queryKey: QueryKey, owedSince: number | null) {
  const state = qc.getQueryState(queryKey);
  if (state?.fetchStatus !== 'idle') return;
  const owed = owedSince !== null && state.dataUpdatedAt < owedSince;
  if (!owed && !state.isInvalidated && state.status !== 'error' && state.data !== undefined) return;
  void qc.refetchQueries({ queryKey, exact: true, type: 'active' }, { cancelRefetch: false });
}
