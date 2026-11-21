// Admin endpoints in fixture mode (CONTRACT 3 + 7.3): enrollment, agents,
// groups, server settings, delete. Shapes follow internal/hub/api_admin.go.

import type { AgentInfo, PendingEnrollment, ServerListItem, ServerSettings } from '../../src/api/types.ts';
import { appendAudit } from './audit.ts';
import type { Ctx } from './ctx.ts';
import { pushEvent } from './events.ts';
import { bodyObject, type FxResponse, json, noContent, problem } from './http.ts';
import { closeSessions, detailRemoteControl, effectivePerms } from './remote.ts';
import { type BrowserState, type EnrollmentRec, type FixtureStore, findServer, iso, randomHex, randomToken, type ServerRec } from './state.ts';

/** A new enrollment's agent "calls in" this long after the token was issued. */
export const ENROLL_PENDING_MS = 4000;
const ENROLL_TTL_MS = 3600_000;
const HOSTNAMES = ['thetitan', 'granite-02', 'pumice-03', 'slate-04', 'gneiss-05', 'schist-06', 'tuff-07', 'chert-08'];
const FLEET_GROUPS = ['Production', 'Lab', 'Edge'];

/** Hub Slug(): lower-case letters, digits and single dashes, at most 63 chars. */
export function slug(s: string): string {
  let out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (out.length > 63) out = out.slice(0, 63).replace(/-+$/, '');
  return out;
}

/** Trim and drop control characters (hub cleanText). */
function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? [...v.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, max).join('') : '';
}

function enrollmentJson(e: EnrollmentRec): PendingEnrollment & { created_at: string } {
  return {
    id: e.id,
    state: e.state,
    hostname: e.hostname,
    os: e.os,
    address: e.address,
    agent_version: e.agentVersion,
    requested_at: e.requestedAt === null ? null : iso(e.requestedAt),
    created_at: iso(e.createdAt),
    expires_at: iso(e.expiresAt),
    server_id: e.serverId,
  };
}

export function createEnrollment(c: Ctx): FxResponse {
  const { store, st, req } = c;
  if (req.bodyInvalid) return problem(400, 'bad_request', 'Invalid JSON body.');
  const now = store.fxNow();
  const e: EnrollmentRec = {
    id: `en_${++st.seq.enrollment}`,
    state: 'issued',
    createdAt: now,
    expiresAt: now + ENROLL_TTL_MS,
    hostname: null,
    os: null,
    address: null,
    agentVersion: null,
    requestedAt: null,
    serverId: null,
  };
  st.enrollments.push(e);
  const token = randomToken(32);
  appendAudit(store, st, { event: 'enrollment.created', details: { enrollment_id: e.id } }, req);
  // The agent on the new host claims the token a few seconds later.
  store.schedule(st, ENROLL_PENDING_MS, () => claimEnrollment(store, st, e));
  return json(201, {
    id: e.id,
    token,
    expires_at: iso(e.expiresAt),
    install_command: `curl -fsSL http://${req.host}/install.sh | sudo sh -s -- --token ${token}`,
  });
}

function claimEnrollment(store: FixtureStore, st: BrowserState, e: EnrollmentRec): void {
  if (e.state !== 'issued') return;
  const n = st.seq.host++;
  e.state = 'pending';
  e.hostname = HOSTNAMES[n] ?? `node-${String(n + 1).padStart(2, '0')}`;
  e.os = 'Debian GNU/Linux 13 (trixie)';
  e.address = `10.20.0.${31 + n}`;
  e.agentVersion = '0.14.2';
  e.requestedAt = store.fxNow();
  appendAudit(store, st, {
    event: 'enrollment.requested', user: null, role: null, client_ip: e.address, user_agent: null,
    details: { enrollment_id: e.id, hostname: e.hostname },
  });
  pushEvent(st, 'enrollment.pending', { id: e.id, hostname: e.hostname });
}

export function listEnrollments(c: Ctx): FxResponse {
  const raw = c.req.query.get('state') ?? '';
  const state = raw === '' ? 'pending' : raw;
  if (!['pending', 'issued', 'approved', 'rejected', 'expired', 'all'].includes(state)) return problem(400, 'invalid_state', 'Unknown enrollment state.');
  // Newest first; the fixture clock is frozen, so ties go to the later one.
  const list = c.st.enrollments
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => state === 'all' || e.state === state)
    .sort((a, b) => (b.e.requestedAt ?? b.e.createdAt) - (a.e.requestedAt ?? a.e.createdAt) || b.i - a.i)
    .map(({ e }) => e);
  return json(200, list.map(enrollmentJson));
}

export function approveEnrollment(c: Ctx, id: string): FxResponse {
  const { store, st, req } = c;
  if (req.bodyInvalid) return problem(400, 'bad_request', 'Invalid JSON body.');
  const b = bodyObject(req);
  const e = st.enrollments.find((x) => x.id === id);
  if (!e) return problem(404, 'not_found', 'Not found.');
  if (e.state !== 'pending') return problem(409, 'not_pending', `This enrollment is ${e.state}.`);
  const name = cleanText(b.name, 128) || e.hostname || '';
  const serverId = slug(name);
  if (!serverId) return problem(400, 'invalid_name', 'Give the server a name (letters, digits, dashes).');
  const group = cleanText(b.group, 64) || 'Ungrouped';
  if (group.toLowerCase() === 'all') return problem(400, 'invalid_group', '"All" is reserved.');
  if (findServer(st, serverId)) return problem(409, 'server_exists', `A server named ${serverId} already exists. Choose another name or delete it first.`);
  const now = store.fxNow();
  st.servers.push({
    id: serverId,
    hostname: e.hostname ?? serverId,
    group,
    location: null,
    status: 'online',
    statusNote: null,
    os: e.os ?? 'Linux',
    detailView: 'standard',
    version: e.agentVersion,
    address: e.address,
    lastSeen: iso(now),
    clockSkewS: 0.1,
    collectors: [],
    // Remote control is off on a newly approved server (diagnostics on, like the hub).
    remoteControl: { console: false, power: false, diagnose: true },
    agentPolicy: { console: true, power: true, diagnose: true },
    certExpiresAt: iso(now + 365 * 86400_000),
    certSerial: randomHex(8),
    approved: true,
  });
  e.state = 'approved';
  e.serverId = serverId;
  appendAudit(store, st, { event: 'enrollment.approved', server: serverId, details: { enrollment_id: e.id, group, hostname: e.hostname ?? '' } }, req);
  pushEvent(st, 'server.settings_changed', { id: serverId });
  return json(200, { server_id: serverId });
}

export function rejectEnrollment(c: Ctx, id: string): FxResponse {
  const { store, st, req } = c;
  const e = st.enrollments.find((x) => x.id === id);
  if (!e || (e.state !== 'pending' && e.state !== 'issued')) return problem(409, 'not_pending', 'This enrollment cannot be rejected.');
  e.state = 'rejected';
  appendAudit(store, st, { event: 'enrollment.rejected', details: { enrollment_id: id } }, req);
  return noContent();
}

// ---------------------------------------------------------------- servers and agents

export function agentInfo(rec: ServerRec): AgentInfo {
  return {
    server_id: rec.id,
    hostname: rec.hostname,
    version: rec.version,
    connected: rec.status !== 'offline',
    status: rec.status,
    last_seen: rec.lastSeen,
    address: rec.address,
    clock_skew_s: rec.clockSkewS,
    collectors: rec.collectors,
    remote_control: { ...rec.remoteControl },
    agent_policy: { ...rec.agentPolicy },
    group: rec.group,
    location: rec.location,
    cert_expires_at: rec.certExpiresAt,
  };
}

export function listAgents(c: Ctx): FxResponse {
  return json(200, c.st.servers.map(agentInfo));
}

/** Distinct groups in use: the fleet's order first, then new ones. */
export function groupsInUse(st: BrowserState): string[] {
  const used = new Set(st.servers.map((s) => s.group));
  return [...FLEET_GROUPS.filter((g) => used.has(g)), ...[...used].filter((g) => !FLEET_GROUPS.includes(g))];
}

/** GET /servers for this browser: fleet.json's list with group changes, deletions and approved servers. */
export function serverListFor(st: BrowserState, base: ServerListItem[]): ServerListItem[] {
  const out: ServerListItem[] = [];
  for (const item of base) {
    const rec = findServer(st, item.id);
    // The caller's permissions, like the hub (the Guests page's row menus and bulk selection read them).
    if (rec) out.push({ ...item, group: rec.group, remote_control: detailRemoteControl(effectivePerms(st, rec)) });
  }
  for (const rec of st.servers.filter((s) => s.approved)) {
    out.push({ id: rec.id, group: rec.group, status: rec.status, status_note: rec.statusNote, os: rec.os, detail_view: rec.detailView });
  }
  return out;
}

export function settingsOf(rec: ServerRec): ServerSettings {
  return { id: rec.id, group: rec.group, location: rec.location, remote_control: { ...rec.remoteControl }, agent_policy: { ...rec.agentPolicy } };
}

export function serverSettings(c: Ctx, id: string): FxResponse {
  const rec = findServer(c.st, id);
  return rec ? json(200, settingsOf(rec)) : problem(404, 'server_not_found', 'No such server.');
}

export function patchServer(c: Ctx, id: string): FxResponse {
  const { store, st, req } = c;
  if (req.bodyInvalid || (req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)))) {
    return problem(400, 'bad_request', 'Invalid JSON body.');
  }
  const rec = findServer(st, id);
  if (!rec) return problem(404, 'server_not_found', 'No such server.');
  const b = bodyObject(req);
  let group: string | undefined;
  if (b.group !== undefined) {
    group = cleanText(b.group, 64);
    if (!group || group.toLowerCase() === 'all') return problem(400, 'invalid_group', 'Give a group name other than "All".');
  }
  let location: string | undefined;
  if (b.location !== undefined) location = cleanText(b.location, 128);
  const rc = b.remote_control && typeof b.remote_control === 'object' ? (b.remote_control as Record<string, unknown>) : {};
  const before = { ...rec.remoteControl, group: rec.group, location: rec.location };
  if (typeof rc.console === 'boolean') rec.remoteControl.console = rc.console;
  if (typeof rc.power === 'boolean') rec.remoteControl.power = rc.power;
  if (typeof rc.manage === 'boolean') rec.remoteControl.manage = rc.manage;
  if (typeof rc.diagnose === 'boolean') rec.remoteControl.diagnose = rc.diagnose;
  if (group !== undefined) rec.group = group;
  if (location !== undefined) rec.location = location || null;

  for (const cap of ['console', 'power', 'manage', 'diagnose'] as const) {
    if (!!before[cap] !== !!rec.remoteControl[cap]) {
      appendAudit(store, st, { event: rec.remoteControl[cap] ? 'remote_control.enabled' : 'remote_control.disabled', server: id, details: { capability: cap } }, req);
    }
  }
  if (before.group !== rec.group || before.location !== rec.location) {
    appendAudit(store, st, { event: 'server.updated', server: id, details: { group: rec.group, location: rec.location ?? '' } }, req);
  }
  if (before.console && !rec.remoteControl.console) closeSessions(st, (s) => s.server === id, 'remote_control_disabled');
  pushEvent(st, 'server.settings_changed', { id });
  return json(200, settingsOf(rec));
}

export function deleteServer(c: Ctx, id: string): FxResponse {
  const { store, st, req } = c;
  const rec = findServer(st, id);
  if (!rec) return problem(404, 'server_not_found', 'No such server.');
  st.servers = st.servers.filter((s) => s.id !== id);
  closeSessions(st, (s) => s.server === id, 'revoked');
  appendAudit(store, st, { event: 'server.deleted', server: id, details: { cert_serial: rec.certSerial } }, req);
  pushEvent(st, 'server.deleted', { id });
  return noContent();
}
