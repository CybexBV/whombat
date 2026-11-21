/**
 * A step's turn hands its wait for T3 Code to Whombat (docs/decisions/outsiders-turns.md). Every outsiders' turn
 * runs in Hermes's one outsiders' profile, one at a time, and a tracker run's step waits for its T3 Code thread inside
 * its turn: a fix for an hour or more, while another customer's answer waits behind it. So while another outsiders' turn
 * is queued, a step's `t3_thread_wait` on a thread that is still at work doesn't wait: the turn records the thread
 * (`dispatches.waits_on`) and is told to end. The engine waits for that thread in its place and, once it finished or
 * asks something, gives the step a new turn with the same instructions (`engine/observe.ts`, the step op
 * `turn_resume`).
 */
import { billedTokens, CONNECTION_CALL_DEADLINE_MS, type JsonObject } from '@whombat/core';
import { and, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db, Tx } from '../db/client';
import { automationRunSteps, type DispatchWaitsOn, dispatches } from '../db/schema/index';
import { forbidden } from '../lib/errors';
import type { DispatchRow } from '../runtime/context';
import { HANDED_OVER_ERROR } from './handed-over';

export { HANDED_OVER_ERROR };

import { outsidersTurn } from '../runtime/person';
import type { Services } from '../services';
import { callT3 } from '../things/kinds/business/t3code';

/** How long the look whether the thread is still at work waits for it. */
const PROBE_MS = 1000;

/** What the turn hears instead of a wait: T3 Code's own end-your-turn signal (`next`) with why, in plain words. */
export const HANDED_WAIT_MESSAGE =
  'Another customer’s report or a Whombat update is waiting for this turn to end, so Whombat waits for this T3 Code thread for you. End your turn now without saying anything: Whombat takes nothing more from this turn, not even a last line. Once the thread finishes or asks something, this step goes on in a new turn of yours, with the same instructions.';

/** What a step's turn after a handed wait is told, after its instructions. */
export function resumedLine(threadId: string): string {
  return `An earlier turn of yours on this step handed its wait for the T3 Code thread ${threadId} to Whombat, and that thread has finished or asks something now. Don't start a new thread for this: read that one (t3_thread_read), answer it when it asks, and go on from there.`;
}

/** Whether another outsiders' turn is queued and due: it waits for the one outsiders' profile. */
export async function outsidersWaiting(db: Db | Tx, dispatchId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(
      and(
        isNull(dispatches.onBehalfOfAccountId),
        eq(dispatches.state, 'queued'),
        ne(dispatches.id, dispatchId),
        or(isNull(dispatches.notBefore), lte(dispatches.notBefore, now)),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * The longest one `t3_thread_wait` of an automation step's outsiders' turn waits in T3 Code: within a call's own 30 s
 * (`CONNECTION_CALL_DEADLINE_MS`; a wait left longer fails there and drops the pooled session), as T3 Code's guide asks.
 * The turn asks again after it, and so finds out about a customer's turn queued meanwhile.
 */
export const STEP_WAIT_SLICE_MS = CONNECTION_CALL_DEADLINE_MS - 5_000;

/** How long a turn that handed its wait over may take to end before Whombat stops it (the wait carries on). */
export const HANDED_WIND_DOWN_MS = 2 * 60_000;

/**
 * Whether a turn that handed its wait over has ended, however: by itself, failing while it wound down, or stopped by
 * Whombat for taking too long. Then the step waits for the thread (a person's stop or the step's time running out
 * still end the step).
 */
export function handedTurnEnded(d: Pick<DispatchRow, 'state' | 'waitsOn' | 'error'>): boolean {
  if (!d.waitsOn) return false;
  return (
    d.state === 'done' || d.state === 'failed' || (d.state === 'cancelled' && d.error === HANDED_OVER_ERROR)
  );
}

/** What any further call of a turn that handed its wait over hears: it has ended its part. */
export const HANDED_TURN_ENDED =
  'This turn handed its wait for T3 Code to Whombat, so nothing more runs in it. End your turn now without saying anything; this step goes on in a new turn of yours.';

/** A step's outsiders' turn's `t3_thread_wait` arguments with its wait cut to `STEP_WAIT_SLICE_MS`; others unchanged. */
export function slicedWaitArgs(
  dispatch: Pick<DispatchRow, 'trigger' | 'onBehalfOfAccountId'>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (dispatch.trigger !== 'automation' || !outsidersTurn(dispatch)) return args;
  const asked =
    typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : Number.POSITIVE_INFINITY;
  return { ...args, timeoutMs: Math.min(asked, STEP_WAIT_SLICE_MS) };
}

/** Whether T3 Code's answer to `t3_thread_wait` says it stopped waiting only because its time ran out. */
export function waitTimedOut(body: unknown): boolean {
  return (body as { timedOut?: unknown } | null)?.timedOut === true;
}

/**
 * `automation.turn_waits` (the step's agent): its turn hands the wait for one T3 Code thread to Whombat and ends. Only
 * an automation step's outsiders' turn that is still at work, and only once; the thread was checked as its own before.
 */
export const handTurnWait = defineCommand({
  name: 'automation.turn_waits',
  schema: z.object({
    dispatchId: z.string().min(1).max(64),
    connectionId: z.string().min(1).max(64),
    threadId: z.string().min(1).max(500),
    settled: z.boolean(),
  }),
  async apply(tx, ctx, input): Promise<{ handed: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the step’s agent hands its wait over.');
    const waitsOn: DispatchWaitsOn = {
      connectionId: input.connectionId,
      threadId: input.threadId,
      settled: input.settled,
      at: ctx.now.toISOString(),
    };
    const rows = await tx
      .update(dispatches)
      .set({ waitsOn })
      .where(
        and(
          eq(dispatches.id, input.dispatchId),
          eq(dispatches.burrowId, ctx.burrow.id),
          eq(dispatches.agentId, ctx.actor.id),
          eq(dispatches.trigger, 'automation'),
          isNull(dispatches.onBehalfOfAccountId),
          inArray(dispatches.state, ['claimed', 'running']),
          isNull(dispatches.waitsOn),
        ),
      )
      .returning({ id: dispatches.id });
    return { handed: rows.length > 0 };
  },
});

/**
 * An automation step's outsiders' turn that waits for a T3 Code thread while another outsiders' turn is queued or an
 * update waits for it: when the thread is still at work, the wait is handed to Whombat and the answer the turn gets is
 * returned; otherwise null, and the wait goes to T3 Code as usual. Any doubt (no step, T3 Code didn't answer) is null too: the turn waits as before.
 */
export async function handWaitWhenQueued(
  services: Services,
  dispatch: DispatchRow,
  connection: CatalogConnectionRow,
  args: Record<string, unknown>,
  burrowId: string,
): Promise<string | null> {
  const db = services.db;
  if (dispatch.trigger !== 'automation' || !outsidersTurn(dispatch)) return null;
  const threadId = typeof args.threadId === 'string' ? args.threadId : null;
  if (!threadId) return null;
  const [step] = await db
    .select({ runId: automationRunSteps.runId })
    .from(automationRunSteps)
    .where(eq(automationRunSteps.dispatchId, dispatch.id))
    .limit(1);
  if (!step) return null;
  // Another customer's turn waits for the outsiders' profile, or an update waits for this turn to end.
  const now = services.clock();
  if (!services.maintenance.updateWaits(now) && !(await outsidersWaiting(db, dispatch.id, now))) return null;
  const settled = args.untilDelegatedWorkSettled === true;
  let probe: unknown;
  try {
    probe = await callT3(services, connection, 't3_thread_wait', {
      threadId,
      ...(settled ? { untilDelegatedWorkSettled: true } : {}),
      timeoutMs: PROBE_MS,
    });
  } catch (err) {
    services.log.warn(
      { dispatchId: dispatch.id, threadId, err: String(err).slice(0, 200) },
      'automations: whether a T3 Code thread is still at work couldn’t be read, so the turn waits for it',
    );
    return null;
  }
  if (!waitTimedOut(probe)) return null;
  const res = await services.pipeline.commit(
    handTurnWait,
    { dispatchId: dispatch.id, connectionId: connection.id, threadId, settled },
    { burrowId, actorId: dispatch.agentId },
  );
  if (res.status !== 'ok' || !res.result.handed) return null;
  services.log.info(
    { dispatchId: dispatch.id, threadId },
    'automations: a step’s turn handed its T3 Code wait to Whombat for a queued outsiders’ turn or an update',
  );
  return JSON.stringify({
    ...(probe as Record<string, unknown>),
    timedOut: true,
    handedToWhombat: true,
    next: 'end_turn',
    message: HANDED_WAIT_MESSAGE,
  });
}

/** `output.handedWait` of a step whose turn handed its wait over: how often, since its first claim, and what for. */
export interface HandedWait {
  count: number;
  /** Its first turn's claim, ISO: the step's time counts from there. */
  since: string | null;
  threadId: string;
  /** The last message before the step's newest turn: its result is what that turn said after it. */
  afterOrd: number | null;
  /** What the turns that handed their wait over used, as billed: the step's and run's usage counts them too. */
  tokens: number;
}

export function handedWaitOf(output: unknown): HandedWait | null {
  const h = (output as { handedWait?: unknown } | null)?.handedWait as Partial<HandedWait> | undefined;
  if (!h || typeof h !== 'object' || typeof h.count !== 'number' || typeof h.threadId !== 'string')
    return null;
  return {
    count: h.count,
    since: typeof h.since === 'string' ? h.since : null,
    threadId: h.threadId,
    afterOrd: typeof h.afterOrd === 'number' ? h.afterOrd : null,
    tokens: typeof h.tokens === 'number' && Number.isFinite(h.tokens) ? h.tokens : 0,
  };
}

/** The step's output once its next turn is queued after a handed wait. */
export function resumedOutput(
  output: JsonObject,
  handed: Pick<DispatchRow, 'claimedAt' | 'waitsOn' | 'usage'>,
  afterOrd: number | null,
): JsonObject {
  const before = handedWaitOf(output);
  const next: HandedWait = {
    count: (before?.count ?? 0) + 1,
    since: before?.since ?? handed.claimedAt?.toISOString() ?? null,
    threadId: handed.waitsOn?.threadId ?? before?.threadId ?? '',
    afterOrd,
    tokens: (before?.tokens ?? 0) + (handed.usage ? billedTokens(handed.usage) : 0),
  };
  return { ...output, handedWait: { ...next } };
}
