/**
 * Run controls from the run page: Pause, Resume and Take over. The runner learns about them from its
 * progress heartbeat (runner phase); here they change the run and are signed.
 */
import { NumberParam, topics } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import { dispatches, runs } from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { followPlanWork } from '../domain/plan-follow';
import { ApiError, forbidden, notFound } from '../lib/errors';
import { loadPrincipalRow, shortName } from '../read/principals';
import { loadRun, runByNumber } from '../read/work';
import { publishDispatch } from '../runtime/activity';
import { cardThread } from '../runtime/dispatch-scope';

async function runFor(ctx: ApplyContext, number: number) {
  const row = await runByNumber(ctx.tx, ctx.burrow.id, number);
  if (!row) throw notFound('Run');
  const own = ctx.actor.kind === 'agent' && ctx.actor.id === row.agentId;
  if (ctx.actor.kind === 'agent' && !own) throw forbidden('Agents only control their own runs.');
  const agent = await loadPrincipalRow(ctx.tx, row.agentId);
  return { row, agentName: agent?.name ?? 'the agent' };
}

export async function publishRun(ctx: ApplyContext, runId: string, eventId: string | null) {
  // Plan steps linked to the run follow its status (work-supervision WS-05); unchanged status writes nothing.
  await followPlanWork(ctx, { kind: 'run', id: runId });
  const run = await loadRun(ctx.tx, runId);
  if (!run) return;
  ctx.publish(topics.run(run.id), { type: 'run.updated', run }, { eventId });
  ctx.publish(topics.burrow(run.burrowId), { type: 'run.updated', run }, { eventId });
  const services = ctx.services;
  const burrowSlug = ctx.burrow.slug;
  // Push delivery doesn't hold the response; one run's updates go in order (server-efficiency.md SV-02).
  ctx.background(
    'run live activity',
    async () => {
      const agent = await loadPrincipalRow(services.db, run.agentId);
      await services.liveActivity.onRunChanged(run, agent ? shortName(agent) : 'The agent', burrowSlug);
    },
    `live:run:${run.id}`,
  );
}

export const pauseRun = defineCommand({
  name: 'pause_run',
  schema: z.object({ number: NumberParam }),
  async apply(tx, ctx, input) {
    const { row, agentName } = await runFor(ctx, input.number);
    if (row.status !== 'live') throw new ApiError('conflict', 'Only a live run can be paused.');
    await tx
      .update(runs)
      .set({ status: 'paused', pausedById: ctx.actor.id, updatedAt: ctx.now })
      .where(eq(runs.id, row.id));
    const event = await ctx.emit({
      type: 'run.paused',
      kind: 'Code',
      text: `Paused ${agentName}’s run #${row.number}`,
      where: `Run #${row.number}`,
      aboutId: row.agentId,
      ref: { type: 'run', number: row.number },
      payload: { runId: row.id },
    });
    await publishRun(ctx, row.id, event.id);
    return { runId: row.id };
  },
});

export const resumeRun = defineCommand({
  name: 'resume_run',
  // Resuming wakes the agent again: a new agent turn, the run retry of LC-10.
  licence: 'agentTurn',
  schema: z.object({ number: NumberParam }),
  async apply(tx, ctx, input) {
    const { row, agentName } = await runFor(ctx, input.number);
    if (row.status !== 'paused') throw new ApiError('conflict', 'Only a paused run can be resumed.');
    // A person's Pause holds until a person resumes: the agent may only undo a pause of its own.
    if (ctx.actor.kind === 'agent' && row.pausedById !== ctx.actor.id)
      throw forbidden('A person paused this run, so only a person can resume it.');
    await tx
      .update(runs)
      .set({ status: 'live', pausedById: null, attention: null, stalledAt: null, updatedAt: ctx.now })
      .where(eq(runs.id, row.id));
    const event = await ctx.emit({
      type: 'run.resumed',
      kind: 'Code',
      text: `Resumed ${agentName}’s run #${row.number}`,
      where: `Run #${row.number}`,
      aboutId: row.agentId,
      ref: { type: 'run', number: row.number },
      payload: { runId: row.id },
    });
    await publishRun(ctx, row.id, event.id);
    const services = ctx.services;
    const burrowId = ctx.burrow.id;
    const causedById = ctx.actor.id;
    const at = ctx.now;
    // In the run card's thread, where the run was asked for (VA-02).
    const threadRootId = await cardThread(tx, row.messageId);
    ctx.after(async () => {
      await enqueueDispatches(services, {
        burrowId,
        causedById,
        conversationId: row.conversationId,
        messageId: row.messageId,
        threadRootId,
        requests: [{ agentId: row.agentId, trigger: 'run_control', mode: 'run' }],
        at,
        runId: row.id,
      });
    });
    return { runId: row.id };
  },
});

export const takeOverRun = defineCommand({
  name: 'take_over_run',
  schema: z.object({ number: NumberParam }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only a person can take over a run.');
    const { row, agentName } = await runFor(ctx, input.number);
    if (row.status !== 'live' && row.status !== 'paused')
      throw new ApiError('conflict', 'This run has already finished.');
    await tx
      .update(runs)
      .set({
        status: 'taken_over',
        takenOverById: ctx.actor.id,
        summary: `${ctx.actor.shortName} took over ${row.branch}.`,
        updatedAt: ctx.now,
      })
      .where(eq(runs.id, row.id));
    const stopped = await tx
      .update(dispatches)
      .set({ state: 'cancelled', finishedAt: ctx.now, error: 'taken_over' })
      .where(and(eq(dispatches.runId, row.id), inArray(dispatches.state, ['queued', 'claimed', 'running'])))
      .returning();
    for (const d of stopped) publishDispatch(ctx, d);
    const event = await ctx.emit({
      type: 'run.taken_over',
      kind: 'Code',
      text: `Took over ${agentName}’s run #${row.number} on ${row.branch}`,
      where: `Run #${row.number}`,
      aboutId: row.agentId,
      ref: { type: 'run', number: row.number },
      payload: { runId: row.id, branch: row.branch },
    });
    await publishRun(ctx, row.id, event.id);
    return { runId: row.id, branch: row.branch };
  },
});
