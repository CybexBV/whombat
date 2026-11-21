/**
 * Figures over a page's range (dashboards.md DS-03, DS-06, DS-08, DS-11, DS-15; dashboards-server.md DS-S01…): the grid,
 * a counter that restarts as bars, small lines, the average and the peak, where a disk is heading. Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  avgPeakLines,
  counterSteps,
  downsample,
  forecastFull,
  fullWords,
  gridTimes,
  inAbout,
  mbPerDay,
  momentWords,
  onRange,
  pageRange,
  pctStat,
  perDay,
  type RawPoint,
  seriesStats,
  statFigure,
  trendOf,
} from './series';

const TZ = 'Europe/Amsterdam';
const now = new Date('2026-10-18T12:07:00Z');
const minAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const dayAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const text = (parts: { text: string }[]) => parts.map((p) => p.text).join('');

describe('the range and its grid (DS-03, DS-11)', () => {
  it('offers 1 h to 30 days; anything else is 24 hours', () => {
    expect(pageRange('7d')).toBe('7d');
    expect(pageRange('90d')).toBe('24h');
    expect(pageRange(undefined)).toBe('24h');
  });

  it('buckets end on the step, the last one now (the current, partial one)', () => {
    const day = gridTimes('24h', now);
    expect(day).toHaveLength(96);
    expect(day.at(-1)?.toISOString()).toBe(now.toISOString());
    expect(day.at(-2)?.toISOString()).toBe('2026-10-18T12:00:00.000Z');
    expect(gridTimes('1h', now)).toHaveLength(12);
    expect(gridTimes('6h', now)).toHaveLength(72);
    expect(gridTimes('7d', now)).toHaveLength(84);
    expect(gridTimes('30d', now)).toHaveLength(120);
    const onTheHour = new Date('2026-10-18T12:00:00Z');
    expect(gridTimes('1h', onTheHour)[0]?.toISOString()).toBe('2026-10-18T11:05:00.000Z');
  });

  it('each bucket is the mean of its points; nothing read is a gap, before the history too', () => {
    const points: RawPoint[] = [
      { at: minAgo(4), value: 2 },
      { at: minAgo(2), value: 4 },
      { at: minAgo(30), value: null },
      { at: minAgo(200), value: 9 },
    ];
    const grid = onRange([points], '1h', now);
    const values = grid.values[0] as (number | null)[];
    expect(values).toHaveLength(12);
    // 12:03 and 12:05 are in the bucket ending at 12:05; the current one (12:05…12:07) has nothing yet.
    expect(values.at(-2)).toBe(3);
    expect(values.at(-1)).toBeNull();
    expect(values.filter((v) => v !== null)).toEqual([3]);
  });
});

describe('a counter as bars (DS-10)', () => {
  it('adds how much it grew per bucket; a restart counts again from the new count', () => {
    const hour = 3600_000;
    const at = (h: number) => new Date(now.getTime() - h * hour);
    const points: RawPoint[] = [
      { at: at(5.5), value: 100 },
      { at: at(4.5), value: 160 },
      { at: at(4.2), value: 200 },
      { at: at(3.5), value: 20 }, // restarted
      { at: at(2.5), value: 19 }, // an old entry left the log
      { at: at(1.5), value: 50 },
    ];
    // Buckets end at 08:00 … 12:00 and now; the point before them is where the count starts.
    const bars = counterSteps(points, '6h', now, hour);
    expect(bars.timestamps[0]).toBe('2026-10-18T08:00:00.000Z');
    expect(bars.values).toEqual([100, 20, 0, 31, null, null]);
  });
});

describe('small lines, averages and peaks (DS-06, DS-15)', () => {
  it('cuts a line to 60 points, the mean of each group', () => {
    const line = Array.from({ length: 120 }, (_, i) => (i % 2 ? null : i));
    const small = downsample(line);
    expect(small).toHaveLength(60);
    expect(small[0]).toBe(0);
    expect(downsample([1, null, 3])).toEqual([1, null, 3]);
  });

  it('one decimal under ten, none above; the peak’s time in the person’s zone', () => {
    expect(statFigure(2.44)).toBe('2.4');
    expect(statFigure(63.4)).toBe('63');
    expect(statFigure(0)).toBe('0');
    const timestamps = [minAgo(30), minAgo(20), minAgo(10)].map((d) => d.toISOString());
    const stats = seriesStats([1.2, 4.6, 2.1], timestamps);
    expect(stats?.avg).toBeCloseTo(2.633, 2);
    expect(avgPeakLines(stats, pctStat, now, TZ).map(text)).toEqual(['Avg 2.6 %', 'Peak 4.6 % Sun 13:47']);
    expect(avgPeakLines(stats, pctStat, now, TZ)[0]).toEqual([
      { text: 'Avg ' },
      { text: '2.6 %', strong: true },
    ]);
    expect(avgPeakLines(seriesStats([1, 2, 9], timestamps), pctStat, now, TZ).map(text)[1]).toBe(
      'Peak 9.0 % Now',
    );
    expect(momentWords(dayAgo(10), now, TZ)).toBe('8 Oct 14:07');
    expect(seriesStats([null, null], timestamps)).toBeNull();
  });
});

describe('where it is heading (DS-08)', () => {
  // A disk growing 0.5 % a day for 30 days, at 76 % now.
  const disk: RawPoint[] = Array.from({ length: 31 }, (_, i) => ({
    at: dayAgo(30 - i),
    value: 61 + i * 0.5,
  }));

  it('the least-squares line over 30 days: full in about 7 weeks, about 6 Dec', () => {
    const full = forecastFull(disk, 100, now);
    expect(full?.toISOString().slice(0, 10)).toBe('2026-12-05');
    expect(inAbout(full as Date, now)).toBe('in about 7 weeks');
    expect(fullWords(full as Date, now, TZ)).toBe('Full about 5 Dec');
    expect(fullWords(new Date(now.getTime() + 150 * 86_400_000), now, TZ)).toBe('Full in about 5 months');
  });

  it('nothing with under two days of history, when it isn’t growing, or past a year', () => {
    expect(forecastFull(disk.slice(-2), 100, now)).toBeNull();
    expect(
      forecastFull(
        disk.map((p) => ({ ...p, value: 80 })),
        100,
        now,
      ),
    ).toBeNull();
    const slow = disk.map((p, i) => ({ ...p, value: 10 + i * 0.01 }));
    expect(forecastFull(slow, 100, now)).toBeNull();
  });

  it('a database growing 110 MB a day; sizes with their sign', () => {
    const db = Array.from({ length: 11 }, (_, i) => ({ at: dayAgo(10 - i), value: 4900 + i * 110 }));
    expect(perDay(mbPerDay(trendOf(db, now)) as number)).toBe('+ 110 MB a day');
    expect(perDay(1500)).toBe('+ 1.5 GB a day');
    expect(perDay(0.2)).toBeNull();
    const halfDay = [
      { at: new Date(now.getTime() - 12 * 3600_000), value: 5900 },
      { at: now, value: 6000 },
    ];
    expect(mbPerDay(trendOf(halfDay, now))).toBeNull();
  });
});
