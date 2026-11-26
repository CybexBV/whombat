import { describe, expect, it } from 'vitest';
import { sunTimes } from './sun.js';

/** Minutes between a worked-out time and the published one. */
const off = (ms: number | null, iso: string) =>
  ms === null ? Number.POSITIVE_INFINITY : Math.abs(ms - Date.parse(iso)) / 60_000;

describe('sunrise and sunset', () => {
  it('match the published times within two minutes', () => {
    // London on the longest and shortest days of 2024: 04:43–21:21 BST and 08:03–15:53 GMT.
    const june = sunTimes('2024-06-21', 51.5074, -0.1278);
    expect(off(june.rise, '2024-06-21T03:43:00Z')).toBeLessThan(2);
    expect(off(june.set, '2024-06-21T20:21:00Z')).toBeLessThan(2);
    const december = sunTimes('2024-12-21', 51.5074, -0.1278);
    expect(off(december.rise, '2024-12-21T08:03:00Z')).toBeLessThan(2);
    expect(off(december.set, '2024-12-21T15:53:00Z')).toBeLessThan(2);
    expect(december.polar).toBeNull();
  });

  it('give the local date’s, even when it is another date in UTC', () => {
    // Sydney on 1 January: 05:47 and 20:09 local time, the sunrise on 31 December in UTC.
    const sydney = sunTimes('2026-01-01', -33.87, 151.21);
    expect(off(sydney.rise, '2025-12-31T18:47:00Z')).toBeLessThan(2);
    expect(off(sydney.set, '2026-01-01T09:09:00Z')).toBeLessThan(2);
  });

  it('say when the sun stays down or up all day', () => {
    expect(sunTimes('2026-12-21', 69.65, 18.96)).toEqual({ rise: null, set: null, polar: 'night' });
    expect(sunTimes('2026-06-21', 69.65, 18.96)).toEqual({ rise: null, set: null, polar: 'day' });
  });

  it('refuse what isn’t a date', () => {
    expect(() => sunTimes('tomorrow', 52, 5)).toThrow();
  });
});
