// Router of the fixture API (/api/v1). Pure: FxRequest in, FxResponse out,
// state per browser cookie. plugin.ts adapts it to Vite's dev server.

import { RANGES, type Range } from '../../src/api/types.ts';
import { approveEnrollment, createEnrollment, deleteServer, groupsInUse, listAgents, listEnrollments, patchServer, rejectEnrollment, serverListFor, serverSettings } from './admin.ts';
import { resolvedAlerts } from './alerts.ts';
import { assistRoutes } from './assist.ts';
import { appendAudit, auditCsv, listAudit } from './audit.ts';
import { authRoute } from './auth.ts';
import { findGuest } from './catalog.ts';
import { type Ctx, makeCtx } from './ctx.ts';
import type { FixtureSet } from './data.ts';
import { eventStream } from './events.ts';
import { computeFleet, computeFleetSeries } from './fleet.ts';
import { applyGuestOverrides, listGuests, listParamError } from './guests.ts';
import { type FxRequest, type FxResponse, header, json, legacyProblem, problem, shiftTimes } from './http.ts';
import { lifecycleRoutes } from './lifecycle.ts';
import { manageRoutes } from './manage.ts';
import { createConsoleSession, deleteConsoleSession, detailRemoteControl, effectivePerms, guestAction, listConsoleSessions } from './remote.ts';
import { detailResponse, guestsFor, metricsFor, serverList } from './servers.ts';
import { type FixtureStore, findServer, roleAtLeast } from './state.ts';
import { screenshot, thumbnail } from './thumbs.ts';

type Handler = (c: Ctx, params: string[]) => FxResponse;

interface Route {
  method: string;
  re: RegExp;
  /** Admin-only (403 insufficient_role otherwise). */
  admin?: boolean;
  handler: Handler;
}

/** Cache policy of the fleet-wide read endpoints (unchanged from the first fixture server). */
const CACHE_READ = 'private, max-age=5';

/** Body of a read endpoint, with FIXTURE_TIME=live shifting. */
function read(c: Ctx, body: unknown, cache = 'no-store'): FxResponse {
  const fx = c.fx();
  const offset = c.store.live ? c.store.now() - 8000 - Date.parse(fx.fleet.as_of) : 0;
  return json(200, shiftTimes(body, offset), cache);
}

/** The original read endpoints validate ?range= and ?group= first. */
function legacy(fn: (c: Ctx, fx: FixtureSet, range: Range, group: string, params: string[]) => FxResponse): Handler {
  return (c, params) => {
    const q = c.req.query;
    const r = q.get('range') ?? '24h';
    if (!(RANGES as readonly string[]).includes(r)) return legacyProblem(400, 'Invalid range', 'invalid_range', 'range must be one of 1h, 6h, 24h, 7d, 30d');
    const fx = c.fx();
    const group = q.get('group') ?? 'All';
    if (group !== 'All' && !fx.fleet.groups.some((g) => g.name === group)) return legacyProblem(400, 'Unknown group', 'invalid_group', group);
    return fn(c, fx, r as Range, group, params);
  };
}

const notFoundServer = (id: string): FxResponse => legacyProblem(404, 'Server not found', 'not_found', id);
const decode = (s: string | undefined): string => decodeURIComponent(s ?? '');

function alerts(c: Ctx, fx: FixtureSet, group: string): FxResponse {
  const q = c.req.query;
  const state = q.get('state') ?? 'open';
  if (!['open', 'resolved', 'all'].includes(state)) return problem(400, 'invalid_state', 'state must be open, resolved or all.');
  const ids = new Set(fx.fleet.servers.filter((s) => group === 'All' || s.group === group).map((s) => s.id));
  const server = q.get('server');
  let list = [...(state === 'resolved' ? [] : fx.fleet.alerts), ...(state === 'open' ? [] : resolvedAlerts(fx.fleet.as_of))];
  list = list.filter((a) => ids.has(a.server) && (!server || a.server === server));
  const limit = Number.parseInt(q.get('limit') ?? '', 10);
  if (Number.isFinite(limit) && limit > 0) list = list.slice(0, Math.min(limit, 1000));
  return read(c, list, CACHE_READ);
}

const ago = (anchor: number, ms: number): string => new Date(anchor - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** GET /tokens: one API token and one kiosk link. */
function sampleTokens(user: string, anchor: number) {
  return [
    { id: 'tk_prometheus', name: 'Prometheus', role: 'viewer', user, kind: 'api', created_at: ago(anchor, 30 * 86400_000), last_used_at: ago(anchor, 40_000), expires_at: null },
    { id: 'tk_office_tv', name: 'Office TV', role: 'viewer', user, kind: 'kiosk', created_at: ago(anchor, 9 * 86400_000), last_used_at: ago(anchor, 3 * 3600_000), expires_at: null },
  ];
}

/** GET /users: the signed-in admin and two more accounts. */
function sampleUsers(me: { name: string; role: string }, anchor: number) {
  const base = { passkeys: 0, sessions: 0, has_password: true, must_change_password: false, oidc_linked: false, role_managed: false, self: false, source: 'local' };
  return [
    { ...base, id: 1, name: me.name, role: me.role, created_at: ago(anchor, 60 * 86400_000), last_login_at: ago(anchor, 3600_000), passkeys: 1, sessions: 1, self: true },
    { ...base, id: 2, name: 'olive', role: 'operator', created_at: ago(anchor, 20 * 86400_000), last_login_at: ago(anchor, 2 * 86400_000), sessions: 2 },
    { ...base, id: 3, name: 'vera', role: 'viewer', created_at: ago(anchor, 3600_000), last_login_at: null, must_change_password: true },
  ];
}

const ROUTES: Route[] = [
  {
    method: 'GET',
    re: /^\/events$/,
    handler: (c) => {
      const raw = header(c.req, 'last-event-id') ?? c.req.query.get('last_event_id');
      const n = raw ? Number.parseInt(raw, 10) : NaN;
      return eventStream(c.store, c.st, Number.isFinite(n) ? n : null);
    },
  },

  // ---- reads (fixtures + this browser's changes)
  { method: 'GET', re: /^\/fleet$/, handler: legacy((c, fx, _r, group) => read(c, computeFleet(fx.fleet, group), CACHE_READ)) },
  { method: 'GET', re: /^\/fleet\/series$/, handler: legacy((c, fx, range, group) => read(c, computeFleetSeries(fx.fleet, group, range), CACHE_READ)) },
  { method: 'GET', re: /^\/servers$/, handler: legacy((c, fx) => read(c, serverListFor(c.st, serverList(fx.fleet)))) },
  { method: 'GET', re: /^\/alerts$/, handler: legacy((c, fx, _r, group) => alerts(c, fx, group)) },
  {
    method: 'GET',
    re: /^\/servers\/([^/]+)$/,
    handler: legacy((c, fx, range, _g, [raw]) => {
      const id = decode(raw);
      const rec = findServer(c.st, id);
      if (!rec) return notFoundServer(id);
      applyGuestOverrides(c.store, c.st, fx);
      const d = detailResponse(fx, id, range);
      if (!d) return notFoundServer(id);
      d.server.group = rec.group;
      d.server.location = rec.location;
      d.server.remote_control = detailRemoteControl(effectivePerms(c.st, rec));
      return read(c, d);
    }),
  },
  {
    method: 'GET',
    re: /^\/servers\/([^/]+)\/metrics$/,
    handler: legacy((c, fx, range, _g, [raw]) => {
      const id = decode(raw);
      const wanted = c.req.query.get('series');
      const out = findServer(c.st, id) ? metricsFor(fx, id, range, wanted ? wanted.split(',').map((s) => s.trim()).filter(Boolean) : null) : null;
      return out ? read(c, out, CACHE_READ) : notFoundServer(id);
    }),
  },
  {
    method: 'GET',
    re: /^\/servers\/([^/]+)\/guests$/,
    handler: legacy((c, fx, _r, _g, [raw]) => {
      const id = decode(raw);
      if (!findServer(c.st, id)) return notFoundServer(id);
      applyGuestOverrides(c.store, c.st, fx);
      const q = c.req.query;
      const out = guestsFor(fx, id, q.get('platform'), q.get('kind'), q.get('q'));
      return out ? read(c, out) : notFoundServer(id);
    }),
  },
  {
    method: 'GET',
    re: /^\/servers\/([^/]+)\/guests\/([^/]+)$/,
    handler: (c, [rawId, rawGuest]) => {
      const id = decode(rawId);
      if (!findServer(c.st, id)) return problem(404, 'server_not_found', 'No such server.');
      const fx = c.fx();
      applyGuestOverrides(c.store, c.st, fx);
      const g = findGuest(fx, id, decode(rawGuest));
      return g ? read(c, g) : problem(404, 'guest_not_found', 'No such guest on this server.');
    },
  },
  {
    method: 'GET',
    re: /^\/guests$/,
    handler: (c) => {
      const q = c.req.query;
      const p = { q: q.get('q'), state: q.get('state'), platform: q.get('platform'), kind: q.get('kind'), server: q.get('server'), tag: q.get('tag'), sort: q.get('sort'), limit: q.get('limit'), cursor: q.get('cursor') };
      const bad = listParamError(p);
      if (bad) return problem(400, bad.code, bad.detail);
      return read(c, listGuests(c.store, c.st, c.fx(), p));
    },
  },
  { method: 'GET', re: /^\/groups$/, handler: (c) => json(200, groupsInUse(c.st)) },
  // Accounts (read only here; the hub implements the changes).
  { method: 'GET', re: /^\/tokens$/, handler: (c) => json(200, sampleTokens(c.st.user.name, c.st.anchor)) },
  { method: 'GET', re: /^\/users$/, admin: true, handler: (c) => json(200, sampleUsers(c.st.user, c.st.anchor)) },

  // ---- admin
  { method: 'GET', re: /^\/servers\/([^/]+)\/settings$/, admin: true, handler: (c, [id]) => serverSettings(c, decode(id)) },
  { method: 'PATCH', re: /^\/servers\/([^/]+)$/, admin: true, handler: (c, [id]) => patchServer(c, decode(id)) },
  { method: 'DELETE', re: /^\/servers\/([^/]+)$/, admin: true, handler: (c, [id]) => deleteServer(c, decode(id)) },
  { method: 'POST', re: /^\/enrollments$/, admin: true, handler: (c) => createEnrollment(c) },
  { method: 'GET', re: /^\/enrollments$/, admin: true, handler: (c) => listEnrollments(c) },
  { method: 'POST', re: /^\/enrollments\/([^/]+)\/approve$/, admin: true, handler: (c, [id]) => approveEnrollment(c, decode(id)) },
  { method: 'POST', re: /^\/enrollments\/([^/]+)\/reject$/, admin: true, handler: (c, [id]) => rejectEnrollment(c, decode(id)) },
  { method: 'GET', re: /^\/agents$/, admin: true, handler: (c) => listAgents(c) },
  {
    method: 'GET',
    re: /^\/audit$/,
    admin: true,
    handler: (c) => {
      const q = c.req.query;
      return json(200, listAudit(c.st, { limit: q.get('limit'), cursor: q.get('cursor'), event: q.get('event'), server: q.get('server') }));
    },
  },
  {
    method: 'GET',
    re: /^\/audit\/export$/,
    admin: true,
    handler: (c) => {
      const q = c.req.query;
      const body = auditCsv(c.st, { event: q.get('event'), server: q.get('server') });
      const stamp = new Date(c.store.fxNow()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      appendAudit(c.store, c.st, { event: 'audit.exported' }, c.req);
      return {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="rackoon-audit-${stamp}.csv"`,
          'Cache-Control': 'no-store',
        },
        body,
      };
    },
  },
  { method: 'GET', re: /^\/console-sessions$/, admin: true, handler: (c) => listConsoleSessions(c) },

  // ---- console, actions, screens (role checks inside: refusals are audited)
  { method: 'POST', re: /^\/servers\/([^/]+)\/guests\/([^/]+)\/console-sessions$/, handler: (c, [s, g]) => createConsoleSession(c, decode(s), decode(g)) },
  { method: 'DELETE', re: /^\/console-sessions\/([^/]+)$/, handler: (c, [id]) => deleteConsoleSession(c, decode(id)) },
  { method: 'POST', re: /^\/servers\/([^/]+)\/guests\/([^/]+)\/actions$/, handler: (c, [s, g]) => guestAction(c, decode(s), decode(g)) },
  { method: 'GET', re: /^\/servers\/([^/]+)\/guests\/([^/]+)\/thumbnail$/, handler: (c, [s, g]) => thumbnail(c, decode(s), decode(g)) },
  { method: 'GET', re: /^\/servers\/([^/]+)\/guests\/([^/]+)\/screenshot$/, handler: (c, [s, g]) => screenshot(c, decode(s), decode(g)) },

  // ---- managing guests (docs/MANAGE.md): manage.ts, lifecycle.ts
  ...manageRoutes,
  ...lifecycleRoutes,

  // ---- the assistant (docs/ASSIST.md): assist.ts
  ...assistRoutes,
];

function route(c: Ctx): FxResponse {
  const { req, st } = c;
  const unsafe = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  const csrfMissing = unsafe && !header(req, 'x-csrf-token');
  if (req.path.startsWith('/auth/')) {
    if (csrfMissing) return problem(403, 'csrf', 'Missing or invalid CSRF token.');
    return authRoute(c) ?? problem(404, 'not_found', 'Not found.');
  }
  if (!st.authenticated) return problem(401, 'unauthenticated', 'Sign in to continue.');
  if (csrfMissing) return problem(403, 'csrf', 'Missing or invalid CSRF token.');
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const allowed: string[] = [];
  for (const r of ROUTES) {
    const m = r.re.exec(req.path);
    if (!m) continue;
    if (r.method !== method) {
      allowed.push(r.method);
      continue;
    }
    if (r.admin && !roleAtLeast(st, 'admin')) return problem(403, 'insufficient_role', 'Requires admin access.');
    return r.handler(c, m.slice(1));
  }
  if (allowed.length) {
    const res = problem(405, 'method_not_allowed', `Use ${allowed.join(' or ')}.`);
    res.headers.Allow = allowed.join(', ');
    return res;
  }
  return problem(404, 'not_found', 'Not found.');
}

/** Handle one /api/v1 request for the browser identified by its Cookie header. */
export function handleApi(store: FixtureStore, req: FxRequest): FxResponse {
  const { state, setCookie } = store.resolve(header(req, 'cookie'));
  const res = route(makeCtx(store, state, req));
  if (setCookie) res.headers['Set-Cookie'] = setCookie;
  return res;
}
