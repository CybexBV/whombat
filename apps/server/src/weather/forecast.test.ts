import { describe, expect, it } from 'vitest';
import {
  feelsLike,
  forecastDays,
  localDate,
  localIso,
  nextHours,
  parseMetForecast,
  rainOver,
  stepNow,
  stepSymbol,
} from './forecast';
import { metAnswer, tempAt } from './testing';

const FROM = '2026-11-26T08:00:00Z';
const NOW = Date.parse('2026-11-26T08:20:00Z');

describe('MET’s forecast', () => {
  it('reads every step with its next hour, six and twelve hours', () => {
    const f = parseMetForecast(metAnswer(FROM));
    expect(f?.updatedAt).toBe('2026-11-26T08:00:00Z');
    const first = f?.steps[0];
    expect(first).toMatchObject({
      at: Date.parse(FROM),
      wind: 4.2,
      gust: 8.1,
      windFrom: 225,
      humidity: 81.5,
      symbol1h: 'partlycloudy_day',
      rain1h: 0,
      symbol6h: 'fair_day',
      symbol12h: 'cloudy',
    });
    expect(first?.temp).toBeCloseTo(tempAt(8), 1);
    // Hours for 60 hours, then six-hour steps at 00, 06, 12 and 18 UTC.
    const later = f?.steps.filter((s) => s.symbol1h === undefined) ?? [];
    expect(later.length).toBeGreaterThan(10);
    expect(later.every((s) => new Date(s.at).getUTCHours() % 6 === 0)).toBe(true);
  });

  it('is nothing without a time series, and skips a step without a temperature', () => {
    expect(parseMetForecast({ properties: {} })).toBeNull();
    expect(parseMetForecast('nope')).toBeNull();
    const f = parseMetForecast({
      properties: {
        timeseries: [
          { time: FROM, data: { instant: { details: {} } } },
          { time: 'later', data: { instant: { details: { air_temperature: 3 } } } },
          { time: FROM, data: { instant: { details: { air_temperature: 3 } } } },
        ],
      },
    });
    expect(f?.steps).toHaveLength(1);
    expect(stepSymbol(f?.steps[0] as never)).toBe('cloudy');
  });
});

describe('the weather now and the hours ahead', () => {
  const f = parseMetForecast(metAnswer(FROM)) as NonNullable<ReturnType<typeof parseMetForecast>>;

  it('is the step that began last', () => {
    expect(stepNow(f, NOW)?.at).toBe(Date.parse(FROM));
    expect(stepNow(f, Date.parse('2026-11-26T09:59:00Z'))?.at).toBe(Date.parse('2026-11-26T09:00:00Z'));
    // Before the first step: the first.
    expect(stepNow(f, Date.parse('2026-11-26T06:00:00Z'))?.at).toBe(Date.parse(FROM));
  });

  it('gives the next hours from the one now on', () => {
    const hours = nextHours(f, NOW, 24);
    expect(hours).toHaveLength(24);
    expect(hours[0]?.at).toBe(Date.parse(FROM));
    expect(hours[23]?.at).toBe(Date.parse('2026-11-27T07:00:00Z'));
  });

  it('says what the cold wind feels like', () => {
    expect(feelsLike(2, 4.2)).toBeCloseTo(-2.1, 0);
    expect(feelsLike(15, 10)).toBeNull();
    expect(feelsLike(2, 1)).toBeNull();
  });
});

describe('the days', () => {
  const f = parseMetForecast(metAnswer(FROM)) as NonNullable<ReturnType<typeof parseMetForecast>>;

  it('come in the place’s own dates, today first, at most as many as asked', () => {
    const days = forecastDays(f, 'Europe/Amsterdam', NOW, 7);
    expect(days.map((d) => d.date)).toEqual([
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
      '2026-11-29',
      '2026-11-30',
      '2026-12-01',
      '2026-12-02',
    ]);
    expect(forecastDays(f, 'Europe/Amsterdam', NOW, 3)).toHaveLength(3);
    // Far east, the same moments fall on later dates.
    expect(forecastDays(f, 'Pacific/Auckland', NOW, 1)[0]?.date).toBe('2026-11-26');
  });

  it('give each day its highest and lowest, its rain counted once, its likeliest rain and its noon symbol', () => {
    const [today, tomorrow, , , later] = forecastDays(f, 'Europe/Amsterdam', NOW, 7);
    expect(tomorrow?.high).toBeCloseTo(10, 0);
    expect(tomorrow?.low).toBeCloseTo(2, 0);
    // 12:00–15:00 UTC, half a millimetre an hour, from the hours.
    expect(tomorrow?.rain).toBe(1.5);
    expect(tomorrow?.rainChance).toBe(80);
    expect(tomorrow?.symbol).toBe('rain');
    expect(tomorrow?.windMax).toBe(4.2);
    expect(today?.rain).toBe(1.5);
    // The six-hour steps count the same rain once, in the 12:00 one.
    expect(later?.rain).toBe(1.5);
  });

  it('count rain over hours and six hours once each', () => {
    const h = 3_600_000;
    const at = Date.parse(FROM);
    const step = (t: number, extra: object) => ({
      at: t,
      temp: 1,
      wind: 1,
      gust: null,
      windFrom: null,
      humidity: null,
      ...extra,
    });
    expect(
      rainOver([
        step(at, { rain1h: 1, rain6h: 9 }),
        step(at + h, { rain1h: 1, rain6h: 9 }),
        step(at + 2 * h, { rain1h: 1, rain6h: 4 }),
        step(at + 8 * h, { rain6h: 2 }),
      ]),
    ).toBe(8);
  });
});

describe('times', () => {
  it('are told in the place’s own zone with its offset', () => {
    const t = Date.parse('2026-11-26T08:00:00Z');
    expect(localIso(t, 'Europe/Amsterdam')).toBe('2026-11-26T09:00+01:00');
    expect(localIso(t, 'UTC')).toBe('2026-11-26T08:00+00:00');
    expect(localIso(t, 'America/New_York')).toBe('2026-11-26T03:00-05:00');
    expect(localDate(t, 'Pacific/Auckland')).toBe('2026-11-26');
    expect(localDate(t, 'Not/AZone')).toBe('2026-11-26');
  });
});
