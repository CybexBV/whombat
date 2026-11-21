/**
 * Plex's page and card from recorded answers (SD-20, SD-04, SD-10): libraries and their counts, what plays and whether
 * it converts, recently added with who asked in Seerr, scans, remote access, updates, and the two buttons.
 */
import type { ThingPagePanel } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { slotProblems, weekChange } from '../slots';
import {
  askedByOf,
  leftWords,
  namesById,
  noteActivities,
  PLEX_ACTIONS,
  PLEX_CHECKS,
  PLEX_KIND,
  type PlexInput,
  type PlexPlay,
  type PlexRest,
  parseActivities,
  parseHistory,
  parseItem,
  parseSections,
  parseSessions,
  parseUpdater,
  playClock,
  plexKpis,
  plexNotices,
  plexSkipped,
  plexView,
  thumbPath,
  whoAsked,
} from './plex';
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
        url.pathname === '/library/sections'
          ? readFileSync(new URL('./fixtures/plex-sections.json', import.meta.url), 'utf8')
          : '';
      return { status: 200, headers: {}, body: Buffer.from(body) };
    },
  };
});

const now = new Date('2026-10-21T19:46:00Z');
const TZ = 'Europe/Amsterdam';
const row = rowOf('plex');

function rest(more: Partial<PlexRest> = {}): PlexRest {
  const libraries = parseSections(fixture('plex-sections.json')).map((l) =>
    l.type === 'movie' ? { ...l, count: 3, unmatched: 1 } : { ...l, count: 1, episodes: 2, unmatched: 0 },
  );
  const items = [
    ...fixture<{ MediaContainer: { Metadata: unknown[] } }>('plex-recent-movies.json').MediaContainer
      .Metadata,
    ...fixture<{ MediaContainer: { Metadata: unknown[] } }>('plex-recent-shows.json').MediaContainer.Metadata,
  ];
  return {
    version: fixture<{ MediaContainer: { version: string } }>('plex-root.json').MediaContainer.version,
    name: 'Plex',
    signedIn: false,
    mapping: 'unknown',
    mappingError: null,
    libraries,
    recent: items.map(parseItem).filter((i) => i !== null),
    update: parseUpdater(fixture('plex-updater.json'), '1.43.5.11029-6bf8af3f0'),
    ...more,
  };
}

/** The recorded session, with the user and player names Plex gives a signed-in server (its OpenAPI). */
function sessions(more: Record<string, unknown> = {}) {
  const raw = fixture<{ MediaContainer: { Metadata: Record<string, unknown>[] } }>('plex-sessions.json');
  const m = raw.MediaContainer.Metadata[0] ?? {};
  return parseSessions({
    MediaContainer: {
      Metadata: [
        {
          ...m,
          User: { id: '1', title: 'Anna' },
          Player: { ...(m.Player as object), title: 'Living room TV', product: 'Plex for LG' },
          ...more,
        },
      ],
    },
  });
}

const input = (r: PlexRest, more: Partial<PlexInput> = {}): PlexInput => ({
  rest: r,
  live: { sessions: sessions(), activities: [] },
  readAt: now,
  now,
  timeZone: TZ,
  who: { row },
  url: 'http://192.0.2.10:32400',
  asked: null,
  since: new Map(),
  streams: [],
  poster: (thumb, title) =>
    thumb ? { ref: `${encodeURIComponent(thumb).slice(0, 20)}.sig`, alt: title, shape: 'poster' } : undefined,
  ...more,
});

const panel = (panels: ThingPagePanel[], id: string) => panels.find((p) => p.id === id);

describe('reading Plex 1.43.5 (recorded)', () => {
  it('reads libraries with their last scan', () => {
    const libs = parseSections(fixture('plex-sections.json'));
    expect(libs.map((l) => [l.key, l.type, l.title])).toEqual([
      ['1', 'movie', 'Movies'],
      ['2', 'show', 'TV Shows'],
    ]);
    expect(libs[0]?.scannedAt).toBeInstanceOf(Date);
  });

  it('reads recently added movies with their TMDB id, and a season under its show', () => {
    const r = rest().recent;
    expect(r.find((i) => i.title === 'Inside Out 2')?.tmdbId).toBe(1022789);
    const season = r.find((i) => i.type === 'season');
    // Its GUIDs are the season's own: no TMDB id that could name another title in Seerr.
    expect(season).toMatchObject({ title: 'NCIS', part: 'Season 24', showKey: '4', tmdbId: null });
  });

  it('reads a converting session and how far it is', () => {
    const [s] = parseSessions(fixture('plex-sessions.json'));
    expect(s?.converting).toBe(true);
    expect(s?.item.title).toBe('Dune: Part Two');
    expect(s?.progress).toBeCloseTo(1000 / 3023);
    expect(s?.state).toBe('playing');
  });

  it('reads a running scan', () => {
    const a = parseActivities({
      MediaContainer: {
        size: 1,
        Activity: [
          {
            uuid: 'd2d5fc4a-38db-4e0b-86ff-38b03733feb8',
            type: 'library.update.section',
            title: 'Scanning Movies',
            subtitle: 'Dune Part Two (2024)',
            progress: 50,
            Context: { librarySectionID: '1' },
          },
        ],
      },
    });
    expect(a).toEqual([
      {
        id: 'd2d5fc4a-38db-4e0b-86ff-38b03733feb8',
        title: 'Scanning Movies',
        sectionKey: '1',
        progress: 0.5,
      },
    ]);
  });

  it('knows an update only when Plex names a newer release', () => {
    expect(parseUpdater(fixture('plex-updater.json'), '1.43.5.11029-6bf8af3f0')).toBeNull();
    const waiting = {
      MediaContainer: {
        canInstall: true,
        Release: [{ version: '1.43.6.11100-abcdef12', state: 'available' }],
      },
    };
    expect(parseUpdater(waiting, '1.43.5.11029-6bf8af3f0')).toEqual({
      version: '1.43.6.11100',
      state: 'available',
    });
  });
});

describe('the page (SD-20)', () => {
  it('shows Movies, Shows (with episodes) and Watching now (converting)', () => {
    const kpis = plexKpis(input(rest()));
    expect(kpis.map((k) => [k.key, k.value, k.sub])).toEqual([
      ['movies', '3', '1 library'],
      ['shows', '1', '2 episodes'],
      ['watching', '1', '1 converting'],
    ]);
  });

  it('shows who watches on which device, how far, and that it converts, in rows', () => {
    const p = panel(plexView(input(rest())).panels, 'playing');
    expect(p?.kind === 'gallery' && [p.look, p.span, p.place]).toEqual(['rows', 2, 'chart']);
    const playing = p?.kind === 'gallery' ? p.items[0] : undefined;
    expect(playing?.person).toEqual({ name: 'Anna', note: 'Living room TV' });
    expect(playing?.sub).toBe('Film · 2024 · SD');
    expect(playing?.badge?.text).toBe('Converting');
    expect(playing?.note).toBe('0:01 of 0:03');
    expect(p?.kind === 'gallery' && p.meta).toBe('1 stream · 0.2 Mb/s out');
  });

  it('says a paused stream is paused, with a grey bar', () => {
    const live = { sessions: sessions({ Player: { state: 'paused' } }), activities: [] };
    const p = panel(plexView(input(rest(), { live })).panels, 'playing');
    const item = p?.kind === 'gallery' ? p.items[0] : undefined;
    expect([item?.badge?.text, item?.paused, item?.noteEnd]).toEqual(['Paused', true, 'Paused']);
  });

  it('says who asked for what was added, from Seerr (SD-10), on a shelf', () => {
    const asked = askedByOf(parseRequests(fixture('seerr-processing.json'), now).items);
    const p = panel(plexView(input(rest(), { asked })).panels, 'recent');
    expect(p?.kind === 'gallery' && [p.look, p.span]).toEqual(['shelf', 3]);
    const recent = p?.kind === 'gallery' ? p.items : [];
    expect(recent.find((i) => i.title === 'Inside Out 2')?.person?.name).toBe('Ben');
    expect(recent.find((i) => i.title === 'Dune: Part Two')?.person).toBeUndefined();
    expect(whoAsked(null, rest().recent[0] as never)).toBeNull();
  });

  it('counts each library with what came in this week, Scan, and Scanning with how far', () => {
    const live = {
      sessions: [],
      activities: [{ id: 'x', title: 'Scanning Movies', sectionKey: '1', progress: 0.4 }],
    };
    const r = rest();
    r.libraries = r.libraries.map((l) => ({ ...l, added: l.type === 'show' ? 5 : 0 }));
    const libs = panel(plexView(input(r, { live })).panels, 'libraries');
    expect(libs?.kind === 'list' && libs.look).toBe('counts');
    const items = libs?.kind === 'list' ? libs.items : [];
    expect(items[0]?.detail).toBe('Scanning · 40 %');
    expect(items[0]?.actions).toBeUndefined();
    expect(items[0]?.figure?.note).toBe('Nothing new');
    expect(items[1]?.actions?.[0]).toMatchObject({ action: 'scan', target: '2', allowed: true });
    expect([items[1]?.figure?.value, items[1]?.right, items[1]?.figure?.note, items[1]?.icon]).toEqual([
      '1',
      '1',
      '+5 episodes',
      'tv',
    ]);
    expect(items[1]?.detail).toMatch(/^2 episodes · /);
    expect(libs?.kind === 'list' && libs.buttons).toBeFalsy();
  });

  it('is in slots: no figures of its own, the machine card with Plex’s version', () => {
    expect(slotProblems(plexView(input(rest(), { history: [] })))).toEqual([]);
    const lines = (r: PlexRest) => plexView(input(r)).slots?.machine.map((b) => [b.label, b.value, b.sub]);
    expect(lines(rest())).toEqual([['Plex', '1.43.5.11029', 'Up to date']]);
    expect(lines(rest({ update: { version: '1.44.0', state: 'available' } }))?.[0]?.[2]).toBe(
      'Version 1.44.0 is out',
    );
  });

  it('shows this week’s plays per day and who watched, from the history', () => {
    const day = 24 * 3600_000;
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * day - 3600_000);
    const history: PlexPlay[] = [
      { at: at(0), who: 'Anna', device: 'Living room TV' },
      { at: at(0), who: 'Anna', device: 'Living room TV' },
      { at: at(1), who: 'John', device: 'iPad' },
      { at: at(3), who: 'Anna', device: 'iPhone' },
      { at: at(9), who: 'John', device: 'iPad' },
      { at: at(10), who: 'John', device: 'iPad' },
    ];
    const panels = plexView(input(rest(), { history })).panels;
    const week = panel(panels, 'week');
    expect(week?.kind === 'chart' && week.labels?.at(-1)).toBe('Today');
    expect(week?.kind === 'chart' && week.series[0]?.values).toEqual([0, 0, 0, 1, 0, 1, 2]);
    expect(week?.kind === 'chart' && week.figure?.value).toBe('4');
    expect(week?.kind === 'chart' && week.stats?.[0]?.[0]?.text).toBe('+100 %');
    const people = panel(panels, 'people');
    expect(people?.kind === 'bars' && people.items.map((b) => [b.label, b.note, b.value, b.person])).toEqual([
      ['Anna', 'Living room TV', '3 plays', true],
      ['John', 'iPad', '1 play', true],
    ]);
    expect(panel(plexView(input(rest())).panels, 'week')).toBeUndefined();
  });

  it('reads the history with names for people and devices', () => {
    const plays = parseHistory(
      {
        MediaContainer: { Metadata: [{ viewedAt: 1792611694, accountID: 1, deviceID: '7' }, { title: 'x' }] },
      },
      namesById({ MediaContainer: { Account: [{ id: 1, name: 'anna' }] } }, 'Account'),
      namesById({ MediaContainer: { Device: [{ id: 7, name: 'Living room TV' }] } }, 'Device'),
    );
    expect(plays.map((p) => [p.who, p.device])).toEqual([['anna', 'Living room TV']]);
    expect([weekChange(9, 10), weekChange(3, 0), playClock(4212_000), leftWords(96 * 60_000)]).toEqual([
      '−10 %',
      null,
      '1:10:12',
      '1 h 36 min',
    ]);
  });

  it('puts Check for updates in the head', () => {
    expect(plexView(input(rest())).buttons?.map((b) => [b.action, b.allowed])).toEqual([
      ['check_updates', true],
    ]);
  });

  it('says what is worth a look: unmatched items, an update, remote access, many conversions, a long scan', () => {
    expect(plexNotices(input(rest())).map((n) => [n.id, n.tone])).toEqual([['unmatched-1', 'info']]);
    const busy = {
      sessions: [...sessions(), ...sessions(), ...sessions()].map((s, i) => ({ ...s, id: `s${i}` })),
      activities: [{ id: 'scan1', title: 'Scanning Movies', sectionKey: '1', progress: 0.1 }],
    };
    const n = plexNotices(
      input(rest({ signedIn: true, mapping: 'failed', update: { version: '1.43.6', state: 'available' } }), {
        live: busy,
        since: new Map([['scan1', new Date(now.getTime() - 2 * 3600_000)]]),
      }),
    );
    expect(n.map((x) => [x.check, x.nature, x.tone])).toEqual([
      ['plex.remote', 'problem', 'warn'],
      ['plex.converting', 'fyi', 'info'],
      ['plex.scan', 'fyi', 'info'],
      ['plex.unmatched', 'fyi', 'info'],
      ['plex.updates', 'fyi', 'info'],
    ]);
  });

  it('asks again every 5 seconds while something plays (SD-09)', () => {
    expect(plexView(input(rest())).refreshS).toBe(5);
    expect(plexView(input(rest(), { live: { sessions: [], activities: [] } })).refreshS).toBeUndefined();
  });

  it('asks Plex’s transcoder for a small poster', () => {
    const path = thumbPath('/library/metadata/2/thumb/1792611699', true);
    expect(path.startsWith('/photo/:/transcode?')).toBe(true);
    expect(new URLSearchParams(path.split('?')[1]).get('url')).toBe('/library/metadata/2/thumb/1792611699');
    expect(thumbPath('/library/metadata/2/thumb/1', false)).toBe('/library/metadata/2/thumb/1');
  });

  it('remembers since when a scan runs, and forgets it once it ends', () => {
    const services = {} as Services;
    const a = [{ id: 'a', title: 'Scanning', sectionKey: '1', progress: null }];
    const first = noteActivities(services, row.id, a, now).get('a');
    const later = noteActivities(services, row.id, a, new Date(now.getTime() + 60_000)).get('a');
    expect(later).toEqual(first);
    noteActivities(services, row.id, [], now);
    expect(
      noteActivities(services, row.id, a, new Date(now.getTime() + 120_000))
        .get('a')
        ?.getTime(),
    ).toBe(now.getTime() + 120_000);
  });
});

describe('the buttons (SD-07)', () => {
  const ctx = { services: {} as Services, row, now, timeZone: TZ };
  it('scans a library Plex has, with POST', async () => {
    http.calls = [];
    const done = await PLEX_ACTIONS.scan?.(ctx, { target: '1' });
    expect(http.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url.pathname])).toEqual([
      ['POST', '/library/sections/1/refresh'],
    ]);
    expect(done?.title).toContain('Movies');
    await expect(PLEX_ACTIONS.scan?.(ctx, { target: '9' })).rejects.toThrow(/library/);
    await expect(PLEX_ACTIONS.scan?.(ctx, { target: '../x' })).rejects.toThrow();
  });

  it('checks for updates and never installs one', async () => {
    http.calls = [];
    const done = await PLEX_ACTIONS.check_updates?.(ctx, {});
    expect(http.calls.map((c) => [c.method, c.url.pathname])).toEqual([['PUT', '/updater/check']]);
    expect(done?.everyday).toBe(true);
    expect(Object.keys(PLEX_ACTIONS).sort()).toEqual(['check_updates', 'scan', 'setting']);
  });
});

describe('quiet notices (quiet-notices.md QN-01…QN-04, QN-11)', () => {
  const scanning = (hours: number) =>
    input(rest(), {
      live: {
        sessions: [],
        activities: [{ id: 'scan1', title: 'Scanning Movies', sectionKey: '1', progress: 0.1 }],
      },
      since: new Map([['scan1', new Date(now.getTime() - hours * 3600_000)]]),
    });

  it('keys a long scan by its library and its run, a heads-up until it runs six hours', () => {
    const short = plexNotices(scanning(2)).find((n) => n.check === 'plex.scan');
    expect(short).toMatchObject({
      nature: 'fyi',
      subject: { id: 'library:1', name: 'Movies' },
      episode: 'scan1',
      ignore: { lifts: 'newer' },
    });
    expect(short?.link).toBeUndefined();
    const long = plexNotices(scanning(7)).find((n) => n.check === 'plex.scan');
    expect(long).toMatchObject({ nature: 'problem', tone: 'warn', link: { kind: 'ask' } });
  });

  it('counts remote access after two passes, and unmatched items per library by their number', () => {
    const remote = plexNotices(input(rest({ signedIn: true, mapping: 'failed' }))).find(
      (n) => n.check === 'plex.remote',
    );
    expect(remote).toMatchObject({ confirm: 2, ignore: { lifts: 'fixed' } });
    const unmatched = plexNotices(input(rest())).find((n) => n.check === 'plex.unmatched');
    expect(unmatched).toMatchObject({ subject: { id: 'library:1', name: 'Movies' }, band: 1 });
    const update = plexNotices(input(rest())).find((n) => n.check === 'plex.updates');
    expect(update ?? null).toBeNull();
    const out = plexNotices(input(rest({ update: { version: '1.43.6', state: 'available' } })));
    expect(out.find((n) => n.check === 'plex.updates')).toMatchObject({ episode: '1.43.6' });
  });

  it('never decides warn or bad in the head', () => {
    const r = rest({ signedIn: true, mapping: 'failed' });
    expect(plexView(input(r)).status).toEqual({ status: 'ok', badge: '1 stream playing' });
    expect(plexView(input(r, { live: { sessions: [], activities: [] } })).status).toBeUndefined();
  });

  it('says which checks it couldn’t read', () => {
    const r = rest();
    expect(plexSkipped(r, { sessions: [], activities: [] })).toEqual([]);
    expect(plexSkipped(r, null)).toEqual(['plex.converting', 'plex.scan']);
    expect(plexSkipped(r, { sessions: [], activities: [], unread: ['activities'] })).toEqual(['plex.scan']);
    const unread = rest({
      unread: ['updater'],
      libraries: r.libraries.map((l) => ({ ...l, unmatched: null })),
    });
    expect(plexSkipped(unread, { sessions: [], activities: [] })).toEqual(['plex.unmatched', 'plex.updates']);
  });

  it('lists every check it can raise', () => {
    expect(PLEX_KIND.checks).toBe(PLEX_CHECKS);
    expect(PLEX_CHECKS.map((c) => [c.check, c.nature])).toEqual([
      ['plex.remote', 'problem'],
      ['plex.converting', 'fyi'],
      ['plex.scan', 'fyi'],
      ['plex.unmatched', 'fyi'],
      ['plex.updates', 'fyi'],
    ]);
  });
});
