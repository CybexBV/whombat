import { afterEach, beforeEach, vi } from 'vitest';

/** The mock world's moment: Wednesday 23 September 2026, 11:22 in Amsterdam. */
export const MOCK_NOW = new Date('2026-09-23T09:22:00.000Z');

/**
 * Pins `Date` (only `Date`: timers stay real, so Testing Library's waits work) to the mock's moment for every
 * test in the file, so copy that is relative to today (“Today · Wednesday 23 September”, “approved 11:38”)
 * does not depend on the day the suite runs.
 */
export function pinMockDate(now: Date = MOCK_NOW): void {
  beforeEach(() => {
    vi.useFakeTimers({ now, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
