/** Dispatch-only candidates. Public message/thread paging remains in read/views.ts (BP-B12, RF-03). */
import type { Message } from '@whombat/core';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { messages } from '../db/schema/index';
import { notFound } from '../lib/errors';
import {
  afterClear,
  loadMessageRow,
  loadMessages,
  type MessageCandidate,
  messageCandidates,
} from '../read/messages';

/**
 * Same newest top-level window and timestamp/ord ties as messagePage, without its unused paging cursor; a cleared room's
 * after its clear (chat-clear.md CHC-03).
 */
export async function contextWindowCandidates(
  db: Db,
  conversationId: string,
  limit: number,
  clearedAt?: Date | null,
): Promise<MessageCandidate[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(eq(messages.conversationId, conversationId), isNull(messages.threadRootId), afterClear(clearedAt)),
    )
    .orderBy(desc(messages.createdAt), desc(messages.ord))
    .limit(limit);
  return messageCandidates(db, rows.reverse());
}

/**
 * The thread's replies, or with `replyLimit` its last ones, chosen before dropping tombstones just like threadView's
 * newest page. Resolve a reply id to its root exactly as threadView does. The root is always kept, so hydrate it now
 * for ranking/fixed budget.
 */
export async function contextThreadCandidates(
  db: Db,
  viewerId: string,
  rootId: string,
  replyLimit?: number,
): Promise<{ root: Message; replies: MessageCandidate[] }> {
  const root = await loadMessageRow(db, rootId);
  if (!root) throw notFound('Thread');
  const actualRoot = root.threadRootId ? await loadMessageRow(db, root.threadRootId) : root;
  if (!actualRoot) throw notFound('Thread');
  const query = db.select().from(messages).where(eq(messages.threadRootId, actualRoot.id));
  const replies =
    replyLimit === undefined
      ? await query.orderBy(asc(messages.createdAt), asc(messages.ord))
      : (await query.orderBy(desc(messages.createdAt), desc(messages.ord)).limit(replyLimit)).reverse();
  const [loadedRoot] = await loadMessages(db, [actualRoot], viewerId);
  if (!loadedRoot) throw notFound('Thread');
  return { root: loadedRoot, replies: await messageCandidates(db, replies) };
}
