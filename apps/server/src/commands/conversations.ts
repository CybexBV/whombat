/**
 * A conversation's own settings: its topic. A Whombat has no channels and no conversations between people
 * (one-agent.md OA-04): a person's rooms with the agent are made with them (`chats/`), a pull request's room by the
 * GitHub mirror.
 */
import { ConversationId, conversationLabel } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { conversations } from '../db/schema/index';
import { publishConversation } from '../domain/members';
import { notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';

export const updateConversation = defineCommand({
  name: 'update_conversation',
  schema: z.object({
    conversationId: ConversationId,
    topic: z.string().max(280).optional(),
  }),
  async apply(tx, ctx, input) {
    const row = await loadConversationRow(tx, input.conversationId);
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    if (input.topic === undefined || input.topic === row.topic) return { conversationId: row.id };
    const topic = input.topic;
    const label = conversationLabel(row);
    await tx.update(conversations).set({ topic }).where(eq(conversations.id, row.id));
    const event = await ctx.emit({
      type: 'conversation.updated',
      kind: 'System',
      text: `Changed the topic of ${label}`,
      where: label,
      payload: { conversationId: row.id, topic },
    });
    await publishConversation(ctx, row.id, event.id);
    return { conversationId: row.id };
  },
});
