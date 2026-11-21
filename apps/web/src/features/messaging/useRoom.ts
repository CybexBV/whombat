/**
 * Live data for one conversation: history (infinite, oldest first), realtime subscription, typing,
 * optimistic sending with commands, reactions and read state. Shared by channels, DMs, branch rooms and
 * (for sending) the thread pane.
 */

import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  agentNowFor,
  composerMentionTargets,
  composerText,
  sidebarSummaries,
  workingLabel,
} from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';
import { queryKeys, type TypingEntry } from '@whombat/client/query';
import {
  useAgentNow,
  useBootstrap,
  useMarkRead,
  useMessagesInfinite,
  useSendMessage,
  useSubscription,
  useTyping,
  useWhombat,
} from '@whombat/client/react';
import {
  type ChatRuntime,
  type ConversationDetail,
  type Message,
  type Principal,
  resolveMentions,
  shortNameOf,
  TYPING_TTL_MS,
  topics,
} from '@whombat/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TypingLine } from './MessageList';
import {
  historyMessages,
  type PrincipalLookup,
  principalLookup,
  type SkillCommand,
  skillAddressNotice,
  viewerTimeZone,
} from './model';

/** How long the scripted reply takes in fixture mode (the mock's `sendDraft()` waits 1.6 s). */
export const FIXTURE_REPLY_DELAY_MS = 1600;

/**
 * Test-only override for the delay `simulateAgentReplies` waits before "delivering" the reply. Screens
 * that cross this delay (screens.test.tsx) set it to a few ms so the test waits on the resulting state
 * change (`findByText`) instead of the wall clock — the real `FIXTURE_REPLY_DELAY_MS` stays 1.6 s for
 * everyone else (dev, Storybook, the rest of the suite). See docs/decisions/polish-ci.md.
 */
let fixtureReplyDelayOverrideMs: number | null = null;
export function __setFixtureReplyDelayForTests(ms: number | null): void {
  fixtureReplyDelayOverrideMs = ms;
  if (ms === null) fixtureReplyHold = null;
}

/**
 * Test-only: hold simulated replies until the returned `release()` is called (instead of a delay), so a
 * test can observe "{name} is thinking" without racing a timer on a loaded machine. Reset by
 * `__setFixtureReplyDelayForTests(null)`.
 */
let fixtureReplyHold: Promise<void> | null = null;
export function __holdFixtureRepliesForTests(): () => void {
  let release = () => {};
  fixtureReplyHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

/** The clock for relative labels ("Today", "last 10:06", "just now"), moving on every `intervalMs`. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The clock for a ticking label: every `intervalMs` while `on`, else still. */
export function useTicker(on: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [on, intervalMs]);
  return now;
}

/** Bootstrap-derived context every conversation view needs. */
export function useBurrowContext(burrow: string) {
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  // Memoized rows take the lookup: it follows the principals, not every change to the bootstrap (an unread count).
  const principals = bootstrap?.principals;
  const lookup = useMemo(() => principalLookup(principals && { principals }), [principals]);
  return useMemo(
    () => ({
      bootstrap,
      lookup,
      principals: principals ?? ([] as Principal[]),
      me: bootstrap?.me,
      timeZone: viewerTimeZone(bootstrap),
    }),
    [bootstrap, lookup, principals],
  );
}

/**
 * The agent's thinking line for a conversation (or one thread): what it does —
 * `Banjo · Editing Layout.astro · 1m 12s` (docs/decisions/card-settle.md AP-734; `workingLabel` from its newest
 * action, `useAgentNow`), else "Banjo is thinking". A thinking line ticks once a second by itself (`TypingLine.at`,
 * WX-01: the room isn't rendered again for the clock); a screen reader hears the line without it.
 */
export function useTypingLines(
  conversationId: string | undefined,
  threadRootId: string | null,
  lookup: PrincipalLookup,
) {
  const { typing } = useTyping(conversationId, threadRootId);
  const agentNow = useAgentNow(conversationId);
  const lines = useMemo(() => {
    const seen = new Set<string>();
    const out: TypingLine[] = [];
    for (const t of typing) {
      const p = lookup(t.principalId);
      const name = p ? shortNameOf(p) : 'Someone';
      const key = `thinking:${t.principalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const at = (nowMs: number) => {
        const entry = agentNowFor(agentNow, t.principalId, threadRootId, nowMs);
        // Without the clock: measured at the action's own start, the label leaves it out.
        const label = workingLabel(name, entry, nowMs);
        return { label, spoken: entry ? workingLabel(name, entry, entry.since) : label };
      };
      out.push({
        key,
        ...at(Date.now()),
        at,
        principalId: t.principalId,
        ...(t.dispatchId ? { dispatchId: t.dispatchId } : {}),
      });
    }
    return out;
  }, [typing, agentNow, lookup, threadRootId]);
  return { lines };
}

/**
 * Without a socket (fixture mode) nothing pushes the agent's reply: show "{name} is thinking" for the
 * mock's 1.6 s, then refetch the conversation (the fixture world has already stored the reply).
 */
export function simulateAgentReplies(
  qc: QueryClient,
  conversationId: string,
  threadRootId: string | null,
  agentIds: readonly string[],
): () => void {
  if (!agentIds.length) return () => {};
  const delayMs = fixtureReplyDelayOverrideMs ?? FIXTURE_REPLY_DELAY_MS;
  const key = queryKeys.typing(conversationId);
  const expiresAt = Date.now() + (fixtureReplyHold ? TYPING_TTL_MS : Math.min(delayMs + 400, TYPING_TTL_MS));
  const entries: TypingEntry[] = agentIds.map((principalId) => ({
    principalId,
    threadRootId,
    mode: 'thinking',
    expiresAt,
  }));
  qc.setQueryData(key, (old: TypingEntry[] | undefined) => [
    ...(old ?? []).filter((e) => !agentIds.includes(e.principalId)),
    ...entries,
  ]);
  const deliver = () => {
    qc.setQueryData(key, (old: TypingEntry[] | undefined) =>
      (old ?? []).filter((e) => !agentIds.includes(e.principalId)),
    );
    void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.list', { conversationId }) });
    void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.thread') });
  };
  if (fixtureReplyHold) {
    let cancelled = false;
    void fixtureReplyHold.then(() => {
      if (!cancelled) deliver();
    });
    return () => {
      cancelled = true;
    };
  }
  const timer = setTimeout(deliver, delayMs);
  return () => clearTimeout(timer);
}

export interface SendOptions {
  burrow: string;
  conversationId: string | undefined;
  threadRootId?: string | null;
  principals: readonly Principal[];
  /** The author (left out of nothing: everyone they see may be named). */
  meId?: string | null;
  /**
   * The agent's skills (skills-library.md SL-09): a draft starting with one of them in a room where it isn't addressed
   * says to mention it (AP-248); otherwise it goes as typed (AP-5235). `agentId`: the agent, addressed without a mention
   * in the person's own rooms (Chat, Feedback).
   */
  skills?: readonly Pick<SkillCommand, 'name' | 'agentId' | 'agentName'>[];
  agentId?: string | null;
  /** The server's message once a send went through (Chat opens a top-level message's thread, chat-channel.md AP-2406). */
  onSent?: (message: Message) => void;
}

/** What a send carries beside the text: what answers a new thread in Chat. */
export interface SendRoute {
  /** What answers the new thread (the Chat's top-level box, contracts 0.96.1 CT-469; chat-runtime.md AP-2684). */
  runtime?: ChatRuntime;
}

export interface SendState {
  /** Sends a message, or runs a `/command`. Resolves true when the draft can be cleared. */
  submit: (text: string, attachmentIds?: string[], route?: SendRoute) => Promise<boolean>;
  notice: string | null;
  clearNotice: () => void;
  sending: boolean;
  /** Sends a message again with its own client id (the same request: it can't be applied twice, AP-14). */
  resend: (message: Message) => void;
}

/** Optimistic sending (docs/decisions/messaging.md). */
export function useSend({
  burrow,
  conversationId,
  threadRootId = null,
  principals,
  meId = null,
  skills,
  agentId = null,
  onSent,
}: SendOptions): SendState {
  const qc = useQueryClient();
  const { realtime } = useWhombat();
  const [notice, setNotice] = useState<string | null>(null);
  const send = useSendMessage({ burrow, conversationId: conversationId ?? '', threadRootId });
  const cancels = useRef<(() => void)[]>([]);
  useEffect(
    () => () => {
      for (const cancel of cancels.current) cancel();
    },
    [],
  );

  const submit = useCallback(
    async (typed: string, attachmentIds?: string[], route?: SendRoute): Promise<boolean> => {
      if (!conversationId) return false;
      setNotice(null);
      // The composer's targets (nobody who left, EP-03), as its auto-correct uses them.
      const targets = composerMentionTargets(principals, meId);
      // Every mention in its canonical form (`@banjo` → `@Banjo`, MS-C02; AP-607): the optimistic message shows what
      // the server stores.
      const text = composerText(typed, targets);
      const addressed = agentId ? [agentId] : resolveMentions(text, targets);
      // One of the agent's skills in a draft that doesn't address it: say to mention it (AP-248).
      const unaddressed = skills?.length ? skillAddressNotice(text, skills, addressed) : null;
      if (unaddressed) {
        setNotice(unaddressed);
        return false;
      }
      const body = text.startsWith('//') ? text.slice(1) : text;
      try {
        const result = await send.mutateAsync({
          text: body,
          attachmentIds: attachmentIds?.length ? attachmentIds : undefined,
          mentions: resolveMentions(body, targets),
          ...(route?.runtime ? { runtime: route.runtime } : {}),
        });
        if (result.status !== 'ok') {
          setNotice(outcomeNotice(result));
          return false;
        }
        onSent?.(result.data.message);
        if (!realtime) {
          // A dispatch is the agent's turn (OA-01): it is the one who answers.
          const replier = agentId ?? targets.find((t) => t.kind === 'agent')?.id;
          cancels.current.push(
            simulateAgentReplies(
              qc,
              conversationId,
              threadRootId,
              result.data.dispatches.length && replier ? [replier] : [],
            ),
          );
          if (threadRootId) void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.list') });
        }
        return true;
      } catch (err) {
        setNotice(errorNotice(err, 'Couldn’t send that. Check your connection and try again.'));
        return false;
      }
    },
    [agentId, conversationId, meId, onSent, principals, qc, realtime, send, skills, threadRootId],
  );

  const resend = useCallback(
    (m: Message) => {
      if (!m.clientId) return;
      send.mutate({
        text: m.text,
        clientId: m.clientId,
        mentions: m.mentions,
        attachmentIds: m.attachments.length ? m.attachments.map((a) => a.id) : undefined,
      });
    },
    [send],
  );
  return { submit, notice, clearNotice: () => setNotice(null), sending: send.isPending, resend };
}

function outcomeNotice(
  result: { status: 'pending_approval' } | { status: 'blocked'; keyNeeded: { label: string } },
): string {
  if (result.status === 'pending_approval') return 'That needs a person to approve it first. We’ve asked.';
  return `Blocked: that needs the “${result.keyNeeded.label}” key.`;
}

function errorNotice(err: unknown, fallback: string): string {
  // The appliance's subscription ended, or the plan's limit is reached (LC-14).
  const licence = licenceRefusalText(err);
  if (licence) return licence;
  if (err instanceof ApiError) {
    if (err.status === 404 || err.status === 501) return 'That isn’t available here yet.';
    if (err.status === 403) return 'You can’t do that in this conversation.';
    return err.message || fallback;
  }
  return fallback;
}

/** Sets `lastReadMessageId` on every cached detail of the conversation (`conversations.get`, `getChannel`, …). */
function rememberRead(qc: QueryClient, conversationId: string, messageId: string) {
  qc.setQueriesData<unknown>(
    {
      predicate: (q) => {
        const d = q.state.data as Partial<ConversationDetail> | undefined;
        return (
          !!d && typeof d === 'object' && 'lastReadMessageId' in d && d.conversation?.id === conversationId
        );
      },
    },
    (d: unknown) => (d ? { ...(d as ConversationDetail), lastReadMessageId: messageId } : d),
  );
}

/** History, subscription and read state for one conversation (reactions: `useMessageActions`). */
export function useRoomMessages(burrow: string, detail: ConversationDetail | undefined) {
  const conversationId = detail?.conversation.id;
  useSubscription(conversationId ? topics.conversation(conversationId) : null);
  const history = useMessagesInfinite(conversationId ? { params: { burrow, conversationId } } : null);
  const messages = useMemo(() => historyMessages(history.data?.pages), [history.data]);
  const markRead = useMarkRead(burrow);
  const { bootstrap } = useBurrowContext(burrow);

  // Mark the conversation read up to its newest message while it is open and has a badge.
  const last = messages.at(-1);
  const unread = useMemo(() => {
    const row = sidebarSummaries(bootstrap?.sidebar).find((c) => c.id === conversationId);
    return (row?.unread ?? 0) + (row?.mentions ?? 0);
  }, [bootstrap, conversationId]);
  const marked = useRef<string | null>(null);
  const mark = markRead.mutate;
  const qc = useQueryClient();
  useEffect(() => {
    if (!conversationId || !last || last.id.startsWith('msg_local-')) return;
    if (unread === 0 || marked.current === last.id) return;
    marked.current = last.id;
    mark({ conversationId, messageId: last.id });
    // The cached conversation remembers where reading stopped, so the next visit's divider starts there (WX-07).
    rememberRead(qc, conversationId, last.id);
  }, [conversationId, last, unread, mark, qc]);

  return {
    conversationId,
    messages,
    /** Unread messages and mentions the sidebar counts here. */
    unread,
    loading: history.isPending && !!conversationId,
    error: history.error,
    hasOlder: !!history.hasNextPage,
    loadingOlder: history.isFetchingNextPage,
    loadOlder: history.fetchNextPage,
  };
}
