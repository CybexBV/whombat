/** Tar field mechanics only. Callers own entry policy, limits, streaming and filesystem access. */
export const TAR_BLOCK_SIZE = 512;

/** UTF-8 up to the first NUL, or the whole field when there is no terminator. */
export function tarString(data: Buffer, offset = 0, width = data.length - offset): string {
  const field = data.subarray(offset, offset + width);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

export type TarNumberProblem = 'base256' | 'syntax' | 'range';

export interface TarNumberOptions {
  /** `octal-only` validates text after trimming; `reject` refuses any leading high bit before decoding. */
  base256: 'allow' | 'reject' | 'octal-only';
  /** Releases validate the entire padded field; some upstream writers terminate it at the first NUL. */
  termination: 'padding' | 'nul';
  error: (problem: TarNumberProblem) => Error;
}

/** Nonnegative, exactly representable octal or (when allowed) GNU base-256. */
export function parseTarNumber(field: Buffer, options: TarNumberOptions): number {
  const first = field[0] ?? 0;
  if (options.base256 !== 'octal-only' && first & 0x80) {
    if (options.base256 === 'reject') throw options.error('base256');
    if (first & 0x40) throw options.error('range'); // GNU's sign bit: sizes cannot be negative.
    let value = first & 0x7f;
    for (let i = 1; i < field.length; i++) {
      value = value * 256 + (field[i] ?? 0);
      if (!Number.isSafeInteger(value)) throw options.error('range');
    }
    return value;
  }
  const text =
    options.termination === 'nul'
      ? tarString(field).trim()
      : field
          .toString('latin1')
          .replace(/[\0 ]+$/g, '')
          .trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw options.error('syntax');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw options.error('range');
  return value;
}

/** A PAX size; callers may additionally restrict the number of decimal digits. */
export function parsePaxSize(value: string, error: () => Error, maxDigits?: number): number {
  if (!/^[0-9]+$/.test(value) || (maxDigits !== undefined && value.length > maxDigits)) throw error();
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw error();
  return size;
}

/** Header path; whether the prefix is meaningful is a caller policy. */
export function tarPath(header: Buffer, usePrefix: boolean): string {
  const name = tarString(header, 0, 100);
  const prefix = usePrefix ? tarString(header, 345, 155) : '';
  return prefix ? `${prefix}/${name}` : name;
}

/** Unsigned checksum, with the checksum field treated as eight spaces. */
export function tarChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum;
}

export function tarPadding(size: number): number {
  return (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
}

export function paddedTarSize(size: number): number {
  return size + tarPadding(size);
}

export function padTarBuffer(data: Buffer): Buffer {
  const padding = tarPadding(data.length);
  return padding ? Buffer.concat([data, Buffer.alloc(padding)]) : data;
}

function writeString(data: Buffer, value: string, offset: number, width: number): void {
  data.write(value, offset, Math.min(Buffer.byteLength(value), width), 'utf8');
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

export interface UstarHeader {
  name: string;
  mode: number;
  size: number;
  mtime: number;
  typeflag: string;
  linkname?: string;
  prefix?: string;
}

/** A zero-owner ustar header. Callers decide path splitting, PAX use and which values fit. */
export function writeUstarHeader(entry: UstarHeader): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  writeString(header, entry.name, 0, 100);
  writeString(header, octal(entry.mode & 0o7777, 8), 100, 8);
  writeString(header, octal(0, 8), 108, 8);
  writeString(header, octal(0, 8), 116, 8);
  writeString(header, octal(entry.size, 12), 124, 12);
  writeString(header, octal(entry.mtime, 12), 136, 12);
  writeString(header, entry.typeflag, 156, 1);
  if (entry.linkname) writeString(header, entry.linkname, 157, 100);
  writeString(header, 'ustar\0', 257, 6);
  writeString(header, '00', 263, 2);
  if (entry.prefix) writeString(header, entry.prefix, 345, 155);
  writeString(header, `${tarChecksum(header).toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

/** `<length> <key>=<value>\n`, with length counting bytes including its own decimal digits. */
export function writePaxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bytes = Buffer.byteLength(body);
  let length = bytes + 1;
  while (String(length).length + bytes !== length) length = String(length).length + bytes;
  return Buffer.from(`${length}${body}`);
}

export type PaxReadOptions =
  | { format: 'strict'; error: () => Error }
  | {
      /** Existing in-memory and selected-entry readers tolerate incomplete/unknown metadata records. */
      format: 'compatible';
      length: 'decimal-prefix' | 'number';
      minimumLength: 'prefix' | 'positive';
      invalidLength: 'throw' | 'stop';
      error: () => Error;
    };

/** Framing and key/value decoding, with every caller's existing malformed-record policy explicit. */
export function parsePaxRecords(data: Buffer, options: PaxReadOptions): Map<string, string> {
  const out = new Map<string, string>();
  const strict = options.format === 'strict';
  let end = data.length;
  if (strict) while (end > 0 && data[end - 1] === 0) end--;
  let offset = 0;
  while (offset < end) {
    const space = data.indexOf(0x20, offset);
    if (space < 0 || space >= end) {
      if (strict) throw options.error();
      break;
    }
    const text = data.subarray(offset, space).toString(strict ? 'latin1' : 'ascii');
    const length =
      options.format === 'compatible' && options.length === 'decimal-prefix'
        ? Number.parseInt(text, 10)
        : Number(text);
    const minimum =
      options.format === 'compatible' && options.minimumLength === 'prefix' ? space - offset : 0;
    if (
      !Number.isSafeInteger(length) ||
      length <= minimum ||
      offset + length > end ||
      (strict && (!/^[1-9][0-9]*$/.test(text) || data[offset + length - 1] !== 0x0a))
    ) {
      if (options.format === 'compatible' && options.invalidLength === 'stop') break;
      throw options.error();
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    else if (strict) throw options.error();
    offset += length;
  }
  return out;
}
