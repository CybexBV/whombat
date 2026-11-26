/**
 * Where this Whombat is, its news sites, and the weather and the news for the assistant, end to end (weather-news.md):
 * the place guessed from the time zone, looked up and kept; the suggested sites for it turned on, a site of the person's
 * own added; the assistant's two tools reading MET Norway and the feeds. OpenStreetMap, MET and the sites are answered
 * by fakes through the open-data seam. It needs Postgres: the place and the sites are kept on the burrow's row through
 * the commit pipeline, which signs each change.
 */
import { api, buildPath, NEWS_SUGGESTIONS, NewsSourcesView, WeatherForecastOutput } from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { burrows, events } from '../db/schema/index';
import { type OpenDataAnswer, useOpenDataForTests } from '../lib/open-data';
import { TOOL_HANDLERS, type ToolContext } from '../mcp/tools';
import type { DispatchRow } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { metAnswer } from '../weather/testing';

// biome-ignore lint/suspicious/noExplicitAny: the tests read nested JSON bodies.
type Body = Record<string, any>;

const t = useTestServer({ seed: true, app: true });
const B = { burrow: 'burrow-hq' };
const asked: { url: string; headers: Record<string, string> }[] = [];

const json = (body: unknown): OpenDataAnswer => ({
  status: 200,
  headers: {},
  body: Buffer.from(JSON.stringify(body)),
});
const text = (body: string): OpenDataAnswer => ({ status: 200, headers: {}, body: Buffer.from(body) });

const BREDA = {
  lat: '51.5887845',
  lon: '4.7760657',
  name: 'Breda',
  address: { city: 'Breda', state: 'Noord-Brabant', 'ISO3166-2-lvl4': 'NL-NB', country_code: 'nl' },
};
const LISBON = {
  lat: '38.7077507',
  lon: '-9.1365919',
  name: 'Lisboa',
  address: { city: 'Lisboa', state: 'Lisboa', country_code: 'pt' },
};
const BRABANT = NEWS_SUGGESTIONS.find((s) => s.id === 'nl-omroep-brabant')?.url ?? '';
const NOS = NEWS_SUGGESTIONS.find((s) => s.id === 'nl-nos')?.url ?? '';
const rss = (title: string, link: string) =>
  `<rss><channel><title>Feed</title><item><title>${title}</title><link>${link}</link><pubDate>${new Date(
    Date.now() - 3_600_000,
  ).toUTCString()}</pubDate></item></channel></rss>`;

/** OpenStreetMap, MET Norway and the news sites, as the tests need them. */
function fake(url: string): OpenDataAnswer {
  const u = new URL(url);
  if (u.hostname === 'nominatim.openstreetmap.org')
    return json(u.searchParams.get('q')?.startsWith('Lis') ? [LISBON] : [BREDA]);
  if (u.hostname === 'api.met.no') {
    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
    return json(metAnswer(hour));
  }
  if (url === BRABANT) return text(rss('Bridge closed in the city centre', 'https://news.example.com/1'));
  if (url === NOS) return text(rss('Rail strike on Monday', 'https://news.example.com/2'));
  if (url === 'https://own.example.com/')
    return text(
      '<html><head><title>Own</title><link rel="alternate" type="application/atom+xml" href="/atom"></head></html>',
    );
  if (url === 'https://own.example.com/atom')
    return text(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>Own News</title><entry><title>Market moves to Friday</title><link href="https://own.example.com/3"/><updated>${new Date(Date.now() - 7_200_000).toISOString()}</updated></entry></feed>`,
    );
  return { status: 404, headers: {}, body: Buffer.alloc(0) };
}

beforeAll(() => {
  useOpenDataForTests(t.services, async (url, headers) => {
    asked.push({ url, headers });
    return fake(url);
  });
});

async function call(method: 'GET' | 'PUT' | 'POST', path: string, payload?: object) {
  const { cookie } = await sessionFor(t.services, IDS.mara);
  const res = await t.api.inject({
    method,
    url: `/api/v1${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.json() as Body };
}

const burrowNow = async () => (await call('GET', buildPath(api.burrows.get.path, B))).body.burrow;
const news = () => call('GET', buildPath(api.news.sources.path, B));

function toolCtx(): ToolContext {
  return {
    services: t.services,
    agentId: IDS.dusty,
    burrowId: t.burrowId,
    dispatch: { id: 'dsp_weather_news', trigger: 'dm', burrowId: t.burrowId } as DispatchRow,
    onBehalfOf: {},
  };
}

describe('where this Whombat is', () => {
  it('is guessed from the time zone until the person chooses', async () => {
    expect((await burrowNow()).place).toEqual({
      name: 'Amsterdam',
      lat: 52.37,
      lon: 4.9,
      country: 'NL',
      guessed: true,
    });
  });

  it('is looked up on OpenStreetMap as Whombat, once for the same words', async () => {
    const before = asked.length;
    const found = await call('GET', `${buildPath(api.place.find.path, B)}?query=Breda`);
    expect(found.status).toBe(200);
    expect(found.body.places[0]).toMatchObject({
      name: 'Breda',
      region: 'NL-NB',
      lat: 51.59,
      guessed: false,
    });
    expect(asked.at(-1)?.headers['user-agent']).toMatch(/^Whombat\//);
    await call('GET', `${buildPath(api.place.find.path, B)}?query=breda`);
    expect(asked.length).toBe(before + 1);
    const half = await call('GET', `${buildPath(api.place.find.path, B)}?lat=51.5`);
    expect(half.status).toBe(400);
  });

  it('is kept as chosen, signed by its name only, and goes back to the guess', async () => {
    const place = {
      name: 'Breda',
      lat: 51.5887845,
      lon: 4.7760657,
      country: 'NL',
      region: 'NL-NB',
      regionName: 'Noord-Brabant',
    };
    const set = await call('PUT', buildPath(api.place.set.path, B), { place });
    expect(set.status).toBe(200);
    expect(set.body.burrow.place).toEqual({ ...place, lat: 51.59, lon: 4.78, guessed: false });
    const [row] = await t.services.db.select().from(burrows).where(eq(burrows.id, t.burrowId));
    expect(row?.place).toMatchObject({ lat: 51.59, lon: 4.78 });
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.burrowId, t.burrowId), eq(events.type, 'burrow.updated')))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(event?.text).toContain('Breda, Noord-Brabant');
    expect(JSON.stringify(event)).not.toContain('51.5');
    const back = await call('PUT', buildPath(api.place.set.path, B), { place: null });
    expect(back.body.burrow.place).toMatchObject({ name: 'Amsterdam', guessed: true });
    await call('PUT', buildPath(api.place.set.path, B), { place });
  });
});

describe('the news sites', () => {
  it('are suggested for the place, the region’s first, and none is on', async () => {
    const view = NewsSourcesView.parse((await news()).body);
    expect(view.chosen).toEqual([]);
    expect(view.suggestions.slice(0, 2).map((s) => [s.id, s.near])).toEqual([
      ['nl-omroep-brabant', 'region'],
      ['nl-nos', 'country'],
    ]);
  });

  it('turn on by id, and refuse an id Whombat doesn’t know', async () => {
    const on = await call('PUT', buildPath(api.news.setSources.path, B), {
      ids: ['nl-omroep-brabant', 'nl-nos'],
    });
    expect(on.status).toBe(200);
    expect(on.body.chosen.map((s: Body) => [s.id, s.own])).toEqual([
      ['nl-omroep-brabant', false],
      ['nl-nos', false],
    ]);
    expect(on.body.suggestions.map((s: Body) => s.id)).not.toContain('nl-nos');
    const bad = await call('PUT', buildPath(api.news.setSources.path, B), { ids: ['nl-nos', 'not-a-site'] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
  });

  it('take a site of the person’s own by the feed its page names', async () => {
    const added = await call('POST', buildPath(api.news.addSite.path, B), { url: 'own.example.com' });
    expect(added.status).toBe(200);
    expect(added.body.added).toMatchObject({
      name: 'Own News',
      url: 'https://own.example.com/atom',
      own: true,
    });
    expect(added.body.news.chosen).toHaveLength(3);
    const refused = await call('POST', buildPath(api.news.addSite.path, B), {
      url: 'https://gone.example.com/',
    });
    expect(refused.status).toBe(400);
    expect(Object.keys(refused.body.error.fields)).toEqual(['url']);
  });
});

describe('the assistant’s weather and news', () => {
  it('gives the forecast where this Whombat is, and for a town it names', async () => {
    const here = WeatherForecastOutput.parse(await TOOL_HANDLERS.weather_forecast(toolCtx(), { days: 2 }));
    if (here.status !== 'ok') throw new Error(here.status);
    expect(here.place).toMatchObject({ name: 'Breda', guessed: false });
    expect(here.days).toHaveLength(2);
    expect(here.credit).toBe('Data from MET Norway');
    expect(asked.some((a) => a.url.startsWith('https://api.met.no/') && a.url.includes('lat=51.59'))).toBe(
      true,
    );
    const there = WeatherForecastOutput.parse(
      await TOOL_HANDLERS.weather_forecast(toolCtx(), { place: 'Lisbon' }),
    );
    if (there.status !== 'ok') throw new Error(there.status);
    expect(there.place.country).toBe('PT');
    // Lisbon's own hours.
    expect(there.now.at).toMatch(/\+00:00$/);
  });

  it('gives the headlines of the sites that are on, newest first, filtered here', async () => {
    const all = await TOOL_HANDLERS.news_headlines(toolCtx(), {});
    if (all.status !== 'ok') throw new Error(all.status);
    expect(all.headlines.map((h) => h.source)).toEqual(
      expect.arrayContaining(['Omroep Brabant', 'NOS Nieuws', 'Own News']),
    );
    expect(all.headlines[0]?.at).toMatch(/\+0[12]:00$/);
    const strike = await TOOL_HANDLERS.news_headlines(toolCtx(), { query: 'STRIKE' });
    expect(strike.status === 'ok' && strike.headlines.map((h) => h.title)).toEqual(['Rail strike on Monday']);
    await call('PUT', buildPath(api.news.setSources.path, B), { ids: [] });
    expect((await TOOL_HANDLERS.news_headlines(toolCtx(), {})).status).toBe('none');
  });
});
