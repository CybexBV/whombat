/**
 * The checks a submission passes before it is filed, whichever way it came (docs/decisions/feedback.md,
 * feedback-drop.md): the integration's body cap and public config, the allowed-origin check, and the parsed
 * JSON to a strict `FeedbackSubmission`. No HTTP here: the drop (`drop/receive.ts`) uses it.
 */
import {
  FEEDBACK_ATTACHMENT_TYPES,
  FEEDBACK_MAX_BODY_BYTES,
  FEEDBACK_TEXT_LIMITS,
  FeedbackPublicConfig,
  FeedbackSubmission,
  originAllowed,
} from '@whombat/core';
import { FeedbackPublicFailure } from './errors';
import { wellFormed } from './intake';
import type { IntegrationRow } from './integrations';
import { checkStructure } from './structure';
import { reporterSignInOn, trailOn } from './switches';

/** Room for the JSON around the screenshots (text, context, field names). */
const BODY_OVERHEAD_BYTES = 64 * 1024;

/** The largest body an integration's submission can legitimately be (FB-09). */
export function bodyCapOf(settings: IntegrationRow['settings']): number {
  const { maxAttachments, maxAttachmentBytes } = settings.limits;
  const perFile = Math.ceil(maxAttachmentBytes / 3) * 4 + 512;
  return Math.min(FEEDBACK_MAX_BODY_BYTES, maxAttachments * perFile + BODY_OVERHEAD_BYTES);
}

/**
 * What the widget needs to render and validate (nothing private: no channel, agent, repo or limits besides files).
 * `trail` and `reporters` (FR-03) tell the widget what it may do; `mail` is whether sign-in codes can be sent: a
 * self-hosted Whombat needs `SMTP_URL`, a managed one's card relies on control, which always sends them.
 */
export function publicConfigOf(
  settings: IntegrationRow['settings'],
  options: { mail: boolean },
): FeedbackPublicConfig {
  return FeedbackPublicConfig.parse({
    productLabel: settings.productLabel,
    reportTypes: settings.reportTypes,
    theme: settings.theme,
    position: settings.position,
    launcher: settings.launcher,
    launcherLabel: settings.launcherLabel,
    privacyUrl: settings.privacyUrl,
    contactFields: { name: settings.contactFields.name, email: settings.contactFields.email },
    attachments: {
      max: settings.limits.maxAttachments,
      maxBytes: settings.limits.maxAttachmentBytes,
      types: [...FEEDBACK_ATTACHMENT_TYPES],
    },
    text: {
      description: FEEDBACK_TEXT_LIMITS.description,
      expected: FEEDBACK_TEXT_LIMITS.expected,
      steps: FEEDBACK_TEXT_LIMITS.steps,
    },
    redactPaths: settings.redactPaths,
    contextKeys: settings.contextKeys,
    trail: trailOn(settings),
    reporters: reporterSignInOn(settings) && options.mail,
  });
}

/** Whether `parent` is exactly one of the integration's allowed origins (FB-05; a browser control, not identity). */
export function parentAllowed(row: IntegrationRow, parent: unknown): boolean {
  return typeof parent === 'string' && originAllowed(parent, row.settings.allowedOrigins);
}

/** Field paths of the first issues only (R1-1: never map, stringify or dedupe every issue of a hostile body). */
const MAX_ISSUES = 20;
function zodFieldPaths(issues: readonly { path: readonly PropertyKey[] }[]): string[] {
  return issues
    .slice(0, MAX_ISSUES)
    .map((i) => i.path.slice(0, 8).map(String).join('.').slice(0, 200) || 'body');
}

/** A parsed JSON value to a strict `FeedbackSubmission` (structure bounds, `wellFormed`, schema), or `invalid`. */
export function checkSubmission(raw: unknown): FeedbackSubmission {
  const outOfBounds = checkStructure(raw);
  if (outOfBounds) throw new FeedbackPublicFailure('invalid', { fields: [outOfBounds] });
  const parsed = FeedbackSubmission.safeParse(wellFormed(raw));
  if (!parsed.success)
    throw new FeedbackPublicFailure('invalid', { fields: zodFieldPaths(parsed.error.issues) });
  return parsed.data;
}
