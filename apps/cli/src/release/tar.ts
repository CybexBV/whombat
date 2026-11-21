/**
 * Gzipped tar archives, written and read here rather than by the host's `tar` (docs/decisions/bp-distribution.md
 * BP-F07): releases must come out byte-for-byte the same on every build (sorted entries, fixed times and
 * owners), and archives we unpack — releases and backups someone hands us — must never write outside the
 * directory they are unpacked into. POSIX ustar with pax headers for long paths and big files; regular files,
 * directories and — only where the kind of archive has them (a release's library links, BP-F12) — relative
 * symlinks. Every number in a header must parse (BP-F14).
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import {
  TAR_BLOCK_SIZE as BLOCK,
  tarString as cString,
  writeUstarHeader as header,
  padTarBuffer as padded,
  parsePaxRecords,
  parsePaxSize,
  parseTarNumber,
  writePaxRecord as paxRecord,
  tarChecksum,
  tarPadding,
  tarPath,
} from '@whombat/node-io/tar';

export type TarEntryType = 'file' | 'directory' | 'symlink';

export interface TarEntryHeader {
  /** Relative, `/`-separated; directories without a trailing slash. */
  path: string;
  type: TarEntryType;
  mode: number;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  linkname?: string;
}

/* Writing ------------------------------------------------------------------------------------------ */

const fits = (s: string, width: number) => Buffer.byteLength(s) < width && /^[\x20-\x7e]*$/.test(s);

/** Header blocks for an entry: a pax header first when the path, link or size don't fit ustar. */
export function headerBlocks(entry: TarEntryHeader): Buffer[] {
  const typeflag = entry.type === 'file' ? '0' : entry.type === 'directory' ? '5' : '2';
  const name = entry.type === 'directory' ? `${entry.path}/` : entry.path;
  const pax: Buffer[] = [];
  if (!fits(name, 100)) pax.push(paxRecord('path', name));
  if (entry.linkname && !fits(entry.linkname, 100)) pax.push(paxRecord('linkpath', entry.linkname));
  if (entry.size > 0o77777777777) pax.push(paxRecord('size', String(entry.size)));
  const blocks: Buffer[] = [];
  if (pax.length) {
    const data = Buffer.concat(pax);
    blocks.push(
      header({ name: 'PaxHeader', mode: 0o644, size: data.length, mtime: entry.mtime, typeflag: 'x' }),
      padded(data),
    );
  }
  blocks.push(
    header({
      name: fits(name, 100) ? name : name.slice(-99).replace(/^[^/]*\//, ''),
      mode: entry.mode,
      size: entry.type === 'file' ? Math.min(entry.size, 0o77777777777) : 0,
      mtime: entry.mtime,
      typeflag,
      ...(entry.linkname && fits(entry.linkname, 100) ? { linkname: entry.linkname } : {}),
    }),
  );
  return blocks;
}

async function write(out: Writable, chunk: Buffer): Promise<void> {
  if (!out.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        out.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        out.off('drain', onDrain);
        reject(err);
      };
      out.once('drain', onDrain);
      out.once('error', onError);
    });
  }
}

export interface TarWriterOptions {
  /** mtime of every entry (seconds); default now. */
  mtime?: number;
  /** gzip level (default 9). */
  level?: number;
}

/** Writes a `.tar.gz`; add entries in the order they should appear, then `finish()`. */
export class TarGzWriter {
  readonly #gzip;
  readonly #file: Writable;
  readonly #mtime: number;

  constructor(path: string, options: TarWriterOptions = {}, fileMode = 0o600) {
    this.#mtime = options.mtime ?? Math.floor(Date.now() / 1000);
    this.#gzip = createGzip({ level: options.level ?? 9 });
    this.#file = createWriteStream(path, { mode: fileMode, flags: 'wx' });
    this.#gzip.pipe(this.#file);
  }

  async directory(path: string, mode = 0o755): Promise<void> {
    for (const block of headerBlocks({ path, type: 'directory', mode, size: 0, mtime: this.#mtime }))
      await write(this.#gzip, block);
  }

  async symlink(path: string, target: string): Promise<void> {
    for (const block of headerBlocks({
      path,
      type: 'symlink',
      mode: 0o777,
      size: 0,
      mtime: this.#mtime,
      linkname: target,
    }))
      await write(this.#gzip, block);
  }

  /** A file from memory. Resolves with its sha256. */
  async buffer(path: string, data: Buffer, mode = 0o644): Promise<string> {
    for (const block of headerBlocks({ path, type: 'file', mode, size: data.length, mtime: this.#mtime }))
      await write(this.#gzip, block);
    await write(this.#gzip, padded(data));
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * A file from disk, streamed. Its size is taken when the header is written; a file that changes size
   * while it is read (a log still being written) is an error rather than a corrupt archive.
   */
  async file(path: string, source: string, mode = 0o644): Promise<{ sha256: string; size: number }> {
    const size = lstatSync(source).size;
    for (const block of headerBlocks({ path, type: 'file', mode, size, mtime: this.#mtime }))
      await write(this.#gzip, block);
    const hash = createHash('sha256');
    let written = 0;
    const stream = size > 0 ? (createReadStream(source, { end: size - 1 }) as AsyncIterable<Buffer>) : [];
    for await (const chunk of stream) {
      hash.update(chunk);
      written += chunk.length;
      await write(this.#gzip, chunk);
    }
    if (written !== size)
      throw new Error(`${source} changed while it was archived (${written} of ${size} bytes)`);
    const padding = tarPadding(size);
    if (padding) await write(this.#gzip, Buffer.alloc(padding));
    return { sha256: hash.digest('hex'), size };
  }

  async finish(): Promise<void> {
    await write(this.#gzip, Buffer.alloc(BLOCK * 2));
    this.#gzip.end();
    await finished(this.#file);
  }

  /** Stops writing after a failure (the caller removes the partial file). */
  abort(): void {
    this.#gzip.destroy();
    this.#file.destroy();
  }
}

/* Reading ------------------------------------------------------------------------------------------ */

export class UnsafeArchiveError extends Error {
  override name = 'UnsafeArchiveError';
}

/**
 * An octal header field (NUL/space padded). Anything else — a digit that isn't octal, GNU's base-256 — is a
 * damaged archive (docs/decisions/bp-distribution.md BP-F14): a size that parses to NaN used to spin forever.
 */
function parseOctal(buf: Buffer, offset: number, width: number, what: string): number {
  return parseTarNumber(buf.subarray(offset, offset + width), {
    base256: 'octal-only',
    termination: 'padding',
    error: (problem) =>
      new UnsafeArchiveError(
        problem === 'range'
          ? `corrupt archive (the ${what} field isn’t a valid number)`
          : `corrupt archive (the ${what} field isn’t a number)`,
      ),
  });
}

/** pax extended headers bigger than this are refused (ours hold a path, a link and a size). */
const MAX_PAX_BYTES = 1024 * 1024;

/** pax records (`<len> <key>=<value>\n`); one that doesn't parse makes the archive damaged (BP-F14). */
export function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of parsePaxRecords(data, {
    format: 'strict',
    error: () => new UnsafeArchiveError('corrupt archive (a pax header record doesn’t parse)'),
  }))
    out[key] = value;
  return out;
}

/** A path inside an archive, normalized; throws for absolute paths and `..`. */
export function safeEntryPath(raw: string): string {
  const path = raw.replace(/\/+$/, '');
  if (!path || isAbsolute(path) || path.includes('\0'))
    throw new UnsafeArchiveError(`unsafe path in archive: ${raw}`);
  const norm = normalize(path);
  if (norm === '.' || norm.split(sep).includes('..') || norm !== path.split('/').join(sep))
    throw new UnsafeArchiveError(`unsafe path in archive: ${raw}`);
  return path;
}

/** Whether a symlink at `path` pointing at `target` stays inside the archive's root. */
export function symlinkStaysInside(path: string, target: string): boolean {
  if (isAbsolute(target)) return false;
  const resolved = normalize(join(dirname(path), target));
  return !(resolved === '..' || resolved.startsWith(`..${sep}`)) && !isAbsolute(resolved);
}

/**
 * Whether the link `path -> target` goes through a link in `links` on its way (BP-F12): step by step, as the
 * kernel resolves it, not lexically — `e -> l/..` with `l -> .` normalizes to `.` but is the parent on disk.
 * A target that is itself a link (a chain) counts too. Also true when it climbs above the root.
 */
export function linkPassesThroughLink(path: string, target: string, links: ReadonlySet<string>): boolean {
  const parts = [...path.split('/').slice(0, -1), ...target.split('/')];
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!stack.length) return true;
      stack.pop();
      continue;
    }
    stack.push(part);
    if (links.has(stack.join('/'))) return true;
  }
  return false;
}

export interface ExtractedEntry extends TarEntryHeader {
  /** sha256 of the file's bytes (files only). */
  sha256?: string;
}

export interface ExtractOptions {
  /** Refuse archives that unpack to more than this many bytes (default 64 GiB). */
  maxBytes?: number;
  /** File mode on disk from the archive's mode: default 0o644 / 0o755 (group and others never write). */
  fileMode?: (mode: number) => number;
  dirMode?: number;
  /**
   * The symlinks this kind of archive may hold (path in the archive, target); any other is refused. Default:
   * none (backups, support bundles). Releases allow their library links (`releaseArchiveLink`).
   */
  allowLink?: (path: string, target: string) => boolean;
}

/**
 * Unpacks `archive` (`.tar.gz`) into `dest` (created; must be empty or new). Refuses absolute paths, `..`,
 * links the caller doesn't allow, links that point outside or through another link, hard links, devices,
 * anything that would go through a symlink it unpacked, and headers whose numbers don't parse. The caller
 * removes `dest` when it throws.
 */
export async function extractTarGz(
  archive: string,
  dest: string,
  options: ExtractOptions = {},
): Promise<ExtractedEntry[]> {
  const input = createReadStream(archive).pipe(createGunzip());
  return extractTarStream(input, dest, options);
}

interface OpenFile {
  entry: ExtractedEntry;
  fd: number;
  remaining: number;
  pad: number;
  hash: ReturnType<typeof createHash>;
}

export async function extractTarStream(
  input: Readable,
  dest: string,
  options: ExtractOptions = {},
): Promise<ExtractedEntry[]> {
  mkdirSync(dest, { recursive: true, mode: options.dirMode ?? 0o755 });
  const root = realpathSync(dest);
  const maxBytes = options.maxBytes ?? 64 * 1024 ** 3;
  const fileMode = options.fileMode ?? ((m: number) => (m & 0o111 ? 0o755 : 0o644));
  const dirMode = options.dirMode ?? 0o755;
  const entries: ExtractedEntry[] = [];
  const links = new Set<string>();
  let total = 0;
  let pending = Buffer.alloc(0);
  let pax: Record<string, string> = {};
  let ended = false;
  // The file being written.
  let current = null as OpenFile | null;
  let skip = 0; // padding still to skip
  let paxData: Buffer[] = [];
  let paxRemaining = 0;
  let paxGlobal = false;
  let paxPad = 0;

  const target = (path: string) => {
    for (const link of links)
      if (path === link || path.startsWith(`${link}/`))
        throw new UnsafeArchiveError(`archive writes through a link it made: ${path}`);
    return resolve(root, path);
  };

  const inside = (real: string) => real === root || real.startsWith(`${root}${sep}`);

  const ensureParent = (path: string) => {
    const parent = dirname(resolve(root, path));
    mkdirSync(parent, { recursive: true, mode: dirMode });
    if (!inside(realpathSync(parent)))
      throw new UnsafeArchiveError(`archive path escapes the destination: ${path}`);
  };

  const onHeader = (block: Buffer): void => {
    if (block.every((b) => b === 0)) {
      ended = true;
      return;
    }
    if (tarChecksum(block) !== parseOctal(block, 148, 8, 'checksum'))
      throw new UnsafeArchiveError('corrupt archive (bad header checksum)');
    const typeflag = String.fromCharCode(block[156] as number) || '0';
    let size = parseOctal(block, 124, 12, 'size');
    if (typeflag === 'x' || typeflag === 'g') {
      if (size > MAX_PAX_BYTES) throw new UnsafeArchiveError('corrupt archive (a pax header is too big)');
      paxRemaining = size;
      paxGlobal = typeflag === 'g';
      paxData = [];
      paxPad = tarPadding(size);
      return;
    }
    let name = tarPath(block, true);
    if (pax.path) name = pax.path;
    let linkname = cString(block, 157, 100);
    if (pax.linkpath) linkname = pax.linkpath;
    if (pax.size !== undefined)
      size = parsePaxSize(
        pax.size,
        () => new UnsafeArchiveError('corrupt archive (a pax size isn’t a valid number)'),
      );
    pax = {};
    const mode = parseOctal(block, 100, 8, 'mode');
    const mtime = parseOctal(block, 136, 12, 'mtime');
    const path = safeEntryPath(name);
    if (typeflag === '5') {
      const dir = target(path);
      ensureParent(path);
      mkdirSync(dir, { recursive: true, mode: dirMode });
      entries.push({ path, type: 'directory', mode, size: 0, mtime });
      return;
    }
    if (typeflag === '2') {
      if (!options.allowLink?.(path, linkname))
        throw new UnsafeArchiveError(`archive holds a link it shouldn’t: ${path} -> ${linkname}`);
      if (!symlinkStaysInside(path, linkname))
        throw new UnsafeArchiveError(`link points outside the archive: ${path} -> ${linkname}`);
      if (linkPassesThroughLink(path, linkname, links))
        throw new UnsafeArchiveError(`link goes through another link: ${path} -> ${linkname}`);
      const at = target(path);
      ensureParent(path);
      symlinkSync(linkname, at);
      links.add(path);
      entries.push({ path, type: 'symlink', mode: 0o777, size: 0, mtime, linkname });
      return;
    }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '7')
      throw new UnsafeArchiveError(`unsupported entry in archive (type ${typeflag}): ${path}`);
    total += size;
    if (total > maxBytes) throw new UnsafeArchiveError(`archive unpacks to more than ${maxBytes} bytes`);
    const at = target(path);
    ensureParent(path);
    const fd = openSync(at, 'wx', 0o600);
    const entry: ExtractedEntry = { path, type: 'file', mode, size, mtime };
    current = {
      entry,
      fd,
      remaining: size,
      pad: tarPadding(size),
      hash: createHash('sha256'),
    };
    if (size === 0) closeCurrent();
  };

  const closeCurrent = () => {
    if (!current) return;
    fchmodSync(current.fd, fileMode(current.entry.mode));
    closeSync(current.fd);
    current.entry.sha256 = current.hash.digest('hex');
    entries.push(current.entry);
    skip = current.pad;
    current = null;
  };

  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      let data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      pending = Buffer.alloc(0);
      while (data.length && !ended) {
        if (paxRemaining > 0) {
          const take = data.subarray(0, paxRemaining);
          paxData.push(take);
          data = data.subarray(take.length);
          paxRemaining -= take.length;
          if (paxRemaining === 0) {
            // Global headers (`g`) are read and ignored: nothing in them changes where or what we write.
            const records = parsePax(Buffer.concat(paxData));
            if (!paxGlobal) pax = { ...pax, ...records };
            paxData = [];
            skip = paxPad;
          }
          continue;
        }
        if (skip > 0) {
          const n = Math.min(skip, data.length);
          skip -= n;
          data = data.subarray(n);
          continue;
        }
        if (current) {
          const n = Math.min(current.remaining, data.length);
          const part = data.subarray(0, n);
          writeSync(current.fd, part);
          current.hash.update(part);
          current.remaining -= n;
          data = data.subarray(n);
          if (current.remaining === 0) closeCurrent();
          continue;
        }
        if (data.length < BLOCK) {
          pending = Buffer.from(data);
          break;
        }
        onHeader(data.subarray(0, BLOCK));
        data = data.subarray(BLOCK);
      }
      if (ended) break;
    }
  } finally {
    if (current) closeSync(current.fd);
    input.destroy();
  }
  // Every archive we read ends with the two zero blocks; without them it was cut short.
  if (!ended) throw new UnsafeArchiveError('the archive ends in the middle (truncated?)');
  // The links once more, now that all of them exist: none through another (a later link can sit on an
  // earlier one's way), and each resolves — as the kernel does it — to something inside the root.
  for (const e of entries) {
    if (e.type !== 'symlink') continue;
    if (linkPassesThroughLink(e.path, e.linkname as string, links))
      throw new UnsafeArchiveError(`link goes through another link: ${e.path} -> ${e.linkname}`);
    let real: string;
    try {
      real = realpathSync.native(resolve(root, e.path));
    } catch {
      throw new UnsafeArchiveError(`link points at nothing in the archive: ${e.path} -> ${e.linkname}`);
    }
    if (!inside(real) || real === root)
      throw new UnsafeArchiveError(`link points outside the archive: ${e.path} -> ${e.linkname}`);
  }
  return entries;
}

/** Whether `path` (absolute) is a regular file once every link on the way is followed. */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
