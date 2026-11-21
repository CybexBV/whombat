/**
 * The wall of the agent's commands (docs/decisions/one-person.md OP-07, OP-S106): what one connection through the
 * commands' proxy may reach. Pure: IPv4 range arithmetic and one decision per destination.
 *
 * - The agent's own services (OP-19): `127.0.0.1` on ports 20000–20099, where the containers publish.
 * - The public space: all of IPv4 minus the special ranges, this host's own addresses, the operator's deny list
 *   (`WHOMBAT_AGENT_NET_DENY`) and the production servers, on every TCP port but 25.
 * - The person's home networks, and with “Agents may reach your local network” every private range (local-network.md
 *   LN-05), minus this host, the deny list, the production servers and the metadata address; every TCP port but 25.
 * - A production server only through an opening the person approved (one-person.md OP-07, OP-S114), on its port or
 *   every port but 25, and only where the rest of the wall would otherwise reach (public, home networks, local network).
 */
import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * The local network (local-network.md LN-05): every private IPv4 range a LAN may use (RFC 1918 and the shared address
 * space). Never the metadata address inside shared space.
 */
export const PRIVATE_V4: readonly string[] = [
  '10.0.0.0/8',
  '100.64.0.0/10',
  '172.16.0.0/12',
  '192.168.0.0/16',
];
export const METADATA_V4: readonly string[] = ['100.100.100.200/32', '169.254.169.254/32'];

/** Never public (IANA special-purpose registry, plus 0/8 and the whole multicast/reserved top). */
export const SPECIAL_V4: readonly string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

/** The ports the agent's services listen on, on this host's loopback (OP-19, I-5). */
export const SERVICE_PORTS = { first: 20000, last: 20099 } as const;
/** No mail server of the agent's own (AC-10). */
export const SMTP_PORT = 25;

/** An inclusive IPv4 range as numbers. */
export type Range = [number, number];

export function ipv4ToNumber(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}

/** `a.b.c.d/n` or a bare address (= /32) → its range; null for anything else (IPv6 included). */
export function parseV4Cidr(text: string): Range | null {
  const [addr, len] = text.trim().split('/');
  const base = ipv4ToNumber(addr ?? '');
  if (base === null) return null;
  const prefix = len === undefined ? 32 : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32 || (len !== undefined && !/^\d+$/.test(len)))
    return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(base / size) * size;
  return [start, start + size - 1];
}

// Cache parsing, never a policy decision: changed lists and openings are checked on every connection.
// The bound also covers invalid entries and changing host/production addresses over the daemon's lifetime.
const parsedRanges = new Map<string, Range | null>();
const PARSED_RANGE_MAX = 1024;

function contains(n: number, list: readonly string[]): boolean {
  for (const cidr of list) {
    let range = parsedRanges.get(cidr);
    if (range === undefined) {
      range = parseV4Cidr(cidr);
      if (parsedRanges.size >= PARSED_RANGE_MAX) {
        const oldest = parsedRanges.keys().next().value;
        if (oldest !== undefined) parsedRanges.delete(oldest);
      }
      parsedRanges.set(cidr, range);
    }
    if (range !== null && n >= range[0] && n <= range[1]) return true;
  }
  return false;
}

/** Whether `address` lies in any of `list` (CIDRs or addresses). */
export function inAny(address: string, list: readonly string[]): boolean {
  const n = ipv4ToNumber(address);
  return n !== null && contains(n, list);
}

/** True for a public IPv4 address (not in `SPECIAL_V4`). */
export function isPublicV4(address: string): boolean {
  const n = ipv4ToNumber(address);
  return n !== null && !contains(n, SPECIAL_V4);
}

/** An opening a person approved for a production server (AC-11): an address, one port or every port but 25. */
export const Opening = z.object({
  address: z.string().max(60),
  port: z.number().int().min(1).max(65535).nullable(),
});
export type Opening = z.infer<typeof Opening>;

/** The longest an opening may hold without the runner saying so again. */
export const OPENING_TTL_MAX_MS = 5 * 60_000;

/**
 * An opening as the runner sends it: with how long it holds from the moment the daemon takes it. The daemon closes it
 * then by itself, so an opening the runner failed to remove, or stopped renewing, can't stay open.
 */
export const TimedOpening = Opening.extend({
  ttlMs: z.number().int().min(1).max(OPENING_TTL_MAX_MS),
});
export type TimedOpening = z.infer<typeof TimedOpening>;

/**
 * What the runner sets (over `control.sock`): the person's home networks (IPv4 CIDRs), the local network switch, the
 * production servers' addresses (closed), and the openings of the commands running now.
 */
export const NetPolicy = z.object({
  homeNetworks: z.array(z.string().max(60)).max(64),
  lan: z.boolean(),
  production: z.array(z.string().max(60)).max(512),
  open: z.array(TimedOpening).max(256),
});
export type NetPolicy = z.infer<typeof NetPolicy>;

/** What the wall decides on: a policy whose openings are the ones holding now. */
export type WallPolicy = Omit<NetPolicy, 'open'> & { open: Opening[] };

/** Nothing set yet: only the public space and the agent's own services. */
export const EMPTY_POLICY: NetPolicy = { homeNetworks: [], lan: false, production: [], open: [] };

/** What the daemon knows of this host: its own addresses and the operator's deny list. */
export interface HostFacts {
  hostAddresses: readonly string[];
  deny: readonly string[];
}

export type Verdict = { ok: true } | { ok: false; reason: string };

const refuse = (reason: string): Verdict => ({ ok: false, reason });

/** The wall's decision for TCP to `address:port` (IPv4 only: the commands' network has no IPv6 of its own). */
export function decide(address: string, port: number, policy: WallPolicy, host: HostFacts): Verdict {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse(`bad port ${port}`);
  const n = ipv4ToNumber(address);
  if (n === null) return refuse('only IPv4 addresses are reachable');
  // The agent's own services on this host (OP-19).
  if (address === '127.0.0.1' && port >= SERVICE_PORTS.first && port <= SERVICE_PORTS.last)
    return { ok: true };
  if (
    contains(n, host.hostAddresses) ||
    contains(n, host.deny) ||
    contains(n, METADATA_V4) ||
    address.startsWith('127.')
  )
    return refuse(`${address} is never reachable from here`);
  const reachable =
    !contains(n, SPECIAL_V4) || contains(n, policy.homeNetworks) || (policy.lan && contains(n, PRIVATE_V4));
  if (!reachable) return refuse(`${address} is outside what the agent may reach`);
  const opened = policy.open.some(
    (o) => o.address === address && (o.port === null ? port !== SMTP_PORT : o.port === port),
  );
  if (opened) return { ok: true };
  if (contains(n, policy.production))
    return refuse(`${address} is a production server: a person has to approve the command first`);
  if (port === SMTP_PORT) return refuse('port 25 (mail) isn’t reachable');
  return { ok: true };
}
