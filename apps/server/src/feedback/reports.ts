/**
 * Changes to a received report (docs/decisions/feedback.md FB-17, FB-25): its internal status and removing its content
 * (the person, in the report's room; or the retention sweep signed by the Feedback principal once the integration's
 * `retentionDays` passed).
 *
 * Removal clears the visitor's text, contact details and context, deletes the screenshot rows (and takes them off the
 * root message) so their bytes go once nothing else references them, removes the assessor's words (the assessment's
 * free text, and the text of everything the assessor posted in the thread, FB-F3-11), and keeps the row, reference,
 * type, status, the assessment's outcome and levels, and timestamps. The person's replies in the thread stay: Whombat has
 * no message deletion. Signed history is untouched: its events never held content.
 */
import {
  FEEDBACK_DECISION_ACTION_LABELS,
  FEEDBACK_DECISION_OPTIONS_MAX,
  FEEDBACK_DECISION_STATUS,
  FEEDBACK_REMOVED_TEXT,
  FEEDBACK_STATUS_LABELS,
  FeedbackReportId,
  FeedbackReportStatus,
  redactedAssessment,
  redactedConclusion,
} from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import {
  attachments,
  feedbackIntegrations,
  feedbackReports,
  messages,
  searchDocuments,
} from '../db/schema/index';
import { ApiError, conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow } from '../read/principals';
import { destinationLabel } from './chat';
import { requestHandoff } from './handoff';
import { isFeedbackPrincipal } from './principal';
import { reportChanged } from './reporters';

export type ReportRow = typeof feedbackReports.$inferSelect;

const DAY_MS = 24 * 3_600_000;

/** The burrow's report, locked; 404 otherwise (its existence isn't revealed). */
async function burrowReport(tx: Tx, ctx: ApplyContext, reportId: string): Promise<ReportRow> {
  const [row] = await tx.select().from(feedbackReports).where(eq(feedbackReports.id, reportId)).for('update');
  if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Report');
  return row;
}

async function whereOf(tx: Tx, conversationId: string): Promise<string> {
  const conv = await loadConversationRow(tx, conversationId);
  return conv ? destinationLabel(conv) : 'Feedback';
}

export const setFeedbackReportStatus = defineCommand({
  name: 'feedback.set_report_status',
  schema: z.object({ reportId: FeedbackReportId, status: FeedbackReportStatus }),
  async apply(tx, ctx, input) {
    const row = await burrowReport(tx, ctx, input.reportId);
    if (row.status === input.status) return { reportId: row.id };
    await tx
      .update(feedbackReports)
      .set({ status: input.status, updatedAt: ctx.now })
      .where(eq(feedbackReports.id, row.id));
    const event = await ctx.emit({
      type: 'feedback.report_status',
      kind: 'System',
      text: null,
      where: await whereOf(tx, row.conversationId),
      payload: { reportId: row.id, reference: row.reference, from: row.status, to: input.status },
    });
    await reportChanged(ctx, [row.rootMessageId], event.id);
    return { reportId: row.id, label: FEEDBACK_STATUS_LABELS[input.status] };
  },
});

/** Clears a report's content inside the transaction; returns the blob keys the rows used. */
async function removeContent(tx: Tx, ctx: ApplyContext, row: ReportRow, reason: 'owner' | 'retention') {
  const removed = row.attachmentIds.length
    ? await tx
        .delete(attachments)
        .where(inArray(attachments.id, row.attachmentIds))
        .returning({ id: attachments.id, blobKey: attachments.blobKey, sha256: attachments.sha256 })
    : [];
  const [root] = await tx.select().from(messages).where(eq(messages.id, row.rootMessageId)).for('update');
  if (root && row.attachmentIds.length) {
    const gone = new Set(row.attachmentIds);
    await tx
      .update(messages)
      .set({ attachmentIds: root.attachmentIds.filter((id) => !gone.has(id)) })
      .where(eq(messages.id, root.id));
  }
  await tx
    .update(feedbackReports)
    .set({
      description: '',
      expected: '',
      steps: '',
      reporterName: null,
      reporterEmail: null,
      context: null,
      attachmentIds: [],
      // The assessor's words go too (they quote and paraphrase the visitor); the outcome and levels stay (FB-F3-11).
      assessment: row.assessment ? redactedAssessment(row.assessment) : null,
      // Its reply, question and labels as well; the verdict and the options' actions stay (FB-32).
      conclusion: row.conclusion ? redactedConclusion(row.conclusion) : null,
      decided: row.decided
        ? { ...row.decided, label: FEEDBACK_DECISION_ACTION_LABELS[row.decided.action] }
        : null,
      contentRemovedAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(eq(feedbackReports.id, row.id));
  // Everything the assessor posted in the report's thread (its replies, the rendered summary, a final-text fallback):
  // the text is replaced, the messages stay (Whombat deletes no messages). People's replies are theirs and stay.
  const assessorPosts = await tx
    .update(messages)
    .set({ text: FEEDBACK_REMOVED_TEXT, more: null, suggestions: [] })
    .where(and(eq(messages.threadRootId, row.rootMessageId), eq(messages.provenance, 'feedback_assessment')))
    .returning({ id: messages.id });
  const assessorIds = assessorPosts.map((m) => m.id);
  if (assessorIds.length) await tx.delete(searchDocuments).where(inArray(searchDocuments.id, assessorIds));
  const event = await ctx.emit({
    type: 'feedback.report_redacted',
    kind: 'System',
    text:
      reason === 'retention'
        ? 'Removed the content of a feedback report after its retention period.'
        : 'Removed the content of a feedback report.',
    where: await whereOf(tx, row.conversationId),
    payload: {
      reportId: row.id,
      reference: row.reference,
      reason,
      attachments: removed.map((a) => ({ id: a.id, sha256: a.sha256 ?? '' })),
      assessorMessageIds: assessorIds,
    },
  });
  await reportChanged(ctx, [row.rootMessageId, ...assessorIds], event.id);
  const files = ctx.services.files;
  const keys = [...new Set(removed.flatMap((a) => (a.blobKey ? [a.blobKey] : [])))];
  if (keys.length)
    ctx.after(async () => {
      for (const key of keys) await files.removeIfUnused(key);
    });
}

export const redactFeedbackReport = defineCommand({
  name: 'feedback.redact_report',
  schema: z.object({ reportId: FeedbackReportId }),
  async apply(tx, ctx, input) {
    const actor = await loadPrincipalRow(tx, ctx.actor.id);
    if (isFeedbackPrincipal(actor)) {
      // The retention sweep: only once the integration's retention period passed.
      const [row] = await tx
        .select({ report: feedbackReports, retentionDays: feedbackIntegrations.settings })
        .from(feedbackReports)
        .innerJoin(feedbackIntegrations, eq(feedbackIntegrations.id, feedbackReports.integrationId))
        .where(eq(feedbackReports.id, input.reportId))
        .for('update', { of: feedbackReports });
      if (!row || row.report.burrowId !== ctx.burrow.id) throw notFound('Report');
      const days = row.retentionDays.retentionDays;
      if (days === null || row.report.createdAt.getTime() + days * DAY_MS > ctx.now.getTime())
        throw forbidden('This report’s retention period hasn’t passed.');
      if (row.report.contentRemovedAt) return { reportId: row.report.id, removed: false };
      await removeContent(tx, ctx, row.report, 'retention');
      return { reportId: row.report.id, removed: true };
    }
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can remove a report’s content.');
    const row = await burrowReport(tx, ctx, input.reportId);
    if (row.contentRemovedAt) return { reportId: row.id, removed: false };
    await removeContent(tx, ctx, row, 'owner');
    return { reportId: row.id, removed: true };
  },
});

/**
 * A person picks an option of the assessor's decision (FB-32), once per report. The option's fixed action runs as that
 * person — `hand_off` asks the person to approve the development handoff (FB-24) with the option's label as the note,
 * the others set the report's status — and the card then shows who picked what. The assessor's words never choose the
 * action, and nobody's turn is started by the click itself.
 */
export const decideFeedbackReport = defineCommand({
  name: 'feedback.decide',
  schema: z.object({
    reportId: FeedbackReportId,
    option: z
      .number()
      .int()
      .min(0)
      .max(FEEDBACK_DECISION_OPTIONS_MAX - 1),
  }),
  async apply(tx, ctx, input) {
    const row = await burrowReport(tx, ctx, input.reportId);
    if (ctx.actor.kind !== 'person') throw forbidden('Only people decide what happens with a report.');
    const decision = row.assessmentState === 'done' ? row.conclusion?.decision : null;
    if (!decision) throw conflict('This assessment has nothing to decide.');
    if (row.decided) {
      const who = await loadPrincipalRow(tx, row.decided.decidedById);
      throw conflict(`${who?.shortName ?? 'Someone'} already chose “${row.decided.label}”.`);
    }
    const picked = decision.options[input.option];
    if (!picked)
      throw new ApiError('validation_failed', 'Choose one of the options.', {
        fields: { option: ['Choose one of the options.'] },
      });
    if (picked.action === 'hand_off')
      await requestHandoff.apply(tx, ctx, { reportId: row.id, note: picked.label });
    else
      await setFeedbackReportStatus.apply(tx, ctx, {
        reportId: row.id,
        status: FEEDBACK_DECISION_STATUS[picked.action],
      });
    await tx
      .update(feedbackReports)
      .set({
        decided: {
          option: input.option,
          label: picked.label,
          action: picked.action,
          decidedById: ctx.actor.id,
          decidedAt: ctx.at,
        },
        updatedAt: ctx.now,
      })
      .where(eq(feedbackReports.id, row.id));
    const event = await ctx.emit({
      type: 'feedback.report_decided',
      kind: 'System',
      text: null,
      where: await whereOf(tx, row.conversationId),
      payload: { reportId: row.id, reference: row.reference, option: input.option, action: picked.action },
    });
    await reportChanged(ctx, [row.rootMessageId], event.id);
    return { reportId: row.id };
  },
});

export const REPORT_COMMANDS = [setFeedbackReportStatus, redactFeedbackReport, decideFeedbackReport];
