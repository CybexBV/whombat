/**
 * Field-allowlisted device reports (assignment §12): enums, counters and ids only — no free text, paths,
 * logs, SQL, prompts or content. Cross-language.
 */

import { SshEd25519PublicKey } from '@whombat/protocol/session';
import {
  EpochSeconds,
  HEALTH_CHECKS,
  Ident,
  ReleaseId,
  UpdateFailureDetail,
  UpdateJournalState,
  UpdateWaitReason,
  VersionString,
} from '@whombat/release';
import { z } from 'zod';
import { OpaqueRef } from '../common.js';

export { describeUpdateFailure, UpdateFailureDetail, UpdateFailureSchema } from '@whombat/release';

/**
 * Why an update failed, in a device report (CT-137, UP-E3): `UpdateFailureDetail` (`@whombat/release`) as a strict
 * command member. Codes, ids and numbers only — this file's allowlist; the message stays on the box. Go:
 * `device.UpdateFailureReport(detail)` converts a `release.UpdateFailureDetail`.
 */
export const UpdateFailureReport = z.strictObject(UpdateFailureDetail.shape);
export type UpdateFailureReport = z.infer<typeof UpdateFailureReport>;

/**
 * Why a staged update waits, in a device report (CT-147): the reason code and since when — no blockers, counts or
 * text (this file's allowlist). The fuller view is `UpdateFacts.waiting` on the box.
 */
export const UpdateWaitingReport = z.strictObject({ reason: UpdateWaitReason, since: EpochSeconds });
export type UpdateWaitingReport = z.infer<typeof UpdateWaitingReport>;

export const HealthLevel = z.enum(['ok', 'degraded', 'down']);

/** Remote help's state in a report (0.120, CT-944): off, or on at a level. */
export const SUPPORT_REPORT_STATES = ['off', 'look', 'fix'] as const;
export const SupportReportState = z.enum(SUPPORT_REPORT_STATES);
export type SupportReportState = z.infer<typeof SupportReportState>;

/**
 * Remote help as control sees it (0.120, CT-944; Whombat remote-help.md RH-09), from the support service's state: off
 * or the level, the seconds left (null: Forever while on, and always when off), how many are connected (0…8, 0 when
 * off), whether a help code is needed, and the service's SSH host key (null before it made one). Metadata only: no
 * names, no code, nobody who granted it. Control answers an operator's `support.open` only from a report of the last 15
 * minutes that isn't `off`.
 */
export const SupportReport = z.strictObject({
  state: SupportReportState,
  untilS: z.number().int().min(0).max(604_800).nullable(),
  connected: z.number().int().min(0).max(8),
  helpCode: z.boolean(),
  hostKey: SshEd25519PublicKey.nullable(),
});
export type SupportReport = z.infer<typeof SupportReport>;

export const DeviceStatusReport = z.strictObject({
  release: ReleaseId,
  managerVersion: VersionString,
  /** The running runtime's version (the tuple's `runtime.version`), for the fleet view (CT-137). */
  runtimeVersion: VersionString.optional(),
  uptimeS: z.number().int().min(0).max(3_153_600_000),
  update: z.strictObject({
    state: UpdateJournalState,
    candidate: ReleaseId.nullable(),
    attempt: z.number().int().min(0).max(100),
    failure: Ident.nullable(),
    /** The last failure's detail (CT-137); absent when there is none. */
    failureDetail: UpdateFailureReport.optional(),
    /** Set while a staged candidate waits to activate (CT-147); absent otherwise. */
    waiting: UpdateWaitingReport.optional(),
  }),
  health: z.strictObject({
    runtime: HealthLevel,
    database: HealthLevel,
    runner: HealthLevel,
    sessionEndpoint: HealthLevel,
    relay: HealthLevel,
    backup: z.enum(['ok', 'stale', 'failing', 'unconfigured']),
  }),
  storage: z.strictObject({
    persistUsedPct: z.number().int().min(0).max(100),
    persistFreeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  sessionsActive: z.number().int().min(0).max(10_000),
  recoveryKit: z.enum(['not_created', 'unconfirmed', 'confirmed']),
  lastBackupAt: EpochSeconds.nullable(),
  clockSynced: z.boolean(),
  /**
   * Remote help (0.120, CT-944); absent when the support socket doesn't answer.
   */
  support: SupportReport.optional(),
});
export type DeviceStatusReport = z.infer<typeof DeviceStatusReport>;

/** Revocation metadata (MA-04 §6): control mirrors pending/applied, reported by the appliance only. */
export const RevocationReport = z.strictObject({
  /** Appliance-local opaque id of the revocation. */
  ref: OpaqueRef,
  kind: z.enum(['endpoint', 'account']),
  state: z.enum(['pending', 'applied']),
  requestedAt: EpochSeconds,
  appliedAt: EpochSeconds.nullable(),
});
export type RevocationReport = z.infer<typeof RevocationReport>;

export const UpdateProgressReport = z.strictObject({
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  state: UpdateJournalState,
  current: ReleaseId,
  candidate: ReleaseId.nullable(),
  attempt: z.number().int().min(0).max(100),
  failure: Ident.nullable(),
  /** Failed health checks by name (codes only). */
  failedChecks: z.array(z.enum(HEALTH_CHECKS)).max(8),
  /** This failure's detail (CT-137); absent when there is none. */
  failureDetail: UpdateFailureReport.optional(),
  /** Set while the candidate waits to activate (CT-147); absent otherwise. */
  waiting: UpdateWaitingReport.optional(),
  at: EpochSeconds,
});
export type UpdateProgressReport = z.infer<typeof UpdateProgressReport>;
