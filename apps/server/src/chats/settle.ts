/**
 * Settling threads of a person's Chat or Feedback room (docs/decisions/chat-settle.md): a finished thread is put away
 * on its first message (`messages.settled_at`, `settled_how`), nothing is removed, and it opens again by hand or with
 * any new message (`postMessage` calls `threadOpenedByMessage`). Never while the agent works on it or something in it
 * waits for the person.
 *
 * - `settle_thread` (`chats.settle`): the person settles one thread, or opens a settled one again, which keeps it open
 *   until its next message (`kept_open_at`).
 * - `settle_finished_threads` (`chats.settleFinished`): every open thread of the room that may settle.
 * - `settle_threads_by_themselves`: the automatic round's commit for one room, signed by its agent because nobody acted
 *   (as an old guide card expires). `settleRound` runs it for every room every 15 minutes.
 *
 * Settling leaves the thread's Hermes session alone: a turn holds its place in the person's Hermes only while it runs,
 * and the runtime can only delete a session, which would make the thread forget when it opens again.
 */
import {
  CHAT_ROOMS,
  type ChatRoom,
  ConversationId,
  MessageId,
  type ThreadSettle,
  type ThreadSettledHow,
  topics,
} from '@whombat/core';
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { accounts, conversations, messages, principals } from '../db/schema/index';
import { publishUnread, unreadKey } from '../domain/messages';
import { conflict, forbidden, notFound } from '../lib/errors';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { loadMessages } from '../read/messages';
import { loadAgentRow, loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { chatRoomOf, FEEDBACK_ROOM_KEY, FEEDBACK_ROOM_TITLE } from './rooms';
import {
  apartInTime,
  autoSettle,
  chatPreferencesOf,
  quietCutoff,
  settleRefusal,
  threadSettleOf,
} from './settle-rules';
import { endedThreads, pinnedThreads, type ThreadRoom, waitingThreads, workingThreads } from './thread-state';
import { readThreadsToEnd, unreadRootIds } from './unread';

/** The signed events (ids and counts only, never words). */
export const CHAT_THREAD_SETTLED_EVENT = 'chat.thread_settled';
export const CHAT_THREAD_OPENED_EVENT = 'chat.thread_opened';
export const CHAT_THREADS_SETTLED_EVENT = 'chat.threads_settled';

/** How often the automatic round runs. */
export const SETTLE_ROUND_MS = 15 * 60_000;
/** The most threads one round settles in a room; the rest wait for the next round. */
const ROUND_BATCH = 500;

const NOT_YOURS = 'Only you settle your threads.';

/** “Chat” or “Feedback”: where the audit log says it happened. */
function roomTitle(room: ChatRoom): string {
  return room === 'chat' ? 'Chat' : FEEDBACK_ROOM_TITLE;
}

function threadRoomOf(conv: ConversationRow): ThreadRoom {
  return {
    burrowId: conv.burrowId,
    conversationId: conv.id,
    agentId: conv.dmAgentId as string,
    personId: conv.dmPersonId as string,
  };
}

/** The room's top-level messages that are open threads (deleted first messages are no threads any more). */
function openThreads(conversationId: string) {
  return and(
    eq(messages.conversationId, conversationId),
    isNull(messages.threadRootId),
    isNull(messages.settledAt),
    isNull(messages.deletedAt),
  );
}

/** Tells the person's apps (topic `me`): one thread, or several at once (`rootId` null, they read the room again). */
function publishSettled(
  ctx: ApplyContext,
  conv: ConversationRow,
  room: ChatRoom,
  rootId: string | null,
  settled: ThreadSettle | null,
  eventId: string,
): void {
  ctx.publish(
    topics.me(conv.dmPersonId as string),
    { type: 'chat.settled', conversationId: conv.id, room, rootId, settled },
    { eventId },
  );
  // A settled thread counts for nothing in the room's badge, and one opened again may count again (thread-unread.md).
  const services = ctx.services;
  ctx.background(
    'unread badges',
    () => publishUnread(services, conv.burrowId, conv.id, null),
    unreadKey(conv.id),
  );
}

/** The thread's first message as the room shows it now, to whoever has the room open. */
async function publishRoot(ctx: ApplyContext, conversationId: string, rootId: string, eventId: string) {
  const rows = await ctx.tx.select().from(messages).where(eq(messages.id, rootId));
  const [message] = await loadMessages(ctx.tx, rows, null);
  if (message)
    ctx.publish(topics.conversation(conversationId), { type: 'message.updated', message }, { eventId });
}

/** A new message in a settled thread opened it again (`postMessage` cleared its columns in the same transaction). */
export async function threadOpenedByMessage(
  ctx: ApplyContext,
  conv: ConversationRow,
  rootId: string,
): Promise<void> {
  const room = chatRoomOf(conv);
  if (!room || !conv.dmPersonId) return;
  const event = await ctx.emit({
    type: CHAT_THREAD_OPENED_EVENT,
    kind: 'Messages',
    text: null,
    where: roomTitle(room),
    payload: { conversationId: conv.id, rootId, by: 'message' },
  });
  publishSettled(ctx, conv, room, rootId, null, event.id);
}

/**
 * Settles the threads where the assistant looked into a problem by itself, once that problem went away
 * (docs/decisions/look-research.md): `resolved`, now, unless the agent works on one, something in it waits for the
 * person, it is pinned or the person opened it again by hand (CHS-03, CHS-05). Nobody acted, so the events have no text.
 */
export async function settleResolvedThreads(
  ctx: ApplyContext,
  conversationId: string,
  rootIds: readonly string[],
): Promise<number> {
  const conv = await loadConversationRow(ctx.tx, conversationId);
  const room = conv && conv.burrowId === ctx.burrow.id ? chatRoomOf(conv) : null;
  const ids = [...new Set(rootIds)];
  if (!conv || !room || !ids.length) return 0;
  const where = threadRoomOf(conv);
  const [working, waiting, pinned] = await Promise.all([
    workingThreads(ctx.tx, where, ids, { handedOver: true }),
    waitingThreads(ctx.tx, where, ids),
    pinnedThreads(ctx.tx, where, ids),
  ]);
  const free = ids.filter((id) => !working.has(id) && !waiting.has(id) && !pinned.has(id));
  if (!free.length) return 0;
  // Now, a millisecond apart, the latest activity first: the shelf pages by when threads settled, so threads that share
  // a moment there would be skipped at a page's end.
  const rows = await ctx.tx.execute<{ id: string; settled_at: Date | string }>(sql`
    update messages m
       set settled_at = ${ctx.at}::timestamptz - (r.n * interval '1 millisecond'), settled_how = 'resolved'
      from (select id, row_number() over (order by coalesce(last_reply_at, created_at) desc, id desc) - 1 as n
              from messages
             where ${and(openThreads(conv.id), isNull(messages.keptOpenAt), inArray(messages.id, free))}) r
     where m.id = r.id
    returning m.id, m.settled_at`);
  for (const { id, settled_at } of rows) {
    const settled = threadSettleOf({ settledAt: new Date(settled_at), settledHow: 'resolved' });
    const event = await ctx.emit({
      type: CHAT_THREAD_SETTLED_EVENT,
      kind: 'Messages',
      text: null,
      where: roomTitle(room),
      payload: { conversationId: conv.id, rootId: id, how: 'resolved' },
    });
    publishSettled(ctx, conv, room, id, settled, event.id);
    await publishRoot(ctx, conv.id, id, event.id);
  }
  return rows.length;
}

/** What the agent is called in a refusal. */
async function agentName(db: Db, conv: ConversationRow): Promise<string | null> {
  const agent = conv.dmAgentId ? await loadPrincipalRow(db, conv.dmAgentId) : undefined;
  return agent?.name ?? null;
}

export const settleThread = defineCommand({
  name: 'settle_thread',
  schema: z.object({ rootId: MessageId, settled: z.boolean() }),
  async apply(tx, ctx, input) {
    // The agent has no way to settle: settling is the person's tidying, or the automatic round's.
    if (ctx.actor.kind !== 'person') throw forbidden(NOT_YOURS);
    const [root] = await tx.select().from(messages).where(eq(messages.id, input.rootId)).for('update');
    const conv =
      root && !root.threadRootId && !root.deletedAt
        ? await loadConversationRow(tx, root.conversationId)
        : undefined;
    // Only the caller's own room; someone else's thread is never named.
    const room =
      conv && conv.burrowId === ctx.burrow.id && conv.dmPersonId === ctx.actor.id ? chatRoomOf(conv) : null;
    if (!root || !conv || !room) throw notFound('Thread');
    const answer = { conversationId: conv.id, room, rootId: root.id };
    if (input.settled === (root.settledAt !== null)) return { ...answer, changed: false };

    let eventId: string;
    let settled: ThreadSettle | null = null;
    if (input.settled) {
      const where = threadRoomOf(conv);
      const [working, waiting] = await Promise.all([
        workingThreads(tx, where, [root.id], { handedOver: true }),
        waitingThreads(tx, where, [root.id]),
      ]);
      const refusal = settleRefusal(
        { working: working.has(root.id), waiting: waiting.has(root.id) },
        await agentName(tx, conv),
      );
      if (refusal) throw conflict(refusal);
      await tx
        .update(messages)
        .set({ settledAt: ctx.now, settledHow: 'person', keptOpenAt: null })
        .where(eq(messages.id, root.id));
      // Put away by hand means done with it: opened again, it doesn't come back as new.
      await readThreadsToEnd(tx, ctx.actor.id, [root.id], ctx.now);
      settled = threadSettleOf({ settledAt: ctx.now, settledHow: 'person' });
      eventId = (
        await ctx.emit({
          type: CHAT_THREAD_SETTLED_EVENT,
          kind: 'Messages',
          text: `Settled a thread in ${roomTitle(room)}`,
          where: roomTitle(room),
          payload: { conversationId: conv.id, rootId: root.id, how: 'person' },
        })
      ).id;
    } else {
      // Open again (or Undo): kept open, so the automatic round leaves it until its next message.
      await tx
        .update(messages)
        .set({ settledAt: null, settledHow: null, keptOpenAt: ctx.now })
        .where(eq(messages.id, root.id));
      eventId = (
        await ctx.emit({
          type: CHAT_THREAD_OPENED_EVENT,
          kind: 'Messages',
          text: `Opened a thread again in ${roomTitle(room)}`,
          where: roomTitle(room),
          payload: { conversationId: conv.id, rootId: root.id, by: 'person' },
        })
      ).id;
    }
    publishSettled(ctx, conv, room, root.id, settled, eventId);
    await publishRoot(ctx, conv.id, root.id, eventId);
    return { ...answer, changed: true };
  },
});

/** The person's own Chat (the default DM) or Feedback room with their assistant, locked; or a plain refusal. */
async function ownRoom(ctx: ApplyContext, room: ChatRoom): Promise<ConversationRow> {
  if (ctx.actor.kind !== 'person') throw forbidden(NOT_YOURS);
  const agent = await loadAgentRow(ctx.tx, ctx.burrow.id);
  if (!agent) throw notFound(roomTitle(room));
  const [row] = await ctx.tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.kind, 'dm'),
        eq(conversations.dmAgentId, agent.id),
        eq(conversations.dmPersonId, ctx.actor.id),
        room === 'chat' ? isNull(conversations.taskKey) : eq(conversations.taskKey, FEEDBACK_ROOM_KEY),
      ),
    )
    .for('update');
  if (!row) throw notFound(roomTitle(room));
  return row;
}

/** “Settled 1 thread in Chat”, “Settled 4 threads in Feedback”. */
function settledText(n: number, room: ChatRoom): string {
  return `Settled ${n} ${n === 1 ? 'thread' : 'threads'} in ${roomTitle(room)}`;
}

/**
 * Settles every open thread of the person's room that may settle (`how: person`), the latest activity first a
 * millisecond apart: pinned ones, ones the agent works on or that wait stay, and with `onlyRead` the ones with something
 * new (chat-inbox.md CIB-07). Signs one event and sends one frame when anything settled. Answers how many.
 */
export async function settleRoomThreads(
  tx: Tx,
  ctx: ApplyContext,
  conv: ConversationRow,
  room: ChatRoom,
  options: { onlyRead: boolean },
): Promise<number> {
  const where = threadRoomOf(conv);
  // Pinned threads stay open: a pin is the person's way to keep something in view, and this tidies what is done.
  const [working, waiting, pinned, unread] = await Promise.all([
    workingThreads(tx, where, null, { handedOver: true }),
    waitingThreads(tx, where, null),
    pinnedThreads(tx, where, null),
    options.onlyRead ? unreadRootIds(tx, ctx.actor.id, conv.id) : new Set<string>(),
  ]);
  const kept = [...new Set([...working, ...waiting, ...pinned, ...unread])];
  // Now, a millisecond apart, the latest activity first: the shelf pages by when threads settled.
  const done = await tx.execute<{ id: string }>(sql`
    update messages m
       set settled_at = ${ctx.at}::timestamptz - (r.n * interval '1 millisecond'),
           settled_how = 'person', kept_open_at = null
      from (select id, row_number() over (order by coalesce(last_reply_at, created_at) desc, id desc) - 1 as n
              from messages
             where ${and(openThreads(conv.id), kept.length ? notInArray(messages.id, kept) : undefined)}) r
     where m.id = r.id
    returning m.id`);
  // Nothing to settle: nothing to sign or tell.
  if (!done.length) return 0;
  await readThreadsToEnd(
    tx,
    ctx.actor.id,
    done.map((r) => r.id),
    ctx.now,
  );
  const event = await ctx.emit({
    type: CHAT_THREADS_SETTLED_EVENT,
    kind: 'Messages',
    text: settledText(done.length, room),
    where: roomTitle(room),
    payload: { conversationId: conv.id, room, count: done.length, how: 'person' },
  });
  publishSettled(
    ctx,
    conv,
    room,
    null,
    threadSettleOf({ settledAt: ctx.now, settledHow: 'person' }),
    event.id,
  );
  return done.length;
}

export const settleFinishedThreads = defineCommand({
  name: 'settle_finished_threads',
  schema: z.object({ room: z.enum(CHAT_ROOMS).default('chat'), onlyRead: z.boolean().default(false) }),
  async apply(tx, ctx, input) {
    const conv = await ownRoom(ctx, input.room);
    const settled = await settleRoomThreads(tx, ctx, conv, input.room, { onlyRead: input.onlyRead });
    return { room: input.room, conversationId: conv.id, settled };
  },
});

/** The person's Chat preferences, by the account behind their principal. */
async function chatPreferencesOfPerson(db: Db, personId: string) {
  const [row] = await db
    .select({ preferences: accounts.preferences })
    .from(principals)
    .innerJoin(accounts, eq(accounts.id, principals.accountId))
    .where(eq(principals.id, personId));
  return chatPreferencesOf(row?.preferences);
}

/**
 * One room's automatic round, in its own transaction holding the burrow's lock, so what it reads is what it settles: a
 * message or the person's action that came first wins. Open threads nobody kept open or pinned, that the agent doesn't
 * work on and that wait for nobody, settle `quiet` after the person's quiet days or `merged` once their pull request
 * merged or closed.
 */
export const settleThreadsByThemselves = defineCommand({
  name: 'settle_threads_by_themselves',
  schema: z.object({ conversationId: ConversationId }),
  async apply(tx, ctx, input) {
    const conv = await loadConversationRow(tx, input.conversationId);
    const room = conv && conv.burrowId === ctx.burrow.id ? chatRoomOf(conv) : null;
    if (!conv || !room) throw notFound('Chat');
    if (ctx.actor.kind !== 'agent' || conv.dmAgentId !== ctx.actor.id) throw forbidden(NOT_YOURS);
    const nothing = { room, conversationId: conv.id, settled: 0 };
    const prefs = await chatPreferencesOfPerson(tx, conv.dmPersonId as string);
    if (prefs.settleQuietDays === null && !prefs.settleMerged) return nothing;

    const where = threadRoomOf(conv);
    const lastAt = sql<Date>`coalesce(${messages.lastReplyAt}, ${messages.createdAt})`;
    const candidates = and(openThreads(conv.id), isNull(messages.keptOpenAt));
    const ended = prefs.settleMerged ? await endedThreads(tx, where, null) : new Map<string, Date>();
    const cutoff = prefs.settleQuietDays !== null ? quietCutoff(ctx.now, prefs.settleQuietDays) : null;
    if (!cutoff && !ended.size) return nothing;
    const rows = await tx
      .select({ id: messages.id, lastAt })
      .from(messages)
      .where(
        and(
          candidates,
          or(
            cutoff ? sql`${lastAt} <= ${cutoff.toISOString()}::timestamptz` : undefined,
            ended.size ? inArray(messages.id, [...ended.keys()]) : undefined,
          ),
        ),
      )
      .orderBy(asc(lastAt))
      .limit(ROUND_BATCH);
    if (!rows.length) return nothing;

    // A thread with something the person hasn't read stays open (chat-inbox.md CIB-08).
    const [working, waiting, pinned, unread] = await Promise.all([
      workingThreads(tx, where, null, { handedOver: true }),
      waitingThreads(tx, where, null),
      pinnedThreads(tx, where, null),
      unreadRootIds(tx, conv.dmPersonId as string, conv.id),
    ]);
    const settles = rows.flatMap((r) => {
      const settle = autoSettle(
        {
          lastAt: new Date(r.lastAt),
          keptOpen: false,
          unread: unread.has(r.id),
          pinned: pinned.has(r.id),
          working: working.has(r.id),
          waiting: waiting.has(r.id),
          endedAt: ended.get(r.id) ?? null,
        },
        prefs,
        ctx.now,
      );
      return settle ? [{ id: r.id, settle }] : [];
    });
    for (const { id, settle } of apartInTime(settles))
      await tx
        .update(messages)
        .set({ settledAt: new Date(settle.at), settledHow: settle.how })
        .where(and(eq(messages.id, id), candidates));
    if (!settles.length) return nothing;

    // One event per way they settled, and one frame for the room.
    const byHow = new Map<ThreadSettledHow, number>();
    for (const { settle } of settles) byHow.set(settle.how, (byHow.get(settle.how) ?? 0) + 1);
    let eventId = '';
    for (const [how, n] of byHow)
      eventId = (
        await ctx.emit({
          type: CHAT_THREADS_SETTLED_EVENT,
          kind: 'Messages',
          // Nobody acted: kept out of what the audit log lists.
          text: null,
          where: roomTitle(room),
          payload: { conversationId: conv.id, room, count: n, how },
        })
      ).id;
    const newest = settles.reduce((a, b) => (Date.parse(b.settle.at) > Date.parse(a.settle.at) ? b : a));
    publishSettled(ctx, conv, room, null, newest.settle, eventId);
    return { ...nothing, settled: settles.length };
  },
});

/**
 * The automatic round: each person's Chat and Feedback room with their assistant, one commit each. Returns how many
 * threads settled.
 */
export async function settleRound(services: Services, now = services.clock()): Promise<number> {
  if (services.maintenance.held) return 0;
  // The rooms of the burrows' agents: one whose agent is gone has nobody to sign for it.
  const rooms = await services.db
    .select({ id: conversations.id, burrowId: conversations.burrowId, agentId: principals.id })
    .from(conversations)
    .innerJoin(principals, and(eq(principals.id, conversations.dmAgentId), eq(principals.kind, 'agent')))
    .where(
      and(
        eq(conversations.kind, 'dm'),
        isNotNull(conversations.dmPersonId),
        or(isNull(conversations.taskKey), eq(conversations.taskKey, FEEDBACK_ROOM_KEY)),
      ),
    );
  let settled = 0;
  for (const room of rooms) {
    try {
      const done = await services.pipeline.commit(
        settleThreadsByThemselves,
        { conversationId: room.id },
        { burrowId: room.burrowId, actorId: room.agentId, now },
      );
      if (done.status === 'ok') settled += done.result.settled;
    } catch (err) {
      services.log.warn({ err: String(err), conversationId: room.id }, 'settling threads: a room failed');
    }
  }
  return settled;
}

const rounds = new WeakMap<Services, () => void>();

/** Every 15 minutes on the housekeeping tick, while this process writes. */
export function startSettleRound(services: Services): void {
  if (rounds.has(services)) return;
  rounds.set(
    services,
    services.housekeeping.add('chats.settle', SETTLE_ROUND_MS, () => settleRound(services)),
  );
}
