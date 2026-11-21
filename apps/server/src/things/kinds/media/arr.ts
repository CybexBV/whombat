/**
 * Sonarr's and Radarr's pages and cards (service-dashboards.md SD-24, SD-05, SD-09, SD-10; SD-S13). The Summary is in
 * slots (docs/service-pages.md): what downloads now (posters from `/api/v3/mediacover/<id>/poster-250.jpg`, rows linking
 * SABnzbd's page), the library's counts with Search for missing, what comes up, what came in per day this week, and the
 * version and media disks in the machine card; Missing below, their own health checks in their words. One shape for
 * both (`/api/v3/`, `X-Api-Key`): `system/status`, `health`, `rootfolder`, `diskspace`, `calendar`, `queue` (live while
 * it downloads), Sonarr's `wanted/missing`, the library (`series`, `movie`: large, kept 5 minutes; Radarr's missing
 * comes from it, so every version answers), the imports of two weeks (`history/since`, kept 10 minutes) and `update`
 * (kept an hour).
 */
import type { ThingLine, ThingPageBar, ThingPageItem, ThingPageKpi } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { ConnectionActivity } from '../../../home/types';
import type { Services } from '../../../services';
import { shortHash } from '../../quiet/items';
import type { KindCheck, KindNotice, NoticeNature } from '../../quiet/types';
import {
  bytes,
  clip,
  clock,
  dateOf,
  dayMonth,
  line,
  list,
  num,
  pct,
  plural,
  rec,
  span,
  str,
  thousands,
  when,
} from '../../words';
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
  addedNote,
  countByDay,
  countLine,
  inventory,
  lastDays,
  liveRows,
  shelf,
  slotPanels,
  trend,
  weekChange,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import {
  badgeOf,
  clockMs,
  diskBand,
  diskSubject,
  episodeCode,
  idOf,
  itemLines,
  LIBRARY_MAX_BYTES,
  leftWords,
  linesSeen,
  optional,
  picture,
  prefixAllows,
  readJson,
  share,
  siblingRow,
  statusFrom,
  uniqueById,
  worstFirst,
} from './common';
import { asNotices, asPanels, type ButtonCtx, button, type GalleryItem, type Notice, type Panel } from './ui';

export type ArrApp = 'sonarr' | 'radarr';
const NAME: Record<ArrApp, string> = { sonarr: 'Sonarr', radarr: 'Radarr' };
const DAY = 86_400_000;
/** The library is kept 5 minutes (SD-S05): its counts change slowly and the list is large. */
export const LIBRARY_KEEP_MS = 5 * 60_000;
/** The live part (the queue) while the page is open. */
export const ARR_LIVE_S = 4;
const QUEUE_ROWS = 20;
const MISSING_ROWS = 10;
const UPCOMING_MAX = 24;
/** Coming up looks this far ahead: a week of episodes, a month of films (a week of film releases is mostly none). */
const AHEAD_DAYS: Record<ArrApp, number> = { sonarr: 7, radarr: 30 };
/** What came in: two weeks of imports (this week and the one before), kept 10 minutes. */
const HISTORY_KEEP_MS = 10 * 60_000;
const HISTORY_DAYS = 14;
/** A library added at once makes a long history: past this the read is left out, not cut. */
const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
/** Whether a newer version is out, kept an hour. */
const UPDATE_KEEP_MS = 60 * 60_000;
/** The media disks the machine card lists, tightest first. */
const DISK_LINES = 3;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface ArrHealth {
  source: string;
  type: 'error' | 'warning' | 'notice' | string;
  message: string;
  wikiUrl: string | null;
}

export interface ArrRoot {
  path: string;
  free: number | null;
  total: number | null;
  accessible: boolean;
}

export interface ArrUpcoming {
  id: string;
  /** The series' or movie's id (its poster). */
  posterId: number | null;
  title: string;
  /** “S02E05”, or the release (“In cinemas”, “Digital”, “On disc”). */
  what: string;
  /** The episode's title. */
  episode: string | null;
  at: Date;
  hasFile: boolean;
}

export interface ArrQueueItem {
  id: string;
  title: string;
  /** The series and episode or the movie it is for (“NCIS · S24E03”). */
  forWhat: string | null;
  posterId: number | null;
  sizeBytes: number | null;
  leftBytes: number | null;
  leftMs: number | null;
  status: string;
  trackedStatus: string | null;
  trackedState: string | null;
  messages: string[];
  client: string | null;
  protocol: string | null;
  /** “WEBDL-1080p”. */
  quality: string | null;
}

export interface ArrMissing {
  id: string;
  posterId: number | null;
  title: string;
  sub: string | null;
  at: Date | null;
}

export interface ArrLibrary {
  count: number;
  /** Sonarr: episode files; Radarr: movies with a file. */
  onDisk: number;
  /** When each series or movie was added (ms), for what is new this week. */
  addedAt?: number[];
  /** Radarr: when each movie's file came in (ms). */
  fileAddedAt?: number[];
  /** Sonarr: series still airing and ended. */
  continuing?: number;
  ended?: number;
  /** Sonarr: episodes aired (and monitored) or on disk. */
  episodes?: number;
  /** What the library takes on disk. */
  sizeBytes?: number;
  /** Radarr: the movies missing (monitored, available, no file), most recent first. */
  missing: ArrMissing[] | null;
  missingTotal: number | null;
}

export interface ArrRest {
  version: string | null;
  health: ArrHealth[];
  roots: ArrRoot[];
  upcoming: ArrUpcoming[];
  missing: ArrMissing[];
  missingTotal: number | null;
  library: ArrLibrary | null;
  /** When each import of the last 14 days came in; null when the history wasn't read. */
  imports?: Date[] | null;
  /** The version installed and the newest out; null when not read. */
  update?: ArrUpdate | null;
  /**
   * Parts this read couldn't read: `health`, `roots` (QN-11: their lines don't look fixed), `calendar` (what comes
   * mustn't look like nothing comes).
   */
  unread?: ('health' | 'roots' | 'calendar')[];
}

export interface ArrUpdate {
  installed: string | null;
  latest: string | null;
}

export interface ArrQueue {
  items: ArrQueueItem[];
  total: number;
}

export interface ArrSnapshot {
  readAt: Date;
  app: ArrApp;
  rest: ArrRest | null;
  queue: ArrQueue | null;
}

export function parseHealth(body: unknown): ArrHealth[] {
  return list(body)
    .slice(0, 30)
    .map((raw): ArrHealth | null => {
      const h = rec(raw);
      const message = str(h.message);
      if (!message) return null;
      return {
        source: str(h.source) ?? 'Health',
        type: (str(h.type) ?? 'warning').toLowerCase(),
        message,
        wikiUrl: str(h.wikiUrl),
      };
    })
    .filter((h): h is ArrHealth => h !== null);
}

/** Root folders with their free space, and the disk's total from `diskspace` (the longest path that holds it). */
export function parseRoots(rootfolders: unknown, diskspace: unknown): ArrRoot[] {
  const disks = list(diskspace)
    .map((d) => ({
      path: str(rec(d).path) ?? '',
      free: num(rec(d).freeSpace),
      total: num(rec(d).totalSpace),
    }))
    .filter((d) => d.path);
  const roots = list(rootfolders)
    .slice(0, 20)
    .map((raw): ArrRoot | null => {
      const r = rec(raw);
      const path = str(r.path);
      if (!path) return null;
      const disk = disks
        .filter((d) => path === d.path || path.startsWith(d.path.endsWith('/') ? d.path : `${d.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0];
      return {
        path,
        free: num(r.freeSpace) ?? disk?.free ?? null,
        total: num(r.totalSpace) ?? disk?.total ?? null,
        accessible: r.accessible !== false,
      };
    })
    .filter((r): r is ArrRoot => r !== null);
  // No root folder yet: the disks themselves (Radarr and Sonarr list their own config disk too).
  return roots.length ? roots : disks.slice(0, 4).map((d) => ({ ...d, accessible: true }));
}

const titleOf = (v: unknown) => str(rec(v).title);

/** Sonarr's calendar: episodes with their series. */
export function parseEpisodes(body: unknown): ArrUpcoming[] {
  return list(body)
    .slice(0, 200)
    .map((raw): ArrUpcoming | null => {
      const e = rec(raw);
      const at = dateOf(e.airDateUtc);
      const series = titleOf(e.series);
      if (!at || !series) return null;
      return {
        id: String(num(e.id) ?? `${series}-${at.getTime()}`),
        posterId: num(e.seriesId) ?? num(rec(e.series).id),
        title: series,
        what: episodeCode(num(e.seasonNumber), num(e.episodeNumber)) ?? 'Special',
        episode: str(e.title),
        at,
        hasFile: e.hasFile === true,
      };
    })
    .filter((x): x is ArrUpcoming => x !== null);
}

const RELEASES = [
  ['inCinemas', 'In cinemas'],
  ['digitalRelease', 'Digital'],
  ['physicalRelease', 'On disc'],
] as const;

/** Radarr's calendar: each release of a movie that falls between `from` and `to`. */
export function parseMovieReleases(body: unknown, from: Date, to: Date): ArrUpcoming[] {
  const out: ArrUpcoming[] = [];
  for (const raw of list(body).slice(0, 200)) {
    const m = rec(raw);
    const title = str(m.title);
    const id = num(m.id);
    if (!title) continue;
    for (const [field, words] of RELEASES) {
      const at = dateOf(m[field]);
      if (at && at >= from && at <= to)
        out.push({
          id: `${id ?? title}-${field}`,
          posterId: id,
          title,
          what: words,
          episode: null,
          at,
          hasFile: m.hasFile === true,
        });
    }
  }
  return out;
}

export function parseQueue(body: unknown, app: ArrApp): ArrQueue {
  const b = rec(body);
  const items = list(b.records)
    .slice(0, QUEUE_ROWS)
    .map((raw): ArrQueueItem | null => {
      const q = rec(raw);
      const title = str(q.title);
      if (!title) return null;
      const series = titleOf(q.series);
      const episode = rec(q.episode);
      const code = episodeCode(num(episode.seasonNumber), num(episode.episodeNumber));
      const movie = rec(q.movie);
      const forWhat =
        app === 'sonarr'
          ? series
            ? `${series}${code ? ` · ${code}` : ''}`
            : null
          : str(movie.title)
            ? `${str(movie.title)}${num(movie.year) ? ` (${num(movie.year)})` : ''}`
            : null;
      const messages = list(q.statusMessages)
        .flatMap((m) => {
          const lines = list(rec(m).messages).map((x) => str(x));
          return lines.length ? lines : [str(rec(m).title)];
        })
        .filter((m): m is string => !!m)
        .slice(0, 5);
      const error = str(q.errorMessage);
      return {
        id: String(num(q.id) ?? title).slice(0, 200),
        title,
        forWhat,
        posterId: app === 'sonarr' ? num(q.seriesId) : num(q.movieId),
        sizeBytes: num(q.size),
        leftBytes: num(q.sizeleft),
        leftMs: clockMs(q.timeleft),
        status: (str(q.status) ?? 'queued').toLowerCase(),
        trackedStatus: str(q.trackedDownloadStatus)?.toLowerCase() ?? null,
        trackedState: str(q.trackedDownloadState) ?? null,
        messages: error ? [error, ...messages].slice(0, 5) : messages,
        client: str(q.downloadClient),
        protocol: str(q.protocol),
        quality: str(rec(rec(q.quality).quality).name),
      };
    })
    .filter((x): x is ArrQueueItem => x !== null);
  return { items, total: num(b.totalRecords) ?? items.length };
}

/** Sonarr's `wanted/missing` (with its series). */
export function parseMissingEpisodes(body: unknown): { items: ArrMissing[]; total: number | null } {
  const b = rec(body);
  const items = list(b.records)
    .slice(0, MISSING_ROWS)
    .map((raw): ArrMissing | null => {
      const e = rec(raw);
      const series = titleOf(e.series);
      if (!series) return null;
      const code = episodeCode(num(e.seasonNumber), num(e.episodeNumber));
      return {
        id: String(num(e.id) ?? `${series}-${code}`),
        posterId: num(e.seriesId),
        title: `${series}${code ? ` · ${code}` : ''}`,
        sub: str(e.title),
        at: dateOf(e.airDateUtc),
      };
    })
    .filter((x): x is ArrMissing => x !== null);
  return { items, total: num(b.totalRecords) };
}

/** When a movie came out last, for “most recent missing”. */
function releasedAt(m: Record<string, unknown>): Date | null {
  return dateOf(m.digitalRelease) ?? dateOf(m.physicalRelease) ?? dateOf(m.inCinemas) ?? dateOf(m.added);
}

/** Sonarr's `series` or Radarr's `movie`: counts, and Radarr's missing. */
export function parseLibrary(body: unknown, app: ArrApp): ArrLibrary {
  const items = list(body).map(rec);
  const times = (xs: unknown[]) =>
    xs.map((x) => dateOf(x)?.getTime()).filter((x): x is number => x !== undefined);
  const addedAt = times(items.map((x) => x.added));
  if (app === 'sonarr') {
    const stat = (s: Record<string, unknown>, key: string) => num(rec(s.statistics)[key]) ?? 0;
    return {
      count: items.length,
      onDisk: items.reduce((a, s) => a + stat(s, 'episodeFileCount'), 0),
      missing: null,
      missingTotal: null,
      addedAt,
      continuing: items.filter((s) => str(s.status) === 'continuing' || str(s.status) === 'upcoming').length,
      ended: items.filter((s) => str(s.status) === 'ended').length,
      episodes: items.reduce((a, s) => a + stat(s, 'episodeCount'), 0),
      sizeBytes: items.reduce((a, s) => a + stat(s, 'sizeOnDisk'), 0),
    };
  }
  const missing = items
    .filter((m) => m.monitored === true && m.hasFile !== true && m.isAvailable === true)
    .sort((a, b) => (releasedAt(b)?.getTime() ?? 0) - (releasedAt(a)?.getTime() ?? 0));
  return {
    count: items.length,
    onDisk: items.filter((m) => m.hasFile === true).length,
    missing: missing.slice(0, MISSING_ROWS).map((m) => ({
      id: String(num(m.id) ?? str(m.title)),
      posterId: num(m.id),
      title: `${str(m.title) ?? 'A movie'}${num(m.year) ? ` (${num(m.year)})` : ''}`,
      sub: null,
      at: releasedAt(m),
    })),
    missingTotal: missing.length,
    addedAt,
    fileAddedAt: times(items.map((m) => rec(m.movieFile).dateAdded)),
    sizeBytes: items.reduce((a, m) => a + (num(m.sizeOnDisk) ?? 0), 0),
  };
}

/** `history/since?eventType=3`: when each download was imported (`downloadFolderImported`, both apps). */
export function parseImports(body: unknown): Date[] {
  return list(body)
    .map(rec)
    .filter((h) => (str(h.eventType) ?? 'downloadFolderImported') === 'downloadFolderImported')
    .map((h) => dateOf(h.date))
    .filter((d): d is Date => d !== null);
}

/** `update`: the version installed and the newest out (`latest`). */
export function parseUpdate(body: unknown): ArrUpdate {
  const all = list(body).map(rec);
  return {
    installed: str(all.find((u) => u.installed === true)?.version) ?? null,
    latest: str(all.find((u) => u.latest === true)?.version) ?? null,
  };
}

const v3 = (path: string) => `/api/v3/${path}`;

async function readRest(
  services: Services,
  row: CatalogConnectionRow,
  app: ArrApp,
  now: Date,
): Promise<ArrRest> {
  const name = NAME[app];
  const get = (path: string, query?: Record<string, string>) => getJson(services, row, name, v3(path), query);
  const to = new Date(now.getTime() + AHEAD_DAYS[app] * DAY);
  const from = new Date(now.getTime() - 6 * 3600_000);
  const [status, health, roots, disks, calendar, missing, library, imports, update] = await Promise.all([
    get('system/status'),
    optional(get('health')),
    optional(get('rootfolder')),
    optional(get('diskspace')),
    optional(
      get('calendar', {
        start: from.toISOString(),
        end: to.toISOString(),
        ...(app === 'sonarr' ? { includeSeries: 'true' } : {}),
      }),
    ),
    app === 'sonarr'
      ? optional(
          get('wanted/missing', {
            sortKey: 'episodes.airDateUtc',
            sortDirection: 'descending',
            pageSize: String(MISSING_ROWS),
            includeSeries: 'true',
            monitored: 'true',
          }),
        )
      : Promise.resolve(null),
    optional(
      cachedRead(
        services,
        `${app}-library:${row.id}`,
        row,
        async () =>
          parseLibrary(
            await readJson(services, row, name, {
              path: v3(app === 'sonarr' ? 'series' : 'movie'),
              maxBytes: LIBRARY_MAX_BYTES,
            }),
            app,
          ),
        LIBRARY_KEEP_MS,
      ),
    ),
    optional(
      cachedRead(
        services,
        `${app}-history:${row.id}`,
        row,
        async () =>
          parseImports(
            await readJson(services, row, name, {
              path: v3('history/since'),
              query: {
                date: new Date(now.getTime() - HISTORY_DAYS * DAY).toISOString(),
                // 3 is `downloadFolderImported` in both.
                eventType: '3',
              },
              maxBytes: HISTORY_MAX_BYTES,
            }),
          ),
        HISTORY_KEEP_MS,
      ),
    ),
    optional(
      cachedRead(
        services,
        `${app}-update:${row.id}`,
        row,
        async () => parseUpdate(await get('update')),
        UPDATE_KEEP_MS,
      ),
    ),
  ]);
  const m = app === 'sonarr' && missing ? parseMissingEpisodes(missing) : null;
  const upcoming = calendar
    ? (app === 'sonarr' ? parseEpisodes(calendar) : parseMovieReleases(calendar, from, to))
        .filter((u) => u.at.getTime() >= now.getTime() - 6 * 3600_000)
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .slice(0, UPCOMING_MAX)
    : [];
  const unread = [
    ...(health ? [] : ['health' as const]),
    ...(roots ? [] : ['roots' as const]),
    ...(calendar ? [] : ['calendar' as const]),
  ];
  return {
    version: str(rec(status).version),
    health: health ? parseHealth(health) : [],
    roots: roots || disks ? parseRoots(roots, disks) : [],
    upcoming,
    missing: m?.items ?? library?.missing ?? [],
    missingTotal: m?.total ?? library?.missingTotal ?? null,
    library,
    imports,
    update,
    ...(unread.length ? { unread } : {}),
  };
}

async function readQueue(services: Services, row: CatalogConnectionRow, app: ArrApp): Promise<ArrQueue> {
  return parseQueue(
    await getJson(services, row, NAME[app], v3('queue'), {
      pageSize: String(QUEUE_ROWS),
      ...(app === 'sonarr' ? { includeSeries: 'true', includeEpisode: 'true' } : { includeMovie: 'true' }),
    }),
    app,
  );
}

function deadline<T>(app: ArrApp, work: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await withDeadline(work(), KIND_DEADLINE_MS, `${NAME[app]} didn’t answer in time.`);
    } catch (err) {
      throw problemOf(err, NAME[app]);
    }
  };
}

const restKey = (app: ArrApp, row: CatalogConnectionRow) => `${app}:${row.id}`;
const queueKey = (app: ArrApp, row: CatalogConnectionRow) => `${app}-live:${row.id}`;

/** The health pass's read: kept 30 seconds (the queue 4). */
export async function arrSnapshot(
  services: Services,
  row: CatalogConnectionRow,
  app: ArrApp,
  now = services.clock(),
): Promise<ArrSnapshot> {
  const [rest, queue] = await Promise.all([
    cachedRead(
      services,
      restKey(app, row),
      row,
      deadline(app, () => readRest(services, row, app, now)),
    ),
    optional(
      cachedRead(
        services,
        queueKey(app, row),
        row,
        deadline(app, () => readQueue(services, row, app)),
        ARR_LIVE_S * 1000,
      ),
    ),
  ]);
  return { readAt: now, app, rest, queue };
}

/* What it shows ------------------------------------------------------------------------------------------------------- */

export interface ArrInput {
  snapshot: ArrSnapshot;
  now: Date;
  timeZone: string;
  who: ButtonCtx;
  url: string;
  /** SABnzbd's page, when the viewer sees one (SD-10). */
  sabnzbd: { href: string; name: string } | null;
  /** The picture of a series or movie, or none (pure tests). */
  poster: (id: number | null, title: string) => GalleryItem['image'];
}

/** The smallest root folder's free space (SD-24). */
export function tightest(roots: readonly ArrRoot[]): ArrRoot | null {
  return (
    [...roots].filter((r) => r.free !== null).sort((a, b) => (a.free as number) - (b.free as number))[0] ??
    null
  );
}

const freeShare = (r: ArrRoot | null) => (r?.free != null && r.total ? r.free / r.total : null);

/** “Thu 21:00”, “Today 21:00”, “14 Nov”. */
export function airWords(at: Date, now: Date, timeZone: string): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  if (day(at) === day(now)) return `Today ${clock(at, timeZone)}`;
  if (day(at) === day(new Date(now.getTime() + DAY))) return `Tomorrow ${clock(at, timeZone)}`;
  if (at.getTime() - now.getTime() < 7 * DAY && at > now)
    return `${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(at)} ${clock(at, timeZone)}`;
  return dayMonth(at, timeZone);
}

/** A queue item that can't be imported, or failed (SD-24). */
export function stuck(q: ArrQueueItem): boolean {
  return (
    q.trackedStatus === 'warning' ||
    q.trackedStatus === 'error' ||
    q.trackedState === 'importBlocked' ||
    q.trackedState === 'importFailed' ||
    q.trackedState === 'failedPending' ||
    q.status === 'failed' ||
    q.status === 'warning'
  );
}

const downloading = (q: ArrQueue | null) => !!q?.items.some((i) => i.status === 'downloading');

/** The figures (SD-24): Series or Movies, Missing, Downloading, Disk free. */
export function arrKpis(input: ArrInput): ThingPageKpi[] {
  const { snapshot: s } = input;
  const out: ThingPageKpi[] = [];
  const lib = s.rest?.library;
  if (lib)
    out.push({
      key: 'library',
      label: s.app === 'sonarr' ? 'Series' : 'Movies',
      value: thousands(lib.count),
      sub:
        s.app === 'sonarr' ? `${thousands(lib.onDisk)} episodes on disk` : `${thousands(lib.onDisk)} on disk`,
    });
  if (s.rest && s.rest.missingTotal !== null)
    out.push({
      key: 'missing',
      label: 'Missing',
      value: thousands(s.rest.missingTotal),
      sub: s.rest.missingTotal
        ? s.app === 'sonarr'
          ? 'episodes not downloaded'
          : 'movies not downloaded'
        : 'Nothing missing',
    });
  if (s.queue) {
    const left = s.queue.items.reduce((a, q) => a + (q.leftBytes ?? 0), 0);
    const ms = s.queue.items.reduce((a, q) => Math.max(a, q.leftMs ?? 0), 0);
    out.push({
      key: 'downloading',
      label: 'Downloading',
      value: thousands(s.queue.total),
      sub: s.queue.total
        ? [left ? `${bytes(left)} left` : null, ms ? span(ms) : null].filter(Boolean).join(' · ') || 'waiting'
        : 'Nothing now',
    });
  }
  const root = tightest(s.rest?.roots ?? []);
  const free = freeShare(root);
  if (root?.free != null)
    out.push({
      key: 'disk',
      label: 'Disk free',
      value: bytes(root.free),
      ...(root.total ? { rest: `of ${bytes(root.total)}` } : {}),
      ...(free !== null
        ? {
            meter: Math.max(0, Math.min(1, 1 - free)),
            sub: clip(`${pct(free * 100)} free · ${root.path}`, 80),
          }
        : { sub: clip(root.path, 80) }),
      ...(free !== null && free < 0.05
        ? { tone: 'bad' as const }
        : free !== null && free < 0.1
          ? { tone: 'warn' as const }
          : { color: 'blue' as const }),
    });
  return out;
}

/** A health check's icon by its source: folders and paths, indexers and clients, updates. */
function healthIcon(h: ArrHealth): Notice['icon'] {
  if (/rootfolder|diskspace|mapping|path|mount|folder/i.test(h.source)) return 'disk';
  if (/indexer|downloadclient|proxy|import ?list/i.test(h.source)) return 'network';
  if (/update/i.test(h.source)) return 'update';
  return 'warn';
}

/** Sonarr's and Radarr's own checks a person deals with (quiet-notices.md QN-S3x): removed titles, setup advice. */
const HEALTH_YOU = new Set([
  'RemovedSeriesCheck',
  'RemovedMovieCheck',
  'ApiKeyValidationCheck',
  'AppDataLocationCheck',
  'RecyclingBinCheck',
  'ReleaseBranchCheck',
]);
/** Their checks that are information: lists and notifications failing, the packager's message. */
const HEALTH_FYI = new Set(['ImportListStatusCheck', 'NotificationStatusCheck', 'PackageGlobalMessageCheck']);
/** Their own back-off that clears by itself: it colours the dot after two passes (QN-04). */
const HEALTH_FLAPS = new Set(['IndexerStatusCheck']);

/** A health check's kind of line by its source (catalogue-infra-media.md): a `notice` is always a heads-up. */
export function healthNature(h: ArrHealth): NoticeNature {
  if (h.type === 'notice') return 'fyi';
  if (h.source === 'UpdateCheck') return /can(no|’|')?t|unable|fail/i.test(h.message) ? 'you' : 'fyi';
  if (HEALTH_YOU.has(h.source)) return 'you';
  if (HEALTH_FYI.has(h.source)) return 'fyi';
  return 'problem';
}

const SOURCE_NAMES: Record<string, string> = {
  IndexerStatusCheck: 'Search sites failing',
  IndexerLongTermStatusCheck: 'Search sites failing for hours',
  IndexerRssCheck: 'Search sites for new releases',
  IndexerSearchCheck: 'Search sites for searches',
  DownloadClientCheck: 'Reaching the downloader',
  DownloadClientStatusCheck: 'Downloaders failing',
  RemotePathMappingCheck: 'Where downloads land',
  RootFolderCheck: 'Media folders',
  MountCheck: 'Disks',
  UpdateCheck: 'Updates',
};

/** A check's source as people say it: “IndexerRssCheck” → “Indexers for new releases”, else “Proxy”. */
export function sourceName(source: string): string {
  const known = SOURCE_NAMES[source];
  if (known) return known;
  const words = source
    .replace(/Check$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return clip(words.charAt(0).toUpperCase() + words.slice(1) || 'Health', 80);
}

/** A download Sonarr or Radarr leaves for a person to import by hand (or to judge as not an upgrade). */
const BY_HAND = /not an upgrade|manual(ly)? import|import (it )?by hand|matched .*by id|manual interaction/i;

/** Every check a Sonarr or Radarr page can raise (QN-15). */
export function arrChecks(app: ArrApp): readonly KindCheck[] {
  const name = NAME[app];
  return [
    { check: 'media.disk', name: 'Media disk filling up', nature: 'problem', perItem: true, startsOn: true },
    {
      check: `${app}.health`,
      name: `${name}’s own health checks`,
      nature: 'problem',
      perItem: true,
      startsOn: false,
    },
    {
      check: `${app}.imports`,
      name: 'Downloads that can’t be imported',
      nature: 'problem',
      perItem: true,
      startsOn: false,
    },
  ];
}

/** What this read couldn't see (QN-11): a part not read, or a queue longer than the rows read. */
export function arrSkipped(s: ArrSnapshot): string[] {
  const out: string[] = [];
  if (!s.rest || s.rest.unread?.includes('health')) out.push(`${s.app}.health`);
  if (!s.rest || s.rest.unread?.includes('roots')) out.push('media.disk');
  if (!s.queue || s.queue.total > s.queue.items.length) out.push(`${s.app}.imports`);
  return out;
}

/** Worth a look (SD-24): their health checks in their words, imports that fail, root folders filling up. */
export function arrNotices(input: ArrInput): KindNotice[] {
  const { snapshot: s } = input;
  const name = NAME[s.app];
  const out: KindNotice[] = [];
  // One line per disk (QN-03): its root folders below 10 % free, the tightest of each disk.
  const full = (s.rest?.roots ?? [])
    .map((r) => ({ r, free: freeShare(r) }))
    .filter((x): x is { r: ArrRoot; free: number } => x.free !== null && x.free < 0.1 && !!x.r.total)
    .sort((a, b) => a.free - b.free);
  const disks = new Set<string>();
  for (const { r, free } of full) {
    const subject = diskSubject(r.total as number, r.path);
    if (disks.has(subject.id)) continue;
    disks.add(subject.id);
    out.push({
      id: idOf('disk', r.path).slice(0, 120),
      tone: free < 0.05 ? 'bad' : 'warn',
      icon: 'disk',
      title: `${name}’s disk is ${pct((1 - free) * 100)} full`,
      detail: `${bytes(r.free ?? 0)} free on ${clip(r.path, 80)}. ${name} can’t import once it is full.`,
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: clip(`${name}’s disk (${r.path}) is nearly full. What can go?`, 300),
      },
      nature: 'problem',
      check: 'media.disk',
      subject,
      band: diskBand(free),
      ignore: { lifts: 'fixed', words: 'Until there’s more room.' },
      badge: badgeOf(`Disk ${pct((1 - free) * 100)} full`),
    });
  }
  const tone = (t: string) => (t === 'error' ? 'bad' : t === 'warning' ? 'warn' : 'info') as Notice['tone'];
  for (const h of s.rest?.health ?? []) {
    const nature = healthNature(h);
    out.push({
      id: idOf('health', h.source).slice(0, 120),
      tone: nature === 'fyi' ? 'info' : tone(h.type),
      icon: healthIcon(h),
      // Whombat's own words for what it is; the service's message, written for admins, is the detail.
      title: `${name}: ${sourceName(h.source).toLowerCase()}`,
      detail: clip(h.message, 200),
      ...(h.wikiUrl && /^https:\/\//.test(h.wikiUrl)
        ? { link: { kind: 'url' as const, label: 'How to fix it', url: h.wikiUrl.slice(0, 500) } }
        : {}),
      nature,
      check: `${s.app}.health`,
      subject: { id: `source:${h.source}`.slice(0, 160), name: sourceName(h.source) },
      // The message names what fails (“…: NZBgeek, DrunkenSlug”): a different one is news.
      episode: shortHash([h.message]),
      ignore: { lifts: 'fixed', words: `Until ${name} stops saying it.` },
      ...(HEALTH_FLAPS.has(h.source) ? { confirm: 2 as const } : {}),
      badge: badgeOf(sourceName(h.source)),
    });
  }
  const stuckOnes = worstFirst(
    (s.queue?.items ?? []).filter(stuck).map((q): KindNotice => {
      const what = clip(q.forWhat ?? q.title, 80);
      const byHand = q.messages.some((m) => BY_HAND.test(m));
      return {
        id: idOf('imports', q.id).slice(0, 120),
        tone: 'warn',
        icon: 'download',
        title: `${what} can’t be imported`,
        ...(q.messages[0] ? { detail: clip(q.messages[0], 200) } : {}),
        link: { kind: 'url', label: `Open ${name}`, url: `${input.url}/activity/queue` },
        nature: byHand ? 'you' : 'problem',
        check: `${s.app}.imports`,
        subject: { id: `download:${q.id}`.slice(0, 160), name: what },
        ignore: { lifts: 'fixed', words: 'Until it’s imported or removed.' },
        badge: badgeOf(`Can’t import ${what}`),
      };
    }),
  );
  out.push(
    ...itemLines(stuckOnes, (rest) => ({
      id: 'imports-more',
      title: `${plural(rest.length, 'more download', 'more downloads')} can’t be imported`,
      link: { kind: 'url', label: `Open ${name}`, url: `${input.url}/activity/queue` },
      badge: badgeOf(`${stuckOnes.length} downloads can’t be imported`),
    })),
  );
  return worstFirst(uniqueById(out));
}

const STATE_WORDS: Record<string, string> = {
  downloading: 'Downloading',
  queued: 'Queued',
  paused: 'Paused',
  delay: 'Waiting',
  completed: 'Done',
  failed: 'Failed',
  warning: 'Needs a look',
  downloadclientunavailable: 'Client unavailable',
  importpending: 'Importing',
  importing: 'Importing',
  importblocked: 'Can’t import',
  importfailed: 'Import failed',
  failedpending: 'Failed',
};

function stateOf(q: ArrQueueItem): { text: string; dot: 'ok' | 'warn' | 'bad' | 'off' } {
  const tracked = (q.trackedState ?? '').toLowerCase();
  if (stuck(q))
    return {
      text: STATE_WORDS[tracked] ?? STATE_WORDS[q.status] ?? 'Needs a look',
      dot: q.trackedStatus === 'error' || q.status === 'failed' ? 'bad' : 'warn',
    };
  const text = STATE_WORDS[tracked] ?? STATE_WORDS[q.status] ?? q.status;
  return { text, dot: q.status === 'downloading' ? 'ok' : 'off' };
}

/** Whether a queue row's download client is SABnzbd's (its name, or Usenet when the viewer has one SABnzbd). */
const isSab = (q: ArrQueueItem) => /sab/i.test(q.client ?? '') || (!q.client && q.protocol === 'usenet');

const doneOf = (q: ArrQueueItem) =>
  q.sizeBytes && q.leftBytes !== null ? Math.max(0, Math.min(1, 1 - q.leftBytes / q.sizeBytes)) : 0;

/** Downloading now's line over its rows: “2 downloading · 4.2 GB left · about 20 min”, “3 waiting”. */
export function queueMeta(q: ArrQueue): string | undefined {
  if (!q.items.length) return undefined;
  const now = q.items.filter((i) => i.status === 'downloading');
  const waiting = q.total - now.length;
  const left = now.reduce((a, i) => a + (i.leftBytes ?? 0), 0);
  const ms = now.reduce((a, i) => Math.max(a, i.leftMs ?? 0), 0);
  return [
    now.length ? `${now.length} downloading` : null,
    waiting > 0 ? `${waiting} waiting` : null,
    left ? `${bytes(left)} left` : null,
    ms ? `about ${span(ms)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Questions for the Downloading now card. */
export function arrQueueQuestions(s: ArrSnapshot): string[] {
  const name = NAME[s.app];
  const bad = (s.queue?.items ?? []).find(stuck);
  const out: string[] = [];
  if (bad) out.push(clip(`Why is ${bad.forWhat ?? bad.title} stuck in ${name}?`, 200));
  if ((s.queue?.total ?? 0) > 0) out.push(`When will ${name}’s downloads finish?`);
  out.push(
    s.app === 'sonarr' ? 'What episodes came in this week?' : 'What movies came in this week?',
    `Are ${name}’s indexers and downloader working?`,
  );
  return out.slice(0, 3);
}

/** Questions for the Your library card. */
export function arrLibraryQuestions(s: ArrSnapshot): string[] {
  const out: string[] = [];
  if ((s.rest?.missingTotal ?? 0) > 0)
    out.push(
      s.app === 'sonarr' ? 'Why are some episodes still missing?' : 'Why are some movies still missing?',
    );
  out.push(
    s.app === 'sonarr' ? 'What new episodes air this week?' : 'What movies come out soon?',
    s.app === 'sonarr' ? 'Which series take the most space?' : 'Which movies take the most space?',
  );
  return out.slice(0, 3);
}

/** One calm sentence for the head while Sonarr or Radarr has no active problem. */
export function arrVerdict(s: ArrSnapshot): string {
  const name = NAME[s.app];
  const q = s.queue;
  const stuckCount = (q?.items ?? []).filter(stuck).length;
  if (stuckCount > 0)
    return clip(
      `${plural(stuckCount, 'download')} ${stuckCount === 1 ? 'is' : 'are'} stuck in ${name}.`,
      200,
    );
  const active = (q?.items ?? []).filter((i) => i.status === 'downloading').length;
  const missing = s.rest?.missingTotal ?? null;
  const parts: string[] = [];
  if (active > 0) parts.push(`${plural(active, 'download')} running`);
  else if (q && q.total > 0) parts.push(`${plural(q.total, 'download')} waiting`);
  else if (q) parts.push('nothing is downloading');
  if (missing !== null) {
    const unit = s.app === 'sonarr' ? (['episode', 'episodes'] as const) : (['movie', 'movies'] as const);
    parts.push(
      missing === 0
        ? `no ${unit[1]} missing`
        : `${thousands(missing)} ${missing === 1 ? unit[0] : unit[1]} missing`,
    );
  }
  return clip(parts.length ? `${name} is fine: ${parts.join(' and ')}.` : `${name} is running fine.`, 200);
}

/**
 * Downloading now (Live): a row per download with its poster, what it is for, its quality and size, how far it is and
 * how long is left; one that can't be imported or failed says so as its tag. Rows link SABnzbd's page (SD-10).
 */
export function arrLive(input: ArrInput) {
  const { snapshot: s } = input;
  const q = s.queue;
  if (!q) return null;
  const name = NAME[s.app];
  const meta = queueMeta(q);
  return liveRows({
    id: 'queue',
    title: 'Downloading now',
    ...(meta ? { meta } : {}),
    ask: { questions: arrQueueQuestions(s) },
    link: input.sabnzbd
      ? { kind: 'href', label: clip(`Open ${input.sabnzbd.name}`, 30), href: input.sabnzbd.href }
      : { kind: 'url', label: `Open ${name}`, url: `${input.url}/activity/queue` },
    ...(q.total > q.items.length ? { total: q.total } : {}),
    items: q.items.map((i): GalleryItem => {
      const what = i.forWhat ?? i.title;
      const image = input.poster(i.posterId, what);
      const done = doneOf(i);
      const state = stateOf(i);
      const paused = i.status === 'paused';
      const have = i.sizeBytes && i.leftBytes !== null ? Math.max(0, i.sizeBytes - i.leftBytes) : 0;
      const sub = [i.quality, i.sizeBytes ? bytes(i.sizeBytes) : null].filter(Boolean).join(' · ');
      const sab = input.sabnzbd && isSab(i) ? input.sabnzbd : null;
      return {
        id: i.id.slice(0, 200),
        title: clip(what, 120),
        ...(sub ? { sub: clip(sub, 120) } : {}),
        ...(image ? { image } : {}),
        ...(stuck(i)
          ? { badge: { text: clip(state.text, 30), tone: state.dot === 'bad' ? 'bad' : 'warn' } }
          : {}),
        progress: done,
        ...(paused ? { paused: true } : {}),
        // “1.2 GB of 3.1 GB” once something came in; “0 %” before.
        note: clip(have && i.sizeBytes ? `${bytes(have)} of ${bytes(i.sizeBytes)}` : share(done), 80),
        ...(stuck(i)
          ? {}
          : paused
            ? { noteEnd: 'Paused' }
            : i.status === 'downloading'
              ? i.leftMs
                ? { noteEnd: leftWords(i.leftMs) }
                : {}
              : { noteEnd: clip(state.text, 60) }),
        ...(sab ? { href: sab.href } : {}),
      };
    }),
    empty: 'Nothing downloading.',
  });
}

const DAY_MS = 86_400_000;
/** How many of these moments fall in the last 7 days. */
const thisWeek = (at: readonly number[] | undefined, now: Date) =>
  at ? at.filter((t) => t > now.getTime() - 7 * DAY_MS && t <= now.getTime()).length : null;

/** Search for missing: Sonarr or Radarr asks the indexers for each one, so it asks first. */
function searchButton(input: ArrInput) {
  const app = input.snapshot.app;
  return button(input.who, {
    action: 'search_missing',
    label: 'Search for missing',
    icon: 'search',
    confirm: {
      title: app === 'sonarr' ? 'Search for every missing episode?' : 'Search for every missing movie?',
      body: `${NAME[app]} asks your indexers for each one. That uses their daily limits.`,
      button: 'Search',
    },
  });
}

/**
 * Your library (Inventory): Sonarr's series (still airing and ended, added this week), episodes on disk (of those
 * aired, imported this week), missing with Search for missing, and the space it takes; Radarr's movies, those on disk,
 * missing and the space. Null when neither the library nor what is missing was read.
 */
export function arrInventory(input: ArrInput) {
  const { snapshot: s, now, url } = input;
  const rest = s.rest;
  if (!rest) return null;
  const lib = rest.library;
  const sonarr = s.app === 'sonarr';
  const lines: ThingPageItem[] = [];
  if (lib) {
    const parts = sonarr
      ? [
          lib.continuing ? `${thousands(lib.continuing)} still airing` : null,
          lib.ended ? `${thousands(lib.ended)} ended` : null,
        ].filter(Boolean)
      : [];
    lines.push(
      countLine({
        id: sonarr ? 'series' : 'movies',
        title: sonarr ? 'Series' : 'Movies',
        icon: sonarr ? 'tv' : 'film',
        ...(parts.length ? { detail: parts.join(' · ') } : {}),
        value: thousands(lib.count),
        ...addedNote(thisWeek(lib.addedAt, now)),
        url: `${url}/`,
      }),
    );
    const imported = sonarr
      ? rest.imports
        ? thisWeek(
            rest.imports.map((d) => d.getTime()),
            now,
          )
        : null
      : thisWeek(lib.fileAddedAt, now);
    lines.push(
      countLine({
        id: sonarr ? 'episodes' : 'on-disk',
        title: sonarr ? 'Episodes' : 'On disk',
        icon: 'video',
        ...(sonarr && lib.episodes
          ? { detail: `of ${thousands(lib.episodes)} aired` }
          : !sonarr
            ? { detail: `of ${plural(lib.count, 'movie')}` }
            : {}),
        value: thousands(lib.onDisk),
        ...addedNote(imported),
      }),
    );
  }
  if (rest.missingTotal !== null)
    lines.push(
      countLine({
        id: 'missing',
        title: 'Missing',
        icon: 'download',
        detail: sonarr ? 'Aired, not downloaded' : 'Out, not downloaded',
        value: thousands(rest.missingTotal),
        ...(rest.missingTotal ? { actions: [searchButton(input)] } : {}),
        ...(sonarr ? { url: `${url}/wanted/missing` } : {}),
      }),
    );
  if (lib?.sizeBytes)
    lines.push(countLine({ id: 'size', title: 'Space used', icon: 'disk', value: bytes(lib.sizeBytes) }));
  if (!lines.length) return null;
  return inventory({
    id: 'library',
    title: 'Your library',
    ask: { questions: arrLibraryQuestions(s) },
    items: lines,
  });
}

/**
 * Coming up (Shelf): the next 7 days' episodes (Sonarr) or 30 days' film releases (Radarr) as posters. Its words are
 * what a desk reads: `sub` “S02E05 · Today 21:00” (what, then when after the last ` · `), `note` the episode's
 * title, “On disk” as an ok tag. Left out when nothing comes.
 */
export function arrShelf(input: ArrInput) {
  const { snapshot: s, now, timeZone } = input;
  const upcoming = s.rest?.upcoming ?? [];
  if (!upcoming.length) return null;
  return shelf({
    id: 'upcoming',
    title: 'Coming up',
    meta: `Next ${AHEAD_DAYS[s.app]} days`,
    items: upcoming.map((u): GalleryItem => {
      const image = input.poster(u.posterId, u.title);
      return {
        id: u.id.slice(0, 200),
        title: clip(u.title, 120),
        sub: clip(
          `${u.what} · ${s.app === 'sonarr' ? airWords(u.at, now, timeZone) : dayMonth(u.at, timeZone)}`,
          120,
        ),
        ...(image ? { image } : {}),
        at: u.at.toISOString(),
        ...(u.episode ? { note: clip(u.episode, 80) } : {}),
        ...(u.hasFile ? { badge: { text: 'On disk', tone: 'ok' as const } } : {}),
      };
    }),
  });
}

/**
 * This week (Trend): what came in per day of the last 7, today last, from the imports in the history, with the
 * week's total and the change on the week before (the history reaches back 14 days). Null without the history. Pure.
 */
export function arrWeek(
  imports: readonly Date[] | null | undefined,
  app: ArrApp,
  now: Date,
  timeZone: string,
) {
  if (!imports) return null;
  const days = lastDays(now, timeZone);
  const values = countByDay(imports, days.keys, timeZone);
  const total = values.reduce((a, b) => a + b, 0);
  const before = countByDay(imports, lastDays(new Date(now.getTime() - 7 * DAY_MS), timeZone).keys, timeZone);
  const prior = before.reduce((a, b) => a + b, 0);
  const one = app === 'sonarr' ? 'episode' : 'movie';
  return trend({
    id: 'week',
    title: 'This week',
    meta: 'Came in per day',
    days,
    values,
    label: 'Came in',
    figure: { value: thousands(total), rest: `${total === 1 ? one : `${one}s`} this week` },
    change: weekChange(total, prior),
    color: 'green',
  });
}

/**
 * Sonarr's or Radarr's own lines in “The machine”: its version with whether a newer one is out, then each media disk
 * (its root folders' disks, tightest first, at most 3): used of total, what's free under it, amber under 10 % free, red
 * under 5 %.
 */
export function arrMachineLines(s: ArrSnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  const rest = s.rest;
  if (rest?.version) {
    const u = rest.update;
    const newer = u?.latest && u.installed && u.latest !== u.installed ? u.latest : null;
    out.push({
      id: `${s.app}-version`,
      label: NAME[s.app],
      value: clip(rest.version, 40),
      pct: null,
      ...(newer
        ? { sub: clip(`Version ${newer} is out`, 120) }
        : u?.latest
          ? { sub: 'Up to date', subTone: 'ok' as const }
          : {}),
    });
  }
  const disks = new Map<string, ArrRoot>();
  for (const r of [...(rest?.roots ?? [])].sort((a, b) => (freeShare(a) ?? 1) - (freeShare(b) ?? 1))) {
    if (r.free === null || !r.total) continue;
    const id = diskSubject(r.total, r.path).id;
    if (!disks.has(id)) disks.set(id, r);
  }
  const shown = [...disks.values()].slice(0, DISK_LINES);
  for (const r of shown) {
    const free = (r.free as number) / (r.total as number);
    out.push({
      id: idOf('disk', r.path).slice(0, 120),
      label: shown.length > 1 ? clip(`Media disk ${r.path}`, 80) : 'Media disk',
      value: clip(`${bytes((r.total as number) - (r.free as number))} of ${bytes(r.total as number)}`, 40),
      pct: Math.max(0, Math.min(1, 1 - free)),
      sub: `${bytes(r.free as number)} free`,
      ...(free < 0.05 ? { tone: 'bad' as const } : free < 0.1 ? { tone: 'warn' as const } : {}),
    });
  }
  return out;
}

/** Missing, the newest 10 with their posters: below the slots (its button is on Your library's Missing line). */
function arrMore(input: ArrInput): Panel[] {
  const { snapshot: s, now, timeZone } = input;
  if (!s.rest?.missing.length) return [];
  return [
    {
      kind: 'list',
      id: 'missing',
      title: 'Missing',
      ...(s.rest.missingTotal ? { meta: thousands(s.rest.missingTotal) } : {}),
      items: s.rest.missing.map((m) => {
        const image = input.poster(m.posterId, m.title);
        return {
          id: m.id.slice(0, 200),
          title: clip(m.title, 160),
          ...(m.sub ? { detail: clip(m.sub, 300) } : {}),
          ...(m.at ? { at: m.at.toISOString(), right: when(m.at, now, timeZone) } : {}),
          ...(image ? { image } : {}),
        };
      }),
      empty: 'Nothing missing.',
    },
  ];
}

/**
 * The Summary in slots (docs/decisions/service-slots.md): what downloads now beside the library's counts, what comes
 * up across, then what came in this week beside the machine with its version and media disks; Missing below. No
 * People: Sonarr and Radarr don't know who asked (Seerr does).
 */
export function arrSlots(input: ArrInput): Pick<KindView, 'panels' | 'slots'> {
  const s = input.snapshot;
  return slotPanels({
    live: arrLive(input),
    inventory: arrInventory(input),
    shelf: arrShelf(input),
    trend: arrWeek(s.rest?.imports, s.app, input.now, input.timeZone),
    more: asPanels(arrMore(input)),
    machine: arrMachineLines(s),
  });
}

/** The page's Sonarr or Radarr part (SD-24); pure apart from the pictures. */
export function arrView(input: ArrInput): KindView {
  const s = input.snapshot;
  const name = NAME[s.app];
  const facts: ThingLine[] = [];
  if (s.rest?.version) facts.push(line(`${name} **${s.rest.version}**`));
  const notices = arrNotices(input);
  return {
    // In slots its figures are in Downloading now and Your library; the card keeps them (`arrSeen`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: asNotices(notices),
    ...statusFrom(downloading(s.queue) ? `Downloading ${plural(s.queue?.total ?? 0, 'item')}` : null),
    ...arrSlots(input),
    tabs: [],
    facts,
    open: { label: `Open ${name}`, url: input.url },
    actions: [],
    readAt: s.readAt,
    verdict: arrVerdict(s),
    ...(downloading(s.queue) ? { refreshS: 5 } : {}),
    suggestions:
      s.app === 'sonarr'
        ? ['Series ending soon', 'Biggest series on disk', 'Episodes this week']
        : ['Movies added this month', 'Biggest movies on disk', 'Releases this month'],
  };
}

/* The page ---------------------------------------------------------------------------------------------------------- */

export function arrUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (str(row.fields.url) ?? row.baseUrl).replace(/\/+$/, '');
}

function arrPage(app: ArrApp) {
  return async (ctx: KindCtx): Promise<KindView> => {
    const { services, row, now } = ctx;
    const url = arrUrl(row);
    const [rest, queue, sab] = await Promise.all([
      latestRead(
        services,
        restKey(app, row),
        row,
        deadline(app, () => readRest(services, row, app, now)),
      ),
      liveRead(
        services,
        queueKey(app, row),
        row,
        deadline(app, () => readQueue(services, row, app)),
        { liveS: ARR_LIVE_S },
      ),
      siblingRow(ctx, ['sabnzbd']).catch(() => null),
    ]);
    if (!rest.ok && !queue.ok)
      return {
        charts: [],
        machine: 'after',
        notices: [],
        panels: [],
        tabs: [],
        facts: [],
        open: { label: `Open ${NAME[app]}`, url },
        actions: [],
        readAt: null,
        suggestions: [],
        problem: problemOf(rest.error, NAME[app]).message,
        refreshing: rest.refreshing || queue.refreshing,
      };
    // Through the API, with the key: a Sonarr or Radarr that asks for a sign-in answers `/MediaCover/` with its login
    // page, even with the key.
    const posters = prefixAllows(ctx, '/api/v3/mediacover/');
    let budget = 36;
    const view = arrView({
      snapshot: {
        readAt: rest.ok ? rest.at : queue.at,
        app,
        rest: rest.ok ? rest.value : null,
        queue: queue.ok ? queue.value : null,
      },
      now,
      timeZone: ctx.timeZone,
      who: { row },
      url,
      sabnzbd: sab ? { href: sab.href, name: sab.name } : null,
      poster: (id, title) =>
        posters && id !== null && budget-- > 0
          ? picture(ctx, `/api/v3/mediacover/${id}/poster-250.jpg`, title)
          : undefined,
    });
    const problem = !rest.ok
      ? problemOf(rest.error, NAME[app]).message
      : !queue.ok
        ? problemOf(queue.error, NAME[app]).message
        : rest.value.unread?.includes('calendar')
          ? `Whombat couldn’t read ${NAME[app]}’s calendar just now.`
          : undefined;
    return { ...view, ...(problem ? { problem } : {}), refreshing: rest.refreshing || queue.refreshing };
  };
}

/**
 * What's downloading, for the desk's calm glance (desk-display-server.md DK-S141): how many download now, what the first
 * is for and how far they are; going on while one downloads. A queue that only waits says how many wait. Nothing when the
 * queue couldn't be read.
 */
export function arrActivity(queue: ArrQueue | null): ConnectionActivity | undefined {
  if (!queue) return undefined;
  const now = queue.items.filter((i) => i.status === 'downloading');
  if (now.length === 0)
    return queue.total > 0
      ? { active: false, value: `${queue.total} in the queue` }
      : { active: false, value: 'Nothing downloading' };
  const size = now.reduce((a, i) => a + (i.sizeBytes ?? 0), 0);
  const left = now.reduce((a, i) => a + (i.leftBytes ?? 0), 0);
  const first = now[0] as ArrQueueItem;
  return {
    active: true,
    value: `${now.length} downloading`,
    detail: clip(first.forWhat ?? first.title, 120),
    ...(size > 0 ? { progress: Math.max(0, Math.min(100, Math.round((1 - left / size) * 100))) } : {}),
  };
}

/** The card (SD-05): Missing, Downloading, Disk free. */
function arrSeen(app: ArrApp) {
  return async (
    services: Services,
    row: CatalogConnectionRow,
    now: Date,
    timeZone: string,
  ): Promise<KindSeen> => {
    const snapshot = await arrSnapshot(services, row, app, now);
    const input: ArrInput = {
      snapshot,
      now,
      timeZone,
      who: { row },
      url: arrUrl(row),
      sabnzbd: null,
      poster: () => undefined,
    };
    const kpis = arrKpis(input).filter((k) => k.key !== 'library');
    const lib = snapshot.rest?.library;
    const notices = arrNotices(input);
    const activity = arrActivity(snapshot.queue);
    return {
      glance: {
        ...seenFromView(
          { kpis, notices: asNotices(notices) },
          {
            line: lib
              ? app === 'sonarr'
                ? plural(lib.count, 'series', 'series')
                : plural(lib.count, 'movie')
              : NAME[app],
          },
        ),
        ...(activity ? { activity } : {}),
      },
      points: {},
      ...linesSeen({ notices }, arrSkipped(snapshot)),
    };
  };
}

/* Buttons (SD-07) ------------------------------------------------------------------------------------------------------ */

function searchMissing(app: ArrApp): KindAction {
  return async (ctx) => {
    await actAs(ctx.services, ctx.row, NAME[app], {
      method: 'POST',
      path: v3('command'),
      body: { name: app === 'sonarr' ? 'MissingEpisodeSearch' : 'MissingMoviesSearch' },
    });
    const what = app === 'sonarr' ? 'missing episodes' : 'missing movies';
    return {
      message: `${NAME[app]} is searching for the ${what}.`,
      title: `Searched for ${what} in ${NAME[app]}`,
    };
  };
}

function arrKind(app: ArrApp): KindModule {
  return {
    page: arrPage(app),
    prefetch: (services, row, now) => arrSnapshot(services, row, app, now),
    seen: arrSeen(app),
    asksFirst: 'deleting and settings ask first',
    actions: { search_missing: searchMissing(app) },
    liveS: ARR_LIVE_S,
    checks: arrChecks(app),
    activityLine: 'What’s downloading',
  };
}

export const SONARR_KIND = arrKind('sonarr');
export const RADARR_KIND = arrKind('radarr');
