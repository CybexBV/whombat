/**
 * Update assignment (MA-11): control picks one TUF-approved tuple for a device or cohort and signs it with the
 * assignment key. The manager (and the root helper) accept it only if the tuple is also approved in TUF
 * metadata; an assignment alone never authorizes an artifact.
 */
import { z } from 'zod';
import { Digest, Environment, EpochSeconds, Ident, PublicKeyHex, ReleaseId } from './primitives.js';
import { signedDocument, verifyDocumentSignature } from './signed.js';

export const ASSIGNMENT_PURPOSE = 'whombat-update-assignment/v1';
/** Longest an assignment stays valid; devices refetch well before. */
export const ASSIGNMENT_MAX_LIFETIME_S = 7 * 24 * 3600;

export const AssignmentPayload = z.strictObject({
  purpose: z.literal(ASSIGNMENT_PURPOSE),
  env: Environment,
  device: Ident,
  /** Strictly increasing per device; the manager rejects a sequence ≤ the last one it accepted. */
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /**
   * What to run: an approved tuple, or `hold` (stay on the current tuple: pause or emergency stop; a hold never
   * forces a downgrade or restores data).
   */
  action: z.enum(['install', 'hold']),
  releaseId: ReleaseId.nullable(),
  /** `tupleDigest` of the approved tuple (must match the TUF-approved tuple for `releaseId`). */
  tupleDigest: Digest.nullable(),
  rolloutId: Ident.nullable(),
  cohort: Ident.nullable(),
  issuedAt: EpochSeconds,
  /** Don't activate before this time (maintenance window start). */
  notBefore: EpochSeconds,
  expiresAt: EpochSeconds,
});
export type AssignmentPayload = z.infer<typeof AssignmentPayload>;

export const SignedAssignment = signedDocument(AssignmentPayload);
export type SignedAssignment = z.infer<typeof SignedAssignment>;

export type AssignmentError =
  | 'bad_schema'
  | 'unknown_key'
  | 'bad_signature'
  | 'wrong_env'
  | 'wrong_device'
  | 'bad_action'
  | 'bad_lifetime'
  | 'expired'
  | 'not_yet_valid'
  | 'replayed';

/**
 * Checks a signed assignment for this device: schema, key, signature, env, device, action/release
 * consistency, lifetime, time (with skew) and sequence (> the last accepted).
 */
export function verifyAssignment(
  raw: unknown,
  ctx: {
    keys: Readonly<Record<string, string>>;
    env: string;
    device: string;
    now: number;
    lastSequence: number;
    clockSkewS?: number;
  },
): { ok: true; assignment: SignedAssignment } | { ok: false; error: AssignmentError } {
  const parsed = SignedAssignment.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'bad_schema' };
  const doc = parsed.data;
  const key = ctx.keys[doc.keyId];
  if (!key) return { ok: false, error: 'unknown_key' };
  if (!verifyDocumentSignature(doc, key)) return { ok: false, error: 'bad_signature' };
  const p = doc.payload;
  if (p.env !== ctx.env) return { ok: false, error: 'wrong_env' };
  if (p.device !== ctx.device) return { ok: false, error: 'wrong_device' };
  const install = p.action === 'install';
  if (install !== (p.releaseId !== null) || install !== (p.tupleDigest !== null))
    return { ok: false, error: 'bad_action' };
  if (
    p.expiresAt <= p.issuedAt ||
    p.expiresAt - p.issuedAt > ASSIGNMENT_MAX_LIFETIME_S ||
    p.notBefore < p.issuedAt
  )
    return { ok: false, error: 'bad_lifetime' };
  const skew = ctx.clockSkewS ?? 300;
  if (p.issuedAt > ctx.now + skew) return { ok: false, error: 'not_yet_valid' };
  if (ctx.now >= p.expiresAt + skew) return { ok: false, error: 'expired' };
  if (p.sequence <= ctx.lastSequence) return { ok: false, error: 'replayed' };
  return { ok: true, assignment: doc };
}

/**
 * The assignment keys a manager trusts (CT-34, CT-41): pinned in the appliance image; control serves the same document
 * for monitoring only. Key states (cross-field rules checked by `assignmentKeyMap`, not by the schema):
 * - `active`: accepted; `notBefore` and `notAfter` are null. At least one key is active.
 * - `next`: published ahead of a rotation. Accepted from `notBefore` on (a scheduled rotation, so images that pinned
 *   it follow control's switch without an update); with `notBefore: null` it is pinned but never accepted until a
 *   later document marks it `active`. `notAfter` is null.
 * - `retired`: the previous key during the grace period: accepted while `now ≤ notAfter`; `notAfter` is required
 *   (null is invalid) and `notBefore` is null.
 * Rotation with a grace period: image N pins `{k1 active, k2 next notBefore: T}`; control signs with k2 from T (plus
 * skew); image N+1 pins `{k2 active, k1 retired notAfter: T + grace}` (grace ≥ 90 days for long-offline devices).
 */
export const AssignmentKeys = z.strictObject({
  v: z.literal(1),
  env: Environment,
  keys: z
    .array(
      z.strictObject({
        kid: Ident,
        publicKey: PublicKeyHex,
        state: z.enum(['active', 'next', 'retired']),
        /** `next`: accepted from this time on (null: not yet scheduled). Null for other states. */
        notBefore: EpochSeconds.nullable(),
        /** `retired`: accepted until this time (required). Null for other states. */
        notAfter: EpochSeconds.nullable(),
      }),
    )
    .min(1)
    .max(16),
});
export type AssignmentKeys = z.infer<typeof AssignmentKeys>;

export type AssignmentKeysErrorCode =
  | 'bad_schema'
  | 'wrong_env'
  | 'duplicate_kid'
  | 'no_active_key'
  | 'active_with_window'
  | 'next_with_not_after'
  | 'retired_without_not_after'
  | 'retired_with_not_before';

export class AssignmentKeysError extends Error {
  constructor(readonly code: AssignmentKeysErrorCode) {
    super(`assignment keys: ${code}`);
    this.name = 'AssignmentKeysError';
  }
}

/**
 * The `{kid: publicKeyHex}` map for `verifyAssignment` at time `now` from a pinned document. Throws
 * `AssignmentKeysError` for an invalid document (a manager must not start verifying with it); otherwise returns the
 * keys accepted now: every `active` key, `next` keys whose `notBefore ≤ now`, `retired` keys with `now ≤ notAfter`.
 */
export function assignmentKeyMap(doc: unknown, env: string, now: number): Record<string, string> {
  const parsed = AssignmentKeys.safeParse(doc);
  if (!parsed.success) throw new AssignmentKeysError('bad_schema');
  const d = parsed.data;
  if (d.env !== env) throw new AssignmentKeysError('wrong_env');
  const kids = new Set<string>();
  for (const k of d.keys) {
    if (kids.has(k.kid)) throw new AssignmentKeysError('duplicate_kid');
    kids.add(k.kid);
    if (k.state === 'active' && (k.notBefore !== null || k.notAfter !== null))
      throw new AssignmentKeysError('active_with_window');
    if (k.state === 'next' && k.notAfter !== null) throw new AssignmentKeysError('next_with_not_after');
    if (k.state === 'retired' && k.notAfter === null)
      throw new AssignmentKeysError('retired_without_not_after');
    if (k.state === 'retired' && k.notBefore !== null)
      throw new AssignmentKeysError('retired_with_not_before');
  }
  if (!d.keys.some((k) => k.state === 'active')) throw new AssignmentKeysError('no_active_key');
  const out: Record<string, string> = {};
  for (const k of d.keys) {
    const accepted =
      k.state === 'active' ||
      (k.state === 'next' && k.notBefore !== null && k.notBefore <= now) ||
      (k.state === 'retired' && k.notAfter !== null && now <= k.notAfter);
    if (accepted) out[k.kid] = k.publicKey;
  }
  return out;
}
