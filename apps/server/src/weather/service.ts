/**
 * The forecast where this Whombat is, and where the assistant asks about (docs/decisions/weather-news.md): MET Norway's
 * Locationforecast 2.0 (`complete`), one forecast kept per place (latitude and longitude to two decimals). MET's terms
 * ask each application to be gentle, so a place is asked again only when its answer has expired (`Expires`), never
 * sooner than every 30 minutes, a few minutes later than that at random and never on the hour; the answer before is
 * sent back as `If-Modified-Since`, and a 304 keeps what is kept. Asked only when something needs it (a shown widget,
 * the assistant, Looks ahead). A failed read keeps the last forecast and tries again after 10 minutes.
 */
import { roundCoord, WEATHER_REFRESH_MIN_S } from '@whombat/core';
import { headerOf, openDataGet } from '../lib/open-data';
import type { Services } from '../services';
import { type MetForecast, parseMetForecast } from './forecast';

export const MET_FORECAST_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
/** After a failed read, the next try. */
export const WEATHER_RETRY_MS = 10 * 60_000;
/** The random minutes added after a forecast expires, so boxes don't all ask at once. */
const JITTER_MS = { min: 2 * 60_000, max: 8 * 60_000 } as const;
/** Places kept at most (this Whombat's own and the few the assistant asked about). */
const KEPT_MAX = 50;

/** A forecast's address: two decimals, within MET's four. */
export function metForecastUrl(lat: number, lon: number): string {
  return `${MET_FORECAST_URL}?lat=${roundCoord(lat)}&lon=${roundCoord(lon)}`;
}

/**
 * When a place is asked again: when MET says its answer expires, but not within 30 minutes of now, plus a few random
 * minutes, and moved off the full hour. Pure (`random` in [0, 1)).
 */
export function nextAskAt(now: number, expires: number | null, random: number): number {
  const at =
    Math.max(expires ?? 0, now + WEATHER_REFRESH_MIN_S * 1000) +
    JITTER_MS.min +
    Math.floor(random * (JITTER_MS.max - JITTER_MS.min));
  // MET asks for no requests at hh:00: a minute past the hour waits two more.
  return new Date(at).getUTCMinutes() === 0 ? at + 2 * 60_000 : at;
}

interface Entry {
  forecast: MetForecast | null;
  lastModified: string | null;
  nextAt: number;
  pending: Promise<void> | null;
}

/** The forecasts of one Whombat. */
export class WeatherService {
  readonly #kept = new Map<string, Entry>();

  constructor(
    private readonly services: Services,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * The forecast for a place: what is kept while it is fresh, else asked now (one read per place at a time). The last
   * forecast when MET can't be read; null when there never was one.
   */
  async forecast(lat: number, lon: number): Promise<MetForecast | null> {
    const key = `${roundCoord(lat)},${roundCoord(lon)}`;
    let e = this.#kept.get(key);
    if (!e) {
      if (this.#kept.size >= KEPT_MAX) this.#kept.delete(this.#kept.keys().next().value as string);
      e = { forecast: null, lastModified: null, nextAt: 0, pending: null };
      this.#kept.set(key, e);
    }
    const entry = e;
    if (this.services.clock().getTime() >= entry.nextAt) {
      entry.pending ??= this.#read(entry, lat, lon).finally(() => {
        entry.pending = null;
      });
      await entry.pending;
    }
    return entry.forecast;
  }

  async #read(e: Entry, lat: number, lon: number): Promise<void> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (e.lastModified && e.forecast) headers['if-modified-since'] = e.lastModified;
    try {
      const res = await openDataGet(this.services, metForecastUrl(lat, lon), headers);
      const now = this.services.clock().getTime();
      const expires = Date.parse(headerOf(res, 'expires') ?? '');
      if (res.status === 304 && e.forecast) {
        e.nextAt = nextAskAt(now, Number.isFinite(expires) ? expires : null, this.random());
        return;
      }
      // 203: MET will retire this version one day; the answer is still good.
      if (res.status !== 200 && res.status !== 203) throw new Error(`MET answered ${res.status}`);
      const forecast = parseMetForecast(JSON.parse(res.body.toString('utf8')));
      if (!forecast || forecast.steps.length === 0) throw new Error('MET’s answer had no forecast');
      e.forecast = forecast;
      e.lastModified = headerOf(res, 'last-modified') ?? null;
      e.nextAt = nextAskAt(now, Number.isFinite(expires) ? expires : null, this.random());
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'weather: MET Norway’s forecast couldn’t be read');
      e.nextAt = this.services.clock().getTime() + WEATHER_RETRY_MS;
    }
  }
}

const services_ = new WeakMap<Services, WeatherService>();

/** The Whombat's one weather service. */
export function weatherFor(services: Services): WeatherService {
  let w = services_.get(services);
  if (!w) {
    w = new WeatherService(services);
    services_.set(services, w);
  }
  return w;
}
