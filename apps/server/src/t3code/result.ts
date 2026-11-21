/**
 * A job's result as a message (docs/decisions/t3code.md): when a job handed to T3 Code from a person's thread truly
 * ends, Whombat puts T3 Code's last answer in that thread itself, in the assistant's name, marked `Message.jobResult`,
 * so the person reads the report in T3 Code's own words and the agent doesn't retell it.
 *
 * A report is never lost to a later run's words. The next end of the same job takes the message's place only when it
 * goes on with the same work: the run that carried out the person's answers on it (T3 Code writes its whole report
 * again), or a run T3 Code started by itself when a command the thread left running ended, while the message is still
 * the thread's latest word. A run someone asked for since (the person in T3 Code, the agent) and a run that was stopped
 * or failed get a message of their own. Runs inside the wake's commit (`t3ThreadMoved`).
 */
import { JOB_REPORT_MAX, type JobResult, type JobResultSend, messageTextFits, topics } from '@whombat/core';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { ApplyContext } from '../commit/types';
import { messages, type T3WatchRow } from '../db/schema/index';
import { unlinkLocalPaths } from '../domain/local-links';
import { refreshMessageNotifications } from '../domain/message-edits';
import { notifyForMessage } from '../domain/message-notify';
import { postMessage } from '../domain/messages';
import { indexMessage } from '../domain/search-index';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow, loadMessages, type MessageRow } from '../read/messages';
import { progressOf } from './progress';

/** What the watcher read of the run that ended: its report (null: it wrote none) and the facts beside it. */
export interface JobReport {
  text: string | null;
  jobResult: Omit<JobResult, 'sends'>;
}

/** The result message's words when the run left no report. A completed run without one gets no message. */
export const NO_REPORT_WORDS = {
  failed: 'T3 Code ran into a problem before it wrote a report.',
  stopped: 'T3 Code was stopped before it wrote a report.',
} as const;

/** The report as a result message keeps it: its start, up to `JOB_REPORT_MAX`, and whether it was longer. */
export function reportOf(answer: string | null): { text: string | null; cut: boolean } {
  const said = answer?.trim();
  if (!said) return { text: null, cut: false };
  if (said.length <= JOB_REPORT_MAX) return { text: said, cut: false };
  return { text: said.slice(0, JOB_REPORT_MAX).trimEnd(), cut: true };
}

/** The person's answers on the message started the run that is ending: the last sending isn't done yet. */
export const sendPending = (result: JobResult | null | undefined) => result?.sends.at(-1)?.doneAt === null;

/** The sendings after the run ended: the one it carried out marked done, with how the run ended. */
function sendsAfter(result: JobResult, ended: Omit<JobResult, 'sends'>): JobResultSend[] {
  const last = result.sends.at(-1);
  if (!last || last.doneAt !== null) return result.sends;
  return [...result.sends.slice(0, -1), { ...last, doneAt: ended.endedAt, outcome: ended.outcome }];
}

/** Whether anything was written in the message's Whombat thread after it. */
async function writtenAfter(ctx: ApplyContext, m: MessageRow): Promise<boolean> {
  const [later] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, m.conversationId),
        gt(messages.ord, m.ord),
        isNull(messages.deletedAt),
        m.threadRootId
          ? eq(messages.threadRootId, m.threadRootId)
          : or(isNull(messages.threadRootId), eq(messages.threadRootId, m.id)),
      ),
    )
    .limit(1);
  return !!later;
}

/**
 * Posts the job's result in the watch's thread, or updates the one it posted before (see the file's comment). Returns
 * the message's id, or null when there is nothing to post (a completed run that wrote no report).
 */
export async function postJobResult(
  ctx: ApplyContext,
  watch: T3WatchRow,
  report: JobReport,
  title: string,
): Promise<string | null> {
  const outcome = report.jobResult.outcome;
  const known = watch.resultMessageId ? await loadMessageRow(ctx.tx, watch.resultMessageId) : undefined;
  const was =
    known &&
    !known.deletedAt &&
    known.burrowId === ctx.burrow.id &&
    known.conversationId === watch.conversationId
      ? known.jobResult
      : null;
  if (known && was && sendPending(was)) {
    // The person's answers on the message started the run: its report is the whole one again. A run that didn't
    // complete wrote none, so the report stays as it was and only the sending says how it ended.
    if (outcome === 'completed') return updateInPlace(ctx, known, was, report, title);
    return answersEnded(ctx, known, was, report.jobResult);
  }
  const goesOn =
    known &&
    was &&
    outcome === 'completed' &&
    !progressOf(watch.progress).asked &&
    !(await writtenAfter(ctx, known));
  if (known && was && goesOn) return updateInPlace(ctx, known, was, report, title);

  // A stopped run's last words are where it was cut off, never its report.
  const said = outcome === 'stopped' ? null : report.text;
  const words = said ?? (outcome === 'completed' ? null : NO_REPORT_WORDS[outcome]);
  if (!words) return null;
  const conversation = await loadConversationRow(ctx.tx, watch.conversationId);
  if (!conversation) return null;
  // The thread it was handed over from, while it is there; else the top of the conversation.
  const root = watch.threadRootId ? await loadMessageRow(ctx.tx, watch.threadRootId) : undefined;
  const posted = await postMessage(ctx, {
    conversation,
    text: words,
    threadRootId: root && root.conversationId === conversation.id ? root.id : null,
    // A report is news for the person, not a request for the agent: the wake that tells it is the watcher's.
    dispatch: false,
    jobResult: { ...report.jobResult, sends: [] },
  });
  return posted.id;
}

/**
 * The sending the run carried out marked done with how it ended, the report and its facts as they were. Sent as
 * `message.updated`; nobody is notified, as the report didn't change.
 */
async function answersEnded(
  ctx: ApplyContext,
  row: MessageRow,
  was: JobResult,
  ended: Omit<JobResult, 'sends'>,
): Promise<string> {
  const jobResult: JobResult = { ...was, sends: sendsAfter(was, ended) };
  const [updated] = await ctx.tx
    .update(messages)
    .set({ jobResult })
    .where(eq(messages.id, row.id))
    .returning();
  if (!updated) return row.id;
  for (const message of await loadMessages(ctx.tx, [updated], null))
    ctx.publish(topics.conversation(message.conversationId), { type: 'message.updated', message });
  return row.id;
}

/**
 * The same message with the new run's report and facts: its earlier text when the run wrote none, the sending the run
 * carried out marked done. Sent as `message.updated`; `editedAt` stays, as nobody edited it. The person hears once that
 * the report changed: nobody gets a new message for it.
 */
async function updateInPlace(
  ctx: ApplyContext,
  row: MessageRow,
  was: JobResult,
  report: JobReport,
  title: string,
): Promise<string> {
  const typed = report.text ? unlinkLocalPaths(report.text) : row.text;
  const text = messageTextFits(typed) ? typed : row.text;
  const jobResult: JobResult = { ...report.jobResult, sends: sendsAfter(was, report.jobResult) };
  const [updated] = await ctx.tx
    .update(messages)
    .set({ text, jobResult })
    .where(eq(messages.id, row.id))
    .returning();
  if (!updated) return row.id;
  if (text !== row.text) await refreshMessageNotifications(ctx.tx, row.id, text);
  for (const message of await loadMessages(ctx.tx, [updated], null))
    ctx.publish(topics.conversation(message.conversationId), { type: 'message.updated', message });
  const { services } = ctx;
  const burrow = { id: ctx.burrow.id, slug: ctx.burrow.slug };
  ctx.after(async () => {
    await indexMessage(services.db, row.id);
    if (row.threadRootId) await indexMessage(services.db, row.threadRootId);
  });
  ctx.background('job result notice', () =>
    notifyForMessage(services, {
      burrow,
      messageId: row.id,
      again: {
        dedupKey: `job-result:${row.id}:${report.jobResult.endedAt}`,
        at: ctx.now,
        text: `T3 Code updated its report: ${title}`.slice(0, 300),
      },
    }),
  );
  return row.id;
}
