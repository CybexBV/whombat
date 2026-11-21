/**
 * Strict UTF-8 cases every decoder in core and protocol must agree on: valid bytes with their text, and malformed bytes
 * with the offset of the byte that can't be read (the bad continuation byte, else the start of its sequence). Not
 * exported from the package; protocol's tests read it too.
 */
import { utf8ToBytes } from '@noble/hashes/utils.js';

export interface Utf8ValidCase {
  name: string;
  bytes: Uint8Array;
  text: string;
}

export interface Utf8InvalidCase {
  name: string;
  bytes: Uint8Array;
  offset: number;
}

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...utf8ToBytes(p)] : p)));

const valid = (name: string, text: string): Utf8ValidCase => ({ name, bytes: utf8ToBytes(text), text });

/** Decoders build their text in chunks (8,192 code units, or 4,096 code points); astral characters straddle each edge. */
const CHUNK_EDGES = [4094, 4095, 4096, 8190, 8191, 8192, 8193];

export const UTF8_VALID: readonly Utf8ValidCase[] = [
  valid('empty', ''),
  valid('ascii', 'abc'),
  valid('lowest two-byte U+0080', '\u0080'),
  valid('highest two-byte U+07FF', '\u07ff'),
  valid('lowest three-byte U+0800', '\u0800'),
  valid('last before surrogates U+D7FF', '\ud7ff'),
  valid('first after surrogates U+E000', '\ue000'),
  valid('highest three-byte U+FFFF', '\uffff'),
  valid('lowest four-byte U+10000', '\u{10000}'),
  valid('highest code point U+10FFFF', '\u{10ffff}'),
  valid('mixed', 'é€𝄞 music'),
  valid('byte order mark', '\ufeffhi'),
  valid('NUL', 'a\u0000b'),
  ...CHUNK_EDGES.map((n) => valid(`astral after ${n} ASCII`, `${'a'.repeat(n)}𝄞é€z`)),
  valid('astral runs', '𝄞'.repeat(10_000)),
  valid('long text', 'x'.repeat(20_000)),
];

export const UTF8_INVALID: readonly Utf8InvalidCase[] = [
  { name: 'lone continuation byte', bytes: bytes([0x80]), offset: 0 },
  { name: 'continuation byte after ASCII', bytes: bytes('a', [0xbf]), offset: 1 },
  { name: 'overlong C0', bytes: bytes([0xc0, 0x80]), offset: 0 },
  { name: 'overlong C1', bytes: bytes([0xc1, 0xbf]), offset: 0 },
  { name: 'overlong three-byte E0 80', bytes: bytes([0xe0, 0x80, 0x80]), offset: 0 },
  { name: 'overlong three-byte U+07FF', bytes: bytes([0xe0, 0x9f, 0xbf]), offset: 0 },
  { name: 'overlong four-byte U+FFFF', bytes: bytes([0xf0, 0x8f, 0xbf, 0xbf]), offset: 0 },
  { name: 'high surrogate ED A0 80', bytes: bytes([0xed, 0xa0, 0x80]), offset: 0 },
  { name: 'low surrogate ED BF BF', bytes: bytes([0xed, 0xbf, 0xbf]), offset: 0 },
  { name: 'surrogate pair as two sequences', bytes: bytes([0xed, 0xa0, 0xbd, 0xed, 0xb4, 0x9e]), offset: 0 },
  { name: 'above U+10FFFF F4 90', bytes: bytes([0xf4, 0x90, 0x80, 0x80]), offset: 0 },
  { name: 'lead F5', bytes: bytes([0xf5, 0x80, 0x80, 0x80]), offset: 0 },
  { name: 'lead F8', bytes: bytes([0xf8, 0x88, 0x80, 0x80, 0x80]), offset: 0 },
  { name: 'lead FE', bytes: bytes([0xfe]), offset: 0 },
  { name: 'lead FF', bytes: bytes([0xff]), offset: 0 },
  { name: 'truncated two-byte at the end', bytes: bytes([0xc3]), offset: 0 },
  { name: 'truncated three-byte at the end', bytes: bytes('a', [0xe2, 0x82]), offset: 1 },
  { name: 'truncated four-byte at the end', bytes: bytes('ab', [0xf0, 0x9d, 0x84]), offset: 2 },
  // A sequence running past the end is reported at its start, before its continuation bytes are looked at.
  { name: 'truncated with a bad continuation', bytes: bytes([0xe2, 0x41]), offset: 0 },
  { name: 'bad second byte', bytes: bytes([0xc3, 0x41]), offset: 1 },
  { name: 'bad third byte', bytes: bytes('é', [0xe2, 0x82, 0x41]), offset: 4 },
  { name: 'bad fourth byte', bytes: bytes([0xf0, 0x9d, 0x84, 0x41]), offset: 3 },
  { name: 'error after a long prefix', bytes: bytes('a'.repeat(10_000), [0xff]), offset: 10_000 },
  {
    name: 'error after a chunk edge',
    bytes: bytes('a'.repeat(8191), '𝄞', [0xe2, 0x82, 0x41]),
    offset: 8191 + 4 + 2,
  },
];

/** Strings and the length of their UTF-8 encoding; a lone surrogate counts as U+FFFD (3 bytes), like TextEncoder. */
export const UTF8_BYTE_LENGTHS: readonly (readonly [string, number])[] = [
  ['', 0],
  ['a', 1],
  ['é', 2],
  ['€', 3],
  ['𝄞', 4],
  ['\ud800', 3],
  ['\udc00', 3],
  ['a\ud800', 4],
  ['\ud800a', 4],
  ['\udc00\ud800', 6],
  ['\ud800\udc00', 4],
  ['x'.repeat(20_000), 20_000],
];
