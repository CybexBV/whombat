/**
 * The runner's cache of the conversations' Files (docs/decisions/files-space.md FS-09, FS-R02): checked bytes by sha256,
 * so a file a turn needs again — every commands turn of a conversation gets all of its Files — is fetched once. Private
 * to the runner: `<workspaces>/.files-cache`, 0700, inside the workspaces root every guarded sandbox denies; never
 * shared itself. A turn's tree hardlinks the cached files (read-only for its commands) or copies them (a scratch folder,
 * which the agent may write).
 *
 * Bounded (`WHOMBAT_FILES_CACHE_BYTES`, default 10 GiB): after each new file the least recently used ones go (a file's
 * mtime is when a turn last used it) until the cache fits again, never one a turn holds (`get` until `release`: while it
 * links or copies it). A tree's hardlink keeps its bytes when the cache lets go of them, until the turn ends. Concurrent
 * turns asking for the same file share one fetch.
 */
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

/** The default bound of the cache (`WHOMBAT_FILES_CACHE_BYTES`). */
export const FILES_CACHE_DEFAULT_BYTES = 10 * 1024 ** 3;

/** The cache's directory in the workspaces root. */
export const FILES_CACHE_DIR = '.files-cache';

const SHA256 = /^[0-9a-f]{64}$/;

/** What the cache knows of one file. */
interface Entry {
  size: number;
  usedAt: number;
}

export interface CachedFile {
  /** Where the checked bytes are (0400, never to be written). */
  path: string;
  /** Lets the file go: it may be evicted again once no turn holds it. */
  release(): void;
}

export class FilesCache {
  readonly root: string;
  readonly maxBytes: number;
  readonly #now: () => number;
  #entries: Map<string, Entry> | null = null;
  #loading: Promise<Map<string, Entry>> | null = null;
  readonly #held = new Map<string, number>();
  readonly #fetching = new Map<string, Promise<void>>();

  constructor(options: { root: string; maxBytes?: number; now?: () => number }) {
    this.root = options.root;
    this.maxBytes = options.maxBytes ?? FILES_CACHE_DEFAULT_BYTES;
    this.#now = options.now ?? Date.now;
  }

  /** Where a file's bytes are kept: `<root>/<first two hex>/<sha256>`. */
  pathOf(sha256: string): string {
    if (!SHA256.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  /** Bytes the cache holds now (after it was read once). */
  get bytes(): number {
    let n = 0;
    for (const e of this.#entries?.values() ?? []) n += e.size;
    return n;
  }

  /**
   * The file with these bytes, held for the caller until `release()`: from the cache, or written by `fetch` into a
   * private temporary path first (which must check size and sha256, and throw when they don't match).
   */
  async get(
    file: { sha256: string; size: number },
    fetch: (path: string) => Promise<void>,
  ): Promise<CachedFile> {
    const sha = file.sha256;
    const path = this.pathOf(sha);
    this.#hold(sha);
    let released = false;
    const held: CachedFile = {
      path,
      release: () => {
        if (released) return;
        released = true;
        this.#let(sha);
      },
    };
    try {
      const entries = await this.#load();
      const had = entries.get(sha);
      if (had && had.size === file.size && (await this.#present(path, file.size))) {
        await this.#touch(sha, path);
        return held;
      }
      let pending = this.#fetching.get(sha);
      if (!pending) {
        pending = this.#fetchInto(sha, file.size, path, fetch).finally(() => this.#fetching.delete(sha));
        this.#fetching.set(sha, pending);
      }
      await pending;
      await this.#evict();
      return held;
    } catch (err) {
      held.release();
      throw err;
    }
  }

  async #fetchInto(
    sha: string,
    size: number,
    path: string,
    fetch: (path: string) => Promise<void>,
  ): Promise<void> {
    await mkdir(join(this.root, '.tmp'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, sha.slice(0, 2)), { recursive: true, mode: 0o700 });
    const tmp = join(this.root, '.tmp', `${sha.slice(0, 16)}-${randomBytes(6).toString('hex')}`);
    try {
      await fetch(tmp);
      const s = await lstat(tmp);
      if (!s.isFile() || s.size !== size) throw new Error(`${sha}: the fetched file has the wrong size`);
      await chmod(tmp, 0o400);
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
    (await this.#load()).set(sha, { size, usedAt: this.#now() });
  }

  async #present(path: string, size: number): Promise<boolean> {
    const s = await lstat(path).catch(() => null);
    return !!s && s.isFile() && s.size === size;
  }

  async #touch(sha: string, path: string): Promise<void> {
    const now = this.#now();
    const e = this.#entries?.get(sha);
    if (e) e.usedAt = now;
    await utimes(path, now / 1000, now / 1000).catch(() => {});
  }

  #hold(sha: string): void {
    this.#held.set(sha, (this.#held.get(sha) ?? 0) + 1);
  }

  #let(sha: string): void {
    const n = (this.#held.get(sha) ?? 1) - 1;
    if (n > 0) this.#held.set(sha, n);
    else this.#held.delete(sha);
  }

  /** The least recently used files out until the cache fits (never one a turn holds). */
  async #evict(): Promise<void> {
    const entries = await this.#load();
    let total = this.bytes;
    if (total <= this.maxBytes) return;
    const oldest = [...entries.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [sha, e] of oldest) {
      if (total <= this.maxBytes) break;
      if (this.#held.has(sha) || this.#fetching.has(sha)) continue;
      await rm(this.pathOf(sha), { force: true });
      entries.delete(sha);
      total -= e.size;
    }
  }

  /** What is in the cache, read once (a runner that restarts finds what it kept; stray temporary files go). */
  #load(): Promise<Map<string, Entry>> {
    if (this.#entries) return Promise.resolve(this.#entries);
    this.#loading ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const s = await lstat(this.root);
      if (!s.isDirectory() || (typeof process.getuid === 'function' && s.uid !== process.getuid()))
        throw new Error(`${this.root} isn’t a directory of this runner`);
      if ((s.mode & 0o077) !== 0) await chmod(this.root, 0o700);
      await rm(join(this.root, '.tmp'), { recursive: true, force: true });
      const entries = new Map<string, Entry>();
      for (const dir of await readdir(this.root).catch(() => [] as string[])) {
        if (!/^[0-9a-f]{2}$/.test(dir)) continue;
        for (const name of await readdir(join(this.root, dir)).catch(() => [] as string[])) {
          if (!SHA256.test(name) || name.slice(0, 2) !== dir) continue;
          const f = await stat(join(this.root, dir, name)).catch(() => null);
          if (f?.isFile()) entries.set(name, { size: f.size, usedAt: f.mtimeMs });
        }
      }
      this.#entries = entries;
      return entries;
    })().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }
}
