import { type JsonObject, trackerAccessAsked } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import type { ApplyContext } from '../../commit/types';
import type { Tx } from '../../db/client';
import { automationRunSteps, automationRuns, automations } from '../../db/schema/index';
import { conflict, notFound } from '../../lib/errors';
import { revokeSettledGrants } from '../../trackers/access';
import { stopRunRequests } from '../../trackers/features';
import { scopeReport } from '../../trackers/items';
import { noticeUnlandedFix } from '../../trackers/unlanded';
import { cancelRunDispatches } from '../commands';
import { postRunNotice } from '../notice';
import { type AutomationRunRow, loadStepRows, publishAutomation } from '../store';

export async function lockRun(tx: Tx, input: { runId: string; fence: number; owner: string }) {
  const [run] = await tx
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.id, input.runId))
    .for('update');
  if (!run) throw notFound('Automation run');
  if (run.fence !== input.fence || run.leaseOwner !== input.owner)
    throw conflict('Another engine holds this run now.');
  return run;
}

export async function updateStep(
  tx: Tx,
  runId: string,
  idx: number,
  values: Partial<typeof automationRunSteps.$inferInsert>,
  now: Date,
) {
  await tx
    .update(automationRunSteps)
    .set({ ...values, updatedAt: now })
    .where(and(eq(automationRunSteps.runId, runId), eq(automationRunSteps.idx, idx)));
}

export async function stopRun(
  ctx: ApplyContext,
  run: AutomationRunRow,
  status: 'succeeded' | 'failed' | 'cancelled' | 'needs_review',
  error: string | null,
  /**
   * `noticeOn`: the step the run stopped at, whose messages the notice joins (a `connection_actions` step's: what an
   * outsiders' turn reads of them is only a summary, `runtime/outsiders-view.ts`).
   */
  o: { quiet?: boolean; noticeOn?: number } = {},
) {
  const finished = status !== 'needs_review';
  await ctx.tx
    .update(automationRuns)
    .set({
      status,
      error,
      updatedAt: ctx.now,
      ...(finished ? { finishedAt: ctx.now, leaseOwner: null, leaseExpiresAt: null } : {}),
    })
    .where(eq(automationRuns.id, run.id));
  if (finished) {
    await cancelRunDispatches(ctx.tx, run.id, ctx.now, ctx);
    revokeTrackerAccessAfter(ctx, run);
    // A feature request it still waited on no longer waits (report-trackers.md TA-44).
    await stopRunRequests(ctx, run.id);
  }
  const [automation] = await ctx.tx.select().from(automations).where(eq(automations.id, run.automationId));
  const name = automation?.name ?? 'an automation';
  const text =
    status === 'succeeded'
      ? `Ran “${name}”`
      : status === 'needs_review'
        ? `“${name}” is waiting for a check of a step`
        : status === 'cancelled'
          ? `Stopped “${name}”`
          : `“${name}” didn’t finish`;
  await ctx.emit({
    type: `automation.run.${status}`,
    kind: 'System',
    text,
    where: null,
    payload: { automationId: run.automationId, runId: run.id, number: run.number, status },
  });
  if (status !== 'succeeded' && !o.quiet) {
    const notice = await postRunNotice(ctx, run, name, status, error);
    if (notice && o.noticeOn !== undefined)
      await ctx.tx
        .update(automationRunSteps)
        .set({ messageIds: sql`array_append(${automationRunSteps.messageIds}, ${notice})`, updatedAt: ctx.now })
        .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, o.noticeOn)));
  }
  // A customer's bug it set out to fix and didn't: its thread says why and the person's Inbox has it (TA-61).
  // Once, when the run first ends: a run finished again says nothing more.
  if (finished && !run.finishedAt)
    await noticeUnlandedFix(ctx, run, await loadStepRows(ctx.tx, run.id), status);
  await publishAutomation(ctx, ctx.burrow.id, run.automationId);
}

/**
 * A step with organization access settled, or its run stopped (report-trackers.md TA-10, TA-23: every agent step of a
 * tracker run that neither writes code nor gives a verdict asks for it): its access is revoked after the commit, in the
 * background; what the tracker doesn't confirm the poller's sweep tries again.
 */
export function revokeTrackerAccessAfter(ctx: ApplyContext, run: AutomationRunRow): void {
  if (!scopeReport(run.scope) || !run.definition.steps.some(trackerAccessAsked)) return;
  const services = ctx.services;
  ctx.after(async () => services.tracker.background(() => revokeSettledGrants(services, { runId: run.id })));
}

/** A step that may not run: signed as Blocked by the automation, the run fails. */
export async function block(ctx: ApplyContext, run: AutomationRunRow, idx: number, reason: string) {
  await updateStep(ctx.tx, run.id, idx, { state: 'blocked', error: reason, finishedAt: ctx.now }, ctx.now);
  const [automation] = await ctx.tx
    .select({ name: automations.name })
    .from(automations)
    .where(eq(automations.id, run.automationId));
  await ctx.emit({
    type: 'automation.step.blocked',
    kind: 'Blocked',
    text: `“${automation?.name ?? 'An automation'}” stopped before a step: ${reason}`.slice(0, 500),
    where: null,
    payload: { runId: run.id, number: run.number, idx },
  });
  await stopRun(ctx, run, 'failed', reason, noticeOnStep(run, idx));
}

/** Where a run's notice is kept when it stops at step `idx`: on a `connection_actions` step, with its own messages. */
export function noticeOnStep(run: Pick<AutomationRunRow, 'definition'>, idx: number): { noticeOn?: number } {
  return run.definition.steps[idx]?.kind === 'connection_actions' ? { noticeOn: idx } : {};
}

/** A step that has nothing to do here: skipped, with why, and the run goes on. */
export async function skipStep(
  ctx: ApplyContext,
  run: AutomationRunRow,
  idx: number,
  base: Partial<typeof automationRunSteps.$inferInsert>,
  reason: string,
  output: JsonObject = { reason },
) {
  await updateStep(
    ctx.tx,
    run.id,
    idx,
    { ...base, state: 'skipped', finishedAt: ctx.now, inputSummary: reason, output },
    ctx.now,
  );
  await ctx.tx
    .update(automationRuns)
    .set({ status: 'running', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
}
