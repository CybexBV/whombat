/**
 * Tracker feature requests put to the person (docs/decisions/report-trackers.md TA-41…TA-48): a `tracker_decision` step
 * keeps the agent's value, why and its two drafts in `feature_requests` and posts a `feature_request` card in the
 * run's thread (`openFeatureRequest`); the person answers it (`tracker.decide`): approve, approve and build, decline with
 * a reason, or ask the customer. Their answer settles the step, and the run goes on to tell the customer through its
 * `tracker_reply` step (the agent words the person's own reason or question first). A newer request for the same report
 * replaces a waiting one; a run that stops leaves its request stopped, and so does a report closed in its tracker.
 */
import {
  type AutomationAssessment,
  chatHref,
  chatThreadHref,
  FEATURE_DECLINE_REASON_MAX,
  FeatureDecisionChoice,
  type FeatureRequestView,
  featureDecisionStatus,
  featureRequestOutcome,
  featureValueText,
  type JsonObject,
  type NeedsYouItem,
  newId,
  topics,
} from '@whombat/core';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BurrowAccess } from '../auth/request';
import { outsidersRun } from '../automations/runs';
import { type AutomationRunRow, activeRunCount, publishRun } from '../automations/store';
import { roomByKey } from '../chats/rooms';
import { type ApplyContext, defineCommand, type TxSession } from '../commit/types';
import type { Db, Tx } from '../db/client';
import {
  automationRunSteps,
  automationRuns,
  conversations,
  featureRequests,
  trackerItems,
} from '../db/schema/index';
import { linkOfMessage } from '../domain/links';
import { postMessage } from '../domain/messages';
import { notify } from '../domain/notify';
import { threadPushGroup } from '../domain/push-preview';
import { thePerson } from '../domain/the-person';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow, loadMessages } from '../read/messages';
import { loadPrincipalRow, shortName } from '../read/principals';
import type { Services } from '../services';
import { featureRequestView } from './feature-views';
import { isTrackerPrincipal } from './principal';

type RequestRow = typeof featureRequests.$inferSelect;

/** Re-sends the cards of these requests to their conversations: the card resolves on read, so it says what is now. */
export async function republishFeatureCards(
  session: Pick<TxSession, 'tx' | 'publish'>,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const rows = await session.tx
    .select({ messageId: featureRequests.messageId })
    .from(featureRequests)
    .where(inArray(featureRequests.id, [...ids]));
  for (const { messageId } of rows) {
    const message = messageId ? await loadMessageRow(session.tx, messageId) : undefined;
    if (!message) continue;
    const [loaded] = await loadMessages(session.tx, [message], null);
    if (loaded)
      session.publish(topics.conversation(message.conversationId), {
        type: 'message.updated',
        message: loaded,
      });
  }
}

/** “approved by John on 31 October”: what an earlier decision was, for a step that won't ask again (TA-47). */
function decidedWords(row: RequestRow, decider: string | null): string {
  const what = row.choice === 'decline' ? 'declined' : 'approved';
  const at = row.decidedAt ?? row.updatedAt;
  const day = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
  return `${what}${decider ? ` by ${decider}` : ''} on ${day}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The latest request of a report the person approved or declined (TA-47), or null. */
export async function decidedRequest(
  db: Db | Tx,
  connectionId: string,
  reportId: string,
): Promise<RequestRow | null> {
  const [row] = await db
    .select()
    .from(featureRequests)
    .where(
      and(
        eq(featureRequests.connectionId, connectionId),
        eq(featureRequests.reportId, reportId),
        eq(featureRequests.state, 'decided'),
        inArray(featureRequests.choice, ['approve', 'build', 'decline']),
      ),
    )
    .orderBy(desc(featureRequests.decidedAt))
    .limit(1);
  return row ?? null;
}

/** Why a decision step doesn't ask again (TA-47): “Already decided: approved by John on 31 October.” */
export async function alreadyDecided(db: Db | Tx, row: RequestRow): Promise<string> {
  const decider = row.decidedById ? await loadPrincipalRow(db, row.decidedById) : null;
  return `Already decided: ${decidedWords(row, decider ? shortName(decider) : null)}.`;
}

/**
 * What a customer's later message's `trigger.text` says about the decision on their report (TA-47), so the agent's
 * answer agrees with it: “The team decided on 31 October to build it.” / “… not to build it: “…””. Null without one.
 */
export async function decisionNote(
  db: Db | Tx,
  connectionId: string,
  reportId: string,
): Promise<string | null> {
  const row = await decidedRequest(db, connectionId, reportId);
  if (!row) return null;
  const at = row.decidedAt ?? row.updatedAt;
  const day = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
  if (row.choice === 'decline') {
    const reason = (row.note ?? row.declineReason).trim();
    return `The team decided on ${day} not to build it${reason ? `: “${reason}”` : ''}.`;
  }
  return `The team decided on ${day} to build it${row.choice === 'build' ? ', and it is being built' : ''}.`;
}

/** A report in one of these is finished: its feature request isn't decided any more (TA-54). */
const CLOSED_STATUSES = ['closed', 'duplicate', 'not_planned', 'confirmed'];

/**
 * The waiting requests of the same report in other runs (TA-44), replaced by a newer one: their card says so, and
 * their step is skipped so their run ends by itself (its later steps find no decision).
 */
export async function replaceWaitingRequests(
  ctx: ApplyContext,
  connectionId: string,
  reportId: string,
  runId: string,
  reason = 'A newer assessment of this report replaced it.',
): Promise<void> {
  const tx = ctx.tx;
  const rows = await tx
    .select()
    .from(featureRequests)
    .where(
      and(
        eq(featureRequests.connectionId, connectionId),
        eq(featureRequests.reportId, reportId),
        eq(featureRequests.state, 'waiting'),
        ne(featureRequests.runId, runId),
      ),
    );
  if (!rows.length) return;
  for (const row of rows) {
    // A closed report's card stops with why (TA-63); otherwise a newer assessment replaced it.
    await tx
      .update(featureRequests)
      .set(
        reason === REPORT_CLOSED
          ? { state: 'stopped', note: REPORT_CLOSED, updatedAt: ctx.now }
          : { state: 'replaced', updatedAt: ctx.now },
      )
      .where(eq(featureRequests.id, row.id));
    const [step] = await tx
      .update(automationRunSteps)
      .set({
        state: 'skipped',
        finishedAt: ctx.now,
        inputSummary: reason,
        output: { requestId: row.id, decided: false, reason },
        updatedAt: ctx.now,
      })
      .where(
        and(
          eq(automationRunSteps.runId, row.runId),
          eq(automationRunSteps.stepId, row.stepId),
          eq(automationRunSteps.state, 'waiting'),
        ),
      )
      .returning({ runId: automationRunSteps.runId });
    if (step)
      await tx
        .update(automationRuns)
        .set({ status: 'running', updatedAt: ctx.now })
        .where(and(eq(automationRuns.id, row.runId), eq(automationRuns.status, 'waiting')));
    await publishRun(ctx, row.runId);
  }
  await republishFeatureCards(
    ctx,
    rows.map((r) => r.id),
  );
  const services = ctx.services;
  ctx.after(async () => services.automations.nudge());
}

/** A run that stopped leaves its waiting requests stopped (TA-44): their card says it no longer waits. */
export async function stopRunRequests(ctx: ApplyContext, runId: string): Promise<void> {
  const rows = await ctx.tx
    .update(featureRequests)
    .set({ state: 'stopped', updatedAt: ctx.now })
    .where(and(eq(featureRequests.runId, runId), eq(featureRequests.state, 'waiting')))
    .returning({ id: featureRequests.id });
  await republishFeatureCards(
    ctx,
    rows.map((r) => r.id),
  );
}

/** Why a request whose report was closed in its tracker no longer waits: on its card, its step and its run. */
export const REPORT_CLOSED = 'The report was closed.';
/** Requests one poll ends at most; the rest the next time. */
const CLOSED_PER_POLL = 50;

/**
 * The waiting requests of a connection whose report is closed as the poller last saw it: someone closed it in
 * the tracker, or the customer confirmed it. Oldest first, at most `CLOSED_PER_POLL`.
 */
export async function closedReportRequests(db: Db | Tx, connectionId: string): Promise<string[]> {
  const rows = await db
    .select({ id: featureRequests.id })
    .from(featureRequests)
    .innerJoin(
      trackerItems,
      and(
        eq(trackerItems.connectionId, featureRequests.connectionId),
        eq(trackerItems.externalId, featureRequests.reportId),
      ),
    )
    .where(
      and(
        eq(featureRequests.connectionId, connectionId),
        eq(featureRequests.state, 'waiting'),
        inArray(sql`coalesce(${trackerItems.seenStatus}, ${trackerItems.status})`, CLOSED_STATUSES),
      ),
    )
    .orderBy(asc(featureRequests.createdAt))
    .limit(CLOSED_PER_POLL);
  return rows.map((r) => r.id);
}

/**
 * `tracker.feature_requests_closed` (the burrow's tracker principal): the poller saw these requests' reports closed
 * in their tracker, so no answer can be given any more (`tracker.decide` refuses one). Each request stops with why
 * (`note`, which its card shows), its waiting step is skipped with the same words and its run goes on, so the run ends
 * by itself (its later steps find no decision). The run is locked first, as `tracker.decide` locks it, so an answer
 * given at the same moment either lands first or finds the card ended. A request that no longer waits, or whose report
 * is open again, is left as it is. Answers how many it ended.
 */
export const endClosedReportRequests = defineCommand({
  name: 'tracker.feature_requests_closed',
  schema: z.object({
    connectionId: z.string(),
    requestIds: z.array(z.string().min(1).max(80)).min(1).max(CLOSED_PER_POLL),
  }),
  async apply(tx, ctx, input): Promise<{ ended: number }> {
    if (!isTrackerPrincipal(await loadPrincipalRow(tx, ctx.actor.id)))
      throw forbidden('Only Whombat’s tracker signer ends a feature request for a closed report.');
    const ended: string[] = [];
    for (const id of input.requestIds) {
      const [found] = await tx.select().from(featureRequests).where(eq(featureRequests.id, id));
      if (
        !found ||
        found.burrowId !== ctx.burrow.id ||
        found.connectionId !== input.connectionId ||
        found.state !== 'waiting'
      )
        continue;
      await tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(eq(automationRuns.id, found.runId))
        .for('update');
      const [report] = await tx
        .select({ status: trackerItems.status, seen: trackerItems.seenStatus })
        .from(trackerItems)
        .where(
          and(eq(trackerItems.connectionId, found.connectionId), eq(trackerItems.externalId, found.reportId)),
        );
      if (!report || !CLOSED_STATUSES.includes(report.seen ?? report.status)) continue;
      const [stopped] = await tx
        .update(featureRequests)
        .set({ state: 'stopped', note: REPORT_CLOSED, updatedAt: ctx.now })
        .where(and(eq(featureRequests.id, id), eq(featureRequests.state, 'waiting')))
        .returning({ id: featureRequests.id });
      if (!stopped) continue;
      const [step] = await tx
        .update(automationRunSteps)
        .set({
          state: 'skipped',
          finishedAt: ctx.now,
          inputSummary: REPORT_CLOSED,
          output: { requestId: id, decided: false, reason: REPORT_CLOSED },
          updatedAt: ctx.now,
        })
        .where(
          and(
            eq(automationRunSteps.runId, found.runId),
            eq(automationRunSteps.stepId, found.stepId),
            eq(automationRunSteps.attempt, found.attempt),
            eq(automationRunSteps.state, 'waiting'),
          ),
        )
        .returning({ runId: automationRunSteps.runId });
      if (step)
        await tx
          .update(automationRuns)
          .set({ status: 'running', updatedAt: ctx.now })
          .where(and(eq(automationRuns.id, found.runId), eq(automationRuns.status, 'waiting')));
      await publishRun(ctx, found.runId);
      ended.push(id);
    }
    if (!ended.length) return { ended: 0 };
    await republishFeatureCards(ctx, ended);
    const services = ctx.services;
    ctx.after(async () => services.automations.nudge());
    return { ended: ended.length };
  },
});

/** What a request is opened with: the run's step, the report and the agent's assessment. */
export interface OpenRequest {
  run: AutomationRunRow;
  stepId: string;
  attempt: number;
  connection: { id: string; label: string };
  reportId: string;
  number: number;
  title: string;
  organization: string | null;
  assessment: AutomationAssessment;
  agent: string;
  signature: string;
  canBuild: boolean;
}

/** The card's own text, for an app that doesn't know the card and for the notification. */
function cardText(row: Pick<RequestRow, 'title' | 'organization' | 'value'>): string {
  const from = row.organization ? ` from ${row.organization}` : '';
  return `Feature request${from}: “${row.title}” · ${featureValueText(row.value)}. Approve it, decline it or ask the customer here.`;
}

/**
 * Opens a request (TA-44): the row, the card in the run's thread (as the automation; the person hears through the
 * notification, not the message), a signed event of ids only, and a notification after the commit.
 */
export async function openFeatureRequest(ctx: ApplyContext, args: OpenRequest): Promise<RequestRow> {
  const tx = ctx.tx;
  const { run, assessment: a } = args;
  const conversation = await loadConversationRow(tx, run.conversationId);
  if (!conversation) throw notFound('Conversation');
  const id = newId('featureRequest');
  const [row] = await tx
    .insert(featureRequests)
    .values({
      id,
      burrowId: run.burrowId,
      runId: run.id,
      stepId: args.stepId,
      attempt: args.attempt,
      automationId: run.automationId,
      connectionId: args.connection.id,
      connection: args.connection.label.slice(0, 80),
      reportId: args.reportId,
      number: args.number,
      title: args.title.slice(0, 300),
      organization: args.organization,
      agent: args.agent,
      value: a.value,
      valueWhy: a.valueWhy,
      summary: a.summary,
      importance: a.importance,
      size: a.size,
      approvedReply: a.approvedReply,
      declinedReply: a.declinedReply,
      declineReason: a.declineReason,
      signature: args.signature,
      canBuild: args.canBuild,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  if (!row) throw conflict('The feature request couldn’t be kept.');
  const posted = await postMessage(ctx, {
    conversation,
    text: cardText(row),
    card: { kind: 'feature_request', requestId: id },
    threadRootId: run.threadRootId,
    // The card's words are the report's: an `@Name` in its title mentions no one, and nobody is woken.
    mentions: [],
    dispatch: false,
    // The person hears through the notification below, once.
    notifyDmPerson: false,
    outsidersRun: outsidersRun(run.trigger),
  });
  await tx.update(featureRequests).set({ messageId: posted.id }).where(eq(featureRequests.id, id));
  await ctx.emit({
    type: 'tracker.feature_requested',
    kind: 'System',
    // No customer words in a signed event (TA-07): the connection and the number.
    text: `Asked about feature request #${args.number} in ${args.connection.label}`,
    where: args.connection.label,
    payload: { runId: run.id, requestId: id, number: args.number, value: a.value, messageId: posted.id },
  });
  const services = ctx.services;
  const burrow = ctx.burrow;
  const actorId = ctx.actor.id;
  const at = ctx.now;
  ctx.after(async () => {
    const person = await thePerson(services.db, burrow.id);
    const room = await loadConversationRow(services.db, conversation.id);
    const message = await loadMessageRow(services.db, posted.id);
    if (!person || !room || !message) return;
    await notify(services, [
      {
        burrowId: burrow.id,
        burrowSlug: burrow.slug,
        principalId: person.id,
        kind: 'needs_you',
        actorId,
        where: args.connection.label,
        text: cardText(row),
        link: await linkOfMessage(services.db, room, message.id, message.threadRootId),
        messageId: message.id,
        createdAt: at,
        dedupKey: `feature_request:${id}`,
        group: threadPushGroup(room.id, message.threadRootId),
      },
    ]);
  });
  return { ...row, messageId: posted.id };
}

/**
 * What the agent is told to write for the customer when the person gave their own words (TA-46), and the draft that
 * goes as it is otherwise. A decline with the agent's own reason sends its draft; a question always needs words.
 */
export function decisionWords(
  row: Pick<RequestRow, 'approvedReply' | 'declinedReply' | 'declineReason'>,
  choice: FeatureDecisionChoice,
  note: string | null,
): { message: string; needsWords: boolean; instruction: string } {
  switch (choice) {
    case 'approve':
    case 'build': {
      const instruction =
        'it was approved, so it will be built, and the customer hears when it is ready. Write what the customer reads: that, with no date.';
      return row.approvedReply
        ? { message: row.approvedReply, needsWords: false, instruction }
        : { message: '', needsWords: true, instruction };
    }
    case 'decline': {
      const reason = (note ?? row.declineReason).trim();
      const own = !!note && note.trim() !== row.declineReason.trim();
      const instruction = `it won’t be built${reason ? `, for this reason: “${reason}”` : ''}. Write what the customer reads: that it won’t be built and why, kind and short.`;
      return !own && row.declinedReply
        ? { message: row.declinedReply, needsWords: false, instruction }
        : { message: '', needsWords: true, instruction };
    }
    case 'ask':
      return {
        message: '',
        needsWords: true,
        instruction: `before deciding, the team wants to ask the customer: “${(note ?? '').trim()}”. Write that question for the customer, so they can answer it there.`,
      };
  }
}

/**
 * `tracker.decide` (TA-45): the person's answer, in one commit under the run's lock — the request decided, its step
 * settled with what the reply step sends (`message`, else `needsWords` and the agent's `instruction`) and the status
 * it sets, the run going on (or queued while its others fill every place), a signed event of ids, the card re-sent.
 */
export const decideFeature = defineCommand({
  name: 'tracker.decide',
  schema: z.object({
    requestId: z.string().min(1).max(80),
    choice: FeatureDecisionChoice,
    note: z.string().trim().max(FEATURE_DECLINE_REASON_MAX).optional(),
  }),
  async apply(tx, ctx, input): Promise<{ request: FeatureRequestView }> {
    if (ctx.actor.kind !== 'person') throw forbidden('Only people decide on feature requests.');
    const [found] = await tx.select().from(featureRequests).where(eq(featureRequests.id, input.requestId));
    if (!found || found.burrowId !== ctx.burrow.id) throw notFound('Feature request');
    const [run] = await tx
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, found.runId))
      .for('update');
    const [request] = await tx
      .select()
      .from(featureRequests)
      .where(eq(featureRequests.id, input.requestId))
      .for('update');
    if (!run || !request) throw notFound('Feature request');
    if (request.state !== 'waiting')
      throw conflict('This feature request isn’t waiting for an answer any more.');
    // The customer withdrew it, or it was closed meanwhile (TA-54): nothing to build or tell any more.
    const [report] = await tx
      .select({ status: trackerItems.status, seen: trackerItems.seenStatus })
      .from(trackerItems)
      .where(
        and(
          eq(trackerItems.connectionId, request.connectionId),
          eq(trackerItems.externalId, request.reportId),
        ),
      );
    if (report && CLOSED_STATUSES.includes(report.seen ?? report.status))
      throw conflict('This report was closed, so there is nothing to decide any more.');
    if (input.choice === 'build' && !request.canBuild)
      throw badRequest('This automation doesn’t build what you approve: approve it instead.');
    const note = input.note?.trim() || null;
    if (input.choice === 'ask' && !note) throw badRequest('Write what you want to ask the customer.');
    const [step] = await tx
      .select()
      .from(automationRunSteps)
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.stepId, request.stepId)));
    if (
      step?.state !== 'waiting' ||
      step.attempt !== request.attempt ||
      !['waiting', 'running'].includes(run.status)
    )
      throw conflict('This automation run isn’t waiting for this answer any more.');
    const words = decisionWords(
      request,
      input.choice,
      input.choice === 'approve' || input.choice === 'build' ? null : note,
    );
    const status = featureDecisionStatus(input.choice);
    const kept = input.choice === 'decline' && note && note === request.declineReason.trim() ? null : note;
    const decided = (
      await tx
        .update(featureRequests)
        .set({
          state: 'decided',
          choice: input.choice,
          note: input.choice === 'approve' || input.choice === 'build' ? null : kept,
          decidedById: ctx.actor.id,
          decidedAt: ctx.now,
          updatedAt: ctx.now,
        })
        .where(eq(featureRequests.id, request.id))
        .returning()
    )[0] as RequestRow;
    const outcome = featureRequestOutcome(featureRequestView(decided), ctx.actor.shortName);
    await tx
      .update(automationRunSteps)
      .set({
        state: 'succeeded',
        finishedAt: ctx.now,
        inputSummary: (outcome
          ? [outcome.lead, outcome.detail].filter(Boolean).join(' · ')
          : 'Decided'
        ).slice(0, 300),
        output: {
          ...(step.output as JsonObject),
          requestId: request.id,
          decided: true,
          choice: input.choice,
          build: input.choice === 'build',
          status,
          message: words.message,
          needsWords: words.needsWords,
          instruction: words.instruction,
          ...(note ? { note } : {}),
          decidedById: ctx.actor.id,
        },
        updatedAt: ctx.now,
      })
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, step.idx)));
    // The answer puts the run back among those that take a place, as a yes on an approval does (AR-56).
    const full =
      (await activeRunCount(tx, run.automationId, run.id)) >= run.definition.limits.maxConcurrentRuns;
    await tx
      .update(automationRuns)
      .set({ status: full ? 'queued' : 'running', updatedAt: ctx.now })
      .where(eq(automationRuns.id, run.id));
    await ctx.emit({
      type: 'tracker.feature_decided',
      kind: 'System',
      text: `Decided on feature request #${request.number} in ${request.connection}`,
      where: request.connection,
      payload: { runId: run.id, requestId: request.id, number: request.number, choice: input.choice },
    });
    await republishFeatureCards(ctx, [request.id]);
    await publishRun(ctx, run.id);
    const services = ctx.services;
    ctx.after(async () => services.automations.nudge());
    return { request: featureRequestView(decided) };
  },
});

/** `tracker.decide` (TA-45): people only. */
export async function trackerDecideOp(
  services: Services,
  access: BurrowAccess,
  requestId: string,
  body: { choice: FeatureDecisionChoice; note?: string | undefined },
): Promise<{ request: FeatureRequestView }> {
  if (access.principal.kind !== 'person') throw forbidden('Only people decide on feature requests.');
  const res = await services.pipeline.commit(
    decideFeature,
    { requestId, choice: body.choice, ...(body.note ? { note: body.note } : {}) },
    { burrowId: access.burrow.id, actorId: access.principal.id },
  );
  if (res.status !== 'ok') throw conflict('Your answer couldn’t be kept: try again.');
  return res.result;
}

/**
 * The feature requests waiting for the person, as Needs you questions (TA-44): “Feature request: Export devices to CSV ·
 * 7 of 10”, with Decide opening the report's thread. Newest first, at most 20.
 */
export async function featureRequestItems(
  db: Db,
  burrowId: string,
): Promise<{ item: NeedsYouItem; conversationId: string | null }[]> {
  const rows = await db
    .select({ request: featureRequests, conversation: conversations })
    .from(featureRequests)
    .innerJoin(automationRuns, eq(automationRuns.id, featureRequests.runId))
    .innerJoin(conversations, eq(conversations.id, automationRuns.conversationId))
    .where(and(eq(featureRequests.burrowId, burrowId), eq(featureRequests.state, 'waiting')))
    .orderBy(desc(featureRequests.createdAt))
    .limit(20);
  const out: { item: NeedsYouItem; conversationId: string | null }[] = [];
  for (const { request, conversation } of rows) {
    const message = request.messageId ? await loadMessageRow(db, request.messageId) : undefined;
    const room = roomByKey(conversation);
    const root = message ? (message.threadRootId ?? message.id) : null;
    out.push({
      conversationId: conversation.id,
      item: {
        id: `feature_request:${request.id}`,
        ref: { kind: 'feature_request', id: request.id },
        kind: 'question',
        severity: 'info',
        title: `Feature request: ${request.title} · ${featureValueText(request.value)}`.slice(0, 200),
        body: (request.organization
          ? `From ${request.organization} in ${request.connection}`
          : `In ${request.connection}`
        ).slice(0, 600),
        at: request.createdAt.toISOString(),
        actions: [
          {
            id: 'decide',
            label: 'Decide',
            style: 'primary',
            kind: 'open',
            href: room && root ? chatThreadHref(room, root) : chatHref(conversation.id),
          },
        ],
      },
    });
  }
  return out;
}
