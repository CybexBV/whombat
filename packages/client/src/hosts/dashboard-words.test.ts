import { describe, expect, it } from 'vitest';
import {
  cut,
  dashboardNumber,
  movedGb,
  peakWhen,
  rateWords,
  seriesStats,
  sizeFigure,
  sizePair,
  sizeWords,
  volumeForecast,
} from './dashboard-words';

const TZ = 'Europe/Amsterdam';
/** Sunday 18 October 2026, 18:00 in Amsterdam. */
const NOW = Date.parse('2026-10-18T16:00:00Z');
const H = 3_600_000;
const DAY = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const nb = (s: string) => s.replace(/ /g, ' ');

describe('the Summary’s words (DS-15, AP-2006)', () => {
  it('writes averages and peaks with one decimal under 10 and none above', () => {
    expect(dashboardNumber(2.44)).toBe('2.4');
    expect(dashboardNumber(9.96)).toBe('10');
    expect(dashboardNumber(14.2)).toBe('14');
    expect(dashboardNumber(63)).toBe('63');
    expect(dashboardNumber(2)).toBe('2');
    expect(dashboardNumber(12_286)).toBe('12,286');
    expect(dashboardNumber(null)).toBe('—');
  });

  it('says when a peak was in the person’s time zone: Now, a weekday and time, or a date', () => {
    expect(peakWhen(iso(NOW - 15 * H + 10 * 60_000), NOW, TZ)).toBe('Sun 03:10');
    expect(peakWhen(iso(NOW - 2 * DAY), NOW, TZ)).toBe('Fri 18:00');
    expect(peakWhen(iso(NOW - 12 * DAY), NOW, TZ)).toBe('6 Oct');
    expect(peakWhen(iso(NOW), NOW, TZ, true)).toBe('Now');
  });

  it('takes the hosts service’s own average and peak when it gives them, else the points', () => {
    const ts = [iso(NOW - 2 * H), iso(NOW - H), iso(NOW)];
    expect(seriesStats([10, 30, null], ts, { timeZone: TZ, now: NOW })).toEqual({
      avg: 20,
      peak: 30,
      peakAt: ts[1],
      peakWhen: 'Sun 17:00',
    });
    const s = seriesStats([10, 30, 20], ts, {
      timeZone: TZ,
      now: NOW,
      summary: { avg: 14.2, max: 63, maxAt: iso(NOW - 15 * H + 10 * 60_000) },
    });
    expect(s).toMatchObject({ avg: 14.2, peak: 63, peakWhen: 'Sun 03:10' });
    expect(seriesStats([1, 2, 5], ts, { timeZone: TZ }).peakWhen).toBe('Now');
    expect(seriesStats([null, null], ts.slice(0, 2))).toMatchObject({
      avg: null,
      peak: null,
      peakWhen: null,
    });
  });

  it('writes sizes in GB and TB, one decimal under 10, in the total’s unit', () => {
    expect(nb(sizeWords(0.48))).toBe('480 MB');
    expect(nb(sizeWords(4.5))).toBe('4.5 GB');
    expect(nb(sizeWords(930))).toBe('930 GB');
    expect(nb(sizeWords(7200))).toBe('7.2 TB');
    expect(nb(sizeWords(24_000))).toBe('24 TB');
    expect(nb(sizePair(660, 930))).toBe('660 of 930 GB');
    expect(nb(sizePair(2100, 7200))).toBe('2.1 of 7.2 TB');
    expect(nb(sizePair(0, 8, '/'))).toBe('0 / 8 GB');
    // Less than a terabyte used: both in GB, as Unraid's cache pool (“310 / 1000 GB” in the mock).
    expect(nb(sizePair(310, 1000))).toBe('310 of 1,000 GB');
    expect(sizeFigure(18_200, 24_000)).toMatchObject({ value: '18', unit: 'TB' });
    expect(nb(sizePair(null, 94))).toBe('— of 94 GB');
  });

  it('writes network rates in Mb/s and Gb/s, and what a rate moved', () => {
    expect(nb(rateWords(84))).toBe('84 Mb/s');
    expect(nb(rateWords(2.44))).toBe('2.4 Mb/s');
    expect(nb(rateWords(1240))).toBe('1.2 Gb/s');
    // 80 Mb/s for an hour is 36 GB.
    expect(movedGb([80, 80, null, 80, 80], 900)).toBeCloseTo(36);
    expect(movedGb([10, 10], 900, false)).toBeCloseTo(18);
    expect(movedGb([null], 900)).toBeNull();
  });

  it('cuts words to a contract’s length with an ellipsis', () => {
    expect(cut('short', 10)).toBe('short');
    expect(cut('a much longer title', 10)).toBe('a much lo…');
  });
});

describe('volumeForecast (DS-08, DS-15)', () => {
  /** 30 days of a volume at `pct` now growing `perDay` points a day (the hosts service's 6-hour points). */
  const month = (pct: number, perDay: number) => {
    const ts: string[] = [];
    const values: number[] = [];
    for (let i = 119; i >= 0; i--) {
      ts.push(iso(NOW - i * 6 * H));
      values.push(pct - (i / 4) * perDay);
    }
    return { values, timestamps: ts };
  };

  it('says the month when it is full more than 60 days from now', () => {
    const f = volumeForecast({ ...month(71, 0.2), now: NOW, timeZone: TZ });
    expect(f.fullInDays).toBeCloseTo(145, 0);
    expect(f.words).toBe('Full in about 5 months');
    expect(nb(f.growth ?? '')).toBe('growing 1.4 % a week');
    expect(f.fullAt).toBe(iso(NOW + (f.fullInDays ?? 0) * DAY));
  });

  it('says the day within 60 days, and the hub’s own forecast wins', () => {
    expect(volumeForecast({ ...month(82, 0.8), now: NOW, timeZone: TZ }).words).toBe('Full about 10 Nov');
    expect(volumeForecast({ fullInDays: 61, now: NOW, timeZone: TZ }).words).toBe('Full in about 2 months');
    expect(volumeForecast({ ...month(50, 0.01), fullInDays: 3, now: NOW, timeZone: TZ }).words).toBe(
      'Full about 21 Oct',
    );
  });

  it('says nothing when it isn’t filling up, is more than a year away, or has less than a day of points', () => {
    expect(volumeForecast({ ...month(40, 0), now: NOW }).words).toBeNull();
    expect(volumeForecast({ ...month(40, -0.3), now: NOW }).words).toBeNull();
    expect(volumeForecast({ ...month(10, 0.1), now: NOW }).words).toBeNull();
    const day = month(71, 2);
    expect(
      volumeForecast({ values: day.values.slice(-3), timestamps: day.timestamps.slice(-3), now: NOW }).words,
    ).toBeNull();
    expect(volumeForecast({ now: NOW })).toEqual({
      fullInDays: null,
      fullAt: null,
      perDay: null,
      words: null,
      growth: null,
    });
  });
});
