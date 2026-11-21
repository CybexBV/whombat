/**
 * What this browser holds between opening a link and finishing its journey (AP-591), on the shared expiring records
 * (AP-590). Each secret came in a page's fragment and was taken out of the address bar at once; it waits in
 * `localStorage` (the magic link opens in a new tab, whose `sessionStorage` is empty) for at most:
 *
 * - an add-a-device link (AP-66): 7 days;
 * - a card's claim secret (AP-47) and a `/signup` invite code (AP-161): an hour.
 *
 * No invite, organization invitation or link to get back in any more: a Whombat is one person's (one-person.md
 * AP-5674).
 *
 * Every one goes as soon as its journey ends or is left, when the Whombat it names is forgotten, and on sign-out and
 * account deletion (`forgetHeld`): it was this browser's user's, not the next one's. The records' shapes are those
 * of the link parsers; anything else is dropped. Records from before AP-590 (`{…, at}`) keep working until their old
 * expiry. The appliance's and control's own checks (expiry, one-time use, who may use it) stay what counts.
 */
import { isPeerId } from '@whombat/client/managed';
import { expiringRecord, type KeyValueStorage } from '@whombat/client/storage';
import { isClaimSecret, normalizeClaimSecret } from '@whombat/protocol/session';
import { z } from 'zod';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const LINK_HELD_MS = 7 * DAY;
export const CLAIM_CARD_HELD_MS = HOUR;
export const SIGNUP_CODE_HELD_MS = HOUR;

const Device = z.string().min(1).max(256);
const PeerId = z.string().refine(isPeerId);
export const HeldAddDevice = z.object({ device: Device, peerId: PeerId.nullable() });
export const HeldClaimCard = z.object({
  device: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  secret: z.string().refine((s) => isClaimSecret(normalizeClaimSecret(s))),
});
export const HeldSignupCode = z.object({ code: z.string().min(1).max(64) });

/** The browser's `localStorage`: reaching it may throw (a sandboxed frame, storage turned off). */
const local = (): KeyValueStorage => window.localStorage;

/** The held records, on this browser's storage and clock (tests pass their own). */
export function heldRecords({
  storage = local,
  now = () => Date.now(),
}: {
  storage?: () => KeyValueStorage;
  now?: () => number;
} = {}) {
  const record = <T>(key: string, schema: z.ZodType<T>, ttlMs: number) =>
    // Before AP-590 each was `{…, at}`, held for the same time as now.
    expiringRecord({ storage, now, key, schema, ttlMs, legacy: { ttlMs } });
  return {
    addDevice: record('whombat:add-device-link', HeldAddDevice, LINK_HELD_MS),
    claimCard: record('whombat:claim-card', HeldClaimCard, CLAIM_CARD_HELD_MS),
    signupCode: record('whombat:signup-code', HeldSignupCode, SIGNUP_CODE_HELD_MS),
  };
}

export type HeldRecords = ReturnType<typeof heldRecords>;

export const held: HeldRecords = heldRecords();

/** Sign-out and account deletion: every held link, card and code goes. */
export function forgetHeld(records: HeldRecords = held): void {
  for (const r of Object.values(records)) r.clear();
}

/** A Whombat forgotten on this browser (AP-66): the links that name it go. */
export function forgetHeldFor(device: string, records: HeldRecords = held): void {
  records.addDevice.clear((v) => v.device === device);
}

/** The `/signup#code=` invite code (AP-125, AP-161), until the organization is created. */
export function heldSignupCode(now = Date.now()): string | null {
  return heldRecords({ now: () => now }).signupCode.read()?.code ?? null;
}
export function holdSignupCode(code: string | null): void {
  if (code === null) held.signupCode.clear();
  else held.signupCode.hold({ code });
}
