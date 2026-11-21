/**
 * A page set the agent shows again in place of an earlier one (`show_pages` `replaces`, docs/decisions/page-sets.md):
 * the new set takes the old one's place on the agent's own message, so a set that changes in rounds keeps one card.
 * The old set leaves the message: a person who saved it to Files keeps it there, otherwise it is removed (its bytes go
 * with the attachment sweep).
 */
import { AttachmentId, isPageSet, MessageId, topics } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { attachments, messages } from '../db/schema/index';
import { linkAttachments } from '../files/commands';
import { publishFilesChanged } from '../files/space-commands';
import { badRequest, notFound } from '../lib/errors';
import { loadMessages } from '../read/messages';

export const NOT_YOUR_SET = 'That isn’t a set of pages you posted in this conversation.';

/** Whether `attachmentId` is a set the agent posted on a live message of its own in this conversation (asked up front). */
export async function replaceableSet(
  db: Db,
  who: { burrowId: string; agentId: string; conversationId: string },
  attachmentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ attachment: attachments, message: messages })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(eq(attachments.id, attachmentId));
  if (!row) return false;
  const { attachment, message } = row;
  return (
    attachment.burrowId === who.burrowId &&
    attachment.uploadedById === who.agentId &&
    attachment.conversationId === who.conversationId &&
    isPageSet(attachment) &&
    !message.deletedAt &&
    message.authorId === who.agentId
  );
}

export const replacePageSet = defineCommand({
  name: 'replace_page_set',
  schema: z.object({ replaces: AttachmentId, attachmentId: AttachmentId, conversationId: z.string().min(1) }),
  async apply(tx, ctx, input) {
    const [old] = await tx.select().from(attachments).where(eq(attachments.id, input.replaces)).for('update');
    if (
      !old ||
      old.burrowId !== ctx.burrow.id ||
      old.uploadedById !== ctx.actor.id ||
      old.conversationId !== input.conversationId ||
      !old.messageId ||
      !isPageSet(old)
    )
      throw badRequest(NOT_YOUR_SET);
    const [message] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, old.messageId), eq(messages.burrowId, ctx.burrow.id)))
      .for('update');
    if (!message || message.deletedAt || message.authorId !== ctx.actor.id) throw badRequest(NOT_YOUR_SET);
    const [fresh] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, input.attachmentId))
      .for('update');
    if (
      !fresh ||
      fresh.uploadedById !== ctx.actor.id ||
      fresh.conversationId !== input.conversationId ||
      fresh.state !== 'ready' ||
      fresh.messageId
    )
      throw notFound('Page set');

    const [updated] = await tx
      .update(messages)
      .set({ attachmentIds: message.attachmentIds.map((id) => (id === old.id ? fresh.id : id)) })
      .where(eq(messages.id, message.id))
      .returning();
    if (!updated) throw notFound('Message');
    // Saved to Files by the person: it stays there; else it goes.
    if (old.filedAt) await tx.update(attachments).set({ messageId: null }).where(eq(attachments.id, old.id));
    else await tx.delete(attachments).where(eq(attachments.id, old.id));
    await linkAttachments(tx, ctx, message.id, [fresh]);
    if (old.filedAt && old.conversationId) await publishFilesChanged(ctx, old.conversationId);

    const [shown] = await loadMessages(tx, [updated], null);
    if (shown)
      ctx.publish(topics.conversation(updated.conversationId), { type: 'message.updated', message: shown });
    return { messageId: MessageId.parse(message.id) };
  },
});
