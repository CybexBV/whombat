import { describe, expect, it } from 'vitest';
import { fitTimeTicks } from './fitTimeTicks';

const ticks = ['Sat 09:50', 'Sat 15:50', 'Sat 21:50', 'Sun 03:35', 'Now'].map((label, k) => ({
  index: k * 6,
  label,
}));
const scale = (width: number) => (i: number) => (i / 24) * width;

describe('fitTimeTicks (AP-1867)', () => {
  it('keeps every word where there is room', () => {
    expect(fitTimeTicks(ticks, scale(900)).map((t) => t.label)).toEqual(ticks.map((t) => t.label));
  });

  it('drops words between the ends when they would touch, never the first or the last', () => {
    const x = scale(300);
    const fit = fitTimeTicks(ticks, x);
    expect(fit.map((t) => t.label)).toEqual(['Sat 09:50', 'Sat 21:50', 'Sun 03:35', 'Now']);
    // No two kept words touch, with their anchors as the charts draw them.
    const box = (t: (typeof fit)[number], k: number) => {
      const w = t.label.length * 6.6;
      const at = x(t.index);
      return k === 0 ? [at, at + w] : k === fit.length - 1 ? [at - w, at] : [at - w / 2, at + w / 2];
    };
    for (let k = 1; k < fit.length; k++)
      expect(box(fit[k] as never, k)[0]).toBeGreaterThan(box(fit[k - 1] as never, k - 1)[1] as number);
  });

  it('keeps only the ends on a very narrow chart', () => {
    expect(fitTimeTicks(ticks, scale(150)).map((t) => t.label)).toEqual(['Sat 09:50', 'Now']);
  });

  it('leaves two words or fewer as they are', () => {
    expect(fitTimeTicks(ticks.slice(0, 2), scale(10))).toHaveLength(2);
  });
});
