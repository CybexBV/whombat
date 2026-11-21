// The assistant's fixture routes: off by default, ?assistant=1 seeds it,
// settings and the re-authentication toggle, simulated installs and
// sign-ins, and investigations whose transcript grows over SSE.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantState, Investigation, InvestigationDetail } from '../../src/api/assist-types';
import { CODEX_LOGIN_MS, STEP_MS } from './assist';
import { applyPageToggles } from './auth';
import { FixtureStore } from './state';
import { browser } from './testkit';

beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-10-17T10:00:00Z') }));
afterEach(() => vi.useRealTimers());

function setup(toggles = '') {
  const store = new FixtureStore();
  const b = browser(store);
  const st = store.states.get(b.id)!;
  if (toggles) applyPageToggles(st, new URLSearchParams(toggles));
  const state = () => b.call('GET', '/assistant').json as AssistantState;
  const detail = (id: string) => b.call('GET', `/assistant/investigations/${id}`).json as InvestigationDetail;
  const sse = () => st.events.backlog.map((e) => e.name);
  return { store, b, st, state, detail, sse };
}

describe('assistant fixtures', () => {
  it('is off by default, admins only', () => {
    const { b, st, state } = setup();
    expect(state()).toMatchObject({ settings: { enabled: false, access: 'full', auto_investigate: 'off' }, providers: { claude: { installed: false }, codex: { installed: false } }, running: 0 });
    expect(b.call('GET', '/assistant/investigations').json).toEqual([]);
    expect(b.call('POST', '/assistant/investigations', { alert: 'al_03' }).json).toMatchObject({ status: 409, code: 'assistant_disabled' });
    applyPageToggles(st, new URLSearchParams('role=operator'));
    expect(b.call('GET', '/assistant').json).toMatchObject({ status: 403, code: 'insufficient_role' });
  });

  it('?assistant=1 seeds investigations; lists filter by alert and server', () => {
    const { b, state, detail } = setup('assistant=1');
    expect(state()).toMatchObject({ settings: { enabled: true, access: 'ask' }, runner: { sandboxed: true }, providers: { claude: { installed: true, signed_in: true, update_available: true }, codex: { installed: true, signed_in: false } }, running: 1 });
    const all = b.call('GET', '/assistant/investigations').json as Investigation[];
    expect(all.map((i) => [i.id, i.state])).toEqual([
      ['inv_wear', 'waiting'],
      ['inv_md0', 'done'],
      ['inv_quartz', 'idle'],
      ['inv_backups', 'failed'],
    ]);
    expect(all[0]).toMatchObject({ alert_id: 'al_02', pending_approvals: 1, created_at: '2026-10-11T13:48:00Z', updated_at: '2026-10-11T13:48:34Z' });
    expect((b.call('GET', '/assistant/investigations?alert=al_02').json as Investigation[]).map((i) => i.id)).toEqual(['inv_wear']);
    expect((b.call('GET', '/assistant/investigations?server=granite&limit=1').json as Investigation[]).map((i) => i.id)).toEqual(['inv_md0']);
    const d = detail('inv_md0');
    expect(d.events.map((e) => e.seq)).toEqual(d.events.map((_, k) => k + 1));
    expect(d.events.filter((e) => e.kind === 'approval_decided')).toHaveLength(1);
    expect(b.call('GET', '/assistant/investigations/nope').json).toMatchObject({ status: 404, code: 'not_found' });
    expect(setup('assistant=nosandbox').state().runner).toEqual({ connected: true, sandboxed: false, error: null });
  });

  it('saves settings, asking for a recent sign-in while ?reauth=1 is pending', () => {
    const { b, st, state } = setup('reauth=1');
    expect(b.call('PUT', '/assistant/settings', { enabled: true }).json).toMatchObject({ status: 403, code: 'reauth_required' });
    expect(b.call('POST', '/auth/reauth', { password: 'wrong-password' }).json).toMatchObject({ status: 403, code: 'invalid_credentials' });
    expect(b.call('POST', '/auth/reauth', { password: 'correct horse battery' }).status).toBe(204);
    expect(b.call('PUT', '/assistant/settings', { enabled: true, access: 'read', auto_investigate: 'critical', claude_model: 'sonnet' }).json).toMatchObject({
      settings: { enabled: true, access: 'read', auto_investigate: 'critical', claude_model: 'sonnet', provider: 'claude' },
    });
    expect(b.call('PUT', '/assistant/settings', { access: 'root' }).json).toMatchObject({ status: 400, code: 'invalid_settings' });
    expect(b.call('PUT', '/assistant/settings', { provider: 'codex' }).json).toMatchObject({ status: 409, code: 'provider_not_installed' });
    expect(state().settings.access).toBe('read');
    expect(st.events.backlog.filter((e) => e.name === 'assistant.state')).toHaveLength(1);
  });

  it('installs with progress, signs in with a token or a device code, signs out', () => {
    const { b, state, sse } = setup();
    expect(b.call('POST', '/assistant/providers/claude/login', { token: 'sk-ant-oat01-abcdefghij' }).json).toMatchObject({ status: 409, code: 'provider_not_installed' });
    const r = b.call('POST', '/assistant/providers/claude/install', {});
    expect(r.status).toBe(202);
    expect((r.json as AssistantState).providers.claude).toMatchObject({ busy: 'installing', progress: 0 });
    vi.advanceTimersByTime(600);
    expect(state().providers.claude.progress).toBe(0.4);
    vi.advanceTimersByTime(900);
    expect(state().providers.claude).toMatchObject({ installed: true, version: '2.3.16', busy: null, progress: null, update_available: false });
    expect(sse().filter((n) => n === 'assistant.state')).toHaveLength(6);
    expect(b.call('POST', '/assistant/providers/claude/login', { token: 'not a token' }).json).toMatchObject({ status: 400, code: 'invalid_token' });
    expect((b.call('POST', '/assistant/providers/claude/login', { token: 'sk-ant-oat01-abcdefghij' }).json as AssistantState).providers.claude).toMatchObject({ signed_in: true, account: 'Claude subscription' });

    b.call('POST', '/assistant/providers/codex/install', {});
    vi.advanceTimersByTime(1500);
    const login = (b.call('POST', '/assistant/providers/codex/login', {}).json as AssistantState).providers.codex;
    expect(login).toMatchObject({ signed_in: false, login: { user_code: 'K7QX-4HTM', verification_url: 'https://auth.openai.com/codex/device' } });
    vi.advanceTimersByTime(CODEX_LOGIN_MS);
    expect(state().providers.codex).toMatchObject({ signed_in: true, login: null });
    expect((b.call('DELETE', '/assistant/providers/codex/login').json as AssistantState).providers.codex).toMatchObject({ signed_in: false, account: null });
    expect((b.call('DELETE', '/assistant/providers/codex').json as AssistantState).providers.codex).toMatchObject({ installed: false, version: null });
  });

  it('runs a new investigation for an alert over SSE', () => {
    const { b, detail, sse } = setup('assistant=1');
    const r = b.call('POST', '/assistant/investigations', { alert: 'al_03' });
    expect(r.status).toBe(201);
    const inv = r.json as Investigation;
    expect(inv).toMatchObject({ title: 'CPU package at 83 °C', server: 'shale', alert_id: 'al_03', state: 'starting', provider: 'claude', created_by: 'admin' });
    expect(detail(inv.id).events.map((e) => e.kind)).toEqual(['user']);
    vi.advanceTimersByTime(STEP_MS * 3);
    expect(detail(inv.id).investigation.state).toBe('running');
    vi.advanceTimersByTime(STEP_MS * 20);
    const d = detail(inv.id);
    expect(d.investigation).toMatchObject({ state: 'done', resolved: false, cost_usd: 0.09 });
    expect(d.events.map((e) => e.kind)).toEqual(['user', 'status', 'tool', 'tool_result', 'tool', 'tool_result', 'tool', 'tool_result', 'assistant', 'summary', 'usage', 'status']);
    expect(sse().filter((n) => n === 'assistant.event')).toHaveLength(12);
    expect(b.call('POST', '/assistant/investigations', { server: 'basalt' }).json).toMatchObject({ status: 400, code: 'invalid_prompt' });
    expect(b.call('POST', '/assistant/investigations', { server: 'nowhere', prompt: 'x' }).json).toMatchObject({ status: 400, code: 'invalid_server' });
    const fleet = b.call('POST', '/assistant/investigations', { prompt: 'Is anything near a limit?' }).json as Investigation;
    expect(fleet).toMatchObject({ server: null, title: 'Is anything near a limit?' });
    vi.advanceTimersByTime(STEP_MS * 10);
    expect(detail(fleet.id).investigation.state).toBe('idle');
  });

  it('decides approvals once, continues with messages, stops and deletes', () => {
    const { b, detail, sse } = setup('assistant=1');
    expect(b.call('POST', '/assistant/investigations/inv_wear/approvals/ap_9', { approve: true }).json).toMatchObject({ status: 404 });
    expect(b.call('POST', '/assistant/investigations/inv_wear/approvals/ap_1', {}).json).toMatchObject({ status: 400 });
    const r = b.call('POST', '/assistant/investigations/inv_wear/approvals/ap_1', { approve: true, reply: 'go ahead' });
    expect(r.json).toMatchObject({ id: 'inv_wear', pending_approvals: 0 });
    expect(b.call('POST', '/assistant/investigations/inv_wear/approvals/ap_1', { approve: false }).json).toMatchObject({ status: 409, code: 'already_decided' });
    vi.advanceTimersByTime(STEP_MS * 5);
    const d = detail('inv_wear');
    expect(d.investigation.state).toBe('idle');
    expect(d.events.slice(-4).map((e) => e.kind)).toEqual(['status', 'tool_result', 'assistant', 'status']);
    expect(d.events.find((e) => e.kind === 'approval_decided')).toMatchObject({ decision: 'approved', by: 'admin', reply: 'go ahead' });

    expect(b.call('POST', '/assistant/investigations/inv_md0/messages', { text: '' }).json).toMatchObject({ status: 400 });
    expect(b.call('POST', '/assistant/investigations/inv_md0/messages', { text: 'Which disk should I buy?' }).status).toBe(202);
    expect(detail('inv_md0').investigation.state).toBe('running');
    b.call('POST', '/assistant/investigations/inv_md0/stop', {});
    vi.advanceTimersByTime(STEP_MS * 5);
    const stopped = detail('inv_md0');
    expect(stopped.investigation.state).toBe('stopped');
    expect(stopped.events.at(-1)).toMatchObject({ kind: 'status', state: 'stopped', text: 'Stopped by admin' });

    expect(b.call('DELETE', '/assistant/investigations/inv_md0').status).toBe(204);
    expect(b.call('GET', '/assistant/investigations/inv_md0').json).toMatchObject({ status: 404 });
    expect(sse().at(-1)).toBe('assistant.deleted');
  });
});
