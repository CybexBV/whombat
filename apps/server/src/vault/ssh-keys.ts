/**
 * An `ssh` entry's key pair (docs/decisions/vault.md VT-S02, VT-S03, VT-S10; VT-D42…VT-D44).
 *
 * - **Generate**: an ed25519 pair made here with Node's crypto; only the public half ever leaves the server.
 * - **Import**: an OpenSSH or PEM private key (RSA ≥ 2048, ECDSA P-256/384/521, ed25519), opened once with its
 *   passphrase (OpenSSH keys through ssh2's parser, which knows bcrypt-pbkdf; PEM keys through Node's), then checked
 *   for its type and size. Core's `inspectVaultSshPrivateKey` refuses what can be told without parsing first.
 * - **Stored** the same way whatever came in: an unencrypted `openssh-key-v1` text (comment `whombat-<entry key>`),
 *   sealed as the entry's secret, and the public half as `auth` (`ssh_key`). ssh2 reads it back at every connection.
 * - **Forms** (VT-S10): the stored text, its private-bearing base64 lines and the raw private numbers (the ed25519
 *   seed, RSA `d`, `p`, `q`, the EC scalar), plus a passphrase seen at import in this process (`rememberPassphrase`).
 *
 * Nothing here logs, throws or returns the private key except as the stored text handed to the sealing command.
 */
import { createPrivateKey, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';
import {
  holdsVaultSshKey,
  inspectVaultSshPrivateKey,
  VAULT_SSH_KEY_PROBLEM_TEXT,
  VAULT_SSH_PASSPHRASE_FORM_MIN,
  VAULT_SSH_RSA_MIN_BITS,
  type VaultSshKeyAuth,
  type VaultSshKeyProblemCode,
  type VaultSshKeyType,
  vaultSshFingerprintOfBlob,
  vaultSshKeyComment,
  vaultSshKeyForms,
} from '@whombat/core';
import ssh2 from 'ssh2';

const { utils } = ssh2;

/** A key ready to be sealed: the OpenSSH text (secret) and its public half (the entry's `auth`). */
export interface SshKeyMaterial {
  privateKey: string;
  auth: VaultSshKeyAuth;
}

export type SshKeyResult =
  | { ok: true; key: SshKeyMaterial }
  | { ok: false; code: VaultSshKeyProblemCode; field: 'privateKey' | 'passphrase'; message: string };

/* Wire encoding ------------------------------------------------------------------------------------- */

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function str(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
  return Buffer.concat([u32(bytes.length), bytes]);
}

/** An unsigned big-endian integer as an SSH `mpint` (no leading zeros; a zero byte when the high bit is set). */
function mpint(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  const body = (trimmed[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
  return str(body);
}

const b64url = (s: string | undefined) => Buffer.from(s ?? '', 'base64url');

const CURVES: Record<string, { name: string; size: number }> = {
  'P-256': { name: 'nistp256', size: 32 },
  'P-384': { name: 'nistp384', size: 48 },
  'P-521': { name: 'nistp521', size: 66 },
};

function pad(bytes: Buffer, size: number): Buffer {
  return bytes.length >= size ? bytes : Buffer.concat([Buffer.alloc(size - bytes.length), bytes]);
}

interface Encoded {
  keyType: VaultSshKeyType;
  algorithm: string;
  publicBlob: Buffer;
  /** The private key's own fields, after the algorithm name (the `openssh-key-v1` private section). */
  privateFields: Buffer;
  /** The raw private numbers, base64 (forms, VT-S10). */
  raw: string[];
}

type KeyProblem = { problem: VaultSshKeyProblemCode };

/** A Node private key in SSH's wire terms, or why an entry can't hold it. */
function encodeKey(key: KeyObject): Encoded | KeyProblem {
  const type = key.asymmetricKeyType;
  if (type === 'ed25519') {
    const jwk = key.export({ format: 'jwk' });
    const pub = b64url(jwk.x);
    const seed = b64url(jwk.d);
    return {
      keyType: 'ed25519',
      algorithm: 'ssh-ed25519',
      publicBlob: Buffer.concat([str('ssh-ed25519'), str(pub)]),
      privateFields: Buffer.concat([str(pub), str(Buffer.concat([seed, pub]))]),
      raw: [seed.toString('base64')],
    };
  }
  if (type === 'rsa') {
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < VAULT_SSH_RSA_MIN_BITS) return { problem: 'rsa_too_short' };
    const jwk = key.export({ format: 'jwk' });
    const [n, e, d, p, q, qi] = [jwk.n, jwk.e, jwk.d, jwk.p, jwk.q, jwk.qi].map(b64url) as Buffer[];
    if (!n || !e || !d || !p || !q || !qi) return { problem: 'unreadable' };
    return {
      keyType: 'rsa',
      algorithm: 'ssh-rsa',
      publicBlob: Buffer.concat([str('ssh-rsa'), mpint(e), mpint(n)]),
      privateFields: Buffer.concat([mpint(n), mpint(e), mpint(d), mpint(qi), mpint(p), mpint(q)]),
      raw: [d, p, q].map((b) => b.toString('base64')),
    };
  }
  if (type === 'ec') {
    const jwk = key.export({ format: 'jwk' });
    const curve = CURVES[jwk.crv ?? ''];
    if (!curve) return { problem: 'unsupported_type' };
    const algorithm = `ecdsa-sha2-${curve.name}`;
    const point = Buffer.concat([
      Buffer.from([4]),
      pad(b64url(jwk.x), curve.size),
      pad(b64url(jwk.y), curve.size),
    ]);
    const d = pad(b64url(jwk.d), curve.size);
    return {
      keyType: 'ecdsa',
      algorithm,
      publicBlob: Buffer.concat([str(algorithm), str(curve.name), str(point)]),
      privateFields: Buffer.concat([str(curve.name), str(point), mpint(d)]),
      raw: [d.toString('base64')],
    };
  }
  // DSA, Ed448, X25519, RSA-PSS, …
  return { problem: 'unsupported_type' };
}

/** The `openssh-key-v1` text of a key, unencrypted (the seal is its protection), with a comment. */
function openSshText(encoded: Encoded, comment: string): string {
  const check = randomBytes(4);
  let section = Buffer.concat([check, check, str(encoded.algorithm), encoded.privateFields, str(comment)]);
  const padding: number[] = [];
  for (let i = 1; (section.length + padding.length) % 8 !== 0; i++) padding.push(i);
  section = Buffer.concat([section, Buffer.from(padding)]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    str('none'),
    str('none'),
    str(''),
    u32(1),
    str(encoded.publicBlob),
    str(section),
  ]).toString('base64');
  const lines = body.match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** The key as an entry stores it, checked by reading it back with the parser connections use. */
function material(
  key: KeyObject,
  entryId: string,
  origin: 'generated' | 'imported',
): SshKeyMaterial | KeyProblem {
  const encoded = encodeKey(key);
  if ('problem' in encoded) return encoded;
  const privateKey = openSshText(encoded, vaultSshKeyComment(entryId));
  const back = utils.parseKey(privateKey);
  const parsed = Array.isArray(back) ? back[0] : back;
  if (!parsed || parsed instanceof Error || !parsed.getPublicSSH().equals(encoded.publicBlob))
    return { problem: 'unreadable' };
  return {
    privateKey,
    auth: {
      type: 'ssh_key',
      keyType: encoded.keyType,
      publicKey: `${encoded.algorithm} ${encoded.publicBlob.toString('base64')}`,
      fingerprint: vaultSshFingerprintOfBlob(encoded.publicBlob),
      origin,
    },
  };
}

/* Generate and import (VT-S03) ---------------------------------------------------------------------- */

/** “Generate a new key”: an ed25519 pair made on the server. */
export function generateSshKey(entryId: string): SshKeyMaterial {
  const { privateKey } = generateKeyPairSync('ed25519');
  const made = material(privateKey, entryId, 'generated');
  if ('problem' in made) throw new Error('could not encode a generated SSH key');
  return made;
}

function refuse(code: VaultSshKeyProblemCode): SshKeyResult {
  return {
    ok: false,
    code,
    field: code === 'passphrase_needed' || code === 'wrong_passphrase' ? 'passphrase' : 'privateKey',
    message: VAULT_SSH_KEY_PROBLEM_TEXT[code],
  };
}

/** Opens a pasted OpenSSH key with ssh2's parser (bcrypt-pbkdf for encrypted ones). */
function openOpenSsh(text: string, passphrase: string | undefined): KeyObject | VaultSshKeyProblemCode {
  const parsed = utils.parseKey(text, passphrase);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key) return 'unreadable';
  if (key instanceof Error) {
    if (/no passphrase given/i.test(key.message)) return 'passphrase_needed';
    if (/passphrase|decrypt|integrity/i.test(key.message)) return 'wrong_passphrase';
    if (/unsupported/i.test(key.message)) return 'unsupported_type';
    return 'unreadable';
  }
  try {
    return createPrivateKey(key.getPrivatePEM());
  } catch {
    return 'unreadable';
  }
}

/**
 * Opens a pasted PEM key (PKCS#1, SEC1, PKCS#8, encrypted or not) with Node's parser. An encrypted key that a given
 * passphrase doesn't open had the wrong one: about one wrong passphrase in 200 decrypts to bytes that fail as another
 * kind of key (`ERR_OSSL_UNSUPPORTED`), which is still a wrong passphrase, not an unsupported key (test-speed.md TS-05).
 */
function openPem(
  text: string,
  passphrase: string | undefined,
  encrypted: boolean,
): KeyObject | VaultSshKeyProblemCode {
  try {
    return createPrivateKey({ key: text, format: 'pem', ...(passphrase ? { passphrase } : {}) });
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    const message = err instanceof Error ? err.message : '';
    if (code === 'ERR_MISSING_PASSPHRASE') return 'passphrase_needed';
    if (passphrase && (encrypted || /decrypt|passphrase|bad/i.test(`${code} ${message}`)))
      return 'wrong_passphrase';
    if (/unsupported/i.test(`${code} ${message}`)) return 'unsupported_type';
    return 'unreadable';
  }
}

/* How much work opening a key takes (VT-D55) --------------------------------------------------------- */

/**
 * The most bcrypt rounds an OpenSSH key may ask for (`ssh-keygen -a`; 16 by default, 100 often advised): ssh2's
 * bcrypt-pbkdf is pure JS and runs on the server's one thread, about 8 ms a round.
 */
export const SSH_KEY_BCRYPT_ROUNDS_MAX = 128;
/** The most PBKDF2 (or PKCS#5 v1.5 / PKCS#12 PBE) iterations a PEM key may ask for: OpenSSL needs ≤ 0.25 s. */
export const SSH_KEY_PBKDF_ITERATIONS_MAX = 1_000_000;

/** What a key whose passphrase protection asks for more work than that reads. */
export const SSH_KEY_TOO_SLOW_TEXT =
  'That key’s passphrase protection takes too long to open. Save it again with ssh-keygen -p -a 100 -f <file> (or without a passphrase), or generate a new key.';

/** One DER element: its tag, the content's bytes. */
interface Der {
  tag: number;
  content: Buffer;
}

/** The elements of a DER sequence's content, or null when it isn't well formed. */
function derChildren(bytes: Buffer): Der[] | null {
  const out: Der[] = [];
  let p = 0;
  while (p < bytes.length) {
    const tag = bytes[p++];
    let len = bytes[p++];
    if (tag === undefined || len === undefined) return null;
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 4 || p + n > bytes.length) return null;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + (bytes[p++] as number);
    }
    if (p + len > bytes.length) return null;
    out.push({ tag, content: bytes.subarray(p, p + len) });
    p += len;
  }
  return out;
}

const OID_TAG = 0x06;
const INTEGER_TAG = 0x02;
const PKCS5 = Buffer.from('2a864886f70d0105', 'hex');
const PKCS12_PBE = Buffer.from('2a864886f70d010c01', 'hex');
const PBKDF2 = Buffer.concat([PKCS5, Buffer.from([0x0c])]);
const SCRYPT = Buffer.from('2b06010401da47040b', 'hex');

/** A DER INTEGER as a number (Infinity past 2^48: certainly too many). */
function derInteger(content: Buffer): number {
  if (content.length > 6) return Number.POSITIVE_INFINITY;
  return content.reduce((n, b) => n * 256 + b, 0);
}

/**
 * Whether a PEM key's DER asks for more than `SSH_KEY_PBKDF_ITERATIONS_MAX` iterations to open (PBKDF2, PKCS#5 v1.5
 * and PKCS#12 PBE parameters anywhere in it), or for scrypt (whose cost OpenSSL bounds by memory, not time); a DER that
 * doesn't parse counts as too much (OpenSSL would refuse it anyway). `depth` bounds the walk.
 */
function derTooSlow(bytes: Buffer, depth = 0): boolean {
  if (depth > 16) return true;
  const children = derChildren(bytes);
  if (!children) return true;
  const [first, second] = children;
  if (first?.tag === OID_TAG) {
    const oid = first.content;
    if (oid.equals(SCRYPT)) return true;
    const pbe =
      oid.equals(PBKDF2) ||
      (oid.length === PKCS5.length + 1 &&
        oid.subarray(0, PKCS5.length).equals(PKCS5) &&
        oid.at(-1) !== 0x0d) ||
      (oid.length === PKCS12_PBE.length + 1 && oid.subarray(0, PKCS12_PBE.length).equals(PKCS12_PBE));
    if (pbe) {
      // Parameters: a sequence of the salt and the iteration count (PBKDF2: salt, iterationCount, keyLength?, prf?).
      const params = second?.tag === 0x30 ? derChildren(second.content) : null;
      const count = params?.[1];
      if (!count || count.tag !== INTEGER_TAG) return true;
      if (derInteger(count.content) > SSH_KEY_PBKDF_ITERATIONS_MAX) return true;
    }
  }
  // Constructed elements (sequences, sets, context-specific) are walked; primitive ones hold no parameters.
  return children.some((c) => (c.tag & 0x20) !== 0 && derTooSlow(c.content, depth + 1));
}

/**
 * A PEM block's body as bytes and whether it has header lines (`Proc-Type:`, `DEK-Info:`, only before the body, as
 * OpenSSL reads them; an OpenSSH key has none). Null unless the body is plain base64 and whitespace: Node's decoder
 * skips characters OpenSSL and ssh2 might read otherwise, and what is checked must be what the parser opens.
 */
function pemBody(text: string, headers: boolean): { bytes: Buffer; headers: string[] } | null {
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!match?.[2]) return null;
  const lines = match[2].split(/\r?\n/).filter((l) => l.trim() !== '');
  const head: string[] = [];
  while (headers && lines[0]?.includes(':')) head.push(lines.shift() as string);
  const body = lines.join('');
  if (!/^[A-Za-z0-9+/=\s]*$/.test(body)) return null;
  return { bytes: Buffer.from(body, 'base64'), headers: head };
}

/** The bcrypt rounds an `openssh-key-v1` body asks for (0 without a KDF), or null when its header doesn't read. */
function openSshRounds(bytes: Buffer): number | null {
  const magic = 'openssh-key-v1\0';
  if (bytes.subarray(0, magic.length).toString('latin1') !== magic) return null;
  let p = magic.length;
  const string = (): Buffer | null => {
    if (p + 4 > bytes.length) return null;
    const n = bytes.readUInt32BE(p);
    if (p + 4 + n > bytes.length) return null;
    const out = bytes.subarray(p + 4, p + 4 + n);
    p += 4 + n;
    return out;
  };
  const cipher = string();
  const kdf = string();
  const options = string();
  if (!cipher || !kdf || !options) return null;
  if (kdf.toString('latin1') !== 'bcrypt') return 0;
  // kdfoptions: string salt, uint32 rounds.
  if (options.length < 4) return null;
  const saltLength = options.readUInt32BE(0);
  if (4 + saltLength + 4 > options.length) return null;
  return options.readUInt32BE(4 + saltLength);
}

/**
 * Whether opening a pasted key would take the server too long (VT-D55): an OpenSSH key with more bcrypt rounds than
 * `SSH_KEY_BCRYPT_ROUNDS_MAX`, a PEM key with more KDF iterations than `SSH_KEY_PBKDF_ITERATIONS_MAX` or scrypt
 * (`too_slow`); a header this can't read is `unreadable` (no parser gets to run a KDF on it). Read from the key's own
 * header before any parser runs its KDF: an attacker picks the count, and 2^32 rounds would hold the server's only
 * thread for a year. A legacy encrypted PEM (`Proc-Type: 4,ENCRYPTED`) derives its key with one MD5: nothing to check.
 */
export function sshKeyWorkProblem(text: string, format: 'openssh' | 'pem'): 'too_slow' | 'unreadable' | null {
  const body = pemBody(text, format === 'pem');
  if (!body) return 'unreadable';
  if (format === 'openssh') {
    const rounds = openSshRounds(body.bytes);
    if (rounds === null) return 'unreadable';
    return rounds > SSH_KEY_BCRYPT_ROUNDS_MAX ? 'too_slow' : null;
  }
  // Legacy encryption: the body is ciphertext, its key one MD5 of the passphrase.
  if (body.headers.some((h) => /^Proc-Type:\s*4,ENCRYPTED/.test(h))) return null;
  return derTooSlow(body.bytes) ? 'too_slow' : null;
}

/**
 * “Use my own key” (VT-S03): the pasted key opened with its passphrase (used here once, never stored), checked and
 * stored as OpenSSH. Problems come back in the words of `VAULT_SSH_KEY_PROBLEM_TEXT`, on `privateKey` or `passphrase`.
 */
export function importSshKey(entryId: string, text: string, passphrase?: string | undefined): SshKeyResult {
  const inspected = inspectVaultSshPrivateKey(text);
  if (!inspected.ok) return refuse(inspected.code);
  const { format, encrypted } = inspected.key;
  if (encrypted && !passphrase) return refuse('passphrase_needed');
  const work = sshKeyWorkProblem(text, format === 'openssh' ? 'openssh' : 'pem');
  if (work === 'unreadable') return refuse('unreadable');
  if (work === 'too_slow')
    return { ok: false, code: 'unreadable', field: 'privateKey', message: SSH_KEY_TOO_SLOW_TEXT };
  const opened = format === 'openssh' ? openOpenSsh(text, passphrase) : openPem(text, passphrase, encrypted);
  if (typeof opened === 'string') return refuse(opened);
  const made = material(opened, entryId, 'imported');
  if ('problem' in made) return refuse(made.problem);
  return { ok: true, key: made };
}

/* Forms (VT-S10) ------------------------------------------------------------------------------------ */

/** The raw private numbers of a stored key, base64 (the forms core can't compute without parsing). */
export function rawPrivateNumbers(privateKey: string): string[] {
  const parsed = utils.parseKey(privateKey);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) return [];
  try {
    const encoded = encodeKey(createPrivateKey(key.getPrivatePEM()));
    return 'problem' in encoded ? [] : encoded.raw;
  } catch {
    return [];
  }
}

/**
 * Passphrases seen at import in this process, per entry (VT-S10): looked for in answers until the entry's key is
 * replaced or the entry removed. Memory only — never stored, logged or sent; a restart forgets them.
 */
const passphrases = new Map<string, string>();

export function rememberPassphrase(entryId: string, passphrase: string | undefined): void {
  if (passphrase && passphrase.length >= VAULT_SSH_PASSPHRASE_FORM_MIN) passphrases.set(entryId, passphrase);
  else passphrases.delete(entryId);
}

export function forgetPassphrase(entryId: string): void {
  passphrases.delete(entryId);
}

/**
 * Base64 of raw bytes at each of the three alignments they can have inside a longer base64 text (a PEM or OpenSSH
 * file holding the same key in another layout): the characters that depend on these bytes alone, at least 16.
 */
export function alignedBase64(bytes: Buffer): string[] {
  const out: string[] = [];
  for (const shift of [0, 1, 2]) {
    const text = Buffer.concat([Buffer.alloc(shift), bytes])
      .toString('base64')
      .replace(/=+$/, '');
    // Leading characters mix in the shift's bytes, the last one may mix in whatever follows.
    const from = Math.ceil((shift * 8) / 6);
    const to = Math.floor(((shift + bytes.length) * 8) / 6);
    const form = text.slice(from, to);
    if (form.length >= 16) out.push(form);
  }
  return out;
}

/** What an answer is checked against for one entry's key (VT-S10, VT-D44). */
export interface SshKeyForms {
  /** Core's forms (`vaultSshKeyForms`), longest first. */
  forms: string[];
  /** The raw private numbers at every base64 alignment, looked for with whitespace removed. */
  aligned: string[];
  /** The longest form: how far past a cut an answer is read before it is checked. */
  longest: number;
}

/** Every form of an entry's private key an answer must never hold. */
export function sshKeyForms(entryId: string, privateKey: string): SshKeyForms {
  const raw = rawPrivateNumbers(privateKey);
  const forms = vaultSshKeyForms({
    privateKeys: [privateKey],
    raw,
    passphrase: passphrases.get(entryId) ?? null,
  });
  const aligned = [...new Set(raw.flatMap((r) => alignedBase64(Buffer.from(r, 'base64'))))];
  const longest = [...forms, ...aligned].reduce((n, f) => Math.max(n, Buffer.byteLength(f)), 0);
  return { forms, aligned, longest };
}

/**
 * Whether a text holds the key in any form: core's forms as written, and with whitespace and NULs removed (a PEM's
 * lines joined, UTF-16 read as UTF-8) core's forms and the raw numbers at every alignment.
 */
export function holdsSshKey(text: string, forms: SshKeyForms): boolean {
  if (!text) return false;
  if (holdsVaultSshKey(text, forms.forms)) return true;
  const joined = text.replace(/[\s\0]+/g, '');
  return holdsVaultSshKey(joined, forms.forms) || holdsVaultSshKey(joined, forms.aligned);
}
