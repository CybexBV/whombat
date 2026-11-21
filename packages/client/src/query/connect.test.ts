import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { type AnyEndpoint, api } from '@whombat/core/contracts';
import { SESSION_OPERATIONS } from '@whombat/protocol/session';
import { describe, expect, it, vi } from 'vitest';
import { DESK_QUERY_KEY } from '../desk/react';
import { BURROW } from '../test/fixtures';
import { invalidateForResync, TOPIC_ENDPOINTS } from './connect';
import { endpointScope } from './keys';

const B = { burrow: BURROW };

/** One cached (data-holding) query per endpoint id, keyed like the real ones. */
function seeded(...ids: string[]) {
  const qc = new QueryClient();
  for (const id of ids) qc.setQueryData([...endpointScope(id, B), {}], { seeded: id });
  return qc;
}
const invalidated = (qc: QueryClient) =>
  qc
    .getQueryCache()
    .findAll()
    .filter((q) => q.state.isInvalidated)
    .map((q) => q.queryKey[1])
    .sort();

describe('resync after a reconnect (WE-04)', () => {
  it('names only real read endpoints, or session-native reads cached under their op (desk.get)', () => {
    const reads = new Set(
      Object.values(api).flatMap((group) =>
        Object.values(group as Record<string, AnyEndpoint>)
          .filter((ep) => ep.method === 'GET')
          .map((ep) => ep.id),
      ),
    );
    const sessionReads = new Set(
      [...SESSION_OPERATIONS.values()].filter((spec) => !spec.mutating).map((spec) => spec.op),
    );
    for (const ids of Object.values(TOPIC_ENDPOINTS))
      for (const id of ids)
        expect(reads.has(id) || sessionReads.has(id), `${id} is a read endpoint`).toBe(true);
  });

  it('a me topic refetches the desk screen (desk.changed travels there)', () => {
    const qc = new QueryClient();
    qc.setQueryData(DESK_QUERY_KEY, { seeded: 'desk.get' });
    invalidateForResync(qc, { reason: 'reconnect', topics: ['me:prn_mara'] });
    expect(invalidated(qc)).toEqual(['desk.get']);
  });

  it('a burrow topic refetches what burrow events change (the AI gateway’s pool too), not the session, the AI sign-ins, the Vault or settings', () => {
    const qc = seeded(
      'conversations.bootstrap',
      'agent.get',
      'messages.list',
      'work.overview',
      'auth.session',
      'signins.list',
      'vault.list',
      'usage.list',
      'notifications.settings',
    );
    invalidateForResync(qc, { reason: 'reconnect', topics: ['burrow:bur_hq'] });
    expect(invalidated(qc)).toEqual([
      'agent.get',
      'conversations.bootstrap',
      'messages.list',
      'usage.list',
      'work.overview',
    ]);
  });

  it('a me topic adds the inbox and the viewer’s Files; a conversation its messages and typing', () => {
    const qc = seeded('notifications.inbox', 'files.summary', 'auth.session');
    qc.setQueryData(['whombat', 'typing', { conversationId: 'cnv_a' }], []);
    qc.setQueryData([...endpointScope('messages.list', { ...B, conversationId: 'cnv_a' }), {}], {});
    invalidateForResync(qc, { reason: 'reconnect', topics: ['me:prs_mara', 'conv:cnv_a'] });
    expect(invalidated(qc)).toEqual(['files.summary', 'messages.list', 'notifications.inbox']);
    expect(qc.getQueryData(['whombat', 'typing', { conversationId: 'cnv_a' }])).toBeUndefined();
  });

  it('fetches the open conversation’s reads once when its topic and the burrow’s resync together', async () => {
    const qc = new QueryClient();
    const fetched: string[] = [];
    const stops = ['messages.list', 'conversations.get', 'messages.thread'].map((id) =>
      new QueryObserver(qc, {
        queryKey: [...endpointScope(id, { ...B, conversationId: 'cnv_a' }), {}],
        queryFn: async () => {
          fetched.push(id);
          return { id };
        },
      }).subscribe(() => {}),
    );
    await vi.waitFor(() => expect(fetched).toHaveLength(3));
    await vi.waitFor(() => expect(qc.isFetching()).toBe(0));
    fetched.length = 0;
    invalidateForResync(qc, { reason: 'reconnect', topics: ['burrow:bur_hq', 'conv:cnv_a'] });
    await vi.waitFor(() => expect(qc.isFetching()).toBe(0));
    expect(fetched.sort()).toEqual(['conversations.get', 'messages.list', 'messages.thread']);
    for (const stop of stops) stop();
  });

  it('a conversation’s topic alone refetches that conversation’s messages, not another’s', () => {
    const qc = new QueryClient();
    for (const conversationId of ['cnv_a', 'cnv_b'])
      qc.setQueryData([...endpointScope('messages.list', { ...B, conversationId }), {}], {});
    invalidateForResync(qc, { reason: 'reconnect', topics: ['conv:cnv_a'] });
    const stale = qc
      .getQueryCache()
      .findAll({ predicate: (q) => q.state.isInvalidated })
      .map((q) => (q.queryKey[2] as { conversationId: string }).conversationId);
    expect(stale).toEqual(['cnv_a']);
  });
});

describe('resync of Chat’s reads', () => {
  it('a me topic refetches the Threads lists, which threads have something new and a thread’s choice of what answers', () => {
    // `chat.settled`, `chat.cleared`, `chat.thread_runtime` and `conversation.unread` travel on `me`.
    const qc = seeded('chats.threads', 'chats.unread', 'chats.runtime', 'messages.list', 'messages.thread');
    invalidateForResync(qc, { reason: 'gap', topics: ['me:prs_mara'] });
    expect(invalidated(qc)).toEqual([
      'chats.runtime',
      'chats.threads',
      'chats.unread',
      'messages.list',
      'messages.thread',
    ]);
  });

  it('a conversation’s topic refetches the Threads lists and its pins (a reply missed moves its thread)', () => {
    const qc = seeded('chats.threads', 'chats.list', 'conversations.pins', 'vault.list');
    invalidateForResync(qc, { reason: 'gap', topics: ['conv:cnv_a'] });
    expect(invalidated(qc)).toEqual(['chats.list', 'chats.threads', 'conversations.pins']);
  });
});
