/** Random secrets and their hashes (sessions, login codes, invite and dispatch tokens). */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random secret with a readable prefix: `ws_…` (session), `wt_…` (API token), `wat_…` (agent). */
export function newSecret(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests / strings of equal length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
