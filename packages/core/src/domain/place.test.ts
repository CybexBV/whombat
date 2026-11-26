import { describe, expect, it } from 'vitest';
import { Burrow } from './burrow.js';
import {
  Place,
  PlaceFindQuery,
  PlaceSetBody,
  placeFromTimeZone,
  placeLabel,
  roundCoord,
  roundPlace,
  timeZoneNear,
} from './place.js';
import { ZONE_LINKS, ZONE_PLACES } from './place-zones.js';

describe('the place a time zone suggests', () => {
  it('is the zone’s own city, in its country, guessed', () => {
    expect(placeFromTimeZone('Europe/Amsterdam')).toEqual({
      name: 'Amsterdam',
      lat: 52.37,
      lon: 4.9,
      country: 'NL',
      guessed: true,
    });
    expect(placeFromTimeZone('America/Argentina/Buenos_Aires')).toMatchObject({
      name: 'Buenos Aires',
      country: 'AR',
    });
    expect(placeFromTimeZone('Australia/Sydney')).toMatchObject({ country: 'AU', lat: -33.87, lon: 151.22 });
  });

  it('keeps each country its own zone, not a neighbour’s', () => {
    expect(placeFromTimeZone('Europe/Brussels')?.country).toBe('BE');
    expect(placeFromTimeZone('Europe/Luxembourg')?.country).toBe('LU');
    expect(placeFromTimeZone('Arctic/Longyearbyen')?.country).toBe('SJ');
  });

  it('knows older and other names of a zone', () => {
    expect(placeFromTimeZone('Asia/Calcutta')).toMatchObject({ name: 'Kolkata', country: 'IN' });
    expect(placeFromTimeZone('Europe/Kiev')).toMatchObject({ name: 'Kyiv', country: 'UA' });
    expect(placeFromTimeZone('US/Eastern')).toMatchObject({ name: 'New York', country: 'US' });
  });

  it('guesses nothing for a zone of no country or one it doesn’t know', () => {
    for (const zone of ['UTC', 'Etc/UTC', 'Etc/GMT+1', 'CET', 'EST5EDT', 'Mars/Olympus', ''])
      expect([zone, placeFromTimeZone(zone)]).toEqual([zone, null]);
  });

  it('comes from a table of every zone with a country and two decimals', () => {
    expect(Object.keys(ZONE_PLACES).length).toBeGreaterThan(400);
    for (const [zone, [country, lat, lon]] of Object.entries(ZONE_PLACES)) {
      expect([zone, /^[A-Z]{2}$/.test(country)]).toEqual([zone, true]);
      expect([zone, roundCoord(lat), roundCoord(lon)]).toEqual([zone, lat, lon]);
      expect(Place.safeParse(placeFromTimeZone(zone)).success).toBe(true);
    }
    for (const [name, zone] of Object.entries(ZONE_LINKS))
      expect([name, zone in ZONE_PLACES]).toEqual([name, true]);
  });
});

describe('the time zone of a place', () => {
  it('is the nearest zone’s, within the place’s country when it has some', () => {
    expect(timeZoneNear(38.72, -9.14, 'PT')).toBe('Europe/Lisbon');
    expect(timeZoneNear(51.59, 4.78, 'NL')).toBe('Europe/Amsterdam');
    // Closer to Brussels, but in the Netherlands.
    expect(timeZoneNear(51.44, 3.57, 'NL')).toBe('Europe/Amsterdam');
    expect(timeZoneNear(51.44, 3.57)).toBe('Europe/Brussels');
    expect(timeZoneNear(40.71, -74.0, 'US')).toBe('America/New_York');
  });
});

describe('a place', () => {
  it('keeps two decimals', () => {
    expect(roundCoord(51.44856)).toBe(51.45);
    expect(roundCoord(-0.004)).toBe(0);
    expect(Object.is(roundCoord(-0.004), -0)).toBe(false);
    expect(roundPlace({ name: 'Utrecht', lat: 52.09074, lon: 5.12142 })).toEqual({
      name: 'Utrecht',
      lat: 52.09,
      lon: 5.12,
    });
  });

  it('is shown with its region when that isn’t its name', () => {
    expect(placeLabel({ name: 'Breda', regionName: 'Noord-Brabant' })).toBe('Breda, Noord-Brabant');
    expect(placeLabel({ name: 'Utrecht', regionName: 'Utrecht' })).toBe('Utrecht');
    expect(placeLabel({ name: 'Amsterdam' })).toBe('Amsterdam');
  });

  it('carries its country and region codes as ISO 3166 has them', () => {
    const place = {
      name: 'Liège',
      lat: 50.63,
      lon: 5.57,
      country: 'BE',
      region: 'BE-WAL',
      area: 'BE-WLG',
      regionName: 'Wallonie',
      guessed: false,
    };
    expect(Place.parse(place)).toEqual(place);
    expect(Place.safeParse({ ...place, country: 'be' }).success).toBe(false);
    expect(Place.safeParse({ ...place, region: 'Wallonie' }).success).toBe(false);
    expect(Place.safeParse({ ...place, lat: 91 }).success).toBe(false);
    expect(PlaceSetBody.safeParse({ place: null }).success).toBe(true);
    expect(PlaceSetBody.safeParse({ place }).success).toBe(true);
  });

  it('is the burrow’s, or none from an older box', () => {
    const burrow = {
      id: 'bur_x',
      name: 'Home',
      slug: 'home',
      timeZone: 'Europe/Amsterdam',
      createdAt: '2026-11-26T09:00:00.000Z',
    };
    expect(Burrow.parse(burrow).place).toBeNull();
    const place = placeFromTimeZone(burrow.timeZone);
    expect(Burrow.parse({ ...burrow, place }).place).toEqual(place);
  });
});

describe('looking a place up', () => {
  it('takes a name or a latitude and longitude, not both and not half', () => {
    expect(PlaceFindQuery.safeParse({ query: 'Utrecht' }).success).toBe(true);
    expect(PlaceFindQuery.parse({ lat: '52.09', lon: '5.12' })).toEqual({ lat: 52.09, lon: 5.12 });
    expect(PlaceFindQuery.safeParse({}).success).toBe(false);
    expect(PlaceFindQuery.safeParse({ lat: 52.09 }).success).toBe(false);
    expect(PlaceFindQuery.safeParse({ query: 'Utrecht', lat: 52.09, lon: 5.12 }).success).toBe(false);
    expect(PlaceFindQuery.safeParse({ query: 'U' }).success).toBe(false);
  });
});
