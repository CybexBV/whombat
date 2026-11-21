/**
 * The backup file's container with Node's native crypto (docs/decisions/backup-file.md BF-06, BF-D02): the same bytes
 * as core's `BackupFileEncoder` / `BackupFileDecoder` (contracts CT-335 prove them against vectors), sealed and opened
 * with `crypto.argon2` and `chacha20-poly1305` under the file's HChaCha20 subkey (`backupChunkSubkey`), so a file of
 * gigabytes costs the server native speed. Incremental: at most one chunk is held.
 */
import { argon2, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  BACKUP_TAG_BYTES,
  BackupFileError,
  type BackupFileHeader,
  type BackupFileKeys,
  type BackupKdf,
  backupChunkIetfNonce,
  backupChunkSubkey,
  type CreateBackupKeysOptions,
  createBackupFileKeys,
  unlockBackupFile,
} from '@whombat/core';

/** Argon2id through Node (`crypto.argon2`), byte-identical with `@noble/hashes` (CT-335 vectors). */
export const nativeBackupKdf: BackupKdf = (password, salt, params) =>
  new Promise<Uint8Array>((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: password,
        nonce: salt,
        parallelism: params.parallelism,
        tagLength: 32,
        memory: params.memoryKiB,
        passes: params.passes,
      },
      (err, key) => (err ? reject(err) : resolve(new Uint8Array(key))),
    );
  });

/** A new file's keys for `password` (native Argon2id). */
export function newBackupKeys(
  password: string,
  options: Omit<CreateBackupKeysOptions, 'kdf'> = {},
): Promise<BackupFileKeys> {
  return createBackupFileKeys(password, { ...options, kdf: nativeBackupKdf });
}

/** The keys of an existing file (native Argon2id); `wrong_password` when its key check doesn't match. */
export function unlockBackup(header: BackupFileHeader, password: string): Promise<BackupFileKeys> {
  return unlockBackupFile(header, password, { kdf: nativeBackupKdf });
}

function seal(subkey: Uint8Array, aad: Uint8Array, index: number, last: boolean, plain: Uint8Array): Buffer {
  const c = createCipheriv('chacha20-poly1305', subkey, backupChunkIetfNonce(index, last), {
    authTagLength: BACKUP_TAG_BYTES,
  });
  c.setAAD(aad, { plaintextLength: plain.length });
  const body = c.update(plain);
  c.final();
  return Buffer.concat([body, c.getAuthTag()]);
}

function open(subkey: Uint8Array, aad: Uint8Array, index: number, last: boolean, sealed: Uint8Array): Buffer {
  if (sealed.length < BACKUP_TAG_BYTES) throw new BackupFileError('damaged', `chunk ${index}`);
  const n = sealed.length - BACKUP_TAG_BYTES;
  const d = createDecipheriv('chacha20-poly1305', subkey, backupChunkIetfNonce(index, last), {
    authTagLength: BACKUP_TAG_BYTES,
  });
  d.setAAD(aad, { plaintextLength: n });
  d.setAuthTag(sealed.subarray(n));
  try {
    const body = d.update(sealed.subarray(0, n));
    d.final();
    return body;
  } catch {
    throw new BackupFileError('damaged', `chunk ${index}${last ? ' (last)' : ''}`);
  }
}

/** `BackupFileEncoder` with native ChaCha20-Poly1305: `push` plaintext, then `finish` once; the header comes first. */
export class NativeBackupEncoder {
  private readonly subkey: Uint8Array;
  private readonly buf: Buffer;
  private fill = 0;
  private index = 0;
  private headerSent = false;
  private done = false;

  constructor(private readonly keys: BackupFileKeys) {
    this.subkey = backupChunkSubkey(keys.streamKey, keys.header.noncePrefix);
    this.buf = Buffer.alloc(keys.header.chunkBytes);
  }

  private start(out: Buffer[]) {
    if (this.headerSent) return;
    this.headerSent = true;
    out.push(Buffer.from(this.keys.header.bytes));
  }

  push(data: Uint8Array): Buffer[] {
    if (this.done) throw new Error('backup encoder: finished');
    const out: Buffer[] = [];
    this.start(out);
    let off = 0;
    while (off < data.length) {
      if (this.fill === this.buf.length) {
        out.push(seal(this.subkey, this.keys.header.hash, this.index++, false, this.buf));
        this.fill = 0;
      }
      const n = Math.min(this.buf.length - this.fill, data.length - off);
      this.buf.set(data.subarray(off, off + n), this.fill);
      this.fill += n;
      off += n;
    }
    return out;
  }

  finish(): Buffer[] {
    if (this.done) throw new Error('backup encoder: finished');
    const out: Buffer[] = [];
    this.start(out);
    out.push(seal(this.subkey, this.keys.header.hash, this.index++, true, this.buf.subarray(0, this.fill)));
    this.done = true;
    this.buf.fill(0);
    this.subkey.fill(0);
    return out;
  }
}

/** `BackupFileDecoder` with native ChaCha20-Poly1305: hands out only authenticated plaintext; `finish` opens the last. */
export class NativeBackupDecoder {
  private readonly subkey: Uint8Array;
  private readonly buf: Buffer;
  private fill = 0;
  private index = 0;
  private done = false;

  constructor(private readonly keys: BackupFileKeys) {
    this.subkey = backupChunkSubkey(keys.streamKey, keys.header.noncePrefix);
    this.buf = Buffer.alloc(keys.header.chunkBytes + BACKUP_TAG_BYTES);
  }

  push(data: Uint8Array): Buffer[] {
    if (this.done) throw new BackupFileError('damaged', 'bytes after the last chunk');
    const out: Buffer[] = [];
    let off = 0;
    while (off < data.length) {
      if (this.fill === this.buf.length) {
        out.push(open(this.subkey, this.keys.header.hash, this.index++, false, this.buf));
        this.fill = 0;
      }
      const n = Math.min(this.buf.length - this.fill, data.length - off);
      this.buf.set(data.subarray(off, off + n), this.fill);
      this.fill += n;
      off += n;
    }
    return out;
  }

  finish(): Buffer[] {
    if (this.done) throw new Error('backup decoder: finished');
    if (this.fill < BACKUP_TAG_BYTES) throw new BackupFileError('damaged', 'truncated');
    const last = open(
      this.subkey,
      this.keys.header.hash,
      this.index++,
      true,
      this.buf.subarray(0, this.fill),
    );
    this.done = true;
    this.subkey.fill(0);
    return [last];
  }
}
