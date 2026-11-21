/**
 * One dispatch, one provider turn: build the TurnInput, run the provider, and map its TurnEvents onto the
 * runner protocol — `progress` heartbeats (keeping "{name} is thinking" alive, carrying the provider session,
 * stopping the turn when the server answers `cancel` on pause / take over), the final text posted through
 * MCP when the agent did not post itself, then `complete` (done / failed / cancelled).
 *
 * Every live turn runs in its task sandbox (one mode, hermes-engine.md HE-48). A turn that can't start (no sandbox, no
 * sign-in, no checkout for its run) ends with a refusal the agent says in the conversation.
 *
 * `runDispatch` runs the turn's phases (`turn/`) in order — preflight, prepare, the provider with its model fallback,
 * settle, finish — and owns when what the turn holds is let go of; each part of the turn's state has one owner
 * (`turn/scope.ts`).
 */

import type { DispatchContext } from '@whombat/core';
import { confineFeedback } from './feedback';
import { runProvider } from './turn/attempts';
import type { TurnDeps } from './turn/deps';
import { finishTurn, type TurnOutcome } from './turn/finish';
import { preflight, refuseStart } from './turn/preflight';
import { prepareTurn } from './turn/prepare';
import { guardTask } from './turn/sandbox';
import { openTurn } from './turn/scope';

export { completionUsage } from './turn/complete';
export { hostFromEnv, type TurnDeps } from './turn/deps';
export type { TurnOutcome } from './turn/finish';
export { type BuiltTurn, buildTurnInput, confinementFor, reviewChanges } from './turn/input';
export { effortsOf } from './turn/model';
export { finalThreadOf } from './turn/reply';
export type { StopReason } from './turn/stop';
export { isAppErrorCode } from './turn/verdict';

export async function runDispatch(
  dispatched: DispatchContext,
  deps: TurnDeps,
  external: AbortSignal,
): Promise<TurnOutcome> {
  // A feedback assessment runs read-only whatever the context says (docs/decisions/feedback.md FB-21).
  const ctx = confineFeedback(dispatched);
  const turn = openTurn(ctx, deps);
  const { stop, verdict, progress, resources } = turn;
  stop.follow(external, () => progress.beat());

  const start = preflight(ctx, deps);
  if (!start.ok) {
    stop.unfollow();
    return refuseStart(turn, start);
  }
  const task = guardTask(turn);
  progress.start();
  try {
    const ready = await prepareTurn(turn, {
      provider: start.provider,
      viaGateway: start.viaGateway,
    });
    await progress.beat();
    ready.step('ready');
    await runProvider(turn, ready);
  } catch (err) {
    verdict.caught(err, stop.aborted);
  } finally {
    progress.stopTimers();
    task.clear();
    stop.unfollow();
    await resources.endWithProvider();
  }
  // The last results before the turn ends (the server marks what is still running as interrupted then).
  if (progress.unsaid && verdict.managedOutcome !== 'lease_lost') await progress.beat({ final: true });
  await verdict.settle(resources.sandbox, {
    viaGateway: !!start.viaGateway,
    provider: ctx.agent.runtime.provider,
  });
  // Pause / take over end the dispatch on the server, which revokes the agent token: a tool call made
  // before the next progress beat fails and breaks the turn. Ask the server before calling it a crash.
  if (verdict.failure && !verdict.refusal && !stop.aborted) await progress.beat();
  try {
    return await finishTurn(turn);
  } finally {
    // The task's processes are all gone before the runner touches its workspace again (cleanup).
    await resources.release();
  }
}
