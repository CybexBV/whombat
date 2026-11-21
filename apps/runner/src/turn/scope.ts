/**
 * One turn's collaborators, each the only owner of its part of the turn's state: how it stops, its session, what it
 * put in front of people, why it failed, the provider's readings and what it ran on, what it holds, its beats and its
 * checkout. A phase takes the ones it uses (`Pick<TurnScope, …>`).
 */

import type { DispatchContext, RunnerLease } from '@whombat/core';
import { leaseOf } from '../api';
import { TurnCheckout } from './checkout';
import type { TurnDeps } from './deps';
import { TurnRan } from './model';
import { TurnProgress } from './progress';
import { RateLimitReadings } from './rate-limits';
import { TurnReply } from './reply';
import { TurnResources } from './resources';
import { TurnSession } from './session';
import { TurnStop } from './stop';
import { TurnVerdict } from './verdict';

export interface TurnScope {
  /** The dispatch as this runner runs it (an assessment confined). */
  ctx: DispatchContext;
  deps: TurnDeps;
  /** The dispatch's id. */
  id: string;
  /** The lease this runner got with the claim; sent with every call about the dispatch. */
  lease: RunnerLease;
  stop: TurnStop;
  session: TurnSession;
  reply: TurnReply;
  verdict: TurnVerdict;
  readings: RateLimitReadings;
  ran: TurnRan;
  resources: TurnResources;
  progress: TurnProgress;
  checkout: TurnCheckout;
}

export function openTurn(ctx: DispatchContext, deps: TurnDeps): TurnScope {
  const parts = {
    ctx,
    deps,
    id: ctx.dispatch.id,
    lease: leaseOf(ctx),
    stop: new TurnStop(),
    session: new TurnSession(ctx.dispatch.providerSessionId ?? undefined),
    reply: new TurnReply(ctx),
    verdict: new TurnVerdict(),
    readings: new RateLimitReadings(),
    ran: new TurnRan(),
    resources: new TurnResources(),
  };
  return { ...parts, progress: new TurnProgress(parts), checkout: new TurnCheckout(parts) };
}
