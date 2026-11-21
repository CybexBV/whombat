/**
 * Stop on an agent's turn (docs/decisions/review-features.md RF-01; contracts 0.55.0 CT-295, `dispatches.cancel`).
 *
 * - Who: the person (an agent: 403) in the turn's conversation (anyone else: 404, as for no turn); they may stop any
 *   turn (one-person.md OP-S07).
 * - A turn that already ended answers with how it ended. A run's turn answers 409 “Pause the run instead.” (the run line
 *   has Pause); a turn another part of Whombat owns (an assessment, an automation step, a search answer, a reflection)
 *   409 too.
 * - Queued: cancelled at once. Claimed or running: cancelled now, and its runner stops at its next beat (the existing
 *   `ProgressResponse {cancel: true, reason: 'cancelled'}`); until the runner says it ended, the turn still holds the
 *   agent's place in its thread (`claimInTx`; another thread's turns go on, hermes-native.md HN-T01), and what it used
 *   and the session it ran are kept (`finalizeIn`).
 * - The thinking line clears, `dispatch.updated` says “Stopped by Mara”, what the turn was doing is interrupted, and a
 *   hidden signed `dispatch.cancelled` records who stopped it.
 */
import {
  canStopTurn,
  DispatchId,
  type DispatchSummary,
  isTurnLive,
  TURN_STOP_RUN_REFUSAL,
  turnStoppedText,
} from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { dispatches } from '../db/schema/index';
import { followDispatch } from '../domain/plan-follow';
import { stoppableTurn } from '../domain/turn-stop';
import { ApiError, forbidden, notFound } from '../lib/errors';
import { loadPrincipalRow, type PrincipalRow, shortName } from '../read/principals';
import { dispatchSummary, interruptActivity, publishDispatch } from './activity';
import type { DispatchRow } from './context';

/** A turn that belongs to another part of Whombat: its owner ends it, not Stop. */
export const NOT_YOURS_TO_STOP =
  'This turn belongs to the part of Whombat that started it, so it can’t be stopped here.';

type StopViewer = Pick<PrincipalRow, 'id' | 'kind' | 'accountId'>;
type StopTurn = Pick<DispatchRow, 'state' | 'runId' | 'trigger' | 'mode' | 'onBehalfOfAccountId'>;

/**
 * Whether the viewer may stop the turn (its burrow checked by the caller): live, not a run's turn,
 * not one Whombat owns, and the viewer is the person (core's `canStopTurn`; one-person.md OP-S07). The Work view's `stop_turn` and the command apply it alike.
 */
export function mayStopTurn(viewer: StopViewer, turn: StopTurn): boolean {
  if (viewer.kind !== 'person' || !isTurnLive(turn.state) || turn.runId || !stoppableTurn(turn)) return false;
  if (turn.onBehalfOfAccountId && viewer.accountId === turn.onBehalfOfAccountId) return true;
  return canStopTurn({ state: turn.state, runId: null }, { id: viewer.id, kind: 'person' });
}

/** The turn as it is now, with “Stopped by Mara” when a person stopped it. */
export async function stoppedSummary(db: Db | Tx, row: DispatchRow): Promise<DispatchSummary> {
  if (row.state !== 'cancelled' || !row.stoppedById) return dispatchSummary(row);
  const by = await loadPrincipalRow(db, row.stoppedById);
  return dispatchSummary(row, row.runId, by ? turnStoppedText(shortName(by)) : null);
}

export const cancelDispatch = defineCommand({
  name: 'dispatch.cancel',
  schema: z.object({ dispatchId: DispatchId }),
  async apply(tx, ctx, input): Promise<{ dispatch: DispatchSummary }> {
    const [row] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId)).for('update');
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Turn');
    const viewer = await loadPrincipalRow(tx, ctx.actor.id);
    if (!viewer) throw notFound('Turn');
    if (viewer.kind !== 'person') throw forbidden('Agents don’t stop turns.');
    if (!isTurnLive(row.state)) return { dispatch: await stoppedSummary(tx, row) };
    if (!mayStopTurn(viewer, { ...row, runId: null }))
      throw stoppableTurn(row)
        ? forbidden('Only you can stop this turn.')
        : new ApiError('conflict', NOT_YOURS_TO_STOP);
    if (row.runId) throw new ApiError('conflict', TURN_STOP_RUN_REFUSAL, { details: { code: 'pause_run' } });
    const [stopped] = await tx
      .update(dispatches)
      .set({
        state: 'cancelled',
        cancelReason: 'cancelled',
        error: 'stopped',
        stoppedById: viewer.id,
        finishedAt: ctx.now,
      })
      .where(and(eq(dispatches.id, row.id), inArray(dispatches.state, ['queued', 'claimed', 'running'])))
      .returning();
    if (!stopped) return { dispatch: await stoppedSummary(tx, row) };
    const reason = turnStoppedText(shortName(viewer));
    // What it was still doing is interrupted, never done (WS-15).
    if (row.state !== 'queued') await interruptActivity(tx, ctx, [row.id], ctx.now);
    publishDispatch(ctx, stopped, reason);
    await ctx.emit({
      type: 'dispatch.cancelled',
      kind: 'System',
      text: null,
      where: null,
      aboutId: row.agentId,
      payload: { dispatchId: row.id, agentId: row.agentId },
    });
    const services = ctx.services;
    ctx.after(async () => {
      services.runtime.stopThinking(stopped);
      // A plan step's turn: the step follows it (WS-05).
      if (stopped.planId) await followDispatch(services, stopped);
    });
    return { dispatch: dispatchSummary(stopped, stopped.runId, reason) };
  },
});
