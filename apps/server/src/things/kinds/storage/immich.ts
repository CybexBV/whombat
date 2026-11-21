/**
 * Immich's page (service-dashboards.md SD-55, SD-S17), in slots (service-slots.md): what it works on now (the job queues
 * with something to do, with Resume), how many photos and videos with what came in this week, what was added lately
 * (square thumbnails), photos and videos added per day, who uses the most space (by name), its version and photo disk
 * in the machine card, and On this day and Favourites below. Read with the
 * connection's key under `/api/`: `server/storage`, `server/statistics` (an admin's key; else the key's own
 * `assets/statistics`), `server/version` and `server/version-check`, the queues (`/api/queues`, 2.4+, else `/api/jobs`),
 * `admin/integrity/summary` where it exists (3.0), and the newest assets (`POST /api/search/metadata`, a read). The page
 * also reads this day's memories from earlier years (`GET /api/memories?for=<day>&type=on_this_day`, `memory.read`,
 * kept an hour; a key without it leaves the panel out), and a dozen of the person's favourite photos picked at random
 * (`POST /api/search/random` with `isFavorite`, `asset.read`, a read; kept an hour), for a screen's photo frame.
 *
 * What came in per day: an admin's key reads the whole server's totals, which keep no history, so the health pass keeps
 * them as points (`immich_photos`, `immich_videos`) and the page draws the change a day once two days have one. Any
 * other key counts its own uploads per day (`POST /api/search/statistics` with `createdAfter`/`createdBefore`, upload
 * times; searches only ever see the key's own library), kept 15 minutes.
 *
 * Button (SD-07): **Resume** a paused queue (`PUT /api/queues/{name}`, else `PUT /api/jobs/{name}`), everyday (SD-08).
 * Never empties a queue or deletes anything (SD-02).
 */
import {
  type ThingGalleryItem,
  type ThingLine,
  type ThingPageBar,
  type ThingPageItem,
  type ThingPageKpi,
  type ThingPagePanel,
  zonedInstant,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { badRequest } from '../../../lib/errors';
import type { Services } from '../../../services';
import { readPoints } from '../../points';
import type { KindCheck } from '../../quiet/types';
import type { RawPoint } from '../../series';
import { bytes, clip, dateOf, line, list, num, plural, rec, str, thousands, when } from '../../words';
import { actAs } from '../act';
import { cachedRead, KIND_DEADLINE_MS, latestRead, problemOf, withDeadline } from '../read';
import type { KindAction, KindModule } from '../registry';
import { declaredSettings } from '../settings';
import {
  addedNote,
  countLine,
  daysWith,
  inventory,
  lastDays,
  liveList,
  people,
  pointsByDay,
  shelf,
  slotPanels,
  trend,
  weekChange,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import { IMMICH_SETTINGS } from './immich-settings';
import { fixed, fullness, itemLines, type KindNotice, lookInto, newer, UNTIL } from './lines';
import { ifPresent, optional, readJson } from './net';
import {
  type ButtonCtx,
  bareVersion,
  button,
  cardOf,
  fullTone,
  noPictures,
  olderThan,
  type Picture,
  picturesOf,
  seenOf,
  serviceUrl,
  statusOf,
  unreadView,
  usedKpi,
  usedOf,
  worstFirst,
} from './shared';

const NAME = 'Immich';
/** The newest assets on the page (SD-55: the last 12). */
export const RECENT_MAX = 12;
/** On this day: a few photos of each earlier year, at most this many in all. */
const MEMORY_PHOTOS = 3;
const MEMORIES_MAX = 12;
/** This day's memories are made once a day: read again after an hour. */
const MEMORIES_KEEP_MS = 3600_000;
/** Favourites: a dozen picked at random, a new dozen every hour. */
export const FAVOURITES_MAX = 12;
const FAVOURITES_KEEP_MS = 3600_000;
/** The whole server's photos and videos (an admin's key), kept by the health pass for what came in per day. */
export const IMMICH_PHOTOS_KEY = 'immich_photos';
export const IMMICH_VIDEOS_KEY = 'immich_videos';
/** The key's own uploads per day are counted again after 15 minutes. */
const ADDED_KEEP_MS = 900_000;
const DAY_MS = 86_400_000;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface ImmichQueue {
  name: string;
  paused: boolean;
  active: number;
  waiting: number;
  failed: number;
}

export interface ImmichAsset {
  id: string;
  video: boolean;
  name: string;
  taken: Date | null;
}

/** One of this day's memories: a year, and a few of its photos with where they were taken. */
export interface ImmichMemory {
  year: number;
  photos: { id: string; name: string; city: string | null }[];
}

/** One of the person's favourite photos: where and when it was taken. */
export interface ImmichFavourite {
  id: string;
  name: string;
  city: string | null;
  taken: Date | null;
}

export interface ImmichPerson {
  id: string;
  name: string;
  photos: number;
  videos: number;
  usage: number;
  quota: number | null;
}

export interface ImmichSnapshot {
  readAt: Date;
  version: string | null;
  latest: string | null;
  /** The whole server's (an admin's key), else the key's own library (`mine`). */
  counts: {
    photos: number;
    videos: number;
    photoBytes: number | null;
    videoBytes: number | null;
    mine: boolean;
  } | null;
  disk: { size: number; used: number } | null;
  people: ImmichPerson[];
  queues: ImmichQueue[] | null;
  /** Which API the queues came from: their Resume goes back the same way. */
  queueApi: 'queues' | 'jobs' | null;
  integrity: { missing: number; untracked: number; mismatched: number } | null;
  recent: ImmichAsset[] | null;
  /** The key's own albums and those shared (`/api/albums/statistics`); absent or null: not read. */
  albums?: { owned: number; shared: number } | null;
  /** The people Immich recognised in the key's library (`/api/people`); absent or null: not read. */
  faces?: number | null;
}

/** `/api/server/storage`. */
export function parseStorage(body: unknown): ImmichSnapshot['disk'] {
  const b = rec(body);
  const size = num(b.diskSizeRaw);
  const used = num(b.diskUseRaw);
  return size && used !== null ? { size, used } : null;
}

/** `/api/server/statistics` (admin). */
export function parseStatistics(body: unknown): {
  counts: NonNullable<ImmichSnapshot['counts']>;
  people: ImmichPerson[];
} {
  const b = rec(body);
  const people = list(b.usageByUser).flatMap((raw) => {
    const u = rec(raw);
    const id = str(u.userId);
    if (!id) return [];
    return [
      {
        id,
        name: clip(str(u.userName) ?? 'Someone', 60),
        photos: num(u.photos) ?? 0,
        videos: num(u.videos) ?? 0,
        usage: num(u.usage) ?? 0,
        quota: num(u.quotaSizeInBytes),
      },
    ];
  });
  return {
    counts: {
      photos: num(b.photos) ?? 0,
      videos: num(b.videos) ?? 0,
      photoBytes: num(b.usagePhotos),
      videoBytes: num(b.usageVideos),
      mine: false,
    },
    people,
  };
}

/** `/api/assets/statistics`: the key's own library. */
export function parseOwnStatistics(body: unknown): ImmichSnapshot['counts'] {
  const b = rec(body);
  const photos = num(b.images);
  const videos = num(b.videos);
  return photos === null && videos === null
    ? null
    : { photos: photos ?? 0, videos: videos ?? 0, photoBytes: null, videoBytes: null, mine: true };
}

/** `/api/albums/statistics`: the key's own albums and those shared. */
export function parseAlbums(body: unknown): ImmichSnapshot['albums'] {
  const b = rec(body);
  const owned = num(b.owned);
  return owned === null ? null : { owned, shared: num(b.shared) ?? 0 };
}

/** `/api/server/version` (`{major, minor, patch}`). */
export function parseVersion(body: unknown): string | null {
  const b = rec(body);
  const [major, minor, patch] = [num(b.major), num(b.minor), num(b.patch)];
  return major !== null && minor !== null ? `${major}.${minor}.${patch ?? 0}` : null;
}

/** A queue's numbers from 2.4's `statistics` or the older `jobCounts`. */
function queueOf(name: string, counts: Record<string, unknown>, paused: boolean): ImmichQueue {
  return {
    name,
    paused,
    active: num(counts.active) ?? 0,
    waiting: (num(counts.waiting) ?? 0) + (num(counts.delayed) ?? 0) + (num(counts.paused) ?? 0),
    failed: num(counts.failed) ?? 0,
  };
}

/** `GET /api/queues` (2.4+): a list, or an object by name. */
export function parseQueues(body: unknown): ImmichQueue[] {
  const entries: [string, Record<string, unknown>][] = Array.isArray(body)
    ? body.map((q) => [str(rec(q).name) ?? '', rec(q)])
    : Object.entries(rec(body)).map(([k, v]) => [k, rec(v)]);
  return entries
    .filter(([name]) => !!name)
    .map(([name, q]) =>
      queueOf(
        name,
        rec(q.statistics ?? q.jobCounts),
        q.isPaused === true || rec(q.queueStatus).isPaused === true,
      ),
    );
}

/** `GET /api/jobs` (before 2.4): `{ <name>: { jobCounts, queueStatus } }`. */
export function parseJobs(body: unknown): ImmichQueue[] {
  return Object.entries(rec(body)).map(([name, v]) => {
    const q = rec(v);
    return queueOf(name, rec(q.jobCounts), rec(q.queueStatus).isPaused === true);
  });
}

/** `/api/admin/integrity/summary` (3.0): missing, untracked and mismatched files, in either spelling. */
export function parseIntegrity(body: unknown): ImmichSnapshot['integrity'] {
  const counts: Record<string, number> = {};
  if (Array.isArray(body))
    for (const raw of body) {
      const r = rec(raw);
      const type = str(r.type);
      const n = num(r.count);
      if (type && n !== null) counts[type.replace(/[_-]/g, '').toLowerCase()] = n;
    }
  else
    for (const [k, v] of Object.entries(rec(body)))
      if (num(v) !== null) counts[k.replace(/[_-]/g, '').toLowerCase()] = num(v) as number;
  if (!Object.keys(counts).length) return null;
  return {
    missing: counts.missingfile ?? counts.missingfiles ?? counts.missing ?? 0,
    untracked: counts.untrackedfile ?? counts.untrackedfiles ?? counts.untracked ?? 0,
    mismatched: counts.checksummismatch ?? counts.checksummismatches ?? 0,
  };
}

/** `POST /api/search/metadata`: the newest assets. */
export function parseRecent(body: unknown): ImmichAsset[] {
  return list(rec(rec(body).assets).items)
    .slice(0, RECENT_MAX)
    .flatMap((raw) => {
      const a = rec(raw);
      const id = str(a.id);
      if (!id || !/^[0-9a-f-]{8,64}$/i.test(id)) return [];
      return [
        {
          id,
          video: str(a.type) === 'VIDEO',
          name: clip(str(a.originalFileName) ?? (str(a.type) === 'VIDEO' ? 'Video' : 'Photo'), 120),
          taken: dateOf(a.localDateTime) ?? dateOf(a.fileCreatedAt),
        },
      ];
    });
}

/** `GET /api/memories`: this day's memories of earlier years, the latest year first; photos only. */
export function parseMemories(body: unknown): ImmichMemory[] {
  const out: ImmichMemory[] = [];
  for (const m of list(body).map(rec)) {
    const year = num(rec(m.data).year);
    if (!year || (str(m.type) ?? 'on_this_day') !== 'on_this_day' || m.deletedAt) continue;
    const photos = list(m.assets)
      .map(rec)
      .flatMap((a) => {
        const id = str(a.id);
        if (!id || !/^[0-9a-f-]{8,64}$/i.test(id) || str(a.type) !== 'IMAGE' || a.isTrashed === true)
          return [];
        return [
          {
            id,
            name: clip(str(a.originalFileName) ?? 'Photo', 120),
            city: str(rec(a.exifInfo).city),
          },
        ];
      })
      .slice(0, MEMORY_PHOTOS);
    if (photos.length) out.push({ year, photos });
  }
  return out.sort((a, b) => b.year - a.year);
}

/** `POST /api/search/random`: favourite photos, in the order Immich picked them; videos and trashed ones left out. */
export function parseFavourites(body: unknown): ImmichFavourite[] {
  return list(body)
    .map(rec)
    .flatMap((a) => {
      const id = str(a.id);
      if (!id || !/^[0-9a-f-]{8,64}$/i.test(id) || str(a.type) !== 'IMAGE' || a.isTrashed === true) return [];
      return [
        {
          id,
          name: clip(str(a.originalFileName) ?? 'Photo', 120),
          city: str(rec(a.exifInfo).city),
          taken: dateOf(a.localDateTime) ?? dateOf(a.fileCreatedAt),
        },
      ];
    })
    .slice(0, FAVOURITES_MAX);
}

/** A dozen favourite photos picked at random, kept an hour; null when the key may not search. */
export function readFavourites(
  services: Services,
  row: CatalogConnectionRow,
): Promise<ImmichFavourite[] | null> {
  return optional(
    cachedRead(
      services,
      `immich-favourites:${row.id}`,
      row,
      async () =>
        parseFavourites(
          await readJson(services, row, NAME, {
            path: '/api/search/random',
            method: 'POST',
            body: { isFavorite: true, type: 'IMAGE', size: FAVOURITES_MAX, withExif: true },
          }),
        ),
      FAVOURITES_KEEP_MS,
    ),
  );
}

/** This day's memories (`for` is the day where the person is), kept an hour; null when the key may not read them. */
export function readMemories(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<ImmichMemory[] | null> {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  return optional(
    cachedRead(
      services,
      `immich-memories:${row.id}:${day}`,
      row,
      async () =>
        parseMemories(
          await readJson(services, row, NAME, {
            path: '/api/memories',
            query: { for: day, type: 'on_this_day' },
          }),
        ),
      MEMORIES_KEEP_MS,
    ),
  );
}

/** What the key itself uploaded: per day of the last 7 (today last), the 7 days before, and this week's photos. */
export interface ImmichAdded {
  days: number[];
  before: number;
  photos: number;
}

/** A local day's first instant (“2026-11-04” in the burrow's zone). */
function dayStart(key: string, timeZone: string): Date {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return zonedInstant({ year, month, day }, '00:00', timeZone);
}

/**
 * The key's own uploads per day (`POST /api/search/statistics`, upload times), kept 15 minutes: one count a day, one
 * for the week before and one of this week's photos; null when the key may not search.
 */
export function readAdded(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<ImmichAdded | null> {
  const days = lastDays(now, timeZone, 8);
  const starts = days.keys.map((k) => dayStart(k, timeZone));
  const count = async (body: Record<string, unknown>) =>
    num(
      rec(await readJson(services, row, NAME, { path: '/api/search/statistics', method: 'POST', body }))
        .total,
    ) ?? 0;
  const between = (from: Date, to?: Date) => ({
    createdAfter: from.toISOString(),
    ...(to ? { createdBefore: to.toISOString() } : {}),
  });
  return optional(
    cachedRead(
      services,
      `immich-added:${row.id}:${days.keys[7]}`,
      row,
      async () => {
        const week = starts[1] as Date;
        const [perDay, before, photos] = await Promise.all([
          Promise.all(starts.slice(1).map((from, i) => count(between(from, starts[i + 2])))),
          count(between(new Date(week.getTime() - 7 * DAY_MS), week)),
          count({ ...between(week), type: 'IMAGE' }),
        ]);
        return { days: perDay, before, photos };
      },
      ADDED_KEEP_MS,
    ),
  );
}

export async function readImmich(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<ImmichSnapshot> {
  const get = (path: string) => readJson(services, row, NAME, { path });
  const [storage, stats, version, check, queues, integrity, recent, albums, faces] = await Promise.all([
    get('/api/server/storage'),
    optional(ifPresent(get('/api/server/statistics'), { forbiddenToo: true })),
    optional(get('/api/server/version')),
    optional(get('/api/server/version-check')),
    optional(ifPresent(get('/api/queues'))),
    optional(ifPresent(get('/api/admin/integrity/summary'))),
    optional(
      readJson(services, row, NAME, {
        path: '/api/search/metadata',
        method: 'POST',
        body: { order: 'desc', size: RECENT_MAX },
      }),
    ),
    optional(get('/api/albums/statistics')),
    optional(readJson(services, row, NAME, { path: '/api/people', query: { size: '1' } })),
  ]);
  const parsed = stats ? parseStatistics(stats) : null;
  // Not an admin's key: its own library.
  const own = parsed ? null : await optional(get('/api/assets/statistics'));
  // Before 2.4 the queues are “jobs”.
  const jobs = queues === null ? await optional(get('/api/jobs')) : null;
  return {
    readAt: now,
    version: parseVersion(version),
    latest: bareVersion(str(rec(check).releaseVersion)),
    counts: parsed?.counts ?? (own ? parseOwnStatistics(own) : null),
    disk: parseStorage(storage),
    people: parsed?.people ?? [],
    queues: queues !== null ? parseQueues(queues) : jobs !== null ? parseJobs(jobs) : null,
    queueApi: queues !== null ? 'queues' : jobs !== null ? 'jobs' : null,
    integrity: integrity !== null ? parseIntegrity(integrity) : null,
    recent: recent !== null ? parseRecent(recent) : null,
    albums: albums !== null ? parseAlbums(albums) : null,
    faces: faces !== null ? num(rec(faces).total) : null,
  };
}

function load(services: Services, row: CatalogConnectionRow, now: Date) {
  return async () => {
    try {
      return await withDeadline(
        readImmich(services, row, now),
        KIND_DEADLINE_MS,
        `${NAME} didn’t answer in time.`,
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

export function immichLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, `immich:${row.id}`, row, load(services, row, now));
}

export function immichSnapshot(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return cachedRead(services, `immich:${row.id}`, row, load(services, row, now));
}

/* Words -------------------------------------------------------------------------------------------------------------- */

const QUEUE_NAMES: Record<string, string> = {
  thumbnailGeneration: 'Thumbnails',
  metadataExtraction: 'Metadata',
  videoConversion: 'Video conversion',
  faceDetection: 'Face detection',
  facialRecognition: 'Face recognition',
  smartSearch: 'Smart search',
  duplicateDetection: 'Duplicates',
  backgroundTask: 'Background tasks',
  storageTemplateMigration: 'Storage template',
  migration: 'Migration',
  search: 'Search',
  sidecar: 'Sidecar files',
  library: 'External libraries',
  notifications: 'Notifications',
  backupDatabase: 'Database backup',
  ocr: 'Text recognition',
  workflow: 'Workflows',
};

/** A queue as people name it: `thumbnailGeneration` → “Thumbnails”, an unknown one in words. */
export function queueName(name: string): string {
  const known = QUEUE_NAMES[name];
  if (known) return known;
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return clip(words.charAt(0).toUpperCase() + words.slice(1), 40);
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface ImmichInput {
  snapshot: ImmichSnapshot;
  now: Date;
  timeZone: string;
  url: string;
  buttons: ButtonCtx;
  picture: Picture;
  /** This day's memories; absent or null: not read. */
  memories?: ImmichMemory[] | null;
  /** A dozen favourite photos; absent or null: not read. */
  favourites?: ImmichFavourite[] | null;
  /** The server's totals as the health pass kept them, for the last 15 days; absent: not read. */
  points?: { photos: RawPoint[]; videos: RawPoint[] } | null;
  /** The key's own uploads per day (a key that isn't an admin's); absent or null: not read. */
  added?: ImmichAdded | null;
}

const waitingOf = (qs: readonly ImmichQueue[]) => qs.reduce((a, q) => a + q.waiting, 0);

/** The card's figures (Photos and Disk are its two). */
export function figures(s: ImmichSnapshot): ThingPageKpi[] {
  const out: ThingPageKpi[] = [];
  if (s.counts) {
    out.push({
      key: 'photos',
      label: 'Photos',
      value: thousands(s.counts.photos),
      ...(s.counts.photoBytes !== null
        ? { sub: bytes(s.counts.photoBytes) }
        : s.counts.mine
          ? { sub: 'In this account' }
          : {}),
    });
    out.push({
      key: 'videos',
      label: 'Videos',
      value: thousands(s.counts.videos),
      ...(s.counts.videoBytes !== null
        ? { sub: bytes(s.counts.videoBytes) }
        : s.counts.mine
          ? { sub: 'In this account' }
          : {}),
    });
  }
  if (s.disk) out.push(usedKpi('disk', 'Disk', s.disk.used, s.disk.size));
  if (s.queues) {
    const waiting = waitingOf(s.queues);
    const active = s.queues.reduce((a, q) => a + q.active, 0);
    const failed = s.queues.reduce((a, q) => a + q.failed, 0);
    const paused = s.queues.filter((q) => q.paused).length;
    const parts = [
      active ? `${thousands(active)} running` : null,
      failed ? `${thousands(failed)} failed` : null,
      paused ? `${paused} paused` : null,
    ].filter(Boolean);
    out.push({
      key: 'jobs',
      label: 'Jobs waiting',
      value: thousands(waiting),
      sub: parts.length ? parts.join(' · ') : 'All done',
      ...(failed || (paused && waiting) ? { tone: 'warn' as const } : {}),
    });
  }
  return out;
}

function resumeButton(ctx: ButtonCtx, q: ImmichQueue) {
  return button(ctx, { action: 'resume', target: q.name, label: 'Resume', icon: 'play' });
}

const queueSubject = (q: ImmichQueue) => ({ id: `queue:${q.name}`.slice(0, 160), name: queueName(q.name) });

function notices(input: ImmichInput): KindNotice[] {
  const { snapshot: s, url } = input;
  const out: KindNotice[] = [];
  if (s.disk) {
    const p = (s.disk.used / s.disk.size) * 100;
    const f = fullness(p, s.disk.size - s.disk.used);
    if (f)
      out.push({
        id: 'disk',
        ...f,
        icon: 'disk',
        title: `Immich’s disk is ${Math.round(p)} % full`,
        detail: `${usedOf(s.disk.used, s.disk.size)} used. New uploads fail when it is full.`,
        check: 'immich.disk_full',
        ignore: fixed(UNTIL.fuller),
        ...(f.nature === 'problem'
          ? { link: lookInto('What takes the space on Immich’s disk, and what can go?') }
          : {}),
      });
  }
  // Paused on purpose (during a big import): a heads-up while nothing waits, a person's to resume once jobs pile up.
  for (const q of (s.queues ?? []).filter((x) => x.paused))
    out.push({
      id: `paused-${q.name}`.slice(0, 120),
      icon: 'clock',
      title: clip(`The ${queueName(q.name).toLowerCase()} queue is paused`, 120),
      ...(q.waiting
        ? { tone: 'warn' as const, nature: 'you' as const, detail: `${plural(q.waiting, 'job')} waiting.` }
        : { tone: 'info' as const, nature: 'fyi' as const }),
      action: resumeButton(input.buttons, q),
      check: 'immich.queue_paused',
      subject: queueSubject(q),
      ignore: fixed('Until it’s resumed.'),
    });
  // Failed jobs stay counted until someone clears them: an Ignore lasts until more fail (the band is how many).
  const failed = (s.queues ?? []).filter((q) => q.failed > 0).sort((a, b) => b.failed - a.failed);
  out.push(
    ...itemLines(
      failed,
      (q) => ({
        id: `failed-${q.name}`.slice(0, 120),
        tone: 'warn',
        icon: 'warn',
        title: clip(`${queueName(q.name)} has ${plural(q.failed, 'failed job')}`, 120),
        link: { kind: 'url', label: 'Open jobs', url: `${url}/admin/jobs-status` },
        nature: 'problem',
        check: 'immich.jobs_failed',
        subject: queueSubject(q),
        band: q.failed,
        ignore: fixed('Until more jobs fail.'),
      }),
      (q) => queueSubject(q).id,
      (rest) => ({
        id: 'failed-more',
        tone: 'warn',
        icon: 'warn',
        title: `${plural(rest.length, 'more queue')} with failed jobs`,
        link: { kind: 'url', label: 'Open jobs', url: `${url}/admin/jobs-status` },
        nature: 'problem',
        check: 'immich.jobs_failed',
        band: rest.reduce((a, q) => a + q.failed, 0),
      }),
    ),
  );
  if (s.integrity) {
    const { missing, mismatched, untracked } = s.integrity;
    if (missing || mismatched)
      out.push({
        id: 'integrity',
        tone: mismatched ? 'bad' : 'warn',
        icon: 'disk',
        title: missing
          ? `${plural(missing, 'file')} missing from Immich’s disk`
          : `${plural(mismatched, 'file')} changed on disk`,
        detail: clip(
          [
            missing ? `${missing} missing` : null,
            mismatched ? `${mismatched} with a wrong checksum` : null,
            untracked ? `${untracked} untracked` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          200,
        ),
        link: { kind: 'url', label: 'Open Immich', url: `${url}/admin/repair` },
        nature: 'problem',
        check: 'immich.integrity',
        band: missing + mismatched,
        ignore: fixed('Until more files are affected.'),
      });
  }
  if (s.version && s.latest && olderThan(s.version, s.latest))
    out.push({
      id: 'update',
      tone: 'info',
      icon: 'update',
      title: `Immich ${s.latest} is out`,
      detail: `This one runs ${s.version}.`,
      link: { kind: 'url', label: 'What’s new', url: 'https://github.com/immich-app/immich/releases' },
      nature: 'fyi',
      check: 'immich.update',
      ignore: newer(UNTIL.version),
      episode: s.latest,
    });
  return worstFirst(out);
}

/** Every check Immich's lines can raise (QN-15). */
export const IMMICH_CHECKS: readonly KindCheck[] = [
  { check: 'immich.disk_full', name: 'Disk filling up', nature: 'problem', perItem: false, startsOn: true },
  { check: 'immich.queue_paused', name: 'Paused job queues', nature: 'you', perItem: true, startsOn: false },
  { check: 'immich.jobs_failed', name: 'Failed jobs', nature: 'problem', perItem: true, startsOn: false },
  {
    check: 'immich.integrity',
    name: 'Missing or changed files',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  { check: 'immich.update', name: 'Immich updates', nature: 'fyi', perItem: false, startsOn: false },
];

/** The checks this read couldn't see (QN-11): the queues, the integrity summary (3.0) or the versions. */
export function immichSkipped(s: ImmichSnapshot): string[] {
  const out: string[] = [];
  if (!s.disk) out.push('immich.disk_full');
  if (!s.queues) out.push('immich.queue_paused', 'immich.jobs_failed');
  if (!s.integrity) out.push('immich.integrity');
  if (!s.version || !s.latest) out.push('immich.update');
  return out;
}

function recentItems(input: ImmichInput): ThingGalleryItem[] {
  const { snapshot: s, now, timeZone, url, picture } = input;
  return (s.recent ?? []).map((a) => {
    const image = picture(`/api/assets/${a.id}/thumbnail?size=thumbnail`, a.name, 'square');
    return {
      id: a.id,
      title: a.name,
      ...(a.taken ? { sub: when(a.taken, now, timeZone), at: a.taken.toISOString() } : {}),
      ...(image ? { image } : {}),
      ...(a.video ? { badge: { text: 'Video', tone: 'ok' as const } } : {}),
      url: `${url}/photos/${a.id}`,
    };
  });
}

/** On this day: “3 years ago · Texel” and the year, a picture each (Immich's preview, made small by the image route). */
function memoryItems(input: ImmichInput): ThingGalleryItem[] {
  const { now, timeZone, url, picture } = input;
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(now));
  return (input.memories ?? [])
    .flatMap((m) =>
      m.photos.map((p) => {
        const back = year - m.year;
        const image = picture(`/api/assets/${p.id}/thumbnail?size=preview`, p.city ?? p.name, 'square');
        return {
          id: p.id,
          title: clip(
            [back === 1 ? 'A year ago' : `${back} years ago`, p.city].filter(Boolean).join(' · '),
            120,
          ),
          sub: String(m.year),
          ...(image ? { image } : {}),
          url: `${url}/photos/${p.id}`,
        };
      }),
    )
    .slice(0, MEMORIES_MAX);
}

/** Favourites: where and when (“Texel” “June 2019”), a picture each (Immich's preview, made small by the image route). */
function favouriteItems(input: ImmichInput): ThingGalleryItem[] {
  const { timeZone, url, picture } = input;
  return (input.favourites ?? []).map((f) => {
    const month = f.taken
      ? new Intl.DateTimeFormat('en-GB', { timeZone, month: 'long', year: 'numeric' }).format(f.taken)
      : null;
    const image = picture(`/api/assets/${f.id}/thumbnail?size=preview`, f.city ?? f.name, 'square');
    return {
      id: f.id,
      title: clip(f.city ?? month ?? 'A favourite', 120),
      ...(f.city && month ? { sub: month } : {}),
      ...(f.taken ? { at: f.taken.toISOString() } : {}),
      ...(image ? { image } : {}),
      url: `${url}/photos/${f.id}`,
    };
  });
}

/** Questions for the Working on card. */
export function immichJobsQuestions(s: ImmichSnapshot): string[] {
  const out: string[] = [];
  if ((s.queues ?? []).some((q) => q.failed > 0)) out.push('Why did some Immich jobs fail?');
  if ((s.queues ?? []).some((q) => q.paused && q.waiting > 0))
    out.push('Should I resume the paused Immich queue?');
  out.push('What is Immich working on right now?', 'How long will the waiting jobs take?');
  return out.slice(0, 3);
}

/** Questions for the In Immich card. */
export function immichLibraryQuestions(s: ImmichSnapshot): string[] {
  const out = ['Which videos take the most space in Immich?', 'How many photos were added this month?'];
  if (s.disk) out.push('How much room is left for new photos?');
  return out.slice(0, 3);
}

/** Questions for the Who uses most space card. */
export function immichPeopleQuestions(): string[] {
  return ['Who added the most photos this month?', 'Is anyone close to their storage quota?'];
}

/** One calm sentence for the head while Immich has no active problem. */
export function immichVerdict(s: ImmichSnapshot): string {
  if (s.integrity && (s.integrity.missing || s.integrity.mismatched)) {
    const n = s.integrity.missing + s.integrity.mismatched;
    return clip(`${plural(n, 'file')} ${n === 1 ? 'has' : 'have'} a problem on Immich’s disk.`, 200);
  }
  const failed = (s.queues ?? []).reduce((a, q) => a + q.failed, 0);
  if (failed > 0) return clip(`Immich has ${plural(failed, 'failed job')}.`, 200);
  const paused = (s.queues ?? []).find((q) => q.paused && q.waiting > 0);
  if (paused)
    return clip(`${queueName(paused.name)} is paused with ${plural(paused.waiting, 'job')} waiting.`, 200);
  const waiting = waitingOf(s.queues ?? []);
  const active = (s.queues ?? []).reduce((a, q) => a + q.active, 0);
  const parts: string[] = [];
  if (s.counts) parts.push(`${thousands(s.counts.photos + s.counts.videos)} photos and videos`);
  if (waiting || active) parts.push(`${plural(waiting + active, 'job')} in progress`);
  else if (s.queues) parts.push('all jobs are caught up');
  if (!parts.length && s.disk) parts.push(`${bytes(Math.max(0, s.disk.size - s.disk.used))} free`);
  return clip(parts.length ? `Immich is fine: ${parts.join(' and ')}.` : 'Immich is running fine.', 200);
}

/** Working on (Live): the queues with something to do, paused and failed first, with Resume on a paused one. */
function workingOn(input: ImmichInput) {
  const { snapshot: s, url } = input;
  const busy = (s.queues ?? []).filter((q) => q.paused || q.failed || q.active || q.waiting);
  // Every queue idle: nothing happens now, and the row closes up.
  if (!busy.some((q) => q.active || q.waiting || q.failed)) return null;
  const order = (q: ImmichQueue) => (q.paused && q.waiting ? 0 : q.failed ? 1 : q.active ? 2 : 3);
  const waiting = waitingOf(busy);
  return liveList({
    id: 'jobs',
    title: 'Working on',
    ...(waiting ? { meta: `${thousands(waiting)} waiting` } : {}),
    ask: { questions: immichJobsQuestions(s) },
    link: { kind: 'url', label: 'Open jobs', url: `${url}/admin/jobs-status` },
    items: [...busy]
      .sort((a, b) => order(a) - order(b) || b.waiting - a.waiting)
      .map((q): ThingPageItem => {
        const parts = [
          q.waiting ? `${thousands(q.waiting)} waiting` : null,
          q.paused ? 'paused' : q.active ? `${thousands(q.active)} running` : null,
          q.failed ? `${thousands(q.failed)} failed` : null,
        ].filter(Boolean);
        const warn = (q.paused && q.waiting > 0) || q.failed > 0;
        return {
          id: `queue-${q.name}`.slice(0, 200),
          title: queueName(q.name),
          detail: clip(parts.join(' · ') || 'Paused', 300),
          icon: q.paused ? 'clock' : q.failed ? 'warn' : 'photo',
          ...(warn ? { tone: 'warn' as const } : {}),
          ...(q.paused ? { actions: [resumeButton(input.buttons, q)] } : {}),
        };
      }),
    empty: 'Nothing to do.',
  });
}

/** What came in per day: the server's totals' change a day (an admin's key), else the key's own uploads. */
function cameIn(input: ImmichInput): {
  trend: ReturnType<typeof trend> | null;
  photos: number | null;
  videos: number | null;
} {
  const { snapshot: s, now, timeZone } = input;
  const none = { trend: null, photos: null, videos: null };
  if (!s.counts) return none;
  const week = lastDays(now, timeZone, 7);
  const figureOf = (n: number) =>
    n ? { value: thousands(n), rest: 'added this week' } : { value: 'None', rest: 'added this week' };
  if (s.counts.mine) {
    const a = input.added;
    if (!a) return none;
    const total = a.days.reduce((x, y) => x + y, 0);
    return {
      photos: a.photos,
      videos: Math.max(0, total - a.photos),
      trend: trend({
        id: 'week',
        title: 'Added by you',
        meta: 'Photos and videos you added per day',
        days: week,
        values: a.days,
        label: 'Added',
        figure: figureOf(total),
        change: weekChange(total, a.before),
      }),
    };
  }
  if (!input.points) return none;
  // The day's last reading; today's is what Immich says now.
  const days = lastDays(now, timeZone, 15);
  const at = (points: RawPoint[], nowValue: number) => {
    const v = pointsByDay(points, days.keys, timeZone, 'last');
    v[v.length - 1] = nowValue;
    return v;
  };
  const photos = at(input.points.photos, s.counts.photos);
  const videos = at(input.points.videos, s.counts.videos);
  const totals = photos.map((p, i) => {
    const v = videos[i];
    return p === null || v == null ? null : p + v;
  });
  // A day's change from the day before's last reading; what was deleted doesn't make a day negative.
  const change = totals.map((v, i) => {
    const prev = i ? totals[i - 1] : null;
    return v === null || prev == null ? null : Math.max(0, v - prev);
  });
  const thisWeek = change.slice(8);
  const lastWeek = change.slice(1, 8);
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
  const since = (v: (number | null)[]) => {
    const then = v[7];
    const today = v[14];
    return then == null || today == null ? null : Math.max(0, today - then);
  };
  const total = sum(thisWeek);
  return {
    photos: since(photos),
    videos: since(videos),
    trend:
      daysWith(thisWeek) < 2
        ? null
        : trend({
            id: 'week',
            title: 'This week',
            meta: 'Photos and videos added per day',
            days: week,
            values: thisWeek,
            label: 'Added',
            figure: figureOf(total),
            ...(daysWith(lastWeek) === 7 ? { change: weekChange(total, sum(lastWeek)) } : {}),
          }),
  };
}

/** In Immich (Inventory): photos and videos, with their space and what came in this week. */
function library(input: ImmichInput, added: { photos: number | null; videos: number | null }) {
  const { snapshot: s, url } = input;
  if (!s.counts) return null;
  const c = s.counts;
  const lineOf = (id: 'photos' | 'videos', n: number, used: number | null, week: number | null) =>
    countLine({
      id,
      title: id === 'photos' ? 'Photos' : 'Videos',
      icon: id === 'photos' ? 'photo' : 'video',
      ...(used !== null ? { detail: bytes(used) } : {}),
      value: thousands(n),
      ...(addedNote(week) ?? {}),
      url: `${url}/photos`,
    });
  return inventory({
    id: 'library',
    title: c.mine ? 'In your library' : 'In Immich',
    ...(c.mine ? { meta: 'This account only' } : {}),
    ask: { questions: immichLibraryQuestions(s) },
    items: [
      lineOf('photos', c.photos, c.photoBytes, added.photos),
      lineOf('videos', c.videos, c.videoBytes, added.videos),
      // Albums and people are the key's own: Immich keeps them per person.
      ...(s.albums
        ? [
            countLine({
              id: 'albums',
              title: 'Albums',
              icon: 'media',
              detail: [
                c.mine ? null : 'Yours',
                s.albums.shared ? `${thousands(s.albums.shared)} shared` : null,
              ]
                .filter(Boolean)
                .join(' · '),
              value: thousands(s.albums.owned),
              url: `${url}/albums`,
            }),
          ]
        : []),
      ...(s.faces
        ? [
            countLine({
              id: 'faces',
              title: 'People',
              icon: 'camera',
              detail: c.mine ? 'Recognised faces' : 'Recognised in your photos',
              value: thousands(s.faces),
              url: `${url}/people`,
            }),
          ]
        : []),
    ],
  });
}

/** Who uses most space (SD-55): Immich's users by name (one-person.md OP-S69), biggest first, amber near a quota. */
function whoUsesMost(input: ImmichInput) {
  const users = [...input.snapshot.people].sort((a, b) => b.usage - a.usage);
  return people({
    title: 'Who uses most space',
    meta: plural(users.length, 'person', 'people'),
    ask: { questions: immichPeopleQuestions() },
    items: users.map((p) => {
      const tone = p.quota ? fullTone((p.usage / p.quota) * 100) : undefined;
      return {
        name: p.name,
        n: p.usage,
        note: `${thousands(p.photos)} photos · ${thousands(p.videos)} videos`,
        value: bytes(p.usage),
        ...(p.quota ? { sub: `Quota ${bytes(p.quota)}` } : {}),
        ...(tone ? { tone } : {}),
      };
    }),
  });
}

/** Immich's lines in the machine card: its version and whether a newer one is out, and the disk its photos are on. */
export function immichMachineLines(s: ImmichSnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.version)
    out.push({
      id: 'immich-version',
      label: 'Immich',
      value: s.version,
      pct: null,
      ...(s.latest && olderThan(s.version, s.latest)
        ? { sub: clip(`Version ${s.latest} is out`, 120) }
        : s.latest
          ? { sub: 'Up to date', subTone: 'ok' as const }
          : {}),
    });
  if (s.disk) {
    const tone = fullTone((s.disk.used / s.disk.size) * 100);
    out.push({
      id: 'photo-disk',
      label: 'Photo disk',
      value: usedOf(s.disk.used, s.disk.size),
      pct: Math.min(1, Math.max(0, s.disk.used / s.disk.size)),
      sub: `${bytes(Math.max(0, s.disk.size - s.disk.used))} free`,
      ...(tone ? { tone, subTone: tone } : {}),
    });
  }
  return out;
}

/** The page's Immich part (SD-55), in slots, from what was read; pure. */
export function immichView(input: ImmichInput): KindView {
  const { snapshot: s, url } = input;
  const more: ThingPagePanel[] = [];
  if (input.memories)
    more.push({
      kind: 'gallery',
      id: 'memories',
      place: 'main',
      // One row that fills the width, as the Shelf: never a half-empty second row.
      look: 'shelf',
      shape: 'square',
      title: 'On this day',
      meta: 'Earlier years',
      items: memoryItems(input),
      empty: 'No photos from this day in earlier years.',
    });
  if (input.favourites)
    more.push({
      kind: 'gallery',
      id: 'favourites',
      place: 'main',
      // One row that fills the width, as the Shelf: never a half-empty second row.
      look: 'shelf',
      shape: 'square',
      title: 'Favourites',
      meta: 'A few at random',
      link: { kind: 'url', label: 'Open favourites', url: `${url}/favorites` },
      items: favouriteItems(input),
      empty: 'No favourites yet. Mark a photo with the heart in Immich.',
    });
  const week = cameIn(input);
  const recent = s.recent
    ? shelf({
        id: 'recent',
        title: 'Recently added',
        meta: 'Newest first',
        shape: 'square',
        link: { kind: 'url', label: 'Open Immich', url: `${url}/photos` },
        items: recentItems(input),
        empty: 'Nothing here yet.',
      })
    : null;

  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`Immich **${s.version}**`));
  if (s.counts)
    facts.push(
      line(
        `**${thousands(s.counts.photos + s.counts.videos)}** photos and videos${s.counts.mine ? ' in this account' : ''}`,
      ),
    );
  const shown = notices(input);
  return {
    // Its counts are in In Immich and Working on; the card keeps its figures (`figures`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: shown,
    ...slotPanels({
      live: workingOn(input),
      inventory: library(input, week),
      shelf: recent,
      trend: week.trend,
      people: whoUsesMost(input),
      more,
      machine: immichMachineLines(s),
    }),
    tabs: [],
    facts,
    status: statusOf(shown, s.counts ? `${thousands(s.counts.photos)} photos` : 'Running fine'),
    open: { label: 'Open Immich', url },
    actions: [],
    readAt: s.readAt,
    verdict: immichVerdict(s),
    suggestions: ['Photos per month', 'Biggest videos', 'Who added the most'],
  };
}

/** The server's totals as points for the health pass: only an admin's key sees them, a key's own library isn't kept. */
export function immichPoints(s: ImmichSnapshot): Record<string, number> {
  return s.counts && !s.counts.mine
    ? { [IMMICH_PHOTOS_KEY]: s.counts.photos, [IMMICH_VIDEOS_KEY]: s.counts.videos }
    : {};
}

/** The server's totals over the last 15 days (two weeks of changes and the day before them). */
async function readTotals(services: Services, rowId: string, now: Date) {
  const points = await readPoints(
    services.db,
    rowId,
    [IMMICH_PHOTOS_KEY, IMMICH_VIDEOS_KEY],
    now,
    15 * DAY_MS,
  ).catch(() => null);
  return points
    ? { photos: points.get(IMMICH_PHOTOS_KEY) ?? [], videos: points.get(IMMICH_VIDEOS_KEY) ?? [] }
    : null;
}

/* The page ----------------------------------------------------------------------------------------------------------- */

export async function immichPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = serviceUrl(row);
  const [read, memories, favourites] = await Promise.all([
    immichLatest(services, row, now),
    readMemories(services, row, now, ctx.timeZone),
    readFavourites(services, row),
  ]);
  if (!read.ok) return unreadView(NAME, url, problemOf(read.error, NAME).message, read.refreshing);
  const counts = read.value.counts;
  // The server's totals come from the health pass's points; a key's own library from its searches.
  const [points, added] = await Promise.all([
    counts && !counts.mine ? readTotals(services, row.id, now) : null,
    counts?.mine ? readAdded(services, row, now, ctx.timeZone) : null,
  ]);
  const view = immichView({
    snapshot: read.value,
    now,
    timeZone: ctx.timeZone,
    url,
    buttons: ctx,
    picture: picturesOf(ctx),
    memories,
    favourites,
    points,
    added,
  });
  return { ...view, refreshing: read.refreshing };
}

/* Buttons (SD-07, SD-08) --------------------------------------------------------------------------------------------- */

/** Resume: a paused queue goes on (2.4's `PUT /api/queues/{name}`, else the older jobs command); everyday. */
export const resumeQueue: KindAction = async ({ services, row, now }, { target }) => {
  const s = await immichSnapshot(services, row, now);
  const q = (s.queues ?? []).find((x) => x.name === target);
  if (!q) throw badRequest('Choose one of the queues on the page.');
  const name = encodeURIComponent(q.name);
  if (s.queueApi === 'jobs')
    await actAs(services, row, NAME, {
      method: 'PUT',
      path: `/api/jobs/${name}`,
      body: { command: 'resume', force: false },
    });
  else
    await actAs(services, row, NAME, {
      method: 'PUT',
      path: `/api/queues/${name}`,
      body: { isPaused: false },
    });
  return {
    message: `${queueName(q.name)} goes on.`,
    title: clip(`Resumed ${queueName(q.name).toLowerCase()} in Immich`, 200),
    everyday: true,
  };
};

export const IMMICH_KIND: KindModule = {
  page: immichPage,
  prefetch: (services, row, now) => immichLatest(services, row, now),
  async seen(services, row, now, timeZone) {
    const s = await immichSnapshot(services, row, now);
    const view = immichView({
      snapshot: s,
      now,
      timeZone,
      url: serviceUrl(row),
      buttons: { row },
      picture: noPictures,
    });
    return {
      ...seenOf(
        cardOf(
          { kpis: figures(s), notices: view.notices },
          ['photos', 'disk'],
          s.version ? `Photos · Immich ${s.version}` : 'Photos',
        ),
        view.notices as KindNotice[],
        immichSkipped(s),
      ),
      points: immichPoints(s),
    };
  },
  asksFirst: 'deleting and settings ask first',
  actions: { resume: resumeQueue },
  settings: declaredSettings(IMMICH_SETTINGS),
  checks: IMMICH_CHECKS,
};
