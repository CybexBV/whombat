/**
 * A report its tracker erased is forgotten here too (docs/decisions/report-trackers.md): the poller reads the driver's
 * `erasures` each cycle, and for each report this Whombat mirrored or ran for, `tracker.items_erased` deletes what
 * Whombat keeps of it — the mirrored report and its customer's answers, its feature request cards — blanks the words
 * the runs about it kept (their trigger's summary and `{{trigger.*}}`, the instructions their agent steps kept, the
 * report's title in their requests to the agents in the thread), puts plain words in place of its feature request
 * cards' (and their notifications'), stops the runs still working on it (their agents' turns, their waiting cards and
 * approvals) with a line in their thread, and stops following its fixes, so no customer is told anything more. The
 * realtime frames a device could still replay with those words go too. What the team's agents and people wrote about
 * it stays. Signed by the burrow's tracker principal with ids only; nothing goes to the tracker. Every connection with
 * something of a report here (mirrored reports, or runs about them) follows its tracker's erasures, also when nothing
 * listens to it any more.
 */
import { conversationLabel, type JsonObject, topics } from '@whombat/core';
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { publishApproval, syncPlanSteps } from '../approvals/engine';
import { cancelRunFor } from '../automations/commands';
import { turnThreads } from '../automations/mail-text';
import { requestLineWithoutTitle } from '../automations/steps/words';
import {
  ACTIVE_RUN_STATUSES,
  type AutomationRunRow,
  type AutomationStepRow,
  loadStepRows,
  publishAutomation,
  publishRun,
} from '../automations/store';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import {
  approvals,
  automationRunSteps,
  automationRuns,
  dispatches,
  featureRequests,
  messages,
  notifications,
  sessionEvents,
  trackerFixes,
  trackerItems,
} from '../db/schema/index';
import { refreshMessageNotifications } from '../domain/message-edits';
import { indexMessage } from '../domain/search-index';
import { forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow, loadMessages } from '../read/messages';
import { loadPrincipalRow } from '../read/principals';
import { toApproval } from '../read/work';
import { dropSessions, finishedAutomationSessions } from '../runtime/sessions';
import { trackerConnectionRow } from './connection';
import { FOLLOWED_STATES } from './fixes';
import { trackerItemKey } from './items';
import { isTrackerPrincipal } from './principal';

/** Erased reports one commit forgets at most (a page of the driver's answer is split into these). */
export const ERASE_PER_COMMIT = 50;

/** Why a run about an erased report stopped, in its thread and on its page. */
export const REPORT_ERASED = 'The customer’s report was deleted, so Whombat deleted its copy too.';
/** What an erased report's fix says, on the run page, when Whombat stops following it. */
export const FIX_REPORT_ERASED = 'The customer’s report was deleted.';
/** What an erased report's feature request card's message (and its notification) says instead of the report's words. */
export const FEATURE_REQUEST_ERASED = 'Feature request: the customer’s report was deleted.';

/** A run whose words were blanked already. */
const blanked = sql`coalesce(${automationRuns.scope}->>'text', '') = ${REPORT_ERASED}`;

/** The run matches an erased report: by its item key, or by its scope (a test run on a sample has no item key). */
function namesReports(connectionId: string, reportIds: readonly string[], keys: readonly string[]) {
  const byScope = and(
    sql`${automationRuns.scope}->>'kind' = 'tracker'`,
    sql`${automationRuns.scope}->>'connectionId' = ${connectionId}`,
    inArray(sql<string>`${automationRuns.scope}->>'reportId'`, [...reportIds]),
  );
  return keys.length ? or(inArray(automationRuns.itemKey, [...keys]), byScope) : byScope;
}

/**
 * The ids among `reportIds` this Whombat has anything of for the connection: a mirrored report, or a run about it.
 * Only those are erased; the others were never here.
 */
export async function keptReports(
  db: Db,
  burrowId: string,
  connectionId: string,
  reportIds: readonly string[],
): Promise<string[]> {
  if (!reportIds.length) return [];
  const mirrored = await db
    .select({ id: trackerItems.externalId })
    .from(trackerItems)
    .where(
      and(eq(trackerItems.connectionId, connectionId), inArray(trackerItems.externalId, [...reportIds])),
    );
  const ran = await db
    .selectDistinct({ id: sql<string>`${automationRuns.scope}->>'reportId'` })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.burrowId, burrowId),
        namesReports(connectionId, reportIds, []),
        sql`not (${blanked})`,
      ),
    );
  const kept = new Set([...mirrored.map((m) => m.id), ...ran.map((r) => r.id)]);
  return reportIds.filter((id) => kept.has(id));
}

/** The words a run about an erased report keeps: its ids, number and kinds stay, the customer's words go. */
function erasedScope(scope: JsonObject): JsonObject {
  return {
    ...scope,
    title: '',
    organization: null,
    description: '',
    expected: '',
    text: REPORT_ERASED,
  };
}

/** “Deleted report #15 in Acme dev”: an erased report's run, as its trigger says it. */
function erasedSummary(scope: JsonObject): string {
  const number = typeof scope.number === 'number' ? ` #${scope.number}` : '';
  const where = typeof scope.connection === 'string' && scope.connection ? ` in ${scope.connection}` : '';
  return `Deleted report${number}${where}`.slice(0, 200);
}

/**
 * The run's requests still waiting for a person's yes — its steps' and its agents' turns' —: they wait no more. Each
 * reads as declined by Whombat's tracker signer, with a signed `approval.declined` saying why; nobody is woken (its run
 * stopped already).
 */
async function withdrawRunApprovals(ctx: ApplyContext, runId: string): Promise<number> {
  const rows = await ctx.tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.burrowId, ctx.burrow.id),
        eq(approvals.state, 'pending'),
        or(
          inArray(
            approvals.id,
            ctx.tx
              .select({ id: sql<string>`${automationRunSteps.approvalId}` })
              .from(automationRunSteps)
              .where(eq(automationRunSteps.runId, runId)),
          ),
          inArray(
            approvals.createdByDispatchId,
            ctx.tx.select({ id: dispatches.id }).from(dispatches).where(eq(dispatches.runId, runId)),
          ),
        ),
      ),
    )
    .for('update');
  for (const row of rows) {
    const [fresh] = await ctx.tx
      .update(approvals)
      .set({ state: 'declined', decidedById: ctx.actor.id, decidedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(approvals.id, row.id))
      .returning();
    const conversation = await loadConversationRow(ctx.tx, row.conversationId);
    const event = await ctx.emit({
      type: 'approval.declined',
      kind: 'Asks',
      text: `Withdrew request #${row.number}: the customer’s report was deleted`,
      where: conversation ? conversationLabel(conversation) : null,
      aboutId: row.requesterId,
      approvalId: row.id,
      ref: { type: 'approval', number: row.number },
      payload: { approvalId: row.id, decision: 'decline', withdrawn: true, note: null },
    });
    if (fresh) {
      const approval = toApproval(fresh);
      publishApproval(ctx, approval, event.id);
      await syncPlanSteps(ctx, approval);
    }
  }
  return rows.length;
}

/**
 * The words an erased report's run kept in its steps and its thread, gone: each agent step's instructions (rendered
 * from the report), and the report's title in the run's requests to its agents (“@Dusty Assess it: #15 “…””, the
 * customer's first line until the team names it), republished as an edited message is. What the agents answered
 * stays. Answers the messages it changed, and those to index again after the commit (their thread roots too).
 */
async function forgetRunWords(
  ctx: ApplyContext,
  run: AutomationRunRow,
  steps: readonly AutomationStepRow[],
): Promise<{ changed: string[]; reindex: string[] }> {
  for (const step of steps) {
    const output = step.output ?? {};
    if (typeof output.instructions !== 'string' || !output.instructions) continue;
    await ctx.tx
      .update(automationRunSteps)
      .set({ output: { ...output, instructions: '' } })
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, step.idx)));
  }
  const title = typeof run.scope?.title === 'string' ? run.scope.title : '';
  const prompts = new Set(steps.map((s) => s.promptMessageId).filter((id): id is string => !!id));
  const changed: string[] = [];
  const reindex: string[] = [];
  for (const id of prompts) {
    const row = await loadMessageRow(ctx.tx, id);
    if (!row || row.deletedAt) continue;
    const text = requestLineWithoutTitle(row.text, title);
    if (text === row.text) continue;
    const [updated] = await ctx.tx.update(messages).set({ text }).where(eq(messages.id, id)).returning();
    if (!updated) continue;
    await refreshMessageNotifications(ctx.tx, id, text);
    const [loaded] = await loadMessages(ctx.tx, [updated], null);
    if (loaded)
      ctx.publish(topics.conversation(row.conversationId), { type: 'message.updated', message: loaded });
    changed.push(id);
    reindex.push(id, ...(row.threadRootId ? [row.threadRootId] : []));
  }
  return { changed, reindex };
}

/**
 * The messages of these deleted feature request cards, now without their request: their text (“Feature request from
 * <name>: “<title>” …”, which the card folded) becomes plain words without the report's, and so do their notifications;
 * then they are published again, so the apps drop the card's controls and words. Answers the messages it changed.
 */
async function forgetCards(
  ctx: ApplyContext,
  cards: readonly { id: string; messageId: string | null }[],
): Promise<{ changed: string[]; rooms: string[] }> {
  const changed: string[] = [];
  const rooms = new Set<string>();
  if (cards.length)
    await ctx.tx
      .update(notifications)
      .set({ text: FEATURE_REQUEST_ERASED })
      .where(
        and(
          eq(notifications.burrowId, ctx.burrow.id),
          inArray(
            notifications.dedupKey,
            cards.map((c) => `feature_request:${c.id}`),
          ),
        ),
      );
  for (const card of cards) {
    if (!card.messageId) continue;
    const message = await loadMessageRow(ctx.tx, card.messageId);
    if (!message) continue;
    rooms.add(message.conversationId);
    let row = message;
    if (!message.deletedAt && message.text !== FEATURE_REQUEST_ERASED) {
      const [updated] = await ctx.tx
        .update(messages)
        .set({ text: FEATURE_REQUEST_ERASED })
        .where(eq(messages.id, message.id))
        .returning();
      if (updated) row = updated;
      await refreshMessageNotifications(ctx.tx, message.id, FEATURE_REQUEST_ERASED);
      changed.push(message.id);
    }
    const [loaded] = await loadMessages(ctx.tx, [row], null);
    if (loaded)
      ctx.publish(topics.conversation(message.conversationId), { type: 'message.updated', message: loaded });
  }
  return { changed, rooms: [...rooms] };
}

/**
 * The realtime frames a device could still replay with the report's words: the session event log keeps every frame for
 * up to three days. The runs' frames and those of the messages that quoted it go; the commit publishes them again
 * without the words.
 */
async function dropReplayFrames(
  ctx: ApplyContext,
  runIds: readonly string[],
  rooms: readonly string[],
  messageIds: readonly string[],
): Promise<void> {
  if (runIds.length)
    await ctx.tx
      .delete(sessionEvents)
      .where(
        and(
          eq(sessionEvents.topic, topics.burrow(ctx.burrow.id)),
          sql`${sessionEvents.event}->>'type' = 'automation.run.updated'`,
          inArray(sql<string>`${sessionEvents.event}->'run'->>'id'`, [...runIds]),
        ),
      );
  if (messageIds.length && rooms.length)
    await ctx.tx.delete(sessionEvents).where(
      and(
        inArray(
          sessionEvents.topic,
          rooms.map((r) => topics.conversation(r)),
        ),
        inArray(sql<string>`${sessionEvents.event}->'message'->>'id'`, [...messageIds]),
      ),
    );
}

/**
 * `tracker.items_erased` (the burrow's tracker principal): these reports of the connection are gone from the tracker
 * (withdrawn, or erased there), so Whombat forgets them. The mirrored row goes first: a run the engine is starting from
 * it at this moment either finds it gone or started already and is found here (`mirroredItem` reads it for share).
 * Repeating it changes nothing. Answers how many reports it forgot and how many runs it stopped.
 */
export const eraseTrackerItems = defineCommand({
  name: 'tracker.items_erased',
  schema: z.object({
    connectionId: z.string(),
    reportIds: z.array(z.string().min(1).max(100)).min(1).max(ERASE_PER_COMMIT),
  }),
  async apply(tx, ctx, input): Promise<{ erased: number; stopped: number }> {
    if (!isTrackerPrincipal(await loadPrincipalRow(tx, ctx.actor.id)))
      throw forbidden('Only Whombat’s tracker signer forgets a report its tracker erased.');
    const connection = await trackerConnectionRow(tx, ctx.burrow.id, input.connectionId);
    if (!connection) throw notFound('Tracker connection');
    const reportIds = [...new Set(input.reportIds)];
    // The report and, by the foreign key, its customer's answers.
    const gone = await tx
      .delete(trackerItems)
      .where(and(eq(trackerItems.connectionId, connection.id), inArray(trackerItems.externalId, reportIds)))
      .returning({ externalId: trackerItems.externalId, number: trackerItems.number });
    const keys = gone.map((g) => trackerItemKey(connection.id, g.number));
    const runs = await tx
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.burrowId, ctx.burrow.id),
          namesReports(connection.id, reportIds, keys),
          // Forgotten before, and finished: nothing left to do (a repeat changes nothing).
          or(sql`not (${blanked})`, inArray(automationRuns.status, [...ACTIVE_RUN_STATUSES])),
        ),
      )
      .for('update');
    let stopped = 0;
    const automationIds = new Set<string>();
    const reindex = new Set<string>();
    // The messages whose words changed, for the frames a device could replay.
    const rewritten = new Set<string>();
    for (const run of runs) {
      if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
        // Its agents' turns stop, its unfinished steps and feature request cards end, its thread hears why.
        await cancelRunFor(ctx, run, REPORT_ERASED, { reportErased: true });
        await withdrawRunApprovals(ctx, run.id);
        automationIds.add(run.automationId);
        stopped++;
      }
      const scope = run.scope ?? {};
      await tx
        .update(automationRuns)
        .set({
          scope: erasedScope(scope),
          trigger: { ...run.trigger, summary: erasedSummary(scope) },
          updatedAt: ctx.now,
        })
        .where(eq(automationRuns.id, run.id));
      const steps = await loadStepRows(tx, run.id);
      const words = await forgetRunWords(ctx, run, steps);
      for (const id of words.changed) rewritten.add(id);
      for (const id of words.reindex) reindex.add(id);
      // The Hermes sessions its agents' turns ran in hold the report as they read it: forgotten, as a mail run's are.
      await dropSessions(ctx, await finishedAutomationSessions(tx, await turnThreads(tx, run, steps)));
    }
    // Its feature request cards: what the agent made of the report and the replies it drafted.
    const cards = await tx
      .delete(featureRequests)
      .where(
        and(
          eq(featureRequests.burrowId, ctx.burrow.id),
          eq(featureRequests.connectionId, connection.id),
          inArray(featureRequests.reportId, reportIds),
        ),
      )
      .returning({ id: featureRequests.id, messageId: featureRequests.messageId });
    // Its fixes are followed no further, so the customer hears nothing more.
    const fixes = await tx
      .update(trackerFixes)
      .set({ state: 'stopped', note: FIX_REPORT_ERASED, updatedAt: ctx.now })
      .where(
        and(
          eq(trackerFixes.burrowId, ctx.burrow.id),
          eq(trackerFixes.connectionId, connection.id),
          inArray(trackerFixes.reportId, reportIds),
          inArray(trackerFixes.state, [...FOLLOWED_STATES]),
        ),
      )
      .returning({ id: trackerFixes.id });
    if (!gone.length && !runs.length && !cards.length && !fixes.length) return { erased: 0, stopped: 0 };
    const forgotten = await forgetCards(ctx, cards);
    for (const id of forgotten.changed) {
      rewritten.add(id);
      reindex.add(id);
    }
    await dropReplayFrames(
      ctx,
      runs.map((r) => r.id),
      [...new Set([...runs.map((r) => r.conversationId), ...forgotten.rooms])],
      [...rewritten],
    );
    for (const run of runs) await publishRun(ctx, run.id);
    for (const id of automationIds) await publishAutomation(ctx, ctx.burrow.id, id);
    const forgot = new Set([
      ...gone.map((g) => g.externalId),
      ...runs.map((r) => String((r.scope as { reportId?: unknown } | null)?.reportId ?? '')).filter(Boolean),
    ]).size;
    await ctx.emit({
      type: 'tracker.items_erased',
      kind: 'System',
      text: `Forgot ${forgot === 1 ? 'a report' : `${forgot} reports`} deleted in ${connection.label}`,
      where: connection.label,
      payload: {
        connectionId: connection.id,
        numbers: gone.map((g) => g.number),
        runIds: runs.map((r) => r.id),
        stopped,
        fixes: fixes.length,
      },
    });
    const services = ctx.services;
    // Search finds the requests by their words as they are now.
    if (reindex.size)
      ctx.after(async () => {
        for (const id of reindex) await indexMessage(services.db, id);
      });
    if (stopped) ctx.after(async () => services.automations.nudge());
    return { erased: forgot, stopped };
  },
});

/** A tracker run's connection, by its scope. */
const runConnection = sql<string>`${automationRuns.scope}->>'connectionId'`;
/** Runs about a tracker's report whose words weren't forgotten yet. */
const runsAboutReports = and(sql`${automationRuns.scope}->>'kind' = 'tracker'`, sql`not (${blanked})`);

/**
 * The tracker connections, besides `listened`, that still keep something of their reports: mirrored reports, or runs
 * about them (a test run on a report keeps its words with no mirrored item). Nothing listens to them any more, but what
 * they keep still follows their tracker's erasures.
 */
export async function keepingConnections(db: Db, listened: readonly string[]): Promise<string[]> {
  const mirrored = await db
    .selectDistinct({ id: trackerItems.connectionId })
    .from(trackerItems)
    .where(listened.length ? notInArray(trackerItems.connectionId, [...listened]) : undefined);
  const ran = await db
    .selectDistinct({ id: runConnection })
    .from(automationRuns)
    .where(
      and(
        runsAboutReports,
        sql`${runConnection} is not null`,
        listened.length ? notInArray(runConnection, [...listened]) : undefined,
      ),
    );
  return [...new Set([...mirrored, ...ran].map((r) => r.id))];
}

/** The burrow of a connection that keeps something of its reports, or null when it keeps nothing. */
export async function keepingBurrow(db: Db, connectionId: string): Promise<string | null> {
  const [row] = await db
    .select({ burrowId: trackerItems.burrowId })
    .from(trackerItems)
    .where(eq(trackerItems.connectionId, connectionId))
    .limit(1);
  if (row) return row.burrowId;
  const [ran] = await db
    .select({ burrowId: automationRuns.burrowId })
    .from(automationRuns)
    .where(and(runsAboutReports, eq(runConnection, connectionId)))
    .limit(1);
  return ran?.burrowId ?? null;
}
