import { describe, expect, it } from 'vitest';
import { burnIn, DIM_AFTER_MS, DRIFT_EVERY_MS, DRIFT_PATH, driftAt } from './burnin';

describe('burnIn', () => {
  it('stays bright and still for 10 minutes', () => {
    expect(burnIn(0, true)).toEqual({ dimmed: false, x: 0, y: 0 });
    expect(burnIn(DIM_AFTER_MS - 1, true)).toEqual({ dimmed: false, x: 0, y: 0 });
  });

  it('dims after 10 minutes and moves every minute', () => {
    const a = burnIn(DIM_AFTER_MS, true);
    const b = burnIn(DIM_AFTER_MS + DRIFT_EVERY_MS, true);
    const b2 = burnIn(DIM_AFTER_MS + DRIFT_EVERY_MS + 59_000, true);
    expect(a.dimmed).toBe(true);
    expect([a.x, a.y]).not.toEqual([b.x, b.y]);
    expect(b).toEqual(b2);
  });

  it('never drifts more than a few pixels and loops', () => {
    for (const [x, y] of DRIFT_PATH) expect(Math.hypot(x, y)).toBeLessThanOrEqual(7);
    const loop = DRIFT_PATH.length * DRIFT_EVERY_MS;
    expect(burnIn(DIM_AFTER_MS + loop + 1, true)).toEqual(burnIn(DIM_AFTER_MS + 1, true));
  });

  it('never applies where it isn’t active (the celebration, the installer)', () => {
    expect(burnIn(DIM_AFTER_MS * 5, false)).toEqual({ dimmed: false, x: 0, y: 0 });
  });
});

describe('driftAt (the idle clock, DK-70)', () => {
  it('starts in place, takes a step every minute and goes round the loop', () => {
    expect(driftAt(0)).toEqual({ x: 0, y: 0 });
    expect(driftAt(DRIFT_EVERY_MS - 1)).toEqual({ x: 0, y: 0 });
    const [x, y] = DRIFT_PATH[1] ?? [];
    expect(driftAt(DRIFT_EVERY_MS)).toEqual({ x, y });
    expect(driftAt(DRIFT_PATH.length * DRIFT_EVERY_MS)).toEqual({ x: 0, y: 0 });
    expect(driftAt(-5)).toEqual({ x: 0, y: 0 });
  });
});
