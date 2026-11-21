/** A person's own notification level for a conversation (docs/decisions/essentials-people.md EP-10; contracts CT-175). */
import { ConversationId, NotifyLevel, notifyLevelOf, topics } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import { conversations } from '../db/schema/index';
import { forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';

function requirePerson(ctx: ApplyContext): void {
  if (ctx.actor.kind !== 'person') throw forbidden('Only you can do this.');
}

/**
 * `conversations.setNotify` (EP-10): the person's own level for a conversation, kept on the conversation (only the
 * person reads it); null goes back to the kind's default. No signed event, like read markers; their other devices hear
 * `conversation.notify`.
 */
export const setConversationNotify = defineCommand({
  name: 'conversations.set_notify',
  schema: z.object({ conversationId: ConversationId, notify: NotifyLevel.nullable() }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await loadConversationRow(tx, input.conversationId);
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    await tx.update(conversations).set({ notify: input.notify }).where(eq(conversations.id, row.id));
    const notify = notifyLevelOf({ kind: row.kind, notify: input.notify });
    ctx.publish(topics.me(ctx.actor.id), { type: 'conversation.notify', conversationId: row.id, notify });
    return { conversationId: row.id, notify };
  },
});

export const PEOPLE_COMMANDS = [setConversationNotify];
