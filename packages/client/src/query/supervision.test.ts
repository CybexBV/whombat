import { QueryClient } from '@tanstack/query-core';
import { api, type Plan } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { activity, BURROW, message, plan, t } from '../test/fixtures';
import { endpointKey } from './keys';
import {
  type ActivityListData,
  applyActivity,
  applyPlan,
  invalidateWork,
  reduceActivityList,
  reducePlanList,
} from './supervision';

const B = { burrow: BURROW };

describe('reduceActivityList (WS-12)', () => {
  const running = activity();
  const failed = activity({ seq: 2, status: 'failed', updatedAt: t(2) });
  const read = activity({
    id: 'act_2',
    seq: 3,
    kind: 'read',
    status: 'done',
    startedAt: t(3),
    updatedAt: t(3),
  });

  it('upserts by id and keeps one row per action', () => {
    const list = reduceActivityList(reduceActivityList([], running), failed);
    expect(list.map((a) => [a.id, a.status])).toEqual([['act_1', 'failed']]);
  });

  it('ignores duplicates and older reports', () => {
    const list = reduceActivityList([], failed);
    expect(reduceActivityList(list, failed)).toBe(list);
    expect(reduceActivityList(list, running)).toBe(list);
  });

  it('takes the server’s later update of the same report (interrupted, same seq)', () => {
    const interrupted = activity({ status: 'interrupted', updatedAt: t(5) });
    expect(reduceActivityList([running], interrupted)[0]?.status).toBe('interrupted');
  });

  it('orders rows oldest first whatever order they arrive in', () => {
    const a = reduceActivityList(reduceActivityList([], read), failed);
    const b = reduceActivityList(reduceActivityList([], failed), read);
    expect(a.map((x) => x.id)).toEqual(['act_1', 'act_2']);
    expect(b).toEqual(a);
  });
});

describe('reducePlanList', () => {
  const open = plan();
  const done = plan({
    updatedAt: t(5),
    steps: plan().steps.map((s) => ({ ...s, state: 'done' as const, stateLabel: 'Done' })),
  });

  it('drops a plan from the open list once every step is done or cancelled, keeps it in all', () => {
    expect(reducePlanList([open], done, { status: 'open' })).toEqual([]);
    expect(reducePlanList([open], done, { status: 'all' })).toEqual([done]);
  });

  it('keeps plans of other conversations out', () => {
    const other = plan({ id: 'pln_other', conversationId: 'cnv_general' });
    expect(reducePlanList([open], other, { conversationId: 'cnv_chat', status: 'open' })).toEqual([open]);
  });

  it('inserts a new plan newest first and never replaces a newer copy', () => {
    const fresh = plan({ id: 'pln_new', createdAt: t(9), updatedAt: t(9) });
    expect(reducePlanList([open], fresh, { status: 'open' }).map((p) => p.id)).toEqual([
      'pln_new',
      'pln_billing',
    ]);
    const newer = plan({ title: 'Newer', updatedAt: t(9) });
    const list = [newer];
    expect(reducePlanList(list, plan({ updatedAt: t(1) }), { status: 'open' })).toBe(list);
  });
});

describe('applyPlan', () => {
  it('updates the pane, the card and lists, but never with an older plan', () => {
    const qc = new QueryClient();
    const getKey = endpointKey(api.plans.get, { params: { ...B, planId: 'pln_billing' } });
    const listKey = endpointKey(api.messages.list, {
      params: { ...B, conversationId: 'cnv_chat' },
    });
    qc.setQueryData(getKey, { plan: plan({ title: 'Newest', updatedAt: t(9) }) });
    qc.setQueryData(listKey, {
      messages: [message('msg_plan', { card: { kind: 'plan', plan: plan() } })],
      before: null,
      hasMore: false,
    });
    applyPlan(qc, plan({ title: 'Middle', updatedAt: t(5) }));
    expect((qc.getQueryData(getKey) as { plan: Plan }).plan.title).toBe('Newest');
    const card = (qc.getQueryData(listKey) as { messages: { card: { plan: Plan } }[] }).messages[0]?.card;
    expect(card?.plan.title).toBe('Middle');
  });
});

describe('applyActivity', () => {
  const empty: ActivityListData = { activities: [], cursor: null, hasMore: false };

  it('refetches a run’s feed when the cache can’t tell the run’s id', () => {
    const qc = new QueryClient();
    const key = endpointKey(api.activity.list, { params: B, query: { runNumber: 1907 } });
    qc.setQueryData(key, empty);
    applyActivity(qc, activity());
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    expect((qc.getQueryData(key) as ActivityListData).activities).toEqual([]);
  });

  it('adds to a run’s feed that already has the turn', () => {
    const qc = new QueryClient();
    const key = endpointKey(api.activity.list, { params: B, query: { runNumber: 1907 } });
    qc.setQueryData(key, { ...empty, activities: [activity()] });
    applyActivity(qc, activity({ id: 'act_9', seq: 4, startedAt: t(4), updatedAt: t(4) }));
    expect((qc.getQueryData(key) as ActivityListData).activities.map((a) => a.id)).toEqual([
      'act_1',
      'act_9',
    ]);
  });
});

describe('invalidateWork', () => {
  it('does nothing without a Work view in the cache', () => {
    const qc = new QueryClient();
    invalidateWork(qc);
    expect(qc.getQueryCache().getAll()).toEqual([]);
  });
});
