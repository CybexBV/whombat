/**
 * Looking a place up on OpenStreetMap's Nominatim (docs/decisions/weather-news.md): a town, city or address the person
 * typed, or the latitude and longitude of *Use my location* (sent rounded to two decimals). Its policy counts every
 * Whombat together as one application, so each box asks at most once a second and keeps every answer for a day; it
 * asks only when someone asks (Settings, the assistant), never in the background. Only what is looked up leaves the
 * box, with Whombat's User-Agent.
 */
import {
  PLACE_FIND_MAX,
  PLACE_NAME_MAX,
  type Place,
  type PlaceFindQuery,
  PlaceRegionCode,
  roundCoord,
} from '@whombat/core';
import { ApiError } from '../lib/errors';
import { openDataGet } from '../lib/open-data';
import type { Services } from '../services';

export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
/** Nominatim's own limit for every Whombat together is one a second: each box keeps to it on its own. */
export const NOMINATIM_GAP_MS = 1_000;
/** An answer is kept this long. */
export const NOMINATIM_KEEP_MS = 24 * 3_600_000;
/** A look-up waits at most this long for its turn; past it the person is asked to try again. */
const QUEUE_MAX_MS = 5_000;
const KEPT_MAX = 500;

export const PLACE_FIND_WORDS = {
  busy: 'Many look-ups at once. Try again in a moment.',
  failed: 'Couldn’t look that up just now. Try again in a moment.',
} as const;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A name as a place keeps it: one line, at most `PLACE_NAME_MAX` characters. */
function nameOf(v: string | undefined): string | undefined {
  const one = v?.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  return one ? one.slice(0, PLACE_NAME_MAX) : undefined;
}

/**
 * The places of a Nominatim answer (`format=jsonv2`, `addressdetails=1`; a search's list or a reverse's one), best first,
 * each once: its name (the place's own, else its town), its country, its ISO 3166-2 region (level 4) and area (level 6)
 * when Nominatim names them, the region's name, its latitude and longitude rounded. Without a country, none. Pure.
 */
export function nominatimPlaces(json: unknown): Place[] {
  const items = Array.isArray(json) ? json : json && typeof json === 'object' ? [json] : [];
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const a = (o.address && typeof o.address === 'object' ? o.address : {}) as Record<string, unknown>;
    const lat = Number(o.lat);
    const lon = Number(o.lon);
    const country = str(a.country_code)?.toUpperCase();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !country || !/^[A-Z]{2}$/.test(country)) continue;
    const town =
      str(a.city) ?? str(a.town) ?? str(a.village) ?? str(a.municipality) ?? str(a.hamlet) ?? str(a.suburb);
    const name = nameOf(str(o.name) ?? town ?? str(o.display_name)?.split(',')[0]);
    if (!name) continue;
    const code = (key: string) => {
      const v = str(a[key])?.toUpperCase();
      return v && PlaceRegionCode.safeParse(v).success && v.startsWith(`${country}-`) ? v : undefined;
    };
    const region = code('ISO3166-2-lvl4');
    const area = code('ISO3166-2-lvl6');
    const regionName = nameOf(str(a.state) ?? str(a.province) ?? str(a.region));
    const place: Place = {
      name,
      lat: roundCoord(lat),
      lon: roundCoord(lon),
      country,
      ...(region ? { region } : {}),
      ...(area ? { area } : {}),
      ...(regionName ? { regionName } : {}),
      guessed: false,
    };
    const key = `${name}\n${country}\n${region ?? ''}\n${area ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(place);
    if (out.length >= PLACE_FIND_MAX) break;
  }
  return out;
}

/** The address of a look-up: a search by words, or the place at a latitude and longitude (to two decimals). */
export function nominatimUrl(query: PlaceFindQuery): string {
  const p = new URLSearchParams({ format: 'jsonv2', addressdetails: '1' });
  if (query.query !== undefined) {
    p.set('q', query.query);
    p.set('limit', String(PLACE_FIND_MAX));
    return `${NOMINATIM_URL}/search?${p}`;
  }
  p.set('lat', String(roundCoord(query.lat ?? 0)));
  p.set('lon', String(roundCoord(query.lon ?? 0)));
  // A town's level, not a street's.
  p.set('zoom', '10');
  return `${NOMINATIM_URL}/reverse?${p}`;
}

/** What a look-up is kept by: the words as typed (case and spaces aside), or the rounded latitude and longitude. */
export function nominatimKey(query: PlaceFindQuery): string {
  return query.query !== undefined
    ? `q:${query.query.trim().toLowerCase().replace(/\s+/g, ' ')}`
    : `ll:${roundCoord(query.lat ?? 0)},${roundCoord(query.lon ?? 0)}`;
}

/** The look-ups of one Whombat: at most one a second, each answer kept a day. */
export class PlaceFinder {
  readonly #kept = new Map<string, { places: Place[]; until: number }>();
  /** When the last look-up may go, so the next waits for its second. */
  #next = 0;

  constructor(
    private readonly services: Services,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  ) {}

  /** The places for a query, best first; kept answers without asking again. Throws `ApiError` when it can't ask. */
  async find(query: PlaceFindQuery): Promise<Place[]> {
    const key = nominatimKey(query);
    const now = this.services.clock().getTime();
    const kept = this.#kept.get(key);
    if (kept && kept.until > now) return kept.places;
    const at = Math.max(now, this.#next);
    if (at - now > QUEUE_MAX_MS) throw new ApiError('rate_limited', PLACE_FIND_WORDS.busy);
    this.#next = at + NOMINATIM_GAP_MS;
    if (at > now) await this.wait(at - now);
    let places: Place[];
    try {
      const res = await openDataGet(this.services, nominatimUrl(query), { accept: 'application/json' });
      if (res.status !== 200) throw new Error(`Nominatim answered ${res.status}`);
      places = nominatimPlaces(JSON.parse(res.body.toString('utf8')));
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'place: Nominatim couldn’t be asked');
      throw new ApiError('unavailable', PLACE_FIND_WORDS.failed);
    }
    if (this.#kept.size >= KEPT_MAX) this.#kept.delete(this.#kept.keys().next().value as string);
    this.#kept.set(key, { places, until: this.services.clock().getTime() + NOMINATIM_KEEP_MS });
    return places;
  }
}

const finders = new WeakMap<Services, PlaceFinder>();

/** The Whombat's one place finder (its pace and what it kept are the box's). */
export function placeFinderFor(services: Services): PlaceFinder {
  let f = finders.get(services);
  if (!f) {
    f = new PlaceFinder(services);
    finders.set(services, f);
  }
  return f;
}
