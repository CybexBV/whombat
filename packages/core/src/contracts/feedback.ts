/**
 * Whombat Feedback contracts (docs/decisions/feedback.md). Internal endpoints are ordinary session endpoints
 * under `api.feedback.*`. The public widget surface lives under `/embed/v1` and is **not** part of `api`: it is
 * registered by the server's feedback module with its own limits and never authenticates (FB-02, FB-04).
 */
import { z } from 'zod';
import { Timestamp } from '../domain/common.js';
import {
  FEEDBACK_DECISION_OPTIONS_MAX,
  FeedbackIntegration,
  FeedbackIntegrationSettings,
  FeedbackReport,
  FeedbackReportStatus,
} from '../domain/feedback.js';
import { FeedbackIntegrationId, FeedbackReportId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';
import { commitOutcome } from './errors.js';

/**
 * The longest note a person may add when asking for development on a report: what the handoff's approval card shows
 * in full on one line (at most 280 characters with its quotes), so the owner approves exactly the words the
 * agent receives (review-3 NEW-5). Runs of whitespace are collapsed to one space before it is stored.
 */
export const FEEDBACK_HANDOFF_NOTE_MAX = 240;

// ---------------------------------------------------------------------------------------------------------
// Public surface (`/embed/v1`)

export const FEEDBACK_EMBED_PREFIX = '/embed/v1';

/** Paths of the public widget surface, relative to the Whombat origin. */
export const FEEDBACK_PUBLIC_PATHS = {
  loader: `${FEEDBACK_EMBED_PREFIX}/widget.js`,
  frame: `${FEEDBACK_EMBED_PREFIX}/frame.html`,
  assets: `${FEEDBACK_EMBED_PREFIX}/assets/`,
  /** GET, `?parent=<origin>` → `FeedbackPublicConfig`. */
  config: `${FEEDBACK_EMBED_PREFIX}/sites/:site/config`,
  /** POST `FeedbackSubmission` → `FeedbackReceipt`. */
  reports: `${FEEDBACK_EMBED_PREFIX}/sites/:site/reports`,
  /**
   * Reporter sign-in (CT-162), same-origin like `reports`; the same shapes as control's `feedbackDropApi.reporter*`.
   * POST `FeedbackReporterCodeRequest` → 202 `FeedbackReporterOk` (always; 404 `unavailable`, 429 `rate_limited`).
   */
  reporterCode: `${FEEDBACK_EMBED_PREFIX}/sites/:site/reporter/code`,
  /**
   * POST `FeedbackReporterSessionRequest` → 200 `FeedbackReporterSession` (400 `code_refused`, 429); DELETE with
   * `Authorization: Bearer fbrs_…` → 204, also for an unknown token.
   */
  reporterSession: `${FEEDBACK_EMBED_PREFIX}/sites/:site/reporter/session`,
  /** GET with the Bearer → `FeedbackReporterReports` (401 `signed_out`). */
  reporterReports: `${FEEDBACK_EMBED_PREFIX}/sites/:site/reporter/reports`,
} as const;

/** The bridge protocol tag between loader and frame (FB-06). */
export const FEEDBACK_BRIDGE_TAG = 'whombat-feedback/1';

/** Hard ceiling of a submission body, whatever an integration allows (FB-09). */
export const FEEDBACK_MAX_BODY_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------
// Internal endpoints

const B = z.object({ burrow: BurrowParam });
const I = B.extend({ id: FeedbackIntegrationId });
const R = B.extend({ id: FeedbackReportId });

export const FeedbackHealthWarning = z.object({
  code: z.enum([
    'intake_disabled',
    'assessment_paused',
    'agent_not_guarded',
    'agent_unsupported_provider',
    'owner_not_member',
    'repo_disabled',
    'public_url_not_https',
    'public_url_missing',
    'widget_not_built',
    'module_off',
    /** Managed (drop mode, FD-26): control doesn't have this site's card (yet). */
    'drop_not_published',
    /** Managed: the manager or control doesn't support the drop (FD-25). */
    'drop_unsupported',
    /** Managed: reports of the last 7 days that were refused when filed. */
    'drop_not_filed',
    /** Managed: reports that expired in control before this Whombat collected them. */
    'drop_expired',
  ]),
  message: z.string(),
});
export type FeedbackHealthWarning = z.infer<typeof FeedbackHealthWarning>;

/**
 * How reports reach a managed Whombat (FD-26): through the encrypted drop. `publishedAt`: when control last accepted
 * this site's card (null: never, or withdrawn); `lastCollectedAt`: the last drop of this site the runtime collected;
 * `notFiled7d`/`expired7d`: drops of the last 7 days refused when filed / deleted by control unread.
 */
export const FeedbackDropDelivery = z.object({
  mode: z.literal('drop'),
  publishedAt: Timestamp.nullable(),
  lastCollectedAt: Timestamp.nullable(),
  notFiled7d: z.number().int().min(0),
  expired7d: z.number().int().min(0),
});
export type FeedbackDropDelivery = z.infer<typeof FeedbackDropDelivery>;

/** Owner-facing texts of the drop (FD-25, FD-26): the server sends them, clients never compose them. */
export const FEEDBACK_DROP_TEXT = {
  /** `appliance.status.policy.feedbackIntake` reason when the drop is available. */
  policy:
    'Visitors’ reports are encrypted in their browser to this Whombat. Whombat’s cloud keeps them, unreadable, until this Whombat collects them.',
  /** The policy reason and the `drop_unsupported` warning. */
  unsupported: 'Feedback needs an update of this Whombat’s cloud connection.',
  notPublished:
    'Whombat’s cloud doesn’t have this site yet, so visitors can’t send reports. This Whombat keeps trying.',
} as const;

/** `drop_not_filed`: “N reports from the last 7 days couldn’t be filed.” */
export function feedbackDropNotFiledText(count: number): string {
  return count === 1
    ? '1 report from the last 7 days couldn’t be filed.'
    : `${count} reports from the last 7 days couldn’t be filed.`;
}

/** `drop_expired`: “N reports waited 7 days in Whombat’s cloud and were deleted before this Whombat collected them.” */
export function feedbackDropExpiredText(count: number): string {
  return count === 1
    ? '1 report waited 7 days in Whombat’s cloud and was deleted before this Whombat collected it.'
    : `${count} reports waited 7 days in Whombat’s cloud and were deleted before this Whombat collected them.`;
}

export const FeedbackIntegrationHealth = z.object({
  /**
   * The base address the snippet loads the widget from: `PUBLIC_URL` (self-hosted), or on a managed Whombat the
   * embed origin (`WHOMBAT_EMBED_URL`, else the hosted app's origin; FD-26, FD-31).
   */
  publicUrl: z.string().nullable(),
  reportsLast24h: z.number().int().min(0),
  lastReportAt: Timestamp.nullable(),
  assessments: z.object({
    queued: z.number().int().min(0),
    running: z.number().int().min(0),
    failed: z.number().int().min(0),
    blocked: z.number().int().min(0),
  }),
  warnings: z.array(FeedbackHealthWarning),
  /** Drop delivery (managed feedback, FD-21); null where there is none. */
  delivery: FeedbackDropDelivery.nullable().default(null),
});
export type FeedbackIntegrationHealth = z.infer<typeof FeedbackIntegrationHealth>;

export const FeedbackSnippets = z.object({
  /** The basic `<script>` tag. */
  basic: z.string(),
  /** Floating launcher off, opened from the site's own button. */
  custom: z.string(),
  /** Content-Security-Policy additions the website needs. */
  csp: z.string(),
});
export type FeedbackSnippets = z.infer<typeof FeedbackSnippets>;

export const FeedbackIntegrationDetail = z.object({
  integration: FeedbackIntegration,
  snippets: FeedbackSnippets,
  health: FeedbackIntegrationHealth,
  can: z.object({ manage: z.boolean() }),
});
export type FeedbackIntegrationDetail = z.infer<typeof FeedbackIntegrationDetail>;

export const feedbackEndpoints = {
  listIntegrations: endpoint({
    id: 'feedback.listIntegrations',
    method: 'GET',
    path: '/burrows/:burrow/feedback/integrations',
    summary: 'Feedback integrations of the burrow.',
    params: B,
    response: z.object({
      integrations: z.array(
        z.object({ integration: FeedbackIntegration, health: FeedbackIntegrationHealth }),
      ),
      can: z.object({ manage: z.boolean() }),
    }),
  }),
  getIntegration: endpoint({
    id: 'feedback.getIntegration',
    method: 'GET',
    path: '/burrows/:burrow/feedback/integrations/:id',
    summary: 'One feedback integration with its installation snippets and health.',
    params: I,
    response: FeedbackIntegrationDetail,
  }),
  createIntegration: endpoint({
    id: 'feedback.createIntegration',
    method: 'POST',
    path: '/burrows/:burrow/feedback/integrations',
    summary: 'Create a feedback integration. It accepts reports once created, from its allowed origins.',
    params: B,
    body: FeedbackIntegrationSettings,
    response: commitOutcome({ integration: FeedbackIntegration }),
    status: 201,
  }),
  updateIntegration: endpoint({
    id: 'feedback.updateIntegration',
    method: 'PUT',
    path: '/burrows/:burrow/feedback/integrations/:id',
    summary: 'Replace an integration’s settings. `revision` must be the one the editor started from.',
    params: I,
    body: z.object({ revision: z.number().int().positive(), settings: FeedbackIntegrationSettings }),
    response: commitOutcome({ integration: FeedbackIntegration }),
  }),
  setIntake: endpoint({
    id: 'feedback.setIntake',
    method: 'POST',
    path: '/burrows/:burrow/feedback/integrations/:id/intake',
    summary: 'Turn report intake on or off (FB-19). Accepted reports are unaffected.',
    params: I,
    body: z.object({ enabled: z.boolean() }),
    response: commitOutcome({ integration: FeedbackIntegration }),
  }),
  setAssessment: endpoint({
    id: 'feedback.setAssessment',
    method: 'POST',
    path: '/burrows/:burrow/feedback/integrations/:id/assessment',
    summary: 'Pause or resume automatic assessment (FB-19). Resuming requeues paused reports.',
    params: I,
    body: z.object({ active: z.boolean() }),
    response: commitOutcome({ integration: FeedbackIntegration }),
  }),
  getReport: endpoint({
    id: 'feedback.getReport',
    method: 'GET',
    path: '/burrows/:burrow/feedback/reports/:id',
    summary:
      'A report with what was submitted and its assessment (the person whose Feedback room it went to).',
    params: R,
    response: z.object({
      report: FeedbackReport,
      can: z.object({
        setStatus: z.boolean(),
        retry: z.boolean(),
        handoff: z.boolean(),
        redact: z.boolean(),
        /** Whether the caller may pick an option of the decision now (CT-193). */
        decide: z.boolean(),
      }),
    }),
  }),
  setReportStatus: endpoint({
    id: 'feedback.setReportStatus',
    method: 'POST',
    path: '/burrows/:burrow/feedback/reports/:id/status',
    summary: 'Change a report’s internal status.',
    params: R,
    body: z.object({ status: FeedbackReportStatus }),
    response: commitOutcome({ report: FeedbackReport }),
  }),
  retryAssessment: endpoint({
    id: 'feedback.retryAssessment',
    method: 'POST',
    path: '/burrows/:burrow/feedback/reports/:id/retry',
    summary: 'Queue a failed or blocked assessment again once its cause is fixed (FB-23).',
    params: R,
    body: z.object({}).default({}),
    response: commitOutcome({ report: FeedbackReport }),
  }),
  requestHandoff: endpoint({
    id: 'feedback.requestHandoff',
    method: 'POST',
    path: '/burrows/:burrow/feedback/reports/:id/handoff',
    summary:
      'Ask the person to approve building the fix for an assessed report: a development turn of the agent (FB-24, OA-16).',
    params: R,
    body: z.object({ note: z.string().trim().max(FEEDBACK_HANDOFF_NOTE_MAX).default('') }),
    response: commitOutcome({ report: FeedbackReport }),
  }),
  decide: endpoint({
    id: 'feedback.decide',
    method: 'POST',
    path: '/burrows/:burrow/feedback/reports/:id/decision',
    summary:
      'Pick an option of the assessor’s decision (CT-193): its action runs as the caller (a handoff asks the person, the others set the status), once per report.',
    params: R,
    body: z.object({
      option: z
        .number()
        .int()
        .min(0)
        .max(FEEDBACK_DECISION_OPTIONS_MAX - 1),
    }),
    response: commitOutcome({ report: FeedbackReport }),
  }),
  redactReport: endpoint({
    id: 'feedback.redactReport',
    method: 'POST',
    path: '/burrows/:burrow/feedback/reports/:id/redact',
    summary: 'Remove a report’s submitted content and screenshots; its history stays (FB-25).',
    params: R,
    body: z.object({}).default({}),
    response: commitOutcome({ report: FeedbackReport }),
  }),
} as const;
