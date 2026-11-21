/**
 * Which network destinations a managed task may reach (docs/decisions/managed-sandbox.md MSB-06). Pure: an
 * address is classified by value, IPv4 and IPv6 alike, including IPv6 forms that carry an IPv4 address
 * (mapped `::ffff:a.b.c.d`, compatible `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`), so a private or
 * metadata address can't be smuggled through another notation. Names are never trusted: the egress proxy
 * resolves them itself and checks every address it would connect to.
 */
import { isIP } from 'node:net';

export type AddressClass =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'cgnat'
  | 'unique_local'
  | 'metadata'
  | 'multicast'
  | 'reserved'
  | 'documentation'
  | 'invalid';

export interface Classified {
  class: AddressClass;
  /** Normalized textual form (IPv4 dotted, IPv6 lower-case full). */
  address: string;
  /** For IPv6 forms carrying an IPv4 address: the embedded one, classified in its own right. */
  embedded?: string;
}

/** A CIDR block: family, network bytes, prefix length. */
export interface Cidr {
  family: 4 | 6;
  bytes: Uint8Array;
  prefix: number;
  text: string;
}

function v4Bytes(text: string): Uint8Array | null {
  if (isIP(text) !== 4) return null;
  return Uint8Array.from(text.split('.').map(Number));
}

function v6Bytes(text: string): Uint8Array | null {
  let t = text;
  const zone = t.indexOf('%');
  if (zone >= 0) t = t.slice(0, zone);
  if (isIP(t) !== 6) return null;
  // A trailing dotted IPv4 part (`::ffff:10.0.0.1`) becomes two groups.
  const lastColon = t.lastIndexOf(':');
  const tail = t.slice(lastColon + 1);
  if (tail.includes('.')) {
    const b = v4Bytes(tail);
    if (!b) return null;
    t = `${t.slice(0, lastColon + 1)}${((b[0] as number) * 256 + (b[1] as number)).toString(16)}:${((b[2] as number) * 256 + (b[3] as number)).toString(16)}`;
  }
  const [head, rest] = t.includes('::') ? t.split('::') : [t, null];
  const left = head ? head.split(':').filter((g) => g !== '') : [];
  const right = rest ? rest.split(':').filter((g) => g !== '') : [];
  const fill = rest === null ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(fill).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = Number.parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

/** Address bytes (4 or 16), or null for anything that isn't a literal IP address. */
export function addressBytes(text: string): Uint8Array | null {
  const t = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  return v4Bytes(t) ?? v6Bytes(t);
}

function formatV4(b: Uint8Array): string {
  return Array.from(b).join('.');
}

function formatV6(b: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((b[i] as number) << 8) | (b[i + 1] as number)).toString(16));
  return groups.join(':');
}

export function parseCidr(text: string): Cidr | null {
  const [addr, len] = text.trim().split('/');
  if (!addr) return null;
  const bytes = addressBytes(addr);
  if (!bytes) return null;
  const family = bytes.length === 4 ? 4 : 6;
  const max = family === 4 ? 32 : 128;
  const prefix = len === undefined ? max : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { family, bytes, prefix, text: `${family === 4 ? formatV4(bytes) : formatV6(bytes)}/${prefix}` };
}

export function inCidr(bytes: Uint8Array, cidr: Cidr): boolean {
  if ((bytes.length === 4 ? 4 : 6) !== cidr.family) return false;
  let bits = cidr.prefix;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((bytes[i] as number) & mask) !== ((cidr.bytes[i] as number) & mask)) return false;
  }
  return true;
}

const table = (rows: [string, AddressClass][]) =>
  rows.map(([cidr, cls]) => ({ cidr: parseCidr(cidr) as Cidr, cls }));

/**
 * Cloud metadata and host-agent addresses that sit in otherwise public space, checked first. Link-local and
 * ULA metadata addresses (169.254.169.254, fd00:ec2::254) are denied by their ranges anyway.
 */
const METADATA = table([
  ['169.254.169.254/32', 'metadata'],
  ['169.254.170.2/32', 'metadata'], // ECS task metadata
  ['168.63.129.16/32', 'metadata'], // Azure wire server
  ['100.100.100.200/32', 'metadata'], // Alibaba
  ['fd00:ec2::254/128', 'metadata'],
]);

const V4 = table([
  ['0.0.0.0/8', 'unspecified'],
  ['10.0.0.0/8', 'private'],
  ['100.64.0.0/10', 'cgnat'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link_local'],
  ['172.16.0.0/12', 'private'],
  ['192.0.0.0/24', 'reserved'],
  ['192.0.2.0/24', 'documentation'],
  ['192.88.99.0/24', 'reserved'],
  ['192.168.0.0/16', 'private'],
  ['198.18.0.0/15', 'reserved'],
  ['198.51.100.0/24', 'documentation'],
  ['203.0.113.0/24', 'documentation'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
]);

const V6 = table([
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['100::/64', 'reserved'], // discard-only
  ['64:ff9b:1::/48', 'private'], // local-use NAT64
  ['2001::/32', 'reserved'], // Teredo: tunnels to anything
  ['2001:10::/28', 'reserved'],
  ['2001:20::/28', 'reserved'],
  ['2001:db8::/32', 'documentation'],
  ['3fff::/20', 'documentation'],
  ['5f00::/16', 'reserved'], // SRv6 SIDs
  ['fc00::/7', 'unique_local'],
  ['fe80::/10', 'link_local'],
  ['fec0::/10', 'link_local'], // deprecated site-local
  ['ff00::/8', 'multicast'],
]);

/** IPv6 prefixes whose low or middle bits carry an IPv4 address: [prefix, offset of the IPv4 bytes]. */
const EMBEDS_V4: [Cidr, number][] = [
  [parseCidr('::ffff:0:0/96') as Cidr, 12], // IPv4-mapped
  [parseCidr('::/96') as Cidr, 12], // IPv4-compatible (deprecated)
  [parseCidr('64:ff9b::/96') as Cidr, 12], // NAT64 well-known
  [parseCidr('2002::/16') as Cidr, 2], // 6to4
];

export function classifyAddress(text: string): Classified {
  const bytes = addressBytes(text);
  if (!bytes) return { class: 'invalid', address: text };
  if (bytes.length === 4) {
    const address = formatV4(bytes);
    if (address === '255.255.255.255') return { class: 'reserved', address };
    for (const { cidr, cls } of [...METADATA, ...V4]) if (inCidr(bytes, cidr)) return { class: cls, address };
    return { class: 'public', address };
  }
  const address = formatV6(bytes);
  for (const { cidr, cls } of METADATA) if (inCidr(bytes, cidr)) return { class: cls, address };
  // `::` and `::1` are not IPv4-compatible addresses (the table below names them).
  const special = address === '0:0:0:0:0:0:0:0' || address === '0:0:0:0:0:0:0:1';
  for (const [prefix, offset] of special ? [] : EMBEDS_V4) {
    if (!inCidr(bytes, prefix)) continue;
    const v4 = formatV4(bytes.slice(offset, offset + 4));
    const inner = classifyAddress(v4);
    return { class: inner.class, address, embedded: v4 };
  }
  for (const { cidr, cls } of V6) if (inCidr(bytes, cidr)) return { class: cls, address };
  // Outside global unicast (2000::/3) nothing is routable on the Internet.
  if (((bytes[0] as number) & 0xe0) !== 0x20) return { class: 'reserved', address };
  return { class: 'public', address };
}

/** Names that are never looked up for a task, whatever they resolve to. */
const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa|lan|intranet)\.?$/i;
const METADATA_NAMES =
  /^(metadata|metadata\.google\.internal|instance-data|instance-data\.ec2\.internal)\.?$/i;

export function localName(host: string): boolean {
  return LOCAL_NAMES.test(host) || METADATA_NAMES.test(host) || !host.includes('.');
}

/** A host pattern: `example.com` (exactly), `*.example.com` (any subdomain, not the apex). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase().replace(/\.$/, '');
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

export const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i;
