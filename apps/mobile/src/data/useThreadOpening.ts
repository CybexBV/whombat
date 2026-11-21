/**
 * Opening a thread quickly: its first page is asked for as soon as a finger comes down on what opens it (a Chat row, a
 * replies row), with the same query the thread screen reads, and until it is there the screen shows the thread's root
 * as the room already has it.
 */
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@whombat/client/query';
import { useWhombat } from '@whombat/client/react';
import { api, type ChatThread, type MessagePage, type ThreadView } from '@whombat/core';
import { useCallback } from 'react';
import { threadPlaceholderFromList } from './chatInbox';
import { threadPlaceholder, threadQuery } from './threadPages';

/** `(messageId) => void`: starts loading a thread's newest page unless the cache has it fresh. */
export function usePrefetchThread(slug: string): (messageId: string) => void {
  const qc = useQueryClient();
  const { queries } = useWhombat();
  return useCallback(
    (messageId: string) => {
      // The client's own staleness: a thread realtime keeps current isn't asked for again.
      void qc.prefetchQuery(
        queries.endpoint(api.messages.thread, { params: { burrow: slug, messageId }, query: threadQuery() }),
      );
    },
    [qc, queries, slug],
  );
}

/**
 * `placeholderData` for a thread's query: its root from the room's cached pages while the thread loads, else from the
 * inbox's cached list of threads (Chat and Feedback list their threads, not their messages).
 */
export function useThreadPlaceholder(slug: string, messageId: string | null): () => ThreadView | undefined {
  const qc = useQueryClient();
  return useCallback(() => {
    if (!messageId) return undefined;
    const lists = qc
      .getQueriesData<{ pages: MessagePage[] }>({
        queryKey: queryKeys.scope('messages.list', { burrow: slug }),
      })
      .map(([, data]) => data);
    const fromRoom = threadPlaceholder(lists, messageId);
    if (fromRoom) return fromRoom;
    const threads = qc
      .getQueriesData<{ pages: { threads: ChatThread[] }[] }>({
        queryKey: queryKeys.scope('chats.threads', { burrow: slug }),
      })
      .map(([, data]) => (data && 'pages' in data ? data : undefined));
    return threadPlaceholderFromList(threads, messageId);
  }, [qc, slug, messageId]);
}
