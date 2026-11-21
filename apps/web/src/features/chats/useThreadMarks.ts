import { useQueryClient } from '@tanstack/react-query';
import { INBOX_WORDS } from '@whombat/client';
import { useMarkThreadUnread, useReadThread, useWhombat } from '@whombat/client/react';
import { api } from '@whombat/core';
import { useCallback } from 'react';
import { useToast } from '../../components/Toast';
import { THREAD_PAGE } from '../messaging/useThreadPages';

export interface ThreadMark {
  conversationId: string;
  rootId: string;
}

/**
 * Mark as unread and Mark as read on a thread of Chat or Feedback (Whombat chat-inbox.md CIB-06). Unread says so in a
 * toast, as mail does, since the thread may leave the screen; read is quiet. A row knows only its thread's first
 * message, so reading it asks the thread's newest page for its newest message first (the same query the thread opens
 * with, so opening it next costs nothing).
 */
export function useThreadMarks(burrow: string) {
  const toast = useToast();
  const qc = useQueryClient();
  const { queries } = useWhombat();
  const markUnread = useMarkThreadUnread(burrow);
  const read = useReadThread(burrow);
  const unread = useCallback(
    (v: ThreadMark) => {
      markUnread(v);
      toast.show(INBOX_WORDS.markedUnread);
    },
    [markUnread, toast],
  );
  const markRead = useCallback(
    ({ conversationId, rootId }: ThreadMark) => {
      const params = { burrow, messageId: rootId };
      void qc
        .fetchQuery({
          ...queries.endpoint(api.messages.thread, { params, query: { limit: THREAD_PAGE } }),
          staleTime: 10_000,
        })
        .then(
          (data) => {
            const thread = data as { root: { id: string }; replies: readonly { id: string }[] };
            const newest = thread.replies.at(-1)?.id ?? thread.root.id;
            read({ conversationId, rootId, messageId: newest });
          },
          () => toast.show('Couldn’t mark it as read. Try again.'),
        );
    },
    [burrow, qc, queries, read, toast],
  );
  return { markUnread: unread, markRead };
}
