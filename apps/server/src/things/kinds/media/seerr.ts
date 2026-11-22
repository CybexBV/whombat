/**
 * Seerr's page and card (service-dashboards.md SD-21, SD-04, SD-05, SD-10; SD-S12): what waits for approval, what is
 * on its way and how far its download is (Seerr's own download status, linking to SABnzbd's page), what just became
 * available, and the open issues — with Approve, Decline, Retry and Mark resolved. Catalog `overseerr`: Seerr 3,
 * Overseerr and Jellyseerr answer the same `/api/v1` with `X-Api-Key`. Requests carry no titles: each title and poster
 * comes from `/movie/<tmdbId>` or `/tv/<tmdbId>`, at most 12 new ones per read, each kept an hour (SD-S05); posters from
 * TMDB's public image host. Requesters by name. Its Summary is in slots (docs/service-pages.md): what waits for a yes,
 * the requests by state, what just became available, this week's requests and who asks, from the newest 100 requests
 * (`filter=all`) kept 10 minutes.
 */
import type { ThingLine, ThingPageBar, ThingPageKpi } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { ConnectionActivity } from '../../../home/types';
import { ApiError, badRequest, conflict, forbidden } from '../../../lib/errors';
import type { Services } from '../../../services';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { clip, dateOf, line, list, num, plural, rec, span, str, thousands, when } from '../../words';
import { actAs } from '../act';
import { cachedRead, getJson, KIND_DEADLINE_MS, latestRead, problemOf, withDeadline } from '../read';
import type { KindAction, KindActionCtx, KindModule, KindSeen } from '../registry';
import { seenFromView } from '../registry';
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
  idOf,
  itemLines,
  leftWords,
  linesSeen,
  optional,
  picture,
  share,
  siblingRow,
  statusFrom,
  uniqueById,
  worstFirst,
} from './common';
import { asNotices, type ButtonCtx, button, type GalleryItem, type Item, type Panel } from './ui';

const NAME = 'Seerr';
const H = 3600_000;
const DAY = 24 * H;
/** Titles and posters read per read at most, and how long each is kept (SD-S05). */
export const TITLE_READS_MAX = 12;
export const TITLE_KEEP_MS = H;
/** Open issues one read lists at most (`take`). */
const ISSUES_READ = 10;
/** Requests the page's week reads at most (newest first), and how long it is kept: Trend, People, Inventory's week. */
export const REQUESTS_READ = 100;
export const WEEK_KEEP_MS = 10 * 60_000;
/** Just available: read, and the most its shelf shows with their titles. */
const AVAILABLE_READ = 20;
const SHELF_MAX = 12;
/** Seerr 3.4 brought security fixes (SD-21). */
const SAFE_VERSION = [3, 4] as const;

/* Reading ------------------------------------------------------------------------------------------------------------ */

/** Seerr's request statuses. */
export const REQUEST = { pending: 1, approved: 2, declined: 3, failed: 4, completed: 5 } as const;

export interface SeerrDownload {
  title: string;
  sizeBytes: number | null;
  leftBytes: number | null;
  /** When it should be done (Seerr's estimate), or null. */
  eta: Date | null;
  status: string | null;
}

export interface SeerrRequest {
  id: number;
  status: number;
  type: 'movie' | 'tv';
  tmdbId: number | null;
  at: Date | null;
  updatedAt: Date | null;
  seasons: number[];
  /** The requester's name. */
  by: string | null;
  is4k: boolean;
  downloads: SeerrDownload[];
  /** Plex's ratingKey of the title, when Seerr knows it (Plex's “Asked by …”). */
  ratingKey: string | null;
  /** The title's availability (`media.status`): 3 processing, 4 partly available, 5 available; null when not said. */
  mediaStatus: number | null;
}

export interface SeerrIssue {
  id: number;
  /** 1 video, 2 audio, 3 subtitles, 4 other. */
  kind: number;
  at: Date | null;
  by: string | null;
  type: 'movie' | 'tv';
  tmdbId: number | null;
  season: number | null;
  episode: number | null;
  message: string | null;
}

export interface SeerrTitle {
  title: string;
  year: string | null;
  poster: string | null;
}

export interface SeerrSnapshot {
  readAt: Date;
  version: string | null;
  updateAvailable: boolean;
  commitsBehind: number | null;
  restartRequired: boolean;
  counts: {
    total: number | null;
    pending: number | null;
    processing: number | null;
    available: number | null;
    /** Absent or null when Seerr didn’t say. */
    declined?: number | null;
  };
  pending: SeerrRequest[];
  processing: SeerrRequest[];
  failed: SeerrRequest[];
  failedTotal: number;
  available: SeerrRequest[];
  issues: SeerrIssue[];
  openIssues: number | null;
  /** The Sonarr and Radarr servers Seerr can't reach (`serviceErrors`). */
  unreachable: string[];
  /** By `titleKey`. */
  titles: Map<string, SeerrTitle>;
  /** Parts this read couldn't read (QN-11): `status`, `failed`, `issues`. */
  unread?: ('status' | 'failed' | 'issues')[];
}

export const titleKey = (type: 'movie' | 'tv', tmdbId: number) => `${type}:${tmdbId}`;

const who = (v: unknown): string | null => {
  const u = rec(v);
  return (
    (str(u.displayName) ?? str(u.username) ?? str(u.plexUsername) ?? str(u.jellyfinUsername))?.slice(0, 60) ??
    null
  );
};

/** One download of Seerr's `downloadStatus` (not in its OpenAPI; SD-21). */
export function parseDownload(raw: unknown, now: Date): SeerrDownload | null {
  const d = rec(raw);
  const title = str(d.title);
  if (!title) return null;
  const eta = dateOf(d.estimatedCompletionTime);
  return {
    title,
    sizeBytes: num(d.size),
    leftBytes: num(d.sizeLeft),
    eta: eta && eta.getTime() > now.getTime() ? eta : null,
    status: str(d.status),
  };
}

export function parseRequest(raw: unknown, now: Date): SeerrRequest | null {
  const r = rec(raw);
  const id = num(r.id);
  if (id === null) return null;
  const media = rec(r.media);
  const type = str(r.type) === 'tv' || str(media.mediaType) === 'tv' ? 'tv' : 'movie';
  return {
    id,
    status: num(r.status) ?? 0,
    type,
    tmdbId: num(media.tmdbId),
    at: dateOf(r.createdAt),
    updatedAt: dateOf(r.updatedAt),
    seasons: list(r.seasons)
      .map((s) => num(rec(s).seasonNumber))
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b),
    by: who(r.requestedBy),
    is4k: r.is4k === true,
    downloads: list(r.is4k === true ? media.downloadStatus4k : media.downloadStatus)
      .slice(0, 50)
      .map((d) => parseDownload(d, now))
      .filter((d): d is SeerrDownload => d !== null),
    ratingKey: str(r.is4k === true ? media.ratingKey4k : media.ratingKey),
    mediaStatus: num(r.is4k === true ? media.status4k : media.status),
  };
}

export function parseRequests(
  body: unknown,
  now: Date,
  max = 50,
): { items: SeerrRequest[]; total: number; unreachable: string[] } {
  const b = rec(body);
  const items = list(b.results)
    .slice(0, max)
    .map((r) => parseRequest(r, now))
    .filter((r): r is SeerrRequest => r !== null);
  const errors = rec(b.serviceErrors);
  const unreachable = [...list(errors.radarr), ...list(errors.sonarr)]
    .map((e) => str(rec(e).name))
    .filter((n): n is string => !!n);
  return { items, total: num(rec(b.pageInfo).results) ?? items.length, unreachable };
}

export function parseIssue(raw: unknown): SeerrIssue | null {
  const i = rec(raw);
  const id = num(i.id);
  if (id === null) return null;
  const media = rec(i.media);
  const season = num(i.problemSeason);
  const episode = num(i.problemEpisode);
  return {
    id,
    kind: num(i.issueType) ?? 4,
    at: dateOf(i.createdAt),
    by: who(i.createdBy),
    type: str(media.mediaType) === 'tv' ? 'tv' : 'movie',
    tmdbId: num(media.tmdbId),
    season: season ? season : null,
    episode: episode ? episode : null,
    message: str(rec(list(i.comments)[0]).message),
  };
}

/** `/movie/<id>` or `/tv/<id>`: the title, the year and the poster's path only. */
export function parseTitle(body: unknown): SeerrTitle | null {
  const b = rec(body);
  const title = str(b.title) ?? str(b.name);
  if (!title) return null;
  const date = str(b.releaseDate) ?? str(b.firstAirDate);
  const poster = str(b.posterPath);
  return {
    title: title.slice(0, 120),
    year: date && /^\d{4}/.test(date) ? date.slice(0, 4) : null,
    poster: poster && /^\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/.test(poster) ? poster : null,
  };
}

/** “3.5.1” → [3, 5, 1]. */
export function versionOf(v: string | null): number[] | null {
  const m = v ? /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

const titleCache = new WeakMap<Services, Map<string, { at: number; title: SeerrTitle | null }>>();

function titlesOf(services: Services): Map<string, { at: number; title: SeerrTitle | null }> {
  let m = titleCache.get(services);
  if (!m) {
    m = new Map();
    titleCache.set(services, m);
  }
  return m;
}

/** The titles of these keys: kept ones, and at most `TITLE_READS_MAX` read now (the rest on the next read). */
async function readTitles(
  services: Services,
  row: CatalogConnectionRow,
  keys: readonly string[],
  now: number,
): Promise<Map<string, SeerrTitle>> {
  const cache = titlesOf(services);
  for (const [k, v] of cache) if (now - v.at > TITLE_KEEP_MS) cache.delete(k);
  const out = new Map<string, SeerrTitle>();
  const missing: string[] = [];
  for (const key of new Set(keys)) {
    const kept = cache.get(`${row.id}|${key}`);
    if (kept) {
      if (kept.title) out.set(key, kept.title);
    } else missing.push(key);
  }
  await Promise.all(
    missing.slice(0, TITLE_READS_MAX).map(async (key) => {
      const [type, id] = key.split(':');
      const title = await getJson(services, row, NAME, `/api/v1/${type}/${id}`)
        .then(parseTitle)
        .catch(() => null);
      cache.set(`${row.id}|${key}`, { at: now, title });
      if (title) out.set(key, title);
    }),
  );
  return out;
}

async function readSeerr(services: Services, row: CatalogConnectionRow, now: Date): Promise<SeerrSnapshot> {
  const get = (path: string, query?: Record<string, string>) =>
    getJson(services, row, NAME, `/api/v1${path}`, query);
  const [status, count, pending, processing, failed, available, issueCount, issues] = await Promise.all([
    optional(get('/status')),
    optional(get('/request/count')),
    get('/request', { filter: 'pending', sort: 'added', take: '12' }),
    optional(get('/request', { filter: 'processing', sort: 'modified', take: '12' })),
    optional(get('/request', { filter: 'failed', sort: 'modified', take: '12' })),
    optional(get('/request', { filter: 'available', sort: 'modified', take: String(AVAILABLE_READ) })),
    optional(get('/issue/count')),
    optional(get('/issue', { filter: 'open', sort: 'added', take: String(ISSUES_READ) })),
  ]);
  const s = rec(status);
  const c = rec(count);
  const p = parseRequests(pending, now);
  const pr = processing ? parseRequests(processing, now) : null;
  const f = failed ? parseRequests(failed, now) : null;
  const a = available ? parseRequests(available, now) : null;
  const parsedIssues = list(rec(issues).results)
    .slice(0, ISSUES_READ)
    .map(parseIssue)
    .filter((i): i is SeerrIssue => i !== null);
  const wanted = [
    ...p.items,
    ...(pr?.items ?? []),
    ...(f?.items ?? []),
    ...parsedIssues,
    ...(a?.items ?? []).slice(0, SHELF_MAX),
  ]
    .filter((x) => x.tmdbId !== null)
    .map((x) => titleKey(x.type, x.tmdbId as number));
  const titles = await readTitles(services, row, wanted, now.getTime());
  const unread = [
    ...(status ? [] : ['status' as const]),
    ...(failed ? [] : ['failed' as const]),
    ...(issues ? [] : ['issues' as const]),
  ];
  return {
    readAt: now,
    version: str(s.version),
    updateAvailable: s.updateAvailable === true,
    commitsBehind: num(s.commitsBehind),
    restartRequired: s.restartRequired === true,
    counts: {
      total: num(c.total),
      pending: num(c.pending),
      processing: num(c.processing),
      available: num(c.available),
      declined: num(c.declined),
    },
    pending: p.items,
    processing: pr?.items ?? [],
    failed: f?.items ?? [],
    failedTotal: f?.total ?? 0,
    available: a?.items ?? [],
    issues: parsedIssues,
    openIssues: num(rec(issueCount).open),
    unreachable: [...new Set([...p.unreachable, ...(pr?.unreachable ?? []), ...(a?.unreachable ?? [])])],
    titles,
    ...(unread.length ? { unread } : {}),
  };
}

function loadSeerr(services: Services, row: CatalogConnectionRow, now: Date) {
  return async (): Promise<SeerrSnapshot> => {
    try {
      return await withDeadline(
        readSeerr(services, row, now),
        KIND_DEADLINE_MS,
        'Seerr didn’t answer in time.',
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

const seerrKey = (row: CatalogConnectionRow) => `seerr:${row.id}`;

/** Seerr's read for the health pass, kept 30 seconds. */
export function seerrSnapshot(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return cachedRead(services, seerrKey(row), row, loadSeerr(services, row, now));
}

/** Seerr's read for its page: the last one when a new one is slow (PS-01). */
export function seerrLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, seerrKey(row), row, loadSeerr(services, row, now));
}

/** The newest requests whatever their state (`filter=all`, newest first): what came in each day and who asks. */
async function readRecent(services: Services, row: CatalogConnectionRow, now: Date): Promise<SeerrRequest[]> {
  const body = await getJson(services, row, NAME, '/api/v1/request', {
    filter: 'all',
    sort: 'added',
    take: String(REQUESTS_READ),
  });
  return parseRequests(body, now, REQUESTS_READ).items;
}

/** The page's week of requests, kept 10 minutes; null when Seerr didn't say. */
export function seerrRecent(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
): Promise<SeerrRequest[] | null> {
  return cachedRead(
    services,
    `seerr-week:${row.id}`,
    row,
    async () => {
      try {
        return await withDeadline(
          readRecent(services, row, now),
          KIND_DEADLINE_MS,
          'Seerr didn’t answer in time.',
        );
      } catch (err) {
        throw problemOf(err, NAME);
      }
    },
    WEEK_KEEP_MS,
  ).catch(() => null);
}

/* What it shows ------------------------------------------------------------------------------------------------------- */

export interface SeerrInput {
  snapshot: SeerrSnapshot;
  now: Date;
  timeZone: string;
  who: ButtonCtx;
  /** Seerr's own web page. */
  url: string;
  /** SABnzbd's page, when the viewer sees one (SD-10). */
  sabnzbd: { href: string; name: string } | null;
  /** The newest requests whatever their state (Trend, People, Inventory's week); absent or null when not read. */
  recent?: SeerrRequest[] | null;
}

const ISSUE_KIND: Record<number, string> = { 1: 'Video', 2: 'Audio', 3: 'Subtitles', 4: 'Other' };

/** “Season 24”, “Seasons 1–3”, “Seasons 1, 3”. */
export function seasonsWords(seasons: readonly number[]): string | null {
  if (!seasons.length) return null;
  if (seasons.length === 1) return `Season ${seasons[0]}`;
  const run = seasons.every((s, i) => i === 0 || s === (seasons[i - 1] as number) + 1);
  return run
    ? `Seasons ${seasons[0]}–${seasons[seasons.length - 1]}`
    : clip(`Seasons ${seasons.join(', ')}`, 60);
}

/**
 * A download's progress over every file of the request: how far, and its words (“63 % · 12 min left”), also apart
 * (“63 %” and “12 min left”) for a row's two ends.
 */
export function downloadOf(
  r: SeerrRequest,
  now: Date,
): { progress: number; note: string; done: string; left: string | null } | null {
  if (!r.downloads.length) return null;
  const size = r.downloads.reduce((a, d) => a + (d.sizeBytes ?? 0), 0);
  const leftBytes = r.downloads.reduce((a, d) => a + (d.leftBytes ?? 0), 0);
  const progress = size > 0 ? Math.max(0, Math.min(1, 1 - leftBytes / size)) : 0;
  const eta = r.downloads.reduce<Date | null>((a, d) => (d.eta && (!a || d.eta > a) ? d.eta : a), null);
  const done = share(progress);
  const left = eta ? leftWords(eta.getTime() - now.getTime()) : null;
  return { progress, note: [done, left].filter(Boolean).join(' · '), done, left };
}

/** The service's own page for a title. */
const titleUrl = (base: string, type: 'movie' | 'tv', tmdbId: number | null) =>
  tmdbId !== null ? `${base}/${type}/${tmdbId}` : base;

function card(input: SeerrInput, r: { type: 'movie' | 'tv'; tmdbId: number | null }) {
  const t = r.tmdbId !== null ? input.snapshot.titles.get(titleKey(r.type, r.tmdbId)) : undefined;
  return {
    title: t?.title ?? (r.type === 'tv' ? 'A series' : 'A movie'),
    year: t?.year ?? null,
    poster: t?.poster ?? null,
  };
}

function requestItem(
  input: SeerrInput,
  r: SeerrRequest,
  ctx: Pick<KindCtx, 'services' | 'row' | 'now'>,
): GalleryItem {
  const c = card(input, r);
  const image = picture(ctx, c.poster, c.title, 'poster', 't');
  return {
    id: String(r.id),
    title: c.title,
    ...(image ? { image } : {}),
    url: titleUrl(input.url, r.type, r.tmdbId),
    ...(r.is4k ? { badge: { text: '4K', tone: 'ok' as const } } : {}),
  };
}

/** “Film · 2026”, “Series · Seasons 1–3”: what a request is. */
function whatWords(input: SeerrInput, r: SeerrRequest): string {
  const c = card(input, r);
  return r.type === 'tv'
    ? ['Series', seasonsWords(r.seasons) ?? c.year].filter(Boolean).join(' · ')
    : ['Film', c.year].filter(Boolean).join(' · ');
}

/** Waiting for you (Live): a row per request waiting for a yes, who asked and when, with Approve and Decline. */
function waitingRows(input: SeerrInput, ctx: Pick<KindCtx, 'services' | 'row' | 'now'>) {
  const { snapshot: s, now, who } = input;
  const n = s.counts.pending ?? s.pending.length;
  const oldest = s.pending.reduce<Date | null>((a, r) => (r.at && (!a || r.at < a) ? r.at : a), null);
  return liveRows({
    id: 'pending',
    title: 'Waiting for you',
    ...(n
      ? {
          meta: [plural(n, 'request'), oldest ? `oldest ${span(now.getTime() - oldest.getTime())}` : null]
            .filter(Boolean)
            .join(' · '),
        }
      : {}),
    items: s.pending.map((r): GalleryItem => {
      const c = card(input, r);
      return {
        ...requestItem(input, r, ctx),
        sub: clip(whatWords(input, r), 120),
        ...(r.by
          ? {
              person: {
                name: r.by,
                ...(r.at ? { note: `asked ${span(now.getTime() - r.at.getTime())} ago` } : {}),
              },
            }
          : {}),
        ...(r.at ? { at: r.at.toISOString() } : {}),
        actions: [
          button(who, {
            action: 'approve',
            target: String(r.id),
            label: 'Approve',
            icon: 'check',
            tone: 'primary',
          }),
          button(who, {
            action: 'decline',
            target: String(r.id),
            label: 'Decline',
            icon: 'close',
            confirm: {
              title: clip(`Decline ${c.title}?`, 80),
              body: r.by ? `${r.by} sees that it was declined.` : 'Whoever asked sees that it was declined.',
              button: 'Decline',
            },
          }),
        ],
      };
    }),
    empty: 'Nothing waits for you.',
  });
}

/** Where a request stands now: waiting, on its way, available, declined or failed. */
export function requestState(r: SeerrRequest): 'pending' | 'progress' | 'available' | 'declined' | 'failed' {
  if (r.status === REQUEST.pending) return 'pending';
  if (r.status === REQUEST.declined) return 'declined';
  if (r.status === REQUEST.failed) return 'failed';
  if (r.status === REQUEST.completed || r.mediaStatus === 5) return 'available';
  return 'progress';
}

const DAY_MS = DAY;

/** How many of these moments fall within the last week. */
const inWeek = (now: Date, ats: readonly (Date | null)[]) =>
  ats.filter((a) => a && a.getTime() <= now.getTime() && now.getTime() - a.getTime() < 7 * DAY_MS).length;

/** Requests (Inventory): how many there are in each state, what changed this week, and the open issues. */
function requestCounts(input: SeerrInput) {
  const { snapshot: s, now } = input;
  const recent = input.recent ?? null;
  // A week's change from the newest requests, as long as they reach back a week.
  const weekOf = (state: ReturnType<typeof requestState> | 'all') => {
    if (!recent) return null;
    const reaches =
      recent.length < REQUESTS_READ ||
      recent.some((r) => r.at && now.getTime() - r.at.getTime() >= 7 * DAY_MS);
    if (!reaches) return null;
    const of = recent.filter((r) => state === 'all' || requestState(r) === state);
    return inWeek(
      now,
      of.map((r) => (state === 'all' ? r.at : r.updatedAt)),
    );
  };
  const count = (n: number | null) => (n === null ? '—' : thousands(n));
  const downloading = s.processing.filter((r) => r.downloads.length).length;
  const availableWeek = inWeek(
    now,
    s.available.map((r) => r.updatedAt),
  );
  const lines: Item[] = [
    countLine({
      id: 'all',
      title: 'All requests',
      icon: 'media',
      ...(s.counts.pending ? { detail: `${thousands(s.counts.pending)} waiting for you` } : {}),
      value: count(s.counts.total),
      ...(addedNote(weekOf('all')) ?? {}),
    }),
    countLine({
      id: 'progress',
      title: 'On its way',
      icon: 'download',
      detail: downloading
        ? `${downloading} downloading`
        : s.counts.processing
          ? 'None downloading now'
          : 'Nothing on its way',
      value: count(s.counts.processing ?? s.processing.length),
      ...(addedNote(weekOf('progress')) ?? {}),
    }),
    countLine({
      id: 'available',
      title: 'Available',
      icon: 'film',
      value: count(s.counts.available),
      // The read lists the newest 20: a full list of this week's says “20+”.
      ...(availableWeek >= AVAILABLE_READ
        ? { note: `+${AVAILABLE_READ}+ this week`, noteTone: 'ok' as const }
        : (addedNote(availableWeek) ?? {})),
    }),
    countLine({
      id: 'declined',
      title: 'Declined',
      icon: 'info',
      value: count(s.counts.declined ?? null),
      ...(addedNote(weekOf('declined')) ?? {}),
    }),
  ];
  if (s.failedTotal)
    lines.push(
      countLine({
        id: 'failed',
        title: 'Failed',
        icon: 'warn',
        tone: 'warn',
        detail: 'Couldn’t be sent on',
        value: thousands(s.failedTotal),
      }),
    );
  const open = s.openIssues ?? s.issues.length;
  const newIssues = inWeek(
    now,
    s.issues.map((i) => i.at),
  );
  lines.push(
    countLine({
      id: 'issues',
      title: 'Open issues',
      icon: 'log',
      value: thousands(open),
      // Only the newest open issues are read: a full list says nothing about the week.
      ...(s.issues.length < ISSUES_READ || newIssues < s.issues.length ? (addedNote(newIssues) ?? {}) : {}),
      url: `${input.url}/issues`,
    }),
  );
  return inventory({
    id: 'requests',
    title: 'Requests',
    ...(s.counts.total !== null ? { meta: `${thousands(s.counts.total)} in all` } : {}),
    items: lines,
  });
}

/** Just available (Shelf): one row of posters, with who asked for each. */
function justAvailable(input: SeerrInput, ctx: Pick<KindCtx, 'services' | 'row' | 'now'>) {
  const { snapshot: s, now, timeZone } = input;
  const week = inWeek(
    now,
    s.available.map((r) => r.updatedAt),
  );
  return shelf({
    id: 'available',
    title: 'Just available',
    ...(week ? { meta: `${week >= AVAILABLE_READ ? `${AVAILABLE_READ}+` : week} this week` } : {}),
    items: s.available.slice(0, SHELF_MAX).map(
      (r): GalleryItem => ({
        ...requestItem(input, r, ctx),
        sub: clip(whatWords(input, r), 120),
        ...askedBy(r.by),
        ...(r.updatedAt ? { at: r.updatedAt.toISOString(), note: when(r.updatedAt, now, timeZone) } : {}),
      }),
    ),
    empty: 'Nothing became available lately.',
  });
}

/**
 * This week's requests (Trend): a bar per day of the last 7, today last, with the requests this week and the change on
 * the week before; and who asks (People): requests per person over the last 30 days, films and series apart. Pure.
 */
export function seerrWeek(
  recent: readonly SeerrRequest[],
  now: Date,
  timeZone: string,
): { trend: TrendPanel; people: PeoplePanel | null } {
  const days = lastDays(now, timeZone);
  const keys = new Set(days.keys);
  const at = (r: SeerrRequest) => r.at?.getTime() ?? null;
  const week = recent.filter(
    (r) => r.at && keys.has(dayKey(r.at, timeZone)) && (at(r) ?? 0) <= now.getTime(),
  );
  const weekStart = now.getTime() - 7 * DAY_MS;
  // The week before is known only when the read reaches back past it.
  const reaches =
    recent.length < REQUESTS_READ || recent.some((r) => (at(r) ?? Infinity) < weekStart - 7 * DAY_MS);
  const before = recent.filter((r) => {
    const t = at(r);
    return (
      t !== null && t < weekStart && t >= weekStart - 7 * DAY_MS && !keys.has(dayKey(r.at as Date, timeZone))
    );
  }).length;
  const byWho = new Map<string, { films: number; series: number }>();
  for (const r of recent) {
    const t = at(r);
    if (!r.by || t === null || now.getTime() - t > 30 * DAY_MS) continue;
    const w = byWho.get(r.by) ?? { films: 0, series: 0 };
    if (r.type === 'tv') w.series++;
    else w.films++;
    byWho.set(r.by, w);
  }
  const ranked = [...byWho.entries()]
    .map(([name, w]) => ({ name, n: w.films + w.series, w }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, 5);
  return {
    trend: trend({
      id: 'week',
      title: 'This week',
      meta: 'Requests per day',
      days,
      values: countByDay(
        week.map((r) => r.at as Date),
        days.keys,
        timeZone,
      ),
      label: 'Requests',
      figure: {
        value: thousands(week.length),
        rest: week.length === 1 ? 'request this week' : 'requests this week',
      },
      change: reaches ? weekChange(week.length, before) : null,
      color: 'violet',
    }),
    people: people({
      title: 'Who asks',
      meta: 'Last 30 days',
      unit: ['request'],
      items: ranked.map(({ name, n, w }) => ({
        name,
        n,
        note: [
          w.films ? plural(w.films, 'film') : null,
          w.series ? plural(w.series, 'series', 'series') : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    }),
  };
}

/** On its way, Failed and Issues: below the slots. */
function seerrMore(input: SeerrInput, ctx: Pick<KindCtx, 'services' | 'row' | 'now'>): Panel[] {
  const { snapshot: s, now, who } = input;
  const panels: Panel[] = [];
  // Rows like Waiting for you's: who asked, and a progress bar wide enough to read, in the main column.
  if (s.processing.length)
    panels.push({
      kind: 'gallery',
      id: 'progress',
      look: 'rows',
      title: 'On its way',
      meta: plural(s.counts.processing ?? s.processing.length, 'request'),
      ...(input.sabnzbd
        ? {
            link: {
              kind: 'href' as const,
              label: `Open ${input.sabnzbd.name}`.slice(0, 30),
              href: input.sabnzbd.href,
            },
          }
        : {}),
      shape: 'poster',
      items: s.processing.map((r): GalleryItem => {
        const d = downloadOf(r, now);
        return {
          ...requestItem(input, r, ctx),
          sub: clip(whatWords(input, r), 120),
          ...(r.by
            ? {
                person: {
                  name: r.by,
                  ...(r.at ? { note: `asked ${span(now.getTime() - r.at.getTime())} ago` } : {}),
                },
              }
            : {}),
          ...(d
            ? {
                progress: d.progress,
                note: `Downloading ${d.done}`,
                ...(d.left ? { noteEnd: d.left } : {}),
                ...(input.sabnzbd ? { href: input.sabnzbd.href } : {}),
              }
            : { note: 'Not downloading yet' }),
        };
      }),
    });
  if (s.failed.length)
    panels.push({
      kind: 'gallery',
      id: 'failed',
      title: 'Failed',
      meta: plural(s.failedTotal, 'request'),
      shape: 'poster',
      items: s.failed.map((r) => {
        const c = card(input, r);
        return {
          ...requestItem(input, r, ctx),
          sub: clip(
            [c.year, seasonsWords(r.seasons)].filter(Boolean).join(' · ') || 'Couldn’t be sent on',
            120,
          ),
          badge: { text: 'Failed', tone: 'bad' as const },
          actions: [button(who, { action: 'retry', target: String(r.id), label: 'Retry', icon: 'retry' })],
        };
      }),
    });
  if (s.issues.length)
    panels.push({
      kind: 'list',
      id: 'issues',
      title: 'Issues',
      ...(s.openIssues ? { meta: `${s.openIssues} open` } : {}),
      items: s.issues.map((i): Item => {
        const c = card(input, i);
        const where = i.type === 'tv' && i.season ? ` · S${i.season}${i.episode ? `E${i.episode}` : ''}` : '';
        return {
          id: String(i.id),
          title: clip(`${ISSUE_KIND[i.kind] ?? 'Other'} · ${c.title}${where}`, 160),
          ...(i.message || i.by ? { detail: clip([i.by, i.message].filter(Boolean).join(': '), 300) } : {}),
          ...(i.at ? { at: i.at.toISOString() } : {}),
          tone: i.at && now.getTime() - i.at.getTime() > 7 * DAY_MS ? ('warn' as const) : ('info' as const),
          icon: 'media' as const,
          url: `${input.url}/issues/${i.id}`,
          actions: [
            button(who, { action: 'resolve', target: String(i.id), label: 'Mark resolved', icon: 'check' }),
          ],
        };
      }),
      empty: 'No open issues.',
    });
  return panels;
}

/** Seerr's own line in “The machine”: its version, and whether an update waits. */
export function seerrMachineLines(s: SeerrSnapshot): ThingPageBar[] {
  if (!s.version) return [];
  const v = versionOf(s.version);
  return [
    {
      id: 'seerr-version',
      label: v && (v[0] as number) < 3 ? 'Overseerr' : 'Seerr',
      value: clip(s.version, 40),
      pct: null,
      ...(s.updateAvailable
        ? { sub: s.commitsBehind ? `${plural(s.commitsBehind, 'change')} behind` : 'An update is waiting' }
        : s.unread?.includes('status')
          ? {}
          : { sub: 'Up to date', subTone: 'ok' as const }),
    },
  ];
}

/**
 * The Summary in slots (docs/decisions/service-slots.md): what waits for a yes beside the requests by state, what just
 * became available across, then this week's requests and who asks; On its way, Failed and Issues below them.
 */
export function seerrSlots(
  input: SeerrInput,
  ctx: Pick<KindCtx, 'services' | 'row' | 'now'>,
): Pick<KindView, 'panels' | 'slots'> {
  const week = input.recent ? seerrWeek(input.recent, input.now, input.timeZone) : null;
  return slotPanels({
    live: waitingRows(input, ctx),
    inventory: requestCounts(input),
    shelf: justAvailable(input, ctx),
    trend: week?.trend,
    people: week?.people,
    more: seerrMore(input, ctx),
    machine: seerrMachineLines(input.snapshot),
  });
}

/** The figures (SD-21): Waiting for you, In progress, Available this week, Open issues. */
export function seerrKpis(input: SeerrInput): ThingPageKpi[] {
  const { snapshot: s, now } = input;
  const out: ThingPageKpi[] = [];
  const pending = s.counts.pending ?? s.pending.length;
  const oldest = s.pending.reduce<Date | null>((a, r) => (r.at && (!a || r.at < a) ? r.at : a), null);
  out.push({
    key: 'waiting',
    label: 'Waiting for you',
    value: thousands(pending),
    sub: pending && oldest ? `oldest ${span(now.getTime() - oldest.getTime())}` : 'Nothing to approve',
    ...(pending ? { tone: 'warn' as const } : {}),
  });
  const processing = s.counts.processing ?? s.processing.length;
  const downloading = s.processing.filter((r) => r.downloads.length).length;
  out.push({
    key: 'progress',
    label: 'In progress',
    value: thousands(processing),
    sub: downloading
      ? `${downloading} downloading`
      : processing
        ? 'none downloading now'
        : 'Nothing on its way',
  });
  const week = s.available.filter(
    (r) => r.updatedAt && now.getTime() - r.updatedAt.getTime() <= 7 * DAY,
  ).length;
  out.push({
    key: 'available',
    label: 'Available this week',
    value: week >= 20 ? '20+' : String(week),
    ...(s.counts.available !== null ? { sub: `${thousands(s.counts.available)} in all` } : {}),
  });
  const open = s.openIssues ?? s.issues.length;
  const oldIssue = s.issues.reduce<Date | null>((a, i) => (i.at && (!a || i.at < a) ? i.at : a), null);
  out.push({
    key: 'issues',
    label: 'Open issues',
    value: thousands(open),
    sub: open && oldIssue ? `oldest ${span(now.getTime() - oldIssue.getTime())}` : 'None',
  });
  return out;
}

/** Every check a Seerr page can raise (QN-15). */
export const SEERR_CHECKS: readonly KindCheck[] = [
  {
    check: 'overseerr.unreachable',
    name: 'Reaching Sonarr and Radarr',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'overseerr.failed',
    name: 'Requests that failed',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'overseerr.issues',
    name: 'Issues left open for a week',
    nature: 'you',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'overseerr.restart',
    name: 'A restart Seerr needs',
    nature: 'you',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'overseerr.security',
    name: 'Versions with known security problems',
    nature: 'you',
    perItem: false,
    startsOn: true,
  },
  { check: 'overseerr.moved', name: 'Moving to Seerr', nature: 'fyi', perItem: false, startsOn: false },
  { check: 'overseerr.updates', name: 'Seerr updates', nature: 'fyi', perItem: false, startsOn: false },
];

/** What this read couldn't see (QN-11): its status, a list not read or longer than what was read. */
export function seerrSkipped(s: SeerrSnapshot): string[] {
  const out: string[] = [];
  if (s.unread?.includes('status'))
    out.push('overseerr.restart', 'overseerr.security', 'overseerr.moved', 'overseerr.updates');
  if (s.unread?.includes('failed') || s.failedTotal > s.failed.length) out.push('overseerr.failed');
  if (
    s.unread?.includes('issues') ||
    (s.openIssues !== null ? s.openIssues > s.issues.length : s.issues.length >= ISSUES_READ)
  )
    out.push('overseerr.issues');
  return out;
}

/** Worth a look (SD-21), worst first. */
export function seerrNotices(input: SeerrInput): KindNotice[] {
  const { snapshot: s, now, who } = input;
  const out: KindNotice[] = [];
  out.push(
    ...itemLines(
      s.unreachable.map(
        (name): KindNotice => ({
          id: idOf('unreachable', name).slice(0, 120),
          tone: 'warn',
          icon: 'network',
          title: clip(`Seerr can’t reach ${name}`, 120),
          detail: 'Approved requests can’t be sent on until it can.',
          link: { kind: 'url', label: 'Open Seerr', url: `${input.url}/settings/services` },
          nature: 'problem',
          check: 'overseerr.unreachable',
          subject: { id: `server:${name}`.slice(0, 160), name: clip(name, 80) },
          ignore: { lifts: 'fixed', words: 'Until Seerr reaches it again.' },
          badge: badgeOf(`Can’t reach ${name}`),
        }),
      ),
      (more) => ({
        id: 'unreachable-more',
        title: `Seerr can’t reach ${plural(more.length, 'more server')}`,
        link: { kind: 'url', label: 'Open Seerr', url: `${input.url}/settings/services` },
      }),
    ),
  );
  out.push(
    ...itemLines(
      s.failed.map((r): KindNotice => {
        const title = clip(card(input, r).title, 80);
        return {
          id: `failed-${r.id}`,
          tone: 'warn',
          icon: 'download',
          title: clip(`${title} failed`, 120),
          detail: 'Seerr couldn’t send it to Sonarr or Radarr.',
          link: {
            kind: 'ask',
            label: 'Look into it',
            question: clip(`Why couldn’t Seerr send the request for ${title} on?`, 300),
          },
          action: button(who, { action: 'retry', target: String(r.id), label: 'Retry', icon: 'retry' }),
          nature: 'problem',
          check: 'overseerr.failed',
          subject: { id: `request:${r.id}`, name: title },
          ignore: { lifts: 'fixed', words: 'Until it’s sent on.' },
          badge: badgeOf(`${title} failed`),
        };
      }),
      (more) => ({
        id: 'failed-more',
        title: `${plural(more.length, 'more request')} failed`,
        link: { kind: 'url', label: 'Open Seerr', url: `${input.url}/requests` },
      }),
    ),
  );
  const old = s.issues.filter((i) => i.at && now.getTime() - i.at.getTime() > 7 * DAY);
  out.push(
    ...itemLines(
      old.map((i): KindNotice => {
        const title = clip(card(input, i).title, 80);
        return {
          id: `old-issue-${i.id}`,
          tone: 'warn',
          icon: 'media',
          title: clip(
            `An issue with ${title} is open for ${span(now.getTime() - (i.at as Date).getTime())}`,
            120,
          ),
          ...(i.message ? { detail: clip(i.message, 200) } : {}),
          link: { kind: 'url', label: 'Open it', url: `${input.url}/issues/${i.id}` },
          nature: 'you',
          check: 'overseerr.issues',
          subject: { id: `issue:${i.id}`, name: title },
          ignore: { lifts: 'fixed', words: 'Until it’s resolved.' },
          badge: 'An issue is open for a week',
        };
      }),
      (more) => ({
        id: 'old-issues-more',
        title: `${plural(more.length, 'more issue')} open for over a week`,
        link: { kind: 'url', label: 'Open Seerr', url: `${input.url}/issues` },
      }),
    ),
  );
  if (s.restartRequired)
    out.push({
      id: 'restart',
      tone: 'warn',
      icon: 'power',
      title: 'Seerr needs a restart',
      detail: 'A change takes effect once Seerr restarts. Whombat leaves that to you.',
      link: { kind: 'url', label: 'Open Seerr', url: `${input.url}/settings` },
      nature: 'you',
      check: 'overseerr.restart',
      ignore: { lifts: 'fixed', words: 'Until it’s restarted.' },
    });
  const v = versionOf(s.version);
  if (v && (v[0] as number) < 3)
    out.push({
      id: 'moved',
      tone: 'info',
      icon: 'update',
      title: 'Overseerr has moved to Seerr',
      detail: 'Seerr carries on Overseerr and Jellyseerr, and moves your requests over.',
      link: { kind: 'url', label: 'How to move', url: 'https://docs.seerr.dev/' },
      nature: 'fyi',
      check: 'overseerr.moved',
      ignore: { lifts: 'fixed', words: 'Until it’s moved to Seerr.' },
    });
  else if (v && v[0] === 3 && (v[1] as number) < SAFE_VERSION[1])
    out.push({
      id: 'security',
      tone: 'warn',
      icon: 'shield',
      title: `Seerr ${s.version} has known security problems`,
      detail: 'Seerr 3.4 fixed them. Update Seerr to stay safe.',
      link: { kind: 'url', label: 'Seerr’s releases', url: 'https://github.com/seerr-team/seerr/releases' },
      nature: 'you',
      check: 'overseerr.security',
      episode: (s.version ?? '').slice(0, 80),
      ignore: { lifts: 'fixed', words: 'Until it’s updated.' },
      badge: 'Known security problems',
    });
  if (s.updateAvailable)
    out.push({
      id: 'update',
      tone: 'info',
      icon: 'update',
      title: 'A Seerr update is waiting',
      ...(s.commitsBehind ? { detail: `${plural(s.commitsBehind, 'change')} behind.` } : {}),
      nature: 'fyi',
      check: 'overseerr.updates',
      // Develop builds are always a few changes behind: the version it runs is what's new (QN-04).
      episode: (s.version ?? '').slice(0, 80),
      ignore: { lifts: 'newer', words: 'Until Seerr is updated.' },
    });
  return worstFirst(uniqueById(out));
}

/** The page's Seerr part (SD-21); pure apart from the pictures' refs. */
export function seerrView(input: SeerrInput, ctx: Pick<KindCtx, 'services' | 'row' | 'now'>): KindView {
  const s = input.snapshot;
  const facts: ThingLine[] = [];
  const v = versionOf(s.version);
  if (s.version) facts.push(line(`${v && (v[0] as number) < 3 ? 'Overseerr' : 'Seerr'} **${s.version}**`));
  if (s.counts.total !== null) facts.push(line(`**${thousands(s.counts.total)}** requests`));
  const notices = seerrNotices(input);
  return {
    // In slots its counts are in Requests and Waiting for you; the card keeps the figures (`seerrSeen`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: asNotices(notices),
    ...statusFrom(s.counts.pending ? `${s.counts.pending} waiting for you` : null),
    ...seerrSlots(input, ctx),
    tabs: [],
    facts,
    open: { label: 'Open Seerr', url: input.url },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Who asks most', 'Requests this month', 'Oldest open issue'],
  };
}

/* The page ---------------------------------------------------------------------------------------------------------- */

export function seerrUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (str(row.fields.url) ?? row.baseUrl).replace(/\/+$/, '');
}

export async function seerrPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = seerrUrl(row);
  const [read, downloader, recent] = await Promise.all([
    seerrLatest(services, row, now),
    siblingRow(ctx, ['sabnzbd', 'qbittorrent']).catch(() => null),
    seerrRecent(services, row, now),
  ]);
  if (!read.ok)
    return {
      charts: [],
      machine: 'after',
      notices: [],
      panels: [],
      tabs: [],
      facts: [],
      open: { label: 'Open Seerr', url },
      actions: [],
      readAt: null,
      suggestions: [],
      problem: problemOf(read.error, NAME).message,
      refreshing: read.refreshing,
    };
  const view = seerrView(
    {
      snapshot: read.value,
      now,
      timeZone: ctx.timeZone,
      who: { row },
      url,
      sabnzbd: downloader ? { href: downloader.href, name: downloader.name } : null,
      recent,
    },
    ctx,
  );
  const downloading = read.value.processing.some((r) => r.downloads.length);
  // Seerr learns its downloads' progress once a minute (its Download Sync): asking every 30 seconds is live enough.
  return { ...view, refreshing: read.refreshing, ...(downloading ? { refreshS: 30 } : {}) };
}

/**
 * New requests, for the desk's calm glance (desk-display-server.md DK-S141): how many wait for approval and their
 * titles; going on while any wait. Nothing when Seerr didn't say how many.
 */
export function seerrActivity(
  s: Pick<SeerrSnapshot, 'counts' | 'pending' | 'titles'>,
): ConnectionActivity | undefined {
  const n = s.counts.pending;
  if (n === null) return undefined;
  if (n === 0) return { active: false, value: 'No new requests' };
  const titles = s.pending
    .map((r) => (r.tmdbId !== null ? s.titles.get(titleKey(r.type, r.tmdbId))?.title : undefined))
    .filter((t): t is string => !!t);
  return {
    active: true,
    value: n === 1 ? '1 new request' : `${n} new requests`,
    ...(titles.length ? { detail: clip([...new Set(titles)].join(', '), 120) } : {}),
  };
}

/** The card (SD-05): Waiting for you, In progress, Open issues. */
export async function seerrSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const snapshot = await seerrSnapshot(services, row, now);
  const input: SeerrInput = {
    snapshot,
    now,
    timeZone,
    who: { row },
    url: seerrUrl(row),
    sabnzbd: null,
  };
  const kpis = seerrKpis(input);
  const notices = seerrNotices(input);
  const glance = seenFromView(
    {
      kpis: [kpis[0], kpis[1], kpis[3]].filter((k): k is ThingPageKpi => !!k),
      notices: asNotices(notices),
    },
    { line: snapshot.counts.pending ? `${snapshot.counts.pending} waiting for you` : 'Nothing waiting' },
  );
  const activity = seerrActivity(snapshot);
  return {
    glance: { ...glance, ...(activity ? { activity } : {}) },
    points: {},
    ...linesSeen({ notices }, seerrSkipped(snapshot)),
  };
}

/* Buttons (SD-07) ------------------------------------------------------------------------------------------------------ */

/** A request's or issue's id from a button. */
function idFrom(target: string | undefined, what: string): number {
  const id = Number(target);
  if (!target || !Number.isInteger(id) || id <= 0) throw badRequest(`Which ${what}?`);
  return id;
}

/** The title of a request or issue for the toast and the thing's Activity. */
async function titleFor(ctx: KindActionCtx, type: 'movie' | 'tv', tmdbId: number | null): Promise<string> {
  if (tmdbId === null) return type === 'tv' ? 'the series' : 'the movie';
  const titles = await readTitles(ctx.services, ctx.row, [titleKey(type, tmdbId)], ctx.now.getTime()).catch(
    () => new Map<string, SeerrTitle>(),
  );
  return titles.get(titleKey(type, tmdbId))?.title ?? (type === 'tv' ? 'the series' : 'the movie');
}

/** One write; Seerr's 403 on a change is its CSRF protection (the key acts as the first admin). */
async function seerrAct(ctx: KindActionCtx, path: string): Promise<void> {
  try {
    await actAs(ctx.services, ctx.row, NAME, { method: 'POST', path: `/api/v1${path}` });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'forbidden')
      throw forbidden(
        'Seerr refused. Its CSRF protection is probably on, which keeps Whombat’s key from changing anything; turn it off in Seerr’s Settings → Network.',
      );
    throw err;
  }
  // `things.action` forgets the connection's kept reads after it (SD-S10): the page read next shows the change.
}

async function requestFor(ctx: KindActionCtx, target: string | undefined): Promise<SeerrRequest> {
  const id = idFrom(target, 'request');
  const body = await getJson(ctx.services, ctx.row, NAME, `/api/v1/request/${id}`).catch((err) => {
    throw new ApiError('unavailable', problemOf(err, NAME).message);
  });
  const r = parseRequest(body, ctx.now);
  if (!r) throw conflict('Seerr doesn’t have that request any more.');
  return r;
}

async function decide(ctx: KindActionCtx, target: string | undefined, how: 'approve' | 'decline') {
  const r = await requestFor(ctx, target);
  if (r.status !== REQUEST.pending) throw conflict('That request isn’t waiting for approval any more.');
  const title = await titleFor(ctx, r.type, r.tmdbId);
  await seerrAct(ctx, `/request/${r.id}/${how}`);
  return title;
}

export const SEERR_ACTIONS: Record<string, KindAction> = {
  async approve(ctx, input) {
    const title = await decide(ctx, input.target, 'approve');
    return { message: clip(`Approved ${title}.`, 200), title: clip(`Approved ${title}`, 200) };
  },
  async decline(ctx, input) {
    const title = await decide(ctx, input.target, 'decline');
    return { message: clip(`Declined ${title}.`, 200), title: clip(`Declined ${title}`, 200) };
  },
  async retry(ctx, input) {
    const r = await requestFor(ctx, input.target);
    if (r.status !== REQUEST.failed)
      throw conflict('That request hasn’t failed, so there’s nothing to retry.');
    const title = await titleFor(ctx, r.type, r.tmdbId);
    await seerrAct(ctx, `/request/${r.id}/retry`);
    return {
      message: clip(`Sending ${title} on again.`, 200),
      title: clip(`Retried the request for ${title}`, 200),
    };
  },
  async resolve(ctx, input) {
    const id = idFrom(input.target, 'issue');
    const body = await getJson(ctx.services, ctx.row, NAME, `/api/v1/issue/${id}`).catch((err) => {
      throw new ApiError('unavailable', problemOf(err, NAME).message);
    });
    const issue = parseIssue(body);
    if (!issue) throw conflict('Seerr doesn’t have that issue any more.');
    if (num(rec(body).status) !== 1) throw conflict('That issue isn’t open any more.');
    const title = await titleFor(ctx, issue.type, issue.tmdbId);
    await seerrAct(ctx, `/issue/${id}/resolved`);
    return {
      message: clip(`Marked the issue with ${title} resolved.`, 200),
      title: clip(`Resolved an issue with ${title}`, 200),
    };
  },
};

export const SEERR_KIND: KindModule = {
  activityLine: 'New requests',
  page: seerrPage,
  prefetch: (services, row, now) => seerrLatest(services, row, now),
  seen: seerrSeen,
  asksFirst: 'deleting, users and settings ask first',
  actions: SEERR_ACTIONS,
  checks: SEERR_CHECKS,
};
