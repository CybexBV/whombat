/**
 * Reading a thread of the person's Chat or Feedback room (`chats.readThread`, docs/decisions/thread-unread.md): private
 * per-viewer state, like a room's read marker. It moves the thread's marker (never backwards) and sends the room's fresh
 * badge to the person's devices, so a thread read on the phone stops showing as new on the web.
 */
import { MessageId } from '@whombat/core';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { publishUnread, unreadKey } from '../domain/messages';
import { notFound } from '../lib/errors';
import { loadConversationRow, unreadCounts } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import { chatRoomOf } from './rooms';
import { moveThreadReadMark, unreadInThread } from './unread';

export const readThread = defineCommand({
  name: 'read_thread',
  schema: z.object({ rootId: MessageId, messageId: MessageId }),
  async apply(tx, ctx, input) {
    const row = await loadMessageRow(tx, input.messageId);
    const rootId = row ? (row.threadRootId ?? row.id) : null;
    const conv =
      row && rootId === input.rootId && row.burrowId === ctx.burrow.id
        ? await loadConversationRow(tx, row.conversationId)
        : undefined;
    // Only a thread of the caller's own room; anything else isn't theirs to name.
    if (!row || !conv || conv.dmPersonId !== ctx.actor.id || !chatRoomOf(conv)) throw notFound('Thread');
    await moveThreadReadMark(tx, ctx.actor.id, input.rootId, row.ord, ctx.now);
    const [unread, room] = await Promise.all([
      unreadInThread(tx, ctx.actor.id, conv.id, input.rootId),
      unreadCounts(tx, ctx.actor.id, [conv.id]),
    ]);
    const services = ctx.services;
    // After the room's badges counted before this commit, so a stale count never lands after this one.
    ctx.background(
      'unread badges',
      () => publishUnread(services, ctx.burrow.id, conv.id, null),
      unreadKey(conv.id),
    );
    return {
      conversationId: conv.id,
      rootId: input.rootId,
      unread,
      roomUnread: room.get(conv.id)?.unread ?? 0,
    };
  },
});
