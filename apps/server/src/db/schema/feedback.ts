/**
 * Whombat Feedback (docs/decisions/feedback.md FB-13): integrations the person configured, the reports received
 * through them, and one row per assessment attempt. Visitors are never principals: a report's reporter name and
 * email are unverified metadata on the report row. Screenshots are ordinary `attachments` rows (uploaded by the
 * burrow's feedback principal, linked to the report's root message).
 */
import type {
  FeedbackAssessment,
  FeedbackAssessmentMode,
  FeedbackAssessmentState,
  FeedbackConclusion,
  FeedbackContext,
  FeedbackDecisionChoice,
  FeedbackIntake,
  FeedbackIntakeSnapshot,
  FeedbackIntegrationSettings,
  FeedbackReportStatus,
  FeedbackReportType,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { ts } from './common';
import { burrows } from './tenancy';

export const feedbackIntegrations = pgTable(
  'feedback_integrations',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    /** Public, non-secret site id (`fbs_…`), unique across the instance. */
    siteId: text('site_id').notNull(),
    intake: text('intake').$type<FeedbackIntake>().notNull().default('enabled'),
    assessment: text('assessment').$type<FeedbackAssessmentMode>().notNull().default('active'),
    /** Destination channel (also inside `settings`; a column for lookups). */
    channelId: text('channel_id').notNull(),
    /** Everything the person configured (validated `FeedbackIntegrationSettings`). */
    settings: jsonb('settings').$type<FeedbackIntegrationSettings>().notNull(),
    revision: integer('revision').notNull().default(1),
    /** sha256 of the canonical settings of this revision (signed in the change event). */
    configHash: text('config_hash').notNull(),
    createdById: text('created_by_id').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedById: text('updated_by_id').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('feedback_integrations_site_idx').on(t.siteId),
    index('feedback_integrations_burrow_idx').on(t.burrowId),
  ],
);

export const feedbackReports = pgTable(
  'feedback_reports',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    integrationId: text('integration_id')
      .notNull()
      .references(() => feedbackIntegrations.id),
    /** `FB-XXXX-XXXX`, unique across the instance; grants nothing. */
    reference: text('reference').notNull(),
    /** The widget's idempotency key (FB-10), unique per integration. */
    submissionId: text('submission_id').notNull(),
    /** sha256 of the canonical normalized submission (screenshots by their sha256). */
    payloadHash: text('payload_hash').notNull(),
    type: text('type').$type<FeedbackReportType>().notNull(),
    status: text('status').$type<FeedbackReportStatus>().notNull().default('new'),

    // Visitor-supplied, unverified; cleared when content is removed (FB-25).
    description: text('description').notNull().default(''),
    expected: text('expected').notNull().default(''),
    steps: text('steps').notNull().default(''),
    reporterName: text('reporter_name'),
    reporterEmail: text('reporter_email'),
    context: jsonb('context').$type<FeedbackContext>(),
    /** Screenshot attachment ids, in the visitor's order. */
    attachmentIds: text('attachment_ids').array().notNull().default(sql`'{}'::text[]`),
    contentRemovedAt: ts('content_removed_at'),

    /** Routing captured at intake: assessment uses this, never the current configuration. */
    intake: jsonb('intake').$type<FeedbackIntakeSnapshot>().notNull(),
    conversationId: text('conversation_id').notNull(),
    rootMessageId: text('root_message_id').notNull(),

    // Assessment (agent conclusions, kept apart from what the visitor sent).
    assessmentState: text('assessment_state').$type<FeedbackAssessmentState>().notNull(),
    assessmentReason: text('assessment_reason'),
    assessment: jsonb('assessment').$type<FeedbackAssessment>(),
    assessmentAttempts: integer('assessment_attempts').notNull().default(0),
    /** The dispatch of the running attempt. */
    assessmentDispatchId: text('assessment_dispatch_id'),
    /** Worker lease on a queued report (FOR UPDATE SKIP LOCKED + lease, like memory_jobs). */
    assessmentLeaseExpiresAt: ts('assessment_lease_expires_at'),
    assessmentNotBefore: ts('assessment_not_before'),
    /** The person who pressed Retry; recorded on the next attempt (null: queued at intake or on resume). */
    assessmentRequestedById: text('assessment_requested_by_id'),
    assessmentUpdatedAt: ts('assessment_updated_at').notNull(),
    /** The development handoff approval, once asked for (FB-24). */
    handoffApprovalId: text('handoff_approval_id'),
    /** The assessor's reply, bug verdict and decision (FB-32); null for assessments recorded before it. */
    conclusion: jsonb('conclusion').$type<FeedbackConclusion>(),
    /** The option a person picked of the decision (FB-32), once. */
    decided: jsonb('decided').$type<FeedbackDecisionChoice>(),
    /** The assessor's reply message, which carries the `assessment` card (FB-32). */
    assessmentMessageId: text('assessment_message_id'),

    // Reporter sign-in (docs/decisions/feedback-reporters.md FR-02, FR-09).
    /**
     * The signed-in reporter who sent it: self-hosted, a `feedback_reporters.id`; managed, control's `fbr_…` id from the
     * drop's attestation. Null for a report sent without signing in.
     */
    reporterId: text('reporter_id'),
    /** The reporter's email was that of a valid reporter session (“Email verified”). */
    reporterVerified: boolean('reporter_verified').notNull().default(false),
    /** Managed: when its reporter status last reached control. */
    reporterPublishedAt: ts('reporter_published_at'),
    /** Managed outbox flag: the report changed since its reporter status was last published. */
    reporterDirty: boolean('reporter_dirty').notNull().default(false),

    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('feedback_reports_reference_idx').on(t.reference),
    uniqueIndex('feedback_reports_submission_idx').on(t.integrationId, t.submissionId),
    index('feedback_reports_integration_idx').on(t.integrationId, t.createdAt),
    index('feedback_reports_assessment_idx').on(t.assessmentState, t.assessmentNotBefore),
    uniqueIndex('feedback_reports_root_idx').on(t.rootMessageId),
    index('feedback_reports_dispatch_idx').on(t.assessmentDispatchId),
    index('feedback_reports_reporter_idx').on(t.integrationId, t.reporterId, t.createdAt),
    index('feedback_reports_reporter_dirty_idx').on(t.id).where(sql`${t.reporterDirty}`),
  ],
);

export type FeedbackAttemptState = 'running' | 'done' | 'failed' | 'cancelled' | 'blocked';

/** One assessment attempt: the budget ledger and the report's history of tries. */
export const feedbackAssessments = pgTable(
  'feedback_assessments',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id').notNull(),
    reportId: text('report_id')
      .notNull()
      .references(() => feedbackReports.id),
    integrationId: text('integration_id').notNull(),
    attempt: integer('attempt').notNull(),
    agentId: text('agent_id').notNull(),
    dispatchId: text('dispatch_id'),
    state: text('state').$type<FeedbackAttemptState>().notNull(),
    error: text('error'),
    /** `{repo: 'owner/name', ref}` the assessor was given, when it had code access. */
    workspace: jsonb('workspace').$type<{ repo: string; ref: string } | null>(),
    /**
     * Whether the turn could run commands (only inside the provider's read-only OS sandbox, FB-21). A turn that
     * could only inspect can't submit `reproduction.status = reproduced`.
     */
    canExecute: boolean('can_execute').notNull().default(false),
    /** Who pressed Retry (null: queued at intake). */
    requestedById: text('requested_by_id'),
    startedAt: ts('started_at').notNull(),
    /**
     * When a runner first claimed the turn (its context was built): `assessmentTimeoutMinutes` counts from here, and
     * only a claimed attempt counts toward the daily budget (review-2 F6). Null while it waits in the queue.
     */
    claimedAt: ts('claimed_at'),
    /**
     * The commit the runner exported for the turn's read-only checkout, as it reported it (review-2 F9); a handoff
     * binds this commit. Null: no code, or a runner that didn't say.
     */
    workspaceCommit: text('workspace_commit'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    uniqueIndex('feedback_assessments_attempt_idx').on(t.reportId, t.attempt),
    index('feedback_assessments_budget_idx').on(t.integrationId, t.startedAt),
    index('feedback_assessments_dispatch_idx').on(t.dispatchId),
  ],
);

/* The encrypted drop of a managed Whombat (docs/decisions/feedback-drop.md FD-08 … FD-11, FD-24) ----------------- */

export type FeedbackDropKeyKind = 'signing' | 'encryption';

/**
 * The drop's keys (FD-07 … FD-09): one Ed25519 site signing key (`kid` = its `fbk_…` pin, never rotated) and X25519
 * encryption keys (`kid` = `fdk_…`), one current (`retiredAt` null), rotated every 30 days; a retired one is kept
 * 22 days (`deleteAfter`) so every drop control can still deliver opens. Private halves sealed with the master key,
 * AAD `feedback_drop_key:<kid>`. Appliance infrastructure written by the drop module, not burrow commands.
 */
export const feedbackDropKeys = pgTable('feedback_drop_keys', {
  kid: text('kid').primaryKey(),
  kind: text('kind').$type<FeedbackDropKeyKind>().notNull(),
  /** base64url, 32 bytes. */
  publicKey: text('public_key').notNull(),
  /** `KeyCustody.seal` of the base64url private key (the Ed25519 seed or the X25519 private key). */
  privateSealed: text('private_sealed').notNull(),
  createdAt: ts('created_at').notNull(),
  /** When it became the current key of its kind. */
  currentSince: ts('current_since').notNull(),
  retiredAt: ts('retired_at'),
  deleteAfter: ts('delete_after'),
});

/** The runtime's drop counters (one row, `id = 1`): `cardSeq` grows with every issued card and sync (FD-11, FD-34). */
export const feedbackDropState = pgTable('feedback_drop_state', {
  id: integer('id').primaryKey(),
  cardSeq: bigint('card_seq', { mode: 'number' }).notNull().default(0),
  /** When control last accepted a full sync. */
  syncedAt: ts('synced_at'),
});

/**
 * What control holds of each site of this runtime (FD-11, FD-26): the last accepted card (`publishedAt`, its `seq`
 * and expiry) or why it was refused. A site whose card was withdrawn has no row.
 */
export const feedbackDropSites = pgTable('feedback_drop_sites', {
  siteId: text('site_id').primaryKey(),
  integrationId: text('integration_id').notNull(),
  /** When control last accepted this site's card; null while it is refused. */
  publishedAt: ts('published_at'),
  cardSeq: bigint('card_seq', { mode: 'number' }),
  expiresAt: ts('expires_at'),
  /** Control's refusal code of the last sync (`site_bound_elsewhere`, …), null when accepted. */
  refused: text('refused'),
  updatedAt: ts('updated_at').notNull(),
});

export type FeedbackDropOutcomeKind = 'pending' | 'filed' | 'duplicate' | 'refused';

/**
 * Each collected drop's outcome, kept 8 days (FD-24): `filed`, `duplicate` or `refused` with a code are final (a
 * redelivered drop is acked without work); `pending` counts attempts that failed transiently (refused `internal`
 * after 5). No content is kept.
 */
export const feedbackDropOutcomes = pgTable(
  'feedback_drop_outcomes',
  {
    dropId: text('drop_id').primaryKey(),
    siteId: text('site_id').notNull(),
    integrationId: text('integration_id'),
    outcome: text('outcome').$type<FeedbackDropOutcomeKind>().notNull(),
    code: text('code'),
    attempts: integer('attempts').notNull().default(0),
    at: ts('at').notNull(),
  },
  (t) => [
    index('feedback_drop_outcomes_integration_idx').on(t.integrationId, t.at),
    index('feedback_drop_outcomes_at_idx').on(t.at),
  ],
);

/** Drops control deleted unread after 7 days, per site and day of the pull that reported them (FD-19, FD-26). */
export const feedbackDropExpired = pgTable(
  'feedback_drop_expired',
  {
    siteId: text('site_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.day] })],
);
