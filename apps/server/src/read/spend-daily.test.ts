/**
 * `spend.daily`'s days (docs/decisions/box-status.md BS-07): 30 calendar days in the burrow's zone, oldest first, today
 * last, each beginning where the one before it ended — across clock changes and in zones a quarter or half hour off —
 * and every day present with zeros where nothing ran.
 */
import { dayKey, SPEND_DAILY_DAYS, SpendDaily } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { spendDaysOf, zonedDayBounds, zonedDays } from './spend';

/** Monday 28 September 2026, 12:00 in Amsterdam (CEST). */
const NOW = new Date('2026-09-28T10:00:00.000Z');

describe('the days of spend.daily (BS-07)', () => {
  it('counts 30 calendar days in the zone, oldest first, today last', () => {
    const { days, end } = zonedDays(NOW, 'Europe/Amsterdam', SPEND_DAILY_DAYS);
    expect(days).toHaveLength(30);
    expect(days.at(-1)).toEqual({ date: '2026-09-28', start: new Date('2026-09-27T22:00:00.000Z') });
    expect(days[0]).toEqual({ date: '2026-08-30', start: new Date('2026-08-29T22:00:00.000Z') });
    expect(end).toEqual(new Date('2026-09-28T22:00:00.000Z'));
    // Today is the day spend.overview calls today.
    expect({ start: days.at(-1)?.start, end }).toEqual(zonedDayBounds(NOW, 'Europe/Amsterdam'));
  });

  it('tiles the range: each day begins where the one before it ended, through a clock change', () => {
    // 25 October 2026: the clocks go back in Amsterdam, a 25-hour day.
    const at = new Date('2026-10-26T12:00:00.000Z');
    const { days, end } = zonedDays(at, 'Europe/Amsterdam', 30);
    for (const [i, d] of days.entries()) {
      const next = days[i + 1]?.start ?? end;
      expect(zonedDayBounds(d.start, 'Europe/Amsterdam')).toEqual({ start: d.start, end: next });
      expect(dayKey(d.start, 'Europe/Amsterdam')).toBe(d.date);
      expect(dayKey(new Date(next.getTime() - 1), 'Europe/Amsterdam')).toBe(d.date);
    }
    const long = days.find((d) => d.date === '2026-10-25');
    const after = days.find((d) => d.date === '2026-10-26');
    expect((after?.start.getTime() ?? 0) - (long?.start.getTime() ?? 0)).toBe(25 * 3_600_000);
    // Consecutive dates, none twice.
    expect(new Set(days.map((d) => d.date)).size).toBe(30);
  });

  it('follows zones off by a quarter or half hour', () => {
    const { days } = zonedDays(NOW, 'Asia/Kathmandu', 2);
    // UTC+5:45: the 28th began at 18:15 UTC on the 27th.
    expect(days.map((d) => d.start.toISOString())).toEqual([
      '2026-09-26T18:15:00.000Z',
      '2026-09-27T18:15:00.000Z',
    ]);
    expect(zonedDays(NOW, 'Asia/Kolkata', 1).days[0]?.start).toEqual(new Date('2026-09-27T18:30:00.000Z'));
  });

  it('gives every day, zeros on a quiet one, from the rows of the days that had turns', () => {
    const { days } = zonedDays(NOW, 'UTC', 3);
    const out = spendDaysOf(days, [
      { bucket: 3, turns: 2, input: '5000', output: '700', cread: '0', cwrite: '0' },
      { bucket: 1, turns: 1, input: 40_000, output: 3000, cread: 30_000, cwrite: 8000 },
    ]);
    expect(out).toEqual([
      {
        date: '2026-09-26',
        turns: 1,
        inputTokens: 40_000,
        outputTokens: 3000,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 8000,
      },
      {
        date: '2026-09-27',
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        date: '2026-09-28',
        turns: 2,
        inputTokens: 5000,
        outputTokens: 700,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
    const answer = {
      generatedAt: NOW.toISOString(),
      timeZone: 'UTC',
      days: spendDaysOf(zonedDays(NOW, 'UTC', SPEND_DAILY_DAYS).days, []),
    };
    expect(SpendDaily.parse(answer)).toEqual(answer);
  });
});
