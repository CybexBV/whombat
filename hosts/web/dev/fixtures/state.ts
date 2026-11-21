// Per-browser mutable state of the fixture server. Every browser (cookie
// `rackoon_fx`) gets its own copy so Playwright tests running in parallel
// against one dev server never see each other's changes. In memory only;
// states idle for more than 2 h are dropped.

import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type {
  AuditRecord,
  CollectorStatus,
  ConsoleProtocol,
  DetailView,
  Fleet,
  GuestState,
  Passkey,
  RemoteControlToggles,
  Role,
  ServerStatus,
} from '../../src/api/types.ts';
import { AGENT_SEEDS } from './catalog.ts';
import { loadFixtures } from './data.ts';
import { parseCookies } from './http.ts';

export const COOKIE = 'rackoon_fx';
export const STATE_IDLE_MS = 2 * 3600_000;
const MAX_STATES = 5000;

export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

/** The fixtures' clock: everything is frozen at fleet.json's as_of by default. */
export const AS_OF = loadFixtures().fleet.as_of;
export const AS_OF_MS = Date.parse(AS_OF);

export const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

/** Random base64url string of `bytes` random bytes (32 bytes -> 43 chars). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const randomHex = (bytes = 8): string => randomBytes(bytes).toString('hex');

/** One server as this browser sees it (fleet.json servers plus approved ones). */
export interface ServerRec {
  id: string;
  hostname: string;
  group: string;
  location: string | null;
  status: ServerStatus;
  statusNote: string | null;
  os: string;
  detailView: DetailView;
  version: string | null;
  address: string | null;
  lastSeen: string | null;
  clockSkewS: number | null;
  collectors: CollectorStatus[];
  remoteControl: RemoteControlToggles;
  agentPolicy: RemoteControlToggles;
  certExpiresAt: string | null;
  certSerial: string;
  /** Approved in this browser (not in fleet.json). */
  approved: boolean;
}

export type EnrollmentState = 'issued' | 'pending' | 'approved' | 'rejected';

export interface EnrollmentRec {
  id: string;
  state: EnrollmentState;
  createdAt: number;
  expiresAt: number;
  hostname: string | null;
  os: string | null;
  address: string | null;
  agentVersion: string | null;
  requestedAt: number | null;
  serverId: string | null;
}

export interface GuestOverride {
  state: GuestState;
  /** Real clock ms of the change (uptime of a started guest). */
  sinceReal: number;
}

export interface ConsoleSessionRec {
  id: string;
  token: string;
  server: string;
  guestId: string;
  protocol: ConsoleProtocol;
  /** Real clock ms until which the token can be used. */
  tokenExpiresReal: number;
  used: boolean;
  live: boolean;
  user: string;
  role: Role;
  clientIp: string;
  userAgent: string;
  /** Set while a WebSocket is attached: ends the session with a reason. */
  close: ((reason: string) => void) | null;
}

export interface AuditEntry {
  seq: number;
  rec: AuditRecord;
}

export interface EventRec {
  id: number;
  name: string;
  data: string;
}

export interface BrowserState {
  id: string;
  lastSeenReal: number;
  /** Fixture clock when the state was created: seeds are relative to it. */
  anchor: number;

  setupRequired: boolean;
  authenticated: boolean;
  user: { name: string; role: Role };
  /** Role chosen with ?role=: used again by the next sign-in. */
  roleToggle: Role | null;
  /** ?reauth=1: sensitive changes answer 403 reauth_required until POST /auth/reauth. */
  reauthRequired: boolean;
  passkeys: Passkey[];
  webauthnUserId: string;
  pendingPasskeyName: string | null;

  servers: ServerRec[];
  enrollments: EnrollmentRec[];
  guestOverrides: Map<string, GuestOverride>;
  actionsInFlight: Set<string>;
  sessions: Map<string, ConsoleSessionRec>;
  seq: { enrollment: number; host: number; session: number; action: number; audit: number; event: number };
  /** Lazily seeded (see audit.ts). */
  audit: AuditEntry[] | null;
  events: { backlog: EventRec[]; clients: Set<ServerResponse> };
  timers: Set<ReturnType<typeof setTimeout>>;
  /** screens.viewed throttle: key -> real ms of the last record. */
  screensAudited: Map<string, number>;
  /** Thumbnail refresh counter per guest (drives the small variation). */
  thumbFrames: Map<string, number>;
}

export interface StoreOptions {
  /** Real clock (tests inject a fake one). */
  now?: () => number;
  /** FIXTURE_TIME=live: the fixture clock follows the real clock. */
  live?: boolean;
}

function seedServers(fleet: Fleet, anchor: number): ServerRec[] {
  const asOf = Date.parse(fleet.as_of);
  return fleet.servers.map((s) => {
    const a = AGENT_SEEDS[s.id];
    return {
      id: s.id,
      hostname: s.id,
      group: s.group,
      location: a?.location ?? null,
      status: s.status,
      statusNote: s.status_note,
      os: s.os ?? '',
      detailView: s.detail_view,
      version: a?.version ?? '0.14.2',
      address: a?.address ?? null,
      lastSeen: iso(anchor - (asOf - Date.parse(s.last_seen ?? fleet.as_of))),
      clockSkewS: a ? a.clockSkewS : null,
      collectors: (a?.collectors ?? []).map((c) => ({ ...c })),
      // Diagnostics (the assistant's read-only checks) is on by default on both sides.
      remoteControl: { diagnose: true, ...(a?.remoteControl ?? { console: false, power: false }) },
      agentPolicy: { diagnose: true, ...(a?.agentPolicy ?? { console: true, power: true }) },
      certExpiresAt: iso(anchor + (a?.certDays ?? 365) * 86400_000),
      certSerial: randomHex(8),
      approved: false,
    };
  });
}

export class FixtureStore {
  readonly states = new Map<string, BrowserState>();
  readonly now: () => number;
  readonly live: boolean;
  private readonly fleet: Fleet;
  private lastPrune = 0;

  constructor(opts: StoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.live = opts.live ?? process.env.FIXTURE_TIME === 'live';
    this.fleet = loadFixtures().fleet;
  }

  /** Fixture clock in ms: as_of (frozen) or the real clock (live). */
  fxNow(): number {
    return this.live ? this.now() : AS_OF_MS;
  }

  create(id = randomToken(18)): BrowserState {
    const anchor = this.fxNow();
    const st: BrowserState = {
      id,
      lastSeenReal: this.now(),
      anchor,
      setupRequired: false,
      authenticated: true,
      user: { name: 'admin', role: 'admin' },
      roleToggle: null,
      reauthRequired: false,
      passkeys: [
        { id: 'cGFzc2tleS1tYWNib29rLXRvdWNoLWlk', name: 'MacBook Touch ID', created_at: iso(anchor - 40 * 86400_000 - 5 * 3600_000), last_used_at: iso(anchor - 2 * 3600_000 - 13 * 60_000) },
      ],
      webauthnUserId: randomToken(32),
      pendingPasskeyName: null,
      servers: seedServers(this.fleet, anchor),
      enrollments: [
        {
          id: 'en_seed', state: 'pending', createdAt: anchor - 15 * 60_000, expiresAt: anchor + 45 * 60_000,
          hostname: 'pumice', os: 'Ubuntu 24.04.3 LTS', address: '10.20.0.27', agentVersion: '0.14.2',
          requestedAt: anchor - 12 * 60_000, serverId: null,
        },
      ],
      guestOverrides: new Map(),
      actionsInFlight: new Set(),
      sessions: new Map(),
      seq: { enrollment: 0, host: 0, session: 0, action: 0, audit: 0, event: 0 },
      audit: null,
      events: { backlog: [], clients: new Set() },
      timers: new Set(),
      screensAudited: new Map(),
      thumbFrames: new Map(),
    };
    this.states.set(id, st);
    return st;
  }

  /** The browser's state from its Cookie header; creates one (plus Set-Cookie) when missing. */
  resolve(cookieHeader: string | undefined): { state: BrowserState; setCookie: string | null } {
    this.prune();
    const id = parseCookies(cookieHeader)[COOKIE];
    const known = id ? this.states.get(id) : undefined;
    if (known) {
      known.lastSeenReal = this.now();
      return { state: known, setCookie: null };
    }
    // An unknown id (pruned, or the dev server restarted) gets a fresh state under the same id.
    const st = this.create(id && /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : undefined);
    return { state: st, setCookie: `${COOKIE}=${st.id}; Path=/; SameSite=Lax` };
  }

  /** Run fn after ms (real time) unless the state is dropped first. */
  schedule(st: BrowserState, ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      st.timers.delete(t);
      fn();
    }, ms);
    st.timers.add(t);
  }

  /** Drop states idle > 2 h (and the oldest ones beyond MAX_STATES). */
  prune(force = false): void {
    const now = this.now();
    if (!force && now - this.lastPrune < 60_000 && this.states.size <= MAX_STATES) return;
    this.lastPrune = now;
    const busy = (s: BrowserState) => s.events.clients.size > 0 || [...s.sessions.values()].some((x) => x.live);
    for (const s of this.states.values()) {
      if (busy(s)) s.lastSeenReal = now;
      else if (now - s.lastSeenReal > STATE_IDLE_MS) this.drop(s);
    }
    if (this.states.size > MAX_STATES) {
      const idle = [...this.states.values()].filter((s) => !busy(s)).sort((a, b) => a.lastSeenReal - b.lastSeenReal);
      for (const s of idle.slice(0, this.states.size - MAX_STATES)) this.drop(s);
    }
  }

  drop(s: BrowserState): void {
    for (const t of s.timers) clearTimeout(t);
    s.timers.clear();
    for (const c of s.events.clients) c.end();
    s.events.clients.clear();
    for (const cs of s.sessions.values()) cs.close?.('revoked');
    this.states.delete(s.id);
  }

  dispose(): void {
    for (const s of [...this.states.values()]) this.drop(s);
  }
}

export function findServer(st: BrowserState, id: string): ServerRec | undefined {
  return st.servers.find((s) => s.id === id);
}

export function roleAtLeast(st: BrowserState, role: Role): boolean {
  return ROLE_RANK[st.user.role] >= ROLE_RANK[role];
}
