/**
 * Box passkeys (4.3; Whombat docs/decisions/own-address.md): passkeys whose RP ID is the box's own host, so no page
 * Cybex serves can use them. The box makes and checks everything itself: its own nonces (one per session per purpose,
 * `PASSKEY_REGISTER_BEGIN_TTL_S`), a random `user.id` per account per box, and the allowed origins
 * `ownAddressOrigin(host)` and `PASSKEY_ANDROID_ORIGINS`. Joining reuses `passkeyEnrollChallenge` with the box's nonce;
 * registering has its own challenge. `passkey.remove` and `passkeys.list` cover both kinds (`PasskeySummary.rpId`).
 */
import { canonicalJson, sha256Bytes } from '@whombat/core/audit';
import { z } from 'zod';
import { base64urlEncode } from '../bytes.js';
import { OwnAddressHost } from '../own-address.js';
import { PeerIdString } from './common.js';
import { NewEndpoint } from './enrollment.js';
import {
  PASSKEYS_PER_ACCOUNT_MAX,
  PasskeyCredentialId,
  PasskeyName,
  PasskeyNonce,
  WebAuthnAuthenticationResponse,
  WebAuthnRegistrationResponse,
} from './passkeys.js';

export const BOX_PASSKEY_REGISTER_PURPOSE = 'whombat-box-passkey-register/1';
/** How long a box passkey ceremony may take in the browser (`timeoutMs`). */
export const BOX_PASSKEY_TIMEOUT_MS = 120_000;

const Base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/**
 * The registration challenge: `SHA-256(utf8(canonicalJson({purpose: 'whombat-box-passkey-register/1', nonce,
 * appliance, rpId})))`, `nonce` the box's from `boxPasskey.register.begin`, `appliance` its PeerId, `rpId` its host.
 * Throws on malformed input.
 */
export function boxPasskeyRegisterChallenge(input: {
  nonce: string;
  appliance: string;
  rpId: string;
}): Uint8Array {
  return sha256Bytes(
    canonicalJson({
      purpose: BOX_PASSKEY_REGISTER_PURPOSE,
      nonce: PasskeyNonce.parse(input.nonce),
      appliance: PeerIdString.parse(input.appliance),
      rpId: OwnAddressHost.parse(input.rpId),
    }),
  );
}

export function boxPasskeyRegisterChallengeBase64url(input: {
  nonce: string;
  appliance: string;
  rpId: string;
}): string {
  return base64urlEncode(boxPasskeyRegisterChallenge(input));
}

/**
 * `boxPasskey.enroll.begin` (enrolled or not, any session; ephemeral): a nonce for joining with a box passkey. The
 * device asks `navigator.credentials.get` with `passkeyEnrollChallenge({nonce, endpoint: its session PeerId})`.
 */
export const BoxPasskeyEnrollBeginInput = z.strictObject({});
export const BoxPasskeyEnrollBeginOutput = z.object({
  nonce: PasskeyNonce,
  rpId: OwnAddressHost,
  timeoutMs: z.number().int().min(1_000).max(600_000),
});

/**
 * `boxPasskey.enroll`: let this session's device in with a box passkey. The box checks the nonce is this session's,
 * the origin, the RP ID hash, user verification, the challenge, that the credential is a live box passkey here, the
 * counter and the passkey policy. Every failed check is `passkey_invalid` (no oracle); `rate_limited` after
 * `PASSKEY_ENROLL_FAILURES_PER_HOUR`.
 */
export const BoxPasskeyEnrollInput = z.strictObject({
  nonce: PasskeyNonce,
  response: WebAuthnAuthenticationResponse,
  endpoint: NewEndpoint,
});

/**
 * `boxPasskey.register.begin` (enrolled; ephemeral): what `navigator.credentials.create` needs. `user.id` is 32 random
 * bytes the box made once for this account; `user.name` is the box's name and `user.displayName` “<box name> · your
 * Whombat”.
 */
export const BoxPasskeyRegisterBeginInput = z.strictObject({});
export const BoxPasskeyRegisterBeginOutput = z.object({
  nonce: PasskeyNonce,
  rpId: OwnAddressHost,
  user: z.object({
    /** base64url of 32 bytes. */
    id: Base64url(43, 43),
    name: z.string().min(1).max(120),
    displayName: z.string().min(1).max(160),
  }),
  excludeCredentialIds: z.array(PasskeyCredentialId).max(PASSKEYS_PER_ACCOUNT_MAX),
  /** `boxPasskeyRegisterChallengeBase64url({nonce, appliance, rpId})`. */
  challenge: Base64url(43, 43),
});

/**
 * `boxPasskey.register` (enrolled): store a new box passkey for the caller's account. Consumes the begin. Refusals as
 * `passkey.register`: `passkey_invalid`, `passkey_not_allowed`, `passkey_limit`; the same credential again is
 * `conflict`. Answers a `PasskeySummary` with `rpId`.
 */
export const BoxPasskeyRegisterInput = z.strictObject({
  nonce: PasskeyNonce,
  response: WebAuthnRegistrationResponse,
  name: PasskeyName,
});
