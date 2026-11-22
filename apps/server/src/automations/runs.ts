/** Creating an automation run: the run row, one row per step, and its signed event, in the caller's transaction. */
import {
  type AutomationDefinition,
  type AutomationTriggerInfo,
  type JsonObject,
  type MessageProvenance,
  newId,
  stepKindLabel,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import type { TxSession } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { automationRunSteps, automationRuns, messages } from '../db/schema/index';
import { thePersonAccountId } from '../domain/the-person';
import { itemThread } from './github-items';
import { runRoomOf } from './rooms';
import { type AutomationRow, type AutomationRunRow, publishAutomation, publishRun } from './store';

export interface NewRun {
  automation: Pick<AutomationRow, 'id' | 'name' | 'principalId' | 'burrowId'>;
  definition: AutomationDefinition;
  version: number;
  publishedById: string;
  trigger: AutomationTriggerInfo;
  triggerKey: string;
  scope: JsonObject;
  conversationId: string;
  threadRootId: string | null;
  causalDepth: number;
  causalChain: string[];
  startedById: string | null;
  test: boolean;
  /** Created as `skipped` (a schedule's overlap policy) with this reason; nothing runs. */
  skippedBecause?: string;
  /** The skip is a refusal (the publisher may not act on the trigger): its signed event is a Blocked one. */
  blocked?: boolean;
  /** The GitHub issue or pull request it is about (`itemKeyOf`): later runs about it continue its thread. */
  itemKey?: string | null;
  now?: Date;
}

/**
 * Inserts the run (queued: the engine starts it when the automation has a free slot). Returns null when a run
 * for the same trigger already exists (dedupe on automation, version and trigger key: at most one run per event,
 * schedule fire or webhook delivery).
 */
export async function createRun(session: TxSession & { now?: Date }, args: NewRun): Promise<string | null> {
  const tx = session.tx;
  const now = args.now ?? session.now ?? session.services.clock();
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${automationRuns.number}), 0)::int + 1` })
    .from(automationRuns)
    .where(eq(automationRuns.burrowId, args.automation.burrowId));
  const id = newId('automationRun');
  // The room its steps post in (chat-channel.md CHT-09): in the assistant shell the publisher's Chat or Feedback room
  // when their shell doesn't show the given one; a thread there continues only if it is in that room.
  const { conversationId, threadRootId } = await placeOf(session, args);
  const person = await runPersonOf(tx, { burrowId: args.automation.burrowId, trigger: args.trigger });
  const deadlineAt = previousReleaseStops(args)
    ? PREVIOUS_RELEASE_STOPS_AT
    : new Date(now.getTime() + args.definition.limits.runTimeoutMinutes * 60_000);
  const inserted = await tx
    .insert(automationRuns)
    .values({
      id,
      burrowId: args.automation.burrowId,
      number: next,
      automationId: args.automation.id,
      version: args.version,
      definition: args.definition,
      publishedById: args.publishedById,
      status: args.skippedBecause ? 'skipped' : 'queued',
      trigger: args.trigger,
      triggerKey: args.triggerKey,
      scope: args.scope,
      conversationId,
      threadRootId,
      causalDepth: args.causalDepth,
      causalChain: args.causalChain,
      startedById: args.startedById,
      onBehalfOfAccountId: person,
      test: args.test,
      createdAt: now,
      finishedAt: args.skippedBecause ? now : null,
      error: args.skippedBecause ?? null,
      deadlineAt,
      updatedAt: now,
      itemKey: args.itemKey ?? null,
    })
    .onConflictDoNothing({
      target: [automationRuns.automationId, automationRuns.version, automationRuns.triggerKey],
    })
    .returning({ id: automationRuns.id });
  if (inserted.length === 0) return null;
  await tx.insert(automationRunSteps).values(
    args.definition.steps.map((s, idx) => ({
      runId: id,
      idx,
      stepId: s.id,
      kind: s.kind,
      name: s.name ?? stepKindLabel(s.kind),
      state: args.skippedBecause ? ('skipped' as const) : ('pending' as const),
      updatedAt: now,
    })),
  );
  await session.append(args.automation.principalId, {
    type: args.skippedBecause ? 'automation.run.skipped' : 'automation.run.created',
    kind: args.skippedBecause && args.blocked ? 'Blocked' : 'System',
    text: args.skippedBecause
      ? `${args.blocked ? 'Blocked' : 'Skipped'} automation run #${next} of “${args.automation.name}”`
      : `Started automation run #${next} of “${args.automation.name}”`,
    where: null,
    payload: {
      automationId: args.automation.id,
      runId: id,
      number: next,
      version: args.version,
      trigger: args.trigger.kind,
      ...(args.trigger.eventId ? { eventId: args.trigger.eventId } : {}),
      causalDepth: args.causalDepth,
      test: args.test,
      ...(args.blocked ? { blocked: true } : {}),
    },
    createdAt: now.toISOString(),
  });
  await publishRun(session, id);
  await publishAutomation(session, args.automation.burrowId, args.automation.id);
  return id;
}

/**
 * Where a new run posts: the room `runRoomOf` resolves (a skipped run posts nothing, so it keeps the given one) and the
 * thread it continues — the given one when it is in that room, else the thread an earlier run about the same item
 * started there (`itemThread`), else none.
 */
async function placeOf(
  session: TxSession & { now?: Date },
  args: NewRun,
): Promise<{ conversationId: string; threadRootId: string | null }> {
  const given = { conversationId: args.conversationId, threadRootId: args.threadRootId };
  if (args.skippedBecause) return given;
  const room = await runRoomOf(session, {
    definition: args.definition,
    publishedById: args.publishedById,
    conversationId: args.conversationId,
  });
  if (room === args.conversationId) return given;
  if (args.threadRootId) {
    const [root] = await session.tx
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.id, args.threadRootId));
    if (root?.conversationId === room) return { conversationId: room, threadRootId: args.threadRootId };
  }
  const thread = args.itemKey ? await itemThread(session.tx, args.automation.id, args.itemKey, room) : null;
  return { conversationId: room, threadRootId: thread };
}

/** Runs of an automation created in the last day (its daily limit), not counting skipped ones. */
export async function runsToday(session: TxSession, automationId: string, now: Date): Promise<number> {
  const [row] = await session.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.automationId, automationId),
        sql`${automationRuns.createdAt} > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`,
        sql`${automationRuns.status} <> 'skipped'`,
      ),
    );
  return row?.n ?? 0;
}

/** Step kinds the release before mail triggers doesn't have. */
const STEP_KINDS_AFTER_PREVIOUS_RELEASE: readonly string[] = ['connection_actions'];

/**
 * Whether the previous release, should an update be rolled back onto this database, must stop the run before it runs
 * any of its steps: a run started by incoming mail (that release runs agent steps of any trigger but a tracker's as the
 * person's own turns, with the email in the prompt), and a run with a step kind it doesn't have (it would try that step
 * again on every pass until the run's time ran out).
 */
export function previousReleaseStops(run: {
  trigger: { kind: string };
  definition: { steps: readonly { kind: string }[] };
}): boolean {
  return (
    run.trigger.kind === 'mail' ||
    run.definition.steps.some((s) => STEP_KINDS_AFTER_PREVIOUS_RELEASE.includes(s.kind))
  );
}

/**
 * The `deadline_at` such a run is stored with. The previous release checks a started run's deadline before anything
 * else and fails it once it is past (“It ran out of time”), cancelling its turns; it never starts one of its steps.
 * This release reads the run's own deadline instead (`runDeadline`). Details: docs/decisions/automation-recipes.md.
 */
export const PREVIOUS_RELEASE_STOPS_AT = new Date(0);

/** When a run gives up: its own time limit after it was created, also for a run stored for the previous release. */
export function runDeadline(
  run: Pick<AutomationRunRow, 'deadlineAt' | 'createdAt'> & {
    definition: { limits: Pick<AutomationDefinition['limits'], 'runTimeoutMinutes'> };
  },
): Date {
  if (run.deadlineAt.getTime() !== PREVIOUS_RELEASE_STOPS_AT.getTime()) return run.deadlineAt;
  return new Date(run.createdAt.getTime() + run.definition.limits.runTimeoutMinutes * 60_000);
}

/**
 * Whether a run starts from outsiders' input (docs/decisions/one-person.md): a tracker customer's report or reply, or
 * incoming mail (and test runs tried on them). Their agent turns stay apart (queued for nobody).
 */
export function outsidersRun(trigger: { kind: string }): boolean {
  return trigger.kind === 'tracker' || trigger.kind === 'mail';
}

/** Provenance stamped on messages posted by an outsiders' run (mail or tracker), so triggers skip them. */
export function runProvenanceOf(run: { trigger: { kind: string } }): MessageProvenance | null {
  return outsidersRun(run.trigger) ? 'outsiders_run' : null;
}

/** The account a run's work is for: the person's (their automations are theirs, OP-17), null for outsiders' input. */
export async function runPersonOf(
  db: Db | Tx,
  run: { burrowId: string; trigger: { kind: string } },
): Promise<string | null> {
  return outsidersRun(run.trigger) ? null : thePersonAccountId(db, run.burrowId);
}
