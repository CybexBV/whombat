/**
 * Clearing a person's Chat or Feedback room (docs/decisions/chat-clear.md CHC-01…CHC-07; contracts 0.119.0, CT-990):
 * `clear_chat` hides the room's top-level messages up to now from its view and from its assistant's window
 * (`conversations.room_cleared_at`); nothing is removed, and every thread stays in Threads. The Hermes sessions of the
 * room's top level go (hermes-engine.md HE-40).
 */
import { CHAT_ROOMS, topics } from '@whombat/core';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { moveReadMark } from '../commands/messages';
import { defineCommand } from '../commit/types';
import { conversations, messages } from '../db/schema/index';
import { publishUnread, unreadKey } from '../domain/messages';
import { forbidden, notFound } from '../lib/errors';
import { afterClear } from '../read/messages';
import { loadAgentRow, loadPrincipalRow } from '../read/principals';
import { dropSessions, topLevelSessions } from '../runtime/sessions';
import { FEEDBACK_ROOM_KEY, FEEDBACK_ROOM_TITLE } from './rooms';
import { settleRoomThreads } from './settle';

/** The audit event of a clear (CHC-06). */
export const CHAT_CLEARED_EVENT = 'chat.cleared';

export const clearChat = defineCommand({
  name: 'clear_chat',
  schema: z.object({ room: z.enum(CHAT_ROOMS).default('chat') }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you clear your Chat.');
    const person = await loadPrincipalRow(tx, ctx.actor.id);
    if (!person) throw notFound('Person');
    const agent = await loadAgentRow(tx, person.burrowId);
    const title = input.room === 'chat' ? 'Chat' : FEEDBACK_ROOM_TITLE;
    if (!agent) throw notFound(title);
    // The person's own room with their own assistant (CHC-02): the default DM, or the Feedback room by its key.
    const [room] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.kind, 'dm'),
          eq(conversations.dmAgentId, agent.id),
          eq(conversations.dmPersonId, person.id),
          input.room === 'chat'
            ? isNull(conversations.taskKey)
            : eq(conversations.taskKey, FEEDBACK_ROOM_KEY),
        ),
      )
      .for('update');
    if (!room) throw notFound(title);
    // Chat is an inbox of threads (chat-inbox.md CIB-13): clearing it settles every thread that may settle, so the
    // list empties; what the assistant works on or what waits for the person stays.
    await settleRoomThreads(tx, ctx, room, input.room, { onlyRead: false });

    const shown = and(
      eq(messages.conversationId, room.id),
      isNull(messages.threadRootId),
      afterClear(room.roomClearedAt),
    );
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(messages).where(shown);
    const answer = { room: input.room, conversationId: room.id };
    // An empty room keeps its mark: nothing to sign or tell (CHC-06).
    if (n === 0)
      return {
        ...answer,
        clearedAt: (room.roomClearedAt ?? ctx.now).toISOString(),
        cleared: 0,
        eventId: null,
      };

    await tx.update(conversations).set({ roomClearedAt: ctx.now }).where(eq(conversations.id, room.id));
    // Read up to its newest top-level message, so its badge clears (CHC-05).
    const [newest] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, room.id), isNull(messages.threadRootId)))
      .orderBy(desc(messages.ord))
      .limit(1);
    if (newest) await moveReadMark(tx, person.id, newest, ctx.now);
    // The agent's sessions of the room's top level are forgotten and deleted; a thread keeps its own (CHC-04, HE-40).
    await dropSessions(ctx, await topLevelSessions(tx, room.id));

    const event = await ctx.emit({
      type: CHAT_CLEARED_EVENT,
      kind: 'Messages',
      text: `Cleared ${title}`,
      where: title,
      payload: { conversationId: room.id, room: input.room, cleared: n },
    });
    const clearedAt = ctx.at;
    ctx.publish(
      topics.me(person.id),
      { type: 'chat.cleared', conversationId: room.id, room: input.room, clearedAt },
      { eventId: event.id },
    );
    const services = ctx.services;
    ctx.background(
      'unread badges',
      () => publishUnread(services, room.burrowId, room.id, null),
      unreadKey(room.id),
    );
    return { ...answer, clearedAt, cleared: n, eventId: event.id as string | null };
  },
});
