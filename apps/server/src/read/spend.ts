/**
 * Spend (docs/decisions/spend.md SP-01, SP-02, SP-D01…): read-only views of what agents' turns used, from the usage
 * Whombat already stores per finished turn (`dispatches.usage`, as the provider reported it). Informational only: no
 * billing, no limits. Tokens count as billed (prompt-efficiency.md PE-04): the totals carry the cache split once a turn
 * reported one, core's `spendTokens` weighs cache reads at a tenth, and the plans' `usedTokens` are billed sums.
 *
 * The sums run in SQL over the `(burrow_id, finished_at)` index (SP-D02), the three windows as filtered aggregates
 * (SP-D04); core's `mergeTotals` folds the rows into totals, so the arithmetic lives in one place. The person sees every
 * turn and every plan by its title: there is no spend per person (one-person.md OP-11, OP-S73).
 */
import {
  dayKey,
  mergeTotals,
  SPEND_DAILY_DAYS,
  SPEND_PLANS_MAX,
  SPEND_WINDOW_DAYS,
  type SpendAgentWeek,
  type SpendDaily,
  type SpendDay,
  type SpendOverview,
  type SpendPlanRow,
  type SpendWindow,
  type SpendWindows,
} from '@whombat/core';
import { type SQL, sql } from 'drizzle-orm';
import type { BurrowRow } from '../commit/types';
import type { Db } from '../db/client';
import { type CountedTotals, sumCacheResults } from '../domain/cache-result';
import { billedTokensSum, hasCacheSplit, usageParts } from '../domain/turn-usage';
import { forbidden, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import type { Services } from '../services';
import { loadAgentRow, type PrincipalRow } from './principals';

const DAY_MS = 86_400_000;

/**
 * The first instant of `now`'s calendar day in the zone and of the next one, as core's `dayKey` counts days (so the
 * SQL window is exactly `spendWindowsOf`'s `today`). Days are 23 to 25 hours long and a zone change can skip one, so
 * 48 hours either side brackets both; a binary search to the millisecond finds them.
 */
export function zonedDayBounds(now: Date, timeZone: string): { start: Date; end: Date } {
  const key = dayKey(now, timeZone);
  const t = now.getTime();
  // The first instant in (lo, hi] where `reached` holds; it doesn't at lo and does at hi.
  const first = (lo: number, hi: number, reached: (at: number) => boolean) => {
    let a = lo;
    let b = hi;
    while (b - a > 1) {
      const mid = Math.floor((a + b) / 2);
      if (reached(mid)) b = mid;
      else a = mid;
    }
    return new Date(b);
  };
  return {
    start: first(t - 2 * DAY_MS, t, (at) => dayKey(at, timeZone) >= key),
    end: first(t, t + 2 * DAY_MS, (at) => dayKey(at, timeZone) > key),
  };
}

/**
 * The last `days` calendar days in the zone, oldest first, today last (box-status.md BS-07): each day's date and first
 * instant, and the end of today. Each day begins where the one before it ended, so the days tile the range exactly as
 * core's `dayKey` counts them (a day a zone change skipped isn't there).
 */
export function zonedDays(
  now: Date,
  timeZone: string,
  days: number,
): { days: { date: string; start: Date }[]; end: Date } {
  const today = zonedDayBounds(now, timeZone);
  const out = [{ date: dayKey(today.start, timeZone), start: today.start }];
  for (let start = today.start; out.length < days; ) {
    start = zonedDayBounds(new Date(start.getTime() - 1), timeZone).start;
    out.unshift({ date: dayKey(start, timeZone), start });
  }
  return { days: out, end: today.end };
}

/** The windows' bounds at `now` (SP-D01): `today` in the zone, then rolling 7 and 30 days by `finished_at`. */
function windowBounds(now: Date, timeZone: string) {
  const today = zonedDayBounds(now, timeZone);
  return {
    todayStart: iso(today.start),
    todayEnd: iso(today.end),
    weekStart: iso(new Date(now.getTime() - SPEND_WINDOW_DAYS.week * DAY_MS)),
    monthStart: iso(new Date(now.getTime() - SPEND_WINDOW_DAYS.month * DAY_MS)),
  };
}

/**
 * A turn that counts (SP-D03): finished, and it ran — a runner claimed it at least once, or it reported usage. A turn
 * cancelled or refused before any runner took it is not a turn.
 */
const RAN = sql`d.state in ('done', 'failed', 'cancelled') and d.finished_at is not null
  and (jsonb_typeof(d.usage) = 'object' or d.attempts > 0)`;
const REPORTED = sql`jsonb_typeof(d.usage) = 'object'`;
const COSTED = sql`jsonb_typeof(d.usage -> 'costUsd') = 'number'`;
const USAGE = usageParts(sql`d.usage`);
const SPLIT = hasCacheSplit(sql`d.usage`);
/** A resumed chat turn's prompt cache result (PE-12), as `finalize` stored it with the usage. */
const CACHE_RESULT = sql`d.usage ->> 'cacheResult'`;

/**
 * One window's totals as filtered aggregates, columns `<w>_turns`, `<w>_in`, `<w>_out`, `<w>_cread`, `<w>_cwrite`,
 * `<w>_split`, `<w>_cost`, `<w>_cost_turns`, `<w>_unreported`. A cost is rounded to micro-dollars per turn before it is
 * summed, which is what core's `addUsage` does turn by turn (SP-D01), so the SQL sum and the pure fold agree to the
 * micro-dollar. Cache reads and writes are clamped to each turn's input, as core's `billedTokens` does (PE-04).
 */
function totalsColumns(w: SpendWindow, inWindow: SQL): SQL {
  const col = (name: string) => sql.raw(`${w}_${name}`);
  return sql`count(*) filter (where ${inWindow})::int as ${col('turns')},
    coalesce(sum((d.usage ->> 'inputTokens')::bigint) filter (where ${inWindow} and ${REPORTED}), 0)::bigint as ${col('in')},
    coalesce(sum((d.usage ->> 'outputTokens')::bigint) filter (where ${inWindow} and ${REPORTED}), 0)::bigint as ${col('out')},
    coalesce(sum(${USAGE.read}) filter (where ${inWindow} and ${REPORTED}), 0)::bigint as ${col('cread')},
    coalesce(sum(${USAGE.write}) filter (where ${inWindow} and ${REPORTED}), 0)::bigint as ${col('cwrite')},
    count(*) filter (where ${inWindow} and ${REPORTED} and ${SPLIT})::int as ${col('split')},
    sum(round((d.usage ->> 'costUsd')::numeric, 6)) filter (where ${inWindow} and ${COSTED}) as ${col('cost')},
    count(*) filter (where ${inWindow} and ${COSTED})::int as ${col('cost_turns')},
    count(*) filter (where ${inWindow} and not coalesce(${REPORTED}, false))::int as ${col('unreported')},
    count(*) filter (where ${inWindow} and ${CACHE_RESULT} = 'hit')::int as ${col('cache_hit')},
    count(*) filter (where ${inWindow} and ${CACHE_RESULT} = 'expired')::int as ${col('cache_expired')},
    count(*) filter (where ${inWindow} and ${CACHE_RESULT} = 'miss')::int as ${col('cache_miss')}`;
}

type Num = number | string | null;
type TotalsRow = Record<string, Num>;

/**
 * Core totals from one window's columns; `mergeTotals` rounds the cost to micro-dollars like `addUsage`. The cache split
 * only once a turn in the window reported one, as `addUsage` adds it (contracts 0.44.1). The resumed turns' prompt cache
 * results (`cacheResults`: hits, expired caches, misses; PE-12) only once a turn in the window had one — the server's own
 * addition beside the contract's totals, which clients that don't know it leave out.
 */
function totalsOf(row: TotalsRow, w: SpendWindow): CountedTotals {
  const n = (name: string) => Number(row[`${w}_${name}`] ?? 0);
  const costTurns = n('cost_turns');
  const cost = row[`${w}_cost`];
  const cacheResults = { hit: n('cache_hit'), expired: n('cache_expired'), miss: n('cache_miss') };
  return {
    ...mergeTotals({
      turns: n('turns'),
      inputTokens: n('in'),
      outputTokens: n('out'),
      ...(n('split') > 0 ? { cacheReadTokens: n('cread'), cacheWriteTokens: n('cwrite') } : {}),
      costUsd: costTurns > 0 && cost !== null && cost !== undefined ? Number(cost) : null,
      costTurns,
      unreportedTurns: n('unreported'),
    }),
    ...(cacheResults.hit + cacheResults.expired + cacheResults.miss > 0 ? { cacheResults } : {}),
  };
}

/** Totals added up, their prompt cache results too (PE-12). */
function mergeCounted(all: readonly CountedTotals[]): CountedTotals {
  return { ...mergeTotals(...all), ...sumCacheResults(all) };
}

function windowsOf(row: TotalsRow): SpendWindows {
  return { today: totalsOf(row, 'today'), week: totalsOf(row, 'week'), month: totalsOf(row, 'month') };
}

function mergeWindows(all: readonly SpendWindows[]): SpendWindows {
  return {
    today: mergeCounted(all.map((w) => w.today)),
    week: mergeCounted(all.map((w) => w.week)),
    month: mergeCounted(all.map((w) => w.month)),
  };
}

/** Spend is for the person: an agent (or a principal of another burrow) never reads it. */
function mayRead(viewer: PrincipalRow, burrowId: string): void {
  if (viewer.kind !== 'person' || viewer.burrowId !== burrowId)
    throw forbidden('Only you can see what agents used.');
}

/** Turns, tokens and cost per agent, each window a set of filtered aggregates (one scan of 30 days). */
async function groupedTotals(db: Db, burrowId: string, now: Date, timeZone: string) {
  const b = windowBounds(now, timeZone);
  const rows = await db.execute<{ agent_id: string } & TotalsRow>(sql`
    select d.agent_id,
      ${totalsColumns('today', sql`d.finished_at >= ${b.todayStart}::timestamptz and d.finished_at < ${b.todayEnd}::timestamptz`)},
      ${totalsColumns('week', sql`d.finished_at > ${b.weekStart}::timestamptz`)},
      ${totalsColumns('month', sql`true`)}
    from dispatches d
    where d.burrow_id = ${burrowId} and d.finished_at > ${b.monthStart}::timestamptz and ${RAN}
    group by d.agent_id`);
  return [...rows].map((r) => ({ agentId: r.agent_id, windows: windowsOf(r) }));
}

/**
 * The plans whose turns (`dispatches.plan_id`) used the most in 30 days (SP-D06), without a budget (one-agent.md OA-06:
 * no handoffs).
 */
async function topPlans(services: Services, burrowId: string, now: Date) {
  const db = services.db;
  const monthStart = iso(new Date(now.getTime() - SPEND_WINDOW_DAYS.month * DAY_MS));
  const rows = await db.execute<{ id: string; title: string; used: string | number; turns: number }>(sql`
    select pl.id, pl.title, ${billedTokensSum(sql`d.usage`)} as used, count(*)::int as turns
    from dispatches d
    join plans pl on pl.id = d.plan_id and pl.burrow_id = d.burrow_id
    where d.burrow_id = ${burrowId} and d.finished_at > ${monthStart}::timestamptz and d.plan_id is not null
      and ${RAN}
    group by pl.id
    order by used desc, turns desc, pl.id
    limit ${SPEND_PLANS_MAX}`);
  return [...rows].map((r): SpendPlanRow => ({ planId: r.id, title: r.title, usedTokens: Number(r.used) }));
}

/** `spend.overview` (SP-01): the burrow's turns and plans. */
export async function spendOverview(
  services: Services,
  viewer: PrincipalRow,
  burrow: Pick<BurrowRow, 'id' | 'timeZone'>,
): Promise<SpendOverview> {
  const db = services.db;
  const now = services.clock();
  mayRead(viewer, burrow.id);
  const [groups, planRows] = await Promise.all([
    groupedTotals(db, burrow.id, now, burrow.timeZone),
    topPlans(services, burrow.id, now),
  ]);
  return {
    generatedAt: iso(now),
    timeZone: burrow.timeZone,
    totals: mergeWindows(groups.map((g) => g.windows)),
    plans: planRows,
  };
}

/** `spend.week` (SP-02, one-agent.md OA-19): the agent's last 7 days for Settings → Agent. */
export async function spendAgentWeek(
  services: Services,
  viewer: PrincipalRow,
  burrow: Pick<BurrowRow, 'id' | 'timeZone'>,
): Promise<SpendAgentWeek> {
  const db = services.db;
  mayRead(viewer, burrow.id);
  // The agent's week (one-agent.md OA-19).
  const agent = await loadAgentRow(db, burrow.id);
  if (!agent) throw notFound('Agent');
  const now = services.clock();
  const weekStart = iso(new Date(now.getTime() - SPEND_WINDOW_DAYS.week * DAY_MS));
  const [row] = await db.execute<TotalsRow>(sql`
    select ${totalsColumns('week', sql`true`)}
    from dispatches d
    where d.burrow_id = ${burrow.id} and d.agent_id = ${agent.id}
      and d.finished_at > ${weekStart}::timestamptz and ${RAN}`);
  return { week: totalsOf(row ?? {}, 'week') };
}

/** A day's sums as the grouped query returns them: its bucket (1 = the oldest day) and the columns. */
export type SpendDayRow = {
  bucket: number;
  turns: Num;
  input: Num;
  output: Num;
  cread: Num;
  cwrite: Num;
};

/** Every day of `days`, zeros on a quiet one (BS-07), from the rows of the days that had turns. */
export function spendDaysOf(days: readonly { date: string }[], rows: readonly SpendDayRow[]): SpendDay[] {
  const byBucket = new Map(rows.map((r) => [Number(r.bucket), r]));
  return days.map((d, i) => {
    const r = byBucket.get(i + 1);
    return {
      date: d.date,
      turns: Number(r?.turns ?? 0),
      inputTokens: Number(r?.input ?? 0),
      outputTokens: Number(r?.output ?? 0),
      cacheReadTokens: Number(r?.cread ?? 0),
      cacheWriteTokens: Number(r?.cwrite ?? 0),
    };
  });
}

/**
 * `spend.daily` (box-status.md BS-07): turns and tokens per calendar day in the burrow's zone for the last
 * `SPEND_DAILY_DAYS` days by `finished_at`. One grouped query over the
 * `(burrow_id, finished_at)` index; the day of a turn is the bucket of its `finished_at` among the days' first
 * instants, so a day here is the day `spend.overview` calls today.
 */
export async function spendDaily(
  services: Services,
  viewer: PrincipalRow,
  burrow: Pick<BurrowRow, 'id' | 'timeZone'>,
): Promise<SpendDaily> {
  const now = services.clock();
  mayRead(viewer, burrow.id);
  const range = zonedDays(now, burrow.timeZone, SPEND_DAILY_DAYS);
  const first = range.days[0]?.start ?? now;
  const starts = sql.join(
    range.days.map((d) => sql`${iso(d.start)}::timestamptz`),
    sql`, `,
  );
  const rows = await services.db.execute<SpendDayRow>(sql`
    select width_bucket(d.finished_at, array[${starts}]) as bucket, count(*)::int as turns,
      coalesce(sum(${USAGE.input}) filter (where ${REPORTED}), 0)::bigint as input,
      coalesce(sum(${USAGE.output}) filter (where ${REPORTED}), 0)::bigint as output,
      coalesce(sum(${USAGE.read}) filter (where ${REPORTED}), 0)::bigint as cread,
      coalesce(sum(${USAGE.write}) filter (where ${REPORTED}), 0)::bigint as cwrite
    from dispatches d
    where d.burrow_id = ${burrow.id} and d.finished_at >= ${iso(first)}::timestamptz
      and d.finished_at < ${iso(range.end)}::timestamptz and ${RAN}
    group by bucket`);
  return {
    generatedAt: iso(now),
    timeZone: burrow.timeZone,
    days: spendDaysOf(range.days, [...rows]),
  };
}
