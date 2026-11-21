import { describe, expect, it } from 'vitest';
import { clockDate, dateClock } from './clockDate';

describe('clockDate', () => {
  it('holds a clock as that time on one fixed day in UTC', () => {
    expect(clockDate('22:00').toISOString()).toBe('2000-01-01T22:00:00.000Z');
    expect(clockDate('07:05').toISOString()).toBe('2000-01-01T07:05:00.000Z');
  });

  it('reads what parseClock reads, and makes anything else midnight', () => {
    expect(clockDate('7.30').toISOString()).toBe('2000-01-01T07:30:00.000Z');
    expect(clockDate('25:00').toISOString()).toBe('2000-01-01T00:00:00.000Z');
    expect(clockDate('').toISOString()).toBe('2000-01-01T00:00:00.000Z');
  });

  it('gives back the HH:MM the picker shows, whatever day it hands back', () => {
    expect(dateClock(clockDate('23:59'))).toBe('23:59');
    expect(dateClock(new Date('2026-03-29T01:30:00.000Z'))).toBe('01:30');
    for (const clock of ['00:00', '06:45', '12:00', '18:30']) expect(dateClock(clockDate(clock))).toBe(clock);
  });
});
