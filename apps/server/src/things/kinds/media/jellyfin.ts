/**
 * Jellyfin's page and card: how big the libraries are, who watches what now (direct or converting), what was added
 * lately with who asked for it in Seerr, each library's count and scan state with a Scan button, this week's plays and
 * who watches, and Jellyfin's own problems (failed tasks, pending restart, long scans, many conversions). Read with
 * the connection's API key (`/System/Info`, `/Library/VirtualFolders`, `/Items/Counts`, `/Items`, `/ScheduledTasks`,
 * `/System/ActivityLog/Entries`, `/Users`; live: `/Sessions`). Buttons: Scan a library or Scan all. Never restarts,
 * deletes media or stops someone's stream.
 */
import type { ThingLine, ThingPageBar, ThingPageItem, ThingPageKpi } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { ConnectionActivity } from '../../../home/types';
import { ApiError, badRequest, conflict } from '../../../lib/errors';
import type { Services } from '../../../services';
import { readPoints } from '../../points';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { downsample, drawable, onRange, type PageRange, RANGE_MS, type RawPoint } from '../../series';
import { clip, figure, line, list, num, plural, rec, span, str, thousands, when } from '../../words';
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
import {
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
  share,
  siblingRow,
  statusFrom,
  uniqueById,
} from './common';
import { type AskedBy, askedByOf, leftWords, playClock } from './plex';
import { parseRequests } from './seerr';
import { asNotices, type ButtonCtx, button, type GalleryItem } from './ui';

const NAME = 'Jellyfin';
export const JELLYFIN_STREAMS_KEY = 'jellyfin_streams';
/** Live refresh interval for what plays now while the page is open. */
export const JELLYFIN_LIVE_S = 4;
const COUNTS_KEEP_MS = 5 * 60_000;
const ASKED_KEEP_MS = 5 * 60_000;
const HISTORY_KEEP_MS = 10 * 60_000;
const HISTORY_DAYS = 14;
const RECENT_MAX = 12;
const TICKS_PER_MS = 10_000;
const H = 3600_000;
const DAY = 24 * H;
const SCAN_PROBLEM_MS = 6 * H;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface JellyfinLibrary {
  id: string;
  name: string;
  type: 'movies' | 'tvshows' | 'music' | 'homevideos' | string;
  refreshing: boolean;
  progress: number | null;
  count: number | null;
  episodes: number | null;
}

export interface JellyfinItem {
  id: string;
  type: string;
  title: string;
  part: string | null;
  year: number | null;
  imageId: string | null;
  addedAt: Date | null;
  tmdbId: number | null;
  season: number | null;
  episode: number | null;
  artist: string | null;
}

export interface JellyfinSession {
  id: string;
  item: JellyfinItem;
  user: string | null;
  device: string | null;
  paused: boolean;
  converting: boolean;
  progress: number | null;
  offsetMs: number | null;
  durationMs: number | null;
  leftMs: number | null;
  bitrateKbps: number | null;
  quality: string | null;
}

export interface JellyfinTask {
  id: string;
  name: string;
  key: string | null;
  running: boolean;
  progress: number | null;
  lastStatus: string | null;
  lastEndedAt: Date | null;
  errorMessage: string | null;
}

export interface JellyfinLive {
  sessions: JellyfinSession[];
  tasks: JellyfinTask[];
  unread?: 'tasks'[];
}

export interface JellyfinRest {
  version: string | null;
  name: string | null;
  os: string | null;
  pendingRestart: boolean;
  libraries: JellyfinLibrary[];
  recent: JellyfinItem[];
  counts: {
    movies: number | null;
    shows: number | null;
    episodes: number | null;
    albums: number | null;
    songs: number | null;
  };
  lastScanAt: Date | null;
  failedTasks: JellyfinTask[];
  unread?: 'tasks'[];
}

export interface JellyfinPlay {
  at: Date;
  who: string | null;
  device: string | null;
}

function isoDate(raw: unknown): Date | null {
  const s = str(raw);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

function ticksToMs(raw: unknown): number | null {
  const n = num(raw);
  return n !== null && n >= 0 ? Math.round(n / TICKS_PER_MS) : null;
}

/** Video resolution from Jellyfin's MediaStreams video height: 4K, 1080p, 720p, SD. */
export function jellyfinQuality(rawStreams: unknown): string | null {
  const video = list(rawStreams)
    .map(rec)
    .find((s) => str(s.Type) === 'Video');
  const height = video ? num(video.Height) : null;
  if (!height || height <= 0) return null;
  if (height >= 2000) return '4K';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  return 'SD';
}

function tmdbFrom(rawProviders: unknown): number | null {
  const p = rec(rawProviders);
  const raw = str(p.Tmdb) ?? str(p.tmdb);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** One item from `/Items` or a session's `NowPlayingItem`. */
export function parseItem(raw: unknown): JellyfinItem | null {
  const m = rec(raw);
  const id = str(m.Id);
  if (!id) return null;
  const type = str(m.Type) ?? 'Movie';
  const episode = type === 'Episode';
  const audio = type === 'Audio';
  const title = (episode ? str(m.SeriesName) : null) ?? str(m.Name);
  if (!title) return null;
  const season = episode ? num(m.ParentIndexNumber) : null;
  const epNum = episode ? num(m.IndexNumber) : null;
  const seriesId = str(m.SeriesId);
  const tags = rec(m.ImageTags);
  const hasPrimary = str(tags.Primary) !== null;
  const hasSeriesPrimary = seriesId !== null && str(m.SeriesPrimaryImageTag) !== null;
  const imageId = episode ? (hasSeriesPrimary ? seriesId : hasPrimary ? id : null) : hasPrimary ? id : null;
  const artists = list(m.Artists)
    .map(str)
    .filter((x): x is string => x !== null);
  return {
    id,
    type,
    title: title.slice(0, 120),
    part: episode ? episodeCode(season, epNum) : null,
    year: num(m.ProductionYear),
    imageId,
    addedAt: isoDate(m.DateCreated),
    // Episodes carry their own TMDB episode id, not the show's; only movies and series carry the Seerr-matchable id.
    tmdbId: type === 'Movie' || type === 'Series' ? tmdbFrom(m.ProviderIds) : null,
    season,
    episode: epNum,
    artist: audio ? ((str(m.AlbumArtist) ?? artists[0] ?? null)?.slice(0, 80) ?? null) : null,
  };
}

/** `/Library/VirtualFolders`. */
export function parseLibraries(body: unknown): JellyfinLibrary[] {
  return list(body)
    .slice(0, 40)
    .map((raw): JellyfinLibrary | null => {
      const f = rec(raw);
      const id = str(f.ItemId);
      const name = str(f.Name);
      if (!id || !name) return null;
      const status = str(f.RefreshStatus);
      const prog = num(f.RefreshProgress);
      return {
        id,
        name: name.slice(0, 80),
        type: (str(f.CollectionType) ?? 'mixed').toLowerCase(),
        refreshing: status === 'Active' || status === 'Queued',
        progress: prog !== null && prog >= 0 ? Math.max(0, Math.min(1, prog / 100)) : null,
        count: null,
        episodes: null,
      };
    })
    .filter((l): l is JellyfinLibrary => l !== null);
}

/** `/ScheduledTasks`. */
export function parseTasks(body: unknown): JellyfinTask[] {
  return list(body)
    .slice(0, 60)
    .map((raw): JellyfinTask | null => {
      const t = rec(raw);
      const id = str(t.Id);
      const name = str(t.Name);
      if (!id || !name) return null;
      const state = str(t.State);
      const pct = num(t.CurrentProgressPercentage);
      const last = rec(t.LastExecutionResult);
      return {
        id,
        name: name.slice(0, 100),
        key: str(t.Key),
        running: state === 'Running',
        progress: pct !== null ? Math.max(0, Math.min(1, pct / 100)) : null,
        lastStatus: str(last.Status),
        lastEndedAt: isoDate(last.EndTimeUtc),
        errorMessage: str(last.ErrorMessage)?.slice(0, 200) ?? null,
      };
    })
    .filter((t): t is JellyfinTask => t !== null);
}

/** `/Sessions`: keeps only sessions with an active `NowPlayingItem`. */
export function parseSessions(body: unknown): JellyfinSession[] {
  return list(body)
    .slice(0, 60)
    .map((raw): JellyfinSession | null => {
      const s = rec(raw);
      if (!s.NowPlayingItem || typeof s.NowPlayingItem !== 'object') return null;
      const item = parseItem(s.NowPlayingItem);
      if (!item) return null;
      const play = rec(s.PlayState);
      const trans = rec(s.TranscodingInfo);
      const nowPlaying = rec(s.NowPlayingItem);
      const durationMs = ticksToMs(nowPlaying.RunTimeTicks);
      const offsetMs = ticksToMs(play.PositionTicks);
      const playMethod = str(play.PlayMethod);
      const videoConverting =
        playMethod === 'Transcode' && (trans.IsVideoDirect === false || trans.IsVideoDirect === undefined);
      const bitrate = num(trans.Bitrate);
      return {
        id: (str(s.Id) ?? item.id).slice(0, 200),
        item,
        user: str(s.UserName)?.slice(0, 60) ?? null,
        device: (str(s.DeviceName) ?? str(s.Client))?.slice(0, 60) ?? null,
        paused: play.IsPaused === true,
        converting: videoConverting,
        progress:
          durationMs && durationMs > 0 && offsetMs !== null
            ? Math.max(0, Math.min(1, offsetMs / durationMs))
            : null,
        offsetMs,
        durationMs,
        leftMs: durationMs && offsetMs !== null ? Math.max(0, durationMs - offsetMs) : null,
        bitrateKbps: bitrate !== null && bitrate > 0 ? Math.round(bitrate / 1000) : null,
        quality: jellyfinQuality(nowPlaying.MediaStreams),
      };
    })
    .filter((s): s is JellyfinSession => s !== null);
}

/** `/Users`: user id -> name. */
export function parseUsers(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of list(body)) {
    const u = rec(raw);
    const id = str(u.Id);
    const name = str(u.Name);
    if (id && name) out.set(id, name.slice(0, 60));
  }
  return out;
}

/** `/System/ActivityLog/Entries`: playback start entries for Trend and People. */
export function parseActivityPlays(body: unknown, users: Map<string, string>): JellyfinPlay[] {
  return list(rec(body).Items)
    .slice(0, 500)
    .map((raw): JellyfinPlay | null => {
      const a = rec(raw);
      const type = str(a.Type);
      if (type !== 'VideoPlayback' && type !== 'AudioPlayback') return null;
      const at = isoDate(a.Date);
      if (!at) return null;
      const userId = str(a.UserId);
      const text = str(a.Name) ?? '';
      const fromText = /^(.+?)\s+is playing\s+/i.exec(text)?.[1]?.trim() ?? null;
      const device = /\son\s+([^.]+?)\s*$/i.exec(text)?.[1]?.trim() ?? null;
      return {
        at,
        who: ((userId ? users.get(userId) : undefined) ?? fromText)?.slice(0, 60) ?? null,
        device: device?.slice(0, 60) ?? null,
      };
    })
    .filter((p): p is JellyfinPlay => p !== null);
}

const totalOf = (body: unknown) => num(rec(body).TotalRecordCount);

async function withCounts(
  services: Services,
  row: CatalogConnectionRow,
  lib: JellyfinLibrary,
): Promise<JellyfinLibrary> {
  const itemType =
    lib.type === 'movies'
      ? 'Movie'
      : lib.type === 'tvshows'
        ? 'Series'
        : lib.type === 'music'
          ? 'MusicAlbum'
          : null;
  if (!itemType) return lib;
  const counted = (key: string, includeTypes: string) =>
    optional(
      cachedRead(
        services,
        `jellyfin-count:${row.id}:${lib.id}:${key}`,
        row,
        async () =>
          totalOf(
            await getJson(services, row, NAME, '/Items', {
              ParentId: lib.id,
              Recursive: 'true',
              IncludeItemTypes: includeTypes,
              Limit: '0',
            }),
          ),
        COUNTS_KEEP_MS,
      ),
    );
  const [count, episodes] = await Promise.all([
    counted(itemType, itemType),
    lib.type === 'tvshows' ? counted('Episode', 'Episode') : Promise.resolve(null),
  ]);
  return { ...lib, count, episodes };
}

async function readRest(services: Services, row: CatalogConnectionRow): Promise<JellyfinRest> {
  const get = (path: string, query?: Record<string, string>) => getJson(services, row, NAME, path, query);
  const [infoRaw, foldersRaw, countsRaw, recentRaw, tasksRaw] = await Promise.all([
    get('/System/Info'),
    get('/Library/VirtualFolders'),
    optional(get('/Items/Counts')),
    optional(
      get('/Items', {
        SortBy: 'DateCreated',
        SortOrder: 'Descending',
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Episode',
        Limit: String(RECENT_MAX),
        Fields: 'DateCreated,ProviderIds',
      }),
    ),
    optional(get('/ScheduledTasks')),
  ]);
  const info = rec(infoRaw);
  const c = rec(countsRaw);
  const libraries = await Promise.all(
    parseLibraries(foldersRaw).map((lib) => withCounts(services, row, lib)),
  );
  const tasks = tasksRaw ? parseTasks(tasksRaw) : [];
  const scanTask = tasks.find((t) => t.key === 'RefreshLibrary');
  const failedTasks = tasks.filter((t) => t.lastStatus === 'Failed');
  return {
    version: str(info.Version),
    name: str(info.ServerName),
    os: str(info.OperatingSystemDisplayName) ?? str(info.OperatingSystem),
    pendingRestart: info.HasPendingRestart === true,
    libraries,
    recent: list(rec(recentRaw).Items)
      .map(parseItem)
      .filter((i): i is JellyfinItem => i !== null)
      .slice(0, RECENT_MAX),
    counts: {
      movies: num(c.MovieCount),
      shows: num(c.SeriesCount),
      episodes: num(c.EpisodeCount),
      albums: num(c.AlbumCount),
      songs: num(c.SongCount),
    },
    lastScanAt: scanTask?.lastEndedAt ?? null,
    failedTasks,
    ...(tasksRaw ? {} : { unread: ['tasks' as const] }),
  };
}

async function readLive(services: Services, row: CatalogConnectionRow): Promise<JellyfinLive> {
  const [sessionsRaw, tasksRaw] = await Promise.all([
    getJson(services, row, NAME, '/Sessions'),
    optional(getJson(services, row, NAME, '/ScheduledTasks')),
  ]);
  return {
    sessions: parseSessions(sessionsRaw),
    tasks: tasksRaw ? parseTasks(tasksRaw) : [],
    ...(tasksRaw ? {} : { unread: ['tasks' as const] }),
  };
}

async function readHistory(services: Services, row: CatalogConnectionRow): Promise<JellyfinPlay[]> {
  const minDate = new Date(services.clock().getTime() - HISTORY_DAYS * DAY).toISOString();
  const [activity, users] = await Promise.all([
    getJson(services, row, NAME, '/System/ActivityLog/Entries', { MinDate: minDate, Limit: '300' }),
    optional(getJson(services, row, NAME, '/Users')),
  ]);
  return parseActivityPlays(activity, parseUsers(users));
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

function deadline<T>(work: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await withDeadline(work(), KIND_DEADLINE_MS, 'Jellyfin didn’t answer in time.');
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

const restKey = (row: CatalogConnectionRow) => `jellyfin:${row.id}`;
const liveKey = (row: CatalogConnectionRow) => `jellyfin-live:${row.id}`;

export async function jellyfinSnapshot(services: Services, row: CatalogConnectionRow) {
  const [rest, live] = await Promise.all([
    cachedRead(
      services,
      restKey(row),
      row,
      deadline(() => readRest(services, row)),
    ),
    optional(
      cachedRead(
        services,
        liveKey(row),
        row,
        deadline(() => readLive(services, row)),
        JELLYFIN_LIVE_S * 1000,
      ),
    ),
  ]);
  return { rest, live };
}

/* Scan duration tracking --------------------------------------------------------------------------------------------- */

const scanSeen = new WeakMap<Services, Map<string, number>>();

/** Remembers when a running library scan was first observed so long scans can be reported. */
export function noteJellyfinScans(
  services: Services,
  rowId: string,
  tasks: readonly JellyfinTask[],
  now: Date,
): Map<string, Date> {
  let seen = scanSeen.get(services);
  if (!seen) {
    seen = new Map();
    scanSeen.set(services, seen);
  }
  const running = tasks.filter((t) => t.running && (t.key === 'RefreshLibrary' || /scan/i.test(t.name)));
  const prefix = `${rowId}|`;
  const live = new Set(running.map((t) => `${prefix}${t.id}`));
  for (const k of seen.keys()) if (k.startsWith(prefix) && !live.has(k)) seen.delete(k);
  const out = new Map<string, Date>();
  for (const t of running) {
    const k = `${prefix}${t.id}`;
    const at = seen.get(k) ?? now.getTime();
    seen.set(k, at);
    out.set(t.id, new Date(at));
  }
  return out;
}

/* Checks and notices ------------------------------------------------------------------------------------------------- */

export const JELLYFIN_CHECKS: readonly KindCheck[] = [
  {
    check: 'jellyfin.task_failed',
    name: 'Failed scheduled tasks',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'jellyfin.restart',
    name: 'Restart needed after changes',
    nature: 'you',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'jellyfin.converting',
    name: 'Many streams converting at once',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'jellyfin.scan',
    name: 'Long library scans',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
];

export function jellyfinSkipped(rest: JellyfinRest, live: JellyfinLive | null): string[] {
  const out: string[] = [];
  if (rest.unread?.includes('tasks')) out.push('jellyfin.task_failed');
  if (!live) out.push('jellyfin.converting', 'jellyfin.scan');
  else if (live.unread?.includes('tasks')) out.push('jellyfin.scan');
  return out;
}

export interface JellyfinInput {
  rest: JellyfinRest;
  live: JellyfinLive | null;
  readAt: Date;
  now: Date;
  timeZone: string;
  who: ButtonCtx;
  url: string;
  asked: AskedBy | null;
  since: Map<string, Date>;
  streams: (number | null)[];
  poster: (imageId: string | null, title: string) => GalleryItem['image'];
  history?: JellyfinPlay[] | null;
}

export function jellyfinNotices(input: JellyfinInput): KindNotice[] {
  const { rest, live, now } = input;
  const out: KindNotice[] = [];
  out.push(
    ...itemLines(
      rest.failedTasks.map(
        (t): KindNotice => ({
          id: idOf('task', t.id).slice(0, 120),
          tone: 'warn',
          icon: 'clock',
          title: clip(`${t.name} failed in Jellyfin`, 120),
          detail: clip(
            t.errorMessage
              ? `${t.errorMessage} Open Dashboard → Scheduled Tasks in Jellyfin to retry it.`
              : 'Open Dashboard → Scheduled Tasks in Jellyfin to see why and run it again.',
            200,
          ),
          link: { kind: 'url', label: 'Open Jellyfin', url: `${input.url}/web/index.html#!/dashboard/tasks` },
          nature: 'problem',
          check: 'jellyfin.task_failed',
          subject: { id: `task:${t.id}`, name: clip(t.name, 80) },
          ...(t.lastEndedAt ? { episode: t.lastEndedAt.toISOString() } : {}),
          ignore: { lifts: 'newer', words: 'Until it fails again.' },
        }),
      ),
      (more) => ({
        id: 'task-more',
        title: `${plural(more.length, 'more scheduled task')} failed in Jellyfin`,
      }),
    ),
  );
  if (rest.pendingRestart)
    out.push({
      id: 'restart',
      tone: 'info',
      icon: 'update',
      title: 'Jellyfin needs a restart to finish changes',
      detail: 'Restart Jellyfin from its Dashboard when nobody is watching.',
      link: { kind: 'url', label: 'Open Jellyfin', url: `${input.url}/web/index.html#!/dashboard` },
      nature: 'you',
      check: 'jellyfin.restart',
      ignore: { lifts: 'fixed', words: 'Until it’s restarted.' },
    });
  const converting = live?.sessions.filter((s) => s.converting).length ?? 0;
  if (converting > 2)
    out.push({
      id: 'converting',
      tone: 'info',
      icon: 'media',
      title: `${converting} streams are converting at once`,
      detail: 'Converting works the server hard. Players that play the file directly need none.',
      nature: 'fyi',
      check: 'jellyfin.converting',
      ignore: { lifts: 'fixed', words: 'Until fewer streams convert.' },
    });
  for (const t of live?.tasks ?? []) {
    if (!t.running) continue;
    const since = input.since.get(t.id);
    if (!since) continue;
    const ms = now.getTime() - since.getTime();
    if (ms < H) continue;
    const long = ms >= SCAN_PROBLEM_MS;
    out.push({
      id: idOf('scan', t.id).slice(0, 120),
      tone: long ? 'warn' : 'info',
      icon: 'clock',
      title: clip(`${t.name} has been running for over ${span(ms)}`, 120),
      ...(t.progress !== null ? { detail: `${share(t.progress)} done.` } : {}),
      ...(long
        ? {
            link: {
              kind: 'ask' as const,
              label: 'Look into it',
              question: clip(`Why has Jellyfin been busy with “${t.name}” for ${span(ms)}?`, 300),
            },
          }
        : {}),
      nature: long ? 'problem' : 'fyi',
      check: 'jellyfin.scan',
      subject: { id: `task:${t.id}`, name: clip(t.name, 80) },
      episode: since.toISOString(),
      ignore: { lifts: 'newer', words: 'Until the scan ends.' },
      badge: badgeOf(`Scanning for ${span(ms)}`),
    });
  }
  return uniqueById(out);
}

/* View --------------------------------------------------------------------------------------------------------------- */

function whoAsked(asked: AskedBy | null, item: JellyfinItem): string | null {
  if (!asked || item.tmdbId === null) return null;
  const type = item.type === 'Movie' ? 'movie' : 'tv';
  return asked.byTmdb.get(`${type}:${item.tmdbId}`) ?? null;
}

export function jellyfinWeek(
  plays: readonly JellyfinPlay[],
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

function streamSub(s: JellyfinSession): string {
  const i = s.item;
  if (i.type === 'Episode')
    return i.season != null && i.episode != null
      ? `Season ${i.season} · Episode ${i.episode}`
      : (i.part ?? 'Episode');
  if (i.type === 'Audio') return ['Song', i.artist].filter(Boolean).join(' · ');
  return [i.type === 'Movie' ? 'Film' : null, i.year ? String(i.year) : null, s.quality ?? null]
    .filter(Boolean)
    .join(' · ');
}

const mbps = (kbps: number) => `${figure(Math.round(kbps / 100) / 10)} Mb/s`;

function playingQuestions(sessions: readonly JellyfinSession[]): string[] {
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

function nowPlaying(input: JellyfinInput) {
  const sessions = input.live?.sessions ?? [];
  const kbps = sessions.reduce((a, s) => a + (s.bitrateKbps ?? 0), 0);
  return liveRows({
    id: 'playing',
    title: 'Now playing',
    ...(sessions.length
      ? {
          meta: [plural(sessions.length, 'stream'), kbps ? `${mbps(kbps)} out` : null]
            .filter(Boolean)
            .join(' · '),
          ask: { questions: playingQuestions(sessions) },
        }
      : {}),
    items: sessions.map((s): GalleryItem => {
      const image = input.poster(s.item.imageId, s.item.title);
      const at =
        s.offsetMs != null && s.durationMs ? `${playClock(s.offsetMs)} of ${playClock(s.durationMs)}` : null;
      return {
        id: s.id,
        title: s.item.title,
        ...(image ? { image } : {}),
        sub: clip(streamSub(s) || 'Playing', 120),
        ...(s.user ? { person: { name: s.user, ...(s.device ? { note: s.device } : {}) } } : {}),
        badge: s.paused
          ? { text: 'Paused', tone: 'warn' }
          : s.converting
            ? { text: 'Converting', tone: 'warn' }
            : { text: 'Direct play', tone: 'ok' },
        ...(s.progress !== null ? { progress: s.progress } : {}),
        ...(s.paused ? { paused: true } : {}),
        ...(at ? { note: at } : {}),
        ...(s.paused ? { noteEnd: 'Paused' } : s.leftMs ? { noteEnd: `${leftWords(s.leftMs)} left` } : {}),
      };
    }),
    empty: input.live ? 'Nobody is watching right now.' : 'Whombat can’t see what plays just now.',
  });
}

const LIBRARY_ICONS: Record<string, ThingPageItem['icon']> = {
  movies: 'film',
  tvshows: 'tv',
  music: 'music',
  homevideos: 'photo',
};

function librariesPanel(input: JellyfinInput) {
  const { rest, live, now, timeZone, who } = input;
  const globalScan = live?.tasks.find((t) => t.key === 'RefreshLibrary' && t.running) ?? null;
  const busy = !!globalScan || rest.libraries.some((l) => l.refreshing);
  const singleType = (type: string) => rest.libraries.filter((l) => l.type === type).length === 1;
  return inventory({
    id: 'libraries',
    title: 'Libraries',
    meta: plural(rest.libraries.length, 'library', 'libraries'),
    ask: { questions: ['What was added this week?', 'Which films take the most space?'] },
    ...(rest.libraries.length > 0 && !busy
      ? { buttons: [button(who, { action: 'scan', target: 'all', label: 'Scan all', icon: 'search' })] }
      : {}),
    items: rest.libraries.map((l): ThingPageItem => {
      const scanning = l.refreshing || !!globalScan;
      const pct = l.progress ?? globalScan?.progress ?? null;
      const scanned = rest.lastScanAt
        ? `Scanned ${when(rest.lastScanAt, now, timeZone).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase())}`
        : 'Ready';
      const state = scanning ? (pct !== null ? `Scanning · ${share(pct)}` : 'Scanning') : scanned;
      const count =
        l.count ??
        (l.type === 'movies' && singleType('movies')
          ? rest.counts.movies
          : l.type === 'tvshows' && singleType('tvshows')
            ? rest.counts.shows
            : l.type === 'music' && singleType('music')
              ? rest.counts.albums
              : null);
      const episodes =
        l.episodes ?? (l.type === 'tvshows' && singleType('tvshows') ? rest.counts.episodes : null);
      const detail =
        l.type === 'tvshows' && episodes !== null ? `${thousands(episodes)} episodes · ${state}` : state;
      const icon = LIBRARY_ICONS[l.type];
      return countLine({
        id: idOf('library', l.id),
        title: l.name,
        ...(icon ? { icon } : {}),
        detail,
        value: count === null ? '—' : thousands(count),
        ...(scanning
          ? {}
          : {
              actions: [
                button(who, {
                  action: 'scan',
                  target: l.id,
                  label: clip(`Scan ${l.name}`, 30),
                  icon: 'search',
                }),
              ],
            }),
      });
    }),
    empty: 'No libraries yet.',
  });
}

function recentlyAdded(input: JellyfinInput) {
  const { rest, now, timeZone } = input;
  return shelf({
    id: 'recent',
    title: 'Recently added',
    link: { kind: 'url', label: 'See all in Jellyfin', url: `${input.url}/web/index.html` },
    items: rest.recent.map((item): GalleryItem => {
      const asked = whoAsked(input.asked, item);
      const image = input.poster(item.imageId, item.title);
      const what = item.type === 'Movie' ? 'Film' : (item.part ?? (item.type === 'Series' ? 'Show' : null));
      return {
        id: item.id.slice(0, 200),
        title: item.title,
        ...(image ? { image } : {}),
        ...(what || item.year
          ? {
              sub: clip(
                [what, item.year && item.type === 'Movie' ? String(item.year) : null]
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

export function jellyfinMachineLines(rest: JellyfinRest): ThingPageBar[] {
  if (!rest.version) return [];
  return [
    {
      id: 'jellyfin-version',
      label: 'Jellyfin',
      value: clip(rest.version, 40),
      pct: null,
      ...(rest.pendingRestart
        ? { sub: 'Restart needed', subTone: 'warn' as const }
        : rest.os
          ? { sub: clip(rest.os, 80) }
          : {}),
    },
  ];
}

export function jellyfinVerdict(rest: JellyfinRest, live: JellyfinLive | null): string {
  const parts: string[] = [];
  if (live) {
    const watchers = new Set(live.sessions.map((s) => s.user ?? s.id)).size;
    parts.push(
      watchers === 0
        ? 'nobody is watching'
        : watchers === 1
          ? '1 person is watching'
          : `${watchers} people are watching`,
    );
  }
  const scanningLib = rest.libraries.find((l) => l.refreshing);
  const scanTask = live?.tasks.some((t) => t.key === 'RefreshLibrary' && t.running);
  if (scanningLib) parts.push(`${scanningLib.name} is being scanned`);
  else if (scanTask) parts.push('libraries are being scanned');
  else if (rest.libraries.length) parts.push('every library is up to date');
  return clip(parts.length ? `Jellyfin is fine: ${parts.join(' and ')}.` : 'Jellyfin is fine.', 200);
}

export function jellyfinKpis(input: JellyfinInput): ThingPageKpi[] {
  const { rest, live } = input;
  const out: ThingPageKpi[] = [];
  const movies = rest.counts.movies;
  if (movies !== null || rest.libraries.some((l) => l.type === 'movies'))
    out.push({
      key: 'movies',
      label: 'Movies',
      value: movies !== null ? thousands(movies) : '—',
      sub: plural(
        Math.max(1, rest.libraries.filter((l) => l.type === 'movies').length),
        'library',
        'libraries',
      ),
    });
  const shows = rest.counts.shows;
  const episodes = rest.counts.episodes;
  if (shows !== null || rest.libraries.some((l) => l.type === 'tvshows'))
    out.push({
      key: 'shows',
      label: 'Shows',
      value: shows !== null ? thousands(shows) : '—',
      ...(episodes !== null ? { sub: `${thousands(episodes)} episodes` } : {}),
    });
  if (live) {
    const n = live.sessions.length;
    const converting = live.sessions.filter((s) => s.converting).length;
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

export function jellyfinSlots(input: JellyfinInput): Pick<KindView, 'panels' | 'slots'> {
  const week = input.history ? jellyfinWeek(input.history, input.now, input.timeZone) : null;
  return slotPanels({
    live: nowPlaying(input),
    inventory: librariesPanel(input),
    shelf: recentlyAdded(input),
    trend: week?.trend,
    people: week?.people,
    machine: jellyfinMachineLines(input.rest),
  });
}

export function jellyfinView(input: JellyfinInput): KindView {
  const { rest, live } = input;
  const facts: ThingLine[] = [];
  if (rest.version) facts.push(line(`Jellyfin **${rest.version}**`));
  if (rest.libraries.length) facts.push(line(`**${plural(rest.libraries.length, 'library', 'libraries')}**`));
  const playing = !!live?.sessions.some((s) => !s.paused);
  const notices = jellyfinNotices(input);
  return {
    kpis: [],
    charts: [],
    machine: 'after',
    notices: asNotices(notices),
    ...statusFrom(live?.sessions.length ? `${plural(live.sessions.length, 'stream')} playing` : null),
    ...jellyfinSlots(input),
    tabs: [],
    facts,
    open: { label: 'Open Jellyfin', url: `${input.url}/web/index.html` },
    actions: [],
    readAt: input.readAt,
    ...(playing ? { refreshS: 5 } : {}),
    suggestions: ['Most watched this month', 'Who watches most', 'Biggest movies'],
    verdict: jellyfinVerdict(rest, live),
  };
}

/* Page & seen -------------------------------------------------------------------------------------------------------- */

export function jellyfinUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (str(row.fields.url) ?? row.baseUrl).replace(/\/+$/, '');
}

export function jellyfinPosterPath(imageId: string): string {
  return `/Items/${encodeURIComponent(imageId)}/Images/Primary?maxWidth=240&quality=90`;
}

async function streamsLine(
  services: Services,
  rowId: string,
  range: PageRange,
  now: Date,
): Promise<(number | null)[]> {
  const points = await readPoints(services.db, rowId, [JELLYFIN_STREAMS_KEY], now, RANGE_MS[range]).catch(
    () => new Map<string, RawPoint[]>(),
  );
  return onRange([points.get(JELLYFIN_STREAMS_KEY) ?? []], range, now).values[0] ?? [];
}

export async function jellyfinPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = jellyfinUrl(row);
  const [rest, live, seerr, streams] = await Promise.all([
    latestRead(
      services,
      restKey(row),
      row,
      deadline(() => readRest(services, row)),
    ),
    liveRead(
      services,
      liveKey(row),
      row,
      deadline(() => readLive(services, row)),
      { liveS: JELLYFIN_LIVE_S },
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
      open: { label: 'Open Jellyfin', url: `${url}/web/index.html` },
      actions: [],
      readAt: null,
      suggestions: [],
      problem: problemOf(rest.error, NAME).message,
      refreshing: rest.refreshing,
    };
  const [asked, history] = await Promise.all([
    seerr ? readAsked(services, seerr.row, now).catch(() => null) : null,
    cachedRead(
      services,
      `jellyfin-history:${row.id}`,
      row,
      deadline(() => readHistory(services, row)),
      HISTORY_KEEP_MS,
    ).catch(() => null),
  ]);
  const view = jellyfinView({
    rest: rest.value,
    live: live.ok ? live.value : null,
    readAt: rest.at,
    now,
    timeZone: ctx.timeZone,
    who: { row },
    url,
    asked,
    since: live.ok ? noteJellyfinScans(services, row.id, live.value.tasks, now) : new Map(),
    streams,
    poster: (imageId, title) => (imageId ? picture(ctx, jellyfinPosterPath(imageId), title) : undefined),
    history,
  });
  return {
    ...view,
    ...(live.ok ? {} : { problem: problemOf(live.error, NAME).message }),
    refreshing: rest.refreshing || live.refreshing,
  };
}

export function jellyfinActivity(live: JellyfinLive | null): ConnectionActivity | undefined {
  if (!live) return undefined;
  if (live.sessions.length === 0) return { active: false, value: 'Nobody watching' };
  const titles = [...new Set(live.sessions.map((s) => s.item.title))];
  return { active: true, value: `${live.sessions.length} watching`, detail: clip(titles.join(', '), 120) };
}

export async function jellyfinSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const { rest, live } = await jellyfinSnapshot(services, row);
  const input: JellyfinInput = {
    rest,
    live,
    readAt: now,
    now,
    timeZone,
    who: { row },
    url: jellyfinUrl(row),
    asked: null,
    since: live ? noteJellyfinScans(services, row.id, live.tasks, now) : new Map(),
    streams: [],
    poster: () => undefined,
  };
  const kpis = jellyfinKpis(input);
  const notices = jellyfinNotices(input);
  const activity = jellyfinActivity(live);
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
    points: live ? { [JELLYFIN_STREAMS_KEY]: live.sessions.length } : {},
    ...linesSeen({ notices }, jellyfinSkipped(rest, live)),
  };
}

/* Actions ------------------------------------------------------------------------------------------------------------ */

const scan: KindAction = async (ctx, input) => {
  const key = input.target;
  if (key === 'all') {
    await actAs(ctx.services, ctx.row, NAME, { method: 'POST', path: '/Library/Refresh' });
    return { message: 'Jellyfin is scanning every library.', title: 'Scanned every library in Jellyfin' };
  }
  if (!key || !/^[0-9a-f-]{1,64}$/i.test(key)) throw badRequest('Which library should Jellyfin scan?');
  const libraries = parseLibraries(
    await getJson(ctx.services, ctx.row, NAME, '/Library/VirtualFolders').catch((err) => {
      throw new ApiError('unavailable', problemOf(err, NAME).message);
    }),
  );
  const lib = libraries.find((l) => l.id === key);
  if (!lib) throw conflict('Jellyfin doesn’t have that library any more.');
  await actAs(ctx.services, ctx.row, NAME, {
    method: 'POST',
    path: `/Items/${encodeURIComponent(lib.id)}/Refresh?Recursive=true&ImageRefreshMode=Default&MetadataRefreshMode=Default`,
  });
  return { message: `Jellyfin is scanning ${lib.name}.`, title: `Scanned ${lib.name} in Jellyfin` };
};

export const JELLYFIN_ACTIONS: Record<string, KindAction> = { scan };

export const JELLYFIN_KIND: KindModule = {
  activityLine: 'Who’s watching',
  page: jellyfinPage,
  prefetch: (services, row) => jellyfinSnapshot(services, row),
  seen: jellyfinSeen,
  asksFirst: 'deleting media, users, settings and restarts ask first',
  actions: JELLYFIN_ACTIONS,
  liveS: JELLYFIN_LIVE_S,
  checks: JELLYFIN_CHECKS,
};
