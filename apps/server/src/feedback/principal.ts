/**
 * The burrow's Feedback system principal (docs/decisions/feedback.md FB-14): an agent-shaped principal named
 * “Feedback” (`principals.system = 'feedback'`) that signs report receipt, the report's root message and the
 * assessment queueing. Its signature attests that Whombat received a report and what Whombat did with it, never who
 * the visitor is. Created lazily on first use, like GitHub's (github/actors.ts): one per burrow, not on the
 * roster, no keys, no channels, and never dispatched (`enqueueDispatches` skips system principals).
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { feedbackReports } from '../db/schema/index';
import { burrowSystemPrincipal } from '../domain/system-principals';

/** `principals.system` of the Feedback signer. */
export const SYSTEM_FEEDBACK = 'feedback';

const signer = burrowSystemPrincipal({
  system: SYSTEM_FEEDBACK,
  name: 'Feedback',
  handle: 'feedback',
  doing: 'Receives bug reports and feature requests from the feedback widget.',
  job: 'Receives reports from the feedback widget on your websites and posts each one as a thread.',
  line: { type: 'feedback.system_principal', where: 'Feedback' },
});

/** The burrow's Feedback principal id, if it exists yet. */
export const findFeedbackPrincipal = signer.find;

/** Whether a message id is the root of a feedback report's thread. */
export async function isReportThread(db: Db, rootMessageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: feedbackReports.id })
    .from(feedbackReports)
    .where(eq(feedbackReports.rootMessageId, rootMessageId));
  return !!row;
}

/** Whether a principal row is a Feedback signer. */
export const isFeedbackPrincipal = signer.is;

/** The burrow's Feedback principal, created on first use (lazy, double-checked under the burrow lock). */
export const feedbackPrincipal = signer.ensure;
