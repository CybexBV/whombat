/**
 * What follows an edited or deleted message besides the message itself (docs/decisions/essentials-conversations.md
 * EC-02…EC-04, EC-08, EC-09):
 *
 * - Who an edit newly tells is the notification service's (`notifyForMessage` with `addedMentions`,
 *   domain/message-notify.ts, essentials-people.md EP-11): the commands call it after the commit.
 * - `refreshMessageNotifications` / `dropMessageNotifications` — inbox rows carry the message's text: an edit rewrites
 *   it, a deletion removes them (the words are gone for everyone, the inbox included).
 * - `forgetStaleContext` — the agent must not keep the old words: the Hermes sessions that may hold them are forgotten
 *   and deleted (hermes-engine.md HE-40, HE-S118); the next turn starts a fresh one with the messages as they are now.
 */
import { plainMessageText } from '@whombat/core';
import { and, inArray, or, sql } from 'drizzle-orm';
import type { ApplyContext } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { notifications } from '../db/schema/index';
import { dropSessions, sessionsSince } from '../runtime/sessions';

/** Inbox kinds that quote a message's words (the others are about approvals, plans and runs). */
export const MESSAGE_NOTIFICATION_KINDS = ['mention', 'agent_update', 'reply'] as const;

/** Inbox rows about these messages: by `message_id` (EP-15), and by their link for rows written before it. */
const aboutMessages = (messageIds: readonly string[]) =>
  and(
    inArray(notifications.kind, [...MESSAGE_NOTIFICATION_KINDS]),
    or(
      inArray(notifications.messageId, [...messageIds]),
      inArray(sql<string>`${notifications.link}->>'messageId'`, [...messageIds]),
    ),
  );

/** An edit: inbox rows about the message show its new words. */
export async function refreshMessageNotifications(
  tx: Tx | Db,
  messageId: string,
  text: string,
): Promise<void> {
  const plain = (plainMessageText(text) || text).slice(0, 500);
  await tx
    .update(notifications)
    .set({ text: plain })
    .where(aboutMessages([messageId]));
}

/** A deletion: inbox rows that quote the message go. */
export async function dropMessageNotifications(tx: Tx | Db, messageIds: readonly string[]): Promise<void> {
  if (messageIds.length === 0) return;
  await tx.delete(notifications).where(aboutMessages(messageIds));
}

/**
 * Keeps an edited or deleted message's old words out of the agent's sessions (HE-S118): every Hermes session of the
 * conversation whose turns began after the message was written is forgotten and deleted (`dropSessions`), so the next
 * turn starts fresh.
 */
export async function forgetStaleContext(
  ctx: Pick<ApplyContext, 'tx' | 'services' | 'background' | 'now'>,
  args: { conversationId: string; createdAt: Date },
): Promise<void> {
  await dropSessions(ctx, await sessionsSince(ctx.tx, args.conversationId, args.createdAt));
}
