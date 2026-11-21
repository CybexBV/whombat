import { describe, expect, it } from 'vitest';
import { backoffDelay } from './realtime';

describe('backoffDelay', () => {
  it('grows exponentially up to the cap with jitter in the upper half', () => {
    expect(backoffDelay(0, {}, () => 0)).toBe(250);
    expect(backoffDelay(0, {}, () => 1)).toBe(500);
    expect(backoffDelay(3, {}, () => 1)).toBe(4000);
    expect(backoffDelay(20, {}, () => 1)).toBe(30_000);
    expect(backoffDelay(20, { maxMs: 10_000 }, () => 0.5)).toBe(7500);
  });
});
