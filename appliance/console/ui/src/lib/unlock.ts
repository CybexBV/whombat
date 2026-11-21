/**
 * Unlocking the desk (DK-04; appliance CG-42): the PIN pad's digits, Whombat's answer to a PIN, and what the pad says.
 * Whombat holds the unlock and counts the wrong PINs; the page only shows its answers.
 */
import { minutesLeft } from './console';
import { type DeskLock, type DeskPaired, deskErrorCode } from './desk';
import { DESK, DESK_WORDS, fill, wrongPinText } from './deskCopy';

/**
 * The PIN's length (DK-26): 4 to 6 digits, as Whombat says; a runtime from before 0.103 doesn't say, and its PINs
 * have six (DK-34). The pad draws that many dots and sends the PIN at the last one.
 */
export const pinLength = (paired: Pick<DeskPaired, 'pinDigits'>): number => paired.pinDigits ?? 6;

/** The digits after a key: a digit adds one (up to the PIN's length), `delete` takes the last one away. */
export function pressKey(digits: string, key: string, length: number): string {
  if (key === 'delete') return digits.slice(0, -1);
  if (/^[0-9]$/.test(key) && digits.length < length) return digits + key;
  return digits;
}

export type UnlockAnswer =
  | { result: 'unlocked' }
  | { result: 'wrong'; triesLeft: number | null }
  | { result: 'backoff'; retryAt: string | null }
  /** 409 `no_pin`: nobody chose a PIN yet, only the phone unlocks (DK-18). */
  | { result: 'noPin' }
  | { result: 'failed' };

/** `POST /api/desk/unlock`'s answer (§2.3 `DeskUnlockAnswer`); anything else is `failed` (type it again). */
export function parseUnlockAnswer(status: number, body: unknown): UnlockAnswer {
  if (status === 409 && deskErrorCode(body) === 'no_pin') return { result: 'noPin' };
  if (status !== 200 || typeof body !== 'object' || body === null) return { result: 'failed' };
  const b = body as Record<string, unknown>;
  if (b.result === 'unlocked') return { result: 'unlocked' };
  if (b.result === 'wrong') {
    const t = b.triesLeft;
    return {
      result: 'wrong',
      triesLeft: typeof t === 'number' && Number.isFinite(t) ? Math.max(0, Math.floor(t)) : null,
    };
  }
  if (b.result === 'backoff') {
    return { result: 'backoff', retryAt: typeof b.retryAt === 'string' ? b.retryAt : null };
  }
  return { result: 'failed' };
}

/** PINs are refused until then (Whombat's lock state, or the last answer), or null. */
export function backoffUntil(lock: DeskLock, last: UnlockAnswer | null, now: number): string | null {
  const at = lock.state === 'backoff' ? lock.retryAt : last?.result === 'backoff' ? last.retryAt : null;
  if (lock.state === 'backoff' && !at) return new Date(now + 60_000).toISOString();
  if (!at) return null;
  return Date.parse(at) > now ? at : null;
}

/** The line under the dots: the wrong PIN with the tries left, or the wait. */
export function padMessage(lock: DeskLock, last: UnlockAnswer | null, now: number): string | null {
  const wait = backoffUntil(lock, last, now);
  if (wait) return fill(DESK_WORDS.tooManyPins, { m: minutesLeft(wait, now) });
  if (last?.result === 'wrong') {
    return last.triesLeft === null ? DESK.wrongPin : wrongPinText(last.triesLeft);
  }
  return null;
}

/** `POST /api/desk/unlock/phone`'s answer: until when the phone can say yes. */
export function parsePhoneAnswer(status: number, body: unknown): string | null {
  if (status !== 200 || typeof body !== 'object' || body === null) return null;
  const at = (body as Record<string, unknown>).expiresAt;
  return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null;
}
