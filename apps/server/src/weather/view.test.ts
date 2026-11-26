import {
  AheadForecast,
  DeskWidgetView,
  type Place,
  WEATHER_CREDIT,
  WEATHER_WORDS,
  WeatherForecastOutput,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { parseMetForecast } from './forecast';
import { metAnswer } from './testing';
import { aheadForecastOf, weatherDeskView, weatherToolOutput } from './view';

const NOW = new Date('2026-11-26T08:20:00Z');
const forecast = parseMetForecast(metAnswer('2026-11-26T08:00:00Z')) as NonNullable<
  ReturnType<typeof parseMetForecast>
>;
const amsterdam: Place = { name: 'Amsterdam', lat: 52.37, lon: 4.9, country: 'NL', guessed: true };

describe('the weather widget', () => {
  it('shows now, today, the next hours, the days, the sun and the credit, as the contract has them', () => {
    const r = weatherDeskView('w_weather', { place: amsterdam, forecast }, NOW, 'Europe/Amsterdam');
    expect(r.private).toBe(false);
    const v = DeskWidgetView.parse(r.view);
    if (v.kind !== 'weather') throw new Error('not a weather view');
    expect(v).toMatchObject({ place: 'Amsterdam', unit: 'C', credit: WEATHER_CREDIT, title: 'Weather' });
    expect(v.now).toMatchObject({ symbol: 'partlycloudy_day', text: 'Partly cloudy', wind: '4 m/s SW' });
    expect(v.now?.feels).toBeLessThan(v.now?.temp ?? 0);
    expect(v.today).toMatchObject({ rainMm: 1.5, rainChance: 80 });
    expect(v.hours).toHaveLength(24);
    expect(v.days).toHaveLength(7);
    expect(v.days[0]?.date).toBe('2026-11-26');
    expect(v.sun?.rise).toMatch(/^2026-11-26T07:2\d/);
    expect(v.sun?.set).toMatch(/^2026-11-26T15:3\d/);
  });

  it('is told in Fahrenheit in the United States', () => {
    const r = weatherDeskView(
      'w_weather',
      { place: { ...amsterdam, name: 'Boston', country: 'US' }, forecast },
      NOW,
      'America/New_York',
    );
    const v = DeskWidgetView.parse(r.view);
    expect(v.kind === 'weather' && v.unit).toBe('F');
    expect(v.kind === 'weather' && v.now?.wind).toMatch(/mph/);
  });

  it('says where to choose a place, or that the forecast can’t be read now', () => {
    const none = DeskWidgetView.parse(
      weatherDeskView('w_weather', { place: null, forecast: null }, NOW, 'UTC').view,
    );
    expect(none.problem?.text).toBe(WEATHER_WORDS.noPlace);
    const failed = DeskWidgetView.parse(
      weatherDeskView('w_weather', { place: amsterdam, forecast: null }, NOW, 'Europe/Amsterdam').view,
    );
    expect(failed.problem?.text).toBe(WEATHER_WORDS.problem);
    expect(failed.kind === 'weather' && failed.place).toBe('Amsterdam');
  });

  it('says the sun stays down in the polar night', () => {
    const tromso = { ...amsterdam, name: 'Tromsø', lat: 69.65, lon: 18.96, country: 'NO' };
    const v = weatherDeskView(
      'w_weather',
      { place: tromso, forecast },
      new Date('2026-12-21T10:00:00Z'),
      'Europe/Oslo',
    ).view;
    expect(v.kind === 'weather' && v.sun).toEqual({ polar: 'night' });
  });
});

describe('the assistant’s forecast', () => {
  it('gives the place, units, now, the next 12 hours and the days asked, local times and the credit', () => {
    const out = WeatherForecastOutput.parse(
      weatherToolOutput(amsterdam, forecast, NOW, 'Europe/Amsterdam', 3),
    );
    if (out.status !== 'ok') throw new Error(out.status);
    expect(out.place).toMatchObject({ name: 'Amsterdam', country: 'NL', guessed: true });
    expect(out.units).toEqual({ temperature: '°C', wind: 'm/s', rain: 'mm' });
    expect(out.now.at).toBe('2026-11-26T09:00+01:00');
    expect(out.now.windFrom).toBe('SW');
    expect(out.hours).toHaveLength(12);
    expect(out.days.map((d) => d.date)).toEqual(['2026-11-26', '2026-11-27', '2026-11-28']);
    expect(out.days[1]?.sunrise).toMatch(/^2026-11-27T08:2\d\+01:00$/);
    expect(out.credit).toBe(WEATHER_CREDIT);
  });
});

describe('a calendar check’s forecast', () => {
  it('gives the plan’s day and its hours when the day is in the forecast', () => {
    const f = aheadForecastOf(amsterdam, forecast, NOW, 'Europe/Amsterdam', {
      start: '2026-11-27T12:00:00+01:00',
      end: '2026-11-27T16:00:00+01:00',
    });
    expect(AheadForecast.parse(f)).toMatchObject({ place: 'Amsterdam', date: '2026-11-27', rain: 1.5 });
    expect(f?.hours.length).toBeGreaterThanOrEqual(4);
    expect(f?.hours.every((h) => h.at.startsWith('2026-11-27T1'))).toBe(true);
  });

  it('gives an all-day plan its day, and nothing past the forecast', () => {
    expect(
      aheadForecastOf(amsterdam, forecast, NOW, 'Europe/Amsterdam', {
        start: '2026-11-28',
        end: '2026-11-29',
      })?.date,
    ).toBe('2026-11-28');
    expect(
      aheadForecastOf(amsterdam, forecast, NOW, 'Europe/Amsterdam', {
        start: '2026-12-20T12:00:00+01:00',
        end: '2026-12-20T13:00:00+01:00',
      }),
    ).toBeNull();
  });
});
