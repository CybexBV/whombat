/**
 * Publishing signed-in reporters' statuses to control (docs/decisions/feedback-reporters.md FR-10; contracts CT-164):
 * a managed Whombat's reporters sign in at control, which answers their “Your reports” from what this runtime
 * publishes through the manager (`feedback.reporters.publish`): each report's reference, type and the reporter's
 * status (`reporterStatusOf`), never its text.
 *
 * `reportChanged` (`../reporters.ts`) marks a report with a reporter `reporter_dirty` in the transaction that changed
 * it; this sends the marked reports in batches of at most `FEEDBACK_REPORTERS_PUBLISH_MAX` and clears each flag only
 * if the row wasn't changed again meanwhile (its `xmin`). A report whose content was removed (by the person or
 * retention) is published as a removal: control forgets it.
 */
import { FEEDBACK_REPORTERS_PUBLISH_MAX } from '@whombat/control-contracts/device';
import type { RuntimeFeedbackReportersRequest } from '@whombat/control-contracts/local';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { feedbackIntegrations, feedbackReports } from '../../db/schema/index';
import type { ManagerPort } from '../../managed/ports';
import type { Services } from '../../services';
import { reporterStatusOfRow, reporterUpdatedAt } from '../reporters';

export interface ReporterBatch {
  updates: number;
  removals: number;
  /** More marked reports than this batch took. */
  more: boolean;
}

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

/** One batch: the oldest marked reports (by id), sent, their flags cleared. Throws the manager's error. */
export async function publishReporterBatch(
  services: Services,
  manager: ManagerPort,
  max: number = FEEDBACK_REPORTERS_PUBLISH_MAX,
): Promise<ReporterBatch> {
  const rows = await services.db
    .select({
      id: feedbackReports.id,
      version: sql<string>`${feedbackReports}.xmin::text`,
      site: feedbackIntegrations.siteId,
      reporterId: feedbackReports.reporterId,
      reference: feedbackReports.reference,
      type: feedbackReports.type,
      status: feedbackReports.status,
      assessmentState: feedbackReports.assessmentState,
      assessment: feedbackReports.assessment,
      createdAt: feedbackReports.createdAt,
      updatedAt: feedbackReports.updatedAt,
      assessmentUpdatedAt: feedbackReports.assessmentUpdatedAt,
      contentRemovedAt: feedbackReports.contentRemovedAt,
    })
    .from(feedbackReports)
    .innerJoin(feedbackIntegrations, eq(feedbackIntegrations.id, feedbackReports.integrationId))
    .where(and(sql`${feedbackReports.reporterDirty}`, isNotNull(feedbackReports.reporterId)))
    .orderBy(asc(feedbackReports.id))
    .limit(max + 1);
  const more = rows.length > max;
  const batch = rows.slice(0, max);
  if (batch.length === 0) return { updates: 0, removals: 0, more: false };

  const request: z.input<typeof RuntimeFeedbackReportersRequest> = { updates: [], removals: [] };
  for (const r of batch) {
    if (r.contentRemovedAt) request.removals.push({ site: r.site, reference: r.reference });
    else
      request.updates.push({
        site: r.site,
        reporterId: r.reporterId as string,
        reference: r.reference,
        type: r.type,
        status: reporterStatusOfRow(r),
        receivedAt: seconds(r.createdAt),
        updatedAt: seconds(reporterUpdatedAt(r)),
      });
  }
  await manager.feedbackReporters(request);

  const now = services.clock();
  await services.db.transaction(async (tx) => {
    for (const r of batch)
      await tx
        .update(feedbackReports)
        .set({ reporterDirty: false, reporterPublishedAt: now })
        // Changed again since it was read: it stays marked for the next batch.
        .where(and(eq(feedbackReports.id, r.id), sql`${feedbackReports}.xmin::text = ${r.version}`));
  });
  return { updates: request.updates.length, removals: request.removals.length, more };
}

/** Whether any report waits to be published (the hourly check's catch-up after a restart or a long outage). */
export async function reportersPending(services: Services): Promise<boolean> {
  const [row] = await services.db
    .select({ id: feedbackReports.id })
    .from(feedbackReports)
    .where(sql`${feedbackReports.reporterDirty}`)
    .limit(1);
  return !!row;
}

/**
 * Marks every report with a reporter of these integrations for publishing (FR-10): a site control (re)accepted after
 * holding no card for it lost its reporter entries when the card went (control deletes them with the site).
 */
export async function markIntegrationReporters(
  services: Services,
  integrationIds: readonly string[],
): Promise<number> {
  if (integrationIds.length === 0) return 0;
  const marked = await services.db
    .update(feedbackReports)
    .set({ reporterDirty: true })
    .where(
      and(inArray(feedbackReports.integrationId, [...integrationIds]), isNotNull(feedbackReports.reporterId)),
    )
    .returning({ id: feedbackReports.id });
  return marked.length;
}
