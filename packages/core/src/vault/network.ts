/**
 * Where a Vault entry may connect (docs/decisions/vault.md VT-10…VT-13). Pure: no DNS, no sockets, no `URL` (core runs
 * in React Native too). The server resolves the host and hands the addresses in; everything here decides.
 *
 * - `addressIsPublic` mirrors the server's outbound checks (`lib/outbound.ts`), plus the metadata addresses.
 * - The home network list holds private ranges only (RFC 1918, shared address space, unique local), at most a /16
 *   (IPv4) or /48 (IPv6) wide, never loopback, link-local, metadata, multicast, unspecified, reserved or
 *   documentation space (`vaultNetworkProblem`).
 * - A destination is public (every address public, https only) or on the home network (every address inside a
 *   listed network whose ports include the port; http allowed) — `vaultDestinationProblem`. With the local network
 *   open (`lan`, Whombat local-network.md LN-01) every private address passes on any port, listed or not.
 */
import {
  VAULT_NETWORK_MIN_PREFIX_V4,
  VAULT_NETWORK_MIN_PREFIX_V6,
  VAULT_NETWORK_PORTS_MAX,
  VAULT_URL_MAX,
} from './schemas.js';

/* Addresses ------------------------------------------------------------------------------------- */

export interface IpAddress {
  family: 4 | 6;
  /** 4 or 16 bytes, network order. */
  bytes: number[];
}

/** Strict dotted-quad IPv4 (`192.168.1.10`): four decimal parts 0–255, no leading zeros, nothing else. */
export function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** IPv6 in any RFC 4291 text form (`::`, an embedded IPv4 tail); no zone id. */
export function parseIpv6(text: string): number[] | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(text)) return null;
  const double = text.indexOf('::');
  if (double !== -1 && text.indexOf('::', double + 1) !== -1) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === '') return [];
    const pieces = part.split(':');
    const out: number[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] as string;
      if (i === pieces.length - 1 && piece.includes('.')) {
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        out.push(((v4[0] as number) << 8) | (v4[1] as number), ((v4[2] as number) << 8) | (v4[3] as number));
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(piece)) return null;
        out.push(Number.parseInt(piece, 16));
      }
    }
    return out;
  };
  let groups: number[];
  if (double === -1) {
    const all = groupsOf(text);
    if (all?.length !== 8) return null;
    groups = all;
  } else {
    const head = groupsOf(text.slice(0, double));
    const tail = groupsOf(text.slice(double + 2));
    if (!head || !tail) return null;
    // A dotted tail is only valid at the very end, which `groupsOf` checks per half; the head can't hold one.
    if (text.slice(0, double).includes('.')) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  }
  const bytes: number[] = [];
  for (const g of groups) bytes.push(g >> 8, g & 255);
  return bytes;
}

/** An IP literal, IPv4 or IPv6 (brackets allowed around IPv6), or null. */
export function parseIp(text: string): IpAddress | null {
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const v4 = parseIpv4(bare);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = bare.includes(':') ? parseIpv6(bare) : null;
  return v6 ? { family: 6, bytes: v6 } : null;
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), or null. */
export function ipv4MappedOf(address: IpAddress): number[] | null {
  if (address.family !== 6) return null;
  const b = address.bytes;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return null;
  if (b[10] !== 0xff || b[11] !== 0xff) return null;
  return b.slice(12);
}

export function formatIpv4(bytes: readonly number[]): string {
  return bytes.join('.');
}

/** RFC 5952 text: lowercase, no leading zeros, the longest run of two or more zero groups as `::`. */
export function formatIpv6(bytes: readonly number[]): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLength < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

export function formatIp(address: IpAddress): string {
  return address.family === 4 ? formatIpv4(address.bytes) : formatIpv6(address.bytes);
}

/* Ranges ---------------------------------------------------------------------------------------- */

export interface IpNetwork {
  family: 4 | 6;
  /** The network address (host bits zero). */
  bytes: number[];
  prefix: number;
}

function inNetwork(bytes: readonly number[], net: IpNetwork): boolean {
  if (bytes.length !== net.bytes.length) return false;
  let bits = net.prefix;
  for (let i = 0; i < bytes.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((bytes[i] as number) & mask) !== ((net.bytes[i] as number) & mask)) return false;
    bits -= take;
  }
  return true;
}

/** `a` lies wholly inside `b`. */
function networkWithin(a: IpNetwork, b: IpNetwork): boolean {
  return a.family === b.family && a.prefix >= b.prefix && inNetwork(a.bytes, b);
}

/** `a` and `b` share at least one address. */
function networksOverlap(a: IpNetwork, b: IpNetwork): boolean {
  return networkWithin(a, b) || networkWithin(b, a);
}

/** What an address is, for the destination rules. `private` is the only class the home network list may hold. */
export type AddressClass =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link_local'
  | 'metadata'
  | 'multicast'
  | 'unspecified'
  | 'reserved'
  | 'documentation';

const net = (text: string, prefix: number): IpNetwork => {
  const address = parseIp(text);
  if (!address) throw new Error(`Bad range ${text}`);
  return { family: address.family, bytes: address.bytes, prefix };
};

/** Cloud metadata endpoints (checked first: several sit inside private or link-local space). */
const METADATA: readonly IpNetwork[] = [
  net('169.254.169.254', 32), // AWS, GCP, Azure, OpenStack, DigitalOcean …
  net('169.254.170.2', 32), // AWS ECS task metadata
  net('100.100.100.200', 32), // Alibaba Cloud
  net('168.63.129.16', 32), // Azure wire server
  net('fd00:ec2::254', 128), // AWS over IPv6
];

/** Every non-public range, most specific first. Mirrors `lib/outbound.ts` (BLOCKED). */
const CLASSES: readonly (readonly [IpNetwork, AddressClass])[] = [
  [net('0.0.0.0', 32), 'unspecified'],
  [net('0.0.0.0', 8), 'reserved'], // “this network”
  [net('10.0.0.0', 8), 'private'],
  [net('100.64.0.0', 10), 'private'], // shared address space (carrier-grade NAT, Tailscale)
  [net('127.0.0.0', 8), 'loopback'],
  [net('169.254.0.0', 16), 'link_local'],
  [net('172.16.0.0', 12), 'private'],
  [net('192.0.0.0', 24), 'reserved'], // IETF protocol assignments
  [net('192.0.2.0', 24), 'documentation'],
  [net('192.88.99.0', 24), 'reserved'], // 6to4 relay anycast
  [net('192.168.0.0', 16), 'private'],
  [net('198.18.0.0', 15), 'reserved'], // benchmarking
  [net('198.51.100.0', 24), 'documentation'],
  [net('203.0.113.0', 24), 'documentation'],
  [net('224.0.0.0', 4), 'multicast'],
  [net('240.0.0.0', 4), 'reserved'], // incl. broadcast
  [net('::', 128), 'unspecified'],
  [net('::1', 128), 'loopback'],
  [net('::', 96), 'reserved'], // IPv4-compatible (deprecated)
  [net('64:ff9b::', 96), 'reserved'], // NAT64 reaches IPv4 inside
  [net('64:ff9b:1::', 48), 'reserved'],
  [net('100::', 64), 'reserved'], // discard
  [net('2001:db8::', 32), 'documentation'],
  [net('2001::', 23), 'reserved'], // IETF assignments, incl. Teredo (2001::/32)
  [net('2002::', 16), 'reserved'], // 6to4 embeds any IPv4
  [net('3fff::', 20), 'documentation'],
  [net('fc00::', 7), 'private'], // unique local
  [net('fe80::', 10), 'link_local'],
  [net('fec0::', 10), 'reserved'], // site-local (deprecated)
  [net('ff00::', 8), 'multicast'],
];

/** The class of an address; an IPv4-mapped IPv6 address is classed as its IPv4 address. */
export function classifyAddress(address: IpAddress): AddressClass {
  const mapped = ipv4MappedOf(address);
  if (mapped) return classifyAddress({ family: 4, bytes: mapped });
  const full: IpNetwork = { ...address, prefix: address.family === 4 ? 32 : 128 };
  if (METADATA.some((m) => networkWithin(full, m))) return 'metadata';
  for (const [range, cls] of CLASSES) if (networkWithin(full, range)) return cls;
  return 'public';
}

/**
 * True for an address on the public internet; false for anything private, local, reserved, a metadata endpoint, or
 * not an IP address at all (the server's `isPublicAddress`, VT-11).
 */
export function addressIsPublic(ip: string): boolean {
  const address = parseIp(ip);
  return address !== null && classifyAddress(address) === 'public';
}

/* Networks on the home network list (VT-12) ------------------------------------------------------ */

export interface ParsedCidr extends IpNetwork {
  /** Canonical text: `192.168.1.0/24`, `fd12:3456:789a::/48`. */
  cidr: string;
}

/**
 * A CIDR (`192.168.1.0/24`, `fd12::/48`); a bare address is a /32 or /128. Host bits are cleared, so
 * `192.168.1.7/24` reads as `192.168.1.0/24`. Null when it isn't one.
 */
export function parseCidr(text: string): ParsedCidr | null {
  const trimmed = text.trim();
  const slash = trimmed.indexOf('/');
  const addressText = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const address = parseIp(addressText);
  if (!address) return null;
  const max = address.family === 4 ? 32 : 128;
  let prefix = max;
  if (slash !== -1) {
    const p = trimmed.slice(slash + 1);
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    prefix = Number(p);
    if (prefix > max) return null;
  }
  const bytes = address.bytes.map((b, i) => {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    return b & ((0xff << (8 - bits)) & 0xff);
  });
  const text2 = address.family === 4 ? formatIpv4(bytes) : formatIpv6(bytes);
  return { family: address.family, bytes, prefix, cidr: `${text2}/${prefix}` };
}

/** The canonical form of a CIDR, or null. */
export function canonicalCidr(text: string): string | null {
  return parseCidr(text)?.cidr ?? null;
}

/** The ranges a home network may lie in: RFC 1918, shared address space, unique local. */
const LISTABLE: readonly IpNetwork[] = [
  net('10.0.0.0', 8),
  net('172.16.0.0', 12),
  net('192.168.0.0', 16),
  net('100.64.0.0', 10),
  net('fc00::', 7),
];

export const VAULT_NETWORK_PROBLEMS = [
  'invalid',
  'mapped',
  'too_wide',
  'public',
  'loopback',
  'link_local',
  'metadata',
  'multicast',
  'unspecified',
  'reserved',
  'documentation',
  'ports',
] as const;
export type VaultNetworkProblemCode = (typeof VAULT_NETWORK_PROBLEMS)[number];

export const VAULT_NETWORK_PROBLEM_TEXT: Record<VaultNetworkProblemCode, string> = {
  invalid: 'That isn’t a network. Write it like 192.168.1.0/24.',
  mapped: 'Write an IPv4 network as IPv4, like 192.168.1.0/24.',
  too_wide: 'That network is too wide. Use a /16 or narrower (a /48 or narrower for IPv6).',
  public: 'That’s a public network. Entries reach public addresses over https without being on this list.',
  loopback: 'Loopback addresses can’t be on this list.',
  link_local: 'Link-local addresses can’t be on this list.',
  metadata: 'That network holds a cloud metadata address, so it can’t be on this list.',
  multicast: 'Multicast addresses can’t be on this list.',
  unspecified: 'That address can’t be on this list.',
  reserved: 'Reserved addresses can’t be on this list.',
  documentation: 'Documentation addresses can’t be on this list.',
  ports: `List 1–${VAULT_NETWORK_PORTS_MAX} different ports between 1 and 65535.`,
};

export interface VaultNetworkProblem {
  code: VaultNetworkProblemCode;
  /** The field it is about. */
  field: 'cidr' | 'ports';
  message: string;
}

const networkProblem = (code: VaultNetworkProblemCode): VaultNetworkProblem => ({
  code,
  field: code === 'ports' ? 'ports' : 'cidr',
  message: VAULT_NETWORK_PROBLEM_TEXT[code],
});

/** Why a port list can't be listed, or null: 1–16 different integers 1–65535. */
export function vaultPortsProblem(ports: readonly number[]): VaultNetworkProblem | null {
  const ok =
    ports.length >= 1 &&
    ports.length <= VAULT_NETWORK_PORTS_MAX &&
    ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535) &&
    new Set(ports).size === ports.length;
  return ok ? null : networkProblem('ports');
}

/**
 * Why a network can't be on the home network list, or null (VT-12): it must be a private range (RFC 1918, shared
 * address space or unique local), at most a /16 (IPv4) or /48 (IPv6) wide, holding no metadata address, with 1–16
 * ports. The appliance validates the same again on its privileged side (VT-59).
 */
export function vaultNetworkProblem(cidr: string, ports: readonly number[]): VaultNetworkProblem | null {
  const parsed = parseCidr(cidr);
  if (!parsed) return networkProblem('invalid');
  if (ipv4MappedOf(parsed) && parsed.prefix >= 96) return networkProblem('mapped');
  const minPrefix = parsed.family === 4 ? VAULT_NETWORK_MIN_PREFIX_V4 : VAULT_NETWORK_MIN_PREFIX_V6;
  if (parsed.prefix < minPrefix) return networkProblem('too_wide');
  if (!LISTABLE.some((range) => networkWithin(parsed, range))) {
    const cls = classifyAddress(parsed);
    return networkProblem(cls === 'private' ? 'reserved' : cls);
  }
  if (METADATA.some((m) => networksOverlap(parsed, m))) return networkProblem('metadata');
  return vaultPortsProblem(ports);
}

/**
 * Whether an address lies inside a network (`192.168.1.0/24`); an IPv4-mapped IPv6 address is matched as its IPv4
 * address. False when either doesn't parse or the families differ. The home network list's matching, shared by the
 * Vault and the browser.
 */
export function addressInCidr(address: IpAddress | string, cidr: string): boolean {
  const a = typeof address === 'string' ? parseIp(address) : address;
  const network = parseCidr(cidr);
  if (!a || !network) return false;
  const mapped = ipv4MappedOf(a);
  return inNetwork(mapped ?? a.bytes, network);
}

/**
 * The first listed network holding the address whose ports include the port, else the first holding the address
 * (`port: false`), else null. How both the Vault and the browser decide a home-network destination.
 */
export function listedNetworkFor(
  address: IpAddress | string,
  port: number,
  networks: readonly { cidr: string; ports: readonly number[] }[],
): { cidr: string; port: boolean } | null {
  let inside: string | null = null;
  for (const n of networks) {
    const cidr = canonicalCidr(n.cidr);
    if (!cidr || !addressInCidr(address, cidr)) continue;
    if (n.ports.includes(port)) return { cidr, port: true };
    inside ??= cidr;
  }
  return inside ? { cidr: inside, port: false } : null;
}

/** The network suggested for an unlisted address: its /24 (IPv4) or /64 (IPv6); a mapped address as IPv4. */
export function suggestedNetworkFor(address: IpAddress): string {
  const mapped = ipv4MappedOf(address);
  const a: IpAddress = mapped ? { family: 4, bytes: mapped } : address;
  const cidr = parseCidr(`${formatIp(a)}/${a.family === 4 ? 24 : 64}`);
  return cidr?.cidr ?? formatIp(a);
}

/** Ports sorted ascending without repeats (how a network is stored and handed to the appliance). */
export function sortedPorts(ports: readonly number[]): number[] {
  return [...new Set(ports)].sort((a, b) => a - b);
}

/* URLs ------------------------------------------------------------------------------------------ */

export interface ParsedVaultUrl {
  scheme: 'http' | 'https';
  /** Lowercase host name, dotted IPv4, or IPv6 without brackets. */
  host: string;
  hostKind: 'name' | 'ipv4' | 'ipv6';
  /** The port connected to (explicit, else 443 / 80). */
  port: number;
  /** The port was written in the URL. */
  explicitPort: boolean;
  /** `scheme://host[:port]` as written back (IPv6 in brackets, default ports left out). */
  origin: string;
  /** The URL's path (`/` when empty). */
  path: string;
  /** The path without a trailing slash (`''` for the root): what a request's path is appended to. */
  basePath: string;
}

export const VAULT_URL_PROBLEMS = [
  'invalid',
  'scheme',
  'credentials',
  'query',
  'host',
  'port',
  'path',
] as const;
export type VaultUrlProblemCode = (typeof VAULT_URL_PROBLEMS)[number];

export const VAULT_URL_PROBLEM_TEXT: Record<VaultUrlProblemCode, string> = {
  invalid: 'That isn’t a web address. Write it like https://api.example.com.',
  scheme: 'Use an address that starts with https:// (or http:// on your home network).',
  credentials: 'Leave the username and password out of the address; the Vault keeps them.',
  query: 'Leave ?… and #… out of the address.',
  host: 'That address has no valid host name.',
  port: 'That address has no valid port.',
  path: 'That address has a path Whombat can’t use (no “..”, “//” or encoded slashes).',
};

/** Characters a path may hold (RFC 3986 pchar and `/`), percent-escapes checked separately. */
const PATH_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/;

/** Why a path isn't safe to send as is, or null: no `.`/`..` segments, `//`, backslashes or encoded dots and slashes. */
export function vaultPathProblem(path: string): string | null {
  if (!path.startsWith('/')) return 'The path has to start with /.';
  if (!PATH_CHARS.test(path)) return 'The path holds characters that have to be percent-encoded.';
  if (/%(?![0-9A-Fa-f]{2})/.test(path)) return 'The path holds a broken percent-escape.';
  if (/%(2e|2f|5c|00)/i.test(path)) return 'The path can’t hold encoded dots, slashes or backslashes.';
  if (path.includes('//')) return 'The path can’t hold “//”.';
  for (const segment of path.split('/').slice(1)) {
    if (segment === '.' || segment === '..') return 'The path can’t hold “.” or “..” segments.';
  }
  return null;
}

/** A hostname a resolver would read as an IPv4 number (`1.2.3`, `0x7f.1`, `127.1`) is refused unless strict. */
function endsInNumber(host: string): boolean {
  const last = host.replace(/\.$/, '').split('.').at(-1) ?? '';
  return /^(0x[0-9a-f]*|[0-9]+)$/i.test(last);
}

/** An authority as `parseUrlAuthority` reads it. */
export interface ParsedUrlAuthority {
  /** Lowercase host name, dotted IPv4, or IPv6 without brackets. */
  host: string;
  hostKind: 'name' | 'ipv4' | 'ipv6';
  /** The port connected to (explicit, else 443 / 80). */
  port: number;
  /** The port was written. */
  explicitPort: boolean;
  /** `scheme://host[:port]` (IPv6 in brackets, default ports left out). */
  origin: string;
}

/**
 * Reads a URL's authority (`host[:port]`, IPv6 in brackets) for an http(s) URL, strictly: no credentials, a host that
 * is a dotted-quad IPv4, a bracketed IPv6 or an ASCII name whose last label isn't a number (`127.1`, `0x7f.1` are
 * refused), and a port 1–65535. Shared by the Vault's URLs and the browser's (`parseBrowserUrl`).
 */
export function parseUrlAuthority(
  scheme: 'http' | 'https',
  authority: string,
): { ok: true; authority: ParsedUrlAuthority } | { ok: false; code: 'credentials' | 'host' | 'port' } {
  const fail = (code: 'credentials' | 'host' | 'port') => ({ ok: false, code }) as const;
  if (authority.includes('@')) return fail('credentials');
  let hostText: string;
  let portText: string | null = null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return fail('host');
    hostText = authority.slice(1, close);
    const rest = authority.slice(close + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return fail('host');
      portText = rest.slice(1);
    }
  } else {
    const colon = authority.lastIndexOf(':');
    hostText = colon === -1 ? authority : authority.slice(0, colon);
    if (colon !== -1) portText = authority.slice(colon + 1);
  }
  const defaultPort = scheme === 'https' ? 443 : 80;
  let port = defaultPort;
  const explicitPort = portText !== null && portText !== '';
  if (portText !== null && portText !== '') {
    if (!/^[0-9]{1,5}$/.test(portText)) return fail('port');
    port = Number(portText);
    if (port < 1 || port > 65535) return fail('port');
  }
  let host: string;
  let hostKind: ParsedUrlAuthority['hostKind'];
  if (authority.startsWith('[')) {
    const v6 = parseIpv6(hostText);
    if (!v6) return fail('host');
    host = formatIpv6(v6);
    hostKind = 'ipv6';
  } else {
    const lower = hostText.toLowerCase();
    const v4 = parseIpv4(lower);
    if (v4) {
      host = formatIpv4(v4);
      hostKind = 'ipv4';
    } else {
      if (endsInNumber(lower)) return fail('host');
      const name = lower.replace(/\.$/, '');
      if (name.length === 0 || name.length > 253) return fail('host');
      if (!name.split('.').every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label)))
        return fail('host');
      host = name;
      hostKind = 'name';
    }
  }
  const hostForUrl = hostKind === 'ipv6' ? `[${host}]` : host;
  const origin = `${scheme}://${hostForUrl}${explicitPort && port !== defaultPort ? `:${port}` : ''}`;
  return { ok: true, authority: { host, hostKind, port, explicitPort, origin } };
}

/**
 * Parses an entry's URL (VT-11, VT-12): http or https, a host, an optional port and a path; no credentials, query or
 * fragment. Pure (no WHATWG `URL`).
 */
export function parseVaultUrl(
  raw: string,
): { ok: true; url: ParsedVaultUrl } | { ok: false; code: VaultUrlProblemCode; message: string } {
  const fail = (code: VaultUrlProblemCode) =>
    ({ ok: false, code, message: VAULT_URL_PROBLEM_TEXT[code] }) as const;
  const text = raw.trim();
  if (text.length === 0 || text.length > VAULT_URL_MAX) return fail('invalid');
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(.*)$/.exec(text);
  if (!m) return fail('invalid');
  const scheme = (m[1] as string).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return fail('scheme');
  const authority = m[2] as string;
  if (authority.includes('@')) return fail('credentials');
  if ((m[4] as string) !== '') return fail('query');
  const parsed = parseUrlAuthority(scheme, authority);
  if (!parsed.ok) return fail(parsed.code);
  const path = (m[3] as string) === '' ? '/' : (m[3] as string);
  if (vaultPathProblem(path)) return fail('path');
  return {
    ok: true,
    url: { scheme, ...parsed.authority, path, basePath: path.replace(/\/+$/, '') },
  };
}

/** The address an entry's card shows (“192.168.1.10:8123”, “grafana.example.com”), or the raw text. */
export function vaultEntryAddress(raw: string): string {
  const parsed = parseVaultUrl(raw);
  if (!parsed.ok) return raw;
  const u = parsed.url;
  const host = u.hostKind === 'ipv6' ? `[${u.host}]` : u.host;
  return u.explicitPort ? `${host}:${u.port}` : host;
}

/* Destinations (VT-11…VT-13) -------------------------------------------------------------------- */

export const VAULT_DESTINATION_PROBLEMS = [
  /** The URL itself (`parseVaultUrl`). */
  'bad_url',
  /** The host resolved to nothing. */
  'unresolved',
  /** Plain http to a public address. */
  'http_public',
  /** An address no network may hold (loopback, link-local, metadata, multicast, reserved, documentation). */
  'never',
  /** Public and home-network addresses at once. */
  'mixed',
  /** A home-network address, or its port, isn't on the list. */
  'not_listed',
] as const;
export type VaultDestinationProblemCode = (typeof VAULT_DESTINATION_PROBLEMS)[number];

/** The copy when a call finds its destination refused (a network removed later, VT-13). */
export const VAULT_ADDRESS_NOT_ALLOWED_ANY_MORE = 'This Vault entry’s address isn’t allowed any more.';

export interface VaultDestinationProblem {
  code: VaultDestinationProblemCode;
  message: string;
  /** For `not_listed`: what an admin would add (`192.168.1.0/24`, port 8123). */
  suggestion?: { cidr: string; port: number };
}

export interface VaultDestinationInput {
  /** The entry's URL. */
  url: string;
  /** The addresses the host resolves to (the IP literal itself for an IP host; may be empty then). */
  resolved: readonly string[];
  /** The home network list. */
  networks: readonly { cidr: string; ports: readonly number[] }[];
  /**
   * The local network is open (Whombat local-network.md LN-01: a Whombat appliance whose burrow has “Agents may reach
   * your local network” on, `agentsReachLanOn`): every private address passes on any port, listed or not. Loopback,
   * link-local, metadata and the other never-listable ranges stay closed. Absent: false.
   */
  lan?: boolean;
  /** `save` (the default): the reason in full (VT-13); `call`: “This Vault entry’s address isn’t allowed any more.” */
  at?: 'save' | 'call';
}

/**
 * Why an entry may not connect to its URL, or null (VT-11, VT-12). Public destinations need https and every address
 * public; home-network destinations need every address inside a listed network whose ports include the port, or the
 * local network open (`lan`, LN-01). Checked
 * when an entry is saved or its URL changes, and before every call with the addresses the call will dial.
 */
export function vaultDestinationProblem(input: VaultDestinationInput): VaultDestinationProblem | null {
  const problem = destinationProblem(input);
  if (!problem || (input.at ?? 'save') === 'save') return problem;
  return { code: problem.code, message: VAULT_ADDRESS_NOT_ALLOWED_ANY_MORE };
}

function destinationProblem(input: VaultDestinationInput): VaultDestinationProblem | null {
  const parsed = parseVaultUrl(input.url);
  if (!parsed.ok) return { code: 'bad_url', message: parsed.message };
  const url = parsed.url;
  const texts = input.resolved.length > 0 || url.hostKind === 'name' ? input.resolved : [url.host];
  if (texts.length === 0) return { code: 'unresolved', message: 'That host name doesn’t resolve.' };
  const addresses: IpAddress[] = [];
  for (const t of texts) {
    const a = parseIp(t);
    if (!a) return { code: 'unresolved', message: 'That host name doesn’t resolve.' };
    const mapped = ipv4MappedOf(a);
    addresses.push(mapped ? { family: 4, bytes: mapped } : a);
  }
  const classes = addresses.map(classifyAddress);
  if (classes.every((c) => c === 'public')) {
    return url.scheme === 'https'
      ? null
      : {
          code: 'http_public',
          message: 'Use https for an address on the internet: a secret never crosses it unencrypted.',
        };
  }
  const never = addresses.find((_, i) => classes[i] !== 'public' && classes[i] !== 'private');
  if (never) return { code: 'never', message: `${formatIp(never)} can’t be reached from the Vault.` };
  if (classes.includes('public'))
    return {
      code: 'mixed',
      message: 'That host name resolves to addresses on the internet and on your network at once.',
    };
  if (input.lan) return null;
  for (const address of addresses) {
    const listed = listedNetworkFor(address, url.port, input.networks);
    if (listed?.port) continue;
    const cidr = listed?.cidr ?? suggestedNetworkFor(address);
    return {
      code: 'not_listed',
      message: `That address is on your network. Add ${cidr} port ${url.port} to the home network list in the Vault first.`,
      suggestion: { cidr, port: url.port },
    };
  }
  return null;
}

/**
 * The networks and ports the appliance opens for the runtime server (VT-59): `{"version":1,"networks":[…]}`, sorted,
 * no notes or names. Serialise with `JSON.stringify`.
 */
export function vaultNetworksFile(networks: readonly { cidr: string; ports: readonly number[] }[]): {
  version: 1;
  networks: { cidr: string; ports: number[] }[];
} {
  const rows = networks
    .map((n) => ({ cidr: canonicalCidr(n.cidr), ports: sortedPorts(n.ports) }))
    .filter((n): n is { cidr: string; ports: number[] } => n.cidr !== null)
    .sort((a, b) => (a.cidr < b.cidr ? -1 : a.cidr > b.cidr ? 1 : 0));
  return { version: 1, networks: rows };
}
