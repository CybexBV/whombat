/**
 * The phone's passkeys (`PasskeyPlatform`, passkeys.md AP-798, ios-parity.md AP-6320): Android's Credential Manager or
 * iOS's AuthenticationServices through the local Expo module `whombat-passkeys`, WebAuthn JSON in and out. A dismissed prompt is `PasskeyCancelled` (nothing is said);
 * no passkey on this phone is `none`; a provider that already holds one for the Whombat is `exists`.
 */
import {
  isOwnAddressHost,
  type PasskeyAssertionJSON,
  PasskeyCancelled,
  PasskeyError,
  type PasskeyErrorCode,
  type PasskeyPlatform,
  type PasskeyRegistrationJSON,
} from '@whombat/client/managed';
import { fromBase64url, toBase64url } from '@whombat/core/backup';
import { passkeyFailureCode, WhombatPasskeys } from '../../modules/whombat-passkeys';
import { UI_ORIGINS } from './config';

/** A URL's host, or null when there's none to read. */
function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

/** The native rejection in the shared module's words. */
export function phonePasskeyFailure(error: unknown): Error {
  const code = passkeyFailureCode(error);
  if (code === 'cancelled') return new PasskeyCancelled();
  const known: PasskeyErrorCode[] = ['exists', 'none', 'unsupported'];
  return new PasskeyError(known.includes(code as PasskeyErrorCode) ? (code as PasskeyErrorCode) : 'failed');
}

/**
 * The PRF output of an assertion answer (`clientExtensionResults.prf.results.first`, base64url) and which passkey gave
 * it; null when the passkey or its manager left PRF out.
 */
export function prfOfAssertion(
  raw: unknown,
): { credentialId: string; output: Uint8Array | null; userHandle?: string } | null {
  const answer = raw as {
    id?: unknown;
    response?: { userHandle?: unknown };
    clientExtensionResults?: { prf?: { results?: { first?: unknown } } };
  } | null;
  const first = answer?.clientExtensionResults?.prf?.results?.first;
  if (typeof answer?.id !== 'string') return null;
  const bytes = typeof first === 'string' ? fromBase64url(first) : null;
  const output = bytes?.length === 32 ? bytes : null;
  const userHandle = typeof answer.response?.userHandle === 'string' ? answer.response.userHandle : undefined;
  return { credentialId: answer.id, output, ...(userHandle && { userHandle }) };
}

/**
 * The request for a PRF evaluation (AP-6855): an assertion of one of `credentialIds` with WebAuthn's `prf` extension.
 * The challenge is random and nobody verifies the signature: only the PRF output is used, to lock or open the kit.
 */
export function prfRequest(input: {
  rpId: string;
  credentialIds: readonly string[];
  salt: Uint8Array;
  challenge: Uint8Array;
}): Record<string, unknown> {
  return {
    challenge: toBase64url(input.challenge),
    rpId: input.rpId,
    allowCredentials: input.credentialIds.map((id) => ({ id, type: 'public-key' })),
    userVerification: 'required',
    timeout: 120_000,
    extensions: { prf: { eval: { first: toBase64url(input.salt) } } },
  };
}

export function phonePasskeys(
  native: typeof WhombatPasskeys = WhombatPasskeys,
  rpId: string | null = hostOf(UI_ORIGINS[0]),
): PasskeyPlatform {
  return {
    isAvailable: async () => native.supported(),
    // No autofill of passkeys in an app's email field here: the button is the way.
    supportsConditional: async () => false,
    async create(options) {
      try {
        return (await native.create(options)) as PasskeyRegistrationJSON;
      } catch (error) {
        throw phonePasskeyFailure(error);
      }
    },
    async get(options) {
      try {
        return (await native.get(options)) as PasskeyAssertionJSON;
      } catch (error) {
        throw phonePasskeyFailure(error);
      }
    },
    // The RP ID is the hosted UI's host, the one this app is tied to.
    async forget(credentialId) {
      if (rpId) await native.forget({ rpId, credentialId });
    },
    async keepOnly(userId, credentialIds) {
      if (rpId) await native.keepOnly({ rpId, userId, allAcceptedCredentialIds: [...credentialIds] });
    },
    // Only where a prompt can carry PRF: without it the kit's “Your passkey” isn't offered (BKO-09).
    ...((native.prfSupported?.() ?? false) &&
      rpId && {
        async prf({ credentialIds, salt }) {
          const challenge = crypto.getRandomValues(new Uint8Array(32));
          let raw: unknown;
          try {
            raw = await native.get(prfRequest({ rpId, credentialIds, salt, challenge }));
          } catch (error) {
            throw phonePasskeyFailure(error);
          }
          return prfOfAssertion(raw);
        },
      }),
  };
}

/** This app's passkeys, once (null without the native module: an older build, tests). */
export const PASSKEYS: PasskeyPlatform | null = WhombatPasskeys.supported() ? phonePasskeys() : null;

/**
 * The RP ID of one box's passkeys (own-address.md): a box with its own address has passkeys of its own, under
 * its host; the account's passkeys (and a box's from before) stay under the hosted UI's host.
 */
export function passkeyRpIdFor(own: { host: string } | null | undefined): string | null {
  return own && isOwnAddressHost(own.host) ? own.host : hostOf(UI_ORIGINS[0]);
}

/**
 * The phone's passkeys for one box: under its own host when it has one (`passkeyRpIdFor`), else `PASSKEYS`. The app
 * makes no box passkey itself yet (that waits for the device tests); it signals and reads PRF under the right RP ID.
 */
export function passkeysForBox(
  own: { host: string } | null | undefined,
  native: typeof WhombatPasskeys = WhombatPasskeys,
): PasskeyPlatform | null {
  if (!native.supported()) return null;
  const rpId = passkeyRpIdFor(own);
  return rpId === hostOf(UI_ORIGINS[0]) && native === WhombatPasskeys
    ? PASSKEYS
    : phonePasskeys(native, rpId);
}
