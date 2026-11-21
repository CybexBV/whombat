/**
 * NZBHydra2's page and card (service-dashboards.md SD-23, SD-05, SD-10; SD-S12). The Summary is in slots
 * (docs/service-pages.md): each indexer as a row — whether it works, how much of its daily limit is used, its grabs
 * this week, VIP — beside today's searches and grabs with the week's, then grabs per day this week; recent grabs with
 * the app that asked (Sonarr's or Radarr's page) below. Read only (no buttons). NZBHydra2 9's external API
 * (`/externalapi/v1/ping`, `/stats`, `/history/…`; two weeks of grabs and the week's searches kept 10 minutes) and the
 * indexer state, `POST /api/stats/indexers` with the key in its JSON body (a read; GET answers 405 since 2025, and a
 * query key is ignored there) — left out when NZBHydra2 refuses it (“API stats access” off).
 */
import type { ThingLine, ThingPageBar, ThingPageItem, ThingPageKpi } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { startOfLocalDay } from '../../../home/time';
import type { Services } from '../../../services';
import type { KindCheck, KindNotice } from '../../quiet/types';
import {
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
import { cachedRead, getJson, KIND_DEADLINE_MS, latestRead, problemOf, withDeadline } from '../read';
import type { KindModule, KindSeen } from '../registry';
import { seenFromView } from '../registry';
import {
  countByDay,
  countLine,
  inventory,
  lastDays,
  liveRows,
  slotPanels,
  trend,
  weekChange,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import {
  badgeOf,
  idOf,
  itemLines,
  linesSeen,
  optional,
  queryKeyOf,
  readJson,
  siblingRow,
  statusFrom,
  uniqueById,
  worstFirst,
} from './common';
import { asNotices, asPanels, type GalleryItem, type Panel } from './ui';

const NAME = 'NZBHydra2';
const DAY = 86_400_000;
const GRABS_MAX = 10;
/** An indexer this close to its daily limit is worth a look (SD-23). */
const NEAR_LIMIT = 0.9;
/** A VIP membership ending within this is worth a look. */
const VIP_SOON_MS = 14 * DAY;
/** Two weeks of grabs (this week and the one before), kept 10 minutes. */
const WEEK_KEEP_MS = 10 * 60_000;
const WEEK_GRABS_MAX = 500;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface HydraIndexer {
  name: string;
  /** ENABLED, DISABLED_SYSTEM_TEMPORARY (after errors, for a while), DISABLED_SYSTEM (after errors, for good), DISABLED_USER. */
  state: string;
  disabledUntil: Date | null;
  lastError: string | null;
  apiHits: number | null;
  apiLimit: number | null;
  downloadHits: number | null;
  downloadLimit: number | null;
  vipEnds: Date | null;
  /** When its API hits and its downloads count from 0 again (NZBHydra2's `apiResetTime`, `downloadResetTime`). */
  apiResetAt?: Date | null;
  downloadResetAt?: Date | null;
}

export type HydraApp = 'sonarr' | 'radarr' | 'lidarr' | 'readarr' | 'prowlarr' | null;

export interface HydraGrab {
  id: string;
  at: Date | null;
  title: string;
  indexer: string | null;
  app: HydraApp;
  /** NZBHydra2's own word for how it ended (NZB_ADDED, CONTENT_DOWNLOAD_SUCCESSFUL, …). */
  status: string | null;
  error: string | null;
}

/** A grab of the last two weeks: when, from which indexer, and whether it failed. */
export interface HydraWeekGrab {
  at: Date;
  indexer: string | null;
  failed: boolean;
}

export interface HydraWeek {
  /** Newest first, at most 500. */
  grabs: HydraWeekGrab[];
  /** Whether every grab of the two weeks came back (then the week before is known). */
  complete: boolean;
  /** Searches since the first of the last 7 days began. */
  searches: number | null;
}

export interface HydraSnapshot {
  readAt: Date;
  version: string | null;
  configured: number | null;
  enabled: number | null;
  /** Null when NZBHydra2 didn't give their state. */
  indexers: HydraIndexer[] | null;
  searchesToday: number | null;
  grabsToday: number | null;
  grabs: HydraGrab[];
  /** The last two weeks' grabs and the week's searches; null when not read. */
  week?: HydraWeek | null;
}

/** `POST /api/stats/indexers`. */
export function parseIndexers(body: unknown): HydraIndexer[] {
  return list(body)
    .slice(0, 100)
    .map((raw): HydraIndexer | null => {
      const x = rec(raw);
      const name = str(x.indexer) ?? str(x.indexerName) ?? str(x.name);
      if (!name) return null;
      const vip = str(x.vipExpirationDate);
      return {
        name: name.slice(0, 80),
        state: (str(x.state) ?? 'ENABLED').toUpperCase(),
        disabledUntil: dateOf(x.disabledUntil),
        lastError: str(x.lastError),
        apiHits: num(x.apiHits),
        apiLimit: num(x.apiHitLimit),
        downloadHits: num(x.downloadHits),
        downloadLimit: num(x.downloadHitLimit),
        // “2026-10-30”: the end of that day, a date said as it is typed (in UTC, not the burrow's zone).
        vipEnds: vip && /^\d{4}-\d{2}-\d{2}$/.test(vip) ? new Date(`${vip}T23:59:59Z`) : dateOf(vip),
        apiResetAt: dateOf(x.apiResetTime),
        downloadResetAt: dateOf(x.downloadResetTime),
      };
    })
    .filter((x): x is HydraIndexer => x !== null);
}

/** Which app a user agent names (“Sonarr/4.0.0”, “Radarr”). */
export function appOf(agent: string | null): HydraApp {
  const a = (agent ?? '').toLowerCase();
  for (const app of ['sonarr', 'radarr', 'lidarr', 'readarr', 'prowlarr'] as const)
    if (a.startsWith(app)) return app;
  return null;
}

/** `/externalapi/v1/history/downloads` entries. */
export function parseGrabs(body: unknown): HydraGrab[] {
  return list(rec(body).entries)
    .slice(0, 50)
    .map((raw): HydraGrab | null => {
      const x = rec(raw);
      const title = str(x.title) ?? str(rec(x.searchResult).title);
      if (!title) return null;
      const agent = str(x.userAgent);
      return {
        id: String(num(x.id) ?? title).slice(0, 200),
        at: dateOf(x.time),
        title: title.slice(0, 160),
        indexer: str(x.indexer) ?? str(rec(rec(x.searchResult).indexer).name),
        app: appOf(agent),
        status: str(x.status),
        error: str(x.error),
      };
    })
    .filter((x): x is HydraGrab => x !== null);
}

const total = (body: unknown) => num(rec(body).totalElements);

/** `/history/downloads` of two weeks: each grab's time, indexer and whether it failed (`…_ERROR`, `…_REJECTED`). */
export function parseWeekGrabs(body: unknown): { grabs: HydraWeekGrab[]; complete: boolean } {
  const entries = list(rec(body).entries).slice(0, WEEK_GRABS_MAX);
  const grabs = entries
    .map((raw): HydraWeekGrab | null => {
      const x = rec(raw);
      const at = dateOf(x.time);
      if (!at) return null;
      return {
        at,
        indexer: str(x.indexer) ?? str(rec(rec(x.searchResult).indexer).name),
        failed: /ERROR|REJECTED/.test(str(x.status) ?? ''),
      };
    })
    .filter((x): x is HydraWeekGrab => x !== null);
  return { grabs, complete: (total(body) ?? entries.length) <= entries.length };
}

/** The first moment of the last 7 days (6 days before today's midnight). */
const weekStart = (now: Date, timeZone: string) =>
  startOfLocalDay(new Date(now.getTime() - 6 * DAY), timeZone);

async function readWeek(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<HydraWeek> {
  const get = (path: string, query?: Record<string, string>) =>
    getJson(services, row, NAME, `/externalapi/v1${path}`, query);
  const [grabs, searches] = await Promise.all([
    get('/history/downloads', {
      from: startOfLocalDay(new Date(now.getTime() - 13 * DAY), timeZone).toISOString(),
      limit: String(WEEK_GRABS_MAX),
      order: 'desc',
    }),
    optional(get('/history/searches', { from: weekStart(now, timeZone).toISOString(), limit: '1' })),
  ]);
  return { ...parseWeekGrabs(grabs), searches: total(searches) };
}

async function readHydra(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<HydraSnapshot> {
  const get = (path: string, query?: Record<string, string>) =>
    getJson(services, row, NAME, `/externalapi/v1${path}`, query);
  const from = startOfLocalDay(now, timeZone).toISOString();
  const [ping, stats, searches, grabsToday, grabs, indexers, week] = await Promise.all([
    get('/ping'),
    optional(get('/stats', { after: from, section: 'INDEXER_API_ACCESS' })),
    optional(get('/history/searches', { from, limit: '1' })),
    optional(get('/history/downloads', { from, limit: '1' })),
    optional(get('/history/downloads', { limit: String(GRABS_MAX), order: 'desc' })),
    optional(
      queryKeyOf(services, row, NAME).then((apikey) =>
        readJson(services, row, NAME, {
          method: 'POST',
          path: '/api/stats/indexers',
          body: JSON.stringify({ apikey }),
          maxBytes: 1024 * 1024,
        }),
      ),
    ),
    optional(
      cachedRead(
        services,
        `nzbhydra-week:${row.id}:${timeZone}`,
        row,
        () => readWeek(services, row, now, timeZone),
        WEEK_KEEP_MS,
      ),
    ),
  ]);
  const s = rec(stats);
  return {
    readAt: now,
    version: str(rec(ping).version),
    configured: num(s.numberOfConfiguredIndexers),
    enabled: num(s.numberOfEnabledIndexers),
    indexers: Array.isArray(indexers) ? parseIndexers(indexers) : null,
    searchesToday: total(searches),
    grabsToday: total(grabsToday),
    grabs: grabs ? parseGrabs(grabs).slice(0, GRABS_MAX) : [],
    week,
  };
}

function loadHydra(services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) {
  return async (): Promise<HydraSnapshot> => {
    try {
      return await withDeadline(
        readHydra(services, row, now, timeZone),
        KIND_DEADLINE_MS,
        'NZBHydra2 didn’t answer in time.',
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

const hydraKey = (row: CatalogConnectionRow, timeZone: string) => `nzbhydra:${row.id}:${timeZone}`;

export function hydraLatest(services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) {
  return latestRead(services, hydraKey(row, timeZone), row, loadHydra(services, row, now, timeZone));
}

export function hydraSnapshot(services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) {
  return cachedRead(services, hydraKey(row, timeZone), row, loadHydra(services, row, now, timeZone));
}

/* What it shows ------------------------------------------------------------------------------------------------------- */

export interface HydraInput {
  snapshot: HydraSnapshot;
  now: Date;
  timeZone: string;
  url: string;
  /** Sonarr's and Radarr's pages, when the viewer sees them (SD-10). */
  apps: Partial<Record<'sonarr' | 'radarr', { href: string; name: string }>>;
}

const off = (i: HydraIndexer) => i.state === 'DISABLED_USER';
const broken = (i: HydraIndexer) => i.state.startsWith('DISABLED_SYSTEM');
const working = (i: HydraIndexer) => i.state === 'ENABLED';

/** How much of its daily limit an indexer used, 0…1, or null without a limit. */
const used = (hits: number | null, limit: number | null) =>
  hits !== null && limit && limit > 0 ? hits / limit : null;

const APP_NAME: Record<NonNullable<HydraApp>, string> = {
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  lidarr: 'Lidarr',
  readarr: 'Readarr',
  prowlarr: 'Prowlarr',
};

/** The figures (SD-23): Indexers, Searches today, Grabs today, API hits. */
export function hydraKpis(input: HydraInput): ThingPageKpi[] {
  const s = input.snapshot;
  const out: ThingPageKpi[] = [];
  if (s.indexers) {
    const counted = s.indexers.filter((i) => !off(i));
    const ok = counted.filter(working).length;
    const byYou = s.indexers.filter(off).length;
    out.push({
      key: 'indexers',
      label: 'Indexers',
      value: `${ok} of ${counted.length}`,
      sub:
        counted.length - ok
          ? `${counted.length - ok} switched off by errors`
          : byYou
            ? `${byYou} switched off by you`
            : 'all working',
      ...(counted.length ? { meter: ok / counted.length } : {}),
      ...(counted.length && !ok
        ? { tone: 'bad' as const }
        : ok < counted.length
          ? { tone: 'warn' as const }
          : { color: 'green' as const }),
    });
  } else if (s.configured !== null)
    out.push({
      key: 'indexers',
      label: 'Indexers',
      value: `${s.enabled ?? 0} of ${s.configured}`,
      sub: 'switched on',
    });
  if (s.searchesToday !== null)
    out.push({ key: 'searches', label: 'Searches today', value: String(s.searchesToday) });
  if (s.grabsToday !== null) out.push({ key: 'grabs', label: 'Grabs today', value: String(s.grabsToday) });
  const busiest = (s.indexers ?? [])
    .filter((i) => !off(i))
    .map((i) => ({ i, share: used(i.apiHits, i.apiLimit) }))
    .filter((x): x is { i: HydraIndexer; share: number } => x.share !== null)
    .sort((a, b) => b.share - a.share)[0];
  if (busiest)
    out.push({
      key: 'hits',
      label: 'API hits',
      value: pct(busiest.share * 100),
      rest: 'of the limit',
      sub: clip(`${busiest.i.name} · ${busiest.i.apiHits} of ${busiest.i.apiLimit} today`, 80),
      meter: Math.min(1, busiest.share),
      ...(busiest.share >= NEAR_LIMIT ? { tone: 'warn' as const } : { color: 'blue' as const }),
    });
  return out;
}

/** Every check a NZBHydra2 page can raise (QN-15). */
export const HYDRA_CHECKS: readonly KindCheck[] = [
  {
    check: 'nzbhydra.indexer_off',
    name: 'Indexers switched off after errors',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  { check: 'nzbhydra.vip', name: 'VIP memberships ending', nature: 'you', perItem: true, startsOn: false },
  {
    check: 'nzbhydra.limit',
    name: 'Indexers near their daily limit',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
  { check: 'nzbhydra.old', name: 'An old NZBHydra2 version', nature: 'fyi', perItem: false, startsOn: false },
];

/** What this read couldn't see (QN-11): without the indexers' state, their lines can't look fixed. */
export function hydraSkipped(s: HydraSnapshot): string[] {
  return s.indexers ? [] : ['nzbhydra.indexer_off', 'nzbhydra.limit', 'nzbhydra.vip'];
}

/** When a daily limit counts from 0 again: NZBHydra2's own time when it gives one, else the next local midnight. */
export function resetOf(at: Date | null | undefined, now: Date, timeZone: string): Date {
  if (at && at > now) return at;
  return startOfLocalDay(new Date(now.getTime() + DAY), timeZone);
}

/** Worth a look (SD-23), worst first. */
export function hydraNotices(input: HydraInput): KindNotice[] {
  const { snapshot: s, now, timeZone } = input;
  const out: KindNotice[] = [];
  const indexers = s.indexers ?? [];
  const counted = indexers.filter((i) => !off(i));
  const down = counted.filter(broken);
  // None works: every switch-off is a problem, the temporary ones too (QN-04).
  const none = counted.length > 0 && !counted.some(working);
  out.push(
    ...itemLines(
      worstFirst(
        down.map((i): KindNotice => {
          const forGood = i.state !== 'DISABLED_SYSTEM_TEMPORARY';
          const problem = forGood || none;
          return {
            id: idOf('off', i.name).slice(0, 120),
            tone: none ? 'bad' : problem ? 'warn' : 'info',
            icon: 'network',
            title: clip(
              `${i.name} is switched off after errors${!forGood && i.disabledUntil ? ` until ${when(i.disabledUntil, now, timeZone)}` : ''}`,
              120,
            ),
            ...(i.lastError ? { detail: clip(i.lastError, 200) } : {}),
            link: { kind: 'url', label: 'Open NZBHydra2', url: `${input.url}/stats/indexerStatuses` },
            // NZBHydra2's own back-off for a while is a heads-up; for good, or with nothing left, a problem.
            nature: problem ? 'problem' : 'fyi',
            check: 'nzbhydra.indexer_off',
            subject: { id: `indexer:${i.name}`.slice(0, 160), name: clip(i.name, 80) },
            episode: i.state.slice(0, 40),
            ignore: { lifts: 'fixed', words: 'Until it’s working again.' },
            badge: badgeOf(none ? 'No indexer works' : `${i.name} is off`),
          };
        }),
      ),
      (more) => ({
        id: 'off-more',
        title: `${plural(more.length, 'more indexer')} switched off after errors`,
        link: { kind: 'url', label: 'Open NZBHydra2', url: `${input.url}/stats/indexerStatuses` },
      }),
    ),
  );
  for (const i of counted) {
    const api = used(i.apiHits, i.apiLimit);
    const dl = used(i.downloadHits, i.downloadLimit);
    const worst = Math.max(api ?? 0, dl ?? 0);
    if (worst >= NEAR_LIMIT) {
      const byApi = (api ?? 0) >= (dl ?? 0);
      const until = resetOf(byApi ? i.apiResetAt : i.downloadResetAt, now, timeZone);
      out.push({
        id: idOf('limit', i.name).slice(0, 120),
        tone: 'info',
        icon: 'clock',
        title: clip(`${i.name} is at ${pct(worst * 100)} of its daily limit`, 120),
        detail: byApi
          ? `${i.apiHits} of ${i.apiLimit} API hits today.`
          : `${i.downloadHits} of ${i.downloadLimit} downloads today.`,
        // Heavy use reaches it by design; nothing to do until it resets (QN-04).
        nature: 'fyi',
        check: 'nzbhydra.limit',
        subject: { id: `indexer:${i.name}`.slice(0, 160), name: clip(i.name, 80) },
        ignore: { lifts: 'period', words: 'Until the limit resets.', until: until.toISOString() },
      });
    }
  }
  for (const i of counted.filter((x) => x.vipEnds)) {
    const ms = (i.vipEnds as Date).getTime() - now.getTime();
    if (ms > VIP_SOON_MS) continue;
    const ended = ms <= 0;
    out.push({
      id: idOf('vip', i.name).slice(0, 120),
      tone: ended ? 'warn' : 'info',
      icon: 'key',
      title: clip(
        ended
          ? `${i.name}’s VIP membership has ended`
          : `${i.name}’s VIP membership ends ${dayMonth(i.vipEnds as Date, 'UTC')}`,
        120,
      ),
      ...(ended
        ? {
            detail: 'Renew it, or change its end date in NZBHydra2’s indexer settings.',
            link: { kind: 'url' as const, label: 'Open NZBHydra2', url: `${input.url}/config/indexers` },
          }
        : { detail: `In ${span(ms)}.` }),
      nature: ended ? 'you' : 'fyi',
      check: 'nzbhydra.vip',
      subject: { id: `indexer:${i.name}`.slice(0, 160), name: clip(i.name, 80) },
      // The date is typed in by hand: a new date is a new membership.
      episode: (i.vipEnds as Date).toISOString(),
      ignore: { lifts: 'newer', words: 'Until its end date changes.' },
      badge: badgeOf(`${i.name} VIP ended`),
    });
  }
  const v = /^(\d+)\./.exec(s.version ?? '');
  if (v && Number(v[1]) < 9)
    out.push({
      id: 'old',
      tone: 'info',
      icon: 'update',
      title: `NZBHydra2 ${s.version} shows fewer figures`,
      detail: 'Version 9 or later gives Whombat its statistics and history.',
      nature: 'fyi',
      check: 'nzbhydra.old',
      ignore: { lifts: 'fixed', words: 'Until it’s updated.' },
    });
  return worstFirst(uniqueById(out));
}

/** Broken first (for good, then for a while), then the working ones, then those switched off by their owner. */
const ORDER: Record<string, number> = {
  DISABLED_SYSTEM: 0,
  DISABLED_SYSTEM_TEMPORARY: 1,
  ENABLED: 2,
  DISABLED_USER: 3,
};

/** How many grabs each indexer made in the last 7 days; null when the week wasn't read. */
function grabsByIndexer(input: HydraInput): Map<string, number> | null {
  const week = input.snapshot.week;
  if (!week) return null;
  const from = weekStart(input.now, input.timeZone).getTime();
  const out = new Map<string, number>();
  for (const g of week.grabs)
    if (g.indexer && g.at.getTime() >= from) out.set(g.indexer, (out.get(g.indexer) ?? 0) + 1);
  return out;
}

/** An error as a row's line says it: NZBHydra2's own lead-in left out (“Error while communicating with indexer X.
 * Server returned: ”), the rest short. */
export const shortError = (text: string) =>
  clip(
    text
      .replace(/^Error while communicating with indexer [^.]*\.\s*(Server returned:\s*)?/i, '')
      .replace(/\.?\s*Code: \d+\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim() || text,
    50,
  );

/**
 * Indexers (Live): a row per indexer, broken ones first — how much of its daily API limit it used as the bar, when the
 * limit resets or how much is used, its grabs this week and download limit, or “Off until 21:50” or “Off after errors”
 * as its tag with the last error. Null without their state (“API stats access” off).
 */
export function hydraLive(input: HydraInput) {
  const { snapshot: s, now, timeZone } = input;
  if (!s.indexers) return null;
  const grabs = grabsByIndexer(input);
  const rows = [...s.indexers].sort(
    (a, b) => (ORDER[a.state] ?? 1) - (ORDER[b.state] ?? 1) || a.name.localeCompare(b.name),
  );
  return liveRows({
    id: 'indexers',
    title: 'Indexers',
    meta: 'How much of each one’s daily limit is used',
    // Indexers have no pictures: the row's square says the name's first letter.
    shape: 'square',
    link: { kind: 'url', label: 'Open NZBHydra2', url: `${input.url}/stats/indexerStatuses` },
    items: rows.map((i): GalleryItem => {
      const api = used(i.apiHits, i.apiLimit);
      const n = grabs?.get(i.name) ?? (grabs ? 0 : null);
      // Why it is off, else what it found this week and its download limit; a VIP end is Worth a look's when near.
      const sub =
        broken(i) && i.lastError
          ? [shortError(i.lastError)]
          : [
              n !== null ? `${plural(n, 'grab')} this week` : null,
              i.downloadLimit ? `${i.downloadHits ?? 0} of ${i.downloadLimit} downloads` : null,
            ].filter(Boolean);
      const badge =
        i.state === 'DISABLED_SYSTEM_TEMPORARY'
          ? {
              text: clip(
                i.disabledUntil ? `Off until ${clock(i.disabledUntil, timeZone)}` : 'Off for a while',
                30,
              ),
              tone: 'warn' as const,
            }
          : i.state === 'DISABLED_SYSTEM'
            ? { text: 'Off after errors', tone: 'bad' as const }
            : working(i) && api !== null && api >= NEAR_LIMIT
              ? { text: clip(`${pct(api * 100)} used`, 30), tone: 'warn' as const }
              : null;
      const resets = i.apiResetAt && i.apiResetAt > now ? i.apiResetAt : null;
      return {
        id: idOf(i.name),
        title: clip(i.name, 120),
        ...(sub.length ? { sub: clip(sub.join(' · '), 120) } : {}),
        ...(badge ? { badge } : {}),
        ...(api !== null ? { progress: Math.min(1, api) } : {}),
        ...(off(i) ? { paused: true } : {}),
        ...(i.apiHits !== null
          ? {
              note: clip(
                i.apiLimit
                  ? `${thousands(i.apiHits)} of ${thousands(i.apiLimit)} searches`
                  : plural(i.apiHits, 'search', 'searches'),
                80,
              ),
            }
          : {}),
        // One that is off says so in its tag; one that works says when its limit resets, or how much is used.
        ...(off(i)
          ? { noteEnd: 'Switched off' }
          : broken(i)
            ? {}
            : {
                noteEnd: resets
                  ? `resets ${when(resets, now, timeZone)}`
                  : api !== null
                    ? pct(api * 100)
                    : 'No limit',
              }),
      };
    }),
    empty: 'No indexers yet.',
  });
}

/**
 * Today (Inventory): searches and grabs today with the week's under them, and how many indexers work. Null when none
 * of them was read.
 */
export function hydraInventory(input: HydraInput) {
  const { snapshot: s, url } = input;
  const week = s.week;
  const from = weekStart(input.now, input.timeZone).getTime();
  const lines: ThingPageItem[] = [];
  if (s.searchesToday !== null)
    lines.push(
      countLine({
        id: 'searches',
        title: 'Searches',
        icon: 'network',
        value: thousands(s.searchesToday),
        ...(week?.searches != null ? { note: `${thousands(week.searches)} this week` } : {}),
      }),
    );
  if (s.grabsToday !== null) {
    const thisWeek = week?.grabs.filter((g) => g.at.getTime() >= from);
    const failed = thisWeek?.filter((g) => g.failed).length ?? 0;
    lines.push(
      countLine({
        id: 'grabs',
        title: 'Grabs',
        icon: 'download',
        ...(failed ? { detail: `${failed} didn’t work this week` } : {}),
        value: thousands(s.grabsToday),
        ...(thisWeek ? { note: `${thousands(thisWeek.length)}${week?.complete ? '' : '+'} this week` } : {}),
      }),
    );
  }
  if (s.indexers) {
    const counted = s.indexers.filter((i) => !off(i));
    const ok = counted.filter(working).length;
    const down = counted.length - ok;
    const byYou = s.indexers.filter(off).length;
    lines.push(
      countLine({
        id: 'indexers',
        title: 'Indexers working',
        icon: 'plug',
        value: `${ok} of ${counted.length}`,
        ...(down
          ? { note: `${down} off after errors`, noteTone: ok ? ('warn' as const) : ('bad' as const) }
          : byYou
            ? { note: `${byYou} switched off by you` }
            : counted.length
              ? { note: 'All working', noteTone: 'ok' as const }
              : {}),
        url: `${url}/config/indexers`,
      }),
    );
  } else if (s.configured !== null)
    lines.push(
      countLine({
        id: 'indexers',
        title: 'Indexers switched on',
        icon: 'plug',
        value: `${s.enabled ?? 0} of ${s.configured}`,
        url: `${url}/config/indexers`,
      }),
    );
  if (!lines.length) return null;
  return inventory({ id: 'today', title: 'Today', items: lines });
}

/**
 * This week (Trend): grabs per day of the last 7, today last, with the week's total and the change on the week before
 * when every grab of the two weeks came back. Null without the week's read. Pure.
 */
export function hydraWeek(week: HydraWeek | null | undefined, now: Date, timeZone: string) {
  if (!week) return null;
  const days = lastDays(now, timeZone);
  const at = week.grabs.map((g) => g.at);
  const values = countByDay(at, days.keys, timeZone);
  const sum = values.reduce((a, b) => a + b, 0);
  const prior = countByDay(at, lastDays(new Date(now.getTime() - 7 * DAY), timeZone).keys, timeZone).reduce(
    (a, b) => a + b,
    0,
  );
  return trend({
    id: 'week',
    title: 'This week',
    meta: 'Grabs per day',
    days,
    values,
    label: 'Grabs',
    figure: { value: thousands(sum), rest: sum === 1 ? 'grab this week' : 'grabs this week' },
    change: week.complete ? weekChange(sum, prior) : null,
    color: 'blue',
  });
}

/** NZBHydra2's own line in “The machine”: its version (it says nothing of newer ones to Whombat). */
export function hydraMachineLines(s: HydraSnapshot): ThingPageBar[] {
  if (!s.version) return [];
  const v = /^(\d+)\./.exec(s.version);
  return [
    {
      id: 'hydra-version',
      label: NAME,
      value: clip(s.version, 40),
      pct: null,
      ...(v && Number(v[1]) < 9 ? { sub: 'Version 9 or later shows more' } : {}),
    },
  ];
}

/** Recent grabs (SD-23), below the slots: what, from which indexer, the app that asked and when. */
export function hydraGrabs(input: HydraInput): Panel {
  const { snapshot: s, now, timeZone } = input;
  return {
    kind: 'table',
    id: 'grabs',
    place: 'main',
    title: 'Recent grabs',
    ...(s.grabsToday !== null ? { meta: `${s.grabsToday} today` } : {}),
    columns: [
      { key: 'title', label: 'Title' },
      { key: 'indexer', label: 'Indexer' },
      { key: 'app', label: 'Asked by' },
      { key: 'at', label: 'When' },
    ],
    rows: s.grabs.map((g) => {
      const app = g.app === 'sonarr' || g.app === 'radarr' ? input.apps[g.app] : undefined;
      return {
        id: g.id,
        cells: {
          title: {
            text: clip(g.title, 200),
            ...(g.error ? { note: clip(g.error, 80), tone: 'bad' as const } : {}),
          },
          indexer: { text: g.indexer ?? '' },
          app: app
            ? { text: clip(app.name, 200), href: app.href }
            : { text: g.app ? APP_NAME[g.app] : '', ...(g.app ? {} : { tone: 'muted' as const }) },
          at: { text: g.at ? when(g.at, now, timeZone) : '' },
        },
      };
    }),
    empty: 'Nothing grabbed yet.',
  };
}

/**
 * The Summary in slots (docs/decisions/service-slots.md): the indexers beside today's searches and grabs, then grabs
 * per day this week beside the machine; no Shelf (releases have no pictures) and no People (indexers aren't people).
 * Recent grabs below.
 */
export function hydraSlots(input: HydraInput): Pick<KindView, 'panels' | 'slots'> {
  return slotPanels({
    live: hydraLive(input),
    inventory: hydraInventory(input),
    trend: hydraWeek(input.snapshot.week, input.now, input.timeZone),
    more: asPanels([hydraGrabs(input)]),
    machine: hydraMachineLines(input.snapshot),
  });
}

/** The page's NZBHydra2 part (SD-23); pure. */
export function hydraView(input: HydraInput): KindView {
  const s = input.snapshot;
  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`NZBHydra2 **${s.version}**`));
  if (s.indexers) facts.push(line(`**${plural(s.indexers.length, 'indexer')}**`));
  const notices = hydraNotices(input);
  return {
    // In slots its figures are in Indexers and Today; the card keeps them (`hydraSeen`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: asNotices(notices),
    ...statusFrom(null),
    ...hydraSlots(input),
    tabs: [],
    facts,
    open: { label: 'Open NZBHydra2', url: input.url },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Searches per indexer', 'Grabs this week', 'Which indexer finds most'],
  };
}

/* The page ---------------------------------------------------------------------------------------------------------- */

export function hydraUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (str(row.fields.url) ?? row.baseUrl).replace(/\/+$/, '');
}

export async function hydraPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = hydraUrl(row);
  const [read, sonarr, radarr] = await Promise.all([
    hydraLatest(services, row, now, ctx.timeZone),
    siblingRow(ctx, ['sonarr']).catch(() => null),
    siblingRow(ctx, ['radarr']).catch(() => null),
  ]);
  if (!read.ok)
    return {
      charts: [],
      machine: 'after',
      notices: [],
      panels: [],
      tabs: [],
      facts: [],
      open: { label: 'Open NZBHydra2', url },
      actions: [],
      readAt: null,
      suggestions: [],
      problem: problemOf(read.error, NAME).message,
      refreshing: read.refreshing,
    };
  const apps: HydraInput['apps'] = {};
  if (sonarr) apps.sonarr = { href: sonarr.href, name: sonarr.name };
  if (radarr) apps.radarr = { href: radarr.href, name: radarr.name };
  const view = hydraView({ snapshot: read.value, now, timeZone: ctx.timeZone, url, apps });
  return { ...view, refreshing: read.refreshing };
}

/** The card (SD-05): Indexers, Grabs today. */
export async function hydraSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const snapshot = await hydraSnapshot(services, row, now, timeZone);
  const input: HydraInput = { snapshot, now, timeZone, url: hydraUrl(row), apps: {} };
  const kpis = hydraKpis(input).filter((k) => k.key === 'indexers' || k.key === 'grabs');
  const notices = hydraNotices(input);
  return {
    glance: seenFromView(
      { kpis, notices: asNotices(notices) },
      { line: snapshot.indexers ? plural(snapshot.indexers.length, 'indexer') : 'NZBHydra2' },
    ),
    points: {},
    ...linesSeen({ notices }, hydraSkipped(snapshot)),
  };
}

export const NZBHYDRA_KIND: KindModule = {
  page: hydraPage,
  prefetch: (services, row, now, timeZone) => hydraLatest(services, row, now, timeZone),
  seen: hydraSeen,
  asksFirst: 'reading its log asks first',
  checks: HYDRA_CHECKS,
};
