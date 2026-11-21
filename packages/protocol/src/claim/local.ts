/**
 * The claim on the box's own page (Whombat hermes-engine.md HE-59, CT-1302): a community box has no control to find it,
 * lease it a lookup number or open a pending claim, so the person opens the page the box serves on its direct ways (the
 * address its console shows) and types the four letters from its screen. The exchange is the claim's (CC-06), bound to
 * both Noise keys, with the box's own claim id as `sid`.
 *
 * - `PRS` = UTF-8 of the four letters (`ClaimLetters`, the same letters, rotation and backoff as the claim through
 *   control: one set on the console, one counter).
 * - `CI` = `lv_cat("whombat-claim-local/1", appliancePeerId, clientPeerId)`, both PeerIds as each side sees them in
 *   Noise. No device id: a community box has none, and its PeerId already names it.
 * - `sid` = UTF-8 of the box's claim id (`enroll.claim.local.start` → `claimId`); tags as the claim's (`confirmed.ts`)
 *   with `info = "whombat-claim-local-confirm/1"`. Same share and tag shapes (`ClaimPakeShare`, `ClaimConfirmTag`),
 *   same error (`ClaimPakeError`), compared with `claimConfirmEqual`.
 *
 * Flow: `enroll.claim.local.start {}` → `{claimId}`; client `localClaimPakeInitiator` →
 * `enroll.claim.local.begin {claimId, share}` → appliance `localClaimPakeResponder` → `{share}` → client
 * `localClaimPakeInitiatorFinish` → `enroll.claim.local.prove {claimId, confirm: tags.client}` → appliance checks it
 * with `claimConfirmEqual` → `{confirm: tags.appliance}` → client checks that, and only then names the person:
 * `enroll.claim.local {claimId, account, endpoint}` on the same session, once.
 */
import { utf8Encode } from '../bytes.js';
import { ClaimLetters } from './code.js';
import {
  type ClaimConfirmTags,
  ClaimPakeError,
  type ConfirmedPakeInitiatorState,
  confirmedPakeInitiator,
  confirmedPakeInitiatorFinish,
  confirmedPakeResponder,
} from './confirmed.js';
import { type CpaceInputs, cpaceLvCat } from './cpace.js';

export const LOCAL_CLAIM_CI_TAG = 'whombat-claim-local/1';
export const LOCAL_CLAIM_CONFIRM_INFO = 'whombat-claim-local-confirm/1';

/** Everything both sides must agree on besides the shares. */
export interface LocalClaimPakeContext {
  /** The four letters on the console (`ClaimLetters`). */
  password: string;
  /** The appliance's PeerId as this side sees it in Noise (the client: the one it pinned from the box's page). */
  appliancePeerId: string;
  /** The client's PeerId as this side sees it in Noise (the appliance: the remote static key). */
  clientPeerId: string;
  /** The box's claim id (`enroll.claim.local.start` → `claimId`): the CPace `sid`. */
  claimId: string;
}

/** `CI = lv_cat("whombat-claim-local/1", appliancePeerId, clientPeerId)`, UTF-8. */
export function localClaimPakeCi(ctx: Omit<LocalClaimPakeContext, 'password' | 'claimId'>): Uint8Array {
  return cpaceLvCat(...[LOCAL_CLAIM_CI_TAG, ctx.appliancePeerId, ctx.clientPeerId].map(utf8Encode));
}

/** The CPace inputs of a claim on the box's page; throws `invalid_password` unless the password is four letters. */
export function localClaimPakeInputs(ctx: LocalClaimPakeContext): CpaceInputs {
  if (!ClaimLetters.safeParse(ctx.password).success) throw new ClaimPakeError('invalid_password');
  return { prs: utf8Encode(ctx.password), ci: localClaimPakeCi(ctx), sid: utf8Encode(ctx.claimId) };
}

/** The client between `enroll.claim.local.begin` and its answer (memory only). */
export type LocalClaimPakeInitiatorState = ConfirmedPakeInitiatorState;

/** Client: start the PAKE; send `share` in `enroll.claim.local.begin`. */
export function localClaimPakeInitiator(
  ctx: LocalClaimPakeContext,
  randomBytes: (n: number) => Uint8Array,
): { share: string; state: LocalClaimPakeInitiatorState } {
  return confirmedPakeInitiator(localClaimPakeInputs(ctx), randomBytes);
}

/**
 * Client, on `enroll.claim.local.begin`'s `{share}`: both tags. Send `tags.client` as `enroll.claim.local.prove`'s
 * `confirm`, and go on to `enroll.claim.local` (the person's account) only if
 * `claimConfirmEqual(tags.appliance, output.confirm)`. Throws `invalid_share`.
 */
export function localClaimPakeInitiatorFinish(
  state: LocalClaimPakeInitiatorState,
  applianceShare: string,
): ClaimConfirmTags {
  return confirmedPakeInitiatorFinish(LOCAL_CLAIM_CONFIRM_INFO, state, applianceShare);
}

/**
 * Appliance, on `enroll.claim.local.begin {claimId, share}`: its own share (answer it) and both tags (keep them with the
 * claim id and the letters' generation for this session, ≤ `ENROLL_CLAIM_BEGIN_TTL_S`). Check
 * `enroll.claim.local.prove`'s `confirm` with `claimConfirmEqual(tags.client, input.confirm)`; answer `tags.appliance`. Throws
 * `invalid_share` (refuse the begin with `claim_share_invalid`; it is not a guess).
 */
export function localClaimPakeResponder(
  ctx: LocalClaimPakeContext,
  clientShare: string,
  randomBytes: (n: number) => Uint8Array,
): { share: string; tags: ClaimConfirmTags } {
  return confirmedPakeResponder(
    LOCAL_CLAIM_CONFIRM_INFO,
    localClaimPakeInputs(ctx),
    clientShare,
    randomBytes,
  );
}
