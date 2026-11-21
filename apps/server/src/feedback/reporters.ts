import type { FeedbackAssessment } from '@whombat/core';
import { type ReporterStatus, reporterStatusOf } from '@whombat/core/feedback/reporters';
import { and, inArray, isNotNull } from 'drizzle-orm';
import type { TxSession } from '../commit/types';
import { feedbackReports } from '../db/schema/index';
import { republishRootMessages } from './messages';

const HOUR_MS = 3_600_000;
/** The reported site's host, as the text email names it (`reporterCodeEmail`). */
const _hostOf = (origin: string) => origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
const DAY_MS = 24 * HOUR_MS;
/** Codes per integration and address in 24 hours, on top of the hourly 5 (FR-13): slow guessing stays slow. */
/** A reporter with no live session and no reports is removed this long after it was made (FR-17). */
const _REPORTER_IDLE_MS = 30 * DAY_MS;
/** What a missing code is compared with, so a sign-in costs the same whether or not one is open (FR-16). */

// --- Status ---------------------------------------------------------------------------------------

type StatusRow = {
  status: string;
  assessmentState: string;
  assessment: FeedbackAssessment | null;
};

/** What the reporter sees of a report (`reporterStatusOf`): never the internal status or the assessment itself. */
export function reporterStatusOfRow(row: StatusRow): ReporterStatus {
  return reporterStatusOf({
    status: row.status,
    assessmentState: row.assessmentState,
    assessmentOutcome: row.assessment?.outcome ?? null,
  });
}

/** When a report last changed in a way its reporter's status can show: its own change or its assessment's. */
export function reporterUpdatedAt(row: { updatedAt: Date; assessmentUpdatedAt: Date }): Date {
  return row.updatedAt > row.assessmentUpdatedAt ? row.updatedAt : row.assessmentUpdatedAt;
}

/**
 * A report changed (FR-10): its root message is republished (the card resolves live), and on a managed Whombat each
 * of those reports that has a reporter is marked for publishing to control in the same transaction; the publisher is
 * nudged after the commit. Ids that aren't a report's root message (the assessor's posts) are only republished.
 */
export async function reportChanged(
  session: Pick<TxSession, 'tx' | 'publish' | 'services' | 'after'>,
  messageIds: readonly string[],
  eventId: string | null = null,
): Promise<void> {
  // The assessor's reply carries the `assessment` card, which shows the report's status and decision (FB-32).
  const assessed = messageIds.length
    ? await session.tx
        .select({ id: feedbackReports.assessmentMessageId })
        .from(feedbackReports)
        .where(
          and(
            inArray(feedbackReports.rootMessageId, [...new Set(messageIds)]),
            isNotNull(feedbackReports.assessmentMessageId),
          ),
        )
    : [];
  await republishRootMessages(
    session,
    [...messageIds, ...assessed.flatMap((r) => (r.id ? [r.id] : []))],
    eventId,
  );
  if (messageIds.length === 0) return;
  const marked = await session.tx
    .update(feedbackReports)
    .set({ reporterDirty: true })
    .where(
      and(
        inArray(feedbackReports.rootMessageId, [...new Set(messageIds)]),
        isNotNull(feedbackReports.reporterId),
      ),
    )
    .returning({ id: feedbackReports.id });
  if (marked.length) {
    const feedback = session.services.feedback;
    session.after(async () => feedback.reportersChanged());
  }
}
