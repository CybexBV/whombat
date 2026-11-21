/**
 * Ends a turn at the server (`complete`): its outcome with the lease and what the turn learned on the way — why a
 * failure failed (essentials-agents.md EA-08), the rate-limit readings (UI-R08), the model fallback (ME-05) and what it
 * ran on (CR-R05) — and its usage as the contract carries it (PE-04).
 */

import type { TurnUsage } from '@whombat/agent-runtime';
import { RUNNER_SHUTDOWN, type SpendUsage } from '@whombat/core';
import { type RunnerApi, RunnerApiError } from '../api';
import type { TurnScope } from './scope';

export type CompleteBody = Parameters<RunnerApi['complete']>[1];

/** Ends the turn at the server; a runner that lost its lease (409) lets go without a fuss. */
export async function complete(
  turn: Pick<TurnScope, 'deps' | 'id' | 'lease' | 'verdict' | 'readings' | 'ran'>,
  body: CompleteBody,
): Promise<void> {
  const { deps, id, lease, verdict, readings } = turn;
  const limits = readings.report();
  // Every failure that isn't a handover says why (a shutdown only hands the dispatch back).
  const failed =
    body.outcome === 'failed' && body.error !== RUNNER_SHUTDOWN && !body.failure
      ? { failure: verdict.failureOf(body.error ?? '', readings.limitedUntil()) }
      : {};
  try {
    await deps.api.complete(id, {
      ...body,
      ...failed,
      ...lease,
      ...(limits ? { rateLimits: limits } : {}),
      ...turn.ran.report(),
    });
  } catch (err) {
    if (!(err instanceof RunnerApiError && err.status === 409)) throw err;
    deps.log('warn', 'the dispatch was handed out again; leaving it to its new runner', { dispatchId: id });
  }
}

/** A whole, non-negative count (the contract's `Count`), or undefined for what a provider didn't report as one. */
function count(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

/**
 * The turn's usage as the completion carries it (`SpendUsage`, contracts 0.44.1, PE-04): the total input and output, the
 * cache reads and writes and the largest call where the provider reported them, and the cost. Counts are whole and
 * never negative, so a provider's slip can't cost the turn its completion.
 */
export function completionUsage(usage: TurnUsage): SpendUsage {
  const optional = {
    cacheReadTokens: count(usage.cacheReadTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens),
    largestCallInputTokens: count(usage.largestCallInputTokens),
  };
  return {
    inputTokens: count(usage.inputTokens) ?? 0,
    outputTokens: count(usage.outputTokens) ?? 0,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
    ...(typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
      ? { costUsd: usage.costUsd }
      : {}),
  };
}
