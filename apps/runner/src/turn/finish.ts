/**
 * How a turn that started completes, from its verdict and its stop, in this order: a managed outcome that ends the turn is said with its code (SUB-50); a stopped turn
 * is handed back on shutdown, else cancelled; a refusal is said; a failure is reported. Otherwise it is done: its
 * checkout pushed, its final answer delivered even after a progress message, then its
 * usage and workspace reported.
 */

import { outcomeCode } from '@whombat/agent-runtime';
import { RUNNER_SHUTDOWN } from '@whombat/core';
import { complete, completionUsage } from './complete';
import type { TurnScope } from './scope';
import type { StopReason } from './stop';

export interface TurnOutcome {
  outcome: 'done' | 'failed' | 'cancelled';
  reason: StopReason | null;
  error?: string;
  posted: boolean;
  providerSessionId?: string;
  /** Pushes of the workspace branch during and after the turn (coding turns). */
  pushes?: string[];
  /** The refusal the agent said, when the host was not ready for the turn. */
  refusal?: string;
}

export async function finishTurn(turn: TurnScope): Promise<TurnOutcome> {
  const { ctx, deps, id, stop, session, reply, verdict, checkout } = turn;
  const outcomeSession = session.outcome();
  const reported = session.reported();
  const { managedOutcome, refusal } = verdict;
  if (managedOutcome && refusal && managedOutcome !== 'lease_lost') {
    // A refusal with its own app code keeps it (SUB-50); an outcome of the turn itself is `managed:<outcome>`.
    const code = verdict.refusalCode ?? outcomeCode(managedOutcome);
    deps.log('warn', `${ctx.agent.name} · ${code}: ${refusal}`, { dispatchId: id });
    await complete(turn, { outcome: 'failed', error: code, refusal: refusal.slice(0, 500), ...reported });
    return { outcome: 'failed', reason: null, error: code, refusal, posted: reply.posted, ...outcomeSession };
  }
  // Not final (an outage): an ordinary failure the server retries once, with its code.
  if (managedOutcome && !refusal) verdict.failure = outcomeCode(managedOutcome);
  if (stop.aborted) {
    const { reason } = stop;
    // Shutting down hands the dispatch back to the queue; pause / take over / cancel end the turn.
    if (reason === 'shutdown') {
      await complete(turn, { outcome: 'failed', error: RUNNER_SHUTDOWN, ...reported });
      return { outcome: 'failed', reason, error: RUNNER_SHUTDOWN, posted: reply.posted, ...outcomeSession };
    }
    await complete(turn, { outcome: 'cancelled', ...reported });
    return { outcome: 'cancelled', reason, posted: reply.posted, ...outcomeSession };
  }
  if (refusal) {
    deps.log('warn', `${ctx.agent.name} · refused: ${refusal}`, { dispatchId: id });
    await complete(turn, {
      outcome: 'failed',
      error: verdict.refusalCode ?? 'host_not_ready',
      refusal: refusal.slice(0, 500),
      ...reported,
    });
    return {
      outcome: 'failed',
      reason: null,
      error: refusal,
      refusal,
      posted: reply.posted,
      ...outcomeSession,
    };
  }
  const { failure } = verdict;
  if (failure) {
    await complete(turn, { outcome: 'failed', error: failure.slice(0, 2000), ...reported });
    return { outcome: 'failed', reason: null, error: failure, posted: reply.posted, ...outcomeSession };
  }
  await checkout.afterTurn();
  try {
    await reply.postFinal(deps);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await complete(turn, { outcome: 'failed', error: detail.slice(0, 2000), ...reported });
    return { outcome: 'failed', reason: null, error: detail, posted: reply.posted, ...outcomeSession };
  }
  await complete(turn, {
    outcome: 'done',
    ...reported,
    ...(reply.usage ? { usage: completionUsage(reply.usage) } : {}),
    ...checkout.report(),
  });
  return {
    outcome: 'done',
    reason: null,
    posted: reply.posted,
    ...outcomeSession,
    ...(checkout.pushes.length ? { pushes: checkout.pushes } : {}),
  };
}
