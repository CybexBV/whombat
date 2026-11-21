import { describe, expect, it } from 'vitest';
import { nextElapsedTick, RUN_SECONDS_BELOW_MS } from './elapsed';

describe('nextElapsedTick', () => {
  it('ticks on the next whole second while seconds show', () => {
    expect(nextElapsedTick(12_300, RUN_SECONDS_BELOW_MS)).toBe(700);
    expect(nextElapsedTick(0, RUN_SECONDS_BELOW_MS)).toBe(1000);
  });

  it('waits for the next whole minute once only minutes show', () => {
    expect(nextElapsedTick(RUN_SECONDS_BELOW_MS + 15_000, RUN_SECONDS_BELOW_MS)).toBe(45_000);
    expect(nextElapsedTick(2 * 60 * 60_000, RUN_SECONDS_BELOW_MS)).toBe(60_000);
  });

  it('treats a start a little ahead of the clock as just begun', () => {
    expect(nextElapsedTick(-500, RUN_SECONDS_BELOW_MS)).toBe(1000);
  });
});
