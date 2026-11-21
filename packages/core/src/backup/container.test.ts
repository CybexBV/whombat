import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_CHUNK_BYTES,
  BACKUP_HEADER_BYTES,
  BACKUP_KDF_DEFAULT,
  BACKUP_TAG_BYTES,
  BackupFileDecoder,
  BackupFileEncoder,
  type BackupFileKeys,
  BackupFileReader,
  type BackupKdf,
  backupChunkIetfNonce,
  backupChunkNonce,
  backupChunkSubkey,
  backupFileSize,
  backupHeaderLength,
  backupPasswordBytes,
  backupPasswordOk,
  createBackupFileKeys,
  encodeBackupHeader,
  parseBackupHeader,
  sealBackupChunk,
  sealBackupChunkIetf,
  unlockBackupFile,
} from './container.js';
import { BackupFileError } from './errors.js';

const SMALL = { memoryKiB: 64, passes: 1, parallelism: 1 };
const PASSWORD = 'correct horse battery';
const fixed = (n: number, v: number) => new Uint8Array(n).fill(v);

async function keys(chunkBytes = 1024, password = PASSWORD): Promise<BackupFileKeys> {
  return createBackupFileKeys(password, {
    params: SMALL,
    chunkBytes,
    salt: fixed(16, 1),
    noncePrefix: fixed(16, 2),
  });
}

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Encrypts `plain` pushed in pieces of `piece` bytes. */
function encrypt(k: BackupFileKeys, plain: Uint8Array, piece = 333): Uint8Array {
  const enc = new BackupFileEncoder(k);
  const out: Uint8Array[] = [];
  for (let i = 0; i < plain.length; i += piece) out.push(...enc.push(plain.subarray(i, i + piece)));
  out.push(...enc.finish());
  return concat(out);
}

async function decrypt(file: Uint8Array, password = PASSWORD, piece = 517): Promise<Uint8Array> {
  const reader = new BackupFileReader();
  const out: Uint8Array[] = [];
  let unlocked = false;
  for (let i = 0; i < file.length; i += piece) {
    out.push(...reader.push(file.subarray(i, i + piece)));
    if (!unlocked && reader.header) {
      out.push(...(await reader.unlock(password, { kdf: smallKdf })));
      unlocked = true;
    }
  }
  if (!unlocked) out.push(...(await reader.unlock(password, { kdf: smallKdf })));
  out.push(...reader.finish());
  return concat(out);
}

const smallKdf: BackupKdf = (pw, salt, p) =>
  argon2id(pw, salt, { m: p.memoryKiB, t: p.passes, p: p.parallelism, dkLen: 32 });

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof BackupFileError) return e.code;
    throw e;
  }
  return 'ok';
}

describe('backup container (CT-335)', () => {
  it('writes a 110-byte header with nothing but crypto parameters in plaintext', async () => {
    const k = await keys();
    const h = k.header.bytes;
    expect(h.length).toBe(BACKUP_HEADER_BYTES);
    expect([...h.subarray(0, 8)]).toEqual([0x89, 0x57, 0x42, 0x4b, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parsed = parseBackupHeader(h);
    expect(parsed.kdf).toEqual(SMALL);
    expect(parsed.chunkBytes).toBe(1024);
    expect(parsed.hash).toEqual(sha256(h));
    expect(backupHeaderLength(h.subarray(0, 5))).toBe(12);
    expect(backupHeaderLength(h)).toBe(110);
  });

  it('round-trips bodies of many shapes, pushed in any pieces', async () => {
    const k = await keys();
    for (const n of [0, 1, 1023, 1024, 1025, 2048, 5000, 10 * 1024 + 17]) {
      const plain = bytes(n, n + 1);
      for (const piece of [1, 100, 1024, 4096]) {
        if (n > 3000 && piece === 1) continue;
        const file = encrypt(k, plain, piece);
        expect(file.length, `size ${n}`).toBe(backupFileSize(n, 1024));
        expect(await decrypt(file, PASSWORD, piece + 3), `n=${n} piece=${piece}`).toEqual(plain);
      }
    }
  });

  it('handles many chunks without holding the body (a multi-GB-shaped stream)', async () => {
    const k = await keys(1024);
    const enc = new BackupFileEncoder(k);
    const dec = new BackupFileDecoder(k);
    const piece = bytes(1024 * 3 + 5, 3);
    let plainIn = 0;
    let plainOut = 0;
    let first = true;
    // 4 000 pieces ≈ 12 MiB in 12 000 chunks; neither side ever holds more than one chunk.
    for (let i = 0; i < 4000; i++) {
      for (let out of enc.push(piece)) {
        if (first) {
          out = out.subarray(BACKUP_HEADER_BYTES);
          first = false;
        }
        for (const p of dec.push(out)) plainOut += p.length;
      }
      plainIn += piece.length;
    }
    for (const out of enc.finish()) for (const p of dec.push(out)) plainOut += p.length;
    for (const p of dec.finish()) plainOut += p.length;
    expect(plainOut).toBe(plainIn);
    expect(enc.bytesOut).toBe(backupFileSize(plainIn, 1024));
  });

  it('refuses a wrong password before trying any chunk', async () => {
    const file = encrypt(await keys(), bytes(3000));
    expect(await code(decrypt(file, 'not the password'))).toBe('wrong_password');
    const header = parseBackupHeader(file);
    expect(await code(unlockBackupFile(header, 'not the password', { kdf: smallKdf }))).toBe(
      'wrong_password',
    );
  });

  it('normalizes the password (NFC), so the same word typed anywhere opens it', async () => {
    const composed = 'café-password-1';
    const decomposed = 'café-password-1';
    expect(backupPasswordBytes(composed)).toEqual(backupPasswordBytes(decomposed));
    const file = encrypt(await keys(1024, composed), bytes(100));
    expect(await decrypt(file, decomposed)).toEqual(bytes(100));
  });

  it('needs a password of at least 10 characters', async () => {
    expect(backupPasswordOk('123456789')).toBe(false);
    expect(backupPasswordOk('1234567890')).toBe(true);
    expect(backupPasswordOk('ééééééééé')).toBe(false);
    expect(await code(createBackupFileKeys('short', { params: SMALL }))).toBe('password_too_short');
  });

  it('detects truncation at a chunk boundary, mid-chunk and in the header', async () => {
    const file = encrypt(await keys(), bytes(3000));
    // header + 2 full chunks + the last: cut after the second full chunk.
    const full = BACKUP_HEADER_BYTES + 2 * (1024 + BACKUP_TAG_BYTES);
    expect(await code(decrypt(file.subarray(0, full)))).toBe('damaged');
    expect(await code(decrypt(file.subarray(0, full + 50)))).toBe('damaged');
    expect(await code(decrypt(file.subarray(0, file.length - 1)))).toBe('damaged');
    expect(await code(decrypt(file.subarray(0, BACKUP_HEADER_BYTES)))).toBe('damaged');
    expect(await code(decrypt(file.subarray(0, 50)))).toBe('damaged');
    expect(await code(decrypt(new Uint8Array(0)))).toBe('not_backup_file');
  });

  it('detects reordered, dropped, repeated and altered chunks and extra bytes', async () => {
    const file = encrypt(await keys(), bytes(4000));
    const c = 1024 + BACKUP_TAG_BYTES;
    const head = file.subarray(0, BACKUP_HEADER_BYTES);
    const chunk = (i: number) =>
      file.subarray(BACKUP_HEADER_BYTES + i * c, BACKUP_HEADER_BYTES + (i + 1) * c);
    const last = file.subarray(BACKUP_HEADER_BYTES + 3 * c);
    expect(await code(decrypt(concat([head, chunk(1), chunk(0), chunk(2), last])))).toBe('damaged');
    expect(await code(decrypt(concat([head, chunk(0), chunk(2), last])))).toBe('damaged');
    expect(await code(decrypt(concat([head, chunk(0), chunk(0), chunk(1), chunk(2), last])))).toBe('damaged');
    const altered = file.slice();
    altered[BACKUP_HEADER_BYTES + c + 10] = (altered[BACKUP_HEADER_BYTES + c + 10] as number) ^ 1;
    expect(await code(decrypt(altered))).toBe('damaged');
    expect(await code(decrypt(concat([file, new Uint8Array([0])])))).toBe('damaged');
  });

  it('detects an altered header: checksum, magic, version, and a re-checksummed change', async () => {
    const k = await keys();
    const file = encrypt(k, bytes(2000));
    const flip = (at: number) => {
      const f = file.slice();
      f[at] = (f[at] as number) ^ 1;
      return f;
    };
    expect(await code(decrypt(flip(0)))).toBe('not_backup_file');
    expect(await code(decrypt(flip(30)))).toBe('damaged'); // salt: checksum fails
    expect(await code(decrypt(flip(100)))).toBe('damaged'); // checksum itself
    const newer = file.slice();
    newer[9] = 2;
    expect(await code(decrypt(newer))).toBe('newer_format');
    // A header re-checksummed with another nonce prefix: the key check passes, the AAD and nonces change, chunks fail.
    const forged = encodeBackupHeader({ ...k.header, chunkBytes: 1024, noncePrefix: fixed(16, 3) });
    const swapped = concat([forged, file.subarray(BACKUP_HEADER_BYTES)]);
    expect(await code(decrypt(swapped))).toBe('damaged');
  });

  it('refuses header parameters outside the bounds (an untrusted file can’t ask for a terabyte)', () => {
    const base = { salt: fixed(16, 1), chunkBytes: 1024, noncePrefix: fixed(16, 2), keyCheck: fixed(16, 3) };
    expect(() => encodeBackupHeader({ ...base, kdf: { memoryKiB: 4, passes: 1, parallelism: 1 } })).toThrow();
    expect(() =>
      encodeBackupHeader({ ...base, kdf: { memoryKiB: 2 ** 21, passes: 1, parallelism: 1 } }),
    ).toThrow();
    expect(() => encodeBackupHeader({ ...base, chunkBytes: 100, kdf: SMALL })).toThrow();
    // A forged header that passes its checksum but asks for too much memory.
    const h = encodeBackupHeader({ ...base, kdf: SMALL });
    h[13] = 0x7f; // memory KiB ≈ 2 GiB
    h.set(sha256(h.subarray(0, 78)), 78);
    expect(() => parseBackupHeader(h)).toThrow(BackupFileError);
  });

  it('chunks agree with the IETF construction under the HChaCha20 subkey (a native port is byte-identical)', async () => {
    const k = await keys();
    const subkey = backupChunkSubkey(k.streamKey, k.header.noncePrefix);
    for (const [i, last] of [
      [0, false],
      [1, false],
      [2 ** 40 + 3, true],
    ] as const) {
      const pt = bytes(700, i % 251);
      const a = sealBackupChunk(k, i, last, pt);
      const b = sealBackupChunkIetf(subkey, k.header.hash, i, last, pt);
      expect(b).toEqual(a);
      expect(chacha20poly1305(subkey, backupChunkIetfNonce(i, last), k.header.hash).decrypt(a)).toEqual(pt);
    }
    expect([...backupChunkNonce(fixed(16, 9), 258, true).subarray(16)]).toEqual([0, 0, 0, 0, 0, 1, 2, 1]);
  });

  it('defaults: Argon2id 128 MiB, 3 passes, 1 lane, 64 KiB chunks', () => {
    expect(BACKUP_KDF_DEFAULT).toEqual({ memoryKiB: 131_072, passes: 3, parallelism: 1 });
    expect(BACKUP_CHUNK_BYTES).toBe(65_536);
  });
});
