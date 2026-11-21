/**
 * SABnzbd's page and card (service-dashboards.md SD-22, SD-05, SD-06…SD-09; SD-S06, SD-S12): how fast it downloads,
 * what is left, the download folder's free space and this month's total; the queue with Pause, Pause 30 min and the
 * speed, the failed downloads with Retry, what finished today, and SABnzbd's own warnings. Read with `GET /api?mode=…`
 * (`queue`, `history`, `server_stats`, `warnings`; never `status` or `fullstatus`, whose answers hold the API key, nor
 * `get_config`); the speed over the range from the `sab_mbps` points the health pass keeps. Never deletes anything,
 * never restarts or shuts SABnzbd down (SD-02). Its Summary is in slots (docs/service-pages.md): what downloads now,
 * what each news server brought in and this week's downloads per day, both from `server_stats`' own days, which stay
 * when Sonarr and Radarr clear the history.
 */
import type { ThingLine, ThingPageBar, ThingPageKpi } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { ConnectionActivity } from '../../../home/types';
import { ApiError, badRequest, conflict } from '../../../lib/errors';
import type { Services } from '../../../services';
import { readPoints } from '../../points';
import { shortHash } from '../../quiet/items';
import type { KindCheck, KindNotice } from '../../quiet/types';
import {
  avgPeakLines,
  downsample,
  drawable,
  lastValue,
  onRange,
  type PageRange,
  RANGE_MS,
  type RawPoint,
  seriesStats,
  statFigure,
  statsOf,
} from '../../series';
import { bytes, clip, clock, dateOf, line, list, num, pct, plural, rec, span, str, when } from '../../words';
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
import type { KindAction, KindActionCtx, KindModule, KindSeen } from '../registry';
import { seenFromView } from '../registry';
import { countLine, dayKey, inventory, lastDays, liveRows, slotPanels, trend, weekChange } from '../slots';
import type { KindCtx, KindView } from '../types';
import {
  badgeOf,
  clockMs,
  diskBand,
  diskSubject,
  idOf,
  itemLines,
  leftWords,
  linesSeen,
  optional,
  share,
  speedWords,
  statusFrom,
  uniqueById,
  worstFirst,
} from './common';
import {
  asNotices,
  type Button,
  type ButtonCtx,
  button,
  type GalleryItem,
  type Item,
  type Panel,
} from './ui';

const NAME = 'SABnzbd';
export const SAB_MBPS_KEY = 'sab_mbps';
/** SABnzbd's sizes are binary: its GB is 1024³ bytes, its MB 1024². */
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/** The live part (the queue) while the page is open (SD-09, SD-S05). */
export const SAB_LIVE_MS = 4_000;
const QUEUE_ROWS = 20;
const FAILED_ROWS = 20;
const DONE_ROWS = 10;
/** The speed steps the Speed button walks through (SD-22): Full → Half → Quarter → Full. */
export const SPEED_STEPS = [100, 50, 25] as const;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface SabSlot {
  id: string;
  name: string;
  category: string | null;
  /** 0…1. */
  done: number;
  sizeBytes: number | null;
  leftBytes: number | null;
  leftMs: number | null;
  status: string;
}

export interface SabQueue {
  version: string | null;
  paused: boolean;
  /** A timed pause's time left. */
  pauseLeftMs: number | null;
  speedBps: number;
  /** The whole queue's size and what's left of it. */
  sizeBytes: number;
  leftBytes: number;
  leftMs: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  /** The limit as a percentage of the line speed (100 = none), and the line speed when one is set (`speedlimit_abs`). */
  limitPct: number | null;
  lineBps: number | null;
  slots: SabSlot[];
  slotsTotal: number;
  warnings: number;
}

export interface SabDone {
  id: string;
  name: string;
  category: string | null;
  status: string;
  /** Why it failed, in SABnzbd's words. */
  why: string | null;
  at: Date | null;
  sizeBytes: number | null;
  retry: boolean;
}

export interface SabWarning {
  type: string;
  text: string;
  at: Date | null;
}

/** What one news server brought in (bytes), by SABnzbd's own day (`2026-10-21`), and its articles tried and found. */
export interface SabServerStats {
  name: string;
  total: number;
  /** SABnzbd's calendar week, from Monday. */
  week: number;
  daily: Map<string, number>;
  tried: Map<string, number>;
  found: Map<string, number>;
}

/** Downloaded today, this calendar week, this month, ever (bytes), and per news server. */
export interface SabStats {
  day: number;
  week: number;
  month: number;
  total: number;
  servers: SabServerStats[];
}

export interface SabRest {
  failed: SabDone[];
  failedTotal: number;
  recent: SabDone[];
  stats: SabStats | null;
  warnings: SabWarning[];
  /** Parts this read couldn't read (QN-11): `warnings`. */
  unread?: 'warnings'[];
}

export interface SabSnapshot {
  readAt: Date;
  queue: SabQueue;
  rest: SabRest | null;
}

const category = (v: unknown) => {
  const c = str(v);
  return c && c !== '*' && c.toLowerCase() !== 'none' ? c : null;
};

/** `mode=queue`. */
export function parseQueue(body: unknown): SabQueue {
  const q = rec(rec(body).queue);
  const limit = num(q.speedlimit);
  const abs = num(q.speedlimit_abs);
  const pause = str(q.pause_int);
  const slots = list(q.slots)
    .slice(0, QUEUE_ROWS)
    .map((raw): SabSlot | null => {
      const s = rec(raw);
      const id = str(s.nzo_id);
      if (!id) return null;
      const mb = num(s.mb);
      const left = num(s.mbleft);
      const p = num(s.percentage);
      return {
        id,
        name: str(s.filename) ?? 'A download',
        category: category(s.cat),
        done: p !== null ? Math.max(0, Math.min(1, p / 100)) : mb && left !== null ? 1 - left / mb : 0,
        sizeBytes: mb !== null ? mb * MIB : null,
        leftBytes: left !== null ? left * MIB : null,
        leftMs: clockMs(s.timeleft),
        status: str(s.status) ?? 'Queued',
      };
    })
    .filter((s): s is SabSlot => s !== null);
  const free = num(q.diskspace1);
  const total = num(q.diskspacetotal1);
  return {
    version: str(q.version),
    paused: q.paused === true || q.paused === 'true',
    pauseLeftMs: pause && pause !== '0' ? clockMs(pause) : null,
    speedBps: (num(q.kbpersec) ?? 0) * 1024,
    sizeBytes: (num(q.mb) ?? 0) * MIB,
    leftBytes: (num(q.mbleft) ?? 0) * MIB,
    leftMs: clockMs(q.timeleft),
    diskFreeBytes: free !== null ? free * GIB : null,
    diskTotalBytes: total !== null && total > 0 ? total * GIB : null,
    limitPct: limit,
    // `speedlimit_abs` is the limit in bytes a second; 0 while no line speed is set (then a percentage does nothing).
    lineBps: abs && abs > 0 && limit && limit > 0 ? (abs * 100) / limit : null,
    slots,
    slotsTotal: num(q.noofslots_total) ?? slots.length,
    warnings: num(q.have_warnings) ?? 0,
  };
}

/** `mode=history` slots. */
export function parseHistory(body: unknown, max: number): { slots: SabDone[]; total: number } {
  const h = rec(rec(body).history);
  const slots = list(h.slots)
    .slice(0, max)
    .map((raw): SabDone | null => {
      const s = rec(raw);
      const id = str(s.nzo_id);
      if (!id) return null;
      return {
        id,
        name: str(s.name)?.replace(/ - https?:\/\/\S+$/, '') ?? 'A download',
        category: category(s.category),
        status: str(s.status) ?? '',
        why: str(s.fail_message),
        at: dateOf(num(s.completed)),
        sizeBytes: num(s.bytes),
        retry: s.retry !== false,
      };
    })
    .filter((s): s is SabDone => s !== null);
  return { slots, total: num(h.noofslots) ?? slots.length };
}

/** A record of days (`{"2026-10-21": 123}`) as a map, the days SABnzbd names only. */
function byDay(v: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, n] of Object.entries(rec(v)).slice(0, 400)) {
    const x = num(n);
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && x !== null) out.set(k, x);
  }
  return out;
}

/** `mode=server_stats`: the totals, and each news server's with its days. */
export function parseStats(body: unknown): SabRest['stats'] {
  const b = rec(body);
  const day = num(b.day);
  const week = num(b.week);
  const month = num(b.month);
  const total = num(b.total);
  if (month === null) return null;
  const servers = Object.entries(rec(b.servers))
    .slice(0, 20)
    .map(([name, raw]): SabServerStats => {
      const v = rec(raw);
      return {
        name: name.slice(0, 120),
        total: num(v.total) ?? 0,
        week: num(v.week) ?? 0,
        daily: byDay(v.daily),
        tried: byDay(v.articles_tried),
        found: byDay(v.articles_success),
      };
    });
  return { day: day ?? 0, week: week ?? 0, month, total: total ?? 0, servers };
}

/** `mode=warnings` (SABnzbd 3+: objects; older: lines “time\nTYPE\ntext”). */
export function parseWarnings(body: unknown): SabWarning[] {
  return list(rec(body).warnings)
    .slice(0, 50)
    .map((raw): SabWarning | null => {
      if (typeof raw === 'string') {
        const [time, type, ...text] = raw.split('\n');
        const t = text.join(' ').trim();
        return t ? { type: (type ?? 'WARNING').trim(), text: t, at: dateOf(time) } : null;
      }
      const w = rec(raw);
      const text = str(w.text);
      return text ? { type: str(w.type) ?? 'WARNING', text, at: dateOf(num(w.time)) } : null;
    })
    .filter((w): w is SabWarning => w !== null);
}

const api = (mode: string, more: Record<string, string> = {}) => ({ mode, output: 'json', ...more });

async function readQueue(services: Services, row: CatalogConnectionRow): Promise<SabQueue> {
  return parseQueue(await getJson(services, row, NAME, '/api', api('queue', { limit: String(QUEUE_ROWS) })));
}

async function readRest(services: Services, row: CatalogConnectionRow): Promise<SabRest> {
  const get = (mode: string, more?: Record<string, string>) =>
    getJson(services, row, NAME, '/api', api(mode, more));
  const [failed, recent, stats, warnings] = await Promise.all([
    get('history', { failed_only: '1', limit: String(FAILED_ROWS) }),
    optional(get('history', { limit: '30' })),
    optional(get('server_stats')),
    optional(get('warnings')),
  ]);
  const f = parseHistory(failed, FAILED_ROWS);
  return {
    failed: f.slots,
    failedTotal: f.total,
    recent: recent ? parseHistory(recent, 30).slots : [],
    stats: stats ? parseStats(stats) : null,
    warnings: warnings ? parseWarnings(warnings) : [],
    ...(warnings ? {} : { unread: ['warnings' as const] }),
  };
}

function deadline<T>(work: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await withDeadline(work(), KIND_DEADLINE_MS, 'SABnzbd didn’t answer in time.');
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

const queueKey = (row: CatalogConnectionRow) => `sabnzbd-live:${row.id}`;
const restKey = (row: CatalogConnectionRow) => `sabnzbd:${row.id}`;

/** SABnzbd's read for the health pass and the buttons: the queue (live) and the rest. */
export async function sabSnapshot(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
): Promise<SabSnapshot> {
  const [queue, rest] = await Promise.all([
    cachedRead(
      services,
      queueKey(row),
      row,
      deadline(() => readQueue(services, row)),
      SAB_LIVE_MS,
    ),
    optional(
      cachedRead(
        services,
        restKey(row),
        row,
        deadline(() => readRest(services, row)),
      ),
    ),
  ]);
  return { readAt: now, queue, rest };
}

/* Since when it pauses ------------------------------------------------------------------------------------------------ */

const pausedSince = new WeakMap<Services, Map<string, number>>();

/** When this server first saw the queue paused (SABnzbd doesn't say); forgotten once it runs again. */
export function notePaused(services: Services, rowId: string, paused: boolean, now: Date): Date | null {
  let seen = pausedSince.get(services);
  if (!seen) {
    seen = new Map();
    pausedSince.set(services, seen);
  }
  if (!paused) {
    seen.delete(rowId);
    return null;
  }
  const at = seen.get(rowId) ?? now.getTime();
  seen.set(rowId, at);
  return new Date(at);
}

/* What it shows ------------------------------------------------------------------------------------------------------- */

export interface SabInput {
  snapshot: SabSnapshot;
  now: Date;
  timeZone: string;
  range: PageRange;
  /** `sab_mbps` over the range, on the page's grid. */
  speed: { timestamps: string[]; values: (number | null)[] };
  pausedSince: Date | null;
  who: ButtonCtx;
  /** SABnzbd's own web page. */
  url: string;
}

const downloading = (q: SabQueue) => !q.paused && q.slots.length > 0;

/** The disk's free share, 0…1, or null. */
function freeShare(q: SabQueue): number | null {
  return q.diskFreeBytes !== null && q.diskTotalBytes ? q.diskFreeBytes / q.diskTotalBytes : null;
}

/** The speed the Speed button sets next (SD-22): Full → Half → Quarter → Full. */
export function nextSpeed(limitPct: number | null): (typeof SPEED_STEPS)[number] {
  const now = limitPct && limitPct > 0 && limitPct < 100 ? limitPct : 100;
  if (now > 50) return 50;
  if (now > 25) return 25;
  return 100;
}

const SPEED_LABEL: Record<(typeof SPEED_STEPS)[number], string> = {
  100: 'Full speed',
  50: 'Half speed',
  25: 'Quarter speed',
};

/** The figures (SD-22): Speed, Left, Disk free, This month. */
export function sabKpis(input: Pick<SabInput, 'snapshot' | 'now' | 'speed'>): ThingPageKpi[] {
  const { queue: q, rest } = input.snapshot;
  const out: ThingPageKpi[] = [];
  const spark = drawable(input.speed.values)
    ? { spark: downsample(input.speed.values), color: 'green' as const }
    : {};
  if (q.paused)
    out.push({
      key: 'speed',
      label: 'Speed',
      value: 'Paused',
      ...(q.pauseLeftMs !== null
        ? { sub: `${leftWords(q.pauseLeftMs)} · resumes by itself` }
        : { sub: 'until someone resumes it' }),
      tone: 'warn',
      ...spark,
    });
  else
    out.push({
      key: 'speed',
      label: 'Speed',
      value: speedWords(q.speedBps),
      sub:
        q.limitPct !== null && q.limitPct > 0 && q.limitPct < 100 && q.lineBps
          ? `limited to ${pct(q.limitPct)}`
          : q.slots.length
            ? plural(q.slotsTotal, 'download')
            : 'Nothing to download',
      ...spark,
    });
  out.push({
    key: 'left',
    label: 'Left',
    value: q.leftBytes > 0 ? bytes(q.leftBytes) : '0',
    ...(q.leftBytes > 0
      ? { sub: q.paused || !q.leftMs ? plural(q.slotsTotal, 'download') : `${span(q.leftMs)} at this speed` }
      : { sub: 'Queue is empty' }),
  });
  const free = freeShare(q);
  if (q.diskFreeBytes !== null)
    out.push({
      key: 'disk',
      label: 'Disk free',
      value: bytes(q.diskFreeBytes),
      ...(q.diskTotalBytes ? { rest: `of ${bytes(q.diskTotalBytes)}` } : {}),
      ...(free !== null ? { meter: Math.max(0, Math.min(1, 1 - free)), sub: `${pct(free * 100)} free` } : {}),
      ...(free !== null && free < 0.05
        ? { tone: 'bad' as const }
        : free !== null && free < 0.1
          ? { tone: 'warn' as const }
          : { color: 'blue' as const }),
    });
  if (rest?.stats)
    out.push({
      key: 'month',
      label: 'This month',
      value: bytes(rest.stats.month),
      sub: `${bytes(rest.stats.day)} today`,
    });
  return out;
}

/** SABnzbd's words for a news server that doesn't work (its warnings; `mode=status` would hold the key). */
const NEWS_SERVER = [
  /cannot connect to server ([^\s[\]]+)/i,
  /server ([^\s[\]]+) will be ignored/i,
  /failed login for server ([^\s[\]]+)/i,
  /too many connections to server ([^\s[\]]+)/i,
];

/** The news server a warning is about, or null. */
export function failingServer(text: string): string | null {
  for (const re of NEWS_SERVER) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

const DAY = 86_400_000;
/** This many failures within a day point at a news server or an account: a problem, not a heads-up (QN-04). */
const FAILED_PROBLEM = 3;

/** Every check a SABnzbd page can raise (QN-15). */
export const SAB_CHECKS: readonly KindCheck[] = [
  {
    check: 'media.disk',
    name: 'The download disk filling up',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'sabnzbd.server',
    name: 'News servers not working',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'sabnzbd.paused',
    name: 'Downloads paused for long',
    nature: 'you',
    perItem: false,
    startsOn: false,
  },
  { check: 'sabnzbd.failed', name: 'Failed downloads', nature: 'fyi', perItem: false, startsOn: false },
  {
    check: 'sabnzbd.warnings',
    name: 'SABnzbd’s other warnings',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];

/** What this read couldn't see (QN-11): the history and warnings when not read, a failed list longer than read. */
export function sabSkipped(snapshot: SabSnapshot): string[] {
  const { queue: q, rest } = snapshot;
  const out: string[] = [];
  if (freeShare(q) === null) out.push('media.disk');
  if (!rest) out.push('sabnzbd.failed', 'sabnzbd.server', 'sabnzbd.warnings');
  else {
    if (rest.unread?.includes('warnings')) out.push('sabnzbd.server', 'sabnzbd.warnings');
    if (rest.failedTotal > rest.failed.length) out.push('sabnzbd.failed');
  }
  return out;
}

/** The newest of some times, as the episode of a line about them (QN-11 `newer`). */
const newest = (ats: readonly (Date | null)[], fallback: readonly string[]) => {
  const t = Math.max(...ats.map((a) => a?.getTime() ?? 0), 0);
  return t ? new Date(t).toISOString() : shortHash(fallback);
};

/** Worth a look (SD-22), worst first. */
export function sabNotices(input: SabInput): KindNotice[] {
  const { snapshot, now, who } = input;
  const q = snapshot.queue;
  const rest = snapshot.rest;
  const out: KindNotice[] = [];
  const free = freeShare(q);
  if (free !== null && free < 0.1 && q.diskTotalBytes)
    out.push({
      id: 'disk',
      tone: free < 0.05 ? 'bad' : 'warn',
      icon: 'disk',
      title: `Download disk ${pct((1 - free) * 100)} full`,
      detail: `${bytes(q.diskFreeBytes ?? 0)} free. Downloads stop when it is full.`,
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: 'SABnzbd’s download disk is nearly full. What can go?',
      },
      nature: 'problem',
      check: 'media.disk',
      subject: diskSubject(q.diskTotalBytes, 'the download disk'),
      band: diskBand(free),
      ignore: { lifts: 'fixed', words: 'Until there’s more room.' },
    });
  // Failed history stays until someone deletes it: only the last day's failures count (QN-04).
  const failed = (rest?.failed ?? []).filter((f) => f.at && now.getTime() - f.at.getTime() < DAY);
  if (failed.length) {
    const names = failed.slice(0, 3).map((f) => clip(f.name, 60));
    const many = failed.length >= FAILED_PROBLEM;
    const newestFailed = [...failed].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))[0];
    out.push({
      id: 'failed',
      tone: many ? 'warn' : 'info',
      icon: 'download',
      title: `${plural(failed.length, 'download')} failed in the last day`,
      detail: clip(names.join(' · '), 200),
      ...(many
        ? {
            link: {
              kind: 'ask' as const,
              label: 'Look into it',
              question: `Why did ${failed.length} downloads fail in SABnzbd in the last day?`,
            },
          }
        : {}),
      ...(rest?.failed.some((f) => f.retry)
        ? {
            action: button(who, {
              action: 'retry_all',
              label: 'Retry all',
              icon: 'retry',
              confirm: {
                title: 'Retry every failed download?',
                body: 'SABnzbd tries each failed download again.',
                button: 'Retry all',
              },
            }),
          }
        : {}),
      nature: many ? 'problem' : 'fyi',
      check: 'sabnzbd.failed',
      episode: (newestFailed?.id ?? '').slice(0, 80),
      ignore: { lifts: 'newer', words: 'Until another one fails.' },
      badge: badgeOf(`${plural(failed.length, 'download')} failed`),
    });
  }
  const servers = new Map<string, SabWarning[]>();
  for (const w of rest?.warnings ?? []) {
    const server = failingServer(w.text);
    if (server) servers.set(server, [...(servers.get(server) ?? []), w]);
  }
  out.push(
    ...itemLines(
      worstFirst(
        [...servers].map(([server, ws]): KindNotice => {
          // A failed login is the account's (its password, its payment): only a person can fix it.
          const login = ws.some((w) => /failed login/i.test(w.text));
          return {
            id: idOf('server', server).slice(0, 120),
            tone: 'warn',
            icon: 'network',
            title: clip(
              login ? `News server ${server} refuses the login` : `News server ${server} isn’t working`,
              120,
            ),
            detail: login
              ? 'Check the account’s user name, password and subscription.'
              : 'SABnzbd skips it for a while and tries again.',
            link: { kind: 'url', label: 'Open SABnzbd', url: `${input.url}/config/server/` },
            nature: login ? 'you' : 'problem',
            check: 'sabnzbd.server',
            subject: { id: `server:${server}`.slice(0, 160), name: clip(server, 80) },
            // SABnzbd keeps its warnings until they're cleared: a newer one is the news.
            episode: newest(
              ws.map((w) => w.at),
              ws.map((w) => w.text),
            ),
            ignore: { lifts: 'newer', words: 'Until SABnzbd warns about it again.' },
            badge: badgeOf(`${server} not working`),
          };
        }),
      ),
      (more) => ({
        id: 'server-more',
        title: `${plural(more.length, 'more news server', 'more news servers')} aren’t working`,
        link: { kind: 'url', label: 'Open SABnzbd', url: `${input.url}/config/server/` },
      }),
    ),
  );
  if (q.paused && input.pausedSince && q.slots.length && q.pauseLeftMs === null) {
    const ms = now.getTime() - input.pausedSince.getTime();
    if (ms >= 3600_000)
      out.push({
        id: 'paused',
        tone: 'warn',
        icon: 'clock',
        title: `Downloads paused for ${span(ms)}`,
        detail: `${plural(q.slotsTotal, 'download')} waiting.`,
        action: button(who, { action: 'resume', label: 'Resume', icon: 'play' }),
        nature: 'you',
        check: 'sabnzbd.paused',
        ignore: { lifts: 'fixed', words: 'Until it’s resumed.' },
      });
  }
  const warnings = (rest?.warnings ?? []).filter((w) => !failingServer(w.text));
  if (warnings.length) {
    const first = warnings[warnings.length - 1] as SabWarning;
    out.push({
      id: 'warnings',
      tone: 'info',
      icon: 'warn',
      title: warnings.length === 1 ? 'SABnzbd has a warning' : `SABnzbd has ${warnings.length} warnings`,
      detail: clip(first.text.split('\n')[0] ?? first.text, 200),
      action: button(who, { action: 'clear_warnings', label: 'Clear in SABnzbd', icon: 'clean' }),
      nature: 'fyi',
      check: 'sabnzbd.warnings',
      episode: newest(
        warnings.map((w) => w.at),
        warnings.map((w) => w.text),
      ),
      ignore: { lifts: 'newer', words: 'Until a new warning comes.' },
    });
  }
  return worstFirst(uniqueById(out));
}

/** The queue's head buttons (SD-22): Pause or Resume, Pause 30 min, and the speed's next step when a line speed is set. */
export function queueButtons(q: SabQueue, who: ButtonCtx): Button[] {
  const out: Button[] = [];
  if (q.paused) out.push(button(who, { action: 'resume', label: 'Resume', icon: 'play', tone: 'primary' }));
  else {
    out.push(button(who, { action: 'pause', label: 'Pause', icon: 'pause' }));
    out.push(button(who, { action: 'pause30', label: 'Pause 30 min', icon: 'pause' }));
  }
  if (q.lineBps) {
    const next = nextSpeed(q.limitPct);
    out.push(button(who, { action: 'speed', value: next, label: SPEED_LABEL[next], icon: 'speed' }));
  }
  return out;
}

/** Downloading now's line over its rows: “42 MB/s · 4 downloads · 18.4 GB left · about 20 min”, “Paused · 18.4 GB left”. */
export function queueMeta(q: SabQueue): string | undefined {
  const left = q.leftBytes > 0 ? `${bytes(q.leftBytes)} left` : null;
  if (q.paused)
    return ['Paused', q.pauseLeftMs !== null ? `resumes in ${span(q.pauseLeftMs)}` : null, left]
      .filter(Boolean)
      .join(' · ');
  if (!q.slots.length) return undefined;
  const limited = q.limitPct !== null && q.limitPct > 0 && q.limitPct < 100 && q.lineBps;
  return [
    speedWords(q.speedBps),
    limited ? `limited to ${pct(q.limitPct as number)}` : null,
    plural(q.slotsTotal, 'download'),
    left,
    q.leftMs ? `about ${span(q.leftMs)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** States of a download that say nothing new on its row. */
const PLAIN_STATES = new Set(['Downloading', 'Queued']);

/** Downloading now (Live): a row per download with its category and size, how far, and how long is left. */
function downloadingRows(input: SabInput) {
  const q = input.snapshot.queue;
  const meta = queueMeta(q);
  return liveRows({
    id: 'queue',
    title: 'Downloading now',
    // Downloads have no pictures: the row's square says the name's first letter.
    shape: 'square',
    ...(meta ? { meta } : {}),
    buttons: queueButtons(q, input.who),
    ...(q.slotsTotal > q.slots.length ? { total: q.slotsTotal } : {}),
    items: q.slots.map((s): GalleryItem => {
      const paused = q.paused || s.status === 'Paused';
      const sub = [s.category, s.sizeBytes !== null ? bytes(s.sizeBytes) : null].filter(Boolean).join(' · ');
      const have = s.sizeBytes && s.leftBytes !== null ? Math.max(0, s.sizeBytes - s.leftBytes) : 0;
      // “1.2 GB of 3.1 GB” once something came in; “0 %” before.
      const got = have && s.sizeBytes ? `${bytes(have)} of ${bytes(s.sizeBytes)}` : share(s.done);
      return {
        id: s.id.slice(0, 200),
        title: clip(s.name, 120),
        ...(sub ? { sub: clip(sub, 120) } : {}),
        ...(PLAIN_STATES.has(s.status) || (q.paused && s.status === 'Paused')
          ? {}
          : { badge: { text: clip(s.status, 30), tone: 'warn' as const } }),
        progress: s.done,
        ...(paused ? { paused: true } : {}),
        note: clip(got, 80),
        ...(paused
          ? { noteEnd: 'Paused' }
          : s.leftMs
            ? { noteEnd: leftWords(s.leftMs) }
            : s.status === 'Queued'
              ? { noteEnd: 'Waiting' }
              : {}),
      };
    }),
    empty: 'Nothing to download.',
  });
}

/** What came in over these days, by SABnzbd's day, every news server together. */
function sumDays(servers: readonly SabServerStats[], keys: readonly string[]): number[] {
  return keys.map((k) => servers.reduce((a, s) => a + (s.daily.get(k) ?? 0), 0));
}

/** The 7 days before the last 7 (their keys), oldest first. */
function weekBefore(now: Date, timeZone: string): string[] {
  return lastDays(new Date(now.getTime() - 7 * DAY), timeZone).keys;
}

/** Whether a server's days reach back before these keys (then the week before is known). */
const reachesBack = (servers: readonly SabServerStats[], first: string) =>
  servers.some((s) => [...s.daily.keys()].some((k) => k < first));

/**
 * Downloaded (Inventory): what each news server brought in, ever, with this week's under it and how many of the
 * articles asked for it had, and whether it works. Without news servers, SABnzbd's own total.
 */
function downloaded(input: SabInput) {
  const { snapshot, now, timeZone } = input;
  const stats = snapshot.rest?.stats;
  if (!stats) return null;
  const keys = lastDays(now, timeZone).keys;
  const failing = new Set(
    (snapshot.rest?.warnings ?? []).map((w) => failingServer(w.text)).filter((x): x is string => !!x),
  );
  const weekNote = (n: number) =>
    n > 0 ? { note: `+${bytes(n)} this week`, noteTone: 'ok' as const } : { note: 'Nothing new' };
  const lines: Item[] = stats.servers.map((s) => {
    // The last 7 days from its days, else SABnzbd's own week (since Monday).
    const week = s.daily.size ? sumDays([s], keys).reduce((a, b) => a + b, 0) : s.week;
    const tried = keys.reduce((a, k) => a + (s.tried.get(k) ?? 0), 0);
    const found = keys.reduce((a, k) => a + (s.found.get(k) ?? 0), 0);
    const down = failing.has(s.name);
    return countLine({
      id: idOf('server', s.name),
      title: s.name,
      icon: 'network',
      ...(down
        ? { detail: 'Not working now', tone: 'warn' as const }
        : tried > 0
          ? { detail: `Found ${share(found / tried)} this week` }
          : {}),
      value: bytes(s.total),
      ...weekNote(week),
    });
  });
  if (!lines.length)
    lines.push(
      countLine({
        id: 'all',
        title: 'Everything',
        icon: 'download',
        value: bytes(stats.total),
        ...weekNote(stats.week),
      }),
    );
  return inventory({
    id: 'downloaded',
    title: 'Downloaded',
    meta: `${bytes(stats.month)} this month`,
    items: lines,
  });
}

/**
 * This week's downloads (Trend): what came in per day of the last 7, today last, from SABnzbd's own days per news
 * server, with the week's total and the change on the week before. Null without news servers' days. Pure.
 */
export function sabWeek(
  stats: SabStats | null | undefined,
  now: Date,
  timeZone: string,
): ReturnType<typeof trend> | null {
  if (!stats?.servers.some((s) => s.daily.size)) return null;
  const days = lastDays(now, timeZone);
  const values = sumDays(stats.servers, days.keys);
  const total = values.reduce((a, b) => a + b, 0);
  const before = weekBefore(now, timeZone);
  const known = reachesBack(stats.servers, days.keys[0] as string);
  const prior = sumDays(stats.servers, before).reduce((a, b) => a + b, 0);
  return trend({
    id: 'week',
    title: 'This week',
    meta: 'Downloaded per day',
    days,
    // In GB as `bytes` says them (decimal), two decimals for a quiet day.
    values: values.map((v) => Math.round(v / 1e7) / 100),
    label: 'Downloaded',
    unit: 'GB',
    figure: { value: bytes(total), rest: 'this week' },
    change: known ? weekChange(total, prior) : null,
    color: 'green',
  });
}

/** SABnzbd's own lines in “The machine”: its version, and how full its download disk is. */
export function sabMachineLines(q: SabQueue): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (q.version) out.push({ id: 'sab-version', label: 'SABnzbd', value: clip(q.version, 40), pct: null });
  const free = freeShare(q);
  if (q.diskFreeBytes !== null && q.diskTotalBytes && free !== null)
    out.push({
      id: 'download-disk',
      label: 'Download disk',
      value: clip(`${bytes(q.diskTotalBytes - q.diskFreeBytes)} of ${bytes(q.diskTotalBytes)}`, 40),
      pct: Math.max(0, Math.min(1, 1 - free)),
      sub: `${bytes(q.diskFreeBytes)} free`,
      ...(free < 0.05 ? { tone: 'bad' as const } : free < 0.1 ? { tone: 'warn' as const } : {}),
    });
  return out;
}

/** Failed, Done today and the speed over the range: below the slots. */
function sabMore(input: SabInput): Panel[] {
  const { snapshot, now, timeZone, who } = input;
  const q = snapshot.queue;
  const rest = snapshot.rest;
  const panels: Panel[] = [];
  if (rest?.failed.length)
    panels.push({
      kind: 'table',
      id: 'failed',
      title: 'Failed',
      meta: plural(rest.failedTotal, 'download'),
      buttons: rest.failed.some((f) => f.retry)
        ? [
            button(who, {
              action: 'retry_all',
              label: 'Retry all',
              icon: 'retry',
              confirm: {
                title: 'Retry every failed download?',
                body: 'SABnzbd tries each failed download again.',
                button: 'Retry all',
              },
            }),
          ]
        : [],
      columns: [
        { key: 'name', label: 'Download' },
        { key: 'why', label: 'Why' },
        { key: 'at', label: 'When' },
        { key: 'retry', label: '' },
      ],
      rows: rest.failed.map((f) => ({
        id: f.id.slice(0, 200),
        cells: {
          name: { text: clip(f.name, 200), ...(f.category ? { note: f.category } : {}) },
          why: { text: clip(f.why ?? 'Failed', 200), tone: 'bad' },
          at: { text: f.at ? when(f.at, now, timeZone) : '' },
          retry: f.retry
            ? {
                text: 'Retry',
                action: button(who, { action: 'retry', target: f.id, label: 'Retry', icon: 'retry' }),
              }
            : { text: '' },
        },
      })),
    });
  const today = dayKey(now, timeZone);
  const done = (rest?.recent ?? [])
    .filter((d) => d.status.toLowerCase() === 'completed' && d.at && dayKey(d.at, timeZone) === today)
    .slice(0, DONE_ROWS);
  if (done.length)
    panels.push({
      kind: 'list',
      id: 'done',
      title: 'Done today',
      meta: plural(done.length, 'download'),
      items: done.map((d) => ({
        id: d.id.slice(0, 200),
        title: clip(d.name, 160),
        ...(d.category ? { detail: d.category } : {}),
        ...(d.at ? { at: d.at.toISOString() } : {}),
        ...(d.sizeBytes ? { right: bytes(d.sizeBytes) } : {}),
        tone: 'ok' as const,
        icon: 'download' as const,
      })),
    });
  if (drawable(input.speed.values)) {
    const stats = seriesStats(input.speed.values, input.speed.timestamps);
    const latest = lastValue(input.speed.values);
    const lines: ThingLine[] = stats
      ? avgPeakLines(stats, (n) => `${statFigure(n)} MB/s`, now, timeZone)
      : [];
    panels.push({
      kind: 'chart',
      id: 'speed',
      title: 'Speed',
      timestamps: input.speed.timestamps,
      series: [
        {
          key: 'speed',
          label: 'Speed',
          unit: 'MB/s',
          values: input.speed.values,
          color: 'green',
          fill: true,
          ...(latest !== null ? { latest: `${statFigure(latest)} MB/s` } : {}),
        },
      ],
      figure: { value: q.paused ? 'Paused' : speedWords(q.speedBps), rest: 'now' },
      ...statsOf(lines),
      axis: { min: 0, unit: 'MB/s' },
    });
  }
  return panels;
}

/**
 * The Summary in slots (docs/decisions/service-slots.md): what downloads now beside what each news server brought in,
 * then this week's downloads; no shelf (downloads have no pictures) and no people (SABnzbd doesn't know who asked).
 * Failed, Done today and the speed below them.
 */
export function sabSlots(input: SabInput): Pick<KindView, 'panels' | 'slots'> {
  return slotPanels({
    live: downloadingRows(input),
    inventory: downloaded(input),
    trend: sabWeek(input.snapshot.rest?.stats, input.now, input.timeZone),
    more: sabMore(input),
    machine: sabMachineLines(input.snapshot.queue),
  });
}

/** The page's SABnzbd part (SD-22), from what was read; pure. */
export function sabView(input: SabInput): KindView {
  const { snapshot } = input;
  const q = snapshot.queue;
  const rest = snapshot.rest;
  const facts: ThingLine[] = [];
  if (q.version) facts.push(line(`SABnzbd **${q.version}**`));
  if (rest?.stats) facts.push(line(`**${bytes(rest.stats.week)}** this week`));
  const notices = sabNotices(input);
  return {
    // In slots its figures are in Downloading now and Downloaded; the card keeps them (`sabSeen`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: asNotices(notices),
    ...sabSlots(input),
    tabs: [],
    facts,
    // Paused is a state, not a warning: after an hour it is a line of its own (QN-S3x).
    ...statusFrom(
      q.paused
        ? q.pauseLeftMs !== null
          ? `Paused · ${leftWords(q.pauseLeftMs)}`
          : 'Paused'
        : downloading(q)
          ? `Downloading · ${speedWords(q.speedBps)}`
          : null,
    ),
    open: { label: 'Open SABnzbd', url: input.url },
    actions: [],
    readAt: snapshot.readAt,
    ...(downloading(q) ? { refreshS: 5 } : {}),
    suggestions: ['Downloads per day', 'What failed this week', 'Biggest downloads'],
  };
}

/** The page's part as the card reads it: the page in slots has no row of figures, the card keeps Speed, Left and Disk free. */
export function sabCardView(input: SabInput): KindView {
  return { ...sabView(input), kpis: sabKpis(input) };
}

/* The page ---------------------------------------------------------------------------------------------------------- */

/** SABnzbd's address for “Open SABnzbd”: its web interface is at the root. */
export function sabUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (str(row.fields.url) ?? row.baseUrl).replace(/\/+$/, '');
}

/** `sab_mbps` over the range on the page's grid (SD-S06). */
async function speedLine(services: Services, rowId: string, range: PageRange, now: Date) {
  const points = await readPoints(services.db, rowId, [SAB_MBPS_KEY], now, RANGE_MS[range]).catch(
    () => new Map<string, RawPoint[]>(),
  );
  const grid = onRange([points.get(SAB_MBPS_KEY) ?? []], range, now);
  return { timestamps: grid.timestamps, values: grid.values[0] ?? [] };
}

export async function sabPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = sabUrl(row);
  const [queue, rest, speed] = await Promise.all([
    liveRead(
      services,
      queueKey(row),
      row,
      deadline(() => readQueue(services, row)),
      {
        liveS: SAB_LIVE_MS / 1000,
      },
    ),
    latestRead(
      services,
      restKey(row),
      row,
      deadline(() => readRest(services, row)),
    ),
    speedLine(services, row.id, ctx.range, now),
  ]);
  if (!queue.ok)
    return {
      charts: [],
      machine: 'after',
      notices: [],
      panels: [],
      tabs: [],
      facts: [],
      open: { label: 'Open SABnzbd', url },
      actions: [],
      readAt: null,
      suggestions: [],
      problem: problemOf(queue.error, NAME).message,
      refreshing: queue.refreshing,
    };
  const snapshot: SabSnapshot = { readAt: queue.at, queue: queue.value, rest: rest.ok ? rest.value : null };
  const view = sabView({
    snapshot,
    now,
    timeZone: ctx.timeZone,
    range: ctx.range,
    speed,
    pausedSince: notePaused(services, row.id, queue.value.paused, now),
    who: { row },
    url,
  });
  return {
    ...view,
    ...(rest.ok ? {} : { problem: problemOf(rest.error, NAME).message }),
    refreshing: queue.refreshing || rest.refreshing,
  };
}

/**
 * The queue on the desk's calm glance (desk-display-server.md DK-S141): how many are left and the time left, how far the
 * whole queue is, the first download's name; going on while the queue downloads, and a paused queue says so.
 */
export function sabActivity(q: SabQueue): ConnectionActivity {
  if (q.slotsTotal === 0) return { active: false, value: 'Nothing to download' };
  const first = q.slots[0]?.name;
  const more = {
    ...(first ? { detail: clip(first, 120) } : {}),
    ...(q.sizeBytes > 0
      ? { progress: Math.max(0, Math.min(100, Math.round((1 - q.leftBytes / q.sizeBytes) * 100))) }
      : {}),
  };
  const left = `${q.slotsTotal} left`;
  if (q.paused) return { active: false, value: `Paused · ${left}`, ...more };
  // Under a minute isn't worth a word; `span` says “a moment”.
  const time = q.leftMs !== null && q.leftMs >= 60_000 ? ` · ${span(q.leftMs)}` : '';
  return { active: true, value: `${left}${time}`, ...more };
}

/** The health pass's look (SD-05, SD-S06): Speed, Left, Disk free, and `sab_mbps`. */
export async function sabSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const snapshot = await sabSnapshot(services, row, now);
  const input: SabInput = {
    snapshot,
    now,
    timeZone,
    range: '24h',
    speed: { timestamps: [], values: [] },
    pausedSince: notePaused(services, row.id, snapshot.queue.paused, now),
    who: { row },
    url: sabUrl(row),
  };
  const view = sabCardView(input);
  const q = snapshot.queue;
  return {
    glance: {
      ...seenFromView(view, {
        line: q.paused ? 'Paused' : q.slots.length ? plural(q.slotsTotal, 'download') : 'Nothing to download',
      }),
      activity: sabActivity(q),
    },
    points: { [SAB_MBPS_KEY]: q.paused ? 0 : Math.round((q.speedBps / 1e6) * 100) / 100 },
    ...linesSeen(view, sabSkipped(snapshot)),
  };
}

/* Buttons (SD-07, SD-08) ------------------------------------------------------------------------------------------------- */

/** One `mode=…` call; SABnzbd answers `{"status": true}` or `{"status": false, "error": …}` with a 200. */
async function sabCall(ctx: KindActionCtx, query: Record<string, string>, doing: string): Promise<void> {
  const answer = await actAs(ctx.services, ctx.row, NAME, {
    method: 'GET',
    path: '/api',
    query: { ...query, output: 'json' },
  });
  const b = rec(answer.json);
  if (b.status === false) {
    const error = str(b.error);
    throw new ApiError('unavailable', clip(`SABnzbd didn’t ${doing}${error ? `: ${error}` : '.'}`, 200));
  }
  // `things.action` forgets the connection's kept reads after it (SD-S10): the page read next shows the change.
}

/** A failed download the page offers to retry: it must still be in the failed list (SD-S04). */
async function failedOne(ctx: KindActionCtx, target: string | undefined): Promise<SabDone> {
  if (!target) throw badRequest('Which download should be retried?');
  const body = await getJson(
    ctx.services,
    ctx.row,
    NAME,
    '/api',
    api('history', { failed_only: '1', limit: '100' }),
  ).catch((err) => {
    throw new ApiError('unavailable', problemOf(err, NAME).message);
  });
  const found = parseHistory(body, 100).slots.find((s) => s.id === target);
  if (!found) throw conflict('That download isn’t in SABnzbd’s failed list any more.');
  return found;
}

export const SAB_ACTIONS: Record<string, KindAction> = {
  async pause(ctx) {
    await sabCall(ctx, { mode: 'pause' }, 'pause');
    return { message: 'Downloads paused.', title: 'Paused downloads in SABnzbd', everyday: true };
  },
  async resume(ctx) {
    await sabCall(ctx, { mode: 'resume' }, 'resume');
    return { message: 'Downloads resumed.', title: 'Resumed downloads in SABnzbd', everyday: true };
  },
  async pause30(ctx) {
    await sabCall(ctx, { mode: 'config', name: 'set_pause', value: '30' }, 'pause');
    return {
      message: `Downloads paused until ${clock(new Date(ctx.now.getTime() + 30 * 60_000), ctx.timeZone)}.`,
      title: 'Paused downloads in SABnzbd for 30 minutes',
      everyday: true,
    };
  },
  async speed(ctx, input) {
    const value = Number(input.value);
    if (!SPEED_STEPS.includes(value as (typeof SPEED_STEPS)[number]))
      throw badRequest('SABnzbd’s speed is full, half or a quarter.');
    await sabCall(ctx, { mode: 'config', name: 'speedlimit', value: String(value) }, 'change its speed');
    const words = value === 100 ? 'full speed' : value === 50 ? 'half speed' : 'a quarter of its speed';
    return {
      message: `SABnzbd now downloads at ${words}.`,
      title: `Set SABnzbd to ${words}`,
      everyday: true,
    };
  },
  async retry(ctx, input) {
    const one = await failedOne(ctx, input.target);
    await sabCall(ctx, { mode: 'retry', value: one.id }, 'retry it');
    return { message: `Trying ${clip(one.name, 80)} again.`, title: clip(`Retried ${one.name}`, 200) };
  },
  async retry_all(ctx) {
    await sabCall(ctx, { mode: 'retry_all' }, 'retry them');
    return {
      message: 'Trying every failed download again.',
      title: 'Retried every failed download in SABnzbd',
    };
  },
  async clear_warnings(ctx) {
    await sabCall(ctx, { mode: 'warnings', name: 'clear' }, 'clear its warnings');
    return {
      message: 'SABnzbd’s warnings are cleared.',
      title: 'Cleared SABnzbd’s warnings',
      everyday: true,
    };
  },
};

export const SABNZBD_KIND: KindModule = {
  activityLine: 'The queue and time left',
  page: sabPage,
  prefetch: (services, row, now) => sabSnapshot(services, row, now),
  seen: sabSeen,
  asksFirst: 'deleting, restarts and settings ask first',
  actions: SAB_ACTIONS,
  liveS: SAB_LIVE_MS / 1000,
  checks: SAB_CHECKS,
};
