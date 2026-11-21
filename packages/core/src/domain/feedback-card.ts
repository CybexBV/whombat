/**
 * The vocabulary of Whombat Feedback reports and the `report` chat card (docs/decisions/feedback.md FB-16).
 * Kept apart from `feedback.ts` so `cards.ts` can include the card without importing messages.
 */
import { z } from 'zod';
import { FeedbackReportId } from '../ids.js';
import { Timestamp } from './common.js';

export const FeedbackReportType = z.enum(['bug', 'feature']);
export type FeedbackReportType = z.infer<typeof FeedbackReportType>;

export const FEEDBACK_TYPE_LABELS: Record<FeedbackReportType, string> = {
  bug: 'Bug report',
  feature: 'Feature request',
};

/** Reference shown to the visitor (`FB-7K3Q-9M2X`). An acknowledgement only; it opens nothing (FB-11). */
export const FeedbackReference = z.string().regex(/^FB-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
export type FeedbackReference = z.infer<typeof FeedbackReference>;

export const FeedbackOutcome = z.enum([
  'confirmed_bug',
  'likely_bug',
  'needs_information',
  'duplicate',
  'configuration_or_support',
  'feature_request',
  'insufficient_evidence',
]);
export type FeedbackOutcome = z.infer<typeof FeedbackOutcome>;

export const FEEDBACK_OUTCOME_LABELS: Record<FeedbackOutcome, string> = {
  confirmed_bug: 'Confirmed bug',
  likely_bug: 'Likely bug',
  needs_information: 'Needs information',
  duplicate: 'Duplicate',
  configuration_or_support: 'Configuration or support',
  feature_request: 'Feature request',
  insufficient_evidence: 'Insufficient evidence',
};

/**
 * Where a report's assessment is. `not_configured`: the integration has no assessment agent. `paused`: its
 * assessment is paused or out of budget. `blocked`: revalidation failed (FB-20). `failed`: the agent didn't
 * deliver (FB-23).
 */
export const FeedbackAssessmentState = z.enum([
  'not_configured',
  'queued',
  'running',
  'done',
  'failed',
  'blocked',
  'paused',
]);
export type FeedbackAssessmentState = z.infer<typeof FeedbackAssessmentState>;

export const FEEDBACK_ASSESSMENT_STATE_LABELS: Record<FeedbackAssessmentState, string> = {
  not_configured: 'Not assessed',
  queued: 'Assessment queued',
  running: 'Assessing',
  done: 'Assessed',
  failed: 'Assessment failed',
  blocked: 'Assessment blocked',
  paused: 'Assessment paused',
};

/** Internal lifecycle, separate from the assessment's classification. */
export const FeedbackReportStatus = z.enum(['new', 'triaged', 'in_progress', 'resolved', 'closed']);
export type FeedbackReportStatus = z.infer<typeof FeedbackReportStatus>;

export const FEEDBACK_STATUS_LABELS: Record<FeedbackReportStatus, string> = {
  new: 'New',
  triaged: 'Triaged',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const REPORT_CARD_SUMMARY_MAX = 280;

/** The resolved card on a report's root message. Visitor text is plain text: never Markdown, never mentions. */
export const ReportCard = z.object({
  kind: z.literal('report'),
  reportId: FeedbackReportId,
  reference: FeedbackReference,
  product: z.string().max(60),
  type: FeedbackReportType,
  /** First characters of the description (plain text); empty once content was removed. */
  summary: z.string().max(REPORT_CARD_SUMMARY_MAX),
  submittedAt: Timestamp,
  status: FeedbackReportStatus,
  assessment: z.object({
    state: FeedbackAssessmentState,
    outcome: FeedbackOutcome.nullable(),
    /** Assessment summary (display text), when done. */
    summary: z.string().max(1200).nullable(),
  }),
  attachments: z.number().int().min(0),
  contentRemoved: z.boolean(),
});
export type ReportCard = z.infer<typeof ReportCard>;

/** Storage form: by reference, resolved on read. */
export const StoredReportCard = z.object({ kind: z.literal('report'), reportId: FeedbackReportId });

/** Card header: `BUG REPORT · FB-7K3Q-9M2X` (web and mobile). */
export function reportCardLabel(card: Pick<ReportCard, 'type' | 'reference'>): string {
  return `${FEEDBACK_TYPE_LABELS[card.type].toUpperCase()} · ${card.reference}`;
}

/** Card state line: `Lumio · New · Likely bug` / `Lumio · New · Assessment queued`. */
export function reportCardState(card: Pick<ReportCard, 'product' | 'status' | 'assessment'>): string {
  const assessment =
    card.assessment.state === 'done' && card.assessment.outcome
      ? FEEDBACK_OUTCOME_LABELS[card.assessment.outcome]
      : FEEDBACK_ASSESSMENT_STATE_LABELS[card.assessment.state];
  return `${card.product} · ${FEEDBACK_STATUS_LABELS[card.status]} · ${assessment}`;
}
