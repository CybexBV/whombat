/**
 * The person's two actions on a job handed to T3 Code (docs/decisions/t3code.md T3-38, T3-39): answering the question
 * it waits on (`t3_pending_request` respond) and sending it a message (`t3_thread_send`, `auto` to steer the turn at work
 * or start one, `queue` for its next turn). Each is checked as a page's button is: a person, on a conversation they can
 * read, a job of that conversation, its connection set to Manage. The call goes to T3 Code first, then one commit signs
 * it and watches the thread again from where it was handed over, as the agent's own calls do, so the job's view and the
 * agent's wake follow what it does next. A permission request is never answered here: only T3 Code approves those.
 */
import {
  type ConversationHandoffs,
  type HandoffAnswerBody,
  type HandoffSendBody,
  JOB_RESULT_SENDS_MAX,
  type JobAnswersBody,
  JobResultAnswer,
  jobAnswersMessage,
  type Message,
  topics,
} from '@whombat/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { CatalogConnectionRow } from '../connections/types';
import { catalogConnections, messages, type T3WatchRow, t3Watches } from '../db/schema/index';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { loadMessageRow, loadMessages } from '../read/messages';
import { readableConversation, readableMessage } from '../read/views';
import type { Services } from '../services';
import { callT3, requestIdsOf, requestOf, T3Failure, type T3Request } from '../things/kinds/business/t3code';
import { buttonRefusal } from '../things/kinds/buttons';
import { rec, str } from '../things/words';
import { conversationHandoffs, publishHandoffs } from './handoffs';
import { sendPending } from './result';

/** Who acts: the person, in their burrow. */
export interface JobViewer {
  burrowId: string;
  principal: { id: string; kind: string };
}

/** The job, its watch and its connection, after the checks a page's button has. */
async function jobOf(
  services: Services,
  viewer: JobViewer,
  conversationId: string,
  handoffId: string,
  gone: () => Error = () => notFound('Job'),
): Promise<{ watch: T3WatchRow; connection: CatalogConnectionRow }> {
  if (viewer.principal.kind !== 'person') throw forbidden('Only you can answer or message a job.');
  const conversation = await readableConversation(services.db, viewer.burrowId, conversationId);
  const [row] = await services.db
    .select({ watch: t3Watches, connection: catalogConnections })
    .from(t3Watches)
    .innerJoin(catalogConnections, eq(catalogConnections.id, t3Watches.connectionId))
    .where(
      and(
        eq(t3Watches.burrowId, viewer.burrowId),
        eq(t3Watches.conversationId, conversation.id),
        eq(t3Watches.threadId, handoffId),
        // A council's and a delegation's threads are their cards' (council.md, delegate.md).
        isNull(t3Watches.councilId),
        isNull(t3Watches.delegationTaskId),
      ),
    )
    .limit(1);
  if (!row) throw gone();
  const refusal = buttonRefusal({ row: row.connection });
  if (refusal) throw forbidden(refusal);
  if (row.connection.status !== 'active') throw conflict('T3 Code needs signing in again first.');
  return row;
}

/** T3 Code's refusal in words the person can act on. */
function refused(err: unknown): Error {
  if (err instanceof T3Failure) return conflict('T3 Code didn’t take it. Look at the job in T3 Code.');
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Watches the thread again from where it was handed over, as the agent's own calls do: new work, so the run is read
 * again and the job's track goes on unless its job was over. Who it wakes and its result message stay.
 */
async function rearm(ctx: ApplyContext, connectionId: string, threadId: string, wakes?: true) {
  return ctx.tx
    .update(t3Watches)
    .set({
      state: 'watching',
      armedAt: ctx.now,
      status: null,
      pending: null,
      asks: null,
      steps: null,
      prs: null,
      runStartedAt: null,
      runEndedAt: null,
      progress: sql`case when ${t3Watches.state} = 'idle' then null else ${t3Watches.progress} end`,
      ...(wakes ? { wakes } : {}),
    })
    .where(
      and(
        eq(t3Watches.burrowId, ctx.burrow.id),
        eq(t3Watches.connectionId, connectionId),
        eq(t3Watches.threadId, threadId),
      ),
    )
    .returning({ conversationId: t3Watches.conversationId });
}

/** Signs the person's answer or message and watches the thread again from where it was handed over. */
export const jobMessaged = defineCommand({
  name: 't3code.job_message',
  schema: z.object({
    connectionId: z.string().min(1).max(64),
    threadId: z.string().min(1).max(300),
    what: z.enum(['answer', 'steer', 'queue']),
  }),
  async apply(_tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can answer or message a job.');
    const rows = await rearm(ctx, input.connectionId, input.threadId);
    const conversationId = rows[0]?.conversationId;
    if (!conversationId) throw notFound('Job');
    await ctx.emit({
      type: 'job.messaged',
      kind: 'System',
      text: null,
      where: null,
      payload: { connectionId: input.connectionId, what: input.what },
    });
    return { conversationId };
  },
});

/**
 * What answers the request: each question it names is one of the request's, an option's label where the question
 * offers options (several only where it allows many), else the person's own words.
 */
export function checkedAnswers(
  request: T3Request,
  answers: HandoffAnswerBody['answers'],
): Record<string, string | string[]> | null {
  const out: Record<string, string | string[]> = {};
  for (const [id, value] of Object.entries(answers)) {
    const q = request.questions.find((x) => x.id === id);
    if (!q) return null;
    const labels = q.options.map((o) => o.label);
    const picked = Array.isArray(value) ? value : [value];
    if (picked.length > 1 && !q.multiSelect) return null;
    if (labels.length && picked.some((v) => !labels.includes(v))) return null;
    out[id] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** `conversations.handoffAnswer`: answers the question the job waits on, read again first. */
export async function answerJob(
  services: Services,
  viewer: JobViewer,
  conversationId: string,
  body: HandoffAnswerBody,
): Promise<ConversationHandoffs> {
  const { watch, connection } = await jobOf(services, viewer, conversationId, body.handoffId);
  const call = (tool: string, args: Record<string, unknown>, label?: 'things.action') =>
    callT3(services, connection, tool, args, label);
  try {
    // Someone may have answered in T3 Code meanwhile, or the agent may have.
    const ids = requestIdsOf(await call('t3_pending_request', { action: 'list', threadId: watch.threadId }));
    if (!ids.includes(body.requestId)) throw conflict('That question was answered already.');
    const request = requestOf(
      await call('t3_pending_request', {
        action: 'read',
        threadId: watch.threadId,
        requestId: body.requestId,
      }),
      watch.threadId,
    );
    const answers = request ? checkedAnswers(request, body.answers) : null;
    if (!answers) throw conflict('That question changed in T3 Code. Look again.');
    await call(
      't3_pending_request',
      { action: 'respond', threadId: watch.threadId, requestId: body.requestId, answers },
      'things.action',
    );
  } catch (err) {
    throw refused(err);
  }
  return signed(services, viewer, watch, 'answer');
}

/** `conversations.handoffSend`: the person's message to the job, steering it now or queued for its next turn. */
export async function messageJob(
  services: Services,
  viewer: JobViewer,
  conversationId: string,
  body: HandoffSendBody,
): Promise<ConversationHandoffs> {
  const text = body.text.trim();
  if (!text) throw badRequest('Write something to send.');
  const { watch, connection } = await jobOf(services, viewer, conversationId, body.handoffId);
  try {
    const sent = await callT3(
      services,
      connection,
      't3_thread_send',
      { threadId: watch.threadId, message: text, mode: body.mode === 'steer' ? 'auto' : 'queue' },
      'things.action',
    );
    if (str(rec(sent).status) === 'rejected')
      throw conflict('T3 Code didn’t take it. Look at the job in T3 Code.');
  } catch (err) {
    throw refused(err);
  }
  return signed(services, viewer, watch, body.mode);
}

async function signed(
  services: Services,
  viewer: JobViewer,
  watch: T3WatchRow,
  what: 'answer' | 'steer' | 'queue',
): Promise<ConversationHandoffs> {
  await services.pipeline.commit(
    jobMessaged,
    { connectionId: watch.connectionId, threadId: watch.threadId, what },
    { burrowId: viewer.burrowId, actorId: viewer.principal.id },
  );
  // Whoever else has the conversation open sees it at once (T3-25).
  await publishHandoffs(services, viewer.burrowId, watch.conversationId);
  return {
    conversationId: watch.conversationId,
    handoffs: await conversationHandoffs(
      services.db,
      viewer.burrowId,
      watch.conversationId,
      services.clock(),
    ),
  };
}

/**
 * Records the person's answers to a result message's open points, sent to T3 Code together: a sending of the message
 * that waits for the run they started (its end updates the message, `result.ts`), and the thread watched again, waking
 * the agent when it ends.
 */
export const jobAnswered = defineCommand({
  name: 't3code.job_answers',
  schema: z.object({
    messageId: z.string().min(1).max(64),
    connectionId: z.string().min(1).max(64),
    threadId: z.string().min(1).max(300),
    answers: z.array(JobResultAnswer).min(1),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can answer a job’s report.');
    const [row] = await tx.select().from(messages).where(eq(messages.id, input.messageId)).for('update');
    if (!row || row.burrowId !== ctx.burrow.id || row.deletedAt || !row.jobResult) throw notFound('Message');
    const sends = [
      ...row.jobResult.sends,
      { at: ctx.now.toISOString(), answers: input.answers, doneAt: null, outcome: null },
    ].slice(-JOB_RESULT_SENDS_MAX);
    const [updated] = await tx
      .update(messages)
      .set({ jobResult: { ...row.jobResult, sends } })
      .where(eq(messages.id, row.id))
      .returning();
    const watched = await rearm(ctx, input.connectionId, input.threadId, true);
    if (!watched.length) throw conflict('This job is no longer followed. Open it in T3 Code.');
    for (const message of await loadMessages(tx, updated ? [updated] : [], null))
      ctx.publish(topics.conversation(message.conversationId), { type: 'message.updated', message });
    await ctx.emit({
      type: 'job.answered',
      kind: 'System',
      text: null,
      where: null,
      payload: { connectionId: input.connectionId, messageId: row.id, count: input.answers.length },
    });
    return { conversationId: row.conversationId };
  },
});

/**
 * `messages.jobAnswers`: the person's answers to what a job's result message left for them, sent to its T3 Code thread
 * in one message (starting a run when none is at work), then recorded on the message. One sending at a time.
 */
export async function answerJobReport(
  services: Services,
  viewer: JobViewer,
  messageId: string,
  body: JobAnswersBody,
): Promise<{ message: Message }> {
  if (viewer.principal.kind !== 'person') throw forbidden('Only you can answer a job’s report.');
  const row = await readableMessage(services.db, viewer.burrowId, messageId);
  // Only a conversation the person can read.
  await readableConversation(services.db, viewer.burrowId, row.conversationId);
  if (row.deletedAt || !row.jobResult) throw notFound('Message');
  if (sendPending(row.jobResult)) throw conflict('T3 Code is still working on your earlier answers.');
  const { watch, connection } = await jobOf(
    services,
    viewer,
    row.conversationId,
    row.jobResult.handoffId,
    () => conflict('This job is no longer followed. Open it in T3 Code.'),
  );
  try {
    const sent = await callT3(
      services,
      connection,
      't3_thread_send',
      { threadId: watch.threadId, message: jobAnswersMessage(body.answers), mode: 'auto' },
      'things.action',
    );
    if (str(rec(sent).status) === 'rejected')
      throw conflict('T3 Code didn’t take it. Look at the job in T3 Code.');
  } catch (err) {
    throw refused(err);
  }
  await services.pipeline.commit(
    jobAnswered,
    { messageId: row.id, connectionId: watch.connectionId, threadId: watch.threadId, answers: body.answers },
    { burrowId: viewer.burrowId, actorId: viewer.principal.id },
  );
  await publishHandoffs(services, viewer.burrowId, watch.conversationId);
  const now = await loadMessageRow(services.db, row.id);
  const [message] = await loadMessages(services.db, now ? [now] : [], viewer.principal.id);
  if (!message) throw notFound('Message');
  return { message };
}
