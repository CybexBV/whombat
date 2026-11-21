/**
 * Byte helpers for backup files: strict UTF-8 without `TextDecoder` (not everywhere core runs), big-endian integers.
 */
import { utf8ToBytes } from '@noble/hashes/utils.js';

/** Strict UTF-8; null on any error. */
export { decodeUtf8OrNull as utf8Decode } from '../text/utf8.js';
export { utf8ToBytes };

export function writeU16(out: Uint8Array, at: number, v: number): void {
  out[at] = (v >>> 8) & 0xff;
  out[at + 1] = v & 0xff;
}

export function writeU32(out: Uint8Array, at: number, v: number): void {
  out[at] = (v >>> 24) & 0xff;
  out[at + 1] = (v >>> 16) & 0xff;
  out[at + 2] = (v >>> 8) & 0xff;
  out[at + 3] = v & 0xff;
}

export function readU16(b: Uint8Array, at: number): number {
  return (((b[at] as number) << 8) | (b[at + 1] as number)) >>> 0;
}

export function readU32(b: Uint8Array, at: number): number {
  return (
    (((b[at] as number) << 24) |
      ((b[at + 1] as number) << 16) |
      ((b[at + 2] as number) << 8) |
      (b[at + 3] as number)) >>>
    0
  );
}

/** Concatenation without a helper import (the inputs are short). */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Constant-time equality of two byte strings of the same length (false for different lengths). */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
