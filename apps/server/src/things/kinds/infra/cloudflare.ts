/**
 * Cloudflare's page (service-dashboards.md SD-43, SD-S16): the last 24 hours' requests, how many came from the cache and
 * how many were threats, per site with a small line; its tunnels healthy, degraded or down; certificates ending and
 * sites that aren't active; one button per site, **Clear cache**✱ (everything; an agent can clear single addresses).
 * Read with an API token only, through API v4: `/zones`, `/accounts`, each account's tunnels and a healthy tunnel's
 * connections, each site's certificate packs (kept an hour) and one GraphQL query for the traffic (kept 5 minutes,
 * `httpRequests1hGroups`, else `httpRequestsAdaptiveGroups` without threats). What the token may not read is left out.
 * A “Sign in with Cloudflare” (MCP) connection reads nothing here: its server's only tool that reads is `whoami` (who
 * signed in); `search`, `execute` and `docs` aren't marked read-only (cloudflare/mcp). A line under the name says an
 * API token shows it, and a hint in Worth a look links Settings once someone turns it on.
 */
import type {
  ThingLine,
  ThingPageCell,
  ThingPageItem,
  ThingPageKpi,
  ThingPagePanel,
  ThingPageRow,
  ThingPageTab,
  ThingTone,
} from '@whombat/core';
import type { TrackedRoutes } from '../../../changes/diff';
import type { CatalogConnectionRow } from '../../../connections/types';
import { ApiError } from '../../../lib/errors';
import type { Services } from '../../../services';
import { checkWatched } from '../../quiet/defaults';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { clip, line, list, num, pct, plural, rec, span, str, thousands } from '../../words';
import { actAs } from '../act';
import { type PageButton, pageButton } from '../buttons';
import { hourWords, twoHours } from '../home/dns';
import { cachedRead, getJson } from '../read';
import type { KindAction, KindModule } from '../registry';
import {
  countLine,
  type InventoryPanel,
  inventory,
  type LivePanel,
  liveList,
  slotPanels,
  type TrendPanel,
  trend,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import { cachedDomainExpirations, readDomainExpirations, warmDomainExpirations } from './rdap';
import {
  type ButtonCtx,
  badgeOf,
  cardOf,
  daysUntil,
  inTime,
  itemLines,
  linesSeen,
  notOffered,
  okJson,
  okStatus,
  optional,
  readAnswer,
  snapshotReader,
  uniqueById,
  unreadView,
} from './shared';

const NAME = 'Cloudflare';
const API = '/client/v4';
export const CLOUDFLARE_DASH = 'https://dash.cloudflare.com/';
/** Sites one read looks at (GraphQL takes 10 zones a query). */
export const ZONES_MAX = 10;
const DOMAIN_WARN_DAYS = 30;
const DOMAIN_URGENT_DAYS = 7;
const ACCOUNTS_MAX = 3;
/** Tunnels whose connections one read asks for (SD-S05). */
const CONNECTIONS_MAX = 12;
const TRAFFIC_CACHE_MS = 5 * 60_000;
const CERTS_CACHE_MS = 60 * 60_000;
/** The tunnels' routes are read again this often for what changed there (docs/decisions/outside-changes.md). */
const ROUTES_CACHE_MS = 15 * 60_000;
/** Tunnels whose routes one read asks for. */
const ROUTES_TUNNELS_MAX = 10;
const H = 3_600_000;
const DAY = 24 * H;
const CERT_WARN_DAYS = 14;
/** A tunnel degraded this long is a problem; before, a heads-up (QN-04: colo maintenance, reconnects). */
const DEGRADED_LONG_MS = 30 * 60_000;
/** A tunnel down this long was most likely retired without being deleted: a heads-up. */
const DOWN_RETIRED_MS = 30 * DAY;

export interface CfZone {
  id: string;
  name: string;
  /** active, pending, initializing, moved. */
  status: string;
  paused: boolean;
  plan: string | null;
  account: string | null;
}

export interface CfTraffic {
  requests: number;
  cached: number;
  /** Null when the dataset has no threats (the adaptive one). */
  threats: number | null;
  /** The last 24 hours, oldest first, one figure an hour. */
  hourly: (number | null)[];
}

export type TunnelState = 'healthy' | 'degraded' | 'down' | 'inactive';

export interface CfTunnel {
  id: string;
  name: string;
  status: TunnelState;
  account: string;
  connections: number | null;
  colos: string[];
  /** When it lost its last connection (`conns_inactive_at`); null when it has connections or never had any. */
  inactiveAt?: Date | null;
  /** When this Whombat first saw it degraded, in memory (a restart starts over); null when it isn't. */
  degradedSince?: Date | null;
  /** Its routes are set in Cloudflare's dashboard (`remote_config`), so Cloudflare can say them. */
  remote?: boolean;
}

export interface CfCertificate {
  zoneId: string;
  expires: Date | null;
  status: string;
}

export interface CfSnapshot {
  readAt: Date;
  zones: CfZone[];
  /** How many sites the token sees (the page shows the first 10). */
  zonesTotal: number;
  /** By zone id; null when the token may not read analytics. */
  traffic: Map<string, CfTraffic> | null;
  /** Null when the token may not read tunnels. */
  tunnels: CfTunnel[] | null;
  /** Null when the token may not read certificates. */
  certificates: CfCertificate[] | null;
  /** Not every account's tunnels were read (one refused, or more than three accounts). */
  tunnelsPartial?: boolean;
  /** Not every shown site's certificates were read. */
  certificatesPartial?: boolean;
  /** Domain registration expiry per lowercase zone name from public RDAP; null when RDAP couldn't be read. */
  domainExpirations?: Map<string, Date | null> | null;
  /** Not every shown site's domain registration could be looked up via RDAP. */
  domainExpirationsPartial?: boolean;
}

/* Reading -------------------------------------------------------------------------------------------------------------- */

const resultOf = (body: unknown) => rec(body).result;

const dateOf = (v: unknown): Date | null => {
  const t = Date.parse(str(v) ?? '');
  return Number.isFinite(t) && t > 0 ? new Date(t) : null;
};

/** `GET /zones`. */
export function parseZones(body: unknown): { zones: CfZone[]; total: number } {
  const zones = list(resultOf(body))
    .slice(0, 50)
    .map((raw): CfZone | null => {
      const z = rec(raw);
      const id = str(z.id);
      const name = str(z.name);
      if (!id || !name) return null;
      return {
        id: id.slice(0, 64),
        name: clip(name, 120),
        status: (str(z.status) ?? 'active').toLowerCase(),
        paused: z.paused === true,
        plan: str(rec(z.plan).name),
        account: str(rec(z.account).id),
      };
    })
    .filter((z): z is CfZone => z !== null);
  return { zones, total: num(rec(rec(body).result_info).total_count) ?? zones.length };
}

const TUNNEL_STATES = new Set<TunnelState>(['healthy', 'degraded', 'down', 'inactive']);

/** `GET /accounts/{id}/cfd_tunnel?is_deleted=false`. */
export function parseTunnels(body: unknown, account: string): CfTunnel[] {
  return list(resultOf(body))
    .slice(0, 100)
    .map((raw): CfTunnel | null => {
      const t = rec(raw);
      const id = str(t.id);
      if (!id || t.deleted_at) return null;
      const status = (str(t.status) ?? 'inactive').toLowerCase() as TunnelState;
      return {
        id: id.slice(0, 64),
        name: clip(str(t.name) ?? id, 80),
        status: TUNNEL_STATES.has(status) ? status : 'inactive',
        account,
        connections: null,
        colos: [],
        inactiveAt: dateOf(t.conns_inactive_at),
        ...(t.remote_config === true || str(t.config_src) === 'cloudflare' ? { remote: true } : {}),
      };
    })
    .filter((t): t is CfTunnel => t !== null);
}

/** `GET /accounts/{id}/cfd_tunnel/{tid}/connections`: every client's connections, and where they land. */
export function parseConnections(body: unknown): { connections: number; colos: string[] } {
  let connections = 0;
  const colos = new Set<string>();
  for (const client of list(resultOf(body)).slice(0, 50))
    for (const c of list(rec(client).conns).slice(0, 50)) {
      if (rec(c).is_pending_reconnect === true) continue;
      connections++;
      const colo = str(rec(c).colo_name);
      if (colo) colos.add(colo.toUpperCase().slice(0, 8));
    }
  return { connections, colos: [...colos].sort() };
}

/** `GET /zones/{id}/ssl/certificate_packs?status=all`: the active pack's primary certificate's end. */
export function parseCertificatePacks(body: unknown, zoneId: string): CfCertificate | null {
  const packs = list(resultOf(body)).map(rec);
  const pack = packs.find((p) => str(p.status) === 'active') ?? packs[0];
  if (!pack) return null;
  const certs = list(pack.certificates).map(rec);
  const primary = certs.find((c) => str(c.id) === str(pack.primary_certificate)) ?? certs[0];
  return { zoneId, expires: dateOf(primary?.expires_on), status: (str(pack.status) ?? '').toLowerCase() };
}

/** The 24 hour starts the traffic is laid on: the current hour last. */
export function trafficHours(now: Date): number[] {
  const last = Math.floor(now.getTime() / H) * H;
  return Array.from({ length: 24 }, (_, i) => last - (23 - i) * H);
}

export const HOURLY_QUERY = `query ($zones: [String!], $since: Time!, $until: Time!) { viewer { zones(filter: {zoneTag_in: $zones}) { zoneTag httpRequests1hGroups(limit: 30, filter: {datetime_geq: $since, datetime_lt: $until}, orderBy: [datetime_ASC]) { dimensions { datetime } sum { requests cachedRequests threats } } } } }`;

export const ADAPTIVE_QUERY = `query ($zones: [String!], $since: Time!, $until: Time!) { viewer { zones(filter: {zoneTag_in: $zones}) { zoneTag httpRequestsAdaptiveGroups(limit: 2000, filter: {datetime_geq: $since, datetime_lt: $until}) { count dimensions { datetimeHour cacheStatus } } } } }`;

const CACHED = new Set(['hit', 'stale', 'updating', 'revalidated']);

/** A GraphQL answer's traffic per zone (either dataset); null when it answered errors only. */
export function parseTraffic(body: unknown, now: Date): Map<string, CfTraffic> | null {
  const b = rec(body);
  const zones = list(rec(rec(b.data).viewer).zones);
  const answered = zones.some(
    (z) => Array.isArray(rec(z).httpRequests1hGroups) || Array.isArray(rec(z).httpRequestsAdaptiveGroups),
  );
  // GraphQL says what it refused in `errors` beside a 200: this dataset isn't the token's or the plan's.
  if (list(b.errors).length && !answered) return null;
  const hours = trafficHours(now);
  const slot = (iso: unknown) => {
    const t = Date.parse(str(iso) ?? '');
    return Number.isFinite(t) ? hours.indexOf(Math.floor(t / H) * H) : -1;
  };
  const out = new Map<string, CfTraffic>();
  for (const raw of zones.slice(0, ZONES_MAX)) {
    const z = rec(raw);
    const id = str(z.zoneTag);
    if (!id) continue;
    const t: CfTraffic = { requests: 0, cached: 0, threats: null, hourly: hours.map(() => null) };
    const add = (i: number, n: number) => {
      if (i >= 0) t.hourly[i] = (t.hourly[i] ?? 0) + n;
    };
    if (Array.isArray(z.httpRequests1hGroups)) {
      t.threats = 0;
      for (const g of list(z.httpRequests1hGroups)) {
        const sum = rec(rec(g).sum);
        const requests = num(sum.requests) ?? 0;
        t.requests += requests;
        t.cached += num(sum.cachedRequests) ?? 0;
        t.threats += num(sum.threats) ?? 0;
        add(slot(rec(rec(g).dimensions).datetime), requests);
      }
    } else
      for (const g of list(z.httpRequestsAdaptiveGroups)) {
        const n = num(rec(g).count) ?? 0;
        const d = rec(rec(g).dimensions);
        t.requests += n;
        if (CACHED.has((str(d.cacheStatus) ?? '').toLowerCase())) t.cached += n;
        add(slot(d.datetimeHour), n);
      }
    out.set(id, t);
  }
  return out;
}

async function readTraffic(
  services: Services,
  row: CatalogConnectionRow,
  zones: readonly CfZone[],
  now: Date,
): Promise<Map<string, CfTraffic> | null> {
  if (!zones.length) return new Map();
  const variables = {
    zones: zones.map((z) => z.id),
    since: new Date(trafficHours(now)[0] as number).toISOString(),
    until: now.toISOString(),
  };
  const ask = async (query: string) =>
    parseTraffic(
      okJson(
        await readAnswer(services, row, NAME, `${API}/graphql`, {
          method: 'POST',
          body: { query, variables },
        }),
        NAME,
      ),
      now,
    );
  return (await ask(HOURLY_QUERY)) ?? (await ask(ADAPTIVE_QUERY));
}

/** Per connection, when each tunnel was first seen degraded (kept in memory, as Pterodactyl's `lastRunning`). */
const degradedFrom = new Map<string, Map<string, number>>();

/** Notes on each tunnel since when it is degraded; forgets the ones that aren't any more. */
export function markDegraded(connectionId: string, tunnels: readonly CfTunnel[], now: Date): void {
  let seen = degradedFrom.get(connectionId);
  if (!seen) {
    seen = new Map();
    degradedFrom.set(connectionId, seen);
  }
  const listed = new Set(tunnels.map((t) => t.id));
  for (const id of seen.keys()) if (!listed.has(id)) seen.delete(id);
  for (const t of tunnels) {
    if (t.status !== 'degraded') {
      seen.delete(t.id);
      t.degradedSince = null;
      continue;
    }
    const at = seen.get(t.id) ?? now.getTime();
    seen.set(t.id, at);
    t.degradedSince = new Date(at);
  }
}

async function readTunnels(
  services: Services,
  row: CatalogConnectionRow,
  accounts: readonly string[],
  now: Date,
): Promise<{ tunnels: CfTunnel[]; partial: boolean } | null> {
  const lists = await Promise.all(
    accounts.map((a) =>
      optional(
        getJson(services, row, NAME, `${API}/accounts/${encodeURIComponent(a)}/cfd_tunnel`, {
          is_deleted: 'false',
          per_page: '100',
        }),
      ).then((doc) => (doc ? parseTunnels(doc, a) : null)),
    ),
  );
  const read = lists.filter((l): l is CfTunnel[] => l !== null);
  if (!read.length) return null;
  const tunnels = read.flat();
  markDegraded(row.id, tunnels, now);
  await Promise.all(
    tunnels
      .filter((t) => t.status === 'healthy' || t.status === 'degraded')
      .slice(0, CONNECTIONS_MAX)
      .map(async (t) => {
        const doc = await optional(
          getJson(
            services,
            row,
            NAME,
            `${API}/accounts/${encodeURIComponent(t.account)}/cfd_tunnel/${encodeURIComponent(t.id)}/connections`,
          ),
        );
        if (doc) Object.assign(t, parseConnections(doc));
      }),
  );
  return { tunnels, partial: read.length < lists.length };
}

/**
 * `GET /accounts/{id}/cfd_tunnel/{tid}/configurations`: where a tunnel set up in Cloudflare's dashboard sends each
 * hostname (and path). The catch-all without a hostname isn't a route.
 */
export function parseIngress(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of list(rec(rec(resultOf(body)).config).ingress).slice(0, 200)) {
    const r = rec(raw);
    const host = str(r.hostname);
    const service = str(r.service);
    if (!host || !service) continue;
    const path = str(r.path);
    out[path ? `${host}${path.startsWith('/') ? '' : '/'}${path}` : host] = service;
  }
  return out;
}

/**
 * The routes of the tunnels set up in Cloudflare's dashboard, kept 15 minutes, for the change log; null when there
 * are none to read or one couldn't be read (a missing tunnel's routes would look removed).
 */
async function tunnelRoutes(
  services: Services,
  row: CatalogConnectionRow,
  tunnels: readonly CfTunnel[] | null,
): Promise<TrackedRoutes | null> {
  const remote = (tunnels ?? []).filter((t) => t.remote).slice(0, ROUTES_TUNNELS_MAX);
  if (!remote.length) return null;
  return cachedRead(
    services,
    `cloudflare-routes:${row.id}:${remote.map((t) => t.id).join(',')}`,
    row,
    async () => {
      const maps = await Promise.all(
        remote.map(async (t) =>
          parseIngress(
            await getJson(
              services,
              row,
              NAME,
              `${API}/accounts/${encodeURIComponent(t.account)}/cfd_tunnel/${encodeURIComponent(t.id)}/configurations`,
            ),
          ),
        ),
      );
      return { via: 'tunnel' as const, map: Object.assign({}, ...maps) as Record<string, string> };
    },
    ROUTES_CACHE_MS,
  ).catch(() => null);
}

async function readCertificates(
  services: Services,
  row: CatalogConnectionRow,
  zones: readonly CfZone[],
): Promise<{ certificates: CfCertificate[]; partial: boolean } | null> {
  const got = await Promise.all(
    zones.map((z) =>
      cachedRead(
        services,
        `cloudflare-certs:${row.id}:${z.id}`,
        row,
        async () =>
          parseCertificatePacks(
            await getJson(
              services,
              row,
              NAME,
              `${API}/zones/${encodeURIComponent(z.id)}/ssl/certificate_packs`,
              {
                status: 'all',
              },
            ),
            z.id,
          ),
        CERTS_CACHE_MS,
      ).then(
        (c) => ({ ok: true as const, c }),
        () => ({ ok: false as const, c: null }),
      ),
    ),
  );
  if (!got.some((g) => g.ok)) return null;
  return { certificates: got.flatMap((g) => (g.c ? [g.c] : [])), partial: got.some((g) => !g.ok) };
}

export const cloudflareReader = snapshotReader<CfSnapshot>(NAME, 'cloudflare', async (services, row, now) => {
  const [zonesDoc, accountsDoc] = await Promise.all([
    getJson(services, row, NAME, `${API}/zones`, { per_page: '50' }),
    optional(getJson(services, row, NAME, `${API}/accounts`, { per_page: '20' })),
  ]);
  const { zones, total } = parseZones(zonesDoc);
  const shown = [...zones].sort((a, b) => a.name.localeCompare(b.name)).slice(0, ZONES_MAX);
  const known = [
    ...new Set([
      ...zones.flatMap((z) => (z.account ? [z.account] : [])),
      ...list(resultOf(accountsDoc)).flatMap((a) => (str(rec(a).id) ? [str(rec(a).id) as string] : [])),
    ]),
  ];
  const accounts = known.slice(0, ACCOUNTS_MAX);
  const [traffic, tunnels, certificates] = await Promise.all([
    cachedRead(
      services,
      `cloudflare-traffic:${row.id}`,
      row,
      () => readTraffic(services, row, shown, now),
      TRAFFIC_CACHE_MS,
    ).catch(() => null),
    readTunnels(services, row, accounts, now),
    readCertificates(services, row, shown),
  ]);
  return {
    readAt: now,
    zones: shown,
    zonesTotal: total,
    traffic,
    tunnels: tunnels?.tunnels ?? null,
    certificates: certificates?.certificates ?? null,
    domainExpirations: null,
    ...(tunnels && (tunnels.partial || known.length > accounts.length) ? { tunnelsPartial: true } : {}),
    ...(certificates?.partial ? { certificatesPartial: true } : {}),
  };
});

/* What it means ------------------------------------------------------------------------------------------------------- */

/** Every site's traffic added up, hour by hour. */
export function totals(s: CfSnapshot) {
  if (!s.traffic) return null;
  const all = [...s.traffic.values()];
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const xs = all.map((t) => t.hourly[i] ?? null).filter((v): v is number => v !== null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  });
  const threats = all.some((t) => t.threats !== null) ? all.reduce((a, t) => a + (t.threats ?? 0), 0) : null;
  return {
    requests: all.reduce((a, t) => a + t.requests, 0),
    cached: all.reduce((a, t) => a + t.cached, 0),
    threats,
    hourly,
  };
}

const running = (t: CfTunnel) => t.status !== 'inactive';

/** “12.4 k”, “1.2 M”, “840”. */
export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)} k`;
  return thousands(Math.round(n));
}

export function cloudflareKpis(s: CfSnapshot): ThingPageKpi[] {
  const out: ThingPageKpi[] = [];
  const t = totals(s);
  if (t) {
    out.push({
      key: 'requests',
      label: 'Requests',
      value: compact(t.requests),
      rest: 'in 24 h',
      sub: plural(s.zones.length, 'site'),
      spark: t.hourly,
      color: 'orange',
    });
    out.push({
      key: 'cached',
      label: 'From cache',
      value: t.requests ? pct((t.cached / t.requests) * 100) : '—',
      sub: `${compact(t.cached)} requests`,
      ...(t.requests ? { meter: Math.min(1, t.cached / t.requests) } : {}),
      color: 'blue',
    });
    if (t.threats !== null)
      out.push({
        key: 'threats',
        label: 'Threats',
        value: compact(t.threats),
        rest: 'in 24 h',
        sub: 'stopped by Cloudflare',
      });
  }
  if (s.tunnels?.length) {
    const live = s.tunnels.filter(running);
    const healthy = live.filter((x) => x.status === 'healthy').length;
    const down = live.filter((x) => x.status === 'down').length;
    const degraded = live.filter((x) => x.status === 'degraded').length;
    out.push({
      key: 'tunnels',
      label: 'Tunnels',
      value: String(healthy),
      rest: `of ${live.length} healthy`,
      sub: down
        ? `${down} down`
        : degraded
          ? `${degraded} degraded`
          : live.length
            ? 'all healthy'
            : 'none running',
      ...(down ? { tone: 'bad' as const } : degraded ? { tone: 'warn' as const } : {}),
    });
  }
  return out;
}

const zoneName = (s: CfSnapshot, id: string) => s.zones.find((z) => z.id === id)?.name ?? 'A site';

/** Every check Cloudflare's page can raise (QN-15). */
export const CLOUDFLARE_CHECKS: readonly KindCheck[] = [
  {
    check: 'cloudflare.tunnel_down',
    name: 'Tunnels going down',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'cloudflare.tunnel_degraded',
    name: 'Tunnels losing connections',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  { check: 'cloudflare.cert', name: 'Certificates ending', nature: 'problem', perItem: true, startsOn: true },
  {
    check: 'cloudflare.domain_expiring',
    name: 'Domains about to expire',
    nature: 'you',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'cloudflare.zone',
    name: 'Sites that aren’t active',
    nature: 'you',
    perItem: true,
    startsOn: false,
  },
  { check: 'cloudflare.paused', name: 'Paused sites', nature: 'fyi', perItem: true, startsOn: false },
  {
    check: 'cloudflare.token_hint',
    name: 'The hint to connect with an API token',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];

/** What this read couldn't see (QN-11): a part the token may not read, a refused account, sites past the first ten. */
export function cloudflareSkipped(s: CfSnapshot): string[] {
  const out: string[] = [];
  if (!s.tunnels || s.tunnelsPartial) out.push('cloudflare.tunnel_down', 'cloudflare.tunnel_degraded');
  if (!s.certificates || s.certificatesPartial) out.push('cloudflare.cert');
  if (s.domainExpirations === null || s.domainExpirationsPartial) out.push('cloudflare.domain_expiring');
  if (s.zonesTotal > s.zones.length)
    out.push('cloudflare.cert', 'cloudflare.domain_expiring', 'cloudflare.zone', 'cloudflare.paused');
  return out;
}

const tunnelSubject = (t: CfTunnel) => ({ id: `tunnel:${t.id}`, name: t.name });
const siteSubject = (s: CfSnapshot, zoneId: string) => ({
  id: `site:${zoneId}`,
  name: clip(zoneName(s, zoneId), 80),
});

function tunnelLines(s: CfSnapshot, now: Date): KindNotice[] {
  const down = (s.tunnels ?? [])
    .filter((x) => x.status === 'down')
    .map((t): KindNotice => {
      const retired = t.inactiveAt && now.getTime() - t.inactiveAt.getTime() > DOWN_RETIRED_MS;
      if (retired)
        // Down for over a month: most likely a tunnel nobody uses any more (QN-04).
        return {
          id: `tunnel-down-${t.id}`,
          tone: 'info',
          icon: 'network',
          title: clip(
            `Tunnel ${t.name} has been down for ${span(now.getTime() - (t.inactiveAt as Date).getTime())}`,
            120,
          ),
          detail: 'If nothing uses it any more, delete it in Cloudflare.',
          link: { kind: 'url', label: 'Open Cloudflare', url: CLOUDFLARE_DASH },
          nature: 'fyi',
          check: 'cloudflare.tunnel_down',
          subject: tunnelSubject(t),
          ignore: { lifts: 'fixed', words: 'Until you sign in again.' },
        };
      return {
        id: `tunnel-down-${t.id}`,
        tone: 'bad',
        icon: 'network',
        title: clip(`Tunnel ${t.name} is down`, 120),
        detail: 'What it publishes can’t be reached until its cloudflared connects again.',
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: clip(`Why is the Cloudflare tunnel ${t.name} down?`, 300),
        },
        nature: 'problem',
        check: 'cloudflare.tunnel_down',
        subject: tunnelSubject(t),
        ignore: { lifts: 'fixed', words: 'Until you sign in again.' },
        badge: badgeOf(`Tunnel ${t.name} down`),
      };
    });
  const degraded = (s.tunnels ?? [])
    .filter((x) => x.status === 'degraded')
    .map((t): KindNotice => {
      const long = !!t.degradedSince && now.getTime() - t.degradedSince.getTime() >= DEGRADED_LONG_MS;
      return {
        id: `tunnel-degraded-${t.id}`,
        tone: long ? 'warn' : 'info',
        icon: 'network',
        title: clip(`Tunnel ${t.name} is degraded`, 120),
        detail: long
          ? `Some of its connections to Cloudflare have been down for ${span(now.getTime() - (t.degradedSince as Date).getTime())}.`
          : 'Some of its connections to Cloudflare are down; it still serves.',
        ...(long
          ? {
              link: {
                kind: 'ask' as const,
                label: 'Look into it',
                question: clip(`Why is the Cloudflare tunnel ${t.name} degraded?`, 300),
              },
              badge: badgeOf(`Tunnel ${t.name} degraded`),
            }
          : {}),
        nature: long ? 'problem' : 'fyi',
        check: 'cloudflare.tunnel_degraded',
        subject: tunnelSubject(t),
        ignore: { lifts: 'fixed', words: 'Until it’s healthy again.' },
      };
    });
  const more = (check: string, word: string) => (rest: readonly KindNotice[]) => ({
    id: `${check}-more`,
    title: plural(rest.length, `more tunnel is ${word}`, `more tunnels are ${word}`),
    detail: clip(rest.map((n) => n.subject?.name ?? n.title).join(' · '), 200),
  });
  return [
    ...itemLines(down, more('tunnel-down', 'down')),
    ...itemLines(degraded, more('tunnel-degraded', 'degraded')),
  ];
}

/** Worth a look (SD-43; quiet-notices.md QN-01…QN-04): one line per tunnel and site. */
export function cloudflareNotices(s: CfSnapshot, now: Date): KindNotice[] {
  const out: KindNotice[] = tunnelLines(s, now);
  for (const c of (s.certificates ?? []).filter(
    (x) => x.expires && daysUntil(x.expires, now) < CERT_WARN_DAYS,
  )) {
    const name = zoneName(s, c.zoneId);
    const expired = (c.expires as Date) <= now;
    out.push({
      id: `cert-${c.zoneId}`,
      tone: expired ? 'bad' : 'warn',
      icon: 'certificate',
      title: clip(
        expired
          ? `The certificate for ${name} has expired`
          : `The certificate for ${name} ends ${inTime(c.expires as Date, now)}`,
        120,
      ),
      detail: 'Cloudflare usually renews it well before; its renewal may be stuck.',
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: clip(`Why hasn’t Cloudflare renewed the certificate for ${name}?`, 300),
      },
      nature: 'problem',
      check: 'cloudflare.cert',
      subject: siteSubject(s, c.zoneId),
      // A renewed certificate ends later: that's a new one.
      episode: (c.expires as Date).toISOString(),
      ignore: { lifts: 'newer', words: 'Until it’s renewed.' },
      badge: badgeOf(expired ? `Certificate expired: ${name}` : `Certificate ending: ${name}`),
    });
  }
  for (const z of s.zones.filter((x) => x.status !== 'moved')) {
    const expires = s.domainExpirations?.get(z.name.toLowerCase()) ?? null;
    if (!expires || daysUntil(expires, now) >= DOMAIN_WARN_DAYS) continue;
    const expired = expires <= now;
    const urgent = daysUntil(expires, now) < DOMAIN_URGENT_DAYS;
    out.push({
      id: `domain-expiring-${z.id}`,
      tone: expired || urgent ? 'bad' : 'warn',
      icon: 'clock',
      title: clip(
        expired
          ? `${z.name}’s domain registration has expired`
          : `${z.name}’s domain registration expires ${inTime(expires, now)}`,
        120,
      ),
      detail: expired
        ? 'Renew it with your domain registrar right away so your website and email come back.'
        : 'Renew it with your domain registrar before it expires so your website and email don’t stop working.',
      link: { kind: 'url', label: 'Open Cloudflare', url: CLOUDFLARE_DASH },
      nature: 'you',
      check: 'cloudflare.domain_expiring',
      subject: siteSubject(s, z.id),
      // Renewing pushes the registration expiry date forward, lifting an ignore automatically.
      episode: expires.toISOString(),
      ignore: { lifts: 'newer', words: 'Until it’s renewed.' },
      badge: badgeOf(expired ? `Domain expired: ${z.name}` : `Domain expiring: ${z.name}`),
    });
  }
  for (const z of s.zones.filter((x) => x.status !== 'active')) {
    // Setting up is a short state of a new site (catalogue-infra-media.md): a heads-up.
    const setup = z.status === 'initializing';
    out.push({
      id: `zone-${z.id}`,
      tone: setup ? 'info' : 'warn',
      icon: 'network',
      title: clip(
        z.status === 'moved'
          ? `${z.name} has moved away from Cloudflare`
          : setup
            ? `Cloudflare is setting up ${z.name}`
            : `${z.name} isn’t active on Cloudflare yet`,
        120,
      ),
      ...(z.status === 'pending'
        ? {
            detail:
              'Its name servers don’t point to Cloudflare yet: change them where the name is registered.',
          }
        : z.status === 'moved'
          ? { detail: 'If it isn’t used any more, remove the site in Cloudflare.' }
          : {}),
      ...(setup ? {} : { link: { kind: 'url' as const, label: 'Open Cloudflare', url: CLOUDFLARE_DASH } }),
      nature: setup ? 'fyi' : 'you',
      check: 'cloudflare.zone',
      subject: siteSubject(s, z.id),
      // Pending, then moved: another state is news.
      episode: z.status,
      ignore: { lifts: 'newer', words: 'Until it’s active or changes state.' },
      ...(setup ? {} : { badge: badgeOf(`${z.name} not active`) }),
    });
  }
  for (const z of s.zones.filter((x) => x.paused && x.status === 'active'))
    out.push({
      id: `paused-${z.id}`,
      tone: 'info',
      icon: 'power',
      title: clip(`Cloudflare is paused for ${z.name}`, 120),
      detail: 'Visitors reach your server directly, without its protection or cache.',
      nature: 'fyi',
      check: 'cloudflare.paused',
      subject: siteSubject(s, z.id),
      ignore: { lifts: 'fixed', words: 'Until it’s unpaused.' },
    });
  return uniqueById(out);
}

/** The head when nothing is worth a look (QN-S30): how many sites; the lines say what's wrong. */
export function cloudflareStatus(s: CfSnapshot): NonNullable<KindView['status']> {
  return okStatus(plural(s.zones.length, 'site'));
}

/** Clear cache✱ on a site (SD-43): everything at once. */
export function purgeButton(ctx: ButtonCtx, z: CfZone): PageButton {
  return pageButton(ctx, {
    action: 'purge',
    target: z.id,
    label: 'Clear cache',
    icon: 'clean',
    confirm: {
      title: clip(`Clear Cloudflare’s cache for ${z.name}?`, 80),
      body: 'Every file is fetched from your server again, so the site may be slower for a few minutes.',
      button: 'Clear cache',
    },
  });
}

const ZONE_WORDS: Record<string, { text: string; dot: NonNullable<ThingPageCell['dot']> }> = {
  active: { text: 'Active', dot: 'ok' },
  pending: { text: 'Waiting for name servers', dot: 'warn' },
  initializing: { text: 'Setting up', dot: 'warn' },
  moved: { text: 'Moved away', dot: 'bad' },
};

export function zoneRows(s: CfSnapshot, ctx: ButtonCtx): ThingPageRow[] {
  return s.zones.map((z) => {
    const t = s.traffic?.get(z.id) ?? null;
    return {
      id: z.id,
      cells: {
        site: {
          text: z.name,
          ...(z.plan ? { note: clip(z.plan, 80) } : {}),
          ...(z.account
            ? { url: `${CLOUDFLARE_DASH}${encodeURIComponent(z.account)}/${encodeURIComponent(z.name)}` }
            : {}),
        },
        status:
          z.paused && z.status === 'active'
            ? { text: 'Paused', dot: 'warn' }
            : (ZONE_WORDS[z.status] ?? { text: z.status, dot: 'off' }),
        requests: t
          ? { text: compact(t.requests), mono: true, spark: t.hourly }
          : { text: '—', tone: 'muted' },
        cached: t?.requests
          ? { text: pct((t.cached / t.requests) * 100), mono: true }
          : { text: '—', tone: 'muted' },
        purge: { text: 'Clear cache', action: purgeButton(ctx, z) },
      },
    };
  });
}

export function cloudflareFacts(s: CfSnapshot): ThingLine[] {
  const parts = [`**${plural(s.zonesTotal, 'site')}**`];
  if (s.tunnels?.length) parts.push(`**${plural(s.tunnels.length, 'tunnel')}**`);
  return [line(parts.join(' · '))];
}

/** Sites on the Summary's Inventory; past this, the Sites tab has them all. */
export const SUMMARY_SITES = 6;
/** Tunnel lines in Live. */
const LIVE_TUNNELS = 8;
const TUNNEL_RANK: Record<TunnelState, number> = { down: 0, degraded: 1, healthy: 2, inactive: 3 };

/** Live, “Tunnels”: a line per running tunnel, down first, with its connections; none running, no Live. */
export function cloudflareLive(s: CfSnapshot, now: Date): LivePanel | null {
  const live = [...(s.tunnels ?? [])]
    .filter(running)
    .sort((a, b) => TUNNEL_RANK[a.status] - TUNNEL_RANK[b.status] || a.name.localeCompare(b.name));
  if (!live.length) return null;
  const down = live.filter((t) => t.status === 'down').length;
  const degraded = live.filter((t) => t.status === 'degraded').length;
  const healthy = live.length - down - degraded;
  const meta = [
    down ? `${down} down` : null,
    degraded ? `${degraded} degraded` : null,
    down || degraded
      ? healthy
        ? `${healthy} healthy`
        : null
      : live.length > 1
        ? `All ${live.length} healthy`
        : 'Healthy',
  ]
    .filter(Boolean)
    .join(' · ');
  // A line's words on the right say its connections in full; the count stays its figure, for a desk.
  const connWords = (t: CfTunnel) =>
    t.connections === null ? undefined : plural(t.connections, 'connection');
  const items = live.slice(0, LIVE_TUNNELS).map((t): ThingPageItem => {
    const colos = t.colos.length ? ` · ${t.colos.join(' · ')}` : '';
    const conns = t.connections !== null ? String(t.connections) : '—';
    if (t.status === 'down')
      return {
        ...countLine({
          id: t.id,
          title: t.name,
          icon: 'network',
          detail: t.inactiveAt ? `Down for ${span(now.getTime() - t.inactiveAt.getTime())}` : 'Not connected',
          value: '0',
          note: 'Down',
          noteTone: 'bad',
          tone: 'bad',
        }),
        right: 'Down',
      };
    if (t.status === 'degraded')
      return {
        ...countLine({
          id: t.id,
          title: t.name,
          icon: 'network',
          detail: `${t.degradedSince ? `Degraded for ${span(Math.max(60_000, now.getTime() - t.degradedSince.getTime()))}` : 'Degraded'}${colos}`,
          value: conns,
          note: 'Degraded',
          noteTone: 'warn',
          tone: 'warn',
        }),
        right: connWords(t) ?? 'Degraded',
      };
    return {
      ...countLine({
        id: t.id,
        title: t.name,
        icon: 'network',
        detail: `Healthy${colos}`,
        value: conns,
        note: t.connections === 1 ? 'connection' : 'connections',
        tone: 'ok',
      }),
      ...(connWords(t) ? { right: connWords(t) } : {}),
    };
  });
  return liveList({
    id: 'tunnels',
    title: 'Tunnels',
    meta: live.length > LIVE_TUNNELS ? `${meta} · ${LIVE_TUNNELS} of ${live.length}` : meta,
    items,
  });
}

const ZONE_NOTES: Record<string, { note: string; noteTone?: ThingTone }> = {
  initializing: { note: 'Setting up' },
  pending: { note: 'Waiting for name servers', noteTone: 'warn' },
  moved: { note: 'Moved away', noteTone: 'bad' },
};

/** Inventory, “Sites”: each site's requests in the last 24 hours, the share from the cache, its Clear cache. */
export function cloudflareSites(s: CfSnapshot, ctx: ButtonCtx): InventoryPanel | null {
  if (!s.zones.length) return null;
  const requests = (z: CfZone) => s.traffic?.get(z.id)?.requests ?? -1;
  const shown = [...s.zones]
    .sort((a, b) => requests(b) - requests(a) || a.name.localeCompare(b.name))
    .slice(0, SUMMARY_SITES);
  const more = s.zonesTotal > shown.length;
  return inventory({
    id: 'inventory',
    title: 'Sites',
    meta: more ? `${shown.length} of ${s.zonesTotal} · last 24 hours` : 'last 24 hours',
    ...(more && s.zones.length > shown.length
      ? { link: { kind: 'tab' as const, label: 'All sites', tab: 'sites' } }
      : {}),
    items: shown.map((z) => {
      const t = s.traffic?.get(z.id) ?? null;
      const detail = [
        t?.requests ? `${pct((t.cached / t.requests) * 100)} from cache` : null,
        t?.threats ? plural(t.threats, 'threat') : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const state =
        ZONE_NOTES[z.status] ??
        (z.paused
          ? { note: 'Paused', noteTone: 'warn' as const }
          : { note: t ? 'requests' : 'No traffic read' });
      return countLine({
        id: z.id,
        title: z.name,
        icon: 'network',
        value: t ? compact(t.requests) : '—',
        ...(detail ? { detail } : {}),
        ...state,
        actions: [purgeButton(ctx, z)],
        ...(z.account
          ? { url: `${CLOUDFLARE_DASH}${encodeURIComponent(z.account)}/${encodeURIComponent(z.name)}` }
          : {}),
      });
    }),
  });
}

/**
 * Trend, “Last 24 hours”: every site's requests in two-hour bars from the hourly traffic already read, with the share
 * from the cache and the threats stopped. Cloudflare's daily dataset isn't promised on every plan, so the week stays
 * out.
 */
export function cloudflareTrend(s: CfSnapshot, now: Date, timeZone: string): TrendPanel | null {
  const t = totals(s);
  if (!t?.requests) return null;
  const hours = trafficHours(now).map((at, i) => ({ at: new Date(at), total: t.hourly[i] ?? 0, blocked: 0 }));
  const bars = twoHours(hours, timeZone);
  const at = bars.map((b) => b.at);
  const panel = trend({
    id: 'requests',
    title: 'Last 24 hours',
    meta: 'Requests per 2 hours',
    days: { at, labels: hourWords(at, timeZone) },
    values: bars.map((b) => b.total),
    label: 'Requests',
    figure: { value: compact(t.requests), rest: t.requests === 1 ? 'request' : 'requests' },
    change: pct((t.cached / t.requests) * 100),
    changeWords: ' from cache',
    color: 'orange',
  });
  return t.threats
    ? {
        ...panel,
        stats: [
          ...(panel.stats ?? []),
          [
            { text: compact(t.threats), strong: true },
            { text: t.threats === 1 ? ' threat stopped' : ' threats stopped' },
          ],
        ],
      }
    : panel;
}

/** Tunnels that never connected: below the slots, only while any. */
function unusedTunnels(s: CfSnapshot): ThingPagePanel | null {
  const unused = (s.tunnels ?? []).filter((t) => !running(t));
  if (!unused.length) return null;
  return {
    kind: 'list',
    id: 'tunnels-unused',
    title: 'Tunnels that never connected',
    meta: plural(unused.length, 'tunnel'),
    items: unused.slice(0, 30).map((t) => ({
      id: t.id,
      title: t.name,
      icon: 'network' as const,
      detail: 'Never connected',
      tone: 'info' as const,
    })),
  };
}

export interface CfInput {
  snapshot: CfSnapshot;
  now: Date;
  row: ButtonCtx['row'];
  /** The burrow's zone, for the hours under the Trend's bars. */
  timeZone?: string;
}

/**
 * The page's Cloudflare part (SD-43), its Summary in slots: the tunnels now beside the sites with their requests and
 * Clear cache, then the last 24 hours' requests; no shelf, people or machine (a cloud service). Pure.
 */
export function cloudflareView({ snapshot: s, now, row, timeZone = 'UTC' }: CfInput): KindView {
  const ctx: ButtonCtx = { row };
  const unused = unusedTunnels(s);
  const tabs: ThingPageTab[] =
    s.zones.length > SUMMARY_SITES
      ? [
          {
            key: 'sites',
            label: 'Sites',
            count: s.zonesTotal,
            panels: [
              {
                kind: 'table',
                id: 'sites',
                title: 'Sites',
                meta:
                  s.zonesTotal > s.zones.length ? `${s.zones.length} of ${s.zonesTotal}` : 'last 24 hours',
                columns: [
                  { key: 'site', label: 'Site' },
                  { key: 'status', label: 'Status' },
                  { key: 'requests', label: 'Requests', numeric: true },
                  { key: 'cached', label: 'From cache', numeric: true },
                  { key: 'purge', label: '' },
                ],
                rows: zoneRows(s, ctx),
              },
            ],
          },
        ]
      : [];
  return {
    // In slots its figures are in Tunnels, Sites and the Trend; the card keeps them (`cloudflareCardView`).
    kpis: [],
    machine: 'after',
    charts: [],
    notices: cloudflareNotices(s, now),
    ...slotPanels({
      live: cloudflareLive(s, now),
      inventory: cloudflareSites(s, ctx),
      trend: cloudflareTrend(s, now, timeZone),
      more: unused ? [unused] : [],
      // A cloud service: no machine.
      machine: [],
    }),
    tabs,
    facts: cloudflareFacts(s),
    status: cloudflareStatus(s),
    open: { label: 'Open Cloudflare', url: CLOUDFLARE_DASH },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Requests per country', 'DNS records', 'Firewall events'],
  };
}

/** The page's part as the card reads it: the page in slots has no row of figures, the card keeps Requests and Tunnels. */
export function cloudflareCardView(input: CfInput): KindView {
  return { ...cloudflareView(input), kpis: cloudflareKpis(input.snapshot) };
}

/** A “Sign in with Cloudflare” connection: its tools are the agent's; the page needs an API token (SD-S16). */
export const viaToken = (row: Pick<CatalogConnectionRow, 'signIn'>) => row.signIn === 'token';

/**
 * What the page says under the name when signed in with Cloudflare: the hint below starts off, as advice about settings
 * does, so without this line the page wouldn't say why it shows nothing of Cloudflare's own.
 */
export const TOKEN_HINT = 'An API token shows its traffic and tunnels here.';

export function signInView(): KindView {
  return {
    problem: TOKEN_HINT,
    machine: 'after',
    charts: [],
    notices: [
      {
        id: 'api-token',
        tone: 'info',
        icon: 'key',
        title: 'An API token shows its traffic and tunnels here.',
        detail:
          'Signed in with Cloudflare, agents use its own tools; connect it with an API token to see it here too.',
        link: { kind: 'tab', label: 'Settings', tab: 'settings' },
        nature: 'fyi',
        check: 'cloudflare.token_hint',
        ignore: { lifts: 'fixed', words: 'Until it’s connected with an API token.' },
      } satisfies KindNotice,
    ],
    panels: [],
    tabs: [],
    facts: [],
    open: { label: 'Open Cloudflare', url: CLOUDFLARE_DASH },
    actions: [],
    readAt: null,
    suggestions: [],
  };
}

function domainNames(s: CfSnapshot): string[] {
  return s.zones.filter((z) => z.status !== 'moved').map((z) => z.name);
}

export async function cloudflarePage(ctx: KindCtx): Promise<KindView> {
  if (!viaToken(ctx.row)) return signInView();
  const read = await cloudflareReader.latest(ctx.services, ctx.row, ctx.now);
  if (!read.ok) return unreadView(read, NAME, { label: 'Open Cloudflare', url: CLOUDFLARE_DASH }, []);
  let snapshot = read.value;
  if (ctx.quiet && checkWatched(ctx.quiet, 'cloudflare.domain_expiring')) {
    const domains = domainNames(snapshot);
    const cached = cachedDomainExpirations(ctx.services, domains, ctx.now);
    if (cached.missing) warmDomainExpirations(ctx.services, domains, ctx.now);
    snapshot = {
      ...snapshot,
      domainExpirations: cached.expirations,
      ...(cached.partial ? { domainExpirationsPartial: true } : {}),
    };
  }
  return {
    ...cloudflareView({ snapshot, now: ctx.now, row: ctx.row, timeZone: ctx.timeZone }),
    refreshing: read.refreshing,
  };
}

/** Clear one site's whole cache (SD-43 ✱). */
const purge: KindAction = async ({ services, row, now }, { target }) => {
  if (!viaToken(row)) throw notOffered('That site');
  const s = await cloudflareReader.cached(services, row, now);
  const z = s.zones.find((x) => x.id === target);
  if (!z) throw notOffered('That site');
  const answer = await actAs(services, row, NAME, {
    method: 'POST',
    path: `${API}/zones/${encodeURIComponent(z.id)}/purge_cache`,
    body: { purge_everything: true },
  });
  if (rec(answer.json).success === false)
    throw new ApiError('unavailable', `Cloudflare didn’t clear the cache for ${z.name}.`);
  return {
    message: `Cleared Cloudflare’s cache for ${z.name}.`,
    title: clip(`Cleared Cloudflare’s cache for ${z.name}`, 200),
  };
};

export const CLOUDFLARE_KIND: KindModule = {
  page: cloudflarePage,
  seen: async (services, row, now, timeZone, quiet) => {
    if (!viaToken(row)) return { glance: { facts: [] }, points: {}, ...linesSeen(signInView(), []) };
    const base = await cloudflareReader.cached(services, row, now);
    const watchExpiry = quiet ? checkWatched(quiet, 'cloudflare.domain_expiring') : false;
    const rdap = watchExpiry
      ? await readDomainExpirations(services, domainNames(base), now).catch(() => null)
      : null;
    const s: CfSnapshot = watchExpiry
      ? {
          ...base,
          domainExpirations: rdap?.expirations ?? null,
          ...(rdap?.partial ? { domainExpirationsPartial: true } : {}),
        }
      : base;
    const view = cloudflareCardView({ snapshot: s, now, row, timeZone });
    return {
      glance: cardOf(view, ['requests', 'tunnels'], plural(s.zonesTotal, 'site')),
      points: {},
      tracked: { routes: await tunnelRoutes(services, row, s.tunnels) },
      ...linesSeen(view, cloudflareSkipped(s)),
    };
  },
  checks: CLOUDFLARE_CHECKS,
  actions: { purge },
};
