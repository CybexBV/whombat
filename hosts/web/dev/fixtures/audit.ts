// Audit log of the fixture server (REMOTE-CONSOLE.md 8, hub audit.go):
// ~240 deterministic seed records over the 14 days before the fixture clock,
// plus whatever this browser does. Newest first, cursor = record sequence.

import type { AuditOutcome, AuditPage, AuditRecord, Role } from '../../src/api/types.ts';
import { hash, rnd } from './gen.ts';
import type { FxRequest } from './http.ts';
import { header } from './http.ts';
import { type AuditEntry, type BrowserState, type FixtureStore, iso, randomHex } from './state.ts';

const MIN = 60_000;
const DAY = 86400_000;

interface SeedUser {
  name: string;
  role: Role;
  ip: string;
  ua: string;
}

const USERS: SeedUser[] = [
  { name: 'admin', role: 'admin', ip: '10.20.0.50', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15' },
  { name: 'john', role: 'operator', ip: '10.20.0.64', ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0' },
];

interface SeedTarget {
  server: string;
  guest: string;
  name: string;
  platform: 'incus' | 'libvirt' | 'pve';
  kind: 'vm' | 'container';
  protocols: string[];
}

const T = (server: string, guest: string, name: string, kind: SeedTarget['kind'], protocols: string[]): SeedTarget => ({
  server, guest, name, platform: guest.split(':')[0] as SeedTarget['platform'], kind, protocols,
});

/** Console targets on the two servers with remote control enabled. */
const TARGETS: SeedTarget[] = [
  T('basalt', 'incus:nixbuild', 'nixbuild', 'vm', ['spice', 'serial']),
  T('basalt', 'incus:ci-runner', 'ci-runner', 'vm', ['spice', 'serial']),
  T('basalt', 'incus:dev-shell', 'dev-shell', 'container', ['shell', 'shell', 'tty']),
  T('basalt', 'incus:git-mirror', 'git-mirror', 'container', ['shell']),
  T('basalt', 'incus:dns', 'dns', 'container', ['shell']),
  T('basalt', 'libvirt:opnsense', 'opnsense', 'vm', ['vnc', 'serial']),
  T('basalt', 'libvirt:win11-test', 'win11-test', 'vm', ['vnc', 'spice']),
  T('basalt', 'libvirt:haos', 'haos', 'vm', ['vnc']),
  T('shale', 'pve:100', 'k3s-node-2', 'vm', ['vnc', 'serial']),
  T('shale', 'pve:101', 'win-build', 'vm', ['vnc', 'spice']),
  T('shale', 'pve:103', 'postgres-prod', 'vm', ['vnc', 'serial']),
  T('shale', 'pve:104', 'gitlab-runner', 'vm', ['serial']),
  T('shale', 'pve:105', 'opnsense-fw', 'vm', ['vnc']),
  T('shale', 'pve:203', 'pihole', 'container', ['shell', 'tty']),
  T('shale', 'pve:200', 'grafana-ct', 'container', ['shell']),
  T('shale', 'pve:202', 'vaultwarden', 'container', ['shell']),
];

/** Servers where remote control is off: requests there are denied. */
const DENIED: { server: string; guest: string; protocol: string }[] = [
  { server: 'obsidian', guest: 'incus:ci-runner-03', protocol: 'shell' },
  { server: 'quartz', guest: 'libvirt:vault-vm', protocol: 'vnc' },
  { server: 'onyx', guest: 'libvirt:haos', protocol: 'vnc' },
];

const ACTIONS: { t: SeedTarget; action: string; state: string }[] = [
  { t: TARGETS[6]!, action: 'reboot', state: 'running' },
  { t: TARGETS[11]!, action: 'reboot', state: 'running' },
  { t: TARGETS[2]!, action: 'restart', state: 'running' },
  { t: TARGETS[15]!, action: 'restart', state: 'running' },
  { t: TARGETS[9]!, action: 'shutdown', state: 'stopped' },
  { t: TARGETS[9]!, action: 'start', state: 'running' },
  { t: TARGETS[13]!, action: 'restart', state: 'running' },
];

function blank(): AuditRecord {
  return {
    id: '', at: '', user: null, role: null, client_ip: null, user_agent: null, server: null, guest: null, platform: null,
    event: '', protocol: null, outcome: 'ok', code: null, duration_s: null, bytes_in: null, bytes_out: null, details: {},
  };
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Deterministic seed records, oldest first, all before `anchor`. */
export function seedAudit(anchor: number): AuditRecord[] {
  const r = rnd(hash('rackoon-audit-seed'));
  const pick = <V>(list: readonly V[]): V => list[Math.floor(r() * list.length)]!;
  const out: { at: number; rec: AuditRecord }[] = [];
  const add = (at: number, u: SeedUser | null, fields: Partial<AuditRecord> & { event: string }) => {
    const rec = { ...blank(), ...fields };
    if (u) Object.assign(rec, { user: u.name, role: u.role, client_ip: u.ip, user_agent: u.ua });
    out.push({ at, rec });
  };
  const admin = USERS[0]!;
  const start = Math.floor((anchor - 14 * DAY) / DAY) * DAY;

  // One-off records: remote control enabled on basalt and shale, an enrollment, a failed sign-in.
  const t0 = start + DAY + 8 * 60 * MIN;
  for (const [i, [server, capability]] of ([['basalt', 'console'], ['basalt', 'power'], ['shale', 'console'], ['shale', 'power']] as const).entries()) {
    add(t0 + i * 25_000, admin, { event: 'remote_control.enabled', server, details: { capability } });
  }
  add(anchor - 12 * DAY - 3 * 60 * MIN, admin, { event: 'enrollment.approved', server: 'flint', details: { enrollment_id: 'en_0f3a9c21d84b7e60', group: 'Edge', hostname: 'flint' } });
  add(anchor - 6 * DAY - 4 * 60 * MIN - 48 * MIN, admin, { event: 'auth.login', outcome: 'denied', code: 'invalid_credentials' });

  let sid = 0;
  let aid = 0;
  for (let day = 0; day <= 14; day++) {
    const dayStart = start + day * DAY;
    const episodes = 4 + Math.floor(r() * 5);
    const times = Array.from({ length: episodes }, () => dayStart + (7 + r() * 13) * 60 * MIN).sort((a, b) => a - b);
    const limit = anchor - 15 * MIN;
    const u0 = pick(USERS);
    if (times[0]! - 2 * MIN < limit) add(times[0]! - 2 * MIN, u0, { event: 'auth.login', details: { method: r() < 0.6 ? 'passkey' : 'password' } });
    for (const t of times) {
      if (t >= limit) break;
      const u = r() < 0.65 ? u0 : pick(USERS);
      const kind = r();
      if (kind < 0.5) {
        // A console session, sometimes switched to another guest through the side list.
        const a = pick(TARGETS);
        const proto = pick(a.protocols);
        const graphical = proto === 'vnc' || proto === 'spice';
        const s1 = `cs_${(0x5a10 + ++sid).toString(16)}`;
        const base = { server: a.server, guest: a.guest, platform: a.platform, protocol: proto };
        add(t, u, { ...base, event: 'console.requested', details: { session_id: s1 } });
        add(t + 1200, u, { ...base, event: 'console.opened', details: graphical ? { session_id: s1, resolution: a.name.startsWith('win') ? '1920x1080' : '1024x768' } : { session_id: s1 } });
        const dur = round1(30 + r() * (graphical ? 1500 : 2400));
        const bytes = (secs: number) => {
          const bi = Math.round(secs * (graphical ? 900 + r() * 2500 : 15 + r() * 120));
          const bo = Math.round(secs * (graphical ? 60_000 + r() * 260_000 : 200 + r() * 2600));
          return { bytes_in: bi, bytes_out: bo };
        };
        const closeWith = (session: string, b: typeof base, at: number, secs: number, code: string) =>
          add(at, u, { ...b, event: 'console.closed', code, duration_s: secs, ...bytes(secs), details: { session_id: session } });
        const siblings = TARGETS.filter((x) => x.server === a.server && x.guest !== a.guest);
        if (r() < 0.22 && siblings.length) {
          const b = pick(siblings);
          const p2 = b.protocols[0]!;
          const s2 = `cs_${(0x5a10 + ++sid).toString(16)}`;
          const base2 = { server: b.server, guest: b.guest, platform: b.platform, protocol: p2 };
          const ts = t + dur * 1000;
          add(ts, u, { ...base2, event: 'console.requested', details: { session_id: s2 } });
          add(ts + 300, u, { ...base2, event: 'console.switched', details: { from_session_id: s1, from_guest: a.guest, session_id: s2 } });
          closeWith(s1, base, ts + 400, dur, 'switched');
          add(ts + 1500, u, { ...base2, event: 'console.opened', details: { session_id: s2 } });
          const d2 = round1(20 + r() * 600);
          closeWith(s2, base2, ts + 1500 + d2 * 1000, d2, 'client_closed');
        } else {
          const code = r() < 0.72 ? 'client_closed' : !graphical && r() < 0.5 ? 'ended' : 'idle_timeout';
          closeWith(s1, base, t + 1200 + dur * 1000, dur, code);
        }
      } else if (kind < 0.66) {
        const a = pick(ACTIONS);
        const action_id = `act_${(0x3c00 + ++aid).toString(16)}`;
        const base = { server: a.t.server, guest: a.t.guest, platform: a.t.platform };
        const reqId = `au_s${hash(`req${aid}`).toString(16).padStart(8, '0')}`;
        add(t, u, { ...base, id: reqId, event: 'action.requested', details: { action: a.action, action_id } });
        const secs = round1(3 + r() * (a.action === 'reboot' ? 50 : 20));
        add(t + secs * 1000, u, { ...base, event: 'action.finished', duration_s: secs, details: { action: a.action, action_id, requested_audit_id: reqId, state: a.state } });
      } else if (kind < 0.8) {
        add(t, u, { event: 'screens.viewed', server: pick(['basalt', 'shale']) });
      } else if (kind < 0.92) {
        add(t, pick(USERS), { event: 'auth.login', details: { method: r() < 0.5 ? 'passkey' : 'password' } });
      } else {
        const d = pick(DENIED);
        add(t, USERS[1]!, { event: 'console.denied', server: d.server, guest: d.guest, platform: d.guest.split(':')[0]!, protocol: d.protocol, outcome: 'denied', code: 'console_disabled' });
      }
    }
  }
  // A start that failed on the agent: an error outcome example.
  add(anchor - 3 * DAY - 2 * 60 * MIN, admin, {
    event: 'action.finished', server: 'basalt', guest: 'libvirt:truenas-lab', platform: 'libvirt', outcome: 'error', code: 'agent_error', duration_s: 4.2,
    details: { action: 'start', action_id: 'act_3bff', requested_audit_id: 'au_s7e1b0c55' },
  });
  add(anchor - 3 * DAY - 2 * 60 * MIN - 4200, admin, { event: 'action.requested', server: 'basalt', guest: 'libvirt:truenas-lab', platform: 'libvirt', id: 'au_s7e1b0c55', details: { action: 'start', action_id: 'act_3bff' } });

  return out
    .filter((x) => x.at < anchor && x.at >= anchor - 14 * DAY)
    .sort((a, b) => a.at - b.at)
    .map(({ at, rec }, i) => ({ ...rec, id: rec.id || `au_${hash(`s${i}`).toString(16).padStart(8, '0')}${hash(`t${i}`).toString(16).padStart(8, '0')}`, at: iso(Math.round(at / 1000) * 1000) }));
}

function entries(st: BrowserState): AuditEntry[] {
  if (!st.audit) {
    st.audit = seedAudit(st.anchor).map((rec, i) => ({ seq: i + 1, rec }));
    st.seq.audit = st.audit.length;
  }
  return st.audit;
}

export interface AuditInput {
  event: string;
  outcome?: AuditOutcome;
  code?: string | null;
  server?: string | null;
  guest?: string | null;
  platform?: string | null;
  protocol?: string | null;
  duration_s?: number | null;
  bytes_in?: number | null;
  bytes_out?: number | null;
  details?: Record<string, string>;
  /** Defaults: the browser's user. */
  user?: string | null;
  role?: string | null;
  client_ip?: string | null;
  user_agent?: string | null;
}

/** Append a record for this browser; returns it (id is `au_<hex>`). */
export function appendAudit(store: FixtureStore, st: BrowserState, input: AuditInput, req?: FxRequest): AuditRecord {
  const list = entries(st);
  const rec: AuditRecord = {
    ...blank(),
    id: `au_${randomHex(8)}`,
    at: iso(store.fxNow()),
    user: input.user !== undefined ? input.user : st.user.name,
    role: input.role !== undefined ? input.role : st.user.role,
    client_ip: input.client_ip !== undefined ? input.client_ip : req ? req.ip : null,
    user_agent: input.user_agent !== undefined ? input.user_agent : req ? (header(req, 'user-agent') ?? null) : null,
    server: input.server ?? null,
    guest: input.guest ?? null,
    platform: input.platform ?? null,
    event: input.event,
    protocol: input.protocol ?? null,
    outcome: input.outcome ?? 'ok',
    code: input.code ?? null,
    duration_s: input.duration_s ?? null,
    bytes_in: input.bytes_in ?? null,
    bytes_out: input.bytes_out ?? null,
    details: input.details ?? {},
  };
  list.push({ seq: ++st.seq.audit, rec });
  return rec;
}

export interface AuditQuery {
  limit?: string | null;
  cursor?: string | null;
  event?: string | null;
  server?: string | null;
}

function matches(e: AuditEntry, q: AuditQuery): boolean {
  if (q.server && e.rec.server !== q.server) return false;
  if (q.event) {
    if (q.event.endsWith('.')) return e.rec.event.startsWith(q.event);
    return e.rec.event === q.event;
  }
  return true;
}

/** GET /audit: newest first; next_cursor is the sequence of the last item. */
export function listAudit(st: BrowserState, q: AuditQuery): AuditPage {
  let limit = Number.parseInt(q.limit ?? '', 10);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 1000) limit = 100;
  const cursor = Number.parseInt(q.cursor ?? '', 10);
  const items: AuditEntry[] = [];
  const list = entries(st);
  for (let i = list.length - 1; i >= 0 && items.length <= limit; i--) {
    const e = list[i]!;
    if (cursor > 0 && e.seq >= cursor) continue;
    if (matches(e, q)) items.push(e);
  }
  const more = items.length > limit;
  const page = items.slice(0, limit);
  return { items: page.map((e) => e.rec), next_cursor: more ? String(page[page.length - 1]!.seq) : null };
}

/** Go encoding/csv quoting. */
function csvField(s: string): string {
  if (s === '') return s;
  if (/[",\r\n]/.test(s) || /^\s/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Defuse spreadsheet formulas in attacker-influenced cells (hub csvSafe). */
function csvSafe(s: string | null): string {
  const v = s ?? '';
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export const AUDIT_CSV_COLUMNS = [
  'id', 'at', 'user', 'role', 'client_ip', 'user_agent', 'server', 'guest', 'platform', 'event',
  'protocol', 'outcome', 'code', 'duration_s', 'bytes_in', 'bytes_out', 'details',
] as const;

/** GET /audit/export body (oldest last, like the API: newest first). */
export function auditCsv(st: BrowserState, q: AuditQuery): string {
  const rows = [AUDIT_CSV_COLUMNS.join(',')];
  const list = entries(st);
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]!;
    if (!matches(e, q)) continue;
    const r = e.rec;
    const det = Object.entries(r.details ?? {}).map(([k, v]) => `${k}=${v}`).join('; ');
    const n = (v: number | null) => (v == null ? '' : String(v));
    rows.push(
      [r.id, r.at, csvSafe(r.user), r.role ?? '', r.client_ip ?? '', csvSafe(r.user_agent), csvSafe(r.server), csvSafe(r.guest), r.platform ?? '',
        r.event, r.protocol ?? '', r.outcome, r.code ?? '', n(r.duration_s), n(r.bytes_in), n(r.bytes_out), csvSafe(det)]
        .map(csvField)
        .join(','),
    );
  }
  return rows.join('\n') + '\n';
}
