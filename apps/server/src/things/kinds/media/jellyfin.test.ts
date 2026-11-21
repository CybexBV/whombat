/**
 * Jellyfin's page, card, checks, Seerr "Asked by" linking, and Scan buttons from documented API fixtures.
 */
import { ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { slotProblems } from '../slots';
import {
  JELLYFIN_ACTIONS,
  JELLYFIN_CHECKS,
  JELLYFIN_KIND,
  type JellyfinInput,
  type JellyfinPlay,
  type JellyfinRest,
  jellyfinActivity,
  jellyfinKpis,
  jellyfinNotices,
  jellyfinPosterPath,
  jellyfinSkipped,
  jellyfinVerdict,
  jellyfinView,
  noteJellyfinScans,
  parseActivityPlays,
  parseItem,
  parseLibraries,
  parseSessions,
  parseTasks,
  parseUsers,
} from './jellyfin';
import { askedByOf } from './plex';
import { parseRequests } from './seerr';
import { fixture, rowOf } from './testing';

const http = vi.hoisted(() => ({ calls: [] as { method: string; url: URL }[] }));
vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  const { readFileSync } = await import('node:fs');
  return {
    ...real,
    signedConnectionFetch: async (_s: unknown, _r: unknown, req: { method: string; url: string }) => {
      const url = new URL(req.url);
      http.calls.push({ method: req.method, url });
      const body =
        url.pathname === '/Library/VirtualFolders'
          ? readFileSync(new URL('./fixtures/jellyfin-folders.json', import.meta.url), 'utf8')
          : '';
      return { status: 200, headers: {}, body: Buffer.from(body) };
    },
  };
});

const now = new Date('2026-10-21T19:46:00Z');
const TZ = 'Europe/Amsterdam';
const row = rowOf('jellyfin');

function rest(more: Partial<JellyfinRest> = {}): JellyfinRest {
  const info = fixture<{ Version: string; ServerName: string; OperatingSystemDisplayName: string }>(
    'jellyfin-info.json',
  );
  const counts = fixture<{
    MovieCount: number;
    SeriesCount: number;
    EpisodeCount: number;
    AlbumCount: number;
    SongCount: number;
  }>('jellyfin-counts.json');
  const libraries = parseLibraries(fixture('jellyfin-folders.json')).map((l) =>
    l.type === 'movies'
      ? { ...l, count: counts.MovieCount }
      : l.type === 'tvshows'
        ? { ...l, count: counts.SeriesCount, episodes: counts.EpisodeCount }
        : { ...l, count: counts.AlbumCount },
  );
  const recentRaw = fixture<{ Items: unknown[] }>('jellyfin-recent.json').Items;
  const tasks = parseTasks(fixture('jellyfin-tasks.json'));
  return {
    version: info.Version,
    name: info.ServerName,
    os: info.OperatingSystemDisplayName,
    pendingRestart: false,
    libraries,
    recent: recentRaw.map(parseItem).filter((i) => i !== null),
    counts: {
      movies: counts.MovieCount,
      shows: counts.SeriesCount,
      episodes: counts.EpisodeCount,
      albums: counts.AlbumCount,
      songs: counts.SongCount,
    },
    lastScanAt: tasks[0]?.lastEndedAt ?? null,
    failedTasks: tasks.filter((t) => t.lastStatus === 'Failed'),
    ...more,
  };
}

const input = (r: JellyfinRest, more: Partial<JellyfinInput> = {}): JellyfinInput => ({
  rest: r,
  live: { sessions: parseSessions(fixture('jellyfin-sessions.json')), tasks: parseTasks(fixture('jellyfin-tasks.json')) },
  readAt: now,
  now,
  timeZone: TZ,
  who: { row },
  url: 'http://10.100.0.20:8096',
  asked: null,
  since: new Map(),
  streams: [],
  poster: (id, title) => (id ? { ref: `jellyfin_${id}.signature12345678`, alt: title, shape: 'poster' } : undefined),
  ...more,
});

const panel = (panels: ThingPagePanel[], id: string) => panels.find((p) => p.id === id);

describe('reading Jellyfin REST responses', () => {
  it('parses libraries, recent items with TMDB ids, and active sessions (skipping idle ones)', () => {
    const libs = parseLibraries(fixture('jellyfin-folders.json'));
    expect(libs.map((l) => [l.name, l.type])).toEqual([
      ['Movies', 'movies'],
      ['TV Shows', 'tvshows'],
      ['Music', 'music'],
    ]);
    const recent = rest().recent;
    expect(recent.find((i) => i.title === 'Inside Out 2')?.tmdbId).toBe(1022789);
    const ep = recent.find((i) => i.type === 'Episode');
    // Episodes carry episode TMDB ids, not the show's, and prefer the series poster.
    expect(ep).toMatchObject({ title: 'Slow Horses', part: 'S05E03', imageId: 'ser95480', tmdbId: null });

    const active = parseSessions(fixture('jellyfin-sessions.json'));
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      id: 'sess-1',
      user: 'Anna',
      device: 'Living room TV',
      paused: false,
      converting: true,
      quality: '4K',
      bitrateKbps: 18400,
    });
    expect(active[0]?.progress).toBeCloseTo(4212 / 9960);
  });

  it('parses activity log playback entries with user names and devices', () => {
    const users = parseUsers([{ Id: 'u1', Name: 'Anna' }]);
    const plays = parseActivityPlays(
      {
        Items: [
          {
            Id: 1,
            Type: 'VideoPlayback',
            Name: 'Anna is playing Dune: Part Two on Living room TV',
            UserId: 'u1',
            Date: '2026-10-21T18:00:00Z',
          },
          {
            Id: 2,
            Type: 'AuthenticationSucceeded',
            Name: 'Anna logged in',
            UserId: 'u1',
            Date: '2026-10-21T17:59:00Z',
          },
        ],
      },
      users,
    );
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ who: 'Anna', device: 'Living room TV' });
  });
});

describe('Jellyfin page in slots', () => {
  it('passes slot validation with history, shows Now playing, Libraries, Recently added and machine version', () => {
    const day = 24 * 3600_000;
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * day - 3600_000);
    const history: JellyfinPlay[] = [
      { at: at(0), who: 'Anna', device: 'Living room TV' },
      { at: at(1), who: 'John', device: 'iPad' },
      { at: at(8), who: 'John', device: 'iPad' },
    ];
    const view = jellyfinView(input(rest(), { history }));
    expect(slotProblems(view)).toEqual([]);
    for (const p of view.panels) ThingPagePanel.parse(p);
    for (const n of view.notices) ThingPageNotice.parse(n);
    expect(view.refreshS).toBe(5);
    expect(view.verdict).toBe('Jellyfin is fine: 1 person is watching and every library is up to date.');
    expect(view.suggestions).toEqual(['Most watched this month', 'Who watches most', 'Biggest movies']);
    expect(view.slots?.machine.map((b) => [b.label, b.value, b.sub])).toEqual([
      ['Jellyfin', '10.10.3', 'Linux 6.12'],
    ]);

    const playing = panel(view.panels, 'playing');
    expect(playing?.kind === 'gallery' && playing.meta).toBe('1 stream · 18 Mb/s out');
    const item = playing?.kind === 'gallery' ? playing.items[0] : undefined;
    expect(item?.person).toEqual({ name: 'Anna', note: 'Living room TV' });
    expect(item?.badge?.text).toBe('Converting');
    expect(item?.note).toBe('1:10:12 of 2:46:00');
  });

  it('matches Seerr "Asked by" on recently added films by TMDB id', () => {
    const asked = askedByOf(parseRequests(fixture('seerr-processing.json'), now).items);
    const view = jellyfinView(input(rest(), { asked }));
    const recent = panel(view.panels, 'recent');
    const items = recent?.kind === 'gallery' ? recent.items : [];
    expect(items.find((i) => i.title === 'Inside Out 2')?.person?.name).toBe('Ben');
    expect(items.find((i) => i.title === 'Dune: Part Two')?.person).toBeUndefined();
  });

  it('reports card KPIs, activity and poster path cleanly', () => {
    const kpis = jellyfinKpis(input(rest()));
    expect(kpis.map((k) => [k.key, k.value, k.sub])).toEqual([
      ['movies', '412', '1 library'],
      ['shows', '68', '2,840 episodes'],
      ['watching', '1', '1 converting'],
    ]);
    expect(jellyfinActivity({ sessions: parseSessions(fixture('jellyfin-sessions.json')), tasks: [] })).toEqual({
      active: true,
      value: '1 watching',
      detail: 'Dune: Part Two',
    });
    expect(jellyfinActivity({ sessions: [], tasks: [] })).toEqual({ active: false, value: 'Nobody watching' });
    expect(jellyfinPosterPath('mov1022789')).toBe('/Items/mov1022789/Images/Primary?maxWidth=240&quality=90');
    expect(jellyfinVerdict(rest(), { sessions: [], tasks: [] })).toBe(
      'Jellyfin is fine: nobody is watching and every library is up to date.',
    );
  });

  it('raises notices for failed tasks, pending restart, many conversions and long scans, all starting off', () => {
    expect(JELLYFIN_KIND.checks).toBe(JELLYFIN_CHECKS);
    expect(JELLYFIN_CHECKS.every((c) => c.startsOn === false)).toBe(true);
    const failedTask = {
      id: 't-fail',
      name: 'Refresh Guide',
      key: 'RefreshGuide',
      running: false,
      progress: null,
      lastStatus: 'Failed',
      lastEndedAt: now,
      errorMessage: 'Guide host unreachable',
    };
    const runningScan = {
      id: 't-scan',
      name: 'Scan Media Library',
      key: 'RefreshLibrary',
      running: true,
      progress: 0.35,
      lastStatus: 'Completed',
      lastEndedAt: null,
      errorMessage: null,
    };
    const one = parseSessions(fixture('jellyfin-sessions.json'))[0]!;
    const notices = jellyfinNotices(
      input(rest({ pendingRestart: true, failedTasks: [failedTask] }), {
        live: {
          sessions: [one, { ...one, id: 's2' }, { ...one, id: 's3' }],
          tasks: [runningScan],
        },
        since: new Map([['t-scan', new Date(now.getTime() - 2 * 3600_000)]]),
      }),
    );
    expect(notices.map((n) => [n.check, n.nature, n.tone])).toEqual([
      ['jellyfin.task_failed', 'problem', 'warn'],
      ['jellyfin.restart', 'you', 'info'],
      ['jellyfin.converting', 'fyi', 'info'],
      ['jellyfin.scan', 'fyi', 'info'],
    ]);
    expect(jellyfinSkipped(rest({ unread: ['tasks'] }), null)).toEqual([
      'jellyfin.task_failed',
      'jellyfin.converting',
      'jellyfin.scan',
    ]);
  });

  it('tracks when a scan started and clears it when done', () => {
    const services = {} as Services;
    const scanTask = {
      id: 't1',
      name: 'Scan Media Library',
      key: 'RefreshLibrary',
      running: true,
      progress: 0.2,
      lastStatus: null,
      lastEndedAt: null,
      errorMessage: null,
    };
    const first = noteJellyfinScans(services, row.id, [scanTask], now).get('t1');
    const later = noteJellyfinScans(services, row.id, [scanTask], new Date(now.getTime() + 60_000)).get('t1');
    expect(later).toEqual(first);
    noteJellyfinScans(services, row.id, [], now);
    expect(
      noteJellyfinScans(services, row.id, [scanTask], new Date(now.getTime() + 120_000))
        .get('t1')
        ?.getTime(),
    ).toBe(now.getTime() + 120_000);
  });
});

describe('Jellyfin scan actions', () => {
  const ctx = { services: {} as Services, row, now, timeZone: TZ };

  it('scans all libraries or a single valid library id', async () => {
    http.calls = [];
    const all = await JELLYFIN_ACTIONS.scan?.(ctx, { target: 'all' });
    expect(http.calls.map((c) => [c.method, c.url.pathname])).toEqual([['POST', '/Library/Refresh']]);
    expect(all?.title).toContain('every library');

    http.calls = [];
    const one = await JELLYFIN_ACTIONS.scan?.(ctx, { target: 'f137a2dd21bbc1b99aa5c0f6bf02a805' });
    expect(http.calls.filter((c) => c.method === 'POST').map((c) => c.url.pathname)).toEqual([
      '/Items/f137a2dd21bbc1b99aa5c0f6bf02a805/Refresh',
    ]);
    expect(one?.title).toContain('Movies');

    await expect(JELLYFIN_ACTIONS.scan?.(ctx, { target: 'unknown-id' })).rejects.toThrow(/library/);
    await expect(JELLYFIN_ACTIONS.scan?.(ctx, { target: '../bad' })).rejects.toThrow();
  });
});
