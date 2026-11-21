/**
 * A turn's usage as Whombat counts it (docs/decisions/prompt-efficiency.md PE-04): `dispatches.usage` holds what the
 * runner reported (`SpendUsage`: every input token in `inputTokens`, since contracts 0.44.1 with the cache split and
 * the largest call). Budgets and spend count it as billed — uncached input, cache writes and output in full, cache reads
 * at a tenth (core's `billedTokens`) — and session rotation and the checkpoint nudge read the context the session
 * reached (`usageContextTokens`), never the turn's sum.
 */
import { CACHE_READ_WEIGHT } from '@whombat/core';
import { type SQL, sql } from 'drizzle-orm';

/** A usage's parts as SQL over a `usage` jsonb column or alias; cache reads clamped to the input, as core does. */
export function usageParts(usage: SQL) {
  const input = sql`coalesce((${usage} ->> 'inputTokens')::bigint, 0)`;
  const output = sql`coalesce((${usage} ->> 'outputTokens')::bigint, 0)`;
  const read = sql`least(coalesce((${usage} ->> 'cacheReadTokens')::bigint, 0), ${input})`;
  const write = sql`least(coalesce((${usage} ->> 'cacheWriteTokens')::bigint, 0), ${input})`;
  return { input, output, read, write };
}

/** Whether a turn reported a cache split (0.44.1 runners). */
export function hasCacheSplit(usage: SQL): SQL {
  return sql`(jsonb_typeof(${usage} -> 'cacheReadTokens') = 'number' or jsonb_typeof(${usage} -> 'cacheWriteTokens') = 'number')`;
}

/** The weight as a SQL literal (a bound parameter beside a bigint would be typed bigint). */
const WEIGHT = sql.raw(String(CACHE_READ_WEIGHT));

/**
 * Billed tokens summed over the rows (`billedTokens` of the sums), optionally only those matching `filter`; 0 for none.
 * Turns without usage add nothing.
 */
export function billedTokensSum(usage: SQL, filter?: SQL): SQL<number> {
  const { input, output, read } = usageParts(usage);
  const where = filter ? sql` filter (where ${filter})` : sql``;
  return sql<number>`(coalesce(sum(${input} - ${read} + ${output})${where}, 0) + round(coalesce(sum(${read})${where}, 0) * ${WEIGHT}))::bigint`;
}
