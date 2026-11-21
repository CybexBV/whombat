import { describe, expect, it } from 'vitest';
import {
  drawOwnAddressLabel,
  isOwnAddressLabel,
  OWN_ADDRESS_WORDS,
  OWN_ADDRESS_WORDS_RETIRED,
} from './index.js';

/** A seeded source of uniform integers (mulberry32, rejection-free modulo is fine for a test's chi-square). */
function seeded(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const u = ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    return Math.floor(u * n);
  };
}

// The list's source and recorded hash are checked in contracts/conformance/src/own-address.test.ts (it reads files).
describe('the word list', () => {
  it('has 996 sorted, unique words of 3–10 lower-case letters with unique three-letter prefixes', () => {
    expect(OWN_ADDRESS_WORDS).toHaveLength(996);
    for (const w of OWN_ADDRESS_WORDS) expect(w).toMatch(/^[a-z]{3,10}$/);
    expect([...OWN_ADDRESS_WORDS].sort()).toEqual(OWN_ADDRESS_WORDS);
    expect(new Set(OWN_ADDRESS_WORDS.map((w) => w.slice(0, 3))).size).toBe(OWN_ADDRESS_WORDS.length);
    expect(OWN_ADDRESS_WORDS_RETIRED).toEqual([]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(OWN_ADDRESS_WORDS)).toBe(true);
    expect(Object.isFrozen(OWN_ADDRESS_WORDS_RETIRED)).toBe(true);
  });
});

describe('drawOwnAddressLabel', () => {
  it('draws three different listed words', () => {
    const random = seeded(7);
    for (let i = 0; i < 5_000; i++) {
      const label = drawOwnAddressLabel(random);
      expect(isOwnAddressLabel(label), label).toBe(true);
    }
  });

  it('draws three different words even when the source repeats itself', () => {
    expect(drawOwnAddressLabel(() => 0)).toBe(
      `${OWN_ADDRESS_WORDS[0]}-${OWN_ADDRESS_WORDS[1]}-${OWN_ADDRESS_WORDS[2]}`,
    );
    const last = OWN_ADDRESS_WORDS.length - 1;
    expect(drawOwnAddressLabel((n) => n - 1)).toBe(
      `${OWN_ADDRESS_WORDS[last]}-${OWN_ADDRESS_WORDS[last - 1]}-${OWN_ADDRESS_WORDS[last - 2]}`,
    );
  });

  it('draws the first word uniformly (chi-square over 100,000 draws)', () => {
    const random = seeded(42);
    const n = OWN_ADDRESS_WORDS.length;
    const index = new Map(OWN_ADDRESS_WORDS.map((w, i) => [w, i]));
    const counts = new Array<number>(n).fill(0);
    const draws = 100_000;
    for (let i = 0; i < draws; i++) {
      const first = drawOwnAddressLabel(random).split('-')[0] as string;
      const at = index.get(first) as number;
      counts[at] = (counts[at] ?? 0) + 1;
    }
    const expected = draws / n;
    const chi2 = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    // 995 degrees of freedom: mean 995, standard deviation about 44.6; this bound is about 5 deviations out.
    expect(chi2).toBeLessThan(1_220);
  });

  it('refuses a source that answers outside [0, n)', () => {
    expect(() => drawOwnAddressLabel((n) => n)).toThrow();
    expect(() => drawOwnAddressLabel(() => -1)).toThrow();
    expect(() => drawOwnAddressLabel(() => 0.5)).toThrow();
  });
});

describe('isOwnAddressLabel', () => {
  const [a, b, c, d] = OWN_ADDRESS_WORDS as [string, string, string, string];

  it('accepts three different listed words', () => {
    expect(isOwnAddressLabel(`${a}-${b}-${c}`)).toBe(true);
  });

  it('refuses a repeated word, an unlisted word, upper case, two or four words', () => {
    expect(isOwnAddressLabel(`${a}-${a}-${b}`)).toBe(false);
    expect(isOwnAddressLabel(`${a}-${b}-${a}`)).toBe(false);
    expect(isOwnAddressLabel(`${a}-${b}-zombie`)).toBe(false);
    expect(isOwnAddressLabel(`${a.toUpperCase()}-${b}-${c}`)).toBe(false);
    expect(isOwnAddressLabel(`${a}-${b}`)).toBe(false);
    expect(isOwnAddressLabel(`${a}-${b}-${c}-${d}`)).toBe(false);
    expect(isOwnAddressLabel(` ${a}-${b}-${c}`)).toBe(false);
  });
});
