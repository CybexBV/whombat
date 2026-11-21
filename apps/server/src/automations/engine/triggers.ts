/**
 * Triggers (bp-automations BP-C05): each burrow's signed `events` after its durable cursor become runs of the live
 * automations they match (deduped by automation + version + event), and the cursor moves past them, in one transaction.
 */
import { triggerMatches } from '@whombat/core';
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  automationCursors,
  automationRuns,
  automations,
  automationVersions,
  events,
} from '../../db/schema/index';
import { inBurrow } from '../../read/conversations';
import type { Services } from '../../services';
import { LIMITED_WORDS, tellLimited } from '../../trackers/stuck';
import { publisherCheck } from '../authority';
import { itemThread } from '../github-items';
import { createRun, runsToday } from '../runs';
import { ACTIVE_RUN_STATUSES, listensToEvents, readsEvents } from '../store';
import { EVENT_TYPES, eventCause, eventFacts } from './event-facts';
import type { EngineOptions } from './options';

/** The engine's limits a scan applies, read as they are at each event (the engine's own options). */
export type TriggerLimits = Pick<EngineOptions, 'maxCausalDepth' | 'burrowRunsPerHour'>;

/**
 * Burrows with a live automation that reads events (a message, reaction or GitHub trigger in its current version).
 * Only those are scanned (SV-03): a burrow whose automations only run on schedules, webhooks or by hand takes no lock
 * and moves no cursor; publishing or switching one on that reads events starts its cursor at the latest event
 * (`ensureCursor`).
 */
export async function eventBurrows(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ burrowId: automationCursors.burrowId })
    .from(automationCursors)
    .innerJoin(automations, eq(automations.burrowId, automationCursors.burrowId))
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(
      and(
        eq(automations.status, 'published'),
        isNull(automations.deletedAt),
        listensToEvents(automationVersions.definition),
      ),
    );
  return rows.map((r) => r.burrowId);
}

async function liveAutomations(db: Db, burrowId: string) {
  const rows = await db
    .select({ a: automations, v: automationVersions })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(
      and(
        eq(automations.burrowId, burrowId),
        eq(automations.status, 'published'),
        isNull(automations.deletedAt),
      ),
    );
  return rows;
}

/** The burrow's events after its cursor (500 at most): the runs they start, and the cursor after them. */
export async function scanBurrow(
  services: Services,
  limits: TriggerLimits,
  burrowId: string,
): Promise<number> {
  const live = (await liveAutomations(services.db, burrowId)).filter((r) =>
    r.v.definition.triggers.some(readsEvents),
  );
  const { result } = await services.pipeline.transact(burrowId, async (session) => {
    const tx = session.tx;
    const [cursor] = await tx
      .select()
      .from(automationCursors)
      .where(eq(automationCursors.burrowId, burrowId))
      .for('update');
    if (!cursor) return 0;
    const batch = await tx
      .select()
      .from(events)
      .where(and(eq(events.burrowId, burrowId), gt(events.seq, cursor.seq)))
      .orderBy(asc(events.seq))
      .limit(500);
    if (batch.length === 0) return 0;
    let created = 0;
    const now = services.clock();
    for (const event of batch) {
      if (!live.length || !EVENT_TYPES.includes(event.type)) continue;
      const facts = await eventFacts(tx, event);
      if (!facts) continue;
      const cause = await eventCause(tx, event, facts);
      for (const { a, v } of live) {
        if (!v.definition.triggers.some((t) => triggerMatches(t, facts.facts))) continue;
        // Mail already present when an automation was published must never start it, even when another automation was
        // already watching the same mailbox (allow 5 s for provider/box clock skew on freshly sent mail).
        if (
          facts.facts.kind === 'mail' &&
          (event.createdAt < v.publishedAt ||
            (facts.receivedAt && facts.receivedAt.getTime() < v.publishedAt.getTime() - 5_000))
        )
          continue;
        // Loop guards: automation-caused events stop at a small depth, and never trigger their own automation.
        if (
          cause.depth > limits.maxCausalDepth ||
          cause.chain.includes(a.id) ||
          event.actorId === a.principalId
        )
          continue;
        const conversationId = facts.conversationId ?? v.definition.conversationId;
        // The publisher must still be allowed, and still read the room the event happened in (BP-C20): otherwise
        // nothing of it reaches a step. It shows as a Blocked, skipped run (at most one an hour).
        const refused = await triggerRefusal(tx, burrowId, v.publishedById, facts.conversationId);
        if (refused) {
          const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString();
          await createRun(session, {
            automation: a,
            definition: v.definition,
            version: v.n,
            publishedById: v.publishedById,
            trigger: facts.info(event),
            triggerKey: `blocked:${hour}`,
            scope: { kind: String(facts.scope.kind ?? 'event'), text: '' },
            conversationId,
            threadRootId: null,
            causalDepth: cause.depth,
            causalChain: [...cause.chain, a.id].slice(-10),
            startedById: null,
            test: false,
            now,
            skippedBecause: refused,
            blocked: true,
          });
          continue;
        }
        // One run at a time per thread: a reply (or a 🐛) in a thread this automation is still working on is part
        // of that run's conversation, not a new report.
        if (facts.threadRootId && (await activeRunInThread(tx, a.id, facts.threadRootId))) continue;
        const limited =
          (await runsToday(session, a.id, now)) >= v.definition.limits.maxRunsPerDay
            ? 'day'
            : (await burrowRunsLastHour(tx, burrowId, now)) >= limits.burrowRunsPerHour
              ? 'hour'
              : null;
        if (limited) {
          // A customer's report isn't let go quietly (report-trackers.md TA-64): a skipped run keeps it, in the same
          // commit as the cursor that moves past it, and the person hears — now, and from the poll's sweep
          // (`resendLimited`) should this hearing be lost.
          if (facts.scope.kind === 'tracker') {
            const scope = facts.scope;
            await createRun(session, {
              automation: a,
              definition: v.definition,
              version: v.n,
              publishedById: v.publishedById,
              trigger: facts.info(event),
              triggerKey: `limited-${limited}:${event.id}`,
              scope,
              conversationId,
              threadRootId: null,
              causalDepth: cause.depth,
              causalChain: [...cause.chain, a.id].slice(-10),
              startedById: null,
              test: false,
              itemKey: facts.itemKey,
              now,
              skippedBecause: LIMITED_WORDS[limited],
            });
            session.after(() => tellLimited(services, burrowId, scope, limited));
          }
          continue;
        }
        // One issue or pull request, one thread (automation-recipes.md): a later run about it goes on in the thread
        // an earlier run of this automation started in its room.
        const threadRootId =
          facts.threadRootId ??
          (facts.itemKey ? await itemThread(tx, a.id, facts.itemKey, conversationId) : null);
        const runId = await createRun(session, {
          automation: a,
          definition: v.definition,
          version: v.n,
          publishedById: v.publishedById,
          trigger: facts.info(event),
          triggerKey: `evt:${event.id}`,
          scope: facts.scope,
          conversationId,
          threadRootId,
          causalDepth: cause.depth,
          causalChain: [...cause.chain, a.id].slice(-10),
          startedById: null,
          test: false,
          itemKey: facts.itemKey,
          now,
        });
        if (runId) created++;
      }
    }
    const last = batch[batch.length - 1];
    if (last)
      await tx
        .update(automationCursors)
        .set({ seq: last.seq, updatedAt: now })
        .where(eq(automationCursors.burrowId, burrowId));
    return created;
  });
  return result;
}

/**
 * While the licence is lapsed (LC-10): every scanned burrow's trigger cursor moves past the events so far, so nothing
 * that happened meanwhile starts a run later. Returns how many cursors moved.
 */
export async function skipEventCursors(services: Services, now: Date): Promise<number> {
  let moved = 0;
  for (const burrowId of await eventBurrows(services.db)) {
    await services.pipeline.transact(burrowId, async ({ tx }) => {
      const [head] = await tx
        .select({ seq: sql<number | null>`max(${events.seq})` })
        .from(events)
        .where(eq(events.burrowId, burrowId));
      if (head?.seq == null) return;
      const updated = await tx
        .update(automationCursors)
        .set({ seq: Number(head.seq), updatedAt: now })
        .where(and(eq(automationCursors.burrowId, burrowId), lt(automationCursors.seq, Number(head.seq))))
        .returning({ burrowId: automationCursors.burrowId });
      moved += updated.length;
    });
  }
  return moved;
}

/** Why an event may not start a run of an automation its publisher can no longer act for (null: it may). */
async function triggerRefusal(
  tx: Db,
  burrowId: string,
  publishedById: string,
  conversationId: string | null,
): Promise<string | null> {
  const who = await publisherCheck(tx, burrowId, publishedById);
  if (!who.ok) return `Blocked: ${who.reason}`;
  if (conversationId && !(await inBurrow(tx, burrowId, conversationId)))
    return 'Blocked: the room this automation listens to is gone, so it can’t act on what happens there.';
  return null;
}

async function burrowRunsLastHour(tx: Db, burrowId: string, now: Date) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.burrowId, burrowId),
        sql`${automationRuns.createdAt} > ${new Date(now.getTime() - 3_600_000).toISOString()}::timestamptz`,
        // A skipped run (a report kept past a limit, a blocked one) started nothing, as `runsToday` counts too.
        sql`${automationRuns.status} <> 'skipped'`,
      ),
    );
  return row?.n ?? 0;
}

/** Whether this automation has a run going for this thread (a reply in it is part of that run). */
async function activeRunInThread(tx: Db, automationId: string, threadRootId: string): Promise<boolean> {
  // The run's own thread, or the thread of the message that started it: a run posts in its publisher's Chat, away from
  // the thread it was started from (automations/rooms.ts; one-agent.md OA-S103).
  const startedThere = sql`exists (select 1 from messages m where m.id = ${automationRuns.trigger} ->> 'messageId' and coalesce(m.thread_root_id, m.id) = ${threadRootId})`;
  const [row] = await tx
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.automationId, automationId),
        or(eq(automationRuns.threadRootId, threadRootId), startedThere),
        inArray(automationRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    )
    .limit(1);
  return !!row;
}
