/**
 * Page sets (docs/decisions/page-sets.md): a folder of pages the agent shows the person — mockups, a report, screenshots
 * with captions, a small static site — kept as one file on a message. The file is a ZIP whose entries are stored as they
 * are (no compression), so a viewer reads one file of it by its byte range through the session, without the rest.
 * `.whombat/pages.json` says what it is and where it opens; `.whombat/cover.png` is a picture of that page.
 *
 * Pure (no DOM, no Node): the runner writes the file with `zipStored`, the server checks its directory with
 * `zipDirectory`, the web and phone apps read files out of it the same way and resolve a page's links with
 * `resolvePageRef`.
 */
import { z } from 'zod';
import { decodeUtf8OrNull, encodeUtf8, utf8ByteLength } from './utf8.js';

/** A page set's content type: older apps see a ZIP to download. */
export const PAGES_CONTENT_TYPE = 'application/vnd.whombat.pages+zip';
/** Whombat's own entries of a page set. */
export const PAGES_DIR = '.whombat';
export const PAGES_MANIFEST = '.whombat/pages.json';
export const PAGES_COVER = '.whombat/cover.png';
/** At most this many files and bytes of the folder in one page set. */
export const PAGES_MAX_FILES = 2000;
/** 240 MB of the folder keeps the whole file (with its headers, cover and manifest) within the 250 MB file limit. */
export const PAGES_MAX_BYTES = 240 * 1024 * 1024;
/** The page a set opens on when the agent names none. */
export const PAGES_DEFAULT_OPEN = 'index.html';
/** At most this many problems are told (and kept in the manifest). */
export const PAGES_MAX_PROBLEMS = 20;
export const PAGES_TITLE_MAX = 80;
const PATH_MAX = 1000;

/** A path inside a page set: `/`-separated, no `.`/`..` parts, no leading slash. */
export const PageSetPath = z
  .string()
  .min(1)
  .max(PATH_MAX)
  .refine((p) => cleanPagePath(p) === p, 'A path inside the folder, like index.html or round-2/index.html');

/** `.whombat/pages.json`: what the set is called, where it opens, what is in it and what its check found. */
export const PageSetManifest = z.object({
  v: z.literal(1),
  title: z.string().min(1).max(PAGES_TITLE_MAX),
  open: PageSetPath,
  /** The folder's files (Whombat's own entries not counted) and how many of them are pages. */
  files: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  /** Whether `.whombat/cover.png` is there. */
  cover: z.boolean(),
  /** Links the check found broken (for the agent, never shown to the person). */
  problems: z.array(z.string().max(300)).max(PAGES_MAX_PROBLEMS).default([]),
});
export type PageSetManifest = z.infer<typeof PageSetManifest>;

/** Whether a file is a page set. */
export function isPageSet(file: { contentType: string }): boolean {
  return file.contentType === PAGES_CONTENT_TYPE;
}

/** A page set's title from its file name (“Council mockups.zip” → “Council mockups”). */
export function pageSetTitle(name: string): string {
  return name.replace(/\.zip$/i, '') || name;
}

/** The file name a page set gets from its title. */
export function pageSetFileName(title: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PAGES_TITLE_MAX);
  return `${clean || 'Pages'}.zip`;
}

/* Paths --------------------------------------------------------------------------------------------- */

/**
 * `path` as a path inside a set (`a/./b/../c.html` → `a/c.html`), or null when it isn't one: empty, a part above the
 * top, a backslash, a control character, or longer than the contract allows.
 */
export function cleanPagePath(path: string): string | null {
  const parts = pathParts(path);
  return parts?.length ? parts.join('/') : null;
}

/** The parts of a path inside a set (none: its top), or null when it isn't one. */
function pathParts(path: string): string[] | null {
  if (path.length > PATH_MAX || path.includes('\\') || /\p{Cc}/u.test(path)) return null;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts;
}

/** Whether a path is a page (an HTML file). */
export function isPagePath(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** Whether a path is one of Whombat's own entries, not the folder's. */
export function isPagesOwnPath(path: string): boolean {
  return path === PAGES_DIR || path.startsWith(`${PAGES_DIR}/`);
}

/** What a link in a page points at: a file of the set (with its `#…`), the same page's anchor, or somewhere else. */
export type PageRef =
  | { kind: 'file'; path: string; hash: string }
  | { kind: 'same'; hash: string }
  | { kind: 'outside' };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Where `ref` (an `href` or `src`) in the file at `from` points inside the set: relative to `from`'s folder, `/…` from
 * the top of the set; a folder means its `index.html`. A URL with a scheme (`https:`, `data:`, `mailto:`), `//host` or a
 * path above the top is `outside`.
 */
export function resolvePageRef(from: string, ref: string): PageRef {
  const raw = ref.trim();
  if (raw === '' || raw.startsWith('#')) return { kind: 'same', hash: raw };
  if (SCHEME.test(raw) || raw.startsWith('//')) return { kind: 'outside' };
  const hashAt = raw.indexOf('#');
  const hash = hashAt >= 0 ? raw.slice(hashAt) : '';
  let rest = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const queryAt = rest.indexOf('?');
  if (queryAt >= 0) rest = rest.slice(0, queryAt);
  if (rest === '') return { kind: 'same', hash };
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // A stray % stays as it is.
  }
  const folder = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  const parts = pathParts(rest.startsWith('/') ? rest : `${folder}${rest}`);
  if (parts === null) return { kind: 'outside' };
  // `dir/`, `.` and `..` name a folder: its index page.
  if (parts.length === 0) return fileRef(PAGES_DEFAULT_OPEN, hash);
  const path = parts.join('/');
  return fileRef(/(^|\/)\.{0,2}$/.test(rest) ? `${path}/${PAGES_DEFAULT_OPEN}` : path, hash);
}

const fileRef = (path: string, hash: string): PageRef => ({ kind: 'file', path, hash });

/**
 * The file a link to `path` opens, as a static site serves it: the path itself, else `path.html`, else
 * `path/index.html`; null when the set has none of them.
 */
export function pageFileFor(has: (path: string) => boolean, path: string): string | null {
  for (const candidate of [path, `${path}.html`, `${path}/${PAGES_DEFAULT_OPEN}`])
    if (has(candidate)) return candidate;
  return null;
}

const TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  xml: 'application/xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  zip: 'application/zip',
  cbz: 'application/vnd.comicbook+zip',
};

/** A file's type from its extension (`application/octet-stream` for anything else). */
export function pageFileType(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

/** Whether a file of a set shows in the viewer as a picture of its own (a link to it opens it there). */
export function isPageImage(path: string): boolean {
  return /^image\//.test(pageFileType(path));
}

/* The ZIP --------------------------------------------------------------------------------------------- */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const END_SIZE = 22;
/** Names are UTF-8 (general purpose bit 11). */
const UTF8_FLAG = 0x0800;
/** Made by Unix, ZIP 2.0; needs 2.0. */
const MADE_BY = (3 << 8) | 20;
const NEEDS = 20;
/** A regular file, rw-r--r--, in the upper half of the external attributes. */
const FILE_MODE = 0o100644 * 0x10000;

/** The bytes from the end of a set a viewer reads first: its end record and, nearly always, its whole directory. */
export const ZIP_TAIL_BYTES = 256 * 1024;
/** The most a directory of `PAGES_MAX_FILES` (plus Whombat's own) may take. */
export const ZIP_DIRECTORY_MAX = (PAGES_MAX_FILES + 2) * (CENTRAL_SIZE + PATH_MAX * 3);

let crcTable: Uint32Array | null = null;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/** The CRC-32 a ZIP keeps for a file. */
export function crc32(bytes: Uint8Array): number {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (t[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A moment as a ZIP's DOS time and date (local fields, taken in UTC; 1980 at the earliest). */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

export interface ZipInput {
  path: string;
  bytes: Uint8Array;
}

/**
 * A ZIP of `files` with every entry stored as it is, in order, as the parts to send one after another (no part copies a
 * file's bytes). Paths must be clean (`cleanPagePath`); a set stays far below ZIP64's limits.
 */
export function zipStored(files: readonly ZipInput[], at: Date = new Date()): Uint8Array[] {
  const { time, date } = dosTime(at);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encodeUtf8(file.path);
    const crc = crc32(file.bytes);
    const size = file.bytes.length;
    const local = new Uint8Array(LOCAL_SIZE + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, LOCAL, true);
    l.setUint16(4, NEEDS, true);
    l.setUint16(6, UTF8_FLAG, true);
    l.setUint16(8, 0, true);
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, size, true);
    l.setUint32(22, size, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    local.set(name, LOCAL_SIZE);
    parts.push(local, file.bytes);

    const entry = new Uint8Array(CENTRAL_SIZE + name.length);
    const c = new DataView(entry.buffer);
    c.setUint32(0, CENTRAL, true);
    c.setUint16(4, MADE_BY, true);
    c.setUint16(6, NEEDS, true);
    c.setUint16(8, UTF8_FLAG, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.length, true);
    c.setUint16(30, 0, true);
    c.setUint16(32, 0, true);
    c.setUint16(34, 0, true);
    c.setUint16(36, 0, true);
    c.setUint32(38, FILE_MODE >>> 0, true);
    c.setUint32(42, offset, true);
    entry.set(name, CENTRAL_SIZE);
    central.push(entry);
    offset += local.length + size;
  }
  const directorySize = central.reduce((n, e) => n + e.length, 0);
  const end = new Uint8Array(END_SIZE);
  const e = new DataView(end.buffer);
  e.setUint32(0, END, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);
  return [...parts, ...central, end];
}

/** One file of a set, from its directory. */
export interface ZipEntry {
  path: string;
  /** Where its local header starts. */
  offset: number;
  size: number;
  crc: number;
}

/** Where a set's directory is, from its end record. */
export interface ZipEnd {
  directoryOffset: number;
  directorySize: number;
  count: number;
}

/**
 * The end record in the last bytes of a ZIP of `total` bytes (`tail` ends where the file ends), or null when there is
 * none or it describes something a page set never is (several disks, ZIP64, a directory past the end).
 */
export function zipEnd(tail: Uint8Array, total: number): ZipEnd | null {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let at = tail.length - END_SIZE; at >= 0 && at >= tail.length - END_SIZE - 0xffff; at--) {
    if (view.getUint32(at, true) !== END) continue;
    const comment = view.getUint16(at + 20, true);
    if (at + END_SIZE + comment !== tail.length) continue;
    const disk = view.getUint16(at + 4, true);
    const directoryDisk = view.getUint16(at + 6, true);
    const onDisk = view.getUint16(at + 8, true);
    const count = view.getUint16(at + 10, true);
    const directorySize = view.getUint32(at + 12, true);
    const directoryOffset = view.getUint32(at + 16, true);
    if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) return null;
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return null;
    const endAt = total - (tail.length - at);
    if (directoryOffset + directorySize > endAt) return null;
    return { directoryOffset, directorySize, count };
  }
  return null;
}

/**
 * The entries of a set's directory (`bytes` is exactly the directory), or why not: a page set's entries are stored
 * (method 0), not encrypted, with clean, unique paths that lie before the directory.
 */
export function zipEntries(bytes: Uint8Array, end: ZipEnd): ZipEntry[] | { error: string } {
  if (bytes.length !== end.directorySize) return { error: 'The directory is cut short.' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let at = 0;
  for (let i = 0; i < end.count; i++) {
    if (at + CENTRAL_SIZE > bytes.length || view.getUint32(at, true) !== CENTRAL)
      return { error: 'The directory is damaged.' };
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const stored = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    if (flags & 0x1) return { error: 'An entry is encrypted.' };
    if (method !== 0 || stored !== size) return { error: 'An entry is compressed.' };
    const nameEnd = at + CENTRAL_SIZE + nameLength;
    if (nameEnd > bytes.length) return { error: 'The directory is damaged.' };
    const path = decodeUtf8OrNull(bytes.subarray(at + CENTRAL_SIZE, nameEnd));
    if (path === null) return { error: 'An entry’s name isn’t text.' };
    if (cleanPagePath(path) !== path)
      return { error: `${path.slice(0, 100)} isn’t a path inside the folder.` };
    if (seen.has(path)) return { error: `${path.slice(0, 100)} is in it twice.` };
    seen.add(path);
    if (offset + LOCAL_SIZE + nameLength + size > end.directoryOffset)
      return { error: 'An entry lies outside the file.' };
    entries.push({ path, offset, size, crc });
    at = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/**
 * The byte range to read for an entry's bytes, its local header included (`[start, end)`), when the local header is as
 * `zipStored` writes it (the name, no extra field); `zipEntryData` says when it wasn't.
 */
export function zipEntryRange(entry: ZipEntry): { start: number; end: number } {
  const name = utf8ByteLength(entry.path);
  return { start: entry.offset, end: entry.offset + LOCAL_SIZE + name + entry.size };
}

/**
 * An entry's bytes out of the bytes read at its `zipEntryRange`; `{ dataAt }` (where its bytes really start) when its
 * local header carries an extra field, so the caller reads `[dataAt, dataAt + size)`; null when the header isn't the
 * entry's.
 */
export function zipEntryData(entry: ZipEntry, read: Uint8Array): Uint8Array | { dataAt: number } | null {
  if (read.length < LOCAL_SIZE) return null;
  const view = new DataView(read.buffer, read.byteOffset, read.byteLength);
  if (view.getUint32(0, true) !== LOCAL || view.getUint16(8, true) !== 0) return null;
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const start = LOCAL_SIZE + nameLength + extraLength;
  if (extraLength > 0) return { dataAt: entry.offset + start };
  if (read.length < start + entry.size) return null;
  return read.subarray(start, start + entry.size);
}
