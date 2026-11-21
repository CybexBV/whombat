import { describe, expect, it, vi } from 'vitest';

// A word moved to the retired list stays valid in labels already issued, and is never drawn again.
vi.mock('./words.js', () => ({
  OWN_ADDRESS_WORDS: Object.freeze(['apple', 'berry', 'cedar']),
  OWN_ADDRESS_WORDS_RETIRED: Object.freeze(['delta']),
}));

describe('retired words', () => {
  it('are accepted in a label but never drawn', async () => {
    const { drawOwnAddressLabel, isOwnAddressLabel } = await import('./label.js');
    expect(isOwnAddressLabel('apple-delta-cedar')).toBe(true);
    expect(isOwnAddressLabel('apple-delta-delta')).toBe(false);
    let calls = 0;
    const label = drawOwnAddressLabel((n) => {
      calls += 1;
      return n - 1;
    });
    expect(calls).toBe(3);
    expect(label.split('-').sort()).toEqual(['apple', 'berry', 'cedar']);
  });
});
