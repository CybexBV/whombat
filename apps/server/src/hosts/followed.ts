/**
 * Followed tasks in the database (task-feedback.md TF-10…TF-13; `follow.ts` is the follow-up's logic):
 *
 * - `hosts.follow_task` keeps a task a Whombat started (`followed_tasks`) and posts its live `task` card as that Whombat
 *   in the thread it was asked in, waking nobody.
 * - `hosts.task_ended` ends it once: the row and the card (updated in place, `message.updated`), Done recently's change
 *   when it ended well (TF-13), and the agent woken in that thread for the same person (`task_finished`, TF-12) — a
 *   queued such turn there takes up to `TASK_FINISHED_MAX` of them — or, when it can't be woken, the outcome posted
 *   there as one line.
 * - `taskFinishedOf` is a `task_finished` turn's `DispatchContext.taskFinished`.
 *
 * The bookkeeping of the follow-up itself (when a task was last asked about, deleting the ended ones after 30 days)
 * isn't anybody's change: it is written in a plain transaction.
 */

import {
  type DispatchContext,
  FollowedTaskId,
  newId,
  TASK_FINISHED_MAX,
  TASK_RESULT_MAX,
  TASK_SERVER_MAX,
  TASK_TITLE_MAX,
  type TaskCard,
  TaskEndState,
  topics,
} from '@whombat/core';
import { and, asc, count, eq, isNull, lt, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { readsRoom } from '../chats/rooms';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { dispatches, type FollowedTaskRow, followedTasks, messages } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { wakeQuietly } from '../domain/wake';
import { forbidden, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow, loadMessages } from '../read/messages';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { updateWork, workEnded } from '../things/quiet/window-work';
import { HostsChangeInput, recordHostsChange } from './commands';
import type { FollowedTask, NewFollowedTask, TaskEnd, TaskStore } from './follow';
import { endedChange } from './task-change';
import type { TaskWords } from './words';

/** What a followed task's change is sealed under (TF-13). */
export const followedChangeAad = (id: string) => `followed_task:${id}:change`;

/** At most `max` characters, never half a character. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** The card's running words: what Whombat is doing (“Installing 3 updates on shale”). */
export const taskTitle = (words: Pick<TaskWords, 'doing'>) => cut(words.doing, TASK_TITLE_MAX);

/** The thread a task is told in: its root when it is still a message of that conversation, else none (TF-S05). */
async function threadIn(ctx: ApplyContext, conversationId: string, rootId: string | null) {
  const root = rootId ? await loadMessageRow(ctx.tx, rootId) : null;
  return root && root.conversationId === conversationId && !root.deletedAt
    ? (root.threadRootId ?? root.id)
    : null;
}

/** The conversation, when the agent may post in it now: any conversation of the burrow. */
async function mayPost(ctx: ApplyContext, conversationId: string) {
  const conversation = await loadConversationRow(ctx.tx, conversationId);
  return conversation && conversation.burrowId === ctx.burrow.id ? conversation : null;
}

export const followTask = defineCommand({
  name: 'hosts.follow_task',
  schema: z.object({
    id: FollowedTaskId,
    serverId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(500),
    serverName: z.string().min(1).max(200),
    conversationId: z.string().min(1).max(64),
    threadRootId: z.string().max(64).nullable(),
    personId: z.string().max(64).nullable(),
    approvalId: z.string().max(64).nullable(),
    words: z.custom<TaskWords>(
      (v) => !!v && typeof v === 'object' && typeof (v as TaskWords).doing === 'string',
    ),
    changeEnc: z.string().nullable(),
  }),
  async apply(tx, ctx, input): Promise<FollowedTaskRow> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only Whombat follows a server’s task.');
    // A task is followed once, by the call that started it.
    const [known] = await tx
      .select()
      .from(followedTasks)
      .where(and(eq(followedTasks.serverId, input.serverId), eq(followedTasks.taskId, input.taskId)));
    if (known) return known;
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const threadRootId = await threadIn(ctx, conversation.id, input.threadRootId);
    const card: TaskCard = {
      kind: 'task',
      followedTaskId: input.id,
      serverId: input.serverId,
      server: cut(input.serverName, TASK_SERVER_MAX),
      title: taskTitle(input.words),
      state: 'running',
      startedAt: ctx.at,
      endedAt: null,
      result: null,
    };
    // The card is posted where the agent may post; the task is followed all the same (its end is still told there).
    const room = await mayPost(ctx, conversation.id);
    // Its words are the card's title, which clients fold into the card (anything else would show above it).
    const posted = room
      ? await postMessage(ctx, {
          conversation: room,
          text: card.title,
          card,
          threadRootId,
          dispatch: false,
          // The person just asked for it: its start isn't news to them.
          notifyDmPerson: false,
        })
      : null;
    const [row] = await tx
      .insert(followedTasks)
      .values({
        id: input.id,
        burrowId: ctx.burrow.id,
        serverId: input.serverId,
        taskId: input.taskId,
        conversationId: conversation.id,
        threadRootId,
        agentId: ctx.actor.id,
        personId: input.personId,
        approvalId: input.approvalId,
        words: input.words,
        serverName: card.server,
        messageId: posted?.id ?? null,
        state: 'running',
        startedAt: ctx.now,
        changeEnc: input.changeEnc,
      })
      .returning();
    if (!row) throw new Error('followed task not kept');
    return row;
  },
});

/** The task card says how it went (the stored card is patched; `message.updated`). */
async function settleCard(ctx: ApplyContext, row: FollowedTaskRow): Promise<void> {
  if (!row.messageId) return;
  const message = await loadMessageRow(ctx.tx, row.messageId);
  if (message?.card?.kind !== 'task' || message.deletedAt) return;
  const card: TaskCard = {
    ...message.card,
    state: row.state,
    endedAt: row.endedAt ? iso(row.endedAt) : null,
    result: row.result ? cut(row.result, TASK_RESULT_MAX) : null,
  };
  const [updated] = await ctx.tx
    .update(messages)
    .set({ card })
    .where(eq(messages.id, message.id))
    .returning();
  if (!updated) return;
  const [loaded] = await loadMessages(ctx.tx, [updated], null);
  if (loaded)
    ctx.publish(topics.conversation(updated.conversationId), { type: 'message.updated', message: loaded });
}

/**
 * The agent woken for an ended task (TF-12): a `task_finished` turn of it queued in the same conversation, thread and
 * for the same person, with room for one more, takes it; else a new one (never another kind of turn). Null when it
 * can't be woken there: also in the person's own room when the task was kept for nobody (an outsiders' turn) or for
 * someone no longer here, as such a turn couldn't read that room (one-person.md OP-S71).
 */
async function wakeFor(ctx: ApplyContext, row: FollowedTaskRow, threadRootId: string | null) {
  const personRow = row.personId ? await loadPrincipalRow(ctx.tx, row.personId) : null;
  const room = await loadConversationRow(ctx.tx, row.conversationId);
  if (!room || !readsRoom(room, personRow ?? null)) return null;
  const person = personRow?.accountId ?? null;
  const queued = await ctx.tx
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.agentId, row.agentId),
        eq(dispatches.conversationId, row.conversationId),
        eq(dispatches.state, 'queued'),
        eq(dispatches.trigger, 'task_finished'),
        threadRootId ? eq(dispatches.threadRootId, threadRootId) : isNull(dispatches.threadRootId),
        person ? eq(dispatches.onBehalfOfAccountId, person) : isNull(dispatches.onBehalfOfAccountId),
      ),
    )
    .orderBy(asc(dispatches.createdAt));
  for (const q of queued) {
    const [taken] = await ctx.tx
      .select({ n: count() })
      .from(followedTasks)
      .where(eq(followedTasks.dispatchId, q.id));
    if (Number(taken?.n ?? 0) < TASK_FINISHED_MAX) return q.id;
  }
  const woken = await wakeQuietly(ctx, {
    agentId: row.agentId,
    conversationId: row.conversationId,
    threadRootId,
    person,
    trigger: 'task_finished',
    coalesce: false,
    own: true,
  });
  return woken?.dispatchId ?? null;
}

export const endFollowedTask = defineCommand({
  name: 'hosts.task_ended',
  schema: z.object({
    id: FollowedTaskId,
    state: TaskEndState,
    result: z.string().min(1).max(TASK_RESULT_MAX),
    rebootRequired: z.boolean(),
    installed: z.number().int().min(0).nullable(),
    endedAt: z.iso.datetime({ offset: true }),
  }),
  async apply(tx, ctx, input): Promise<{ dispatchId: string | null; posted: boolean } | null> {
    // Once: a second end (the event and a check both heard it) changes nothing.
    const [row] = await tx
      .update(followedTasks)
      .set({
        state: input.state,
        endedAt: new Date(input.endedAt),
        result: input.result,
        rebootRequired: input.rebootRequired,
      })
      .where(
        and(
          eq(followedTasks.id, input.id),
          eq(followedTasks.burrowId, ctx.burrow.id),
          eq(followedTasks.agentId, ctx.actor.id),
          eq(followedTasks.state, 'running'),
        ),
      )
      .returning();
    if (!row) return null;
    await settleCard(ctx, row);
    // Done recently gets the change now that it is true, past tense with how it went (TF-13).
    if ((row.state === 'ok' || row.state === 'warning') && row.changeEnc) {
      const change = openChange(ctx, row);
      if (change) await recordHostsChange.apply(tx, ctx, endedChange(change, row, input.installed));
    }
    const threadRootId = await threadIn(ctx, row.conversationId, row.threadRootId);
    const dispatchId = await wakeFor(ctx, row, threadRootId);
    if (dispatchId) {
      await tx.update(followedTasks).set({ dispatchId }).where(eq(followedTasks.id, row.id));
      return { dispatchId, posted: false };
    }
    // Nobody to wake there: the outcome as one line, where it was asked (TF-04).
    const room = await mayPost(ctx, row.conversationId);
    if (!room) return { dispatchId: null, posted: false };
    await postMessage(ctx, { conversation: room, text: input.result, threadRootId, dispatch: false });
    return { dispatchId: null, posted: true };
  },
});

/** The change kept with a task, opened; null when there is none or it doesn't open (it is then not recorded). */
function openChange(ctx: ApplyContext, row: FollowedTaskRow): HostsChangeInput | null {
  if (!row.changeEnc) return null;
  try {
    const parsed = HostsChangeInput.safeParse(
      JSON.parse(ctx.services.custody.open(followedChangeAad(row.id), row.changeEnc)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const FOLLOWED_TASK_COMMANDS = [followTask, endFollowedTask];

const toFollowed = (row: FollowedTaskRow): FollowedTask => ({
  id: row.id,
  taskId: row.taskId,
  serverId: row.serverId,
  serverName: row.serverName,
  burrowId: row.burrowId,
  conversationId: row.conversationId,
  threadRootId: row.threadRootId,
  agentId: row.agentId,
  personId: row.personId,
  words: row.words,
  at: row.startedAt.getTime(),
});

/** The follow-up's store on these services: `followed_tasks` through the commit pipeline. */
export function dbTaskStore(services: Services): TaskStore {
  const { db } = services;
  return {
    async start(task: NewFollowedTask) {
      const id = newId('followedTask');
      const changeEnc = task.change
        ? services.custody.seal(followedChangeAad(id), JSON.stringify(task.change))
        : null;
      const res = await services.pipeline.commit(
        followTask,
        {
          id,
          serverId: task.serverId,
          taskId: task.taskId,
          serverName: task.serverName,
          conversationId: task.conversationId,
          threadRootId: task.threadRootId,
          personId: task.personId,
          approvalId: task.approvalId ?? null,
          words: task.words,
          changeEnc,
        },
        { burrowId: task.burrowId, actorId: task.agentId },
      );
      if (res.status !== 'ok') return null;
      // An earlier call already follows it: that one tells it.
      if (res.result.id !== id) return null;
      return toFollowed(res.result);
    },
    async running(serverId, taskId) {
      const [row] = await db
        .select()
        .from(followedTasks)
        .where(
          and(
            eq(followedTasks.serverId, serverId),
            eq(followedTasks.taskId, taskId),
            eq(followedTasks.state, 'running'),
          ),
        );
      return row ? toFollowed(row) : null;
    },
    async toAsk(filter, at) {
      return services.pipeline.transactAccount(async (tx) => {
        const rows = await tx
          .update(followedTasks)
          .set({ checkedAt: new Date(at) })
          .where(
            and(
              eq(followedTasks.state, 'running'),
              ...(filter
                ? [
                    lt(followedTasks.startedAt, new Date(filter.startedBefore)),
                    or(
                      isNull(followedTasks.checkedAt),
                      lt(followedTasks.checkedAt, new Date(filter.checkedBefore)),
                    ),
                  ]
                : []),
            ),
          )
          .returning();
        return rows.map(toFollowed);
      });
    },
    async end(task: FollowedTask, end: TaskEnd) {
      const res = await services.pipeline.commit(
        endFollowedTask,
        {
          id: task.id,
          state: end.state,
          result: end.words || task.words.what,
          rebootRequired: end.rebootRequired,
          installed: end.installed,
          endedAt: new Date(end.endedAt).toISOString(),
        },
        { burrowId: task.burrowId, actorId: task.agentId },
      );
      // An update Whombat installed is over: its server stays quiet 15 minutes more.
      await workEnded(services, updateWork(task.serverId, task.taskId), new Date(end.endedAt));
      return res.status === 'ok' && res.result !== null;
    },
    async sweep(before) {
      await services.pipeline.transactAccount((tx) =>
        tx
          .delete(followedTasks)
          .where(and(ne(followedTasks.state, 'running'), lt(followedTasks.endedAt, new Date(before)))),
      );
    },
  };
}

/** Whether the yes to this approval ran a call that started a followed task (its card says what happens, TF-10). */
export async function approvalStartedTask(db: Db, approvalId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: followedTasks.id })
    .from(followedTasks)
    .where(eq(followedTasks.approvalId, approvalId))
    .limit(1);
  return !!row;
}

/**
 * `DispatchContext.taskFinished` of a `task_finished` turn (TF-12): the tasks that woke it, in the order they ended,
 * at most `TASK_FINISHED_MAX`; null for any other turn or when none is left.
 */
export async function taskFinishedOf(
  db: Db,
  row: { id: string; trigger: string },
): Promise<DispatchContext['taskFinished']> {
  if (row.trigger !== 'task_finished') return null;
  const rows = await db
    .select()
    .from(followedTasks)
    .where(and(eq(followedTasks.dispatchId, row.id), ne(followedTasks.state, 'running')))
    .orderBy(asc(followedTasks.endedAt), asc(followedTasks.id))
    .limit(TASK_FINISHED_MAX);
  const out = rows.flatMap((r) =>
    r.state === 'running' || !r.endedAt
      ? []
      : [
          {
            followedTaskId: r.id,
            serverId: cut(r.serverId, 200),
            server: cut(r.serverName, TASK_SERVER_MAX),
            what: taskTitle(r.words),
            result: r.state,
            words: cut(r.result ?? '', TASK_RESULT_MAX),
            rebootRequired: r.rebootRequired,
            startedAt: iso(r.startedAt),
            endedAt: iso(r.endedAt),
          },
        ],
  );
  return out.length ? out : null;
}
