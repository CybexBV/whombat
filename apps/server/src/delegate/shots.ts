/**
 * A delegation task's pictures of what it changed (docs/decisions/delegate.md DLG-27, as the council's were, CNL-30…
 * CNL-33): `delegation.shot` keeps a before or after shot of a screen, `delegation.compare` the one picture Whombat drew
 * of them with its numbered areas, `delegation.notes` the task's plain-words note per number. The drawn picture goes on
 * the card's message at once (its row shows it); the shots it was drawn from go when the delegation ends
 * (`endDelegation`).
 */
import { COUNCIL_AREAS_MAX, COUNCIL_SHOT_NOTE_MAX, DELEGATION_TASK_SHOTS_MAX } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import {
  attachments,
  type DelegationRow,
  type DelegationTaskRow,
  delegationShots,
  delegations,
  delegationTasks,
} from '../db/schema/index';
import { putOnMessage } from '../files/commands';
import { conflict, forbidden, notFound } from '../lib/errors';
import { refreshCard } from './commands';

const Id = z.string().min(1).max(64);

/** The task for a picture: the agent's (the link is its task's), still live. */
async function taskOf(
  ctx: ApplyContext,
  taskId: string,
): Promise<{ task: DelegationTaskRow; d: DelegationRow }> {
  if (ctx.actor.kind !== 'agent') throw forbidden('Only a task sends its pictures.');
  const [row] = await ctx.tx
    .select({ task: delegationTasks, d: delegations })
    .from(delegationTasks)
    .innerJoin(delegations, eq(delegations.id, delegationTasks.delegationId))
    .where(and(eq(delegationTasks.id, taskId), eq(delegationTasks.burrowId, ctx.burrow.id)));
  if (!row) throw notFound('Task');
  if (row.d.stage !== 'working') throw conflict('This list ended.');
  return row;
}

export const delegationShot = defineCommand({
  name: 'delegation.shot',
  schema: z.object({
    taskId: Id,
    view: z.string().min(1).max(80),
    when: z.enum(['before', 'after']),
    attachmentId: Id,
  }),
  async apply(tx, ctx, input): Promise<{ beforeId: string | null; afterId: string | null }> {
    const { task, d } = await taskOf(ctx, input.taskId);
    const shots = await tx.select().from(delegationShots).where(eq(delegationShots.taskId, task.id));
    const shot = shots.find((s) => s.view === input.view);
    if (!shot && shots.length >= DELEGATION_TASK_SHOTS_MAX) throw conflict('too_many_screens');
    const replaced = shot ? (input.when === 'before' ? shot.beforeId : shot.afterId) : null;
    const set = input.when === 'before' ? { beforeId: input.attachmentId } : { afterId: input.attachmentId };
    const [row] = await tx
      .insert(delegationShots)
      .values({
        taskId: task.id,
        delegationId: d.id,
        burrowId: d.burrowId,
        view: input.view,
        position: shot?.position ?? shots.length,
        ...set,
        updatedAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [delegationShots.taskId, delegationShots.view],
        set: { ...set, updatedAt: ctx.now },
      })
      .returning();
    if (replaced && replaced !== input.attachmentId)
      await tx.update(attachments).set({ state: 'deleted' }).where(eq(attachments.id, replaced));
    return { beforeId: row?.beforeId ?? null, afterId: row?.afterId ?? null };
  },
});

export const delegationCompare = defineCommand({
  name: 'delegation.compare',
  schema: z.object({
    taskId: Id,
    view: z.string().min(1).max(80),
    compareId: Id,
    /** The shots it was drawn from: a newer one since makes it stale. */
    beforeId: Id,
    afterId: Id,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    areas: z
      .array(
        z.object({
          n: z.number().int().min(1).max(COUNCIL_AREAS_MAX),
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          w: z.number().int().positive(),
          h: z.number().int().positive(),
          where: z.string().min(1).max(60),
        }),
      )
      .max(COUNCIL_AREAS_MAX),
  }),
  async apply(tx, ctx, input): Promise<{ stale: boolean }> {
    const { task, d } = await taskOf(ctx, input.taskId);
    const [shot] = await tx
      .select()
      .from(delegationShots)
      .where(and(eq(delegationShots.taskId, task.id), eq(delegationShots.view, input.view)))
      .for('update');
    if (!shot) throw notFound('Screen');
    // Drawn from shots that were sent again meanwhile: the newer pair's picture is the one (or comes next).
    if (shot.beforeId !== input.beforeId || shot.afterId !== input.afterId) {
      await tx.update(attachments).set({ state: 'deleted' }).where(eq(attachments.id, input.compareId));
      return { stale: true };
    }
    await tx
      .update(delegationShots)
      .set({
        compareId: input.compareId,
        width: input.width,
        height: input.height,
        areas: input.areas,
        // New areas, new numbers: the old notes no longer say where they are.
        notes: [],
        updatedAt: ctx.now,
      })
      .where(and(eq(delegationShots.taskId, task.id), eq(delegationShots.view, input.view)));
    const replaced = shot.compareId && shot.compareId !== input.compareId ? [shot.compareId] : [];
    // The card's row shows it now: it is a file of the card's message.
    if (d.messageId)
      await putOnMessage(
        tx,
        ctx,
        { id: d.messageId, conversationId: d.conversationId },
        [input.compareId],
        replaced,
      );
    if (shot.compareId && shot.compareId !== input.compareId)
      await tx.update(attachments).set({ state: 'deleted' }).where(eq(attachments.id, shot.compareId));
    await refreshCard(ctx, d.id);
    return { stale: false };
  },
});

export const delegationNotes = defineCommand({
  name: 'delegation.notes',
  schema: z.object({
    taskId: Id,
    view: z.string().min(1).max(80),
    notes: z
      .array(
        z.object({
          n: z.number().int().min(1).max(COUNCIL_AREAS_MAX),
          text: z.string().min(1).max(COUNCIL_SHOT_NOTE_MAX),
        }),
      )
      .max(COUNCIL_AREAS_MAX),
  }),
  async apply(tx, ctx, input): Promise<{ kept: number }> {
    const { task, d } = await taskOf(ctx, input.taskId);
    const [shot] = await tx
      .select()
      .from(delegationShots)
      .where(and(eq(delegationShots.taskId, task.id), eq(delegationShots.view, input.view)));
    if (!shot) throw notFound('Screen');
    const mine = input.notes.filter((n) => shot.areas.some((a) => a.n === n.n));
    if (!mine.length) return { kept: 0 };
    const notes = [
      ...shot.notes.filter((n) => !mine.some((m) => m.n === n.n)),
      ...mine.map((m) => ({ n: m.n, text: m.text })),
    ].sort((a, b) => a.n - b.n);
    await tx
      .update(delegationShots)
      .set({ notes, updatedAt: ctx.now })
      .where(and(eq(delegationShots.taskId, task.id), eq(delegationShots.view, shot.view)));
    await refreshCard(ctx, d.id);
    return { kept: mine.length };
  },
});
