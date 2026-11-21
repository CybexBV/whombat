/**
 * Page sets in the apps (Whombat docs/decisions/page-sets.md): reading one file of a set out of its ZIP by its byte
 * range (`PageSetReader`), and the app's side of the viewer's frame (`PageSetHost`, the frame's side is `pages-runtime.js`).
 * The web and the phone each give the reader a way to read a range of the set's file (the session's download stream)
 * and the host a way to send to their frame; everything else is here.
 */
import {
  isPageImage,
  isPagePath,
  PAGES_MANIFEST,
  type PageSetManifest,
  PageSetManifest as PageSetManifestSchema,
  pageFileFor,
  pageFileType,
  ZIP_DIRECTORY_MAX,
  ZIP_TAIL_BYTES,
  type ZipEntry,
  zipEnd,
  zipEntries,
  zipEntryData,
  zipEntryRange,
} from '@whombat/core';
import { decodeUtf8OrNull } from '@whombat/core/text/utf8';

/** Reads `[start, end)` of the set's file. */
export type ReadRange = (range: { start: number; end: number }, signal?: AbortSignal) => Promise<Uint8Array>;

export class PageSetError extends Error {}

/** The most bytes of files a viewer keeps read (older ones are read again when needed). */
const CACHE_BYTES = 48 * 1024 * 1024;
/** At most this many reads at once. */
const READS_AT_ONCE = 4;

/**
 * A page set's files, read when asked for: its directory first (from the end of the file), then each file by its own
 * range, kept a while. `size` is the set's file size (`Attachment.size`).
 */
export class PageSetReader {
  readonly #read: ReadRange;
  readonly #size: number;
  #entries: Promise<Map<string, ZipEntry>> | null = null;
  readonly #cache = new Map<string, Promise<Uint8Array>>();
  readonly #sizes = new Map<string, number>();
  #cached = 0;
  #running = 0;
  readonly #queue: (() => void)[] = [];

  constructor(read: ReadRange, size: number) {
    this.#read = read;
    this.#size = size;
  }

  /** Every file of the set by its path. */
  entries(): Promise<Map<string, ZipEntry>> {
    this.#entries ??= this.#index().catch((err: unknown) => {
      this.#entries = null;
      throw err;
    });
    return this.#entries;
  }

  async #index(): Promise<Map<string, ZipEntry>> {
    const start = Math.max(0, this.#size - ZIP_TAIL_BYTES);
    const tail = await this.#ranged({ start, end: this.#size });
    const end = zipEnd(tail, this.#size);
    if (!end) throw new PageSetError('This isn’t a set of pages.');
    if (end.directorySize > ZIP_DIRECTORY_MAX) throw new PageSetError('This set has too many files to open.');
    const directory =
      end.directoryOffset >= start
        ? tail.subarray(end.directoryOffset - start, end.directoryOffset - start + end.directorySize)
        : await this.#ranged({ start: end.directoryOffset, end: end.directoryOffset + end.directorySize });
    const entries = zipEntries(directory, end);
    if (!Array.isArray(entries)) throw new PageSetError('This set of pages is damaged.');
    return new Map(entries.map((e) => [e.path, e]));
  }

  /** What the set says about itself, or null when it says nothing readable. */
  async manifest(): Promise<PageSetManifest | null> {
    const bytes = await this.file(PAGES_MANIFEST).catch(() => null);
    if (!bytes) return null;
    try {
      const parsed = PageSetManifestSchema.safeParse(JSON.parse(decodeUtf8OrNull(bytes) ?? ''));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Whether the set has a file at `path`. */
  async has(path: string): Promise<boolean> {
    return (await this.entries()).has(path);
  }

  /** A file's bytes; null when the set has no such file. */
  async file(path: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    const entry = (await this.entries()).get(path);
    if (!entry) return null;
    const held = this.#cache.get(path);
    if (held) {
      // Read lately: to the back of the queue of what is let go first.
      this.#cache.delete(path);
      this.#cache.set(path, held);
      return held;
    }
    const reading = this.#readEntry(entry, signal);
    this.#cache.set(path, reading);
    reading.then(
      (bytes) => this.#keep(path, bytes.length),
      () => this.#cache.delete(path),
    );
    return reading;
  }

  async #readEntry(entry: ZipEntry, signal?: AbortSignal): Promise<Uint8Array> {
    const range = zipEntryRange(entry);
    const read = await this.#ranged(range, signal);
    const data = zipEntryData(entry, read);
    if (data instanceof Uint8Array) return data;
    if (data === null) throw new PageSetError('This set of pages is damaged.');
    return this.#ranged({ start: data.dataAt, end: data.dataAt + entry.size }, signal);
  }

  #keep(path: string, bytes: number): void {
    this.#sizes.set(path, bytes);
    this.#cached += bytes;
    for (const [old] of this.#cache) {
      if (this.#cached <= CACHE_BYTES) break;
      if (old === path) continue;
      this.#cache.delete(old);
      this.#cached -= this.#sizes.get(old) ?? 0;
      this.#sizes.delete(old);
    }
  }

  /** One read, at most `READS_AT_ONCE` at a time. */
  async #ranged(range: { start: number; end: number }, signal?: AbortSignal): Promise<Uint8Array> {
    if (range.end <= range.start) return new Uint8Array(0);
    if (this.#running >= READS_AT_ONCE) await new Promise<void>((go) => this.#queue.push(go));
    this.#running += 1;
    try {
      return await this.#read(range, signal);
    } finally {
      this.#running -= 1;
      this.#queue.shift()?.();
    }
  }
}

/* The viewer ------------------------------------------------------------------------------------- */

/** What the viewer's frame says (`pages-runtime.js`). */
export type PagesFrameMessage =
  | { type: 'whombat.pages.ready' }
  | { type: 'whombat.pages.need'; id: number; path: string }
  | { type: 'whombat.pages.open'; path: string; hash: string; query: string }
  | { type: 'whombat.pages.external'; url: string }
  | { type: 'whombat.pages.shown'; path: string; title: string }
  | { type: 'whombat.pages.failed'; path: string }
  | { type: 'whombat.pages.escape' };

/** What the app says to the frame. */
export type PagesHostMessage =
  | { type: 'whombat.pages.show'; path: string; hash: string; query?: string }
  | {
      type: 'whombat.pages.file';
      id: number;
      ok: true;
      contentType: string;
      bytes?: ArrayBuffer;
      base64?: string;
    }
  | { type: 'whombat.pages.file'; id: number; ok: false };

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** A message from the frame, read strictly (the page in it can post anything); null for anything else. */
export function pagesFrameMessage(data: unknown): PagesFrameMessage | null {
  let m = data;
  if (typeof m === 'string') {
    if (!m.startsWith('{"type":"whombat.pages.')) return null;
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'whombat.pages.ready':
      return { type: o.type };
    case 'whombat.pages.need':
      return Number.isSafeInteger(o.id) && str(o.path, 1000)
        ? { type: o.type, id: o.id as number, path: o.path }
        : null;
    case 'whombat.pages.open':
      return str(o.path, 1000)
        ? {
            type: o.type,
            path: o.path,
            hash: str(o.hash, 1000) ? o.hash : '',
            query: str(o.query, 2000) && /^(\?|$)/.test(o.query) ? o.query : '',
          }
        : null;
    case 'whombat.pages.external':
      return str(o.url, 2000) && /^https?:\/\//i.test(o.url) ? { type: o.type, url: o.url } : null;
    case 'whombat.pages.shown':
      return str(o.path, 1000)
        ? { type: o.type, path: o.path, title: str(o.title, 300) ? o.title : '' }
        : null;
    case 'whombat.pages.failed':
      return str(o.path, 1000) ? { type: o.type, path: o.path } : null;
    case 'whombat.pages.escape':
      return { type: o.type };
    default:
      return null;
  }
}

/** What opening a link of the set does: show a page or a picture, offer a file, or say it isn't there. */
export type PageTarget =
  | { kind: 'page'; path: string; hash: string }
  | { kind: 'file'; path: string; size: number }
  | { kind: 'missing'; path: string };

/** Where a link to `path` in the set leads (a static site's way: `path`, `path.html`, `path/index.html`). */
export async function pageTarget(reader: PageSetReader, path: string, hash = ''): Promise<PageTarget> {
  const entries = await reader.entries();
  const found = pageFileFor((p) => entries.has(p), path);
  if (!found) return { kind: 'missing', path };
  if (isPagePath(found) || isPageImage(found)) return { kind: 'page', path: found, hash };
  return { kind: 'file', path: found, size: entries.get(found)?.size ?? 0 };
}

/**
 * The app's side of one viewer frame: answers the frame's asks for files of this set and tells the app what the frame
 * wants (`onOpen`, `onExternal`, `onShown`, `onFailed`). `send` delivers a message to the frame; `encoding` says how
 * bytes travel (`buffer`: an ArrayBuffer, transferred; `base64`: a string, for the phone's WebView).
 */
export class PageSetHost {
  readonly #reader: PageSetReader;
  readonly #send: (message: PagesHostMessage, transfer?: ArrayBuffer[]) => void;
  readonly #encoding: 'buffer' | 'base64';
  #closed = false;
  /** A link of the set: its path, `#…` and `?…` (which the page reads from its address). */
  onOpen: (path: string, hash: string, query: string) => void = () => {};
  onExternal: (url: string) => void = () => {};
  onShown: (path: string, title: string) => void = () => {};
  onFailed: (path: string) => void = () => {};
  /** Escape inside the page that the page didn't take. */
  onEscape: () => void = () => {};

  constructor(
    reader: PageSetReader,
    send: (message: PagesHostMessage, transfer?: ArrayBuffer[]) => void,
    encoding: 'buffer' | 'base64' = 'buffer',
  ) {
    this.#reader = reader;
    this.#send = send;
    this.#encoding = encoding;
  }

  /** A message from the frame; `show` is the page this frame is for. Returns whether it was one of the viewer's. */
  handle(data: unknown, show: { path: string; hash: string; query?: string }): boolean {
    const message = pagesFrameMessage(data);
    if (!message || this.#closed) return !!message;
    switch (message.type) {
      case 'whombat.pages.ready':
        this.#send({ type: 'whombat.pages.show', path: show.path, hash: show.hash, query: show.query ?? '' });
        break;
      case 'whombat.pages.need':
        void this.#answer(message.id, message.path);
        break;
      case 'whombat.pages.open':
        this.onOpen(message.path, message.hash, message.query);
        break;
      case 'whombat.pages.external':
        this.onExternal(message.url);
        break;
      case 'whombat.pages.shown':
        this.onShown(message.path, message.title);
        break;
      case 'whombat.pages.failed':
        this.onFailed(message.path);
        break;
      case 'whombat.pages.escape':
        this.onEscape();
        break;
    }
    return true;
  }

  /** No more answers (the frame went). */
  close(): void {
    this.#closed = true;
  }

  async #answer(id: number, path: string): Promise<void> {
    const bytes = await this.#reader.file(path).catch(() => null);
    if (this.#closed) return;
    if (!bytes) {
      this.#send({ type: 'whombat.pages.file', id, ok: false });
      return;
    }
    const contentType = pageFileType(path);
    if (this.#encoding === 'base64') {
      this.#send({ type: 'whombat.pages.file', id, ok: true, contentType, base64: base64Of(bytes) });
      return;
    }
    // A copy of its own, so the reader's cache keeps its bytes when this one is handed over.
    const copy = bytes.slice().buffer as ArrayBuffer;
    this.#send({ type: 'whombat.pages.file', id, ok: true, contentType, bytes: copy }, [copy]);
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of bytes, without `btoa` (no binary strings on the phone), a few thousand bytes per piece. */
export function base64Of(bytes: Uint8Array): string {
  const pieces: string[] = [];
  const at = (n: number) => B64[n & 63] as string;
  for (let from = 0; from < bytes.length; from += 3072) {
    const to = Math.min(bytes.length, from + 3072);
    let piece = '';
    let i = from;
    for (; i + 2 < to; i += 3) {
      const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
      piece += at(n >> 18) + at(n >> 12) + at(n >> 6) + at(n);
    }
    const left = to - i;
    if (left === 1) {
      const n = (bytes[i] as number) << 16;
      piece += `${at(n >> 18)}${at(n >> 12)}==`;
    } else if (left === 2) {
      const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
      piece += `${at(n >> 18)}${at(n >> 12)}${at(n >> 6)}=`;
    }
    pieces.push(piece);
  }
  return pieces.join('');
}

/** A file's name in the set (its last part). */
export function pageFileName(path: string): string {
  return path.split('/').pop() || path;
}
