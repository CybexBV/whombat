// Remote control in fixture mode (CONTRACT 4): effective permissions, console
// session tokens and power actions. The WebSocket side is console.ts.

import type { ConsoleProtocol, Guest, GuestState, RemoteControl } from '../../src/api/types.ts';
import { appendAudit } from './audit.ts';
import { findGuest } from './catalog.ts';
import type { Ctx } from './ctx.ts';
import { pushEvent } from './events.ts';
import { guestKey, guestState } from './guests.ts';
import { bodyObject, type FxResponse, json, noContent, problem } from './http.ts';
import {
  type BrowserState,
  type ConsoleSessionRec,
  findServer,
  iso,
  randomToken,
  roleAtLeast,
  type ServerRec,
} from './state.ts';

export const REASON_ROLE = 'Requires operator access';
export const REASON_HUB = 'Remote control is turned off for this server';
export const REASON_AGENT = 'The agent on this server does not allow remote control';
export const REASON_HUB_MANAGE = 'Managing guests is turned off for this server';
export const REASON_AGENT_MANAGE =
  "This host's agent does not allow managing guests yet: set manage = true under [remote_control] in its agent.toml and reload the agent";

export const SESSION_LIMIT = 5;
export const TOKEN_TTL_MS = 30_000;

/** FIXTURE_CONSOLE_IDLE_S (default 900). */
export function consoleIdleS(): number {
  const v = Number(process.env.FIXTURE_CONSOLE_IDLE_S);
  return Number.isFinite(v) && v > 0 ? v : 900;
}

export interface Effective {
  console: boolean;
  power: boolean;
  agentConsole: boolean;
  agentPower: boolean;
  consoleReason: string | null;
  powerReason: string | null;
  manage: boolean;
  agentManage: boolean;
  manageReason: string | null;
}

/** Hub toggle AND agent policy AND role >= operator, with the first reason that fails. */
export function effectivePerms(st: BrowserState, rec: ServerRec): Effective {
  const reason = (hub: boolean, agent: boolean): string | null =>
    !roleAtLeast(st, 'operator') ? REASON_ROLE : !hub ? REASON_HUB : !agent ? REASON_AGENT : null;
  const consoleReason = reason(rec.remoteControl.console, rec.agentPolicy.console);
  const powerReason = reason(rec.remoteControl.power, rec.agentPolicy.power);
  const manageReason = !roleAtLeast(st, 'operator') ? REASON_ROLE : !rec.remoteControl.manage ? REASON_HUB_MANAGE : !rec.agentPolicy.manage ? REASON_AGENT_MANAGE : null;
  return {
    manage: manageReason === null,
    agentManage: !!rec.agentPolicy.manage,
    manageReason,
    console: consoleReason === null,
    power: powerReason === null,
    agentConsole: rec.agentPolicy.console,
    agentPower: rec.agentPolicy.power,
    consoleReason,
    powerReason,
  };
}

/** `server.remote_control` of the detail body; reasons only when set (keeps the default body unchanged). */
export function detailRemoteControl(e: Effective): RemoteControl {
  return {
    console: e.console,
    power: e.power,
    agent_console: e.agentConsole,
    agent_power: e.agentPower,
    ...(e.consoleReason ? { console_reason: e.consoleReason } : {}),
    ...(e.powerReason ? { power_reason: e.powerReason } : {}),
    // Only for hosts whose agent allows managing guests (keeps the other bodies unchanged).
    ...(e.agentManage ? { manage: e.manage, agent_manage: true, ...(e.manageReason ? { manage_reason: e.manageReason } : {}) } : {}),
  };
}

const platformOf = (guestId: string): string | null => (guestId.includes(':') ? guestId.split(':')[0]! : null);

/** End a session: a live one gets `closed {reason}`, an unused token is dropped. */
export function endSession(st: BrowserState, s: ConsoleSessionRec, reason: string): void {
  if (s.close) s.close(reason);
  else st.sessions.delete(s.id);
}

export function closeSessions(st: BrowserState, pred: (s: ConsoleSessionRec) => boolean, reason: string): void {
  for (const s of [...st.sessions.values()]) if (pred(s)) endSession(st, s, reason);
}

function activeSessions(c: Ctx, except: string): ConsoleSessionRec[] {
  const now = c.store.now();
  for (const s of [...c.st.sessions.values()]) {
    if (!s.used && now >= s.tokenExpiresReal) c.st.sessions.delete(s.id);
  }
  return [...c.st.sessions.values()].filter((s) => s.id !== except && (s.live || !s.used));
}

/** Shared checks for console, actions and screens (role, server, permission, agent, guest). */
export function remoteTarget(c: Ctx, serverId: string, guestId: string, need: 'console' | 'power'): { rec: ServerRec; guest: Guest } | { status: number; code: string; detail: string } {
  if (!roleAtLeast(c.st, 'operator')) return { status: 403, code: 'insufficient_role', detail: 'Requires operator access.' };
  const rec = findServer(c.st, serverId);
  if (!rec) return { status: 404, code: 'server_not_found', detail: 'No such server.' };
  const eff = effectivePerms(c.st, rec);
  if (need === 'console' && !eff.console) return { status: 403, code: 'console_disabled', detail: eff.consoleReason ?? REASON_HUB };
  if (need === 'power' && !eff.power) return { status: 403, code: 'power_disabled', detail: eff.powerReason ?? REASON_HUB };
  if (rec.status === 'offline') return { status: 409, code: 'agent_offline', detail: 'The agent of this server is not connected.' };
  const guest = findGuest(c.fx(), serverId, guestId);
  if (!guest) return { status: 404, code: 'guest_not_found', detail: 'No such guest on this server.' };
  return { rec, guest };
}

// ---------------------------------------------------------------- console sessions

export function createConsoleSession(c: Ctx, serverId: string, guestId: string): FxResponse {
  const { store, st, req } = c;
  if (req.bodyInvalid) return problem(400, 'bad_request', 'Invalid JSON body.');
  const b = bodyObject(req);
  const wanted = typeof b.protocol === 'string' ? b.protocol : '';
  const switchFrom = typeof b.switch_from === 'string' ? b.switch_from : '';
  const deny = (status: number, code: string, detail: string): FxResponse => {
    appendAudit(store, st, { event: 'console.denied', outcome: 'denied', code, server: serverId, guest: guestId, platform: platformOf(guestId), protocol: wanted || null }, req);
    return problem(status, code, detail);
  };
  const t = remoteTarget(c, serverId, guestId, 'console');
  if ('code' in t) return deny(t.status, t.code, t.detail);
  const g = t.guest;
  const protocols = g.console.available ? (g.console.protocols ?? []) : [];
  if (g.platform === 'docker' || !protocols.length) return deny(409, 'console_unavailable', 'This guest has no console.');
  const def = g.console.default_protocol;
  const protocol = wanted || (def && protocols.includes(def) ? def : protocols[0]!);
  if (!(protocols as string[]).includes(protocol)) {
    const why = g.console.unavailable?.[protocol as ConsoleProtocol];
    return deny(409, 'protocol_unavailable', why || `This guest does not offer ${protocol}.`);
  }
  if (guestState(st, serverId, g) === 'stopped') return deny(409, 'guest_not_running', 'The guest is powered off.');
  if (activeSessions(c, switchFrom).length >= SESSION_LIMIT) return deny(429, 'session_limit', 'Too many open consoles. Close one and try again.');

  const s: ConsoleSessionRec = {
    id: `cs_${++st.seq.session}`,
    token: randomToken(32),
    server: serverId,
    guestId,
    protocol: protocol as ConsoleProtocol,
    tokenExpiresReal: store.now() + TOKEN_TTL_MS,
    used: false,
    live: false,
    user: st.user.name,
    role: st.user.role,
    clientIp: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '',
    close: null,
  };
  const base = { server: serverId, guest: guestId, platform: g.platform, protocol };
  appendAudit(store, st, { ...base, event: 'console.requested', details: { session_id: s.id } }, req);
  const old = switchFrom ? st.sessions.get(switchFrom) : undefined;
  if (old) {
    appendAudit(store, st, { ...base, event: 'console.switched', details: { from_session_id: old.id, from_guest: old.guestId, session_id: s.id } }, req);
    endSession(st, old, 'switched');
  }
  st.sessions.set(s.id, s);
  return json(201, {
    session_id: s.id,
    url: `/api/v1/console/${s.id}`,
    token: s.token,
    protocol: s.protocol,
    expires_at: iso(store.fxNow() + TOKEN_TTL_MS),
    idle_timeout_s: consoleIdleS(),
    requires_confirmation: false,
  });
}

export function deleteConsoleSession(c: Ctx, id: string): FxResponse {
  if (!roleAtLeast(c.st, 'operator')) return problem(403, 'insufficient_role', 'Requires operator access.');
  const s = c.st.sessions.get(id);
  if (!s) return problem(404, 'not_found', 'Not found.');
  endSession(c.st, s, 'revoked');
  return noContent();
}

/** GET /console-sessions?server= (admin): live sessions of this browser. */
export function listConsoleSessions(c: Ctx): FxResponse {
  const server = c.req.query.get('server');
  const out = [...c.st.sessions.values()]
    .filter((s) => s.live && (!server || s.server === server))
    .map((s) => ({ session_id: s.id, server: s.server, guest: s.guestId, protocol: s.protocol, user: s.user, client_ip: s.clientIp }));
  return json(200, out);
}

// ---------------------------------------------------------------- power actions

const VM_ACTIONS = ['start', 'shutdown', 'reboot', 'force_stop', 'ctrl_alt_del'];
const CONTAINER_ACTIONS = ['start', 'restart', 'stop'];
const KNOWN = new Set([...VM_ACTIONS, ...CONTAINER_ACTIONS]);
/** Need `confirm: true` (hub / CONTRACT 7.4). */
const DESTRUCTIVE = new Set(['shutdown', 'reboot', 'force_stop', 'stop']);
const STOPPING = new Set(['shutdown', 'force_stop', 'stop']);

export function guestAction(c: Ctx, serverId: string, guestId: string): FxResponse {
  const { store, st, req } = c;
  if (req.bodyInvalid) return problem(400, 'bad_request', 'Invalid JSON body.');
  const b = bodyObject(req);
  const action = typeof b.action === 'string' ? b.action : '';
  const confirm = b.confirm === true;
  if (action === 'screenshot') return problem(400, 'use_screenshot_endpoint', 'Use GET .../screenshot for screenshots.');
  if (!KNOWN.has(action)) return problem(400, 'invalid_action', 'Unknown action.');
  const deny = (status: number, code: string, detail: string): FxResponse => {
    appendAudit(store, st, { event: 'action.requested', outcome: 'denied', code, server: serverId, guest: guestId, platform: platformOf(guestId), details: { action } }, req);
    return problem(status, code, detail);
  };
  const t = remoteTarget(c, serverId, guestId, action === 'ctrl_alt_del' ? 'console' : 'power');
  if ('code' in t) return deny(t.status, t.code, t.detail);
  const g = t.guest;
  const allowed = g.kind === 'vm' ? VM_ACTIONS : CONTAINER_ACTIONS;
  if (g.platform === 'docker' || !allowed.includes(action)) return deny(400, 'invalid_action', 'This action does not apply to this guest.');
  if (DESTRUCTIVE.has(action) && !confirm) return deny(400, 'confirm_required', 'Destructive actions need "confirm": true.');
  const key = guestKey(serverId, guestId);
  if (st.actionsInFlight.has(key)) return problem(409, 'action_in_progress', 'Another action on this guest is still running.');

  const cur = guestState(st, serverId, g);
  const noop = (action === 'start' && cur !== 'stopped') || (STOPPING.has(action) && cur === 'stopped');
  const actionId = `act_${++st.seq.action}`;
  const requested = appendAudit(store, st, { event: 'action.requested', server: serverId, guest: guestId, platform: g.platform, details: { action, action_id: actionId } }, req);
  st.actionsInFlight.add(key);
  const delay = action === 'reboot' || action === 'restart' ? 2500 : 1500;
  const who = { user: st.user.name, role: st.user.role, client_ip: requested.client_ip, user_agent: requested.user_agent };

  store.schedule(st, delay, () => {
    st.actionsInFlight.delete(key);
    const now = guestState(st, serverId, g);
    let result: 'ok' | 'error' = 'ok';
    let code: string | null = null;
    let state: GuestState = now;
    let message: string;
    if (g.name === 'truenas-lab' && action === 'start' && now === 'stopped') {
      // Fixture special case: a start that fails on the hypervisor.
      result = 'error';
      code = 'agent_error';
      message = 'Domain truenas-lab could not start: not enough memory (fixture)';
    } else if (noop) {
      message = `${g.name} is already ${now}`;
    } else if (now === 'stopped' && action !== 'start') {
      result = 'error';
      code = 'guest_not_running';
      message = `${g.name} is not running`;
    } else if (action === 'ctrl_alt_del') {
      message = `Ctrl+Alt+Del sent to ${g.name}`;
    } else {
      state = STOPPING.has(action) ? 'stopped' : 'running';
      st.guestOverrides.set(key, { state, sinceReal: store.now() });
      message = `${g.name} is ${state}`;
      pushEvent(st, 'guest.state_changed', { server: serverId, id: guestId, state });
      if (state === 'stopped') closeSessions(st, (s) => s.server === serverId && s.guestId === guestId, 'guest_stopped');
    }
    appendAudit(store, st, {
      ...who,
      event: 'action.finished',
      outcome: result,
      code,
      server: serverId,
      guest: guestId,
      platform: g.platform,
      duration_s: delay / 1000,
      details: { action, action_id: actionId, requested_audit_id: requested.id, state, ...(noop ? { noop: 'true' } : {}) },
    });
    pushEvent(st, 'action.finished', { action_id: actionId, server: serverId, guest: guestId, action, result, message, state, noop, code });
  });

  return json(202, { action_id: actionId, audit_id: requested.id, ...(noop ? { noop: true } : {}) });
}
