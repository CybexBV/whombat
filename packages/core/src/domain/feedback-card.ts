/**
 * The vocabulary of Whombat Feedback reports and the `report` chat card (docs/decisions/feedback.md FB-16).
 * Kept apart from `feedback.ts` so `cards.ts` can include the card without importing messages.
 */
import { z } from 'zod';
import { coreWords } from '../i18n/catalog.js';
import { FeedbackReportId } from '../ids.js';
import { Timestamp } from './common.js';

export const FeedbackReportType = z.enum(['bug', 'feature']);
export type FeedbackReportType = z.infer<typeof FeedbackReportType>;

/** A report's type, in a locale. */
export function feedbackTypeLabels(locale?: string | null): Readonly<Record<FeedbackReportType, string>> {
  return coreWords(locale, 'feedbackType', FeedbackReportType.options);
}

export const FEEDBACK_TYPE_LABELS: Record<FeedbackReportType, string> = feedbackTypeLabels('en');

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

/** An assessment's outcome, in a locale. */
export function feedbackOutcomeLabels(locale?: string | null): Readonly<Record<FeedbackOutcome, string>> {
  return coreWords(locale, 'feedbackOutcome', FeedbackOutcome.options);
}

export const FEEDBACK_OUTCOME_LABELS: Record<FeedbackOutcome, string> = feedbackOutcomeLabels('en');

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

/** Where a report's assessment is, in a locale. */
export function feedbackAssessmentStateLabels(
  locale?: string | null,
): Readonly<Record<FeedbackAssessmentState, string>> {
  return coreWords(locale, 'feedbackState', FeedbackAssessmentState.options);
}

export const FEEDBACK_ASSESSMENT_STATE_LABELS: Record<FeedbackAssessmentState, string> =
  feedbackAssessmentStateLabels('en');

/** Internal lifecycle, separate from the assessment's classification. */
export const FeedbackReportStatus = z.enum(['new', 'triaged', 'in_progress', 'resolved', 'closed']);
export type FeedbackReportStatus = z.infer<typeof FeedbackReportStatus>;

/** A report's status, in a locale. */
export function feedbackStatusLabels(locale?: string | null): Readonly<Record<FeedbackReportStatus, string>> {
  return coreWords(locale, 'feedbackStatus', FeedbackReportStatus.options);
}

export const FEEDBACK_STATUS_LABELS: Record<FeedbackReportStatus, string> = feedbackStatusLabels('en');

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
export function reportCardLabel(
  card: Pick<ReportCard, 'type' | 'reference'>,
  locale?: string | null,
): string {
  return `${feedbackTypeLabels(locale)[card.type].toUpperCase()} · ${card.reference}`;
}

/** Card state line: `Lumio · New · Likely bug` / `Lumio · New · Assessment queued`. */
export function reportCardState(
  card: Pick<ReportCard, 'product' | 'status' | 'assessment'>,
  locale?: string | null,
): string {
  const assessment =
    card.assessment.state === 'done' && card.assessment.outcome
      ? feedbackOutcomeLabels(locale)[card.assessment.outcome]
      : feedbackAssessmentStateLabels(locale)[card.assessment.state];
  return `${card.product} · ${feedbackStatusLabels(locale)[card.status]} · ${assessment}`;
}
