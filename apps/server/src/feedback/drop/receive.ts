/**
 * One collected drop to an outcome (docs/decisions/feedback-drop.md FD-23): open the envelope, check what only the
 * runtime can check, and file the submission through the one filing path (`../file.ts`). In FD-23's order:
 *
 *   kid known (`unknown_key`) → AEAD opens (`undecryptable`) → header site = the drop's site, zero padding
 *   (`malformed`) → an integration of this runtime has the site (`unknown_site`) → the drop's `Origin` is the embed
 *   origin (`origin`) → size, shape, structure, `wellFormed`, strict schema (`invalid`, `too_large`) → `parentOrigin`
 *   in the integration's current allowed origins, the frame's bridge origin and first ancestor equal to it
 *   (`origin`) → report type offered (`invalid`) → filed (or `duplicate`, `conflict`, `daily_cap`, …).
 *
 * The in-memory token buckets and intake slots of the direct route are not used: control enforced the card's limits
 * and filing is serial; the durable daily cap stays the backstop.
 */
import type { FeedbackDrop } from '@whombat/control-contracts/device';
import {
  FeedbackDropFrame,
  type FeedbackDropOutcome,
  type FeedbackDropRefusalCode,
  type FeedbackPublicErrorCode,
} from '@whombat/core';
import {
  FEEDBACK_DROP_WRAPPER_BYTES,
  FeedbackDropError,
  feedbackReferenceFor,
  openDropEnvelope,
} from '@whombat/core/feedback/drop';
import {
  normalizeReporterEmail,
  reporterDigestEqual,
  reporterEmailDigest,
} from '@whombat/core/feedback/reporters';
import { eq } from 'drizzle-orm';
import { managedEmbedOrigin } from '../../config';
import { feedbackIntegrations } from '../../db/schema/index';
import type { Services } from '../../services';
import { FeedbackPublicFailure } from '../errors';
import { fileSubmission, type VerifiedReporter } from '../file';
import type { IntegrationRow } from '../integrations';
import { SUBMISSION_BOUNDS, scanJsonShape } from '../structure';
import { bodyCapOf, checkSubmission, parentAllowed } from '../submission';
import { reporterSignInOn } from '../switches';
import type { DropKeys } from './keys';

/** The plaintext wraps the submission one level deeper, with a bounded frame beside it (FD-15, FD-36). */
const PLAINTEXT_BOUNDS = {
  ...SUBMISSION_BOUNDS,
  depth: SUBMISSION_BOUNDS.depth + 1,
  nodes: SUBMISSION_BOUNDS.nodes + 32,
};

export interface DropResult {
  outcome: FeedbackDropOutcome;
  integrationId: string | null;
}

class Refused extends Error {
  constructor(readonly code: FeedbackDropRefusalCode) {
    super(`feedback drop refused: ${code}`);
  }
}

/** A filing refusal as the drop's refusal code; null when it is transient (the drop comes back). */
const FILING_CODE: Record<FeedbackPublicErrorCode, FeedbackDropRefusalCode | null> = {
  invalid: 'invalid',
  too_large: 'too_large',
  unsupported_attachment: 'unsupported_attachment',
  conflict: 'conflict',
  rate_limited: 'daily_cap',
  unavailable: 'unknown_site',
  internal: null,
  // Reporter sign-in answers never come out of filing; listed for the closed set.
  code_refused: 'invalid',
  signed_out: 'invalid',
};

/**
 * Control's attestation of a signed-in reporter (feedback-reporters FR-09, CT-164): honoured only when the sealed
 * submission's address gives the same `reporterEmailDigest` for this site, and the integration still offers sign-in
 * (as the direct route ignores a session then). Anything else files the report unverified, never refuses it.
 */
export function attestedReporter(
  drop: Pick<FeedbackDrop, 'site' | 'reporter'>,
  row: Pick<IntegrationRow, 'settings'>,
  email: string,
): VerifiedReporter | null {
  if (!drop.reporter || !email || !reporterSignInOn(row.settings)) return null;
  const digest = reporterEmailDigest(drop.site, email);
  if (!reporterDigestEqual(digest, drop.reporter.emailDigest)) return null;
  return { id: drop.reporter.id, email: normalizeReporterEmail(email) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Opens, checks and files one drop. Returns the final outcome; throws on a transient failure (database, image
 * worker), which leaves the drop unacknowledged so control delivers it again.
 */
export async function receiveDrop(
  services: Services,
  keys: DropKeys,
  drop: FeedbackDrop,
): Promise<DropResult> {
  let integrationId: string | null = null;
  try {
    const envelope = new Uint8Array(Buffer.from(drop.envelope, 'base64url'));
    let plaintextJson: string;
    try {
      ({ plaintextJson } = await openDropEnvelope(envelope, (kid) => keys.privateKeyFor(kid), {
        site: drop.site,
      }));
    } catch (err) {
      if (err instanceof FeedbackDropError)
        throw new Refused(err.code === 'too_large' ? 'malformed' : err.code);
      throw err;
    }

    const [row] = await services.db
      .select()
      .from(feedbackIntegrations)
      .where(eq(feedbackIntegrations.siteId, drop.site));
    // A connected system's integration has no widget, so no drop (feedback-sources.md FBS-01).
    if (!row) throw new Refused('unknown_site');
    integrationId = row.id;
    if (drop.origin !== managedEmbedOrigin(services.config)) throw new Refused('origin');

    const bytes = Buffer.from(plaintextJson, 'utf8');
    if (bytes.length > bodyCapOf(row.settings) + FEEDBACK_DROP_WRAPPER_BYTES) throw new Refused('too_large');
    if (!scanJsonShape(bytes, PLAINTEXT_BOUNDS)) throw new Refused('invalid');
    let raw: unknown;
    try {
      raw = JSON.parse(plaintextJson);
    } catch {
      throw new Refused('invalid');
    }
    if (!isRecord(raw) || raw.v !== 1) throw new Refused('invalid');
    if (Object.keys(raw).some((k) => k !== 'v' && k !== 'submission' && k !== 'frame'))
      throw new Refused('invalid');
    const frame = FeedbackDropFrame.safeParse(raw.frame);
    if (!frame.success) throw new Refused('invalid');
    const submission = checkSubmission(raw.submission);

    const parent = submission.parentOrigin;
    const ancestors = frame.data.ancestorOrigins;
    if (
      !parentAllowed(row, parent) ||
      frame.data.bridgeOrigin !== parent ||
      (ancestors !== null && ancestors[0] !== parent)
    )
      throw new Refused('origin');
    if (!row.settings.reportTypes.includes(submission.type)) throw new Refused('invalid');

    const filed = await fileSubmission(
      services,
      row as IntegrationRow,
      submission,
      {
        via: 'drop',
        dropId: drop.dropId,
        reference: feedbackReferenceFor(drop.site, submission.submissionId),
      },
      attestedReporter(drop, row as IntegrationRow, submission.reporter.email),
    );
    return { outcome: { outcome: filed.created ? 'filed' : 'duplicate' }, integrationId };
  } catch (err) {
    if (err instanceof Refused) return { outcome: { outcome: 'refused', code: err.code }, integrationId };
    if (err instanceof FeedbackPublicFailure) {
      const code = FILING_CODE[err.code];
      if (code) return { outcome: { outcome: 'refused', code }, integrationId };
    }
    throw err;
  }
}
