/**
 * Where the “New” divider goes when a conversation opens (docs/decisions/web-messages.md WX-07): above the first
 * message after the viewer's last-read one that someone else wrote. Pure, so the rule is tested once.
 */
import type { Message } from '@whombat/core';

export interface UnreadInput {
  /** The top-level messages loaded, oldest first. */
  messages: readonly Pick<Message, 'id' | 'authorId'>[];
  /** `ConversationDetail.lastReadMessageId` as it was when the room opened. */
  lastReadId: string | null;
  viewerId: string | undefined;
  /** Older history exists beyond the loaded pages. */
  hasOlder: boolean;
  /** Unread messages and mentions the sidebar counted when the room opened. */
  unread: number;
}

/** The id of the first unread message, or null for no divider. */
export function unreadStart({
  messages,
  lastReadId,
  viewerId,
  hasOlder,
  unread,
}: UnreadInput): string | null {
  // Nothing new by the sidebar's count, or never read here (a first visit has no “where you were”).
  if (unread <= 0 || !lastReadId) return null;
  const at = messages.findIndex((m) => m.id === lastReadId);
  // Not loaded: older than the first page (everything shown is new), or gone without older history (no place to say).
  if (at < 0 && !hasOlder) return null;
  for (let i = at + 1; i < messages.length; i++) {
    const m = messages[i] as Pick<Message, 'id' | 'authorId'>;
    if (m.authorId !== viewerId && !m.id.startsWith('msg_local-')) return m.id;
  }
  return null;
}
