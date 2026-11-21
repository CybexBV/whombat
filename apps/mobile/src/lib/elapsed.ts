/**
 * When a ticking “so far” time next changes. Pure (no React Native imports) so it is unit-tested in Node.
 *
 * A live run's card says `3m 12s`, then `1h 04m`; a task's `12 s`, then `4 min`. Re-rendering every second only matters
 * while the seconds show: after that the words change once a minute, so the card waits for the next whole minute.
 */
export function nextElapsedTick(elapsedMs: number, secondsShownBelowMs: number): number {
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed < secondsShownBelowMs) return 1000 - (elapsed % 1000);
  return 60_000 - (elapsed % 60_000);
}

/** A run's time shows seconds under an hour (`formatDuration`); a task's under a minute (`formatTaskDuration`). */
export const RUN_SECONDS_BELOW_MS = 60 * 60_000;
export const TASK_SECONDS_BELOW_MS = 60_000;
