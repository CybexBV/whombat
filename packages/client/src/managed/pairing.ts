/**
 * Letting a new device in (MA-04 §5, CT-46), shared by the web and the phone. The new device shows its pairing code
 * and the short fingerprint of its own key (`pairingFingerprint`, `XXXX-XXXX-XXXX`); the approving device looks the
 * code up (`enroll.pair.lookup`), shows which device asked — its name, what kind of device it is and its
 * fingerprint — and approves with the fingerprint it showed, so a mistyped or guessed code can't let a stranger's
 * device in (`pairing_fingerprint_mismatch`).
 */
import { pairingFingerprint } from '@whombat/protocol/session';
import { OperationError } from '../session/managed-ops';
import type { ConnectionState } from '../session/types';

export { pairingFingerprint };

/**
 * The box says this device is in already: it answered the enrollment session on the `app` channel. A box restored from
 * a backup knows the person's devices while they don't know its new identity yet; once a link pinned it, there is
 * nothing to pair, so the device opens it. The account it is in, or null while the session doesn't say so.
 */
export function letInAlready(state: ConnectionState): { accountId: string | null } | null {
  if (state.status !== 'open' || state.info.channel !== 'app') return null;
  return { accountId: state.info.account?.id ?? null };
}

/** A pairing code as the new device shows it (`1234-5678`). */
export const PAIRING_CODE = /^\d{4}-\d{4}$/;

/** Digits only while typing; the dash comes by itself. */
export function formatPairingCodeInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  return digits.length > 4 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : digits;
}

/** What kind of device asked, in plain words. */
export function platformName(platform: string): string {
  switch (platform) {
    case 'web':
      return 'Browser';
    case 'android':
      return 'Android phone';
    case 'ios':
      return 'iPhone or iPad';
    case 'desktop':
      return 'Desktop app';
    case 'cli':
      return 'Command line';
    default:
      return 'Device';
  }
}

export type PairingErrorKey = 'badCode' | 'expired' | 'fingerprintChanged' | 'rateLimited' | 'failed';

/** Which words a failed look-up or approval gets (`MANAGED_TEXT[key]`). */
export function pairingErrorKey(error: unknown): PairingErrorKey {
  if (!(error instanceof OperationError)) return 'failed';
  switch (error.code) {
    case 'pairing_code_invalid':
    case 'invalid_code':
    case 'not_found':
      return 'badCode';
    case 'pairing_expired':
      return 'expired';
    case 'pairing_fingerprint_mismatch':
      return 'fingerprintChanged';
    case 'rate_limited':
      return 'rateLimited';
    default:
      return 'failed';
  }
}
