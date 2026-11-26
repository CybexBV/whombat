/**
 * Fusebox's page and tile (fusebox-page.md FP-01…FP-14; ai-gateway.md AIG-11, AIG-13): how the gateway runs. Its
 * Summary is in slots (docs/decisions/service-slots.md): the limits now (each tool's week and Claude's 5 hours, when
 * they reset or run out at this pace), what goes through it (subscriptions, keys, clients, requests and what this
 * month's use is worth at API prices), requests per day this week and who used it most, its own lines in the machine
 * card; each tool's week over the range, the subscriptions, who used each week and what Whombat sends below. Read
 * with the management key through Fusebox's own API (`/api/overview`, `/api/accounts`, `/api/faults` and
 * `/api/faults/dismissed`, and where its version has them `/api/clients/usage`, `/api/usage/status`,
 * `/api/usage/dashboard`), only the fields shown (FP-12); the limits and requests over time from the points the health
 * pass keeps (FP-03). Read only: changes are made in Fusebox (FP-11).
 */
import {
  GATEWAY_TOOL_LABELS,
  type GatewayAccountUsage,
  type GatewayProvider,
  type ThingGalleryItem,
  type ThingLine,
  type ThingPageBar,
  type ThingPageItem,
  type ThingPagePanel,
  type ThingPageRow,
  type ThingSeriesColor,
} from '@whombat/core';
import { and, count, eq, gte } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../../connections/types';
import { burrows, dispatches, type StoredGatewayFault } from '../../db/schema/index';
import {
  type FuseboxOtherSubscription,
  fuseboxProviderMark,
  fuseboxSignedIn,
  fuseboxToolName,
  gatewayAccountKey,
  mapFuseboxAccounts,
  mapFuseboxOtherSubscriptions,
  mergeFaults,
  parseFuseboxFaults,
  planWords,
} from '../../gateway/fusebox';
import { gatewayUsageOf, switchesOf } from '../../gateway/store';
import type { Services } from '../../services';
import { readPoints } from '../points';
import {
  avgPeakLines,
  counterSteps,
  drawable,
  onRange,
  type PageRange,
  POINT_STEP_MS,
  pctStat,
  RANGE_MS,
  type RawPoint,
  seriesStats,
  statsOf,
} from '../series';
import { bytes, clip, line, list, num, pct, plural, rec, span, str, thousands } from '../words';
import { FAILING_WINDOW_MS, FUSEBOX_ACCOUNT_CHECKS, fuseboxNotices } from './fusebox-lines';
import {
  type FuseboxTotals,
  fuseboxGlance,
  fuseboxPoints,
  fuseboxStatus,
  isSubscription,
  memberKey,
  POOL_TOOLS,
  type Pool,
  type PoolWindow,
  poolFind,
  poolKey,
  poolsOf,
  REQ_FAILED_KEY,
  REQ_OK_KEY,
  roundHour,
  TOOL_NAME,
  untilWords,
} from './fusebox-pool';
import { statusOf } from './home/lines';
import { ago } from './infra/shared';
import {
  cachedRead,
  getJson,
  KIND_DEADLINE_MS,
  latestRead,
  problemOf,
  ReadProblem,
  withDeadline,
} from './read';
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
  type PeoplePanel,
  people,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from './slots';
import type { ChartPanel, KindCtx, KindView } from './types';

const NAME = 'Fusebox';
const H = 3600_000;
const DAY = 24 * H;
/** This month's use is Fusebox's heaviest read: kept 5 minutes (FP-S01). */
const MONTH_CACHE_MS = 5 * 60_000;
/** Clients People holds; the rest of them are in the Clients table. Rows of that table at most. */
const PEOPLE_MAX = 8;
const CLIENTS_MAX = 100;
/** Clients in “Who used”. */
const WHO_MAX = 5;

/* Reading ------------------------------------------------------------------------------------------------------------ */

/** What `/api/overview` says that the page shows (FP-12: never its keys, paths or base URL). */
export interface FuseboxOverview {
  /** “0.7.0”: the release, without a build's `+gui.81f9ff12` (the card, the head). */
  version: string | null;
  /** As Fusebox says it, build included (“Fusebox itself”). */
  build: string | null;
  uptimeS: number | null;
  routing: string | null;
  affinity: boolean | null;
  totals: FuseboxTotals | null;
  models: number | null;
}

/**
 * When a subscription charges next, or ends when it was cancelled (`quota.renewal`): the date ChatGPT gives, or the
 * billing day someone set in Fusebox where the provider gives none (Claude's, Meta's).
 */
export interface FuseboxRenewal {
  at: Date;
  /** A billing day set by hand: a day without a time, the next charge until that day is over. */
  day: boolean;
  ends: boolean;
  /** Moved on a period from a date that passed, until Fusebox reads the next one. */
  estimated: boolean;
}

/** Of one account, what `/api/accounts` says beyond its limits: when it was last used, who used its windows. */
export interface FuseboxAccountMore {
  lastUsed: Date | null;
  renews?: FuseboxRenewal;
  /** The current windows' use per client (`quota_attribution.current`, 0.6+): percentage points of the window. */
  shares: { window: string; outside: number; clients: { id: string; label: string; points: number }[] }[];
}

/** One client this month (`/api/usage/dashboard`, `breakdowns.client`). */
export interface FuseboxMonthClient {
  id: string;
  label: string;
  requests: number;
  usd: number | null;
}

/** This month's use at API prices (`/api/usage/dashboard`). */
export interface FuseboxMonth {
  usd: number | null;
  /** Per day and tool, oldest first: `date` is the local day (YYYY-MM-DD). */
  days: { date: string; tool: GatewayProvider | 'other'; usd: number }[];
  clients: FuseboxMonthClient[];
}

/** Named clients (`/api/clients/usage`, 0.5+): when each was last used, which are connected now. */
export interface FuseboxClients {
  lastUsed: Map<string, Date>;
  connected: Set<string>;
}

export interface FuseboxSnapshot {
  readAt: Date;
  overview: FuseboxOverview | null;
  accounts: GatewayAccountUsage[];
  /** The subscriptions of other tools (Meta, Gemini, Grok…), listed beside the pools'. */
  others: FuseboxOtherSubscription[];
  /** The keys of the Claude and ChatGPT accounts Fusebox signs in to: subscriptions also while off and unread. */
  signedIn: ReadonlySet<string>;
  /** By account key. */
  more: Map<string, FuseboxAccountMore>;
  faults: StoredGatewayFault[];
  /** Fusebox's account id → the account's key (faults name Fusebox's id). */
  ids: Map<string, string>;
  clients: FuseboxClients | null;
  month: FuseboxMonth | null;
  /** The usage history on disk and how much it grows a day (`/api/usage/status` `database`). */
  history: { bytes: number; growthPerDay: number | null } | null;
}

const dateOf = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
};

/** `/api/overview`, the fields shown. */
export function parseOverview(body: unknown): FuseboxOverview {
  const b = rec(body);
  const t = rec(b.totals);
  const ok = num(t.ok);
  const failed = num(t.failed);
  const requests = num(t.requests);
  return {
    version: str(b.version)?.replace(/\+.*$/, '').slice(0, 40) || null,
    build: str(b.version)?.slice(0, 60) ?? null,
    uptimeS: num(b.uptime_secs),
    routing: str(b.routing)?.slice(0, 40) ?? null,
    affinity: typeof b.session_affinity === 'boolean' ? b.session_affinity : null,
    totals: ok !== null && failed !== null ? { ok, failed, requests: requests ?? ok + failed } : null,
    models: num(b.models),
  };
}

/** What `/api/accounts` says beyond the limits, by account key (`gatewayAccountKey`). */
export function parseAccountsMore(
  body: unknown,
  keyOf: (fuseboxId: string) => string,
): Map<string, FuseboxAccountMore> {
  const out = new Map<string, FuseboxAccountMore>();
  for (const raw of list(body).slice(0, 200)) {
    const a = rec(raw);
    const id = str(a.id);
    if (!id) continue;
    const shares = list(rec(a.quota_attribution).current)
      .slice(0, 16)
      .map((s) => {
        const r = rec(s);
        return {
          window: `${str(r.name) ?? ''}${str(r.model) ? ` ${str(r.model)}` : ''}`.trim(),
          outside: num(r.outside) ?? 0,
          clients: list(r.clients)
            .slice(0, 50)
            .map((c) => {
              const x = rec(c);
              const cid = str(x.id);
              return cid
                ? {
                    id: cid.slice(0, 200),
                    label: (str(x.label) ?? cid).slice(0, 80),
                    points: num(x.points) ?? 0,
                  }
                : null;
            })
            .filter((c): c is NonNullable<typeof c> => c !== null),
        };
      });
    const renewal = rec(rec(a.quota).renewal);
    const at = dateOf(renewal.at);
    out.set(keyOf(id), {
      lastUsed: dateOf(a.last_used),
      shares,
      ...(at
        ? {
            renews: {
              at,
              day: renewal.manual === true,
              ends: renewal.ends === true,
              estimated: renewal.estimated === true,
            },
          }
        : {}),
    });
  }
  return out;
}

/** Fusebox's provider names in its usage history → the tools. */
function toolOfGroup(group: string | null): GatewayProvider | 'other' {
  const g = (group ?? '').toLowerCase();
  if (g === 'anthropic' || g === 'claude') return 'claude';
  if (g === 'openai' || g === 'codex' || g === 'chatgpt') return 'codex';
  return 'other';
}

const usdOf = (nanos: unknown) => {
  const n = num(nanos);
  return n === null ? null : n / 1e9;
};

/** `/api/usage/dashboard`: this month's worth, per day and tool, and per client. */
export function parseMonth(body: unknown): FuseboxMonth {
  const combined = rec(rec(body).combined);
  const labels = new Map<string, string>();
  for (const c of list(rec(rec(body).facets).clients)) {
    const x = rec(c);
    const id = str(x.id);
    const label = str(x.label);
    if (id && label) labels.set(id, label);
  }
  const days = list(rec(combined.trends).provider)
    .slice(0, 31 * 12)
    .map((r) => {
      const x = rec(r);
      const date = str(x.date);
      const usd = usdOf(x.estimated_cost_nanos);
      return date && /^\d{4}-\d{2}-\d{2}$/.test(date) && usd !== null
        ? { date, tool: toolOfGroup(str(x.group)), usd }
        : null;
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);
  const clients = list(rec(combined.breakdowns).client)
    .slice(0, 100)
    .map((r) => {
      const x = rec(r);
      const id = str(x.id);
      if (!id) return null;
      return {
        id: id.slice(0, 200),
        label: (labels.get(id) ?? str(x.label) ?? id).slice(0, 80),
        requests: num(x.observations) ?? 0,
        usd: usdOf(x.estimated_cost_nanos),
      };
    })
    .filter((c): c is FuseboxMonthClient => c !== null);
  return { usd: usdOf(rec(combined.totals).estimated_cost_nanos), days, clients };
}

/** `/api/clients/usage`: when each named client was last used, which keys are connected now. */
export function parseClients(body: unknown): FuseboxClients {
  const b = rec(body);
  const lastUsed = new Map<string, Date>();
  for (const [id, at] of Object.entries(rec(b.last_used))) {
    const d = typeof at === 'number' ? new Date(at > 1e12 ? at : at * 1000) : dateOf(at);
    if (d && Number.isFinite(d.getTime())) lastUsed.set(id, d);
  }
  const connected = new Set<string>();
  for (const c of list(b.connected).slice(0, 200)) {
    const key = str(rec(c).key);
    if (key) connected.add(key);
  }
  return { lastUsed, connected };
}

/** `/api/usage/status` `database`. */
export function parseHistory(body: unknown): FuseboxSnapshot['history'] {
  const d = rec(rec(body).database);
  const size = num(d.bytes);
  return size === null ? null : { bytes: size, growthPerDay: num(d.growth_bytes_per_day) };
}

/** “2026-10-01” in a zone. */
function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
}

/** This month's query: the first of the month to tomorrow, in the burrow's zone (end is exclusive). */
export function monthQuery(now: Date, timeZone: string): Record<string, string> {
  const today = localDay(now, timeZone);
  return {
    start: `${today.slice(0, 8)}01`,
    end: localDay(new Date(now.getTime() + DAY), timeZone),
    timezone: timeZone,
  };
}

/** An optional read: null when this Fusebox doesn't have it or it fails (FP-13). */
const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

async function readFusebox(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<FuseboxSnapshot> {
  const get = (path: string, query?: Record<string, string>) => getJson(services, row, NAME, path, query);
  const [overview, accounts, faults, dismissed, clients, history, month] = await Promise.all([
    get('/api/overview'),
    get('/api/accounts'),
    optional(get('/api/faults')),
    // An older Fusebox without the dismissed list answers 404: none; any other failure is unknown (null).
    get('/api/faults/dismissed').catch((err) =>
      err instanceof ReadProblem && err.httpStatus === 404 ? [] : null,
    ),
    optional(get('/api/clients/usage')),
    optional(get('/api/usage/status')),
    optional(
      cachedRead(
        services,
        `fusebox-month:${row.id}:${timeZone}`,
        row,
        async () => parseMonth(await get('/api/usage/dashboard', monthQuery(now, timeZone))),
        MONTH_CACHE_MS,
      ),
    ),
  ]);
  // Dismissed in Fusebox's dashboard, a fault still holds; not read now, the poller's last faults stand in for them.
  const parsedFaults = mergeFaults(
    parseFuseboxFaults(faults ?? []),
    Array.isArray(dismissed)
      ? parseFuseboxFaults(dismissed)
      : ((await gatewayUsageOf(services.db, row.id).catch(() => null))?.faults ?? []),
  );
  const mapped = mapFuseboxAccounts(row.id, accounts, parsedFaults, now);
  // The same key as the mapped accounts', by Fusebox's id.
  const keys = new Map<string, string>();
  for (const raw of list(accounts)) {
    const id = str(rec(raw).id);
    if (id) keys.set(id, gatewayAccountKey(row.id, id));
  }
  return {
    readAt: now,
    overview: parseOverview(overview),
    accounts: mapped,
    others: mapFuseboxOtherSubscriptions(row.id, accounts, parsedFaults, now),
    signedIn: fuseboxSignedIn(row.id, accounts),
    more: parseAccountsMore(accounts, (id) => keys.get(id) ?? id),
    faults: parsedFaults,
    ids: keys,
    clients: clients ? parseClients(clients) : null,
    month,
    history: history ? parseHistory(history) : null,
  };
}

function loadFusebox(services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) {
  return async (): Promise<FuseboxSnapshot> => {
    try {
      return await withDeadline(
        readFusebox(services, row, now, timeZone),
        KIND_DEADLINE_MS,
        'Fusebox didn’t answer in time.',
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

/** Fusebox's read for its page: the last one when a new one is slow (page-speed.md PS-01). */
export function fuseboxLatest(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
  timeZone = 'UTC',
) {
  return latestRead(services, `fusebox:${row.id}`, row, loadFusebox(services, row, now, timeZone));
}

/** `/api/overview` alone, for the health pass (FP-S02): the version and the request counters. */
export function fuseboxOverview(services: Services, row: CatalogConnectionRow): Promise<FuseboxOverview> {
  return cachedRead(services, `fusebox-overview:${row.id}`, row, async () => {
    try {
      return parseOverview(
        await withDeadline(
          getJson(services, row, NAME, '/api/overview'),
          KIND_DEADLINE_MS,
          'Fusebox didn’t answer in time.',
        ),
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  });
}

/* Words ---------------------------------------------------------------------------------------------------------------- */

/** “$ 1,906”, “$ 91”, “$ 4.20”. */
export function usd(n: number): string {
  if (n >= 100) return `$ ${thousands(Math.round(n))}`;
  if (n >= 10) return `$ ${Math.round(n)}`;
  return `$ ${n.toFixed(2)}`;
}

/** “99.2 %”, “50 %”; a whole hundred is “100 %”. */
export function share(n: number): string {
  if (n >= 99.95) return '100 %';
  const r = Math.round(n * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)} %`;
}

/** How new sessions are routed (Fusebox `routing`, `session-affinity`). */
export function routingWords(routing: string | null, affinity: boolean | null): string | null {
  const how: Record<string, string> = {
    'least-used': 'Most left first',
    'smart-quota': 'Longest-lasting first',
    'round-robin': 'Taking turns',
    'fill-first': 'One until it’s full',
  };
  const words = routing ? how[routing] : null;
  if (!words) return null;
  return `${words}${affinity ? ' · sessions stay' : ''}`;
}

const ACCOUNT_STATUS: Record<
  GatewayAccountUsage['status'],
  { text: string; dot: 'ok' | 'warn' | 'bad' | 'off' }
> = {
  ok: { text: 'Working', dot: 'ok' },
  rate_limited: { text: 'Busy', dot: 'warn' },
  used_up: { text: 'Used up', dot: 'warn' },
  signin_expired: { text: 'Sign-in expired', dot: 'bad' },
  off: { text: 'Off in Fusebox', dot: 'off' },
};

/* What it shows -------------------------------------------------------------------------------------------------------- */

export interface FuseboxInput {
  snapshot: FuseboxSnapshot;
  /** The points over the page's range (pools, subscriptions, requests). */
  points: Map<string, RawPoint[]>;
  range: PageRange;
  now: Date;
  timeZone: string;
  switches: { claude: boolean; codex: boolean };
  /** Agent turns through it over the last 7 days, per tool (FP-S04). */
  turns: { claude: number; codex: number };
  /** Whombat's own named client in Fusebox (`fields.clientId`). */
  clientId: string | null;
  /** Fusebox's own dashboard. */
  url: string;
  /** The request counters over the last month (`req_ok`, `req_failed`), for the days; null when they can't be read. */
  requestDays: Map<string, RawPoint[]> | null;
}

/** A tool's own colour, as its figure's bar (Claude blue, Codex green); amber when its week runs out early. */
const TOOL_COLOR: Record<GatewayProvider, ThingSeriesColor> = { claude: 'blue', codex: 'green' };
const MEMBER_COLORS: readonly ThingSeriesColor[] = ['orange', 'green', 'violet', 'blue', 'grey'];

/** The points of the range on its grid, by key. */
function grid(points: Map<string, RawPoint[]>, keys: readonly string[], range: PageRange, now: Date) {
  const g = onRange(
    keys.map((k) => points.get(k) ?? []),
    range,
    now,
  );
  return { timestamps: g.timestamps, values: new Map(keys.map((k, i) => [k, g.values[i] ?? []])) };
}

/** A week's or five hours' chart: the pool and each subscription, the forecast when it runs out early (FP-06, FP-S03). */
function poolChart(input: FuseboxInput, pool: Pool, labelOf: (key: string) => string): ChartPanel | null {
  const { range, now, timeZone } = input;
  const own = poolKey(pool.tool, pool.window);
  const keys = [own, ...pool.members.map((m) => memberKey(m.key, pool.window))];
  const g = grid(input.points, keys, range, now);
  const values = g.values.get(own) ?? [];
  if (!drawable(values)) return null;
  const warn = !!pool.runsOut && pool.window === 'week';
  const many = pool.members.length > 1;
  const name = `${TOOL_NAME[pool.tool]} · ${pool.window === 'week' ? 'weekly limit' : '5 hours'}`;
  const stats: ThingLine[] = [];
  if (pool.runsOut) {
    stats.push(line(`At this pace **100 %** ${untilWords(roundHour(pool.runsOut.at), now, timeZone)}`));
    stats.push(line(`Resets **${untilWords(pool.runsOut.before, now, timeZone)}**`));
  } else if (pool.atFirstReset !== null && pool.firstReset) {
    stats.push(line(`At this pace **${pct(pool.atFirstReset)}** at the reset`));
    stats.push(line(`Resets **${untilWords(pool.firstReset, now, timeZone)}**`));
  } else stats.push(...avgPeakLines(seriesStats(values, g.timestamps), pctStat, now, timeZone));
  const ahead = pool.runsOut ? pool.runsOut.at.getTime() - now.getTime() : 0;
  const poolColor: ThingSeriesColor = warn ? 'amber' : TOOL_COLOR[pool.tool];
  const memberColors = MEMBER_COLORS.filter((c) => c !== poolColor);
  return {
    kind: 'chart',
    id: `${pool.tool}-${pool.window}`,
    place: 'chart',
    span: 2,
    title: name,
    timestamps: g.timestamps,
    series: [
      {
        key: 'pool',
        label: many ? 'Together' : labelOf(pool.members[0]?.key ?? ''),
        unit: '%',
        values,
        color: poolColor,
        fill: true,
        latest: pct(pool.used),
      },
      ...(many
        ? pool.members.slice(0, 5).map((m, i) => ({
            key: `m${i + 1}`,
            label: clip(labelOf(m.key), 40),
            unit: '%',
            values: g.values.get(memberKey(m.key, pool.window)) ?? [],
            color: memberColors[i] as ThingSeriesColor,
            latest: pct(m.used),
          }))
        : []),
    ],
    figure: {
      value: pct(pool.used),
      rest: many ? `of ${pool.members.length} subscriptions` : 'used',
      ...(warn ? { tone: 'warn' as const } : {}),
    },
    ...statsOf(stats),
    ...(many
      ? {
          foot: pool.members.slice(0, 4).map((m) => ({
            label: clip(labelOf(m.key), 30),
            value: pct(m.used),
            ...(m.used >= 80 ? { tone: 'warn' as const } : {}),
          })),
        }
      : {}),
    axis: { min: 0, max: 100, unit: '%' },
    ...(pool.runsOut && pool.window === 'week' && ahead > 0 && ahead <= RANGE_MS[range]
      ? {
          forecast: {
            at: roundHour(pool.runsOut.at).toISOString(),
            value: 100,
            label: `100 % ${untilWords(roundHour(pool.runsOut.at), now, timeZone)}`.slice(0, 40),
          },
        }
      : {}),
  };
}

/** How long one bar of the requests is, per range (the points' grid). */
const _STEP_WORDS: Record<PageRange, string> = {
  '1h': '5 min',
  '6h': '5 min',
  '24h': '15 min',
  '7d': '2 h',
  '30d': '6 h',
};

/** The requests that worked and failed over the last hour (failing requests, QN-S23), from Fusebox's counters. */
export function lastHour(points: Map<string, RawPoint[]>, now: Date): { ok: number; failed: number } {
  const r = requestLines({ points, range: '1h', now });
  return { ok: r.okSum, failed: r.failedSum };
}

/** The requests over the range: worked and failed per step, from Fusebox's counters (FP-03). */
export function requestLines(input: Pick<FuseboxInput, 'points' | 'range' | 'now'>) {
  const step = POINT_STEP_MS[input.range];
  const ok = counterSteps(input.points.get(REQ_OK_KEY) ?? [], input.range, input.now, step);
  const failed = counterSteps(input.points.get(REQ_FAILED_KEY) ?? [], input.range, input.now, step);
  const total = ok.values.map((v, i) =>
    v === null && failed.values[i] == null ? null : (v ?? 0) + (failed.values[i] ?? 0),
  );
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
  return {
    timestamps: ok.timestamps,
    ok: ok.values,
    failed: failed.values,
    total,
    okSum: sum(ok.values),
    failedSum: sum(failed.values),
  };
}

/** The Subscriptions table (FP-07). */
/** A subscription as the page lists it: one of the pools' (Claude, ChatGPT) or another tool's (Meta). */
interface Subscription {
  key: string;
  label: string;
  /** Fusebox's provider id (`claude`, `codex`, `meta`). */
  provider: string;
  plan: string | null;
  status: GatewayAccountUsage['status'];
  until: string | null;
  windows: GatewayAccountUsage['windows'];
  noFiveHourLimit: boolean;
}

/**
 * Every subscription Fusebox's dashboard lists: the Claude and ChatGPT ones, also one that is off and so has no
 * limits read, then the other tools' in Fusebox's order.
 */
export function subscriptionsOf(
  snapshot: Pick<FuseboxSnapshot, 'accounts' | 'others' | 'signedIn'>,
): Subscription[] {
  const pools = snapshot.accounts
    .filter((a) => isSubscription(a) || snapshot.signedIn.has(a.key))
    .map((a) => ({
      key: a.key,
      label: a.label,
      provider: a.provider as string,
      plan: a.planName ?? planWords(a.plan),
      status: a.status,
      until: a.until,
      windows: a.windows,
      noFiveHourLimit: !!a.noFiveHourLimit,
    }));
  return [...pools, ...snapshot.others];
}

const working = (a: Pick<Subscription, 'status'>) => a.status === 'ok' || a.status === 'rate_limited';

/**
 * When a subscription renews, as its row says it after the plan: “Renews 3 Dec”, “Renews tomorrow”, “Ends 3 Dec” once
 * cancelled, “Renews about 3 Dec” when Fusebox only counted on from a date that passed. A day set by hand holds until
 * it's over; nothing once the date has passed.
 */
export function renewsWords(r: FuseboxRenewal, now: Date, timeZone: string): string | null {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const today = day(now);
  if (r.day ? day(r.at) < today : r.at.getTime() <= now.getTime()) return null;
  const when =
    day(r.at) === today
      ? 'today'
      : day(r.at) === day(new Date(now.getTime() + DAY))
        ? 'tomorrow'
        : new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(r.at);
  if (r.ends) return `Ends ${when}`;
  return `Renews ${r.estimated ? 'about ' : ''}${when}`;
}

/**
 * The Subscriptions table's rows: each with its tool's mark for the screen, its plan and when it renews, its 5 hours
 * and week, and how it is.
 */
function subscriptionRows(input: FuseboxInput, subs: readonly Subscription[]): ThingPageRow[] {
  const { snapshot, now, timeZone } = input;
  return subs.map((a) => {
    const window = (kind: string) => a.windows.find((w) => w.kind === kind);
    const meter = (kind: string) => {
      if (kind === 'five_hour' && a.noFiveHourLimit) return { text: 'No limit', tone: 'muted' as const };
      const w = window(kind);
      if (!w || w.usedPct === null) return { text: '—', tone: 'muted' as const };
      return {
        text: pct(w.usedPct),
        mono: true,
        meter: Math.min(1, w.usedPct / 100),
        ...(w.usedPct >= 80 ? { tone: 'warn' as const } : {}),
      };
    };
    const week = window('seven_day');
    const status = ACCOUNT_STATUS[a.status];
    const until =
      a.until && (a.status === 'used_up' || a.status === 'rate_limited') ? new Date(a.until) : null;
    const more = snapshot.more.get(a.key);
    const last = more?.lastUsed ?? null;
    const renews = more?.renews ? renewsWords(more.renews, now, timeZone) : null;
    const tool = fuseboxToolName(a.provider);
    const mark = fuseboxProviderMark(a.provider);
    return {
      id: a.key,
      cells: {
        subscription: {
          text: clip(a.label, 200),
          note: clip([tool, a.plan, renews].filter(Boolean).join(' · '), 80),
          ...(mark ? { mark } : {}),
        },
        five: meter('five_hour'),
        week: meter('seven_day'),
        resets: week?.resetsAt
          ? { text: untilWords(new Date(week.resetsAt), now, timeZone), mono: true }
          : { text: '—', tone: 'muted' },
        status: {
          text: until ? `${status.text} until ${untilWords(until, now, timeZone)}` : status.text,
          dot: status.dot,
          ...(last ? { note: ago(last, now) } : {}),
        },
      },
    };
  });
}

/** The Clients table: every client this month by worth (below the slots when People can't hold them all). */
function clientRows(input: FuseboxInput): ThingPageRow[] {
  const { snapshot, now } = input;
  const month = snapshot.month;
  if (!month?.clients.length) return [];
  return [...month.clients]
    .sort(byWorth)
    .slice(0, CLIENTS_MAX)
    .map((c) => {
      const mine = !!input.clientId && c.id === input.clientId;
      const last = snapshot.clients?.lastUsed.get(c.id) ?? null;
      const on = snapshot.clients?.connected.has(c.id) ?? false;
      return {
        id: c.id,
        cells: {
          client: mine ? { text: 'This Whombat', note: clip(c.label, 80) } : { text: clip(c.label, 200) },
          requests: { text: thousands(c.requests), mono: true },
          worth: c.usd !== null ? { text: usd(c.usd), mono: true } : { text: '—', tone: 'muted' },
          used: on
            ? { text: last ? ago(last, now) : 'now', dot: 'ok' }
            : last
              ? { text: ago(last, now) }
              : { text: '—', tone: 'muted' },
        },
      };
    });
}

/** Who used a tool's week (FP-08): Fusebox's estimate per subscription, pooled like the use. */
export function whoUsed(snapshot: FuseboxSnapshot, pool: Pool, clientId: string | null): ThingPageBar[] {
  const total = pool.members.reduce((a, m) => a + m.weight, 0);
  if (!total) return [];
  const points = new Map<string, { label: string; points: number }>();
  let outside = 0;
  let any = false;
  for (const m of pool.members) {
    const s = snapshot.more.get(m.key)?.shares.find((x) => x.window === 'week');
    if (!s) continue;
    any = true;
    outside += (m.weight * s.outside) / total;
    for (const c of s.clients) {
      const was = points.get(c.id);
      points.set(c.id, { label: c.label, points: (was?.points ?? 0) + (m.weight * c.points) / total });
    }
  }
  if (!any) return [];
  const ranked = [...points.entries()]
    .sort((a, b) => b[1].points - a[1].points)
    .filter(([, v]) => v.points >= 0.5);
  const scale = Math.max(pool.used, ranked.reduce((a, [, v]) => a + v.points, 0) + outside, 1);
  const bars: ThingPageBar[] = ranked.slice(0, WHO_MAX).map(([id, v]) => ({
    id: clip(`client-${id}`, 200),
    label: clientId && id === clientId ? 'This Whombat' : clip(v.label, 80),
    ...(clientId && id === clientId ? { note: clip(v.label, 80) } : {}),
    value: pct(v.points),
    pct: Math.min(1, v.points / scale),
  }));
  if (outside >= 0.5)
    bars.push({
      id: 'outside',
      label: 'Outside Fusebox',
      note: pool.tool === 'claude' ? 'claude.ai, the app' : 'ChatGPT, the app',
      value: pct(outside),
      pct: Math.min(1, outside / scale),
    });
  return bars;
}

/** The tool's limits in Live, in this order: each tool's week, Claude's 5 hours while it has a pool (FP-15). */
const LIMITS: readonly [GatewayProvider, PoolWindow][] = [
  ['claude', 'week'],
  ['claude', '5h'],
  ['codex', 'week'],
];

/**
 * Limits now (Live): a row per pool, its bar the share used together, when it resets at the bar's end, or when it runs
 * out at this pace (its tag “Runs out early”), and “Used up” when it is. Rows rather than lines: the bar and the reset
 * are the point.
 */
export function fuseboxLimits(input: FuseboxInput, pools: readonly Pool[]): LivePanel | null {
  const { now, timeZone, snapshot } = input;
  const items: ThingGalleryItem[] = [];
  for (const [tool, window] of LIMITS) {
    const pool = poolFind(pools, tool, window);
    if (!pool) continue;
    const early = window === 'week' ? pool.runsOut : null;
    const full = pool.used >= 99.5;
    items.push({
      id: `${tool}-${window}`,
      title: `${TOOL_NAME[tool]} · ${window === 'week' ? 'week' : '5 hours'}`,
      sub: plural(pool.members.length, 'subscription'),
      progress: Math.min(1, Math.max(0, pool.used / 100)),
      note: `${pct(pool.used)} used`,
      ...(early
        ? { noteEnd: `out about ${untilWords(roundHour(early.at), now, timeZone)}` }
        : pool.firstReset
          ? { noteEnd: `resets ${untilWords(pool.firstReset, now, timeZone)}` }
          : window === '5h'
            ? { noteEnd: 'Not in use' }
            : {}),
      ...(full
        ? { badge: { text: 'Used up', tone: 'bad' as const } }
        : early
          ? { badge: { text: 'Runs out early', tone: 'warn' as const } }
          : {}),
    });
  }
  if (!items.length) return null;
  return liveRows({
    id: 'limits',
    title: 'Limits now',
    // Limits have no pictures: the row's square says the tool's first letter.
    shape: 'square',
    meta: fuseboxStatus(snapshot.accounts).badge,
    items,
  });
}

/** Clients by what their use is worth, then by requests. */
const byWorth = (a: FuseboxMonthClient, b: FuseboxMonthClient) =>
  (b.usd ?? 0) - (a.usd ?? 0) || b.requests - a.requests;

/**
 * The counters' growth per day (`2026-11-04` → requests), from the points the health pass keeps: a drop to under half
 * is a restart and counts again from the new count, as `counterSteps`. Pure.
 */
export function countsByDay(points: readonly RawPoint[], timeZone: string): Map<string, number> {
  const out = new Map<string, number>();
  let prev: number | null = null;
  for (const p of points) {
    if (p.value === null || !Number.isFinite(p.value)) continue;
    const grew = prev === null ? 0 : p.value >= prev ? p.value - prev : p.value < prev / 2 ? p.value : 0;
    prev = p.value;
    const day = dayKey(p.at, timeZone);
    out.set(day, (out.get(day) ?? 0) + grew);
  }
  return out;
}

/** Requests per day that worked and failed, from the counters read over the last weeks. */
function requestDays(input: FuseboxInput): { ok: Map<string, number>; failed: Map<string, number> } | null {
  const days = input.requestDays;
  if (!days) return null;
  const ok = countsByDay(days.get(REQ_OK_KEY) ?? [], input.timeZone);
  const failed = countsByDay(days.get(REQ_FAILED_KEY) ?? [], input.timeZone);
  return ok.size || failed.size ? { ok, failed } : null;
}

const sumOf = (m: ReadonlyMap<string, number>, keys: readonly string[]) =>
  keys.reduce((a, k) => a + (m.get(k) ?? 0), 0);

/**
 * Through Fusebox (Inventory): the subscriptions and whether they work, the API keys, the clients this month and how
 * many are connected now, the requests this month with this week's, and what this month's use is worth at API prices.
 */
export function fuseboxInventory(input: FuseboxInput): InventoryPanel | null {
  const { snapshot, now, timeZone, url } = input;
  const items: ThingPageItem[] = [];
  const subs = subscriptionsOf(snapshot);
  if (subs.length) {
    const on = subs.filter((a) => a.status !== 'off');
    const broken = on.filter((a) => !working(a)).length;
    const usedUp = on.filter((a) => a.status === 'used_up').length;
    items.push(
      countLine({
        id: 'subscriptions',
        title: 'Subscriptions',
        icon: 'key',
        value: thousands(subs.length),
        ...(subs.length > on.length ? { detail: `${subs.length - on.length} off in Fusebox` } : {}),
        ...(broken
          ? {
              note: usedUp === broken ? `${usedUp} used up` : `${broken} not working`,
              noteTone: usedUp === broken ? ('warn' as const) : ('bad' as const),
            }
          : { note: 'All working' }),
      }),
    );
  }
  const keys = snapshot.accounts.filter((a) => !isSubscription(a) && !snapshot.signedIn.has(a.key));
  if (keys.length) {
    const ids = new Set(keys.map((a) => a.key));
    const dry = snapshot.faults.filter(
      (f) => f.kind === 'credit' && f.accountId && ids.has(snapshot.ids.get(f.accountId) ?? ''),
    ).length;
    items.push(
      countLine({
        id: 'api-keys',
        title: 'API keys',
        icon: 'key',
        value: thousands(keys.length),
        ...(dry
          ? { note: `${dry} out of credit`, noteTone: 'warn' as const }
          : {
              note: keys.every(working)
                ? 'All working'
                : `${keys.filter((a) => !working(a)).length} not working`,
            }),
      }),
    );
  }
  const month = snapshot.month;
  if (month?.clients.length) {
    const connected = snapshot.clients?.connected.size ?? 0;
    items.push(
      countLine({
        id: 'clients',
        title: 'Clients',
        icon: 'device',
        value: thousands(month.clients.length),
        detail: 'Used it this month',
        ...(connected
          ? { note: `${connected} connected now`, noteTone: 'ok' as const }
          : { note: 'None connected now' }),
      }),
    );
  }
  const r = requestDays(input);
  const week = lastDays(now, timeZone).keys;
  if (r) {
    const first = `${dayKey(now, timeZone).slice(0, 8)}01`;
    const inMonth = (m: Map<string, number>) => [...m].reduce((a, [k, v]) => a + (k >= first ? v : 0), 0);
    const thisWeek = sumOf(r.ok, week) + sumOf(r.failed, week);
    items.push(
      countLine({
        id: 'requests',
        title: 'Requests this month',
        icon: 'network',
        value: thousands(Math.round(inMonth(r.ok) + inMonth(r.failed))),
        ...(thisWeek
          ? { note: `+${thousands(Math.round(thisWeek))} this week`, noteTone: 'ok' as const }
          : { note: 'None this week' }),
        url: `${url}/#/requests`,
      }),
    );
  } else if (snapshot.overview?.totals)
    items.push(
      countLine({
        id: 'requests',
        title: 'Requests',
        icon: 'network',
        value: thousands(snapshot.overview.totals.requests),
        note: 'since it started',
        url: `${url}/#/requests`,
      }),
    );
  if (month?.usd != null) {
    const days = new Set(week);
    const thisWeek = month.days.filter((d) => days.has(d.date)).reduce((a, d) => a + d.usd, 0);
    items.push(
      countLine({
        id: 'worth',
        title: 'Worth this month',
        icon: 'money',
        value: usd(month.usd),
        detail: 'At API prices',
        ...(thisWeek >= 0.005 ? { note: `+${usd(thisWeek)} this week`, noteTone: 'ok' as const } : {}),
        url: `${url}/#/usage`,
      }),
    );
  }
  return items.length ? inventory({ id: 'gateway', title: 'Through Fusebox', items }) : null;
}

/**
 * Requests this week (Trend): how many went through per day, from Fusebox's counters the health pass keeps, with how
 * many worked and the change on the week before once its days are known. Left out under two days.
 */
export function fuseboxWeek(input: FuseboxInput): TrendPanel | null {
  const r = requestDays(input);
  if (!r) return null;
  const { now, timeZone } = input;
  const days = lastDays(now, timeZone);
  const known = (k: string) => r.ok.has(k) || r.failed.has(k);
  const values = days.keys.map((k) =>
    known(k) ? Math.round((r.ok.get(k) ?? 0) + (r.failed.get(k) ?? 0)) : null,
  );
  if (daysWith(values) < 2) return null;
  const total = values.reduce<number>((a, v) => a + (v ?? 0), 0);
  const ok = sumOf(r.ok, days.keys);
  const before = lastDays(new Date(now.getTime() - 7 * DAY), timeZone).keys;
  const prior = sumOf(r.ok, before) + sumOf(r.failed, before);
  return trend({
    id: 'week',
    title: 'Requests this week',
    ...(total ? { meta: `${share((ok / total) * 100)} worked` } : {}),
    days,
    values,
    label: 'Requests',
    figure: { value: thousands(total), rest: 'requests this week' },
    change: before.every(known) ? weekChange(total, prior) : null,
    color: 'green',
  });
}

/** Who used it most (People): each client this month by what its use is worth, Whombat's own by its name. */
export function fuseboxPeople(input: FuseboxInput): PeoplePanel | null {
  const clients = [...(input.snapshot.month?.clients ?? [])].sort(byWorth);
  return people({
    title: 'Who used it most',
    meta: 'This month',
    items: clients.map((c) => {
      const mine = !!input.clientId && c.id === input.clientId;
      return {
        name: mine ? 'This Whombat' : c.label,
        ...(mine ? { note: c.label } : {}),
        n: c.usd ?? 0,
        // Worth beside the name, how many requests under its bar: both on one line squeezed the names.
        value: c.usd !== null ? usd(c.usd) : '—',
        sub: plural(c.requests, 'request'),
      };
    }),
  });
}

/** Fusebox's own lines in the machine card: its version, how it routes new sessions, its usage history, how long it is up. */
export function fuseboxMachineLines(snapshot: FuseboxSnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  const o = snapshot.overview;
  if (o?.version)
    out.push({
      id: 'fusebox-version',
      label: 'Fusebox',
      value: clip(o.build ?? o.version, 40),
      mono: true,
      pct: null,
    });
  const routing = routingWords(o?.routing ?? null, o?.affinity ?? null);
  if (routing) out.push({ id: 'routing', label: 'New sessions', value: clip(routing, 40), pct: null });
  if (snapshot.history) {
    const grow = snapshot.history.growthPerDay;
    out.push({
      id: 'history',
      label: 'Usage history',
      value: bytes(snapshot.history.bytes),
      pct: null,
      ...(grow && grow >= 1e6 ? { sub: `+ ${bytes(grow)} a day` } : {}),
    });
  }
  if (o?.models) out.push({ id: 'models', label: 'Models', value: String(o.models), pct: null });
  if (o?.uptimeS != null) out.push({ id: 'up', label: 'Up', value: span(o.uptimeS * 1000), pct: null });
  return out;
}

/**
 * Below the slots: each tool's week over the range with its forecast, the subscriptions one by one, who used each
 * tool's week, what Whombat uses it for, and every client when People can't hold them all.
 */
function fuseboxMore(
  input: FuseboxInput,
  pools: readonly Pool[],
  labelOf: (key: string) => string,
): ThingPagePanel[] {
  const { snapshot, now } = input;
  const accounts = snapshot.accounts;
  const panels: ThingPagePanel[] = [];
  for (const tool of POOL_TOOLS) {
    const pool = poolFind(pools, tool, 'week');
    const chart = pool ? poolChart(input, pool, labelOf) : null;
    if (chart) {
      const { place: _p, span: _s, ...rest } = chart;
      panels.push(rest);
    }
  }
  const all = subscriptionsOf(snapshot);
  const subs = subscriptionRows(input, all);
  if (subs.length) {
    const on = all.filter(working).length;
    panels.push({
      kind: 'table',
      id: 'subscriptions',
      title: 'Subscriptions',
      meta: on === all.length ? `All ${on} working` : `${on} of ${all.length} working`,
      columns: [
        { key: 'subscription', label: 'Subscription' },
        { key: 'five', label: '5 hours', numeric: true },
        { key: 'week', label: 'Week', numeric: true },
        { key: 'resets', label: 'Week resets' },
        { key: 'status', label: 'Status' },
      ],
      rows: subs,
    });
  }
  for (const tool of POOL_TOOLS) {
    const week = poolFind(pools, tool, 'week');
    const bars = week ? whoUsed(snapshot, week, input.clientId) : [];
    if (bars.length && week)
      panels.push({
        kind: 'bars',
        id: `who-${tool}`,
        title: `Who used ${TOOL_NAME[tool]} this week`,
        meta: `${pct(week.used)} used`,
        items: bars,
      });
  }
  const uses: ThingPageItem[] = [];
  const has = (tool: GatewayProvider) => accounts.some((a) => a.provider === tool);
  for (const tool of POOL_TOOLS)
    if (has(tool) || input.switches[tool])
      uses.push({
        id: tool,
        title: GATEWAY_TOOL_LABELS[tool],
        detail: `${plural(input.turns[tool], 'agent turn')} in 7 days`,
        right: input.switches[tool] ? 'On' : 'Off',
        tone: input.switches[tool] ? 'ok' : 'info',
      });
  if (input.clientId) {
    const last = snapshot.clients?.lastUsed.get(input.clientId) ?? null;
    uses.push({
      id: 'key',
      title: 'Its own key',
      detail: input.clientId,
      ...(last ? { right: `used ${ago(last, now)}` } : {}),
    });
  }
  if (uses.length)
    panels.push({
      kind: 'list',
      id: 'whombat',
      title: 'Whombat uses it for',
      link: { kind: 'tab', label: 'Settings', tab: 'settings' },
      items: uses,
    });
  // People shows the busiest eight: every client's use stays in reach below (FP-08).
  if ((snapshot.month?.clients.length ?? 0) > PEOPLE_MAX) {
    const rows = clientRows(input);
    panels.push({
      kind: 'table',
      id: 'clients',
      title: 'Every client',
      meta: 'This month',
      columns: [
        { key: 'client', label: 'Client' },
        { key: 'requests', label: 'Requests', numeric: true },
        { key: 'worth', label: 'Worth', numeric: true },
        { key: 'used', label: 'Last used' },
      ],
      rows,
    });
  }
  return panels;
}

/**
 * The page's Fusebox part (FP-04…FP-11), from what was read; pure. Its Summary is in slots
 * (docs/decisions/service-slots.md): the limits now beside what goes through it, the requests this week and who used
 * it most, its own lines in the machine card.
 */
export function fuseboxView(input: FuseboxInput): KindView {
  const { snapshot, now, timeZone } = input;
  const accounts = snapshot.accounts;
  const pools = poolsOf(accounts, now);
  const labels = new Map(accounts.map((a) => [a.key, a.label]));
  const labelOf = (key: string) => labels.get(key) ?? 'A subscription';

  const facts: ThingLine[] = [];
  const subs = subscriptionsOf(snapshot);
  const tools = [...new Set(subs.map((a) => a.provider))];
  const counts = tools.map((t) => `**${subs.filter((a) => a.provider === t).length} ${fuseboxToolName(t)}**`);
  if (counts.length)
    facts.push(
      line(
        `${counts.length > 1 ? `${counts.slice(0, -1).join(', ')} and ${counts[counts.length - 1]}` : counts[0]} ${subs.length === 1 ? 'subscription' : 'subscriptions'}`,
      ),
    );
  if (snapshot.overview?.version) facts.push(line(`Fusebox **${snapshot.overview.version}**`));
  if (snapshot.overview?.uptimeS != null)
    facts.push(line(`Up **${span(snapshot.overview.uptimeS * 1000)}**`));

  return {
    // In slots its figures are in Limits now and Through Fusebox; the card keeps its own (`fuseboxGlance`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: fuseboxNotices({
      accounts,
      pools,
      faults: snapshot.faults,
      ids: snapshot.ids,
      labels,
      lastHour: lastHour(input.points, now),
      switches: input.switches,
      url: input.url,
      now,
      timeZone,
    }),
    ...slotPanels({
      live: fuseboxLimits(input, pools),
      inventory: fuseboxInventory(input),
      trend: fuseboxWeek(input),
      people: fuseboxPeople(input),
      more: fuseboxMore(input, pools, labelOf),
      machine: fuseboxMachineLines(snapshot),
    }),
    tabs: [],
    facts,
    // Fine words only: what isn't fine is a line, and the head follows the lines that aren't ignored (QN-S23).
    status: fuseboxStatus(accounts),
    open: { label: 'Open Fusebox', url: input.url },
    actions: [],
    readAt: snapshot.readAt,
    suggestions: ['Claude use per day', 'Requests that failed', 'Worth per client'],
  };
}

/* The page ---------------------------------------------------------------------------------------------------------- */

/** Agent turns through the gateway over the last 7 days, per tool (FP-S04). */
async function turnsOf(services: Services, burrowId: string, now: Date) {
  const rows = await services.db
    .select({ provider: dispatches.gatewayProvider, n: count() })
    .from(dispatches)
    .where(
      and(eq(dispatches.burrowId, burrowId), gte(dispatches.createdAt, new Date(now.getTime() - 7 * DAY))),
    )
    .groupBy(dispatches.gatewayProvider);
  const out = { claude: 0, codex: 0 };
  for (const r of rows) if (r.provider === 'claude' || r.provider === 'codex') out[r.provider] = Number(r.n);
  return out;
}

/** Every point key the page draws for these accounts. */
function pointKeys(accounts: readonly GatewayAccountUsage[]): string[] {
  const keys = new Set<string>([REQ_OK_KEY, REQ_FAILED_KEY]);
  for (const tool of POOL_TOOLS) for (const w of ['week', '5h'] as PoolWindow[]) keys.add(poolKey(tool, w));
  for (const a of accounts) {
    keys.add(memberKey(a.key, 'week'));
    keys.add(memberKey(a.key, '5h'));
  }
  return [...keys];
}

/** Fusebox's address for “Open Fusebox”: its dashboard is at the root. */
export function fuseboxUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (row.fields.url ?? row.baseUrl).replace(/\/+$/, '');
}

export async function fuseboxPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = fuseboxUrl(row);
  const [read, stored, burrow] = await Promise.all([
    fuseboxLatest(services, row, now, ctx.timeZone),
    gatewayUsageOf(services.db, row.id).catch(() => null),
    services.db
      .select({ aiGateway: burrows.aiGateway })
      .from(burrows)
      .where(eq(burrows.id, ctx.burrowId))
      .then((r) => r[0] ?? null),
  ]);
  // Not answering now: the poller's last accounts still say how the subscriptions stood.
  const snapshot: FuseboxSnapshot | null = read.ok
    ? read.value
    : stored?.accounts.length
      ? {
          readAt: stored.observedAt ?? now,
          overview: null,
          accounts: stored.accounts,
          others: [],
          signedIn: new Set(),
          more: new Map(),
          faults: stored.faults,
          ids: new Map(
            stored.faults.flatMap((f) =>
              f.accountId ? [[f.accountId, gatewayAccountKey(row.id, f.accountId)] as const] : [],
            ),
          ),
          clients: null,
          month: null,
          history: null,
        }
      : null;
  const [points, requestDays, turns] = await Promise.all([
    readPoints(services.db, row.id, pointKeys(snapshot?.accounts ?? []), now, RANGE_MS[ctx.range]),
    // This month's and the last two weeks' days (the points reach 30 days back).
    readPoints(services.db, row.id, [REQ_OK_KEY, REQ_FAILED_KEY], now, 31 * DAY).catch(() => null),
    turnsOf(services, ctx.burrowId, now).catch(() => ({ claude: 0, codex: 0 })),
  ]);
  const problem = read.ok ? undefined : problemOf(read.error, NAME).message;
  if (!snapshot)
    return {
      notices: [],
      panels: [],
      tabs: [],
      facts: [],
      open: { label: 'Open Fusebox', url },
      actions: [],
      readAt: null,
      suggestions: [],
      ...(problem ? { problem } : {}),
      refreshing: read.refreshing,
    };
  const view = fuseboxView({
    snapshot,
    points,
    range: ctx.range,
    now,
    timeZone: ctx.timeZone,
    switches: switchesOf(burrow?.aiGateway ?? null, row.id),
    turns,
    clientId: str(row.fields.clientId),
    url,
    requestDays,
  });
  return { ...view, ...(problem ? { problem } : {}), refreshing: read.refreshing };
}

/** The gateway poller's read is recent enough to say a line is over (QN-S23): it answered within 15 minutes. */
const FRESH_MS = 15 * 60_000;

/**
 * The health pass's look (FP-02, FP-03, FP-S02, QN-S23): the card from the accounts the gateway poller kept and the
 * overview, the points, and Worth a look's lines as the page shows them.
 */
export async function fuseboxSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const [usage, overview, points, burrow] = await Promise.all([
    gatewayUsageOf(services.db, row.id),
    fuseboxOverview(services, row).catch(() => null),
    readPoints(services.db, row.id, [REQ_OK_KEY, REQ_FAILED_KEY], now, FAILING_WINDOW_MS + 15 * 60_000).catch(
      () => null,
    ),
    row.burrowId
      ? services.db
          .select({ aiGateway: burrows.aiGateway })
          .from(burrows)
          .where(eq(burrows.id, row.burrowId))
          .then((r) => r[0] ?? null)
          .catch(() => null)
      : null,
  ]);
  const accounts = usage?.accounts ?? [];
  const faults = usage?.faults ?? [];
  const notices = fuseboxNotices({
    accounts,
    pools: poolsOf(accounts, now),
    faults,
    ids: new Map(
      faults.flatMap((f) =>
        f.accountId ? [[f.accountId, gatewayAccountKey(row.id, f.accountId)] as const] : [],
      ),
    ),
    labels: new Map(accounts.map((a) => [a.key, a.label])),
    lastHour: points ? lastHour(points, now) : null,
    switches: switchesOf(burrow?.aiGateway ?? null, row.id),
    url: fuseboxUrl(row),
    now,
    timeZone,
  });
  const fresh =
    !!usage?.reachable && !!usage.observedAt && now.getTime() - usage.observedAt.getTime() <= FRESH_MS;
  return {
    glance: fuseboxGlance(accounts, overview?.version ?? null, now, timeZone, statusOf(notices)),
    points: fuseboxPoints(accounts, overview?.totals ?? null, now),
    notices,
    skipped: [...(fresh ? [] : FUSEBOX_ACCOUNT_CHECKS), ...(points ? [] : ['fusebox.failing'])],
  };
}
