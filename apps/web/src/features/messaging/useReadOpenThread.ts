/**
 * The open thread of Chat or Feedback is read up to its newest message while the tab is on screen (Whombat
 * thread-unread.md): its dot goes, the room's badge drops and the person's other devices agree. Nothing is sent while
 * nothing in it is new.
 */
import { useReadThread, useThreadUnread } from '@whombat/client/react';
import type { ChatRoom } from '@whombat/core';
import { useEffect, useRef } from 'react';
import { useDocumentVisible } from '../mobile/usePhoneSignIn';

export function useReadOpenThread(args: {
  burrow: string;
  /** The thread's room; undefined: not a Chat or Feedback thread, nothing to read. */
  room: ChatRoom | undefined;
  conversationId: string | undefined;
  rootId: string;
  /** The newest message shown in the thread (the root while it has no replies). */
  newestId: string | undefined;
}): void {
  const { burrow, room, conversationId, rootId, newestId } = args;
  const unread = useThreadUnread(burrow, room ?? 'chat', !!room);
  const read = useReadThread(burrow);
  const visible = useDocumentVisible();
  const count = unread.get(rootId) ?? 0;
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!room || !conversationId || !newestId || newestId.startsWith('msg_local-')) return;
    if (!visible || count === 0) return;
    // Once per newest message: a reply still on its way is read when it shows.
    const key = `${rootId}:${newestId}`;
    if (sent.current === key) return;
    sent.current = key;
    read({ conversationId, rootId, messageId: newestId });
  }, [room, conversationId, rootId, newestId, visible, count, read]);
}
