/**
 * A conversation's own settings: its topic and its link previews (docs/decisions/essentials-conversations.md EC-23). A
 * Whombat has no channels and no conversations between people (one-agent.md OA-04): a person's rooms with the agent are
 * made with them (`chats/`), a pull request's room by the GitHub mirror.
 */
import { ConversationId, conversationLabel } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { conversations } from '../db/schema/index';
import { publishConversation } from '../domain/members';
import { forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';

export const updateConversation = defineCommand({
  name: 'update_conversation',
  schema: z.object({
    conversationId: ConversationId,
    topic: z.string().max(280).optional(),
    /** Link previews here on or off (EC-23, CT-330): the person. */
    linkPreviews: z.boolean().optional(),
  }),
  async apply(tx, ctx, input) {
    const row = await loadConversationRow(tx, input.conversationId);
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const topic = input.topic !== undefined && input.topic !== row.topic ? input.topic : null;
    const previews =
      input.linkPreviews !== undefined && input.linkPreviews !== (row.linkPreviews !== false)
        ? input.linkPreviews
        : null;
    if (topic === null && previews === null) return { conversationId: row.id };
    // What the room shows: the person's choice, not the agent's (EC-23).
    if (previews !== null && ctx.actor.kind !== 'person')
      throw forbidden('Only you can turn link previews on or off.');
    const label = conversationLabel(row);
    let last: string | null = null;
    if (previews !== null) {
      await tx.update(conversations).set({ linkPreviews: previews }).where(eq(conversations.id, row.id));
      const event = await ctx.emit({
        type: 'conversation.updated',
        kind: 'System',
        text: `Turned link previews ${previews ? 'on' : 'off'} in ${label}`,
        where: label,
        payload: { conversationId: row.id, linkPreviews: previews },
      });
      last = event.id;
    }
    if (topic !== null) {
      await tx.update(conversations).set({ topic }).where(eq(conversations.id, row.id));
      const event = await ctx.emit({
        type: 'conversation.updated',
        kind: 'System',
        text: `Changed the topic of ${label}`,
        where: label,
        payload: { conversationId: row.id, topic },
      });
      last = event.id;
    }
    await publishConversation(ctx, row.id, last);
    return { conversationId: row.id };
  },
});
