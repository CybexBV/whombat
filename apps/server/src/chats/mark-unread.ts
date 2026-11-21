/**
 * Marking a thread of the person's Chat or Feedback room unread (`chats.markUnread`, docs/decisions/chat-inbox.md
 * CIB-06): the newest message someone else wrote in it counts as new again. Private per-viewer state, like a read, and
 * the room's fresh badge goes to the person's devices.
 */
import { MessageId } from '@whombat/core';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { publishUnread, unreadKey } from '../domain/messages';
import { notFound } from '../lib/errors';
import { loadConversationRow, unreadCounts } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import { chatRoomOf } from './rooms';
import { moveThreadReadMarkBack, unreadInThread } from './unread';

export const markThreadUnread = defineCommand({
  name: 'mark_thread_unread',
  schema: z.object({ rootId: MessageId }),
  async apply(tx, ctx, input) {
    const root = await loadMessageRow(tx, input.rootId);
    const conv =
      root && !root.threadRootId && root.burrowId === ctx.burrow.id
        ? await loadConversationRow(tx, root.conversationId)
        : undefined;
    // Only a thread of the caller's own room; anything else isn't theirs to name.
    if (!root || !conv || conv.dmPersonId !== ctx.actor.id || !chatRoomOf(conv)) throw notFound('Thread');
    await moveThreadReadMarkBack(tx, ctx.actor.id, root.id, ctx.now);
    const [unread, room] = await Promise.all([
      unreadInThread(tx, ctx.actor.id, conv.id, root.id),
      unreadCounts(tx, ctx.actor.id, [conv.id]),
    ]);
    const services = ctx.services;
    ctx.background(
      'unread badges',
      () => publishUnread(services, ctx.burrow.id, conv.id, null),
      unreadKey(conv.id),
    );
    return { conversationId: conv.id, rootId: root.id, unread, roomUnread: room.get(conv.id)?.unread ?? 0 };
  },
});
