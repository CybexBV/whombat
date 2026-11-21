/**
 * CPace (`cpace.ts`) with an explicit key confirmation: what the claim PAKE (`pake.ts`, CC-06, CT-59) and the screen
 * sign-in (`screen.ts`, BX-03, CT-621) share. The client is the initiator; `ADa` = `ADb` = empty;
 * `k = HKDF-SHA512(salt = none, IKM = ISK, info, L = 64)`, `tagClient = HMAC-SHA512(k, "client" ‖ transcript)[0..32]`,
 * `tagAppliance = HMAC-SHA512(k, "appliance" ‖ transcript)[0..32]`, base64url without padding (43 characters), where
 * `transcript = transcript_ir(Ya, b"", Yb, b"")`. Each ceremony brings its own `CpaceInputs` and `info`. The shared
 * wire shapes and the error are re-exported from `pake.ts`; the functions here aren't exported from the index.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { base64urlDecode, base64urlEncode, utf8Encode } from '../bytes.js';
import {
  CpaceError,
  type CpaceInitiatorState,
  type CpaceInputs,
  cpaceInitiatorFinish,
  cpaceInitiatorStart,
  cpaceResponderRespond,
} from './cpace.js';

/** Confirmation tags are HMAC-SHA512 truncated to 32 bytes. */
export const CLAIM_CONFIRM_TAG_BYTES = 32;

/** A CPace share on the wire: the 32-byte ristretto255 encoding, base64url without padding. */
export const ClaimPakeShare = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** A key-confirmation tag (`tagClient` / `tagAppliance`), base64url without padding. */
export const ClaimConfirmTag = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export class ClaimPakeError extends Error {
  constructor(
    /** `invalid_share`: the peer's share is malformed or invalid (abort); `invalid_password`: wrong shape. */
    readonly code: 'invalid_share' | 'invalid_password',
  ) {
    super(
      code === 'invalid_share' ? 'claim PAKE: invalid share' : 'claim PAKE: the password has the wrong shape',
    );
    this.name = 'ClaimPakeError';
  }
}

/** Both confirmation tags, from `ISK` and the transcript. */
export interface ClaimConfirmTags {
  /** `tagClient`: the client sends it (`enroll.claim.confirm`, `enroll.screen.confirm`). */
  client: string;
  /** `tagAppliance`: the appliance answers it (the output's `confirm`). */
  appliance: string;
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** `k = HKDF-SHA512(ISK, info)`, then the two truncated HMAC-SHA512 tags over the role label and the transcript. */
export function confirmTags(info: string, isk: Uint8Array, transcript: Uint8Array): ClaimConfirmTags {
  const k = hkdf(sha512, isk, undefined, utf8Encode(info), 64);
  const tag = (role: string) =>
    base64urlEncode(
      hmac(sha512, k, concat(utf8Encode(role), transcript)).subarray(0, CLAIM_CONFIRM_TAG_BYTES),
    );
  return { client: tag('client'), appliance: tag('appliance') };
}

function decodeShare(share: string): Uint8Array {
  if (!ClaimPakeShare.safeParse(share).success) throw new ClaimPakeError('invalid_share');
  try {
    return base64urlDecode(share);
  } catch {
    throw new ClaimPakeError('invalid_share');
  }
}

/** The client between its begin and the answer (memory only). */
export interface ConfirmedPakeInitiatorState {
  readonly cpace: CpaceInitiatorState;
}

/** Client: start; send `share` in the begin. */
export function confirmedPakeInitiator(
  inputs: CpaceInputs,
  randomBytes: (n: number) => Uint8Array,
): { share: string; state: ConfirmedPakeInitiatorState } {
  const cpace = cpaceInitiatorStart(inputs, randomBytes);
  return { share: base64urlEncode(cpace.share), state: { cpace } };
}

/** Client, on the begin's `{share}`: both tags. Throws `invalid_share` (abort). */
export function confirmedPakeInitiatorFinish(
  info: string,
  state: ConfirmedPakeInitiatorState,
  applianceShare: string,
): ClaimConfirmTags {
  try {
    const { isk, transcript } = cpaceInitiatorFinish(state.cpace, decodeShare(applianceShare));
    return confirmTags(info, isk, transcript);
  } catch (e) {
    if (e instanceof CpaceError) throw new ClaimPakeError('invalid_share');
    throw e;
  }
}

/** Appliance, on the begin's `{share}`: its own share and both tags. Throws `invalid_share` (not a guess). */
export function confirmedPakeResponder(
  info: string,
  inputs: CpaceInputs,
  clientShare: string,
  randomBytes: (n: number) => Uint8Array,
): { share: string; tags: ClaimConfirmTags } {
  const ya = decodeShare(clientShare);
  try {
    const { share, isk, transcript } = cpaceResponderRespond(inputs, ya, randomBytes);
    return { share: base64urlEncode(share), tags: confirmTags(info, isk, transcript) };
  } catch (e) {
    if (e instanceof CpaceError) throw new ClaimPakeError('invalid_share');
    throw e;
  }
}

/**
 * Constant-time comparison of two confirmation tags (as strings). False for anything that isn't a well-formed tag;
 * the time depends only on the (public) length.
 */
export function claimConfirmEqual(expected: string, received: string): boolean {
  if (!ClaimConfirmTag.safeParse(expected).success || !ClaimConfirmTag.safeParse(received).success)
    return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}
