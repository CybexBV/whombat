import { describe, expect, it } from 'vitest';
import type { Investigation, InvestigationEvent } from '../../api/assist';
import { alertInvestigationLabel, costText, investigationOfAlert, providerLine, stateColor } from './labels';
import { keepOpen, withInvestigation } from './open';
import { buildTranscript, inputRows, pendingApprovals, stepDuration } from './transcript';

let seq = 0;
const at = '2026-10-17T10:00:00Z';
const e = (body: Record<string, unknown>) => ({ seq: ++seq, at, ...body }) as InvestigationEvent;

describe('assistant transcript', () => {
  const events: InvestigationEvent[] = [
    e({ kind: 'user', text: 'Investigate', by: 'admin' }),
    e({ kind: 'status', state: 'running', text: null }),
    e({ kind: 'tool', tool_id: 't1', tool: 'diagnose', title: 'SMART data', server: 'blackbox', input: { host: 'blackbox', check: 'smart', args: { device: 'sdc' } } }),
    e({ kind: 'tool_result', tool_id: 't1', ok: true, output: '…', truncated: false, duration_ms: 1840 }),
    e({ kind: 'tool', tool_id: 't2', tool: 'diagnose', title: 'Logs', server: 'blackbox', input: { check: 'logs' } }),
    e({ kind: 'assistant', text: '**sdc** is failing.' }),
    e({ kind: 'assistant', text: '  ' }),
    e({ kind: 'tool', tool_id: 't3', tool: 'run_command', title: 'Run command', server: 'blackbox', input: { command: 'smartctl -t short /dev/sdc' } }),
    e({ kind: 'approval', approval_id: 'ap1', tool_id: 't3', server: 'blackbox', action: 'command', command: 'smartctl -t short /dev/sdc', reason: 'Self-test' }),
    e({ kind: 'status', state: 'waiting', text: null }),
    e({ kind: 'usage', cost_usd: 0.1, input_tokens: 1, output_tokens: 1 }),
  ];

  it('groups tool calls with their results and approvals with their calls', () => {
    const items = buildTranscript(events);
    expect(items.map((i) => i.kind)).toEqual(['user', 'step', 'step', 'assistant', 'approval']);
    expect(items[1]).toMatchObject({ kind: 'step', tool: { tool_id: 't1' }, result: { ok: true } });
    expect(items[2]).toMatchObject({ kind: 'step', tool: { tool_id: 't2' }, result: null });
    expect(items[4]).toMatchObject({ kind: 'approval', seq: 8, tool: { tool_id: 't3' }, decision: null, result: null });
    expect(pendingApprovals(events).map((a) => a.approval_id)).toEqual(['ap1']);

    const later = [
      ...events,
      e({ kind: 'approval_decided', approval_id: 'ap1', decision: 'declined', by: 'admin', reply: 'not now' }),
      e({ kind: 'tool_result', tool_id: 't3', ok: false, output: 'Declined', truncated: false, duration_ms: 0 }),
      e({ kind: 'status', state: 'stopped', text: null }),
      e({ kind: 'status', state: 'idle', text: 'Resumed by admin' }),
      e({ kind: 'summary', text: 'Replace sdc', resolved: false }),
      e({ kind: 'error', text: 'Token expired' }),
    ];
    const all = buildTranscript(later);
    expect(all.map((i) => i.kind)).toEqual(['user', 'step', 'step', 'assistant', 'approval', 'status', 'status', 'summary', 'error']);
    expect(all[4]).toMatchObject({ decision: { decision: 'declined', reply: 'not now' }, result: { ok: false } });
    expect(all[6]).toMatchObject({ state: 'idle', text: 'Resumed by admin' });
    expect(pendingApprovals(later)).toEqual([]);
    // An approval without its tool event still shows.
    expect(buildTranscript([e({ kind: 'approval', approval_id: 'x', tool_id: 'tx', server: 'h', action: 'guest_action', command: 'stop pve:101', reason: '' })]).map((i) => i.kind)).toEqual(['approval']);
  });

  it('formats tool input and durations', () => {
    expect(inputRows({ host: 'blackbox', check: 'smart', args: { device: 'sdc', lines: 200, deep: { a: 1 } }, empty: null, list: ['a', 'b'] })).toEqual([
      ['host', 'blackbox'],
      ['check', 'smart'],
      ['args', 'device=sdc lines=200 deep={"a":1}'],
      ['list', 'a, b'],
    ]);
    expect(stepDuration(84)).toBe('84 ms');
    expect(stepDuration(1840)).toBe('1.8 s');
    expect(stepDuration(24_400)).toBe('24 s');
    expect(stepDuration(65_000)).toBe('1 min 5 s');
  });
});

describe('assistant labels and links', () => {
  const inv = (id: string, alert: string | null, state: Investigation['state']) => ({ id, alert_id: alert, state }) as Investigation;

  it('names the state an alert row shows', () => {
    expect(alertInvestigationLabel('starting')).toBe('Investigating…');
    expect(alertInvestigationLabel('running')).toBe('Investigating…');
    expect(alertInvestigationLabel('waiting')).toBe('Waiting for you');
    for (const s of ['idle', 'done', 'failed', 'stopped'] as const) expect(alertInvestigationLabel(s)).toBe('Investigated');
    expect(investigationOfAlert([inv('b', 'al_1', 'done'), inv('a', 'al_1', 'failed')], 'al_1')?.id).toBe('b');
    expect(investigationOfAlert([inv('a', 'al_2', 'done')], 'al_1')).toBeUndefined();
  });

  it('colors, provider lines and costs', () => {
    expect(stateColor({ state: 'done', resolved: true })).toBe('var(--good)');
    expect(stateColor({ state: 'done', resolved: false })).toBe('var(--warning)');
    expect(stateColor({ state: 'failed', resolved: null })).toBe('var(--critical)');
    expect(providerLine({ provider: 'claude', model: 'opus' })).toBe('Claude Code · opus');
    expect(providerLine({ provider: 'codex', model: null })).toBe('Codex');
    expect(costText(0.4249)).toBe('≈ $0.42');
    expect(costText(0.001)).toBe('≈ $0.01');
    expect(costText(null)).toBeNull();
  });

  it('keeps the panel open across links', () => {
    expect(withInvestigation('?tab=guests', 'inv_1')).toBe('?tab=guests&investigation=inv_1');
    expect(withInvestigation('?investigation=inv_1', null)).toBe('');
    expect(keepOpen('/servers/basalt', 'inv_1')).toBe('/servers/basalt?investigation=inv_1');
    expect(keepOpen('/servers/basalt?tab=storage#system', 'inv_1')).toBe('/servers/basalt?tab=storage&investigation=inv_1#system');
  });
});
