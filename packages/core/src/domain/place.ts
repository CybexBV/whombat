/**
 * Where this Whombat is (Whombat docs/decisions/weather-news.md): the place the weather and the suggested local news are
 * for. One per burrow (`Burrow.place`). Until the person chooses one it is guessed from the burrow's time zone, without
 * asking anyone (`placeFromTimeZone`); the person or the assistant looks one up (`place.find`, OpenStreetMap's
 * Nominatim) and keeps it (`place.set`), or goes back to the guess (`place.set` with null).
 *
 * Latitude and longitude are kept to two decimals (about 1 km): enough for a forecast, and no closer to the house than
 * that.
 */
import { z } from 'zod';
import { ZONE_LINKS, ZONE_PLACES } from './place-zones.js';

/** Decimals kept of a latitude or longitude. */
export const PLACE_COORD_DECIMALS = 2;

/** A latitude or longitude to `PLACE_COORD_DECIMALS` decimals. */
export function roundCoord(value: number): number {
  const f = 10 ** PLACE_COORD_DECIMALS;
  // `+ 0` turns -0 into 0, so the same place is written the same way.
  return Math.round(value * f) / f + 0;
}

/** A country, ISO 3166-1 alpha-2, upper case: `NL`. */
export const PlaceCountry = z.string().regex(/^[A-Z]{2}$/);
/** A part of a country, ISO 3166-2: `NL-NB` (a province), `BE-VOV`, `FR-20R`, Austria's Länder by number. */
export const PlaceRegionCode = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/);

export const PLACE_NAME_MAX = 80;
const PlaceName = z.string().trim().min(1).max(PLACE_NAME_MAX);

/**
 * A place as the person chose it (or the assistant for them), without whether it was guessed: its name (“Utrecht”), its
 * latitude and longitude, its country, its region (ISO 3166-2 level 4: a province, state, Land or nation) and, where
 * Nominatim names one, its area (level 6: a Belgian province, a French département), and the region's name
 * (“Noord-Brabant”).
 */
export const PlaceInput = z.object({
  name: PlaceName,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  country: PlaceCountry,
  region: PlaceRegionCode.optional(),
  area: PlaceRegionCode.optional(),
  regionName: PlaceName.optional(),
});
export type PlaceInput = z.infer<typeof PlaceInput>;

/** A place, and whether it was only guessed from the time zone (`guessed`) or chosen. */
export const Place = PlaceInput.extend({ guessed: z.boolean() });
export type Place = z.infer<typeof Place>;

/** A place with its latitude and longitude rounded, as it is kept. */
export function roundPlace<P extends { lat: number; lon: number }>(place: P): P {
  return { ...place, lat: roundCoord(place.lat), lon: roundCoord(place.lon) };
}

/** The zone of a time zone name: itself when `zone.tab` lists it, the zone an older or other name stands for, or null. */
function listedZone(timeZone: string): string | null {
  if (Object.hasOwn(ZONE_PLACES, timeZone)) return timeZone;
  const linked = Object.hasOwn(ZONE_LINKS, timeZone) ? ZONE_LINKS[timeZone] : undefined;
  return linked && Object.hasOwn(ZONE_PLACES, linked) ? linked : null;
}

/** The city a zone is named after: `Europe/Amsterdam` “Amsterdam”, `America/Argentina/Buenos_Aires` “Buenos Aires”. */
function zoneCity(zone: string): string {
  return (zone.split('/').pop() ?? zone).replaceAll('_', ' ');
}

/**
 * The place a time zone suggests, without asking anyone: the city its zone is named after, in that zone's country
 * (`Europe/Amsterdam` → Amsterdam, NL, 52.37, 4.9), `guessed`, no region. Null for a zone of no country (`UTC`,
 * `Etc/GMT+1`) or one the table doesn't know.
 */
export function placeFromTimeZone(timeZone: string): Place | null {
  const zone = listedZone(timeZone.trim());
  if (!zone) return null;
  const [country, lat, lon] = ZONE_PLACES[zone] as readonly [string, number, number];
  return { name: zoneCity(zone), lat, lon, country, guessed: true };
}

/**
 * The time zone a place most likely keeps: the zone whose city is nearest, among its country's when the country has any
 * (a forecast for Lisbon is told in Lisbon's hours). Null without any zone in the table, which never happens.
 */
export function timeZoneNear(lat: number, lon: number, country?: string): string | null {
  const zones = Object.entries(ZONE_PLACES);
  const own = country ? zones.filter(([, [c]]) => c === country) : [];
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [zone, [, zLat, zLon]] of own.length ? own : zones) {
    // The angle between the two on the globe (the haversine's), enough to compare.
    const dLat = ((zLat - lat) * Math.PI) / 180;
    const dLon = ((zLon - lon) * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat * Math.PI) / 180) * Math.cos((zLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    if (h < bestDistance) {
      bestDistance = h;
      best = zone;
    }
  }
  return best;
}

/** What Settings shows of a place: “Utrecht”, “Breda, Noord-Brabant” (its region when that isn't its name). */
export function placeLabel(place: Pick<Place, 'name' | 'regionName'>): string {
  return place.regionName && place.regionName !== place.name
    ? `${place.name}, ${place.regionName}`
    : place.name;
}

/** `place.find` answers at most this many places. */
export const PLACE_FIND_MAX = 5;
/** The longest text `place.find` looks up. */
export const PLACE_QUERY_MAX = 120;

/**
 * What `place.find` looks up: a town, city or address the person typed, or a latitude and longitude (the device's own
 * location, *Use my location*) — one of the two.
 */
export const PlaceFindQuery = z
  .object({
    query: z.string().trim().min(2).max(PLACE_QUERY_MAX).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lon: z.coerce.number().min(-180).max(180).optional(),
  })
  .refine(
    (q) => (q.query !== undefined) !== (q.lat !== undefined && q.lon !== undefined),
    'Give a name to look up, or a latitude and longitude.',
  )
  .refine((q) => (q.lat === undefined) === (q.lon === undefined), 'Give a latitude and a longitude.');
export type PlaceFindQuery = z.infer<typeof PlaceFindQuery>;

/** `place.find`'s answer: up to `PLACE_FIND_MAX` places, best first, none guessed. */
export const PlaceFindResult = z.object({ places: z.array(Place).max(PLACE_FIND_MAX) });
export type PlaceFindResult = z.infer<typeof PlaceFindResult>;

/** `place.set`: the place to keep, or null to go back to the time zone's guess. */
export const PlaceSetBody = z.strictObject({ place: PlaceInput.nullable() });
export type PlaceSetBody = z.input<typeof PlaceSetBody>;

/** The words Settings → This Whombat shows about the place (web and phone alike). */
export const PLACE_SETTING_WORDS = {
  title: 'Place',
  about: 'Where this Whombat is, for the weather and local news.',
  guessed: '{place} · guessed from the time zone',
  none: 'Not set',
  change: 'Change',
  search: 'Town or city',
  searchButton: 'Search',
  useLocation: 'Use my location',
  useGuess: 'Use the time zone’s guess',
  /** OpenStreetMap's data is ODbL: its credit stays by the results. */
  credit: '© OpenStreetMap',
  noResults: 'Nothing found by that name. Try another spelling or a bigger town nearby.',
  failed: 'Couldn’t look that up just now. Try again in a moment.',
  noLocation: 'This device didn’t share its location.',
  saved: 'Saved. The weather and news are for {place} now.',
} as const;
