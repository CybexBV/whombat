/**
 * The appliance licence over the session (LC-08, LC-09, LC-13, CT-77): `licence.status` and `licence.refresh`. Times are
 * session timestamps (RFC 3339), converted from `licenceStatus`'s epoch seconds.
 */
import { Timestamp } from '@whombat/core/domain';
import { z } from 'zod';
import { LicenceLimits, LicencePlan, LicenceReason, LicenceState } from '../licence.js';

const Count = z.number().int().min(0);

/**
 * What the appliance shows in Settings → This Whombat → Subscription (LC-13): `licenceStatus`'s answer as timestamps,
 * plus what counts against the limits now (LC-11: connector connections; since 3.0 no people, CT-1562) and when the
 * runtime computed it (`checkedAt`; it caches the state for 60 s).
 */
export const LicenceStatusView = z.object({
  state: LicenceState,
  reason: LicenceReason,
  plan: LicencePlan.nullable(),
  limits: z.object(LicenceLimits.shape).nullable(),
  /** The token's `iat` (“Not confirmed since …”). */
  renewedAt: Timestamp.nullable(),
  /** The token's `exp` (“Valid until …”). */
  expiresAt: Timestamp.nullable(),
  /** When grace ends and the licence lapses (“{agent} keeps working until …”); null for `cancelled`. */
  graceEndsAt: Timestamp.nullable(),
  /** The effective time the state is for: max(clock, highWater, clockMark). */
  effectiveAt: Timestamp,
  usage: z.object({ connectors: Count }),
  checkedAt: Timestamp,
});
export type LicenceStatusView = z.infer<typeof LicenceStatusView>;

export const LicenceStatusInput = z.strictObject({});
/** `licence: null` on an unclaimed appliance (no licence state). */
export const LicenceStatusOutput = z.object({ licence: LicenceStatusView.nullable() });
export type LicenceStatusOutput = z.infer<typeof LicenceStatusOutput>;

/**
 * “Check again”: the runtime asks the manager to renew now (`POST /v1/licence/renew`) and answers
 * the resulting state. Mutating, like `backup.runNow`: accepted once its request commits; a failed renewal is an
 * error (`licence.renew_failed`), not a result.
 */
export const LicenceRefreshInput = z.strictObject({});
export const LicenceRefreshOutput = LicenceStatusOutput;

/** `error.details` of a `licence.limit` refusal (LC-10). */
export const LicenceLimitDetails = z.object({
  code: z.literal('licence.limit'),
  limit: z.enum(['connectors']),
  /** What the plan allows. */
  allowed: Count,
});
export type LicenceLimitDetails = z.infer<typeof LicenceLimitDetails>;

const LicenceVerdict = z.object({ state: LicenceState, reason: LicenceReason });

/**
 * Payload of the signed `licence.state_changed` appliance event, written on every change of state or reason (LC-09).
 * `null`: no licence state (unclaimed, or before the first computation).
 */
export const LicenceAuditPayload = z.object({
  from: LicenceVerdict.nullable(),
  to: LicenceVerdict.nullable(),
  plan: LicencePlan.nullable(),
  /** The token's `jti`, when there is one. */
  jti: z
    .string()
    .min(22)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
});
export type LicenceAuditPayload = z.infer<typeof LicenceAuditPayload>;
