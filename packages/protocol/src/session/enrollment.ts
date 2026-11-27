/**
 * Session-native operations for claim, enrollment, recovery and endpoint trust (MA-04). They are not REST
 * endpoints; the appliance dispatches them like `api.*` operations (see `operations.ts`).
 *
 * Unenrolled endpoints (channel `enroll`) may call only `enroll.claim.begin`, `enroll.claim`, `enroll.pair.request`,
 * `enroll.pair.status`, `recovery.enroll`, `enroll.passkey` (`passkeys.ts`), `enroll.screen.request`, `enroll.screen.begin`,
 * `enroll.screen` (0.106), `enroll.claim.local.start`, `enroll.claim.local.begin`, `enroll.claim.local.prove`,
 * `enroll.claim.local` and `enroll.link.accept` (1.1) and, on a development runtime only, `enroll.dev` (1.0; bounded rate and size). The
 * claim/pairing binds the endpoint key that is the session's Noise static identity; nothing here carries the key itself.
 */
import {
  canonicalJson,
  sha256Bytes,
  sha256Hex,
  signBytes,
  utf8ToBytes,
  verifyBytes,
} from '@whombat/core/audit';
import type { ErrorCode } from '@whombat/core/contracts';
import { Email, LinkRef, ProviderSignInState, Timestamp } from '@whombat/core/domain';
import { LocaleTag } from '@whombat/core/i18n';
import { AccountId } from '@whombat/core/ids';
import {
  ClientFloor,
  ReleaseId,
  UpdateFailureDetail,
  UpdateJournalState,
  UpdateWaitReason,
} from '@whombat/release';
import { z } from 'zod';
import { base64urlEncode } from '../bytes.js';
import { ClaimMethod } from '../claim/code.js';
import { ClaimConfirmTag, ClaimPakeShare } from '../claim/pake.js';
import { OwnAddressClaimSecret } from '../own-address.js';
import { BackupBringBack } from './backup-passkey.js';
import {
  AuthzGeneration,
  EndpointId,
  EndpointLabel,
  EndpointPlatform,
  PeerIdString,
  PushHandle,
  PushRef,
} from './common.js';
import { LicenceStatusView } from './licence.js';
import { LocalLink } from './local-links.js';
import { PrincipalSummary } from './messages.js';
import { OwnAddressSummary } from './own-address.js';

const PublicKeyHex = z.string().regex(/^[0-9a-f]{64}$/);
const SignatureHex = z.string().regex(/^[0-9a-f]{128}$/);
const NonceHex = z.string().regex(/^[0-9a-f]{32}$/);

/** Claim secret from the card: 128 bits as 26 base32 characters (RFC 4648 alphabet, no padding). */
export const ClaimSecret = z.string().regex(/^[A-Z2-7]{26}$/);
/**
 * Characters removed from a typed or scanned claim code: Unicode White_Space, U+FEFF (JS `\s` counts it) and `-`.
 */
const CLAIM_SECRET_DROP =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff-]/g;
const CLAIM_SECRET_LOOKALIKES: Readonly<Record<string, string>> = { '0': 'O', '1': 'I', '8': 'B' };

/**
 * Card/QR input → claim secret, exactly as provisioning (appliance NX-24, CT-29): (1) ASCII upper-case
 * `a–z` only; (2) remove whitespace (`CLAIM_SECRET_DROP`) and `-`; (3) map `0→O`, `1→I`, `8→B`. The result is
 * valid only if it matches `ClaimSecret` (`isClaimSecret`); anything else is rejected, never repaired.
 */
export function normalizeClaimSecret(input: string): string {
  return input
    .replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32))
    .replace(CLAIM_SECRET_DROP, '')
    .replace(/[018]/g, (c) => CLAIM_SECRET_LOOKALIKES[c] as string);
}

export function isClaimSecret(normalized: string): boolean {
  return ClaimSecret.safeParse(normalized).success;
}

export const CLAIM_SECRET_HASH_TAG = 'whombat-claim-secret/1';

/**
 * What the appliance stores to check a presented secret (`claim.json` `secretHash`, NX-24):
 * `base64url_nopad(SHA-256(UTF-8("whombat-claim-secret/1\n" + deviceId + "\n" + normalized)))`, 43 characters.
 * Throws when `normalizedSecret` isn't a valid normalized secret.
 */
export function claimSecretHash(deviceId: string, normalizedSecret: string): string {
  if (!isClaimSecret(normalizedSecret)) throw new Error('not a normalized claim secret');
  return base64urlEncode(sha256Bytes(`${CLAIM_SECRET_HASH_TAG}\n${deviceId}\n${normalizedSecret}`));
}

/**
 * The claim PAKE's `card` password (CT-66): `claimSecretHash(deviceId, normalizedSecret)`. The client computes it from
 * the card; the appliance has it as `claim.json` `secretHash` and never stores the secret itself.
 */
export function claimCardPassword(deviceId: string, normalizedSecret: string): string {
  return claimSecretHash(deviceId, normalizedSecret);
}

/** Short pairing code shown on the new endpoint and typed on a trusted one: `1234-5678`. */
export const PairingCode = z.string().regex(/^[0-9]{4}-[0-9]{4}$/);
export const PairingId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
/**
 * A device link's one-time secret (≥ 128 bits, base64url), carried in the link's fragment; only its hash is stored
 * (`InviteSecret` until 3.0, CT-1505: invites went, the device link keeps the shape).
 */
export const DeviceLinkSecret = z
  .string()
  .min(22)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const NewEndpoint = z.strictObject({ label: EndpointLabel, platform: EndpointPlatform });
export type NewEndpoint = z.infer<typeof NewEndpoint>;

export const EndpointSummary = z.object({
  endpointId: EndpointId,
  peerId: PeerIdString,
  label: EndpointLabel,
  platform: EndpointPlatform,
  /** The account the endpoint is bound to (MA-03). */
  accountId: AccountId,
  createdAt: Timestamp,
  lastSeenAt: Timestamp.nullable(),
  /** The endpoint of the session asking. */
  current: z.boolean(),
  revokedAt: Timestamp.nullable(),
  /** MA-04 §6: `pending` until the appliance reported the revocation to control, then `applied`. */
  revocation: z.enum(['none', 'pending', 'applied']),
});
export type EndpointSummary = z.infer<typeof EndpointSummary>;

/** Result of every enrollment that binds this session's endpoint to an account. */
/**
 * Result of every enrollment that binds this session's endpoint to an account: the account (with its burrow
 * principals, none after a fresh claim), the endpoint and the account's authorization generation.
 */
export const EnrolledOutput = PrincipalSummary.extend({
  endpoint: EndpointSummary,
  authzGeneration: AuthzGeneration,
});
export type EnrolledOutput = z.infer<typeof EnrolledOutput>;

/**
 * How an endpoint was let in: the `via` of `endpoint.enrolled` in the signed appliance log (the runtime's
 * `enrolled_via`). 0.106 (CT-627) adds `screen` (`enroll.screen`), 1.1 (CT-1305) `link` (`enroll.link.accept`); a claim
 * on the box's own page is `claim` too. `invite` and `reenroll` went in 3.0 (CT-1505); a signed event that names them
 * keeps its own words. Readers treat it as an open set: a newer runtime may add a way. 3.6 adds `display`: a tablet or
 * computer that became a screen (`desk.screen.add`), whose sessions see only the `screen` channel.
 */
export const ENDPOINT_ENROLLED_VIA = [
  'claim',
  'pairing',
  'recovery',
  'passkey',
  'screen',
  'dev',
  'link',
  'display',
] as const;
export const EndpointEnrolledVia = z.enum(ENDPOINT_ENROLLED_VIA);
export type EndpointEnrolledVia = z.infer<typeof EndpointEnrolledVia>;

/* Claim ------------------------------------------------------------------------------------------ */

export const CLAIM_VERIFIER_TAG = 'whombat-claim-control/1';

/**
 * The card proof control checks before opening a pending claim (MA-19d, CT-43):
 * `base64url_nopad(SHA-256(UTF-8("whombat-claim-control/1\n" + deviceId + "\n" + normalized)))`. Provisioning
 * registers it as the device's `claimVerifier`; the client computes the same value from the card as `claimProof`
 * for `claims.start`. Domain-separated from `claimSecretHash`, so neither reveals the other; control compares in
 * constant time and never sees the secret. Throws when `normalizedSecret` isn't a valid normalized secret.
 */
export function claimVerifier(deviceId: string, normalizedSecret: string): string {
  if (!isClaimSecret(normalizedSecret)) throw new Error('not a normalized claim secret');
  return base64urlEncode(sha256Bytes(`${CLAIM_VERIFIER_TAG}\n${deviceId}\n${normalizedSecret}`));
}

/** Control's pending-claim id (from `claims.start`): the appliance reports exactly this claim as claimed (CT-27). */
export const ControlClaimId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Claim, step 1 (CC-07, CT-61): the client's CPace share (`claimPakeInitiator`, `@whombat/protocol/claim`) for control's
 * pending claim. The appliance runs the responder (`claimPakeResponder`) with the password of `method` — its console
 * letters (`code`) or its card secret (`card`) — and keeps `{tags, claimId, method}` for this session for at most
 * `ENROLL_CLAIM_BEGIN_TTL_S`; a new begin replaces it. The answer reveals nothing about the password, and a begin
 * without a following `enroll.claim` costs no attempt. Ephemeral: no `accepted`, no receipt, never resent (start again
 * with a fresh share).
 *
 * Refusals (`error.details.code`): `claim_used` (claimed), `claim_not_ready` (no letters yet: no lookup lease, or no
 * card secret for `card`), `claim_backoff` (`ClaimBackoffDetails.retryAt`), `claim_share_invalid` (not a ristretto255
 * element, or the identity; not an attempt), `claim_window_closed`, and the unenrolled budget (`rate_limited`).
 */
export const EnrollClaimBeginInput = z.strictObject({
  claimId: ControlClaimId,
  method: ClaimMethod,
  share: ClaimPakeShare,
});
export const EnrollClaimBeginOutput = z.object({ share: ClaimPakeShare });

/** A person's name on a box: what its agent calls them. */
export const CLAIM_ACCOUNT_NAME_MAX = 120;
/**
 * The first owner a claim names (`enroll.claim`, `enroll.claim.local`): the rules both sides check, so an app refuses a
 * name or an email the box would refuse before it starts an exchange (`claimAccountProblem`).
 */
export const ClaimAccount = z.strictObject({
  name: z.string().trim().min(1).max(CLAIM_ACCOUNT_NAME_MAX),
  email: Email,
});
export type ClaimAccount = z.infer<typeof ClaimAccount>;

/** Which part of a claim's account the box would refuse, or null when it takes both. */
export function claimAccountProblem(account: { name: string; email: string }): 'name' | 'email' | null {
  if (!ClaimAccount.shape.name.safeParse(account.name).success) return 'name';
  if (!ClaimAccount.shape.email.safeParse(account.email).success) return 'email';
  return null;
}

/**
 * Claim, step 2 (CC-07): `confirm` is the client's tag (`tags.client` from `claimPakeInitiatorFinish`). The appliance
 * checks it in constant time (`claimConfirmEqual`) against the live begin of this session for the same `claimId` and
 * `method` (`claim_begin_missing` otherwise) before anything else. A mismatch is one wrong guess (`claim_invalid`;
 * under `code` the letters rotate) and ends the begin. Only a match creates the owner, as before (0.6: no
 * `claimSecret`).
 */
export const EnrollClaimInput = z.strictObject({
  claimId: ControlClaimId,
  method: ClaimMethod,
  confirm: ClaimConfirmTag,
  account: ClaimAccount,
  endpoint: NewEndpoint,
  locale: LocaleTag.optional(),
});
/**
 * `confirm` is the appliance's tag (`tags.appliance`). The client accepts the result — pins the PeerId — only if
 * `claimConfirmEqual(tags.appliance, confirm)`; otherwise it was talking to something else and stops (“This isn’t the
 * Whombat on your screen”).
 */
export const EnrollClaimOutput = EnrolledOutput.extend({
  confirm: ClaimConfirmTag,
});

/** `error.details` of `claim_backoff` (`error.code: rate_limited`): when `enroll.claim.begin` is accepted again. */
export const ClaimBackoffDetails = z.object({
  code: z.literal('claim_backoff'),
  retryAt: Timestamp,
});
export type ClaimBackoffDetails = z.infer<typeof ClaimBackoffDetails>;

/* The claim on the box's own page (1.1, CT-1302; Whombat hermes-engine.md HE-59) --------------------------------------- */

/**
 * A box claimed on its own pages has no control to open a pending claim, so the claim runs on the page the box serves on
 * its direct ways (the address its console shows) or in the app at that address, over the enrollment channel the box
 * gives any key it doesn't know:
 *
 * 1. `enroll.claim.local.start {}` → `{claimId, expiresAt}`: the box's own claim id for this session, for
 *    `LOCAL_CLAIM_TTL_S` (a new start on the session replaces it). It also says whether a claim can start: refusals
 *    `claim_local_unavailable` (a box claimed through control, `enroll.claim`), `claim_used`, `claim_not_ready` (no
 *    letters on the console yet), `claim_backoff` (`ClaimBackoffDetails`), `claim_update_app` (a session below minor 1:
 *    an app that would send the account before the box proved itself) and the unenrolled budget (`rate_limited`).
 *    Ephemeral, like `enroll.claim.begin`.
 * 2. `enroll.claim.local.begin {claimId, share}` → `{share}` (`localClaimPakeInitiator`/`Responder`, CPace bound to both
 *    Noise keys, `sid` = the claim id; only on the session that started it, kept for `ENROLL_CLAIM_BEGIN_TTL_S`, a new
 *    begin replaces it). Refusals: `claim_start_missing`, `claim_backoff`, `claim_window_closed`, `claim_rate_limited`,
 *    `claim_share_invalid` (not a guess), `claim_used`. Ephemeral.
 * 3. `enroll.claim.local.prove {claimId, confirm}` → `{confirm}` (minor 1): the proofs alone. The box checks the client's
 *    tag in constant time against this session's live begin, which is used up whatever happens (`claim_begin_missing`
 *    without one). A mismatch is one wrong guess (`claim_invalid`); a match answers the box's own tag and keeps the
 *    proof on this session for `ENROLL_CLAIM_BEGIN_TTL_S`. The client checks the box's tag
 *    (`claimConfirmEqual(tags.appliance, …)`) and stops when it is wrong (“This isn’t the Whombat on your screen.”):
 *    nothing about the person has been sent yet. Ephemeral.
 * 4. `enroll.claim.local {claimId, account, endpoint}` → `EnrolledOutput`: once, on the session that proved
 *    (`claim_proof_missing` otherwise: it ran out, was used, or never was). It makes `account` the box's first owner
 *    with this device (`via: 'claim'`), as `enroll.claim` does.
 *
 * So the person's name, email and device label go only to a box that proved it knows the letters on its screen: a
 * stranger answering at the box's address learns nothing about them.
 *
 * The letters, their rotation after a wrong guess and the backoff are the claim's (CC-07): one set on the console, one
 * counter; the box gives one verdict at a time across all sessions. Nothing is reported to control (there is none):
 * `appliance.status.claimReported` stays false on such a box and means nothing there.
 */
export const LocalClaimId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export type LocalClaimId = z.infer<typeof LocalClaimId>;
/** How long a local claim id is good for (a person reads the letters and types them). */
export const LOCAL_CLAIM_TTL_S = 300;
/** The session minor from which an app proves first and names the person after (`enroll.claim.local.prove`). */
export const LOCAL_CLAIM_PROVE_MINOR = 1;

/**
 * `link` (4.3; Whombat own-address.md): the claim link's secret (`https://<host>/c/<secret>`, shown on the box's screen).
 * A door session to an unclaimed box with its own address must carry it (`claim_link` otherwise, which never counts
 * toward the claim backoff); other sessions leave it out. The box keeps it with the start, on that session, and checks
 * it again when the exchange begins there.
 */
export const EnrollClaimLocalStartInput = z.strictObject({ link: OwnAddressClaimSecret.optional() });
export const EnrollClaimLocalStartOutput = z.object({ claimId: LocalClaimId, expiresAt: Timestamp });
export type EnrollClaimLocalStartOutput = z.infer<typeof EnrollClaimLocalStartOutput>;
export const EnrollClaimLocalBeginInput = z.strictObject({ claimId: LocalClaimId, share: ClaimPakeShare });
export const EnrollClaimLocalBeginOutput = z.object({ share: ClaimPakeShare });
/** The proofs alone: the client's tag in, the box's tag out. Nothing about the person. */
export const EnrollClaimLocalProveInput = z.strictObject({ claimId: LocalClaimId, confirm: ClaimConfirmTag });
export const EnrollClaimLocalProveOutput = z.object({ confirm: ClaimConfirmTag });
export type EnrollClaimLocalProveOutput = z.infer<typeof EnrollClaimLocalProveOutput>;
/**
 * `account`: the first owner, as `enroll.claim`'s; `endpoint`: this device. `confirm` is the form before the proof
 * round, which sent the account with the client's tag: a box refuses it with `claim_update_app` and reads nothing else
 * of it.
 */
export const EnrollClaimLocalInput = z.strictObject({
  claimId: LocalClaimId,
  confirm: ClaimConfirmTag.optional(),
  account: ClaimAccount,
  endpoint: NewEndpoint,
  locale: LocaleTag.optional(),
});
export type EnrollClaimLocalInput = z.infer<typeof EnrollClaimLocalInput>;

/* Sign in at the box's screen (0.106, CT-622) ------------------------------------------------------------- */

/**
 * A device that isn't let in yet asks the box for a code, the box shows six letters on its own screen (the console,
 * the desk display or the virtual machine's console) and the person types them on the device (Whombat
 * signin-at-box.md BX-02…BX-05). The exchange is the claim's (`@whombat/protocol/claim` `screenSignInPake*`, bound to
 * both Noise keys), so control and the relay can't let a device in.
 *
 * 1. `enroll.screen.request {endpoint}` → `{signinId, expiresAt}`: the box shows letters for this device key for
 *    `SCREEN_SIGNIN_TTL_S`, naming the device (since 3.0 without an email: the account is the person's, CT-1509). One sign-in per box: a new request replaces the one
 *    showing. At most `SCREEN_SIGNIN_REQUESTS_PER_KEY` requests per device key and `SCREEN_SIGNIN_REQUESTS_TOTAL` per
 *    box in an hour (`screen_rate_limited`).
 * 2. `enroll.screen.begin {signinId, share}` → `{share}` (only from the key that asked; kept for this session for
 *    `ENROLL_CLAIM_BEGIN_TTL_S`, a new begin replaces it).
 * 3. `enroll.screen {signinId, confirm}` → `EnrolledOutput + {confirm}`: the device is let in to the account it named
 *    (`via: 'screen'`). The client checks `confirm` with `claimConfirmEqual(tags.appliance, confirm)` before it trusts
 *    the result and pins the PeerId (“This isn’t the Whombat whose screen you’re looking at.” otherwise). One of the
 *    person's devices that is in already (a box restored from a backup) keeps its endpoint and only pins the box.
 *
 * A wrong `confirm` is one guess (`screen_code_invalid`): the letters rotate at once (the sign-in stays until it
 * expires) and live begins end. Guesses back off like the claim's (`claimBackoffSeconds` on their own counter, kept
 * across restarts; `screen_backoff` with `ScreenBackoffDetails`); a success clears it.
 */
export const ScreenSignInId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export type ScreenSignInId = z.infer<typeof ScreenSignInId>;
/** How long the box shows a code (BX-02). */
export const SCREEN_SIGNIN_TTL_S = 300;
/** `enroll.screen.request`s per device key per hour (BX-05). */
export const SCREEN_SIGNIN_REQUESTS_PER_KEY = 5;
/** `enroll.screen.request`s per box per hour (BX-05). */
export const SCREEN_SIGNIN_REQUESTS_TOTAL = 30;

/**
 * Ask the box to show a code for this device (ephemeral, like `enroll.claim.begin`: no receipt, never resent).
 * `endpoint`: the label the screen shows and the endpoint the device becomes, on the person's account. Refusals:
 * `screen_unavailable` (not claimed, or no screen to show on), `screen_rate_limited`, `screen_backoff` (so the device says so before anyone types),
 * `endpoint_enrolled`, and the unenrolled budget (`rate_limited`).
 */
export const EnrollScreenRequestInput = z.strictObject({ endpoint: NewEndpoint });
/**
 * `device`: the box's device id, which the exchange binds (`screenSignInPakeCi`). The box's own page has no directory
 * to read it from, so it takes the box's answer, from the same box whose key it pinned; the app keeps its directory's.
 */
export const EnrollScreenRequestOutput = z.object({
  signinId: ScreenSignInId,
  expiresAt: Timestamp,
  device: z.string().min(1).max(64).optional(),
});

/**
 * CPace step 1 with the letters (`screenSignInPakeInitiator`; ephemeral, like `enroll.claim.begin`). The appliance
 * runs `screenSignInPakeResponder` with the letters showing and keeps the tags with the sign-in id and the letters'
 * generation for this session. A begin without a following `enroll.screen` costs nothing. Refusals:
 * `screen_signin_missing` (no live sign-in with this id for this device key), `screen_backoff`,
 * `screen_share_invalid` (not a guess), `screen_unavailable`.
 */
export const EnrollScreenBeginInput = z.strictObject({ signinId: ScreenSignInId, share: ClaimPakeShare });
export const EnrollScreenBeginOutput = z.object({ share: ClaimPakeShare });

/**
 * CPace step 2: `confirm` is the client's tag (`tags.client`), checked in constant time against this session's live
 * begin for the same id before anything else (`screen_begin_missing` without one, or for one made before a wrong
 * guess). A mismatch is `screen_code_invalid`; a match lets the device in (`screen_signin_missing` if the sign-in ended
 * meanwhile, `endpoint_enrolled` if the key is already let in). Never resent automatically: it consumes the one-time
 * state.
 */
export const EnrollScreenInput = z.strictObject({ signinId: ScreenSignInId, confirm: ClaimConfirmTag });
/** `confirm` is the appliance's tag (`tags.appliance`): check it before pinning the PeerId. */
export const EnrollScreenOutput = EnrolledOutput.extend({ confirm: ClaimConfirmTag });

/* Development enrolment (1.0, CT-1257; Whombat hermes-engine.md HE-49) ------------------------------------------------ */

/**
 * Let a browser on the developer's own machine in, with no claim, control or relay: `pnpm dev` runs the one runtime
 * mode with stand-ins, and this is the stand-in for the claim and the sign-in. Only a development runtime answers it,
 * and only on a direct connection from the machine itself (loopback); every other runtime and connection refuses with
 * `forbidden` and `details.code: dev_only`, so a box never lets a device in this way. The device is bound to the account
 * with `account.email` — created with `account.name` when new; the first account on the Whombat is its owner
 * (`via: 'dev'`). Refusals besides `dev_only`: `endpoint_enrolled`, and the unenrolled budget (`rate_limited`).
 */
export const EnrollDevInput = z.strictObject({
  account: z.strictObject({ name: z.string().trim().min(1).max(120), email: Email }),
  endpoint: NewEndpoint,
});
export type EnrollDevInput = z.infer<typeof EnrollDevInput>;

/** `error.details` of `screen_backoff` (`error.code: rate_limited`): when the box takes `enroll.screen.begin` again. */
export const ScreenBackoffDetails = z.object({
  code: z.literal('screen_backoff'),
  retryAt: Timestamp,
});
export type ScreenBackoffDetails = z.infer<typeof ScreenBackoffDetails>;

/** The screen sign-in's refusals (`error.details.code`; described in `APP_ERROR_CODES`), besides `endpoint_enrolled`. */
export const SCREEN_SIGNIN_ERROR_CODES = [
  'screen_unavailable',
  'screen_signin_missing',
  'screen_begin_missing',
  'screen_code_invalid',
  'screen_backoff',
  'screen_share_invalid',
  'screen_rate_limited',
] as const;
export const ScreenSignInErrorCode = z.enum(SCREEN_SIGNIN_ERROR_CODES);
export type ScreenSignInErrorCode = z.infer<typeof ScreenSignInErrorCode>;

/** The generic session `ErrorCode` each refusal rides on. */
export const SCREEN_SIGNIN_ERROR_STATUS: Readonly<Record<ScreenSignInErrorCode, z.infer<typeof ErrorCode>>> =
  {
    screen_unavailable: 'unavailable',
    screen_signin_missing: 'conflict',
    screen_begin_missing: 'conflict',
    screen_code_invalid: 'forbidden',
    screen_backoff: 'rate_limited',
    screen_share_invalid: 'validation_failed',
    screen_rate_limited: 'rate_limited',
  };

/* Pairing ---------------------------------------------------------------------------------------- */

/** A new endpoint asks to join the person's account (since 3.0 without an email, CT-1509: there is one account). */
export const EnrollPairRequestInput = z.strictObject({ endpoint: NewEndpoint });
export const EnrollPairRequestOutput = z.object({
  pairingId: PairingId,
  code: PairingCode,
  expiresAt: Timestamp,
});
export const EnrollPairStatusInput = z.strictObject({ pairingId: PairingId });
export const EnrollPairStatusOutput = z.object({
  state: z.enum(['pending', 'approved', 'denied', 'expired']),
  /** When approved: the account this endpoint is now bound to. Reconnect to get the `app` channel. */
  enrolled: EnrolledOutput.optional(),
});
export const PAIRING_FINGERPRINT_TAG = 'whombat-pairing-fingerprint/1';

/**
 * The short fingerprint of a pairing device's key (MR-32, CT-46): the first 6 bytes of
 * `SHA-256("whombat-pairing-fingerprint/1\n" + peerId)`, upper-case hex as `XXXX-XXXX-XXXX` (48 bits). The new
 * device shows it next to its code; the approving device shows it from `enroll.pair.lookup`; the person compares
 * both before approving.
 */
export function pairingFingerprint(peerId: string): string {
  const hex = sha256Hex(`${PAIRING_FINGERPRINT_TAG}\n${peerId}`).slice(0, 12).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}
export const PairingFingerprint = z.string().regex(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);

/**
 * On a trusted endpoint: which device a code belongs to, before approving it (a query; look-ups and approvals share
 * a per-account budget of 10 codes per 10 minutes, `rate_limited`).
 */
export const EnrollPairLookupInput = z.strictObject({ code: PairingCode });
export const EnrollPairLookupOutput = z.object({
  pairingId: PairingId,
  label: EndpointLabel,
  platform: EndpointPlatform,
  fingerprint: PairingFingerprint,
  expiresAt: Timestamp,
});

/**
 * On a trusted endpoint of the account: approve (or deny) the code shown on the new endpoint. `fingerprint` is the
 * one `enroll.pair.lookup` returned (and the person compared with the new device's screen); a different one is
 * refused (`pairing_fingerprint_mismatch`), so a mistyped or guessed code can't bind a stranger's device.
 */
export const EnrollPairApproveInput = z.strictObject({
  code: PairingCode,
  approve: z.boolean(),
  fingerprint: PairingFingerprint,
});
export const EnrollPairApproveOutput = z.object({
  state: z.enum(['approved', 'denied']),
  endpoint: EndpointSummary.optional(),
});

/* Adding a device of your own by a link or QR code (1.1, CT-1305; Whombat hermes-engine.md HE-60) ------------------------- */

/**
 * A device someone already uses shows a QR code (or a link) that lets one more device of theirs in, over the box's
 * direct ways, without control, a code to type or a second person:
 *
 * 1. On the device they use: `enroll.link.create {}` → `{linkId, secret, expiresAt, link}` (a `secret` op: shown once,
 *    never in a receipt). One live link per account: a new one replaces it. Refused with `link_unavailable` while the
 *    box has no direct way to put in the link.
 * 2. On the new device, which pins the PeerId from the link and connects on one of its ways (enrollment channel):
 *    `enroll.link.accept {secret, endpoint}` → `EnrolledOutput`, bound to the account that made the link
 *    (`via: 'link'`; a `secret` op). Refusals: `link_invalid`, `link_expired`, `link_used`, `endpoint_enrolled`, and the
 *    unenrolled budget (`rate_limited`, failed attempts count).
 *
 * The secret is a bearer secret for `DEVICE_LINK_TTL_S`, used once; whoever scans the code in time gets a device on the
 * account. The account sees the new device in Devices and can revoke it (`endpoints.revoke`).
 */
export const DeviceLinkId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export type DeviceLinkId = z.infer<typeof DeviceLinkId>;
/** A device link works for five minutes. */
export const DEVICE_LINK_TTL_S = 300;

export const EnrollLinkCreateInput = z.strictObject({});
export const EnrollLinkCreateOutput = z.object({
  linkId: DeviceLinkId,
  secret: DeviceLinkSecret,
  expiresAt: Timestamp,
  /** `parseLocalLink`, kind `device`: show it as a QR code. */
  link: LocalLink,
});
export type EnrollLinkCreateOutput = z.infer<typeof EnrollLinkCreateOutput>;
export const EnrollLinkAcceptInput = z.strictObject({ secret: DeviceLinkSecret, endpoint: NewEndpoint });
export type EnrollLinkAcceptInput = z.infer<typeof EnrollLinkAcceptInput>;

/* Recovery --------------------------------------------------------------------------------------- */

/** The person: register the public half of a new recovery key (generated in the client). */
export const RecoveryKitRegisterInput = z.strictObject({ recoveryPublicKey: PublicKeyHex });
export const RecoveryKitRegisterOutput = z.object({
  kitId: z.string().min(1).max(64),
  /** Sign `recoveryKitConfirmation(...)` with the recovery key from the saved kit to confirm it. */
  challenge: NonceHex,
  expiresAt: Timestamp,
});
export const RECOVERY_ROTATE_PURPOSE = 'whombat-recovery-rotate/1';

/**
 * What the current recovery key signs to replace itself (MA-19a, CT-45): the new key and the appliance. The new key
 * is pending until its kit is confirmed; the person is notified (signed event).
 */
export const RecoveryRotation = z.strictObject({
  purpose: z.literal(RECOVERY_ROTATE_PURPOSE),
  appliance: PeerIdString,
  newRecoveryPublicKey: PublicKeyHex,
});
export type RecoveryRotation = z.infer<typeof RecoveryRotation>;

/**
 * The person: replace the existing recovery key. `currentKeySignature` is the current recovery key's signature over
 * `recoverySigningBytes(RecoveryRotation)`. `recovery.kit.register` only works while no key exists
 * (`recovery_key_exists`).
 */
export const RecoveryKitRotateInput = z.strictObject({
  newRecoveryPublicKey: PublicKeyHex,
  currentKeySignature: SignatureHex,
});

export const RecoveryKitConfirmInput = z.strictObject({
  kitId: z.string().min(1).max(64),
  signature: SignatureHex,
});
export const RecoveryKitConfirmOutput = z.object({
  confirmed: z.literal(true),
  confirmedAt: Timestamp,
});

export const RECOVERY_KIT_CONFIRM_PURPOSE = 'whombat-recovery-kit-confirm/v1';
export const RECOVERY_ENROLL_PURPOSE = 'whombat-recovery-enroll/v1';

/** What a recovery key signs to prove the saved kit (canonical JSON). */
export const RecoveryKitConfirmation = z.strictObject({
  purpose: z.literal(RECOVERY_KIT_CONFIRM_PURPOSE),
  appliance: PeerIdString,
  kitId: z.string().min(1).max(64),
  challenge: NonceHex,
});
export type RecoveryKitConfirmation = z.infer<typeof RecoveryKitConfirmation>;

/**
 * What a recovery key signs to enroll a new endpoint of the person's: bound to the appliance, the new endpoint's
 * PeerId (must equal the session's Noise identity), the person's account, a fresh nonce and a time (±5 minutes).
 */
export const RecoveryStatement = z.strictObject({
  purpose: z.literal(RECOVERY_ENROLL_PURPOSE),
  appliance: PeerIdString,
  endpoint: PeerIdString,
  /**
   * The person's account (MA-19a; since 3.0 the only one, CT-1509); the kit must be confirmed.
   */
  accountId: AccountId,
  issuedAt: Timestamp,
  nonce: NonceHex,
});
export type RecoveryStatement = z.infer<typeof RecoveryStatement>;

export const RecoveryEnrollInput = z.strictObject({
  statement: RecoveryStatement,
  signature: SignatureHex,
  endpoint: NewEndpoint,
});

/** Bytes a recovery key signs: UTF-8 of the statement's canonical JSON. */
export function recoverySigningBytes(
  statement: RecoveryStatement | RecoveryKitConfirmation | RecoveryRotation,
): Uint8Array {
  return utf8ToBytes(canonicalJson(statement));
}

export function signRecoveryStatement(
  statement: RecoveryStatement | RecoveryKitConfirmation | RecoveryRotation,
  recoverySecretKeyHex: string,
): string {
  return signBytes(recoverySigningBytes(statement), recoverySecretKeyHex);
}

/** Strict Ed25519 (`verifyEd25519Strict`: canonical encodings, no small-order keys). */
export function verifyRecoveryStatement(
  statement: RecoveryStatement | RecoveryKitConfirmation | RecoveryRotation,
  signatureHex: string,
  recoveryPublicKeyHex: string,
): boolean {
  return verifyBytes(signatureHex, recoverySigningBytes(statement), recoveryPublicKeyHex);
}

/* Endpoint trust --------------------------------------------------------------------------------- */

/** The person's endpoints (their devices; since 3.0 without `all`, CT-1509: there is one account). */
export const EndpointsListInput = z.strictObject({});
export const EndpointsListOutput = z.object({ endpoints: z.array(EndpointSummary).max(1_000) });
/** Revoke one of the person's endpoints. Bumps the account's `authzGeneration`. */
export const EndpointsRevokeInput = z.strictObject({ endpointId: EndpointId });
export const EndpointsRevokeOutput = z.object({
  endpoint: EndpointSummary,
  authzGeneration: AuthzGeneration,
});

export const EndpointsRenameInput = z.strictObject({ endpointId: EndpointId, label: EndpointLabel });
export const OkOutput = z.object({ ok: z.literal(true) });

/* Push handle (CT-11) ---------------------------------------------------------------------------- */

/** Store this endpoint's control-issued push handle; the appliance names it in content-free push requests. */
export const PushHandlesSetInput = z.strictObject({ handle: PushHandle });
export const PushHandlesClearInput = z.strictObject({});

/* Appliance status ------------------------------------------------------------------------------- */

/** One managed-mode capability and, when unavailable, the explanation people see (MA-10). */
export const PolicyItem = z.object({ available: z.boolean(), reason: z.string().max(500).nullable() });

/**
 * Coverage classes of the backup service (MA-13; the appliance's backup `pkg/coverage`). The first ten are
 * covered by a checkpoint (`servers`, the hosts service's own backup, only on a box that has one; Whombat
 * backup-options.md CT-1697); the rest are deliberately outside it (held elsewhere or regenerable).
 */
export const BackupScope = z.enum([
  'database',
  'memory',
  'attachments',
  'packs',
  'home',
  'workspaces',
  'configuration',
  'provider-sessions',
  'recovery-references',
  'servers',
  'identity',
  'recovery-secrets',
  'manager',
  'postgres-datadir',
  'backup-state',
  'caches',
]);
export type BackupScope = z.infer<typeof BackupScope>;

/** Backup states of the backup service (never "enabled" without a successful checkpoint). */
export const BackupState = z.enum([
  /** No destination configured. */
  'unprotected',
  /** Destination configured, no successful checkpoint yet. */
  'pending',
  /** The last attempt succeeded and is recent. */
  'protected',
  /** The last success is older than the service's `staleAfter`. */
  'stale',
  /** The last attempt failed (`lastSuccessAt` still shows the previous success). */
  'failing',
]);
export type BackupState = z.infer<typeof BackupState>;

/** The client-safe backup summary in `appliance.status` (derived from the backup service's status document). */
export const BackupStatus = z.object({
  state: BackupState,
  lastSuccessAt: Timestamp.nullable(),
  /** Seconds since the last successful checkpoint. */
  ageS: z.number().int().min(0).nullable(),
  /** Classes a checkpoint covers. */
  coverage: z.array(BackupScope).max(32),
  /** Classes no checkpoint protects (shown as a warning; some by design, e.g. `identity`). */
  unprotected: z.array(BackupScope).max(32),
  /** Covered classes that need a provider re-login after a restore. */
  relogin: z.array(BackupScope).max(32),
  lastFailure: z
    .object({
      at: Timestamp,
      stage: z.enum(['preflight', 'quiesce', 'snapshot', 'dump', 'upload', 'verify']),
      /** One sentence for people. */
      reason: z.string().max(500),
    })
    .nullable(),
  /** The last restore drill succeeded (a verified checkpoint the recovery kit can restore). */
  recoverable: z.boolean(),
  /**
   * What the last backup left out, when it was made with a gap and uploaded anyway: `reason` in plain words (“1
   * attachment wasn't on this Whombat any more…”), the attachments missing, whether the servers are missing. Absent when
   * it is whole, and from an older Whombat.
   */
  incomplete: z
    .object({
      reason: z.string().max(500),
      attachments: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      servers: z.boolean().optional(),
    })
    .optional(),
  /**
   * Where bringing this Whombat back stands (Whombat backup-passkey.md): its passkey backup key, the locked copies and a
   * paper copy. Absent from an older Whombat.
   */
  bringBack: BackupBringBack.optional(),
});
export type BackupStatus = z.infer<typeof BackupStatus>;

export const UpdateStatus = z.object({
  /** The manager's journal state (MA-11 names). */
  state: UpdateJournalState,
  current: ReleaseId,
  candidate: ReleaseId.nullable(),
  lastCheckedAt: Timestamp.nullable(),
  /** Why activation waits (e.g. `task_running`), or null. */
  deferredReason: z.string().min(1).max(64).nullable(),
  failure: z.string().min(1).max(64).nullable(),
  /**
   * The manager's update facts (CT-138, UP-E4), absent when there is nothing to say: the last failure's detail (render
   * it with `describeUpdateFailure`), why a staged update waits, the last update.
   */
  failureDetail: UpdateFailureDetail.optional(),
  waiting: z
    .object({
      reason: UpdateWaitReason,
      since: Timestamp,
      blockers: z
        .array(z.object({ kind: z.string().min(1).max(64), count: z.number().int().min(0).max(1_000_000) }))
        .max(16),
    })
    .optional(),
  lastUpdate: z.object({ release: ReleaseId, from: ReleaseId.nullable(), at: Timestamp }).optional(),
  /**
   * The owner's “Ask before updating” (4.2): on, every update waits for `appliance.update.install` (`waiting.reason`
   * `owner`). Absent when the box's manager can't hold updates for the owner: no switch then.
   */
  askFirst: z.boolean().optional(),
  /** The box's update channel is paused by its release key; absent when not paused. */
  paused: z.boolean().optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;

/** `appliance.update.ask` (4.2): turn “Ask before updating” on or off; answers the setting the manager now keeps. */
export const ApplianceUpdateAskInput = z.strictObject({ askFirst: z.boolean() });
export type ApplianceUpdateAskInput = z.infer<typeof ApplianceUpdateAskInput>;
export const ApplianceUpdateAskOutput = z.object({ askFirst: z.boolean() });
export type ApplianceUpdateAskOutput = z.infer<typeof ApplianceUpdateAskOutput>;

/**
 * `appliance.update.install` (4.2): the owner approves the update waiting for them (`release`, as `update.candidate`
 * shows it); it installs at the next safe moment. Refused `conflict` when that release no longer waits for them.
 */
export const ApplianceUpdateInstallInput = z.strictObject({ release: ReleaseId });
export type ApplianceUpdateInstallInput = z.infer<typeof ApplianceUpdateInstallInput>;
export const ApplianceUpdateInstallOutput = z.object({ release: ReleaseId });
export type ApplianceUpdateInstallOutput = z.infer<typeof ApplianceUpdateInstallOutput>;

/**
 * `appliance.update.check` (minor 13; Whombat check-for-updates.md): the owner's “Check for updates”. The box looks for
 * a newer release now instead of at its next hourly look, and takes one it finds as any update (it still waits for the
 * owner where “Ask before updating” is on). `outcome`: `found` (a newer version is on its way), `upToDate` (nothing
 * newer, and no update under way), `nothingNewer` (nothing newer than the update already under way), `refused` (the box
 * found a version it won't take). `not_implemented` from a box whose manager can't check on demand; `unavailable` when
 * the release list or control can't be reached.
 */
export const ApplianceUpdateCheckInput = z.strictObject({});
export type ApplianceUpdateCheckInput = z.infer<typeof ApplianceUpdateCheckInput>;
export const APPLIANCE_UPDATE_CHECK_OUTCOMES = ['found', 'upToDate', 'nothingNewer', 'refused'] as const;
export const ApplianceUpdateCheckOutput = z.object({ outcome: z.enum(APPLIANCE_UPDATE_CHECK_OUTCOMES) });
export type ApplianceUpdateCheckOutput = z.infer<typeof ApplianceUpdateCheckOutput>;

/** Payload of `update.ask_set` (4.2): who turned “Ask before updating” on or off, and to what. */
export const UpdateAskAuditPayload = z.object({ byAccountId: AccountId, askFirst: z.boolean() });
export type UpdateAskAuditPayload = z.infer<typeof UpdateAskAuditPayload>;

/** Payload of `update.approved` (4.2): who approved the release that waited for them. */
export const UpdateApprovedAuditPayload = z.object({ byAccountId: AccountId, release: ReleaseId });
export type UpdateApprovedAuditPayload = z.infer<typeof UpdateApprovedAuditPayload>;

/**
 * Model provider account states (assignment §8: quota exhausted, auth expired, outage are distinct).
 * The same enum as core's `ProviderSignInState` (CT-70).
 */
export const ProviderState = ProviderSignInState;
export type ProviderState = z.infer<typeof ProviderState>;

/** One provider sign-in the runner can use (the person's, one per provider) and whether it works. */
export const ProviderStatus = z.object({
  /** `codex`, `claude`, `synthetic`, … */
  provider: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/),
  /** How it authenticates: `subscription` (a person's login), `api_key`, … (open set). */
  authMode: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9_]*$/),
  state: ProviderState,
  /** When the sign-in stops working (access tokens), if known. */
  expiresAt: Timestamp.nullable().optional(),
  /** `valid`: a free check accepted it; `unverified`: checked on first use. */
  verified: z.enum(['valid', 'unverified']).nullable().optional(),
  /** What people see when it isn't ready. */
  explanation: z.string().max(500).nullable(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

/** The appliance's identity and versions. */
export const ApplianceInfo = z.object({
  peerId: PeerIdString,
  runtimeVersion: z.string().min(1).max(64),
  /** Database schema version the runtime runs against (null while unknown). */
  schemaVersion: z.number().int().min(0).nullable(),
  protocol: z.object({ major: z.number().int().min(1), minor: z.number().int().min(0) }),
  /**
   * The Hermes Agent the assistant runs on (contracts 3.8; Whombat hermes-updates.md), as its runner reported it. Null
   * or absent while no runner has said.
   */
  hermes: z
    .object({ version: z.string().min(1).max(64) })
    .nullable()
    .optional(),
});
export type ApplianceInfo = z.infer<typeof ApplianceInfo>;

export const ApplianceStatusInput = z.strictObject({});
export const ApplianceStatusOutput = z.object({
  claimed: z.boolean(),
  /** The claim was reported to control (MA-04 §3). */
  claimReported: z.boolean(),
  recovery: z.object({
    enrolled: z.boolean(),
    kitVerified: z.boolean(),
    /** A rotation's new key waits for its kit to be confirmed (the previous key still works until then). */
    rotationPending: z.boolean(),
  }),
  /** Revocations not yet reported to control, and reported ones (MA-04 §6). */
  revocationsPending: z.number().int().min(0),
  revocationsApplied: z.number().int().min(0),
  /** The appliance is draining for maintenance (new work waits). */
  draining: z.boolean(),
  /** Managed-mode policy: capability → availability and explanation (MA-10). */
  policy: z.record(z.string().min(1).max(64), PolicyItem),
  backup: BackupStatus,
  update: UpdateStatus.nullable(),
  appliance: ApplianceInfo,
  providers: z.array(ProviderStatus).max(64),
  /**
   * The running release's client security floor (CT-53): the lowest build number served per platform (`0`: none);
   * null or absent when the release sets none.
   */
  clientFloor: z.object(ClientFloor.shape).nullable().optional(),
  /**
   * The licence state (0.10, LC-09; the same view as `licence.status`): null on an unclaimed appliance; absent where no
   * licence applies (a development runtime, HE-49).
   */
  licence: LicenceStatusView.nullable().optional(),
  /**
   * The box's own address (4.3; Whombat own-address.md): null when it has none (yet), absent from a box before 4.3. Not
   * a direct way: today's apps would refuse a new `DirectWay`.
   */
  ownAddress: OwnAddressSummary.nullable().optional(),
});
export type ApplianceStatusOutput = z.infer<typeof ApplianceStatusOutput>;

/* Ephemeral client ops (no receipt, no idempotency, rate-limited) ------------------------------------ */

/** Ephemeral requests per endpoint per minute (above it: `rate_limited`, dropped). */
export const EPHEMERAL_MAX_PER_MINUTE = 120;

/* Push resolve (MA-20) --------------------------------------------------------------------------------------- */

/**
 * A notification tap: the appliance maps its keyed push ref back to the item, if this member may see it (else
 * `not_found`, the same for unknown and forbidden refs). A query.
 */
export const PushResolveInput = z.strictObject({ ref: PushRef });
export const PushResolveOutput = z.object({
  /** Burrow slug the link lives in. */
  burrow: z.string().min(1).max(63),
  link: LinkRef,
});
