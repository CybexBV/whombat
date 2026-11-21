import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { appendEvent, applyAssistantEvent, assistKeys, type Investigation, type InvestigationDetail, type InvestigationEvent, removeInvestigation, upsertInvestigation, withInvestigation } from './assist';

const inv = (id: string, created: string, more: Partial<Investigation> = {}): Investigation => ({
  id,
  title: `Investigation ${id}`,
  server: 'basalt',
  server_name: 'basalt',
  alert_id: null,
  provider: 'claude',
  model: null,
  state: 'running',
  access: 'ask',
  auto: false,
  created_by: 'admin',
  created_at: created,
  updated_at: created,
  summary: null,
  resolved: null,
  cost_usd: null,
  pending_approvals: 0,
  ...more,
});

const ev = (seq: number, text = `step ${seq}`): InvestigationEvent => ({ seq, at: '2026-10-17T10:00:00Z', kind: 'assistant', text });

describe('assistant cache reducers', () => {
  const a = inv('a', '2026-10-17T10:00:00Z');
  const b = inv('b', '2026-10-17T11:00:00Z');
  const c = inv('c', '2026-10-17T12:00:00Z', { server: 'shale', alert_id: 'al_03' });

  it('upserts investigations newest first, within the filters and the limit', () => {
    expect(upsertInvestigation([b, a], c)).toEqual([c, b, a]);
    expect(upsertInvestigation([c, a], b)).toEqual([c, b, a]);
    expect(upsertInvestigation([c, b], a)).toEqual([c, b, a]);
    expect(upsertInvestigation([b, a], c, { limit: 2 })).toEqual([c, b]);
    expect(upsertInvestigation([b, a], c, { server: 'basalt' })).toEqual([b, a]);
    expect(upsertInvestigation([], c, { alert: 'al_03' })).toEqual([c]);
    const done = { ...b, state: 'done' as const, updated_at: '2026-10-17T11:30:00Z' };
    expect(upsertInvestigation([c, b, a], done)).toEqual([c, done, a]);
    // An older copy (a late answer) does not replace a newer one.
    expect(upsertInvestigation([c, done, a], b)).toEqual([c, done, a]);
  });

  it('removes investigations', () => {
    const list = [b, a];
    expect(removeInvestigation(list, 'a')).toEqual([b]);
    expect(removeInvestigation(list, 'x')).toBe(list);
  });

  it('appends events once, in seq order', () => {
    const d: InvestigationDetail = { investigation: a, events: [ev(1), ev(2)] };
    expect(appendEvent(d, ev(3)).events.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(appendEvent(d, ev(2, 'again'))).toBe(d);
    expect(appendEvent({ ...d, events: [ev(1), ev(3)] }, ev(2)).events.map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it('replaces the detail’s investigation unless the cached one is newer', () => {
    const d: InvestigationDetail = { investigation: a, events: [] };
    const later = { ...a, state: 'waiting' as const, updated_at: '2026-10-17T10:05:00Z' };
    expect(withInvestigation(d, later).investigation).toBe(later);
    expect(withInvestigation({ investigation: later, events: [] }, a).investigation).toBe(later);
    expect(withInvestigation(d, b)).toBe(d);
  });

  it('applies the SSE events to the cached lists and details', () => {
    const qc = new QueryClient();
    qc.setQueryData(assistKeys.list({}), [b, a]);
    qc.setQueryData(assistKeys.list({ server: 'shale' }), []);
    qc.setQueryData(assistKeys.list({ server: 'basalt', limit: 1 }), [b]);
    qc.setQueryData<InvestigationDetail>(assistKeys.detail('a'), { investigation: a, events: [ev(1)] });

    applyAssistantEvent(qc, 'assistant.investigation', c as unknown as Record<string, unknown>);
    expect(qc.getQueryData(assistKeys.list({}))).toEqual([c, b, a]);
    expect(qc.getQueryData(assistKeys.list({ server: 'shale' }))).toEqual([c]);
    expect(qc.getQueryData(assistKeys.list({ server: 'basalt', limit: 1 }))).toEqual([b]);

    applyAssistantEvent(qc, 'assistant.event', { investigation: 'a', event: ev(2) });
    applyAssistantEvent(qc, 'assistant.event', { investigation: 'a', event: ev(2) });
    applyAssistantEvent(qc, 'assistant.event', { investigation: 'zzz', event: ev(9) });
    expect(qc.getQueryData<InvestigationDetail>(assistKeys.detail('a'))?.events.map((x) => x.seq)).toEqual([1, 2]);
    expect(qc.getQueryData(assistKeys.detail('zzz'))).toBeUndefined();

    const waiting = { ...a, state: 'waiting', pending_approvals: 1, updated_at: '2026-10-17T10:09:00Z' };
    applyAssistantEvent(qc, 'assistant.investigation', waiting);
    expect(qc.getQueryData<InvestigationDetail>(assistKeys.detail('a'))?.investigation).toEqual(waiting);

    applyAssistantEvent(qc, 'assistant.deleted', { id: 'a' });
    expect(qc.getQueryData<Investigation[]>(assistKeys.list({}))?.map((x) => x.id)).toEqual(['c', 'b']);
    expect(qc.getQueryData(assistKeys.detail('a'))).toBeUndefined();

    const state = { settings: { enabled: true }, runner: { connected: true, sandboxed: true, error: null }, providers: {}, running: 0 };
    applyAssistantEvent(qc, 'assistant.state', state);
    expect(qc.getQueryData(assistKeys.state)).toEqual(state);
    applyAssistantEvent(qc, 'assistant.state', { nonsense: true });
    expect(qc.getQueryData(assistKeys.state)).toEqual(state);
  });
});
