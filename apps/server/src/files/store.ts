/**
 * Where attachment bytes live (docs/decisions/bp-attachments.md BP-A02, BP-12). `FileStore` is the seam an
 * S3-compatible backend would implement; `LocalFileStore` is the one that ships: a directory (default
 * `$WHOMBAT_HOME/files`, mode 0700) with content-addressed blobs `sha256/ab/cd/<sha256>` (0600) and a
 * `.staging` area for uploads in flight.
 *
 * Keys come only from sha256 hashes, never from file names. Writes are atomic (exclusive temp file, fsync,
 * rename, directory fsync); every open refuses symlinks (`O_NOFOLLOW`) and checks the real parent directory
 * is inside the store's real root, so a planted link cannot point a read or write outside it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, type ReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Readable } from 'node:stream';

/** Bytes received for an upload, hashed while written; not visible to readers until `commit`. */
export interface StagedFile {
  /** Opaque handle for `commit` / `discard`. */
  readonly token: string;
  readonly size: number;
  readonly sha256: string;
}

export interface StageOptions {
  /** Refuse (and discard) the upload as soon as it passes this many bytes. */
  maxBytes: number;
  /** Sees every chunk in order (sniffing, UTF-8 checks). */
  observe?: (chunk: Buffer) => void;
  signal?: AbortSignal;
}

/** Thrown by `stage` when the body passes `maxBytes`. */
export class TooManyBytes extends Error {
  constructor(readonly limit: number) {
    super(`more than ${limit} bytes`);
    this.name = 'TooManyBytes';
  }
}

export interface BlobInfo {
  key: string;
  size: number;
  /** Last modification (ms since epoch). */
  mtimeMs: number;
}

/**
 * Storage for attachment bytes. Implementations must make `commit` atomic and idempotent (committing bytes
 * whose key exists drops the staged copy), and `delete` idempotent.
 */
export interface FileStore {
  stage(
    source: Readable | Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    options: StageOptions,
  ): Promise<StagedFile>;
  commit(staged: StagedFile, key: string): Promise<void>;
  discard(staged: StagedFile): Promise<void>;
  /** A read stream over the whole blob or an inclusive byte range; null when the blob is missing. */
  open(key: string, range?: { start: number; end: number }): Promise<Readable | null>;
  /** Size of a blob, or null when it is missing. */
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
  /** Every blob (for the sweep). */
  list(): AsyncIterable<BlobInfo>;
  /** Removes staged files older than `olderThanMs` (uploads that died with the process). */
  sweepStaging(olderThanMs: number, now?: number): Promise<number>;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The key of a blob: `sha256/ab/cd/<sha256>`. */
export function blobKey(sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error('not a sha256');
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

const KEY = /^sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;
const STAGING = '.staging';
const TOKEN = /^[0-9a-f-]{36}$/;

export class LocalFileStore implements FileStore {
  readonly root: string;
  #realRoot: string | null = null;

  constructor(root: string) {
    this.root = root;
  }

  /** The store's real root, created (0700) on first use. */
  async #base(): Promise<string> {
    if (this.#realRoot) return this.#realRoot;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory()) throw new Error(`${this.root} is not a directory`);
    this.#realRoot = await realpath(this.root);
    await mkdir(join(this.#realRoot, STAGING), { recursive: true, mode: 0o700 });
    return this.#realRoot;
  }

  /** Makes (0700) and checks a directory inside the root: its real path must stay inside. */
  async #dir(base: string, rel: string): Promise<string> {
    const path = join(base, rel);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const real = await realpath(path);
    if (real !== path || relative(base, real).startsWith('..')) throw new Error('file store path escapes');
    return real;
  }

  #path(base: string, key: string): string {
    if (!KEY.test(key)) throw new Error('invalid file key');
    return join(base, ...key.split('/'));
  }

  #staged(base: string, token: string): string {
    if (!TOKEN.test(token)) throw new Error('invalid staging token');
    return join(base, STAGING, token);
  }

  async stage(
    source: Readable | Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    options: StageOptions,
  ): Promise<StagedFile> {
    const base = await this.#base();
    const token = randomUUID();
    const path = this.#staged(base, token);
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash('sha256');
    let size = 0;
    let ok = false;
    try {
      for await (const part of source) {
        options.signal?.throwIfAborted();
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        size += chunk.length;
        if (size > options.maxBytes) throw new TooManyBytes(options.maxBytes);
        hash.update(chunk);
        options.observe?.(chunk);
        await handle.write(chunk);
      }
      options.signal?.throwIfAborted();
      await handle.sync();
      ok = true;
    } finally {
      await handle.close().catch(() => {});
      if (!ok) await unlink(path).catch(() => {});
    }
    return { token, size, sha256: hash.digest('hex') };
  }

  async commit(staged: StagedFile, key: string): Promise<void> {
    const base = await this.#base();
    const from = this.#staged(base, staged.token);
    const to = this.#path(base, key);
    const dir = await this.#dir(base, dirname(key));
    const existing = await lstat(to).catch(() => null);
    if (existing) {
      if (!existing.isFile()) throw new Error('file store entry is not a file');
      await unlink(from).catch(() => {});
      return;
    }
    await rename(from, to);
    const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async discard(staged: StagedFile): Promise<void> {
    const base = await this.#base();
    await unlink(this.#staged(base, staged.token)).catch(() => {});
  }

  async #openFile(key: string): Promise<{ path: string; size: number } | null> {
    const base = await this.#base();
    const path = this.#path(base, key);
    const dir = await realpath(dirname(path)).catch(() => null);
    if (!dir || dir !== dirname(path)) return null;
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) return null;
    return { path, size: info.size };
  }

  async open(key: string, range?: { start: number; end: number }): Promise<Readable | null> {
    const file = await this.#openFile(key);
    if (!file) return null;
    // O_NOFOLLOW: a link swapped in after the check is refused, not followed.
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) return null;
    const stream: ReadStream = createReadStream('', {
      fd: handle,
      ...(range ? { start: range.start, end: range.end } : {}),
    });
    return stream;
  }

  async size(key: string): Promise<number | null> {
    return (await this.#openFile(key))?.size ?? null;
  }

  async delete(key: string): Promise<void> {
    const base = await this.#base();
    await rm(this.#path(base, key), { force: true });
  }

  async *list(): AsyncIterable<BlobInfo> {
    const base = await this.#base();
    const top = join(base, 'sha256');
    for (const a of await readdir(top).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{2}$/.test(a)) continue;
      for (const b of await readdir(join(top, a)).catch(() => [] as string[])) {
        if (!/^[0-9a-f]{2}$/.test(b)) continue;
        for (const name of await readdir(join(top, a, b)).catch(() => [] as string[])) {
          const key = `sha256/${a}/${b}/${name}`;
          if (!KEY.test(key)) continue;
          const info = await stat(join(top, a, b, name)).catch(() => null);
          if (info?.isFile()) yield { key, size: info.size, mtimeMs: info.mtimeMs };
        }
      }
    }
  }

  async sweepStaging(olderThanMs: number, now = Date.now()): Promise<number> {
    const base = await this.#base();
    let removed = 0;
    for (const name of await readdir(join(base, STAGING)).catch(() => [] as string[])) {
      if (!TOKEN.test(name)) continue;
      const path = join(base, STAGING, name);
      const info = await lstat(path).catch(() => null);
      if (info && now - info.mtimeMs > olderThanMs) {
        await rm(path, { force: true });
        removed++;
      }
    }
    return removed;
  }
}
