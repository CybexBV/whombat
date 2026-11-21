/** The manager's persisted update state machine (MA-11). */
import { z } from 'zod';
import { EpochSeconds, Ident, ReleaseId } from './primitives.js';

export const UpdateJournalState = z.enum([
  'Assigned',
  'Downloading',
  'Verified',
  'Staged',
  'WaitingForSafeBoundary',
  'Activating',
  'Verifying',
  'Healthy',
  'Failed',
  'RolledBack',
  'Quarantined',
  /**
   * The candidate is running and cannot be rolled back (its migration made the database unusable for the
   * known-good release): it keeps running, nothing is rewound, and only a newer (fix-forward) assignment moves
   * on (CT-31). `current` is the candidate.
   */
  'ForwardRepairRequired',
]);
export type UpdateJournalState = z.infer<typeof UpdateJournalState>;

/** Allowed transitions. Before activation an assignment can be superseded (back to `Assigned`). */
export const UPDATE_JOURNAL_TRANSITIONS: Readonly<Record<UpdateJournalState, readonly UpdateJournalState[]>> =
  {
    Assigned: ['Downloading', 'Failed', 'Quarantined'],
    Downloading: ['Verified', 'Failed', 'Assigned'],
    Verified: ['Staged', 'Failed', 'Assigned', 'Quarantined'],
    Staged: ['WaitingForSafeBoundary', 'Failed', 'Assigned'],
    WaitingForSafeBoundary: ['Activating', 'Failed', 'Assigned'],
    Activating: ['Verifying', 'RolledBack', 'Failed', 'ForwardRepairRequired'],
    Verifying: ['Healthy', 'RolledBack', 'ForwardRepairRequired'],
    Healthy: ['Assigned'],
    Failed: ['Assigned', 'Quarantined'],
    RolledBack: ['Assigned', 'Quarantined'],
    Quarantined: ['Assigned'],
    ForwardRepairRequired: ['Assigned'],
  };

export function canTransition(from: UpdateJournalState, to: UpdateJournalState): boolean {
  return UPDATE_JOURNAL_TRANSITIONS[from].includes(to);
}

/** States in which the candidate may be running (health evidence is being gathered or rollback is possible). */
export const ACTIVATION_STATES: ReadonlySet<UpdateJournalState> = new Set(['Activating', 'Verifying']);

/**
 * Why a staged update waits instead of activating (CT-138, UP-E4), as the manager tells the runtime and the owner sees
 * it: `boundary` — work is running (the safe boundary; `blockers` say what); `checkpoint` — a verified backup must be
 * taken first (without a destination it waits for one); `window` — the org's maintenance window hasn't opened;
 * `hold` — control holds the device (emergency stop, `manager_too_old`, …); `lock` — a maintenance lock is held;
 * `metadata` — the signed update metadata must be refreshed first; `owner` — the owner asked to approve each update
 * first and hasn't approved this one yet (contracts 4.2; Whombat ask-before-updating.md).
 */
export const UpdateWaitReason = z.enum([
  'boundary',
  'checkpoint',
  'window',
  'hold',
  'lock',
  'metadata',
  'owner',
]);
export type UpdateWaitReason = z.infer<typeof UpdateWaitReason>;

/** The manager's local health checks by name (health evidence, failed checks in reports). */
export const HEALTH_CHECKS = [
  'runtime',
  'database',
  'session_endpoint',
  'runner',
  'relay_control',
  'boot',
  'manager',
] as const;
export type HealthCheckName = (typeof HEALTH_CHECKS)[number];

export const HealthEvidence = z.strictObject({
  check: z.enum(HEALTH_CHECKS),
  ok: z.boolean(),
  at: EpochSeconds,
  /** Machine code, never free text (field-allowlisted telemetry). */
  code: Ident.optional(),
});
export type HealthEvidence = z.infer<typeof HealthEvidence>;

/** One persisted journal record (the manager fsyncs it on every transition). */
export const UpdateJournalRecord = z.strictObject({
  v: z.literal(1),
  state: UpdateJournalState,
  updateClass: z.enum(['runtime', 'host']),
  current: ReleaseId,
  candidate: ReleaseId.nullable(),
  knownGood: ReleaseId,
  /** Assignment sequence this candidate came from. */
  assignmentSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  attempt: z.number().int().min(0).max(100),
  maxAttempts: z.number().int().min(1).max(100),
  maintenanceLock: z.boolean(),
  health: z.array(HealthEvidence).max(64),
  updatedAt: EpochSeconds,
  /** Machine-readable failure code for Failed/RolledBack/Quarantined. */
  failure: Ident.nullable(),
});
export type UpdateJournalRecord = z.infer<typeof UpdateJournalRecord>;
