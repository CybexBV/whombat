/**
 * Plex's page and card (service-dashboards.md SD-20, SD-04, SD-05, SD-09, SD-10; SD-S06, SD-S13): how big the libraries
 * are, who watches what now (direct or converting), what was added lately with who asked for it in Seerr, each
 * library's count and last scan with a Scan button, and Plex's own problems (an update waiting, remote access, a long
 * scan, unmatched items, many conversions). Read as the connection's Plex token with `Accept: application/json`
 * (`/`, `/library/sections` and their counts, `/hubs/home/recentlyAdded`, `/updater/status`, `/myplex/account`; live:
 * `/status/sessions`, `/activities`); pictures through Plex's own transcoder. Buttons: Scan a library, Check for updates
 * (only checks). Never installs an update, empties a trash or stops someone's stream (SD-02). Viewers and requesters by
 * name.
 */
import type {
  ThingLine,
  ThingPageBar,
  ThingPageButton,
  ThingPageItem,
  ThingPageKpi,
  ThingPageTab,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { assistantCalled } from '../../../home/assistant-name';
import type { ConnectionActivity } from '../../../home/types';
import { ApiError, badRequest, conflict } from '../../../lib/errors';
import { loadAgentRow } from '../../../read/principals';
import type { Services } from '../../../services';
import { readPoints } from '../../points';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { downsample, drawable, onRange, type PageRange, RANGE_MS, type RawPoint } from '../../series';
import { clip, dateOf, figure, line, list, num, plural, rec, span, str, thousands, when } from '../../words';
import { actAs } from '../act';
import {
  cachedRead,
  getJson,
  KIND_DEADLINE_MS,
  latestRead,
  liveRead,
  problemOf,
  withDeadline,
} from '../read';
import type { KindAction, KindModule, KindSeen } from '../registry';
import { seenFromView } from '../registry';
import { describeSetting, SETTING_ACTION, settingAction, settingChanges, settingsPanels } from '../settings';
import {
  addedNote,
  askedBy,
  countByDay,
  countLine,
  dayKey,
  inventory,
  lastDays,
  liveRows,
  type PeoplePanel,
  people,
  shelf,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import {
  badgeOf,
  episodeCode,
  idOf,
  itemLines,
  linesSeen,
  optional,
  picture,
  prefixAllows,
  share,
  siblingRow,
  statusFrom,
  uniqueById,
} from './common';
import { PLEX_SETTINGS, type PlexPrefs } from './plex-settings';
import { parseRequests, type SeerrRequest } from './seerr';
import { asNotices, type ButtonCtx, button, type GalleryItem } from './ui';

const NAME = 'Plex';
export const PLEX_STREAMS_KEY = 'plex_streams';
/** The live part (what plays, what scans) while the page is open. */
export const PLEX_LIVE_S = 4;
/** Counts and unmatched items change slowly: kept 5 and 30 minutes (SD-S05). */
const COUNTS_KEEP_MS = 5 * 60_000;
const UNMATCHED_KEEP_MS = 30 * 60_000;
/** Seerr's requests behind “Asked by …”, kept 5 minutes. */
const ASKED_KEEP_MS = 5 * 60_000;
const RECENT_MAX = 12;
/** The watch history changes with each play: kept 10 minutes. */
const HISTORY_KEEP_MS = 10 * 60_000;
/** How far back the history is read: this week and the one before, for the change. */
const HISTORY_DAYS = 14;
const HISTORY_MAX = 2000;
const H = 3600_000;
const DAY = 24 * H;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface PlexLibrary {
  key: string;
  title: string;
  type: 'movie' | 'show' | 'artist' | 'photo' | string;
  refreshing: boolean;
  scannedAt: Date | null;
  /** Movies, shows or artists. */
  count: number | null;
  /** Shows' episodes. */
  episodes: number | null;
  unmatched: number | null;
  /** Added in the last 7 days: movies, a show's episodes, an artist library's albums. */
  added?: number | null;
}

export interface PlexItem {
  ratingKey: string;
  type: string;
  /** The movie's or show's title. */
  title: string;
  /** “S24E02”, “Season 24”, or null. */
  part: string | null;
  year: number | null;
  thumb: string | null;
  addedAt: Date | null;
  /** The movie's, show's (for a season or episode) Plex key, and its TMDB id when Plex says it. */
  showKey: string | null;
  tmdbId: number | null;
  /** An episode's season and number, a season's number. */
  season?: number | null;
  episode?: number | null;
  /** A song's artist. */
  artist?: string | null;
}

export interface PlexSession {
  id: string;
  item: PlexItem;
  user: string | null;
  device: string | null;
  state: 'playing' | 'paused' | 'buffering' | string;
  /** 0…1. */
  progress: number | null;
  leftMs: number | null;
  converting: boolean;
  /** Where it is and how long it is. */
  offsetMs?: number | null;
  durationMs?: number | null;
  /** What it takes of the upload, in kilobits a second. */
  bandwidthKbps?: number | null;
  /** “4K”, “1080p”, “SD”. */
  quality?: string | null;
}

export interface PlexActivity {
  id: string;
  title: string;
  sectionKey: string | null;
  progress: number | null;
}

export interface PlexLive {
  sessions: PlexSession[];
  activities: PlexActivity[];
  /** Parts this read couldn't read (QN-11): `activities`. */
  unread?: 'activities'[];
}

export interface PlexRest {
  version: string | null;
  name: string | null;
  signedIn: boolean;
  mapping: string | null;
  mappingError: string | null;
  libraries: PlexLibrary[];
  recent: PlexItem[];
  /** A newer Plex waiting, by its version. */
  update: { version: string; state: string | null } | null;
  /** Parts this read couldn't read (QN-11): `updater`. */
  unread?: 'updater'[];
}

const mc = (body: unknown) => rec(rec(body).MediaContainer);

/** A library item, a season, an episode or a playing session's item. */
export function parseItem(raw: unknown): PlexItem | null {
  const m = rec(raw);
  const ratingKey = str(m.ratingKey);
  const type = str(m.type) ?? 'movie';
  if (!ratingKey) return null;
  const episode = type === 'episode';
  const season = type === 'season';
  const title = (episode ? str(m.grandparentTitle) : season ? str(m.parentTitle) : null) ?? str(m.title);
  if (!title) return null;
  const tmdb = list(m.Guid)
    .map((g) => /^tmdb:\/\/(\d+)$/.exec(str(rec(g).id) ?? '')?.[1])
    .find(Boolean);
  return {
    ratingKey,
    type,
    title: title.slice(0, 120),
    part: episode
      ? episodeCode(num(m.parentIndex), num(m.index))
      : season
        ? (str(m.title) ?? (num(m.index) !== null ? `Season ${num(m.index)}` : null))
        : null,
    year: num(m.year) ?? num(m.parentYear),
    thumb:
      (episode ? (str(m.grandparentThumb) ?? str(m.parentThumb)) : null) ??
      str(m.thumb) ??
      str(m.parentThumb),
    addedAt: dateOf(num(m.addedAt)),
    showKey: episode ? str(m.grandparentRatingKey) : season ? str(m.parentRatingKey) : ratingKey,
    // A season's or episode's GUIDs are its own, not its show's.
    tmdbId: tmdb && (type === 'movie' || type === 'show') ? Number(tmdb) : null,
    season: episode ? num(m.parentIndex) : season ? num(m.index) : null,
    episode: episode ? num(m.index) : null,
    artist: type === 'track' ? (str(m.grandparentTitle)?.slice(0, 80) ?? null) : null,
  };
}

/** `/status/sessions`. */
export function parseSessions(body: unknown): PlexSession[] {
  return list(mc(body).Metadata)
    .slice(0, 50)
    .map((raw): PlexSession | null => {
      const m = rec(raw);
      const item = parseItem(raw);
      if (!item) return null;
      const player = rec(m.Player);
      const t = rec(m.TranscodeSession);
      const duration = num(m.duration);
      const offset = num(m.viewOffset);
      return {
        id: (str(rec(m.Session).id) ?? str(m.sessionKey) ?? item.ratingKey).slice(0, 200),
        item,
        user: str(rec(m.User).title)?.slice(0, 60) ?? null,
        device: (str(player.title) ?? str(player.product) ?? str(player.device))?.slice(0, 60) ?? null,
        state: str(player.state) ?? 'playing',
        progress: duration && offset !== null ? Math.max(0, Math.min(1, offset / duration)) : null,
        leftMs: duration && offset !== null ? Math.max(0, duration - offset) : null,
        converting: str(t.videoDecision) === 'transcode',
        offsetMs: offset,
        durationMs: duration,
        bandwidthKbps: num(rec(m.Session).bandwidth),
        quality: qualityOf(str(rec(list(m.Media)[0]).videoResolution)),
      };
    })
    .filter((s): s is PlexSession => s !== null);
}

/** Plex's resolution words as people say them: “4K”, “1080p”, “SD”. */
export function qualityOf(resolution: string | null): string | null {
  if (!resolution) return null;
  if (/^\d+$/.test(resolution)) return `${resolution}p`;
  return resolution.toUpperCase().slice(0, 12);
}

/** `/activities`: running scans and other work, with how far. */
export function parseActivities(body: unknown): PlexActivity[] {
  return list(mc(body).Activity)
    .slice(0, 20)
    .map((raw): PlexActivity | null => {
      const a = rec(raw);
      const id = str(a.uuid);
      if (!id) return null;
      const p = num(a.progress);
      return {
        id,
        title: str(a.title) ?? 'Working',
        sectionKey:
          str(rec(a.Context).librarySectionID) ??
          (num(rec(a.Context).librarySectionID) !== null
            ? String(num(rec(a.Context).librarySectionID))
            : null),
        progress: p !== null ? Math.max(0, Math.min(1, p / 100)) : null,
      };
    })
    .filter((a): a is PlexActivity => a !== null);
}

/** `/library/sections` (counts come later). */
export function parseSections(body: unknown): PlexLibrary[] {
  return list(mc(body).Directory)
    .slice(0, 40)
    .map((raw): PlexLibrary | null => {
      const d = rec(raw);
      const key = str(d.key) ?? (num(d.key) !== null ? String(num(d.key)) : null);
      const title = str(d.title);
      if (!key || !title || num(d.hidden) === 2) return null;
      return {
        key,
        title: title.slice(0, 80),
        type: str(d.type) ?? 'movie',
        refreshing: d.refreshing === true,
        scannedAt: dateOf(num(d.scannedAt)),
        count: null,
        episodes: null,
        unmatched: null,
      };
    })
    .filter((l): l is PlexLibrary => l !== null);
}

/** `/updater/status`: the newest release Plex knows of, when there is one. */
export function parseUpdater(body: unknown, version: string | null): PlexRest['update'] {
  const releases = list(mc(body).Release).map(rec);
  const r = releases[0];
  const v = r ? str(r.version) : null;
  if (!r || !v) return null;
  const bare = (x: string) => x.replace(/-.*$/, '');
  if (version && bare(v) === bare(version)) return null;
  return { version: bare(v), state: str(r.state) };
}

const totalOf = (body: unknown) => num(mc(body).totalSize) ?? num(mc(body).size);
const page0 = { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '0' };

/** A library's count (movies, shows and their episodes, artists), kept 5 minutes; its unmatched items, 30. */
async function withCounts(
  services: Services,
  row: CatalogConnectionRow,
  lib: PlexLibrary,
  now: Date,
): Promise<PlexLibrary> {
  const get = (query: Record<string, string>) =>
    getJson(services, row, NAME, `/library/sections/${encodeURIComponent(lib.key)}/all`, {
      ...query,
      ...page0,
    });
  const counted = (key: string, query: Record<string, string>, keep: number) =>
    optional(
      cachedRead(
        services,
        `plex-count:${row.id}:${lib.key}:${key}`,
        row,
        async () => totalOf(await get(query)),
        keep,
      ),
    );
  const type = lib.type === 'movie' ? '1' : lib.type === 'show' ? '2' : lib.type === 'artist' ? '8' : null;
  if (!type) return lib;
  // What came in this week: films, a show's episodes, an artist library's albums (`addedAt>>=` takes seconds).
  const addedType = lib.type === 'show' ? '4' : lib.type === 'artist' ? '9' : type;
  const since = String(Math.floor((now.getTime() - 7 * DAY) / 1000));
  const [count, episodes, unmatched, added] = await Promise.all([
    counted(type, { type }, COUNTS_KEEP_MS),
    lib.type === 'show' ? counted('4', { type: '4' }, COUNTS_KEEP_MS) : Promise.resolve(null),
    lib.type === 'movie' || lib.type === 'show'
      ? counted('unmatched', { unmatched: '1' }, UNMATCHED_KEEP_MS)
      : Promise.resolve(null),
    counted('added', { type: addedType, 'addedAt>>': since }, COUNTS_KEEP_MS),
  ]);
  return { ...lib, count, episodes, unmatched, added };
}

/** What was added lately: movies and shows from the home hubs (newest Plex), else `/library/recentlyAdded`. */
async function readRecent(services: Services, row: CatalogConnectionRow): Promise<PlexItem[]> {
  const get = (path: string, query: Record<string, string>) => getJson(services, row, NAME, path, query);
  const size = {
    'X-Plex-Container-Start': '0',
    'X-Plex-Container-Size': String(RECENT_MAX),
    includeGuids: '1',
  };
  const hubs = await Promise.all(
    ['1', '2'].map((type) => optional(get('/hubs/home/recentlyAdded', { type, ...size }))),
  );
  let raw = hubs.flatMap((h) => list(mc(h).Metadata));
  if (hubs.every((h) => h === null))
    raw = list(mc(await optional(get('/library/recentlyAdded', size))).Metadata);
  return raw
    .map(parseItem)
    .filter((i): i is PlexItem => i !== null)
    .sort((a, b) => (b.addedAt?.getTime() ?? 0) - (a.addedAt?.getTime() ?? 0))
    .slice(0, RECENT_MAX);
}

async function readRest(services: Services, row: CatalogConnectionRow, now: Date): Promise<PlexRest> {
  const get = (path: string) => getJson(services, row, NAME, path);
  const [root, account, sections, recent, updater] = await Promise.all([
    get('/'),
    optional(get('/myplex/account')),
    get('/library/sections'),
    optional(readRecent(services, row)),
    optional(get('/updater/status')),
  ]);
  const r = mc(root);
  const a = rec(rec(account).MyPlex);
  const version = str(r.version);
  const libraries = await Promise.all(
    parseSections(sections).map((lib) => withCounts(services, row, lib, now)),
  );
  return {
    version,
    name: str(r.friendlyName),
    signedIn: (str(a.signInState) ?? str(r.myPlexSigninState)) === 'ok',
    mapping: str(a.mappingState) ?? str(r.myPlexMappingState),
    mappingError: str(a.mappingError),
    libraries,
    recent: recent ?? [],
    update: updater ? parseUpdater(updater, version) : null,
    ...(updater ? {} : { unread: ['updater' as const] }),
  };
}

async function readLive(services: Services, row: CatalogConnectionRow): Promise<PlexLive> {
  const [sessions, activities] = await Promise.all([
    getJson(services, row, NAME, '/status/sessions'),
    optional(getJson(services, row, NAME, '/activities')),
  ]);
  return {
    sessions: parseSessions(sessions),
    activities: activities ? parseActivities(activities) : [],
    ...(activities ? {} : { unread: ['activities' as const] }),
  };
}

function deadline<T>(work: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await withDeadline(work(), KIND_DEADLINE_MS, 'Plex didn’t answer in time.');
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

const restKey = (row: CatalogConnectionRow) => `plex:${row.id}`;
const liveKey = (row: CatalogConnectionRow) => `plex-live:${row.id}`;

/** The health pass's read. */
export async function plexSnapshot(services: Services, row: CatalogConnectionRow) {
  const [rest, live] = await Promise.all([
    cachedRead(
      services,
      restKey(row),
      row,
      deadline(() => readRest(services, row, services.clock())),
    ),
    optional(
      cachedRead(
        services,
        liveKey(row),
        row,
        deadline(() => readLive(services, row)),
        PLEX_LIVE_S * 1000,
      ),
    ),
  ]);
  return { rest, live };
}

/* Who asked (Seerr, SD-10) -------------------------------------------------------------------------------------------- */

/** Seerr's recently available requests by Plex key and TMDB id: who asked for each. */
export interface AskedBy {
  byKey: Map<string, string>;
  byTmdb: Map<string, string>;
}

export function askedByOf(requests: readonly SeerrRequest[]): AskedBy {
  const byKey = new Map<string, string>();
  const byTmdb = new Map<string, string>();
  for (const r of requests) {
    if (!r.by) continue;
    if (r.ratingKey && !byKey.has(r.ratingKey)) byKey.set(r.ratingKey, r.by);
    if (r.tmdbId !== null && !byTmdb.has(`${r.type}:${r.tmdbId}`)) byTmdb.set(`${r.type}:${r.tmdbId}`, r.by);
  }
  return { byKey, byTmdb };
}

/** Who asked for an item, by its Plex key (the show's for an episode or season) or its TMDB id. */
export function whoAsked(asked: AskedBy | null, item: PlexItem): string | null {
  if (!asked) return null;
  const type = item.type === 'movie' ? 'movie' : 'tv';
  return (
    (item.showKey ? asked.byKey.get(item.showKey) : undefined) ??
    asked.byKey.get(item.ratingKey) ??
    (item.tmdbId !== null ? asked.byTmdb.get(`${type}:${item.tmdbId}`) : undefined) ??
    null
  );
}

async function readAsked(services: Services, seerr: CatalogConnectionRow, now: Date): Promise<AskedBy> {
  return cachedRead(
    services,
    `seerr-asked:${seerr.id}`,
    seerr,
    async () =>
      askedByOf(
        parseRequests(
          await getJson(services, seerr, 'Seerr', '/api/v1/request', {
            filter: 'available',
            sort: 'modified',
            take: '50',
          }),
          now,
        ).items,
      ),
    ASKED_KEEP_MS,
  );
}

/* Watch history (Trend and People) ----------------------------------------------------------------------------------- */

/** One play in Plex's history: when, by whom, on what. */
export interface PlexPlay {
  at: Date;
  who: string | null;
  device: string | null;
}

/** Names by id from `/accounts` (`Account`) or `/devices` (`Device`). */
export function namesById(body: unknown, key: 'Account' | 'Device'): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of list(mc(body)[key])) {
    const r = rec(raw);
    const id = str(r.id) ?? (num(r.id) !== null ? String(num(r.id)) : null);
    const name = str(r.name);
    if (id && name) out.set(id, name.slice(0, 60));
  }
  return out;
}

/** `/status/sessions/history/all`: each play with its person's and device's names. */
export function parseHistory(
  body: unknown,
  accounts: Map<string, string>,
  devices: Map<string, string>,
): PlexPlay[] {
  const id = (v: unknown) => str(v) ?? (num(v) !== null ? String(num(v)) : null);
  return list(mc(body).Metadata)
    .slice(0, HISTORY_MAX)
    .map((raw): PlexPlay | null => {
      const m = rec(raw);
      const at = dateOf(num(m.viewedAt));
      if (!at) return null;
      const who = id(m.accountID);
      const device = id(m.deviceID);
      return {
        at,
        who: who ? (accounts.get(who) ?? null) : null,
        device: device ? (devices.get(device) ?? null) : null,
      };
    })
    .filter((p): p is PlexPlay => p !== null);
}

async function readHistory(services: Services, row: CatalogConnectionRow): Promise<PlexPlay[]> {
  const now = services.clock();
  const get = (path: string, query?: Record<string, string>) => getJson(services, row, NAME, path, query);
  const [history, accounts, devices] = await Promise.all([
    get('/status/sessions/history/all', {
      sort: 'viewedAt:desc',
      'viewedAt>': String(Math.floor((now.getTime() - HISTORY_DAYS * DAY) / 1000)),
      'X-Plex-Container-Start': '0',
      'X-Plex-Container-Size': String(HISTORY_MAX),
    }),
    optional(get('/accounts')),
    optional(get('/devices')),
  ]);
  return parseHistory(history, namesById(accounts, 'Account'), namesById(devices, 'Device'));
}

/**
 * This week's plays (Trend): a bar per day of the last 7, today last, with the plays this week and the change on the
 * week before; and who watched (People): plays per person with the device they used most. Pure.
 */
export function plexWeek(
  plays: readonly PlexPlay[],
  now: Date,
  timeZone: string,
): { trend: TrendPanel; people: PeoplePanel | null } {
  const days = lastDays(now, timeZone);
  const inWeek = new Set(days.keys);
  const weekStart = now.getTime() - 7 * DAY;
  const week = plays.filter((p) => inWeek.has(dayKey(p.at, timeZone)) && p.at.getTime() <= now.getTime());
  const before = plays.filter(
    (p) =>
      p.at.getTime() < weekStart &&
      p.at.getTime() >= weekStart - 7 * DAY &&
      !inWeek.has(dayKey(p.at, timeZone)),
  ).length;
  const total = week.length;
  const byWho = new Map<string, { n: number; devices: Map<string, number> }>();
  for (const p of week) {
    if (!p.who) continue;
    const w = byWho.get(p.who) ?? { n: 0, devices: new Map() };
    w.n++;
    if (p.device) w.devices.set(p.device, (w.devices.get(p.device) ?? 0) + 1);
    byWho.set(p.who, w);
  }
  const ranked = [...byWho.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, 5);
  return {
    trend: trend({
      id: 'week',
      title: 'This week',
      meta: 'Plays per day',
      days,
      values: countByDay(
        week.map((p) => p.at),
        days.keys,
        timeZone,
      ),
      label: 'Plays',
      figure: { value: thousands(total), rest: total === 1 ? 'play this week' : 'plays this week' },
      change: weekChange(total, before),
    }),
    people: people({
      title: 'Who watches',
      meta: 'This week',
      unit: ['play'],
      items: ranked.map(([name, w]) => ({
        name,
        n: w.n,
        ...(() => {
          const device = [...w.devices.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
          return device ? { note: device } : {};
        })(),
      })),
    }),
  };
}

/* Since when it scans ------------------------------------------------------------------------------------------------- */

const scanSeen = new WeakMap<Services, Map<string, number>>();

/** When this server first saw each running activity (Plex doesn't say); forgotten once it ends. */
export function noteActivities(
  services: Services,
  rowId: string,
  activities: readonly PlexActivity[],
  now: Date,
): Map<string, Date> {
  let seen = scanSeen.get(services);
  if (!seen) {
    seen = new Map();
    scanSeen.set(services, seen);
  }
  const prefix = `${rowId}|`;
  const live = new Set(activities.map((a) => `${prefix}${a.id}`));
  for (const k of seen.keys()) if (k.startsWith(prefix) && !live.has(k)) seen.delete(k);
  const out = new Map<string, Date>();
  for (const a of activities) {
    const k = `${prefix}${a.id}`;
    const at = seen.get(k) ?? now.getTime();
    seen.set(k, at);
    out.set(a.id, new Date(at));
  }
  return out;
}

/* What it shows ------------------------------------------------------------------------------------------------------- */

export interface PlexInput {
  rest: PlexRest;
  live: PlexLive | null;
  readAt: Date;
  now: Date;
  timeZone: string;
  who: ButtonCtx;
  url: string;
  asked: AskedBy | null;
  /** Since when each running activity runs. */
  since: Map<string, Date>;
  /** `plex_streams` over the range. */
  streams: (number | null)[];
  /** A picture of a Plex thumb, or none (pure tests). */
  poster: (thumb: string | null, title: string) => GalleryItem['image'];
  /** The Plex settings tab (service-settings.md SST-07), when the page reads it. */
  settingsTab?: ThingPageTab;
  /** The last two weeks' plays, or null when the history couldn't be read. */
  history?: PlexPlay[] | null;
}

const sum = (libs: readonly PlexLibrary[], type: string, f: (l: PlexLibrary) => number | null) =>
  libs
    .filter((l) => l.type === type)
    .reduce<number | null>((a, l) => (f(l) === null ? a : (a ?? 0) + (f(l) as number)), null);

/** The figures (SD-20): Movies, Shows, Music, Watching now. */
export function plexKpis(input: PlexInput): ThingPageKpi[] {
  const libs = input.rest.libraries;
  const out: ThingPageKpi[] = [];
  const movies = sum(libs, 'movie', (l) => l.count);
  if (libs.some((l) => l.type === 'movie'))
    out.push({
      key: 'movies',
      label: 'Movies',
      value: movies !== null ? thousands(movies) : '—',
      sub: plural(libs.filter((l) => l.type === 'movie').length, 'library', 'libraries'),
    });
  const shows = sum(libs, 'show', (l) => l.count);
  const episodes = sum(libs, 'show', (l) => l.episodes);
  if (libs.some((l) => l.type === 'show'))
    out.push({
      key: 'shows',
      label: 'Shows',
      value: shows !== null ? thousands(shows) : '—',
      ...(episodes !== null ? { sub: `${thousands(episodes)} episodes` } : {}),
    });
  const artists = sum(libs, 'artist', (l) => l.count);
  if (libs.some((l) => l.type === 'artist'))
    out.push({
      key: 'music',
      label: 'Music',
      value: artists !== null ? thousands(artists) : '—',
      sub: 'artists',
    });
  if (input.live) {
    const n = input.live.sessions.length;
    const converting = input.live.sessions.filter((s) => s.converting).length;
    out.push({
      key: 'watching',
      label: 'Watching now',
      value: String(n),
      sub: n ? (converting ? `${converting} converting` : 'all direct') : 'Nobody',
      ...(drawable(input.streams) ? { spark: downsample(input.streams), color: 'violet' as const } : {}),
    });
  }
  return out;
}

/** A scan this long without ending is a problem, not a heads-up (QN-S3x). */
const SCAN_PROBLEM_MS = 6 * H;

/** Every check a Plex page can raise (QN-15). */
export const PLEX_CHECKS: readonly KindCheck[] = [
  {
    check: 'plex.remote',
    name: 'Reaching Plex from outside your network',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  {
    check: 'plex.converting',
    name: 'Many streams converting at once',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
  { check: 'plex.scan', name: 'Long library scans', nature: 'fyi', perItem: true, startsOn: false },
  {
    check: 'plex.unmatched',
    name: 'Items Plex couldn’t match',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
  { check: 'plex.updates', name: 'Plex updates', nature: 'fyi', perItem: false, startsOn: false },
];

/** What this read couldn't see (QN-11): what plays and runs now, a library's unmatched count, the updater. */
export function plexSkipped(rest: PlexRest, live: PlexLive | null): string[] {
  const out: string[] = [];
  if (!live) out.push('plex.converting', 'plex.scan');
  else if (live.unread?.includes('activities')) out.push('plex.scan');
  if (rest.libraries.some((l) => (l.type === 'movie' || l.type === 'show') && l.unmatched === null))
    out.push('plex.unmatched');
  if (rest.unread?.includes('updater')) out.push('plex.updates');
  return out;
}

/** Worth a look (SD-20), worst first. */
export function plexNotices(input: PlexInput): KindNotice[] {
  const { rest, live, now } = input;
  const out: KindNotice[] = [];
  const converting = live?.sessions.filter((s) => s.converting).length ?? 0;
  if (rest.signedIn && (rest.mapping === 'failed' || rest.mappingError))
    out.push({
      id: 'remote',
      tone: 'warn',
      icon: 'network',
      title: 'Plex can’t be reached from outside your network',
      detail: clip(
        rest.mappingError ? `Plex says: ${rest.mappingError}.` : 'Remote access isn’t working.',
        200,
      ),
      link: { kind: 'url', label: 'Open Plex', url: `${input.url}/web/index.html#!/settings/server` },
      nature: 'problem',
      check: 'plex.remote',
      // Plex tests its mapping again when the public address changes, and fails for a moment (QN-04).
      confirm: 2,
      ignore: { lifts: 'fixed', words: 'Until it’s reachable again.' },
      badge: 'No remote access',
    });
  // Converting is load on a busy evening, not something to do (QN-04).
  if (converting > 2)
    out.push({
      id: 'converting',
      tone: 'info',
      icon: 'media',
      title: `${converting} streams are converting at once`,
      detail: 'Converting works the server hard. Players that play the file directly need none.',
      nature: 'fyi',
      check: 'plex.converting',
      ignore: { lifts: 'fixed', words: 'Until fewer streams convert.' },
    });
  const scans = new Map<string, KindNotice>();
  for (const a of live?.activities ?? []) {
    const since = input.since.get(a.id);
    if (!since || !/scan|refresh/i.test(a.title)) continue;
    const ms = now.getTime() - since.getTime();
    if (ms < H) continue;
    const lib = rest.libraries.find((l) => l.key === a.sectionKey);
    const subject = lib
      ? { id: `library:${lib.key}`, name: clip(lib.title, 80) }
      : { id: `activity:${a.id}`.slice(0, 160), name: clip(a.title, 80) };
    if (scans.has(subject.id)) continue;
    const long = ms >= SCAN_PROBLEM_MS;
    scans.set(subject.id, {
      id: idOf('scan', a.id).slice(0, 120),
      tone: long ? 'warn' : 'info',
      icon: 'clock',
      title: clip(`${a.title} for over ${span(ms)}`, 120),
      ...(a.progress !== null ? { detail: `${share(a.progress)} done.` } : {}),
      ...(long
        ? {
            link: {
              kind: 'ask' as const,
              label: 'Look into it',
              question: clip(`Why has Plex been busy with “${a.title}” for ${span(ms)}?`, 300),
            },
          }
        : {}),
      nature: long ? 'problem' : 'fyi',
      check: 'plex.scan',
      subject,
      // One run is one episode: the next scan of that library is news again.
      episode: a.id.slice(0, 80),
      ignore: { lifts: 'newer', words: 'Until the scan ends.' },
      badge: badgeOf(`Scanning for ${span(ms)}`),
    });
  }
  out.push(...scans.values());
  out.push(
    ...itemLines(
      rest.libraries
        .filter((l) => (l.unmatched ?? 0) > 0)
        .map(
          (l): KindNotice => ({
            id: idOf('unmatched', l.key).slice(0, 120),
            tone: 'info',
            icon: 'media',
            title: clip(
              l.unmatched === 1
                ? `Plex couldn’t match an item in ${l.title}`
                : `Plex couldn’t match ${thousands(l.unmatched as number)} items in ${l.title}`,
              120,
            ),
            detail: 'They show without a poster or details until they’re matched.',
            nature: 'fyi',
            check: 'plex.unmatched',
            subject: { id: `library:${l.key}`, name: clip(l.title, 80) },
            // More unmatched is news; fewer isn't (QN-11: a higher band ends an Ignore).
            band: l.unmatched as number,
            ignore: { lifts: 'fixed', words: 'Until more go unmatched.' },
          }),
        ),
      (more) => ({
        id: 'unmatched-more',
        title: `Plex couldn’t match items in ${plural(more.length, 'more library', 'more libraries')}`,
      }),
    ),
  );
  if (rest.update)
    out.push({
      id: 'update',
      tone: 'info',
      icon: 'update',
      title: 'Plex has an update',
      detail: `Version ${rest.update.version}. Install it from Plex’s own settings when nobody is watching.`,
      nature: 'fyi',
      check: 'plex.updates',
      episode: rest.update.version.slice(0, 80),
      ignore: { lifts: 'newer', words: 'Until a newer version is out.' },
    });
  return uniqueById(out);
}

/** A gallery item of a library item (Recently added, Now playing). */
function itemCard(input: PlexInput, item: PlexItem): Pick<GalleryItem, 'id' | 'title' | 'image'> {
  const image = input.poster(item.thumb, item.title);
  return { id: item.ratingKey.slice(0, 200), title: item.title, ...(image ? { image } : {}) };
}

/** Now playing's questions for the assistant (service-settings.md SST-08): why one converts, who watched most. */
export function playingQuestions(sessions: readonly PlexSession[]): string[] {
  const converting = sessions.find((s) => s.converting);
  const out: string[] = [];
  if (converting)
    out.push(
      clip(
        `Why is ${converting.item.title} converting${converting.device ? ` on ${converting.device}` : ''}?`,
        200,
      ),
    );
  out.push('Who watched the most this week?', 'What did people watch today?');
  return out.slice(0, 3);
}

/** Libraries' questions (SST-08). */
export function libraryQuestions(libraries: readonly PlexLibrary[]): string[] {
  const out: string[] = [];
  if (libraries.some((l) => (l.unmatched ?? 0) > 0)) out.push('Why couldn’t Plex match some items?');
  out.push('What was added this week?', 'Which films take the most space?');
  return out.slice(0, 3);
}

/**
 * The sentence under the name while Plex is fine (SST-10): who watches, then whether a library is being scanned —
 * “Plex is fine: 2 people are watching and every library is up to date.”
 */
export function plexVerdict(rest: PlexRest, live: PlexLive | null): string {
  const parts: string[] = [];
  if (live) {
    const people = new Set(live.sessions.map((s) => s.user ?? s.id)).size;
    parts.push(
      people === 0
        ? 'nobody is watching'
        : people === 1
          ? '1 person is watching'
          : `${people} people are watching`,
    );
  }
  const scanning = rest.libraries.find(
    (l) =>
      l.refreshing || live?.activities.some((a) => a.sectionKey === l.key && /scan|refresh/i.test(a.title)),
  );
  if (scanning) parts.push(`${scanning.title} is being scanned`);
  else if (rest.libraries.length) parts.push('every library is up to date');
  return clip(parts.length ? `Plex is fine: ${parts.join(' and ')}.` : 'Plex is fine.', 200);
}

/** “1:10:12”, “38:12”: where a stream is, as a player shows it. */
export function playClock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** “17 min”, “1 h 36 min”: what is left of a stream, finer than `span`. */
export function leftWords(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** A stream's second line: “Season 2 · Episode 5”, “Film · 2024 · 4K”, “Song · Daft Punk”. */
function streamSub(s: PlexSession): string {
  const i = s.item;
  if (i.type === 'episode')
    return i.season != null && i.episode != null
      ? `Season ${i.season} · Episode ${i.episode}`
      : (i.part ?? 'Episode');
  if (i.type === 'track') return ['Song', i.artist].filter(Boolean).join(' · ');
  return [i.type === 'movie' ? 'Film' : null, i.year ? String(i.year) : null, s.quality ?? null]
    .filter(Boolean)
    .join(' · ');
}

/** “52 Mb/s” from kilobits a second. */
const mbps = (kbps: number) => `${figure(Math.round(kbps / 100) / 10)} Mb/s`;

/** Now playing (Live): a row per stream with who watches where, played directly or converted, and how far. */
function nowPlaying(input: PlexInput) {
  const sessions = input.live?.sessions ?? [];
  const kbps = sessions.reduce((a, s) => a + (s.bandwidthKbps ?? 0), 0);
  return liveRows({
    id: 'playing',
    title: 'Now playing',
    ...(sessions.length
      ? {
          meta: [plural(sessions.length, 'stream'), kbps ? `${mbps(kbps)} out` : null]
            .filter(Boolean)
            .join(' · '),
        }
      : {}),
    ...(sessions.length ? { ask: { questions: playingQuestions(sessions) } } : {}),
    items: sessions.map((s): GalleryItem => {
      const paused = s.state === 'paused';
      const at =
        s.offsetMs != null && s.durationMs ? `${playClock(s.offsetMs)} of ${playClock(s.durationMs)}` : null;
      return {
        ...itemCard(input, s.item),
        id: s.id,
        sub: clip(streamSub(s) || 'Playing', 120),
        ...(s.user ? { person: { name: s.user, ...(s.device ? { note: s.device } : {}) } } : {}),
        badge: paused
          ? { text: 'Paused', tone: 'warn' }
          : s.converting
            ? { text: 'Converting', tone: 'warn' }
            : { text: 'Direct play', tone: 'ok' },
        ...(s.progress !== null ? { progress: s.progress } : {}),
        ...(paused ? { paused: true } : {}),
        ...(at ? { note: at } : {}),
        ...(paused ? { noteEnd: 'Paused' } : s.leftMs ? { noteEnd: `${leftWords(s.leftMs)} left` } : {}),
      };
    }),
    empty: input.live ? 'Nobody is watching right now.' : 'Whombat can’t see what plays just now.',
  });
}

const LIBRARY_ICONS: Record<string, ThingPageItem['icon']> = {
  movie: 'film',
  show: 'tv',
  artist: 'music',
  photo: 'photo',
};

/** Libraries (Inventory): each one's count with what came in this week, how its scan stands, and Scan. */
function libraries(input: PlexInput) {
  const { rest, live, now, timeZone, who } = input;
  const scans = new Map(
    (live?.activities ?? []).filter((a) => a.sectionKey).map((a) => [a.sectionKey as string, a]),
  );
  const busy = rest.libraries.some((l) => l.refreshing || scans.has(l.key));
  return inventory({
    id: 'libraries',
    title: 'Libraries',
    meta: plural(rest.libraries.length, 'library', 'libraries'),
    ask: { questions: libraryQuestions(rest.libraries) },
    ...(rest.libraries.length > 1 && !busy
      ? { buttons: [button(who, { action: 'scan', target: 'all', label: 'Scan all', icon: 'search' })] }
      : {}),
    items: rest.libraries.map((l): ThingPageItem => {
      const scan = scans.get(l.key);
      const scanning = !!scan || l.refreshing;
      const scanned = l.scannedAt
        ? `Scanned ${when(l.scannedAt, now, timeZone).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase())}`
        : 'Never scanned';
      const state = scanning
        ? scan?.progress != null
          ? `Scanning · ${share(scan.progress)}`
          : 'Scanning'
        : l.unmatched
          ? `${thousands(l.unmatched)} not matched`
          : scanned;
      const detail =
        l.type === 'show' && l.episodes !== null ? `${thousands(l.episodes)} episodes · ${state}` : state;
      const count = l.count === null ? '—' : thousands(l.count);
      const added = addedNote(
        l.added,
        l.type === 'show' ? ['episode', 'episodes'] : l.type === 'artist' ? ['album', 'albums'] : undefined,
      );
      const icon = LIBRARY_ICONS[l.type];
      return countLine({
        id: idOf('library', l.key),
        title: l.title,
        ...(icon ? { icon } : {}),
        detail,
        ...(l.unmatched && !scanning ? { tone: 'warn' as const } : {}),
        value: count,
        ...(added ?? {}),
        ...(scanning
          ? {}
          : {
              actions: [
                button(who, {
                  action: 'scan',
                  target: l.key,
                  label: clip(`Scan ${l.title}`, 30),
                  icon: 'search',
                }),
              ],
            }),
      });
    }),
    empty: 'No libraries yet.',
  });
}

/** Recently added (Shelf): one row of posters, with who asked for each in Seerr. */
function recentlyAdded(input: PlexInput) {
  const { rest, now, timeZone } = input;
  const added = rest.libraries.reduce<number | null>(
    (a, l) => (l.added == null ? a : (a ?? 0) + l.added),
    null,
  );
  return shelf({
    id: 'recent',
    title: 'Recently added',
    ...(added ? { meta: `${thousands(added)} this week` } : {}),
    link: { kind: 'url', label: 'See all in Plex', url: `${input.url}/web/index.html` },
    items: rest.recent.map((item): GalleryItem => {
      const asked = whoAsked(input.asked, item);
      const what = item.type === 'movie' ? 'Film' : (item.part ?? (item.type === 'show' ? 'Show' : null));
      return {
        ...itemCard(input, item),
        ...(what || item.year
          ? {
              sub: clip(
                [what, item.year && item.type === 'movie' ? String(item.year) : null]
                  .filter(Boolean)
                  .join(' · '),
                120,
              ),
            }
          : {}),
        ...askedBy(asked),
        ...(item.addedAt ? { at: item.addedAt.toISOString(), note: when(item.addedAt, now, timeZone) } : {}),
      };
    }),
    empty: 'Nothing added lately.',
  });
}

/**
 * The Summary in slots (docs/decisions/service-slots.md): Now playing beside Libraries, Recently added across, then
 * this week's plays and who watched; the page adds the machine after them.
 */
export function plexSlots(input: PlexInput): Pick<KindView, 'panels' | 'slots'> {
  const week = input.history ? plexWeek(input.history, input.now, input.timeZone) : null;
  return slotPanels({
    live: nowPlaying(input),
    inventory: libraries(input),
    shelf: recentlyAdded(input),
    trend: week?.trend,
    people: week?.people,
    machine: plexMachineLines(input.rest),
  });
}

/** Plex's own line in “The machine”: its version, and whether a newer one is out. */
export function plexMachineLines(rest: PlexRest): ThingPageBar[] {
  if (!rest.version) return [];
  const version = rest.version.replace(/-.*$/, '');
  return [
    {
      id: 'plex-version',
      label: 'Plex',
      value: clip(version, 40),
      pct: null,
      ...(rest.update
        ? { sub: clip(`Version ${rest.update.version} is out`, 120) }
        : rest.unread?.includes('updater')
          ? {}
          : { sub: 'Up to date', subTone: 'ok' as const }),
    },
  ];
}

/** The head's button (SD-20): Check for updates, which only checks. */
export function plexButtons(who: ButtonCtx): ThingPageButton[] {
  return [button(who, { action: 'check_updates', label: 'Check for updates', icon: 'check' })];
}

/** The page's Plex part (SD-20); pure apart from the pictures. */
export function plexView(input: PlexInput): KindView {
  const { rest, live } = input;
  const facts: ThingLine[] = [];
  if (rest.version) facts.push(line(`Plex **${rest.version.replace(/-.*$/, '')}**`));
  if (rest.libraries.length) facts.push(line(`**${plural(rest.libraries.length, 'library', 'libraries')}**`));
  const playing = !!live?.sessions.some((s) => s.state === 'playing' || s.state === 'buffering');
  const notices = plexNotices(input);
  return {
    // In slots its counts are in Libraries and Now playing; the card keeps the figures (`plexSeen`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: asNotices(notices),
    ...statusFrom(live?.sessions.length ? `${plural(live.sessions.length, 'stream')} playing` : null),
    ...plexSlots(input),
    tabs: input.settingsTab ? [input.settingsTab] : [],
    facts,
    open: { label: 'Open Plex', url: `${input.url}/web/index.html` },
    actions: [],
    buttons: plexButtons(input.who),
    readAt: input.readAt,
    ...(playing ? { refreshS: 5 } : {}),
    suggestions: ['Most watched this month', 'Who watches most', 'Biggest movies'],
    verdict: plexVerdict(rest, live),
  };
}

/* The page ---------------------------------------------------------------------------------------------------------- */

export function plexUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (str(row.fields.url) ?? row.baseUrl).replace(/\/+$/, '');
}

/** A thumb as a picture: through Plex's transcoder (240 × 360) when the catalog lets it through, else as it is. */
export function thumbPath(thumb: string, transcoder: boolean): string {
  return transcoder
    ? `/photo/:/transcode?${new URLSearchParams({ url: thumb, width: '240', height: '360', minSize: '1', upscale: '1' }).toString()}`
    : thumb;
}

async function streamsLine(
  services: Services,
  rowId: string,
  range: PageRange,
  now: Date,
): Promise<(number | null)[]> {
  const points = await readPoints(services.db, rowId, [PLEX_STREAMS_KEY], now, RANGE_MS[range]).catch(
    () => new Map<string, RawPoint[]>(),
  );
  return onRange([points.get(PLEX_STREAMS_KEY) ?? []], range, now).values[0] ?? [];
}

export async function plexPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = plexUrl(row);
  const [rest, live, seerr, streams] = await Promise.all([
    latestRead(
      services,
      restKey(row),
      row,
      deadline(() => readRest(services, row, services.clock())),
    ),
    liveRead(
      services,
      liveKey(row),
      row,
      deadline(() => readLive(services, row)),
      { liveS: PLEX_LIVE_S },
    ),
    siblingRow(ctx, ['overseerr']).catch(() => null),
    streamsLine(services, row.id, ctx.range, now),
  ]);
  if (!rest.ok)
    return {
      charts: [],
      machine: 'after',
      notices: [],
      panels: [],
      tabs: [],
      facts: [],
      open: { label: 'Open Plex', url: `${url}/web/index.html` },
      actions: [],
      readAt: null,
      suggestions: [],
      problem: problemOf(rest.error, NAME).message,
      refreshing: rest.refreshing,
    };
  const [asked, settingsTab, history] = await Promise.all([
    seerr ? readAsked(services, seerr.row, now).catch(() => null) : null,
    plexSettingsTab(ctx, url),
    cachedRead(
      services,
      `plex-history:${row.id}`,
      row,
      deadline(() => readHistory(services, row)),
      HISTORY_KEEP_MS,
    ).catch(() => null),
  ]);
  const transcoder = prefixAllows(ctx, '/photo/:/transcode');
  const view = plexView({
    rest: rest.value,
    live: live.ok ? live.value : null,
    readAt: rest.at,
    now,
    timeZone: ctx.timeZone,
    who: { row },
    url,
    asked,
    since: live.ok ? noteActivities(services, row.id, live.value.activities, now) : new Map(),
    streams,
    poster: (thumb, title) => (thumb ? picture(ctx, thumbPath(thumb, transcoder), title) : undefined),
    settingsTab,
    history,
  });
  return {
    ...view,
    ...(live.ok ? {} : { problem: problemOf(live.error, NAME).message }),
    refreshing: rest.refreshing || live.refreshing,
  };
}

/** Plex's prefs are kept a minute; a change forgets them (SST-02). */
const PREFS_KEEP_MS = 60_000;

/** The Plex settings tab (SST-06, SST-07): its cards, or why it couldn't be read with Open Plex. */
export async function plexSettingsTab(ctx: KindCtx, url: string): Promise<ThingPageTab> {
  const { services, row, now } = ctx;
  const [prefs, changed, agent] = await Promise.all([
    cachedRead<PlexPrefs>(
      services,
      `plex-prefs:${row.id}`,
      row,
      deadline(() => PLEX_SETTINGS.read(services, row)),
      PREFS_KEEP_MS,
    ).catch(() => null),
    settingChanges(services, ctx.burrowId, row.id, now).catch(() => new Map()),
    loadAgentRow(services.db, ctx.burrowId).catch(() => undefined),
  ]);
  const tab = { key: 'service-settings', label: 'Plex settings' };
  if (!prefs)
    return {
      ...tab,
      panels: [
        {
          kind: 'text',
          id: 'settings-unread',
          title: 'Plex settings',
          body: 'Whombat couldn’t read Plex’s settings just now. Try again in a moment, or change them in Plex.',
          link: { kind: 'url', label: 'Open Plex', url: `${url}/web/index.html#!/settings/server` },
        },
      ],
    };
  return {
    ...tab,
    panels: settingsPanels({
      declared: PLEX_SETTINGS,
      settings: prefs,
      who: { row },
      url: `${url}/web/index.html#!/settings/server`,
      changed,
      assistant: assistantCalled(agent?.name),
      now,
      timeZone: ctx.timeZone,
    }),
  };
}

/**
 * Who's watching, for the desk's calm glance (desk-display-server.md DK-S141): how many, and the titles playing; going
 * on while anyone watches. Nothing when the live part couldn't be read.
 */
export function plexActivity(live: PlexLive | null): ConnectionActivity | undefined {
  if (!live) return undefined;
  if (live.sessions.length === 0) return { active: false, value: 'Nobody watching' };
  const titles = [...new Set(live.sessions.map((s) => s.item.title))];
  return { active: true, value: `${live.sessions.length} watching`, detail: clip(titles.join(', '), 120) };
}

/** The card (SD-05, SD-S06): Movies, Shows, Watching now; `plex_streams`. */
export async function plexSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const { rest, live } = await plexSnapshot(services, row);
  const input: PlexInput = {
    rest,
    live,
    readAt: now,
    now,
    timeZone,
    who: { row },
    url: plexUrl(row),
    asked: null,
    since: live ? noteActivities(services, row.id, live.activities, now) : new Map(),
    streams: [],
    poster: () => undefined,
  };
  const kpis = plexKpis(input).filter((k) => k.key !== 'music');
  const notices = plexNotices(input);
  const activity = plexActivity(live);
  return {
    glance: {
      ...seenFromView(
        { kpis, notices: asNotices(notices) },
        {
          line: live?.sessions.length
            ? `${live.sessions.length} watching`
            : plural(rest.libraries.length, 'library', 'libraries'),
        },
      ),
      ...(activity ? { activity } : {}),
    },
    points: live ? { [PLEX_STREAMS_KEY]: live.sessions.length } : {},
    ...linesSeen({ notices }, plexSkipped(rest, live)),
  };
}

/* Buttons (SD-07) ------------------------------------------------------------------------------------------------------ */

const scan: KindAction = async (ctx, input) => {
  const key = input.target;
  if (key === 'all') {
    await actAs(ctx.services, ctx.row, NAME, { method: 'POST', path: '/library/sections/all/refresh' });
    return { message: 'Plex is scanning every library.', title: 'Scanned every library in Plex' };
  }
  if (!key || !/^\d{1,9}$/.test(key)) throw badRequest('Which library should Plex scan?');
  const sections = parseSections(
    await getJson(ctx.services, ctx.row, NAME, '/library/sections').catch((err) => {
      throw new ApiError('unavailable', problemOf(err, NAME).message);
    }),
  );
  const lib = sections.find((l) => l.key === key);
  if (!lib) throw conflict('Plex doesn’t have that library any more.');
  await actAs(ctx.services, ctx.row, NAME, { method: 'POST', path: `/library/sections/${key}/refresh` });
  return { message: `Plex is scanning ${lib.title}.`, title: `Scanned ${lib.title} in Plex` };
};

const checkUpdates: KindAction = async (ctx) => {
  await actAs(ctx.services, ctx.row, NAME, { method: 'PUT', path: '/updater/check' });
  return {
    message: 'Plex is checking for updates. If one is out, it shows here in a moment.',
    title: 'Checked Plex for updates',
    everyday: true,
  };
};

export const PLEX_ACTIONS: Record<string, KindAction> = {
  scan,
  check_updates: checkUpdates,
  [SETTING_ACTION]: settingAction(PLEX_SETTINGS),
};

export const PLEX_KIND: KindModule = {
  activityLine: 'Who’s watching',
  page: plexPage,
  prefetch: (services, row) => plexSnapshot(services, row),
  seen: plexSeen,
  asksFirst: 'deleting media and settings ask first',
  actions: PLEX_ACTIONS,
  describe: (ctx, action, input) =>
    action === SETTING_ACTION ? describeSetting(PLEX_SETTINGS, ctx, input) : Promise.resolve(null),
  liveS: PLEX_LIVE_S,
  checks: PLEX_CHECKS,
};
