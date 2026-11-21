/**
 * `@whombat/core/feedback/reporters` — reporter sign-in of Whombat Feedback (Whombat
 * `docs/implementation/feedback-reporters/assignment.md` §1, FR-*, CT-162, CT-163): a visitor signs in on a site with
 * their email address and a 6-digit code, their reports are marked verified, and “Your reports” shows how each is
 * going. The runtime (self-hosted), control (managed) and the widget frame use the same helpers.
 *
 * Pure and Zod-free, so the widget frame and loader can bundle it: only `@noble/hashes` (and type-only imports).
 * The Zod shapes of the requests and answers are in `@whombat/core/domain` (`FeedbackReporter*`).
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type {
  FeedbackAssessmentState,
  FeedbackOutcome,
  FeedbackReportStatus,
  FeedbackReportType,
} from '../domain/feedback-card.js';

// ---------------------------------------------------------------------------------------------------------
// Constants

/** A sign-in code lives 10 minutes and works once. */
export const FEEDBACK_REPORTER_CODE_TTL_S = 600;
/** Wrong tries that end a code (the fifth wrong one consumes it). */
export const FEEDBACK_REPORTER_CODE_ATTEMPTS = 5;
/** Codes sent per site + email address per rolling hour. */
export const FEEDBACK_REPORTER_CODES_PER_HOUR = 5;
/** Code requests per network (keyed client address) per hour, across emails. */
export const FEEDBACK_REPORTER_CODES_PER_NETWORK_PER_HOUR = 30;
/** Sign-in attempts (`POST …/reporter/session`) per network per hour, across emails and codes. */
export const FEEDBACK_REPORTER_SESSIONS_PER_NETWORK_PER_HOUR = 60;
/** The frame enables “Send a new code” this long after the last one. */
export const FEEDBACK_REPORTER_RESEND_S = 30;
/** A reporter session lives 30 days (not renewed by use). */
export const FEEDBACK_REPORTER_SESSION_TTL_S = 30 * 86_400;
/** At most this many reports in `FeedbackReporterReports` (newest first). */
export const FEEDBACK_REPORTER_REPORTS_MAX = 200;
/** A report's `summary` in “Your reports”. */
export const FEEDBACK_REPORTER_SUMMARY_MAX = 140;
/** Longest email address (as `FEEDBACK_TEXT_LIMITS.email`). */
export const FEEDBACK_REPORTER_EMAIL_MAX = 254;

/** A sign-in code: exactly 6 ASCII digits. */
export const FEEDBACK_REPORTER_CODE_PATTERN = /^[0-9]{6}$/;
/** A session token: `fbrs_` + 43 base64url characters (32 random bytes). Only its sha256 is stored. */
export const FEEDBACK_REPORTER_TOKEN_PATTERN = /^fbrs_[A-Za-z0-9_-]{43}$/;
/** A reporter id: `fbr_` + 22 base64url characters (16 random bytes). */
export const FEEDBACK_REPORTER_ID_PATTERN = /^fbr_[A-Za-z0-9_-]{22}$/;
/** `reporterEmailDigest`'s domain separation (followed by a newline). */
export const FEEDBACK_REPORTER_DIGEST_CONTEXT = 'whombat-feedback-reporter/1';
/** `reporterCodeMac`'s domain separation (followed by a newline). */
export const FEEDBACK_REPORTER_CODE_CONTEXT = 'whombat-feedback-reporter-code/1';

/** What a visitor sees about a report (never the internal status or the assessment itself). */
export const FEEDBACK_REPORTER_STATUSES = [
  'received',
  'reviewing',
  'needs_info',
  'confirmed',
  'in_progress',
  'fixed',
  'closed',
] as const;
export type ReporterStatus = (typeof FEEDBACK_REPORTER_STATUSES)[number];

// ---------------------------------------------------------------------------------------------------------
// Status

export interface ReporterStatusInput {
  status: FeedbackReportStatus | string;
  /** The report's assessment state (`FeedbackAssessmentStatus.state`); null when unknown. */
  assessmentState: FeedbackAssessmentState | string | null;
  /** The recorded assessment's outcome (`result.outcome`); null while there is none. */
  assessmentOutcome: FeedbackOutcome | string | null;
}

const OUTCOME_STATUS: Record<string, ReporterStatus> = {
  needs_information: 'needs_info',
  insufficient_evidence: 'needs_info',
  confirmed_bug: 'confirmed',
  likely_bug: 'confirmed',
  duplicate: 'confirmed',
  feature_request: 'confirmed',
};

/**
 * The visitor's status of a report: the owners' status once they set one (`resolved` → fixed, `closed`, `in_progress`,
 * `triaged` → confirmed); for a `new` report, what its assessment says (running → reviewing; a recorded outcome that
 * asks for more → needs_info; one that confirms or files it → confirmed; any other outcome → reviewing); otherwise
 * received.
 */
export function reporterStatusOf(input: ReporterStatusInput): ReporterStatus {
  switch (input.status) {
    case 'resolved':
      return 'fixed';
    case 'closed':
      return 'closed';
    case 'in_progress':
      return 'in_progress';
    case 'triaged':
      return 'confirmed';
    case 'new':
      if (input.assessmentState === 'running') return 'reviewing';
      if (input.assessmentOutcome) return OUTCOME_STATUS[input.assessmentOutcome] ?? 'reviewing';
      return 'received';
    default:
      return 'received';
  }
}

/** The widget's words for a status (“Your reports”), per report type. */
export const REPORTER_STATUS_COPY: Record<FeedbackReportType, Record<ReporterStatus, string>> = {
  bug: {
    received: 'Received',
    reviewing: 'Being looked at',
    needs_info: 'Needs more information',
    confirmed: 'Confirmed',
    in_progress: 'In progress',
    fixed: 'Fixed',
    closed: 'Closed',
  },
  feature: {
    received: 'Received',
    reviewing: 'Being looked at',
    needs_info: 'Needs more information',
    confirmed: 'Noted',
    in_progress: 'In progress',
    fixed: 'Done',
    closed: 'Closed',
  },
};

/** The widget's word for a report's type in “Your reports”. */
export const REPORTER_TYPE_COPY: Record<FeedbackReportType, string> = { bug: 'Problem', feature: 'Idea' };

/**
 * A report's `summary` in “Your reports”: the description with runs of whitespace collapsed, at most
 * `FEEDBACK_REPORTER_SUMMARY_MAX` characters (UTF-16 units, never splitting a surrogate pair), “…” when cut.
 */
export function reporterSummaryOf(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  if (flat.length <= FEEDBACK_REPORTER_SUMMARY_MAX) return flat;
  let cut = FEEDBACK_REPORTER_SUMMARY_MAX - 1;
  const last = flat.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${flat.slice(0, cut).trimEnd()}…`;
}

// ---------------------------------------------------------------------------------------------------------
// Email, digest, code, token

/** How every side compares addresses: trimmed and lower-cased (`String.prototype.toLowerCase`). */
export function normalizeReporterEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Control's attestation of a signed-in drop (`FeedbackDrop.reporter.emailDigest`): lower-case hex sha256 of the UTF-8
 * of `"whombat-feedback-reporter/1\n" + site + "\n" + normalizeReporterEmail(email)`. The runtime recomputes it from the
 * sealed submission's `reporter.email`; equal means the report came from that signed-in address.
 */
export function reporterEmailDigest(site: string, email: string): string {
  return bytesToHex(
    sha256(utf8ToBytes(`${FEEDBACK_REPORTER_DIGEST_CONTEXT}\n${site}\n${normalizeReporterEmail(email)}`)),
  );
}

/**
 * How a code is stored (never in plain): lower-case hex HMAC-SHA256 under the storer's own secret `key` of
 * `"whombat-feedback-reporter-code/1\n" + site + "\n" + normalized email + "\n" + code`.
 */
export function reporterCodeMac(key: Uint8Array, site: string, email: string, code: string): string {
  const message = `${FEEDBACK_REPORTER_CODE_CONTEXT}\n${site}\n${normalizeReporterEmail(email)}\n${code}`;
  return bytesToHex(hmac(sha256, key, utf8ToBytes(message)));
}

/** Constant-time comparison of two hex strings (digests, MACs). */
export function reporterDigestEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 4) / 3));
    for (let k = 0; k < chars; k++) out += B64URL.charAt((n >> (18 - 6 * k)) & 63);
  }
  return out;
}

/** A new sign-in code: 6 uniformly random digits (leading zeros kept). */
export function newReporterCode(): string {
  for (;;) {
    const b = randomBytes(4);
    const n = (((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0)) >>> 0;
    // 4 294 000 000 is the largest multiple of 10^6 below 2^32: no modulo bias.
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, '0');
  }
}

/** A new session token, `fbrs_` + 32 random bytes in base64url. */
export function newReporterToken(): string {
  return `fbrs_${base64url(randomBytes(32))}`;
}

/** How a session is stored: lower-case hex sha256 of the token's UTF-8. */
export function reporterTokenHash(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(token)));
}

/** A new reporter id, `fbr_` + 16 random bytes in base64url. */
export function newReporterId(): string {
  return `fbr_${base64url(randomBytes(16))}`;
}

/**
 * The session token of an `authorization` header (`Bearer fbrs_…`, scheme case-insensitive), or null when there is
 * none or it isn't a well-formed reporter token.
 */
export function reporterTokenFrom(authorization: string | null | undefined): string | null {
  if (typeof authorization !== 'string') return null;
  const m = /^bearer +(\S+) *$/i.exec(authorization);
  const token = m?.[1];
  return token && FEEDBACK_REPORTER_TOKEN_PATTERN.test(token) ? token : null;
}

/** The code email (plain text, from `MAIL_FROM`), the same in both modes. `parent` is the embedding origin. */
export function reporterCodeEmail(input: { code: string; productLabel: string; parent: string }): {
  subject: string;
  text: string;
} {
  const host = input.parent.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  return {
    subject: `${input.code} is your code for ${input.productLabel} feedback`,
    text: `Enter this code in the feedback window on ${host} to follow your reports:\n\n${input.code}\n\nIt works once, for 10 minutes. If you didn’t ask for it, you can ignore this email — nobody can sign in without the code.`,
  };
}
