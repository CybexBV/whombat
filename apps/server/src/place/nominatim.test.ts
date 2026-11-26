import { Place } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors';
import { type OpenDataAnswer, useOpenDataForTests } from '../lib/open-data';
import type { Services } from '../services';
import { NOMINATIM_KEEP_MS, nominatimKey, nominatimPlaces, nominatimUrl, PlaceFinder } from './nominatim';

/** A search's answer as Nominatim gives it (`format=jsonv2`, `addressdetails=1`), cut to what Whombat reads. */
const SEARCH = [
  {
    place_id: 1,
    lat: '51.5887845',
    lon: '4.7760657',
    category: 'boundary',
    type: 'administrative',
    addresstype: 'city',
    name: 'Breda',
    display_name: 'Breda, Noord-Brabant, Nederland',
    address: {
      city: 'Breda',
      state: 'Noord-Brabant',
      'ISO3166-2-lvl4': 'NL-NB',
      country: 'Nederland',
      country_code: 'nl',
    },
  },
  // The same place again, from another object: once.
  {
    lat: '51.59',
    lon: '4.78',
    name: 'Breda',
    address: { city: 'Breda', state: 'Noord-Brabant', 'ISO3166-2-lvl4': 'NL-NB', country_code: 'nl' },
  },
  // No country: left out.
  { lat: '1', lon: '2', name: 'Nowhere', address: {} },
  {
    lat: '50.6450944',
    lon: '5.5736112',
    name: 'Liège',
    address: {
      city: 'Liège',
      state: 'Wallonie',
      'ISO3166-2-lvl4': 'BE-WAL',
      province: 'Liège',
      'ISO3166-2-lvl6': 'BE-WLG',
      country_code: 'be',
    },
  },
  // A code of another country, or not a code: left out of the place.
  {
    lat: '48.85',
    lon: '2.35',
    name: 'Paris',
    address: { 'ISO3166-2-lvl4': 'NL-NB', country_code: 'fr', state: 'Île-de-France' },
  },
];

/** A reverse look-up's answer: one object, the town's name in its address. */
const REVERSE = {
  lat: '52.0907006',
  lon: '5.1215634',
  name: '',
  display_name: 'Utrecht, Nederland',
  address: { city: 'Utrecht', state: 'Utrecht', 'ISO3166-2-lvl4': 'NL-UT', country_code: 'nl' },
};

describe('Nominatim’s answer', () => {
  it('gives each place once with its country, region, area and region’s name, two decimals', () => {
    const places = nominatimPlaces(SEARCH);
    expect(places).toEqual([
      {
        name: 'Breda',
        lat: 51.59,
        lon: 4.78,
        country: 'NL',
        region: 'NL-NB',
        regionName: 'Noord-Brabant',
        guessed: false,
      },
      {
        name: 'Liège',
        lat: 50.65,
        lon: 5.57,
        country: 'BE',
        region: 'BE-WAL',
        area: 'BE-WLG',
        regionName: 'Wallonie',
        guessed: false,
      },
      { name: 'Paris', lat: 48.85, lon: 2.35, country: 'FR', regionName: 'Île-de-France', guessed: false },
    ]);
    for (const p of places) expect(Place.safeParse(p).success).toBe(true);
  });

  it('names a reverse look-up by its town', () => {
    expect(nominatimPlaces(REVERSE)).toEqual([
      {
        name: 'Utrecht',
        lat: 52.09,
        lon: 5.12,
        country: 'NL',
        region: 'NL-UT',
        regionName: 'Utrecht',
        guessed: false,
      },
    ]);
    expect(nominatimPlaces({ error: 'Unable to geocode' })).toEqual([]);
    expect(nominatimPlaces('nope')).toEqual([]);
  });
});

describe('a look-up', () => {
  it('asks by words, or by a latitude and longitude rounded to a town’s level', () => {
    expect(nominatimUrl({ query: 'Breda' })).toBe(
      'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&q=Breda&limit=5',
    );
    expect(nominatimUrl({ lat: 52.090701, lon: 5.121563 })).toBe(
      'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=52.09&lon=5.12&zoom=10',
    );
    expect(nominatimKey({ query: '  breda ' })).toBe(nominatimKey({ query: 'Breda' }));
  });
});

describe('the place finder', () => {
  function world(answer: () => OpenDataAnswer) {
    let now = Date.parse('2026-11-26T08:00:00Z');
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const waits: number[] = [];
    const services = {
      clock: () => new Date(now),
      log: { warn: () => undefined },
      config: { NODE_ENV: 'test' },
    } as unknown as Services;
    useOpenDataForTests(services, async (url, headers) => {
      asked.push({ url, headers });
      return answer();
    });
    const finder = new PlaceFinder(services, async (ms) => {
      waits.push(ms);
    });
    return { finder, asked, waits, later: (ms: number) => (now += ms) };
  }
  const json = (body: unknown): OpenDataAnswer => ({
    status: 200,
    headers: {},
    body: Buffer.from(JSON.stringify(body)),
  });

  it('asks as Whombat, at most once a second, and keeps each answer a day', async () => {
    const w = world(() => json(SEARCH));
    expect((await w.finder.find({ query: 'Breda' }))[0]?.name).toBe('Breda');
    expect(w.asked[0]?.headers['user-agent']).toMatch(/^Whombat\/\S+ \(\+https:\/\/whombat\.com\)$/);
    await w.finder.find({ query: 'Liège' });
    expect(w.waits).toEqual([1000]);
    await w.finder.find({ query: 'breda' });
    expect(w.asked).toHaveLength(2);
    w.later(NOMINATIM_KEEP_MS);
    await w.finder.find({ query: 'Breda' });
    expect(w.asked).toHaveLength(3);
  });

  it('says it can’t look up when Nominatim fails, and that it is busy when too many wait', async () => {
    const w = world(() => ({ status: 503, headers: {}, body: Buffer.alloc(0) }));
    await expect(w.finder.find({ query: 'Breda' })).rejects.toMatchObject({ code: 'unavailable' });
    const slow = world(() => json([]));
    // Each look-up takes its second: the seventh would wait more than five.
    const many = Array.from({ length: 7 }, (_, i) =>
      slow.finder.find({ query: `Town ${i}` }).catch((e) => e),
    );
    const out = await Promise.all(many);
    expect(out.filter((o) => o instanceof ApiError).map((e) => (e as ApiError).code)).toEqual([
      'rate_limited',
    ]);
  });
});
