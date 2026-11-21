/**
 * “How it’s doing”, live while it is on screen (Whombat box-status.md BS-08; app docs/decisions/box-status.md AP-1136):
 * `host.metrics` every 10 seconds with `since` (only the new points, merged into the range), the whole range again when
 * the range changes, and `spend.daily` with `spend.overview` on open and every 5 minutes. Nothing runs while the
 * screen says it isn't active (the section scrolled away, the tab or the app in the background). UI-free: the web wraps
 * it in a hook, Android in its screen; state is replaced on every change (`useSyncExternalStore`).
 */
import type { SpendDaily, SpendOverview } from '@whombat/core/domain';
import {
  HOST_SAMPLE_INTERVAL_S,
  type HostMetrics,
  type HostMetricsOutput,
  type HostMetricsRange,
} from '@whombat/protocol/session';
import { type HostMetricsLoader, hostSince, mergeHostMetrics } from './model';

/** How often a live view asks for new points (the manager's sampling interval). */
export const HOST_POLL_MS = HOST_SAMPLE_INTERVAL_S * 1000;
/** How often the Tokens card reads spend again. */
export const HOST_SPEND_POLL_MS = 5 * 60_000;
/** Polls in a row that may fail before the section says the measurements can't be read (a manager restarting). */
export const HOST_POLL_TOLERANCE = 2;
/** The range the section opens with (the mock's). */
export const HOST_DEFAULT_RANGE: HostMetricsRange = 'day';

/** What the Tokens card reads; either may be missing (null) when it failed. */
export interface HostSpend {
  daily: SpendDaily | null;
  overview: SpendOverview | null;
}

export interface HostPollState {
  /** The range picked (the charts may still show the previous one while it loads: `metrics.series.range`). */
  range: HostMetricsRange;
  /** What the box parts show; null with a `reason`, or before the first answer. */
  metrics: HostMetrics | null;
  /** `not_managed`: Tokens only. `unavailable`: the sentence instead of the box parts (also when asking failed). */
  reason: HostMetricsOutput['reason'];
  /** A whole range is being fetched (the first time, or another range): the frame stays, dimmed. */
  loading: boolean;
  spend: HostSpend;
  /** Spend was asked for and couldn't be read (what was read before stays). */
  spendFailed: boolean;
}

export interface HostPollerOptions {
  /** `hostMetricsLoader(session)`: null on a self-hosted server (no manager; never asked). */
  loadMetrics: HostMetricsLoader | null;
  loadSpend: () => Promise<HostSpend>;
  range?: HostMetricsRange;
  /** Tests: other intervals and timers. */
  pollMs?: number;
  spendPollMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface HostPoller {
  getState(): HostPollState;
  subscribe(listener: () => void): () => void;
  /** Another range: fetched whole at once while active, else when it next becomes active. */
  setRange(range: HostMetricsRange): void;
  /** On screen and visible (start, or catch up and go on) or not (stop asking). */
  setActive(active: boolean): void;
  dispose(): void;
}

export function createHostPoller(options: HostPollerOptions): HostPoller {
  const pollMs = options.pollMs ?? HOST_POLL_MS;
  const spendPollMs = options.spendPollMs ?? HOST_SPEND_POLL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const load = options.loadMetrics;

  let state: HostPollState = {
    range: options.range ?? HOST_DEFAULT_RANGE,
    metrics: null,
    reason: load ? null : 'not_managed',
    loading: load !== null,
    spend: { daily: null, overview: null },
    spendFailed: false,
  };
  const listeners = new Set<() => void>();
  let active = false;
  let disposed = false;
  /** Bumped by every new range: an answer for an older one is dropped. */
  let generation = 0;
  /** The generation whose request is under way (one at a time). */
  let asking: number | null = null;
  let failures = 0;
  let metricsTimer: unknown = null;
  let spendTimer: unknown = null;
  let spendAt: number | null = null;
  let spendAsking = false;

  const set = (patch: Partial<HostPollState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  const stopMetrics = () => {
    if (metricsTimer !== null) clearTimer(metricsTimer);
    metricsTimer = null;
  };
  const stopSpend = () => {
    if (spendTimer !== null) clearTimer(spendTimer);
    spendTimer = null;
  };

  const scheduleMetrics = () => {
    stopMetrics();
    if (active && !disposed && load) metricsTimer = setTimer(askMetrics, pollMs);
  };

  function askMetrics() {
    metricsTimer = null;
    if (!load || disposed || asking === generation) return;
    const mine = generation;
    const range = state.range;
    const shown = state.metrics;
    // The range on screen and its points: only what is new. Otherwise (first time, another range, after it couldn't be
    // read): the whole range.
    const live = shown !== null && shown.series.range === range;
    if (!live && !state.loading && state.reason === null) set({ loading: true });
    asking = mine;
    load(live && shown ? { range, since: hostSince(shown.series) } : { range }).then(
      (out) => {
        if (mine !== generation || disposed) return;
        asking = null;
        if (out.metrics) {
          failures = 0;
          const current = state.metrics;
          set({
            metrics:
              live && current && current.series.range === range
                ? mergeHostMetrics(current, out.metrics)
                : out.metrics,
            reason: null,
            loading: false,
          });
        } else if (out.reason === 'not_managed') {
          set({ metrics: null, reason: 'not_managed', loading: false });
          return; // nothing more to ask
        } else failed(live);
        scheduleMetrics();
      },
      () => {
        if (mine !== generation || disposed) return;
        asking = null;
        failed(live);
        scheduleMetrics();
      },
    );
  }

  /** A poll that couldn't be read keeps the frame a little while; a whole range that couldn't says so at once. */
  function failed(live: boolean) {
    failures += 1;
    if (live && failures <= HOST_POLL_TOLERANCE) return;
    set({ metrics: null, reason: 'unavailable', loading: false });
  }

  const scheduleSpend = () => {
    stopSpend();
    if (!active || disposed) return;
    const due = spendAt === null ? 0 : Math.max(0, spendAt + spendPollMs - now());
    spendTimer = setTimer(askSpend, due);
  };

  function askSpend() {
    spendTimer = null;
    if (disposed || spendAsking) return;
    spendAsking = true;
    options.loadSpend().then(
      (spend) => {
        spendAsking = false;
        spendAt = now();
        if (disposed) return;
        set({
          spend: {
            daily: spend.daily ?? state.spend.daily,
            overview: spend.overview ?? state.spend.overview,
          },
          spendFailed: spend.daily === null && spend.overview === null,
        });
        scheduleSpend();
      },
      () => {
        spendAsking = false;
        spendAt = now();
        if (disposed) return;
        set({ spendFailed: true });
        scheduleSpend();
      },
    );
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setRange(range) {
      if (disposed || range === state.range) return;
      generation += 1;
      asking = null;
      failures = 0;
      // The previous range stays on screen, dimmed, until the new one is in (no empty frame in between).
      set({ range, loading: load !== null && state.reason !== 'not_managed' });
      stopMetrics();
      if (active) askMetrics();
    },
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      if (!active) {
        stopMetrics();
        stopSpend();
        return;
      }
      if (state.reason !== 'not_managed') askMetrics();
      scheduleSpend();
    },
    dispose() {
      disposed = true;
      active = false;
      stopMetrics();
      stopSpend();
      listeners.clear();
    },
  };
}
