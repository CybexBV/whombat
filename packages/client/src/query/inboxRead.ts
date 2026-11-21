/**
 * Reading a conversation reads its inbox rows (AP-704): a mention, a direct message or a reply leaves the inbox once
 * the viewer has read where it happened. Reading a conversation's top level reads the rows of its top level; opening
 * a thread reads the rows of that thread (a thread's replies don't move the conversation's read marker, so a reply in
 * a thread the viewer hasn't opened stays). Rows are matched by their link: a conversation link, or a message link
 * into one. Agents' updates and NEEDS YOU rows are left alone: they aren't about a message the viewer read.
 */
import type { QueryClient } from '@tanstack/query-core';
import type {
  Bootstrap,
  ConversationDetail,
  ConversationLink,
  ConversationSummary,
  InboxItem,
  InboxResponse,
  LinkRef,
  NotificationKind,
} from '@whombat/core';
import { cachedData, patchEndpoint } from './cache';
import { markInboxRead } from './reducers';

/** The rows reading a conversation reads. */
export const READ_WITH_CONVERSATION: ReadonlySet<NotificationKind> = new Set(['mention', 'reply']);

/** Where the viewer read: a conversation's top level (`threadRootId` null), or one of its threads. */
export interface ReadPlace {
  link: ConversationLink;
  threadRootId: string | null;
}

/** The same conversation (a branch room's repository counts only when both say). */
export function sameConversationLink(a: ConversationLink, b: ConversationLink): boolean {
  switch (a.type) {
    case 'dm':
      return b.type === 'dm' && (a.room ?? 'chat') === (b.room ?? 'chat');
    case 'chat':
      return b.type === 'chat' && a.id === b.id;
    case 'pr':
      return b.type === 'pr' && a.number === b.number && (!a.repo || !b.repo || a.repo === b.repo);
  }
}

/** Where an inbox row's link points: a conversation's top level or a thread; null for anything else. */
export function placeOfLink(link: LinkRef): ReadPlace | null {
  switch (link.type) {
    case 'dm':
    case 'chat':
    case 'pr':
      return { link, threadRootId: null };
    case 'message':
      return { link: link.in, threadRootId: link.threadRootId ?? null };
    default:
      return null;
  }
}

/** Whether reading `place` reads this row (unread mentions and replies only). */
export function readsInboxItem(item: Pick<InboxItem, 'kind' | 'link' | 'readAt'>, place: ReadPlace): boolean {
  if (item.readAt !== null || !READ_WITH_CONVERSATION.has(item.kind)) return false;
  const at = placeOfLink(item.link);
  return !!at && at.threadRootId === place.threadRootId && sameConversationLink(at.link, place.link);
}

/** The unread rows of an inbox that reading `place` reads. */
export function inboxIdsReadAt(inbox: InboxResponse, place: ReadPlace): string[] {
  return inbox.sections.flatMap((s) => s.items.filter((i) => readsInboxItem(i, place)).map((i) => i.id));
}

/** A conversation's link from whatever the cache knows: the sidebar of a bootstrap, or the conversation's detail. */
export function cachedConversationLink(qc: QueryClient, conversationId: string): ConversationLink | null {
  const hit = (list: readonly ConversationSummary[] | undefined) =>
    list?.find((c) => c.id === conversationId)?.link ?? null;
  for (const { data } of cachedData<Bootstrap>(qc, 'conversations.bootstrap')) {
    const link = hit(data.sidebar.dms) ?? hit(data.sidebar.branchRooms);
    if (link) return link;
  }
  for (const { data } of cachedData<ConversationDetail>(qc, 'conversations.get')) {
    if (data.summary.id === conversationId) return data.summary.link;
  }
  return null;
}

/**
 * Mark the cached inbox rows read where the viewer read (`burrow`: only that burrow's inbox). Returns the ids marked,
 * for `notifications.markRead`; none when the cache doesn't know the conversation or has no inbox.
 */
export function markInboxReadAt(
  qc: QueryClient,
  conversationId: string,
  threadRootId: string | null,
  at: string,
  burrow?: string,
): string[] {
  const link = cachedConversationLink(qc, conversationId);
  if (!link) return [];
  const place = { link, threadRootId };
  const ids = new Set<string>();
  patchEndpoint<InboxResponse>(
    qc,
    'notifications.inbox',
    (d) => {
      const hit = inboxIdsReadAt(d, place);
      for (const id of hit) ids.add(id);
      return hit.length ? markInboxRead(d, hit, at) : d;
    },
    burrow ? { burrow } : undefined,
  );
  return [...ids];
}
