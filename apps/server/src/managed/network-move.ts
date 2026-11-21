/**
 * Moving a Whombat to Wi-Fi without losing its servers, the pure part (docs/decisions/network-move.md NM-05…NM-10;
 * network-move-server.md NM-S01…): which address the box uses, where the agents are asked to go, how far they got, and
 * what owners are told about the box's network — a cable that stopped, the cable back as the backup, connections that
 * stopped letting Whombat in after its address changed. No I/O: `network-move-service.ts` and `network-watch.ts` read
 * and keep.
 */
import {
  type CableChange,
  type HostNetwork,
  IpAddress,
  networkChangeDone,
  type ServerMove,
} from '@whombat/protocol/session';
import type { ConnectionGlance } from '../home/types';
import { agentEndpoint } from '../hosts/hub';
import { arr, obj, str } from '../hosts/map';

/** How long a move is shown after it began (NM-07, the contract's `ServerMove`). */
export const MOVE_KEEP_MS = 24 * 60 * 60_000;

/** A move with the box: the address before (when known), the one the servers are asked to use, and when it began. */
export interface MoveRecord {
  from?: string;
  to: string;
  since: string;
}

/** An address as it is compared: lower case, no brackets, no zone. */
export function plainIp(ip: string | null | undefined): string | null {
  const s = ip
    ?.trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
  return s ? s : null;
}

/** Whether a host is an IP address the contract's `IpAddress` takes (a name isn't). */
export function isIp(host: string | null | undefined): host is string {
  if (!host) return false;
  if (!IpAddress.safeParse(host).success) return false;
  return host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** The cable the box uses: plugged in with a link and an address, while Wi-Fi only is off. */
export function cableInUse(n: HostNetwork): HostNetwork['wired'][number] | null {
  if (n.wifiOnly) return null;
  return n.wired.find((w) => w.connected && w.address) ?? null;
}

/** Wi-Fi's address while it is on a network, or null. */
export function wifiAddress(n: HostNetwork): string | null {
  return n.wifi?.state === 'connected' && n.wifi.address ? n.wifi.address : null;
}

/**
 * The address the box uses (pure): a cable in use wins (hardware-support.md HD-05), else Wi-Fi's; null with neither.
 * This is the address servers and other services reach it at.
 */
export function boxAddress(n: HostNetwork): string | null {
  return plainIp(cableInUse(n)?.address ?? wifiAddress(n));
}

/** The agents' URL at `address` with the hub's port (`wss://10.100.1.97:8443`, IPv6 in brackets). */
export function agentUrlAt(address: string, port: number): string {
  const host = address.includes(':') ? `[${address}]` : address;
  return `wss://${host}:${port}`;
}

/** The port the hub's agents dial (from `GET /hub`'s agents URL), else the agent's default 8443. */
export function agentPortOf(agentUrl: string | null | undefined): number {
  return agentEndpoint(agentUrl)?.port ?? 8443;
}

/** A server last seen this long before a move began was away already: it isn't waited for. */
export const MOVE_AWAY_MS = 10 * 60_000;

/**
 * A move as `host.network` shows it, with the servers counted (pure; NM-07): found, those connected through `to`; to
 * come, those connected through the old address (any other than `to` when it isn't known) and those that dropped
 * around the move. Not counted: servers away since before it (switched off, never connected), which would keep the
 * line from ever finishing, and servers that reach the box another way (the tailnet, a forward), which don't move.
 */
export function moveProgress(record: MoveRecord, cards: readonly unknown[]): ServerMove {
  const to = plainIp(record.to) ?? record.to;
  const from = plainIp(record.from);
  const since = Date.parse(record.since);
  let found = 0;
  let total = 0;
  for (const raw of arr(cards)) {
    const c = obj(raw);
    const via = plainIp(str(c.via));
    if (c.agent_connected === true) {
      if (via === to) {
        found++;
        total++;
      } else if (via && (!from || via === from)) total++;
      continue;
    }
    const seen = Date.parse(str(c.last_seen) ?? '');
    if (Number.isFinite(seen) && !(seen < since - MOVE_AWAY_MS)) total++;
  }
  return {
    ...(record.from && record.from !== to ? { from: record.from } : {}),
    to,
    since: record.since,
    total,
    found,
  };
}

/**
 * The move to show now (pure): the one Whombat recorded in the last 24 hours, as the box is now (`network`, when
 * known), else the agents' address change the hosts service reports in that time (from and to as plain IPs; none when
 * either is a name). Null: none.
 */
export function currentMove(
  recorded: MoveRecord | null | undefined,
  hub: { agentUrl: string | null; agentUrlPrevious: string | null; agentUrlChangedAt: string | null } | null,
  now: Date,
  network: HostNetwork | null = null,
): MoveRecord | null {
  const fresh = (since: string) => {
    const t = Date.parse(since);
    return Number.isFinite(t) && now.getTime() - t < MOVE_KEEP_MS;
  };
  // A recorded move says what happened better than the hosts service's address changes it caused.
  if (recorded && fresh(recorded.since) && isIp(recorded.to)) return recordedNow(recorded, network);
  if (!hub?.agentUrl || !hub.agentUrlChangedAt || !fresh(hub.agentUrlChangedAt)) return null;
  const to = plainIp(agentEndpoint(hub.agentUrl)?.host);
  if (!isIp(to)) return null;
  const from = plainIp(agentEndpoint(hub.agentUrlPrevious)?.host);
  // The hosts service naming the box's address of the other kind (IPv6 while its IPv4 address wasn't there yet at a
  // start, then IPv4 again) isn't a move: the box had both all along.
  if (isIp(from) && from.includes(':') !== to.includes(':')) return null;
  return { ...(isIp(from) && from !== to ? { from } : {}), to, since: hub.agentUrlChangedAt };
}

/**
 * A recorded move as the box is now (pure): while a cable change runs, or the box's address isn't known, as recorded;
 * after it, to the address the box uses now, and none once that is the address it had before (Wi-Fi only undone, the
 * cable used again, the router giving the Wi-Fi card the old address): nothing moved then.
 */
function recordedNow(recorded: MoveRecord, n: HostNetwork | null): MoveRecord | null {
  if (!n || changing(n.cableChange)) return recorded;
  const at = plainIp(boxAddress(n));
  if (!isIp(at)) return recorded;
  if (recorded.from && at === plainIp(recorded.from)) return null;
  return at === recorded.to ? recorded : { ...recorded, to: at };
}

/* What owners are told (NM-09) ------------------------------------------------------------------------------------ */

/** The cable as the box last used it, and when it stopped while Wi-Fi carried the box. */
export interface CableMemory {
  /** The cable last seen in use. */
  cable?: { interface: string; seenAt: string };
  /** It stopped (lost its link or its address) while Wi-Fi only was off and Wi-Fi carried the box. */
  lost?: { interface: string; at: string };
}

/** A cable change still running (the guard's phases before the end). */
const changing = (c: CableChange | undefined) => !!c && !networkChangeDone(c.phase);

/**
 * The cable after this reading (pure; NM-09): in use again, it is remembered and a loss ends; Wi-Fi only chosen, there
 * is nothing to say (the person switched it off); while a cable change runs, nothing moves. Remembered in use and now not,
 * while Wi-Fi carries the box (it reached Whombat), it stopped working: once, with the time it was first seen.
 */
export function cableAfter(before: CableMemory, n: HostNetwork, now: Date): CableMemory {
  const inUse = cableInUse(n);
  if (inUse) return { cable: { interface: inUse.interface, seenAt: now.toISOString() } };
  if (n.wifiOnly) return {};
  if (changing(n.cableChange)) return before;
  if (before.lost) return before;
  if (before.cable && n.online && wifiAddress(n))
    return { cable: before.cable, lost: { interface: before.cable.interface, at: now.toISOString() } };
  return before;
}

/** The box turned its cable back on by itself (NM-03): the change's id, else null. */
export function backupChangeOf(n: HostNetwork): string | null {
  const c = n.cableChange;
  return c && c.by === 'backup' && c.use === 'cable' && c.phase === 'committed' ? c.id : null;
}

/** How long the backup's item stays when nobody settles it. */
export const BACKUP_KEEP_MS = 3 * 24 * 60 * 60_000;

/* The box's address changed (NM-10) ------------------------------------------------------------------------------- */

/** An address change of the box: from, to, and when it was seen (or when the hosts service saw it). */
export interface AddressChange {
  from: string;
  to: string;
  at: string;
}

/**
 * Whether the box's address changed since `before` (pure): both known and different. An address that went (no network
 * now) isn't a change: the last one known stays the one to compare with.
 */
export function addressChangeOf(
  before: string | null | undefined,
  now: string | null,
  at: Date,
): AddressChange | null {
  const from = plainIp(before);
  const to = plainIp(now);
  if (!from || !to || from === to) return null;
  return { from, to, at: at.toISOString() };
}

/** How a connection did in its last check, for the before and after of an address change. */
export type ConnectionHealth = 'working' | 'refused' | 'unreachable' | 'unknown';

/**
 * A connection's health from its row (pure): signed out or its sign-in refused is `refused`; no answer or an error
 * answer is `unreachable`; checked and answering is `working`; never checked is `unknown`.
 */
export function connectionHealth(row: { status: string; glance: ConnectionGlance | null }): ConnectionHealth {
  if (row.status === 'needs_reauth') return 'refused';
  const g = row.glance;
  if (!g) return 'unknown';
  if (g.lines?.some((l) => l.check === 'conn.signin')) return 'refused';
  if (g.outcome === 'offline' || g.outcome === 'error') return 'unreachable';
  return 'working';
}

/**
 * The connections that worked in the last check before the change and don't in the first one after it (pure): refused
 * or unreachable. One that wasn't checked again says nothing.
 */
export function stoppedAfterChange(
  before: ReadonlySet<string>,
  after: ReadonlyMap<string, ConnectionHealth>,
): string[] {
  return [...before].filter((id) => {
    const h = after.get(id);
    return h === 'refused' || h === 'unreachable';
  });
}
