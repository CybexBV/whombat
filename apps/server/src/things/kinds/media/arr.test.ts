/**
 * Sonarr's and Radarr's pages and cards from recorded answers (SD-24, SD-10): the library, missing, the queue linking to
 * SABnzbd, the calendar, health checks in their words, imports that fail, the disk, and Search for missing.
 */
import type { ThingPagePanel } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { slotProblems } from '../slots';
import {
  type ArrInput,
  type ArrSnapshot,
  airWords,
  arrChecks,
  arrKpis,
  arrMachineLines,
  arrNotices,
  arrSkipped,
  arrView,
  arrWeek,
  healthNature,
  parseEpisodes,
  parseHealth,
  parseImports,
  parseLibrary,
  parseMissingEpisodes,
  parseMovieReleases,
  parseQueue,
  parseRoots,
  parseUpdate,
  RADARR_KIND,
  SONARR_KIND,
} from './arr';
import { fixture, rowOf } from './testing';

const http = vi.hoisted(() => ({ calls: [] as { method: string; url: URL; body: string | null }[] }));
vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  return {
    ...real,
    signedConnectionFetch: async (
      _s: unknown,
      _r: unknown,
      req: { method: string; url: string; body?: unknown },
    ) => {
      http.calls.push({
        method: req.method,
        url: new URL(req.url),
        body: typeof req.body === 'string' ? req.body : null,
      });
      return { status: 201, headers: {}, body: Buffer.from('{"name":"MissingEpisodeSearch","id":42}') };
    },
  };
});

// A minute after the recorded answers.
const now = new Date('2026-10-21T19:46:00Z');
const TZ = 'Europe/Amsterdam';

function sonarr(more: Partial<ArrSnapshot> = {}): ArrSnapshot {
  const missing = parseMissingEpisodes(fixture('sonarr-missing.json'));
  return {
    readAt: now,
    app: 'sonarr',
    rest: {
      version: '4.0.20.3014',
      health: parseHealth(fixture('sonarr-health.json')),
      roots: parseRoots(fixture('sonarr-rootfolder.json'), fixture('sonarr-diskspace.json')),
      upcoming: parseEpisodes(fixture('sonarr-calendar.json')),
      missing: missing.items,
      missingTotal: missing.total,
      library: parseLibrary(fixture('sonarr-series.json'), 'sonarr'),
      // Three imports today, one two days ago, two the week before.
      imports: [0.1, 0.2, 0.3, 2.1, 8, 9].map((d) => new Date(now.getTime() - d * 86_400_000)),
      update: parseUpdate(fixture('sonarr-update.json')),
    },
    queue: parseQueue(fixture('sonarr-queue.json'), 'sonarr'),
    ...more,
  };
}

function radarr(more: Partial<ArrSnapshot> = {}): ArrSnapshot {
  const library = parseLibrary(fixture('radarr-movie.json'), 'radarr');
  return {
    readAt: now,
    app: 'radarr',
    rest: {
      version: '6.4.4.10685',
      health: parseHealth(fixture('radarr-health.json')),
      roots: parseRoots(fixture('radarr-rootfolder.json'), fixture('radarr-diskspace.json')),
      upcoming: [],
      missing: library.missing ?? [],
      missingTotal: library.missingTotal,
      library,
      imports: null,
      update: null,
    },
    queue: parseQueue(fixture('radarr-queue.json'), 'radarr'),
    ...more,
  };
}

const input = (s: ArrSnapshot, more: Partial<ArrInput> = {}): ArrInput => ({
  snapshot: s,
  now,
  timeZone: TZ,
  who: { row: rowOf(s.app) },
  url: 'http://192.0.2.10:8989',
  sabnzbd: { href: '/things/connection%3Acon_sab', name: 'SABnzbd' },
  poster: (id, title) => (id === null ? undefined : { ref: `poster${id}.sig`, alt: title, shape: 'poster' }),
  ...more,
});

const panel = (panels: ThingPagePanel[], id: string) => panels.find((p) => p.id === id);

describe('reading Sonarr 4 and Radarr 6 (recorded)', () => {
  it('reads Sonarr’s queue with the series and episode it is for', () => {
    const q = parseQueue(fixture('sonarr-queue.json'), 'sonarr');
    expect(q.total).toBe(2);
    expect(q.items[0]).toMatchObject({
      forWhat: 'NCIS · S24E03',
      client: 'SABnzbd',
      status: 'downloading',
      sizeBytes: 2306867,
    });
    // A download Sonarr can't place: its release name only.
    expect(q.items[1]?.forWhat).toBeNull();
  });

  it('reads Radarr’s queue with the movie and its year', () => {
    expect(parseQueue(fixture('radarr-queue.json'), 'radarr').items[0]?.forWhat).toBe('Inside Out 2 (2024)');
  });

  it('gives a root folder the size of the disk that holds it', () => {
    const [tv] = parseRoots(fixture('sonarr-rootfolder.json'), fixture('sonarr-diskspace.json'));
    expect(tv?.path).toBe('/tv');
    expect(tv?.free).toBe(1755181219840);
    // `/tv` lives on `/`, not on `/config`.
    expect(tv?.total).toBe(1848004313088);
  });

  it('reads the calendar: Sonarr’s episodes, Radarr’s releases that fall in the window', () => {
    expect(parseEpisodes(fixture('sonarr-calendar.json')).map((e) => [e.title, e.what])).toEqual([
      ['NCIS', 'S24E03'],
      ['NCIS', 'S24E04'],
    ]);
    const from = new Date('2026-11-28T00:00:00Z');
    const releases = parseMovieReleases(
      fixture('radarr-calendar.json'),
      from,
      new Date(from.getTime() + 7 * 86_400_000),
    );
    expect(releases.map((r) => [r.title, r.what])).toEqual([['Spider-Man: Brand New Day', 'On disc']]);
  });

  it('counts Radarr’s missing as monitored, released and without a file, newest first', () => {
    const lib = parseLibrary(fixture('radarr-movie.json'), 'radarr');
    expect(lib.count).toBe(3);
    expect(lib.missingTotal).toBe(2);
    expect(lib.missing?.map((m) => m.title)).toEqual([
      'Spider-Man: Brand New Day (2026)',
      'Dune: Part Two (2024)',
    ]);
  });
});

describe('reading what came in and the newest version (Sonarr 4.0.20, Radarr 6.4.4, recorded 2026-11-04)', () => {
  it('reads the imports of the history in both', () => {
    expect(parseImports(fixture('sonarr-history.json'))).toEqual([new Date('2026-11-04T19:22:44Z')]);
    expect(parseImports(fixture('radarr-history.json'))).toEqual([new Date('2026-11-04T19:23:08Z')]);
  });

  it('reads the version installed and the newest out', () => {
    expect(parseUpdate(fixture('sonarr-update.json'))).toEqual({
      installed: '4.0.20.3014',
      latest: '4.0.20.3014',
    });
  });

  it('reads the library’s size, what is still airing and when each came in', () => {
    const lib = parseLibrary(fixture('sonarr-series.json'), 'sonarr');
    expect(lib).toMatchObject({ continuing: 2, ended: 0, episodes: 6, sizeBytes: 0 });
    expect(lib.addedAt).toHaveLength(2);
    const movies = parseLibrary(
      [
        {
          title: 'Dune: Part Two',
          added: '2026-10-20T10:00:00Z',
          hasFile: true,
          sizeOnDisk: 2e9,
          movieFile: { dateAdded: '2026-10-21T10:00:00Z' },
        },
        { title: 'Arrival', added: '2026-01-02T10:00:00Z', hasFile: false, sizeOnDisk: 0 },
      ],
      'radarr',
    );
    expect(movies).toMatchObject({ count: 2, onDisk: 1, sizeBytes: 2e9 });
    expect(movies.fileAddedAt).toEqual([new Date('2026-10-21T10:00:00Z').getTime()]);
  });
});

describe('the page in slots', () => {
  it('follows the slots: Downloading now, Your library, Coming up, This week, Missing below', () => {
    const view = arrView(input(sonarr()));
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['queue', 'library', 'upcoming', 'week', 'missing']);
    expect(view.kpis).toEqual([]);
    const radarrView = arrView(input(radarr()));
    expect(slotProblems(radarrView)).toEqual([]);
    // Radarr's fixture has nothing coming and no history: no Shelf, no Trend.
    expect(radarrView.panels.map((p) => p.id)).toEqual(['queue', 'library', 'missing']);
  });

  it('shows each download with its poster, quality and size, how far and its link to SABnzbd', () => {
    const live = panel(arrView(input(sonarr())).panels, 'queue');
    expect(live).toMatchObject({
      kind: 'gallery',
      look: 'rows',
      title: 'Downloading now',
      meta: '2 downloading · 5 MB left',
    });
    expect(live?.kind === 'gallery' && live.link).toMatchObject({ kind: 'href', label: 'Open SABnzbd' });
    const row = live?.kind === 'gallery' ? live.items[0] : undefined;
    expect(row).toMatchObject({
      title: 'NCIS · S24E03',
      sub: 'WEBDL-1080p · 2 MB',
      progress: 0,
      href: '/things/connection%3Acon_sab',
      image: { ref: 'poster1.sig' },
    });
    const alone = panel(arrView(input(sonarr(), { sabnzbd: null })).panels, 'queue');
    expect(alone?.kind === 'gallery' && alone.items[0]?.href).toBeUndefined();
    expect(alone?.kind === 'gallery' && alone.link).toMatchObject({ kind: 'url', label: 'Open Sonarr' });
  });

  it('tags a download that can’t be imported', () => {
    const q = parseQueue(fixture('sonarr-queue.json'), 'sonarr');
    const blocked = {
      ...q,
      items: q.items.map((i) => ({ ...i, trackedStatus: 'warning', trackedState: 'importBlocked' })),
    };
    const live = panel(arrView(input(sonarr({ queue: blocked }))).panels, 'queue');
    expect(live?.kind === 'gallery' && live.items[0]?.badge).toEqual({ text: 'Can’t import', tone: 'warn' });
  });

  it('counts the library with what came in this week, and Missing with a confirmed Search for missing', () => {
    const lib = panel(arrView(input(sonarr())).panels, 'library');
    const lines = lib?.kind === 'list' ? lib.items : [];
    expect(lines.map((l) => [l.title, l.figure?.value, l.figure?.note])).toEqual([
      ['Series', '2', '+2 this week'],
      ['Episodes', '0', '+4 this week'],
      ['Missing', '6', undefined],
    ]);
    expect(lines[0]?.detail).toBe('2 still airing');
    const search = lines[2]?.actions?.[0];
    expect(search).toMatchObject({ action: 'search_missing', allowed: true });
    expect(search?.confirm).toBeDefined();
    const movies = panel(arrView(input(radarr())).panels, 'library');
    expect(movies?.kind === 'list' && movies.items.map((l) => [l.title, l.figure?.value])).toEqual([
      ['Movies', '3'],
      ['On disk', '0'],
      ['Missing', '2'],
    ]);
  });

  it('shows what comes up as posters, in the words the desk reads', () => {
    const up = panel(arrView(input(sonarr())).panels, 'upcoming');
    expect(up).toMatchObject({ kind: 'gallery', look: 'shelf', meta: 'Next 7 days' });
    expect(up?.kind === 'gallery' && up.items.map((i) => [i.title, i.sub, i.image?.ref])).toEqual([
      ['NCIS', 'S24E03 · Today 02:00', 'poster1.sig'],
      ['NCIS', 'S24E04 · Wed 01:00', 'poster1.sig'],
    ]);
  });

  it('counts what came in per day this week, with the change on the week before', () => {
    const week = arrWeek(sonarr().rest?.imports, 'sonarr', now, TZ);
    expect(week?.series[0]?.values).toEqual([0, 0, 0, 0, 1, 0, 3]);
    expect(week?.figure).toEqual({ value: '4', rest: 'episodes this week' });
    expect(week?.stats?.[0]?.[0]?.text).toBe('+100 %');
    expect(arrWeek(null, 'radarr', now, TZ)).toBeNull();
  });

  it('says its version, whether it is up to date, and how full each media disk is', () => {
    const lines = arrMachineLines(sonarr());
    expect(lines.map((l) => [l.label, l.value, l.sub])).toEqual([
      ['Sonarr', '4.0.20.3014', 'Up to date'],
      ['Media disk', '93 GB of 1.8 TB', '1.8 TB free'],
    ]);
    const rest = sonarr().rest;
    const behind = sonarr({
      rest: rest ? { ...rest, update: { installed: '4.0.20.3014', latest: '4.0.21.3100' } } : null,
    });
    expect(arrMachineLines(behind)[0]?.sub).toBe('Version 4.0.21.3100 is out');
    expect(arrMachineLines(radarr())[0]?.sub).toBeUndefined();
  });
});

describe('the page (SD-24)', () => {
  it('keeps Series, Missing, Downloading and Disk free for the card', () => {
    expect(arrKpis(input(sonarr())).map((k) => [k.label, k.value])).toEqual([
      ['Series', '2'],
      ['Missing', '6'],
      ['Downloading', '2'],
      ['Disk free', '1.8 TB'],
    ]);
    expect(
      arrKpis(input(radarr()))
        .map((k) => [k.label, k.value])
        .slice(0, 2),
    ).toEqual([
      ['Movies', '3'],
      ['Missing', '2'],
    ]);
  });

  it('says Sonarr’s health checks in Whombat’s words, its own under them, errors serious, with the way to fix them', () => {
    const n = arrNotices(input(sonarr()));
    expect(n.map((x) => x.tone)).toEqual(['bad', 'warn']);
    expect(n[0]?.title).toMatch(/^Sonarr: search sites/);
    expect(n[0]?.detail).toMatch(/No indexers available/);
    expect(n[0]?.link).toMatchObject({ kind: 'url' });
    expect(arrNotices(input(radarr()))[0]?.icon).toBe('disk');
  });

  it('warns about downloads that can’t be imported', () => {
    const q = parseQueue(fixture('sonarr-queue.json'), 'sonarr');
    const blocked = {
      ...q,
      items: q.items.map((i, k) =>
        k === 0
          ? {
              ...i,
              trackedStatus: 'warning',
              trackedState: 'importBlocked',
              messages: ['No files found are eligible for import'],
            }
          : i,
      ),
    };
    const n = arrNotices(input(sonarr({ queue: blocked })));
    expect(n.find((x) => x.check === 'sonarr.imports')).toMatchObject({
      tone: 'warn',
      detail: 'No files found are eligible for import',
      nature: 'problem',
      subject: { id: 'download:1412340291', name: 'NCIS · S24E03' },
      ignore: { lifts: 'fixed' },
    });
  });

  it('warns when the smallest root folder is nearly full', () => {
    const rest = sonarr().rest;
    const full = sonarr({
      rest: rest
        ? { ...rest, health: [], roots: [{ path: '/tv', free: 40e9, total: 1e12, accessible: true }] }
        : null,
    });
    expect(arrNotices(input(full)).map((n) => [n.check, n.tone, n.subject?.id, n.band])).toEqual([
      ['media.disk', 'bad', 'disk:931g', 95],
    ]);
  });

  it('asks again every 5 seconds while something downloads (SD-09)', () => {
    expect(arrView(input(sonarr())).refreshS).toBe(5);
    expect(arrView(input(sonarr({ queue: { items: [], total: 0 } }))).refreshS).toBeUndefined();
    expect(arrView(input(sonarr())).machine).toBe('after');
  });

  it('words air times', () => {
    expect(airWords(new Date('2026-10-21T19:00:00Z'), now, TZ)).toBe('Today 21:00');
    expect(airWords(new Date('2026-10-22T19:00:00Z'), now, TZ)).toBe('Tomorrow 21:00');
    expect(airWords(new Date('2026-10-24T19:00:00Z'), now, TZ)).toBe('Sat 21:00');
  });
});

describe('Search for missing (SD-24)', () => {
  const services = {} as Services;
  it('asks Sonarr for MissingEpisodeSearch and Radarr for MissingMoviesSearch', async () => {
    http.calls = [];
    const ctx = (app: string) => ({ services, row: rowOf(app), now, timeZone: TZ });
    const sonarrDone = await SONARR_KIND.actions?.search_missing?.(ctx('sonarr'), {});
    await RADARR_KIND.actions?.search_missing?.(ctx('radarr'), {});
    expect(http.calls.map((c) => [c.method, c.url.pathname, JSON.parse(c.body ?? '{}').name])).toEqual([
      ['POST', '/api/v3/command', 'MissingEpisodeSearch'],
      ['POST', '/api/v3/command', 'MissingMoviesSearch'],
    ]);
    expect(sonarrDone?.everyday).toBeFalsy();
  });
});

describe('quiet notices (quiet-notices.md QN-01…QN-04, QN-11)', () => {
  const health = (source: string, type = 'warning', message = `${source} says something.`) => ({
    source,
    type,
    message,
    wikiUrl: null,
  });
  const withHealth = (h: ReturnType<typeof health>[]) => {
    const rest = sonarr().rest;
    return sonarr({ rest: rest ? { ...rest, health: h } : null, queue: { items: [], total: 0 } });
  };

  it('keys its own checks by their source, not their words, with a kind of line per source', () => {
    const n = arrNotices(input(sonarr()));
    expect(n.map((x) => [x.check, x.subject?.id, x.nature, x.tone])).toEqual([
      ['sonarr.health', 'source:IndexerRssCheck', 'problem', 'bad'],
      ['sonarr.health', 'source:IndexerSearchCheck', 'problem', 'warn'],
    ]);
    // A different message is a different episode; the same source stays the same item.
    const a = arrNotices(input(withHealth([health('IndexerStatusCheck', 'warning', 'Indexers failing: A')])));
    const b = arrNotices(
      input(withHealth([health('IndexerStatusCheck', 'warning', 'Indexers failing: A, B')])),
    );
    expect(a[0]?.subject).toEqual(b[0]?.subject);
    expect(a[0]?.episode).not.toBe(b[0]?.episode);
    expect(a[0]?.confirm).toBe(2);
    expect(arrNotices(input(radarr()))[0]).toMatchObject({ check: 'radarr.health', nature: 'problem' });
  });

  it('makes a notice, lists and updates heads-ups, and removed titles and setup only-you', () => {
    expect(healthNature(health('IndexerStatusCheck', 'notice'))).toBe('fyi');
    expect(healthNature(health('ImportListStatusCheck'))).toBe('fyi');
    expect(healthNature(health('UpdateCheck', 'warning', 'New update is available'))).toBe('fyi');
    expect(healthNature(health('UpdateCheck', 'error', 'Cannot install update because …'))).toBe('you');
    expect(healthNature(health('RemovedSeriesCheck'))).toBe('you');
    expect(healthNature(health('ProxyCheck'))).toBe('problem');
    const fyi = arrNotices(input(withHealth([health('NotificationStatusCheck', 'warning')])))[0];
    expect(fyi).toMatchObject({ nature: 'fyi', tone: 'info' });
  });

  it('gives each download that can’t be imported its own line, three lines at most, the rest as one', () => {
    const q = parseQueue(fixture('sonarr-queue.json'), 'sonarr');
    const first = q.items[0] as NonNullable<(typeof q.items)[0]>;
    const items = Array.from({ length: 11 }, (_, k) => ({
      ...first,
      id: String(100 + k),
      forWhat: `Show ${k}`,
      trackedStatus: 'warning',
      messages: k === 0 ? ['Not an upgrade for existing episode file(s)'] : ['Failed to import'],
    }));
    const n = arrNotices(input(sonarr({ queue: { items, total: 11 } }))).filter(
      (x) => x.check === 'sonarr.imports',
    );
    expect(n).toHaveLength(3);
    expect(n[0]).toMatchObject({ subject: { id: 'download:100' }, nature: 'you' });
    expect(n[1]?.nature).toBe('problem');
    expect(n[2]).toMatchObject({ subject: { id: '+more', name: '9 more' }, ignore: { lifts: 'newer' } });
    expect(n[2]?.episode).toMatch(/^[0-9a-f]{8}$/);
  });

  it('says a disk once, by its size, at its tightest root folder', () => {
    const rest = sonarr().rest;
    const two = sonarr({
      rest: rest
        ? {
            ...rest,
            health: [],
            roots: [
              { path: '/tv', free: 80e9, total: 1e12, accessible: true },
              { path: '/anime', free: 60e9, total: 1e12, accessible: true },
            ],
          }
        : null,
    });
    const n = arrNotices(input(two));
    expect(n.map((x) => [x.check, x.subject, x.tone])).toEqual([
      ['media.disk', { id: 'disk:931g', name: '/anime' }, 'warn'],
    ]);
    expect(n[0]?.link?.kind).toBe('ask');
  });

  it('never decides warn or bad in the head, and leaves heads-ups out of the dot', async () => {
    expect(arrView(input(sonarr())).status).toEqual({ status: 'ok', badge: 'Downloading 2 items' });
    const idle = sonarr({ queue: { items: [], total: 0 } });
    expect(arrView(input(idle)).status).toBeUndefined();
  });

  it('says which checks it couldn’t read: a part not read, a queue longer than read', () => {
    expect(arrSkipped(sonarr())).toEqual([]);
    const rest = sonarr().rest;
    const partial = sonarr({
      rest: rest ? { ...rest, unread: ['health', 'roots'] } : null,
      queue: { items: [], total: 25 },
    });
    expect(arrSkipped(partial)).toEqual(['sonarr.health', 'media.disk', 'sonarr.imports']);
    expect(arrSkipped(radarr({ queue: null }))).toEqual(['radarr.imports']);
  });

  it('lists every check it can raise for What Whombat watches', () => {
    expect(arrChecks('radarr').map((c) => c.check)).toEqual([
      'media.disk',
      'radarr.health',
      'radarr.imports',
    ]);
    expect(SONARR_KIND.checks?.map((c) => c.check)).toContain('sonarr.health');
    expect(RADARR_KIND.checks?.every((c) => c.name.length <= 80)).toBe(true);
  });
});
