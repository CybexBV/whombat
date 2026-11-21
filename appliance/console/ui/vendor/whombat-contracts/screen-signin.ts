/**
 * Sign in at the box's screen (Whombat signin-at-box.md BX-02…BX-04, CT-620, CT-621): a device that isn't let in asks
 * the box for a code (`enroll.screen.request`), the box shows six letters on its own screen, the person types them on
 * the device, and the claim's exchange (CC-06) bound to both Noise keys lets the device in to the account it named.
 *
 * - The letters: six from `CLAIM_CODE_ALPHABET` (20⁶ = 64 million), drawn by CT-58's byte rule
 *   (`generateScreenSignInLetters`), shown grouped `KXQ MTR` (`formatScreenSignInLetters`); the space isn't typed.
 * - The PAKE: `PRS` = UTF-8 of the six letters;
 *   `CI` = `lv_cat("whombat-screen-signin/1", deviceId, appliancePeerId, clientPeerId)`, both PeerIds as each side sees
 *   them in Noise; `sid` = UTF-8 of the sign-in id; tags as the claim's (`confirmed.ts`) with
 *   `info = "whombat-screen-signin-confirm/1"`. Same share and tag shapes (`ClaimPakeShare`, `ClaimConfirmTag`), same
 *   error (`ClaimPakeError`), compared with `claimConfirmEqual`.
 *
 * Flow: `enroll.screen.request {email, endpoint}` → `{signinId}`; client `screenSignInPakeInitiator` →
 * `enroll.screen.begin {signinId, share}` → appliance `screenSignInPakeResponder` → `{share}` → client
 * `screenSignInPakeInitiatorFinish` → `enroll.screen {signinId, confirm: tags.client}` → appliance checks it with
 * `claimConfirmEqual` → `{…, confirm: tags.appliance}` → client checks that before it pins the PeerId.
 */
import { z } from 'zod';
import { utf8Encode } from '../bytes.js';
import { drawAlphabetLetters, foldTypedCode } from './alphabet.js';
import {
  type ClaimConfirmTags,
  ClaimPakeError,
  type ConfirmedPakeInitiatorState,
  confirmedPakeInitiator,
  confirmedPakeInitiatorFinish,
  confirmedPakeResponder,
} from './confirmed.js';
import { type CpaceInputs, cpaceLvCat } from './cpace.js';

export const SCREEN_SIGNIN_LETTERS_LENGTH = 6;
/** Six letters from `CLAIM_CODE_ALPHABET` (BX-04), in order: the PAKE password. */
export const ScreenSignInLetters = z.string().regex(/^[ABCDEFGHJKMNPQRTVWXY]{6}$/);
export type ScreenSignInLetters = z.infer<typeof ScreenSignInLetters>;

/**
 * Six letters from a CSPRNG by CT-58's byte rule (`generateClaimLetters`'s): a byte `b < 240` gives
 * `CLAIM_CODE_ALPHABET[b % 20]`, a byte ≥ 240 is skipped; `randomBytes(n)` is asked for 6 bytes, then for as many as
 * letters are still missing. Pass `crypto.getRandomValues`-backed randomness.
 */
export function generateScreenSignInLetters(randomBytes: (n: number) => Uint8Array): ScreenSignInLetters {
  return drawAlphabetLetters(SCREEN_SIGNIN_LETTERS_LENGTH, randomBytes);
}

/**
 * Typed input → the letters: ASCII upper-case (`a–z` only), drop Unicode White_Space, U+FEFF and `-` (the claim
 * code's set); six letters of `CLAIM_CODE_ALPHABET`, else null. Nothing is repaired (`O`, `I`, `S` … stay wrong).
 */
export function normalizeScreenSignInLetters(input: string): ScreenSignInLetters | null {
  const s = foldTypedCode(input);
  return ScreenSignInLetters.safeParse(s).success ? s : null;
}

/** `KXQMTR` → `KXQ MTR`, for display only. Throws on anything but six letters. */
export function formatScreenSignInLetters(letters: string): string {
  if (!ScreenSignInLetters.safeParse(letters).success) throw new Error('not screen sign-in letters');
  return `${letters.slice(0, 3)} ${letters.slice(3)}`;
}

export const SCREEN_SIGNIN_CI_TAG = 'whombat-screen-signin/1';
export const SCREEN_SIGNIN_CONFIRM_INFO = 'whombat-screen-signin-confirm/1';

/** Everything both sides must agree on besides the shares. */
export interface ScreenSignInPakeContext {
  /** The six letters (`ScreenSignInLetters`). */
  password: string;
  /** The box's device id (`appliance_state.claim_device_id`; the app's `/appliances/<device>`). */
  deviceId: string;
  /** The appliance's PeerId as this side sees it in Noise (the client: the pinned or the directory's key). */
  appliancePeerId: string;
  /** The client's PeerId as this side sees it in Noise (the appliance: the remote static key). */
  clientPeerId: string;
  /** The sign-in id (`enroll.screen.request` → `signinId`): the CPace `sid`. */
  signinId: string;
}

/** `CI = lv_cat("whombat-screen-signin/1", deviceId, appliancePeerId, clientPeerId)`, UTF-8. */
export function screenSignInPakeCi(ctx: Omit<ScreenSignInPakeContext, 'password' | 'signinId'>): Uint8Array {
  return cpaceLvCat(
    ...[SCREEN_SIGNIN_CI_TAG, ctx.deviceId, ctx.appliancePeerId, ctx.clientPeerId].map(utf8Encode),
  );
}

/** The CPace inputs of a screen sign-in; throws `invalid_password` unless the password is six letters. */
export function screenSignInPakeInputs(ctx: ScreenSignInPakeContext): CpaceInputs {
  if (!ScreenSignInLetters.safeParse(ctx.password).success) throw new ClaimPakeError('invalid_password');
  return { prs: utf8Encode(ctx.password), ci: screenSignInPakeCi(ctx), sid: utf8Encode(ctx.signinId) };
}

/** The client between `enroll.screen.begin` and its answer (memory only). */
export type ScreenSignInPakeInitiatorState = ConfirmedPakeInitiatorState;

/** Client: start the PAKE; send `share` in `enroll.screen.begin`. */
export function screenSignInPakeInitiator(
  ctx: ScreenSignInPakeContext,
  randomBytes: (n: number) => Uint8Array,
): { share: string; state: ScreenSignInPakeInitiatorState } {
  return confirmedPakeInitiator(screenSignInPakeInputs(ctx), randomBytes);
}

/**
 * Client, on `enroll.screen.begin`'s `{share}`: both tags. Send `tags.client` as `enroll.screen.confirm`, and accept
 * the result (pin the PeerId) only if `claimConfirmEqual(tags.appliance, output.confirm)`. Throws `invalid_share`.
 */
export function screenSignInPakeInitiatorFinish(
  state: ScreenSignInPakeInitiatorState,
  applianceShare: string,
): ClaimConfirmTags {
  return confirmedPakeInitiatorFinish(SCREEN_SIGNIN_CONFIRM_INFO, state, applianceShare);
}

/**
 * Appliance, on `enroll.screen.begin {signinId, share}`: its own share (answer it) and both tags (keep them with the
 * sign-in id and the letters' generation for this session, ≤ `ENROLL_CLAIM_BEGIN_TTL_S`). Check `enroll.screen.confirm`
 * with `claimConfirmEqual(tags.client, input.confirm)` before anything else; answer `tags.appliance`. Throws
 * `invalid_share` (refuse the begin with `screen_share_invalid`; it is not a guess).
 */
export function screenSignInPakeResponder(
  ctx: ScreenSignInPakeContext,
  clientShare: string,
  randomBytes: (n: number) => Uint8Array,
): { share: string; tags: ClaimConfirmTags } {
  return confirmedPakeResponder(
    SCREEN_SIGNIN_CONFIRM_INFO,
    screenSignInPakeInputs(ctx),
    clientShare,
    randomBytes,
  );
}
