/**
 * Whombat Feedback in the mock world (docs/decisions/feedback.md): one integration for Burrow HQ's billing
 * portal that posts into Mara's Feedback room, where Dusty looks into each report, and five reports in the states the report card shows (assessed likely
 * bug, queued, failed, content removed, feature request). Not part of the seeded world (`seed.ts`): fixture
 * mode, stories, the visual suite and tests use it. Typed with the core schemas; `fixtures.test.ts` parses
 * every value.
 */
import {
  FEEDBACK_DROP_TEXT,
  type FeedbackIntegrationHealth,
  feedbackDropExpiredText,
  type FeedbackIntegrationDetail as IntegrationDetail,
} from '@whombat/core/contracts';
import {
  type AssessmentCard,
  DEFAULT_FEEDBACK_LIMITS,
  type FeedbackIntegration,
  type FeedbackReport,
  REPORT_CARD_SUMMARY_MAX,
  type ReportCard,
} from '@whombat/core/domain';
import { basicSnippet, cspAdvice, customLauncherSnippet } from '@whombat/core/feedback';
import { rep_billing } from './burrow.js';
import { cnv_feedback_mara } from './conversations.js';
import { mara } from './principals.js';
import { at } from './time.js';

/** The public address the fixture Whombat is reached at (`PUBLIC_URL`). */
export const FEEDBACK_PUBLIC_URL = 'https://whombat.burrowhq.example';

export const feedbackIntegration: FeedbackIntegration = {
  id: 'fbi_billing-portal',
  siteId: 'fbs_Q7m2Xc9LpR4tVb8NwK3zHd6J',
  name: 'Billing portal',
  productLabel: 'Burrow Billing',
  allowedOrigins: ['https://billing.burrowhq.example', 'http://localhost:5173'],
  repoId: rep_billing.id,
  projectContext:
    'Burrow Billing is the customer portal for invoices and payments. Invoices are rendered in billing/pdf; VAT is computed in billing/vat. Customers are small Dutch businesses.',
  reportTypes: ['bug', 'feature'],
  theme: 'auto',
  position: 'bottom-right',
  launcher: 'floating',
  launcherLabel: 'Feedback',
  privacyUrl: 'https://burrowhq.example/privacy',
  contactFields: { name: 'optional', email: 'optional' },
  redactPaths: ['/customers/*', '/invoices/*'],
  contextKeys: ['plan', 'seats'],
  limits: { ...DEFAULT_FEEDBACK_LIMITS },
  retentionDays: 180,
  handoff: 'on',
  trail: 'on',
  reporterSignIn: 'on',
  intake: 'enabled',
  assessment: 'active',
  revision: 3,
  configHash: 'c0f1e2d3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f',
  createdById: mara.id,
  createdAt: at('09:10', -2),
  updatedById: mara.id,
  updatedAt: at('16:40', -1),
  conversationId: cnv_feedback_mara.id,
  chat: { id: cnv_feedback_mara.id },
};

/** The snippets the server generates for an integration (`@whombat/core/feedback` install helpers). */
export function feedbackSnippets(integration: FeedbackIntegration, publicUrl = FEEDBACK_PUBLIC_URL) {
  const input = {
    publicUrl,
    siteId: integration.siteId,
    theme: integration.theme,
    position: integration.position,
    launcher: integration.launcher,
    launcherLabel: integration.launcherLabel,
  };
  return { basic: basicSnippet(input), custom: customLauncherSnippet(input), csp: cspAdvice(publicUrl) };
}

/** Health as the server reports it (`apps/server/src/feedback/read.ts`): intake on, nothing to warn about. */
export const feedbackHealth: FeedbackIntegrationHealth = {
  publicUrl: FEEDBACK_PUBLIC_URL,
  reportsLast24h: 4,
  lastReportAt: at('10:48'),
  assessments: { queued: 1, running: 0, failed: 1, blocked: 0 },
  warnings: [],
  delivery: null,
};

/** The embed origin a managed fixture Whombat's snippet loads the widget from (FD-31). */
export const FEEDBACK_EMBED_URL = 'https://embed.whombat.com';

/**
 * Health of the same integration on a managed Whombat (drop mode, FD-26): reports arrive through Whombat's cloud;
 * two waited too long while the appliance was off.
 */
export const feedbackManagedHealth: FeedbackIntegrationHealth = {
  ...feedbackHealth,
  publicUrl: FEEDBACK_EMBED_URL,
  warnings: [{ code: 'drop_expired', message: feedbackDropExpiredText(2) }],
  delivery: {
    mode: 'drop',
    publishedAt: at('16:41', -1),
    lastCollectedAt: at('10:48'),
    notFiled7d: 0,
    expired7d: 2,
  },
};

/** The `drop_not_published` warning as the server words it. */
export const feedbackDropNotPublishedWarning = {
  code: 'drop_not_published' as const,
  message: FEEDBACK_DROP_TEXT.notPublished,
};

export function feedbackIntegrationDetail(
  integration: FeedbackIntegration = feedbackIntegration,
  health: FeedbackIntegrationHealth = feedbackHealth,
): IntegrationDetail {
  return { integration, snippets: feedbackSnippets(integration), health, can: { manage: true } };
}

/* Reports ----------------------------------------------------------------------------------------- */

const intake = {
  revision: 3,
  configHash: feedbackIntegration.configHash,
  conversationId: cnv_feedback_mara.id,
  repoId: rep_billing.id,
  projectContext: feedbackIntegration.projectContext,
  configuredById: mara.id,
};

const emptyContext = {
  page: null,
  browser: null,
  app: null,
  custom: {},
  references: [],
  sentAt: null,
};

/** A bug report Dusty assessed as a likely bug (the richest state: every assessment field is filled). */
export const reportLikelyBug: FeedbackReport = {
  id: 'fbr_vat-rounding',
  integrationId: feedbackIntegration.id,
  reference: 'FB-7K3Q-9M2X',
  productLabel: 'Burrow Billing',
  type: 'bug',
  status: 'triaged',
  receivedAt: at('10:48'),
  updatedAt: at('11:02'),
  submitted: {
    description:
      'The invoice PDF shows a VAT total of €121,01 but the invoice page says €121,00. Our accountant noticed it on invoice 2026-000142.',
    expected: 'The PDF and the invoice page show the same VAT total.',
    steps: '1. Open invoice 2026-000142\n2. Download the PDF\n3. Compare the VAT line with the page',
    reporter: { name: 'Sanne Visser', email: 'sanne@visser-advies.example', verified: true },
    context: {
      page: { url: 'https://billing.burrowhq.example/invoices/:id', title: 'Invoice · Burrow Billing' },
      browser: {
        name: 'Chrome 131 · macOS',
        language: 'nl-NL',
        viewport: { width: 1440, height: 900 },
        timeZone: 'Europe/Amsterdam',
      },
      app: { version: '2.14.0', environment: 'production', build: '7be20f7' },
      custom: { plan: 'business', seats: 12 },
      references: ['req_8f2c1a9d'],
      sentAt: at('10:47'),
    },
    trail: [
      { url: 'https://billing.burrowhq.example/', title: 'Overview · Burrow Billing', at: at('10:39') },
      {
        url: 'https://billing.burrowhq.example/invoices',
        title: 'Invoices · Burrow Billing',
        at: at('10:41'),
      },
      {
        url: 'https://billing.burrowhq.example/invoices/:id',
        title: 'Invoice · Burrow Billing',
        at: at('10:44'),
      },
    ],
    attachments: [
      {
        id: 'att_fb-vat-pdf',
        name: 'invoice-pdf.png',
        contentType: 'image/png',
        size: 184_220,
        url: '/api/v1/burrows/burrow-hq/attachments/att_fb-vat-pdf',
        kind: 'image',
        width: 1280,
        height: 800,
      },
      {
        id: 'att_fb-vat-page',
        name: 'invoice-page.png',
        contentType: 'image/png',
        size: 142_906,
        url: '/api/v1/burrows/burrow-hq/attachments/att_fb-vat-page',
        kind: 'image',
        width: 1280,
        height: 800,
      },
    ],
  },
  contentRemovedAt: null,
  intake,
  conversationId: cnv_feedback_mara.id,
  rootMessageId: 'msg_fb-vat-rounding',
  assessment: {
    state: 'done',
    reason: null,
    attempts: 1,
    dispatchId: 'dsp_fb-vat-rounding-1',
    updatedAt: at('11:02'),
    workspace: { repo: 'whombat/billing', ref: 'main@7be20f7' },
    result: {
      outcome: 'likely_bug',
      summary:
        'The PDF rounds each line’s VAT before adding them up; the page rounds the total once. With several lines the two can differ by a cent.',
      confidence: 'medium',
      uncertainty: 'I read the code but could not run the PDF export in the sandbox.',
      reproduction: { status: 'not_attempted', notes: '' },
      evidence: [
        {
          kind: 'file',
          ref: 'billing/pdf/format.ts:88',
          note: 'Rounds each line’s VAT with roundCents() before summing.',
          hypothesis: false,
        },
        {
          kind: 'file',
          ref: 'billing/vat/total.ts:31',
          note: 'The page sums unrounded amounts and rounds once.',
          hypothesis: false,
        },
        {
          kind: 'observation',
          ref: 'Invoice 2026-000142 has 7 lines',
          note: 'Seven roundings can drift by one cent.',
          hypothesis: true,
        },
      ],
      revision: {
        inspected: '7be20f7',
        reported: '2.14.0',
        mismatch: null,
      },
      severity: {
        level: 'medium',
        rationale: 'Wrong totals on legal documents, but off by at most a few cents.',
      },
      missingInformation: ['Whether older invoices show the same difference.'],
      nextAction: 'Round once, after summing, in billing/pdf/format.ts, and add a test with seven lines.',
      duplicateOf: null,
      feature: null,
    },
    conclusion: {
      reply:
        'This is a real bug. The PDF rounds the VAT on every line and then adds them up, while the invoice page rounds the total once, so an invoice with several lines can be a cent off. I read both places in the code but couldn’t run the export myself.',
      bugVerdict: 'bug',
      decision: {
        question: 'Shall I fix it?',
        options: [
          { label: 'Fix it', action: 'hand_off', recommended: true },
          { label: 'Leave it for now', action: 'keep_open', recommended: false },
        ],
      },
    },
    decided: null,
  },
  attempts: [
    {
      id: 'fba_vat-rounding-1',
      attempt: 1,
      state: 'done',
      dispatchId: 'dsp_fb-vat-rounding-1',
      error: null,
      requestedById: null,
      startedAt: at('10:49'),
      finishedAt: at('11:02'),
    },
  ],
  handoff: null,
};

/** Just received; the assessment waits for a free slot. */
export const reportQueued: FeedbackReport = {
  ...reportLikelyBug,
  id: 'fbr_login-loop',
  reference: 'FB-3WQ8-KD5N',
  status: 'new',
  receivedAt: at('11:19'),
  updatedAt: at('11:19'),
  submitted: {
    ...reportLikelyBug.submitted,
    description:
      'After signing in with the magic link I land on the sign-in page again. It happens every time on my phone.',
    expected: 'I end up on my invoices.',
    steps: '',
    reporter: { name: null, email: null, verified: false },
    context: {
      ...emptyContext,
      page: { url: 'https://billing.burrowhq.example/login', title: 'Sign in · Burrow Billing' },
      browser: { name: 'Safari 18 · iOS', language: 'nl-NL', viewport: null, timeZone: null },
    },
    attachments: [],
    trail: [],
  },
  rootMessageId: 'msg_fb-login-loop',
  assessment: {
    state: 'queued',
    reason: null,
    attempts: 0,
    dispatchId: null,
    updatedAt: at('11:19'),
    workspace: null,
    result: null,
  },
  attempts: [],
};

/** The assessment turn ended without a result (FB-23): shown honestly, Retry offered. */
export const reportFailed: FeedbackReport = {
  ...reportQueued,
  id: 'fbr_csv-export',
  reference: 'FB-R6TB-2H4P',
  receivedAt: at('09:31'),
  updatedAt: at('10:02'),
  submitted: {
    ...reportQueued.submitted,
    description: 'The CSV export of payments is empty when I pick “last quarter”.',
    expected: 'All payments from July to September.',
    reporter: { name: 'Pieter de Groot', email: null, verified: false },
    context: {
      ...emptyContext,
      page: { url: 'https://billing.burrowhq.example/payments', title: 'Payments · Burrow Billing' },
    },
    trail: [],
  },
  rootMessageId: 'msg_fb-csv-export',
  assessment: {
    state: 'failed',
    reason: 'The assessment ran out of time after 30 minutes without submitting a result.',
    attempts: 1,
    dispatchId: 'dsp_fb-csv-export-1',
    updatedAt: at('10:02'),
    workspace: { repo: 'whombat/billing', ref: 'main@7be20f7' },
    result: null,
  },
  attempts: [
    {
      id: 'fba_csv-export-1',
      attempt: 1,
      state: 'failed',
      dispatchId: 'dsp_fb-csv-export-1',
      error: 'Timed out after 30 minutes without submitting an assessment.',
      requestedById: null,
      startedAt: at('09:32'),
      finishedAt: at('10:02'),
    },
  ],
};

/** An owner removed what the visitor sent (FB-25): reference, states and history stay. */
export const reportRemoved: FeedbackReport = {
  ...reportLikelyBug,
  id: 'fbr_removed',
  reference: 'FB-N4ZC-8QJ1',
  status: 'closed',
  receivedAt: at('14:05', -1),
  updatedAt: at('09:15'),
  submitted: {
    description: '',
    expected: '',
    steps: '',
    reporter: { name: null, email: null, verified: false },
    context: { ...emptyContext },
    attachments: [],
    trail: [],
  },
  contentRemovedAt: at('09:15'),
  rootMessageId: 'msg_fb-removed',
};

/** A feature request, assessed as one (with the feature assessment). */
export const reportFeature: FeedbackReport = {
  ...reportLikelyBug,
  id: 'fbr_ideal-links',
  reference: 'FB-H8XM-5VKT',
  type: 'feature',
  status: 'new',
  receivedAt: at('08:12'),
  updatedAt: at('08:40'),
  submitted: {
    description:
      'Could invoices include an iDEAL payment link? Most of our customers pay by bank transfer and forget the reference.',
    expected: '',
    steps: '',
    reporter: { name: 'Lotte Jansen', email: 'lotte@jansen-bouw.example', verified: false },
    context: {
      ...emptyContext,
      page: { url: 'https://billing.burrowhq.example/invoices', title: 'Invoices · Burrow Billing' },
      browser: { name: 'Firefox 132 · Windows', language: 'nl-NL', viewport: null, timeZone: null },
    },
    attachments: [],
    trail: [],
  },
  rootMessageId: 'msg_fb-ideal-links',
  assessment: {
    state: 'done',
    reason: null,
    attempts: 1,
    dispatchId: 'dsp_fb-ideal-links-1',
    updatedAt: at('08:40'),
    workspace: { repo: 'whombat/billing', ref: 'main@7be20f7' },
    result: {
      outcome: 'feature_request',
      summary:
        'Invoices have no payment link today. Adding one touches the PDF template and the payment provider.',
      confidence: 'high',
      uncertainty: '',
      reproduction: { status: 'not_attempted', notes: '' },
      evidence: [
        {
          kind: 'file',
          ref: 'billing/pdf/template.ts',
          note: 'No payment link in the template.',
          hypothesis: false,
        },
      ],
      revision: { inspected: '7be20f7', reported: null, mismatch: null },
      severity: { level: 'none', rationale: 'A request, not a defect.' },
      missingInformation: [],
      nextAction: 'Decide whether to add iDEAL links through the current payment provider.',
      duplicateOf: null,
      feature: {
        goal: 'Customers pay faster and with the right reference.',
        existingBehavior: 'Invoices show the IBAN and the reference as text.',
        workarounds: 'Customers copy the reference by hand.',
        scope: 'PDF template, invoice e-mail and a payment-link endpoint.',
        tradeoffs: 'Provider fees per payment; links expire and need refreshing.',
      },
    },
    conclusion: {
      reply:
        'Invoices only show the IBAN and the reference as text today, so a payment link would be new. It means touching the PDF template, the invoice e-mail and the payment provider, and the provider charges per payment.',
      bugVerdict: null,
      decision: {
        question: 'Do you want to add iDEAL payment links?',
        options: [
          { label: 'Build it', action: 'hand_off', recommended: false },
          { label: 'Not now', action: 'keep_open', recommended: true },
          { label: 'Won’t do', action: 'close', recommended: false },
        ],
      },
    },
    decided: null,
  },
  attempts: [
    {
      id: 'fba_ideal-links-1',
      attempt: 1,
      state: 'done',
      dispatchId: 'dsp_fb-ideal-links-1',
      error: null,
      requestedById: null,
      startedAt: at('08:13'),
      finishedAt: at('08:40'),
    },
  ],
};

export const FEEDBACK_REPORTS: FeedbackReport[] = [
  reportLikelyBug,
  reportQueued,
  reportFailed,
  reportRemoved,
  reportFeature,
];

/** One line of the description, cut at the card's limit (the server's `reportSummary`). */
function cardSummary(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  return flat.length > REPORT_CARD_SUMMARY_MAX ? `${flat.slice(0, REPORT_CARD_SUMMARY_MAX - 1)}…` : flat;
}

/** The resolved report card of a report, as the server builds it on read (FB-16). */
export function reportCardOf(report: FeedbackReport): ReportCard {
  const removed = report.contentRemovedAt !== null;
  return {
    kind: 'report',
    reportId: report.id,
    reference: report.reference,
    product: report.productLabel,
    type: report.type,
    summary: removed ? '' : cardSummary(report.submitted.description),
    submittedAt: report.receivedAt,
    status: report.status,
    assessment: {
      state: report.assessment.state,
      outcome: report.assessment.result?.outcome ?? null,
      summary: report.assessment.result?.summary ?? null,
    },
    attachments: removed ? 0 : report.submitted.attachments.length,
    contentRemoved: removed,
  };
}

/** The resolved assessment card of an assessed report, as the server builds it on read (CT-193); null before. */
export function assessmentCardOf(report: FeedbackReport): AssessmentCard | null {
  const result = report.assessment.result;
  if (report.assessment.state !== 'done' || !result) return null;
  return {
    kind: 'assessment',
    reportId: report.id,
    reference: report.reference,
    type: report.type,
    status: report.status,
    assessment: result,
    bugVerdict: report.assessment.conclusion?.bugVerdict ?? null,
    decision: report.assessment.conclusion?.decision ?? null,
    decided: report.assessment.decided ?? null,
    contentRemoved: report.contentRemovedAt !== null,
  };
}
