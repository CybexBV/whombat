import { describe, expect, it } from 'vitest';
import {
  DESK_OWN_WIDGETS,
  DESK_SCREEN_WORDS,
  DeskCatalogItem,
  DeskWidgetView,
} from '../domain/desk-screens.js';
import { WEATHER_CREDIT } from '../domain/weather.js';
import { MCP_TOOLS } from './mcp.js';
import { NewsHeadlinesInput, NewsHeadlinesOutput } from './mcp-news.js';
import { WeatherForecastInput, WeatherForecastOutput } from './mcp-weather.js';

const weatherView = {
  kind: 'weather',
  id: 'w_weather',
  title: 'Weather',
  at: '2026-11-26T08:00:00Z',
  place: 'Amsterdam',
  unit: 'C',
  now: { temp: 3, symbol: 'partlycloudy_day', text: 'Partly cloudy', wind: '4 m/s SW', feels: 0 },
  today: { high: 5, low: -1, rainMm: 0.4, rainChance: 20 },
  hours: [
    { at: '2026-11-26T09:00:00Z', temp: 3, symbol: 'partlycloudy_day' },
    { at: '2026-11-26T10:00:00Z', temp: 4, symbol: 'lightrain', rainMm: 0.2 },
  ],
  days: [
    { date: '2026-11-26', high: 5, low: -1, symbol: 'lightrain', rainMm: 0.4 },
    { date: '2026-11-27', high: 7, low: 2, symbol: 'cloudy' },
  ],
  sun: { rise: '2026-11-26T07:20:00Z', set: '2026-11-26T15:35:00Z' },
  credit: WEATHER_CREDIT,
} as const;

describe('the weather and news widgets', () => {
  it('are Whombat’s own, with their words', () => {
    expect(DESK_OWN_WIDGETS).toContain('weather');
    expect(DESK_OWN_WIDGETS).toContain('news');
    expect(DESK_SCREEN_WORDS.own.weather.name).toBe('Weather');
    expect(DESK_SCREEN_WORDS.own.news.name).toBe('News');
  });

  it('read back a forecast, and one the lock or a problem emptied', () => {
    expect(DeskWidgetView.parse(weatherView)).toEqual(weatherView);
    const problem = {
      kind: 'weather',
      id: 'w_weather',
      title: 'Weather',
      unit: 'C',
      hours: [],
      days: [],
      credit: WEATHER_CREDIT,
      problem: { text: 'Can’t read the weather just now' },
    };
    expect(DeskWidgetView.parse(problem)).toEqual(problem);
    const polar = { ...weatherView, sun: { polar: 'night' } };
    expect(DeskWidgetView.safeParse(polar).success).toBe(true);
  });

  it('keep a forecast within its hours and days', () => {
    const hours = Array.from({ length: 25 }, () => weatherView.hours[0]);
    expect(DeskWidgetView.safeParse({ ...weatherView, hours }).success).toBe(false);
    expect(
      DeskWidgetView.safeParse({ ...weatherView, days: [{ ...weatherView.days[0], date: '26-11' }] }).success,
    ).toBe(false);
    expect(DeskWidgetView.safeParse({ ...weatherView, now: { ...weatherView.now, temp: 3.5 } }).success).toBe(
      false,
    );
  });

  it('are listed in Add a widget with what they draw', () => {
    const name = DESK_SCREEN_WORDS.own.weather;
    expect(DeskCatalogItem.safeParse({ type: 'weather', view: 'weather', ...name }).success).toBe(true);
    expect(
      DeskCatalogItem.safeParse({ type: 'news', view: 'list', ...DESK_SCREEN_WORDS.own.news }).success,
    ).toBe(true);
  });
});

describe('the assistant’s weather and news tools', () => {
  it('are read-only and need no key', () => {
    for (const name of ['weather_forecast', 'news_headlines'] as const)
      expect(MCP_TOOLS[name]).toMatchObject({ name, readOnly: true, requiredKey: null });
  });

  it('take their inputs within bounds', () => {
    expect(WeatherForecastInput.safeParse({}).success).toBe(true);
    expect(WeatherForecastInput.safeParse({ place: 'Lisbon', days: 7 }).success).toBe(true);
    expect(WeatherForecastInput.safeParse({ days: 8 }).success).toBe(false);
    expect(NewsHeadlinesInput.safeParse({ limit: 30, query: 'strike' }).success).toBe(true);
    expect(NewsHeadlinesInput.safeParse({ limit: 31 }).success).toBe(false);
  });

  it('answer what the handlers will send', () => {
    const forecast = {
      status: 'ok',
      place: { name: 'Amsterdam', country: 'NL', region: null, lat: 52.37, lon: 4.9, guessed: true },
      units: { temperature: '°C', wind: 'm/s', rain: 'mm' },
      now: {
        at: '2026-11-26T09:00+01:00',
        temperature: 3.1,
        feelsLike: 0.2,
        symbol: 'partlycloudy_day',
        text: 'Partly cloudy',
        windSpeed: 4.3,
        windGust: null,
        windFrom: 'SW',
        humidity: 81,
        rainNextHour: 0,
      },
      hours: [],
      days: [
        {
          date: '2026-11-26',
          high: 5,
          low: -1,
          symbol: 'lightrain',
          text: 'Light rain',
          rain: 0.4,
          rainChance: 20,
          windMax: 6,
          sunrise: '2026-11-26T08:20+01:00',
          sunset: '2026-11-26T16:35+01:00',
        },
      ],
      updatedAt: '2026-11-26T07:31:00Z',
      credit: WEATHER_CREDIT,
    };
    expect(WeatherForecastOutput.parse(forecast)).toEqual(forecast);
    expect(WeatherForecastOutput.safeParse({ status: 'no_place', message: 'x' }).success).toBe(true);
    const news = {
      status: 'ok',
      headlines: [
        {
          source: 'NOS Nieuws',
          title: 'A headline',
          at: '2026-11-26T08:19+01:00',
          link: 'https://example.com/a',
        },
      ],
      sources: [{ name: 'NOS Nieuws', read: true }],
    };
    expect(NewsHeadlinesOutput.parse(news)).toEqual(news);
    expect(NewsHeadlinesOutput.safeParse({ status: 'none', message: 'x' }).success).toBe(true);
  });
});
