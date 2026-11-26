/**
 * A forecast as the screens, the assistant and Looks ahead read it (docs/decisions/weather-news.md): the `weather`
 * widget's view, `weather_forecast`'s answer and a calendar check's forecast for its day, each in the place's units
 * (Fahrenheit and miles per hour in the United States, else Celsius and metres per second) and with MET Norway's credit.
 * Pure.
 */
import {
  type AheadForecast,
  DESK_SCREEN_WORDS,
  type DeskWidgetView,
  type Place,
  temperatureIn,
  WEATHER_CREDIT,
  WEATHER_DAYS_MAX,
  WEATHER_HOURS_MAX,
  WEATHER_WORDS,
  type WeatherForecastOutput,
  type WeatherUnits,
  weatherUnitsFor,
  windFrom,
  windIn,
} from '@whombat/core';
import { screenText } from '../desk/glance';
import type { Resolved } from '../desk/widgets/types';
import {
  type ForecastDay,
  feelsLike,
  forecastDays,
  localDate,
  localIso,
  type MetForecast,
  nextHours,
  stepNow,
  stepSymbol,
  sunOf,
  symbolText,
} from './forecast';

/** The widget is drawn again this often; MET is asked only when its forecast expired (`WeatherService`). */
export const WEATHER_REFRESH_S = 300;

const deg = (units: WeatherUnits, celsius: number) => Math.round(temperatureIn(units.temperature, celsius));
const unitWords = (units: WeatherUnits) =>
  ({ temperature: units.temperature === 'F' ? '°F' : '°C', wind: units.wind, rain: 'mm' }) as const;

/** A whole-number view's text for wind: “4 m/s SW”. */
function windText(units: WeatherUnits, speed: number, from: number | null): string {
  const value = Math.round(windIn(units.wind, speed));
  return from === null ? `${value} ${units.wind}` : `${value} ${units.wind} ${windFrom(from)}`;
}

/** What the `weather` widget reads: where, its forecast, and whether its last read failed. */
export interface WeatherRead {
  place: Place | null;
  forecast: MetForecast | null;
}

/**
 * The `weather` widget's view: the place, now, today's highest and lowest with its rain, the next hours, the
 * days ahead, today's sunrise and sunset, and MET Norway's credit. Without a place it says where to choose one; without a
 * forecast, that it can't be read now. Never private on a locked screen.
 */
export function weatherDeskView(id: string, read: WeatherRead | null, now: Date, timeZone: string): Resolved {
  const title = DESK_SCREEN_WORDS.own.weather.name;
  const units = weatherUnitsFor(read?.place?.country);
  const base = {
    kind: 'weather' as const,
    id,
    title,
    unit: units.temperature,
    hours: [],
    days: [],
    credit: WEATHER_CREDIT,
  };
  const place = read?.place ?? null;
  const placeName = place ? screenText(place.name, 80) : '';
  const problem = (text: string): Resolved => ({
    view: { ...base, ...(placeName ? { place: placeName } : {}), tone: 'off', problem: { text } },
    private: false,
    refreshS: WEATHER_REFRESH_S,
  });
  if (!place) return problem(WEATHER_WORDS.noPlace);
  const forecast = read?.forecast;
  const at = stepNow(forecast ?? { updatedAt: null, steps: [] }, now.getTime());
  if (!forecast || !at) return problem(WEATHER_WORDS.problem);
  const days = forecastDays(forecast, timeZone, now.getTime(), WEATHER_DAYS_MAX);
  const today = days[0];
  const feels = feelsLike(at.temp, at.wind);
  const sun = sunOf(localDate(now.getTime(), timeZone), place.lat, place.lon);
  const view: DeskWidgetView = {
    ...base,
    ...(placeName ? { place: placeName } : {}),
    ...(forecast.updatedAt && !Number.isNaN(Date.parse(forecast.updatedAt))
      ? { at: new Date(forecast.updatedAt).toISOString() }
      : {}),
    now: {
      temp: deg(units, at.temp),
      symbol: stepSymbol(at),
      text: screenText(symbolText(stepSymbol(at)), 60),
      wind: windText(units, at.wind, at.windFrom),
      ...(feels !== null && Math.round(feels) !== Math.round(at.temp) ? { feels: deg(units, feels) } : {}),
    },
    ...(today
      ? {
          today: {
            high: deg(units, today.high),
            low: deg(units, today.low),
            rainMm: today.rain,
            ...(today.rainChance !== null ? { rainChance: Math.round(today.rainChance) } : {}),
          },
        }
      : {}),
    hours: nextHours(forecast, now.getTime(), WEATHER_HOURS_MAX).map((s) => ({
      at: new Date(s.at).toISOString(),
      temp: deg(units, s.temp),
      symbol: stepSymbol(s),
      ...(s.rain1h ? { rainMm: Math.round(s.rain1h * 10) / 10 } : {}),
    })),
    days: days.map((d) => ({
      date: d.date,
      high: deg(units, d.high),
      low: deg(units, d.low),
      symbol: d.symbol,
      ...(d.rain ? { rainMm: d.rain } : {}),
    })),
    sun:
      sun.polar !== null
        ? { polar: sun.polar }
        : {
            ...(sun.rise !== null ? { rise: new Date(sun.rise).toISOString() } : {}),
            ...(sun.set !== null ? { set: new Date(sun.set).toISOString() } : {}),
          },
  };
  return { view, private: false, refreshS: WEATHER_REFRESH_S };
}

const one = (n: number) => Math.round(n * 10) / 10;

/** A day as the assistant reads it, with its sunrise and sunset. */
function toolDay(d: ForecastDay, units: WeatherUnits, place: Place, timeZone: string) {
  const sun = sunOf(d.date, place.lat, place.lon);
  return {
    date: d.date,
    high: temperatureIn(units.temperature, d.high),
    low: temperatureIn(units.temperature, d.low),
    symbol: d.symbol,
    text: symbolText(d.symbol),
    rain: d.rain,
    rainChance: d.rainChance === null ? null : Math.round(d.rainChance),
    windMax: windIn(units.wind, d.windMax),
    sunrise: sun.rise === null ? null : localIso(sun.rise, timeZone),
    sunset: sun.set === null ? null : localIso(sun.set, timeZone),
  };
}

/** The hours the assistant gets. */
const TOOL_HOURS = 12;

/** `weather_forecast`'s answer: the place, now, the next 12 hours and `days` days, in the place's units and hours. */
export function weatherToolOutput(
  place: Place,
  forecast: MetForecast,
  now: Date,
  timeZone: string,
  days: number,
): WeatherForecastOutput {
  const units = weatherUnitsFor(place.country);
  const at = stepNow(forecast, now.getTime());
  if (!at) return { status: 'unavailable', message: WEATHER_WORDS.problem };
  const feels = feelsLike(at.temp, at.wind);
  return {
    status: 'ok',
    place: {
      name: place.name,
      country: place.country,
      region: place.regionName ?? place.region ?? null,
      lat: place.lat,
      lon: place.lon,
      guessed: place.guessed,
    },
    units: unitWords(units),
    now: {
      at: localIso(at.at, timeZone),
      temperature: temperatureIn(units.temperature, at.temp),
      feelsLike: feels === null ? null : temperatureIn(units.temperature, feels),
      symbol: stepSymbol(at),
      text: symbolText(stepSymbol(at)),
      windSpeed: windIn(units.wind, at.wind),
      windGust: at.gust === null ? null : windIn(units.wind, at.gust),
      windFrom: at.windFrom === null ? null : windFrom(at.windFrom),
      humidity: at.humidity === null ? null : Math.round(at.humidity),
      rainNextHour: at.rain1h === undefined ? null : one(at.rain1h),
    },
    hours: nextHours(forecast, now.getTime(), TOOL_HOURS).map((s) => ({
      at: localIso(s.at, timeZone),
      temperature: temperatureIn(units.temperature, s.temp),
      symbol: stepSymbol(s),
      text: symbolText(stepSymbol(s)),
      rain: one(s.rain1h ?? 0),
      rainChance: s.chance1h === undefined ? null : Math.round(s.chance1h),
      windSpeed: windIn(units.wind, s.wind),
    })),
    days: forecastDays(forecast, timeZone, now.getTime(), days).map((d) =>
      toolDay(d, units, place, timeZone),
    ),
    updatedAt: forecast.updatedAt ?? new Date(at.at).toISOString(),
    credit: WEATHER_CREDIT,
  };
}

/**
 * A calendar check's forecast where the Whombat is, for the plan's day (`start`, `end`), when that day is in the
 * forecast: the day's figures and the hours the plan spans (at most 12; an all-day plan's from its morning). Null
 * otherwise.
 */
export function aheadForecastOf(
  place: Place,
  forecast: MetForecast,
  now: Date,
  timeZone: string,
  plan: { start: string; end: string },
): AheadForecast | null {
  const start = Date.parse(plan.start);
  if (!Number.isFinite(start)) return null;
  const end = Math.max(start, Date.parse(plan.end) || start);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(plan.start) ? plan.start : localDate(start, timeZone);
  const day = forecastDays(forecast, timeZone, now.getTime(), WEATHER_DAYS_MAX).find((d) => d.date === date);
  if (!day) return null;
  const units = weatherUnitsFor(place.country);
  const hourMs = 3_600_000;
  const hours = day.steps
    .filter((s) => s.at >= start - hourMs && s.at <= end)
    .slice(0, 12)
    .map((s) => ({
      at: localIso(s.at, timeZone),
      temperature: temperatureIn(units.temperature, s.temp),
      text: symbolText(stepSymbol(s)),
      rain: one(s.rain1h ?? s.rain6h ?? 0),
      windSpeed: windIn(units.wind, s.wind),
    }));
  const words = unitWords(units);
  return {
    place: place.name,
    date,
    units: { temperature: words.temperature, wind: words.wind },
    text: symbolText(day.symbol),
    high: temperatureIn(units.temperature, day.high),
    low: temperatureIn(units.temperature, day.low),
    rain: day.rain,
    rainChance: day.rainChance === null ? null : Math.round(day.rainChance),
    windMax: windIn(units.wind, day.windMax),
    hours,
    credit: WEATHER_CREDIT,
  };
}
