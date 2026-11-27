/**
 * The weather where this Whombat is (Whombat docs/decisions/weather-news.md): MET Norway's forecast for the burrow's
 * place (`Burrow.place`), read by the runtime and shown by the `weather` widget and the assistant's `weather_forecast`.
 * MET's data is open (NLOD 2.0, CC BY 4.0) on one condition: the credit, `WEATHER_CREDIT`, wherever it is shown. Sunrise
 * and sunset are worked out here (`sunTimes`).
 *
 * Units: Celsius and metres per second, except Fahrenheit and miles per hour in the United States; rain in millimetres
 * everywhere. No setting.
 */
import { z } from 'zod';
import { coreTranslator } from '../i18n/catalog.js';

/** The credit MET Norway's licence asks for, wherever its data is shown. */
export const WEATHER_CREDIT = 'Data from MET Norway';
/** The hours ahead a forecast gives, and the days. */
export const WEATHER_HOURS_MAX = 24;
export const WEATHER_DAYS_MAX = 7;
/** Never asked for the same place again sooner than this. */
export const WEATHER_REFRESH_MIN_S = 30 * 60;

/**
 * MET Norway's weather symbols (`symbol_code` without its time of day; github.com/metno/weathericons `legend.csv`), and
 * what each says in English. The ones marked `true` come as `_day`, `_night` and `_polartwilight`. (`lightssleet…` and
 * `lightssnow…` are MET's own spelling.)
 */
export const WEATHER_SYMBOLS = {
  clearsky: ['Clear sky', true],
  fair: ['Fair', true],
  partlycloudy: ['Partly cloudy', true],
  cloudy: ['Cloudy', false],
  fog: ['Fog', false],
  lightrainshowers: ['Light rain showers', true],
  rainshowers: ['Rain showers', true],
  heavyrainshowers: ['Heavy rain showers', true],
  lightrainshowersandthunder: ['Light rain showers and thunder', true],
  rainshowersandthunder: ['Rain showers and thunder', true],
  heavyrainshowersandthunder: ['Heavy rain showers and thunder', true],
  lightsleetshowers: ['Light sleet showers', true],
  sleetshowers: ['Sleet showers', true],
  heavysleetshowers: ['Heavy sleet showers', true],
  lightssleetshowersandthunder: ['Light sleet showers and thunder', true],
  sleetshowersandthunder: ['Sleet showers and thunder', true],
  heavysleetshowersandthunder: ['Heavy sleet showers and thunder', true],
  lightsnowshowers: ['Light snow showers', true],
  snowshowers: ['Snow showers', true],
  heavysnowshowers: ['Heavy snow showers', true],
  lightssnowshowersandthunder: ['Light snow showers and thunder', true],
  snowshowersandthunder: ['Snow showers and thunder', true],
  heavysnowshowersandthunder: ['Heavy snow showers and thunder', true],
  lightrain: ['Light rain', false],
  rain: ['Rain', false],
  heavyrain: ['Heavy rain', false],
  lightrainandthunder: ['Light rain and thunder', false],
  rainandthunder: ['Rain and thunder', false],
  heavyrainandthunder: ['Heavy rain and thunder', false],
  lightsleet: ['Light sleet', false],
  sleet: ['Sleet', false],
  heavysleet: ['Heavy sleet', false],
  lightsleetandthunder: ['Light sleet and thunder', false],
  sleetandthunder: ['Sleet and thunder', false],
  heavysleetandthunder: ['Heavy sleet and thunder', false],
  lightsnow: ['Light snow', false],
  snow: ['Snow', false],
  heavysnow: ['Heavy snow', false],
  lightsnowandthunder: ['Light snow and thunder', false],
  snowandthunder: ['Snow and thunder', false],
  heavysnowandthunder: ['Heavy snow and thunder', false],
} as const satisfies Record<string, readonly [string, boolean]>;
export type WeatherSymbolBase = keyof typeof WEATHER_SYMBOLS;
export const WEATHER_SYMBOL_BASES = Object.keys(WEATHER_SYMBOLS) as WeatherSymbolBase[];

/** The times of day a symbol may carry. */
export const WEATHER_TIMES_OF_DAY = ['day', 'night', 'polartwilight'] as const;
export type WeatherTimeOfDay = (typeof WEATHER_TIMES_OF_DAY)[number];

/**
 * A symbol as MET sends it (`partlycloudy_night`, `rain`). Any such word is taken, so a symbol MET adds later still
 * reaches the screen, which draws a plain cloud for one it doesn't know.
 */
export const WeatherSymbol = z.string().regex(/^[a-z]{2,48}(_(day|night|polartwilight))?$/);
export type WeatherSymbol = z.infer<typeof WeatherSymbol>;

/** A symbol's base and time of day; the base is null when the table doesn't know it. */
export function weatherSymbolParts(code: string): {
  base: WeatherSymbolBase | null;
  time: WeatherTimeOfDay | null;
} {
  const [base = '', time] = code.split('_');
  return {
    base: Object.hasOwn(WEATHER_SYMBOLS, base) ? (base as WeatherSymbolBase) : null,
    time: (WEATHER_TIMES_OF_DAY as readonly string[]).includes(time ?? '')
      ? (time as WeatherTimeOfDay)
      : null,
  };
}

/** What a symbol says (“Partly cloudy”, “Half bewolkt”); empty for one the table doesn't know. */
export function weatherSymbolText(code: string, locale?: string | null): string {
  const { base } = weatherSymbolParts(code);
  return base ? coreTranslator(locale).t(`weather.symbol.${base}`) : '';
}

/** The units a place's weather is told in. */
export interface WeatherUnits {
  temperature: 'C' | 'F';
  wind: 'm/s' | 'mph';
}

/** The units for a country (ISO 3166-1): Fahrenheit and miles per hour in the United States, else metric. */
export function weatherUnitsFor(country: string | null | undefined): WeatherUnits {
  return country === 'US' ? { temperature: 'F', wind: 'mph' } : { temperature: 'C', wind: 'm/s' };
}

/** A temperature MET gives in Celsius, in the unit, to one decimal. */
export function temperatureIn(unit: WeatherUnits['temperature'], celsius: number): number {
  const value = unit === 'F' ? (celsius * 9) / 5 + 32 : celsius;
  return Math.round(value * 10) / 10 + 0;
}

/** A wind speed MET gives in metres per second, in the unit, to one decimal. */
export function windIn(unit: WeatherUnits['wind'], metresPerSecond: number): number {
  const value = unit === 'mph' ? metresPerSecond * 2.236936 : metresPerSecond;
  return Math.round(value * 10) / 10 + 0;
}

/** The compass point a wind comes from (`SW`; `ZW` in Dutch), from MET's degrees. */
export function windFrom(degrees: number, locale?: string | null): string {
  const point = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
  return coreTranslator(locale).t(`weather.compass.${point as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7}`);
}

/** The words the weather widget and Settings say beyond the forecast, in a locale. */
export function weatherWords(locale?: string | null): { credit: string; problem: string; noPlace: string } {
  const tr = coreTranslator(locale);
  return {
    credit: tr.t('weather.credit'),
    problem: tr.t('weather.problem'),
    noPlace: tr.t('weather.noPlace'),
  };
}

/** The words the weather widget and Settings say beyond the forecast (the screen's own are `@whombat/screen`'s). */
export const WEATHER_WORDS = weatherWords('en');
