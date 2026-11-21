import { describe, expect, it } from 'vitest';
import { judge, type SoakSample } from './soak-rss.ts';

const series = (
  rss: (n: number) => number,
  pids: (n: number) => number[] = () => [10, 11],
  n = 40,
): SoakSample[] =>
  Array.from({ length: n }, (_, i) => ({
    t: i * 15_000,
    rss: { runtime: rss(i) },
    pids: { runtime: pids(i) },
  }));

describe('soak verdict', () => {
  it('flat memory passes', () => {
    const v = judge(
      series(() => 300),
      60_000,
    );
    expect(v.services.runtime?.verdict).toBe('ok');
  });
  it('sustained growth fails', () => {
    const v = judge(
      series((i) => 300 + i * 10),
      60_000,
    );
    expect(v.services.runtime?.verdict).toBe('growth');
    expect(v.ok).toBe(false);
  });
  it('a restart fails', () => {
    const v = judge(
      series(
        () => 300,
        (i) => (i < 20 ? [10, 11] : [20, 21]),
      ),
      60_000,
    );
    expect(v.services.runtime?.verdict).toBe('restarted');
  });
});
