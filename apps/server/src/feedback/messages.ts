/** Realtime for report root messages: their card resolves live, so a change republishes the message. */
import { topics } from '@whombat/core';
import { inArray } from 'drizzle-orm';
import type { TxSession } from '../commit/types';
import { messages } from '../db/schema/index';
import { loadMessages } from '../read/messages';

/** Publishes `message.updated` for each root message (to its conversation), inside the open transaction. */
export async function republishRootMessages(
  session: Pick<TxSession, 'tx' | 'publish'>,
  messageIds: readonly string[],
  eventId: string | null = null,
): Promise<void> {
  if (messageIds.length === 0) return;
  const rows = await session.tx
    .select()
    .from(messages)
    .where(inArray(messages.id, [...new Set(messageIds)]));
  for (const message of await loadMessages(session.tx, rows, null)) {
    session.publish(
      topics.conversation(message.conversationId),
      { type: 'message.updated', message },
      { eventId },
    );
  }
}
