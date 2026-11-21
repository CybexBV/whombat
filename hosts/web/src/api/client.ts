// Typed client for the hub API (`/api/v1`). Same-origin session cookie,
// `X-CSRF-Token` on every mutation (token from GET /auth/state, CONTRACT 2).
// Responses are typed at this boundary; in dev builds they are also shape
// checked (validate.ts) and mismatches are logged.

import type {
  ActionAccepted,
  AgentInfo,
  Alert,
  Annotation,
  AuditPage,
  AuthState,
  Channel,
  ChannelInput,
  Check,
  CheckInput,
  GuestAction,
  InspectKind,
  InspectResult,
  Snapshot,
  SnapshotArgs,
  ConsoleProtocol,
  ConsoleSession,
  Delivery,
  Enrollment,
  Fleet,
  FleetSeries,
  Guest,
  GuestList,
  GuestListPage,
  GuestListParams,
  Maintenance,
  MaintenanceCreate,
  Metrics,
  NotifySettings,
  Passkey,
  PendingEnrollment,
  Problem,
  ProxmoxDetail,
  Range,
  ServerDetail,
  ServerListItem,
  ServerSettings,
  ServerSettingsPatch,
  Zoom,
} from './types';
import {
  alertSchema,
  arr,
  fleetSchema,
  fleetSeriesSchema,
  guestSchema,
  guestListSchema,
  metricsSchema,
  proxmoxDetailSchema,
  standardDetailSchema,
  validate,
} from './validate';

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | null;
  constructor(status: number, problem: Problem | null, message?: string) {
    super(message ?? problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }
  get code(): string | undefined {
    return this.problem?.code;
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;
let onReauth: (() => Promise<boolean>) | null = null;

/**
 * Registered by the app: asks the user to confirm their credentials when the
 * hub answers 403 reauth_required (sensitive changes need a recent sign-in);
 * resolves true when confirmed, and the request is then sent again once.
 */
export function setReauthHandler(fn: (() => Promise<boolean>) | null): void {
  onReauth = fn;
}

/** Called by the auth layer whenever /auth/state is (re)loaded. */
export function setCsrfToken(token: string | null | undefined): void {
  csrfToken = token ?? null;
}

/** Registered by the app: invoked on any 401 so the auth state is refetched. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

type Params = Record<string, string | number | undefined | null>;

function buildUrl(path: string, params?: Params): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ''}`;
}

function isProblem(v: unknown): v is Problem {
  return !!v && typeof v === 'object' && 'title' in v && 'status' in v;
}

async function send(method: string, path: string, opts: { params?: Params; body?: unknown; signal?: AbortSignal; accept?: string }): Promise<Response> {
  const headers: Record<string, string> = { Accept: opts.accept ?? 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') {
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  }
  return fetch(buildUrl(path, opts.params), {
    method,
    headers,
    credentials: 'same-origin',
    // Revalidate instead of reusing a cached read (the hub sends max-age=5 with an ETag):
    // a refetch right after an action must see the new state.
    cache: 'no-cache',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
}

async function problemOf(res: Response): Promise<Problem | null> {
  try {
    const v: unknown = JSON.parse(await res.text());
    return isProblem(v) ? v : null;
  } catch {
    return null;
  }
}

/** Binary GET (thumbnails, screenshots): resolves to the body as a Blob. */
async function requestBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const res = await send('GET', path, { signal, accept: 'image/*' });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(res.status, await problemOf(res));
  }
  return res.blob();
}

async function request(method: string, path: string, opts: { params?: Params; body?: unknown; signal?: AbortSignal; retried?: boolean } = {}): Promise<unknown> {
  const res = await send(method, path, opts);
  if (res.status === 204) return null;
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    const problem = isProblem(data) ? data : null;
    if (res.status === 403 && problem?.code === 'reauth_required' && onReauth && !opts.retried) {
      if (await onReauth()) return request(method, path, { ...opts, retried: true });
    }
    throw new ApiError(res.status, problem);
  }
  return data;
}

function checked<T>(label: string, schema: Parameters<typeof validate>[0] | null, data: unknown): T {
  if (schema) {
    const errs = validate(schema, data, label);
    if (errs.length) console.warn(`[api] ${label} does not match the expected shape:\n  ${errs.slice(0, 20).join('\n  ')}`);
  }
  return data as T;
}

/** Accept a bare array or an object wrapping it under one of `keys`. */
function listOf(data: unknown, keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  throw new ApiError(500, null, 'Unexpected response shape (expected a list)');
}

/** Detail bodies come in two shapes; see API.md 2.3. */
export function isProxmoxDetail(d: ServerDetail): d is ProxmoxDetail {
  return d.server.detail_view === 'proxmox' || 'cluster' in d || d.server.roles.includes('proxmox-node');
}

// --------------------------------------------------------------- endpoints

export const api = {
  authState: async (signal?: AbortSignal): Promise<AuthState> =>
    (await request('GET', '/auth/state', { signal })) as AuthState,

  logout: async (): Promise<void> => {
    await request('POST', '/auth/logout');
  },

  login: async (username: string, password: string): Promise<void> => {
    await request('POST', '/auth/login', { body: { username, password } });
  },

  setup: async (setupToken: string, username: string, password: string): Promise<void> => {
    await request('POST', '/auth/setup', { body: { setup_token: setupToken, username, password } });
  },

  changePassword: async (current: string, next: string): Promise<void> => {
    await request('POST', '/auth/password', { body: { current, new: next } });
  },

  passkeyLoginBegin: async (): Promise<unknown> => request('POST', '/auth/passkey/login/begin', { body: {} }),
  passkeyLoginFinish: async (credential: unknown): Promise<void> => {
    await request('POST', '/auth/passkey/login/finish', { body: credential });
  },
  passkeyRegisterBegin: async (name: string): Promise<unknown> => request('POST', '/auth/passkey/register/begin', { body: { name } }),
  passkeyRegisterFinish: async (credential: unknown): Promise<void> => {
    await request('POST', '/auth/passkey/register/finish', { body: credential });
  },
  reauth: async (password: string): Promise<void> => {
    await request('POST', '/auth/reauth', { body: { password }, retried: true });
  },
  passkeyReauthBegin: async (): Promise<unknown> => request('POST', '/auth/passkey/reauth/begin', { body: {}, retried: true }),
  passkeyReauthFinish: async (credential: unknown): Promise<void> => {
    await request('POST', '/auth/passkey/reauth/finish', { body: credential, retried: true });
  },
  passkeys: async (signal?: AbortSignal): Promise<Passkey[]> => listOf(await request('GET', '/auth/passkeys', { signal }), ['passkeys', 'items']) as Passkey[],
  deletePasskey: async (id: string): Promise<void> => {
    await request('DELETE', `/auth/passkeys/${encodeURIComponent(id)}`);
  },

  fleet: async (group: string, range: Range, signal?: AbortSignal): Promise<Fleet> =>
    checked<Fleet>('GET /fleet', import.meta.env.DEV ? fleetSchema : null, await request('GET', '/fleet', { params: { group, range }, signal })),

  fleetSeries: async (group: string, range: Range, signal?: AbortSignal): Promise<FleetSeries> =>
    checked<FleetSeries>('GET /fleet/series', import.meta.env.DEV ? fleetSeriesSchema : null, await request('GET', '/fleet/series', { params: { group, range }, signal })),

  servers: async (signal?: AbortSignal): Promise<ServerListItem[]> =>
    listOf(await request('GET', '/servers', { signal }), ['servers', 'items']) as ServerListItem[],

  server: async (id: string, range: Range, signal?: AbortSignal): Promise<ServerDetail> => {
    const data = await request('GET', `/servers/${encodeURIComponent(id)}`, { params: { range }, signal });
    const d = data as ServerDetail;
    return checked<ServerDetail>(`GET /servers/${id}`, import.meta.env.DEV ? (isProxmoxDetail(d) ? proxmoxDetailSchema : standardDetailSchema) : null, data);
  },

  metrics: async (id: string, range: Range, series?: string[], signal?: AbortSignal, zoom?: Zoom | null): Promise<Metrics> =>
    checked<Metrics>(
      `GET /servers/${id}/metrics`,
      import.meta.env.DEV ? metricsSchema : null,
      await request('GET', `/servers/${encodeURIComponent(id)}/metrics`, {
        params: zoom ? { from: zoom.from, to: zoom.to, series: series?.join(',') } : { range, series: series?.join(',') },
        signal,
      }),
    ),

  /** History of one guest (CPU, memory, network, disk I/O), sampled once a minute. */
  guestMetrics: async (id: string, guestId: string, range: Range, signal?: AbortSignal): Promise<Metrics> =>
    (await request('GET', `/servers/${encodeURIComponent(id)}/guests/${encodeURIComponent(guestId)}/metrics`, { params: { range }, signal })) as Metrics,

  /** Chart markers: alerts, reboots, actions. */
  annotations: async (id: string, range: Range, zoom?: Zoom | null, signal?: AbortSignal): Promise<Annotation[]> =>
    ((await request('GET', `/servers/${encodeURIComponent(id)}/annotations`, { params: zoom ? { from: zoom.from, to: zoom.to } : { range }, signal })) as Annotation[] | null) ?? [],

  /**
   * Full guest list for one platform. Proxmox uses platform=pve plus
   * kind=vm|container. Accepts `{guests: [...]}` or a bare array.
   */
  guests: async (id: string, platform: string, kind?: string, signal?: AbortSignal): Promise<GuestList> => {
    const data = await request('GET', `/servers/${encodeURIComponent(id)}/guests`, { params: { platform, kind }, signal });
    const guests = checked<Guest[]>(`GET /servers/${id}/guests`, import.meta.env.DEV ? arr(guestSchema) : null, listOf(data, ['guests', 'items']));
    const total = data && typeof data === 'object' && !Array.isArray(data) && typeof (data as GuestList).total === 'number' ? (data as GuestList).total : undefined;
    return { guests, total };
  },

  /** Guests on every server, filtered, sorted and paged (CONTRACT 1). */
  listGuests: async (p: GuestListParams, signal?: AbortSignal): Promise<GuestListPage> => {
    const data = await request('GET', '/guests', {
      params: { q: p.q, state: p.state, platform: p.platform, kind: p.kind, server: p.server, tag: p.tag, sort: p.sort, limit: p.limit, cursor: p.cursor },
      signal,
    });
    const page = checked<Partial<GuestListPage>>('GET /guests', import.meta.env.DEV ? guestListSchema : null, data);
    return {
      guests: page.guests ?? [],
      total: page.total ?? page.guests?.length ?? 0,
      next_cursor: page.next_cursor ?? null,
      counts: page.counts ?? { all: page.total ?? 0, running: 0, stopped: 0, unhealthy: 0 },
      platforms: page.platforms ?? {},
      tags: page.tags,
    };
  },

  alerts: async (signal?: AbortSignal): Promise<Alert[]> =>
    checked<Alert[]>('GET /alerts', import.meta.env.DEV ? arr(alertSchema) : null, listOf(await request('GET', '/alerts', { params: { state: 'open' }, signal }), ['alerts', 'items'])),

  /** Alert history, newest first, with filters; `before` pages (the opened_at of the last item). */
  alertHistory: async (
    f: { state?: 'resolved' | 'all'; server?: string; group?: string; severity?: string; q?: string; before?: string | null; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ items: Alert[]; nextBefore: string | null }> => {
    const res = await send('GET', '/alerts', {
      params: { state: f.state ?? 'resolved', server: f.server, group: f.group, severity: f.severity, q: f.q, before: f.before, limit: f.limit ?? 50 },
      signal,
    });
    if (!res.ok) {
      if (res.status === 401) onUnauthorized?.();
      throw new ApiError(res.status, await problemOf(res));
    }
    const items = listOf(await res.json(), ['alerts', 'items']) as Alert[];
    return { items, nextBefore: res.headers.get('X-Next-Before') };
  },

  ackAlert: async (id: string, note: string, minutes: number): Promise<Alert> =>
    (await request('POST', `/alerts/${encodeURIComponent(id)}/ack`, { body: { note, minutes } })) as Alert,
  unackAlert: async (id: string): Promise<Alert> => (await request('DELETE', `/alerts/${encodeURIComponent(id)}/ack`)) as Alert,

  channels: async (signal?: AbortSignal): Promise<Channel[]> => listOf(await request('GET', '/channels', { signal }), ['items']) as Channel[],
  createChannel: async (c: ChannelInput): Promise<Channel> => (await request('POST', '/channels', { body: c })) as Channel,
  patchChannel: async (id: string, c: ChannelInput): Promise<Channel> => (await request('PATCH', `/channels/${encodeURIComponent(id)}`, { body: c })) as Channel,
  deleteChannel: async (id: string): Promise<void> => {
    await request('DELETE', `/channels/${encodeURIComponent(id)}`);
  },
  testChannel: async (id: string): Promise<{ ok: boolean; error: string }> =>
    (await request('POST', `/channels/${encodeURIComponent(id)}/test`, { body: {} })) as { ok: boolean; error: string },
  testChannelConfig: async (c: ChannelInput): Promise<{ ok: boolean; error: string }> =>
    (await request('POST', '/channels/test', { body: c })) as { ok: boolean; error: string },
  deliveries: async (signal?: AbortSignal): Promise<Delivery[]> => listOf(await request('GET', '/deliveries', { params: { limit: 50 }, signal }), ['items']) as Delivery[],
  notifySettings: async (signal?: AbortSignal): Promise<NotifySettings> => (await request('GET', '/notification-settings', { signal })) as NotifySettings,
  saveNotifySettings: async (s: { heartbeat_url?: string; heartbeat_minutes: number }): Promise<NotifySettings> =>
    (await request('PUT', '/notification-settings', { body: s })) as NotifySettings,

  maintenance: async (signal?: AbortSignal): Promise<Maintenance[]> => listOf(await request('GET', '/maintenance', { signal }), ['items']) as Maintenance[],
  createMaintenance: async (m: MaintenanceCreate): Promise<Maintenance> => (await request('POST', '/maintenance', { body: m })) as Maintenance,
  deleteMaintenance: async (id: string): Promise<void> => {
    await request('DELETE', `/maintenance/${encodeURIComponent(id)}`);
  },

  resolvedAlerts: async (limit: number, signal?: AbortSignal): Promise<Alert[]> =>
    checked<Alert[]>(
      'GET /alerts?state=resolved',
      import.meta.env.DEV ? arr(alertSchema) : null,
      listOf(await request('GET', '/alerts', { params: { state: 'resolved', limit }, signal }), ['alerts', 'items']),
    ),

  // ---- console (CONTRACT 4)

  createConsoleSession: async (serverId: string, guestId: string, protocol: ConsoleProtocol | null, switchFrom?: string | null): Promise<ConsoleSession> =>
    (await request('POST', `${targetPath(serverId, guestId)}/console-sessions`, {
      body: { ...(protocol ? { protocol } : {}), ...(switchFrom ? { switch_from: switchFrom } : {}) },
    })) as ConsoleSession,

  closeConsoleSession: async (sessionId: string): Promise<void> => {
    await request('DELETE', `/console-sessions/${encodeURIComponent(sessionId)}`);
  },

  /** A guest action, or with HOST_GUEST_ID an action on the host itself. Snapshot actions carry `args`. */
  guestAction: async (serverId: string, guestId: string, action: GuestAction, args?: SnapshotArgs): Promise<ActionAccepted> =>
    (await request('POST', `${targetPath(serverId, guestId)}/actions`, { body: { action, confirm: true, ...args } })) as ActionAccepted,

  snapshots: async (serverId: string, guestId: string, signal?: AbortSignal): Promise<InspectResult<Snapshot>> =>
    (await request('GET', `${guestPath(serverId, guestId)}/snapshots`, { signal })) as InspectResult<Snapshot>,

  /** Live view of the host (never stored): processes, services, ports or pending updates. */
  inspect: async <T>(serverId: string, kind: InspectKind, signal?: AbortSignal): Promise<InspectResult<T>> =>
    (await request('GET', `/servers/${encodeURIComponent(serverId)}/inspect/${kind}`, { signal })) as InspectResult<T>,

  thumbnail: (serverId: string, guestId: string, signal?: AbortSignal): Promise<Blob> => requestBlob(`${guestPath(serverId, guestId)}/thumbnail`, signal),

  screenshot: (serverId: string, guestId: string, signal?: AbortSignal): Promise<Blob> => requestBlob(`${guestPath(serverId, guestId)}/screenshot`, signal),

  // ---- admin (CONTRACT 3)

  createEnrollment: async (): Promise<Enrollment> => (await request('POST', '/enrollments', { body: {} })) as Enrollment,

  pendingEnrollments: async (signal?: AbortSignal): Promise<PendingEnrollment[]> =>
    listOf(await request('GET', '/enrollments', { params: { state: 'pending' }, signal }), ['enrollments', 'items']) as PendingEnrollment[],

  approveEnrollment: async (id: string, group: string, name: string): Promise<{ server_id: string }> =>
    (await request('POST', `/enrollments/${encodeURIComponent(id)}/approve`, { body: { group, name } })) as { server_id: string },

  rejectEnrollment: async (id: string): Promise<void> => {
    await request('POST', `/enrollments/${encodeURIComponent(id)}/reject`, { body: {} });
  },

  agents: async (signal?: AbortSignal): Promise<AgentInfo[]> => listOf(await request('GET', '/agents', { signal }), ['agents', 'items']) as AgentInfo[],

  /** Update the listed agents to the hub's build (empty: every agent that can be), one at a time. */
  updateAgents: async (servers: string[] = []): Promise<{ servers: string[]; version: string }> =>
    (await request('POST', '/agents/update', { body: { servers } })) as { servers: string[]; version: string },

  checks: async (signal?: AbortSignal): Promise<Check[]> => listOf(await request('GET', '/checks', { signal }), ['items']) as Check[],
  createCheck: async (c: CheckInput): Promise<Check> => (await request('POST', '/checks', { body: c })) as Check,
  patchCheck: async (id: string, c: CheckInput): Promise<Check> => (await request('PATCH', `/checks/${encodeURIComponent(id)}`, { body: c })) as Check,
  deleteCheck: async (id: string): Promise<void> => {
    await request('DELETE', `/checks/${encodeURIComponent(id)}`);
  },

  groups: async (signal?: AbortSignal): Promise<string[]> => listOf(await request('GET', '/groups', { signal }), ['groups', 'items']) as string[],

  serverSettings: async (id: string, signal?: AbortSignal): Promise<ServerSettings> =>
    (await request('GET', `/servers/${encodeURIComponent(id)}/settings`, { signal })) as ServerSettings,

  patchServer: async (id: string, patch: ServerSettingsPatch): Promise<ServerSettings> =>
    (await request('PATCH', `/servers/${encodeURIComponent(id)}`, { body: patch })) as ServerSettings,

  deleteServer: async (id: string): Promise<void> => {
    await request('DELETE', `/servers/${encodeURIComponent(id)}`);
  },

  audit: async (opts: { limit?: number; cursor?: string | null; event?: string | null; server?: string | null }, signal?: AbortSignal): Promise<AuditPage> => {
    const data = await request('GET', '/audit', { params: { limit: opts.limit ?? 100, cursor: opts.cursor, event: opts.event, server: opts.server }, signal });
    if (Array.isArray(data)) return { items: data as AuditPage['items'], next_cursor: null };
    const page = (data ?? {}) as Partial<AuditPage>;
    return { items: page.items ?? [], next_cursor: page.next_cursor ?? null };
  },
};

/** The JSON request helper (CSRF, 401 and re-authentication handling) for feature modules with their own endpoints. */
export { request as apiRequest };

function guestPath(serverId: string, guestId: string): string {
  return `/servers/${encodeURIComponent(serverId)}/guests/${encodeURIComponent(guestId)}`;
}

/** Guest id of the host itself in console and action requests. */
export const HOST_GUEST_ID = 'host:host';

/** Console sessions and actions: the guest's path, or the server's for the host itself. */
function targetPath(serverId: string, guestId: string): string {
  return guestId === HOST_GUEST_ID ? `/servers/${encodeURIComponent(serverId)}` : guestPath(serverId, guestId);
}

/** URL of the audit CSV export (a plain link; the session cookie authenticates it). */
export function auditExportUrl(filters: { event?: string | null; server?: string | null } = {}): string {
  return buildUrl('/audit/export', filters);
}

/** Absolute ws(s):// URL for a console session's relative `url` (CONTRACT 4). */
export function consoleSocketUrl(url: string, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  if (/^wss?:\/\//.test(url)) return url;
  if (/^https?:\/\//.test(url)) return url.replace(/^http/, 'ws');
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}${url.startsWith('/') ? url : `/${url}`}`;
}
