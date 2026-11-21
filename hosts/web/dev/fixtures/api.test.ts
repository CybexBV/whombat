// Fixture server state machine: cookie isolation, auth, enrollment timing,
// audit pagination, power-action overrides, console session limits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditPage, AuditRecord, GuestList, GuestListPage, PendingEnrollment, ServerListItem, StandardDetail } from '../../src/api/types';
import { guestListSchema, validate } from '../../src/api/validate';
import { ENROLL_PENDING_MS } from './admin';
import { applyPageToggles } from './auth';
import { loadFixtures } from './data';
import { computeFleet } from './fleet';
import { applyLifecycle } from './lifecycle';
import { detailResponse, guestsFor, serverList } from './servers';
import { isPageLoad } from './plugin';
import { COOKIE, FixtureStore } from './state';
import { browser, call } from './testkit';

const guestsOf = (r: { json: unknown }) => (r.json as GuestList).guests;

describe('per-browser state (cookie rackoon_fx)', () => {
  it('sets a cookie on the first request and keeps state per cookie', () => {
    const store = new FixtureStore();
    const first = call(store, 'GET', '/auth/state');
    const cookie = String(first.headers['Set-Cookie']);
    expect(cookie).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]+; Path=/; SameSite=Lax$`));
    const id = cookie.split(';')[0]!.split('=')[1]!;
    expect(call(store, 'GET', '/auth/state', { cookie: id }).headers['Set-Cookie']).toBeUndefined();
  });

  it('never leaks changes between browsers', () => {
    const store = new FixtureStore();
    const a = browser(store);
    const b = browser(store);
    expect(a.call('PATCH', '/servers/granite', { remote_control: { console: true }, group: 'Staging' }).status).toBe(200);
    expect(a.call('DELETE', '/servers/onyx').status).toBe(204);
    expect(a.call('GET', '/servers/granite/settings').json).toMatchObject({ group: 'Staging', remote_control: { console: true } });
    expect(b.call('GET', '/servers/granite/settings').json).toMatchObject({ group: 'Production', remote_control: { console: false } });
    expect(a.call('GET', '/groups').json).toEqual(['Production', 'Lab', 'Edge', 'Staging']);
    expect(b.call('GET', '/groups').json).toEqual(['Production', 'Lab', 'Edge']);
    expect((a.call('GET', '/agents').json as unknown[]).length).toBe(7);
    expect((b.call('GET', '/agents').json as unknown[]).length).toBe(8);
    a.call('POST', '/auth/logout');
    expect(a.call('GET', '/fleet').status).toBe(401);
    expect(b.call('GET', '/fleet').status).toBe(200);
  });

  it('prunes states idle for more than 2 h', () => {
    let now = 1_000_000;
    const store = new FixtureStore({ now: () => now });
    const a = browser(store);
    now += 2 * 3600_000 + 120_000;
    call(store, 'GET', '/auth/state');
    expect(store.states.has(a.id)).toBe(false);
  });
});

describe('page-load toggles', () => {
  it('only HTML navigations outside the API and Vite internals count', () => {
    const nav = (url: string, accept = 'text/html,application/xhtml+xml') => isPageLoad({ method: 'GET', url, headers: { accept } });
    expect(nav('/?setup=1')).toBe(true);
    expect(nav('/servers/basalt?role=viewer')).toBe(true);
    expect(nav('/api/v1/fleet')).toBe(false);
    expect(nav('/@vite/client')).toBe(false);
    expect(nav('/src/main.tsx')).toBe(false);
    expect(nav('/node_modules/.vite/deps/react.js')).toBe(false);
    expect(nav('/', 'application/json')).toBe(false);
    expect(isPageLoad({ method: 'POST', url: '/', headers: { accept: 'text/html' } })).toBe(false);
  });

  it('?setup=1, ?signedout=1 and ?role= set the auth state', () => {
    const store = new FixtureStore();
    const b = browser(store);
    const st = store.states.get(b.id)!;
    const auth = () => b.call('GET', '/auth/state').json;
    applyPageToggles(st, new URLSearchParams('setup=1'));
    expect(auth()).toMatchObject({ setup_required: true, authenticated: false, user: null });
    applyPageToggles(st, new URLSearchParams('signedout=1'));
    expect(auth()).toMatchObject({ setup_required: false, authenticated: false });
    applyPageToggles(st, new URLSearchParams('role=operator'));
    expect(auth()).toMatchObject({ authenticated: true, user: { name: 'admin', role: 'operator' }, passkeys: 1 });
    b.call('POST', '/auth/logout');
    b.call('POST', '/auth/login', { username: 'john', password: 'a password' });
    expect(auth()).toMatchObject({ user: { name: 'john', role: 'operator' } });
  });
});

describe('default state keeps the read bodies unchanged', () => {
  it('fleet, servers and the detail bodies equal the pure fixture functions', () => {
    const store = new FixtureStore();
    const b = browser(store);
    expect(b.call('GET', '/fleet').text).toBe(JSON.stringify(computeFleet(loadFixtures().fleet, 'All')));
    // The list adds the caller's permissions (remote_control), like the hub.
    const servers = b.call('GET', '/servers').json as ServerListItem[];
    expect(JSON.stringify(servers.map(({ remote_control: _rc, ...rest }) => rest))).toBe(JSON.stringify(serverList(loadFixtures().fleet)));
    expect(servers.find((s) => s.id === 'shale')?.remote_control).toMatchObject({ power: true, manage: true });
    expect(servers.find((s) => s.id === 'granite')?.remote_control).toMatchObject({ power: false });
    // Proxmox guests carry the tags of their configuration (lifecycle.ts).
    const fx = loadFixtures();
    applyLifecycle(store.states.get(b.id)!, fx);
    for (const id of ['basalt', 'shale']) {
      expect(b.call('GET', `/servers/${id}?range=7d`).text).toBe(JSON.stringify(detailResponse(fx, id, '7d')));
    }
    expect(b.call('GET', '/servers/basalt/guests?platform=incus').text).toBe(JSON.stringify(guestsFor(loadFixtures(), 'basalt', 'incus', null, null)));
    expect(b.call('GET', '/alerts').text).toBe(JSON.stringify(loadFixtures().fleet.alerts));
  });

  it('guest list spans servers, filters, pages, follows power actions and deletions', () => {
    const store = new FixtureStore();
    const b = browser(store);
    const list = (qs: string) => b.call('GET', `/guests${qs}`).json as GuestListPage;
    const search = (q: string) => list(`?q=${encodeURIComponent(q)}`);
    const g = search('GRAFANA');
    expect(g.guests.slice(0, 2).map((h) => `${h.server}/${h.id}`)).toEqual(['basalt/docker:grafana', 'shale/pve:200']);
    expect(g.guests.some((h) => h.name === 'loki')).toBe(true); // image grafana/loki
    expect(g.total).toBe(g.guests.length);
    expect(g.guests[0]!.server_online).toBe(true);
    expect(search('haos').guests.map((h) => h.name)).toEqual(['haos', 'haos-prod']);
    // No query: everything, with counts over the whole set and a page cursor.
    const all = list('');
    expect(all.counts.all).toBe(all.total);
    expect(all.counts.running + all.counts.stopped + all.counts.unhealthy).toBe(all.counts.all);
    expect(all.platforms.docker).toBeGreaterThan(0);
    expect(all.platforms.pve).toBeGreaterThan(0);
    expect(all.guests.length).toBe(all.total);
    const page = list('?limit=3');
    expect(page.guests).toHaveLength(3);
    expect(page.next_cursor).toBeTruthy();
    const page2 = list(`?limit=3&cursor=${page.next_cursor}`);
    expect(page2.guests[0]!.id).toBe(all.guests[3]!.id);
    expect(list('?state=stopped').guests.every((h) => h.state === 'stopped')).toBe(true);
    expect(list('?state=stopped').counts).toEqual(all.counts);
    expect(list('?platform=pve&kind=container').guests.every((h) => h.platform === 'pve' && h.kind === 'container')).toBe(true);
    expect(list('?server=shale').guests.every((h) => h.server === 'shale')).toBe(true);
    expect(b.call('GET', '/guests?state=up').json).toMatchObject({ status: 400, code: 'invalid_state' });
    expect(b.call('GET', '/guests?platform=lxd').json).toMatchObject({ status: 400, code: 'invalid_platform' });
    b.call('DELETE', '/servers/shale');
    expect(search('haos').guests.map((h) => h.name)).toEqual(['haos']);
    expect(validate(guestListSchema, search('nix'))).toEqual([]);
    expect(validate(guestListSchema, list(''))).toEqual([]);
  });

  it('remote_control reasons follow role, hub toggle and agent policy', () => {
    const store = new FixtureStore();
    const b = browser(store);
    const rc = () => (b.call('GET', '/servers/basalt').json as StandardDetail).server.remote_control;
    expect(rc()).toEqual({ console: true, power: true, agent_console: true, agent_power: true, manage: true, agent_manage: true });
    b.call('PATCH', '/servers/basalt', { remote_control: { power: false } });
    expect(rc()).toEqual({ console: true, power: false, agent_console: true, agent_power: true, power_reason: 'Remote control is turned off for this server', manage: true, agent_manage: true });
    b.call('PATCH', '/servers/basalt', { remote_control: { manage: false } });
    expect(rc()).toMatchObject({ manage: false, manage_reason: 'Managing guests is turned off for this server' });
    applyPageToggles(store.states.get(b.id)!, new URLSearchParams('role=viewer'));
    expect(rc()).toMatchObject({ console: false, console_reason: 'Requires operator access', power_reason: 'Requires operator access' });
  });
});

describe('auth', () => {
  it('401 when signed out, 403 csrf without the header, admin-only and operator-only routes', () => {
    const store = new FixtureStore();
    const b = browser(store);
    expect(call(store, 'POST', '/enrollments', { cookie: b.id, body: {}, csrf: false }).json).toMatchObject({ status: 403, code: 'csrf' });
    applyPageToggles(store.states.get(b.id)!, new URLSearchParams('role=operator'));
    expect(b.call('GET', '/agents').json).toMatchObject({ status: 403, code: 'insufficient_role', detail: 'Requires admin access.' });
    expect(b.call('GET', '/groups').status).toBe(200);
    expect(b.call('POST', '/servers/basalt/guests/incus%3Adev-shell/console-sessions', {}).status).toBe(201);
    applyPageToggles(store.states.get(b.id)!, new URLSearchParams('role=viewer'));
    expect(b.call('POST', '/servers/basalt/guests/incus%3Adev-shell/console-sessions', {}).json).toMatchObject({ code: 'insufficient_role', detail: 'Requires operator access.' });
    applyPageToggles(store.states.get(b.id)!, new URLSearchParams('signedout=1'));
    expect(b.call('GET', '/servers').json).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(b.call('GET', '/auth/state').json).toMatchObject({ authenticated: false, user: null, csrf_token: 'fixture-csrf-token' });
  });

  it('setup and login', () => {
    const store = new FixtureStore();
    const b = browser(store);
    expect(b.call('POST', '/auth/setup', { setup_token: 'fixture-setup-token', username: 'john', password: 'long enough pw' }).json).toMatchObject({ code: 'setup_done' });
    applyPageToggles(store.states.get(b.id)!, new URLSearchParams('setup=1'));
    expect(b.call('GET', '/auth/state').json).toMatchObject({ setup_required: true, authenticated: false });
    expect(b.call('POST', '/auth/setup', { setup_token: 'nope', username: 'john', password: 'long enough pw' }).json).toMatchObject({ status: 403, code: 'invalid_setup_token' });
    expect(b.call('POST', '/auth/setup', { setup_token: 'fixture-setup-token', username: 'john', password: 'short' }).json).toMatchObject({ status: 400, code: 'weak_password', detail: 'Use at least 10 characters.' });
    expect(b.call('POST', '/auth/setup', { setup_token: 'fixture-setup-token', username: '', password: 'long enough pw' }).json).toMatchObject({ code: 'invalid_username' });
    expect(b.call('POST', '/auth/setup', { setup_token: 'fixture-setup-token', username: 'john', password: 'long enough pw' }).status).toBe(204);
    expect(b.call('GET', '/auth/state').json).toMatchObject({ setup_required: false, authenticated: true, user: { name: 'john', role: 'admin' } });

    b.call('POST', '/auth/logout');
    expect(b.call('POST', '/auth/login', { username: 'admin', password: 'wrong-password' }).json).toMatchObject({ status: 401, code: 'invalid_credentials' });
    expect(b.call('POST', '/auth/login', { username: 'admin', password: 'anything' }).status).toBe(204);
    expect(b.call('POST', '/auth/password', { current: 'wrong-password', new: 'a new long password' }).json).toMatchObject({ status: 403, code: 'invalid_credentials' });
    expect(b.call('POST', '/auth/password', { current: 'x', new: 'short' }).json).toMatchObject({ code: 'weak_password' });
    expect(b.call('POST', '/auth/password', { current: 'x', new: 'a new long password' }).status).toBe(204);
  });

  it('passkeys: register, list, delete, login', () => {
    const store = new FixtureStore();
    const b = browser(store);
    const begin = b.call('POST', '/auth/passkey/register/begin', { name: 'YubiKey 5C' }).json as { publicKey: { excludeCredentials: { id: string }[]; challenge: string } };
    expect(begin.publicKey.excludeCredentials).toHaveLength(1);
    expect(begin.publicKey.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const fin = b.call('POST', '/auth/passkey/register/finish', { id: 'bmV3LWtleS0wMQ', response: {} });
    expect(fin.status).toBe(201);
    expect(fin.json).toEqual({ id: 'bmV3LWtleS0wMQ', name: 'YubiKey 5C' });
    expect((b.call('GET', '/auth/passkeys').json as unknown[]).length).toBe(2);
    expect(b.call('DELETE', '/auth/passkeys/bmV3LWtleS0wMQ').status).toBe(204);
    expect(b.call('DELETE', '/auth/passkeys/bmV3LWtleS0wMQ').status).toBe(404);
    b.call('POST', '/auth/logout');
    expect(b.call('POST', '/auth/passkey/login/finish', {}).json).toMatchObject({ status: 401, detail: 'The passkey was not accepted.' });
    expect(b.call('POST', '/auth/passkey/login/finish', { id: 'cGFzc2tleS1tYWNib29rLXRvdWNoLWlk', response: { signature: 'x' } }).status).toBe(204);
    expect(b.call('GET', '/auth/state').json).toMatchObject({ authenticated: true });
  });
});

describe('enrollment', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a new enrollment turns pending after ~4 s with an SSE event', () => {
    const store = new FixtureStore();
    const b = browser(store);
    const pending = () => (b.call('GET', '/enrollments?state=pending').json as PendingEnrollment[]).map((e) => e.hostname);
    const created = b.call('POST', '/enrollments', {});
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ id: 'en_1', expires_at: '2026-10-11T15:00:00Z' });
    const { token, install_command } = created.json as { token: string; install_command: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(install_command).toBe(`curl -fsSL http://127.0.0.1:5173/install.sh | sudo sh -s -- --token ${token}`);
    expect(pending()).toEqual(['pumice']);
    vi.advanceTimersByTime(ENROLL_PENDING_MS - 100);
    expect(pending()).toEqual(['pumice']);
    vi.advanceTimersByTime(100);
    expect(pending()).toEqual(['thetitan', 'pumice']);
    const st = store.states.get(b.id)!;
    expect(st.events.backlog.at(-1)).toMatchObject({ name: 'enrollment.pending', data: JSON.stringify({ id: 'en_1', hostname: 'thetitan' }) });

    b.call('POST', '/enrollments', {});
    vi.advanceTimersByTime(ENROLL_PENDING_MS);
    expect((b.call('GET', '/enrollments').json as PendingEnrollment[])[0]).toMatchObject({ id: 'en_2', hostname: 'granite-02', address: '10.20.0.32' });
  });

  it('approve, conflicts and reject', () => {
    const store = new FixtureStore();
    const b = browser(store);
    expect(b.call('POST', '/enrollments/en_seed/approve', { group: 'All', name: '' }).json).toMatchObject({ status: 400, code: 'invalid_group' });
    expect(b.call('POST', '/enrollments/en_seed/approve', { group: 'Lab', name: 'Granite' }).json).toMatchObject({ status: 409, code: 'server_exists', detail: 'A server named granite already exists. Choose another name or delete it first.' });
    expect(b.call('POST', '/enrollments/en_seed/approve', { group: '', name: '' }).json).toEqual({ server_id: 'pumice' });
    expect(b.call('POST', '/enrollments/en_seed/approve', {}).json).toMatchObject({ status: 409, code: 'not_pending' });
    expect(b.call('GET', '/groups').json).toEqual(['Production', 'Lab', 'Edge', 'Ungrouped']);
    expect((b.call('GET', '/agents').json as { server_id: string }[]).at(-1)).toMatchObject({
      server_id: 'pumice', connected: true, version: '0.14.2', collectors: [], remote_control: { console: false, power: false }, agent_policy: { console: true, power: true },
    });
    expect((b.call('GET', '/servers').json as { id: string }[]).at(-1)).toMatchObject({ id: 'pumice', group: 'Ungrouped', status: 'online' });
    b.call('POST', '/enrollments', {});
    expect(b.call('POST', '/enrollments/en_1/reject', {}).status).toBe(204);
    vi.advanceTimersByTime(ENROLL_PENDING_MS);
    expect(b.call('GET', '/enrollments').json).toEqual([]);
  });
});

describe('audit', () => {
  it('~240 seeds over 14 days, newest first, cursor pagination without gaps', () => {
    const store = new FixtureStore();
    const b = browser(store);
    const all: AuditRecord[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: AuditPage = b.call('GET', `/audit?limit=50${cursor ? `&cursor=${cursor}` : ''}`).json as AuditPage;
      all.push(...page.items);
      cursor = page.next_cursor;
      pages++;
    } while (cursor && pages < 20);
    expect(all.length).toBeGreaterThanOrEqual(220);
    expect(all.length).toBeLessThanOrEqual(260);
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    const times = all.map((r) => Date.parse(r.at));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(Math.max(...times)).toBeLessThan(Date.parse('2026-10-11T14:00:00Z'));
    expect(Math.min(...times)).toBeGreaterThanOrEqual(Date.parse('2026-09-27T14:00:00Z'));
    const events = new Set(all.map((r) => r.event));
    for (const e of ['console.opened', 'console.closed', 'console.switched', 'console.denied', 'action.requested', 'action.finished', 'remote_control.enabled', 'auth.login', 'enrollment.approved', 'screens.viewed']) {
      expect(events).toContain(e);
    }
    expect(all.find((r) => r.event === 'auth.login' && r.outcome === 'denied')?.code).toBe('invalid_credentials');
    expect(all.find((r) => r.event === 'console.denied')).toMatchObject({ outcome: 'denied', code: 'console_disabled' });
    expect(all.find((r) => r.event === 'console.closed')).toMatchObject({ duration_s: expect.any(Number), bytes_in: expect.any(Number), bytes_out: expect.any(Number) });
    // Deterministic: a second browser sees the same seed.
    expect((browser(store).call('GET', '/audit?limit=5').json as AuditPage).items).toEqual(all.slice(0, 5));
  });

  it('filters by event (exact or "prefix.") and server; live records come first', () => {
    const store = new FixtureStore();
    const b = browser(store);
    const items = (q: string) => (b.call('GET', `/audit?limit=1000${q}`).json as AuditPage).items;
    expect(items('&event=console.opened').every((r) => r.event === 'console.opened')).toBe(true);
    expect(new Set(items('&event=console.').map((r) => r.event.split('.')[0]))).toEqual(new Set(['console']));
    expect(items('&server=shale').every((r) => r.server === 'shale')).toBe(true);
    b.call('PATCH', '/servers/granite', { remote_control: { console: true } });
    expect(items('&event=remote_control.enabled')[0]).toMatchObject({ server: 'granite', user: 'admin', details: { capability: 'console' }, at: '2026-10-11T14:00:00Z' });
  });

  it('exports CSV with the hub column order', () => {
    const store = new FixtureStore();
    const r = browser(store).call('GET', '/audit/export');
    expect(r.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['Content-Disposition']).toBe('attachment; filename="rackoon-audit-20261011-140000.csv"');
    expect(r.text.split('\n')[0]).toBe('id,at,user,role,client_ip,user_agent,server,guest,platform,event,protocol,outcome,code,duration_s,bytes_in,bytes_out,details');
  });
});

describe('power actions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const opnsense = (b: ReturnType<typeof browser>) => guestsOf(b.call('GET', '/servers/basalt/guests?platform=libvirt')).find((g) => g.name === 'opnsense')!;

  it('shutdown overrides the guest state after ~1.5 s and emits SSE', () => {
    const store = new FixtureStore();
    const b = browser(store);
    expect(b.call('POST', '/servers/basalt/guests/libvirt%3Aopnsense/actions', { action: 'shutdown' }).json).toMatchObject({ status: 400, code: 'confirm_required' });
    const r = b.call('POST', '/servers/basalt/guests/libvirt%3Aopnsense/actions', { action: 'shutdown', confirm: true });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ action_id: 'act_1', audit_id: expect.stringMatching(/^au_/) });
    expect(b.call('POST', '/servers/basalt/guests/libvirt%3Aopnsense/actions', { action: 'reboot', confirm: true }).json).toMatchObject({ status: 409, code: 'action_in_progress' });
    vi.advanceTimersByTime(1400);
    expect(opnsense(b).state).toBe('running');
    vi.advanceTimersByTime(100);
    expect(opnsense(b)).toMatchObject({ state: 'stopped', uptime_s: null, cpu_pct: null, console: { resolution: null } });
    const detail = b.call('GET', '/servers/basalt').json as StandardDetail;
    expect(detail.workloads?.libvirt?.running).toBe(2);
    const names = store.states.get(b.id)!.events.backlog.map((e) => e.name);
    expect(names).toEqual(['guest.state_changed', 'action.finished']);
    expect(JSON.parse(store.states.get(b.id)!.events.backlog[1]!.data)).toMatchObject({ action_id: 'act_1', result: 'ok', state: 'stopped', message: 'opnsense is stopped' });
    // Other browsers still see it running.
    expect(opnsense(browser(store)).state).toBe('running');
    // Console and thumbnail now refuse.
    expect(b.call('POST', '/servers/basalt/guests/libvirt%3Aopnsense/console-sessions', {}).json).toMatchObject({ status: 409, code: 'guest_not_running' });
    expect(b.call('GET', '/servers/basalt/guests/libvirt%3Aopnsense/thumbnail').json).toMatchObject({ status: 409, code: 'guest_not_running' });
    // Start again: running with a fresh uptime.
    expect(b.call('POST', '/servers/basalt/guests/libvirt%3Aopnsense/actions', { action: 'start', confirm: true }).json).not.toHaveProperty('noop');
    vi.advanceTimersByTime(1500);
    expect(opnsense(b)).toMatchObject({ state: 'running', uptime_s: 0, console: { resolution: '1024x768' } });
  });

  it('noop, the truenas-lab failure, permissions and invalid actions', () => {
    const store = new FixtureStore();
    const b = browser(store);
    expect(b.call('POST', '/servers/basalt/guests/libvirt%3Ahaos/actions', { action: 'start' }).json).toMatchObject({ noop: true });
    b.call('POST', '/servers/basalt/guests/libvirt%3Atruenas-lab/actions', { action: 'start' });
    vi.advanceTimersByTime(1500);
    const ev = store.states.get(b.id)!.events.backlog.map((e) => JSON.parse(e.data) as Record<string, unknown>);
    expect(ev.find((e) => e.guest === 'libvirt:truenas-lab')).toMatchObject({ result: 'error', state: 'stopped', message: 'Domain truenas-lab could not start: not enough memory (fixture)' });
    expect(b.call('POST', '/servers/basalt/guests/incus%3Adev-shell/actions', { action: 'shutdown', confirm: true }).json).toMatchObject({ code: 'invalid_action' });
    expect(b.call('POST', '/servers/basalt/guests/docker%3Aredis/actions', { action: 'restart' }).json).toMatchObject({ code: 'invalid_action' });
    expect(b.call('POST', '/servers/basalt/guests/libvirt%3Ahaos/actions', { action: 'explode' }).json).toMatchObject({ code: 'invalid_action' });
    expect(b.call('POST', '/servers/obsidian/guests/incus%3Ax/actions', { action: 'start' }).json).toMatchObject({ status: 403, code: 'power_disabled', detail: 'Remote control is turned off for this server' });
    b.call('PATCH', '/servers/obsidian', { remote_control: { power: true } });
    expect(b.call('POST', '/servers/obsidian/guests/incus%3Ax/actions', { action: 'start' }).json).toMatchObject({ code: 'power_disabled', detail: 'The agent on this server does not allow remote control' });
  });
});

describe('console sessions', () => {
  it('session limit of 5 (live or unused), switch_from exempt, tokens expire after 30 s', () => {
    let now = 1_000_000;
    const store = new FixtureStore({ now: () => now });
    const b = browser(store);
    const open = (body: object = {}) => b.call('POST', '/servers/shale/guests/pve%3A203/console-sessions', body);
    const first = open();
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ session_id: 'cs_1', url: '/api/v1/console/cs_1', protocol: 'shell', idle_timeout_s: 900, requires_confirmation: false, expires_at: '2026-10-11T14:00:30Z' });
    for (let i = 0; i < 4; i++) expect(open().status).toBe(201);
    expect(open().json).toMatchObject({ status: 429, code: 'session_limit', detail: 'Too many open consoles. Close one and try again.' });
    expect(open({ switch_from: 'cs_1' }).status).toBe(201);
    expect(store.states.get(b.id)!.sessions.has('cs_1')).toBe(false);
    expect(b.call('DELETE', '/console-sessions/cs_2').status).toBe(204);
    expect(b.call('DELETE', '/console-sessions/cs_2').status).toBe(404);
    expect(open().status).toBe(201);
    expect(open().status).toBe(429);
    now += 30_000;
    expect(open().status).toBe(201);
  });

  it('refusals: unknown server/guest, console off, docker, protocol, other browser', () => {
    const store = new FixtureStore();
    const b = browser(store);
    expect(b.call('POST', '/servers/nope/guests/x/console-sessions', {}).json).toMatchObject({ status: 404, code: 'server_not_found' });
    expect(b.call('POST', '/servers/basalt/guests/incus%3Anope/console-sessions', {}).json).toMatchObject({ status: 404, code: 'guest_not_found' });
    expect(b.call('POST', '/servers/granite/guests/x/console-sessions', {}).json).toMatchObject({ status: 403, code: 'console_disabled', detail: 'Remote control is turned off for this server' });
    expect(b.call('POST', '/servers/basalt/guests/docker%3Aredis/console-sessions', {}).json).toMatchObject({ status: 409, code: 'console_unavailable' });
    expect(b.call('POST', '/servers/basalt/guests/incus%3Adev-shell/console-sessions', { protocol: 'vnc' }).json).toMatchObject({ status: 409, code: 'protocol_unavailable' });
    expect(b.call('POST', '/servers/basalt/guests/incus%3Ascratch/console-sessions', {}).json).toMatchObject({ status: 409, code: 'guest_not_running', detail: 'The guest is powered off.' });
    const denied = (b.call('GET', '/audit?event=console.denied&limit=10').json as AuditPage).items;
    expect(denied[0]).toMatchObject({ server: 'basalt', guest: 'incus:scratch', outcome: 'denied', code: 'guest_not_running' });
  });

  it('thumbnails: SVG for running VMs, 404 for containers, screens.viewed once', () => {
    const store = new FixtureStore();
    const b = browser(store);
    const t = b.call('GET', '/servers/basalt/guests/incus%3Anixbuild/thumbnail');
    expect(t.status).toBe(200);
    expect(t.headers['Content-Type']).toBe('image/svg+xml');
    expect(t.headers['Cache-Control']).toBe('no-store');
    expect(t.text).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 320 200"/);
    expect(t.text).toContain('#06080b');
    const again = b.call('GET', '/servers/basalt/guests/incus%3Anixbuild/thumbnail');
    expect(again.text).not.toBe(t.text);
    expect(b.call('GET', '/servers/basalt/guests/libvirt%3Awin11-test/thumbnail').text).toContain('Task\u00a0Manager');
    expect(b.call('GET', '/servers/basalt/guests/incus%3Adev-shell/thumbnail').json).toMatchObject({ status: 404, code: 'no_screen' });
    expect((b.call('GET', '/audit?event=screens.viewed&server=basalt&limit=100').json as AuditPage).items.filter((r) => r.at === '2026-10-11T14:00:00Z')).toHaveLength(1);
    const png = b.call('GET', '/servers/shale/guests/pve%3A100/screenshot');
    expect(png.headers['Content-Type']).toBe('image/png');
    expect(png.headers['Content-Disposition']).toBe('attachment; filename="k3s-node-2-20261011-140000.png"');
  });
});
