/**
 * Filing a report (docs/decisions/feedback-drop.md FD-23): the one path from a schema-valid `FeedbackSubmission` to a
 * stored report, used by the drop worker (`drop/`, after opening and checking an envelope). In order: the server's own sanitizing, screenshots decoded, the payload hash,
 * idempotency (screenshots by the hash of the bytes sent), the durable daily cap, image decode and re-encode (worker
 * thread, FB-F02) and `feedback.receive_report`. Refusals are `FeedbackPublicFailure`s.
 */
import type { FeedbackSubmission } from '@whombat/core';
import { and, count, eq, gt } from 'drizzle-orm';
import { feedbackReports } from '../db/schema/index';
import type { StagedFile } from '../files/store';
import { iso } from '../lib/time';
import type { Services } from '../services';
import { FeedbackPublicFailure, PUBLIC_RETRY_AFTER } from './errors';
import { decodeScreenshots, processScreenshots } from './images';
import { normalizeSubmission, payloadHashOf, receiveFeedbackReport } from './intake';
import type { IntegrationRow } from './integrations';
import { feedbackPrincipal } from './principal';

/** How a submission reached this Whombat: straight from the widget, or through the encrypted drop. */
export type FilingSource = { via: 'direct' } | { via: 'drop'; dropId: string; reference: string };

/**
 * The signed-in reporter who sent it (feedback-reporters FR-08, FR-09): self-hosted, the reporter of a valid session
 * (the `Authorization` Bearer); managed, control's attestation when its digest matches the sealed address. `email` is
 * normalized and replaces whatever the submission said.
 */
export interface VerifiedReporter {
  id: string;
  email: string;
}

export interface FiledReport {
  /** False when this submission was already accepted (its receipt is replayed). */
  created: boolean;
  reference: string;
  receivedAt: string;
}

/**
 * Files `submission` for the integration `row` (whose allowed origins and report types the caller checked). Throws
 * `FeedbackPublicFailure`: `invalid`, `too_large`, `unsupported_attachment`, `conflict` (same id, other content),
 * `rate_limited` (the daily cap), `unavailable` (the integration or its channel went away), `internal`.
 */
export async function fileSubmission(
  services: Services,
  row: IntegrationRow,
  submission: FeedbackSubmission,
  source: FilingSource,
  reporter: VerifiedReporter | null = null,
): Promise<FiledReport> {
  const settings = row.settings;
  const normalized = normalizeSubmission(submission, settings, {
    verifiedEmail: reporter?.email ?? null,
  });
  if (!normalized.description) throw new FeedbackPublicFailure('invalid', { fields: ['description'] });
  const originals = decodeScreenshots(submission.attachments, settings.limits);
  const payloadHash = payloadHashOf(
    normalized,
    originals.map((o) => o.sha256),
  );

  // Idempotency before any image work (FB-10): the same submission gets its receipt, a different one a 409.
  const replay = await receiptFor(services, row.id, submission.submissionId, payloadHash);
  if (replay) return { created: false, ...replay };
  // The durable daily cap, cheaply, before any image work (FB-F03); the intake transaction checks it again under
  // the burrow lock, and that check is the one that counts.
  if (originals.length && (await reportsToday(services, row.id)) >= settings.limits.reportsPerDay)
    throw new FeedbackPublicFailure('rate_limited', { retryAfter: PUBLIC_RETRY_AFTER.daily });

  const processed = await processScreenshots(originals, services.feedback.images);
  const staged: StagedFile[] = [];
  const store = services.files.store;
  try {
    for (const shot of processed)
      staged.push(await store.stage([shot.bytes], { maxBytes: shot.bytes.length }));
    const actorId = await feedbackPrincipal(services, row.burrowId);
    const res = await services.pipeline.commit(
      receiveFeedbackReport,
      {
        integrationId: row.id,
        submissionId: submission.submissionId,
        payloadHash,
        type: normalized.type,
        description: normalized.description,
        expected: normalized.expected,
        steps: normalized.steps,
        reporterName: normalized.reporterName,
        reporterEmail: normalized.reporterEmail,
        context: normalized.context,
        reporterId: reporter?.id ?? null,
        // A connected system's reporter is its signed-in account (FBS-05).
        reporterVerified: reporter !== null,
        screenshots: processed.map((shot, i) => ({
          staged: staged[i] as StagedFile,
          originalSha256: shot.originalSha256,
          contentType: shot.contentType,
          width: shot.width,
          height: shot.height,
          name: shot.name,
        })),
        ...(source.via === 'drop'
          ? { via: 'drop' as const, dropId: source.dropId, reference: source.reference }
          : { via: 'direct' as const }),
      },
      { burrowId: row.burrowId, actorId },
    );
    if (res.status !== 'ok') throw new FeedbackPublicFailure('internal');
    const { created, reference, receivedAt } = res.result;
    // A replay (a concurrent duplicate committed first) leaves our staged copies unused.
    if (!created) await Promise.all(staged.map((s) => store.discard(s)));
    return { created, reference, receivedAt };
  } catch (err) {
    // Nothing was stored: staged bytes go (a committed blob nothing references goes with the attachment sweep).
    await Promise.all(staged.map((s) => store.discard(s).catch(() => {})));
    throw err;
  }
}

/** Reports the integration received in the last 24 hours. */
async function reportsToday(services: Services, integrationId: string): Promise<number> {
  const since = new Date(services.clock().getTime() - 24 * 3_600_000);
  const [day] = await services.db
    .select({ n: count() })
    .from(feedbackReports)
    .where(and(eq(feedbackReports.integrationId, integrationId), gt(feedbackReports.createdAt, since)));
  return day?.n ?? 0;
}

/** The receipt of an already accepted submission (same payload), a 409 for a different one, null for a new one. */
async function receiptFor(
  services: Services,
  integrationId: string,
  submissionId: string,
  payloadHash: string,
): Promise<{ reference: string; receivedAt: string } | null> {
  const [existing] = await services.db
    .select({
      reference: feedbackReports.reference,
      payloadHash: feedbackReports.payloadHash,
      createdAt: feedbackReports.createdAt,
    })
    .from(feedbackReports)
    .where(
      and(eq(feedbackReports.integrationId, integrationId), eq(feedbackReports.submissionId, submissionId)),
    );
  if (!existing) return null;
  if (existing.payloadHash !== payloadHash) throw new FeedbackPublicFailure('conflict');
  return { reference: existing.reference, receivedAt: iso(existing.createdAt) };
}
