/**
 * Threads with something new in the person's Chat and Feedback rooms (Whombat thread-unread.md): which threads, from
 * `chats.unread` (asked again whenever the room's badge moves, `query/apply.ts`), and reading a thread, which clears it
 * here at once and on the person's other devices through the server. Web and phone share them.
 */
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import type { Bootstrap, ChatRoom, ChatUnreadResponse } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useCallback, useMemo } from 'react';
import { threadUnreadCounts, withThreadRead } from '../chat/unread';
import { sidebarSummaries } from '../conversations';
import { invalidateThreadUnread, setChatRoomUnread, setConversationUnread } from '../query/apply';
import { cachedData, patchEndpoint } from '../query/cache';
import { useWhombat } from './context';
import { useReadInboxAt } from './mutations';
import { queryHook } from './queries';

export const useChatUnread = queryHook(api.chats.unread);

/**
 * Each open thread's count of new messages in the room, by its first message's id. Empty while it loads, and from a
 * Whombat that doesn't know `chats.unread` yet (nothing shows as new there).
 */
export function useThreadUnread(
  burrow: string | null | undefined,
  room: ChatRoom,
  enabled = true,
): ReadonlyMap<string, number> {
  const { data } = useChatUnread(burrow && enabled ? { params: { burrow }, query: { room } } : null, {
    retry: false,
  });
  return useMemo(() => threadUnreadCounts(data), [data]);
}

export interface ReadThreadVariables {
  conversationId: string;
  /** The thread's first message. */
  rootId: string;
  /** The newest message of the thread shown. */
  messageId: string;
}

/** The room's cached mention count, kept while its badge changes. */
function cachedMentions(qc: QueryClient, conversationId: string): number {
  for (const { data } of cachedData<Bootstrap>(qc, 'conversations.bootstrap')) {
    const row = sidebarSummaries(data.sidebar).find((c) => c.id === conversationId);
    if (row) return row.mentions;
  }
  return 0;
}

/**
 * Reads a thread up to a message (`chats.readThread`): it stops showing as new at once, its inbox rows are read, and
 * the room's badge takes the server's count. A failure asks which threads are new again.
 */
export function useReadThread(burrow: string): (v: ReadThreadVariables) => void {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const readInbox = useReadInboxAt(burrow);
  return useCallback(
    ({ conversationId, rootId, messageId }: ReadThreadVariables) => {
      patchEndpoint<ChatUnreadResponse>(
        qc,
        'chats.unread',
        (d) => (d.conversationId === conversationId ? withThreadRead(d, rootId) : d),
        { burrow },
      );
      readInbox(conversationId, rootId);
      client.chats.readThread({ params: { burrow, rootId }, body: { messageId } }).then(
        (result) => {
          if (result.status !== 'ok') return;
          const unread = result.data.roomUnread;
          setConversationUnread(qc, conversationId, unread, cachedMentions(qc, conversationId));
          setChatRoomUnread(qc, conversationId, unread);
        },
        () => invalidateThreadUnread(qc, conversationId),
      );
    },
    [client, qc, burrow, readInbox],
  );
}

/**
 * Marks a thread unread (`chats.markUnread`, Whombat chat-inbox.md CIB-06): it shows as new at once with one new
 * message, and the room's badge takes the server's count; a failure asks which threads are new again.
 */
export function useMarkThreadUnread(burrow: string): (v: { conversationId: string; rootId: string }) => void {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useCallback(
    ({ conversationId, rootId }: { conversationId: string; rootId: string }) => {
      patchEndpoint<ChatUnreadResponse>(
        qc,
        'chats.unread',
        (d) =>
          d.conversationId !== conversationId || d.threads.some((t) => t.rootId === rootId)
            ? d
            : { ...d, threads: [{ rootId, unread: 1 }, ...d.threads] },
        { burrow },
      );
      client.chats.markUnread({ params: { burrow, rootId } }).then(
        (result) => {
          if (result.status !== 'ok') return;
          const unread = result.data.roomUnread;
          setConversationUnread(qc, conversationId, unread, cachedMentions(qc, conversationId));
          setChatRoomUnread(qc, conversationId, unread);
          // The server's count for the thread (0 when nothing in it came from someone else).
          patchEndpoint<ChatUnreadResponse>(
            qc,
            'chats.unread',
            (d) =>
              d.conversationId !== conversationId
                ? d
                : result.data.unread > 0
                  ? {
                      ...d,
                      threads: d.threads.map((t) =>
                        t.rootId === rootId ? { ...t, unread: result.data.unread } : t,
                      ),
                    }
                  : withThreadRead(d, rootId),
            { burrow },
          );
        },
        () => invalidateThreadUnread(qc, conversationId),
      );
    },
    [client, qc, burrow],
  );
}
