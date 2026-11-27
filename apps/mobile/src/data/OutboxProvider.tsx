/**
 * The outbox in the app (AP-717): one per Whombat (`scope`), sending through the typed client once the phone is online
 * and — on a managed Whombat — its session is open, refreshing the conversation after each message. `useOutboxSend` is
 * what a conversation's composer asks before sending; `OutboxRows` shows its waiting messages above the composer. The
 * composers' unsent drafts live beside it, in the same box and scope (`useDraft`, MX-02).
 */
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@whombat/client/query';
import { sendRequestId, useWhombat } from '@whombat/client/react';
import type { ChatRuntime } from '@whombat/core';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState } from 'react-native';
import { useI18n } from '../i18n';
import { createDraftStore, type DraftStore, draftKey } from './drafts';
import { createOutbox, type Outbox, type OutboxMessage, outboxFor, sendOutcome } from './outbox';
import { deviceBox } from './secureBoxNative';

interface OutboxValue {
  outbox: Outbox;
  /** Online and connected: a message goes now. */
  online: boolean;
  /** Unsent drafts per conversation and thread (MX-02). */
  drafts: DraftStore;
}

const OutboxContext = createContext<OutboxValue | null>(null);

function useOnline(): boolean {
  return useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
  );
}

export function OutboxProvider({
  scope,
  connected,
  children,
}: {
  /** The storage scope (`managed:<org>/<Whombat>`, `server:<url>`). */
  scope: string;
  /** The managed session is open (always true over HTTP). */
  connected: boolean;
  children: ReactNode;
}) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const online = useOnline() && connected;
  const { rawLocale } = useI18n();
  const latest = useRef({ client, qc, online, locale: rawLocale });
  latest.current = { client, qc, online, locale: rawLocale };
  const [outbox] = useState(() =>
    createOutbox({
      box: deviceBox(),
      scope,
      canSend: () => latest.current.online,
      locale: () => latest.current.locale,
      async send(item) {
        const params = { burrow: item.burrow, conversationId: item.conversationId };
        const body = {
          text: item.text,
          clientId: item.id,
          ...(item.threadRootId ? { threadRootId: item.threadRootId } : {}),
          ...(item.attachmentIds?.length ? { attachmentIds: item.attachmentIds } : {}),
          ...(item.runtime ? { runtime: item.runtime } : {}),
        } as Parameters<typeof client.messages.send>[0]['body'];
        const result = await latest.current.client.messages.send({
          params,
          body,
          requestId: sendRequestId(item.id),
        });
        return sendOutcome({ result: result as { status: string; message?: string } }, latest.current.locale);
      },
      onSent(item) {
        const { qc } = latest.current;
        void qc.invalidateQueries({
          queryKey: queryKeys.scope('messages.list', { conversationId: item.conversationId }),
        });
        if (item.threadRootId)
          void qc.invalidateQueries({
            queryKey: queryKeys.scope('messages.thread', { messageId: item.threadRootId }),
          });
      },
    }),
  );
  useEffect(() => {
    void outbox.load().then(() => outbox.flush());
  }, [outbox]);
  // Back online (or the session back): what waited goes, in order.
  useEffect(() => {
    if (online) void outbox.flush();
  }, [online, outbox]);
  // Drafts (MX-02): read at start, written when the app goes to the background, dropped (not written) once this Whombat
  // is left — its box may already be wiped.
  const [drafts] = useState(() => createDraftStore({ box: deviceBox(), scope }));
  useEffect(() => {
    void drafts.load();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') void drafts.flush();
    });
    return () => {
      sub.remove();
      drafts.dispose();
    };
  }, [drafts]);
  const value = useMemo(() => ({ outbox, online, drafts }), [outbox, online, drafts]);
  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>;
}

const NONE: readonly OutboxMessage[] = [];
const noSubscription = () => () => {};

/** True while a message waits to be sent (not one that failed): the connection is kept for it in the background (AP-925). */
export function useOutboxWaiting(): boolean {
  const ctx = useContext(OutboxContext);
  return useSyncExternalStore(
    ctx ? ctx.outbox.subscribe : noSubscription,
    () => !!ctx && ctx.outbox.items().some((m) => m.state !== 'failed'),
  );
}

/** The waiting messages of one conversation (or thread), and what to do with them. */
export function useOutbox(conversationId: string | null, threadRootId: string | null) {
  const ctx = useContext(OutboxContext);
  const all = useSyncExternalStore(ctx ? ctx.outbox.subscribe : noSubscription, () =>
    ctx ? ctx.outbox.items() : NONE,
  );
  const items = useMemo(
    () => (conversationId ? outboxFor(all, conversationId, threadRootId) : NONE),
    [all, conversationId, threadRootId],
  );
  const retry = useCallback(
    (id: string) => {
      ctx?.outbox.retry(id);
      void ctx?.outbox.flush();
    },
    [ctx],
  );
  const remove = useCallback((id: string) => ctx?.outbox.remove(id), [ctx]);
  return { items, retry, remove };
}

export interface HeldMessage {
  text: string;
  attachmentIds?: readonly string[];
  /** What answers the new thread, chosen in the Chat's box (chat-runtime-android.md AP-2719); absent: the agent's own. */
  runtime?: ChatRuntime;
}

/**
 * What the composer asks before sending: `hold(message)` keeps it in the outbox and returns true while the phone is
 * offline (or the session is down), and while earlier messages of this conversation still wait — so they go first.
 * False: send it now, as before. Without an outbox (the demo world) it never holds.
 */
export function useOutboxSend(target: {
  burrow: string;
  conversationId: string | null;
  threadRootId: string | null;
}) {
  const ctx = useContext(OutboxContext);
  const { items } = useOutbox(target.conversationId, target.threadRootId);
  const waiting = items.some((i) => i.state !== 'failed');
  const hold = useCallback(
    (message: HeldMessage): boolean => {
      if (!ctx || !target.conversationId || (ctx.online && !waiting)) return false;
      ctx.outbox.add({
        burrow: target.burrow,
        conversationId: target.conversationId,
        threadRootId: target.threadRootId,
        text: message.text,
        ...(message.attachmentIds?.length ? { attachmentIds: [...message.attachmentIds] } : {}),
        ...(message.runtime ? { runtime: message.runtime } : {}),
      });
      void ctx.outbox.flush();
      return true;
    },
    [ctx, waiting, target.burrow, target.conversationId, target.threadRootId],
  );
  return { hold };
}

/**
 * A composer's kept draft (MX-02): `kept` is what was typed here before (read again once the device's drafts are in),
 * `save` keeps what is typed now, and leaving writes it. Without an outbox (the demo world) nothing is kept.
 */
export function useDraft(conversationId: string | null, threadRootId: string | null) {
  const drafts = useContext(OutboxContext)?.drafts ?? null;
  const key = conversationId ? draftKey(conversationId, threadRootId) : null;
  const [kept, setKept] = useState(() => (drafts && key ? drafts.get(key) : ''));
  useEffect(() => {
    if (!drafts || !key) return;
    setKept(drafts.get(key));
    return drafts.onLoad(() => setKept(drafts.get(key)));
  }, [drafts, key]);
  const save = useCallback(
    (text: string) => (drafts && key ? drafts.set(key, text) : undefined),
    [drafts, key],
  );
  // Leaving the conversation writes what was typed at once.
  useEffect(() => () => void drafts?.flush(), [drafts]);
  return { kept, save };
}
