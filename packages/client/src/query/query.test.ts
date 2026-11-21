import { QueryClient } from '@tanstack/query-core';
import type { ApprovalResponse } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { approval, BURROW, bootstrap, message, t } from '../test/fixtures';
import { drivenRealtime } from '../test/session';
import { connectRealtimeToQueryClient } from './connect';
import { queryKeys } from './keys';
import {
  addOptimisticMessage,
  applyOptimisticDecision,
  confirmOptimisticMessage,
  findCachedApproval,
  restore,
  rollbackOptimisticMessage,
} from './optimistic';

const B = { burrow: BURROW };
const CONV = { ...B, conversationId: 'cnv_chat' };

function _json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('connectRealtimeToQueryClient', () => {
  it('a resync invalidates what its topics feed', () => {
    const qc = new QueryClient();
    const rt = drivenRealtime();
    connectRealtimeToQueryClient(rt, qc);
    const billing = queryKeys.messages.list({ params: CONV });
    const general = queryKeys.messages.list({ params: { ...B, conversationId: 'cnv_general' } });
    qc.setQueryData(billing, { messages: [], before: null, hasMore: false });
    qc.setQueryData(general, { messages: [], before: null, hasMore: false });
    rt.subscribe(['conv:cnv_chat', 'conv:cnv_general']);
    rt.connect();
    rt.open();
    rt.event('conv:cnv_chat', { type: 'message.created', message: message('msg_1') });
    expect(qc.getQueryState(billing)?.isInvalidated).toBe(false);
    rt.resync({ reason: 'snapshot', topics: ['conv:cnv_chat', 'conv:cnv_general'] });
    expect(qc.getQueryState(billing)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(general)?.isInvalidated).toBe(true);
  });
});

describe('optimistic updates', () => {
  const seed = () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.conversations.bootstrap({ params: B }), bootstrap());
    qc.setQueryData(queryKeys.messages.list({ params: CONV }), {
      messages: [
        message('msg_1', {
          reactions: [
            {
              value: 'finally',
              count: 3,
              mine: false,
              principalIds: ['prn_banjo', 'prn_waffle', 'prn_neo'],
            },
          ],
        }),
      ],
      before: null,
      hasMore: false,
    });
    return qc;
  };
  const ids = (qc: QueryClient) =>
    qc.getQueryData(queryKeys.messages.list({ params: CONV }))?.messages.map((m) => m.id);

  it('keeps one copy when the realtime echo beats the HTTP response', () => {
    const qc = seed();
    addOptimisticMessage(qc, {
      conversationId: 'cnv_chat',
      authorId: 'prn_mara',
      text: 'Ship it',
      clientId: 'c1',
      createdAt: t(2),
    });
    const server = message('msg_2', { createdAt: t(2), text: 'Ship it', clientId: 'c1' });
    confirmOptimisticMessage(qc, 'c1', server); // as the realtime reducer would
    confirmOptimisticMessage(qc, 'c1', server);
    expect(ids(qc)).toEqual(['msg_1', 'msg_2']);
  });

  it('rolls a failed send back', () => {
    const qc = seed();
    addOptimisticMessage(qc, {
      conversationId: 'cnv_chat',
      authorId: 'prn_mara',
      text: 'Ship it',
      clientId: 'c1',
      createdAt: t(2),
    });
    rollbackOptimisticMessage(qc, 'cnv_chat', 'c1');
    expect(ids(qc)).toEqual(['msg_1']);
  });

  it('decides an approval everywhere and rolls it back', () => {
    const qc = seed();
    const modal = queryKeys.approvals.get({ params: { ...B, number: 12 } });
    qc.setQueryData(modal, { approval: approval(), eventId: null } satisfies ApprovalResponse);
    expect(findCachedApproval(qc, 12)?.id).toBe('apr_12');
    const snap = applyOptimisticDecision(qc, 12, 'approve', 'prn_mara', t(20));
    const decided = qc.getQueryData(modal)?.approval;
    expect(decided).toMatchObject({ state: 'approved', decidedById: 'prn_mara', decidedAt: t(20) });
    expect(decided?.conditions[0]?.met).toBe(true);
    applyOptimisticDecision(qc, 12, 'undo', 'prn_mara', t(21));
    expect(qc.getQueryData(modal)?.approval).toMatchObject({ state: 'pending', decidedById: null });
    restore(qc, snap ?? []);
    expect(qc.getQueryData(modal)?.approval.state).toBe('pending');
    expect(applyOptimisticDecision(qc, 99, 'approve', 'prn_mara')).toBeNull();
  });
});
