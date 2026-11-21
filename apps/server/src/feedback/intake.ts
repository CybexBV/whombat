/**
 * Accepting a report (docs/decisions/feedback.md FB-07, FB-10, FB-13, FB-15): normalizing what the widget sent into
 * what is stored, the idempotency hash, and `feedback.receive_report`, the one transaction that makes a report exist.
 *
 * `feedback.receive_report` is committed by the burrow's Feedback principal (and refuses any other actor). Under the
 * burrow lock it re-checks idempotency (a concurrent duplicate replays the winner's receipt), the durable daily cap
 * and the burrow's storage quota, commits the re-encoded screenshots to the file store, inserts the report, posts the
 * root message (fixed text, the report card, no mentions, no dispatch), attaches the screenshots to it and signs
 * `feedback.report_received` with ids, sizes and hashes only. The visitor's words are only in the report row.
 */
import {
  attachmentUrl,
  canonicalJson,
  cleanText,
  FEEDBACK_CONTEXT_LIMITS,
  FEEDBACK_TYPE_LABELS,
  FeedbackContext,
  type FeedbackIntakeSnapshot,
  FeedbackIntegrationId,
  type FeedbackIntegrationSettings,
  FeedbackReportType,
  type FeedbackSubmission,
  newFeedbackReference,
  newId,
  originAllowed,
  sanitizeCustomContext,
  sanitizePageUrl,
  sanitizeReferences,
  sha256Hex,
} from '@whombat/core';
import { FEEDBACK_REPORTER_ID_PATTERN } from '@whombat/core/feedback/reporters';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { attachments, feedbackReports } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { filesRoom } from '../files/room';
import { lockBlob } from '../files/service';
import { blobKey } from '../files/store';
import { forbidden } from '../lib/errors';
import { iso } from '../lib/time';
import { loadPrincipalRow } from '../read/principals';
import { destinationLabel, destinationOf, reopenFeedbackChat } from './chat';
import { FeedbackPublicFailure, PUBLIC_RETRY_AFTER, unavailable } from './errors';
import { lockIntegration } from './integrations';
import { isFeedbackPrincipal } from './principal';
import { trailOn } from './switches';

const DAY_MS = 24 * 3_600_000;

export { wellFormed } from '../lib/well-formed';

/** What a submission becomes once the integration's settings applied (before its screenshots). */
export interface NormalizedSubmission {
  type: FeedbackSubmission['type'];
  description: string;
  expected: string;
  steps: string;
  reporterName: string | null;
  reporterEmail: string | null;
  context: FeedbackContext;
}

function nullableText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const clean = cleanText(value, max);
  return clean.length ? clean : null;
}

type TrailStep = NonNullable<FeedbackContext['trail']>[number];

/** The origin of a sanitized page URL, or null. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The visitor's page views as the server keeps them (feedback-reporters FR-04, FR-18): each URL sanitized again with
 * the integration's `redactPaths`; a step whose URL isn't an http(s) page, or isn't on one of the integration's allowed
 * origins, is left out; titles as printable text; none when the integration's `trail` is off or nothing is left.
 */
export function normalizeTrail(
  trail: readonly TrailStep[] | undefined,
  settings: Pick<FeedbackIntegrationSettings, 'redactPaths' | 'trail' | 'allowedOrigins'>,
): TrailStep[] | undefined {
  if (!trailOn(settings) || !trail?.length) return undefined;
  const steps = trail.slice(-FEEDBACK_CONTEXT_LIMITS.trail).flatMap((step): TrailStep[] => {
    const url = sanitizePageUrl(step.url, settings.redactPaths);
    if (!url || url.length > FEEDBACK_CONTEXT_LIMITS.url) return [];
    if (!originAllowed(originOf(url), settings.allowedOrigins)) return [];
    return [{ url, title: nullableText(step.title, FEEDBACK_CONTEXT_LIMITS.title), at: step.at }];
  });
  return steps.length ? steps : undefined;
}

/**
 * The server's own sanitizing of a (schema-valid) submission (FB-07): reporter fields the integration has `off` are
 * dropped, the page URL loses its query, fragment and id-like segments, custom context keeps only allowlisted keys,
 * references only short printable ids, the trail is sanitized like the page URL (or dropped, FR-04), and every
 * free-text field is printable text within its limit. `verifiedEmail`: the address of a signed-in reporter (FR-08),
 * stored whatever the submission and the email field's setting say.
 */
export function normalizeSubmission(
  submission: FeedbackSubmission,
  settings: FeedbackIntegrationSettings,
  options: { verifiedEmail?: string | null } = {},
): NormalizedSubmission {
  const c = submission.context;
  const pageUrl = c.page ? sanitizePageUrl(c.page.url, settings.redactPaths) : null;
  const trail = normalizeTrail(c.trail, settings);
  const context: FeedbackContext = {
    page: pageUrl ? { url: pageUrl, title: nullableText(c.page?.title, 160) } : null,
    browser: c.browser
      ? {
          name: cleanText(c.browser.name, 80),
          language: nullableText(c.browser.language, 35),
          viewport: c.browser.viewport,
          timeZone: nullableText(c.browser.timeZone, 64),
        }
      : null,
    app: c.app
      ? {
          version: nullableText(c.app.version, 64),
          environment: nullableText(c.app.environment, 64),
          build: nullableText(c.app.build, 64),
        }
      : null,
    custom: sanitizeCustomContext(c.custom, settings.contextKeys),
    references: sanitizeReferences(c.references),
    sentAt: c.sentAt,
    ...(trail ? { trail } : {}),
  };
  const name = settings.contactFields.name === 'off' ? '' : cleanText(submission.reporter.name, 120);
  const email = options.verifiedEmail
    ? options.verifiedEmail
    : settings.contactFields.email === 'off'
      ? ''
      : submission.reporter.email.trim();
  return {
    type: submission.type,
    description: cleanText(submission.description, 5000),
    expected: cleanText(submission.expected, 3000),
    steps: cleanText(submission.steps, 3000),
    reporterName: name || null,
    reporterEmail: email || null,
    context,
  };
}

/**
 * FB-10 / FB-A09: sha256 of the canonical normalized payload, screenshots by the sha256 of the bytes the visitor
 * sent. `context.sentAt` is left out: it is informational (the visitor's clock when they pressed Send), and a retry
 * of the same report must get its receipt whenever it was sent (R1-2). The stored report keeps the first one.
 */
export function payloadHashOf(normalized: NormalizedSubmission, screenshotHashes: readonly string[]): string {
  const { sentAt: _informational, ...context } = normalized.context;
  return sha256Hex(
    canonicalJson(JSON.parse(JSON.stringify({ ...normalized, context, screenshots: [...screenshotHashes] }))),
  );
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const ReceiveReportInput = z.object({
  integrationId: FeedbackIntegrationId,
  submissionId: z.string().min(1).max(64),
  payloadHash: Sha256,
  type: FeedbackReportType,
  description: z.string().min(1).max(5000),
  expected: z.string().max(3000),
  steps: z.string().max(3000),
  reporterName: z.string().max(120).nullable(),
  reporterEmail: z.string().max(254).nullable(),
  context: FeedbackContext,
  screenshots: z
    .array(
      z.object({
        staged: z.object({
          token: z.string().regex(/^[0-9a-f-]{36}$/),
          size: z.number().int().positive(),
          sha256: Sha256,
        }),
        originalSha256: Sha256,
        contentType: z.enum(['image/png', 'image/jpeg']),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        name: z.string().regex(/^screenshot-\d\.(png|jpg)$/),
      }),
    )
    .max(3),
  /** How it arrived (FD-23): straight from the widget, or collected from the encrypted drop. */
  via: z.enum(['direct', 'drop']).default('direct'),
  /** The drop it came in (`fdr_…`), for `via: drop`. */
  dropId: z
    .string()
    .regex(/^fdr_[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  /** The signed-in reporter who sent it (FR-08, FR-09): self-hosted, a `feedback_reporters` id; managed, control's. */
  reporterId: z.string().regex(FEEDBACK_REPORTER_ID_PATTERN).nullable().default(null),
  /** `reporterEmail` is that reporter's session address (“Email verified”). */
  reporterVerified: z.boolean().default(false),
  /** The reference the frame already showed (`feedbackReferenceFor`, FD-16); a random one when it is taken. */
  reference: z
    .string()
    .regex(/^FB-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    .optional(),
});
export type ReceiveReportInput = z.input<typeof ReceiveReportInput>;

export interface ReceiveReportResult {
  /** False when this submission was already accepted (the receipt is replayed). */
  created: boolean;
  reportId: string;
  reference: string;
  receivedAt: string;
}

export const receiveFeedbackReport = defineCommand({
  name: 'feedback.receive_report',
  schema: ReceiveReportInput,
  async apply(tx, ctx, input): Promise<ReceiveReportResult> {
    const services = ctx.services;
    const actorRow = await loadPrincipalRow(tx, ctx.actor.id);
    if (!isFeedbackPrincipal(actorRow) || actorRow?.burrowId !== ctx.burrow.id)
      throw forbidden('Only Whombat Feedback receives reports.');

    const integration = await lockIntegration(tx, ctx.burrow.id, input.integrationId).catch(() => null);
    if (!integration) throw unavailable();
    // A drop was accepted by Whombat's cloud while intake was on; it is still filed after intake went off
    // (feedback-drop FD-19, FD-51). A direct submission needs intake on now.
    if (integration.intake !== 'enabled' && input.via !== 'drop') throw unavailable();
    const settings = integration.settings;

    // Idempotency again, under the burrow lock: a concurrent duplicate that got here second replays the receipt.
    const [existing] = await tx
      .select()
      .from(feedbackReports)
      .where(
        and(
          eq(feedbackReports.integrationId, integration.id),
          eq(feedbackReports.submissionId, input.submissionId),
        ),
      );
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) throw new FeedbackPublicFailure('conflict');
      return {
        created: false,
        reportId: existing.id,
        reference: existing.reference,
        receivedAt: iso(existing.createdAt),
      };
    }

    // The durable daily cap (FB-12).
    const since = new Date(ctx.now.getTime() - DAY_MS);
    const [day] = await tx
      .select({ n: count() })
      .from(feedbackReports)
      .where(and(eq(feedbackReports.integrationId, integration.id), gt(feedbackReports.createdAt, since)));
    if ((day?.n ?? 0) >= settings.limits.reportsPerDay)
      // A fixed wait: when the window frees up would tell a visitor when other reports arrived (FB-F07).
      throw new FeedbackPublicFailure('rate_limited', { retryAfter: PUBLIC_RETRY_AFTER.daily });

    // The files' room, as uploads are checked: a fixed quota when one is set, else the disk's (page-sets.md PG-20).
    const bytes = input.screenshots.reduce((n, s) => n + s.staged.size, 0);
    if (bytes > 0) {
      const room = await filesRoom(services.config, bytes, async () => {
        const [used] = await tx
          .select({ bytes: sql<number>`coalesce(sum(${attachments.size}), 0)::bigint` })
          .from(attachments)
          .where(eq(attachments.burrowId, ctx.burrow.id));
        return Number(used?.bytes ?? 0);
      });
      if (room !== 'ok') throw new FeedbackPublicFailure('too_large');
    }

    // The integration's channel, or its chat with the person's assistant (less-is-more.md LM-01).
    const channel = await destinationOf(tx, ctx.burrow.id, integration.channelId, integration.id);
    if (!channel) throw unavailable();

    let reference = input.reference ?? newFeedbackReference();
    for (let i = 0; i < 8; i++) {
      const [taken] = await tx
        .select({ id: feedbackReports.id })
        .from(feedbackReports)
        .where(eq(feedbackReports.reference, reference));
      if (!taken) break;
      // The derived reference of a drop belongs to another report (FD-16): this one gets a random one, and the
      // visitor's number finds nothing (FB-11 allows that).
      if (i === 0 && input.reference)
        services.log.info(
          { dropId: input.dropId ?? null },
          'feedback drop: derived reference taken, filed under another',
        );
      reference = newFeedbackReference();
    }

    const reportId = newId('feedbackReport');
    const messageId = newId('message');

    // Screenshots: staged bytes → content-addressed blobs (under each blob's lock), ready rows on the root message.
    const attachmentIds: string[] = [];
    const attached: {
      id: string;
      size: number;
      sha256: string;
      originalSha256: string;
      contentType: string;
    }[] = [];
    for (const shot of input.screenshots) {
      const key = blobKey(shot.staged.sha256);
      await lockBlob(tx, key);
      await services.files.store.commit(shot.staged, key);
      const id = newId('attachment');
      await tx.insert(attachments).values({
        id,
        burrowId: ctx.burrow.id,
        conversationId: channel.id,
        name: shot.name,
        declaredType: shot.contentType,
        contentType: shot.contentType,
        kind: 'image',
        size: shot.staged.size,
        sha256: shot.staged.sha256,
        blobKey: key,
        width: shot.width,
        height: shot.height,
        state: 'ready',
        url: attachmentUrl(ctx.burrow.slug, id),
        uploadedById: ctx.actor.id,
        messageId,
        createdAt: ctx.now,
        uploadedAt: ctx.now,
      });
      attachmentIds.push(id);
      attached.push({
        id,
        size: shot.staged.size,
        sha256: shot.staged.sha256,
        originalSha256: shot.originalSha256,
        contentType: shot.contentType,
      });
    }

    // The agent assesses every report (one-agent.md OA-16), unless the person paused it.
    const assessmentState = integration.assessment === 'paused' ? 'paused' : 'queued';
    const snapshot: FeedbackIntakeSnapshot = {
      revision: integration.revision,
      configHash: integration.configHash,
      conversationId: channel.id,
      repoId: settings.repoId,
      projectContext: settings.projectContext,
      configuredById: integration.updatedById,
    };
    await tx.insert(feedbackReports).values({
      id: reportId,
      burrowId: ctx.burrow.id,
      integrationId: integration.id,
      reference,
      submissionId: input.submissionId,
      payloadHash: input.payloadHash,
      type: input.type,
      status: 'new',
      description: input.description,
      expected: input.expected,
      steps: input.steps,
      reporterName: input.reporterName,
      reporterEmail: input.reporterEmail,
      context: input.context,
      attachmentIds,
      reporterId: input.reporterId,
      reporterVerified: input.reporterId !== null && input.reporterVerified,
      // The Whombat tells control the reporter's status (FR-10).
      reporterDirty: input.reporterId !== null,
      intake: snapshot,
      conversationId: channel.id,
      rootMessageId: messageId,
      assessmentState,
      assessmentReason: assessmentState === 'paused' ? 'Assessment is paused for this integration.' : null,
      assessmentUpdatedAt: ctx.now,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });

    // An archived feedback chat comes back to the person's list: a new report is something to look at (LM-F06).
    await reopenFeedbackChat(ctx, channel);
    // The thread: fixed text only, so nothing the visitor wrote can mention, trigger or command anything.
    await postMessage(ctx, {
      conversation: channel,
      id: messageId,
      text: `${FEEDBACK_TYPE_LABELS[input.type]} ${reference} · ${settings.productLabel}`,
      card: { kind: 'report', reportId },
      attachmentIds,
      mentions: [],
      dispatch: false,
      createdAt: ctx.now,
    });

    await ctx.emit({
      type: 'feedback.report_received',
      kind: 'System',
      text: null,
      where: destinationLabel(channel),
      payload: {
        reportId,
        reference,
        integrationId: integration.id,
        revision: integration.revision,
        configHash: integration.configHash,
        type: input.type,
        conversationId: channel.id,
        rootMessageId: messageId,
        assessmentState,
        payloadHash: input.payloadHash,
        attachments: attached,
        // Only a dropped report says how it came (FD-23); a direct one's payload is as before.
        ...(input.via === 'drop' ? { via: 'drop', dropId: input.dropId ?? null } : {}),
        // Only a signed-in reporter's report says so (FR-08): never the address or the reporter's id.
        ...(input.reporterId !== null && input.reporterVerified ? { reporterVerified: true } : {}),
      },
    });

    await services.feedback.faults.beforeIntakeCommit?.();

    const feedback = services.feedback;
    const publish = input.reporterId !== null;
    ctx.after(async () => {
      feedback.nudge();
      if (publish) feedback.reportersChanged();
    });
    return { created: true, reportId, reference, receivedAt: ctx.at };
  },
});
