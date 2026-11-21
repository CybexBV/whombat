/**
 * Re-sends a plan's card when its state changes (docs/decisions/automation-chat.md): turned on, not now, replaced
 * by a newer plan, or its automation deleted. The card resolves on read (`read/messages.ts`), so the frame carries the
 * plan as it is now.
 */
import { topics } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { TxSession } from '../commit/types';
import { automationPlans } from '../db/schema/index';
import { loadMessageRow, loadMessages } from '../read/messages';

/** Re-sends the cards of these plans to their conversations. */
export async function republishPlanCardsById(
  session: Pick<TxSession, 'tx' | 'publish'>,
  planIds: readonly string[],
): Promise<void> {
  if (!planIds.length) return;
  const rows = await session.tx
    .select({ messageId: automationPlans.messageId })
    .from(automationPlans)
    .where(inArray(automationPlans.id, [...planIds]));
  for (const { messageId } of rows) {
    const message = messageId ? await loadMessageRow(session.tx, messageId) : undefined;
    if (!message) continue;
    const [loaded] = await loadMessages(session.tx, [message], null);
    if (loaded)
      session.publish(topics.conversation(message.conversationId), {
        type: 'message.updated',
        message: loaded,
      });
  }
}

/** Re-sends the cards of an automation's waiting plans (its deletion shows on them). */
export async function republishPlanCards(
  session: Pick<TxSession, 'tx' | 'publish'>,
  automationId: string,
): Promise<void> {
  const rows = await session.tx
    .select({ id: automationPlans.id })
    .from(automationPlans)
    .where(and(eq(automationPlans.automationId, automationId), eq(automationPlans.status, 'waiting')));
  await republishPlanCardsById(
    session,
    rows.map((r) => r.id),
  );
}
