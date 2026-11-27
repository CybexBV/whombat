/**
 * What the agent's turns used (Whombat spend.md SP-01, SP-D01): a read-only view over the usage Whombat already stores per
 * finished turn (`dispatches.usage`: `{inputTokens, outputTokens, costUsd?}` as the provider reported it).
 * Informational only: no billing and no limits. Costs are the providers' own estimates, summed over the turns that
 * reported one. Since 0.44.1 (Whombat prompt-efficiency.md PE-04) tokens are counted as they are billed
 * (`billedTokens`): a prompt-cache read counts a tenth.
 */
import { z } from 'zod';
import { isEnglishLocale, tCore } from '../i18n/catalog.js';
import { formatLocaleCurrency, formatLocaleNumber } from '../i18n/format.js';
import { PlanId } from '../ids.js';
import { type DateInput, dayKey, toDate } from '../text/time.js';
import { Count, IsoDate, Timestamp } from './common.js';

/* Usage and totals (SP-D01) --------------------------------------------------------------------- */

/**
 * How a turn's input splits over the provider's prompt cache, and the context it reached (Whombat prompt-efficiency.md
 * PE-04, 0.44.1), beside a total `inputTokens`. Optional: a provider that reports only the totals.
 */
export const UsageCacheFields = {
  /**
   * Of `inputTokens`, the tokens read from the prompt cache, over all the turn's model calls (Claude
   * `cache_read_input_tokens`, Codex `cached_input_tokens`).
   */
  cacheReadTokens: Count.optional(),
  /** Of `inputTokens`, the tokens written to the prompt cache (Claude `cache_creation_input_tokens`; Codex: 0). */
  cacheWriteTokens: Count.optional(),
  /**
   * The input of the turn's largest model call, uncached, cache reads and cache writes together: the context the
   * provider session reached (`usageContextTokens`).
   */
  largestCallInputTokens: Count.optional(),
};

/**
 * One finished turn's usage as the runner reported it (`CompleteBody.usage`). `inputTokens` is every input token of the
 * turn's model calls: uncached, read from the prompt cache and written to it. Since 0.44.1 the cache split and the
 * largest call ride along (`UsageCacheFields`).
 */
export const SpendUsage = z.object({
  inputTokens: Count,
  outputTokens: Count,
  costUsd: z.number().nonnegative().optional(),
  ...UsageCacheFields,
});
export type SpendUsage = z.infer<typeof SpendUsage>;

/** What a token read from the prompt cache counts for (PE-04): providers bill a cache read at a tenth of an input token. */
export const CACHE_READ_WEIGHT = 0.1;

/**
 * Tokens as they are billed (PE-04, 0.44.1): uncached input, cache writes and output in full, cache reads at a tenth
 * (rounded). Spend and handoff budgets count this. Without a cache split it is input plus output.
 * Cache reads are clamped to `inputTokens`, of which they are a part.
 */
export function billedTokens(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  /** Part of `inputTokens` and counted in full with it. */
  cacheWriteTokens?: number | undefined;
}): number {
  const read = Math.min(Math.max(0, usage.cacheReadTokens ?? 0), usage.inputTokens);
  return usage.inputTokens - read + Math.round(read * CACHE_READ_WEIGHT) + usage.outputTokens;
}

/**
 * The context a turn reached (PE-04, 0.44.1): its largest model call's input; without it, `inputTokens` (more than the
 * context when the turn made several calls). Whombat retires a
 * provider session and nudges the agent to save a checkpoint on this, not on the sum.
 */
export function usageContextTokens(usage: {
  inputTokens: number;
  largestCallInputTokens?: number | undefined;
}): number {
  return usage.largestCallInputTokens ?? usage.inputTokens;
}

/** Turns and what they used in one window. */
export const SpendTotals = z.object({
  /** Finished turns in the window, with or without usage. */
  turns: Count,
  /** Every input token, cached or not. */
  inputTokens: Count,
  outputTokens: Count,
  /**
   * Of `inputTokens`, read from the prompt cache (0.44.1, PE-04). Absent when no turn in the window reported the split.
   */
  cacheReadTokens: Count.optional(),
  /** Of `inputTokens`, written to the prompt cache (0.44.1); absent like `cacheReadTokens`. */
  cacheWriteTokens: Count.optional(),
  /** Summed over the turns that reported a cost (an estimate); null when none did. */
  costUsd: z.number().nonnegative().nullable(),
  /** Turns that reported a cost. */
  costTurns: Count,
  /** Turns that reported no usage at all (counted as 0 tokens). */
  unreportedTurns: Count,
});
export type SpendTotals = z.infer<typeof SpendTotals>;

/** Today (the burrow's time zone), the last 7 days and the last 30 days, each counted by the turn's `finished_at`. */
export const SpendWindows = z.object({ today: SpendTotals, week: SpendTotals, month: SpendTotals });
export type SpendWindows = z.infer<typeof SpendWindows>;

export const SPEND_WINDOWS = ['today', 'week', 'month'] as const;
export type SpendWindow = (typeof SPEND_WINDOWS)[number];

/** The rolling windows' lengths in days (“today” is the calendar day in the burrow's time zone). */
export const SPEND_WINDOW_DAYS = { week: 7, month: 30 } as const;

/** The plans the overview lists: the ones that used the most in 30 days. */
export const SPEND_PLANS_MAX = 5;

export function emptyTotals(): SpendTotals {
  return { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null, costTurns: 0, unreportedTurns: 0 };
}

export function emptyWindows(): SpendWindows {
  return { today: emptyTotals(), week: emptyTotals(), month: emptyTotals() };
}

/** Micro-dollars: sums of many small costs stay free of visible floating-point drift. */
const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

type CacheSplit = Pick<SpendTotals, 'cacheReadTokens' | 'cacheWriteTokens'>;

/** The cache split of two parts added up: present once either part has it (0.44.1). */
function addCacheSplit(a: CacheSplit, b: CacheSplit): CacheSplit {
  const out: CacheSplit = {};
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined)
    out.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined)
    out.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  return out;
}

/**
 * One more finished turn (SP-D01): a turn without usage counts as a turn with 0 tokens and raises `unreportedTurns`; a
 * reported cost adds to `costUsd` and `costTurns`; a reported cache split adds to the totals' (0.44.1). Returns new
 * totals.
 */
export function addUsage(totals: SpendTotals, usage: SpendUsage | null | undefined): SpendTotals {
  if (!usage) return { ...totals, turns: totals.turns + 1, unreportedTurns: totals.unreportedTurns + 1 };
  const cost = typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) ? usage.costUsd : null;
  return {
    turns: totals.turns + 1,
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    ...addCacheSplit(totals, usage),
    costUsd: cost === null ? totals.costUsd : roundUsd((totals.costUsd ?? 0) + cost),
    costTurns: totals.costTurns + (cost === null ? 0 : 1),
    unreportedTurns: totals.unreportedTurns,
  };
}

/** Totals added together (a row's parts, or SQL sums per group). */
export function mergeTotals(...all: readonly SpendTotals[]): SpendTotals {
  return all.reduce<SpendTotals>(
    (sum, t) => ({
      turns: sum.turns + t.turns,
      inputTokens: sum.inputTokens + t.inputTokens,
      outputTokens: sum.outputTokens + t.outputTokens,
      ...addCacheSplit(sum, t),
      costUsd:
        sum.costUsd === null && t.costUsd === null ? null : roundUsd((sum.costUsd ?? 0) + (t.costUsd ?? 0)),
      costTurns: sum.costTurns + t.costTurns,
      unreportedTurns: sum.unreportedTurns + t.unreportedTurns,
    }),
    emptyTotals(),
  );
}

/**
 * The tokens totals stand for, as billed (`billedTokens`, PE-04): input and output, with cache reads at a tenth. Without
 * a cache split, input plus output.
 */
export function spendTokens(
  totals: Pick<SpendTotals, 'inputTokens' | 'outputTokens'> & Partial<Pick<SpendTotals, 'cacheReadTokens'>>,
): number {
  return billedTokens(totals);
}

/**
 * The windows a turn that finished at `finishedAt` counts in, at `now`: `today` when it is the same calendar day in
 * the time zone, `week` and `month` when it finished less than 7 or 30 days before `now` (a turn stamped a little
 * after `now` counts too).
 */
export function spendWindowsOf(
  finishedAt: DateInput,
  now: DateInput,
  timeZone: string,
): Record<SpendWindow, boolean> {
  const age = toDate(now).getTime() - toDate(finishedAt).getTime();
  const day = 86_400_000;
  return {
    today: dayKey(finishedAt, timeZone) === dayKey(now, timeZone),
    week: age < SPEND_WINDOW_DAYS.week * day,
    month: age < SPEND_WINDOW_DAYS.month * day,
  };
}

/** One finished turn added to the windows it counts in. Returns new windows. */
export function addTurn(
  windows: SpendWindows,
  turn: { finishedAt: DateInput; usage: SpendUsage | null | undefined },
  now: DateInput,
  timeZone: string,
): SpendWindows {
  const counts = spendWindowsOf(turn.finishedAt, now, timeZone);
  return {
    today: counts.today ? addUsage(windows.today, turn.usage) : windows.today,
    week: counts.week ? addUsage(windows.week, turn.usage) : windows.week,
    month: counts.month ? addUsage(windows.month, turn.usage) : windows.month,
  };
}

/** Finished turns folded into their windows. */
export function spendWindowsFrom(
  turns: readonly { finishedAt: DateInput; usage: SpendUsage | null | undefined }[],
  now: DateInput,
  timeZone: string,
): SpendWindows {
  return turns.reduce((w, t) => addTurn(w, t, now, timeZone), emptyWindows());
}

/* The overview (SP-01) -------------------------------------------------------------------------- */

/** A plan that used the most in 30 days (as billed, `billedTokens`). */
export const SpendPlanRow = z.object({
  planId: PlanId,
  title: z.string(),
  usedTokens: Count,
});
export type SpendPlanRow = z.infer<typeof SpendPlanRow>;

/**
 * `spend.overview` (SP-01): every turn of the agent's (since 3.0 without `scope` and by person, CT-1513: one person).
 */
export const SpendOverview = z.object({
  generatedAt: Timestamp,
  /** The burrow's time zone, which “today” is counted in. */
  timeZone: z.string(),
  totals: SpendWindows,
  /** At most `SPEND_PLANS_MAX`, most used first. */
  plans: z.array(SpendPlanRow).max(SPEND_PLANS_MAX),
});
export type SpendOverview = z.infer<typeof SpendOverview>;

/** Days in `spend.daily`, today included. */
export const SPEND_DAILY_DAYS = 30;

/** One calendar day's turns and tokens (the burrow's time zone), counted by `finished_at` like `SpendTotals`. */
export const SpendDay = z.object({
  /** `YYYY-MM-DD`. */
  date: IsoDate,
  turns: Count,
  inputTokens: Count,
  outputTokens: Count,
  /** Of `inputTokens`, read from the prompt cache (0 when no turn that day reported the split). */
  cacheReadTokens: Count,
  /** Of `inputTokens`, written to the prompt cache. */
  cacheWriteTokens: Count,
});
export type SpendDay = z.infer<typeof SpendDay>;

/**
 * `spend.daily` (Whombat box-status.md BS-07, CT-334): the last `SPEND_DAILY_DAYS` days, oldest first, today last, every
 * day present (zeros on a quiet day).
 */
export const SpendDaily = z.object({
  generatedAt: Timestamp,
  timeZone: z.string(),
  days: z.array(SpendDay).max(SPEND_DAILY_DAYS),
});
export type SpendDaily = z.infer<typeof SpendDaily>;

/** `spend.week`: the agent page's week (SP-02). */
export const SpendAgentWeek = z.object({ week: SpendTotals });
export type SpendAgentWeek = z.infer<typeof SpendAgentWeek>;

/* Copy (SP-02, SP-D01) -------------------------------------------------------------------------- */

const trim1 = (n: number) => String(Number(n.toFixed(1)));

/** A token count as people read it: 900, 1.2k, 340k, 1.2M, 12M, 1.5B. */
export function formatTokenCount(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1_000) return String(v);
  if (v < 9_950) return `${trim1(v / 1_000)}k`;
  if (v < 999_500) return `${Math.round(v / 1_000)}k`;
  if (v < 9_950_000) return `${trim1(v / 1_000_000)}M`;
  if (v < 999_500_000) return `${Math.round(v / 1_000_000)}M`;
  return `${trim1(v / 1_000_000_000)}B`;
}

/** A locale tag, or null: a formatter passed straight to `Array.map` receives an index there, which means English. */
const tagOf = (locale: unknown): string | null => (typeof locale === 'string' ? locale : null);

/** “about $3.40”, “about $1,204.00”, “under $0.01”; null when no turn reported a cost. In a locale when one is given. */
export function formatCost(usd: number | null, locale?: string | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  const tag = tagOf(locale);
  const english = isEnglishLocale(tag);
  if (usd < 0.01)
    return tCore(tag, 'spend.under', { amount: english ? '$0.01' : formatLocaleCurrency(1, 'USD', tag) });
  const cents = Math.round(usd * 100);
  if (!english) return tCore(tag, 'spend.about', { amount: formatLocaleCurrency(cents, 'USD', tag) });
  const dollars = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return tCore(tag, 'spend.about', { amount: `$${dollars}.${String(cents % 100).padStart(2, '0')}` });
}

/** The decimal mark of a locale (“.”, “,”). */
function decimalMark(locale: string | null): string {
  return formatLocaleNumber(1.5, locale, { minimumFractionDigits: 1 }).replace(/\d/g, '') || '.';
}

/** “1.2M tokens · about $3.40”, or “1.2M tokens” without a reported cost. */
export function spendSummary(totals: SpendTotals, locale?: string | null): string {
  const tag = tagOf(locale);
  const count = formatTokenCount(spendTokens(totals));
  // Other languages write the decimal of “1.2M” their own way (“1,2M”).
  const said = isEnglishLocale(tag) ? count : count.replace('.', decimalMark(tag));
  const tokens = tCore(tag, 'spend.tokens', { tokens: said });
  const cost = formatCost(totals.costUsd, tag);
  return cost ? `${tokens} · ${cost}` : tokens;
}

/**
 * The agent page's line (SP-02): “This week: 1.2M tokens · about $3.40”, “This week: 1.2M tokens” when no turn
 * reported a cost, “This week: no turns” when it did nothing.
 */
export function spendLine(week: SpendTotals, locale?: string | null): string {
  const tag = tagOf(locale);
  return week.turns === 0
    ? tCore(tag, 'spend.weekNone')
    : tCore(tag, 'spend.week', { summary: spendSummary(week, tag) });
}
