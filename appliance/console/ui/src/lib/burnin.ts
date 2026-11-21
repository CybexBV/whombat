/**
 * Burn-in protection (CG-09) on the non-interactive screens: after `DIM_AFTER_MS` without a key press the
 * screen dims to about 40 % (a dark overlay) and the content moves a few pixels every minute, around a small loop; any key wakes it.
 */
export const DIM_AFTER_MS = 10 * 60_000;
export const DRIFT_EVERY_MS = 60_000;

/** A loop of offsets (px), never more than 6 px from the centre, each step a small move. */
export const DRIFT_PATH: readonly (readonly [number, number])[] = [
  [0, 0],
  [4, -2],
  [6, 3],
  [2, 6],
  [-3, 5],
  [-6, 1],
  [-4, -4],
  [1, -6],
];

export interface BurnIn {
  dimmed: boolean;
  x: number;
  y: number;
}

/** The offset `ms` into a drift: a step along `DRIFT_PATH` every minute, round the loop. */
export function driftAt(ms: number): { x: number; y: number } {
  const step = Math.floor(Math.max(0, ms) / DRIFT_EVERY_MS) % DRIFT_PATH.length;
  const [x, y] = DRIFT_PATH[step] ?? [0, 0];
  return { x, y };
}

/** The burn-in state `idleMs` after the last key press, on a screen where it applies (`active`). */
export function burnIn(idleMs: number, active: boolean): BurnIn {
  if (!active || idleMs < DIM_AFTER_MS) return { dimmed: false, x: 0, y: 0 };
  return { dimmed: true, ...driftAt(idleMs - DIM_AFTER_MS) };
}
