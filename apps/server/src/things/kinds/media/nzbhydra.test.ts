/**
 * NZBHydra2's page and card from recorded answers (SD-23, SD-10): indexers switched off after errors, limits, VIP,
 * searches and grabs today, the app that asked, and the indexer state read with the key in the body. Pure, with a fake
 * connection fetch.
 */
import type { ThingPagePanel } from '@whombat/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { forgetKindReads } from '../read';
import { slotProblems } from '../slots';
import {
  appOf,
  HYDRA_CHECKS,
  type HydraIndexer,
  type HydraInput,
  type HydraSnapshot,
  hydraKpis,
  hydraMachineLines,
  hydraNotices,
  hydraSkipped,
  hydraSnapshot,
  hydraView,
  hydraWeek,
  NZBHYDRA_KIND,
  parseGrabs,
  parseIndexers,
  parseWeekGrabs,
  resetOf,
} from './nzbhydra';
import { fixture, rowOf } from './testing';

const http = vi.hoisted(() => ({
  calls: [] as { method: string; url: URL; body: string | null }[],
}));
vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  const { readFileSync } = await import('node:fs');
  const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
  return {
    ...real,
    signedConnectionFetch: async (
      _s: unknown,
      _r: unknown,
      req: { method: string; url: string; body?: unknown },
    ) => {
      const url = new URL(req.url);
      http.calls.push({ method: req.method, url, body: typeof req.body === 'string' ? req.body : null });
      const files: Record<string, string> = {
        '/externalapi/v1/ping': 'hydra-ping.json',
        '/externalapi/v1/stats': 'hydra-stats.json',
        '/externalapi/v1/history/searches': 'hydra-searches.json',
        '/externalapi/v1/history/downloads': 'hydra-downloads.json',
        '/api/stats/indexers': 'hydra-indexers.json',
      };
      const file = files[url.pathname];
      return file
        ? { status: 200, headers: {}, body: Buffer.from(fx(file)) }
        : { status: 404, headers: {}, body: Buffer.alloc(0) };
    },
  };
});
vi.mock('../../../connections/credentials', () => ({
  resolveCredential: async () => ({
    credential: { headers: {}, query: { apikey: 'k3y' }, version: '1' },
    forms: [],
  }),
}));

// Five minutes after the recorded answers: two indexers off for a while after errors, one switched off by its owner.
const now = new Date('2026-10-21T19:47:00Z');
const TZ = 'Europe/Amsterdam';
const row = rowOf('nzbhydra');

/** A grab as NZBHydra2 9.1's OpenAPI describes it (the throwaway had no indexer that answered). */
const GRABS = {
  page: 1,
  limit: 10,
  totalElements: 2,
  totalPages: 1,
  entries: [
    {
      id: 4321,
      time: '2026-10-21T19:30:00Z',
      title: 'NCIS.S24E03.1080p.WEB.h264-GRP',
      indexer: 'NZBgeek',
      accessType: 'PROXY',
      accessSource: 'API',
      status: 'NZB_ADDED',
      userAgent: 'Sonarr/4.0.20.3014 (alpine 3.24.2)',
    },
    {
      id: 4320,
      time: '2026-10-21T18:02:00Z',
      title: 'Inside.Out.2.2024.1080p.WEB.h264-GRP',
      indexer: 'DrunkenSlug',
      status: 'NZB_DOWNLOAD_ERROR',
      error: 'The indexer did not answer within 10 seconds',
      userAgent: 'Radarr/6.4.4.10685',
    },
  ],
};

function snapshot(more: Partial<HydraSnapshot> = {}): HydraSnapshot {
  return {
    readAt: now,
    version: '9.1.1',
    configured: 3,
    enabled: 0,
    indexers: parseIndexers(fixture('hydra-indexers.json')),
    searchesToday: fixture<{ totalElements: number }>('hydra-searches.json').totalElements,
    grabsToday: 2,
    grabs: parseGrabs(GRABS),
    // Two grabs from NZBgeek today, one two days ago (failed), two the week before.
    week: {
      grabs: [0.01, 0.02, 2, 8, 9].map((d, k) => ({
        at: new Date(now.getTime() - d * 86_400_000),
        indexer: k === 2 ? 'DrunkenSlug' : 'NZBgeek',
        failed: k === 2,
      })),
      complete: true,
      searches: 40,
    },
    ...more,
  };
}

const input = (s: HydraSnapshot, more: Partial<HydraInput> = {}): HydraInput => ({
  snapshot: s,
  now,
  timeZone: TZ,
  url: 'http://192.0.2.10:5076',
  apps: { sonarr: { href: '/things/connection%3Acon_sonarr', name: 'Sonarr' } },
  ...more,
});

const table = (panels: ThingPagePanel[], id: string) => {
  const p = panels.find((x) => x.id === id);
  return p?.kind === 'table' ? p.rows : [];
};

describe('reading NZBHydra2 9.1 (recorded)', () => {
  it('reads each indexer’s state, limits, last error and VIP end', () => {
    const ix = parseIndexers(fixture('hydra-indexers.json'));
    expect(ix.map((i) => [i.name, i.state])).toEqual([
      ['DrunkenSlug', 'DISABLED_SYSTEM_TEMPORARY'],
      ['NZBgeek', 'DISABLED_SYSTEM_TEMPORARY'],
      ['NZBFinder', 'DISABLED_USER'],
    ]);
    expect(ix[1]).toMatchObject({ apiHits: 1, apiLimit: 100, downloadLimit: 50 });
    expect(ix[1]?.vipEnds?.toISOString().slice(0, 10)).toBe('2026-10-30');
    expect(ix[0]?.lastError).toMatch(/Failed to connect/);
  });

  it('knows which app asked by its user agent', () => {
    expect([appOf('Sonarr'), appOf('Radarr/6.4.4'), appOf('Other'), appOf(null)]).toEqual([
      'sonarr',
      'radarr',
      null,
      null,
    ]);
  });

  it('reads with the key in the indexer state’s body, and today’s searches and grabs from midnight', async () => {
    const services = { clock: () => now } as unknown as Services;
    forgetKindReads(services);
    http.calls = [];
    const s = await hydraSnapshot(services, row, now, TZ);
    const post = http.calls.find((c) => c.method === 'POST');
    expect(post?.url.pathname).toBe('/api/stats/indexers');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ apikey: 'k3y' });
    const froms = (path: string) =>
      http.calls.filter((c) => c.url.pathname === path).map((c) => c.url.searchParams.get('from'));
    // Midnight in Amsterdam (CEST) is 22:00 the day before in UTC; the week's starts 6 days before, its grabs 13.
    expect(froms('/externalapi/v1/history/searches').sort()).toEqual([
      '2026-10-14T22:00:00.000Z',
      '2026-10-20T22:00:00.000Z',
    ]);
    expect(froms('/externalapi/v1/history/downloads')).toContain('2026-10-07T22:00:00.000Z');
    expect(s.week).toMatchObject({ grabs: [], complete: true, searches: 2 });
    expect(s.version).toBe('9.1.1');
    expect(s.indexers?.length).toBe(3);
    expect(s.searchesToday).toBe(2);
    expect(http.calls.every((c) => c.method === 'GET' || c.url.pathname === '/api/stats/indexers')).toBe(
      true,
    );
  });
});

describe('reading a week of grabs (NZBHydra2 9.2.0 with a fake indexer, recorded 2026-11-04)', () => {
  it('reads each grab’s time, indexer and whether it failed', () => {
    const week = parseWeekGrabs(fixture('hydra-downloads-week.json'));
    expect(week.complete).toBe(true);
    expect(week.grabs).toEqual([
      { at: new Date('2026-11-04T19:24:26.518839Z'), indexer: 'NZBgeek', failed: false },
      { at: new Date('2026-11-04T19:24:26.470556Z'), indexer: 'NZBgeek', failed: false },
    ]);
    expect(parseWeekGrabs({ totalElements: 900, entries: [{ time: '2026-11-04T19:24:26Z' }] }).complete).toBe(
      false,
    );
  });
});

describe('the page in slots', () => {
  it('follows the slots: Indexers, Today, This week, Recent grabs below', () => {
    const view = hydraView(input(snapshot()));
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['indexers', 'today', 'week', 'grabs']);
  });

  it('shows each indexer as a row: broken first, its limit as the bar, its grabs this week, until when', () => {
    const live = hydraView(input(snapshot())).panels.find((p) => p.id === 'indexers');
    expect(live).toMatchObject({ kind: 'gallery', look: 'rows', shape: 'square' });
    const rows = live?.kind === 'gallery' ? live.items : [];
    expect(rows.map((r) => [r.title, r.badge?.text, r.noteEnd])).toEqual([
      ['DrunkenSlug', 'Off until 21:50', undefined],
      ['NZBgeek', 'Off until 21:50', undefined],
      ['NZBFinder', undefined, 'Switched off'],
    ]);
    const geek = rows[1];
    expect(geek).toMatchObject({ note: '1 of 100 searches', progress: 0.01 });
    // Off after errors: why, in the row's line.
    expect(geek?.sub).toBe('Failed to connect to /172.20.0.1:1');
    const allOn = snapshot({
      indexers: snapshot().indexers?.map((i) => ({ ...i, state: 'ENABLED' })) ?? null,
    });
    const working = hydraView(input(allOn)).panels.find((p) => p.id === 'indexers');
    expect(working?.kind === 'gallery' && working.items.find((r) => r.title === 'NZBgeek')?.sub).toBe(
      '2 grabs this week · 0 of 50 downloads',
    );
    expect(rows[2]?.paused).toBe(true);
    // Working again: how much of its limit is used, and a tag near it.
    const near = snapshot({
      indexers: [{ ...(snapshot().indexers?.[1] as HydraIndexer), state: 'ENABLED', apiHits: 95 }],
    });
    const back = hydraView(input(near)).panels.find((p) => p.id === 'indexers');
    expect(back?.kind === 'gallery' && back.items[0]).toMatchObject({
      noteEnd: '95 %',
      badge: { text: '95 % used', tone: 'warn' },
    });
  });

  it('counts searches and grabs today with the week’s, and how many indexers work', () => {
    const today = hydraView(input(snapshot())).panels.find((p) => p.id === 'today');
    const lines = today?.kind === 'list' ? today.items : [];
    expect(lines.map((l) => [l.title, l.figure?.value, l.figure?.note])).toEqual([
      ['Searches', '2', '40 this week'],
      ['Grabs', '2', '3 this week'],
      ['Indexers working', '0 of 2', '2 off after errors'],
    ]);
    expect(lines[1]?.detail).toBe('1 didn’t work this week');
    expect(lines[2]?.figure?.tone).toBe('bad');
  });

  it('counts grabs per day this week, with the change on the week before only when all came back', () => {
    const week = hydraWeek(snapshot().week, now, TZ);
    expect(week?.series[0]?.values).toEqual([0, 0, 0, 0, 1, 0, 2]);
    expect(week?.figure).toEqual({ value: '3', rest: 'grabs this week' });
    expect(week?.stats?.[0]?.[0]?.text).toBe('+50 %');
    const cut = snapshot().week;
    expect(hydraWeek(cut && { ...cut, complete: false }, now, TZ)?.stats).toBeUndefined();
    expect(hydraWeek(null, now, TZ)).toBeNull();
  });

  it('says its version in the machine card, and that version 9 shows more', () => {
    expect(hydraMachineLines(snapshot()).map((l) => [l.label, l.value, l.sub])).toEqual([
      ['NZBHydra2', '9.1.1', undefined],
    ]);
    expect(hydraMachineLines(snapshot({ version: '7.12.3' }))[0]?.sub).toBe('Version 9 or later shows more');
  });
});

describe('the page (SD-23)', () => {
  it('keeps Indexers working, Searches and Grabs today and the busiest limit for the card', () => {
    const kpis = hydraKpis(input(snapshot()));
    expect(kpis.map((k) => [k.key, k.value])).toEqual([
      ['indexers', '0 of 2'],
      ['searches', '2'],
      ['grabs', '2'],
      ['hits', '1 %'],
    ]);
    expect(kpis[0]?.tone).toBe('bad');
  });

  it('is serious when every indexer is off after errors, and says until when', () => {
    const n = hydraNotices(input(snapshot()));
    const off = n.filter((x) => x.id.startsWith('off-'));
    expect(off.map((x) => [x.tone, x.nature])).toEqual([
      ['bad', 'problem'],
      ['bad', 'problem'],
    ]);
    expect(off[0]?.title).toMatch(/until/);
    // One still working: switched off for a while is NZBHydra2's own back-off, a heads-up (QN-04).
    const one = snapshot({
      indexers: snapshot().indexers?.map((i, k) => (k === 0 ? { ...i, state: 'ENABLED' } : i)) ?? null,
    });
    expect(
      hydraNotices(input(one))
        .filter((x) => x.id.startsWith('off-'))
        .map((x) => [x.tone, x.nature]),
    ).toEqual([['info', 'fyi']]);
    // For good: a problem.
    const gone = snapshot({
      indexers:
        snapshot().indexers?.map((i, k) =>
          k === 0 ? { ...i, state: 'ENABLED' } : { ...i, state: 'DISABLED_SYSTEM' },
        ) ?? null,
    });
    expect(hydraNotices(input(gone)).filter((x) => x.id.startsWith('off-'))[0]).toMatchObject({
      tone: 'warn',
      nature: 'problem',
      subject: { id: 'indexer:NZBgeek', name: 'NZBgeek' },
      episode: 'DISABLED_SYSTEM',
    });
  });

  it('warns at 90 % of a daily limit and when a VIP membership ends soon', () => {
    const near = snapshot({
      indexers: [
        { ...(snapshot().indexers?.[1] as HydraIndexer), state: 'ENABLED', apiHits: 95, apiLimit: 100 },
      ],
    });
    const ids = hydraNotices(input(near)).map((n) => [n.id, n.tone]);
    expect(ids).toContainEqual(['limit-NZBgeek', 'info']);
    // VIP until 30 Oct, nine days on.
    expect(ids).toContainEqual(['vip-NZBgeek', 'info']);
  });

  it('says an older NZBHydra2 shows fewer figures', () => {
    expect(hydraNotices(input(snapshot({ version: '7.12.3' }))).map((n) => n.id)).toContain('old');
  });

  it('links a grab to the page of the app that asked (SD-10)', () => {
    const rows = table(hydraView(input(snapshot())).panels, 'grabs');
    expect(rows[0]?.cells.app).toMatchObject({ text: 'Sonarr', href: '/things/connection%3Acon_sonarr' });
    // Radarr isn't connected here: its name, no link.
    expect(rows[1]?.cells.app?.href).toBeUndefined();
    expect(rows[1]?.cells.title?.tone).toBe('bad');
  });

  it('leaves the indexers out when NZBHydra2 doesn’t give their state', () => {
    const view = hydraView(input(snapshot({ indexers: null })));
    expect(view.panels.map((p) => p.id)).toEqual(['today', 'week', 'grabs']);
    expect(slotProblems(view)).toEqual([]);
    expect(hydraKpis(input(snapshot({ indexers: null })))[0]).toMatchObject({
      key: 'indexers',
      value: '0 of 3',
    });
  });
});

beforeEach(() => {
  http.calls = [];
});

describe('quiet notices (quiet-notices.md QN-01…QN-04, QN-11)', () => {
  const geek = () => snapshot().indexers?.[1] as HydraIndexer;

  it('makes a daily limit a heads-up that is quiet until the limit resets', () => {
    const reset = new Date(now.getTime() + 3 * 3600_000);
    const near = snapshot({
      indexers: [{ ...geek(), state: 'ENABLED', apiHits: 95, apiLimit: 100, apiResetAt: reset }],
    });
    const limit = hydraNotices(input(near)).find((n) => n.check === 'nzbhydra.limit');
    expect(limit).toMatchObject({
      nature: 'fyi',
      subject: { id: 'indexer:NZBgeek' },
      ignore: { lifts: 'period', until: reset.toISOString() },
    });
    // Without NZBHydra2's own reset time: the next midnight where the Whombat is.
    expect(resetOf(null, now, 'UTC').toISOString()).toBe('2026-10-22T00:00:00.000Z');
  });

  it('says a VIP membership ending as a heads-up, ended as only you, its date the episode', () => {
    const vip = (vipEnds: Date) =>
      hydraNotices(input(snapshot({ indexers: [{ ...geek(), state: 'ENABLED', vipEnds }] }))).find(
        (n) => n.check === 'nzbhydra.vip',
      );
    const soon = new Date(now.getTime() + 5 * 86_400_000);
    expect(vip(soon)).toMatchObject({
      nature: 'fyi',
      episode: soon.toISOString(),
      ignore: { lifts: 'newer' },
    });
    const ended = new Date(now.getTime() - 86_400_000);
    expect(vip(ended)).toMatchObject({ nature: 'you', tone: 'warn', link: { kind: 'url' } });
    // An indexer you switched off yourself isn't worth a word.
    const mine = snapshot({ indexers: [{ ...geek(), state: 'DISABLED_USER', vipEnds: ended }] });
    expect(hydraNotices(input(mine)).find((n) => n.check === 'nzbhydra.vip')).toBeUndefined();
  });

  it('never decides warn or bad in the head', () => {
    expect(hydraView(input(snapshot())).status).toBeUndefined();
  });

  it('says which checks it couldn’t read', () => {
    expect(hydraSkipped(snapshot())).toEqual([]);
    expect(hydraSkipped(snapshot({ indexers: null }))).toEqual([
      'nzbhydra.indexer_off',
      'nzbhydra.limit',
      'nzbhydra.vip',
    ]);
  });

  it('lists every check it can raise', () => {
    expect(NZBHYDRA_KIND.checks).toBe(HYDRA_CHECKS);
    expect(HYDRA_CHECKS.map((c) => c.check)).toEqual([
      'nzbhydra.indexer_off',
      'nzbhydra.vip',
      'nzbhydra.limit',
      'nzbhydra.old',
    ]);
  });
});
