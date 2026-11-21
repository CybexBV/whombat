/**
 * Fusebox's pool, the pure part (fusebox-page.md FP-02…FP-05): each tool's subscriptions together per window, the way
 * Fusebox 0.8's own dashboard adds them up (`pools.rs`, ported so any Fusebox that lists its accounts gets it) — weighted
 * by plan for Claude, the pace from how far each subscription's own window has gone, and whether, at that pace, the pool
 * is empty before a renewal brings room back, and when. Also the page's status, the card's glance and the points the
 * health pass keeps. No I/O.
 */
import {
  GATEWAY_ACCOUNT_PROVIDER_LABELS,
  type GatewayAccountUsage,
  type GatewayProvider,
  type ThingStatus,
  type UsageWindowKind,
} from '@whombat/core';
import type { ConnectionGlance } from '../../home/types';
import { pct } from '../words';

const H = 3600_000;
const DAY = 24 * H;

export type PoolWindow = 'week' | '5h';
export const POOL_TOOLS: readonly GatewayProvider[] = ['claude', 'codex'];

const WINDOW_KIND: Record<PoolWindow, UsageWindowKind> = { week: 'seven_day', '5h': 'five_hour' };
const WINDOW_MS: Record<PoolWindow, number> = { week: 7 * DAY, '5h': 5 * H };

/** The tool's subscriptions as people name them: “Claude”, “ChatGPT” (the contracts' words, CT-1450). */
export const TOOL_NAME: Readonly<Record<GatewayProvider, string>> = GATEWAY_ACCOUNT_PROVIDER_LABELS;

/**
 * A Claude plan's weight in its pool (Fusebox `plan_weight`): its weekly allowance, Pro 1, Max 5, Ultra 10 (still
 * `max_5x` and `max_20x`, perhaps `ultra` one day); null when unknown (then all count the same).
 */
export function planWeight(provider: GatewayProvider, plan: string | null): number | null {
  if (provider !== 'claude' || !plan) return null;
  return ({ pro: 1, max_5x: 5, max_20x: 10, ultra: 10 } as Record<string, number>)[plan] ?? null;
}

/**
 * Whether a subscription without a 5-hour limit (Claude Ultra, ChatGPT Pro) takes what its tool's others can't
 * (Fusebox 0.12 `pools.rs`): on, signed in, not paused as a whole (one model's pause leaves it the others), its week
 * not used up. While one does, the tool has no 5-hour pool; otherwise the pool is the subscriptions that have the limit.
 */
export function carriesFiveHours(a: GatewayAccountUsage): boolean {
  if (!a.noFiveHourLimit || a.paused || a.status === 'off' || a.status === 'signin_expired') return false;
  const week = a.windows.find((w) => w.kind === 'seven_day');
  return !(week?.usedPct != null && week.usedPct >= 100);
}

/** Whether an account is one of the pool's subscriptions (Fusebox lists API-key accounts too: no windows, no plan). */
export function isSubscription(a: GatewayAccountUsage): boolean {
  return a.windows.length > 0 || !!a.plan;
}

/** One subscription in a pool. */
export interface PoolMember {
  key: string;
  label: string;
  used: number;
  resetsAt: Date | null;
  weight: number;
}

export interface Pool {
  tool: GatewayProvider;
  window: PoolWindow;
  /** Weighted use, 0…100. */
  used: number;
  members: PoolMember[];
  /** How far through their windows the members are together, 0…1; null when a window in use has no reset. */
  pace: number | null;
  /** The first renewal ahead. */
  firstReset: Date | null;
  /** At this pace the pool is empty at `at`, before the renewal `before` brings room back. */
  runsOut: { at: Date; before: Date } | null;
  /** Where the use would be at the first renewal at this pace (when it doesn't run out), 0…100. */
  atFirstReset: number | null;
}

/** How far through a window that resets at `resetsAt` it is, 0…1 (Fusebox `gone`); null when it says nothing. */
function gone(resetsAt: Date | null, lengthMs: number, now: Date): number | null {
  if (!resetsAt) return null;
  const left = resetsAt.getTime() - now.getTime();
  return left >= 0 && left <= lengthMs ? 1 - left / lengthMs : null;
}

interface Stock {
  weight: number;
  left: number;
  renews: Date | null;
}

/**
 * The renewal before which use at `rate` (weighted points a millisecond) empties the pool, and the moment it is empty
 * (Fusebox `run_out`): use goes to the member that renews first, what a member has left when it renews is lost, each
 * renews once.
 */
export function runOut(
  stockIn: readonly Stock[],
  rate: number,
  now: Date,
): { at: Date; before: Date } | null {
  if (!(rate > 0)) return null;
  const stock = stockIn
    .map((s) => ({ ...s }))
    .sort((a, b) =>
      a.renews === null
        ? b.renews === null
          ? 0
          : 1
        : b.renews === null
          ? -1
          : a.renews.getTime() - b.renews.getTime(),
    );
  let at = now.getTime();
  for (let i = 0; i < stock.length; i++) {
    const renews = (stock[i] as Stock).renews;
    if (!renews) break;
    const available = stock.reduce((sum, s) => sum + s.left, 0);
    let need = rate * (renews.getTime() - at);
    if (need > available + 1e-9) return { at: new Date(at + available / rate), before: renews };
    const order = [...stock.keys()].slice(i).concat([...stock.keys()].slice(0, i));
    for (const j of order) {
      const s = stock[j] as Stock;
      const take = Math.min(need, s.left);
      s.left -= take;
      need -= take;
    }
    (stock[i] as Stock).left = 100 * (stock[i] as Stock).weight;
    at = renews.getTime();
  }
  return null;
}

/**
 * One tool's subscriptions together for one window (Fusebox `pool`): the enabled ones that report it; null when none
 * does, or for 5 hours while a subscription without that limit carries the others. It runs out early only with at
 * least a quarter of the window gone and 20–100 % used, as Fusebox warns.
 */
export function poolOf(
  accounts: readonly GatewayAccountUsage[],
  tool: GatewayProvider,
  window: PoolWindow,
  now: Date,
): Pool | null {
  const reports = accounts
    .filter((a) => a.provider === tool && a.status !== 'off')
    .map((a) => ({ a, w: a.windows.find((w) => w.kind === WINDOW_KIND[window] && w.usedPct !== null) }))
    .filter((r): r is { a: GatewayAccountUsage; w: NonNullable<typeof r.w> } => !!r.w);
  if (!reports.length) return null;
  if (window === '5h' && accounts.some((a) => a.provider === tool && carriesFiveHours(a))) return null;
  const weights = reports.map((r) => planWeight(tool, r.a.plan));
  const priced = weights.every((w) => w !== null);
  const lengthMs = WINDOW_MS[window];
  let total = 0;
  let used = 0;
  let elapsed = 0;
  let paced = true;
  const members: PoolMember[] = [];
  const stock: Stock[] = [];
  reports.forEach((r, i) => {
    const k = priced ? (weights[i] as number) : 1;
    const u = Math.min(100, Math.max(0, r.w.usedPct as number));
    const resetsAt = r.w.resetsAt ? new Date(r.w.resetsAt) : null;
    total += k;
    used += k * u;
    const g = gone(resetsAt, lengthMs, now) ?? (u === 0 ? 0 : null);
    if (g === null) paced = false;
    else elapsed += k * g;
    members.push({ key: r.a.key, label: r.a.label, used: u, resetsAt, weight: k });
    stock.push({ weight: k, left: k * (100 - u), renews: resetsAt });
  });
  const pooled = used / total;
  const pace = paced ? elapsed / total : null;
  const resets = members.map((m) => m.resetsAt).filter((d): d is Date => d !== null && d > now);
  const firstReset = resets.length ? new Date(Math.min(...resets.map((d) => d.getTime()))) : null;
  let runs: Pool['runsOut'] = null;
  let atFirstReset: number | null = null;
  if (pace !== null && pace >= 0.25 && pooled < 100) {
    // Weighted points a millisecond: the use so far over the time it took.
    const rate = (total * pooled) / (pace * lengthMs);
    if (pooled >= 20) runs = runOut(stock, rate, now);
    if (!runs && firstReset)
      atFirstReset = Math.min(100, pooled + (rate / total) * (firstReset.getTime() - now.getTime()));
  }
  return { tool, window, used: pooled, members, pace, firstReset, runsOut: runs, atFirstReset };
}

/** Every tool's pools for both windows, the tools Fusebox has subscriptions of. */
export function poolsOf(accounts: readonly GatewayAccountUsage[], now: Date): Pool[] {
  const out: Pool[] = [];
  for (const tool of POOL_TOOLS)
    for (const w of ['week', '5h'] as const) {
      const p = poolOf(accounts, tool, w, now);
      if (p) out.push(p);
    }
  return out;
}

export const poolFind = (pools: readonly Pool[], tool: GatewayProvider, window: PoolWindow) =>
  pools.find((p) => p.tool === tool && p.window === window) ?? null;

/* Points (FP-03) -------------------------------------------------------------------------------------------------- */

export const REQ_OK_KEY = 'req_ok';
export const REQ_FAILED_KEY = 'req_failed';

/** A pool's point key: `claude_week`, `codex_5h`. */
export const poolKey = (tool: GatewayProvider, window: PoolWindow) => `${tool}_${window}`;

/** A subscription's point key for a window: `fw_<8 hex>` (week), `fh_<8 hex>` (5 hours) of its account key. */
export function memberKey(accountKey: string, window: PoolWindow): string {
  const hex = accountKey.replace(/^gwa_/, '').slice(0, 8);
  return `${window === 'week' ? 'fw' : 'fh'}_${hex}`;
}

/** What Fusebox has counted since it started (`/api/overview` `totals`). */
export interface FuseboxTotals {
  requests: number;
  ok: number;
  failed: number;
}

/** The points the health pass keeps (FP-03): pools, each subscription's windows, the request counters. */
export function fuseboxPoints(
  accounts: readonly GatewayAccountUsage[],
  totals: FuseboxTotals | null,
  now: Date,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const p of poolsOf(accounts, now)) out[poolKey(p.tool, p.window)] = Math.round(p.used * 10) / 10;
  // Each subscription's own, also while its tool has no 5-hour pool, so its chart has no gap when the pool returns.
  for (const a of accounts) {
    if (a.status === 'off') continue;
    for (const window of ['week', '5h'] as const) {
      const used = a.windows.find((w) => w.kind === WINDOW_KIND[window])?.usedPct;
      if (used != null)
        out[memberKey(a.key, window)] = Math.round(Math.min(100, Math.max(0, used)) * 10) / 10;
    }
  }
  if (totals) {
    out[REQ_OK_KEY] = totals.ok;
    out[REQ_FAILED_KEY] = totals.failed;
  }
  return out;
}

/* Status and glance (FP-02, FP-05) -------------------------------------------------------------------------------- */

/** “14:20” today, “tomorrow 09:00”, “Thu 09:00” within the week, “28 Oct” later; in the burrow's zone. */
export function untilWords(at: Date, now: Date, timeZone: string): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  if (day(at) === day(now)) return time;
  if (day(at) === day(new Date(now.getTime() + DAY))) return `tomorrow ${time}`;
  if (at.getTime() - now.getTime() < 6 * DAY) {
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(at);
    return `${weekday} ${time}`;
  }
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(at);
}

/** A moment rounded to the hour, for a forecast (“Wed around 15:00”). */
export function roundHour(at: Date): Date {
  return new Date(Math.round(at.getTime() / H) * H);
}

/** The tools whose every enabled subscription is used up, each with the earliest `until`. */
export function usedUpTools(
  accounts: readonly GatewayAccountUsage[],
): { tool: GatewayProvider; until: Date | null }[] {
  const out: { tool: GatewayProvider; until: Date | null }[] = [];
  for (const tool of POOL_TOOLS) {
    const on = accounts.filter((a) => a.provider === tool && a.status !== 'off' && isSubscription(a));
    if (!on.length || !on.every((a) => a.status === 'used_up')) continue;
    const untils = on.map((a) => (a.until ? Date.parse(a.until) : Number.NaN)).filter(Number.isFinite);
    out.push({ tool, until: untils.length ? new Date(Math.min(...untils)) : null });
  }
  return out;
}

/**
 * The head's words while it is fine (FP-05, quiet-notices.md QN-S23): how many subscriptions work. What isn't fine is a
 * line of Worth a look (`fusebox-lines.ts`), and the head's status and badge come from those that aren't ignored.
 */
export function fuseboxStatus(accounts: readonly GatewayAccountUsage[]): {
  status: Extract<ThingStatus, 'ok'>;
  badge: string;
} {
  const subs = accounts.filter(isSubscription);
  const on = subs.filter((a) => a.status !== 'off');
  if (!on.length)
    return { status: 'ok', badge: subs.length ? 'Every subscription is off' : 'No subscriptions' };
  const working = on.filter((a) => a.status === 'ok' || a.status === 'rate_limited').length;
  if (working === on.length)
    return {
      status: 'ok',
      badge: on.length === 1 ? '1 subscription working' : `All ${on.length} subscriptions working`,
    };
  return { status: 'ok', badge: `${working} of ${on.length} subscriptions working` };
}

/** The worst line that isn't a heads-up, for the card's dot and reason (QN-02). */
export interface GlanceStatus {
  status: 'ok' | 'warn' | 'bad';
  reason?: string;
}

/**
 * The card and the sidebar (FP-02): the version, each tool's week, how many subscriptions work; the dot and the reason
 * from Worth a look's lines (`fuseboxSeen` gives them; fine without).
 */
export function fuseboxGlance(
  accounts: readonly GatewayAccountUsage[],
  version: string | null,
  now: Date,
  _timeZone: string,
  status: GlanceStatus = { status: 'ok' },
): Omit<ConnectionGlance, 'status'> & { status: 'ok' | 'warn' | 'bad' } {
  const pools = poolsOf(accounts, now);
  const facts: ConnectionGlance['facts'] = [];
  for (const tool of POOL_TOOLS) {
    const week = poolFind(pools, tool, 'week');
    if (week) facts.push({ label: `${TOOL_NAME[tool]} week`, value: pct(week.used) });
  }
  const on = accounts.filter((a) => isSubscription(a) && a.status !== 'off');
  if (on.length)
    facts.push({
      label: 'Subscriptions',
      value: `${on.filter((a) => a.status === 'ok' || a.status === 'rate_limited').length} of ${on.length}`,
      note: 'working',
    });
  return {
    status: status.status,
    line: version ? `AI gateway · Fusebox ${version}` : 'AI gateway',
    facts: facts.slice(0, 3),
    ...(status.status !== 'ok' && status.reason ? { reason: status.reason } : {}),
  };
}
