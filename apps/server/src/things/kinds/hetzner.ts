/**
 * Hetzner Cloud's page (connection-pages.md CP-02; connection-pages-server.md CP-S15): what runs, where and at what
 * cost. Its Summary is in slots (docs/decisions/service-slots.md): the servers now (type, place, CPU and traffic from
 * Hetzner's metrics API, up to six servers, running ones first, kept 60 seconds per server and range), what the project
 * holds (servers, volumes, snapshots, traffic this month against what is included, the servers' monthly price at their
 * location), and the traffic out per day from the same API's hourly readings over two weeks (kept an hour). CPU and
 * Network over the range follow below. A server that is also a Whombat server (the same public address) opens its
 * page; one that isn't gets a note, as Hetzner can't see memory or disk space. Worth a look: a server not running, no
 * Hetzner backups, delete protection off, traffic past 80 % of what's included.
 */
import { isIP } from 'node:net';
import {
  type ThingGalleryItem,
  type ThingLine,
  type ThingPageItem,
  type ThingPagePanel,
  type ThingPageRow,
  type ThingSeriesColor,
  thingHref,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../connections/types';
import type { ConnectionGlance } from '../../home/types';
import type { Services } from '../../services';
import { within } from '../part-of';
import { shortHash, someNames } from '../quiet/items';
import type { KindCheck, KindNotice } from '../quiet/types';
import { addressIndex, hostsServing } from '../runs-on';
import {
  avgPeakLines,
  drawable,
  lastValue,
  onRange,
  type PageRange,
  pctStat,
  RANGE_MS,
  type RawPoint,
  SERVICE_STEP_MS,
  seriesStats,
  statFigure,
  statsOf,
} from '../series';
import { bytes, clip, figure, figure1, line, list, num, pct, plural, rec, str, thousands } from '../words';
import { itemLines, lineId, statusOf, subjectName } from './home/lines';
import { cachedRead, getJson, KIND_DEADLINE_MS, latestRead, problemOf, withDeadline } from './read';
import type { KindSeen } from './registry';
import {
  countLine,
  dayKey,
  daysWith,
  type InventoryPanel,
  inventory,
  type LivePanel,
  lastDays,
  liveRows,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from './slots';
import type { ChartPanel, KindCtx, KindView } from './types';

const NAME = 'Hetzner';
const SERVERS_MAX = 50;

export interface HetznerServer {
  id: string;
  name: string;
  status: string;
  type: string;
  cores: number | null;
  memoryGb: number | null;
  diskGb: number | null;
  location: string | null;
  city: string | null;
  ipv4: string | null;
  /** The server's IPv6 network (`2001:db8:c0c:1234::/64`). */
  ipv6: string | null;
  /** “Debian 13”. */
  os: string | null;
  monthlyEur: number | null;
  backups: boolean;
  deleteProtection: boolean;
  /** This billing period's traffic out and what is included, in bytes. */
  outgoingBytes: number | null;
  includedBytes: number | null;
  /** When it was made (`created`), for what came in this week. */
  createdAt: Date | null;
}

export interface HetznerVolume {
  id: string;
  name: string;
  sizeGb: number | null;
  server: string | null;
  location: string | null;
  createdAt: Date | null;
}

export interface HetznerSnapshot {
  readAt: Date;
  servers: HetznerServer[];
  volumes: HetznerVolume[] | null;
  /** The list held as many servers as asked for: there may be more (an unread part never lifts an Ignore). */
  serversCapped?: boolean;
}

/** An RFC 3339 time of Hetzner's, or null. */
function dateOf(v: unknown): Date | null {
  const t = Date.parse(str(v) ?? '');
  return Number.isFinite(t) ? new Date(t) : null;
}

export function hetznerServer(raw: unknown): HetznerServer {
  const s = rec(raw);
  const type = rec(s.server_type);
  const location = rec(rec(s.datacenter).location);
  const where = str(location.name);
  const price = list(type.prices)
    .map(rec)
    .find((p) => p.location === where);
  return {
    id: String(s.id ?? ''),
    name: str(s.name) ?? 'server',
    status: str(s.status) ?? 'unknown',
    type: str(type.name) ?? '',
    cores: num(type.cores),
    memoryGb: num(type.memory),
    diskGb: num(type.disk),
    location: where,
    city: str(location.city),
    ipv4: str(rec(rec(s.public_net).ipv4).ip),
    ipv6: str(rec(rec(s.public_net).ipv6).ip),
    os: str(rec(s.image).description),
    monthlyEur: num(rec(price?.price_monthly).gross),
    backups: s.backup_window !== null && s.backup_window !== undefined,
    deleteProtection: rec(s.protection).delete === true,
    outgoingBytes: num(s.outgoing_traffic),
    includedBytes: num(s.included_traffic),
    createdAt: dateOf(s.created),
  };
}

export async function readHetzner(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<HetznerSnapshot> {
  const [servers, volumes] = await Promise.all([
    getJson(services, row, NAME, '/v1/servers', { per_page: String(SERVERS_MAX) }),
    getJson(services, row, NAME, '/v1/volumes', { per_page: '50' }).catch(() => null),
  ]);
  const byId = new Map(list(rec(servers).servers).map((s) => [String(rec(s).id), str(rec(s).name)]));
  const all = list(rec(servers).servers);
  return {
    readAt: now,
    ...(all.length >= SERVERS_MAX ? { serversCapped: true } : {}),
    servers: all.map(hetznerServer),
    volumes: volumes
      ? list(rec(volumes).volumes)
          .map(rec)
          .map((v) => ({
            id: String(v.id ?? ''),
            name: str(v.name) ?? 'volume',
            sizeGb: num(v.size),
            server: v.server !== null && v.server !== undefined ? (byId.get(String(v.server)) ?? null) : null,
            location: str(rec(v.location).name),
            createdAt: dateOf(v.created),
          }))
      : null,
  };
}

/** One read of the project within its deadline. */
function loadHetzner(services: Services, row: CatalogConnectionRow, now: Date) {
  return async (): Promise<HetznerSnapshot> => {
    try {
      return await withDeadline(
        readHetzner(services, row, now),
        KIND_DEADLINE_MS,
        'Hetzner didn’t answer in time.',
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

export function hetznerSnapshot(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return cachedRead(services, `hetzner:${row.id}`, row, loadHetzner(services, row, now));
}

/** The project's read for its page: the last one when a new one is slow (page-speed.md PS-01). */
export function hetznerLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, `hetzner:${row.id}`, row, loadHetzner(services, row, now));
}

/** “€ 13.60” (Hetzner prices in euros, gross). */
export function euros(n: number): string {
  return `€ ${n.toFixed(2)}`;
}

/* Metrics (DS-12) ---------------------------------------------------------------------------------------------------- */

/** Servers whose metrics a page reads: running ones first, at most six. */
export const METRICS_SERVERS = 6;
/** How long one server's metrics are kept per range. */
export const METRICS_CACHE_MS = 60_000;

/** One server's lines over the range, on the range's grid. */
export interface HetznerMetrics {
  serverId: string;
  timestamps: string[];
  /** A share of all its vCPUs, in % (Hetzner counts 100 % per vCPU). */
  cpu: (number | null)[];
  /** The public interface, in Mb/s. */
  netIn: (number | null)[];
  netOut: (number | null)[];
  /** The disk, in MB/s. */
  diskRead: (number | null)[];
  diskWrite: (number | null)[];
}

/** A time series of Hetzner's answer as points (`[[1735689600, "4.2"], …]`). */
function seriesPoints(
  timeSeries: Record<string, unknown>,
  name: string,
  scale: (v: number) => number,
): RawPoint[] {
  return list(rec(timeSeries[name]).values)
    .map((pair) => {
      const [t, v] = list(pair);
      const at = num(t);
      const value = num(v);
      return at === null ? null : { at: new Date(at * 1000), value: value === null ? null : scale(value) };
    })
    .filter((p): p is RawPoint => p !== null);
}

/**
 * Hetzner's `GET /v1/servers/{id}/metrics` answer on the range's grid: CPU divided by the server's vCPUs, network bytes/s
 * as Mb/s, disk bytes/s as MB/s.
 */
export function hetznerMetrics(
  raw: unknown,
  server: Pick<HetznerServer, 'id' | 'cores'>,
  range: PageRange,
  now: Date,
): HetznerMetrics {
  const ts = rec(rec(rec(raw).metrics).time_series);
  const cores = server.cores && server.cores > 0 ? server.cores : 1;
  const mbits = (v: number) => (v * 8) / 1e6;
  const mbytes = (v: number) => v / 1e6;
  const grid = onRange(
    [
      seriesPoints(ts, 'cpu', (v) => v / cores),
      seriesPoints(ts, 'network.0.bandwidth.in', mbits),
      seriesPoints(ts, 'network.0.bandwidth.out', mbits),
      seriesPoints(ts, 'disk.0.bandwidth.read', mbytes),
      seriesPoints(ts, 'disk.0.bandwidth.write', mbytes),
    ],
    range,
    now,
    SERVICE_STEP_MS[range],
  );
  const [cpu, netIn, netOut, diskRead, diskWrite] = grid.values as (number | null)[][];
  return {
    serverId: server.id,
    timestamps: grid.timestamps,
    cpu: cpu ?? [],
    netIn: netIn ?? [],
    netOut: netOut ?? [],
    diskRead: diskRead ?? [],
    diskWrite: diskWrite ?? [],
  };
}

/** The servers whose metrics are read: running first, at most six. */
export function metricsServers(s: HetznerSnapshot): HetznerServer[] {
  return [
    ...s.servers.filter((x) => x.status === 'running'),
    ...s.servers.filter((x) => x.status !== 'running'),
  ].slice(0, METRICS_SERVERS);
}

/**
 * One server's metrics over the range as the connection (kept 60 s per server and range; the last ones while new ones
 * are slow, PS-01); null when they fail.
 */
export async function readHetznerMetrics(
  services: Services,
  row: CatalogConnectionRow,
  server: HetznerServer,
  range: PageRange,
  now: Date,
): Promise<{ metrics: HetznerMetrics | null; refreshing: boolean }> {
  const read = await latestRead<unknown>(
    services,
    `hetzner-metrics:${row.id}:${server.id}:${range}`,
    row,
    () =>
      getJson(services, row, NAME, `/v1/servers/${encodeURIComponent(server.id)}/metrics`, {
        type: 'cpu,disk,network',
        start: new Date(now.getTime() - RANGE_MS[range]).toISOString(),
        end: now.toISOString(),
        step: String(SERVICE_STEP_MS[range] / 1000),
      }),
    { ttlMs: METRICS_CACHE_MS },
  );
  return {
    metrics: read.ok && read.value ? hetznerMetrics(read.value, server, range, now) : null,
    refreshing: read.refreshing,
  };
}

/** The mean of several lines per step (null where none of them has a value). */
export function meanLine(lines: readonly (readonly (number | null)[])[]): (number | null)[] {
  const n = Math.max(0, ...lines.map((l) => l.length));
  return Array.from({ length: n }, (_, i) => {
    const xs = lines.map((l) => l[i]).filter((v): v is number => v !== null && v !== undefined);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  });
}

/** Two lines added per step (null where both are). */
function sumLine(a: readonly (number | null)[], b: readonly (number | null)[]): (number | null)[] {
  return a.map((v, i) => (v === null && (b[i] ?? null) === null ? null : (v ?? 0) + (b[i] ?? 0)));
}

/* Which Hetzner server is a Whombat server --------------------------------------------------------------------------- */

/** An IPv6 address as eight numbers (null when it isn't one). */
function v6Words(address: string): number[] | null {
  const a =
    address
      .split('/')[0]
      ?.replace(/^\[|\]$/g, '')
      .replace(/%.*$/, '') ?? '';
  if (isIP(a) !== 6 || a.includes('.')) return null;
  const [head, tail] = a.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const words = [...left, ...new Array(8 - left.length - right.length).fill('0'), ...right];
  return words.length === 8 ? words.map((w) => Number.parseInt(w, 16)) : null;
}

/** Whether `address` is the Hetzner server's IPv4 address or inside its IPv6 network (a /64). */
export function sameServer(x: Pick<HetznerServer, 'ipv4' | 'ipv6'>, address: string): boolean {
  const bare = address.trim().toLowerCase();
  if (x.ipv4 && bare === x.ipv4) return true;
  const net = x.ipv6 ? v6Words(x.ipv6) : null;
  const ip = v6Words(bare);
  return !!net && !!ip && net.slice(0, 4).every((w, i) => w === ip[i]);
}

/** The Whombat servers (`serverId`) behind the Hetzner servers, by their public addresses. */
export function whombatServers(
  s: HetznerSnapshot,
  machines: readonly { serverId: string; guestId: string | null; addresses: string[] }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const x of s.servers) {
    const hit = machines.find((m) => m.guestId === null && m.addresses.some((a) => sameServer(x, a)));
    if (hit) out.set(x.id, hit.serverId);
  }
  return out;
}

/* The Summary -------------------------------------------------------------------------------------------------------- */

/** Bytes as Hetzner counts them (TB of 1024⁴, GB of 1024³: “20 TB” included). */
const TIB = 1024 ** 4;
const GIB = 1024 ** 3;

/** This month's traffic out and what is included, over all servers (null when Hetzner doesn't say). */
export function traffic(s: HetznerSnapshot): { out: number; included: number } | null {
  const known = s.servers.filter((x) => x.includedBytes !== null && x.includedBytes > 0);
  if (!known.length) return null;
  return {
    out: known.reduce((n, x) => n + (x.outgoingBytes ?? 0), 0),
    included: known.reduce((n, x) => n + (x.includedBytes ?? 0), 0),
  };
}

/** The tile: servers running; the dot and the reason from Worth a look's lines that aren't heads-ups (QN-02). */
export function hetznerGlanceOf(
  s: HetznerSnapshot,
  notices: readonly KindNotice[] = hetznerNotices(s),
): Omit<ConnectionGlance, 'status'> & { status: 'ok' | 'warn' | 'bad' } {
  const running = s.servers.filter((x) => x.status === 'running').length;
  return {
    ...statusOf(notices),
    line: plural(s.servers.length, 'server'),
    facts: [{ label: 'Servers', value: `${running} of ${s.servers.length}`, note: 'running' }],
  };
}

/** The CPU of the running servers read, averaged per step. */
function runningCpu(s: HetznerSnapshot, metrics: readonly HetznerMetrics[]): (number | null)[] {
  const running = new Set(s.servers.filter((x) => x.status === 'running').map((x) => x.id));
  return meanLine(metrics.filter((m) => running.has(m.serverId)).map((m) => m.cpu));
}

const SERVER_COLORS: ThingSeriesColor[] = ['blue', 'orange', 'green', 'violet', 'amber', 'grey'];
const mbps = (n: number) => `${statFigure(n)} Mb/s`;

/**
 * CPU and Network over the page's range, below the slots (they follow the range). One server: its own lines (network
 * in green and out orange); several: one line per server (network in and out together).
 */
export function hetznerCharts(
  s: HetznerSnapshot,
  metrics: readonly HetznerMetrics[],
  now: Date,
  timeZone: string,
): ChartPanel[] {
  const drawn = metrics.filter((m) => drawable(m.cpu) || drawable(m.netIn));
  if (!drawn.length) return [];
  const timestamps = (drawn[0] as HetznerMetrics).timestamps;
  const nameOf = (m: HetznerMetrics) =>
    clip(s.servers.find((x) => x.id === m.serverId)?.name ?? m.serverId, 40);
  const one = drawn.length === 1 ? (drawn[0] as HetznerMetrics) : null;
  const out: ChartPanel[] = [];
  const cpu = one ? one.cpu : runningCpu(s, drawn);
  const running = drawn.filter((m) => s.servers.some((x) => x.id === m.serverId && x.status === 'running'));
  const whose = one ?? (running.length === 1 ? (running[0] as HetznerMetrics) : null);
  if (drawable(cpu)) {
    const nowCpu = lastValue(cpu);
    out.push({
      kind: 'chart',
      id: 'cpu',
      title: 'CPU',
      timestamps,
      series: one
        ? [
            {
              key: 'cpu',
              label: nameOf(one),
              unit: '%',
              values: one.cpu,
              color: 'blue',
              fill: true,
              ...latestOf(one.cpu, pct),
            },
          ]
        : drawn.map((m, i) => ({
            key: `s${i + 1}`,
            label: nameOf(m),
            unit: '%',
            values: m.cpu,
            color: SERVER_COLORS[i] ?? 'grey',
            ...latestOf(m.cpu, pct),
          })),
      ...(nowCpu !== null ? { figure: { value: pct(nowCpu), rest: whose ? nameOf(whose) : 'average' } } : {}),
      ...statsOf(avgPeakLines(seriesStats(cpu, timestamps), pctStat, now, timeZone)),
      axis: { min: 0, max: 100, unit: '%' },
    });
  }
  const network = one
    ? [
        {
          key: 'in',
          label: 'In',
          unit: 'Mb/s',
          values: one.netIn,
          color: 'green' as const,
          fill: true,
          ...latestOf(one.netIn, mbps),
        },
        {
          key: 'out',
          label: 'Out',
          unit: 'Mb/s',
          values: one.netOut,
          color: 'orange' as const,
          ...latestOf(one.netOut, mbps),
        },
      ]
    : drawn.map((m, i) => {
        const values = sumLine(m.netIn, m.netOut);
        return {
          key: `s${i + 1}`,
          label: nameOf(m),
          unit: 'Mb/s',
          values,
          color: SERVER_COLORS[i] ?? ('grey' as const),
          ...latestOf(values, mbps),
        };
      });
  if (network.some((x) => drawable(x.values)))
    out.push({
      kind: 'chart',
      id: 'network',
      title: 'Network',
      ...(one ? {} : { meta: 'in and out' }),
      timestamps,
      series: network,
      axis: { min: 0, unit: 'Mb/s' },
    });
  return out;
}

/** A series' legend figure, when it has one. */
function latestOf(values: readonly (number | null)[], fmt: (n: number) => string): { latest?: string } {
  const v = lastValue(values);
  return v === null ? {} : { latest: fmt(v) };
}

/** Every check Hetzner raises (What Whombat watches, QN-15). */
export const HETZNER_CHECKS: readonly KindCheck[] = [
  {
    check: 'hetzner.not_running',
    name: 'Servers not running',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'hetzner.traffic',
    name: 'Traffic past what’s included',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  {
    check: 'hetzner.no_backups',
    name: 'Servers without Hetzner backups',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'hetzner.delete_protection',
    name: 'Delete protection off',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];

/** On their way somewhere (QN-04): a server starting, stopping, rebuilt or moved isn't “not running”. */
const UNDER_WAY = new Set(['initializing', 'starting', 'stopping', 'migrating', 'rebuilding', 'deleting']);

/** The first moment of next month in UTC, when Hetzner's included traffic starts again. */
export function nextMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

const serverSubject = (x: HetznerServer) => ({
  id: `server:${x.id}`.slice(0, 160),
  name: subjectName(x.name),
});

/**
 * Worth a look (QN-01…QN-04): a server off, one line each, after two passes in a row and not while it starts, stops or
 * moves; traffic past what's included a problem, at 80 % a heads-up until next month; no Hetzner backups and delete
 * protection off heads-ups per server (standing choices: many back up another way).
 */
export function hetznerNotices(s: HetznerSnapshot, now = s.readAt): KindNotice[] {
  const out: KindNotice[] = [];
  const names = (xs: readonly HetznerServer[]) => clip(xs.map((x) => x.name).join(' · '), 200);
  const stopped = s.servers.filter((x) => x.status !== 'running' && !UNDER_WAY.has(x.status));
  out.push(
    ...itemLines(
      stopped,
      (x) => serverSubject(x).id,
      (x) => {
        const title = clip(`${x.name} isn’t running`, 120);
        return {
          id: lineId('not-running', x.id),
          tone: 'warn',
          icon: 'power',
          title,
          detail: clip(
            [STATUS_WORDS[x.status] ?? x.status, x.type.toUpperCase(), x.city].filter(Boolean).join(' · '),
            200,
          ),
          link: {
            kind: 'ask',
            label: 'Look into it',
            question: clip(`Why isn’t ${x.name} running on Hetzner?`, 300),
          },
          nature: 'problem',
          check: 'hetzner.not_running',
          subject: serverSubject(x),
          ignore: { lifts: 'fixed', words: 'Until it’s running.' },
          confirm: 2,
          ...(title.length > 40 ? { badge: 'A server isn’t running' } : {}),
        };
      },
      (more, subject, episode) => ({
        id: 'not-running-more',
        tone: 'warn',
        icon: 'power',
        title: `${plural(more.length, 'more server')} aren’t running`,
        detail: names(more),
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: 'Why aren’t some of my Hetzner servers running?',
        },
        nature: 'problem',
        check: 'hetzner.not_running',
        subject,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
        episode,
        confirm: 2,
        badge: 'Servers aren’t running',
      }),
    ),
  );
  const t = traffic(s);
  if (t && t.out / t.included >= 0.8) {
    const unit = t.included >= TIB ? TIB : GIB;
    const u = unit === TIB ? 'TB' : 'GB';
    const over = t.out >= t.included;
    out.push({
      id: 'traffic',
      // Past what's included it costs money; at 80 % it is a forecast (QN-04).
      tone: over ? 'warn' : 'info',
      icon: 'network',
      title: `Traffic is at ${pct((t.out / t.included) * 100)} of what’s included`,
      detail: `${figure1(t.out / unit)} of ${figure(Math.round(t.included / unit))} ${u} going out this month`,
      ...(over
        ? {
            link: {
              kind: 'ask' as const,
              label: 'Look into it',
              question: 'What uses so much traffic on my Hetzner servers, and what will it cost?',
            },
          }
        : {}),
      nature: over ? 'problem' : 'fyi',
      check: 'hetzner.traffic',
      ignore: { lifts: 'period', words: 'Until next month.', until: nextMonth(now).toISOString() },
      band: over ? 100 : 80,
      badge: over ? 'Traffic past what’s included' : 'Traffic at 80 %',
    });
  }
  // Backups and delete protection are settings people often choose on purpose: one heads-up each for all servers,
  // said once, whose Ignore lasts while the same servers are without (a line per server made the card a list).
  const noBackups = s.servers.filter((x) => !x.backups);
  const firstNoBackup = noBackups[0];
  if (firstNoBackup)
    out.push({
      id: 'no-backups',
      tone: 'info',
      icon: 'backup',
      title:
        noBackups.length === 1
          ? clip(`${firstNoBackup.name} has no backups`, 120)
          : `${plural(noBackups.length, 'server')} have no backups`,
      detail: clip(
        `${noBackups.length > 1 ? `${someNames(noBackups.map((x) => x.name))} · ` : ''}Hetzner’s backups are 20 % of the server price`,
        200,
      ),
      nature: 'fyi',
      check: 'hetzner.no_backups',
      ignore: { lifts: 'newer', words: 'Until another server has none.' },
      episode: shortHash(noBackups.map((x) => serverSubject(x).id)),
    });
  const unprotected = s.servers.filter((x) => !x.deleteProtection);
  const firstOpen = unprotected[0];
  if (firstOpen)
    out.push({
      id: 'delete-protection',
      tone: 'info',
      icon: 'key',
      title:
        s.servers.length === 1
          ? 'Delete protection is off'
          : unprotected.length === 1
            ? clip(`Delete protection is off for ${firstOpen.name}`, 120)
            : `Delete protection is off for ${plural(unprotected.length, 'server')}`,
      detail: 'Turn it on in Hetzner so nothing is deleted by mistake.',
      nature: 'fyi',
      check: 'hetzner.delete_protection',
      ignore: { lifts: 'newer', words: 'Until another server has it off.' },
      episode: shortHash(unprotected.map((x) => serverSubject(x).id)),
    });
  return out;
}

/** The checks this read couldn't fully see: every one when the list of servers was capped. */
export function hetznerSkipped(s: HetznerSnapshot): string[] {
  return s.serversCapped ? HETZNER_CHECKS.map((c) => c.check) : [];
}

/** The health pass's look (SD-05, QN-S24): the card and Worth a look's lines as the page shows them. */
export async function hetznerSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<KindSeen> {
  const s = await hetznerSnapshot(services, row, now);
  const notices = hetznerNotices(s, now);
  return { glance: hetznerGlanceOf(s, notices), points: {}, notices, skipped: hetznerSkipped(s) };
}

const STATUS_WORDS: Record<string, string> = {
  running: 'Running',
  off: 'Off',
  initializing: 'Starting',
  starting: 'Starting',
  stopping: 'Stopping',
  migrating: 'Moving',
  rebuilding: 'Rebuilding',
  deleting: 'Being deleted',
};

export function hetznerRows(s: HetznerSnapshot): ThingPageRow[] {
  return s.servers.slice(0, 300).map((x) => ({
    id: x.id || x.name,
    cells: {
      name: { text: clip(x.name, 200) },
      state: {
        text: STATUS_WORDS[x.status] ?? x.status,
        dot:
          x.status === 'running'
            ? ('ok' as const)
            : x.status === 'off'
              ? ('bad' as const)
              : ('warn' as const),
      },
      type: {
        text: x.type.toUpperCase(),
        mono: true,
        note: [
          x.cores !== null ? plural(x.cores, 'core') : null,
          x.memoryGb !== null ? `${x.memoryGb} GB` : null,
          x.diskGb !== null ? `${x.diskGb} GB disk` : null,
        ]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 80),
      },
      location: { text: [x.city, x.location].filter(Boolean).join(' · ') },
      address: { text: x.ipv4 ?? '', mono: true },
      cost: { text: x.monthlyEur !== null ? euros(x.monthlyEur) : '', mono: true },
    },
  }));
}

const SERVER_COLUMNS = [
  { key: 'name', label: 'Server' },
  { key: 'state', label: 'State' },
  { key: 'type', label: 'Type' },
  { key: 'location', label: 'Location' },
  { key: 'address', label: 'Address' },
  { key: 'cost', label: 'A month', numeric: true },
];

/** The note under the table: Hetzner can't see memory or disk space of a server Whombat doesn't watch (DS-12). */
export function agentNote(
  s: HetznerSnapshot,
  whombat: ReadonlyMap<string, string>,
): Extract<ThingPagePanel, { kind: 'text' }> | null {
  const missing = s.servers.filter((x) => x.status === 'running' && !whombat.has(x.id));
  if (!missing.length) return null;
  const names = missing.map((x) => x.name);
  const who =
    names.length === 1
      ? `${names[0]} as a server`
      : names.length === 2
        ? `${names[0]} and ${names[1]} as servers`
        : `${names[0]}, ${names[1]} and ${plural(names.length - 2, 'more', 'more')} as servers`;
  const one = missing.length === 1 ? (missing[0] as HetznerServer) : null;
  const address = one?.ipv4 ?? null;
  return {
    kind: 'text',
    id: 'agent-note',
    place: 'main',
    body: clip(`Hetzner can’t see memory or disk space. Add ${who} to see them here.`, 1000),
    link: {
      kind: 'href',
      label: names.length === 1 ? 'Add as a server' : 'Add a server',
      href: `/things/servers?add=1${address ? `&address=${encodeURIComponent(address)}` : ''}`,
    },
  };
}

function volumeItems(s: HetznerSnapshot): ThingPageItem[] {
  return (s.volumes ?? []).slice(0, 100).map((v) => ({
    id: v.id || v.name,
    title: clip(v.name, 160),
    detail: v.server ? `On ${v.server}` : 'Not attached',
    ...(v.sizeGb !== null ? { right: `${v.sizeGb} GB` } : {}),
    icon: 'disk' as const,
  }));
}

/** The head's facts: “**1** server”, “Falkenstein”. */
export function hetznerFacts(s: HetznerSnapshot): ThingLine[] {
  const facts: ThingLine[] = [
    line(`**${s.servers.length}** ${s.servers.length === 1 ? 'server' : 'servers'}`),
  ];
  const cities = [...new Set(s.servers.map((x) => x.city).filter((c): c is string => !!c))];
  if (cities.length) facts.push(line(clip(cities.slice(0, 3).join(' · '), 120)));
  return facts;
}

/** The Whombat servers by address, when this burrow sees servers (else none). */
async function watched(
  ctx: KindCtx,
): Promise<{ serverId: string; guestId: string | null; addresses: string[] }[]> {
  const hosts = await hostsServing(ctx.services, ctx.burrowId);
  if (!hosts) return [];
  return (await addressIndex(hosts)).machines;
}

/* Snapshots and traffic per day ------------------------------------------------------------------------------------ */

/** The project's snapshots (`GET /v1/images?type=snapshot`, newest first): how many, when the newest were made, their size. */
export interface HetznerImages {
  total: number;
  created: Date[];
  /** In GB as Hetzner bills them (`image_size`); null when not every snapshot was in the answer. */
  sizeGb: number | null;
}

export function parseSnapshots(raw: unknown): HetznerImages {
  const images = list(rec(raw).images).map(rec);
  const total = num(rec(rec(rec(raw).meta).pagination).total_entries) ?? images.length;
  return {
    total,
    created: images.map((i) => dateOf(i.created)).filter((d): d is Date => d !== null),
    sizeGb: total <= images.length ? images.reduce((n, i) => n + (num(i.image_size) ?? 0), 0) : null,
  };
}

/** How long the snapshots are kept: they change when someone makes one. */
export const SNAPSHOTS_CACHE_MS = 10 * 60_000;

/** The snapshots, kept 10 minutes; null when they can't be read. */
export function readHetznerSnapshots(
  services: Services,
  row: CatalogConnectionRow,
): Promise<HetznerImages | null> {
  return cachedRead(
    services,
    `hetzner-images:${row.id}`,
    row,
    async () =>
      parseSnapshots(
        await getJson(services, row, NAME, '/v1/images', {
          type: 'snapshot',
          sort: 'created:desc',
          per_page: '50',
        }),
      ),
    SNAPSHOTS_CACHE_MS,
  ).catch(() => null);
}

/** Two weeks of hourly traffic out per server: this week's days and the week before. */
export const TRAFFIC_DAYS = 14;
export const TRAFFIC_STEP_S = 3600;
/** Kept an hour per server: a day's bar changes slowly. */
export const TRAFFIC_CACHE_MS = 3600_000;

/** What a server sent (bytes/s) per hour from Hetzner's `network` metrics answer. */
export function sentPoints(raw: unknown): RawPoint[] {
  return seriesPoints(rec(rec(rec(raw).metrics).time_series), 'network.0.bandwidth.out', (v) => v);
}

/** One server's traffic out per hour over the last two weeks, kept an hour; null when it can't be read. */
export function readHetznerTraffic(
  services: Services,
  row: CatalogConnectionRow,
  server: HetznerServer,
  now: Date,
): Promise<RawPoint[] | null> {
  return cachedRead(
    services,
    `hetzner-traffic:${row.id}:${server.id}`,
    row,
    async () =>
      sentPoints(
        await getJson(services, row, NAME, `/v1/servers/${encodeURIComponent(server.id)}/metrics`, {
          type: 'network',
          start: new Date(now.getTime() - TRAFFIC_DAYS * 86_400_000).toISOString(),
          end: now.toISOString(),
          step: String(TRAFFIC_STEP_S),
        }),
      ),
    TRAFFIC_CACHE_MS,
  ).catch(() => null);
}

/**
 * About how many bytes the servers sent per day of `keys`: each hourly reading (bytes/s) for its hour, summed over
 * the servers; null for a day without a reading. Readings after `until` are left out (the week before stops at the
 * same moment as this one). Pure.
 */
export function sentByDay(
  servers: readonly (readonly RawPoint[])[],
  keys: readonly string[],
  timeZone: string,
  until: Date,
  stepS = TRAFFIC_STEP_S,
): (number | null)[] {
  const index = new Map(keys.map((k, i) => [k, i]));
  const out: (number | null)[] = keys.map(() => null);
  for (const points of servers)
    for (const p of points) {
      if (p.value === null || !Number.isFinite(p.value) || p.at > until) continue;
      const i = index.get(dayKey(p.at, timeZone));
      if (i !== undefined) out[i] = (out[i] ?? 0) + p.value * stepS;
    }
  return out;
}

/* The Summary in slots --------------------------------------------------------------------------------------------- */

export interface HetznerInput {
  snapshot: HetznerSnapshot;
  /** The servers' lines over the page's range (at most six, running first). */
  metrics: readonly HetznerMetrics[];
  /** Hetzner server id → the Whombat server it is. */
  whombat: ReadonlyMap<string, string>;
  snapshots: HetznerImages | null;
  /** Each read server's hourly traffic out over two weeks; null when none could be read. */
  sent: { points: RawPoint[][]; read: number } | null;
  now: Date;
  timeZone: string;
}

/** Servers in Live, running ones first. */
export const LIVE_SERVERS = 12;

/** A server that isn't running says so as its tag: off is amber, on its way somewhere (starting, moving) is normal. */
const BADGE: Record<string, { text: string; tone: 'warn' | 'ok' }> = {
  off: { text: 'Off', tone: 'warn' },
  initializing: { text: 'Starting', tone: 'ok' },
  starting: { text: 'Starting', tone: 'ok' },
  stopping: { text: 'Stopping', tone: 'ok' },
  migrating: { text: 'Moving', tone: 'ok' },
  rebuilding: { text: 'Rebuilding', tone: 'ok' },
  deleting: { text: 'Being deleted', tone: 'ok' },
};

/** “3 Mb/s” for a server's traffic now. */
const rate = (n: number) => `${statFigure(n)} Mb/s`;

/**
 * Servers now (Live): a row per server, running ones first, with its type and where it is, its CPU now as the bar and
 * its traffic in and out at the bar's end; one that isn't running says so as its tag. A Whombat server opens its page.
 */
export function hetznerLive(input: HetznerInput): LivePanel | null {
  const { snapshot: s, metrics, whombat } = input;
  if (!s.servers.length) return null;
  const running = s.servers.filter((x) => x.status === 'running');
  const servers = [...running, ...s.servers.filter((x) => x.status !== 'running')].slice(0, LIVE_SERVERS);
  const cost = s.servers.some((x) => x.monthlyEur !== null)
    ? euros(s.servers.reduce((n, x) => n + (x.monthlyEur ?? 0), 0))
    : null;
  return liveRows({
    id: 'servers',
    title: 'Servers now',
    // Servers have no pictures: the row's square says the name's first letter.
    shape: 'square',
    meta: [
      running.length === s.servers.length
        ? 'All running'
        : `${running.length} of ${s.servers.length} running`,
      cost ? `${cost} a month` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    items: servers.map((x): ThingGalleryItem => {
      const on = x.status === 'running';
      const m = metrics.find((y) => y.serverId === x.id);
      const cpu = on && m ? lastValue(m.cpu) : null;
      const netIn = on && m ? lastValue(m.netIn) : null;
      const netOut = on && m ? lastValue(m.netOut) : null;
      const server = whombat.get(x.id);
      const badge = on
        ? null
        : (BADGE[x.status] ?? { text: clip(STATUS_WORDS[x.status] ?? x.status, 30), tone: 'warn' as const });
      return {
        id: (x.id || x.name).slice(0, 200),
        title: clip(x.name, 120),
        sub: clip(
          [
            x.type.toUpperCase(),
            x.cores !== null ? `${x.cores} vCPU` : null,
            x.memoryGb !== null ? `${figure(x.memoryGb)} GB` : null,
            x.city,
          ]
            .filter(Boolean)
            .join(' · '),
          120,
        ),
        ...(badge ? { badge } : {}),
        ...(cpu !== null ? { progress: Math.min(1, Math.max(0, cpu / 100)), note: `CPU ${pct(cpu)}` } : {}),
        ...(on ? {} : { progress: 0, paused: true, note: STATUS_WORDS[x.status] ?? x.status }),
        ...(netIn !== null && netOut !== null ? { noteEnd: `${rate(netIn)} in · ${rate(netOut)} out` } : {}),
        ...(server ? { href: thingHref('server', server) } : {}),
      };
    }),
    empty: 'No servers in this project.',
  });
}

const DAY_MS = 86_400_000;
const thisWeek = (d: Date | null, now: Date) => !!d && now.getTime() - d.getTime() < 7 * DAY_MS && d <= now;

/**
 * In this project (Inventory): the servers (one off, or what came this week), the volumes, the snapshots, the traffic
 * out this month against what is included, and what the servers cost a month.
 */
export function hetznerInventory(input: HetznerInput): InventoryPanel | null {
  const { snapshot: s, snapshots, now } = input;
  const items: ThingPageItem[] = [];
  const stopped = s.servers.filter((x) => x.status !== 'running').length;
  const added = s.servers.filter((x) => thisWeek(x.createdAt, now)).length;
  const cores = s.servers.reduce((n, x) => n + (x.cores ?? 0), 0);
  const memory = s.servers.reduce((n, x) => n + (x.memoryGb ?? 0), 0);
  items.push(
    countLine({
      id: 'servers',
      title: 'Servers',
      icon: 'device',
      value: thousands(s.servers.length),
      ...(cores ? { detail: `${cores} vCPU · ${figure(memory)} GB in all` } : {}),
      ...(stopped
        ? { note: `${stopped} not running`, noteTone: 'warn' as const }
        : added
          ? { note: `+${added} this week`, noteTone: 'ok' as const }
          : { note: s.servers.length ? 'All running' : 'None yet' }),
    }),
  );
  if (s.volumes) {
    const size = s.volumes.reduce((n, v) => n + (v.sizeGb ?? 0), 0);
    const loose = s.volumes.filter((v) => !v.server).length;
    const new_ = s.volumes.filter((v) => thisWeek(v.createdAt, now)).length;
    items.push(
      countLine({
        id: 'volumes',
        title: 'Volumes',
        icon: 'disk',
        value: thousands(s.volumes.length),
        ...(size ? { detail: `${figure(size)} GB in all${loose ? ` · ${loose} not attached` : ''}` } : {}),
        ...(new_ ? { note: `+${new_} this week`, noteTone: 'ok' as const } : { note: 'Nothing new' }),
      }),
    );
  }
  if (snapshots) {
    const new_ = snapshots.created.filter((d) => thisWeek(d, now)).length;
    items.push(
      countLine({
        id: 'snapshots',
        title: 'Snapshots',
        icon: 'backup',
        value: thousands(snapshots.total),
        ...(snapshots.sizeGb ? { detail: `${figure(snapshots.sizeGb)} GB in all` } : {}),
        ...(new_ ? { note: `+${new_} this week`, noteTone: 'ok' as const } : { note: 'Nothing new' }),
      }),
    );
  }
  const t = traffic(s);
  if (t) {
    const unit = t.included >= TIB ? TIB : GIB;
    const u = unit === TIB ? 'TB' : 'GB';
    const share = t.out / t.included;
    items.push(
      countLine({
        id: 'traffic',
        title: 'Traffic this month',
        icon: 'network',
        value: `${figure1(t.out / unit)} ${u}`,
        detail: 'Going out, all servers',
        note: `${pct(share * 100)} of ${figure(Math.round(t.included / unit))} ${u}`,
        ...(share >= 1 ? { noteTone: 'bad' as const } : share >= 0.8 ? { noteTone: 'warn' as const } : {}),
      }),
    );
  }
  if (s.servers.some((x) => x.monthlyEur !== null))
    items.push(
      countLine({
        id: 'cost',
        title: 'Cost a month',
        icon: 'money',
        value: euros(s.servers.reduce((sum, x) => sum + (x.monthlyEur ?? 0), 0)),
        note: 'servers, before traffic',
      }),
    );
  return inventory({
    id: 'project',
    title: 'In this project',
    link: { kind: 'tab', label: 'All servers', tab: 'servers' },
    items,
  });
}

/**
 * Traffic out this week (Trend): about how much the servers sent per day, from Hetzner's hourly readings of the servers
 * whose metrics are read, with the change on the week before once both weeks have every day. Left out under two days.
 */
export function hetznerWeek(
  input: Pick<HetznerInput, 'sent' | 'snapshot' | 'now' | 'timeZone'>,
): TrendPanel | null {
  const { sent, snapshot: s, now, timeZone } = input;
  if (!sent?.points.length) return null;
  const days = lastDays(now, timeZone);
  const values = sentByDay(sent.points, days.keys, timeZone, now);
  if (daysWith(values) < 2) return null;
  const then = new Date(now.getTime() - 7 * DAY_MS);
  const before = sentByDay(sent.points, lastDays(then, timeZone).keys, timeZone, then);
  const total = values.reduce<number>((a, v) => a + (v ?? 0), 0);
  const prior = before.reduce<number>((a, v) => a + (v ?? 0), 0);
  return trend({
    id: 'week',
    title: 'Traffic out this week',
    meta:
      sent.read < s.servers.length
        ? `Sent per day · ${sent.read} of ${s.servers.length} servers`
        : 'Sent per day, all servers',
    days,
    values: values.map((v) => (v === null ? null : Math.round(v / 1e8) / 10)),
    label: 'Sent',
    unit: 'GB',
    figure: { value: `about ${bytes(total)}`, rest: 'out this week' },
    change: daysWith(before) === 7 ? weekChange(total, prior) : null,
    color: 'orange',
  });
}

/**
 * The Summary in slots (docs/decisions/service-slots.md): the servers now beside what the project holds, the traffic
 * out this week. No shelf, no people (Hetzner doesn't say who) and no machine card: the servers are the machines.
 * CPU and Network over the range and the note about servers Whombat doesn't watch below them.
 */
export function hetznerSlots(input: HetznerInput): Pick<KindView, 'panels' | 'slots'> {
  const { snapshot: s, metrics, whombat, now, timeZone } = input;
  const note = agentNote(s, whombat);
  return slotPanels({
    live: hetznerLive(input),
    inventory: hetznerInventory(input),
    trend: hetznerWeek(input),
    more: [...hetznerCharts(s, metrics, now, timeZone), ...(note ? [note] : [])],
  });
}

/** The page's Hetzner part from what was read; pure. */
export function hetznerView(input: HetznerInput): Omit<KindView, 'open' | 'suggestions'> {
  const s = input.snapshot;
  const stopped = s.servers.filter((x) => x.status !== 'running').length;
  return {
    // In slots its figures are in Servers now and In this project; the card keeps its own (`hetznerGlanceOf`).
    kpis: [],
    charts: [],
    notices: hetznerNotices(s, input.now),
    ...hetznerSlots(input),
    tabs: [
      {
        key: 'servers',
        label: 'Servers',
        count: s.servers.length,
        panels: [
          {
            kind: 'table',
            id: 'servers',
            title: 'Servers',
            columns: SERVER_COLUMNS,
            rows: hetznerRows(s),
            empty: 'No servers in this project.',
          },
        ],
      },
      ...(s.volumes
        ? [
            {
              key: 'volumes',
              label: 'Volumes',
              count: s.volumes.length,
              panels: [
                {
                  kind: 'list' as const,
                  id: 'volumes',
                  title: 'Volumes',
                  items: volumeItems(s),
                  empty: 'No volumes in this project.',
                },
              ],
            },
          ]
        : []),
    ],
    facts: hetznerFacts(s),
    // Fine words only (QN-S24): a server not running is a line, and the head follows the lines that aren't ignored.
    ...(s.servers.length
      ? {
          status: {
            status: 'ok' as const,
            badge: stopped ? `${s.servers.length - stopped} of ${s.servers.length} running` : 'All running',
          },
        }
      : {}),
    actions: [],
    readAt: s.readAt,
  };
}

export async function hetznerPage(ctx: KindCtx): Promise<KindView> {
  const base = {
    open: { label: 'Open in Hetzner', url: 'https://console.hetzner.cloud/' },
    suggestions: ['Cost this month', 'Traffic used', 'Snapshots'],
  };
  const latest = await hetznerLatest(ctx.services, ctx.row, ctx.now);
  if (!latest.ok)
    // Nothing read: the page of a connection without a kind (how it answers) says the rest.
    return {
      ...base,
      notices: [],
      panels: [],
      tabs: [],
      facts: [],
      actions: [],
      readAt: null,
      problem: problemOf(latest.error, NAME).message,
      refreshing: latest.refreshing,
    };
  const s = latest.value;
  const servers = metricsServers(s);
  const [metrics, machines, snapshots, sent] = await Promise.all([
    Promise.all(servers.map((x) => readHetznerMetrics(ctx.services, ctx.row, x, ctx.range, ctx.now))),
    within(watched(ctx), 5_000, []),
    readHetznerSnapshots(ctx.services, ctx.row),
    Promise.all(servers.map((x) => readHetznerTraffic(ctx.services, ctx.row, x, ctx.now))),
  ]);
  const read = metrics.map((m) => m.metrics).filter((m): m is HetznerMetrics => m !== null);
  const points = sent.filter((p): p is RawPoint[] => p !== null);
  return {
    ...base,
    ...hetznerView({
      snapshot: s,
      metrics: read,
      whombat: whombatServers(s, machines),
      snapshots,
      sent: points.length ? { points, read: points.length } : null,
      now: ctx.now,
      timeZone: ctx.timeZone,
    }),
    refreshing: latest.refreshing || metrics.some((m) => m.refreshing),
  };
}
