/**
 * MET Norway's Locationforecast 2.0 (`complete`) as Whombat reads it (docs/decisions/weather-news.md): the steps of an
 * answer (`parseMetForecast`), and from them the weather now, the next hours and the days in a place's own time zone.
 * Sunrise and sunset come from `sunTimes`, not from MET. Temperatures stay in Celsius and wind in metres per second here;
 * the views and the tool turn them into the place's units. Pure.
 */
import { sunTimes, weatherSymbolText } from '@whombat/core';

/** One step of the forecast: the moment's figures and the next hour's, six hours' and twelve hours' summaries. */
export interface MetStep {
  at: number;
  /** °C. */
  temp: number;
  /** m/s. */
  wind: number;
  gust: number | null;
  /** Degrees the wind comes from. */
  windFrom: number | null;
  humidity: number | null;
  symbol1h?: string;
  rain1h?: number;
  chance1h?: number;
  symbol6h?: string;
  rain6h?: number;
  chance6h?: number;
  max6h?: number;
  min6h?: number;
  symbol12h?: string;
  chance12h?: number;
}

export interface MetForecast {
  /** When MET made it (`properties.meta.updated_at`). */
  updatedAt: string | null;
  steps: MetStep[];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const symbolOf = (period: unknown): string | undefined => {
  const code = obj(obj(period).summary).symbol_code;
  return typeof code === 'string' && /^[a-z]{2,48}(_[a-z]+)?$/.test(code) ? code : undefined;
};

/** The steps of a Locationforecast answer, in time order; null when it isn't one. */
export function parseMetForecast(json: unknown): MetForecast | null {
  const props = obj(obj(json).properties);
  const series = props.timeseries;
  if (!Array.isArray(series)) return null;
  const steps: MetStep[] = [];
  for (const raw of series) {
    const s = obj(raw);
    const at = typeof s.time === 'string' ? Date.parse(s.time) : Number.NaN;
    const data = obj(s.data);
    const now = obj(obj(data.instant).details);
    const temp = num(now.air_temperature);
    if (!Number.isFinite(at) || temp === undefined) continue;
    const h1 = obj(data.next_1_hours);
    const h6 = obj(data.next_6_hours);
    const h12 = obj(data.next_12_hours);
    const d1 = obj(h1.details);
    const d6 = obj(h6.details);
    const d12 = obj(h12.details);
    const step: MetStep = {
      at,
      temp,
      wind: num(now.wind_speed) ?? 0,
      gust: num(now.wind_speed_of_gust) ?? null,
      windFrom: num(now.wind_from_direction) ?? null,
      humidity: num(now.relative_humidity) ?? null,
    };
    const put = <K extends keyof MetStep>(key: K, value: MetStep[K] | undefined) => {
      if (value !== undefined) step[key] = value;
    };
    put('symbol1h', symbolOf(h1));
    put('rain1h', num(d1.precipitation_amount));
    put('chance1h', num(d1.probability_of_precipitation));
    put('symbol6h', symbolOf(h6));
    put('rain6h', num(d6.precipitation_amount));
    put('chance6h', num(d6.probability_of_precipitation));
    put('max6h', num(d6.air_temperature_max));
    put('min6h', num(d6.air_temperature_min));
    put('symbol12h', symbolOf(h12));
    put('chance12h', num(d12.probability_of_precipitation));
    steps.push(step);
  }
  steps.sort((a, b) => a.at - b.at);
  const updated = obj(props.meta).updated_at;
  return { updatedAt: typeof updated === 'string' ? updated : null, steps };
}

const HOUR_MS = 3_600_000;

/** A step's symbol: the next hour's, else six hours', else twelve. */
export const stepSymbol = (s: MetStep): string => s.symbol1h ?? s.symbol6h ?? s.symbol12h ?? 'cloudy';

const dayFormats = new Map<string, Intl.DateTimeFormat>();
/** A moment's date in a time zone, `YYYY-MM-DD` (UTC when the zone isn't known). */
export function localDate(ms: number, timeZone: string): string {
  let f = dayFormats.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      f = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    }
    dayFormats.set(timeZone, f);
  }
  return f.format(ms);
}

const hourFormats = new Map<string, Intl.DateTimeFormat>();
/** A moment's hour in a time zone, 0–23 (UTC when the zone isn't known). */
export function localHour(ms: number, timeZone: string): number {
  let f = hourFormats.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', hourCycle: 'h23' });
    }
    hourFormats.set(timeZone, f);
  }
  return Number(f.format(ms));
}

/** The step the weather now is: the last one that began, else the first. */
export function stepNow(f: MetForecast, now: number): MetStep | null {
  let found: MetStep | null = null;
  for (const s of f.steps) {
    if (s.at <= now) found = s;
    else break;
  }
  return found ?? f.steps[0] ?? null;
}

/** The hours ahead from the one now on, as long as MET gives them hour by hour, at most `max`. */
export function nextHours(f: MetForecast, now: number, max: number): MetStep[] {
  const from = Math.floor(now / HOUR_MS) * HOUR_MS;
  return f.steps.filter((s) => s.at >= from && s.symbol1h !== undefined).slice(0, max);
}

/** What “feels like” says: the wind chill when it is cold and windy (°C, m/s), else null. */
export function feelsLike(temp: number, wind: number): number | null {
  const kmh = wind * 3.6;
  if (temp > 10 || kmh <= 4.8) return null;
  const v = kmh ** 0.16;
  return Math.round((13.12 + 0.6215 * temp - 11.37 * v + 0.3965 * temp * v) * 10) / 10;
}

/** A day of the forecast in a place's time zone (°C, mm, m/s). */
export interface ForecastDay {
  date: string;
  high: number;
  low: number;
  symbol: string;
  rain: number;
  rainChance: number | null;
  windMax: number;
  /** Its steps, in time order. */
  steps: MetStep[];
}

/**
 * Rain over steps, each hour counted once: an hourly step's next hour, else a six-hour step's next six hours (MET gives
 * hours for the first days, then six hours), to one decimal.
 */
export function rainOver(steps: readonly MetStep[]): number {
  let covered = Number.NEGATIVE_INFINITY;
  let mm = 0;
  steps.forEach((s, i) => {
    if (s.at < covered) return;
    const next = steps[i + 1];
    const hourly = s.rain1h !== undefined && (!next || next.at - s.at <= HOUR_MS);
    if (hourly) {
      mm += s.rain1h ?? 0;
      covered = s.at + HOUR_MS;
    } else if (s.rain6h !== undefined) {
      mm += s.rain6h;
      covered = s.at + 6 * HOUR_MS;
    } else if (s.rain1h !== undefined) {
      mm += s.rain1h;
      covered = s.at + HOUR_MS;
    }
  });
  return Math.round(mm * 10) / 10;
}

/**
 * The days from today on in `timeZone`, at most `max`: each one's highest and lowest, its symbol (the one for the hours
 * around its noon), its rain, its likeliest rain and its strongest wind. A last day MET gives only a step or so of is
 * left out.
 */
export function forecastDays(f: MetForecast, timeZone: string, now: number, max: number): ForecastDay[] {
  const today = localDate(now, timeZone);
  const byDate = new Map<string, MetStep[]>();
  for (const s of f.steps) {
    const date = localDate(s.at, timeZone);
    if (date < today) continue;
    const list = byDate.get(date) ?? [];
    list.push(s);
    byDate.set(date, list);
  }
  const days: ForecastDay[] = [];
  for (const [date, steps] of byDate) {
    if (days.length >= max) break;
    const longer = steps.some((s) => s.symbol6h !== undefined);
    if (date !== today && steps.length < 2 && !longer) continue;
    const temps = steps.flatMap((s) =>
      [s.temp, s.max6h, s.min6h].filter((t): t is number => t !== undefined),
    );
    const fromNoon = (st: MetStep) => Math.abs(localHour(st.at, timeZone) - 12);
    const nearNoon = [...steps].sort((a, b) => fromNoon(a) - fromNoon(b));
    const symbol =
      nearNoon.find((s) => s.symbol6h)?.symbol6h ??
      nearNoon.find((s) => s.symbol12h)?.symbol12h ??
      nearNoon.find((s) => s.symbol1h)?.symbol1h ??
      'cloudy';
    const chances = steps.flatMap((s) =>
      [s.chance1h, s.chance6h, s.chance12h].filter((c): c is number => c !== undefined),
    );
    days.push({
      date,
      high: Math.max(...temps),
      low: Math.min(...temps),
      symbol,
      rain: rainOver(steps),
      rainChance: chances.length ? Math.max(...chances) : null,
      windMax: Math.max(...steps.map((s) => s.wind)),
      steps,
    });
  }
  return days;
}

/** A local time with its offset, as the assistant reads it: `2026-11-26T09:00+01:00`. */
export function localIso(ms: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    }).formatToParts(ms);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const offset = get('timeZoneName').replace(/^GMT/, '') || '+00:00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}${offset}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 16).concat('Z');
  }
}

/** Sunrise and sunset of a date at a place, as moments (ms) or the polar day or night. */
export function sunOf(date: string, lat: number, lon: number) {
  return sunTimes(date, lat, lon);
}

/** What a symbol says, or the cloud's words for one the table doesn't know. */
export const symbolText = (code: string): string => weatherSymbolText(code) || 'Cloudy';
