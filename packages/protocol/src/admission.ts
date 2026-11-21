/**
 * Admission tickets (MA-06): compact JWS, `alg: EdDSA` (Ed25519), signed by control, verified by the relay.
 * A ticket admits traffic only; the appliance authenticates every session itself.
 *
 * The verifier is pure: the caller passes the JWKS and the current time, and may inject the Ed25519 verify
 * function (default: strict RFC 8032 verification that also refuses small-order keys, the same rules as Go). Single use of client tickets (`jti`) is
 * the relay's job (it needs state); `verifyAdmissionTicket` returns the `jti` and `exp` to remember.
 */
import { z } from 'zod';
import { base64urlEncode } from './bytes.js';
import { type Ed25519Sign, type Ed25519Verify, signCompactEdDsa, verifyCompactEdDsa } from './jws.js';
import { RELAY_MAX_TICKET_BYTES, TICKET_CLOCK_SKEW_S, TICKET_MAX_LIFETIME_S } from './limits.js';
import { OwnAddressLabel } from './own-address.js';

export const ADMISSION_TYP = 'whombat-admission+jwt';
export const ADMISSION_ALG = 'EdDSA';

/** Key ids, opaque route/subject/org/worker ids in tickets. */
export const OpaqueId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export type OpaqueId = z.infer<typeof OpaqueId>;

/** `whombat-relay:<env>` (`local`, `dev`, `prod`, or another lowercase environment name). */
export const RelayAudience = z
  .string()
  .max(64)
  .regex(/^whombat-relay:[a-z0-9-]{1,32}$/);

/** Seconds since the epoch, bounded to year 2100. */
export const EpochSeconds = z.number().int().min(0).max(4_102_444_800);

export const AdmissionHeader = z.strictObject({
  alg: z.literal(ADMISSION_ALG),
  kid: OpaqueId,
  typ: z.literal(ADMISSION_TYP),
});
export type AdmissionHeader = z.infer<typeof AdmissionHeader>;

export const TicketRole = z.enum(['client', 'appliance']);
export type TicketRole = z.infer<typeof TicketRole>;
/** Advisory channel (quota/UI); the appliance enforces enrollment-only rights from the Noise identity. */
export const TicketChannel = z.enum(['app', 'enroll']);
export type TicketChannel = z.infer<typeof TicketChannel>;

export const AdmissionClaims = z.strictObject({
  /** Control's base URL. */
  iss: z
    .string()
    .min(8)
    .max(256)
    .regex(/^https?:\/\/[\x21-\x7e]+$/),
  aud: RelayAudience,
  rol: TicketRole,
  /** Opaque appliance route id. */
  apl: OpaqueId,
  /** Pseudonymous account id (client) or device id (appliance). */
  sub: OpaqueId,
  /** Owning org; absent for an unclaimed appliance (reachable on the enrollment channel; "unclaimed" quota). */
  org: OpaqueId.optional(),
  /** Assigned relay worker id. */
  wrk: OpaqueId,
  chn: TicketChannel,
  iat: EpochSeconds,
  nbf: EpochSeconds,
  exp: EpochSeconds,
  /** Unique ticket id (≥ 128 bits, base64url). */
  jti: z
    .string()
    .min(22)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  /**
   * The box's registered own-address label (4.3; Whombat own-address.md): only in appliance tickets of its main route,
   * and only once control's switch is on, which comes after the relay takes 4.3 (an older relay refuses the member).
   */
  lbl: OwnAddressLabel.optional(),
});
export type AdmissionClaims = z.infer<typeof AdmissionClaims>;

/**
 * One Ed25519 public key (RFC 8037), as control publishes it in the admission JWKS and in the licence key set.
 * Strict (cross-language subset): exactly these members; a private `d` or anything else is refused.
 */
export const Ed25519Jwk = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  kid: OpaqueId,
  /** 32-byte public key, base64url (43 characters). */
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  alg: z.literal(ADMISSION_ALG).optional(),
  use: z.literal('sig').optional(),
});
export type Ed25519Jwk = z.infer<typeof Ed25519Jwk>;

/** One key in control's admission JWKS: an `Ed25519Jwk` (the same schema, CT-76). */
export const AdmissionJwk = Ed25519Jwk;
export type AdmissionJwk = Ed25519Jwk;

export const AdmissionJwks = z.strictObject({
  keys: z.array(AdmissionJwk).min(1).max(16),
});
export type AdmissionJwks = z.infer<typeof AdmissionJwks>;

/** The injected Ed25519 functions, declared with the verifier admission tickets and licence tokens share. */
export type { Ed25519Sign, Ed25519Verify };

export const AdmissionErrorCode = z.enum([
  /** Not three base64url segments, too long, bad JSON or bad signature length. */
  'malformed',
  /** Header is not `{alg: EdDSA, kid, typ: whombat-admission+jwt}`. */
  'bad_header',
  /** No key with that `kid` in the JWKS. */
  'unknown_kid',
  'bad_signature',
  /** Claims don't match the schema (missing/extra members, bad formats). */
  'bad_claims',
  'wrong_audience',
  'wrong_issuer',
  'wrong_role',
  /** `wrk` is not this relay worker (the client must fetch a ticket for its assigned worker). */
  'wrong_worker',
  /** `iat`/`nbf`/`exp` are inconsistent or the lifetime exceeds 300 s. */
  'bad_lifetime',
  /** `iat` or `nbf` is in the future (beyond the clock skew). */
  'not_yet_valid',
  'expired',
]);
export type AdmissionErrorCode = z.infer<typeof AdmissionErrorCode>;

/**
 * Close code for each verification failure (MA-05): the role doesn't fit the connection → 4403, another worker's
 * ticket → 4421, anything else (malformed, bad signature, expired, …) → 4401.
 */
export const ADMISSION_ERROR_CLOSE: Readonly<Record<AdmissionErrorCode, 4401 | 4403 | 4421>> = {
  malformed: 4401,
  bad_header: 4401,
  unknown_kid: 4401,
  bad_signature: 4401,
  bad_claims: 4401,
  wrong_audience: 4401,
  wrong_issuer: 4401,
  wrong_role: 4403,
  wrong_worker: 4421,
  bad_lifetime: 4401,
  not_yet_valid: 4401,
  expired: 4401,
};

export type AdmissionResult =
  | { ok: true; header: AdmissionHeader; claims: AdmissionClaims }
  | { ok: false; error: AdmissionErrorCode };

export interface VerifyAdmissionOptions {
  jwks: AdmissionJwks;
  /** Ed25519 verification; default `verifyEd25519Strict` from `@whombat/core/audit` (strict RFC 8032, like Go). */
  verify?: Ed25519Verify;
  /** Current time, seconds since the epoch. */
  now: number;
  /** Expected `aud` (`whombat-relay:<env>`). */
  audience: string;
  /** Expected `iss`, when the verifier knows it. */
  issuer?: string;
  /** Expected `rol` (the relay knows whether it is a client or an appliance connection). */
  role?: TicketRole;
  /** This relay worker's id; a ticket for another worker fails with `wrong_worker`. */
  worker?: string;
  /** Tolerated clock skew in seconds (default 30). */
  clockSkewS?: number;
}

/**
 * Verifies a ticket: structure, header, key, signature, claims schema, audience/issuer/role, then time
 * bounds (`nbf ≥ iat`, `exp > nbf`, `exp − iat ≤ 300`, `iat`/`nbf` ≤ now + skew, now < exp + skew). Map a failure
 * to a close code with `ADMISSION_ERROR_CLOSE`.
 */
export function verifyAdmissionTicket(token: string, options: VerifyAdmissionOptions): AdmissionResult {
  const verified = verifyCompactEdDsa(token, {
    maxLength: RELAY_MAX_TICKET_BYTES,
    header: AdmissionHeader,
    claims: AdmissionClaims,
    keys: options.jwks.keys,
    verify: options.verify,
  });
  if (!verified.ok) return verified;
  const fail = (error: AdmissionErrorCode): AdmissionResult => ({ ok: false, error });
  const { claims } = verified;

  if (claims.aud !== options.audience) return fail('wrong_audience');
  if (options.issuer !== undefined && claims.iss !== options.issuer) return fail('wrong_issuer');
  if (options.role !== undefined && claims.rol !== options.role) return fail('wrong_role');
  if (options.worker !== undefined && claims.wrk !== options.worker) return fail('wrong_worker');
  if (claims.nbf < claims.iat || claims.exp <= claims.nbf || claims.exp - claims.iat > TICKET_MAX_LIFETIME_S)
    return fail('bad_lifetime');
  const skew = options.clockSkewS ?? TICKET_CLOCK_SKEW_S;
  if (claims.iat > options.now + skew || claims.nbf > options.now + skew) return fail('not_yet_valid');
  if (options.now >= claims.exp + skew) return fail('expired');
  return { ok: true, header: verified.header, claims };
}

/** Signs a ticket (control side, and tests). Validates header and claims first; throws when invalid. */
export function signAdmissionTicket(
  header: AdmissionHeader,
  claims: AdmissionClaims,
  sign: Ed25519Sign,
): string {
  return signCompactEdDsa(AdmissionHeader.parse(header), AdmissionClaims.parse(claims), sign);
}

/** JWK for a raw 32-byte Ed25519 public key (`alg: EdDSA`, `use: sig`). */
export function ed25519Jwk(kid: string, publicKey: Uint8Array): Ed25519Jwk {
  if (publicKey.length !== 32) throw new Error('Ed25519 public keys are 32 bytes');
  return Ed25519Jwk.parse({
    kty: 'OKP',
    crv: 'Ed25519',
    kid,
    x: base64urlEncode(publicKey),
    alg: 'EdDSA',
    use: 'sig',
  });
}

/** JWK for a raw 32-byte Ed25519 public key (= `ed25519Jwk`). */
export const admissionJwk = ed25519Jwk;
