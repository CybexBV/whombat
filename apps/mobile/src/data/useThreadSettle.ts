/**
 * Settling a thread from the phone (Whombat chat-settle.md CHS-01…CHS-05; app chat-settle.md AP-6151, AP-6157, AP-6158):
 * `chats.settle` with the room changed at once — the thread leaves Chat or Feedback for Settled or comes back, the
 * thread's own screen shows its state — and put back when it is refused, whose
 * words show as a toast. Settling says “Thread settled.” with Undo for 5 s and the success haptic. A `chat.settled`
 * frame from another device, a new message or the automatic round changes the same caches
 * (`useChatSettledFrames`, mounted once beside the navigator); the shared handler reads the lists again after it. And
 * Profile → CHAT's switches (`useSaveChatPreferences`).
 */
import { type InfiniteData, type QueryClient, useQueryClient } from '@tanstack/react-query';
import { threadOfMessage } from '@whombat/client';
import { endpointQueries, patchEndpoint, patchMessages, queryKeys } from '@whombat/client/query';
import { useRealtimeEvent, useWhombat } from '@whombat/client/react';
import {
  api,
  type Bootstrap,
  type ChatPreferences,
  type ChatRoom,
  type ChatThread,
  type ChatThreadsResponse,
  type Message,
  type Preferences,
  type ThreadSettle,
  type ThreadView,
} from '@whombat/core';
import { useCallback } from 'react';
import { errorText, outcomeText } from '../screens/feedback';
import { haptic } from '../ui/haptics';
import { useBurrowBase } from './BurrowProvider';
import {
  chatPreferencesOf,
  messageWithSettle,
  SETTLE_COPY,
  type SettleChange,
  type ThreadListState,
  threadsWithSettle,
} from './threadSettle';
import { showToast } from './toast';

/** How long “Thread settled.” offers Undo (AP-6151). */
export const SETTLE_UNDO_MS = 5000;

type ThreadsData = InfiniteData<ChatThreadsResponse>;

/** The thread as a cached list has it, else from its first message in a cached room or thread (its room given). */
function cachedThread(qc: QueryClient, rootId: string, room: ChatRoom | null): ChatThread | null {
  for (const q of endpointQueries(qc, 'chats.threads')) {
    const data = q.state.data as ThreadsData | undefined;
    const row = data?.pages?.flatMap((p) => p.threads).find((t) => t.rootId === rootId);
    if (row) return row;
  }
  if (!room) return null;
  let root: Message | undefined;
  for (const q of endpointQueries(qc, 'messages.thread')) {
    const view = q.state.data as ThreadView | undefined;
    if (view?.root.id === rootId) root = view.root;
  }
  if (!root)
    for (const q of endpointQueries(qc, 'messages.list')) {
      const data = q.state.data as InfiniteData<{ messages: Message[] }> | undefined;
      root = data?.pages?.flatMap((p) => p.messages).find((m) => m.id === rootId);
      if (root) break;
    }
  return root ? { ...threadOfMessage(root, room), settled: root.settled ?? null } : null;
}

/**
 * A settle or Open again in every cached copy: the thread's first message (the room, its thread, a single read) and
 * every `chats.threads` list (`threadsWithSettle`); a list it can't make right here is read again.
 */
export function applySettle(qc: QueryClient, change: SettleChange, room: ChatRoom | null): void {
  patchMessages({ qc }, (m) => messageWithSettle(m, change.rootId, change.settled));
  let stale = false;
  patchEndpoint<ThreadsData>(qc, 'chats.threads', (d, key) => {
    if (!key.infinite || !('pages' in d)) return d;
    // Only a list of the thread's own room, and not one about a subject, takes a thread it doesn't hold yet.
    const sameRoom = room !== null && ((key.query.room as ChatRoom | undefined) ?? 'chat') === room;
    const ofRoom = sameRoom && !key.query.subjectKind && !key.query.subjectId;
    const next = threadsWithSettle(d, key.query.state as ThreadListState, {
      ...change,
      thread: ofRoom ? change.thread : null,
    });
    if (next !== null) return next;
    stale = true;
    return d;
  });
  if (stale) void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') });
}

export interface SettleTarget {
  rootId: string;
  /** Chat or Feedback, so the thread can join that room's lists. */
  room: ChatRoom | null;
}

/**
 * Settle a thread (`settled` true) or open it again (false), changed at once and put back when refused. Settling says
 * “Thread settled.” with Undo (which opens it again, quietly); `onDone` runs when the server agreed.
 */
export function useSettleThread() {
  const { slug, clock } = useBurrowBase();
  const { client } = useWhombat();
  const qc = useQueryClient();
  const run = useCallback(
    (target: SettleTarget, settled: boolean, options: { undo?: boolean; onDone?: () => void } = {}) => {
      const { rootId, room } = target;
      const before = cachedThread(qc, rootId, room);
      const previous: ThreadSettle | null = before?.settled ?? null;
      const next: ThreadSettle | null = settled ? { at: clock().toISOString(), how: 'person' } : null;
      // The shelf's count: one more for a thread that wasn't settled, one less for one opened again.
      const delta = settled ? (previous ? 0 : 1) : previous ? -1 : 0;
      applySettle(qc, { rootId, settled: next, thread: before, delta }, room);
      const putBack = () =>
        applySettle(
          qc,
          { rootId, settled: previous, thread: before, delta: delta === 1 ? -1 : delta ? 1 : 0 },
          room,
        );
      if (settled) {
        haptic('success');
        if (options.undo !== false)
          showToast(SETTLE_COPY.settled, {
            undo: () => run(target, false, { undo: false }),
            ms: SETTLE_UNDO_MS,
          });
      }
      client
        .request(api.chats.settle, { params: { burrow: slug, rootId }, body: { settled } })
        .then((result) => {
          if (result.status !== 'ok') {
            putBack();
            const said = outcomeText(result);
            if (said) showToast(said.body);
            return;
          }
          // The server's own settle (its time) everywhere.
          const thread = result.data.thread;
          applySettle(qc, { rootId, settled: thread.settled ?? null, thread, delta: 0 }, room);
          options.onDone?.();
        })
        .catch((error: unknown) => {
          putBack();
          // The refusal in the server's words (“Dusty is still working on this.”).
          showToast(errorText(error));
        })
        .finally(() => void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') }));
    },
    [client, qc, slug, clock],
  );
  return run;
}

/**
 * `chat.settled` on this phone (AP-6158): one thread's new state in every cached copy at once; several at once
 * (`rootId` null: Settle finished threads, the automatic round) read every thread screen's head again, as the shared
 * handler reads the room and the lists.
 */
export function useChatSettledFrames(): void {
  const qc = useQueryClient();
  useRealtimeEvent('chat.settled', (e) => {
    if (!e.rootId) {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.thread') });
      return;
    }
    applySettle(
      qc,
      { rootId: e.rootId, settled: e.settled, thread: cachedThread(qc, e.rootId, e.room), delta: 0 },
      e.room,
    );
  });
}

/** Mounted once beside the navigator: no screen of its own. */
export function ChatSettledBridge(): null {
  useChatSettledFrames();
  return null;
}

/**
 * Saves Profile → CHAT's switches (CHS-12; AP-6156): `me.updatePreferences` replaces `chat` whole, so the change is applied
 * to what the server has now (read just before), and only `chat` is sent. The bootstrap shows it at once; a failure
 * puts the old value back and throws.
 */
export function useSaveChatPreferences() {
  const { slug, currentBootstrap } = useBurrowBase();
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useCallback(
    async (change: (current: ChatPreferences) => ChatPreferences) => {
      const bootKey = queryKeys.conversations.bootstrap({ params: { burrow: slug } });
      const before = currentBootstrap().preferences.chat;
      const put = (value: ChatPreferences | undefined) =>
        qc.setQueryData(
          bootKey,
          (old: Bootstrap | undefined) => old && { ...old, preferences: { ...old.preferences, chat: value } },
        );
      put(change(chatPreferencesOf({ chat: before })));
      try {
        const current: Preferences = await client.me.getPreferences();
        const result = await client.me.updatePreferences({
          body: { chat: change(chatPreferencesOf(current)) },
        });
        if (result.status !== 'ok') throw new Error('not saved');
        qc.setQueryData(bootKey, (old: Bootstrap | undefined) => old && { ...old, preferences: result.data });
      } catch (error) {
        put(before);
        throw error;
      }
    },
    [client, qc, slug, currentBootstrap],
  );
}
