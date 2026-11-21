/**
 * The signed appliance licence (LC-01…LC-12, CT-76): a compact JWS, `alg: EdDSA` (Ed25519), that control signs from
 * the org's entitlement (device op `licence.renew`) and the appliance verifies against a key set pinned in its
 * image (`LicenceKeySet`, LC-03). Nothing on a device fetches licence keys over the network.
 *
 * Verification is the admission model (strict RFC 8032, small-order keys refused, the same rules in Go). Expiry is
 * not a verification error: the runtime still reads an expired token to compute its grace period. `licenceStatus`
 * turns the verified claims and the appliance's clocks into `licensed | grace | lapsed` (LC-09); the Go twin
 * (`protocol.VerifyLicenceToken`, `protocol.LicenceStatus`) follows `vectors/licence.json`.
 */
import { z } from 'zod';
import { ADMISSION_ALG, AdmissionClaims, Ed25519Jwk, EpochSeconds, OpaqueId } from './admission.js';
import { type Ed25519Sign, type Ed25519Verify, signCompactEdDsa, verifyCompactEdDsa } from './jws.js';

export const LICENCE_TYP = 'whombat-licence+jwt';
export const LICENCE_ALG = ADMISSION_ALG;

/** `exp − iat` of every token control issues, and the maximum a verifier accepts (14 days, LC-02). */
export const LICENCE_LIFETIME_S = 1_209_600;
/** Control's `renewAfterS` while the org is `trialing` or `active` (the manager adds ±10 % jitter). */
export const LICENCE_RENEW_S = 86_400;
/** Control's `renewAfterS` in every other state, so a restored subscription shows up within the hour. */
export const LICENCE_RENEW_UNPAID_S = 3_600;
/** Grace after `exp` (or after the claim, without a token) before the licence lapses (30 days). */
export const LICENCE_GRACE_S = 2_592_000;
/** Tolerated clock skew for `iat`/`nbf`. */
export const LICENCE_CLOCK_SKEW_S = 300;
/** Largest token accepted (4 KiB). */
export const LICENCE_MAX_BYTES = 4_096;
/** `aud` = this prefix + the key set's `env`. */
export const LICENCE_AUDIENCE_PREFIX = 'whombat-appliance:';

/** Moved here from `@whombat/control-contracts` (billing), which re-exports it (LC-01). */
export const EntitlementState = z.enum(['trialing', 'active', 'past_due', 'grace', 'cancelled']);
export type EntitlementState = z.infer<typeof EntitlementState>;

/** A licence token (compact JWS, at most 4 KiB); `verifyLicenceToken` checks the rest. */
export const LicenceToken = z
  .string()
  .min(16)
  .max(LICENCE_MAX_BYTES)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

/** Environment name of a licence key set and audience (`dev`, `test`, `prod`, …). */
export const LicenceEnv = z.string().regex(/^[a-z0-9-]{1,32}$/);

/** `whombat-appliance:<env>`. */
export const LicenceAudience = z
  .string()
  .max(64)
  .regex(/^whombat-appliance:[a-z0-9-]{1,32}$/);

/** The org's plan id (`trial`, `team`, …). */
export const LicencePlan = z.string().regex(/^[a-z0-9-]{1,32}$/);

const LimitCount = z.number().int().min(0).max(100_000);

/**
 * What the plan allows (LC-10, LC-11). `devices` is control's (claimed appliances of the org); `connectors` is
 * enforced by the appliance on adding only, `null` = unlimited. A Whombat has exactly one agent (Whombat one-agent.md
 * OA-02) and is one person's (one-person.md OP-01, OP-11; 3.0, CT-1562), so no plan counts agents or people.
 */
export const LicenceLimits = z.strictObject({
  devices: z.number().int().min(0).max(10_000),
  connectors: LimitCount.nullable(),
});
export type LicenceLimits = z.infer<typeof LicenceLimits>;

export const LicenceHeader = z.strictObject({
  alg: z.literal(LICENCE_ALG),
  kid: OpaqueId,
  typ: z.literal(LICENCE_TYP),
});
export type LicenceHeader = z.infer<typeof LicenceHeader>;

export const LicenceClaims = z.strictObject({
  /** Control's base URL. */
  iss: AdmissionClaims.shape.iss,
  aud: LicenceAudience,
  /** The device id (control's directory id, the appliance ticket's `sub`). */
  sub: OpaqueId,
  org: OpaqueId,
  plan: LicencePlan,
  state: EntitlementState,
  limits: LicenceLimits,
  iat: EpochSeconds,
  nbf: EpochSeconds,
  exp: EpochSeconds,
  /** Unique token id (≥ 128 bits, base64url). */
  jti: z
    .string()
    .min(22)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export type LicenceClaims = z.infer<typeof LicenceClaims>;

/**
 * The licence public keys an appliance trusts, pinned in its image (LC-03: the NixOS module writes
 * `/etc/whombat/licence-keys.json`; the runtime reads `WHOMBAT_LICENCE_KEYS_FILE`, the manager `licence.keysFile`).
 * `env` fixes the audience (`licenceAudience(env)`). Kids start with `lic-` by convention; a licence key is never an
 * admission or assignment key. Rotation ships the next key in a release before control signs with it.
 */
export const LicenceKeySet = z.strictObject({
  v: z.literal(1),
  env: LicenceEnv,
  keys: z.array(Ed25519Jwk).min(1).max(8),
});
export type LicenceKeySet = z.infer<typeof LicenceKeySet>;

/** The audience a key set's tokens must carry. */
export function licenceAudience(env: string): string {
  return `${LICENCE_AUDIENCE_PREFIX}${env}`;
}

export const LicenceErrorCode = z.enum([
  /** Not three base64url segments, longer than 4 KiB, bad JSON or a bad signature length. */
  'malformed',
  /** The header is not `{alg: EdDSA, kid, typ: whombat-licence+jwt}` (an admission ticket fails here). */
  'bad_header',
  /** No key with that `kid` in the pinned set. */
  'unknown_kid',
  'bad_signature',
  /** The claims don't match the schema (missing or extra members, bad formats). */
  'bad_claims',
  /** `aud` isn't `whombat-appliance:<keySet.env>`. */
  'wrong_audience',
  /** `sub` isn't this device. */
  'wrong_device',
  /** `nbf < iat`, `exp ≤ nbf`, or `exp − iat` over 14 days. */
  'bad_lifetime',
  /** `iat` or `nbf` is later than the effective time plus the skew. */
  'not_yet_valid',
]);
export type LicenceErrorCode = z.infer<typeof LicenceErrorCode>;

export type LicenceResult =
  | { ok: true; header: LicenceHeader; claims: LicenceClaims }
  | { ok: false; error: LicenceErrorCode };

export interface VerifyLicenceOptions {
  /** The pinned key set (parse it with `LicenceKeySet` first). */
  keySet: LicenceKeySet;
  /** This appliance's device id; the token's `sub` must equal it. */
  device: string;
  /** The caller's effective time in seconds since the epoch (the runtime: max(clock, highWater, clockMark)). */
  now: number;
  /** Ed25519 verification; default `verifyEd25519Strict` (strict RFC 8032, like Go). */
  verify?: Ed25519Verify;
}

/**
 * Verifies a licence token: structure, header, key, signature, claims schema, audience, device, then the lifetime
 * (`nbf ≥ iat`, `exp > nbf`, `exp − iat ≤ 14 d`) and `iat`/`nbf` ≤ now + 300 s. An expired token passes: its state
 * comes from `licenceStatus`.
 */
export function verifyLicenceToken(token: string, options: VerifyLicenceOptions): LicenceResult {
  const verified = verifyCompactEdDsa(token, {
    maxLength: LICENCE_MAX_BYTES,
    header: LicenceHeader,
    claims: LicenceClaims,
    keys: options.keySet.keys,
    verify: options.verify,
  });
  if (!verified.ok) return verified;
  const fail = (error: LicenceErrorCode): LicenceResult => ({ ok: false, error });
  const { claims } = verified;

  if (claims.aud !== licenceAudience(options.keySet.env)) return fail('wrong_audience');
  if (claims.sub !== options.device) return fail('wrong_device');
  if (claims.nbf < claims.iat || claims.exp <= claims.nbf || claims.exp - claims.iat > LICENCE_LIFETIME_S)
    return fail('bad_lifetime');
  if (claims.iat > options.now + LICENCE_CLOCK_SKEW_S || claims.nbf > options.now + LICENCE_CLOCK_SKEW_S)
    return fail('not_yet_valid');
  return { ok: true, header: verified.header, claims };
}

/** Signs a licence token (control, and tests). Validates header and claims first; throws when invalid. */
export function signLicenceToken(header: LicenceHeader, claims: LicenceClaims, sign: Ed25519Sign): string {
  return signCompactEdDsa(LicenceHeader.parse(header), LicenceClaims.parse(claims), sign);
}

/* Licence state (LC-09) ------------------------------------------------------------------------------------ */

export const LicenceState = z.enum(['licensed', 'grace', 'lapsed']);
export type LicenceState = z.infer<typeof LicenceState>;

/**
 * Why: `active`, `trial`, `past_due` (licensed); `payment` (grace: the org's entitlement is in `grace`),
 * `not_renewed` (grace: the token expired and no newer one arrived); `expired` (lapsed after the grace period),
 * `cancelled` (lapsed: the org cancelled); `no_licence` (a claimed box that never verified a token: grace for 30 days
 * after the claim, then lapsed, with the same reason in both phases).
 */
export const LicenceReason = z.enum([
  'active',
  'trial',
  'past_due',
  'payment',
  'not_renewed',
  'no_licence',
  'cancelled',
  'expired',
]);
export type LicenceReason = z.infer<typeof LicenceReason>;

/**
 * `licenceStatus`'s answer, in epoch seconds. `plan`, `limits` and `renewedAt` (the token's `iat`) are null without a
 * token. `expiresAt` is the token's `exp` (null without one). `graceEndsAt` is when the grace period ends (`exp` or,
 * without a token, the claim time, plus the grace), null for `cancelled`, which has no grace. `effectiveAt` is the
 * time the state was computed for: max(now, highWater, clockMark).
 */
export const LicenceStatusResult = z.object({
  state: LicenceState,
  reason: LicenceReason,
  plan: LicencePlan.nullable(),
  limits: LicenceLimits.nullable(),
  renewedAt: EpochSeconds.nullable(),
  expiresAt: EpochSeconds.nullable(),
  graceEndsAt: EpochSeconds.nullable(),
  effectiveAt: EpochSeconds,
});
export type LicenceStatusResult = z.infer<typeof LicenceStatusResult>;

export interface LicenceStatusParams {
  /** Claims of the stored token that passed `verifyLicenceToken` (null: none). */
  claims: LicenceClaims | null;
  /** The local clock, epoch seconds. */
  now: number;
  /** The manager's high-water mark (max of accepted `iat`s and control's `now`), LC-06. */
  highWater: number;
  /** The runtime's own clock mark, LC-07. */
  clockMark: number;
  /** When the appliance was claimed (null: unclaimed). */
  claimedAt: number | null;
  /** Grace after `exp`; default `LICENCE_GRACE_S`. */
  graceS?: number;
}

const WHILE_VALID: Readonly<
  Record<Exclude<EntitlementState, 'cancelled'>, { state: LicenceState; reason: LicenceReason }>
> = {
  trialing: { state: 'licensed', reason: 'trial' },
  active: { state: 'licensed', reason: 'active' },
  past_due: { state: 'licensed', reason: 'past_due' },
  grace: { state: 'grace', reason: 'payment' },
};

/**
 * The licence state (LC-09). Effective time t = max(now, highWater, clockMark), so a clock rolled back never gains
 * time. With claims: `cancelled` → lapsed (`cancelled`); while t < exp the entitlement state decides (trialing →
 * licensed/trial, active → licensed/active, past_due → licensed/past_due, grace → grace/payment); from exp to
 * exp + grace → grace (`not_renewed`); after that → lapsed (`expired`). Without claims on a claimed box the claim
 * time counts as exp: grace (`no_licence`) until claimedAt + grace, then lapsed (`no_licence`). An unclaimed box
 * without a token has no licence state (null).
 */
export function licenceStatus(input: LicenceStatusParams): LicenceStatusResult | null {
  const graceS = input.graceS ?? LICENCE_GRACE_S;
  const t = Math.max(input.now, input.highWater, input.clockMark);
  const { claims } = input;
  if (!claims) {
    if (input.claimedAt === null) return null;
    const graceEndsAt = input.claimedAt + graceS;
    return {
      state: t < graceEndsAt ? 'grace' : 'lapsed',
      reason: 'no_licence',
      plan: null,
      limits: null,
      renewedAt: null,
      expiresAt: null,
      graceEndsAt,
      effectiveAt: t,
    };
  }
  const graceEndsAt = claims.state === 'cancelled' ? null : claims.exp + graceS;
  const verdict =
    claims.state === 'cancelled'
      ? { state: 'lapsed' as const, reason: 'cancelled' as const }
      : t < claims.exp
        ? WHILE_VALID[claims.state]
        : t < (graceEndsAt as number)
          ? { state: 'grace' as const, reason: 'not_renewed' as const }
          : { state: 'lapsed' as const, reason: 'expired' as const };
  return {
    state: verdict.state,
    reason: verdict.reason,
    plan: claims.plan,
    limits: { ...claims.limits },
    renewedAt: claims.iat,
    expiresAt: claims.exp,
    graceEndsAt,
    effectiveAt: t,
  };
}
