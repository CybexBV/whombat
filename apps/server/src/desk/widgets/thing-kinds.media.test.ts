/**
 * The media kinds as widgets, from their recorded answers (desk-display-server.md “Every connection's widgets”): Plex's
 * Now playing and Recently added as posters, SABnzbd's queue with its big line, Seerr's requests, Sonarr's and Radarr's
 * Coming up. Pure: the kinds' own view builders, laid out as a page, through the widgets' runtime.
 */

import type { ThingGalleryItem, ThingPage } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../services';
import {
  arrView,
  parseQueue as parseArrQueue,
  parseEpisodes,
  parseHealth,
  parseLibrary,
  parseRoots,
} from '../../things/kinds/media/arr';
import { hydraView, parseGrabs, parseIndexers } from '../../things/kinds/media/nzbhydra';
import {
  parseItem,
  parseSections,
  parseSessions,
  parseUpdater,
  plexView,
} from '../../things/kinds/media/plex';
import {
  parseHistory,
  parseQueue,
  parseStats,
  parseWarnings,
  sabView,
} from '../../things/kinds/media/sabnzbd';
import { parseIssue, parseRequests, parseTitle, seerrView, titleKey } from '../../things/kinds/media/seerr';
import { fixture, rowOf } from '../../things/kinds/media/testing';
import { releaseTitle } from './thing-kinds';
import { as, groupOn, NOW, pageOf, panelOn, pictureRef, TZ, viewsOn } from './thing-testing';

/** The page without one of its panels (a page leaves out what has nothing to show). */
function withoutPanel(page: ThingPage, id: string): ThingPage {
  return { ...page, tabs: page.tabs.map((t) => ({ ...t, panels: t.panels.filter((p) => p.id !== id) })) };
}

/** The page with one gallery's items changed. */
function withItems(
  page: ThingPage,
  id: string,
  change: (item: ThingGalleryItem) => ThingGalleryItem,
): ThingPage {
  return {
    ...page,
    tabs: page.tabs.map((t) => ({
      ...t,
      panels: t.panels.map((p) =>
        p.kind === 'gallery' && p.id === id ? { ...p, items: p.items.map(change) } : p,
      ),
    })),
  };
}

/** The page with one panel's line over it changed. */
function withMeta(page: ThingPage, id: string, meta: string): ThingPage {
  return {
    ...page,
    tabs: page.tabs.map((t) => ({
      ...t,
      panels: t.panels.map((p) => (p.id === id && 'meta' in p ? { ...p, meta } : p)),
    })),
  };
}

vi.mock('../../connections/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connections/http')>()),
  signedConnectionFetch: async () => ({ status: 200, headers: {}, body: Buffer.from('{}') }),
}));

const poster = (thumb: string | null, title: string) =>
  thumb ? { ref: pictureRef(thumb), alt: title, shape: 'poster' as const } : undefined;

function plexPage(more: { live?: null } = {}) {
  const raw = fixture<{ MediaContainer: { Metadata: Record<string, unknown>[] } }>('plex-sessions.json');
  const m = raw.MediaContainer.Metadata[0] ?? {};
  const sessions = parseSessions({
    MediaContainer: {
      Metadata: [
        {
          ...m,
          User: { id: '1', title: 'Anna' },
          Player: { ...(m.Player as object), title: 'Living room TV', product: 'Plex for LG' },
        },
      ],
    },
  });
  const items = [
    ...fixture<{ MediaContainer: { Metadata: unknown[] } }>('plex-recent-movies.json').MediaContainer
      .Metadata,
    ...fixture<{ MediaContainer: { Metadata: unknown[] } }>('plex-recent-shows.json').MediaContainer.Metadata,
  ];
  const view = plexView({
    rest: {
      version: '1.43.5',
      name: 'Plex',
      signedIn: false,
      mapping: 'unknown',
      mappingError: null,
      libraries: parseSections(fixture('plex-sections.json')).map((l) => ({ ...l, count: 3, unmatched: 0 })),
      recent: items.map(parseItem).filter((i) => i !== null),
      update: parseUpdater(fixture('plex-updater.json'), '1.43.5.11029-6bf8af3f0'),
    },
    live: more.live === null ? null : { sessions, activities: [] },
    readAt: NOW,
    now: NOW,
    timeZone: TZ,
    who: { row: rowOf('plex') },
    url: 'http://192.0.2.10:32400',
    asked: null,
    since: new Map(),
    streams: [],
    poster,
  });
  return pageOf(view, { catalogId: 'plex', name: 'Plex' });
}

const services = {
  custody: { mac: () => Buffer.alloc(32, 7).toString('base64url') },
} as unknown as Services;

function sabPage() {
  const failed = parseHistory(fixture('sab-history-failed.json'), 20);
  const view = sabView({
    snapshot: {
      readAt: NOW,
      queue: parseQueue(fixture('sab-queue.json')),
      rest: {
        failed: failed.slots,
        failedTotal: failed.total,
        recent: parseHistory(fixture('sab-history.json'), 30).slots,
        stats: parseStats(fixture('sab-server-stats.json')),
        warnings: parseWarnings(fixture('sab-warnings.json')),
      },
    },
    now: NOW,
    timeZone: TZ,
    range: '24h',
    speed: { timestamps: [], values: [] },
    pausedSince: null,
    who: { row: rowOf('sabnzbd') },
    url: 'http://192.0.2.10:8080',
  });
  return pageOf(view, { catalogId: 'sabnzbd', name: 'SABnzbd' });
}

function seerrPage() {
  const titles = new Map();
  for (const [key, file] of [
    [titleKey('movie', 969681), 'seerr-movie.json'],
    [titleKey('tv', 4614), 'seerr-tv.json'],
  ] as const) {
    const t = parseTitle(fixture(file));
    if (t) titles.set(key, t);
  }
  const status = fixture<Record<string, unknown>>('seerr-status.json');
  const count = fixture<Record<string, number>>('seerr-count.json');
  const failed = parseRequests(fixture('seerr-failed.json'), NOW);
  const row = rowOf('overseerr');
  const view = seerrView(
    {
      snapshot: {
        readAt: NOW,
        version: status.version as string,
        updateAvailable: false,
        commitsBehind: 0,
        restartRequired: false,
        counts: {
          total: count.total ?? null,
          pending: count.pending ?? null,
          processing: count.processing ?? null,
          available: 0,
        },
        pending: parseRequests(fixture('seerr-pending.json'), NOW).items,
        processing: parseRequests(fixture('seerr-processing.json'), NOW).items,
        failed: failed.items,
        failedTotal: failed.total,
        available: parseRequests(fixture('seerr-available.json'), NOW).items,
        issues: (
          fixture<{ results: unknown[] }>('seerr-issues.json').results.map(parseIssue) as never[]
        ).filter(Boolean),
        openIssues: fixture<{ open: number }>('seerr-issue-count.json').open,
        unreachable: parseRequests(fixture('seerr-available.json'), NOW).unreachable,
        titles,
      },
      now: NOW,
      timeZone: TZ,
      who: { row },
      url: 'http://192.0.2.10:5055',
      sabnzbd: { href: '/things/connection%3Acon_sab', name: 'SABnzbd' },
    },
    { services, row, now: NOW },
  );
  return pageOf(view, { catalogId: 'overseerr', name: 'Seerr' });
}

function arrPage(app: 'sonarr' | 'radarr') {
  const sonarr = app === 'sonarr';
  const library = parseLibrary(fixture(sonarr ? 'sonarr-series.json' : 'radarr-movie.json'), app);
  const view = arrView({
    snapshot: {
      readAt: NOW,
      app,
      rest: {
        version: sonarr ? '4.0.20.3014' : '6.4.4.10685',
        health: parseHealth(fixture(`${app}-health.json`)),
        roots: parseRoots(fixture(`${app}-rootfolder.json`), fixture(`${app}-diskspace.json`)),
        upcoming: parseEpisodes(fixture(`${app}-calendar.json`)),
        missing: library.missing ?? [],
        missingTotal: library.missingTotal,
        library,
      },
      queue: parseArrQueue(fixture(`${app}-queue.json`), app),
    },
    now: NOW,
    timeZone: TZ,
    who: { row: rowOf(app) },
    url: 'http://192.0.2.10:8989',
    sabnzbd: { href: '/things/connection%3Acon_sab', name: 'SABnzbd' },
    poster: (id, title) =>
      id === null ? undefined : { ref: pictureRef(`p${id}`), alt: title, shape: 'poster' },
  });
  return pageOf(view, { catalogId: app, name: sonarr ? 'Sonarr' : 'Radarr' });
}

const ids = (items: { opts: Record<string, string> }[]) => items.map((i) => i.opts.panel ?? 'figures');

describe('Plex', () => {
  it('offers its figures, Now playing, Recently added and Library, with Worth a look last', async () => {
    const group = await groupOn(plexPage());
    expect(group).toMatchObject({ label: 'Plex', mark: 'plex', thing: 'connection:con_plex' });
    expect(ids(group.items)).toEqual(['figures', 'playing', 'recent', 'libraries', 'notices']);
    expect(group.items.find((i) => i.opts.panel === 'playing')).toMatchObject({
      name: 'Now playing',
      view: 'posters',
    });
  });

  it('shows what plays as posters: who watches apart from the year, how far, private, every 10 seconds', async () => {
    const got = await panelOn(plexPage(), 'playing');
    const view = as(got, 'posters');
    expect(view).toMatchObject({ title: 'Now playing', name: 'Plex', head: '1 watching', shape: 'poster' });
    expect(view.items[0]).toMatchObject({
      title: 'Dune: Part Two',
      detail: 'Film · 2024 · SD',
      who: 'Anna · Living room TV',
      progress: 33,
    });
    expect(view.items[0]?.image).toMatchObject({ thing: 'connection:con_plex', shape: 'poster' });
    expect(got).toMatchObject({ private: true, refreshS: 10 });
  });

  it('keeps Now playing while nobody watches: offered, and empty rather than gone', async () => {
    const page = plexPage({ live: null });
    const group = await groupOn(page);
    expect(ids(group.items)).toContain('playing');
    const view = as(await panelOn(page, 'playing'), 'posters');
    expect(view.items).toEqual([]);
    expect(view.problem).toBeUndefined();
    expect(view.empty).toContain('Nobody');
  });

  it('shows Recently added as posters that may show on a locked screen, without who asked', async () => {
    const page = withItems(plexPage(), 'recent', (i) => ({ ...i, sub: '2024 · Asked by Anna' }));
    const got = await panelOn(page, 'recent');
    const view = as(got, 'posters');
    expect(view.items.map((i) => i.title)).toContain('Inside Out 2');
    expect(view.items[0]?.detail).toBe('2024');
    expect(JSON.stringify(view)).not.toContain('Anna');
    expect(got.private).toBe(false);
  });

  it('says how long is left of what plays, or that it’s paused', async () => {
    const playing = withItems(plexPage(), 'playing', (i) => ({ ...i, noteEnd: '1 h 20 min left' }));
    expect(as(await panelOn(playing, 'playing'), 'posters').items[0]?.time).toBe('1 h 20 min left');
    const paused = withItems(playing, 'playing', (i) => ({ ...i, paused: true }));
    expect(as(await panelOn(paused, 'playing'), 'posters').items[0]?.time).toBe('Paused');
  });

  it('leads its figures with who is watching', async () => {
    const got = await viewsOn(plexPage(), [{ id: 'w_fig', type: 'figures', opts: {} }]);
    const view = as(got.get('w_fig'), 'figures');
    expect(view.title).toBe('Plex');
    // The page in slots has no row of figures: Now playing's count leads, then each library's.
    expect(view.items.map((k) => k.label)).toEqual(['Now playing', 'Movies', 'TV Shows']);
    expect(got.get('w_fig')?.refreshS).toBe(60);
  });
});

describe('SABnzbd', () => {
  it('shows the queue with how many are left over its rows, each with its bar, category and size', async () => {
    const view = as(await panelOn(sabPage(), 'queue'), 'list');
    expect(view).toMatchObject({ title: 'Download queue', name: 'SABnzbd', head: '3 left' });
    expect(view.rows).toHaveLength(3);
    expect(view.rows[0]).toMatchObject({ title: 'Show Name · S2 E5', progress: 0, meta: 'tv · 2 MB' });
    // A time that's left says so; a paused download says that instead.
    const timed = withItems(sabPage(), 'queue', (i) => ({ ...i, noteEnd: '4 min left' }));
    expect(as(await panelOn(timed, 'queue'), 'list').rows[0]?.detail).toBe('4 min left');
    const paused = withItems(timed, 'queue', (i) => ({ ...i, paused: true }));
    expect(as(await panelOn(paused, 'queue'), 'list').rows[0]?.detail).toBe('Paused');
  });

  it('keeps Failed while nothing failed: empty, not gone', async () => {
    const page = withoutPanel(sabPage(), 'failed');
    expect(ids((await groupOn(page)).items)).toContain('failed');
    const view = as(await panelOn(page, 'failed'), 'list');
    expect(view).toMatchObject({ title: 'Failed downloads', rows: [] });
    expect(view.problem).toBeUndefined();
    expect(view.empty).toBeTruthy();
  });

  it('says how long the queue takes at this speed, and that it is paused', async () => {
    const page = sabPage();
    const withTime = withMeta(page, 'queue', '42 MB/s · 3 downloads · 6 MB left · about 20 min');
    expect(as(await panelOn(withTime, 'queue'), 'list').head).toBe('3 left · about 20 min');
    const paused = withMeta(page, 'queue', 'Paused · 6 MB left');
    expect(as(await panelOn(paused, 'queue'), 'list').head).toBe('Paused · 3 left');
  });

  it('leads its figures with what downloads now, then each news server', async () => {
    const got = await viewsOn(sabPage(), [{ id: 'w_fig', type: 'figures', opts: {} }]);
    const view = as(got.get('w_fig'), 'figures');
    expect(view.items.map((k) => k.label)).toEqual(['Downloading now', 'news.example.com']);
  });
});

describe('Seerr', () => {
  it('shows the requests waiting for a yes as posters with who asked, private', async () => {
    const page = seerrPage();
    expect((await groupOn(page)).items[1]).toMatchObject({ name: 'Requests', opts: { panel: 'pending' } });
    const got = await panelOn(page, 'pending');
    const view = as(got, 'posters');
    expect(view).toMatchObject({ title: 'Requests', head: '2 new' });
    expect(view.items[0]).toMatchObject({
      title: 'Spider-Man: Brand New Day',
      detail: 'Film · 2026',
      who: 'Ben',
    });
    expect(got.private).toBe(true);
  });

  it('shows what just became available without who asked, and keeps the issues private', async () => {
    const page = withItems(seerrPage(), 'available', (i) => ({ ...i, sub: '2026 · Asked by Ben' }));
    const got = await panelOn(page, 'available');
    expect(got.private).toBe(false);
    expect(as(got, 'posters').items.every((i) => !i.who && !i.detail?.includes('Ben'))).toBe(true);
    expect((await panelOn(page, 'issues')).private).toBe(true);
  });

  it('keeps On its way and Failed while they have nothing: empty, not gone', async () => {
    const page = withoutPanel(withoutPanel(seerrPage(), 'progress'), 'failed');
    const offered = ids((await groupOn(page)).items);
    expect(offered).toEqual(expect.arrayContaining(['progress', 'failed']));
    for (const panel of ['progress', 'failed']) {
      const view = as(await panelOn(page, panel), 'posters');
      expect(view.items).toEqual([]);
      expect(view.problem).toBeUndefined();
      expect(view.empty).toBeTruthy();
    }
    expect((await panelOn(page, 'progress')).private).toBe(true);
  });
});

describe('release names', () => {
  it('read as their show and episode, or their film and year', () => {
    expect(releaseTitle('Show.Name.S02E05.1080p.WEB.h264-GRP')).toBe('Show Name · S2 E5');
    expect(releaseTitle('Show_Name_S01_COMPLETE')).toBe('Show Name · Season 1');
    expect(releaseTitle('Dune.Part.Two.2024.2160p.UHD.BluRay.x265-GRP')).toBe('Dune Part Two · 2024');
    expect(releaseTitle('2001.A.Space.Odyssey.1968.1080p')).toBe('2001 A Space Odyssey · 1968');
    expect(releaseTitle('Some.Concert.1080p.WEB-DL')).toBe('Some Concert');
    expect(releaseTitle('Dune: Part Two (2024)')).toBe('Dune: Part Two (2024)');
  });
});

/** The page with more episodes in Coming up. */
function withEpisodes(
  page: ThingPage,
  more: { id: string; title: string; sub: string; at: string; onDisk?: boolean }[],
) {
  return {
    ...page,
    tabs: page.tabs.map((t) => ({
      ...t,
      panels: t.panels.map((p) =>
        p.kind === 'gallery' && p.id === 'upcoming'
          ? {
              ...p,
              items: [
                ...p.items,
                ...more.map(({ onDisk, ...i }) => ({
                  ...i,
                  ...(onDisk ? { badge: { text: 'On disk', tone: 'ok' as const } } : {}),
                })),
              ],
            }
          : p,
      ),
    })),
  };
}

describe('Tonight on TV', () => {
  it('is Sonarr’s first widget, not Radarr’s', async () => {
    expect(ids((await groupOn(arrPage('sonarr'))).items).slice(0, 2)).toEqual(['figures', 'tonight']);
    expect(ids((await groupOn(arrPage('radarr'))).items)).not.toContain('tonight');
  });

  it('lists today’s episodes by time: in, still to come, or aired and not in yet', async () => {
    const page = withEpisodes(arrPage('sonarr'), [
      { id: 'e1', title: 'The Bear', sub: 'S03E05 · Today 21:00', at: '2026-10-21T19:00:00Z', onDisk: true },
      { id: 'e2', title: 'Slow Horses', sub: 'S05E01 · Today 23:00', at: '2026-10-21T21:00:00Z' },
      { id: 'e3', title: 'Severance', sub: 'S03E01 · Tomorrow 03:00', at: '2026-10-22T01:00:00Z' },
    ]);
    const got = await panelOn(page, 'tonight');
    const view = as(got, 'list');
    expect(view).toMatchObject({ title: 'Tonight on TV', head: '3 tonight · 1 ready' });
    expect(view.rows.map((r) => [r.title, r.time, r.meta, r.tone])).toEqual([
      ['NCIS', '02:00', 'Not in yet', 'warn'],
      ['The Bear', '21:00', 'Ready', 'ok'],
      ['Slow Horses', '23:00', 'Coming', undefined],
    ]);
    expect(view.rows[1]?.detail).toBe('S3 E5');
    expect(got.private).toBe(false);
  });

  it('says so on a night without episodes', async () => {
    const page = arrPage('sonarr');
    const later = {
      ...page,
      tabs: page.tabs.map((t) => ({
        ...t,
        panels: t.panels.map((p) => (p.kind === 'gallery' ? { ...p, items: [] } : p)),
      })),
    };
    const view = as(await panelOn(later, 'tonight'), 'list');
    expect(view.rows).toEqual([]);
    expect(view.head).toBeUndefined();
    expect(view.empty).toBeTruthy();
  });
});

describe('On its way', () => {
  it('shows what Seerr is fetching and for whom, private, offered even when nothing is', async () => {
    const page = seerrPage();
    expect((await groupOn(page)).items[2]).toMatchObject({
      name: 'On its way',
      view: 'posters',
      private: true,
      opts: { panel: 'progress' },
    });
    const got = await panelOn(page, 'progress');
    expect(as(got, 'posters').items[0]).toMatchObject({ title: 'A movie', who: 'Ben', progress: 0 });
    expect(got.private).toBe(true);
    const none = {
      ...page,
      tabs: page.tabs.map((t) => ({ ...t, panels: t.panels.filter((p) => p.id !== 'progress') })),
    };
    expect(ids((await groupOn(none)).items)).toContain('progress');
    const empty = as(await panelOn(none, 'progress'), 'posters');
    expect(empty.items).toEqual([]);
    expect(empty.problem).toBeUndefined();
  });
});

describe('Sonarr and Radarr', () => {
  it('show the coming episodes with what and when', async () => {
    const view = as(await panelOn(arrPage('sonarr'), 'upcoming'), 'posters');
    expect(view.title).toBe('Coming episodes');
    expect(view.items[0]).toMatchObject({
      title: 'NCIS',
      detail: 'S24E03 · Sleeping Dogs',
      time: 'Today 02:00',
    });
  });

  it('show Downloading now as rows with their bars, and lead their figures with it', async () => {
    const view = as(await panelOn(arrPage('sonarr'), 'queue'), 'list');
    expect(view).toMatchObject({ title: 'Download queue', head: '2 left' });
    expect(view.rows[0]).toMatchObject({ title: 'NCIS · S24E03', meta: 'WEBDL-1080p · 2 MB', progress: 0 });
    const got = await viewsOn(arrPage('radarr'), [{ id: 'w_fig', type: 'figures', opts: {} }]);
    expect(as(got.get('w_fig'), 'figures').items.map((k) => k.label)).toEqual([
      'Downloading now',
      'Movies',
      'On disk',
      'Missing',
    ]);
  });

  it('say a date once', async () => {
    const view = as(await panelOn(arrPage('radarr'), 'missing'), 'list');
    expect(view.rows[0]).toMatchObject({ title: 'Spider-Man: Brand New Day (2026)', time: '6 Oct' });
    expect(view.rows[0]?.meta).toBeUndefined();
  });

  it('have Coming films empty when nothing is out this week', async () => {
    const view = as(await panelOn(arrPage('radarr'), 'upcoming'), 'posters');
    expect(view.items).toEqual([]);
    expect(view.empty).toBeTruthy();
  });
});

describe('NZBHydra2', () => {
  function hydraPage() {
    const view = hydraView({
      snapshot: {
        readAt: NOW,
        version: '9.1.1',
        configured: 3,
        enabled: 0,
        indexers: parseIndexers(fixture('hydra-indexers.json')),
        searchesToday: 2,
        grabsToday: 1,
        grabs: parseGrabs(fixture('hydra-downloads.json')),
        week: { grabs: [{ at: NOW, indexer: 'NZBgeek', failed: false }], complete: true, searches: 9 },
      },
      now: NOW,
      timeZone: TZ,
      url: 'http://192.0.2.10:5076',
      apps: {},
    });
    return pageOf(view, { catalogId: 'nzbhydra', name: 'NZBHydra2' });
  }

  it('lists its indexers with their bars, and leads its figures with today’s grabs', async () => {
    const page = hydraPage();
    const view = as(await panelOn(page, 'indexers'), 'list');
    expect(view.rows.map((r) => [r.title, r.detail])).toEqual([
      ['DrunkenSlug', 'Off until 21:50'],
      ['NZBgeek', 'Off until 21:50'],
      ['NZBFinder', 'Paused'],
    ]);
    const got = await viewsOn(page, [{ id: 'w_fig', type: 'figures', opts: {} }]);
    expect(as(got.get('w_fig'), 'figures').items.map((k) => k.label)[0]).toBe('Grabs');
  });
});
