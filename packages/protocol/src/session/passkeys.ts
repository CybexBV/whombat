/**
 * Passkeys are verified independently by control and each appliance. Legacy credentials name one appliance in their
 * user handle; shared credentials carry an owner identity and are explicitly linked from enrolled sessions.
 * WebAuthn JSON accepts browser additions while the surrounding operation inputs stay strict.
 */
import { canonicalJson, sha256Bytes } from '@whombat/core/audit';
import { RemoteHelpDuration, RemoteHelpLevel, Timestamp } from '@whombat/core/domain';
import { AccountId } from '@whombat/core/ids';
import { z } from 'zod';
import { base64urlDecode, base64urlEncode, utf8Decode, utf8Encode } from '../bytes.js';
import { EndpointId, PeerIdString } from './common.js';
import { NewEndpoint } from './enrollment.js';
import { OwnerPasskeyHandle, OwnerPasskeyRecord } from './owner-passkey.js';

/* Identifiers and helpers (PK-01, PK-02, PK-03) ---------------------------------------------------------------- */

/** 32 random bytes, lowercase hex: control's sign-in nonce and both registration nonces (PK-03). */
export const PasskeyNonce = z.string().regex(/^[0-9a-f]{64}$/);
export type PasskeyNonce = z.infer<typeof PasskeyNonce>;

const Base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/** A credential id, base64url (WebAuthn allows up to 1023 bytes). */
export const PasskeyCredentialId = Base64url(1_364);
export type PasskeyCredentialId = z.infer<typeof PasskeyCredentialId>;

/** What people call a passkey (“Chrome on Linux” by default, PK-06). */
export const PasskeyName = z.string().trim().min(1).max(64);

/** The WebAuthn RP ID: the hosted UI's host (`app.whombat.com`, `dev.whombat.com`, PK-02). */
export const PasskeyRpId = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);

/** `user.id` of a Whombat passkey is UTF-8 of this prefix and the Whombat's content PeerId (PK-01). */
export const PASSKEY_USER_HANDLE_PREFIX = 'wb1:';
export const PASSKEY_ENROLL_PURPOSE = 'whombat-passkey-enroll/1';
export const PASSKEY_REGISTER_PURPOSE = 'whombat-passkey-register/1';

/**
 * Origins besides the hosted UI's that both verifiers accept (PK-02): the Android app, signed with the release key
 * (SHA-256 `85:C4:44:97…66:D3`), which shares passkeys with the website through Digital Asset Links.
 */
export const PASSKEY_ANDROID_ORIGINS = [
  'android:apk-key-hash:hcREl8X1DtHfXqk1yeVFTAZ7nhsYeSGr8uoly49gZtM',
] as const;

/** A registration's `begin` nonce lives this long in the session (PK-06). */
export const PASSKEY_REGISTER_BEGIN_TTL_S = 300;
/** At most this many passkeys per account per Whombat (`passkey_limit`, PK-06). */
export const PASSKEYS_PER_ACCOUNT_MAX = 20;
/** Failed `enroll.passkey` attempts per peer per hour, on top of the unenrolled budget (PK-05). */
export const PASSKEY_ENROLL_FAILURES_PER_HOUR = 10;

/** `user.id` of the Whombat's passkeys: UTF-8 of `wb1:` + its PeerId, 56 bytes (PK-01). Throws on anything else. */
export function passkeyUserHandle(appliance: string): Uint8Array {
  return utf8Encode(PASSKEY_USER_HANDLE_PREFIX + PeerIdString.parse(appliance));
}

/** `passkeyUserHandle` as base64url, the form of WebAuthn JSON (`user.id`, `response.userHandle`). */
export function passkeyUserHandleBase64url(appliance: string): string {
  return base64urlEncode(passkeyUserHandle(appliance));
}

/**
 * The Whombat a passkey names (its `userHandle`, base64url or bytes), or null when it names none: an account-level
 * passkey of control (CL-11, PK-11), or anything malformed.
 */
export function parsePasskeyUserHandle(handle: string | Uint8Array): PeerIdString | null {
  let bytes: Uint8Array;
  let text: string;
  try {
    bytes = typeof handle === 'string' ? base64urlDecode(handle) : handle;
    text = utf8Decode(bytes);
  } catch {
    return null;
  }
  if (!text.startsWith(PASSKEY_USER_HANDLE_PREFIX)) return null;
  const peerId = PeerIdString.safeParse(text.slice(PASSKEY_USER_HANDLE_PREFIX.length));
  return peerId.success ? peerId.data : null;
}

/**
 * The sign-in challenge (PK-03): `SHA-256(utf8(canonicalJson({purpose: 'whombat-passkey-enroll/1', nonce,
 * endpoint})))`, `nonce` control's, `endpoint` the new device's PeerId (its Noise identity). The assertion can
 * enroll that key only. Throws on a malformed nonce or PeerId.
 */
export function passkeyEnrollChallenge(input: { nonce: string; endpoint: string }): Uint8Array {
  return sha256Bytes(
    canonicalJson({
      purpose: PASSKEY_ENROLL_PURPOSE,
      nonce: PasskeyNonce.parse(input.nonce),
      endpoint: PeerIdString.parse(input.endpoint),
    }),
  );
}

export function passkeyEnrollChallengeBase64url(input: { nonce: string; endpoint: string }): string {
  return base64urlEncode(passkeyEnrollChallenge(input));
}

/**
 * The registration challenge (PK-03): `SHA-256(utf8(canonicalJson({purpose: 'whombat-passkey-register/1',
 * controlNonce, applianceNonce, appliance})))`, so each verifier checks its own nonce. Throws on malformed input.
 */
export function passkeyRegisterChallenge(input: {
  controlNonce: string;
  applianceNonce: string;
  appliance: string;
}): Uint8Array {
  return sha256Bytes(
    canonicalJson({
      purpose: PASSKEY_REGISTER_PURPOSE,
      controlNonce: PasskeyNonce.parse(input.controlNonce),
      applianceNonce: PasskeyNonce.parse(input.applianceNonce),
      appliance: PeerIdString.parse(input.appliance),
    }),
  );
}

export function passkeyRegisterChallengeBase64url(input: {
  controlNonce: string;
  applianceNonce: string;
  appliance: string;
}): string {
  return base64urlEncode(passkeyRegisterChallenge(input));
}

/** Confirming remote help with a passkey (0.120, CT-934; Whombat remote-help.md RH-04). */
export const PASSKEY_REMOTE_HELP_PURPOSE = 'whombat-remote-help/1';

/**
 * The remote help challenge (RH-04): `SHA-256(utf8(canonicalJson({purpose: 'whombat-remote-help/1', nonce, endpoint,
 * level, duration})))`, `nonce` the Whombat's from `remoteHelp.confirmBegin`, `endpoint` the caller's session PeerId (its
 * Noise identity), `level` and `duration` what the owner chose. The assertion confirms exactly that choice, from that
 * device, once. Throws on a malformed nonce, PeerId, level or duration.
 */
export function passkeyRemoteHelpChallenge(input: {
  nonce: string;
  endpoint: string;
  level: string;
  duration: string;
}): Uint8Array {
  return sha256Bytes(
    canonicalJson({
      purpose: PASSKEY_REMOTE_HELP_PURPOSE,
      nonce: PasskeyNonce.parse(input.nonce),
      endpoint: PeerIdString.parse(input.endpoint),
      level: RemoteHelpLevel.parse(input.level),
      duration: RemoteHelpDuration.parse(input.duration),
    }),
  );
}

export function passkeyRemoteHelpChallengeBase64url(input: {
  nonce: string;
  endpoint: string;
  level: string;
  duration: string;
}): string {
  return base64urlEncode(passkeyRemoteHelpChallenge(input));
}

/* WebAuthn JSON ---------------------------------------------------------------------------------------------- */

const AuthenticatorAttachment = z.enum(['platform', 'cross-platform']);
/** `usb`, `nfc`, `ble`, `hybrid`, `internal`, … (an open set). */
const AuthenticatorTransport = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z-]*$/);

/** `navigator.credentials.get` as JSON (`AuthenticationResponseJSON`). */
export const WebAuthnAuthenticationResponse = z.object({
  id: PasskeyCredentialId,
  rawId: PasskeyCredentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: Base64url(4_096),
    authenticatorData: Base64url(4_096),
    signature: Base64url(1_024),
    /** A discoverable credential always returns it; `enroll.passkey` without it is `passkey_invalid`. */
    userHandle: Base64url(86).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  authenticatorAttachment: AuthenticatorAttachment.nullable().optional(),
});
export type WebAuthnAuthenticationResponse = z.infer<typeof WebAuthnAuthenticationResponse>;

/**
 * `navigator.credentials.get` options as JSON (`PublicKeyCredentialRequestOptionsJSON`, 0.120, CT-934) when the Whombat
 * makes them itself (`remoteHelp.confirmBegin`): the challenge, its RP ID, the caller's passkeys on this Whombat and user
 * verification. Members a newer runtime adds are stripped.
 */
export const WebAuthnRequestOptions = z.object({
  challenge: Base64url(86),
  rpId: PasskeyRpId,
  allowCredentials: z
    .array(
      z.object({
        id: PasskeyCredentialId,
        type: z.literal('public-key'),
        transports: z.array(AuthenticatorTransport).max(16).optional(),
      }),
    )
    .max(PASSKEYS_PER_ACCOUNT_MAX),
  userVerification: z.enum(['required', 'preferred', 'discouraged']),
  /** Milliseconds. */
  timeout: z.number().int().min(1_000).max(600_000).optional(),
});
export type WebAuthnRequestOptions = z.infer<typeof WebAuthnRequestOptions>;

/** `navigator.credentials.create` as JSON (`RegistrationResponseJSON`). */
export const WebAuthnRegistrationResponse = z.object({
  id: PasskeyCredentialId,
  rawId: PasskeyCredentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: Base64url(4_096),
    attestationObject: Base64url(16_384),
    authenticatorData: Base64url(16_384).optional(),
    transports: z.array(AuthenticatorTransport).max(16).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: Base64url(4_096).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  authenticatorAttachment: AuthenticatorAttachment.nullable().optional(),
});
export type WebAuthnRegistrationResponse = z.infer<typeof WebAuthnRegistrationResponse>;

/* Session ops ------------------------------------------------------------------------------------------------ */

/**
 * Unenrolled channel (PK-04, PK-05): enroll this session's endpoint with a passkey. `nonce` is the one control
 * returned from `auth.passkeyAuthenticateOptions {endpoint}`; the Whombat checks the assertion itself (credential
 * known, its account active, signature, RP ID hash, origin, `webauthn.get`, user verification, challenge
 * `passkeyEnrollChallenge({nonce, endpoint: session PeerId})`, `userHandle` its own, counter, PK-07 policy) and binds
 * the endpoint to the passkey's account. Refusals: `passkey_invalid` for every failed check (no oracle),
 * `passkey_not_allowed` (a synced passkey under `deviceBoundOnly`), `endpoint_enrolled`, `rate_limited`.
 */
export const EnrollPasskeyInput = z.strictObject({
  nonce: PasskeyNonce,
  response: WebAuthnAuthenticationResponse,
  endpoint: NewEndpoint,
});

/**
 * Registration, step 1 (PK-06), for the caller's own account: a nonce the session keeps for
 * `PASSKEY_REGISTER_BEGIN_TTL_S` (a new begin replaces it), the RP ID the Whombat verifies against, the PK-01 user
 * (`user.id` = `passkeyUserHandleBase64url(appliance)`; the client checks control's options carry the same) and the
 * account's credential ids to exclude. Ephemeral: no receipt, never resent. `passkey_limit` at
 * `PASSKEYS_PER_ACCOUNT_MAX`.
 */
export const PasskeyRegisterBeginInput = z.strictObject({ ownerHandle: OwnerPasskeyHandle.optional() });
export const PasskeyRegisterBeginOutput = z.object({
  applianceNonce: PasskeyNonce,
  endpoint: PeerIdString.optional(),
  rpId: PasskeyRpId,
  user: z.object({
    id: Base64url(86),
    /** The account's email, when the Whombat knows it (control sets the cloud account's). */
    name: z.string().min(1).max(254).optional(),
    /** The Whombat's name. */
    displayName: z.string().min(1).max(120).optional(),
  }),
  excludeCredentialIds: z.array(PasskeyCredentialId).max(PASSKEYS_PER_ACCOUNT_MAX),
});

/**
 * One passkey that opens this Whombat. Members see their own; owners see everyone's (`passkeys.list`), with the
 * person.
 */
export const PasskeySummary = z.object({
  /** The credential id (base64url). */
  id: PasskeyCredentialId,
  name: PasskeyName,
  /** The account it enrolls devices into. */
  accountId: AccountId,
  /** That account's name. */
  personName: z.string().min(1).max(120),
  createdAt: Timestamp,
  /** The last device it enrolled; null before the first. */
  lastUsedAt: Timestamp.nullable(),
  /**
   * Backup eligible (the BE flag at registration): the passkey can sync to the person's other devices (Google
   * Password Manager, iCloud Keychain). `deviceBoundOnly` refuses these (PK-07).
   */
  synced: z.boolean(),
  /** This session's endpoint was enrolled with it. */
  current: z.boolean(),
  /** Present for a shared credential, rooted in its authenticator user handle. */
  ownerHandle: OwnerPasskeyHandle.optional(),
  /** COSE public key, for publishing the owner-signed directory from an enrolled session. */
  publicKey: Base64url(4096).optional(),
  /**
   * A box passkey's RP ID, the box's own host (4.3; `boxPasskey.*`); absent for a passkey under the hosted app's RP ID.
   */
  rpId: PasskeyRpId.optional(),
});
export type PasskeySummary = z.infer<typeof PasskeySummary>;

/**
 * Registration, step 3 (PK-06), after `auth.passkeyRegisterOptions {appliance, applianceNonce}` and
 * `navigator.credentials.create`: the Whombat verifies the attestation (`none`), RP ID, origin, user verification,
 * `user.id`, the challenge `passkeyRegisterChallenge({controlNonce, applianceNonce: its begin's, appliance: itself})`
 * and the PK-07 policy, then stores the credential for the caller's account. Consumes the begin. Refusals:
 * `passkey_invalid`, `passkey_not_allowed`, `passkey_limit`; the same credential again is `conflict`.
 */
export const PasskeyRegisterInput = z.strictObject({
  controlNonce: PasskeyNonce,
  response: WebAuthnRegistrationResponse,
  name: PasskeyName,
});
export const PasskeyRegisterOutput = PasskeySummary;
export const PasskeyLinkInput = z.strictObject({
  record: OwnerPasskeyRecord,
  response: WebAuthnAuthenticationResponse,
  name: PasskeyName,
});

/** The caller's passkeys (an owner: everyone's), newest first, and the owner setting (PK-07, PK-08). */
export const PasskeysListInput = z.strictObject({});
export const PasskeysPolicy = z.object({
  /** “Only passkeys that stay on one device”: synced passkeys can't be registered or enroll devices. */
  deviceBoundOnly: z.boolean(),
});
export type PasskeysPolicy = z.infer<typeof PasskeysPolicy>;
export const PasskeysListOutput = z.object({
  passkeys: z.array(PasskeySummary).max(1_000),
  policy: PasskeysPolicy,
});

/**
 * Remove a passkey (its person, or an owner): it enrolls no device any more. Devices it enrolled stay (revoke them in
 * `endpoints.revoke`). The client also deletes the caller's own from control (`auth.deletePasskey`).
 */
export const PasskeyRemoveInput = z.strictObject({ id: PasskeyCredentialId });

/** Owners (`not_owner` otherwise): the PK-07 setting. Passkeys already registered keep working only if they comply. */
export const PasskeysPolicyInput = z.strictObject({ deviceBoundOnly: z.boolean() });

/* Audit (signed appliance log; ids only) --------------------------------------------------------------------- */

/** Payload of `passkey.registered` / `passkey.removed`. */
export const PasskeyAuditPayload = z.object({
  credentialId: PasskeyCredentialId,
  accountId: AccountId,
  /** Who acted: the person, an owner; null when the passkey went with its account. */
  byAccountId: AccountId.nullable(),
  synced: z.boolean(),
});
/** Payload of `passkeys.policy_changed`. */
export const PasskeysPolicyAuditPayload = z.object({ deviceBoundOnly: z.boolean(), byAccountId: AccountId });
/** What `endpoint.enrolled` adds for a device a passkey enrolled (PK-05). */
export const PasskeyEnrolledAuditDetail = z.object({
  via: z.literal('passkey'),
  credentialId: PasskeyCredentialId,
  endpointId: EndpointId,
});
