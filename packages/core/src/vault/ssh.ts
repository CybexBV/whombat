/**
 * SSH keys in the Vault (docs/decisions/vault.md VT-S01…VT-S12, contracts 0.32.0 CT-199…): an `ssh` entry is one key
 * pair and the servers it opens. Whombat connects; agents never hold the key. These are the pure rules every surface
 * shares: names, hosts and usernames, where a server may be (`vaultSshDestinationProblem`), which servers a key covers
 * (`vaultKeyCoversServer`), public keys and fingerprints, the `authorized_keys` line, what a pasted private key is, the
 * forms of a private key an answer must never hold, and what a use records. Pure: no `Buffer`, no `URL`, no sockets.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { coreTranslator } from '../i18n/catalog.js';
import {
  classifyAddress,
  formatIp,
  type IpAddress,
  ipv4MappedOf,
  listedNetworkFor,
  parseIp,
  parseIpv4,
  parseIpv6,
  suggestedNetworkFor,
} from './network.js';
import {
  VAULT_SSH_ADDRESS_MAX,
  VAULT_SSH_DEFAULT_PORT,
  VAULT_SSH_HOST_MAX,
  VAULT_SSH_PASSPHRASE_MAX,
  VAULT_SSH_PORTS_DEFAULT,
  VAULT_SSH_PRIVATE_KEY_MAX,
  VAULT_SSH_PUBLIC_KEY_ALGORITHMS,
  VAULT_SSH_SERVER_NAME_MAX,
  VAULT_SSH_USERNAME_MAX,
  type VaultCheck,
  type VaultKeyServers,
  type VaultSshKeyType,
  type VaultSshServer,
} from './schemas.js';
import { vaultEntryKey } from './tools.js';

/* Bytes and base64 (no Buffer, no atob: core runs in React Native) ------------------------------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Record<string, number> = Object.fromEntries([...B64].map((c, i) => [c, i]));

/** Standard base64 of bytes; `pad: false` drops the `=` (how fingerprints are written). */
export function bytesToBase64(bytes: Uint8Array, pad = true): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += b === undefined ? (pad ? '=' : '') : B64[(n >> 6) & 63];
    out += c === undefined ? (pad ? '=' : '') : B64[n & 63];
  }
  return out;
}

/** Bytes of standard base64 (padding optional, whitespace ignored), or null when it isn't base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, '').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      ((B64_INDEX[clean[i] as string] as number) << 18) |
      ((B64_INDEX[clean[i + 1] as string] ?? 0) << 12) |
      ((B64_INDEX[clean[i + 2] as string] ?? 0) << 6) |
      (B64_INDEX[clean[i + 3] as string] ?? 0);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out;
}

/** Reads SSH wire strings (`uint32 length || bytes`) and integers. */
class SshReader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  uint32(): number | null {
    if (this.offset + 4 > this.bytes.length) return null;
    const b = this.bytes;
    const o = this.offset;
    this.offset += 4;
    return (
      (((b[o] as number) << 24) |
        ((b[o + 1] as number) << 16) |
        ((b[o + 2] as number) << 8) |
        (b[o + 3] as number)) >>>
      0
    );
  }
  string(): Uint8Array | null {
    const n = this.uint32();
    if (n === null || this.offset + n > this.bytes.length) return null;
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  text(): string | null {
    const s = this.string();
    return s === null ? null : String.fromCharCode(...s);
  }
}

/* Names, usernames, hosts, paths (VT-S04, VT-S08) ------------------------------------------------ */

/** A server's name (VT-S04, CT-319): a name, not a host, so capitals are fine (`PVE-01`); unique per entry ignoring case. */
export const VAULT_SSH_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const VAULT_SSH_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*\$?$/;

const VAULT_SSH_FIELDS = ['name', 'nameTaken', 'username', 'host', 'port', 'address', 'addressUser'] as const;

/**
 * The words for each field a server form can get wrong, in a locale. `address` and `addressUser` are
 * `vault_add_server`'s address (0.112.0, CT-781).
 */
export function vaultSshFieldText(
  locale?: string | null,
): Readonly<Record<(typeof VAULT_SSH_FIELDS)[number], string>> {
  const tr = coreTranslator(locale);
  const max = { name: VAULT_SSH_SERVER_NAME_MAX, username: VAULT_SSH_USERNAME_MAX } as Record<string, number>;
  return Object.fromEntries(
    VAULT_SSH_FIELDS.map((field) => [field, tr.t(`vaultSsh.field.${field}`, { max: max[field] ?? '' })]),
  ) as Record<(typeof VAULT_SSH_FIELDS)[number], string>;
}

/** The words for each field a server form can get wrong. */
export const VAULT_SSH_FIELD_TEXT = vaultSshFieldText('en');

/** Why a server name can't be used, or null: 1–40, `^[A-Za-z0-9][A-Za-z0-9._-]*$` (VT-S04, CT-319). */
export function vaultSshServerNameProblem(name: string, locale?: string | null): string | null {
  return name.length >= 1 &&
    name.length <= VAULT_SSH_SERVER_NAME_MAX &&
    VAULT_SSH_SERVER_NAME_PATTERN.test(name)
    ? null
    : vaultSshFieldText(locale).name;
}

/** Why a username can't be signed in as, or null: 1–32, `^[A-Za-z_][A-Za-z0-9._-]*\$?$` (VT-S04). */
export function vaultSshUsernameProblem(username: string, locale?: string | null): string | null {
  return username.length >= 1 &&
    username.length <= VAULT_SSH_USERNAME_MAX &&
    VAULT_SSH_USERNAME_PATTERN.test(username)
    ? null
    : vaultSshFieldText(locale).username;
}

/** A server's host as stored: lowercase name, dotted IPv4 or IPv6 without brackets. */
export interface ParsedVaultSshHost {
  host: string;
  hostKind: 'name' | 'ipv4' | 'ipv6';
}

/**
 * Reads a server's host (VT-S04): a host name (ASCII labels, the last one not a number, ≤ 253) or an IP literal (IPv6
 * with or without brackets, no zone). Canonical: lowercase, IPv6 in RFC 5952 form. Null when it isn't one.
 */
export function parseVaultSshHost(text: string): ParsedVaultSshHost | null {
  const raw = text.trim();
  if (raw.length === 0 || raw.length > VAULT_SSH_HOST_MAX + 2) return null;
  const bare = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  const v4 = parseIpv4(bare);
  if (v4) return { host: formatIp({ family: 4, bytes: v4 }), hostKind: 'ipv4' };
  if (bare.includes(':')) {
    const v6 = parseIpv6(bare);
    return v6 ? { host: formatIp({ family: 6, bytes: v6 }), hostKind: 'ipv6' } : null;
  }
  if (bare !== raw) return null;
  const name = raw.toLowerCase().replace(/\.$/, '');
  if (name.length === 0 || name.length > VAULT_SSH_HOST_MAX) return null;
  const last = name.split('.').at(-1) ?? '';
  if (/^(0x[0-9a-f]*|[0-9]+)$/i.test(last)) return null;
  if (!name.split('.').every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) return null;
  return { host: name, hostKind: 'name' };
}

/** A server's address as `vault_add_server` takes it (0.112.0, CT-781): its host, as stored, and the port. */
export interface ParsedVaultSshAddress extends ParsedVaultSshHost {
  /** The port given, else `VAULT_SSH_DEFAULT_PORT` (22). */
  port: number;
}

/**
 * Reads `vault_add_server`'s address (Whombat vault-self-serve.md VS-09): a host name or IP literal (`parseVaultSshHost`)
 * with an optional `:port` — `web1.example.com`, `192.168.1.10:2222`, `[2001:db8::7]:2222`, or a bare IPv6 address
 * (no port: its colons are its own). The port defaults to 22. Null for anything else: a user (`root@…`), a scheme, a
 * path, a port outside 1…65535. Where the server may be is `vaultSshDestinationProblem`'s, as for a person's server.
 */
export function parseVaultSshAddress(text: string): ParsedVaultSshAddress | null {
  const raw = text.trim();
  if (raw.length === 0 || raw.length > VAULT_SSH_ADDRESS_MAX) return null;
  let hostText = raw;
  let portText: string | null = null;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return null;
    hostText = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      portText = rest.slice(1);
    }
  } else if (raw.indexOf(':') >= 0 && raw.indexOf(':') === raw.lastIndexOf(':')) {
    const colon = raw.indexOf(':');
    hostText = raw.slice(0, colon);
    portText = raw.slice(colon + 1);
  }
  const host = parseVaultSshHost(hostText);
  if (!host) return null;
  if (portText === null) return { ...host, port: VAULT_SSH_DEFAULT_PORT };
  if (!/^[0-9]{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  return port >= 1 && port <= 65535 ? { ...host, port } : null;
}

/** Why `vault_add_server` can't take an address, or null (`parseVaultSshAddress`): a user in it says where it goes. */
export function vaultSshAddressProblem(text: string, locale?: string | null): string | null {
  if (parseVaultSshAddress(text)) return null;
  const words = vaultSshFieldText(locale);
  return text.includes('@') ? words.addressUser : words.address;
}

// Validation errors from the schemas reach the server and the agent's tools, so they stay English.
const refineWith = (problem: (value: string) => string | null) => (value: string, ctx: z.RefinementCtx) => {
  const message = problem(value);
  if (message) ctx.addIssue({ code: 'custom', message });
};

/** A server's name as typed in “Add server” (`web-1`, `nas`, `PVE-01`). */
export const VaultSshServerName = z.string().trim().superRefine(refineWith(vaultSshServerNameProblem));
/** The user a server is signed in to as (`deploy`). */
export const VaultSshUsername = z.string().trim().superRefine(refineWith(vaultSshUsernameProblem));
/** A server's host (`web1.example.com`, `192.168.1.10`, `2001:db8::7`); the server stores `parseVaultSshHost`'s form. */
export const VaultSshHost = z
  .string()
  .trim()
  .superRefine(refineWith((h) => (parseVaultSshHost(h) ? null : VAULT_SSH_FIELD_TEXT.host)));
/** `vault_add_server`'s address (0.112.0, CT-781): `web1.example.com`, `192.168.1.10:2222` (`parseVaultSshAddress`). */
export const VaultSshAddress = z
  .string()
  .trim()
  .min(1)
  .max(VAULT_SSH_ADDRESS_MAX)
  .superRefine(refineWith(vaultSshAddressProblem));
/* Where a server may be (VT-S06) ----------------------------------------------------------------- */

/**
 * The ports public servers may be reached on, from `WHOMBAT_VAULT_SSH_PORTS` (`22`, `22,2222`; spaces allowed): 1–16
 * different ports 1–65535, sorted. Null for anything else; an unset or empty value means `VAULT_SSH_PORTS_DEFAULT`.
 */
export function parseVaultSshPorts(text: string | null | undefined): number[] | null {
  if (text === null || text === undefined || text.trim() === '') return [...VAULT_SSH_PORTS_DEFAULT];
  const parts = text.split(',').map((p) => p.trim());
  if (parts.length > 16 || !parts.every((p) => /^[1-9][0-9]{0,4}$/.test(p))) return null;
  const ports = parts.map(Number);
  if (ports.some((p) => p > 65535) || new Set(ports).size !== ports.length) return null;
  return ports.sort((a, b) => a - b);
}

export const VAULT_SSH_DESTINATION_PROBLEMS = [
  /** The host isn't a host name or IP literal (`parseVaultSshHost`). */
  'bad_host',
  /** The host resolved to nothing. */
  'unresolved',
  /** A public address on a port that isn't one of the SSH ports. */
  'port_not_allowed',
  /** An address no network may hold (loopback, link-local, metadata, multicast, reserved, documentation). */
  'never',
  /** Public and home-network addresses at once. */
  'mixed',
  /** A home-network address, or its port, isn't on the list. */
  'not_listed',
] as const;
export type VaultSshDestinationProblemCode = (typeof VAULT_SSH_DESTINATION_PROBLEMS)[number];

/** What a connection says when the server's address is refused at call time (VT-S06). */
export const VAULT_SSH_ADDRESS_NOT_ALLOWED_ANY_MORE = 'This server’s address isn’t allowed any more.';

export interface VaultSshDestinationProblem {
  code: VaultSshDestinationProblemCode;
  message: string;
  /** For `not_listed`: what an admin would add (`192.168.1.0/24`, port 22). */
  suggestion?: { cidr: string; port: number };
}

export interface VaultSshDestinationInput {
  /** The server's host (a name or an IP literal). */
  host: string;
  port: number;
  /** The addresses the host resolves to (the IP literal itself for an IP host; may be empty then). */
  resolved: readonly string[];
  /** The home network list. */
  networks: readonly { cidr: string; ports: readonly number[] }[];
  /** The local network is open (Whombat local-network.md LN-01): every private address passes on any port. */
  lan?: boolean;
  /** The ports public servers may be reached on (`WHOMBAT_VAULT_SSH_PORTS`); default `[22]`. */
  sshPorts?: readonly number[];
  /** `save` (the default): the reason in full; `call`: “This server’s address isn’t allowed any more.” */
  at?: 'save' | 'call';
}

/** “port 22”, “ports 22 and 2222”, “ports 22, 2222 and 8022”. */
function portList(ports: readonly number[]): string {
  const sorted = [...ports].sort((a, b) => a - b).map(String);
  if (sorted.length <= 1) return `port ${sorted[0] ?? '22'}`;
  return `ports ${sorted.slice(0, -1).join(', ')} and ${sorted.at(-1)}`;
}

/**
 * Why Whombat may not connect to a server, or null (VT-S06, VT-11…VT-13 adapted): public addresses only on the SSH
 * ports; non-public addresses only inside a listed home network on a listed port, or any of them with the local network
 * open (`lan`, LN-01); never loopback, link-local, metadata
 * and the other never-listable ranges; every resolved address must pass. Checked when a server is added or its host or
 * port changes, and before every connection with the addresses it will dial.
 */
export function vaultSshDestinationProblem(
  input: VaultSshDestinationInput,
): VaultSshDestinationProblem | null {
  const problem = sshDestinationProblem(input);
  if (!problem || (input.at ?? 'save') === 'save') return problem;
  return { code: problem.code, message: VAULT_SSH_ADDRESS_NOT_ALLOWED_ANY_MORE };
}

function sshDestinationProblem(input: VaultSshDestinationInput): VaultSshDestinationProblem | null {
  const host = parseVaultSshHost(input.host);
  if (!host) return { code: 'bad_host', message: VAULT_SSH_FIELD_TEXT.host };
  const texts = input.resolved.length > 0 || host.hostKind === 'name' ? input.resolved : [host.host];
  const unresolved = { code: 'unresolved', message: 'That host name doesn’t resolve.' } as const;
  if (texts.length === 0) return unresolved;
  const addresses: IpAddress[] = [];
  for (const t of texts) {
    const a = parseIp(t);
    if (!a) return unresolved;
    const mapped = ipv4MappedOf(a);
    addresses.push(mapped ? { family: 4, bytes: mapped } : a);
  }
  const classes = addresses.map(classifyAddress);
  if (classes.every((c) => c === 'public')) {
    const ports = input.sshPorts ?? VAULT_SSH_PORTS_DEFAULT;
    return ports.includes(input.port)
      ? null
      : {
          code: 'port_not_allowed',
          message: `Whombat reaches servers on the internet on ${portList(ports)} only.`,
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
    const listed = listedNetworkFor(address, input.port, input.networks);
    if (listed?.port) continue;
    const cidr = listed?.cidr ?? suggestedNetworkFor(address);
    return {
      code: 'not_listed',
      message: `That address is on your network. Add ${cidr} port ${input.port} to the home network list in the Vault first.`,
      suggestion: { cidr, port: input.port },
    };
  }
  return null;
}

/* Which servers a key covers (VT-S07) ------------------------------------------------------------ */

/** Whether a key reaches a server: `servers` null is All servers (later ones too), else only those listed. */
export function vaultKeyCoversServer(
  key: { servers?: VaultKeyServers | undefined },
  serverId: string,
): boolean {
  return key.servers === null || key.servers === undefined || key.servers.includes(serverId);
}

/**
 * The servers a key covers, in the entry's order: every server for All servers, else the listed ones that still exist
 * (a removed server simply drops out).
 */
export function vaultKeyCoveredServers<S extends { id: string }>(
  key: { servers?: VaultKeyServers | undefined },
  servers: readonly S[],
): S[] {
  return servers.filter((s) => vaultKeyCoversServer(key, s.id));
}

/* Public keys and fingerprints (VT-S02, VT-S13) -------------------------------------------------- */

export interface ParsedVaultSshPublicKey {
  /** `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`, … */
  algorithm: string;
  keyType: VaultSshKeyType;
  /** The key blob (wire format). */
  blob: Uint8Array;
  /** `<algorithm> <base64>`, no comment: how the entry stores it. */
  line: string;
}

/**
 * Reads an OpenSSH public key line (`ssh-ed25519 AAAA… comment`): the algorithm must be one an entry holds and match
 * the blob's own name. The comment is dropped. Null for anything else (certificates, FIDO keys, DSA).
 */
export function parseVaultSshPublicKey(text: string): ParsedVaultSshPublicKey | null {
  const [algorithm, data] = text.trim().split(/\s+/);
  if (!algorithm || !data) return null;
  const keyType = (Object.keys(VAULT_SSH_PUBLIC_KEY_ALGORITHMS) as VaultSshKeyType[]).find((t) =>
    VAULT_SSH_PUBLIC_KEY_ALGORITHMS[t].includes(algorithm),
  );
  if (!keyType) return null;
  const blob = base64ToBytes(data);
  if (!blob) return null;
  const inner = new SshReader(blob).text();
  if (inner !== algorithm) return null;
  return { algorithm, keyType, blob, line: `${algorithm} ${bytesToBase64(blob)}` };
}

/** `SHA256:` + unpadded base64 of the sha256 of a key blob, as `ssh-keygen -l` writes it. */
export function vaultSshFingerprintOfBlob(blob: Uint8Array): string {
  return `SHA256:${bytesToBase64(sha256(blob), false)}`;
}

/** The fingerprint of an OpenSSH public key line, or null when it isn't one an entry holds. */
export function vaultSshFingerprint(publicKey: string): string | null {
  const parsed = parseVaultSshPublicKey(publicKey);
  return parsed ? vaultSshFingerprintOfBlob(parsed.blob) : null;
}

/** The comment every `authorized_keys` line of an entry ends with: `whombat-<entry key>`. */
export function vaultSshKeyComment(entryId: string): string {
  return `whombat-${vaultEntryKey(entryId)}`;
}

/**
 * The line the owner adds to `~/.ssh/authorized_keys` on every server (VT-S13): `restrict <publicKey> whombat-<entry
 * key>`. `restrict` turns off port, agent and X11 forwarding and PTYs for this key, which Whombat never uses (VT-S15).
 */
export function vaultSshAuthorizedKeysLine(publicKey: string, entryId: string): string {
  const parsed = parseVaultSshPublicKey(publicKey);
  const key = parsed ? parsed.line : publicKey.trim().split(/\s+/).slice(0, 2).join(' ');
  return `restrict ${key} ${vaultSshKeyComment(entryId)}`;
}

/** The type a host key algorithm reads as on the trust card: `ED25519`, `ECDSA`, `RSA`, `DSA`, else as given. */
export function vaultSshHostKeyLabel(algorithm: string): string {
  if (algorithm === 'ssh-ed25519') return 'ED25519';
  if (algorithm.startsWith('ecdsa-sha2-')) return 'ECDSA';
  if (algorithm === 'ssh-rsa' || algorithm.startsWith('rsa-sha2-')) return 'RSA';
  if (algorithm === 'ssh-dss') return 'DSA';
  return algorithm.toUpperCase();
}

/** The host key file to compare with on the server (`/etc/ssh/ssh_host_ed25519_key.pub`). */
export function vaultSshHostKeyFile(algorithm: string): string {
  const label = vaultSshHostKeyLabel(algorithm);
  const name = ({ ED25519: 'ed25519', ECDSA: 'ecdsa', RSA: 'rsa', DSA: 'dsa' } as Record<string, string>)[
    label
  ];
  return `/etc/ssh/ssh_host_${name ?? 'ed25519'}_key.pub`;
}

/* Private keys as pasted (VT-S03) ---------------------------------------------------------------- */

/** The private key formats an import takes. */
export const VAULT_SSH_PRIVATE_KEY_FORMATS = ['openssh', 'rsa', 'ec', 'pkcs8', 'pkcs8_encrypted'] as const;
export type VaultSshPrivateKeyFormat = (typeof VAULT_SSH_PRIVATE_KEY_FORMATS)[number];

const PEM_LABELS: Record<string, VaultSshPrivateKeyFormat> = {
  'OPENSSH PRIVATE KEY': 'openssh',
  'RSA PRIVATE KEY': 'rsa',
  'EC PRIVATE KEY': 'ec',
  'PRIVATE KEY': 'pkcs8',
  'ENCRYPTED PRIVATE KEY': 'pkcs8_encrypted',
};

/** Why a pasted key can't be imported. The server adds what only parsing tells (`passphrase_needed` and the rest). */
export const VAULT_SSH_KEY_PROBLEMS = [
  'empty',
  'too_long',
  'not_a_key',
  'public_key',
  'putty',
  'certificate',
  'several_keys',
  'fido',
  'unsupported_type',
  'rsa_too_short',
  'passphrase_needed',
  'wrong_passphrase',
  'unreadable',
] as const;
export type VaultSshKeyProblemCode = (typeof VAULT_SSH_KEY_PROBLEMS)[number];

export const VAULT_SSH_KEY_PROBLEM_TEXT: Record<VaultSshKeyProblemCode, string> =
  vaultSshKeyProblemText('en');

/** `VAULT_SSH_KEY_PROBLEM_TEXT` in a locale. */
export function vaultSshKeyProblemText(locale?: string | null): Record<VaultSshKeyProblemCode, string> {
  const tr = coreTranslator(locale);
  return Object.fromEntries(
    VAULT_SSH_KEY_PROBLEMS.map((code) => [code, tr.t(`vaultSsh.keyProblem.${code}`)]),
  ) as Record<VaultSshKeyProblemCode, string>;
}

export interface VaultSshPrivateKeyFacts {
  format: VaultSshPrivateKeyFormat;
  /** The key is encrypted (needs a passphrase); null when only parsing can tell (PKCS#1 and SEC1 with headers). */
  encrypted: boolean;
  /** For an OpenSSH key: the public half's algorithm (readable even when encrypted). */
  algorithm: string | null;
  /** For an OpenSSH key: the public key line (no comment), readable even when encrypted; null for PEM keys. */
  publicKey: string | null;
}

/**
 * What a pasted private key looks like before anything parses it (VT-S03): its format, whether it is encrypted, and
 * for OpenSSH keys the algorithm; or the problem, in a sentence. The server parses for real (and refuses what only
 * parsing finds); the web uses this to ask for the passphrase and to refuse early.
 */
export function inspectVaultSshPrivateKey(
  text: string,
  locale?: string | null,
): { ok: true; key: VaultSshPrivateKeyFacts } | { ok: false; code: VaultSshKeyProblemCode; message: string } {
  const fail = (code: VaultSshKeyProblemCode) =>
    ({ ok: false, code, message: coreTranslator(locale).t(`vaultSsh.keyProblem.${code}`) }) as const;
  const trimmed = text.trim();
  if (trimmed === '') return fail('empty');
  if (text.length > VAULT_SSH_PRIVATE_KEY_MAX) return fail('too_long');
  if (trimmed.startsWith('PuTTY-User-Key-File-')) return fail('putty');
  if (/^(ssh|ecdsa|sk)-\S*-cert-v01@openssh\.com\s/.test(trimmed)) return fail('certificate');
  if (/^(sk-)?(ssh-|ecdsa-sha2-)\S+\s+AAAA/.test(trimmed) || trimmed.startsWith('---- BEGIN SSH2 PUBLIC KEY'))
    return fail('public_key');
  const begins = [...trimmed.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----/g)];
  if (begins.length === 0) return fail('not_a_key');
  if (begins.length > 1) return fail('several_keys');
  const begin = begins[0] as RegExpMatchArray;
  const label = begin[1] as string;
  if (label.includes('PUBLIC KEY')) return fail('public_key');
  const format = PEM_LABELS[label];
  if (!format) return fail('not_a_key');
  const end = trimmed.indexOf(`-----END ${label}-----`);
  if (end === -1) return fail('not_a_key');
  const inner = trimmed.slice((begin.index ?? 0) + begin[0].length, end);
  const headers = /^Proc-Type:\s*4,ENCRYPTED/m.test(inner);
  const body = inner
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.includes(':'))
    .join('');
  const bytes = base64ToBytes(body);
  if (!bytes || bytes.length === 0) return fail('not_a_key');
  if (format !== 'openssh')
    return {
      ok: true,
      key: { format, encrypted: format === 'pkcs8_encrypted' || headers, algorithm: null, publicKey: null },
    };
  const openssh = readOpenSshKey(bytes);
  if (!openssh) return fail('not_a_key');
  if (openssh.count > 1) return fail('several_keys');
  if (openssh.algorithm.startsWith('sk-')) return fail('fido');
  if (openssh.algorithm.includes('-cert-')) return fail('certificate');
  if (!Object.values(VAULT_SSH_PUBLIC_KEY_ALGORITHMS).flat().includes(openssh.algorithm))
    return fail('unsupported_type');
  return {
    ok: true,
    key: {
      format,
      encrypted: openssh.cipher !== 'none',
      algorithm: openssh.algorithm,
      publicKey: `${openssh.algorithm} ${bytesToBase64(openssh.publicBlob)}`,
    },
  };
}

/** `openssh-key-v1`'s header: cipher, the first public key's algorithm, and where the private section starts. */
function readOpenSshKey(bytes: Uint8Array): {
  cipher: string;
  algorithm: string;
  publicBlob: Uint8Array;
  count: number;
  privateOffset: number;
} | null {
  const magic = 'openssh-key-v1\0';
  if (bytes.length < magic.length || String.fromCharCode(...bytes.subarray(0, magic.length)) !== magic)
    return null;
  const r = new SshReader(bytes);
  r.offset = magic.length;
  const cipher = r.text();
  const kdf = r.string();
  const kdfOptions = r.string();
  const count = r.uint32();
  if (cipher === null || kdf === null || kdfOptions === null || count === null || count < 1) return null;
  let algorithm: string | null = null;
  let publicBlob: Uint8Array | null = null;
  for (let i = 0; i < count && i < 16; i++) {
    const pub = r.string();
    if (pub === null) return null;
    if (i === 0) {
      publicBlob = pub;
      algorithm = new SshReader(pub).text();
    }
  }
  // The private section's length word; what follows (check integers, private keys, comments) is secret.
  if (count > 16 || r.uint32() === null || algorithm === null || publicBlob === null) return null;
  return { cipher, algorithm, publicBlob, count, privateOffset: r.offset };
}

/** A key as the import form sends it, after `inspectVaultSshPrivateKey`. */
export const VaultSshPrivateKeyText = z
  .string()
  .max(VAULT_SSH_PRIVATE_KEY_MAX)
  .superRefine((text, ctx) => {
    const inspected = inspectVaultSshPrivateKey(text);
    if (!inspected.ok) ctx.addIssue({ code: 'custom', message: inspected.message });
  });

/** “Passphrase (if it has one)”: used once at import, never stored (VT-S03). */
export const VaultSshPassphrase = z.string().min(1).max(VAULT_SSH_PASSPHRASE_MAX);

/* Forms a private key must never reach an agent in (VT-S10) -------------------------------------- */

/** The shortest base64 line of a key text that counts as a form of it. */
export const VAULT_SSH_KEY_LINE_MIN = 24;
/** The shortest passphrase looked for in answers: shorter ones would match ordinary output. */
export const VAULT_SSH_PASSPHRASE_FORM_MIN = 8;

/**
 * The base64 lines of a key text (PEM or OpenSSH) that carry private material, at least 24 characters long. For an
 * OpenSSH key, lines wholly inside the header and public key (the same in every key of its type, or public) are left
 * out, so a server printing another key, or this key's public half, isn't taken for an echo.
 */
export function vaultSshPrivateKeyLines(text: string): string[] {
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!match) return [];
  const lines = (match[2] as string)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.includes(':'));
  let privateFrom = 0;
  if (match[1] === 'OPENSSH PRIVATE KEY') {
    const bytes = base64ToBytes(lines.join(''));
    const header = bytes ? readOpenSshKey(bytes) : null;
    if (header) privateFrom = header.privateOffset;
  }
  const out: string[] = [];
  let chars = 0;
  for (const line of lines) {
    const endByte = Math.floor(((chars + line.length) * 3) / 4);
    chars += line.length;
    if (line.length >= VAULT_SSH_KEY_LINE_MIN && endByte > privateFrom) out.push(line);
  }
  return out;
}

export interface VaultSshKeyFormsInput {
  /** The key as stored (OpenSSH), and as it was pasted when the server still has it. */
  privateKeys: readonly string[];
  /** The raw private key bytes in base64 (the ed25519 seed, RSA `d`, `p`, `q`, the EC scalar), from the parser. */
  raw?: readonly string[];
  /** A passphrase seen at import in this process (looked for when at least 8 characters). */
  passphrase?: string | null;
}

/**
 * Every form of a private key an answer must never hold (VT-S10): the whole text (LF and CRLF, and JSON-escaped), the
 * base64 body joined, each private-bearing base64 line of at least 24 characters, the raw key bytes in base64 (padded
 * and not), and the passphrase. Longest first. An answer holding any of them is withheld whole and the key taken back
 * (the VT-D22 path).
 */
export function vaultSshKeyForms(input: VaultSshKeyFormsInput): string[] {
  const forms = new Set<string>();
  const add = (s: string | null | undefined, min = VAULT_SSH_KEY_LINE_MIN) => {
    if (s && s.length >= min) forms.add(s);
  };
  for (const key of input.privateKeys) {
    const lf = key.replace(/\r\n/g, '\n').trim();
    add(lf);
    add(lf.replace(/\n/g, '\r\n'));
    add(JSON.stringify(lf).slice(1, -1));
    const lines = vaultSshPrivateKeyLines(lf);
    add(lines.join(''));
    for (const line of lines) add(line);
  }
  for (const raw of input.raw ?? []) {
    add(raw, 16);
    add(raw.replace(/=+$/, ''), 16);
  }
  add(input.passphrase, VAULT_SSH_PASSPHRASE_FORM_MIN);
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Whether a text holds any of the forms (`vaultSshKeyForms`). */
export function holdsVaultSshKey(text: string, forms: readonly string[]): boolean {
  return forms.some((f) => text.includes(f));
}

/* Servers ---------------------------------------------------------------------------------------- */

/** `deploy@web1.example.com:22`, `backup@[2001:db8::7]:2222`. */
export function vaultSshServerTarget(server: Pick<VaultSshServer, 'username' | 'host' | 'port'>): string {
  const host = server.host.includes(':') ? `[${server.host}]` : server.host;
  return `${server.username}@${host}:${server.port}`;
}

/**
 * Whether agents may connect to a server now (VT-S05): its host key is trusted and the last check saw no other one.
 * The destination rule and the key's coverage are checked separately.
 */
export function vaultSshServerReady(server: Pick<VaultSshServer, 'hostKey' | 'seenHostKey'>): boolean {
  return server.hostKey !== null && server.seenHostKey === null;
}

/**
 * An `ssh` entry's own check, from its servers (the card's status dot and line): with one server, that server's check;
 * with several, `failing` when any fails (“1 of 3 servers failing”), `reached` when one or more signed in and none fails
 * (“Signed in to all 3 servers”, “Signed in to 2 of 3 servers”), else `unchecked`; with none, `unchecked` “No servers
 * yet”. `checkedAt` is the latest check.
 */
export function vaultSshEntryCheck(servers: readonly Pick<VaultSshServer, 'check'>[]): VaultCheck {
  const n = servers.length;
  if (n === 0)
    return { status: 'unchecked', summary: VAULT_SSH_NO_SERVERS, checkedAt: null, toolCount: null };
  const latest =
    servers
      .map((s) => s.check.checkedAt)
      .filter((t): t is string => t !== null)
      .sort()
      .at(-1) ?? null;
  if (n === 1) {
    const only = (servers[0] as Pick<VaultSshServer, 'check'>).check;
    return { status: only.status, summary: only.summary, checkedAt: only.checkedAt, toolCount: null };
  }
  const failing = servers.filter((s) => s.check.status === 'failing').length;
  const reached = servers.filter((s) => s.check.status === 'reached').length;
  if (failing > 0)
    return {
      status: 'failing',
      summary: `${failing} of ${n} servers failing`,
      checkedAt: latest,
      toolCount: null,
    };
  if (reached > 0)
    return {
      status: 'reached',
      summary: reached === n ? `Signed in to all ${n} servers` : `Signed in to ${reached} of ${n} servers`,
      checkedAt: latest,
      toolCount: null,
    };
  return { status: 'unchecked', summary: '', checkedAt: latest, toolCount: null };
}

/** An `ssh` entry without servers (the card, and what agents are told). */
export const VAULT_SSH_NO_SERVERS = 'No servers yet';
