/**
 * The hosts service itself as Whombat reads it (docs/decisions/backup-file.md BF-13…BF-16; backup-file.md BF-S30…):
 * `GET /hub` mapped (its certificate authority, the agents' address now and before, a restore it applied or refused),
 * the agents' address in the words people read (“10.100.1.158”), and a server's control level from its switches. Pure.
 */
import { HOST_CONTROL_LEVEL_SWITCHES, type HostControlLevel, hostsAgentAddress } from '@whombat/core';
import { obj, str, ts } from './map';

/** `GET /api/v1/hub`, the parts Whombat uses (hosts/docs/WHOMBAT.md §3 and HS-170…). */
export interface HubInfo {
  /** The pin of the hub's certificate authority (what agents enroll with); null when it didn't say. */
  caSha256: string | null;
  /**
   * The agents' address now (`wss://10.100.1.158:8443`): `agent_url`, the address the hub tells its agents (HS-170…;
   * before, the raw flag: “” for auto), else `agents_url` (the address resolved now); null unknown.
   */
  agentUrl: string | null;
  /** The address before it last changed (kept until the next change); null when it never changed. */
  agentUrlPrevious: string | null;
  agentUrlChangedAt: string | null;
  /** When a backup was last applied to it. */
  restoredAt: string | null;
  /** Why the last staged backup wasn't applied (`bad_backup`, `newer_schema`, `failed`; the hub kept what it had). */
  restoreError: string | null;
  /** When that was: a time after a restore was asked for means that restore failed. */
  restoreErrorAt: string | null;
  /**
   * The hub is reconnecting to its servers (network-move.md NM-06): its address changed, most
   * agents dropped at once, or a planned move; their “isn't checking in” alerts wait until `until`. Null: none, or an
   * older hosts service.
   */
  reconnecting: HubReconnecting | null;
  /** Servers it watches. */
  servers: number;
  /** Its database's size, bytes (the estimate's stand-in for its backup's size). */
  databaseBytes: number;
}

/** `GET /hub` `reconnecting`. */
export interface HubReconnecting {
  since: string;
  until: string;
  reason: 'address_changed' | 'many_dropped' | 'move' | 'other';
  /** Servers it covers that aren't back yet. */
  waiting: number;
}

const REASONS = new Set(['address_changed', 'many_dropped', 'move']);

/** `reconnecting` as the hub gives it, or null (absent, null, or not readable). */
export function reconnectingOf(raw: unknown): HubReconnecting | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = obj(raw);
  const since = ts(r.since);
  const until = ts(r.until);
  if (!since || !until) return null;
  const reason = str(r.reason) ?? '';
  return {
    since,
    until,
    reason: (REASONS.has(reason) ? reason : 'other') as HubReconnecting['reason'],
    waiting: typeof r.waiting === 'number' && r.waiting > 0 ? Math.floor(r.waiting) : 0,
  };
}

/**
 * How long before a hold began a server's drop still counts as part of it: the hub's own window for drops that come
 * together (hosts `dropWindow`).
 */
export const HOLD_DROP_WINDOW_MS = 30_000;

/**
 * Whether the hub's hold covers a server now (pure; NM-06): it is reconnecting, and the server isn't connected but was
 * seen since just before the hold began. The hub doesn't list the servers it covers; a server that was offline long
 * before isn't part of this event.
 */
export function holdCovers(
  hold: HubReconnecting | null,
  card: { agentConnected: boolean; lastSeen: string | null },
  now: Date,
): boolean {
  if (!hold || card.agentConnected) return false;
  if (now.getTime() >= Date.parse(hold.until)) return false;
  if (!card.lastSeen) return false;
  return Date.parse(card.lastSeen) >= Date.parse(hold.since) - HOLD_DROP_WINDOW_MS;
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** An agent URL as the hub gives it, or null when it is empty or `auto` (not resolved). */
function agentUrlOf(v: unknown): string | null {
  const s = str(v)?.trim();
  return s && /^wss?:\/\//i.test(s) ? s : null;
}

export function toHubInfo(raw: unknown): HubInfo {
  const h = obj(raw);
  const err = h.restore_error;
  return {
    caSha256: str(h.ca_sha256)?.trim().toLowerCase() || null,
    agentUrl: agentUrlOf(h.agent_url) ?? agentUrlOf(h.agents_url),
    agentUrlPrevious: agentUrlOf(h.agent_url_previous),
    agentUrlChangedAt: ts(h.agent_url_changed_at),
    restoredAt: ts(h.restored_at),
    restoreError:
      typeof err === 'string' && err.trim()
        ? err.trim().slice(0, 300)
        : err && typeof err === 'object'
          ? (str(obj(err).code) ?? 'failed')
          : null,
    restoreErrorAt: err && typeof err === 'object' ? ts(obj(err).at) : null,
    reconnecting: reconnectingOf(h.reconnecting),
    servers: count(h.servers),
    databaseBytes: count(h.database_bytes),
  };
}

/** Host and port of an agent URL (`wss://[fd00::1]:8443` → `fd00::1`, 8443); null when it isn't one. */
export function agentEndpoint(url: string | null | undefined): { host: string; port: number } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return null;
    const port = u.port ? Number(u.port) : u.protocol === 'wss:' ? 443 : 80;
    return { host, port };
  } catch {
    return null;
  }
}

/** Whether two agent URLs name the same place (host case and the default port don't matter). */
export function sameAgentUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = agentEndpoint(a);
  const y = agentEndpoint(b);
  if (!x || !y) return (a ?? '') === (b ?? '');
  return x.host === y.host && x.port === y.port;
}

/** An agent URL as people read it (contracts' `hostsAgentAddress`: the host, with its port when it isn't 8443). */
export function addressText(url: string): string {
  return hostsAgentAddress(url) ?? url;
}

/**
 * Two agent URLs as people read them, side by side (BF-15, BF-16), or null when they are the same place or either is
 * unknown.
 */
export function addressChangeText(
  from: string | null | undefined,
  to: string | null | undefined,
): { from: string; to: string } | null {
  if (!from || !to || sameAgentUrl(from, to)) return null;
  return { from: addressText(from), to: addressText(to) };
}

/** A server's switches as `/agents` and `/servers/{id}/settings` give them (the hub's or the agent's). */
export interface SwitchSet {
  console?: boolean | null;
  power?: boolean | null;
  host_shell?: boolean | null;
  host_power?: boolean | null;
  manage?: boolean | null;
  diagnose?: boolean | null;
}

const LEVELS_HIGH_FIRST: readonly HostControlLevel[] = ['full', 'operate', 'watch'];

/**
 * The control level a server has (SI-06): the highest level whose switches are all on in `hub` and, when given,
 * `agent` too — never more than the server allows now. A server with less than `watch` is `watch`.
 */
export function levelOfSwitches(hub: SwitchSet | null, agent?: SwitchSet | null): HostControlLevel {
  const on = (key: keyof SwitchSet) => (!hub || hub[key] === true) && (!agent || agent[key] === true);
  const keys: Record<keyof (typeof HOST_CONTROL_LEVEL_SWITCHES)['full'], keyof SwitchSet> = {
    console: 'console',
    power: 'power',
    hostShell: 'host_shell',
    hostPower: 'host_power',
    manage: 'manage',
    diagnose: 'diagnose',
  };
  if (!hub && !agent) return 'watch';
  for (const level of LEVELS_HIGH_FIRST) {
    const wanted = HOST_CONTROL_LEVEL_SWITCHES[level];
    const fits = (Object.keys(keys) as (keyof typeof keys)[]).every((k) => !wanted[k] || on(keys[k]));
    if (fits) return level;
  }
  return 'watch';
}
