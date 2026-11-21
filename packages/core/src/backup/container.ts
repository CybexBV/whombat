/**
 * The backup file's container (contracts 0.79, CT-335; Whombat backup-file.md BF-06, BF-10): a short plaintext header,
 * then the body encrypted in authenticated chunks. Pure (no Node APIs): the server, the `whombat backup-file open` CLI
 * and the tests share it. Incremental both ways over `Uint8Array` pieces, so a file of gigabytes is never buffered.
 *
 * Header (`BACKUP_HEADER_BYTES` = 110 bytes, integers big-endian):
 *
 * | offset | bytes | field |
 * |---|---|---|
 * | 0 | 8 | magic `89 57 42 4b 0d 0a 1a 0a` (`\x89WBK\r\n\x1a\n`, PNG-style: catches text-mode transfers) |
 * | 8 | 2 | container version, 1 |
 * | 10 | 2 | header length, 110 |
 * | 12 | 1 | KDF, 1 = Argon2id (RFC 9106, version 0x13) |
 * | 13 | 4 | Argon2id memory, KiB |
 * | 17 | 4 | Argon2id passes |
 * | 21 | 4 | Argon2id parallelism |
 * | 25 | 16 | salt (random) |
 * | 41 | 1 | cipher, 1 = XChaCha20-Poly1305 STREAM |
 * | 42 | 4 | plaintext bytes per chunk (65 536) |
 * | 46 | 16 | nonce prefix (random) |
 * | 62 | 16 | key check |
 * | 78 | 32 | SHA-256 of bytes 0–77 (header checksum) |
 *
 * Nothing else is in plaintext: no burrow name, no counts, no dates.
 *
 * Keys: `ikm = Argon2id(password, salt, m, t, p, 32 bytes)` over the UTF-8 of the NFC-normalized password
 * (`backupPasswordBytes`); `streamKey = HKDF-SHA256(ikm, no salt, "whombat.backup-file/1 stream", 32)`;
 * `keyCheck = HKDF-SHA256(ikm, no salt, "whombat.backup-file/1 key check", 16)`. A wrong password fails the key check
 * (`wrong_password`) before any chunk is tried; a header with a bad checksum is `damaged`.
 *
 * Body (STREAM, Hoang–Reyhanitabar–Rogaway–Vizár): the plaintext is cut into chunks of `chunkBytes`; every chunk but the
 * last is exactly that long, the last holds 0…`chunkBytes` bytes (0 only for an empty body). Chunk `i` is
 * `XChaCha20-Poly1305(streamKey, nonce_i, aad).encrypt(chunk)`, ciphertext + 16-byte tag, written back to back after
 * the header, where `nonce_i = noncePrefix (16) ‖ i as 7 bytes big-endian ‖ last (1 byte: 1 for the last chunk, else
 * 0)` and `aad = SHA-256(the whole 110-byte header)`. So truncation (the last chunk is missing its flag), reordering or
 * dropping chunks (the counter), swapping files (the random prefix and salt) and any header change (the AAD) fail
 * authentication, and the decoder hands out plaintext only after its chunk authenticated.
 *
 * Native implementations (byte-identical, `backupChunkSubkey`): every chunk of a file shares the nonce prefix, so the
 * XChaCha20 subkey `HChaCha20(streamKey, noncePrefix)` is computed once per file, and chunk `i` is IETF
 * ChaCha20-Poly1305 (RFC 8439, Node's `chacha20-poly1305`) under that subkey with the 12-byte nonce
 * `00 00 00 00 ‖ i (7 bytes) ‖ last` (`backupChunkIetfNonce`). Argon2id is Node's `crypto.argon2` with the header's
 * parameters (`message` = `backupPasswordBytes`, `nonce` = salt, `tagLength` 32); pass it as `kdf`.
 */
import { chacha20poly1305, hchacha, xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { readU16, readU32, sameBytes, utf8ToBytes, writeU16, writeU32 } from './bytes.js';
import { BackupFileError } from './errors.js';

/** `\x89WBK\r\n\x1a\n` (the bytes; `backupFileMagic()` gives a copy). */
const MAGIC = [0x89, 0x57, 0x42, 0x4b, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** A fresh copy of the 8 magic bytes. */
export function backupFileMagic(): Uint8Array {
  return Uint8Array.from(MAGIC);
}
/** The container version this code writes and reads; a higher one is `newer_format`. */
export const BACKUP_CONTAINER_VERSION = 1;
/** Header length of container version 1. */
export const BACKUP_HEADER_BYTES = 110;
/** Bytes before the header length is known (magic, version, length). */
export const BACKUP_HEADER_PREFIX_BYTES = 12;
export const BACKUP_KDF_ARGON2ID = 1;
export const BACKUP_CIPHER_XCHACHA20POLY1305_STREAM = 1;
export const BACKUP_SALT_BYTES = 16;
export const BACKUP_NONCE_PREFIX_BYTES = 16;
export const BACKUP_KEY_CHECK_BYTES = 16;
export const BACKUP_TAG_BYTES = 16;
/** Plaintext bytes per chunk the server writes (64 KiB). */
export const BACKUP_CHUNK_BYTES = 65_536;
/** Chunk sizes a reader accepts (a header outside them is `damaged`). */
export const BACKUP_CHUNK_BYTES_MIN = 1_024;
export const BACKUP_CHUNK_BYTES_MAX = 16_777_216;
/** Most chunks a file may have (the counter is 7 bytes; this keeps it a safe integer). */
export const BACKUP_MAX_CHUNKS = 2 ** 48;

/** HKDF labels. */
export const BACKUP_STREAM_KEY_INFO = 'whombat.backup-file/1 stream';
export const BACKUP_KEY_CHECK_INFO = 'whombat.backup-file/1 key check';

/** Argon2id parameters (RFC 9106 names: `m` KiB, `t` passes, `p` lanes). */
export interface BackupKdfParams {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

/**
 * What the server writes (CT-335): Argon2id with 128 MiB, 3 passes, 1 lane. ≈ 1.0 s with `@noble/hashes` in Node 24 on
 * the build machine (≈ 0.15 s with Node's native `crypto.argon2`), so the offline CLI and any runtime without a native
 * Argon2 stay usable; slower boxes take 2–3 s with the pure implementation.
 */
export const BACKUP_KDF_DEFAULT: Readonly<BackupKdfParams> = Object.freeze({
  memoryKiB: 131_072,
  passes: 3,
  parallelism: 1,
});

/**
 * Bounds a reader holds a header's parameters to (a file is untrusted input: these cap its memory and time). The
 * lower bounds are Argon2's own (`m ≥ 8·p`), so test vectors may use tiny parameters; writers use
 * `BACKUP_KDF_DEFAULT`.
 */
export const BACKUP_KDF_LIMITS = Object.freeze({
  memoryKiBMax: 1_048_576,
  passesMax: 16,
  parallelismMax: 16,
});

/** Shortest and longest password, in characters (code points). */
export const BACKUP_PASSWORD_MIN = 10;
export const BACKUP_PASSWORD_MAX = 1_024;

/** A parsed header. */
export interface BackupFileHeader {
  version: number;
  kdf: BackupKdfParams;
  salt: Uint8Array;
  chunkBytes: number;
  noncePrefix: Uint8Array;
  keyCheck: Uint8Array;
  /** The header's 110 bytes as read. */
  bytes: Uint8Array;
  /** SHA-256 of `bytes`: every chunk's associated data. */
  hash: Uint8Array;
}

/** A header unlocked with its password: what the encoder and the decoder need. */
export interface BackupFileKeys {
  header: BackupFileHeader;
  streamKey: Uint8Array;
}

/**
 * Argon2id: 32 bytes from the password bytes, salt and parameters. The default is `@noble/hashes` (`argon2idAsync`);
 * a server may pass Node's native `crypto.argon2` (same bytes).
 */
export type BackupKdf = (
  password: Uint8Array,
  salt: Uint8Array,
  params: BackupKdfParams,
) => Uint8Array | Promise<Uint8Array>;

/** `@noble/hashes` Argon2id (version 0x13), 32 bytes. */
export const nobleBackupKdf: BackupKdf = (password, salt, params) =>
  argon2idAsync(password, salt, {
    m: params.memoryKiB,
    t: params.passes,
    p: params.parallelism,
    dkLen: 32,
    maxmem: (BACKUP_KDF_LIMITS.memoryKiBMax + 1) * 1024,
  });

/** The password's code points (what `BACKUP_PASSWORD_MIN` counts). */
export function backupPasswordLength(password: string): number {
  return [...password.normalize('NFC')].length;
}

/** Whether a password is long enough and not too long. */
export function backupPasswordOk(password: string): boolean {
  const n = backupPasswordLength(password);
  return n >= BACKUP_PASSWORD_MIN && n <= BACKUP_PASSWORD_MAX;
}

/** The bytes Argon2id gets: UTF-8 of the NFC form (the same password typed on any platform opens the file). */
export function backupPasswordBytes(password: string): Uint8Array {
  return utf8ToBytes(password.normalize('NFC'));
}

function checkKdfParams(p: BackupKdfParams): boolean {
  return (
    Number.isSafeInteger(p.parallelism) &&
    p.parallelism >= 1 &&
    p.parallelism <= BACKUP_KDF_LIMITS.parallelismMax &&
    Number.isSafeInteger(p.passes) &&
    p.passes >= 1 &&
    p.passes <= BACKUP_KDF_LIMITS.passesMax &&
    Number.isSafeInteger(p.memoryKiB) &&
    p.memoryKiB >= 8 * p.parallelism &&
    p.memoryKiB <= BACKUP_KDF_LIMITS.memoryKiBMax
  );
}

/** The 110 header bytes for these fields (checksum included). */
export function encodeBackupHeader(fields: {
  kdf: BackupKdfParams;
  salt: Uint8Array;
  chunkBytes: number;
  noncePrefix: Uint8Array;
  keyCheck: Uint8Array;
}): Uint8Array {
  if (!checkKdfParams(fields.kdf)) throw new RangeError('backup header: KDF parameters out of range');
  if (fields.salt.length !== BACKUP_SALT_BYTES) throw new RangeError('backup header: salt must be 16 bytes');
  if (fields.noncePrefix.length !== BACKUP_NONCE_PREFIX_BYTES)
    throw new RangeError('backup header: nonce prefix must be 16 bytes');
  if (fields.keyCheck.length !== BACKUP_KEY_CHECK_BYTES)
    throw new RangeError('backup header: key check must be 16 bytes');
  if (
    !Number.isSafeInteger(fields.chunkBytes) ||
    fields.chunkBytes < BACKUP_CHUNK_BYTES_MIN ||
    fields.chunkBytes > BACKUP_CHUNK_BYTES_MAX
  )
    throw new RangeError('backup header: chunk size out of range');
  const h = new Uint8Array(BACKUP_HEADER_BYTES);
  h.set(MAGIC, 0);
  writeU16(h, 8, BACKUP_CONTAINER_VERSION);
  writeU16(h, 10, BACKUP_HEADER_BYTES);
  h[12] = BACKUP_KDF_ARGON2ID;
  writeU32(h, 13, fields.kdf.memoryKiB);
  writeU32(h, 17, fields.kdf.passes);
  writeU32(h, 21, fields.kdf.parallelism);
  h.set(fields.salt, 25);
  h[41] = BACKUP_CIPHER_XCHACHA20POLY1305_STREAM;
  writeU32(h, 42, fields.chunkBytes);
  h.set(fields.noncePrefix, 46);
  h.set(fields.keyCheck, 62);
  h.set(sha256(h.subarray(0, 78)), 78);
  return h;
}

/**
 * How many header bytes `bytes` (the start of a file) needs in all: `BACKUP_HEADER_BYTES` once the prefix is there,
 * `BACKUP_HEADER_PREFIX_BYTES` before. Throws `not_backup_file` / `newer_format` / `damaged` as soon as it can tell.
 */
export function backupHeaderLength(bytes: Uint8Array): number {
  const magicPart = Math.min(bytes.length, MAGIC.length);
  for (let i = 0; i < magicPart; i++)
    if (bytes[i] !== MAGIC[i]) throw new BackupFileError('not_backup_file', 'magic');
  if (bytes.length < BACKUP_HEADER_PREFIX_BYTES) return BACKUP_HEADER_PREFIX_BYTES;
  const version = readU16(bytes, 8);
  if (version > BACKUP_CONTAINER_VERSION) throw new BackupFileError('newer_format', `container ${version}`);
  if (version !== BACKUP_CONTAINER_VERSION) throw new BackupFileError('damaged', `container ${version}`);
  const length = readU16(bytes, 10);
  if (length !== BACKUP_HEADER_BYTES) throw new BackupFileError('damaged', `header length ${length}`);
  return length;
}

/**
 * Parses the header at the start of `bytes` (at least `BACKUP_HEADER_BYTES`; more is ignored). Throws
 * `not_backup_file`, `newer_format` (a newer container, KDF or cipher) or `damaged` (short, bad checksum, parameters out
 * of bounds). Runs no KDF.
 */
export function parseBackupHeader(bytes: Uint8Array): BackupFileHeader {
  const need = backupHeaderLength(bytes);
  if (bytes.length < need || need !== BACKUP_HEADER_BYTES)
    throw new BackupFileError('damaged', 'short header');
  const h = bytes.slice(0, BACKUP_HEADER_BYTES);
  if (!sameBytes(sha256(h.subarray(0, 78)), h.subarray(78, 110)))
    throw new BackupFileError('damaged', 'header checksum');
  if (h[12] !== BACKUP_KDF_ARGON2ID) throw new BackupFileError('newer_format', `kdf ${h[12]}`);
  if (h[41] !== BACKUP_CIPHER_XCHACHA20POLY1305_STREAM)
    throw new BackupFileError('newer_format', `cipher ${h[41]}`);
  const kdf = { memoryKiB: readU32(h, 13), passes: readU32(h, 17), parallelism: readU32(h, 21) };
  if (!checkKdfParams(kdf)) throw new BackupFileError('damaged', 'kdf parameters');
  const chunkBytes = readU32(h, 42);
  if (chunkBytes < BACKUP_CHUNK_BYTES_MIN || chunkBytes > BACKUP_CHUNK_BYTES_MAX)
    throw new BackupFileError('damaged', 'chunk size');
  return {
    version: BACKUP_CONTAINER_VERSION,
    kdf,
    salt: h.slice(25, 41),
    chunkBytes,
    noncePrefix: h.slice(46, 62),
    keyCheck: h.slice(62, 78),
    bytes: h,
    hash: sha256(h),
  };
}

function subkeys(ikm: Uint8Array): { streamKey: Uint8Array; keyCheck: Uint8Array } {
  return {
    streamKey: hkdf(sha256, ikm, undefined, utf8ToBytes(BACKUP_STREAM_KEY_INFO), 32),
    keyCheck: hkdf(sha256, ikm, undefined, utf8ToBytes(BACKUP_KEY_CHECK_INFO), BACKUP_KEY_CHECK_BYTES),
  };
}

async function runKdf(kdf: BackupKdf, password: string, salt: Uint8Array, params: BackupKdfParams) {
  const ikm = await kdf(backupPasswordBytes(password), salt, params);
  if (!(ikm instanceof Uint8Array) || ikm.length !== 32) throw new Error('backup kdf: expected 32 bytes');
  return subkeys(ikm);
}

export interface CreateBackupKeysOptions {
  kdf?: BackupKdf;
  /** Default `BACKUP_KDF_DEFAULT`. Tests and vectors pass small ones. */
  params?: BackupKdfParams;
  /** Default `BACKUP_CHUNK_BYTES`. */
  chunkBytes?: number;
  /** Fixed values for test vectors only; otherwise random. */
  salt?: Uint8Array;
  noncePrefix?: Uint8Array;
}

/**
 * A new file's keys and header for `password` (refused below `BACKUP_PASSWORD_MIN` characters: `password_too_short`).
 * Salt and nonce prefix are fresh random bytes; never reuse keys for a second file.
 */
export async function createBackupFileKeys(
  password: string,
  options: CreateBackupKeysOptions = {},
): Promise<BackupFileKeys> {
  if (!backupPasswordOk(password)) throw new BackupFileError('password_too_short');
  const params = options.params ?? BACKUP_KDF_DEFAULT;
  const salt = options.salt ?? randomBytes(BACKUP_SALT_BYTES);
  const noncePrefix = options.noncePrefix ?? randomBytes(BACKUP_NONCE_PREFIX_BYTES);
  const { streamKey, keyCheck } = await runKdf(options.kdf ?? nobleBackupKdf, password, salt, params);
  const bytes = encodeBackupHeader({
    kdf: params,
    salt,
    chunkBytes: options.chunkBytes ?? BACKUP_CHUNK_BYTES,
    noncePrefix,
    keyCheck,
  });
  return { header: parseBackupHeader(bytes), streamKey };
}

/** The keys of an existing file: throws `wrong_password` when the key check doesn't match. */
export async function unlockBackupFile(
  header: BackupFileHeader,
  password: string,
  options: { kdf?: BackupKdf } = {},
): Promise<BackupFileKeys> {
  const { streamKey, keyCheck } = await runKdf(
    options.kdf ?? nobleBackupKdf,
    password,
    header.salt,
    header.kdf,
  );
  if (!sameBytes(keyCheck, header.keyCheck)) throw new BackupFileError('wrong_password');
  return { header, streamKey };
}

function counterBytes(index: number, last: boolean): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0 || index >= BACKUP_MAX_CHUNKS)
    throw new BackupFileError('too_large', 'chunk counter');
  const out = new Uint8Array(8);
  let v = index;
  for (let i = 6; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[7] = last ? 1 : 0;
  return out;
}

/** The 24-byte XChaCha20 nonce of chunk `index`: prefix ‖ index (7 bytes, big-endian) ‖ last flag. */
export function backupChunkNonce(noncePrefix: Uint8Array, index: number, last: boolean): Uint8Array {
  const n = new Uint8Array(24);
  n.set(noncePrefix, 0);
  n.set(counterBytes(index, last), 16);
  return n;
}

/** The 12-byte IETF ChaCha20-Poly1305 nonce of chunk `index` under `backupChunkSubkey`: 4 zero bytes ‖ the last 8. */
export function backupChunkIetfNonce(index: number, last: boolean): Uint8Array {
  const n = new Uint8Array(12);
  n.set(counterBytes(index, last), 4);
  return n;
}

const aligned32 = (b: Uint8Array) => {
  const copy = new Uint8Array(b.length);
  copy.set(b);
  return new Uint32Array(copy.buffer, 0, b.length / 4);
};
const SIGMA = aligned32(utf8ToBytes('expand 32-byte k'));

/**
 * The XChaCha20 subkey of a file: `HChaCha20(streamKey, noncePrefix)`. With it every chunk is IETF ChaCha20-Poly1305
 * (`backupChunkIetfNonce`), so a server may seal and open chunks with a native implementation, byte for byte.
 */
export function backupChunkSubkey(streamKey: Uint8Array, noncePrefix: Uint8Array): Uint8Array {
  if (streamKey.length !== 32 || noncePrefix.length !== BACKUP_NONCE_PREFIX_BYTES)
    throw new RangeError('backup subkey: 32-byte key and 16-byte prefix');
  const out = new Uint32Array(8);
  hchacha(SIGMA, aligned32(streamKey), aligned32(noncePrefix), out);
  return new Uint8Array(out.buffer.slice(0));
}

/** Seals one chunk (the encoder's step, exposed for vectors and native cross-checks). */
export function sealBackupChunk(
  keys: BackupFileKeys,
  index: number,
  last: boolean,
  plaintext: Uint8Array,
): Uint8Array {
  const nonce = backupChunkNonce(keys.header.noncePrefix, index, last);
  return xchacha20poly1305(keys.streamKey, nonce, keys.header.hash).encrypt(plaintext);
}

/** Opens one chunk; null when it doesn't authenticate. */
export function openBackupChunk(
  keys: BackupFileKeys,
  index: number,
  last: boolean,
  ciphertext: Uint8Array,
): Uint8Array | null {
  const nonce = backupChunkNonce(keys.header.noncePrefix, index, last);
  try {
    return xchacha20poly1305(keys.streamKey, nonce, keys.header.hash).decrypt(ciphertext);
  } catch {
    return null;
  }
}

/** The same chunk through the IETF construction (tests prove both agree; a native port follows this one). */
export function sealBackupChunkIetf(
  subkey: Uint8Array,
  headerHash: Uint8Array,
  index: number,
  last: boolean,
  plaintext: Uint8Array,
): Uint8Array {
  return chacha20poly1305(subkey, backupChunkIetfNonce(index, last), headerHash).encrypt(plaintext);
}

/** Size of the encrypted file for a body of `plaintextBytes` (header, chunks, tags). */
export function backupFileSize(plaintextBytes: number, chunkBytes: number = BACKUP_CHUNK_BYTES): number {
  const chunks = Math.max(1, Math.ceil(plaintextBytes / chunkBytes));
  return BACKUP_HEADER_BYTES + plaintextBytes + chunks * BACKUP_TAG_BYTES;
}

/**
 * Encrypts a body incrementally: `push` plaintext pieces of any size, then `finish` once. The first output starts with
 * the header. Holds at most one chunk of plaintext.
 */
export class BackupFileEncoder {
  private readonly buf: Uint8Array;
  private fill = 0;
  private index = 0;
  private headerSent = false;
  private done = false;
  private written = 0;

  constructor(private readonly keys: BackupFileKeys) {
    this.buf = new Uint8Array(keys.header.chunkBytes);
  }

  /** Bytes handed out so far (header and chunks). */
  get bytesOut(): number {
    return this.written;
  }

  private emit(out: Uint8Array[], bytes: Uint8Array) {
    out.push(bytes);
    this.written += bytes.length;
  }

  private start(out: Uint8Array[]) {
    if (this.headerSent) return;
    this.headerSent = true;
    this.emit(out, this.keys.header.bytes.slice());
  }

  push(data: Uint8Array): Uint8Array[] {
    if (this.done) throw new Error('backup encoder: finished');
    const out: Uint8Array[] = [];
    this.start(out);
    const size = this.buf.length;
    let off = 0;
    while (off < data.length) {
      if (this.fill === size) {
        // A full chunk with more data after it: not the last one.
        this.emit(out, sealBackupChunk(this.keys, this.index++, false, this.buf));
        this.fill = 0;
      }
      const n = Math.min(size - this.fill, data.length - off);
      this.buf.set(data.subarray(off, off + n), this.fill);
      this.fill += n;
      off += n;
    }
    return out;
  }

  finish(): Uint8Array[] {
    if (this.done) throw new Error('backup encoder: finished');
    const out: Uint8Array[] = [];
    this.start(out);
    this.emit(out, sealBackupChunk(this.keys, this.index++, true, this.buf.subarray(0, this.fill)));
    this.done = true;
    this.buf.fill(0);
    return out;
  }
}

/**
 * Decrypts the bytes after the header incrementally: `push` ciphertext pieces of any size, then `finish` once (it
 * opens the last chunk). Every plaintext piece it returns has authenticated; until `finish` returned, the body may still
 * turn out truncated (`damaged`), so act on nothing irreversible before then. Throws `damaged` on the first chunk that
 * doesn't authenticate.
 */
export class BackupFileDecoder {
  private readonly buf: Uint8Array;
  private fill = 0;
  private index = 0;
  private done = false;
  private read = 0;

  constructor(private readonly keys: BackupFileKeys) {
    this.buf = new Uint8Array(keys.header.chunkBytes + BACKUP_TAG_BYTES);
  }

  /** Plaintext bytes handed out so far. */
  get bytesOut(): number {
    return this.read;
  }

  private open(last: boolean, ciphertext: Uint8Array): Uint8Array {
    const pt = openBackupChunk(this.keys, this.index, last, ciphertext);
    if (!pt) throw new BackupFileError('damaged', `chunk ${this.index}${last ? ' (last)' : ''}`);
    this.index++;
    this.read += pt.length;
    return pt;
  }

  push(data: Uint8Array): Uint8Array[] {
    if (this.done) throw new BackupFileError('damaged', 'bytes after the last chunk');
    const out: Uint8Array[] = [];
    const size = this.buf.length;
    let off = 0;
    while (off < data.length) {
      if (this.fill === size) {
        out.push(this.open(false, this.buf));
        this.fill = 0;
      }
      const n = Math.min(size - this.fill, data.length - off);
      this.buf.set(data.subarray(off, off + n), this.fill);
      this.fill += n;
      off += n;
    }
    return out;
  }

  finish(): Uint8Array[] {
    if (this.done) throw new Error('backup decoder: finished');
    if (this.fill < BACKUP_TAG_BYTES) throw new BackupFileError('damaged', 'truncated');
    const pt = this.open(true, this.buf.subarray(0, this.fill));
    this.done = true;
    return [pt];
  }
}

/**
 * Reads a whole file from its first byte: collects the header, then (after `unlock`) decrypts. For callers that see the
 * file as one stream (the CLI, an upload being inspected). `push` before `unlock` buffers only the header; bytes after
 * it wait in at most one piece.
 */
export class BackupFileReader {
  private head = new Uint8Array(0);
  private pending: Uint8Array[] = [];
  private decoder: BackupFileDecoder | null = null;
  header: BackupFileHeader | null = null;

  /** Feeds bytes; returns plaintext once unlocked. */
  push(data: Uint8Array): Uint8Array[] {
    if (this.decoder) return this.decoder.push(data);
    if (this.header) {
      this.pending.push(data.slice());
      return [];
    }
    const all = new Uint8Array(this.head.length + data.length);
    all.set(this.head, 0);
    all.set(data, this.head.length);
    const need = backupHeaderLength(all);
    if (all.length < BACKUP_HEADER_BYTES || need > all.length) {
      this.head = all;
      return [];
    }
    this.header = parseBackupHeader(all);
    this.head = new Uint8Array(0);
    if (all.length > BACKUP_HEADER_BYTES) this.pending.push(all.slice(BACKUP_HEADER_BYTES));
    return [];
  }

  /** Unlocks with the password once the header is in; returns the plaintext of what was waiting. */
  async unlock(password: string, options: { kdf?: BackupKdf } = {}): Promise<Uint8Array[]> {
    if (!this.header)
      throw new BackupFileError(this.head.length === 0 ? 'not_backup_file' : 'damaged', 'short file');
    const keys = await unlockBackupFile(this.header, password, options);
    this.decoder = new BackupFileDecoder(keys);
    const out: Uint8Array[] = [];
    for (const p of this.pending) out.push(...this.decoder.push(p));
    this.pending = [];
    return out;
  }

  finish(): Uint8Array[] {
    if (!this.header)
      throw new BackupFileError(this.head.length === 0 ? 'not_backup_file' : 'damaged', 'short file');
    if (!this.decoder) throw new Error('backup reader: unlock first');
    return this.decoder.finish();
  }
}
