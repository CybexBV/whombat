/**
 * Triggers (bp-automations BP-C05): each burrow's signed `events` after its durable cursor become runs of the live
 * automations they match (deduped by automation + version + event), and the cursor moves past them, in one transaction.
 */
import { triggerMatches, upsTrigger } from '@whombat/core';
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { MAIL_SINCE_SKEW_MS } from '../../connectors/types';
import type { Db } from '../../db/client';
import {
  automationCursors,
  automationRuns,
  automations,
  automationVersions,
  events,
  mailTriggerItems,
} from '../../db/schema/index';
import { inBurrow } from '../../read/conversations';
import type { Services } from '../../services';
import { LIMITED_WORDS, tellLimited } from '../../trackers/stuck';
import { publisherCheck } from '../authority';
import { itemThread } from '../github-items';
import { smartHomeTriggersFor } from '../home-triggers';
import { createRun, runsToday } from '../runs';
import { ACTIVE_RUN_STATUSES, listensToEvents, readsEvents } from '../store';
import { EVENT_TYPES, eventCause, eventFacts } from './event-facts';
import {
  claimDueHomeWait,
  claimHomeChange,
  coolingDown,
  dropHomeWait,
  dueHomeWaits,
  type HomeNow,
  skipDueHomeWaits,
} from './home-waits';
import {
  claimIncidentTrigger,
  dropIncidentTrigger,
  dueIncidentTriggers,
  liveChecks,
  skipDueIncidentTriggers,
} from './incident-triggers';
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
  const { result } = await services.pipeline.transact(burrowId, async (session) => {
    const tx = session.tx;
    const [cursor] = await tx
      .select()
      .from(automationCursors)
      .where(eq(automationCursors.burrowId, burrowId))
      .for('update');
    if (!cursor) return 0;
    const live = (await liveAutomations(tx, burrowId)).filter((r) =>
      r.v.definition.triggers.some(readsEvents),
    );
    const batch = await tx
      .select()
      .from(events)
      .where(and(eq(events.burrowId, burrowId), gt(events.seq, cursor.seq)))
      .orderBy(asc(events.seq))
      .limit(500);
    let created = 0;
    const now = services.clock();
    // While the release the box would go back to can't run thing automations, something going down or coming back
    // claims no incident and starts nothing; a delayed start already waiting keeps its time.
    const things = await services.newerAutomations.thingsReady();
    const due = things ? await dueIncidentTriggers(tx, burrowId, now) : [];
    const active = liveChecks(services, burrowId, now);
    // The same for automations that act without AI: Home Assistant and Protect start nothing meanwhile, and a delayed
    // start keeps its time.
    const direct = await services.newerAutomations.directReady();
    const waits = direct ? await dueHomeWaits(tx, burrowId, now) : [];
    const homeNow: HomeNow = (connectionId, entity) =>
      smartHomeTriggersFor(services).current(connectionId, entity);
    const work = [
      ...due.map(({ event, pending }) => ({ event, pending, wait: null })),
      ...waits.map(({ event, wait }) => ({ event, pending: null, wait })),
      ...batch
        .filter((event) => EVENT_TYPES.includes(event.type))
        .map((event) => ({ event, pending: null, wait: null })),
    ];
    for (const { event, pending, wait } of work) {
      if (pending) await dropIncidentTrigger(tx, pending);
      const facts = live.length ? await eventFacts(tx, event) : null;
      // A wait of an automation switched off or published again since (its version isn't live any more), or of a change
      // Whombat can't read, ends here: nothing else would end it.
      if (
        wait &&
        (facts?.facts.kind !== 'home_state' ||
          !live.some(({ a, v }) => a.id === wait.automationId && v.n === wait.version))
      ) {
        await dropHomeWait(tx, wait.automationId, wait.key);
        continue;
      }
      if (!facts) continue;
      const cause = await eventCause(tx, event, facts);
      for (const { a, v } of live) {
        if (pending && (pending.automationId !== a.id || pending.version !== v.n)) continue;
        if (wait && wait.automationId !== a.id) continue;
        const kind = facts.facts.kind;
        if (kind === 'home_state' || kind === 'protect') {
          // What Home Assistant or Protect saw before this version was published was for another automation.
          if (!direct || event.createdAt < v.publishedAt) continue;
          if (
            kind === 'home_state' &&
            !(wait
              ? await claimDueHomeWait(tx, wait, v.n, v.definition, facts.facts, now, homeNow)
              : await claimHomeChange(tx, a.id, v.n, v.definition, facts.facts, event))
          )
            continue;
        }
        if (!v.definition.triggers.some((t) => triggerMatches(t, facts.facts))) continue;
        // Mail already present when this automation's mail trigger became active must never start it (allow 5 s for
        // provider/box clock skew on freshly arrived mail).
        if (facts.facts.kind === 'mail') {
          const activeAt = a.mailActiveAt ?? v.publishedAt;
          if (
            event.createdAt < activeAt ||
            (facts.receivedAt && facts.receivedAt.getTime() < activeAt.getTime() - MAIL_SINCE_SKEW_MS)
          )
            continue;
        }
        // A change of place noticed before this version was published was for another automation's listening.
        if (facts.facts.kind === 'findmy' && event.createdAt < v.publishedAt) continue;
        // Loop guards: automation-caused events stop at a small depth, and never trigger their own automation.
        if (
          cause.depth > limits.maxCausalDepth ||
          cause.chain.includes(a.id) ||
          event.actorId === a.principalId
        )
          continue;
        if (facts.facts.kind === 'thing') {
          if (!things || event.createdAt < (a.thingActiveAt ?? v.publishedAt)) continue;
          const triggers = v.definition.triggers.filter((t) => t.kind === 'thing');
          const safety =
            facts.facts.event === 'problem' &&
            triggers.some(upsTrigger) &&
            v.definition.steps.some((s) => s.kind === 'run_action');
          if (!(await claimIncidentTrigger(tx, a.id, v.n, triggers, facts.facts, event, now, active, safety)))
            continue;
        }
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
        // A sensor that flaps or a doorbell pressed again: one run, then quiet for the automation's cooldown.
        if (await coolingDown(tx, a.id, v.definition, now)) continue;
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
          triggerKey:
            facts.facts.kind === 'thing' ? `incident:${facts.facts.incident.incidentId}` : `evt:${event.id}`,
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
    // Every run that matched has its own scope. Clear the mail cache as the cursor consumes the event, even
    // when the automation was switched off, hit a limit, or otherwise started no run.
    const mailRows = batch.flatMap(({ type, payload }) =>
      type === 'mail.received' && typeof payload.rowId === 'string' ? [payload.rowId] : [],
    );
    if (mailRows.length)
      await tx
        .update(mailTriggerItems)
        .set({ body: '', snippet: '' })
        .where(and(eq(mailTriggerItems.burrowId, burrowId), inArray(mailTriggerItems.id, mailRows)));
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
      await skipDueIncidentTriggers(tx, burrowId, now);
      await skipDueHomeWaits(tx, burrowId, now);
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
