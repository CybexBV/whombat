/**
 * The claim PAKE (CC-06, CT-59): CPace (`cpace.ts`) with the claim's inputs and an explicit key confirmation.
 *
 * - `PRS` = UTF-8 of the password: the 4 letters (`code`), or for `card` the card's `claimSecretHash(deviceId,
 *   normalized secret)` (43 base64url characters, CT-66): the appliance stores only that hash, never the secret.
 * - `CI` = `lv_cat("whombat-claim/1", method, deviceId, appliancePeerId, clientPeerId)`, both PeerIds as each side
 *   sees them in the Noise handshake it runs (so a relay that man-in-the-middles Noise gets mismatching keys).
 * - `sid` = UTF-8 of control's claim id; `ADa` = `ADb` = empty; the client is the initiator.
 * - `k = HKDF-SHA512(salt = none, IKM = ISK, info = "whombat-claim-confirm/1", L = 64)`;
 *   `tagClient = HMAC-SHA512(k, "client" ‖ transcript)[0..32]`,
 *   `tagAppliance = HMAC-SHA512(k, "appliance" ‖ transcript)[0..32]`, base64url without padding (43 characters),
 *   where `transcript = transcript_ir(Ya, b"", Yb, b"")`.
 *
 * The CPace-with-confirmation part is shared with the screen sign-in (`screen.ts`, BX-03) in `confirmed.ts`.
 *
 * Flow: client `claimPakeInitiator` → `enroll.claim.begin {share}` → appliance `claimPakeResponder` → `{share}` →
 * client `claimPakeInitiatorFinish` → `enroll.claim {confirm: tags.client}` → appliance checks it with
 * `claimConfirmEqual` → `{…, confirm: tags.appliance}` → client checks that with `claimConfirmEqual`.
 */
import { utf8Encode } from '../bytes.js';
import { ClaimLetters, type ClaimMethod } from './code.js';
import {
  type ClaimConfirmTags,
  ClaimPakeError,
  type ConfirmedPakeInitiatorState,
  confirmedPakeInitiator,
  confirmedPakeInitiatorFinish,
  confirmedPakeResponder,
  confirmTags,
} from './confirmed.js';
import { type CpaceInputs, cpaceLvCat } from './cpace.js';

export {
  CLAIM_CONFIRM_TAG_BYTES,
  ClaimConfirmTag,
  type ClaimConfirmTags,
  ClaimPakeError,
  ClaimPakeShare,
  claimConfirmEqual,
} from './confirmed.js';

export const CLAIM_PAKE_CI_TAG = 'whombat-claim/1';
export const CLAIM_CONFIRM_INFO = 'whombat-claim-confirm/1';

/** The `card` password: `claimSecretHash(deviceId, normalized secret)` (`claimCardPassword`, CT-66). */
const CARD_PASSWORD = /^[A-Za-z0-9_-]{43}$/;

/** Everything both sides must agree on besides the shares. */
export interface ClaimPakeContext {
  method: ClaimMethod;
  /** `code`: the 4 letters (`ClaimLetters`); `card`: `claimCardPassword(deviceId, normalized secret)` (CT-66). */
  password: string;
  /** Control's device id (`claims.start` → `claim.device`; the appliance's own directory id). */
  deviceId: string;
  /** The appliance's PeerId as this side sees it in Noise (the client: the pinned remote static key). */
  appliancePeerId: string;
  /** The client's PeerId as this side sees it in Noise (the appliance: the remote static key). */
  clientPeerId: string;
  /** Control's claim id (`claims.start` → `claim.claim`), also `enroll.claim.begin.claimId`. */
  claimId: string;
}

/** `CI = lv_cat("whombat-claim/1", method, deviceId, appliancePeerId, clientPeerId)`, UTF-8. */
export function claimPakeCi(ctx: Omit<ClaimPakeContext, 'password' | 'claimId'>): Uint8Array {
  return cpaceLvCat(
    ...[CLAIM_PAKE_CI_TAG, ctx.method, ctx.deviceId, ctx.appliancePeerId, ctx.clientPeerId].map(utf8Encode),
  );
}

/** The CPace inputs of a claim; throws `invalid_password` when the password doesn't fit the method. */
export function claimPakeInputs(ctx: ClaimPakeContext): CpaceInputs {
  const ok =
    ctx.method === 'code' ? ClaimLetters.safeParse(ctx.password).success : CARD_PASSWORD.test(ctx.password);
  if (!ok) throw new ClaimPakeError('invalid_password');
  return { prs: utf8Encode(ctx.password), ci: claimPakeCi(ctx), sid: utf8Encode(ctx.claimId) };
}

/** `k = HKDF-SHA512(ISK, "whombat-claim-confirm/1")`, then the two truncated HMAC-SHA512 tags. */
export function claimConfirmTags(isk: Uint8Array, transcript: Uint8Array): ClaimConfirmTags {
  return confirmTags(CLAIM_CONFIRM_INFO, isk, transcript);
}

/** The client between `enroll.claim.begin` and its answer (memory only). */
export type ClaimPakeInitiatorState = ConfirmedPakeInitiatorState;

/** Client: start the PAKE; send `share` in `enroll.claim.begin`. */
export function claimPakeInitiator(
  ctx: ClaimPakeContext,
  randomBytes: (n: number) => Uint8Array,
): { share: string; state: ClaimPakeInitiatorState } {
  return confirmedPakeInitiator(claimPakeInputs(ctx), randomBytes);
}

/**
 * Client, on `enroll.claim.begin`'s `{share}`: both tags. Send `tags.client` as `enroll.claim.confirm`, and accept
 * the result only if `claimConfirmEqual(tags.appliance, output.confirm)`. Throws `invalid_share` (abort).
 */
export function claimPakeInitiatorFinish(
  state: ClaimPakeInitiatorState,
  applianceShare: string,
): ClaimConfirmTags {
  return confirmedPakeInitiatorFinish(CLAIM_CONFIRM_INFO, state, applianceShare);
}

/**
 * Appliance, on `enroll.claim.begin {share}`: its own share (answer it) and both tags (keep them with the claim id and
 * method for this session, ≤ `ENROLL_CLAIM_BEGIN_TTL_S`). Check `enroll.claim.confirm` with
 * `claimConfirmEqual(tags.client, input.confirm)` before anything else; answer `tags.appliance`. Throws
 * `invalid_share` (refuse the begin; it is not a guess).
 */
export function claimPakeResponder(
  ctx: ClaimPakeContext,
  clientShare: string,
  randomBytes: (n: number) => Uint8Array,
): { share: string; tags: ClaimConfirmTags } {
  return confirmedPakeResponder(CLAIM_CONFIRM_INFO, claimPakeInputs(ctx), clientShare, randomBytes);
}
