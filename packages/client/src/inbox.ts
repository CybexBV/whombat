/**
 * The inbox as the clients read it (web-efficiency.md WE-11; the mobile inbox's AP-704 rule): a mention or a reply
 * leaves the inbox once read; NEEDS YOU and the agent's updates stay, read or not. Pure.
 */
import type { InboxItem, InboxResponse, NotificationKind } from '@whombat/core';

/** Rows that leave the inbox once read: the viewer has seen where they happened. */
export const INBOX_GONE_WHEN_READ: ReadonlySet<NotificationKind> = new Set(['mention', 'reply']);

/** Whether a notification row still shows: a read mention or reply doesn't. */
export function inboxItemShown(item: Pick<InboxItem, 'kind' | 'readAt'>): boolean {
  return item.readAt === null || !INBOX_GONE_WHEN_READ.has(item.kind);
}

/** Unread mentions and replies: the Inbox's plain count. */
export function unreadMentionCount(inbox: InboxResponse | undefined): number {
  let n = 0;
  for (const s of inbox?.sections ?? [])
    if (INBOX_GONE_WHEN_READ.has(s.kind)) n += s.items.filter((i) => i.readAt === null).length;
  return n;
}
