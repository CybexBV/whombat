/**
 * What runs a turn, or why nothing does — decided before anything starts: an assessment this runner can't keep
 * read-only (feedback.md FB-21), a gateway route this runner can't take
 * (AIG-12), no provider for the agent here.
 */

import type { AgentProvider } from '@whombat/agent-runtime';
import type { DispatchContext, GatewayDispatchContext, TurnFailureReport } from '@whombat/core';
import { feedbackRefusal } from '../feedback';
import { gatewayRouteOf } from '../gateway';
import { complete } from './complete';
import type { TurnDeps } from './deps';
import type { TurnOutcome } from './finish';
import type { TurnScope } from './scope';

export type TurnStart =
  | { ok: true; provider: AgentProvider; viaGateway: GatewayDispatchContext | null }
  | {
      ok: false;
      /** Nothing to run, and nothing wrong: the dispatch ends done. */
      done?: true;
      error: string;
      /** What the agent says in the conversation; absent when nothing on this runner can run the agent at all. */
      refusal?: string;
      failure?: TurnFailureReport;
    };

export function preflight(ctx: DispatchContext, deps: Pick<TurnDeps, 'registry'>): TurnStart {
  // An assessment whose report didn't reach the runner is refused, not run.
  const assessmentRefusal = feedbackRefusal(ctx);
  if (assessmentRefusal) return { ok: false, error: assessmentRefusal, refusal: assessmentRefusal };

  // Through the burrow's AI gateway (Whombat ai-gateway.md AIG-07): the server decided at claim, and the turn keeps that
  // route whatever the switch says now. One this runner can't send there doesn't start (AIG-12: no fallback).
  const route = gatewayRouteOf(ctx);
  if (route && !route.ok)
    return { ok: false, error: route.refusal, refusal: route.refusal, failure: { code: 'provider' } };
  const viaGateway = route?.gateway ?? null;

  // A gateway turn needs the CLI, not its sign-in (AIG-16).
  const provider = deps.registry.for(ctx.agent.runtime.provider, viaGateway ? { gateway: true } : undefined);
  if (!provider) return { ok: false, error: `No ${ctx.agent.runtime.provider} provider on this runner` };
  return { ok: true, provider, viaGateway };
}

/** A turn that doesn't start ends failed at once; a refusal is what the agent says (`CompleteBody.refusal`). */
export async function refuseStart(
  turn: Pick<TurnScope, 'ctx' | 'deps' | 'id' | 'lease' | 'verdict' | 'readings' | 'ran' | 'reply'>,
  start: Extract<TurnStart, { ok: false }>,
): Promise<TurnOutcome> {
  const { ctx, deps, id, reply } = turn;
  const { error, refusal, failure } = start;
  if (start.done) {
    await complete(turn, { outcome: 'done' });
    return { outcome: 'done', reason: null, posted: reply.posted };
  }
  if (!refusal) {
    await complete(turn, { outcome: 'failed', error });
    return { outcome: 'failed', reason: null, error, posted: reply.posted };
  }
  deps.log('warn', `${ctx.agent.name} · refused: ${refusal}`, { dispatchId: id });
  await complete(turn, {
    outcome: 'failed',
    error: 'host_not_ready',
    refusal: refusal.slice(0, 500),
    ...(failure ? { failure } : {}),
  });
  return { outcome: 'failed', reason: null, error, refusal, posted: reply.posted };
}
