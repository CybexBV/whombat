/**
 * The weather for the agent (Whombat weather-news.md): MET Norway's forecast where this Whombat is, or for a place the
 * agent names (looked up on OpenStreetMap first). Spread into `MCP_TOOLS` (`./mcp`); read-only, no key.
 */
import { z } from 'zod';
import { WEATHER_DAYS_MAX } from '../domain/weather.js';
import type { McpTool } from './mcp.js';

export const WeatherForecastInput = z.object({
  place: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .optional()
    .describe(
      'A town, city or address elsewhere (“Lisbon”, “Schiphol”). Leave it out for where this Whombat is. Only this text is looked up outside.',
    ),
  days: z
    .number()
    .int()
    .min(1)
    .max(WEATHER_DAYS_MAX)
    .optional()
    .describe('How many days, today first: 1 to 7 (default 3)'),
});
export type WeatherForecastInput = z.input<typeof WeatherForecastInput>;

/** The weather now: local time with its offset, MET's symbol and what it says, wind, and rain in the next hour. */
export const WeatherNow = z.object({
  at: z.string(),
  temperature: z.number(),
  feelsLike: z.number().nullable(),
  symbol: z.string(),
  text: z.string(),
  windSpeed: z.number(),
  windGust: z.number().nullable(),
  /** The compass point the wind comes from (`SW`). */
  windFrom: z.string().nullable(),
  humidity: z.number().nullable(),
  rainNextHour: z.number().nullable(),
});
export type WeatherNow = z.infer<typeof WeatherNow>;

/** An hour ahead (local time with its offset). */
export const WeatherHourForecast = z.object({
  at: z.string(),
  temperature: z.number(),
  symbol: z.string(),
  text: z.string(),
  rain: z.number(),
  rainChance: z.number().nullable(),
  windSpeed: z.number(),
});
export type WeatherHourForecast = z.infer<typeof WeatherHourForecast>;

/** A day (the place's own date), with its sunrise and sunset (null when the sun stays up or down). */
export const WeatherDayForecast = z.object({
  date: z.string(),
  high: z.number(),
  low: z.number(),
  symbol: z.string(),
  text: z.string(),
  rain: z.number(),
  rainChance: z.number().nullable(),
  windMax: z.number().nullable(),
  sunrise: z.string().nullable(),
  sunset: z.string().nullable(),
});
export type WeatherDayForecast = z.infer<typeof WeatherDayForecast>;

export const WeatherForecastOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    /** The place it is for, and whether it is only this Whombat's time zone's guess. */
    place: z.object({
      name: z.string(),
      country: z.string(),
      region: z.string().nullable(),
      lat: z.number(),
      lon: z.number(),
      guessed: z.boolean(),
    }),
    units: z.object({
      temperature: z.enum(['°C', '°F']),
      wind: z.enum(['m/s', 'mph']),
      rain: z.literal('mm'),
    }),
    now: WeatherNow,
    /** The next 12 hours. */
    hours: z.array(WeatherHourForecast),
    days: z.array(WeatherDayForecast),
    /** When MET made the forecast. */
    updatedAt: z.string(),
    /** “Data from MET Norway”: say it when you show the forecast. */
    credit: z.string(),
  }),
  /** This Whombat has no place (the person sets it in Settings → This Whombat), or the place named wasn't found. */
  z.object({ status: z.literal('no_place'), message: z.string() }),
  /** The forecast couldn't be read just now. */
  z.object({ status: z.literal('unavailable'), message: z.string() }),
]);
export type WeatherForecastOutput = z.infer<typeof WeatherForecastOutput>;

export const WEATHER_MCP_TOOLS = {
  weather_forecast: {
    name: 'weather_forecast',
    title: 'Weather forecast',
    description:
      'The weather forecast from MET Norway: now, the next 12 hours, and today and the days ahead with sunrise and sunset. Without place: where this Whombat is (guessed from its time zone until the person sets it in Settings → This Whombat). With place: that town or address, looked up first. Credit “Data from MET Norway” when you pass it on.',
    input: WeatherForecastInput,
    output: WeatherForecastOutput,
    requiredKey: null,
    readOnly: true,
  } satisfies McpTool<typeof WeatherForecastInput, typeof WeatherForecastOutput>,
} as const;
