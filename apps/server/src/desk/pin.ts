/**
 * The desk screen's PIN (docs/decisions/desk-display.md DK-04, DK-26, DK-27; desk-display-server.md DK-S04, DK-S05,
 * DK-S34): 4 to 6 digits, none too easy to guess, stored as scrypt with its own salt (the length beside it, never the
 * digits), compared in constant time; five wrong ones make the screen wait a minute, then twice as long after each
 * further wrong one, at most an hour.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import {
  DESK_PIN_BACKOFF_MAX_S,
  DESK_PIN_RE,
  DESK_TRIES,
  deskPinBackoffS,
  deskPinTooEasy,
  deskTriesLeft,
} from '@whombat/core';

/** Wrong PINs before the screen makes you wait (DK-04). */
export const PIN_FREE_TRIES = DESK_TRIES;
/** The longest wait. */
export const PIN_BACKOFF_MAX_MS = DESK_PIN_BACKOFF_MAX_S * 1000;

/** A PIN chosen before 0124 has no length kept: it is six digits (DK-26). */
export const PIN_DIGITS_BEFORE = 6;

/**
 * Why a new PIN can't be chosen (DK-26, DK-27): `shape` when it isn't 4 to 6 ASCII digits (the ops' schemas refuse
 * that first), `easy_pin` when it is too easy to guess; null when it may be. Checked before it is hashed.
 */
export function newPinRefusal(pin: string): 'shape' | 'easy_pin' | null {
  if (!DESK_PIN_RE.test(pin)) return 'shape';
  return deskPinTooEasy(pin) ? 'easy_pin' : null;
}

/** scrypt's cost: 16 MiB and about 50 ms here, once per unlock. */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_BYTES = 32;

function derive(pin: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pin, salt, KEY_BYTES, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** `scrypt$N$r$p$salt$hash`, base64url. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pin, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Whether `pin` is the one `stored` was made from. A hash it can't read matches nothing. */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length !== KEY_BYTES) return false;
  const key = await derive(pin, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return timingSafeEqual(key, expected);
}

/** How long the screen waits after `wrong` wrong PINs in a row (DK-04; core `deskPinBackoffS`). */
export function pinBackoffMs(wrong: number): number {
  return deskPinBackoffS(wrong) * 1000;
}

/** The tries left before the wait (0 from the fifth wrong PIN on; core `deskTriesLeft`). */
export const pinTriesLeft = deskTriesLeft;
