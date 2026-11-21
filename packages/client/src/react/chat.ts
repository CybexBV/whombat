/**
 * Chat and Feedback's reads (Whombat chat-channel.md CHT-01…CHT-07; contracts 0.93.0; app chat-channel.md
 * AP-2400…AP-2409): the person's rooms from `chats.list` and a room's threads from `chats.threads`, paged and live on
 * the room's conversation topic (a new message moves its thread in every cached list, `query/apply.ts`). Web and phone
 * share them.
 */
import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type Bootstrap,
  type ChatPreferences,
  type ChatRoom,
  type ChatSubject,
  type ChatThread,
  type ChatThreadsResponse,
  DEFAULT_CHAT_PREFERENCES,
  type Preferences,
  topics,
} from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useCallback, useMemo } from 'react';
import { type ChatRooms, chatRoomsOf } from '../chat/rooms';
import { settleRefusalText } from '../chat/settle';
import type { CommitResult, ResponseData } from '../http/types';
import { applyThreadSettle } from '../query/apply';
import { queryKeys } from '../query/keys';
import { invalidateSnapshot, restore, type Snapshot, snapshot } from '../query/optimistic';
import { wentThrough } from '../session/types';
import { useWhombat } from './context';
import { useChats } from './home';
import { useBootstrap, usePreferences } from './queries';
import { useSubscription } from './realtime';

export interface ChatRoomsView extends ChatRooms {
  /** `chats.list` has answered (an empty Chat and no Feedback room are known, not loading). */
  known: boolean;
  error: Error | null;
}

/**
 * The person's Chat and Feedback room with their unread counts (AP-2400), from the same `chats.list` the sidebar reads;
 * `enabled: false` asks nothing.
 */
export function useChatRooms(burrow: string | null | undefined, enabled = true): ChatRoomsView {
  const { data, error } = useChats(burrow && enabled ? { params: { burrow }, query: {} } : null, {
    retry: false,
  });
  return useMemo(
    () => ({ ...chatRoomsOf(data?.chats), known: data !== undefined, error: error ?? null }),
    [data, error],
  );
}

export interface ChatThreadsOptions {
  /** Only the threads about this server, connection or device (a thing page's Ask pane, CHT-23). */
  subject?: Pick<ChatSubject, 'kind' | 'id'> | null;
  /**
   * Only the open threads (newest activity first) or only the settled ones (latest settled first), contracts 3.8
   * (chat-settle.md CHS-10); absent: every thread.
   */
  state?: 'open' | 'settled';
  /** The room's conversation: the list follows it live (`conv:<id>`). */
  conversationId?: string | null;
  /** A page's size (the server's default, 30, when absent). */
  limit?: number;
  /** False: ask nothing (no room yet). */
  enabled?: boolean;
}

export interface ChatThreadsView {
  /** Every page loaded so far, newest activity first, each thread once. */
  threads: ChatThread[];
  isLoading: boolean;
  error: Error | null;
  /** Older threads exist (the last page had a `next`). */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  refetch: () => void;
  /** How many of the room's threads are settled (the first page's `settledCount`); undefined from an older Whombat. */
  settledCount: number | undefined;
  /**
   * The list's read itself: for a line that says it is being updated or couldn't be, and a pull to refresh that waits
   * for its answer (`refetch` returns once it came).
   */
  read: ChatThreadsRead;
  /** The list's query key, null while it waits for its burrow: a pull to refresh watches that read and no other. */
  queryKey: readonly unknown[] | null;
}

/** The parts of the threads' read a screen shows its state with. */
export type ChatThreadsRead = Pick<
  UseInfiniteQueryResult<InfiniteData<ChatThreadsResponse, string | undefined>, Error>,
  | 'data'
  | 'status'
  | 'isFetching'
  | 'isPaused'
  | 'dataUpdatedAt'
  | 'isFetchingNextPage'
  | 'isFetchNextPageError'
  | 'refetch'
>;

const NO_THREADS: ChatThread[] = [];

/**
 * A room's threads (`chats.threads`, AP-2408): the first page at once, older ones with `loadMore`, live while the room's
 * conversation is known. The phone's Threads screen and the web's Threads list and Ask pane read it.
 */
export function useChatThreads(
  burrow: string | null | undefined,
  room: ChatRoom,
  options: ChatThreadsOptions = {},
): ChatThreadsView {
  const { queries } = useWhombat();
  const { subject, conversationId, limit, state, enabled = true } = options;
  const input =
    burrow && enabled
      ? {
          params: { burrow },
          query: {
            room,
            ...(state ? { state } : {}),
            ...(subject ? { subjectKind: subject.kind, subjectId: subject.id } : {}),
            ...(limit ? { limit } : {}),
          },
        }
      : null;
  const factory = input ? queries.chats.threadsInfinite(input) : null;
  const q = useInfiniteQuery<
    ChatThreadsResponse,
    Error,
    InfiniteData<ChatThreadsResponse, string | undefined>,
    readonly unknown[],
    string | undefined
  >({
    queryKey: factory?.queryKey ?? ['whombat', 'chats.threads', 'waiting'],
    queryFn: factory?.queryFn ?? (() => Promise.resolve({ threads: [], next: null })),
    initialPageParam: undefined,
    getNextPageParam: (p) => p.next ?? undefined,
    enabled: !!factory,
    retry: false,
  });
  useSubscription(enabled && conversationId ? topics.conversation(conversationId) : null);
  const pages = q.data?.pages;
  const threads = useMemo(() => {
    if (!pages) return NO_THREADS;
    const seen = new Set<string>();
    return pages.flatMap((p) => p.threads).filter((t) => !seen.has(t.rootId) && !!seen.add(t.rootId));
  }, [pages]);
  return {
    threads,
    isLoading: !!factory && q.isLoading,
    error: q.error ?? null,
    hasMore: !!q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMore: () => void q.fetchNextPage(),
    refetch: () => void q.refetch(),
    settledCount: pages?.[0]?.settledCount,
    read: q,
    queryKey: factory?.queryKey ?? null,
  };
}

/* Settling threads (contracts 3.8; Whombat chat-settle.md; app chat-settle.md AP-6150…AP-6158) ------------------------- */

export interface SettleThreadInput {
  /** The thread's room: which Threads lists it moves in. */
  room: ChatRoom;
  /** The thread's first message. */
  rootId: string;
  /** True: settle it; false: open it again (Open again, Undo). */
  settled: boolean;
}

/** What a settle's mutation keeps to put things back: every message and Threads read as it was. */
const SETTLE_SNAPSHOT = ['messages.list', 'messages.thread', 'messages.get', 'chats.threads'] as const;

/**
 * Settle a thread, or open a settled one again (`chats.settle`, CHS-01, CHS-05): the room folds it and the Threads lists
 * move it before the Whombat answers (`applyThreadSettle`, the same change its `chat.settled` frame makes); the answer's
 * thread is what stays. A refusal or a failure puts every read back and says why (`onRefused`, the server's own words:
 * “Neo is still working on this.”). Done without its answer kept counts as done (CT-195).
 */
export function useSettleThread(burrow: string, options: { onRefused?: (text: string) => void } = {}) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const putBack = (snap: Snapshot | undefined) => {
    if (!snap) return;
    restore(qc, snap);
    invalidateSnapshot(qc, snap);
  };
  return useMutation<
    CommitResult<ResponseData<typeof api.chats.settle>>,
    Error,
    SettleThreadInput,
    { snap: Snapshot }
  >({
    mutationFn: ({ rootId, settled }) =>
      client.request(api.chats.settle, { params: { burrow, rootId: rootId as never }, body: { settled } }),
    onMutate: ({ room, rootId, settled }) => {
      const snap = snapshot(qc, SETTLE_SNAPSHOT);
      applyThreadSettle(qc, {
        room,
        rootId,
        settled: settled ? { at: new Date().toISOString(), how: 'person' } : null,
      });
      return { snap };
    },
    onSuccess: (result, input, context) => {
      if (result.status === 'ok') {
        const { thread } = result.data;
        return applyThreadSettle(qc, {
          room: thread.room,
          rootId: thread.rootId,
          settled: thread.settled ?? null,
          thread,
        });
      }
      putBack(context?.snap);
      options.onRefused?.(settleRefusalText(result, input.settled));
    },
    onError: (error, input, context) => {
      if (wentThrough(error)) return;
      putBack(context?.snap);
      options.onRefused?.(settleRefusalText(error, input.settled));
    },
  });
}

/**
 * Settle finished threads (`chats.settleFinished`, CHS-09): every open thread of the room nobody works on and that waits
 * for nobody. The answer says how many; the room and its lists read again (as the `chat.settled` frame with no thread
 * does on the person's other devices).
 */
export function useSettleFinished(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<
    CommitResult<ResponseData<typeof api.chats.settleFinished>>,
    Error,
    ChatRoom | { room: ChatRoom; onlyRead?: boolean }
  >({
    // `onlyRead`: “Settle everything read” leaves the threads with something new (chat-inbox.md CIB-07).
    mutationFn: (v) =>
      client.request(api.chats.settleFinished, {
        params: { burrow },
        body:
          typeof v === 'string' ? { room: v } : { room: v.room, ...(v.onlyRead ? { onlyRead: true } : {}) },
      }),
    onSuccess: (result) => {
      if (result.status !== 'ok') return;
      void qc.invalidateQueries({
        queryKey: queryKeys.scope('messages.list', { conversationId: result.data.conversationId }),
      });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.thread') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') });
    },
  });
}

/** The person's choices for settling by itself (`Preferences.chat`, CHS-12): the cached preferences, else the defaults. */
export function useChatPreferences(burrow: string | null | undefined): ChatPreferences {
  const { data } = useBootstrap(burrow ? { params: { burrow } } : null);
  const fresh = usePreferences({}, { enabled: !!burrow });
  return fresh.data?.chat ?? data?.preferences.chat ?? DEFAULT_CHAT_PREFERENCES;
}

/**
 * Saves a change to them at once (AP-6156; `me.updatePreferences` replaces `chat` whole): the cached preferences and
 * bootstrap show it before the answer, which then stands; a refusal or a failure puts the old choice back (a failure
 * rejects too, for the caller to say so).
 */
export function useSaveChatPreferences(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useCallback(
    async (next: ChatPreferences): Promise<boolean> => {
      const bootKey = queryKeys.conversations.bootstrap({ params: { burrow } });
      const prefsKey = queryKeys.me.getPreferences({});
      const before =
        qc.getQueryData<Preferences>(prefsKey)?.chat ?? qc.getQueryData<Bootstrap>(bootKey)?.preferences.chat;
      const put = (chat: ChatPreferences | undefined) => {
        qc.setQueryData(
          bootKey,
          (old: Bootstrap | undefined) => old && { ...old, preferences: { ...old.preferences, chat } },
        );
        qc.setQueryData(prefsKey, (old: Preferences | undefined) => old && { ...old, chat });
      };
      put(next);
      try {
        const result = await client.me.updatePreferences({ body: { chat: next } });
        if (result.status !== 'ok') {
          put(before);
          return false;
        }
        qc.setQueryData(bootKey, (old: Bootstrap | undefined) => old && { ...old, preferences: result.data });
        qc.setQueryData(prefsKey, result.data);
        return true;
      } catch (err) {
        put(before);
        throw err;
      }
    },
    [client, qc, burrow],
  );
}
