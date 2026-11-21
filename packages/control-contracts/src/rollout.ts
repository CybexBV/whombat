/**
 * Update assignment and rollout (MA-11): internal → consenting pilot → canary → progressive waves, with
 * observation windows, failure thresholds, auto-pause, release quarantine and an operator emergency stop.
 * A pause/stop prevents further activations; it never interrupts healthy installations or restores data.
 */
import { EpochSeconds, Ident, ReleaseId, UpdateFailureDetail } from '@whombat/release';
import { z } from 'zod';
import { CohortId, DeviceId, OrgId, RolloutId } from './common.js';
import { controlEndpoint } from './endpoint.js';

export const CohortKind = z.enum(['internal', 'pilot', 'canary', 'general']);

export const Cohort = z.object({
  cohort: CohortId,
  kind: CohortKind,
  name: z.string().min(1).max(80),
  /** Pilot/canary membership requires the org's consent. */
  requiresConsent: z.boolean(),
  devices: z.number().int().min(0).max(10_000_000),
});
export type Cohort = z.infer<typeof Cohort>;

export const Wave = z.object({
  index: z.number().int().min(0).max(100),
  cohorts: z.array(CohortId).min(1).max(32),
  /** Share of the cohorts' devices, in basis points (10000 = all). */
  basisPoints: z.number().int().min(1).max(10_000),
  /** Minimum time between the first activation and promotion to the next wave. */
  minObservationS: z
    .number()
    .int()
    .min(0)
    .max(30 * 86_400),
  /** Auto-pause when failures/rollbacks exceed this share (basis points) of activated devices. */
  failureThresholdBp: z.number().int().min(0).max(10_000),
  /** Minimum activated devices before the threshold is evaluated. */
  minSample: z.number().int().min(0).max(1_000_000),
  state: z.enum(['pending', 'active', 'observing', 'promoted', 'paused']),
  startedAt: EpochSeconds.nullable(),
  /** When the observation window started (the wave's first activation). */
  observingSince: EpochSeconds.nullable().optional(),
});
export type Wave = z.infer<typeof Wave>;

/** A wave as `rollout.create` takes it. */
export const RolloutWaveInput = z.strictObject(Wave.omit({ state: true, startedAt: true }).shape);
export type RolloutWaveInput = z.infer<typeof RolloutWaveInput>;

const wave = (
  index: number,
  cohorts: string[],
  basisPoints: number,
  minObservationS: number,
): RolloutWaveInput => ({
  index,
  cohorts,
  basisPoints,
  minObservationS,
  failureThresholdBp: 0,
  minSample: 1,
});

/**
 * The wave plans `deploy.sh release … --waves` and `release/ship promote-prod` use (CT-140, UP-E1). Every wave pauses
 * on any failure (threshold 0, sample 1); control promotes a wave once its window passed with every activated device
 * healthy, and an empty wave at once.
 * - `default`: `internal` 100 % (1 h), `pilot` 100 % (6 h), `canary` 100 % (12 h), `general` 10 % (24 h), `general`
 *   100 %.
 * - `all-at-once`: one wave of every cohort, 100 %.
 */
export const ROLLOUT_PRESETS = {
  default: [
    wave(0, ['internal'], 10_000, 3_600),
    wave(1, ['pilot'], 10_000, 21_600),
    wave(2, ['canary'], 10_000, 43_200),
    wave(3, ['general'], 1_000, 86_400),
    wave(4, ['general'], 10_000, 0),
  ],
  'all-at-once': [wave(0, ['internal', 'pilot', 'canary', 'general'], 10_000, 0)],
} as const satisfies Record<string, readonly RolloutWaveInput[]>;
export type RolloutPreset = keyof typeof ROLLOUT_PRESETS;

export const RolloutState = z.enum(['draft', 'active', 'paused', 'stopped', 'completed']);

/**
 * `Rollout.pauseReason` values control sets (an open set, `Ident`; CT-140, UP-E2). An operator's own reason
 * (`rollout.pause {reason}`) is kept as given.
 */
export const ROLLOUT_PAUSE_REASONS = {
  operator: 'An operator paused it.',
  failure_threshold: 'Failures in the current wave passed its threshold.',
  device_failed:
    'A device of the current wave reported Failed, RolledBack, Quarantined or ForwardRepairRequired (`pauseDetail` names it).',
  health_regression:
    'A device of the current wave reported its runtime or database down in two consecutive status reports within the observation window.',
  quarantined: 'The release was quarantined.',
} as const;

/** What paused a rollout (CT-140): the device and its failure, when a device did. */
export const RolloutPauseDetail = z.object({
  device: DeviceId.nullable(),
  reason: Ident,
  failureDetail: UpdateFailureDetail.nullable(),
  at: EpochSeconds,
});
export type RolloutPauseDetail = z.infer<typeof RolloutPauseDetail>;

export const Rollout = z.object({
  rollout: RolloutId,
  release: ReleaseId,
  state: RolloutState,
  waves: z.array(Wave).min(1).max(32),
  /** Why it paused (auto-pause code or operator; `ROLLOUT_PAUSE_REASONS`). */
  pauseReason: Ident.nullable(),
  /** The device and failure behind an automatic pause (CT-140); null or absent: none. */
  pauseDetail: RolloutPauseDetail.nullable().optional(),
  createdAt: EpochSeconds,
  counts: z.object({
    assigned: z.number().int().min(0),
    healthy: z.number().int().min(0),
    failed: z.number().int().min(0),
    rolledBack: z.number().int().min(0),
  }),
});
export type Rollout = z.infer<typeof Rollout>;

export const ReleaseStatus = z.object({
  release: ReleaseId,
  state: z.enum(['approved', 'quarantined', 'retired']),
  quarantinedAt: EpochSeconds.nullable(),
});

/** Fleet-wide switch: while on, every assignment is `hold`. */
export const EmergencyStop = z.object({
  active: z.boolean(),
  since: EpochSeconds.nullable(),
  by: Ident.nullable(),
});
export type EmergencyStop = z.infer<typeof EmergencyStop>;
export type ReleaseStatus = z.infer<typeof ReleaseStatus>;
export type RolloutState = z.infer<typeof RolloutState>;

/** A release as the app shows it (CT-138): one paragraph of plain text. */
export const ReleaseSummary = z.object({
  release: ReleaseId,
  summary: z.string().max(500),
  publishedAt: EpochSeconds,
});
export type ReleaseSummary = z.infer<typeof ReleaseSummary>;

export const rolloutApi = {
  cohorts: controlEndpoint({
    id: 'rollout.cohorts',
    method: 'GET',
    path: '/operator/cohorts',
    auth: 'operator',
    summary: 'Cohorts and sizes.',
    response: z.object({ cohorts: z.array(Cohort).max(1_000) }),
  }),
  create: controlEndpoint({
    id: 'rollout.create',
    method: 'POST',
    path: '/operator/rollouts',
    auth: 'operator',
    summary: 'Start a rollout of an approved release through waves.',
    body: z.strictObject({
      release: ReleaseId,
      /** `ROLLOUT_PRESETS.default` unless the operator chose otherwise. */
      waves: z.array(RolloutWaveInput).min(1).max(32),
    }),
    response: Rollout,
  }),
  pause: controlEndpoint({
    id: 'rollout.pause',
    method: 'POST',
    path: '/operator/rollouts/:rollout/pause',
    auth: 'operator',
    summary: 'Pause further activations (installed devices keep running).',
    body: z.strictObject({ reason: Ident }),
    response: Rollout,
  }),
  resume: controlEndpoint({
    id: 'rollout.resume',
    method: 'POST',
    path: '/operator/rollouts/:rollout/resume',
    auth: 'operator',
    summary: 'Resume a paused rollout.',
    body: z.strictObject({}),
    response: Rollout,
  }),
  quarantine: controlEndpoint({
    id: 'rollout.quarantine',
    method: 'POST',
    path: '/operator/releases/:release/quarantine',
    auth: 'operator',
    summary: 'Quarantine a release: no new assignments; devices that have it staged discard it.',
    body: z.strictObject({ reason: Ident }),
    response: ReleaseStatus,
  }),
  emergencyStopStatus: controlEndpoint({
    id: 'rollout.emergencyStopStatus',
    method: 'GET',
    path: '/operator/emergency-stop',
    auth: 'operator',
    summary: 'Whether the fleet-wide emergency stop is on.',
    response: EmergencyStop,
  }),
  emergencyStop: controlEndpoint({
    id: 'rollout.emergencyStop',
    method: 'PUT',
    path: '/operator/emergency-stop',
    auth: 'operator',
    summary: 'Fleet-wide stop: every assignment becomes hold until cleared.',
    body: z.strictObject({ active: z.boolean() }),
    response: EmergencyStop,
  }),
  consent: controlEndpoint({
    id: 'rollout.consent',
    method: 'PUT',
    path: '/orgs/:org/update-cohort',
    auth: 'session',
    summary: 'The org’s consent to join the pilot or canary cohort.',
    body: z.strictObject({ kind: z.enum(['general', 'pilot', 'canary']) }),
    response: z.object({ org: OrgId, kind: z.enum(['general', 'pilot', 'canary']) }),
  }),
  releaseSummary: controlEndpoint({
    id: 'rollout.releaseSummary',
    method: 'GET',
    path: '/releases/:release/summary',
    auth: 'session',
    summary:
      'What a release brings, as the app shows it (“Updated to … on …”, CT-138): its notes’ summary from the release record. Refuses `release_not_found` (404) when control has no record of it.',
    response: ReleaseSummary,
  }),
  deviceCohort: controlEndpoint({
    id: 'rollout.deviceCohort',
    method: 'GET',
    path: '/operator/devices/:device/assignment',
    auth: 'operator',
    summary: 'A device’s cohort and current assignment sequence.',
    response: z.object({
      device: DeviceId,
      cohort: CohortId.nullable(),
      sequence: z.number().int().min(0),
    }),
  }),
};
