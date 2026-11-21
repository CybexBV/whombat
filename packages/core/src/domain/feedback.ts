/**
 * Whombat Feedback: integrations, reports, assessments and the report card (docs/decisions/feedback.md).
 * Visitor-supplied data (`FeedbackSubmission`, a report's text, reporter and context) is unverified evidence:
 * nothing in it selects a burrow, channel, repo or agent, and it is never an instruction or an approval.
 */
import { z } from 'zod';
import {
  FEEDBACK_CARD_MAX_LIFETIME_S,
  FEEDBACK_CARD_MAX_ORIGINS,
  FEEDBACK_DROP_KID_PATTERN,
  FEEDBACK_DROP_MAX_ENVELOPE_BYTES,
  FEEDBACK_DROP_SUITE,
  FEEDBACK_SITE_CARD_PURPOSE,
  FEEDBACK_SITE_KEY_PATTERN,
} from '../feedback/drop.js';
import {
  FEEDBACK_REPORTER_CODE_PATTERN,
  FEEDBACK_REPORTER_EMAIL_MAX,
  FEEDBACK_REPORTER_REPORTS_MAX,
  FEEDBACK_REPORTER_STATUSES,
  FEEDBACK_REPORTER_SUMMARY_MAX,
  FEEDBACK_REPORTER_TOKEN_PATTERN,
} from '../feedback/reporters.js';
import {
  FEEDBACK_CONTEXT_LIMITS as LIMITS,
  normalizeOrigin,
  validContextKey,
  validRedactPath,
} from '../feedback/sanitize.js';
import {
  ApprovalId,
  ConversationId,
  DispatchId,
  FeedbackAssessmentId,
  FeedbackIntegrationId,
  FeedbackReportId,
  MessageId,
  PrincipalId,
  RepoId,
} from '../ids.js';
import { Timestamp } from './common.js';
import { FeedbackAssessment, FeedbackConclusion, FeedbackDecisionChoice } from './feedback-assessment.js';
import {
  FeedbackAssessmentState,
  FeedbackReference,
  FeedbackReportStatus,
  FeedbackReportType,
} from './feedback-card.js';
import { Attachment } from './message.js';

export * from './feedback-assessment.js';
export * from './feedback-card.js';

// ---------------------------------------------------------------------------------------------------------
// Shared vocabulary

export const FeedbackTheme = z.enum(['auto', 'light', 'dark']);
export type FeedbackTheme = z.infer<typeof FeedbackTheme>;
export const FeedbackPosition = z.enum(['bottom-right', 'bottom-left']);
export type FeedbackPosition = z.infer<typeof FeedbackPosition>;
/** `floating`: the widget's own launcher button. `custom`: none; the site opens it from its own button. */
export const FeedbackLauncher = z.enum(['floating', 'custom']);
export type FeedbackLauncher = z.infer<typeof FeedbackLauncher>;
export const FeedbackContactField = z.enum(['off', 'optional']);
export type FeedbackContactField = z.infer<typeof FeedbackContactField>;
/** An integration switch (CT-161, CT-162): the navigation trail, reporter sign-in. */
export const FeedbackSwitch = z.enum(['on', 'off']);
export type FeedbackSwitch = z.infer<typeof FeedbackSwitch>;

/** Public site identifier: not a secret, not authentication (FB-02). `fbs_` + 24 random characters. */
export const FeedbackSiteId = z
  .string()
  .regex(/^fbs_[A-Za-z0-9]{24}$/, { message: 'Expected a feedback site id' })
  .describe('fbs_ public site id');
export type FeedbackSiteId = z.infer<typeof FeedbackSiteId>;

/** Idempotency key the widget generates once per draft (FB-10): 128+ bits, base64url. */
export const FeedbackSubmissionId = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);

/** An exact website origin, canonicalized (FB-05). */
export const FeedbackOrigin = z
  .string()
  .max(255)
  .transform((value, ctx) => {
    const origin = normalizeOrigin(value);
    if (origin === null) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Use an exact origin such as https://app.example.com (http only for localhost), without a path or wildcard.',
      });
      return z.NEVER;
    }
    return origin;
  });

// ---------------------------------------------------------------------------------------------------------
// Integration configuration (private, server-authoritative)

/** Hard ceilings the settings form cannot exceed. */
export const FEEDBACK_MAX_ATTACHMENTS = 3;
export const FEEDBACK_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const FEEDBACK_IMAGE_MAX_SIDE = 8192;
export const FEEDBACK_IMAGE_MAX_PIXELS = 16_000_000;
export const FEEDBACK_ATTACHMENT_TYPES = ['image/png', 'image/jpeg'] as const;
export const FEEDBACK_TEXT_LIMITS = { description: 5000, expected: 3000, steps: 3000, name: 120, email: 254 };
export const FEEDBACK_MAX_ASSESSMENT_ATTEMPTS = 5;

export const FeedbackLimits = z.object({
  /** Reports accepted per integration per rolling hour (in-memory bucket) and per day (durable count). */
  reportsPerHour: z.number().int().min(1).max(1000).default(30),
  reportsPerDay: z.number().int().min(1).max(10_000).default(200),
  /** Reports per client address per hour, per integration. */
  perSourcePerHour: z.number().int().min(1).max(100).default(5),
  maxAttachments: z.number().int().min(0).max(FEEDBACK_MAX_ATTACHMENTS).default(3),
  maxAttachmentBytes: z
    .number()
    .int()
    .min(64 * 1024)
    .max(FEEDBACK_MAX_ATTACHMENT_BYTES)
    .default(3 * 1024 * 1024),
  /** Assessments started per integration per rolling 24 hours; 0 pauses automatic assessment by budget. */
  assessmentsPerDay: z.number().int().min(0).max(500).default(50),
  maxConcurrentAssessments: z.number().int().min(1).max(5).default(1),
  assessmentTimeoutMinutes: z.number().int().min(5).max(120).default(30),
});
export type FeedbackLimits = z.infer<typeof FeedbackLimits>;
export const DEFAULT_FEEDBACK_LIMITS: FeedbackLimits = FeedbackLimits.parse({});

/** What an owner configures (create and update take this whole object). */
export const FeedbackIntegrationSettings = z.object({
  name: z.string().trim().min(1).max(80),
  /** Shown to visitors: “Lumio”. */
  productLabel: z.string().trim().min(1).max(60),
  allowedOrigins: z.array(FeedbackOrigin).min(1).max(20),
  /** Repository (switched on in the burrow) the assessment may read; null = no code access. */
  repoId: RepoId.nullable(),
  /** Approved project context for the assessment (what the product is, where to look). Operator-written. */
  projectContext: z.string().max(4000).default(''),
  reportTypes: z.array(FeedbackReportType).min(1).max(2),
  theme: FeedbackTheme.default('auto'),
  position: FeedbackPosition.default('bottom-right'),
  launcher: FeedbackLauncher.default('floating'),
  launcherLabel: z.string().trim().min(1).max(40).default('Feedback'),
  /** https only. */
  privacyUrl: z
    .string()
    .max(500)
    .url()
    .refine((u) => u.startsWith('https://'), 'Use an https:// address.')
    .nullable()
    .default(null),
  contactFields: z
    .object({
      name: FeedbackContactField.default('optional'),
      email: FeedbackContactField.default('optional'),
    })
    .default({ name: 'optional', email: 'optional' }),
  /** Path templates whose `*` segments are redacted from page URLs (`/customers/*`). */
  redactPaths: z
    .array(
      z.string().refine(validRedactPath, 'Use a path like /customers/* (letters, digits, . _ ~ - and *).'),
    )
    .max(LIMITS.redactPaths)
    .default([]),
  /** Custom context keys the site may send with `setContext({custom})`; none by default. */
  contextKeys: z
    .array(
      z.string().refine(validContextKey, 'Keys start with a letter: letters, digits, . _ -, at most 40.'),
    )
    .max(LIMITS.customEntries)
    .default([]),
  limits: FeedbackLimits.default(DEFAULT_FEEDBACK_LIMITS),
  /** Remove report content automatically after this many days; null keeps it until removed by hand. */
  retentionDays: z.number().int().min(7).max(3650).nullable().default(null),
  /**
   * Offer to build the fix (FB-24, Whombat one-agent.md OA-16): `on`, an assessed report can be handed to development,
   * a turn of the same agent after an owner approves; `off` offers no handoff.
   */
  handoff: FeedbackSwitch.default('off'),
  /** The widget sends the last `FEEDBACK_TRAIL_MAX` page views on the site with a report (CT-161). */
  trail: FeedbackSwitch.default('on'),
  /**
   * Visitors may sign in with their email address and a code to follow their reports (CT-162). Self-hosted, it also
   * needs mail (`FeedbackPublicConfig.reporters` says whether it is offered).
   */
  reporterSignIn: FeedbackSwitch.default('on'),
});
export type FeedbackIntegrationSettings = z.infer<typeof FeedbackIntegrationSettings>;
export type FeedbackIntegrationSettingsInput = z.input<typeof FeedbackIntegrationSettings>;

export const FeedbackIntake = z.enum(['enabled', 'disabled']);
export type FeedbackIntake = z.infer<typeof FeedbackIntake>;
export const FeedbackAssessmentMode = z.enum(['active', 'paused']);
export type FeedbackAssessmentMode = z.infer<typeof FeedbackAssessmentMode>;

/**
 * The room an integration's reports land in (0.87, CT-383; Whombat less-is-more.md LM-01, chat-channel.md CHT-03): the
 * person's Feedback room. Reports, the agent's assessment and its decision buttons appear there. Since 3.0 without
 * `personId` (CT-1514).
 */
export const FeedbackIntegrationChat = z.object({
  /** The room's conversation (also `FeedbackIntegration.conversationId`). */
  id: ConversationId,
});
export type FeedbackIntegrationChat = z.infer<typeof FeedbackIntegrationChat>;

/** The longest feedback chat title: a task chat's (`CHAT_TITLE_MAX`, 60 characters). */
const FEEDBACK_CHAT_TITLE_MAX = 60;

/** A feedback chat's title (CT-383): “Website feedback · Billing portal” (the integration's name), cut to 60 characters. */
export function feedbackChatTitle(name: string): string {
  const head = 'Website feedback';
  const clean = name.replace(/\s+/g, ' ').trim();
  const title = clean ? `${head} · ${clean}` : head;
  const chars = [...title];
  return chars.length <= FEEDBACK_CHAT_TITLE_MAX
    ? title
    : `${chars
        .slice(0, FEEDBACK_CHAT_TITLE_MAX - 1)
        .join('')
        .trimEnd()}…`;
}

export const FeedbackIntegration = FeedbackIntegrationSettings.extend({
  /** The conversation reports go to: the person's Feedback room (`chat`). */
  conversationId: ConversationId,
  id: FeedbackIntegrationId,
  siteId: FeedbackSiteId,
  intake: FeedbackIntake,
  assessment: FeedbackAssessmentMode,
  /** Increments with every change; reports record the revision they were received under. */
  revision: z.number().int().positive(),
  configHash: z.string(),
  createdById: PrincipalId,
  createdAt: Timestamp,
  updatedById: PrincipalId,
  updatedAt: Timestamp,
  /** Where reports land (0.87, CT-383): the person's Feedback room (`conversationId` names the same conversation). */
  chat: FeedbackIntegrationChat,
});
export type FeedbackIntegration = z.infer<typeof FeedbackIntegration>;

// ---------------------------------------------------------------------------------------------------------
// Public widget surface (FB-02, FB-09 … FB-11)

/** Page views in `FeedbackContext.trail` (CT-161). */
export const FEEDBACK_TRAIL_MAX = LIMITS.trail;

/**
 * One page view of the visitor on the site before reporting (CT-161): the page URL sanitized like `page.url` (origin +
 * path, `sanitizePageUrl`), its title, and when the visitor got there (their clock; informational).
 */
export const FeedbackTrailStep = z.strictObject({
  url: z.string().min(1).max(LIMITS.url),
  title: z.string().max(LIMITS.title).nullable().default(null),
  at: Timestamp,
});
export type FeedbackTrailStep = z.infer<typeof FeedbackTrailStep>;

/** Context the widget sends: sanitized again by the server (FB-07). */
export const FeedbackContext = z.strictObject({
  page: z
    .strictObject({
      url: z.string().max(LIMITS.url),
      title: z.string().max(LIMITS.title).nullable().default(null),
    })
    .nullable()
    .default(null),
  browser: z
    .strictObject({
      /** Coarse: “Chrome 131 · macOS” (never the raw user agent). */
      name: z.string().max(80),
      language: z.string().max(35).nullable().default(null),
      viewport: z
        .strictObject({
          width: z.number().int().min(0).max(20_000),
          height: z.number().int().min(0).max(20_000),
        })
        .nullable()
        .default(null),
      timeZone: z.string().max(64).nullable().default(null),
    })
    .nullable()
    .default(null),
  app: z
    .strictObject({
      version: z.string().max(LIMITS.appField).nullable().default(null),
      environment: z.string().max(LIMITS.appField).nullable().default(null),
      build: z.string().max(LIMITS.appField).nullable().default(null),
    })
    .nullable()
    .default(null),
  custom: z
    .record(
      z.string().max(LIMITS.customKey),
      z.union([z.string().max(LIMITS.customValue), z.number(), z.boolean(), z.null()]),
    )
    .refine((r) => Object.keys(r).length <= LIMITS.customEntries, 'Too many custom context entries.')
    .default({}),
  references: z.array(z.string().max(LIMITS.reference)).max(LIMITS.references).default([]),
  /** When the visitor pressed Send (their clock; informational). */
  sentAt: Timestamp.nullable().default(null),
  /**
   * The visitor's last page views on the site (CT-161), oldest first, the page the report was sent from last. Only when
   * the config says `trail: true`; absent when the integration's `trail` is off.
   */
  trail: z.array(FeedbackTrailStep).max(FEEDBACK_TRAIL_MAX).optional(),
});
export type FeedbackContext = z.infer<typeof FeedbackContext>;

export const FeedbackSubmissionAttachment = z.strictObject({
  name: z.string().trim().min(1).max(120),
  /** A hint only: the server sniffs the bytes. */
  contentType: z.enum(FEEDBACK_ATTACHMENT_TYPES),
  /** Base64 (no data: prefix). */
  data: z
    .string()
    .min(4)
    .max(Math.ceil(FEEDBACK_MAX_ATTACHMENT_BYTES / 3) * 4 + 4),
});

/** POST /embed/v1/sites/:site/reports. Strict: routing or authorization fields are rejected (FB-09). */
export const FeedbackSubmission = z.strictObject({
  submissionId: FeedbackSubmissionId,
  /** The embedding page's origin as the loader saw it; re-checked against the allowlist (not identity). */
  parentOrigin: z.string().max(255),
  type: FeedbackReportType,
  description: z.string().trim().min(1).max(FEEDBACK_TEXT_LIMITS.description),
  expected: z.string().trim().max(FEEDBACK_TEXT_LIMITS.expected).default(''),
  steps: z.string().trim().max(FEEDBACK_TEXT_LIMITS.steps).default(''),
  reporter: z
    .strictObject({
      name: z.string().trim().max(FEEDBACK_TEXT_LIMITS.name).default(''),
      email: z.union([z.literal(''), z.string().trim().max(FEEDBACK_TEXT_LIMITS.email).email()]).default(''),
    })
    .default({ name: '', email: '' }),
  context: FeedbackContext.default(FeedbackContext.parse({})),
  attachments: z.array(FeedbackSubmissionAttachment).max(FEEDBACK_MAX_ATTACHMENTS).default([]),
});
export type FeedbackSubmission = z.infer<typeof FeedbackSubmission>;
export type FeedbackSubmissionInput = z.input<typeof FeedbackSubmission>;

/** The only thing a submission ever returns (FB-11). */
export const FeedbackReceipt = z.strictObject({
  reference: FeedbackReference,
  receivedAt: Timestamp,
});
export type FeedbackReceipt = z.infer<typeof FeedbackReceipt>;

/** GET /embed/v1/sites/:site/config — only what the widget needs to render and validate. */
export const FeedbackPublicConfig = z.strictObject({
  productLabel: z.string(),
  reportTypes: z.array(FeedbackReportType).min(1),
  theme: FeedbackTheme,
  position: FeedbackPosition,
  launcher: FeedbackLauncher,
  launcherLabel: z.string(),
  privacyUrl: z.string().nullable(),
  contactFields: z.strictObject({ name: FeedbackContactField, email: FeedbackContactField }),
  attachments: z.strictObject({
    max: z.number().int().min(0),
    maxBytes: z.number().int().positive(),
    types: z.array(z.enum(FEEDBACK_ATTACHMENT_TYPES)),
  }),
  text: z.strictObject({ description: z.number(), expected: z.number(), steps: z.number() }),
  redactPaths: z.array(z.string()),
  contextKeys: z.array(z.string()),
  /**
   * The widget may send `context.trail` (CT-161). Absent means false.
   */
  trail: z.boolean().optional(),
  /** The widget may offer reporter sign-in (CT-162). Absent means false. */
  reporters: z.boolean().optional(),
});
export type FeedbackPublicConfig = z.infer<typeof FeedbackPublicConfig>;

export const FeedbackPublicErrorCode = z.enum([
  'unavailable',
  'invalid',
  'conflict',
  'too_large',
  'unsupported_attachment',
  'rate_limited',
  'internal',
  /** Reporter sign-in (CT-162): the one answer for every failed `…/reporter/session`. */
  'code_refused',
  /** Reporter sign-in: the session token is unknown or expired (`GET …/reporter/reports`). */
  'signed_out',
]);
export type FeedbackPublicErrorCode = z.infer<typeof FeedbackPublicErrorCode>;

export const FEEDBACK_PUBLIC_ERROR_STATUS: Record<FeedbackPublicErrorCode, number> = {
  unavailable: 404,
  invalid: 400,
  conflict: 409,
  too_large: 413,
  unsupported_attachment: 422,
  rate_limited: 429,
  internal: 500,
  code_refused: 400,
  signed_out: 401,
};

export const FeedbackPublicError = z.strictObject({
  error: z.strictObject({
    code: FeedbackPublicErrorCode,
    /** Fixed, non-revealing text. */
    message: z.string(),
    /** Invalid field paths (`description`, `attachments.1`). */
    fields: z.array(z.string()).optional(),
    /** Seconds (rate_limited). */
    retryAfter: z.number().int().positive().optional(),
  }),
});
export type FeedbackPublicError = z.infer<typeof FeedbackPublicError>;

/** The fixed, non-revealing message of each public error code (the runtime's direct route and control's drop). */
export const FEEDBACK_PUBLIC_MESSAGES: Record<FeedbackPublicErrorCode, string> = {
  unavailable: 'Feedback is not available here.',
  invalid: 'The report is not valid.',
  conflict: 'This report was already sent with different content.',
  too_large: 'The report or its screenshots are too large.',
  unsupported_attachment: 'Screenshots must be PNG or JPEG images.',
  rate_limited: 'Too many reports right now. Try again later.',
  internal: 'Something went wrong. Try again later.',
  code_refused: 'That code didn’t work. Check it or ask for a new one.',
  signed_out: 'Your sign-in has ended. Sign in again.',
};

// ---------------------------------------------------------------------------------------------------------
// Reporter sign-in (CT-162): the same shapes on the runtime's `/embed/v1/sites/:site/reporter/…` (self-hosted) and
// control's `/v1/feedback/sites/:site/reporter/…` (managed). The pure helpers are in `@whombat/core/feedback/reporters`.

/** An email address as the widget sends it; parsing trims and lower-cases it (`normalizeReporterEmail`). */
export const FeedbackReporterEmail = z.string().trim().toLowerCase().max(FEEDBACK_REPORTER_EMAIL_MAX).email();

/** POST `…/reporter/code`: email a sign-in code. Always 202 `FeedbackReporterOk`, whether or not one was sent. */
export const FeedbackReporterCodeRequest = z.strictObject({
  email: FeedbackReporterEmail,
  /** The embedding page's origin; must be one of the site's allowed origins (not identity). */
  parent: z.string().max(255),
});
export type FeedbackReporterCodeRequest = z.infer<typeof FeedbackReporterCodeRequest>;

/** POST `…/reporter/session`: exchange the code for a session; 400 `code_refused` for every failure. */
export const FeedbackReporterSessionRequest = z.strictObject({
  email: FeedbackReporterEmail,
  code: z.string().regex(FEEDBACK_REPORTER_CODE_PATTERN, { message: 'Expected a 6-digit code' }),
  parent: z.string().max(255),
});
export type FeedbackReporterSessionRequest = z.infer<typeof FeedbackReporterSessionRequest>;

/** A reporter session token (`Authorization: Bearer fbrs_…`). */
export const FeedbackReporterToken = z.string().regex(FEEDBACK_REPORTER_TOKEN_PATTERN);

/** The answer of a successful sign-in. `expiresAt` = sign-in + `FEEDBACK_REPORTER_SESSION_TTL_S`. */
export const FeedbackReporterSession = z.strictObject({
  token: FeedbackReporterToken,
  email: z.string().max(FEEDBACK_REPORTER_EMAIL_MAX),
  expiresAt: Timestamp,
});
export type FeedbackReporterSession = z.infer<typeof FeedbackReporterSession>;

/** The 202 of `…/reporter/code`. */
export const FeedbackReporterOk = z.strictObject({ ok: z.literal(true) });

/** A report's status as its reporter sees it (`reporterStatusOf`, `REPORTER_STATUS_COPY`). */
export const FeedbackReporterStatus = z.enum(FEEDBACK_REPORTER_STATUSES);
export type FeedbackReporterStatus = z.infer<typeof FeedbackReporterStatus>;

/** One of the reporter's reports on the site. `summary`: `reporterSummaryOf(description)`; null where it isn't kept. */
export const FeedbackReporterReport = z.strictObject({
  reference: FeedbackReference,
  type: FeedbackReportType,
  status: FeedbackReporterStatus,
  receivedAt: Timestamp,
  updatedAt: Timestamp,
  summary: z.string().max(FEEDBACK_REPORTER_SUMMARY_MAX).nullable(),
});
export type FeedbackReporterReport = z.infer<typeof FeedbackReporterReport>;

/** GET `…/reporter/reports` (Bearer): the signed-in reporter's reports on the site, newest first. */
export const FeedbackReporterReports = z.strictObject({
  email: z.string().max(FEEDBACK_REPORTER_EMAIL_MAX),
  reports: z.array(FeedbackReporterReport).max(FEEDBACK_REPORTER_REPORTS_MAX),
});
export type FeedbackReporterReports = z.infer<typeof FeedbackReporterReports>;

// ---------------------------------------------------------------------------------------------------------
// The encrypted drop of a managed Whombat (Whombat docs/decisions/feedback-drop.md FD-07 … FD-16, CT-91).
// The crypto and the Zod-free checks are in `@whombat/core/feedback/drop`.

/** `data-key`: the pin of a runtime's site signing key, `fbk_` + 22 base64url characters (FD-07). */
export const FeedbackSiteKey = z
  .string()
  .regex(FEEDBACK_SITE_KEY_PATTERN, { message: 'Expected a site key' });
export type FeedbackSiteKey = z.infer<typeof FeedbackSiteKey>;

/** Encryption key id, `fdk_` + 16 base64url characters (FD-08). */
export const FeedbackDropKeyId = z.string().regex(FEEDBACK_DROP_KID_PATTERN);
export type FeedbackDropKeyId = z.infer<typeof FeedbackDropKeyId>;

export const FeedbackDropSuite = z.literal(FEEDBACK_DROP_SUITE);
export type FeedbackDropSuite = z.infer<typeof FeedbackDropSuite>;

/** A 32-byte key (X25519 or Ed25519 public), base64url without padding. */
export const FeedbackDropPublicKey = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);

const EpochS = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** An origin exactly as `normalizeOrigin` writes it (a signed card never normalizes, it only checks). */
export const FeedbackCanonicalOrigin = z
  .string()
  .max(255)
  .refine((o) => normalizeOrigin(o) === o, 'Expected a canonical origin such as https://app.example.com');

/** What control enforces for the site (FD-18), from the integration's `FeedbackLimits`. */
export const FeedbackSiteCardLimits = z.strictObject({
  /** `dropEnvelopeCap(bodyCapOf(settings))`, at most `FEEDBACK_DROP_MAX_ENVELOPE_BYTES`. */
  maxEnvelopeBytes: z.number().int().min(1).max(FEEDBACK_DROP_MAX_ENVELOPE_BYTES),
  reportsPerHour: z.number().int().min(1).max(1000),
  reportsPerDay: z.number().int().min(1).max(10_000),
  perSourcePerHour: z.number().int().min(1).max(100),
});
export type FeedbackSiteCardLimits = z.infer<typeof FeedbackSiteCardLimits>;

/**
 * A site card (FD-10): everything the frame needs to render, check the parent and seal, signed by the runtime's
 * site signing key. A card exists only while intake is enabled. `config` is `publicConfigOf`, exactly what
 * `GET /embed/v1/sites/:site/config` answers. `verifySiteCard` additionally checks `kid = dropKeyId(publicKey)`,
 * unique origins, the size and the signature.
 */
export const FeedbackSiteCard = z.strictObject({
  purpose: z.literal(FEEDBACK_SITE_CARD_PURPOSE),
  v: z.literal(1),
  site: FeedbackSiteId,
  /** The runtime's card counter (`feedback_drop_state.card_seq`); control refuses one not above the stored card's. */
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** Epoch seconds; `expiresAt − issuedAt` is at most 14 days. */
  issuedAt: EpochS,
  expiresAt: EpochS,
  allowedOrigins: z.array(FeedbackCanonicalOrigin).min(1).max(FEEDBACK_CARD_MAX_ORIGINS),
  config: FeedbackPublicConfig,
  limits: FeedbackSiteCardLimits,
  encryption: z.strictObject({
    suite: FeedbackDropSuite,
    kid: FeedbackDropKeyId,
    publicKey: FeedbackDropPublicKey,
  }),
  /** Ed25519 public key; its `siteKeyFingerprint` is the snippet's `data-key`. */
  signingKey: FeedbackDropPublicKey,
});
export type FeedbackSiteCard = z.infer<typeof FeedbackSiteCard>;

/** `sig` = Ed25519 over the UTF-8 of `canonicalJson(card)`, base64url (64 bytes). */
export const SignedFeedbackSiteCard = z.strictObject({
  card: FeedbackSiteCard.superRefine((c, ctx) => {
    if (c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > FEEDBACK_CARD_MAX_LIFETIME_S)
      ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'A card lives at most 14 days.' });
  }),
  sig: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
});
export type SignedFeedbackSiteCard = z.infer<typeof SignedFeedbackSiteCard>;

/** The envelope header (FD-14), the AAD: exactly these members, as canonical JSON. */
export const FeedbackDropHeader = z.strictObject({
  kid: FeedbackDropKeyId,
  site: FeedbackSiteId,
  suite: FeedbackDropSuite,
  v: z.literal(1),
});
export type FeedbackDropHeader = z.infer<typeof FeedbackDropHeader>;

/** What only the frame knows about where it runs (FD-15), checked by the runtime (FD-23). */
export const FeedbackDropFrame = z.strictObject({
  /** `event.origin` of the first valid loader message the frame accepted. */
  bridgeOrigin: z.string().max(255),
  /** `location.ancestorOrigins` as an array (nearest first), null where the browser has none. */
  ancestorOrigins: z.array(z.string().max(255)).max(8).nullable(),
  /** The widget's version. */
  widget: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
  /** The `seq` of the card the frame sealed with. */
  cardSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type FeedbackDropFrame = z.infer<typeof FeedbackDropFrame>;

/** The sealed plaintext (FD-15): the direct widget's `FeedbackSubmission`, plus the frame's evidence. */
export const FeedbackDropPlaintext = z.strictObject({
  v: z.literal(1),
  submission: FeedbackSubmission,
  frame: FeedbackDropFrame,
});
export type FeedbackDropPlaintext = z.infer<typeof FeedbackDropPlaintext>;

/** Why the runtime refused a drop (FD-23); `internal` after 5 failed attempts. */
export const FeedbackDropRefusalCode = z.enum([
  'unknown_key',
  'undecryptable',
  'malformed',
  'unknown_site',
  'origin',
  'invalid',
  'too_large',
  'unsupported_attachment',
  'daily_cap',
  'conflict',
  'internal',
]);
export type FeedbackDropRefusalCode = z.infer<typeof FeedbackDropRefusalCode>;

/** A drop's final outcome in the runtime (FD-24): filed, a duplicate of a filed one, or refused. */
export const FeedbackDropOutcome = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('filed') }),
  z.strictObject({ outcome: z.literal('duplicate') }),
  z.strictObject({ outcome: z.literal('refused'), code: FeedbackDropRefusalCode }),
]);
export type FeedbackDropOutcome = z.infer<typeof FeedbackDropOutcome>;

/** Routing captured at intake (FB-13): assessment always uses this, never the current configuration. */
export const FeedbackIntakeSnapshot = z.object({
  revision: z.number().int().positive(),
  configHash: z.string(),
  /** The conversation the report went to: the person's Feedback room (CT-383). */
  conversationId: ConversationId,
  repoId: RepoId.nullable(),
  /** The person's guidance for the assessment (FB-F08). */
  projectContext: z.string(),
  /** Who last saved the settings before intake (the person, FB-F06). */
  configuredById: PrincipalId,
});
export type FeedbackIntakeSnapshot = z.infer<typeof FeedbackIntakeSnapshot>;

export const FeedbackAssessmentStatus = z.object({
  state: FeedbackAssessmentState,
  /** Why it is failed / blocked / paused, in plain words. */
  reason: z.string().nullable(),
  attempts: z.number().int().min(0),
  dispatchId: DispatchId.nullable(),
  updatedAt: Timestamp,
  result: FeedbackAssessment.nullable(),
  /**
   * The assessor's reply, bug verdict and decision (CT-193) once it is done; absent or null until then.
   */
  conclusion: FeedbackConclusion.nullable().optional(),
  /** The option a person picked (CT-193); absent or null until then. */
  decided: FeedbackDecisionChoice.nullable().optional(),
  /** Repository and branch or commit the assessor was given, when it had code access. */
  workspace: z.object({ repo: z.string(), ref: z.string() }).nullable(),
});
export type FeedbackAssessmentStatus = z.infer<typeof FeedbackAssessmentStatus>;

/** One assessment attempt (`feedback_assessments`). */
export const FeedbackAssessmentAttempt = z.object({
  id: FeedbackAssessmentId,
  attempt: z.number().int().positive(),
  state: z.enum(['running', 'done', 'failed', 'cancelled', 'blocked']),
  dispatchId: DispatchId.nullable(),
  error: z.string().nullable(),
  requestedById: PrincipalId.nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type FeedbackAssessmentAttempt = z.infer<typeof FeedbackAssessmentAttempt>;

/**
 * Full internal report (only the person whose Feedback room it went to, and the agent). Visitor
 * data and agent conclusions are kept apart.
 */
export const FeedbackReport = z.object({
  id: FeedbackReportId,
  integrationId: FeedbackIntegrationId,
  reference: FeedbackReference,
  productLabel: z.string(),
  type: FeedbackReportType,
  status: FeedbackReportStatus,
  receivedAt: Timestamp,
  updatedAt: Timestamp,
  /** Visitor-supplied, unverified. Empty once content was removed. */
  submitted: z.object({
    description: z.string(),
    expected: z.string(),
    steps: z.string(),
    reporter: z.object({
      name: z.string().nullable(),
      email: z.string().nullable(),
      /** The email was that of a signed-in reporter (CT-162): “Email verified”. */
      verified: z.boolean().default(false),
    }),
    /**
     * As received, except `trail`: an answer never carries `context.trail`; the runtime lifts it to `submitted.trail`
     * (CT-161).
     */
    context: FeedbackContext,
    /** The visitor's page views before reporting, oldest first (`context.trail` as stored). */
    trail: z.array(FeedbackTrailStep).max(FEEDBACK_TRAIL_MAX).default([]),
    attachments: z.array(Attachment),
  }),
  contentRemovedAt: Timestamp.nullable(),
  intake: FeedbackIntakeSnapshot,
  conversationId: ConversationId,
  rootMessageId: MessageId,
  assessment: FeedbackAssessmentStatus,
  attempts: z.array(FeedbackAssessmentAttempt),
  handoff: z
    .object({ approvalId: ApprovalId, approvalNumber: z.number().int().positive(), state: z.string() })
    .nullable(),
});
export type FeedbackReport = z.infer<typeof FeedbackReport>;
