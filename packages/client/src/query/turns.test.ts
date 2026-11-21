import { QueryClient } from '@tanstack/query-core';
import type { Message, WorkItem, WorkOverview } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { queryKeys } from './keys';
import { applyTurnRetry, markTurnRetried, markWorkRetried } from './turns';

const AT = '2026-09-30T12:32:00.000Z';

function failed(over: Partial<Message> = {}): Message {
  return {
    id: 'msg_failed',
    conversationId: 'cnv_dm-dusty',
    authorId: 'prn_dusty',
    createdAt: '2026-09-30T12:00:00.000Z',
    editedAt: null,
    text: 'I couldn’t finish this.',
    mentions: [],
    reactions: [],
    attachments: [],
    clientId: null,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    suggestions: [],
    more: null,
    card: {
      kind: 'turn_failed',
      dispatchId: 'dsp_failed',
      agentId: 'prn_dusty',
      code: 'signin',
      reason: 'I couldn’t start because Claude isn’t set up or signed in for this.',
      retriedAt: null,
      retryDispatchId: null,
    },
    ...over,
  } as Message;
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'dispatch:dsp_failed',
    kind: 'dispatch',
    section: 'failed',
    title: 'Dusty · invoice numbers',
    where: 'Dusty',
    agentId: 'prn_dusty',
    ownerId: 'prn_mara',
    status: { text: 'NOT SIGNED IN', tone: 'bad' },
    detail: '',
    since: '2026-09-30T12:00:00.000Z',
    health: null,
    activity: null,
    link: { type: 'dm', agent: 'dusty' },
    actions: ['retry_turn', 'open'],
    refs: {
      conversationId: 'cnv_dm-dusty',
      messageId: null,
      runNumber: null,
      runId: null,
      approvalNumber: null,
      approvalId: null,
      planId: null,
      stepId: null,
      automationRunNumber: null,
      automationRunId: null,
      dispatchId: 'dsp_failed',
    },
    failure: { code: 'signin', reason: 'Sign in.', detail: null, retriedAt: null, retryDispatchId: null },
    ...over,
  } as WorkItem;
}

const overview = (items: WorkItem[]): WorkOverview =>
  ({
    sections: [{ section: 'failed', title: 'FAILED', items }],
    counts: { needs_you: 0, running: 0, queued: 0, blocked: 0, failed: items.length, done: 0 },
    generatedAt: AT,
  }) as WorkOverview;

describe('Try again in the cache (essentials item 4, CT-167)', () => {
  it('marks the failed turn’s card retried, once, and leaves other messages alone', () => {
    const m = failed();
    const next = markTurnRetried(m, 'dsp_failed', 'dsp_retry', AT);
    expect(next.card).toMatchObject({ retriedAt: AT, retryDispatchId: 'dsp_retry' });
    // Already retried: its time stays.
    expect(markTurnRetried(next, 'dsp_failed', 'dsp_other', '2026-09-30T13:00:00.000Z')).toBe(next);
    expect(markTurnRetried(m, 'dsp_elsewhere', 'dsp_retry', AT)).toBe(m);
    const plain = failed({ card: null });
    expect(markTurnRetried(plain, 'dsp_failed', 'dsp_retry', AT)).toBe(plain);
  });

  it('marks the Work item of that turn and keeps the overview when nothing matches', () => {
    const o = overview([
      item(),
      item({ id: 'dispatch:other', refs: { ...item().refs, dispatchId: 'dsp_other' } }),
    ]);
    const next = markWorkRetried(o, 'dsp_failed', 'dsp_retry', AT);
    expect(next.sections[0]?.items[0]?.failure).toMatchObject({
      retriedAt: AT,
      retryDispatchId: 'dsp_retry',
    });
    expect(next.sections[0]?.items[1]).toBe(o.sections[0]?.items[1]);
    expect(markWorkRetried(o, 'dsp_nothing', 'dsp_retry', AT)).toBe(o);
  });

  it('puts the retry in every cached message list and the Work view', () => {
    const qc = new QueryClient();
    const listKey = queryKeys.messages.list({
      params: { burrow: 'burrow-hq', conversationId: 'cnv_dm-dusty' },
    });
    qc.setQueryData(listKey, { messages: [failed()], before: null, hasMore: false });
    const workKey = queryKeys.work.overview({ params: { burrow: 'burrow-hq' } });
    qc.setQueryData(workKey, overview([item()]));
    applyTurnRetry(qc, 'dsp_failed', 'dsp_retry', AT);
    const list = qc.getQueryData<{ messages: Message[] }>(listKey);
    expect(list?.messages[0]?.card).toMatchObject({ kind: 'turn_failed', retriedAt: AT });
    expect(qc.getQueryData<WorkOverview>(workKey)?.sections[0]?.items[0]?.failure?.retriedAt).toBe(AT);
  });
});
