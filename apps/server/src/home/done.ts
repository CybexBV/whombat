/**
 * Done today (docs/decisions/done-today.md DN-01…DN-04): the tasks the agent finished, each in its own few words.
 *
 * - **`report_done`** (the person's turns, no key): the turn's thread gets the agent's words of what it did (“Checked
 *   the status of pve-01”), one row per thread; a later report there replaces the words and the time. Rows older than
 *   `DONE_KEEP_MS` go then too. The signed event carries ids, never the words.
 * - **`recentDoneTasks`**: the burrow's newest, for the desk's *Done today* and *Welcome back*. Home's Done recently stays
 *   the changes (with Undo, `changes.ts`).
 * - **`doneToday`**: the person's own since the start of their day, for what the status sentence says was fixed
 *   (status-line.md).
 */
import {
  CHANGE_UNDO_WINDOW_S,
  chatHref,
  chatRoomHref,
  chatThreadHref,
  DONE_TODAY_MAX,
  type DoneTodayItem,
  newId,
} from '@whombat/core';
import { and, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { changes, doneTasks, lookResearches } from '../db/schema/index';
import { forbidden } from '../lib/errors';
import type { PrincipalRow } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import { dispatchPerson, outsidersTurn } from '../runtime/person';
import { viewersChats } from './changes';
import { homeAudience, publishHomeChanged } from './notify';
import { undoStateOf } from './registry';
import { startOfLocalDay } from './time';

/** How long a finished task is kept: the screen shows today's, Welcome back a night's at most. */
export const DONE_KEEP_MS = 30 * 24 * 60 * 60_000;

/** The words as stored: one line, the contract's 60 characters (the screen clips again where it must). */
const Summary = z
  .string()
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1).max(60));

export const reportDoneCommand = defineCommand({
  name: 'report_done',
  schema: z.object({
    summary: Summary,
    conversationId: z.string().max(64),
    threadRootId: z.string().max(64).nullable(),
    personId: z.string().max(64).nullable(),
    dispatchId: z.string().max(64),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant says what it finished.');
    const thread = input.threadRootId
      ? eq(doneTasks.threadRootId, input.threadRootId)
      : isNull(doneTasks.threadRootId);
    const [earlier] = await tx
      .select({ id: doneTasks.id })
      .from(doneTasks)
      .where(and(eq(doneTasks.conversationId, input.conversationId), thread))
      .for('update');
    const fields = {
      agentId: ctx.actor.id,
      personId: input.personId,
      summary: input.summary,
      dispatchId: input.dispatchId,
      reportedAt: ctx.now,
    };
    const id = earlier?.id ?? newId('doneTask');
    if (earlier) await tx.update(doneTasks).set(fields).where(eq(doneTasks.id, id));
    else
      await tx.insert(doneTasks).values({
        id,
        burrowId: ctx.burrow.id,
        conversationId: input.conversationId,
        threadRootId: input.threadRootId,
        ...fields,
      });
    await tx
      .delete(doneTasks)
      .where(
        and(
          eq(doneTasks.burrowId, ctx.burrow.id),
          lt(doneTasks.reportedAt, new Date(ctx.now.getTime() - DONE_KEEP_MS)),
        ),
      );
    await ctx.emit({
      type: 'task.done',
      kind: 'System',
      text: null,
      where: null,
      payload: { doneTaskId: id, conversationId: input.conversationId },
    });
    // A task in one of the person's chats finished: Home and the desk read again (the desk on any home.changed).
    publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['working']);
    return { doneTaskId: id };
  },
});

export const DONE_COMMANDS = [reportDoneCommand];

/** What `report_done` records for a turn: its thread, for the person it is for. */
export async function doneInputFor(db: Db, dispatch: DispatchRow, summary: string) {
  // Served only in the person's turns; a search answer has no thread of its own to have finished.
  if (outsidersTurn(dispatch) || dispatch.search)
    throw forbidden('report_done is only for what you did in the person’s own chats.');
  const person = await dispatchPerson(db, dispatch);
  return {
    summary,
    conversationId: dispatch.conversationId,
    threadRootId: dispatch.threadRootId,
    personId: person?.id ?? null,
    dispatchId: dispatch.id,
  };
}

/** A finished task as the desk reads it: its words and when. */
export interface DoneTask {
  text: string;
  at: string;
}

/** The burrow's newest `limit` finished tasks, newest first. */
export async function recentDoneTasks(db: Db, burrowId: string, limit: number): Promise<DoneTask[]> {
  const rows = await db
    .select({ summary: doneTasks.summary, at: doneTasks.reportedAt })
    .from(doneTasks)
    .where(eq(doneTasks.burrowId, burrowId))
    .orderBy(desc(doneTasks.reportedAt), desc(doneTasks.id))
    .limit(limit);
  return rows.map((r) => ({ text: r.summary, at: r.at.toISOString() }));
}

/** A thread's key: its conversation and root (`''` for the top of a flat conversation). */
const threadKey = (conversationId: string | null, rootId: string | null) =>
  `${conversationId}|${rootId ?? ''}`;

/**
 * Done today (status-line.md): what the assistant finished for `viewer` since the start of their day, newest
 * first. Each says where it was done (the thread in their Chat, or the task chat), whether it fixed a look (its research
 * in that thread ended fixed; the look's fix reports there, look-research.md), and the change made in that thread that
 * can still be undone when there is exactly one: with several, Undo would have to guess which, so the row leaves it to
 * Everything I did.
 */
export async function doneToday(
  db: Db,
  viewer: PrincipalRow,
  now: Date,
  timeZone: string,
): Promise<DoneTodayItem[]> {
  const rows = await db
    .select({
      id: doneTasks.id,
      conversationId: doneTasks.conversationId,
      threadRootId: doneTasks.threadRootId,
      summary: doneTasks.summary,
      at: doneTasks.reportedAt,
    })
    .from(doneTasks)
    .where(
      and(
        eq(doneTasks.burrowId, viewer.burrowId),
        eq(doneTasks.personId, viewer.id),
        gte(doneTasks.reportedAt, startOfLocalDay(now, timeZone)),
      ),
    )
    .orderBy(desc(doneTasks.reportedAt), desc(doneTasks.id))
    .limit(DONE_TODAY_MAX);
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.conversationId))];
  const [chats, fixedRows, undoRows] = await Promise.all([
    viewersChats(db, viewer.id, ids),
    db
      .select({ conversationId: lookResearches.conversationId, threadRootId: lookResearches.threadRootId })
      .from(lookResearches)
      .where(
        and(
          eq(lookResearches.burrowId, viewer.burrowId),
          eq(lookResearches.state, 'fixed'),
          inArray(lookResearches.conversationId, ids),
        ),
      ),
    db
      .select()
      .from(changes)
      .where(
        and(
          eq(changes.burrowId, viewer.burrowId),
          inArray(changes.conversationId, ids),
          isNull(changes.undoneAt),
          gte(changes.createdAt, new Date(now.getTime() - CHANGE_UNDO_WINDOW_S * 1000)),
        ),
      ),
  ]);
  const fixed = new Set(fixedRows.map((r) => threadKey(r.conversationId, r.threadRootId)));
  const undoable = new Map<string, NonNullable<DoneTodayItem['undo']>[]>();
  for (const row of undoRows) {
    const undo = undoStateOf(row, now);
    if (undo.state !== 'available' || row.undoAskedAt) continue;
    const key = threadKey(row.conversationId, row.threadRootId);
    undoable.set(key, [
      ...(undoable.get(key) ?? []),
      { changeId: row.id, ...(undo.until ? { until: undo.until } : {}) },
    ]);
  }
  return rows.map((r) => {
    const key = threadKey(r.conversationId, r.threadRootId);
    const chat = chats.get(r.conversationId);
    const href = !chat
      ? undefined
      : chat === true
        ? chatHref(r.conversationId)
        : r.threadRootId
          ? chatThreadHref(chat, r.threadRootId)
          : chatRoomHref(chat);
    const undo = undoable.get(key);
    const only = undo?.length === 1 ? undo[0] : undefined;
    return {
      id: r.id,
      text: r.summary,
      at: r.at.toISOString(),
      ...(href ? { href } : {}),
      ...(fixed.has(key) ? { fixed: true as const } : {}),
      ...(only ? { undo: only } : {}),
    };
  });
}
