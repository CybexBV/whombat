/**
 * This browser's passkeys and the nudge's memory (passkeys.md AP-791, AP-794), one of each per page: the sign-in, Set
 * up this device, Settings · Devices and the nudge strip all use them.
 */
import { createPasskeyNudge } from '@whombat/client/managed';
import { webPasskeys } from './passkeys';

export { webAuthnExists } from './passkeys';

export const PASSKEYS = webPasskeys();

/** Local storage, reached when used (it may throw: storage off, a sandboxed frame). */
export const PASSKEY_NUDGE = createPasskeyNudge(() => window.localStorage);
