import { describe, expect, it } from 'vitest';
import { ELDER_POSES, elderSvg } from './elders';

const ids = (svg: string) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const refs = (svg: string) => [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);

describe('the council’s elders', () => {
  it('draws every pose of every seat with its own ids, each one it uses defined', () => {
    for (const pose of ELDER_POSES)
      for (const seat of [0, 1, 2, 3, 4]) {
        const svg = elderSvg({ seat, pose, idPrefix: `c1-${seat}` });
        expect(svg.startsWith('<svg')).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
        expect(ids(svg).every((id) => id?.startsWith(`c1-${seat}`))).toBe(true);
        for (const ref of refs(svg)) expect(ids(svg)).toContain(ref);
      }
  });

  it('keeps two elders on one page apart', () => {
    const a = ids(elderSvg({ seat: 0, pose: 'answered', idPrefix: 'a' }));
    const b = ids(elderSvg({ seat: 0, pose: 'answered', idPrefix: 'b' }));
    expect(a.some((id) => b.includes(id))).toBe(false);
  });

  it('shows how each one is doing: thinking dots, a sleeper’s z, a scroll once it answered', () => {
    const svg = (pose: (typeof ELDER_POSES)[number]) => elderSvg({ seat: 0, pose, idPrefix: 'x' });
    expect(svg('thinking')).toContain('data-elder="dot3"');
    expect(svg('resting')).toContain('data-elder="z2"');
    for (const pose of ['answered', 'agrees', 'doubts'] as const) expect(svg(pose)).toContain('#a8463a');
    expect(svg('thinking')).not.toContain('#a8463a');
    // Waiting: awake, with neither dots, z nor scroll.
    expect(svg('waiting')).not.toMatch(/data-elder="(dot|z)|#a8463a/);
  });

  it('dresses each seat differently and starts again after the fourth', () => {
    const robe = (seat: number) =>
      elderSvg({ seat, pose: 'answered', idPrefix: 'r' })
        .match(/stop-color="(#[0-9a-f]+)"\/><stop offset="\.55"/g)
        ?.at(-1);
    expect(new Set([0, 1, 2, 3].map(robe)).size).toBe(4);
    expect(robe(4)).toBe(robe(0));
  });

  it('keeps the prefix to safe characters', () => {
    expect(
      ids(elderSvg({ seat: 0, pose: 'thinking', idPrefix: 'a"b<c' })).every((id) => id?.startsWith('abc')),
    ).toBe(true);
  });
});
