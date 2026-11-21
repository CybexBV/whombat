/**
 * The burrow's one “now” for time labels (AP-900). Pure (no React Native imports) so it is unit-tested in Node.
 *
 * The labels need nothing finer than a minute: `just now` under a minute, then the clock (`09:13`), the day, `12 min
 * ago`. So the clock is read in 15-second steps, rounded up — never earlier than the clock, so what was just sent reads
 * `just now`, not its time — and one timer moves it for every screen at once. Between steps it is the same `Date`, so
 * view models memoised on it rebuild four times a minute, not on every render. (Before: every reader ran its own
 * 30-second timer and read the clock at render time, to the second, so any later render rebuilt its view models.)
 */

/** How often `now` moves. */
export const NOW_STEP_MS = 15_000;

/** `ms` rounded up to the step. */
export function stepUp(ms: number, step: number = NOW_STEP_MS): number {
  return Math.ceil(ms / step) * step;
}

/** A store for `useSyncExternalStore`: `get` is the same object until the next step. */
export interface NowStore {
  get(): Date;
  subscribe(listener: () => void): () => void;
}

export interface NowTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const TIMERS: NowTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One timer while someone reads it, none while nobody does (it catches up when someone does again). */
export function createNowStore(
  clock: () => Date,
  step: number = NOW_STEP_MS,
  timers: NowTimers = TIMERS,
): NowStore {
  let now = new Date(stepUp(clock().getTime(), step));
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  const refresh = (): boolean => {
    const next = stepUp(clock().getTime(), step);
    if (next === now.getTime()) return false;
    now = new Date(next);
    return true;
  };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const schedule = () => {
    // Just past the step `now` stands at: from there it rounds up to the next one.
    timer = timers.set(
      () => {
        timer = null;
        if (refresh()) notify();
        if (listeners.size) schedule();
      },
      Math.max(0, now.getTime() - clock().getTime()) + 1,
    );
  };
  return {
    get: () => now,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        if (refresh()) notify();
        schedule();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size || timer === null) return;
        timers.clear(timer);
        timer = null;
      };
    },
  };
}
