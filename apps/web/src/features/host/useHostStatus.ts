/**
 * “How it’s doing”, live while it can be seen (Whombat box-status.md BS-08; app docs/decisions/box-status.md AP-1136,
 * AP-1137): the client's poller (`createHostPoller`) over this Whombat's `host.metrics` (`AppServices.hostMetrics`:
 * none without a manager); what the AI used is Spend's, in Settings → Advanced. Active
 * only while the section is on screen (IntersectionObserver) and the tab is visible (visibilitychange).
 */
import {
  createHostPoller,
  HOST_DEFAULT_RANGE,
  type HostPoller,
  type HostPollState,
  type HostSpend,
} from '@whombat/client';
import type { HostMetricsRange } from '@whombat/protocol/session';
import { type RefObject, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAppServices } from '../../app/providers';

const IDLE: HostPollState = {
  range: HOST_DEFAULT_RANGE,
  metrics: null,
  reason: null,
  loading: true,
  spend: { daily: null, overview: null },
  spendFailed: false,
};

const noop = () => () => {};

/** Whether `ref` is on screen and the page visible (true where the browser can't tell, as in tests). */
function useSeen(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last) setInView(last.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return inView && visible;
}

export function useHostStatus(burrow: string, ref: RefObject<HTMLElement | null>) {
  const { hostMetrics } = useAppServices();
  const [poller, setPoller] = useState<HostPoller | null>(null);
  const range = useRef<HostMetricsRange>(HOST_DEFAULT_RANGE);
  const seen = useSeen(ref);
  // Before the poller is made: what it will start with (no box on a self-hosted server).
  const idle = useMemo<HostPollState>(
    () => ({ ...IDLE, reason: hostMetrics ? null : 'not_managed', loading: hostMetrics !== null }),
    [hostMetrics],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: another Whombat starts a poller of its own
  useEffect(() => {
    const p = createHostPoller({
      loadMetrics: hostMetrics,
      range: range.current,
      // What the AI used is Spend's (Settings → Advanced); this section shows the machine.
      loadSpend: async (): Promise<HostSpend> => ({ daily: null, overview: null }),
    });
    setPoller(p);
    return () => p.dispose();
  }, [burrow, hostMetrics]);

  useEffect(() => {
    poller?.setActive(seen);
  }, [poller, seen]);

  const state = useSyncExternalStore(
    poller ? poller.subscribe : noop,
    poller ? poller.getState : () => idle,
    () => idle,
  );
  return {
    state,
    setRange: (next: HostMetricsRange) => {
      range.current = next;
      poller?.setRange(next);
    },
  };
}
