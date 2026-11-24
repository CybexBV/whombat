// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ApprovalResponse, GuideCard, type MessagePage } from '@whombat/core';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../http/client';
import { cachedMe } from '../query/cache';
import { queryKeys } from '../query/keys';
import type { Realtime } from '../realtime/realtime';
import { createFakeAppliance } from '../session/fake';
import { createFakeSession } from '../session/fake-session';
import { createSecureSession } from '../session/secure';
import { OutcomeRedactedError } from '../session/types';
import { approval, BURROW, bootstrap, message, t } from '../test/fixtures';
import { drivenRealtime, fakeClient } from '../test/session';
import { useSetThreadRuntime } from './chatRuntime';
import { useSessionProtocol, WhombatClientProvider } from './context';
import { useSaveMessageFile } from './files';
import { useDecideApproval, useGuideAct, useReaction, useSendMessage } from './mutations';
import { useAgentNow, useRealtimeStatus, useSubscription, useTyping } from './realtime';

const B = { burrow: BURROW };
const CONV = { ...B, conversationId: 'cnv_chat' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

function setup(respond: Responder = () => json({})) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => respond(url, init));
  const client = fakeClient(fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.conversations.bootstrap({ params: B }), bootstrap());
  const realtime = drivenRealtime();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider client={client} realtime={realtime} queryClient={queryClient}>
      {children}
    </WhombatClientProvider>
  );
  return { fetch, client, queryClient, realtime, wrapper };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const messagesKey = queryKeys.messages.list({ params: CONV });
const ids = (qc: QueryClient) => qc.getQueryData(messagesKey)?.messages.map((m) => m.id);

describe('realtime hooks', () => {
  it('connects while mounted, subscribes by ref count and applies events to the cache', () => {
    const { wrapper, queryClient, realtime } = setup();
    queryClient.setQueryData(messagesKey, { messages: [], before: null, hasMore: false });
    const { result, rerender, unmount } = renderHook(
      ({ on }: { on: boolean }) => {
        useSubscription(on ? ['conv:cnv_chat'] : null);
        useSubscription(on ? 'conv:cnv_chat' : undefined);
        return useRealtimeStatus();
      },
      { wrapper, initialProps: { on: true } },
    );
    expect(result.current).toBe('connecting');
    act(() => realtime.open());
    expect(result.current).toBe('open');
    expect(realtime.topics()).toEqual(['conv:cnv_chat']);
    act(() => realtime.event('conv:cnv_chat', { type: 'message.created', message: message('msg_1') }));
    expect(ids(queryClient)).toEqual(['msg_1']);
    rerender({ on: false });
    expect(realtime.topics()).toEqual([]);
    unmount();
    expect((realtime as Realtime).status()).toBe('closed');
  });

  it('typing entries expire and the viewer is excluded', () => {
    vi.useFakeTimers({ now: Date.parse(t(30)) });
    try {
      const { wrapper, realtime } = setup();
      const { result } = renderHook(
        () => {
          useSubscription('conv:cnv_chat');
          return useTyping('cnv_chat');
        },
        { wrapper },
      );
      act(() => realtime.open());
      const typing = (principalId: string) => {
        const at = new Date().toISOString();
        realtime.event(
          'conv:cnv_chat',
          {
            type: 'typing',
            conversationId: 'cnv_chat',
            threadRootId: null,
            principalId,
            active: true,
            expiresAt: new Date(Date.now() + 6000).toISOString(),
          },
          at,
        );
      };
      act(() => {
        typing('prn_banjo');
        typing('prn_mara');
      });
      expect(result.current.typing.map((e) => e.principalId)).toEqual(['prn_banjo']);
      act(() => vi.advanceTimersByTime(4000));
      act(() => typing('prn_banjo')); // refreshed
      act(() => vi.advanceTimersByTime(4000));
      expect(result.current.typing.map((e) => e.principalId)).toEqual(['prn_banjo']);
      act(() => vi.advanceTimersByTime(2100));
      expect(result.current.typing).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('every typing and agent-now reader shares one query-cache subscription (WE-08)', () => {
    const { wrapper, queryClient } = setup();
    // The endpoint index has its own cache subscription; count the readers independently.
    cachedMe(queryClient);
    const subscribe = vi.spyOn(queryClient.getQueryCache(), 'subscribe');
    const { unmount } = renderHook(
      () => [useTyping('cnv_a'), useTyping('cnv_a'), useTyping('cnv_b'), useAgentNow('cnv_a')],
      { wrapper },
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
    unmount();
    expect(subscribe.mock.results[0]?.value).toBeTypeOf('function');
  });
});

describe('optimistic mutations', () => {
  it('guide act: sends a form’s values once and keeps them nowhere (AG-03)', async () => {
    const bodies: unknown[] = [];
    const { wrapper, queryClient } = setup((_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return json({ ok: true });
    });
    const card = GuideCard.parse({
      kind: 'guide',
      guide: 'google_app',
      node: 'step_5.external.email',
      title: 'Paste the client',
      state: 'open',
      blocks: [
        {
          type: 'form',
          id: 'app',
          fields: [{ id: 'clientSecret', label: 'Client secret', kind: 'secret' }],
          submitLabel: 'Save',
        },
      ],
    });
    queryClient.setQueryData(messagesKey, {
      messages: [message('msg_g', { card })],
      before: null,
      hasMore: false,
    });
    const { result } = renderHook(() => useGuideAct(BURROW), { wrapper });
    await act(() =>
      result.current.mutateAsync({
        messageId: 'msg_g',
        actionId: 'app',
        values: { clientSecret: 'GOCSPX-s3cret' },
      }),
    );
    expect(bodies).toEqual([{ actionId: 'app', values: { clientSecret: 'GOCSPX-s3cret' } }]);
    // TanStack keeps the variables in its mutation cache after it settles: the secret must not be in there.
    const kept = JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state.variables),
    );
    expect(kept).toContain('msg_g');
    expect(kept).not.toContain('GOCSPX-s3cret');
    const variables = queryClient.getMutationCache().getAll()[0]?.state.variables as
      | { sealed?: { take(): unknown } }
      | undefined;
    expect(variables?.sealed?.take()).toBeUndefined();
  });

  it('send message: carries the Chat box’s choice, and a resend repeats it (CT-469, AP-2684)', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { session, appliance } = createFakeSession({
      account: { id: 'acc_mara', name: 'Mara' },
      handle: async (_op, input) => {
        bodies.push((input as { body: Record<string, unknown> }).body);
        return { status: 201, body: { message: message('msg_9'), dispatches: [] } };
      },
      session: { deadlineMs: 50, backoff: { initialMs: 2, maxMs: 5 } },
    });
    const client = createClient({ session, validateResponses: false });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.conversations.bootstrap({ params: B }), bootstrap());
    queryClient.setQueryData(messagesKey, { messages: [], before: null, hasMore: false });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WhombatClientProvider client={client} queryClient={queryClient} connect={false}>
        {children}
      </WhombatClientProvider>
    );
    const { result } = renderHook(() => useSendMessage({ burrow: BURROW, conversationId: 'cnv_chat' }), {
      wrapper,
    });
    const runtime = { provider: 'codex', effort: 'high' } as const;
    // Not delivered (the Whombat can't be reached): an error, and nothing arrived.
    appliance.faults.offline(true);
    act(() => result.current.mutate({ text: 'Check the UPS', clientId: 'c-rt', runtime }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(bodies).toEqual([]);
    appliance.faults.offline(false);
    act(() => result.current.mutate({ text: 'Check the UPS', clientId: 'c-rt' }));
    await waitFor(() => expect(result.current.data?.status).toBe('ok'));
    expect(bodies.map((b) => b.runtime)).toEqual([runtime]);
    session.close();
  });

  it('send message: rolls back when blocked', async () => {
    const reply = deferred<Response>();
    const { wrapper, queryClient } = setup(() => reply.promise);
    queryClient.setQueryData(messagesKey, { messages: [message('msg_1')], before: null, hasMore: false });
    const { result } = renderHook(() => useSendMessage({ burrow: BURROW, conversationId: 'cnv_chat' }), {
      wrapper,
    });
    act(() => result.current.mutate({ text: 'Refund €24,00' }));
    await waitFor(() => expect(ids(queryClient)).toHaveLength(2));
    reply.resolve(
      json(
        {
          error: { code: 'blocked', message: 'Not one of your keys' },
          blocked: true,
          keyNeeded: { id: 'messages.external', label: 'Message customers' },
          eventId: 'evt_9d77',
        },
        403,
      ),
    );
    await waitFor(() => expect(result.current.data?.status).toBe('blocked'));
    expect(ids(queryClient)).toEqual(['msg_1']);
  });

  it('send message: rolls back when it fails', async () => {
    const { wrapper, queryClient } = setup(() => {
      throw new TypeError('offline');
    });
    queryClient.setQueryData(messagesKey, { messages: [], before: null, hasMore: false });
    const { result } = renderHook(() => useSendMessage({ burrow: BURROW, conversationId: 'cnv_chat' }), {
      wrapper,
    });
    act(() => result.current.mutate({ text: 'Hello?' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(ids(queryClient)).toEqual([]);
  });

  it('send message: went through without its answer (CT-195) — kept on screen, and what is shown is fetched again', async () => {
    const appliance = createFakeAppliance({
      handle: async () => ({ status: 201, body: { message: message('msg_sent') } }),
    });
    appliance.faults.loseAfterCommit(1, 'redacted');
    const session = createSecureSession({
      connector: appliance.connector,
      backoff: { initialMs: 2, maxMs: 5 },
    });
    try {
      const client = createClient({ session, validateResponses: false });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(queryKeys.conversations.bootstrap({ params: B }), bootstrap());
      queryClient.setQueryData(messagesKey, { messages: [message('msg_1')], before: null, hasMore: false });
      const inbox = queryKeys.notifications.inbox({ params: B });
      queryClient.setQueryData(inbox, {
        sections: [],
        counts: { all: 0, needs_you: 0, mentions: 0, agents: 0 },
        unread: 0,
      });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <WhombatClientProvider client={client} queryClient={queryClient}>
          {children}
        </WhombatClientProvider>
      );
      const { result } = renderHook(() => useSendMessage({ burrow: BURROW, conversationId: 'cnv_chat' }), {
        wrapper,
      });
      act(() => result.current.mutate({ text: 'Sent, answer lost' }));
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error?.name).toBe('OutcomeRedactedError');
      // Not taken back to the composer: it was sent.
      expect(ids(queryClient)).toHaveLength(2);
      // Something changed that nobody saw: everything is fetched again (AP-580).
      await waitFor(() => expect(queryClient.getQueryState(inbox)?.isInvalidated).toBe(true));
      expect(appliance.stats().executed.get('messages.send')).toBe(1);
    } finally {
      session.close();
    }
  });

  it('answers lost together that went through make one refetch, not one each', async () => {
    const { wrapper, queryClient } = setup();
    renderHook(() => null, { wrapper });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const lost = (n: number) =>
      queryClient
        .getMutationCache()
        .build(queryClient, {
          mutationFn: () =>
            Promise.reject(new OutcomeRedactedError('messages.send', `req_${n}`, 'completed')),
        })
        .execute(undefined)
        .catch(() => {});
    await Promise.all([lost(1), lost(2), lost(3)]);
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 120));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('reaction: optimistic toggle, server reactions win, rollback on error', async () => {
    let fail = false;
    const { wrapper, queryClient } = setup(() =>
      fail
        ? json({ error: { code: 'internal', message: 'boom' } }, 500)
        : json({ reactions: [{ value: 'finally', count: 5, mine: true, principalIds: ['prn_mara'] }] }),
    );
    queryClient.setQueryData(messagesKey, {
      messages: [
        message('msg_1', {
          reactions: [{ value: 'finally', count: 3, mine: false, principalIds: ['prn_banjo'] }],
        }),
      ],
      before: null,
      hasMore: false,
    });
    const reactions = () => queryClient.getQueryData(messagesKey)?.messages[0]?.reactions;
    const { result } = renderHook(() => useReaction(BURROW), { wrapper });
    await act(() => result.current.mutateAsync({ messageId: 'msg_1', value: 'finally', on: true }));
    expect(reactions()?.[0]?.count).toBe(5);
    fail = true;
    const before = reactions();
    await act(async () => {
      await result.current.mutateAsync({ messageId: 'msg_1', value: '+1', on: true }).catch(() => {});
    });
    expect(reactions()).toEqual(before);
  });

  it('reaction: cancels only its own conversation’s messages.list and recovers it afterwards', async () => {
    // cancelQueries defaults to revert:true, which leaves a cancelled query permanently
    // fetchStatus:'idle' with nothing to retry it. Reacting must not cancel every conversation's
    // in-flight messages.list fetch (e.g. a resync recovering messages missed during a disconnect
    // elsewhere), and whatever it does cancel must be invalidated once the mutation settles.
    const { wrapper, queryClient } = setup(() =>
      json({ reactions: [{ value: 'finally', count: 1, mine: true, principalIds: ['prn_mara'] }] }),
    );
    const otherKey = queryKeys.messages.list({ params: { ...B, conversationId: 'cnv_general' } });
    queryClient.setQueryData(messagesKey, {
      messages: [message('msg_1', { conversationId: 'cnv_chat' })],
      before: null,
      hasMore: false,
    } satisfies MessagePage);
    queryClient.setQueryData(otherKey, { messages: [], before: null, hasMore: false } satisfies MessagePage);
    const cancelSpy = vi.spyOn(queryClient, 'cancelQueries');
    const { result } = renderHook(() => useReaction(BURROW), { wrapper });
    await act(() => result.current.mutateAsync({ messageId: 'msg_1', value: 'finally', on: true }));
    const cancelled = cancelSpy.mock.calls[0]?.[0] as { queryKey?: unknown } | undefined;
    expect(cancelled?.queryKey).toEqual(queryKeys.scope('messages.list', { conversationId: 'cnv_chat' }));
    expect(queryClient.getQueryState(messagesKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });

  it('approval decide: rollback invalidates every snapshotted endpoint, not just the approval', async () => {
    // Restore() writes every snapshotted query back to its pre-mutation value with setQueryData, which
    // can silently overwrite a realtime update (e.g. audit.appended) that landed while the undo/decide
    // request was in flight. The rollback must invalidate everything it just restored, not only the
    // approval itself, so a mounted screen refetches server truth instead of being stuck on stale data.
    const reply = deferred<Response>();
    const { wrapper, queryClient } = setup(() => reply.promise);
    const modal = queryKeys.approvals.get({ params: { ...B, number: 12 } });
    queryClient.setQueryData(modal, { approval: approval(), eventId: null } satisfies ApprovalResponse);
    const inbox = queryKeys.notifications.inbox({ params: B });
    queryClient.setQueryData(inbox, {
      sections: [],
      counts: { all: 0, needs_you: 0, mentions: 0, agents: 0 },
      unread: 0,
    });
    const audit = queryKeys.audit.list({ params: B });
    queryClient.setQueryData(audit, {
      events: [],
      counts: { all: 0, code: 0, asks: 0, blocked: 0, keys: 0, vault: 0, messages: 0 },
      before: null,
      hasMore: false,
    });
    const { result } = renderHook(() => useDecideApproval(BURROW), { wrapper });
    act(() => result.current.mutate({ number: 12, decision: 'approve' }));
    await waitFor(() => expect(queryClient.getQueryData(modal)?.approval.state).toBe('approved'));
    reply.resolve(json({ error: { code: 'conflict', message: 'Already executed' } }, 409));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryState(inbox)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(audit)?.isInvalidated).toBe(true);
  });
});

describe('Save to Files on a message’s file (CT-312, AP-834)', () => {
  const file = (inFiles: boolean) => ({
    id: 'att_fonts',
    name: 'fonts.zip',
    contentType: 'application/zip',
    size: 2048,
    url: '/api/v1/burrows/burrow-hq/attachments/att_fonts',
    kind: 'file' as const,
    width: null,
    height: null,
    inFiles,
  });
  const inFiles = (qc: QueryClient) => qc.getQueryData(messagesKey)?.messages[0]?.attachments[0]?.inFiles;

  it('says In Files at once, and goes back with the Whombat’s words when it refuses', async () => {
    const reply = deferred<Response>();
    const bodies: unknown[] = [];
    const { wrapper, queryClient } = setup((_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return reply.promise;
    });
    queryClient.setQueryData(messagesKey, {
      messages: [message('msg_f', { attachments: [file(false)] })],
      before: null,
      hasMore: false,
    });
    const { result } = renderHook(() => useSaveMessageFile(BURROW), { wrapper });
    act(() => result.current.mutate({ attachmentId: 'att_fonts' }));
    await waitFor(() => expect(inFiles(queryClient)).toBe(true));
    reply.resolve(json({ error: { code: 'forbidden', message: 'Only people save files.' } }, 403));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Only people save files.');
    expect(inFiles(queryClient)).toBe(false);
    expect(bodies).toEqual([{ attachmentId: 'att_fonts', folder: '' }]);
  });
});

describe('a Chat thread’s choice (CR-02, AP-2682)', () => {
  const runtimeKey = queryKeys.chats.runtime({ params: B, query: { thread: 'msg_root' } });
  const thread = (qc: QueryClient) => qc.getQueryData(runtimeKey)?.thread;
  const seed = (qc: QueryClient) =>
    qc.setQueryData(runtimeKey, {
      assistantId: 'prn_neo' as never,
      assistantName: 'Neo',
      default: { provider: 'claude' },
      thread: null,
      providers: [],
    });

  it('shows at once and keeps the Whombat’s answer', async () => {
    const reply = deferred<Response>();
    const bodies: unknown[] = [];
    const { wrapper, queryClient } = setup((_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return reply.promise;
    });
    seed(queryClient);
    const { result } = renderHook(() => useSetThreadRuntime(BURROW), { wrapper });
    act(() => result.current.mutate({ rootId: 'msg_root', runtime: { provider: 'codex', effort: 'high' } }));
    await waitFor(() => expect(thread(queryClient)).toEqual({ provider: 'codex', effort: 'high' }));
    reply.resolve(json({ thread: { provider: 'codex', effort: 'high', fast: true } }));
    await waitFor(() =>
      expect(thread(queryClient)).toEqual({ provider: 'codex', effort: 'high', fast: true }),
    );
    expect(bodies).toEqual([{ runtime: { provider: 'codex', effort: 'high' } }]);
  });

  it('goes back with the Whombat’s words when it refuses', async () => {
    const reply = deferred<Response>();
    const refused = vi.fn();
    const { wrapper, queryClient } = setup(() => reply.promise);
    seed(queryClient);
    const { result } = renderHook(() => useSetThreadRuntime(BURROW, { onRefused: refused }), { wrapper });
    act(() => result.current.mutate({ rootId: 'msg_root', runtime: { provider: 'codex' } }));
    await waitFor(() => expect(thread(queryClient)).toEqual({ provider: 'codex' }));
    reply.resolve(
      json({ error: { code: 'forbidden', message: 'ChatGPT isn’t set up on this Whombat.' } }, 403),
    );
    await waitFor(() => expect(refused).toHaveBeenCalledWith('ChatGPT isn’t set up on this Whombat.'));
    expect(thread(queryClient)).toBeNull();
  });
});

describe('useSessionProtocol', () => {
  it('follows the negotiated welcome version and updates when a box rolls back', async () => {
    const { session, appliance } = createFakeSession({
      account: { id: 'acc_mara', name: 'Mara' },
      handle: async () => ({ status: 200, body: {} }),
      session: { backoff: { initialMs: 2, maxMs: 5 } },
    });
    const client = createClient({ session, validateResponses: false });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WhombatClientProvider client={client} queryClient={queryClient} connect={false}>
        {children}
      </WhombatClientProvider>
    );
    const { result } = renderHook(() => useSessionProtocol(), { wrapper });
    expect(result.current).toBeNull();

    act(() => session.connect());
    await waitFor(() => expect(result.current).toEqual({ major: 5, minor: 8 }));

    // Simulate a rollback to minor 2: reconnect picks up the older welcome version.
    appliance.faults.protocolMinor(2);
    appliance.faults.restart();
    await waitFor(() => expect(result.current).toEqual({ major: 5, minor: 2 }));

    session.close();
  });
});
