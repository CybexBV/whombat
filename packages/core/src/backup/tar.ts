/**
 * A minimal streaming POSIX ustar (IEEE Std 1003.1-1988) writer and reader for the backup file's body (CT-335). Pure,
 * incremental over `Uint8Array` pieces: an entry's bytes pass through, never buffered.
 *
 * Only what a backup file needs: regular files (typeflag `0`), names up to 255 bytes (`prefix` + `name`), sizes up to
 * `TAR_ENTRY_MAX_BYTES` (11 octal digits), mode 0644, uid/gid 0, empty user and group names, the end-of-archive marker
 * of two zero blocks. No pax or GNU extensions: a reader refuses them (`damaged`), and refuses unsafe paths (absolute,
 * `..`, empty segments, a backslash or a control character), so unpacking a file never writes outside its folder.
 */
import { utf8Decode, utf8ToBytes } from './bytes.js';
import { BackupFileError } from './errors.js';

export const TAR_BLOCK_BYTES = 512;
/** Largest entry: 11 octal digits. */
export const TAR_ENTRY_MAX_BYTES = 8_589_934_591;
/** Longest path (prefix 155 + `/` + name 100 bytes, UTF-8). */
export const TAR_PATH_MAX_BYTES = 255;

export interface TarEntry {
  /** Path inside the archive (`agents.jsonl`, `files/<sha256>`). */
  name: string;
  size: number;
  /** Modification time, seconds since the epoch. */
  mtime: number;
}

/** Whether a path is one a backup file may hold: relative, `/`-separated, no `.`/`..`, no backslash or controls. */
export function isSafeTarPath(name: string): boolean {
  if (!name || name.startsWith('/') || name.endsWith('/')) return false;
  if (utf8ToBytes(name).length > TAR_PATH_MAX_BYTES) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return false;
  return name.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function writeString(block: Uint8Array, at: number, len: number, value: Uint8Array) {
  if (value.length > len) throw new RangeError('tar: field too long');
  block.set(value, at);
}

function writeOctal(block: Uint8Array, at: number, len: number, value: number) {
  // `len - 1` digits and a NUL.
  const digits = value.toString(8).padStart(len - 1, '0');
  if (digits.length > len - 1) throw new RangeError('tar: number too large');
  block.set(utf8ToBytes(digits), at);
  block[at + len - 1] = 0;
}

/** Splits a path into ustar `prefix` and `name` (≤ 155 and ≤ 100 bytes, split at a `/`). */
function splitPath(path: string): { prefix: Uint8Array; name: Uint8Array } {
  const bytes = utf8ToBytes(path);
  if (bytes.length <= 100) return { prefix: new Uint8Array(0), name: bytes };
  const segments = path.split('/');
  for (let i = segments.length - 1; i > 0; i--) {
    const prefix = utf8ToBytes(segments.slice(0, i).join('/'));
    const name = utf8ToBytes(segments.slice(i).join('/'));
    if (prefix.length <= 155 && name.length <= 100) return { prefix, name };
  }
  throw new RangeError(`tar: path doesn’t fit a ustar header: ${path}`);
}

/** The 512-byte header of a regular file. */
export function tarHeader(entry: TarEntry): Uint8Array {
  if (!isSafeTarPath(entry.name)) throw new RangeError(`tar: unsafe path ${entry.name}`);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > TAR_ENTRY_MAX_BYTES)
    throw new RangeError('tar: size out of range');
  const mtime = Math.max(0, Math.min(0o77777777777, Math.floor(entry.mtime)));
  const { prefix, name } = splitPath(entry.name);
  const h = new Uint8Array(TAR_BLOCK_BYTES);
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, entry.size);
  writeOctal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156); // checksum counts as spaces
  h[156] = 0x30; // '0': regular file
  writeString(h, 257, 6, utf8ToBytes('ustar\0'));
  writeString(h, 263, 2, utf8ToBytes('00'));
  writeString(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  // Six octal digits, NUL, space (the classic layout).
  h.set(utf8ToBytes(sum.toString(8).padStart(6, '0')), 148);
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

/** Zero bytes after an entry of `size` bytes, to the next block boundary (0…511 bytes). */
export function tarPadding(size: number): Uint8Array {
  const rest = size % TAR_BLOCK_BYTES;
  return new Uint8Array(rest === 0 ? 0 : TAR_BLOCK_BYTES - rest);
}

/** The end-of-archive marker: two zero blocks. */
export function tarEnd(): Uint8Array {
  return new Uint8Array(2 * TAR_BLOCK_BYTES);
}

/** One whole entry (header, bytes, padding) for small entries. */
export function tarFile(name: string, data: Uint8Array, mtime = 0): Uint8Array {
  const header = tarHeader({ name, size: data.length, mtime });
  const pad = tarPadding(data.length);
  const out = new Uint8Array(header.length + data.length + pad.length);
  out.set(header, 0);
  out.set(data, header.length);
  return out;
}

/**
 * Writes an archive entry by entry: `begin` (header), `write` (the bytes, passed through), `end` (padding; the bytes
 * written must equal the size announced), and `finish` (end-of-archive). Each returns the bytes to append.
 */
export class TarWriter {
  private open: { name: string; size: number; written: number } | null = null;
  private finished = false;

  begin(entry: TarEntry): Uint8Array {
    if (this.finished || this.open) throw new Error('tar writer: entry still open or finished');
    const header = tarHeader(entry);
    this.open = { name: entry.name, size: entry.size, written: 0 };
    return header;
  }

  write(data: Uint8Array): Uint8Array {
    if (!this.open) throw new Error('tar writer: no entry');
    this.open.written += data.length;
    if (this.open.written > this.open.size)
      throw new RangeError(`tar writer: ${this.open.name} is longer than announced`);
    return data;
  }

  end(): Uint8Array {
    if (!this.open) throw new Error('tar writer: no entry');
    if (this.open.written !== this.open.size)
      throw new RangeError(`tar writer: ${this.open.name} is shorter than announced`);
    const pad = tarPadding(this.open.size);
    this.open = null;
    return pad;
  }

  /** One whole entry. */
  file(name: string, data: Uint8Array, mtime = 0): Uint8Array {
    if (this.finished || this.open) throw new Error('tar writer: entry still open or finished');
    return tarFile(name, data, mtime);
  }

  finish(): Uint8Array {
    if (this.open) throw new Error('tar writer: entry still open');
    this.finished = true;
    return tarEnd();
  }
}

export type TarEvent =
  | { type: 'entry'; entry: TarEntry }
  /** Bytes of the current entry: a view into the pushed piece (copy it to keep it past the next `push`). */
  | { type: 'data'; data: Uint8Array }
  | { type: 'end'; entry: TarEntry };

function readOctal(block: Uint8Array, at: number, len: number): number {
  let i = at;
  const end = at + len;
  while (i < end && block[i] === 0x20) i++;
  let v = 0;
  let digits = 0;
  for (; i < end; i++) {
    const c = block[i] as number;
    if (c === 0 || c === 0x20) break;
    if (c < 0x30 || c > 0x37) throw new BackupFileError('damaged', 'tar number');
    v = v * 8 + (c - 0x30);
    digits++;
  }
  for (; i < end; i++)
    if (block[i] !== 0 && block[i] !== 0x20) throw new BackupFileError('damaged', 'tar number');
  if (digits === 0) throw new BackupFileError('damaged', 'tar number');
  return v;
}

function readName(block: Uint8Array, at: number, len: number): string {
  let end = at;
  while (end < at + len && block[end] !== 0) end++;
  const s = utf8Decode(block.subarray(at, end));
  if (s === null) throw new BackupFileError('damaged', 'tar name');
  return s;
}

function parseHeader(block: Uint8Array): TarEntry {
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_BYTES; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
  if (readOctal(block, 148, 8) !== sum) throw new BackupFileError('damaged', 'tar checksum');
  const magic = utf8Decode(block.subarray(257, 263));
  if (magic !== 'ustar\0' || block[263] !== 0x30 || block[264] !== 0x30)
    throw new BackupFileError('damaged', 'not ustar');
  const type = block[156];
  if (type !== 0x30 && type !== 0) throw new BackupFileError('damaged', `tar type ${type}`);
  const name = readName(block, 0, 100);
  const prefix = readName(block, 345, 155);
  const path = prefix ? `${prefix}/${name}` : name;
  if (!isSafeTarPath(path)) throw new BackupFileError('damaged', 'tar path');
  return { name: path, size: readOctal(block, 124, 12), mtime: readOctal(block, 136, 12) };
}

const isZero = (b: Uint8Array) => b.every((x) => x === 0);

/**
 * Reads an archive incrementally: `push` pieces, get events (`entry`, `data`…, `end` per entry); `finish` checks the
 * archive ended with its marker. Throws `damaged` on a bad header, an unsafe path, bytes after the end, or a short
 * archive.
 */
export class TarReader {
  private block = new Uint8Array(TAR_BLOCK_BYTES);
  private fill = 0;
  private entry: TarEntry | null = null;
  private left = 0;
  private pad = 0;
  private zeros = 0;
  private ended = false;

  push(data: Uint8Array): TarEvent[] {
    const out: TarEvent[] = [];
    let off = 0;
    while (off < data.length) {
      if (this.entry && this.left > 0) {
        const n = Math.min(this.left, data.length - off);
        out.push({ type: 'data', data: data.subarray(off, off + n) });
        this.left -= n;
        off += n;
        if (this.left === 0) {
          out.push({ type: 'end', entry: this.entry });
          this.entry = null;
        }
        continue;
      }
      if (this.pad > 0) {
        const n = Math.min(this.pad, data.length - off);
        for (let i = off; i < off + n; i++)
          if (data[i] !== 0) throw new BackupFileError('damaged', 'tar padding');
        this.pad -= n;
        off += n;
        continue;
      }
      const n = Math.min(TAR_BLOCK_BYTES - this.fill, data.length - off);
      this.block.set(data.subarray(off, off + n), this.fill);
      this.fill += n;
      off += n;
      if (this.fill < TAR_BLOCK_BYTES) continue;
      this.fill = 0;
      if (this.ended) {
        if (!isZero(this.block)) throw new BackupFileError('damaged', 'bytes after the end of the archive');
        continue;
      }
      if (isZero(this.block)) {
        this.zeros++;
        if (this.zeros === 2) this.ended = true;
        continue;
      }
      if (this.zeros > 0) throw new BackupFileError('damaged', 'tar entry after a zero block');
      const entry = parseHeader(this.block);
      out.push({ type: 'entry', entry });
      this.pad = tarPadding(entry.size).length;
      if (entry.size === 0) out.push({ type: 'end', entry });
      else {
        this.entry = entry;
        this.left = entry.size;
      }
    }
    return out;
  }

  /** Throws `damaged` unless the archive ended with its end-of-archive marker. */
  finish(): void {
    if (!this.ended || this.fill !== 0) throw new BackupFileError('damaged', 'tar archive incomplete');
  }
}
