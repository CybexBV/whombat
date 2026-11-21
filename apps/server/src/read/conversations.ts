import {
  type Conversation,
  type ConversationSummary,
  conversationLabel,
  conversationLink,
  notifyLevelOf,
} from '@whombat/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { roomByKey } from '../chats/rooms';
import { unreadThreadCounts } from '../chats/unread';
import { chatOf } from '../chats/view';
import type { Db } from '../db/client';
import { conversations, readStates, repos } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { iso, isoOrNull } from '../lib/time';

export type ConversationRow = typeof conversations.$inferSelect;

export function toConversation(row: ConversationRow): Conversation {
  const chat = chatOf(row);
  return {
    id: row.id,
    burrowId: row.burrowId,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    topic: row.topic,
    actions: row.actions,
    prNumber: row.prNumber,
    repoId: row.repoId,
    createdAt: iso(row.createdAt),
    lastMessageAt: isoOrNull(row.lastMessageAt),
    // Always said, so a client that merges what it had sees “on” again (EC-23).
    linkPreviews: row.linkPreviews !== false,
    // A task chat's title and subject (one-whombat.md ONE-06, CT-337); absent on every other conversation.
    ...(chat ? { chat } : {}),
  };
}

/** `owner/name` of each repository id (branch rooms' links carry it, CT-170). */
export async function repoNames(db: Db, repoIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(repoIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: repos.id, fullName: repos.fullName })
    .from(repos)
    .where(inArray(repos.id, ids));
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

/** "feat/invoice-pdf", "Dusty". */
export function whereOf(row: Pick<ConversationRow, 'kind' | 'title'>): string {
  return conversationLabel(row);
}

export async function loadConversationRow(db: Db, id: string): Promise<ConversationRow | undefined> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
  return row;
}

export async function loadConversation(db: Db, id: string): Promise<Conversation | undefined> {
  const row = await loadConversationRow(db, id);
  if (!row) return undefined;
  return toConversation(row);
}

/**
 * Whether a conversation is one of the burrow's. Every conversation is the person's with the agent, so this is all an
 * act in one needs: the person and the agent may read and post in each of them.
 */
export async function inBurrow(db: Db, burrowId: string, conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.burrowId, burrowId)));
  return !!row;
}

/** The burrow's conversation ids: what the person and the agent may read. */
export async function burrowConversationIds(db: Db, burrowId: string): Promise<string[]> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.burrowId, burrowId));
  return rows.map((r) => r.id);
}

export interface UnreadCounts {
  unread: number;
  mentions: number;
}

/**
 * Unread top-level messages by others after the viewer's read marker, per conversation, and how many of
 * them mention the viewer. No marker = everything by others is unread. In the person's Chat and Feedback rooms `unread`
 * is the number of threads with something new (`unreadThreadCounts`).
 *
 * One range per conversation on `messages_top_level_idx` (index-only, server-efficiency.md SV-01): the marker is a
 * position (`ord` starts at 1, so no marker reads from -1).
 */
export async function unreadCounts(
  db: Db,
  viewerId: string,
  conversationIds: readonly string[],
): Promise<Map<string, UnreadCounts>> {
  const out = new Map<string, UnreadCounts>();
  for (const id of conversationIds) out.set(id, { unread: 0, mentions: 0 });
  if (conversationIds.length === 0) return out;
  const ids = [...new Set(conversationIds)];
  const rows = await db.execute<{ conversation_id: string; unread: number; mentions: number }>(sql`
    select c.id as conversation_id, x.unread, x.mentions
      from unnest(array[${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )}]::text[]) as c(id)
      left join read_states rs on rs.conversation_id = c.id and rs.principal_id = ${viewerId}
      cross join lateral (
        select count(*)::int as unread,
               count(*) filter (where ${viewerId} = any(m.mentions))::int as mentions
          from messages m
         where m.conversation_id = c.id
           and m.thread_root_id is null
           and m.deleted_at is null
           and m.author_id <> ${viewerId}
           and m.ord > coalesce(rs.last_read_ord, -1)) x`);
  for (const r of rows) out.set(r.conversation_id, { unread: r.unread, mentions: r.mentions });
  // The person's Chat and Feedback rooms count their threads with something new instead: every answer there is a reply
  // in a thread (docs/decisions/thread-unread.md).
  const threads = await unreadThreadCounts(db, viewerId, ids);
  for (const [id, n] of threads) out.set(id, { unread: n, mentions: out.get(id)?.mentions ?? 0 });
  return out;
}

/**
 * The person's `unreadCounts` of one conversation, for their badge: empty when the person wrote the message
 * (`exceptId`) or the burrow has no person yet. Only the person reads; the agent and Whombat's signers keep no badges.
 */
export async function personUnreadCounts(
  db: Db,
  burrowId: string,
  conversationId: string,
  exceptId: string | null,
): Promise<Map<string, UnreadCounts>> {
  const person = await thePerson(db, burrowId);
  if (!person || person.id === exceptId) return new Map();
  const counts = await unreadCounts(db, person.id, [conversationId]);
  return new Map([[person.id, counts.get(conversationId) ?? { unread: 0, mentions: 0 }]]);
}

export async function lastReadMessageId(
  db: Db,
  conversationId: string,
  viewerId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: readStates.lastReadMessageId })
    .from(readStates)
    .where(and(eq(readStates.conversationId, conversationId), eq(readStates.principalId, viewerId)));
  return row?.id ?? null;
}

/** Sidebar / list rows for the viewer. */
export async function conversationSummaries(
  db: Db,
  viewerId: string,
  rows: readonly ConversationRow[],
): Promise<ConversationSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const unread = await unreadCounts(db, viewerId, ids);
  const repoOf = await repoNames(
    db,
    rows.filter((r) => r.kind === 'branch').map((r) => r.repoId),
  );
  return rows.map((row) => {
    const counts = unread.get(row.id) ?? { unread: 0, mentions: 0 };
    return {
      id: row.id,
      kind: row.kind,
      slug: row.slug,
      title: row.title,
      link: conversationLink({
        ...row,
        repo: row.repoId ? (repoOf.get(row.repoId) ?? null) : null,
        chat: chatOf(row) ?? null,
        room: roomByKey(row) ?? undefined,
      }),
      unread: counts.unread,
      mentions: counts.mentions,
      prNumber: row.prNumber,
      lastMessageAt: isoOrNull(row.lastMessageAt),
      // The level in effect: the person's own for this conversation, else the kind's default.
      notify: notifyLevelOf({ kind: row.kind, notify: row.notify ?? null }),
    };
  });
}
