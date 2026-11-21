import { describe, expect, it } from 'vitest';
import { FACTS } from '../facts';
import { FactRotation, shuffle } from './facts';

/** A small deterministic generator (mulberry32). */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('FactRotation', () => {
  it('shows every fact once before any repeats', () => {
    const r = new FactRotation(50, seeded(1));
    const round = Array.from({ length: 50 }, () => r.next());
    expect(new Set(round).size).toBe(50);
  });

  it('never shows the same fact twice in a row, across rounds too', () => {
    for (let seed = 0; seed < 200; seed++) {
      const r = new FactRotation(5, seeded(seed));
      let last = -1;
      for (let i = 0; i < 40; i++) {
        const n = r.next();
        expect(n).not.toBe(last);
        last = n;
      }
    }
  });

  it('shuffles differently per start', () => {
    const a = Array.from(
      { length: 10 },
      (
        (r) => () =>
          r.next()
      )(new FactRotation(50, seeded(1))),
    );
    const b = Array.from(
      { length: 10 },
      (
        (r) => () =>
          r.next()
      )(new FactRotation(50, seeded(2))),
    );
    expect(a).not.toEqual(b);
  });

  it('copes with one fact and with none', () => {
    const one = new FactRotation(1, seeded(1));
    expect([one.next(), one.next()]).toEqual([0, 0]);
    expect(new FactRotation(0).next()).toBe(-1);
  });

  it('shuffles a permutation', () => {
    expect([...shuffle(20, seeded(3))].sort((x, y) => x - y)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
  });
});

describe('FACTS', () => {
  it('has 40–60 short facts, each with its source', () => {
    expect(FACTS.length).toBeGreaterThanOrEqual(40);
    expect(FACTS.length).toBeLessThanOrEqual(60);
    for (const f of FACTS) {
      expect(f.text.length, f.text).toBeLessThanOrEqual(160);
      expect(f.source).toMatch(/^https:\/\//);
      expect(f.sourceTitle).not.toBe('');
    }
    expect(new Set(FACTS.map((f) => f.text)).size).toBe(FACTS.length);
  });

  it('leaves out the bushfire myth (CG-10)', () => {
    for (const f of FACTS) expect(f.text).not.toMatch(/shepherd|bushfire|herd/i);
  });
});
