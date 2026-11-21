/**
 * Every resumed turn's prompt cache result (docs/decisions/prompt-efficiency.md PE-12, after Hermes Agent's cache-break
 * causes): a resumed chat turn is a `hit` (it read the session's context from the provider's prompt cache), `expired`
 * (it didn't, and the gap since the session's last turn exceeded the lifetime that turn's cache was written with) or a
 * `miss` (it didn't, within the lifetime: something changed the prefix). The class is stored with the turn's usage
 * (`dispatches.usage.cacheResult`), logged, counted in the spend view, and repeated misses of one agent are a warning.
 *
 * Judged from what the runner reports (`SpendUsage`, contracts 0.44.1: the turn's sums and its largest call), since a
 * turn's per-call usage doesn't reach the server. On a hit every call reads what came before it — the first call the
 * session's last context, each later one its predecessor's whole input — so the input the turn didn't read from the
 * cache is exactly what it added to the context: its largest call less the session's last context. What it didn't read
 * beyond that is the part of the session's context the cache didn't hold. Main-thread calls only, as the providers count
 * them (a Claude sub-agent's calls aren't in its usage, a Codex sub-agent's thread isn't the turn's).
 */
import type { SpendTotals, SpendUsage } from '@whombat/core';

export const CACHE_RESULTS = ['hit', 'expired', 'miss'] as const;
export type CacheResult = (typeof CACHE_RESULTS)[number];

/** How many of a window's resumed turns had each result (PE-12; server-side, beside contracts 0.44.1's totals). */
export type CacheResultCounts = Record<CacheResult, number>;

/** A turn's usage as stored: the runner's `SpendUsage` and, for a resumed chat turn, its cache result. */
export type StoredUsage = SpendUsage & { cacheResult?: CacheResult };

/** Spend totals with their resumed turns' cache results, once a turn in the window had one. */
export type CountedTotals = SpendTotals & { cacheResults?: CacheResultCounts };

/**
 * A session context below this is too small to judge (a provider caches nothing under ~1 000 tokens, and every real
 * Whombat turn's tools and prompt alone are tens of thousands).
 */
export const CACHE_JUDGED_FROM_TOKENS = 4096;
/** Unread input beyond what the turn added that still counts as a hit: the session's context × this … */
export const CACHE_MISS_SHARE = 0.05;
/** … but at least this many tokens (a provider caches in blocks; Claude Code adds small reminders). */
export const CACHE_MISS_MIN_TOKENS = 1024;
/** Resumed turns in a row of one agent that missed before the runtime log warns (PE-12). */
export const CACHE_MISS_WARN_AFTER = 3;

export interface CacheJudgement {
  result: CacheResult;
  /** Input not read from the cache beyond what the turn itself added. */
  unreadTokens: number;
  /** The context the session reached in its last turn (its largest call). */
  priorContextTokens: number;
  gapMs: number;
  ttlMs: number;
}

/**
 * The cache result of a turn that resumed a session (PE-12), or null when it can't be judged: no cache split or largest
 * call (an older runner), or a session context too small to tell.
 *
 * - `usage`: the turn's, as reported.
 * - `priorContextTokens`: the context the session reached in its last turn (`agent_sessions.last_context_tokens`).
 * - `gapMs`: from the end of the session's last turn to this turn's claim.
 * - `ttlMs`: the lifetime the session's last turn wrote its cache with — the runtime's rule for the hour of cache
 *   (`promptCacheTtlMs` of `@whombat/agent-runtime/cache`: an hour after a person-paced Claude turn, else five minutes).
 */
export function judgeCache(input: {
  usage: SpendUsage;
  priorContextTokens: number | null;
  gapMs: number;
  ttlMs: number;
}): CacheJudgement | null {
  const { usage, gapMs, ttlMs } = input;
  const prior = input.priorContextTokens;
  if (prior === null || prior < CACHE_JUDGED_FROM_TOKENS) return null;
  if (usage.cacheReadTokens === undefined || usage.largestCallInputTokens === undefined) return null;
  const read = Math.min(Math.max(0, usage.cacheReadTokens), usage.inputTokens);
  const added = Math.max(0, usage.largestCallInputTokens - prior);
  const unread = Math.max(0, usage.inputTokens - read - added);
  const slack = Math.max(CACHE_MISS_MIN_TOKENS, Math.round(prior * CACHE_MISS_SHARE));
  const result: CacheResult = unread <= slack ? 'hit' : gapMs > ttlMs ? 'expired' : 'miss';
  return { result, unreadTokens: unread, priorContextTokens: prior, gapMs, ttlMs };
}

/** No results yet. */
export function noCacheResults(): CacheResultCounts {
  return { hit: 0, expired: 0, miss: 0 };
}

/** The results of several totals added up; absent when none had any. */
export function sumCacheResults(all: readonly CountedTotals[]): { cacheResults?: CacheResultCounts } {
  const counted = all.filter((t) => t.cacheResults);
  if (!counted.length) return {};
  const sum = noCacheResults();
  for (const t of counted) for (const r of CACHE_RESULTS) sum[r] += t.cacheResults?.[r] ?? 0;
  return { cacheResults: sum };
}
