/**
 * A live card that moves to the end of its thread (docs/decisions/card-moves.md): a council's or a checklist's card is
 * kept current on its message, and once the thread went on under it, the card's next real news posts it again as the
 * thread's newest message, so where it stands is always at the end of the chat, read like a new message. The old
 * message keeps the agent's words above the card and a link to where it went; where the person wrote after it, it also
 * keeps the card as it was then, folded and read-only, so what they talked about stays next to their words. One
 * that held only the card, with nobody talking after it, goes.
 */
import { type MovedCard, topics } from '@whombat/core';
import { and, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { applyContext } from '../commit/pipeline';
import type { ApplyContext } from '../commit/types';
import { attachments, messages, reactions, searchDocuments } from '../db/schema/index';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow, loadMessages, type MessageRow } from '../read/messages';
import { loadPrincipalRow, toActor } from '../read/principals';
import { dropMessageNotifications } from './message-edits';
import { postMessage } from './messages';

export { cardNews } from './card-news';

import { indexMessage } from './search-index';

type Card = NonNullable<MessageRow['card']>;

/** Whether any message came in the thread after this one. */
async function buried(ctx: ApplyContext, row: MessageRow): Promise<boolean> {
  if (!row.threadRootId) return false;
  const [later] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadRootId, row.threadRootId),
        gt(messages.createdAt, row.createdAt),
        ne(messages.id, row.id),
        isNull(messages.deletedAt),
      ),
    )
    .limit(1);
  return !!later;
}

/**
 * Whether someone other than the card's author wrote in the thread after this message: the person talked about the card
 * as it was there. The agent's own notes don't count, so a council's card that leapfrogs them leaves nothing behind.
 */
async function talkedAfter(ctx: ApplyContext, row: MessageRow): Promise<boolean> {
  if (!row.threadRootId) return false;
  const [later] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadRootId, row.threadRootId),
        gt(messages.createdAt, row.createdAt),
        ne(messages.authorId, row.authorId),
        isNull(messages.deletedAt),
      ),
    )
    .limit(1);
  return !!later;
}

async function publishRow(ctx: ApplyContext, row: MessageRow): Promise<void> {
  const [loaded] = await loadMessages(ctx.tx, [row], null);
  if (loaded)
    ctx.publish(topics.conversation(row.conversationId), { type: 'message.updated', message: loaded });
}

/**
 * Puts a new card on a message the agent just posted, after its words (a council's conclusion that its tasks join), so
 * one message says what was found and offers what to do about it: changed in place, telling nobody again.
 */
export async function joinCard(
  ctx: ApplyContext,
  messageId: string,
  card: Card,
  words: string,
): Promise<void> {
  const [joined] = await ctx.tx
    .update(messages)
    .set({ card, text: words })
    .where(eq(messages.id, messageId))
    .returning();
  if (!joined) return;
  await publishRow(ctx, joined);
  const { services } = ctx;
  ctx.after(async () => indexMessage(services.db, messageId));
}

/**
 * Puts the card on the message that shows it: on `messageId` as it is, or, when `move` and the thread went on under
 * that message (a reply of a thread only), on a new message of the same author at the thread's end, quietly (no
 * inbox row, no push, nobody woken). The card's pictures, quick replies and question go with it. Answers the id of the
 * message that holds the card now, or null when the message is gone.
 */
export async function placeCard(
  ctx: ApplyContext,
  messageId: string,
  card: Card,
  move: boolean,
): Promise<string | null> {
  const { tx } = ctx;
  const row = await loadMessageRow(tx, messageId);
  if (!row || row.deletedAt) return null;
  if (!move || !(await buried(ctx, row))) {
    const [updated] = await tx.update(messages).set({ card }).where(eq(messages.id, row.id)).returning();
    if (updated) await publishRow(ctx, updated);
    return row.id;
  }
  const [conversation, author] = await Promise.all([
    loadConversationRow(tx, row.conversationId),
    loadPrincipalRow(tx, row.authorId),
  ]);
  if (!conversation || !author) return row.id;
  // The agent posts it, also when the watcher or a person's press brought the news.
  const as =
    ctx.actor.id === author.id
      ? ctx
      : applyContext(ctx, { ...ctx, actor: toActor(author), decision: null, requirement: null });
  const posted = await postMessage(as, {
    conversation,
    text: '',
    card,
    threadRootId: row.threadRootId,
    attachmentIds: row.attachmentIds,
    suggestions: row.suggestions,
    asks: row.asks,
    dispatch: false,
    notify: false,
    notifyDmPerson: false,
    notifyMentions: false,
  });
  if (row.attachmentIds.length)
    await tx
      .update(attachments)
      .set({ messageId: posted.id })
      .where(inArray(attachments.id, row.attachmentIds));
  // Where the person talked after it, the card as it was stays here, folded and read-only.
  const keep = row.card && (await talkedAfter(ctx, row)) ? row.card : null;
  if (row.text.trim() || keep) {
    // The agent's words above the card stay where they were said, with a link to where the card went (CM-07).
    const [left] = await tx
      .update(messages)
      .set({
        card: null,
        attachmentIds: [],
        suggestions: [],
        asks: false,
        movedCard: movedOf(card),
        earlierCard: keep,
      })
      .where(eq(messages.id, row.id))
      .returning();
    if (left) await publishRow(ctx, left);
    const { services } = ctx;
    ctx.after(async () => indexMessage(services.db, row.id));
  } else await removeEmptied(ctx, row);
  return posted.id;
}

/** Which council's or checklist's card it is, for the link the message it left keeps (CM-07). */
function movedOf(card: Card): MovedCard | null {
  const c = card as { kind?: unknown; councilId?: unknown; delegationId?: unknown };
  if (c.kind === 'council' && typeof c.councilId === 'string') return { kind: 'council', id: c.councilId };
  if (c.kind === 'delegation' && typeof c.delegationId === 'string')
    return { kind: 'delegation', id: c.delegationId };
  return null;
}

/** A message that held only the card, gone once the card moved on: out of the thread and its count. */
async function removeEmptied(ctx: ApplyContext, row: MessageRow): Promise<void> {
  const { tx } = ctx;
  await tx.delete(reactions).where(eq(reactions.messageId, row.id));
  await tx.delete(searchDocuments).where(eq(searchDocuments.id, row.id));
  await tx.delete(messages).where(eq(messages.id, row.id));
  await dropMessageNotifications(tx, [row.id]);
  ctx.publish(topics.conversation(row.conversationId), {
    type: 'message.deleted',
    conversationId: row.conversationId,
    messageId: row.id,
  });
  if (!row.threadRootId) return;
  const replies = await tx
    .select({ authorId: messages.authorId, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.threadRootId, row.threadRootId))
    .orderBy(messages.createdAt, messages.ord);
  const participants: string[] = [];
  for (const r of replies) {
    const i = participants.indexOf(r.authorId);
    if (i >= 0) participants.splice(i, 1);
    participants.push(r.authorId);
  }
  const [root] = await tx
    .update(messages)
    .set({
      replyCount: replies.length,
      lastReplyAt: replies.at(-1)?.createdAt ?? null,
      threadParticipantIds: participants.slice(-3),
    })
    .where(eq(messages.id, row.threadRootId))
    .returning();
  if (root) await publishRow(ctx, root);
}
