/**
 * Pi-hole's and AdGuard Home's page (service-dashboards.md SD-34, SD-S06, SD-S15): one shape for both, its Summary in
 * slots (docs/service-pages.md): Blocking now with Pause 5 and 30 minutes (Resume while off) and how much it blocked;
 * the block lists and the devices with Update lists; lookups over the last 24 hours from the service itself in two-hour
 * bars, stacked with what was blocked; the busiest devices by name; the most blocked sites below them and the lists one by
 * one in their tab. Worth a look: blocking off, lists older than a week or failing, an update waiting, Pi-hole's own
 * diagnosis. Never updates the service, clears statistics or logs, or changes its DNS settings.
 *
 * Pi-hole v6 (`/api/…`, its session sign-in: the credential layer keeps one session per connection, CM-10) and AdGuard
 * Home (`/control/…`, Basic; its clients' names from `/control/clients`). Both read in one go, kept 30 seconds; a part
 * that fails is left out. The builders below are pure.
 */
import type {
  ThingLine,
  ThingPageBar,
  ThingPageItem,
  ThingPageKpi,
  ThingPagePanel,
  ThingPageRow,
  ThingPageTab,
} from '@whombat/core';
import { externalEffect } from '../../../commit/scope';
import { signedConnectionFetch } from '../../../connections/http';
import type { CatalogConnectionRow } from '../../../connections/types';
import { ApiError, badRequest } from '../../../lib/errors';
import type { Services } from '../../../services';
import { readPoints } from '../../points';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { downsample, drawable, onRange, type PageRange, RANGE_MS, type RawPoint } from '../../series';
import { clip, clock, dateOf, line, list, num, rec, span, str, thousands } from '../../words';
import { actAs } from '../act';
import {
  cachedRead,
  getJson,
  KIND_DEADLINE_MS,
  KIND_MAX_BYTES,
  latestRead,
  problemOf,
  ReadProblem,
  withDeadline,
} from '../read';
import { type KindAction, type KindModule, type KindSeen, seenFromView } from '../registry';
import {
  countLine,
  type InventoryPanel,
  inventory,
  type LivePanel,
  liveList,
  type PeoplePanel,
  people,
  slotPanels,
  type TrendPanel,
  trend,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import { itemLines, lineId, subjectName } from './lines';
import { type ButtonCtx, button, type ThingPageButton } from './shapes';

export type DnsService = 'pihole' | 'adguard';

const NAMES: Record<DnsService, string> = { pihole: 'Pi-hole', adguard: 'AdGuard Home' };

/** The points the health pass keeps (SD-S06): queries over the service's last 24 hours, and the share blocked (%). */
export const DNS_Q_KEY = 'dns_q';
export const DNS_BLOCKED_KEY = 'dns_blocked';

const DAY = 86_400_000;
/**
 * Lists older than this are worth a look: Pi-hole rebuilds them weekly at a random minute early on Sunday, so a week
 * flapped whenever a run was a little late (quiet-notices.md QN-04).
 */
export const LISTS_OLD_MS = 9 * DAY;

export interface DnsList {
  id: string;
  name: string;
  /** Domains (Pi-hole) or rules (AdGuard) it holds. */
  rules: number | null;
  updatedAt: Date | null;
  enabled: boolean;
  /** Its last download failed (Pi-hole: it kept the old copy, or has none). */
  failed: boolean;
  /** Pi-hole: the failed download left the old copy in use (status 3), so it still blocks. */
  keptOld?: boolean;
  /** Pi-hole: when it was added. */
  addedAt?: Date | null;
}

/** One read of Pi-hole or AdGuard Home; `null` parts couldn't be read. */
export interface DnsSnapshot {
  readAt: Date;
  service: DnsService;
  version: string | null;
  /** A newer version it knows of (“v6.6”), or null. */
  update: string | null;
  /** Over the service's last 24 hours (Pi-hole), or its statistics' period (AdGuard: `period`). */
  queries: number | null;
  /** The time the counts cover in words (“last 7 days”); absent: the last 24 hours. */
  period?: string;
  blocked: number | null;
  blockedPct: number | null;
  clients: number | null;
  /** Pi-hole: every client it has seen, active or not. */
  clientsSeen?: number | null;
  /** Pi-hole: the domains its lists block together. */
  domainsBlocked: number | null;
  /** Blocking (Pi-hole) or protection (AdGuard): on, or off until a moment or for good. */
  blocking: { on: boolean; until: Date | null } | null;
  /** AdGuard: its DNS server isn't running. */
  notRunning: boolean;
  /** AdGuard: filtering as a whole is switched off. */
  filteringOff: boolean;
  topBlocked: { domain: string; count: number }[] | null;
  topClients: { name: string; ip: string | null; count: number }[] | null;
  lists: DnsList[] | null;
  /** Pi-hole: when it last built its lists (gravity), which every list shares. */
  gravityAt: Date | null;
  /** Queries and blocked per hour, oldest first. */
  hours: { at: Date; total: number; blocked: number }[] | null;
  /** Pi-hole's own diagnosis (`/api/info/messages`), with its type (`RATE_LIMIT`, `LOAD`, `ADLIST`…). */
  messages: { id: string; text: string; at: Date | null; type?: string | null }[];
  /** Parts that couldn't be read whose emptiness would look fine (QN-S21): Pi-hole's messages, the version check. */
  unread?: { messages?: boolean; version?: boolean };
}

/* Reading ------------------------------------------------------------------------------------------------------------ */

const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** “v6.5” → [6, 5]; null when it isn't a version. */
function versionParts(v: string | null): number[] | null {
  const m = v ? /(\d+(?:\.\d+)*)/.exec(v) : null;
  return m?.[1] ? m[1].split('.').map(Number) : null;
}

/** Whether `remote` is newer than `local`. */
export function newer(local: string | null, remote: string | null): boolean {
  const a = versionParts(local);
  const b = versionParts(remote);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y !== x) return y > x;
  }
  return false;
}

/** Ten-minute buckets (Pi-hole's `/api/history`) as hours: the queries and blocked of each whole hour. */
export function hourly(buckets: readonly { at: Date; total: number; blocked: number }[]) {
  const by = new Map<number, { at: Date; total: number; blocked: number }>();
  for (const b of buckets) {
    const h = Math.floor(b.at.getTime() / 3600_000) * 3600_000;
    const cur = by.get(h) ?? { at: new Date(h), total: 0, blocked: 0 };
    cur.total += b.total;
    cur.blocked += b.blocked;
    by.set(h, cur);
  }
  return [...by.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** A list's name: its comment, else its address's host and file. */
function listName(address: string | null, comment: string | null): string {
  if (comment && !/^Migrated from /i.test(comment)) return comment;
  if (!address) return 'Block list';
  try {
    const u = new URL(address);
    const parts = u.pathname.split('/').filter(Boolean);
    // A list on GitHub is named by its owner and project (“StevenBlack/hosts”), the part people know it by.
    if (/^(raw\.githubusercontent\.com|github\.com)$/i.test(u.hostname) && parts.length >= 2)
      return `${parts[0]}/${parts[1]}`;
    const file = parts.slice(-2).join('/');
    return `${u.hostname}${file ? `/${file}` : ''}`;
  } catch {
    return address;
  }
}

/** Pi-hole's answers as a snapshot. */
export function parsePihole(
  parts: {
    summary: unknown;
    topBlocked: unknown;
    topClients: unknown;
    history: unknown;
    messages: unknown;
    version: unknown;
    lists: unknown;
    blocking: unknown;
  },
  now: Date,
): DnsSnapshot {
  const s = rec(parts.summary);
  const q = rec(s.queries);
  const g = rec(s.gravity);
  const v = rec(rec(parts.version).version);
  const core = rec(v.core);
  const local = str(rec(core.local).version);
  const updates = (['core', 'web', 'ftl'] as const)
    .map((k) => ({ local: str(rec(rec(v[k]).local).version), remote: str(rec(rec(v[k]).remote).version) }))
    .filter((x) => newer(x.local, x.remote));
  const docker = rec(v.docker);
  const dockerNew = newer(str(docker.local), str(docker.remote)) ? str(docker.remote) : null;
  const b = parts.blocking === null ? null : rec(parts.blocking);
  const timer = num(b?.timer);
  const blockingState = str(b?.blocking);
  const lists = parts.lists === null ? null : list(rec(parts.lists).lists).map(rec);
  const history = parts.history === null ? null : list(rec(parts.history).history).map(rec);
  return {
    readAt: now,
    service: 'pihole',
    version: local,
    update: dockerNew ?? (updates[0] ? (updates.find((u) => u.remote)?.remote ?? null) : null),
    queries: num(q.total),
    blocked: num(q.blocked),
    blockedPct: num(q.percent_blocked),
    clients: num(rec(s.clients).active),
    clientsSeen: num(rec(s.clients).total),
    domainsBlocked: num(g.domains_being_blocked),
    blocking:
      blockingState === 'enabled'
        ? { on: true, until: null }
        : blockingState === 'disabled'
          ? { on: false, until: timer && timer > 0 ? new Date(now.getTime() + timer * 1000) : null }
          : null,
    notRunning: false,
    filteringOff: false,
    topBlocked:
      parts.topBlocked === null
        ? null
        : list(rec(parts.topBlocked).domains)
            .map(rec)
            .map((d) => ({ domain: str(d.domain) ?? '', count: num(d.count) ?? 0 }))
            .filter((d) => d.domain),
    topClients:
      parts.topClients === null
        ? null
        : list(rec(parts.topClients).clients)
            .map(rec)
            .map((c) => ({ name: str(c.name) ?? str(c.ip) ?? '', ip: str(c.ip), count: num(c.count) ?? 0 }))
            .filter((c) => c.name),
    lists:
      lists
        ?.filter((l) => (str(l.type) ?? 'block') === 'block')
        .map((l, i) => ({
          id: String(num(l.id) ?? i),
          name: listName(str(l.address), str(l.comment)),
          rules: num(l.number),
          updatedAt: dateOf(l.date_updated),
          enabled: l.enabled !== false,
          // 3: the download failed and it kept its old copy; 4: failed with nothing to keep.
          failed: num(l.status) === 3 || num(l.status) === 4,
          ...(num(l.status) === 3 ? { keptOld: true } : {}),
          addedAt: dateOf(l.date_added),
        })) ?? null,
    gravityAt: dateOf(g.last_update),
    hours: history
      ? hourly(
          history
            .map((h) => ({ at: dateOf(h.timestamp), total: num(h.total) ?? 0, blocked: num(h.blocked) ?? 0 }))
            .filter((h): h is { at: Date; total: number; blocked: number } => h.at !== null),
        )
      : null,
    messages: list(rec(parts.messages).messages)
      .map(rec)
      .map((m, i) => ({
        id: String(num(m.id) ?? i),
        text: str(m.plain) ?? str(m.message) ?? '',
        at: dateOf(m.timestamp),
        type: str(m.type),
      }))
      .filter((m) => m.text),
    ...unreadOf({ messages: parts.messages === null, version: parts.version === null }),
  };
}

/** The `unread` part of a snapshot, absent when everything was read. */
function unreadOf(u: { messages?: boolean; version?: boolean }): Pick<DnsSnapshot, 'unread'> {
  const set = Object.fromEntries(Object.entries(u).filter(([, v]) => v));
  return Object.keys(set).length ? { unread: set } : {};
}

/** AdGuard's `[{name: count}]` lists as pairs. */
function pairs(raw: unknown): { key: string; count: number }[] {
  return list(raw).flatMap((o) => Object.entries(rec(o)).map(([key, v]) => ({ key, count: num(v) ?? 0 })));
}

/**
 * AdGuard's names for its clients' addresses (`/control/clients`): the ones a person named first, then what it found
 * itself (its hosts file, reverse lookups). Only plain addresses; a client named by a range or a MAC address isn't.
 */
export function adguardNames(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const r = rec(raw);
  for (const c of list(r.clients).map(rec)) {
    const name = str(c.name);
    if (name) for (const id of list(c.ids)) if (typeof id === 'string' && !out.has(id)) out.set(id, name);
  }
  for (const c of list(r.auto_clients).map(rec)) {
    const ip = str(c.ip);
    const name = str(c.name);
    if (ip && name && !out.has(ip)) out.set(ip, name);
  }
  return out;
}

/** AdGuard Home's answers as a snapshot. */
export function parseAdguard(
  parts: { stats: unknown; status: unknown; filtering: unknown; version: unknown; clients?: unknown },
  now: Date,
): DnsSnapshot {
  const names = adguardNames(parts.clients ?? null);
  const st = parts.stats === null ? null : rec(parts.stats);
  const status = rec(parts.status);
  const version = str(status.version);
  const vj = rec(parts.version);
  const latest = str(vj.new_version);
  const queries = num(st?.num_dns_queries);
  const blocked = num(st?.num_blocked_filtering);
  const disabledMs = num(status.protection_disabled_duration) ?? 0;
  const perHour = st && str(st.time_units) !== 'days';
  const total = list(st?.dns_queries).map((n) => num(n) ?? 0);
  // AdGuard counts over its statistics' interval (a day to 90 days), one entry per hour or per day.
  const period = !st
    ? undefined
    : perHour
      ? total.length > 1
        ? `last ${total.length} hours`
        : undefined
      : total.length > 1
        ? `last ${total.length} days`
        : 'recently';
  const blockedHours = list(st?.blocked_filtering).map((n) => num(n) ?? 0);
  const hourStart = Math.floor(now.getTime() / 3600_000) * 3600_000;
  const filtering = parts.filtering === null ? null : rec(parts.filtering);
  return {
    readAt: now,
    service: 'adguard',
    version,
    update: latest && vj.disabled !== true && newer(version, latest) ? latest : null,
    queries,
    blocked,
    blockedPct: queries ? ((blocked ?? 0) / queries) * 100 : queries === 0 ? 0 : null,
    clients: st ? pairs(st.top_clients).length : null,
    ...(period ? { period } : {}),
    domainsBlocked: null,
    blocking:
      typeof status.protection_enabled === 'boolean'
        ? status.protection_enabled
          ? { on: true, until: null }
          : { on: false, until: disabledMs > 0 ? new Date(now.getTime() + disabledMs) : null }
        : null,
    notRunning: status.running === false,
    filteringOff: filtering?.enabled === false,
    topBlocked: st ? pairs(st.top_blocked_domains).map((p) => ({ domain: p.key, count: p.count })) : null,
    topClients: st
      ? pairs(st.top_clients).map((p) => ({ name: names.get(p.key) ?? p.key, ip: p.key, count: p.count }))
      : null,
    lists: filtering
      ? list(filtering.filters)
          .map(rec)
          .map((f, i) => ({
            id: String(num(f.id) ?? i),
            name: str(f.name) ?? listName(str(f.url), null),
            rules: num(f.rules_count),
            updatedAt: dateOf(f.last_updated),
            enabled: f.enabled === true,
            failed: false,
          }))
      : null,
    gravityAt: null,
    hours: perHour
      ? total.map((t, i) => ({
          at: new Date(hourStart - (total.length - 1 - i) * 3600_000),
          total: t,
          blocked: blockedHours[i] ?? 0,
        }))
      : null,
    messages: [],
    ...unreadOf({ version: parts.version === null }),
  };
}

/** A read with POST (AdGuard's update check only reads), as the connection. */
async function postRead(services: Services, row: CatalogConnectionRow, path: string, body: unknown) {
  const res = await externalEffect(
    'things.read',
    () =>
      signedConnectionFetch(
        services,
        row,
        {
          method: 'POST',
          url: `${row.baseUrl.replace(/\/+$/, '')}${path}`,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        },
        { maxBytes: KIND_MAX_BYTES, deadlineMs: KIND_DEADLINE_MS },
      ),
    { idempotent: true },
  );
  if (res.status >= 400) throw new ReadProblem('AdGuard Home answered with an error.');
  return JSON.parse(res.body.toString('utf8')) as unknown;
}

async function readDns(services: Services, row: CatalogConnectionRow, now: Date): Promise<DnsSnapshot> {
  const service = row.catalogId as DnsService;
  const name = NAMES[service];
  const get = (path: string, query?: Record<string, string>) => getJson(services, row, name, path, query);
  if (service === 'pihole') {
    const [summary, topBlocked, topClients, history, messages, version, lists, blocking] = await Promise.all([
      get('/api/stats/summary'),
      optional(get('/api/stats/top_domains', { blocked: 'true', count: '10' })),
      optional(get('/api/stats/top_clients', { count: '10' })),
      optional(get('/api/history')),
      optional(get('/api/info/messages')),
      optional(get('/api/info/version')),
      optional(get('/api/lists', { type: 'block' })),
      optional(get('/api/dns/blocking')),
    ]);
    return parsePihole({ summary, topBlocked, topClients, history, messages, version, lists, blocking }, now);
  }
  const [status, stats, filtering, version, clients] = await Promise.all([
    get('/control/status'),
    optional(get('/control/stats')),
    optional(get('/control/filtering/status')),
    optional(postRead(services, row, '/control/version.json', { recheck_now: false })),
    optional(get('/control/clients')),
  ]);
  return parseAdguard({ status, stats, filtering, version, clients }, now);
}

function loadDns(services: Services, row: CatalogConnectionRow, now: Date) {
  const name = NAMES[row.catalogId as DnsService] ?? 'The service';
  return async (): Promise<DnsSnapshot> => {
    try {
      return await withDeadline(
        readDns(services, row, now),
        KIND_DEADLINE_MS,
        `${name} didn’t answer in time.`,
      );
    } catch (err) {
      throw problemOf(err, name);
    }
  };
}

const key = (row: CatalogConnectionRow) => `dns:${row.id}`;

export function dnsLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, key(row), row, loadDns(services, row, now));
}

export function dnsSnapshot(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return cachedRead(services, key(row), row, loadDns(services, row, now));
}

/* What it means ------------------------------------------------------------------------------------------------------- */

/** “18.2 %”: one decimal below 10 and above, as Pi-hole shows it. */
export function share(p: number): string {
  return `${p.toFixed(1)} %`;
}

/** The lists' last update: Pi-hole's gravity, else the oldest enabled list's. */
export function listsUpdatedAt(s: DnsSnapshot): Date | null {
  if (s.gravityAt) return s.gravityAt;
  const times = (s.lists ?? [])
    .filter((l) => l.enabled && l.updatedAt)
    .map((l) => (l.updatedAt as Date).getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

/** “Blocking is off until 14:35”, “… until you turn it on”, null while it blocks. */
export function blockingOffWords(s: DnsSnapshot, timeZone: string): string | null {
  if (!s.blocking || s.blocking.on) return null;
  const what = s.service === 'pihole' ? 'Blocking' : 'Protection';
  return s.blocking.until
    ? `${what} is off until ${clock(s.blocking.until, timeZone)}`
    : `${what} is off until you turn it on`;
}

export interface DnsCtx {
  now: Date;
  timeZone: string;
  range: PageRange;
  /** The connection, for the head's buttons (SD-07). */
  buttons: ButtonCtx;
  points: { queries: RawPoint[]; blocked: RawPoint[] };
}

function spark(points: RawPoint[], ctx: DnsCtx) {
  const values = onRange([points], ctx.range, ctx.now).values[0] as (number | null)[];
  return drawable(values) ? { spark: downsample(values) } : {};
}

/** The four figures (SD-34): Queries, Blocked, Clients, Lists. */
export function dnsKpis(s: DnsSnapshot, ctx: DnsCtx): ThingPageKpi[] {
  const out: ThingPageKpi[] = [];
  if (s.queries !== null)
    out.push({
      key: 'queries',
      label: 'Queries',
      value: thousands(s.queries),
      sub: s.period ?? 'last 24 hours',
      ...spark(ctx.points.queries, ctx),
      color: 'blue',
    });
  if (s.blockedPct !== null) {
    const off = s.blocking && !s.blocking.on;
    out.push({
      key: 'blocked',
      label: 'Blocked',
      value: share(s.blockedPct),
      sub: off ? (blockingOffWords(s, ctx.timeZone) ?? '') : `${thousands(s.blocked ?? 0)} queries`,
      ...(off ? { tone: s.blocking?.until ? ('warn' as const) : ('bad' as const) } : {}),
      ...spark(ctx.points.blocked, ctx),
      color: 'orange',
    });
  }
  if (s.clients !== null)
    out.push({
      key: 'clients',
      label: 'Clients',
      value: thousands(s.clients),
      sub: s.service === 'pihole' ? 'active' : (s.period ?? 'last 24 hours'),
    });
  if (s.lists) {
    const enabled = s.lists.filter((l) => l.enabled).length;
    const at = listsUpdatedAt(s);
    const old = at && ctx.now.getTime() - at.getTime() > LISTS_OLD_MS;
    out.push({
      key: 'lists',
      label: 'Lists',
      value: String(enabled),
      ...(s.domainsBlocked ? { rest: `· ${thousands(s.domainsBlocked)} domains` } : {}),
      sub: at ? `updated ${span(ctx.now.getTime() - at.getTime())} ago` : 'not updated yet',
      ...(old || !at ? { tone: 'warn' as const } : {}),
    });
  }
  return out;
}

/** A bar's word: the hour it starts at in the burrow's zone (“14”), “Now” for the one going on. */
export function hourWords(hours: readonly Date[], timeZone: string): string[] {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
  return hours.map((h, i) => (i === hours.length - 1 ? 'Now' : hour.format(h)));
}

/**
 * The last 24 hours as bars of two hours, each starting at an even hour in the burrow's zone so midnight is always
 * between two bars (a screen counts today's from them): a word under each of 24 bars doesn't fit a third of the page.
 */
export function twoHours(
  hours: readonly { at: Date; total: number; blocked: number }[],
  timeZone: string,
): { at: Date; total: number; blocked: number }[] {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' });
  const out: { at: Date; total: number; blocked: number }[] = [];
  for (const h of hours) {
    const last = out.at(-1);
    if (last && Number(hour.format(h.at)) % 2 === 1 && h.at.getTime() - last.at.getTime() <= 3600_000) {
      last.total += h.total;
      last.blocked += h.blocked;
    } else out.push({ at: h.at, total: h.total, blocked: h.blocked });
  }
  return out;
}

/**
 * The Trend: lookups over the last 24 hours (all the service keeps) in two-hour bars, stacked: what got through and
 * what was blocked, with the hour under each bar. Its figure is the lookups, the share kept out beside it.
 */
export function dnsTrend(s: DnsSnapshot, timeZone: string): TrendPanel | null {
  const hours = (s.hours ?? []).slice(-24);
  if (hours.length < 2) return null;
  const bars = twoHours(hours, timeZone);
  const total = hours.reduce((n, h) => n + h.total, 0);
  const blocked = hours.reduce((n, h) => n + h.blocked, 0);
  const at = bars.map((h) => h.at);
  const t = trend({
    id: 'queries',
    title: 'Last 24 hours',
    meta: 'Lookups per 2 hours',
    days: { at, labels: hourWords(at, timeZone) },
    values: bars.map((h) => h.total),
    label: 'Lookups',
    figure: { value: thousands(total), rest: total === 1 ? 'lookup' : 'lookups' },
    change: total ? share((blocked / total) * 100) : null,
    changeWords: ' kept out',
  });
  return {
    ...t,
    series: [
      {
        key: 'allowed',
        label: 'Answered',
        values: bars.map((h) => Math.max(0, h.total - h.blocked)),
        color: 'blue',
        latest: thousands(total - blocked),
      },
      {
        key: 'blocked',
        label: 'Blocked',
        values: bars.map((h) => h.blocked),
        color: 'orange',
        latest: thousands(blocked),
      },
    ],
  };
}

/** Every check Pi-hole and AdGuard Home raise (What Whombat watches, QN-15). */
export const DNS_CHECKS: readonly KindCheck[] = [
  { check: 'dns.not_running', name: 'DNS stopping', nature: 'problem', perItem: false, startsOn: true },
  {
    check: 'dns.blocking_off',
    name: 'Blocking switched off',
    nature: 'you',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'dns.filtering_off',
    name: 'Block lists switched off',
    nature: 'you',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'dns.list_failed',
    name: 'Block lists failing to download',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'dns.lists_old',
    name: 'Block lists getting old',
    nature: 'problem',
    perItem: false,
    startsOn: false,
  },
  { check: 'dns.message', name: 'Pi-hole’s own warnings', nature: 'problem', perItem: true, startsOn: false },
  { check: 'dns.update', name: 'New versions', nature: 'fyi', perItem: false, startsOn: false },
];

/** Pi-hole's: its DNS has no running flag, filtering no switch of its own. */
export const PIHOLE_CHECKS = DNS_CHECKS.filter(
  (c) => c.check !== 'dns.not_running' && c.check !== 'dns.filtering_off',
);
/** AdGuard Home's: no diagnosis messages, no failed downloads in its answer. */
export const ADGUARD_CHECKS = DNS_CHECKS.filter(
  (c) => c.check !== 'dns.message' && c.check !== 'dns.list_failed',
);

/** Pi-hole's message types that say how it is used, not that something is wrong: heads-ups (QN-04). */
const FYI_MESSAGES = new Set(['RATE_LIMIT', 'LOAD', 'HOSTNAME']);

const listSubject = (l: DnsList) => ({ id: `list:${l.id}`.slice(0, 160), name: subjectName(l.name) });
const short = (title: string, badge: string) => (title.length > 40 ? { badge } : {});

/**
 * “Worth a look” (SD-34, QN-01…QN-04): the DNS not running; blocking off for good (only you turn it back on) or paused
 * for a while (a heads-up: someone pressed Pause, it ends by itself); filtering off; one line per list that failed to
 * download (a heads-up while Pi-hole still uses its old copy); lists older than 9 days; one line per Pi-hole message
 * (heads-ups for how it is used: rate limits, load, host names); an update.
 */
export function dnsNotices(s: DnsSnapshot, ctx: DnsCtx): KindNotice[] {
  const name = NAMES[s.service];
  const out: KindNotice[] = [];
  if (s.notRunning)
    out.push({
      id: 'not-running',
      tone: 'bad',
      icon: 'power',
      title: `${name}’s DNS isn’t running`,
      detail: 'Devices that use it can’t look up addresses.',
      link: { kind: 'ask', label: 'Look into it', question: `Why isn’t ${name}’s DNS server running?` },
      nature: 'problem',
      check: 'dns.not_running',
      ignore: { lifts: 'fixed', words: 'Until it’s running again.' },
      badge: 'Not running',
    });
  const off = blockingOffWords(s, ctx.timeZone);
  const what = s.service === 'pihole' ? 'Blocking' : 'Protection';
  if (off && s.blocking?.until)
    out.push({
      id: 'blocking-off',
      tone: 'info',
      icon: 'shield',
      title: off,
      detail: 'Ads and trackers get through meanwhile.',
      nature: 'fyi',
      check: 'dns.blocking_off',
      ignore: { lifts: 'newer', words: 'Until the next pause.' },
      episode: s.blocking.until.toISOString(),
      badge: 'Paused',
    });
  else if (off)
    out.push({
      id: 'blocking-off',
      // Off for good is red on the card (SD-34): only a person turns it back on.
      tone: 'bad',
      icon: 'shield',
      title: off,
      detail: 'Ads and trackers get through meanwhile.',
      nature: 'you',
      check: 'dns.blocking_off',
      ignore: { lifts: 'fixed', words: `Until ${what.toLowerCase()} is back on.` },
      badge: `${what} off`,
    });
  if (s.filteringOff)
    out.push({
      id: 'filtering-off',
      tone: 'warn',
      icon: 'warn',
      title: 'Block lists are switched off',
      detail: `${name} lets everything through: its block lists are off.`,
      nature: 'you',
      check: 'dns.filtering_off',
      ignore: { lifts: 'fixed', words: 'Until the lists are back on.' },
    });
  const failed = (s.lists ?? [])
    .filter((l) => l.enabled && l.failed)
    // The ones without a copy first: they block nothing.
    .sort((a, b) => Number(!!a.keptOld) - Number(!!b.keptOld) || a.name.localeCompare(b.name));
  out.push(
    ...itemLines(
      failed,
      (l) => listSubject(l).id,
      (l) => {
        const title = clip(`${l.name} couldn’t be downloaded`, 120);
        return {
          id: lineId('list-failed', l.id),
          tone: l.keptOld ? 'info' : 'warn',
          icon: 'network',
          title,
          detail: l.keptOld
            ? `${name} still blocks with the copy it has.`
            : 'It blocks nothing until it downloads again.',
          // A problem asks with its own question (QN-02, QN-S49); a list still in use is a heads-up.
          ...(l.keptOld
            ? {}
            : {
                link: {
                  kind: 'ask' as const,
                  label: 'Look into it',
                  question: clip(`Why can’t ${name} download the block list ${l.name}?`, 300),
                },
              }),
          nature: l.keptOld ? 'fyi' : 'problem',
          check: 'dns.list_failed',
          subject: listSubject(l),
          ignore: { lifts: 'fixed', words: 'Until it downloads again.' },
          ...short(title, 'A block list failed'),
        };
      },
      (more, subject, episode) => ({
        id: 'list-failed-more',
        tone: more.every((l) => l.keptOld) ? 'info' : 'warn',
        icon: 'network',
        title: `${more.length} more block lists couldn’t be downloaded`,
        detail: clip(more.map((l) => l.name).join(' · '), 200),
        ...(more.every((l) => l.keptOld)
          ? {}
          : {
              link: {
                kind: 'ask' as const,
                label: 'Look into it',
                question: `Why can’t ${name} download some of its block lists?`,
              },
            }),
        nature: more.every((l) => l.keptOld) ? 'fyi' : 'problem',
        check: 'dns.list_failed',
        subject,
        episode,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
        badge: 'Block lists failed',
      }),
    ),
  );
  const at = listsUpdatedAt(s);
  if (at && ctx.now.getTime() - at.getTime() > LISTS_OLD_MS)
    out.push({
      id: 'lists-old',
      tone: 'warn',
      icon: 'clock',
      title: `Block lists last updated ${span(ctx.now.getTime() - at.getTime())} ago`,
      detail: 'New ad and tracker addresses aren’t blocked until they update.',
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: `Why haven’t ${name}’s block lists updated for so long?`,
      },
      nature: 'problem',
      check: 'dns.lists_old',
      ignore: { lifts: 'fixed', words: 'Until the lists update.' },
      badge: 'Block lists are old',
    });
  out.push(
    ...itemLines(
      s.messages,
      (m) => `message:${m.id}`,
      (m) => {
        const fyi = FYI_MESSAGES.has((m.type ?? '').toUpperCase());
        // Pi-hole's messages are written for admins: they are the detail, under Whombat's own title.
        const title = fyi ? `${name} has a note` : `${name} has a warning`;
        return {
          id: lineId('message', m.id),
          tone: fyi ? 'info' : 'warn',
          icon: 'info',
          title,
          detail: clip(m.text, 200),
          ...(fyi
            ? {}
            : {
                link: {
                  kind: 'ask' as const,
                  label: 'Look into it',
                  question: clip(`What does ${name}’s message “${m.text}” mean?`, 300),
                },
              }),
          nature: fyi ? 'fyi' : 'problem',
          check: 'dns.message',
          // Pi-hole gives a message that comes back a new id: the id is the message.
          subject: { id: `message:${m.id}`.slice(0, 160), name: subjectName(clip(m.text, 80)) },
          ignore: { lifts: 'fixed', words: `Until ${name} clears it.` },
          ...short(title, `${name} has a warning`),
        };
      },
      (more, subject, episode) => {
        const fyi = more.every((m) => FYI_MESSAGES.has((m.type ?? '').toUpperCase()));
        return {
          id: 'message-more',
          tone: fyi ? 'info' : 'warn',
          icon: 'info',
          title: `${more.length} more messages from ${name}`,
          detail: clip(more.map((m) => m.text).join(' · '), 200),
          nature: fyi ? 'fyi' : 'problem',
          check: 'dns.message',
          subject,
          episode,
          ignore: { lifts: 'newer', words: 'Until the list changes.' },
          badge: `${name} has warnings`,
        };
      },
    ),
  );
  if (s.update)
    out.push({
      id: 'update',
      tone: 'info',
      icon: 'update',
      title: `${name} has an update`,
      detail: s.version ? `Version ${s.update}; this one runs ${s.version}.` : `Version ${s.update}.`,
      nature: 'fyi',
      check: 'dns.update',
      ignore: { lifts: 'newer', words: 'Until the next version.' },
      episode: s.update,
    });
  return out;
}

/** The checks this read couldn't fully see (QN-S21): blocking, the lists, Pi-hole's messages, the version check. */
export function dnsSkipped(s: DnsSnapshot): string[] {
  const out: string[] = [];
  if (!s.blocking) out.push('dns.blocking_off');
  if (!s.lists) {
    out.push('dns.list_failed');
    if (!s.gravityAt) out.push('dns.lists_old');
    // AdGuard's filtering status is the lists' read.
    if (s.service === 'adguard') out.push('dns.filtering_off');
  }
  if (s.unread?.messages) out.push('dns.message');
  if (s.unread?.version) out.push('dns.update');
  return out;
}

/** Top blocked (SD-34): domain and count, as bars against the busiest. */
export function topBlockedBars(s: DnsSnapshot): ThingPageBar[] {
  const top = (s.topBlocked ?? []).slice(0, 10);
  const max = Math.max(1, ...top.map((d) => d.count));
  return top.map((d, i) => ({
    id: `d${i}`,
    label: clip(d.domain, 80),
    mono: true,
    value: thousands(d.count),
    pct: d.count / max,
  }));
}

/** The block lists (SD-34): name, rules, last updated; switched-off ones last. */
export function listRows(s: DnsSnapshot, now: Date): ThingPageRow[] {
  return (s.lists ?? [])
    .slice()
    .sort((a, b) => Number(b.enabled) - Number(a.enabled))
    .slice(0, 100)
    .map((l) => {
      // A list keeps its own date until its content changes; an update of every list since is newer (SD-S21).
      const at =
        l.enabled && s.gravityAt && (!l.updatedAt || s.gravityAt > l.updatedAt) ? s.gravityAt : l.updatedAt;
      return {
        id: `list-${l.id}`.slice(0, 200),
        cells: {
          name: {
            text: clip(l.name, 200),
            dot: !l.enabled ? ('off' as const) : l.failed ? ('warn' as const) : ('ok' as const),
            ...(!l.enabled ? { note: 'off' } : l.failed ? { note: 'download failed' } : {}),
          },
          rules: { text: l.rules !== null ? thousands(l.rules) : '', mono: true },
          updated: {
            text: at ? `${span(now.getTime() - at.getTime())} ago` : 'never',
            ...(at && now.getTime() - at.getTime() > LISTS_OLD_MS ? { tone: 'warn' as const } : {}),
          },
        },
      };
    });
}

/** The head's buttons (SD-34): pause 5 or 30 minutes (the longer one confirmed), resume while off, update the lists. */
export function dnsButtons(s: DnsSnapshot, bctx: ButtonCtx): ThingPageButton[] {
  const name = NAMES[s.service];
  const out: ThingPageButton[] = [];
  if (s.blocking && !s.blocking.on)
    out.push(button(bctx, { action: 'resume', label: 'Resume', icon: 'play', tone: 'primary' }));
  else if (s.blocking) {
    out.push(button(bctx, { action: 'pause', value: 300, label: 'Pause 5 min', icon: 'pause' }));
    out.push(
      button(bctx, {
        action: 'pause',
        value: 1800,
        label: 'Pause 30 min',
        icon: 'pause',
        confirm: {
          title: `Pause blocking for 30 minutes?`,
          body: `${name} lets ads and trackers through for every device that uses it, then blocks again by itself.`,
          button: 'Pause 30 min',
        },
      }),
    );
  }
  if (s.lists) out.push(button(bctx, { action: 'update-lists', label: 'Update lists', icon: 'retry' }));
  return out;
}

function headFacts(s: DnsSnapshot, timeZone: string): ThingLine[] {
  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`${NAMES[s.service]} **${s.version}**`));
  const off = blockingOffWords(s, timeZone);
  facts.push(line(off ? `**${off}**` : s.blocking?.on ? 'Blocking **on**' : ''));
  return facts.filter((f) => f.length);
}

/** Live, “Blocking now”: whether it blocks with its Pause buttons (Resume while off), and how much it kept out. */
export function dnsLive(s: DnsSnapshot, ctx: DnsCtx): LivePanel | null {
  const name = NAMES[s.service];
  const what = s.service === 'pihole' ? 'Blocking' : 'Protection';
  const items: ThingPageItem[] = [];
  const off = s.blocking && !s.blocking.on;
  const offWords = blockingOffWords(s, ctx.timeZone);
  const offTone = s.blocking?.until ? ('warn' as const) : ('bad' as const);
  if (s.blocking) {
    const actions = dnsButtons(s, ctx.buttons).filter((b) => b.action !== 'update-lists');
    items.push({
      id: 'blocking',
      title: what,
      icon: 'shield',
      detail: off
        ? `Ads and trackers get through on every device that uses ${name}.`
        : `Ads and trackers are kept out on every device that uses ${name}.`,
      right: off ? (s.blocking.until ? `Off until ${clock(s.blocking.until, ctx.timeZone)}` : 'Off') : 'On',
      tone: off ? offTone : 'ok',
      ...(actions.length ? { actions } : {}),
    });
  }
  if (s.blockedPct !== null)
    items.push(
      countLine({
        id: 'blocked',
        title: 'Blocked',
        icon: 'shield',
        value: share(s.blockedPct),
        detail:
          s.queries !== null
            ? `${thousands(s.blocked ?? 0)} of ${thousands(s.queries)} lookups · ${s.period ?? 'last 24 hours'}`
            : `${thousands(s.blocked ?? 0)} lookups · ${s.period ?? 'last 24 hours'}`,
        // A screen's “Ads kept out today” turns red with these words while it is off.
        ...(off && offWords ? { note: offWords, noteTone: offTone } : {}),
      }),
    );
  if (!items.length) return null;
  return liveList({ id: 'blocking-now', title: 'Blocking now', items });
}

/** Inventory: the block lists with what changed (added this week, a failed download, how old) and Update lists, and the devices. */
export function dnsInventory(s: DnsSnapshot, ctx: DnsCtx): InventoryPanel | null {
  const items: ThingPageItem[] = [];
  if (s.lists) {
    const on = s.lists.filter((l) => l.enabled);
    const failed = on.filter((l) => l.failed).length;
    const at = listsUpdatedAt(s);
    const old = !at || ctx.now.getTime() - at.getTime() > LISTS_OLD_MS;
    const added =
      s.service === 'pihole'
        ? on.filter((l) => l.addedAt && ctx.now.getTime() - l.addedAt.getTime() < 7 * DAY).length
        : 0;
    const rules = on.reduce((n, l) => n + (l.rules ?? 0), 0);
    const size =
      s.domainsBlocked !== null
        ? `${thousands(s.domainsBlocked)} domains`
        : rules
          ? `${thousands(rules)} ${s.service === 'pihole' ? 'domains' : 'rules'}`
          : null;
    const updated = at ? `updated ${span(ctx.now.getTime() - at.getTime())} ago` : 'not updated yet';
    items.push(
      countLine({
        id: 'lists',
        title: 'Block lists',
        icon: 'shield',
        value: thousands(on.length),
        detail: [size, updated].filter(Boolean).join(' · '),
        ...(failed
          ? { note: `${failed} failed to update`, noteTone: 'warn' as const }
          : old
            ? { note: at ? 'Getting old' : 'Not updated yet', noteTone: 'warn' as const }
            : added
              ? { note: `+${added} this week`, noteTone: 'ok' as const }
              : { note: `${s.lists.length - on.length ? `${s.lists.length - on.length} off` : 'All on'}` }),
        actions: [button(ctx.buttons, { action: 'update-lists', label: 'Update lists', icon: 'retry' })],
      }),
    );
  }
  if (s.clients !== null)
    items.push(
      countLine({
        id: 'clients',
        title: 'Devices',
        icon: 'device',
        value: thousands(s.clients),
        note:
          s.service === 'pihole'
            ? s.clientsSeen
              ? `active · ${thousands(s.clientsSeen)} seen`
              : 'active'
            : (s.period ?? 'last 24 hours'),
      }),
    );
  return items.length ? inventory({ id: 'inventory', title: 'Lists and devices', items }) : null;
}

/** People: the devices that look up the most, by the name the service has for them, the address beside a bare name. */
export function busiestDevices(s: DnsSnapshot): PeoplePanel | null {
  return people({
    id: 'top-clients',
    title: 'Busiest devices',
    meta: s.period ?? 'last 24 hours',
    unit: ['lookup'],
    items: (s.topClients ?? []).slice(0, 8).map((c) => ({
      name: c.name,
      n: c.count,
      value: thousands(c.count),
      ...(c.ip && c.ip !== c.name ? { note: c.ip } : {}),
    })),
  });
}

/** Its own line in “The machine”: its version, and whether a newer one is out. */
export function dnsMachineLines(s: DnsSnapshot): ThingPageBar[] {
  if (!s.version) return [];
  return [
    {
      id: 'dns-version',
      label: NAMES[s.service],
      value: clip(s.version, 40),
      pct: null,
      ...(s.update
        ? { sub: clip(`Version ${s.update} is out`, 120) }
        : s.unread?.version
          ? {}
          : { sub: 'Up to date', subTone: 'ok' as const }),
    },
  ];
}

/**
 * The page's own part when the read worked, its Summary in slots: Blocking now beside the lists and devices, the
 * last 24 hours' lookups and the busiest devices beside the machine, the most blocked sites below them; the block
 * lists one by one in their tab.
 */
export function dnsView(
  s: DnsSnapshot,
  ctx: DnsCtx,
): Pick<
  KindView,
  'kpis' | 'charts' | 'notices' | 'panels' | 'slots' | 'tabs' | 'facts' | 'status' | 'machine' | 'buttons'
> {
  const more: ThingPagePanel[] = [];
  if (s.topBlocked)
    more.push({
      kind: 'bars',
      id: 'top-blocked',
      place: 'main',
      title: 'Most blocked',
      meta: s.period ?? 'last 24 hours',
      items: topBlockedBars(s),
      empty: 'Nothing blocked yet.',
    });
  const tabs: ThingPageTab[] = s.lists
    ? [
        {
          key: 'lists',
          label: 'Block lists',
          count: s.lists.length,
          panels: [
            {
              kind: 'table',
              id: 'lists',
              title: 'Block lists',
              meta: `${s.lists.filter((l) => l.enabled).length} of ${s.lists.length} on`,
              columns: [
                { key: 'name', label: 'List' },
                { key: 'rules', label: s.service === 'pihole' ? 'Domains' : 'Rules', numeric: true },
                { key: 'updated', label: 'Updated' },
              ],
              rows: listRows(s, ctx.now),
              empty: 'No block lists.',
            },
          ],
        },
      ]
    : [];
  return {
    // In slots its counts are in Blocking now and Lists and devices; the card keeps the figures (`dnsSeen`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: dnsNotices(s, ctx),
    ...slotPanels({
      live: dnsLive(s, ctx),
      inventory: dnsInventory(s, ctx),
      trend: dnsTrend(s, ctx.timeZone),
      people: busiestDevices(s),
      more,
      machine: dnsMachineLines(s),
    }),
    tabs,
    facts: headFacts(s, ctx.timeZone),
    // Pause and Resume are in Blocking now, Update lists on its line.
    buttons: [],
  };
}

/** “Open Pi-hole”: its admin pages; AdGuard Home's at its root. */
export function dnsUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl' | 'catalogId'>): string {
  const base = (row.fields.url ?? row.baseUrl).replace(/\/+$/, '');
  return row.catalogId === 'pihole' ? `${base}/admin/` : base;
}

export async function dnsPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const service = row.catalogId as DnsService;
  const name = NAMES[service];
  const [read, points] = await Promise.all([
    dnsLatest(services, row, now),
    readPoints(services.db, row.id, [DNS_Q_KEY, DNS_BLOCKED_KEY], now, RANGE_MS[ctx.range]).catch(
      () => new Map<string, RawPoint[]>(),
    ),
  ]);
  const base: KindView = {
    notices: [],
    panels: [],
    tabs: [],
    facts: [],
    open: { label: `Open ${name}`, url: dnsUrl(row) },
    actions: [],
    readAt: null,
    machine: 'after',
    charts: [],
    suggestions: ['Blocked over the week', 'Busiest clients', 'Queries per day'],
    refreshing: read.refreshing,
  };
  if (!read.ok) return { ...base, problem: problemOf(read.error, name).message };
  const view = dnsView(read.value, {
    now,
    timeZone: ctx.timeZone,
    range: ctx.range,
    buttons: { row },
    points: { queries: points.get(DNS_Q_KEY) ?? [], blocked: points.get(DNS_BLOCKED_KEY) ?? [] },
  });
  return { ...base, ...view, readAt: read.value.readAt };
}

/** The card (SD-34): Blocked, Queries; red while blocking is off for good. Points `dns_q`, `dns_blocked` (SD-S06). */
export async function dnsSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const s = await dnsSnapshot(services, row, now);
  const ctx: DnsCtx = {
    now,
    timeZone,
    range: '24h',
    buttons: { row },
    points: { queries: [], blocked: [] },
  };
  const kpis = dnsKpis(s, ctx);
  const pick = (k: string) => kpis.filter((x) => x.key === k);
  const notices = dnsNotices(s, ctx);
  return {
    glance: seenFromView(
      { kpis: [...pick('blocked'), ...pick('queries')], notices },
      { figures: 2, ...(s.version ? { line: `${NAMES[s.service]} ${s.version}` } : {}) },
    ),
    points: { [DNS_Q_KEY]: s.queries, [DNS_BLOCKED_KEY]: s.blockedPct },
    notices,
    skipped: dnsSkipped(s),
  };
}

/* Buttons ------------------------------------------------------------------------------------------------------------ */

const PAUSES = new Set([300, 1800]);

/** Pause blocking for 5 or 30 minutes (SD-34; everyday, SD-08). */
const pause: KindAction = async ({ services, row }, { value }) => {
  const service = row.catalogId as DnsService;
  const name = NAMES[service];
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!PAUSES.has(seconds)) throw badRequest('Blocking pauses for 5 or 30 minutes.');
  if (service === 'pihole')
    await actAs(services, row, name, {
      method: 'POST',
      path: '/api/dns/blocking',
      body: { blocking: false, timer: seconds },
    });
  else
    await actAs(services, row, name, {
      method: 'POST',
      path: '/control/protection',
      body: { enabled: false, duration: seconds * 1000 },
    });
  const minutes = seconds / 60;
  return {
    message: `Blocking is paused for ${minutes} minutes. It turns back on by itself.`,
    title: `Paused blocking on ${name} for ${minutes} minutes`,
    everyday: true,
  };
};

/** Turn blocking back on (everyday). */
const resume: KindAction = async ({ services, row }) => {
  const service = row.catalogId as DnsService;
  const name = NAMES[service];
  if (service === 'pihole')
    await actAs(services, row, name, { method: 'POST', path: '/api/dns/blocking', body: { blocking: true } });
  else
    await actAs(services, row, name, {
      method: 'POST',
      path: '/control/protection',
      body: { enabled: true },
    });
  return { message: 'Blocking is on again.', title: `Turned blocking back on in ${name}`, everyday: true };
};

/** Update the block lists (Pi-hole's gravity, AdGuard's refresh); it can take a few minutes. */
const updateLists: KindAction = async ({ services, row }) => {
  const service = row.catalogId as DnsService;
  const name = NAMES[service];
  const done = { title: `Updated ${name}’s block lists`, everyday: true };
  try {
    if (service === 'pihole')
      await actAs(services, row, name, { method: 'POST', path: '/api/action/gravity' });
    else
      await actAs(services, row, name, {
        method: 'POST',
        path: '/control/filtering/refresh',
        body: { whitelist: false },
      });
  } catch (err) {
    // Pi-hole builds its lists while it answers: a long one is still going when the call's time is up.
    if (err instanceof ApiError && err.code === 'unavailable' && /in time/.test(err.message))
      return { ...done, message: `${name} is still updating its lists. It takes a few minutes.` };
    throw err;
  }
  return { ...done, message: `${name} updated its block lists.` };
};

export const DNS_ACTIONS: Record<string, KindAction> = { pause, resume, 'update-lists': updateLists };

export const PIHOLE_KIND: KindModule = {
  page: dnsPage,
  prefetch: (services, row, now) => dnsLatest(services, row, now),
  seen: dnsSeen,
  asksFirst: 'turning blocking off asks first',
  actions: DNS_ACTIONS,
  checks: PIHOLE_CHECKS,
};

export const ADGUARD_KIND: KindModule = {
  ...PIHOLE_KIND,
  asksFirst: 'turning protection off asks first',
  checks: ADGUARD_CHECKS,
};
