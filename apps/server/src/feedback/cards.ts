/**
 * Resolves stored `{kind: 'report', reportId}` cards into live report cards (docs/decisions/feedback.md FB-16) and
 * `{kind: 'assessment', reportId}` cards into live assessment cards (FB-32).
 */
import { type AssessmentCard, REPORT_CARD_SUMMARY_MAX, type ReportCard } from '@whombat/core';
import { eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { feedbackIntegrations, feedbackReports } from '../db/schema/index';
import { iso } from '../lib/time';

/** Plain one-line summary of a report's description for its card. */
export function reportSummary(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  return flat.length > REPORT_CARD_SUMMARY_MAX ? `${flat.slice(0, REPORT_CARD_SUMMARY_MAX - 1)}…` : flat;
}

export async function loadReportCards(
  db: Db | Tx,
  reportIds: readonly string[],
): Promise<Map<string, ReportCard>> {
  const out = new Map<string, ReportCard>();
  if (reportIds.length === 0) return out;
  const rows = await db
    .select({ report: feedbackReports, settings: feedbackIntegrations.settings })
    .from(feedbackReports)
    .innerJoin(feedbackIntegrations, eq(feedbackIntegrations.id, feedbackReports.integrationId))
    .where(inArray(feedbackReports.id, [...new Set(reportIds)]));
  for (const { report: r, settings } of rows) {
    const removed = r.contentRemovedAt !== null;
    out.set(r.id, {
      kind: 'report',
      reportId: r.id,
      reference: r.reference,
      product: settings.productLabel,
      type: r.type,
      summary: removed ? '' : reportSummary(r.description),
      submittedAt: iso(r.createdAt),
      status: r.status,
      assessment: {
        state: r.assessmentState,
        outcome: r.assessmentState === 'done' ? (r.assessment?.outcome ?? null) : null,
        // Once the content is removed the assessor's words are gone too (FB-F3-11).
        summary: r.assessmentState === 'done' && !removed ? (r.assessment?.summary ?? null) : null,
      },
      attachments: removed ? 0 : r.attachmentIds.length,
      contentRemoved: removed,
    });
  }
  return out;
}

/**
 * Resolves stored `{kind: 'assessment', reportId}` cards into live assessment cards (FB-32): the assessment, the
 * verdict, the decision and the option picked, as the report holds them now. A report without an assessment or a
 * conclusion (recorded before FB-32) resolves to nothing, so the message's own text stands alone.
 */
export async function loadAssessmentCards(
  db: Db | Tx,
  reportIds: readonly string[],
): Promise<Map<string, AssessmentCard>> {
  const out = new Map<string, AssessmentCard>();
  if (reportIds.length === 0) return out;
  const rows = await db
    .select()
    .from(feedbackReports)
    .where(inArray(feedbackReports.id, [...new Set(reportIds)]));
  for (const r of rows) {
    if (r.assessmentState !== 'done' || !r.assessment || !r.conclusion) continue;
    out.set(r.id, {
      kind: 'assessment',
      reportId: r.id,
      reference: r.reference,
      type: r.type,
      status: r.status,
      assessment: r.assessment,
      bugVerdict: r.conclusion.bugVerdict,
      decision: r.conclusion.decision,
      decided: r.decided ?? null,
      contentRemoved: r.contentRemovedAt !== null,
    });
  }
  return out;
}
