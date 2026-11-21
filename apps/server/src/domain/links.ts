import {
  type ConversationLink,
  chatHref,
  chatRoomHref,
  chatThreadHref,
  conversationLink,
  type LinkRef,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { chatRoomOf, roomByKey } from '../chats/rooms';
import type { Db, Tx } from '../db/client';
import { conversations, messages, repos } from '../db/schema/index';
import type { ConversationRow } from '../read/conversations';

/** `owner/name` of a repository, for branch-room links (CT-170); null when unknown. */
export async function repoFullName(db: Db, repoId: string | null | undefined): Promise<string | null> {
  if (!repoId) return null;
  const [repo] = await db.select({ fullName: repos.fullName }).from(repos).where(eq(repos.id, repoId));
  return repo?.fullName ?? null;
}

/**
 * A task chat's part for `conversationLink` (contracts 0.80.1, CT-348): a DM with a task key links as the chat itself
 * (`/chats/:id`), never as the default DM with its agent (one-whombat-assistant.md ONE-DW02).
 */
export function chatPart(
  row: Pick<ConversationRow, 'kind' | 'taskKey' | 'chatTitle'>,
): { title: string } | null {
  return row.kind === 'dm' && row.taskKey !== null ? { title: row.chatTitle ?? '' } : null;
}

/**
 * Route link of a conversation: a person's room names which (Chat or Feedback), branch rooms carry their repository (two
 * repos may both have a PR #1, docs/decisions/essentials-conversations.md EC-24), task chats their id.
 */
export async function linkOfConversation(db: Db, row: ConversationRow): Promise<ConversationLink> {
  if (chatPart(row)) return { type: 'chat', id: row.id };
  if (row.kind === 'branch') return conversationLink({ ...row, repo: await repoFullName(db, row.repoId) });
  return conversationLink({ ...row, room: roomByKey(row) ?? undefined });
}

/** A PR's link (`/pr/:number?repo=owner/name`) for audit refs, notifications and search hits (EC-24). */
export function prLink(number: number, repo: string | null | undefined): LinkRef {
  return repo ? { type: 'pr', number, repo } : { type: 'pr', number };
}

export async function linkOfMessage(
  db: Db,
  conversation: ConversationRow,
  messageId: string,
  threadRootId: string | null,
): Promise<LinkRef> {
  const link: LinkRef = { type: 'message', in: await linkOfConversation(db, conversation), messageId };
  if (threadRootId) link.threadRootId = threadRootId;
  return link;
}

/**
 * Where the app opens a place in a person's chats with their assistant (docs/decisions/chat-channel.md CHT-08): in their
 * Chat or Feedback room the thread of `at` (`/chat?thread=<root>`, its first message's id), else the room itself; a
 * task chat from before Chat its page (`/chats/<id>`). `at` is the thread's first message or any message in it.
 */
export async function chatPlaceHref(
  db: Db | Tx,
  conversationId: string,
  at: { threadRootId?: string | null; messageId?: string | null } = {},
): Promise<string> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  const room = row ? chatRoomOf(row) : null;
  if (!room) return chatHref(conversationId);
  let root = at.threadRootId ?? null;
  if (!root && at.messageId) {
    const [m] = await db
      .select({
        id: messages.id,
        threadRootId: messages.threadRootId,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(eq(messages.id, at.messageId));
    if (m?.conversationId === conversationId) root = m.threadRootId ?? m.id;
  }
  return root ? chatThreadHref(room, root) : chatRoomHref(room);
}
