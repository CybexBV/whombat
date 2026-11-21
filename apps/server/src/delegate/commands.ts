/**
 * A delegation's changes, each one commit (docs/decisions/delegate.md). The agent's: `delegation.offer` (the checklist
 * card, or the tasks handed over at once), `delegation.update` (the card changed after the person talked about it, or as
 * tasks end), `delegation.claim` (the next tasks whose turn it is), `delegation.launched` / `delegation.launch_failed`
 * (a task's T3 Code thread, and its watch), `delegation.task_ended` (the watcher read a task's end: its answer and pull
 * request, the agent woken), `delegation.merge_next` (the next done task's pull request is merged in its own thread, one
 * at a time), `delegation.refresh` (what a task does now changed), `delegation.finish` (the summary) and
 * `delegation.expire`. The person's: `delegation.pick`, `delegation.ai` (a task's AI, or every task's), `delegation.start`,
 * `delegation.stop_task` and `delegation.stop`. T3 Code is called between these commits, never inside one (`run.ts`).
 */
import {
  DELEGATION_ANSWER_MAX,
  DELEGATION_AREA_MAX,
  DELEGATION_AREAS_MAX,
  DELEGATION_AT_ONCE_MAX,
  DELEGATION_BRIEF_MAX,
  DELEGATION_CARD_TASKS_MAX,
  DELEGATION_NOTE_MAX,
  DELEGATION_RULES_MAX,
  DELEGATION_SUMMARY_MAX,
  DELEGATION_TASK_NOTE_MAX,
  DELEGATION_TASK_TITLE_MAX,
  DELEGATION_TASKS_MAX,
  DELEGATION_TITLE_MAX,
  DELEGATION_WHY_MAX,
  type DelegationCard,
  type DelegationTaskState,
  DelegationVerification,
  newId,
  SUGGESTIONS_MAX,
  Suggestion,
} from '@whombat/core';
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { readsRoom } from '../chats/rooms';
import { type ApplyContext, defineCommand } from '../commit/types';
import { councilHandedOver, councilOffered, councilPutAside } from '../council/commands';
import type { Db, Tx } from '../db/client';
import {
  attachments,
  councils,
  type DelegationRow,
  type DelegationTaskRow,
  delegationShots,
  delegations,
  delegationTasks,
  messages,
  pullRequests,
  t3Watches,
} from '../db/schema/index';
import { cardNews, joinCard, placeCard } from '../domain/card-move';
import { postMessage } from '../domain/messages';
import { indexMessage } from '../domain/search-index';
import { postUnderCard } from '../domain/under-card';
import { wakeQuietly } from '../domain/wake';
import { conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import { loadPrincipalRow } from '../read/principals';
import { overlapAfter } from './areas';
import { FINAL_TASK, itemsOf, noteOf, saysMerged, taskBranch } from './briefs';
import { changedOf, DELEGATION_TEXT, delegationCard, inOrder, itemNumbersOf, numbersOf } from './card';
import {
  allOver,
  busyTasks,
  eligibleIntegration,
  groupMembers,
  isFinal,
  leadsWith,
  mergesWaiting,
  onePullRequest,
  readyTasks,
  togetherWith,
} from './state';
import { inputFingerprint, verificationOf, verificationPassed } from './verification';

/** Where a delegation's tasks are: kept in `state.ts` (pure), read here and by the watcher. */
export {
  allOver,
  busyTasks,
  isFinal,
  landed,
  leadsWith,
  mergesWaiting,
  readyTasks,
  togetherWith,
} from './state';

const Id = z.string().min(1).max(64);
const ThreadId = z.string().min(1).max(300);
const N = z.number().int().min(1).max(99);

/** How long a combined check's checks may wait to start before the agent looks at the CI. */
export const CHECKS_STUCK_MINUTES = 30;

/** The final row's line when its checks don't start. */
export const CHECKS_STUCK_NOTE = `Its checks haven’t started after ${CHECKS_STUCK_MINUTES} minutes in the queue.`;

/** A delegation nothing moved on for this long ends by itself (a checklist nobody handed over, an agent gone quiet). */
export const DELEGATION_QUIET_DAYS = 7;

/** One task as a command takes it: the agent's words, and the AI resolved from what T3 Code runs. */
export const TaskSpec = z.object({
  title: z.string().min(1).max(DELEGATION_TASK_TITLE_MAX),
  why: z.string().max(DELEGATION_WHY_MAX).nullable(),
  brief: z.string().min(1).max(DELEGATION_BRIEF_MAX),
  picked: z.boolean(),
  /** The number of the task it comes after, on the card as it will be. */
  after: N.nullable(),
  provider: z.string().min(1).max(40).nullable(),
  model: z.string().min(1).max(80).nullable(),
  modelLabel: z.string().min(1).max(60).nullable(),
  /** Its model's options in T3 Code (a council's builder seat's effort, CNL-60). */
  options: z
    .array(z.object({ id: z.string().min(1).max(40), value: z.union([z.string().max(40), z.boolean()]) }))
    .max(8)
    .nullable()
    .default(null),
  /** The parts it changes (DLG-24). */
  areas: z.array(z.string().min(1).max(DELEGATION_AREA_MAX)).max(DELEGATION_AREAS_MAX).default([]),
});
export type TaskSpec = z.input<typeof TaskSpec>;

const ENDED: readonly DelegationTaskState[] = ['done', 'failed', 'stopped', 'timed_out'];
const NOT_STARTED: readonly DelegationTaskState[] = ['offered', 'queued', 'skipped'];

/* Reading ------------------------------------------------------------------------------------------------------- */

export async function loadDelegation(
  db: Db | Tx,
  burrowId: string,
  delegationId: string,
): Promise<DelegationRow | null> {
  const [row] = await db
    .select()
    .from(delegations)
    .where(and(eq(delegations.id, delegationId), eq(delegations.burrowId, burrowId)));
  return row ?? null;
}

export async function loadTasks(db: Db | Tx, delegationId: string): Promise<DelegationTaskRow[]> {
  const rows = await db
    .select()
    .from(delegationTasks)
    .where(eq(delegationTasks.delegationId, delegationId))
    .orderBy(asc(delegationTasks.position), asc(delegationTasks.createdAt));
  return inOrder(rows);
}

/** The watches of a delegation's task threads (what each does now and waits for). */
export async function taskWatches(db: Db | Tx, d: DelegationRow, tasks: readonly DelegationTaskRow[]) {
  const threads = tasks.flatMap((t) => (t.threadId ? [t.threadId] : []));
  if (!threads.length) return [];
  return db
    .select({
      threadId: t3Watches.threadId,
      pending: t3Watches.pending,
      steps: t3Watches.steps,
      program: t3Watches.program,
      state: t3Watches.state,
      status: t3Watches.status,
      progress: t3Watches.progress,
    })
    .from(t3Watches)
    .where(and(eq(t3Watches.connectionId, d.connectionId), inArray(t3Watches.threadId, threads)));
}

/** Whether a delegation is still live: its checklist waits, or its tasks are handed over. */
export const isLive = (d: Pick<DelegationRow, 'stage'>) => d.stage === 'offer' || d.stage === 'working';

/** Whether the task `id` would come after itself through `afterId` (a loop). */
function loops(
  tasks: readonly Pick<DelegationTaskRow, 'id' | 'afterId'>[],
  id: string,
  afterId: string,
): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t.afterId]));
  let at: string | null | undefined = afterId;
  for (let i = 0; at && i <= tasks.length; i++) {
    if (at === id) return true;
    at = byId.get(at);
  }
  return false;
}

/**
 * The card says what the rows say now; the message's own words, the agent's intro, stay above it. Real news while the
 * thread went on under the card moves it to the thread's end (`placeCard`), unless the person's own press brought it
 * (a tick, Hand over, Stop): they are looking at the card. `noteChanged`: search finds the card by its new words too.
 * Answers the message that holds the card now.
 */
export async function refreshCard(
  ctx: ApplyContext,
  delegationId: string,
  noteChanged = false,
): Promise<string | null> {
  const { tx } = ctx;
  const d = await loadDelegation(tx, ctx.burrow.id, delegationId);
  if (!d?.messageId) return null;
  const tasks = await loadTasks(tx, d.id);
  const shots = await tx.select().from(delegationShots).where(eq(delegationShots.delegationId, d.id));
  const card = delegationCard(d, tasks, await taskWatches(tx, d, tasks), shots);
  const before = await loadMessageRow(tx, d.messageId);
  // What the last change to the offered list did stays on the card until Hand over.
  const prior =
    (before?.card as { kind?: string } | null)?.kind === 'delegation'
      ? (before?.card as DelegationCard)
      : null;
  card.changed = changedOf(prior, card, ctx.now);
  if (await councilChecking(tx, d)) card.checking = true;
  // A list the council was looking at is the person's to hand over again: it comes to the end, as news does.
  const released = !!prior?.checking && !card.checking;
  const move = ctx.actor.kind !== 'person' && (cardNews(before?.card, card) || released);
  const at = await placeCard(ctx, d.messageId, card, move);
  if (at && at !== d.messageId)
    await tx.update(delegations).set({ messageId: at }).where(eq(delegations.id, d.id));
  if (noteChanged && at) {
    const { services } = ctx;
    ctx.after(async () => indexMessage(services.db, at));
  }
  return at;
}

/** How long after a council's end its conclusion still takes its tasks onto itself. */
const JOIN_WITHIN_MS = 30 * 60_000;

/**
 * The conclusion a new list joins: the thread's newest message, when it is this agent's own words, without a card,
 * posted when a review or research council in the thread finished (its conclusion), and nobody wrote since.
 */
async function conclusionToJoin(
  ctx: ApplyContext,
  conversationId: string,
  threadRootId: string | null,
): Promise<{ id: string; text: string } | null> {
  if (!threadRootId) return null;
  const { tx } = ctx;
  const [last] = await tx
    .select({
      id: messages.id,
      text: messages.text,
      authorId: messages.authorId,
      card: messages.card,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.threadRootId, threadRootId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.createdAt), desc(messages.ord))
    .limit(1);
  if (!last || last.authorId !== ctx.actor.id || last.card || !last.text.trim()) return null;
  const [ended] = await tx
    .select({ endedAt: councils.endedAt })
    .from(councils)
    .where(
      and(
        eq(councils.conversationId, conversationId),
        eq(councils.threadRootId, threadRootId),
        eq(councils.state, 'done'),
        inArray(councils.kind, ['review', 'research']),
      ),
    )
    .orderBy(desc(councils.endedAt))
    .limit(1);
  const at = ended?.endedAt?.getTime();
  if (at === undefined || last.createdAt.getTime() < at || ctx.now.getTime() - at > JOIN_WITHIN_MS)
    return null;
  return { id: last.id, text: last.text.trim() };
}

/**
 * Whether a council in the list's thread is checking it now: the list waits for Hand over and another council than its
 * own is at work there. Hand over waits for its answer.
 */
export async function councilChecking(tx: Tx, d: DelegationRow): Promise<boolean> {
  if (d.stage !== 'offer') return false;
  const [at] = await tx
    .select({ id: councils.id })
    .from(councils)
    .where(
      and(
        eq(councils.burrowId, d.burrowId),
        eq(councils.conversationId, d.conversationId),
        d.threadRootId ? eq(councils.threadRootId, d.threadRootId) : isNull(councils.threadRootId),
        eq(councils.state, 'active'),
        ...(d.councilId ? [ne(councils.id, d.councilId)] : []),
      ),
    )
    .limit(1);
  return !!at;
}

/**
 * The offered list of a thread, changed where it is when a council there starts or ends, so it says whether Hand over
 * waits for the council's answer.
 */
export async function refreshThreadOffer(
  ctx: ApplyContext,
  conversationId: string,
  threadRootId: string | null,
): Promise<void> {
  const d = await delegationOfThread(ctx.tx, ctx.burrow.id, conversationId, threadRootId);
  if (d?.stage === 'offer' && d.threadRootId === threadRootId) await refreshCard(ctx, d.id);
}

/** The delegation for a change of the agent's: this burrow's, led by this agent. */
async function agentsDelegation(ctx: ApplyContext, delegationId: string): Promise<DelegationRow> {
  if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent changes a delegation.');
  const d = await loadDelegation(ctx.tx, ctx.burrow.id, delegationId);
  if (!d) throw notFound('Delegation');
  if (d.agentId !== ctx.actor.id) throw forbidden('Only the agent that offered it changes it.');
  return d;
}

/** The delegation for a press of the person's: this burrow's. */
async function personsDelegation(ctx: ApplyContext, delegationId: string): Promise<DelegationRow> {
  if (ctx.actor.kind !== 'person') throw forbidden('Only you decide on this card.');
  const d = await loadDelegation(ctx.tx, ctx.burrow.id, delegationId);
  if (!d) throw notFound('Delegation');
  return d;
}

/** States whose task can't be built on: a task coming after one of these would wait for good. */
const DEAD_ENDS: readonly DelegationTaskState[] = ['failed', 'stopped', 'timed_out', 'skipped'];

/** A task the server put after another because both change the same part (DLG-24), for the agent's answer. */
export interface Chained {
  n: number;
  after: number;
  shared: string[];
}

/**
 * New task rows for specs added at the end (`after` numbers count the tasks already there, without the final check,
 * which stays last). A new task that names no task to come after is done with the nearest earlier one it shares a part
 * with (DLG-24, DLG-42).
 */
function newTaskRows(
  d: DelegationRow,
  existing: readonly DelegationTaskRow[],
  input: readonly TaskSpec[],
  state: (spec: TaskSpec) => DelegationTaskState,
  now: Date,
) {
  const specs = input.map((spec) => TaskSpec.parse(spec));
  const ordered = inOrder(existing);
  const ids = specs.map(() => newId('delegationTask'));
  const idAt = (n: number) =>
    (n <= ordered.length ? ordered[n - 1]?.id : ids[n - ordered.length - 1]) ?? null;
  const start = ordered.length ? Math.max(...ordered.map((t) => t.position)) + 1 : 0;
  // Existing tasks keep what they come after; one that can't be built on doesn't chain a new one.
  const overlaps = overlapAfter([
    ...ordered.map((t) => ({ areas: DEAD_ENDS.includes(t.state) ? [] : t.areas, after: 0 })),
    ...specs.map((spec) => ({ areas: spec.areas, after: spec.after })),
  ]);
  const chained: Chained[] = [];
  const rows = specs.map((spec, i) => {
    const id = ids[i] as string;
    const overlap = overlaps[ordered.length + i];
    const afterN = spec.after ?? (overlap ? overlap.index + 1 : null);
    const after = afterN ? idAt(afterN) : null;
    if (!spec.after && overlap && after && after !== id)
      chained.push({ n: ordered.length + i + 1, after: overlap.index + 1, shared: overlap.shared });
    return {
      id,
      delegationId: d.id,
      burrowId: d.burrowId,
      position: start + i,
      title: spec.title,
      why: spec.why,
      brief: spec.brief,
      picked: spec.picked,
      afterId: after && after !== id ? after : null,
      provider: spec.provider,
      model: spec.model,
      modelLabel: spec.modelLabel,
      options: spec.options,
      areas: spec.areas,
      state: state(spec),
      createdAt: now,
    };
  });
  return { rows, chained };
}

/** What Whombat chained, in a line each for the agent. */
export function chainedLines(chained: readonly Chained[]): string[] {
  return chained.map(
    (c) =>
      `Task ${c.n} is done with task ${c.after}, in one thread and one pull request: both change ${c.shared.slice(0, 3).join(', ')} (after: 0 runs it apart).`,
  );
}

/* Offer ---------------------------------------------------------------------------------------------------------- */

export const offerDelegation = defineCommand({
  name: 'delegation.offer',
  schema: z.object({
    id: Id,
    conversationId: Id,
    threadRootId: Id.nullable(),
    personId: Id.nullable(),
    connectionId: Id,
    project: z
      .object({ id: z.string().min(1).max(300), title: z.string().max(200), root: z.string().max(2000) })
      .nullable(),
    title: z.string().min(1).max(DELEGATION_TITLE_MAX),
    intro: z.string().min(1).max(DELEGATION_NOTE_MAX),
    atOnce: z.number().int().min(1).max(DELEGATION_AT_ONCE_MAX),
    pullRequests: z.boolean(),
    merge: z.boolean(),
    tasks: z.array(TaskSpec).min(1).max(DELEGATION_TASKS_MAX),
    start: z.boolean(),
    rules: z.string().min(1).max(DELEGATION_RULES_MAX).nullable().default(null),
    /** The council whose agreed plan these tasks carry out (council.md CNL-60). */
    councilId: Id.nullable().default(null),
  }),
  async apply(tx, ctx, input): Promise<{ delegation: DelegationRow; chained: Chained[]; held: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent offers tasks.');
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const root = input.threadRootId ? await loadMessageRow(tx, input.threadRootId) : null;
    const threadRootId =
      root && root.conversationId === conversation.id ? (root.threadRootId ?? root.id) : null;
    const here = await delegationOfThread(tx, ctx.burrow.id, conversation.id, threadRootId);
    if (here && isLive(here)) throw conflict('busy');
    const [d] = await tx
      .insert(delegations)
      .values({
        id: input.id,
        burrowId: ctx.burrow.id,
        conversationId: conversation.id,
        threadRootId,
        agentId: ctx.actor.id,
        personId: input.personId,
        connectionId: input.connectionId,
        projectId: input.project?.id ?? null,
        projectTitle: input.project?.title ?? null,
        projectRoot: input.project?.root ?? null,
        title: input.title,
        stage: 'offer',
        atOnce: input.atOnce,
        pullRequests: input.pullRequests,
        // Only pull requests can be merged.
        merge: input.merge && input.pullRequests,
        councilId: input.councilId,
        rules: input.rules,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning();
    if (!d) throw new Error('delegation not kept');
    const { rows, chained } = newTaskRows(d, [], input.tasks, () => 'offered', ctx.now);
    for (const row of rows) if (row.afterId && loops(rows, row.id, row.afterId)) row.afterId = null;
    await tx.insert(delegationTasks).values(rows);
    const tasks = await loadTasks(tx, d.id);
    // Right after a review's or research's conclusion, its tasks come on the conclusion itself: one message that says
    // what they found and offers what to do about it, told once.
    const conclusion = input.councilId ? null : await conclusionToJoin(ctx, conversation.id, threadRootId);
    let postedId: string;
    if (conclusion) {
      await joinCard(
        ctx,
        conclusion.id,
        delegationCard(d, tasks, []),
        `${conclusion.text}\n\n${input.intro.trim()}`,
      );
      postedId = conclusion.id;
    } else {
      // The person just asked for it: the checklist isn't news to them (the end is: the agent's summary under it).
      const posted = await postMessage(ctx, {
        conversation,
        text: input.intro.trim(),
        card: delegationCard(d, tasks, []),
        threadRootId,
        dispatch: false,
        notifyDmPerson: false,
      });
      postedId = posted.id;
    }
    await tx.update(delegations).set({ messageId: postedId }).where(eq(delegations.id, d.id));
    // A council's plan: its card waits for the go-ahead, which is this checklist's Hand over (CNL-60).
    // Another council at work in the thread holds even a list the person said to hand over at once.
    const held = !!input.start && (await councilChecking(tx, d));
    if (input.councilId && (!input.start || held)) await councilOffered(ctx, input.councilId);
    if (input.start && !held) await handOver(ctx, { ...d, messageId: postedId }, tasks);
    else await refreshCard(ctx, d.id);
    return { delegation: (await loadDelegation(tx, ctx.burrow.id, d.id)) ?? d, chained, held };
  },
});

/** The ticked tasks are handed over (queued), the others left out (skipped). */
async function handOver(
  ctx: ApplyContext,
  d: DelegationRow,
  tasks: readonly DelegationTaskRow[],
): Promise<void> {
  const { tx } = ctx;
  if (d.stage !== 'offer') throw conflict('handed');
  const offered = tasks.filter((t) => t.state === 'offered');
  const picked = offered.filter((t) => t.picked);
  if (!picked.length) throw conflict('none_picked');
  await tx
    .update(delegationTasks)
    .set({ state: 'queued' })
    .where(
      inArray(
        delegationTasks.id,
        picked.map((t) => t.id),
      ),
    );
  const left = offered.filter((t) => !t.picked);
  if (left.length) {
    await tx
      .update(delegationTasks)
      .set({ state: 'skipped' })
      .where(
        inArray(
          delegationTasks.id,
          left.map((t) => t.id),
        ),
      );
    // A task after one that isn't handed over would wait for good: it starts by itself.
    await tx
      .update(delegationTasks)
      .set({ afterId: null })
      .where(
        and(
          eq(delegationTasks.delegationId, d.id),
          inArray(
            delegationTasks.afterId,
            left.map((t) => t.id),
          ),
        ),
      );
  }
  await tx
    .update(delegations)
    .set({ stage: 'working', handedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(delegations.id, d.id));
  // A council's plan: Hand over is its go-ahead, so the council builds now (CNL-60).
  if (d.councilId) await councilHandedOver(ctx, d.councilId);
  await addFinal(ctx, d);
  await refreshCard(ctx, d.id);
}

/**
 * Reserve one final row outside the ordinary task limit, so full and upgraded automatic lists cannot bypass their
 * combined check. Scratch work and lists the person merges do not need this row.
 */
export async function addFinal(ctx: ApplyContext, d: Pick<DelegationRow, 'id' | 'burrowId'>): Promise<void> {
  const { tx } = ctx;
  const now = await loadDelegation(tx, ctx.burrow.id, d.id);
  if (!now?.merge || !now.pullRequests || !now.projectId) return;
  const tasks = await loadTasks(tx, d.id);
  if (tasks.some(isFinal)) return;
  await tx.insert(delegationTasks).values({
    id: newId('delegationTask'),
    delegationId: d.id,
    burrowId: d.burrowId,
    position: Math.max(0, ...tasks.map((t) => t.position + 1)),
    title: FINAL_TASK.title,
    why: FINAL_TASK.why,
    brief: FINAL_TASK.brief,
    picked: true,
    kind: 'final',
    state: 'queued',
    createdAt: ctx.now,
  });
}

/** Whether Whombat last saw this pull request open. */
async function openPullRequest(tx: Tx, burrowId: string, url: string): Promise<boolean> {
  const [row] = await tx
    .select({ state: pullRequests.state })
    .from(pullRequests)
    .where(and(eq(pullRequests.burrowId, burrowId), sql`lower(${pullRequests.url}) = lower(${url})`))
    .limit(1);
  return row?.state === 'open';
}

/**
 * The final check runs again when more work lands after it ran (tasks added, tried again or sent more work). Tried
 * again on its own (`sameWork`), it keeps its candidate's address and what it combined, so it can carry on with it.
 */
async function finalAgain(ctx: ApplyContext, d: Pick<DelegationRow, 'id'>, sameWork = false): Promise<void> {
  const tasks = await loadTasks(ctx.tx, d.id);
  const final = tasks.find(isFinal);
  if (!final) return;
  // Whombat is merging the checked work on GitHub this moment: what would replace its check waits until it's over.
  if (mergeClaimed(final, ctx.now)) throw conflict(MERGING_NOW);
  const policy = await loadDelegation(ctx.tx, ctx.burrow.id, d.id);
  // What Whombat merged is being put live: its check isn't replaced until that is over.
  if (policy && whombatMerged(final, policy)) throw conflict(DEPLOYING_NOW);
  const needed = !!(policy?.merge && policy.pullRequests);
  // An obsolete run cannot certify a later set of changes. Keep its thread until its stop is acknowledged.
  if (final.threadId && final.state === 'working')
    await ctx.tx
      .update(t3Watches)
      .set({ state: 'idle' })
      .where(and(eq(t3Watches.threadId, final.threadId), eq(t3Watches.burrowId, ctx.burrow.id)));
  await ctx.tx
    .update(delegationTasks)
    .set({
      state: needed ? 'queued' : 'skipped',
      picked: needed,
      answer: null,
      ...(sameWork ? {} : { pr: null, checkedInputs: null }),
      note: null,
      checks: null,
      endedAt: null,
      dispatchId: null,
      mergeState: null,
      mergeAnswer: null,
      checkedRevision: null,
      checkedBase: null,
      checkedGeneration: null,
      checksStuckAt: null,
      mergeClaimedAt: null,
      checkGeneration: sql`${delegationTasks.checkGeneration} + 1`,
      ...(final.state === 'working' ? { stopPending: true } : {}),
    })
    .where(and(eq(delegationTasks.delegationId, d.id), eq(delegationTasks.kind, 'final')));
}

/* The person's presses -------------------------------------------------------------------------------------------- */

export const pickTask = defineCommand({
  name: 'delegation.pick',
  schema: z.object({ delegationId: Id, taskId: Id, picked: z.boolean() }),
  async apply(tx, ctx, input): Promise<{ delegation: DelegationRow }> {
    const d = await personsDelegation(ctx, input.delegationId);
    if (d.stage !== 'offer') throw conflict('These tasks were handed over already.');
    const [task] = await tx
      .update(delegationTasks)
      .set({ picked: input.picked })
      .where(
        and(
          eq(delegationTasks.id, input.taskId),
          eq(delegationTasks.delegationId, d.id),
          eq(delegationTasks.state, 'offered'),
        ),
      )
      .returning({ id: delegationTasks.id });
    if (!task) throw notFound('Task');
    await tx.update(delegations).set({ updatedAt: ctx.now }).where(eq(delegations.id, d.id));
    await refreshCard(ctx, d.id);
    return { delegation: d };
  },
});

/** An AI as T3 Code takes it, checked against what it runs (`council/members.ts` `chosenAi`). */
const AiRow = z.object({
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(80),
  modelLabel: z.string().min(1).max(60),
  options: z.array(
    z.object({ id: z.string().min(1).max(40), value: z.union([z.string().max(40), z.boolean()]) }),
  ),
});

/**
 * The person chose the AI on the checklist: for one task (`taskId`), or for every task without a choice of its own;
 * null goes back to the default (the card's choice for a task, T3 Code's for the card).
 */
export const setDelegationAi = defineCommand({
  name: 'delegation.ai',
  schema: z.object({ delegationId: Id, taskId: Id.nullable(), ai: AiRow.nullable() }),
  async apply(tx, ctx, input): Promise<{ delegation: DelegationRow }> {
    const d = await personsDelegation(ctx, input.delegationId);
    if (d.stage !== 'offer') throw conflict('These tasks were handed over already.');
    const ai = input.ai;
    if (input.taskId) {
      const [task] = await tx
        .update(delegationTasks)
        .set({
          provider: ai?.provider ?? null,
          model: ai?.model ?? null,
          modelLabel: ai?.modelLabel ?? null,
          options: ai?.options ?? null,
        })
        .where(
          and(
            eq(delegationTasks.id, input.taskId),
            eq(delegationTasks.delegationId, d.id),
            eq(delegationTasks.state, 'offered'),
          ),
        )
        .returning({ id: delegationTasks.id });
      if (!task) throw notFound('Task');
    }
    await tx
      .update(delegations)
      .set({
        updatedAt: ctx.now,
        ...(input.taskId
          ? {}
          : {
              aiProvider: ai?.provider ?? null,
              aiModel: ai?.model ?? null,
              aiModelLabel: ai?.modelLabel ?? null,
              aiOptions: ai?.options ?? null,
            }),
      })
      .where(eq(delegations.id, d.id));
    await refreshCard(ctx, d.id);
    return { delegation: d };
  },
});

export const startDelegation = defineCommand({
  name: 'delegation.start',
  schema: z.object({ delegationId: Id }),
  async apply(tx, ctx, input): Promise<{ delegation: DelegationRow }> {
    const d = await personsDelegation(ctx, input.delegationId);
    if (d.stage !== 'offer') throw conflict('These tasks were handed over already.');
    if (await councilChecking(tx, d))
      throw conflict('The council is checking this list. Hand it over once it answers, or stop the council.');
    try {
      await handOver(ctx, d, await loadTasks(tx, d.id));
    } catch (err) {
      if (err instanceof Error && err.message === 'none_picked') throw conflict('Tick a task first.');
      throw err;
    }
    return { delegation: (await loadDelegation(tx, ctx.burrow.id, d.id)) ?? d };
  },
});

/**
 * The threads of tasks that stop now: their watches go quiet, and their stop is kept until T3 Code answers it. A task
 * stopped while merging stays done, its pull request not merged; one waiting to be merged is left for the person.
 */
async function stopTasks(
  ctx: ApplyContext,
  d: DelegationRow,
  stopping: readonly DelegationTaskRow[],
): Promise<DelegationTaskRow[]> {
  const { tx } = ctx;
  // Tasks done together share a thread (DLG-42): stopping one stops the thread, so all of them.
  const all = await loadTasks(tx, d.id);
  const tasks = [...new Map(stopping.flatMap((t) => groupMembers(t, all)).map((t) => [t.id, t])).values()];
  // Whombat is merging the checked work on GitHub this moment: a stop waits until it's over.
  const final = all.find(isFinal);
  if (final && mergeClaimed(final, ctx.now)) throw conflict(MERGING_NOW);
  const working = tasks.filter((t) => t.state === 'working');
  // What Whombat merged and its thread puts live stays merged when that is stopped, with the work it combined.
  const live = working.filter((t) => whombatMerged(t, d));
  const combined = live.length ? eligibleIntegration(all).map((t) => t.id) : [];
  if (live.length) {
    await tx
      .update(delegationTasks)
      .set({
        state: 'done',
        mergeState: 'merged',
        checks: 'passing',
        note: notLive('stopped'),
        endedAt: ctx.now,
        stopPending: true,
      })
      .where(
        inArray(
          delegationTasks.id,
          live.map((t) => t.id),
        ),
      );
    if (combined.length)
      await tx
        .update(delegationTasks)
        .set({ mergeState: 'merged' })
        .where(inArray(delegationTasks.id, combined));
  }
  const merging = working.filter((t) => t.mergeState === 'merging' && !live.includes(t));
  const queued = tasks.filter((t) => t.state === 'queued');
  const waiting = tasks.filter(
    (t) => t.state === 'done' && t.mergeState === 'waiting' && !combined.includes(t.id),
  );
  const atWork = working.filter((t) => t.state === 'working' && t.mergeState !== 'merging');
  if (atWork.length)
    await tx
      .update(delegationTasks)
      .set({ state: 'stopped', endedAt: ctx.now, stopPending: true })
      .where(
        inArray(
          delegationTasks.id,
          atWork.map((t) => t.id),
        ),
      );
  if (merging.length)
    await tx
      .update(delegationTasks)
      .set({ state: 'done', mergeState: 'not_merged', endedAt: ctx.now, stopPending: true })
      .where(
        inArray(
          delegationTasks.id,
          merging.map((t) => t.id),
        ),
      );
  if (waiting.length)
    await tx
      .update(delegationTasks)
      .set({ mergeState: 'kept' })
      .where(
        inArray(
          delegationTasks.id,
          waiting.map((t) => t.id),
        ),
      );
  if (queued.length)
    await tx
      .update(delegationTasks)
      .set({ state: 'stopped' })
      .where(
        inArray(
          delegationTasks.id,
          queued.map((t) => t.id),
        ),
      );
  const idle = [...new Set(working.flatMap((t) => (t.threadId ? [t.threadId] : [])))];
  if (idle.length)
    await tx
      .update(t3Watches)
      .set({ state: 'idle' })
      .where(and(eq(t3Watches.connectionId, d.connectionId), inArray(t3Watches.threadId, idle)));
  return working;
}

export const stopTaskByPerson = defineCommand({
  name: 'delegation.stop_task',
  schema: z.object({ delegationId: Id, taskId: Id }),
  async apply(tx, ctx, input): Promise<{ delegation: DelegationRow; working: DelegationTaskRow[] }> {
    const d = await personsDelegation(ctx, input.delegationId);
    const tasks = await loadTasks(tx, d.id);
    const task = tasks.find((t) => t.id === input.taskId);
    if (!task) throw notFound('Task');
    const waitsToMerge = task.state === 'done' && task.mergeState === 'waiting';
    if (d.stage !== 'working' || (task.state !== 'working' && task.state !== 'queued' && !waitsToMerge))
      return { delegation: d, working: [] };
    const working = await stopTasks(ctx, d, [task]);
    if (!isFinal(task)) await finalAgain(ctx, d);
    await tx.update(delegations).set({ updatedAt: ctx.now }).where(eq(delegations.id, d.id));
    await refreshCard(ctx, d.id);
    // The last one stopped: the agent sums it up (the person pressed only this one).
    if (allOver(await loadTasks(tx, d.id), d.integrationMode === 'batch'))
      await wakeFor(ctx, d, [task.id], true);
    return { delegation: d, working };
  },
});

export const stopDelegation = defineCommand({
  name: 'delegation.stop',
  schema: z.object({ delegationId: Id }),
  async apply(tx, ctx, input): Promise<{ delegation: DelegationRow; working: DelegationTaskRow[] }> {
    const d = await personsDelegation(ctx, input.delegationId);
    if (!isLive(d)) return { delegation: d, working: [] };
    // The person pressed it: nothing to tell them.
    const working = await endDelegation(ctx, d, {
      stopped: true,
      note: d.stage === 'offer' ? DELEGATION_TEXT.notNow : DELEGATION_TEXT.stopped,
    });
    // A council's plan put aside before it was handed over: the council ends there too (CNL-60).
    if (d.councilId && d.stage === 'offer') await councilPutAside(ctx, d.councilId);
    return { delegation: (await loadDelegation(tx, ctx.burrow.id, d.id)) ?? d, working };
  },
});

/* Running the tasks ------------------------------------------------------------------------------------------------ */

/**
 * A task whose turn came, and the branch it starts from (the task it comes after); `send`: it ran before and gets more
 * work in its own thread now (DLG-25), instead of a new thread.
 */
export interface ClaimedTask {
  task: DelegationTaskRow;
  base: string | null;
  send: string | null;
  /** Tasks done in its thread after it, on its branch and in its pull request (DLG-42). */
  with: DelegationTaskRow[];
}

export const claimTasks = defineCommand({
  name: 'delegation.claim',
  schema: z.object({ delegationId: Id }),
  async apply(tx, ctx, input): Promise<{ delegation: DelegationRow; claimed: ClaimedTask[] }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent starts a delegation’s tasks.');
    const d = await loadDelegation(tx, ctx.burrow.id, input.delegationId);
    if (d?.stage !== 'working') return { delegation: d as DelegationRow, claimed: [] };
    await addFinal(ctx, d);
    const tasks = await loadTasks(tx, d.id);
    // Waiting for its checks holds no place (DLG-21).
    const free = d.atOnce - busyTasks(tasks).length;
    let ready = readyTasks(tasks, d.integrationMode === 'batch').filter(
      (t) => !isFinal(t) || (d.merge && d.pullRequests),
    );
    if (ready.some(isFinal)) {
      // A combined candidate owns the repository until its merge ends, including the gap between its two runs.
      const others = await tx
        .select({ id: delegationTasks.id })
        .from(delegationTasks)
        .innerJoin(delegations, eq(delegations.id, delegationTasks.delegationId))
        .where(
          and(
            eq(delegations.burrowId, d.burrowId),
            eq(delegations.connectionId, d.connectionId),
            eq(delegations.projectId, d.projectId as string),
            sql`${delegations.id} <> ${d.id}`,
            eq(delegations.stage, 'working'),
            eq(delegationTasks.kind, 'final'),
            or(
              eq(delegationTasks.state, 'working'),
              eq(delegationTasks.stopPending, true),
              and(eq(delegationTasks.state, 'done'), eq(delegationTasks.mergeState, 'waiting')),
            ),
          ),
        );
      if (others.length) ready = ready.filter((t) => !isFinal(t));
    }
    // Work sent to a task that ran first: it is the oldest in line.
    const next = [...ready.filter((t) => t.sendPending), ...ready.filter((t) => !t.sendPending)];
    if (!next.length || free <= 0) return { delegation: d, claimed: [] };
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const numbers = numbersOf(tasks);
    const claimed: ClaimedTask[] = [];
    // A task another thread took along holds no place of its own.
    const taken = new Set<string>();
    for (const t of next) {
      if (claimed.length >= free) break;
      if (taken.has(t.id)) continue;
      if (t.sendPending && t.threadId) {
        const memberIds = groupMembers(t, tasks).map((m) => m.id);
        const [row] = await tx
          .update(delegationTasks)
          .set({
            state: 'working',
            sendPending: null,
            endedAt: null,
            dispatchId: null,
            checks: null,
            deadline: null,
          })
          .where(inArray(delegationTasks.id, memberIds))
          .returning();
        if (!row) continue;
        await rearmWatch(ctx, d, t.threadId, t.id);
        claimed.push({ task: row, base: null, send: t.sendPending, with: [] });
        continue;
      }
      const attempt = t.attempt + 1;
      // All the work in one pull request: the final check checks that one itself.
      const single = isFinal(t) && d.integrationMode === 'batch' ? onePullRequest(tasks) : null;
      // A final check started again on the same work carries on with its open candidate, whose checks may already
      // pass, rather than building and checking a copy of it.
      const again =
        isFinal(t) && !single && t.pr && t.branch && t.checkedInputs === inputFingerprint(tasks)
          ? await openPullRequest(tx, d.burrowId, t.pr).then((open) =>
              open ? { pr: t.pr as string, branch: t.branch as string } : null,
            )
          : null;
      const branch = again ? again.branch : d.projectId ? taskBranch(t.title, t.id, attempt) : null;
      // Every task waiting that fits its AI and merge choice is led by its thread, on its branch; a list handed over
      // before one thread led them all keeps doing only the tasks after it there.
      const mates = isFinal(t)
        ? []
        : d.integrationMode === 'batch'
          ? leadsWith(t, tasks, d)
          : togetherWith(t, tasks, d);
      const groupId = newId('delegationTask');
      const start = (task: DelegationTaskRow) =>
        tx
          .update(delegationTasks)
          .set({
            state: 'working',
            groupId,
            // The number its thread is told and reports on it by, whatever the card's order becomes.
            item: numbers.get(task.id) ?? null,
            attempt: task.attempt + 1,
            threadId: null,
            url: null,
            worktree: null,
            branch,
            pr: isFinal(task) ? (single?.pr ?? again?.pr ?? null) : null,
            answer: null,
            checks: null,
            checksStuckAt: null,
            ...(!(task.provider && task.model) && d.aiProvider && d.aiModel
              ? {
                  provider: d.aiProvider,
                  model: d.aiModel,
                  modelLabel: d.aiModelLabel,
                  options: d.aiOptions,
                }
              : {}),
            ...(isFinal(task)
              ? {
                  checkedInputs: inputFingerprint(tasks),
                  checkedGeneration: task.checkGeneration,
                  checkedRevision: null,
                  checkedBase: null,
                }
              : {}),
            // A new run's pull request is new: merged as the delegation says, unless the person keeps it.
            mergeState: task.mergeState === 'kept' ? 'kept' : null,
            mergeAnswer: null,
            dispatchId: null,
            startedAt: ctx.now,
            endedAt: null,
            deadline: null,
          })
          .where(and(eq(delegationTasks.id, task.id), eq(delegationTasks.state, 'queued')))
          .returning();
      const [row] = await start(t);
      if (!row) continue;
      const withRows: DelegationTaskRow[] = [];
      for (const m of mates) {
        taken.add(m.id);
        const [mate] = await start(m);
        if (mate) withRows.push(mate);
      }
      // After a task that was merged: from the default branch as it is now (the brief brings it up to date), else from
      // that task's branch.
      const before = t.afterId ? byId.get(t.afterId) : undefined;
      claimed.push({
        task: row,
        base: before && before.mergeState !== 'merged' ? before.branch : null,
        send: null,
        with: withRows,
      });
    }
    await tx.update(delegations).set({ updatedAt: ctx.now }).where(eq(delegations.id, d.id));
    await refreshCard(ctx, d.id);
    return { delegation: d, claimed };
  },
});

export const taskLaunched = defineCommand({
  name: 'delegation.launched',
  schema: z.object({
    delegationId: Id,
    taskId: Id,
    /** Tasks done in the same thread (DLG-42). */
    withIds: z.array(Id).max(DELEGATION_TASKS_MAX).default([]),
    threadId: ThreadId,
    title: z.string().min(1).max(160),
    url: z.string().max(2000).nullable(),
    worktree: z.string().max(2000).nullable(),
  }),
  async apply(tx, ctx, input): Promise<{ cancelled: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent starts a delegation’s tasks.');
    const d = await loadDelegation(tx, ctx.burrow.id, input.delegationId);
    if (!d) throw notFound('Delegation');
    const tasks = await loadTasks(tx, d.id);
    const task = tasks.find((t) => t.id === input.taskId);
    const members = task ? groupMembers(task, tasks) : [];
    // Stopped while T3 Code was starting it: the new thread is stopped at once.
    const cancelled =
      d.stage !== 'working' ||
      task?.state !== 'working' ||
      members.some((t) => t.state !== 'working' || t.stopPending) ||
      input.withIds.some((id) => !members.some((t) => t.id === id));
    await tx
      .update(delegationTasks)
      .set({
        threadId: input.threadId,
        url: input.url,
        worktree: input.worktree,
        ...(cancelled ? { stopPending: true } : {}),
      })
      .where(and(eq(delegationTasks.id, input.taskId), eq(delegationTasks.delegationId, d.id)));
    if (members.length > 1)
      await tx
        .update(delegationTasks)
        .set({
          threadId: input.threadId,
          url: input.url,
          worktree: input.worktree,
          ...(cancelled ? { stopPending: true } : {}),
        })
        .where(
          and(
            inArray(
              delegationTasks.id,
              members.map((t) => t.id),
            ),
            eq(delegationTasks.delegationId, d.id),
          ),
        );
    if (cancelled) return { cancelled: true };
    const watch = {
      conversationId: d.conversationId,
      threadRootId: d.threadRootId,
      agentId: d.agentId,
      personId: d.personId,
      // A question or a permission request of a task wakes the agent as any hand-over's does.
      wakes: true,
      state: 'watching' as const,
      armedAt: ctx.now,
      councilId: null,
      delegationTaskId: input.taskId,
      title: input.title,
      status: null,
      pending: null,
      asks: null,
      steps: null,
      prs: null,
      runStartedAt: null,
      runEndedAt: null,
      url: input.url,
    };
    await tx
      .insert(t3Watches)
      .values({ burrowId: d.burrowId, connectionId: d.connectionId, threadId: input.threadId, ...watch })
      .onConflictDoUpdate({ target: [t3Watches.connectionId, t3Watches.threadId], set: watch });
    await refreshCard(ctx, d.id);
    return { cancelled: false };
  },
});

export const taskLaunchFailed = defineCommand({
  name: 'delegation.launch_failed',
  schema: z.object({
    delegationId: Id,
    taskId: Id,
    withIds: z.array(Id).max(DELEGATION_TASKS_MAX).default([]),
  }),
  async apply(tx, ctx, input): Promise<{ dispatchId: string | null }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent starts a delegation’s tasks.');
    const d = await loadDelegation(tx, ctx.burrow.id, input.delegationId);
    if (!d) throw notFound('Delegation');
    // A cancelled launch that created no thread has nothing left to stop. Release its durable stop guard.
    await tx
      .update(delegationTasks)
      .set({ stopPending: false, stopTries: 0, stopNextAt: null })
      .where(
        and(
          inArray(delegationTasks.id, [input.taskId, ...input.withIds]),
          eq(delegationTasks.delegationId, d.id),
          isNull(delegationTasks.threadId),
          eq(delegationTasks.stopPending, true),
          inArray(delegationTasks.state, ['queued', 'stopped']),
        ),
      );
    const [task] = await tx
      .update(delegationTasks)
      .set({ state: 'failed', endedAt: ctx.now })
      .where(
        and(
          inArray(delegationTasks.id, [input.taskId, ...input.withIds]),
          eq(delegationTasks.delegationId, d.id),
          eq(delegationTasks.state, 'working'),
        ),
      )
      .returning();
    if (!task || d.stage !== 'working') return { dispatchId: null };
    await refreshCard(ctx, d.id);
    return {
      dispatchId: await wakeFor(
        ctx,
        d,
        [task.id],
        allOver(await loadTasks(tx, d.id), d.integrationMode === 'batch'),
      ),
    };
  },
});

export const taskEnded = defineCommand({
  name: 'delegation.task_ended',
  schema: z.object({
    delegationId: Id,
    threadId: ThreadId,
    state: z.enum(['done', 'failed', 'stopped', 'timed_out']),
    answer: z.string().max(DELEGATION_ANSWER_MAX).nullable(),
    pr: z.string().max(500).nullable(),
    /** T3 Code says its pull request is merged; null: it doesn't know (the answer's `Merged:` line decides). */
    merged: z.boolean().nullable().default(null),
    /** What its answer's `Checks:` line says (DLG-20); null: it said nothing. */
    checks: z.enum(['passing', 'none', 'failing']).nullable().default(null),
    verification: DelegationVerification.nullable().default(null),
    verified: z.boolean().default(false),
    watching: z.boolean().default(false),
    /** The line for the person when the thread can't give one (T3 Code no longer has it). */
    note: z.string().max(DELEGATION_TASK_NOTE_MAX).nullable().default(null),
  }),
  async apply(tx, ctx, input): Promise<{ handled: boolean; dispatchId: string | null; settle: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent hears from a delegation’s threads.');
    const d = await loadDelegation(tx, ctx.burrow.id, input.delegationId);
    if (!d) return { handled: false, dispatchId: null, settle: false };
    const rows = await tx
      .select()
      .from(delegationTasks)
      .where(
        and(
          eq(delegationTasks.delegationId, d.id),
          eq(delegationTasks.threadId, input.threadId),
          eq(delegationTasks.state, 'working'),
        ),
      );
    // Tasks done together end together (DLG-42); the first of them speaks for the thread.
    const working = inOrder(rows).find((r) => !rows.some((x) => x.id === r.afterId)) ?? inOrder(rows)[0];
    // A thread no task waits for any more (the agent sent it work itself): the ordinary watch tells it.
    if (!working) return { handled: false, dispatchId: null, settle: false };
    const answer = input.answer?.trim() || null;
    const pr = input.pr ?? working.pr;
    // Its merge ended: merged when T3 Code or the thread's last line says so; else its pull request stays open.
    const merge = working.mergeState === 'merging';
    // The final check merges its own fix, if it made one (DLG-41).
    const final = isFinal(working);
    const proof = final ? (merge ? verificationOf(working.answer) : input.verification) : null;
    const currentTasks = await loadTasks(tx, d.id);
    const certified =
      final &&
      input.verified &&
      verificationPassed(proof, inputFingerprint(currentTasks), working.checkGeneration) &&
      proof?.inputs === working.checkedInputs &&
      proof?.generation === working.checkedGeneration;
    // What Whombat merged itself is merged however its thread's putting it live ended.
    const live = merge && whombatMerged(working, d);
    const saidMerged = live
      ? true
      : final
        ? certified && input.merged === true
        : input.merged === true ||
          (input.merged === null && input.state === 'done' && saysMerged(answer) === true);
    const red = !merge && input.state === 'done' && (input.checks === 'failing' || (final && !certified));
    const kept = rows.some((r) => r.mergeState === 'kept');
    const waits =
      !merge &&
      !red &&
      input.state === 'done' &&
      d.merge &&
      !!pr &&
      !kept &&
      (!final || (d.integrationMode === 'batch' && certified && input.merged !== true));
    const merged = (merge || final) && saidMerged;
    const finalUnmerged = final && input.state === 'done' && !waits && !merged;
    // The line for the person its thread ended with goes on its row unless the agent wrote one (DLG-26).
    const note = live
      ? input.state === 'done'
        ? (noteOf(answer, DELEGATION_TASK_NOTE_MAX) ?? 'The checked work has been merged.')
        : input.merged === true && input.note
          ? input.note
          : notLive(input.state)
      : input.note
        ? input.note
        : final && !certified
          ? 'The combined check could not be confirmed. The work is still incomplete.'
          : final && certified
            ? noteOf(answer, DELEGATION_TASK_NOTE_MAX)
            : !merge && (!working.note || working.note === CHECKS_STUCK_NOTE)
              ? noteOf(answer, DELEGATION_TASK_NOTE_MAX)
              : null;
    const ids = rows.map((r) => r.id);
    // A thread that led several items says how each went, by the number it was given for it. What it said while it
    // worked (“Item 3 done: …”) counts for an item its last answer left out.
    const numbers = itemNumbersOf(currentTasks);
    const several = !merge && !final && rows.length > 1;
    const items = several ? itemsOf(answer, DELEGATION_TASK_NOTE_MAX) : new Map<number, ItemSaid>();
    const reported = several ? await reportedOf(tx, d.connectionId, input.threadId) : {};
    // More work sent to the thread: an item its new answer leaves alone keeps how its earlier answer said it went
    // (each row keeps the answer it had; the one the work was sent for had it cleared, so it must say again).
    const beforeOf = (id: string): ItemSaid | undefined => {
      const row = rows.find((r) => r.id === id);
      return several && row?.answer
        ? itemsOf(row.answer, DELEGATION_TASK_NOTE_MAX).get(numbers.get(id) ?? 0)
        : undefined;
    };
    const itemOf = (id: string): ItemSaid | undefined => {
      const n = numbers.get(id) ?? 0;
      const line = reported[String(n)];
      return items.get(n) ?? (line ? { note: line, done: true } : undefined) ?? beforeOf(id);
    };
    // Those kept lines go on with the answer, so a later follow-up still finds them.
    const carried = several
      ? rows.flatMap((r) => {
          const n = numbers.get(r.id);
          const said = n && !items.has(n) ? itemOf(r.id) : undefined;
          return n && said ? [`Item ${n}: ${said.done ? '' : 'not done: '}${said.note}`] : [];
        })
      : [];
    const stored = carried.length
      ? `${answer ?? ''}\n\nEarlier, for the items this answer didn’t mention:\n${carried.join('\n')}`.trim()
      : answer;
    await tx
      .update(delegationTasks)
      .set({
        ...(merge
          ? {
              state: 'done',
              mergeState: merged ? 'merged' : 'not_merged',
              mergeAnswer: answer,
              // Merged by Whombat: the claim stays however putting it live went, so trying again puts it live.
              mergeClaimedAt: live ? working.mergeClaimedAt : null,
              checks: final
                ? certified || live
                  ? 'passing'
                  : 'failing'
                : merged
                  ? ('passing' as const)
                  : working.checks === 'running'
                    ? null
                    : working.checks,
            }
          : {
              state: final && input.state === 'done' && !certified ? 'failed' : input.state,
              answer: stored,
              checks: final ? (certified ? 'passing' : 'failing') : input.checks,
              mergeState: final
                ? merged
                  ? 'merged'
                  : waits
                    ? 'waiting'
                    : 'not_merged'
                : waits
                  ? 'waiting'
                  : kept
                    ? 'kept'
                    : null,
            }),
        ...(input.pr ? { pr: input.pr } : {}),
        ...(final && certified && proof ? { checkedRevision: proof.revision, checkedBase: proof.base } : {}),
        endedAt: ctx.now,
        // Ran out of time: its thread is stopped, and tried again until T3 Code answers.
        ...(input.state === 'timed_out' ? { stopPending: true } : {}),
      })
      .where(inArray(delegationTasks.id, ids));
    if (final && merged) {
      const integrated = eligibleIntegration(currentTasks).map((t) => t.id);
      if (integrated.length)
        await tx
          .update(delegationTasks)
          .set({ mergeState: 'merged' })
          .where(inArray(delegationTasks.id, integrated));
    }
    // A legacy merge already in flight may finish during rollout; its result needs a fresh combined check.
    if (!final && merge && merged) await finalAgain(ctx, d);
    if ((note || (final && certified)) && !itemOf(working.id))
      await tx.update(delegationTasks).set({ note }).where(eq(delegationTasks.id, working.id));
    // Each item's own line on its row, unless the agent wrote one; an item the thread didn't do needs a look, and stays
    // out of what is combined and merged.
    // An item it said nothing about isn't known to be done: it needs a look as one it didn't do.
    const notDone: string[] = [];
    for (const r of rows) {
      const said = several && input.state === 'done' ? (itemOf(r.id) ?? UNSAID_ITEM) : itemOf(r.id);
      if (!said) continue;
      if (!said.done && input.state === 'done') notDone.push(r.id);
      if (!r.note || said === UNSAID_ITEM)
        await tx.update(delegationTasks).set({ note: said.note }).where(eq(delegationTasks.id, r.id));
    }
    if (notDone.length)
      await tx
        .update(delegationTasks)
        .set({ state: 'failed', mergeState: null })
        .where(inArray(delegationTasks.id, notDone));
    await tx
      .update(t3Watches)
      .set({ state: input.watching ? 'watching' : 'idle', ...(input.watching ? { wakes: false } : {}) })
      .where(and(eq(t3Watches.connectionId, d.connectionId), eq(t3Watches.threadId, input.threadId)));
    // Batch source work is merged by the final thread; only a thread that will itself merge needs keeping.
    const settle = !waits || (d.integrationMode === 'batch' && !final);
    if (d.stage !== 'working') return { handled: true, dispatchId: null, settle };
    await tx.update(delegations).set({ updatedAt: ctx.now }).where(eq(delegations.id, d.id));
    await refreshCard(ctx, d.id);
    // The agent is woken when this end needs judgment, and once all are over (DLG-26).
    // A pull request whose thread didn't say how its checks went can't be combined until someone looks.
    const checksUnsaid = d.integrationMode === 'batch' && !merge && !final && waits && input.checks === null;
    const judgment =
      input.state !== 'done' ||
      red ||
      (merge && !merged) ||
      finalUnmerged ||
      notDone.length > 0 ||
      checksUnsaid;
    const over = allOver(await loadTasks(tx, d.id), d.integrationMode === 'batch');
    if (!over && !judgment) return { handled: true, dispatchId: null, settle };
    return {
      handled: true,
      dispatchId: await wakeFor(ctx, d, [...new Set([working.id, ...notDone])], over),
      settle,
    };
  },
});

/** Preserve a finished review while its independent evidence is unavailable or its checks still run. */
export const awaitFinalVerification = defineCommand({
  name: 'delegation.await_verification',
  schema: z.object({
    delegationId: Id,
    taskId: Id,
    threadId: ThreadId,
    answer: z.string().max(DELEGATION_ANSWER_MAX).nullable(),
    pr: z.string().max(500).nullable(),
    message: z.string().min(1).max(DELEGATION_TASK_NOTE_MAX),
    blocked: z.boolean(),
  }),
  async apply(tx, ctx, input): Promise<void> {
    const d = await agentsDelegation(ctx, input.delegationId);
    if (d.stage !== 'working') return;
    const task = (await loadTasks(tx, d.id)).find((t) => t.id === input.taskId);
    if (
      !task ||
      !isFinal(task) ||
      task.threadId !== input.threadId ||
      !(task.state === 'working' || (task.state === 'done' && task.mergeState === 'waiting'))
    )
      return;
    await tx
      .update(delegationTasks)
      .set({
        state: 'working',
        checks: 'running',
        answer: input.answer,
        ...(input.pr ? { pr: input.pr } : {}),
        note: input.message,
        endedAt: null,
      })
      .where(eq(delegationTasks.id, task.id));
    await tx
      .update(t3Watches)
      .set({ state: 'watching', armedAt: ctx.now })
      .where(
        and(
          eq(t3Watches.connectionId, d.connectionId),
          eq(t3Watches.threadId, input.threadId),
          eq(t3Watches.delegationTaskId, task.id),
        ),
      );
    if (task.checks !== 'running' || task.note !== input.message) await refreshCard(ctx, d.id);
    // An access or service problem needs judgment once; another read of the same blocker needs no new turn.
    if (input.blocked && task.note !== input.message) await wakeFor(ctx, d, [task.id]);
  },
});

/** Independent GitHub verification confirmed that someone already merged the exact checked candidate. */
export const checkedCandidateMerged = defineCommand({
  name: 'delegation.checked_candidate_merged',
  schema: z.object({ delegationId: Id, taskId: Id, revision: z.string().min(1) }),
  async apply(tx, ctx, input): Promise<void> {
    const d = await agentsDelegation(ctx, input.delegationId);
    if (d.stage !== 'working') return;
    const tasks = await loadTasks(tx, d.id);
    const task = tasks.find((t) => t.id === input.taskId && isFinal(t));
    if (
      task?.state !== 'done' ||
      task.mergeState !== 'waiting' ||
      task.checkedRevision !== input.revision ||
      task.checkedInputs !== inputFingerprint(tasks) ||
      task.checkedGeneration !== task.checkGeneration ||
      !verificationPassed(verificationOf(task.answer), task.checkedInputs, task.checkGeneration)
    )
      return;
    const ids = [task.id, ...eligibleIntegration(tasks).map((t) => t.id)];
    await tx.update(delegationTasks).set({ mergeState: 'merged' }).where(inArray(delegationTasks.id, ids));
    await tx.update(delegationTasks).set({ mergeClaimedAt: null }).where(eq(delegationTasks.id, task.id));
    await tx
      .update(delegationTasks)
      .set({ note: 'The checked work has been merged.' })
      .where(eq(delegationTasks.id, task.id));
    await tx.update(delegations).set({ note: null, updatedAt: ctx.now }).where(eq(delegations.id, d.id));
    await refreshCard(ctx, d.id);
    await wakeFor(ctx, d, [task.id], allOver(await loadTasks(tx, d.id), d.integrationMode === 'batch'));
  },
});

/**
 * GitHub refused to merge a checked candidate (the repository's rules, a review it requires, a conflict): it stays
 * open, the row says why, and the agent is woken to tell the person.
 */
export const finalMergeRefused = defineCommand({
  name: 'delegation.final_merge_refused',
  schema: z.object({
    delegationId: Id,
    taskId: Id,
    revision: z.string().min(1),
    message: z.string().max(2000),
  }),
  async apply(tx, ctx, input): Promise<void> {
    const d = await agentsDelegation(ctx, input.delegationId);
    if (d.stage !== 'working') return;
    const reason = input.message.trim().replace(/\s+/g, ' ');
    const note = reason ? `GitHub didn’t merge it: ${reason}` : 'GitHub didn’t merge it.';
    const [task] = await tx
      .update(delegationTasks)
      .set({
        mergeState: 'not_merged',
        mergeClaimedAt: null,
        note:
          note.length > DELEGATION_TASK_NOTE_MAX ? `${note.slice(0, DELEGATION_TASK_NOTE_MAX - 1)}…` : note,
      })
      .where(
        and(
          eq(delegationTasks.id, input.taskId),
          eq(delegationTasks.delegationId, d.id),
          eq(delegationTasks.kind, 'final'),
          eq(delegationTasks.state, 'done'),
          eq(delegationTasks.mergeState, 'waiting'),
          eq(delegationTasks.checkedRevision, input.revision),
        ),
      )
      .returning();
    if (!task) return;
    await refreshCard(ctx, d.id);
    await wakeFor(ctx, d, [task.id], allOver(await loadTasks(tx, d.id), d.integrationMode === 'batch'));
  },
});

/** How long a merge claim holds: a merge on GitHub takes seconds; one older is a restart's, and is let go. */
export const MERGE_CLAIM_MS = 3 * 60_000;
const MERGING_NOW = 'The checked work is being merged on GitHub right now. Try again in a moment.';
const DEPLOYING_NOW =
  'The checked work is merged and being put live right now. Change the list once that’s over.';
/** More work for the thread that puts what Whombat merged live, when the person tries that again. */
export const DEPLOY_AGAIN =
  'Put the merged work live again, the same way as before. Never deploy to production. End with this line: Note: <one short sentence for the person about whether it is live>';

/** Whether Whombat is merging this waiting candidate on GitHub now (a fresh claim, before the merge is recorded). */
export function mergeClaimed(
  t: Pick<DelegationTaskRow, 'mergeClaimedAt' | 'state' | 'mergeState'>,
  now: Date,
): boolean {
  return (
    t.state === 'done' &&
    t.mergeState === 'waiting' &&
    !!t.mergeClaimedAt &&
    now.getTime() - t.mergeClaimedAt.getTime() < MERGE_CLAIM_MS
  );
}

/**
 * A combined check's candidate Whombat merged whose thread puts it live now: its row works on, and however that ends
 * (done, failed, stopped, its thread gone) the work stays merged. Only Whombat's own merge leaves a claim on a merging
 * final row of a combined list.
 */
export function whombatMerged(
  t: Pick<DelegationTaskRow, 'kind' | 'mergeClaimedAt' | 'mergeState'>,
  d: Pick<DelegationRow, 'integrationMode'>,
): boolean {
  return d.integrationMode === 'batch' && isFinal(t) && t.mergeState === 'merging' && !!t.mergeClaimedAt;
}

/** The final row's line when what Whombat merged wasn't put live: how its thread's run ended. */
function notLive(state: string): string {
  return state === 'stopped'
    ? 'It is merged; putting it live was stopped.'
    : 'It is merged, but putting it live didn’t finish.';
}

/**
 * Whombat is about to merge a combined check's candidate on GitHub: claimed only while it is the current, checked,
 * waiting candidate of a list that merges (its generation, its inputs, the revision that was verified, no stop), and no
 * other merge of it is going on. Until it is let go, changes that would replace its check wait.
 */
export const claimFinalMerge = defineCommand({
  name: 'delegation.claim_final_merge',
  schema: z.object({ delegationId: Id, taskId: Id, revision: z.string().min(1) }),
  async apply(tx, ctx, input): Promise<{ claimed: boolean; at: string | null }> {
    const d = await agentsDelegation(ctx, input.delegationId);
    if (d.stage !== 'working' || !d.merge || d.integrationMode !== 'batch')
      return { claimed: false, at: null };
    const tasks = await loadTasks(tx, d.id);
    const final = tasks.find((t) => t.id === input.taskId && isFinal(t));
    if (
      final?.state !== 'done' ||
      final.mergeState !== 'waiting' ||
      final.stopPending ||
      final.checkedRevision !== input.revision ||
      final.checkedInputs !== inputFingerprint(tasks) ||
      final.checkedGeneration !== final.checkGeneration ||
      mergeClaimed(final, ctx.now)
    )
      return { claimed: false, at: null };
    await tx.update(delegationTasks).set({ mergeClaimedAt: ctx.now }).where(eq(delegationTasks.id, final.id));
    return { claimed: true, at: ctx.now.toISOString() };
  },
});

/** The merge on GitHub is over (or its answer was lost): changes may replace the check again. */
export const releaseFinalMerge = defineCommand({
  name: 'delegation.release_final_merge',
  schema: z.object({ delegationId: Id, taskId: Id, at: z.string().datetime() }),
  async apply(tx, ctx, input): Promise<void> {
    const d = await agentsDelegation(ctx, input.delegationId);
    // Only its own claim: a later one (after this one ran out) is another merge's.
    await tx
      .update(delegationTasks)
      .set({ mergeClaimedAt: null })
      .where(
        and(
          eq(delegationTasks.id, input.taskId),
          eq(delegationTasks.delegationId, d.id),
          eq(delegationTasks.mergeClaimedAt, new Date(input.at)),
        ),
      );
  },
});

/** Waiting for remote checks holds no running place; a new T3 run holds a place again. */
export const taskChecks = defineCommand({
  name: 'delegation.checks',
  schema: z.object({
    delegationId: Id,
    threadId: ThreadId,
    waiting: z.boolean(),
    pr: z.string().max(500).nullable().default(null),
  }),
  async apply(tx, ctx, input): Promise<{ changed: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent hears from a delegation’s threads.');
    const d = await loadDelegation(tx, ctx.burrow.id, input.delegationId);
    if (!d) return { changed: false };
    const [row] = await tx
      .update(delegationTasks)
      .set({ checks: input.waiting ? 'running' : null, ...(input.pr ? { pr: input.pr } : {}) })
      .where(
        and(
          eq(delegationTasks.delegationId, d.id),
          eq(delegationTasks.threadId, input.threadId),
          eq(delegationTasks.state, 'working'),
          input.waiting
            ? sql`${delegationTasks.checks} is distinct from 'running'`
            : eq(delegationTasks.checks, 'running'),
        ),
      )
      .returning({ id: delegationTasks.id });
    if (!row) return { changed: false };
    await refreshCard(ctx, d.id);
    return { changed: true };
  },
});

/**
 * The combined check's checks have waited to start longer than they should (the watcher reads it from GitHub): its row
 * says so and the agent is woken to look at the CI, once per wait; a wait that began later (checks asked for again)
 * tells it again. Nobody is told while the checks merely run.
 */
export const checksStuck = defineCommand({
  name: 'delegation.checks_stuck',
  schema: z.object({
    delegationId: Id,
    taskId: Id,
    since: z.string().datetime(),
    names: z.array(z.string().min(1).max(200)).max(20),
    /** The checks started after all: the row's line about them goes. */
    clear: z.boolean().default(false),
  }),
  async apply(tx, ctx, input): Promise<{ dispatchId: string | null }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent hears from a delegation’s checks.');
    const d = await loadDelegation(tx, ctx.burrow.id, input.delegationId);
    if (d?.stage !== 'working') return { dispatchId: null };
    const [task] = await tx
      .select()
      .from(delegationTasks)
      .where(and(eq(delegationTasks.id, input.taskId), eq(delegationTasks.delegationId, d.id)));
    if (!task || !isFinal(task) || task.state !== 'working') return { dispatchId: null };
    if (input.clear) {
      if (task.note === CHECKS_STUCK_NOTE) {
        await tx.update(delegationTasks).set({ note: null }).where(eq(delegationTasks.id, task.id));
        await refreshCard(ctx, d.id);
      }
      return { dispatchId: null };
    }
    const since = new Date(input.since);
    if (task.checksStuckAt && task.checksStuckAt.getTime() >= since.getTime()) return { dispatchId: null };
    await tx
      .update(delegationTasks)
      .set({ checksStuckAt: since, note: CHECKS_STUCK_NOTE })
      .where(eq(delegationTasks.id, task.id));
    await refreshCard(ctx, d.id);
    return { dispatchId: await wakeFor(ctx, d, [task.id]) };
  },
});

/**
 * The next done task's pull request is merged, one at a time per delegation, in the card's order: its own thread, which
 * knows its change, brings it up to date with what was merged since, gets its checks to pass and merges it
 * (`mergeBrief`, sent after this commit, then `delegation.merge_sent` arms its watch again, so the watcher never reads
 * the run before it as the merge's end). Null when one merges already or none waits.
 */
export const mergeNext = defineCommand({
  name: 'delegation.merge_next',
  schema: z.object({ delegationId: Id, verifiedRevision: z.string().nullable().default(null) }),
  async apply(tx, ctx, input): Promise<{ delegation: DelegationRow; task: DelegationTaskRow | null }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent merges a delegation’s pull requests.');
    const d = await loadDelegation(tx, ctx.burrow.id, input.delegationId);
    if (d?.stage !== 'working') return { delegation: d as DelegationRow, task: null };
    const tasks = await loadTasks(tx, d.id);
    if (tasks.some((t) => t.state === 'working' && t.mergeState === 'merging'))
      return { delegation: d, task: null };
    const next = mergesWaiting(tasks).find(
      (t) =>
        t.threadId &&
        t.pr &&
        !t.stopPending &&
        (d.integrationMode !== 'batch' ||
          (isFinal(t) &&
            !!t.checkedRevision &&
            t.checkedRevision === input.verifiedRevision &&
            t.checkedInputs === inputFingerprint(tasks) &&
            t.checkedGeneration === t.checkGeneration)),
    );
    if (!next?.threadId) return { delegation: d, task: null };
    // Tasks done together have one pull request: they merge together (DLG-42).
    const rows = await tx
      .update(delegationTasks)
      .set({
        state: 'working',
        mergeState: 'merging',
        // What Whombat merged is handed on now: a hand-on a restart cuts off is found by its age from here.
        mergeClaimedAt: sql`case when ${delegationTasks.mergeClaimedAt} is null then null else ${ctx.now.toISOString()}::timestamptz end`,
        // A temporary blocker is shared with the card; restore its completion note when merging resumes.
        note: sql`case when ${delegationTasks.note} = ${d.note} then ${noteOf(next.answer, DELEGATION_TASK_NOTE_MAX)} else ${delegationTasks.note} end`,
        mergeAnswer: null,
        endedAt: null,
        dispatchId: null,
        deadline: null,
      })
      .where(
        and(
          eq(delegationTasks.delegationId, d.id),
          eq(delegationTasks.threadId, next.threadId),
          eq(delegationTasks.state, 'done'),
          eq(delegationTasks.mergeState, 'waiting'),
        ),
      )
      .returning();
    const row = rows.find((r) => r.id === next.id) ?? rows[0];
    if (!row) return { delegation: d, task: null };
    await tx.update(delegations).set({ note: null, updatedAt: ctx.now }).where(eq(delegations.id, d.id));
    await refreshCard(ctx, d.id);
    return { delegation: d, task: row };
  },
});

/** Its thread has the merge's work: its watch reads it from now. Cancelled when it was stopped meanwhile. */
export const mergeSent = defineCommand({
  name: 'delegation.merge_sent',
  schema: z.object({ delegationId: Id, taskId: Id }),
  async apply(tx, ctx, input): Promise<{ cancelled: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent merges a delegation’s pull requests.');
    const d = await loadDelegation(tx, ctx.burrow.id, input.delegationId);
    if (!d) throw notFound('Delegation');
    const [task] = await tx
      .select()
      .from(delegationTasks)
      .where(and(eq(delegationTasks.id, input.taskId), eq(delegationTasks.delegationId, d.id)));
    if (!task?.threadId || task.state !== 'working' || task.mergeState !== 'merging')
      return { cancelled: true };
    await rearmWatch(ctx, d, task.threadId, task.id);
    return { cancelled: false };
  },
});

/** Whether the council a checklist was made for has ended (null: none). */
async function councilOver(tx: Tx, councilId: string | null): Promise<boolean> {
  if (!councilId) return false;
  const [c] = await tx.select({ state: councils.state }).from(councils).where(eq(councils.id, councilId));
  return !!c && c.state !== 'active';
}

type ItemSaid = { note: string; done: boolean };
/** The row's line for an item its lead thread said nothing about. */
const UNSAID_ITEM: ItemSaid = { note: 'Its thread didn’t say whether it did this one.', done: false };

/** The items a lead thread said it finished while it worked (`Item 3 done: …`, kept on its watch), by number. */
async function reportedOf(tx: Tx, connectionId: string, threadId: string): Promise<Record<string, string>> {
  const [watch] = await tx
    .select({ progress: t3Watches.progress })
    .from(t3Watches)
    .where(and(eq(t3Watches.connectionId, connectionId), eq(t3Watches.threadId, threadId)));
  const reported = (watch?.progress as { reported?: unknown } | null | undefined)?.reported;
  const out: Record<string, string> = {};
  if (reported && typeof reported === 'object')
    for (const [n, line] of Object.entries(reported)) if (typeof line === 'string' && line) out[n] = line;
  return out;
}

/** A task's thread gets more work: its watch reads it again from now, for the task. */
export async function rearmWatch(ctx: ApplyContext, d: DelegationRow, threadId: string, taskId: string) {
  await ctx.tx
    .update(t3Watches)
    .set({
      state: 'watching',
      // Its questions wake the agent again: the watch kept only for its pull request after its end didn't.
      wakes: true,
      armedAt: ctx.now,
      // Read first in the watcher's next pass, as a new watch is.
      checkedAt: null,
      status: null,
      pending: null,
      asks: null,
      steps: null,
      runStartedAt: null,
      runEndedAt: null,
      delegationTaskId: taskId,
    })
    .where(and(eq(t3Watches.connectionId, d.connectionId), eq(t3Watches.threadId, threadId)));
}

/** What a working task does now or waits for changed (its watch): the card shows it. */
export const refreshDelegation = defineCommand({
  name: 'delegation.refresh',
  schema: z.object({ delegationId: Id }),
  async apply(_tx, ctx, input): Promise<void> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent follows a delegation’s threads.');
    await refreshCard(ctx, input.delegationId);
  },
});

/**
 * The agent woken for tasks that ended, in the delegation's thread, for its person: a queued `delegation` turn there
 * takes them (`wakeQuietly`), else a new one. When all are over and it carries out a council's plan, the council's turn
 * takes it (trigger `council`, CNL-61): its check comes next. Null when it can't be woken there.
 */
export async function wakeFor(
  ctx: ApplyContext,
  d: DelegationRow,
  taskIds: readonly string[],
  over = false,
): Promise<string | null> {
  if (ctx.services.licence.lapsed) return null;
  const personRow = d.personId ? await loadPrincipalRow(ctx.tx, d.personId) : null;
  const person = personRow?.accountId ?? null;
  const room = await loadConversationRow(ctx.tx, d.conversationId);
  if (!person || !room || !readsRoom(room, personRow ?? null)) return null;
  const woken = await wakeQuietly(ctx, {
    agentId: d.agentId,
    conversationId: d.conversationId,
    threadRootId: d.threadRootId,
    person,
    trigger: over && d.councilId ? 'council' : 'delegation',
    coalesce: false,
  });
  const dispatchId = woken?.dispatchId ?? null;
  if (dispatchId && taskIds.length)
    await ctx.tx
      .update(delegationTasks)
      .set({ dispatchId })
      .where(inArray(delegationTasks.id, [...taskIds]));
  return dispatchId;
}

/* The agent's changes ------------------------------------------------------------------------------------------- */

const Change = z.object({
  n: N,
  title: z.string().min(1).max(DELEGATION_TASK_TITLE_MAX).optional(),
  why: z.string().max(DELEGATION_WHY_MAX).optional(),
  brief: z.string().min(1).max(DELEGATION_BRIEF_MAX).optional(),
  picked: z.boolean().optional(),
  after: z.number().int().min(0).max(99).optional(),
  note: z.string().max(DELEGATION_TASK_NOTE_MAX).optional(),
  merge: z.boolean().optional(),
  areas: z.array(z.string().min(1).max(DELEGATION_AREA_MAX)).max(DELEGATION_AREAS_MAX).optional(),
});

/** More work for a task's own thread, sent after the commit. */
export interface TaskSend {
  task: DelegationTaskRow;
  message: string;
  /** Putting what Whombat merged live again: its thread gets the repository's deploy step (`deployBrief`). */
  deploy?: true;
}

export const updateDelegation = defineCommand({
  name: 'delegation.update',
  schema: z.object({
    delegationId: Id,
    note: z.string().min(1).max(DELEGATION_NOTE_MAX).nullable(),
    title: z.string().min(1).max(DELEGATION_TITLE_MAX).nullable(),
    atOnce: z.number().int().min(1).max(DELEGATION_AT_ONCE_MAX).nullable(),
    pullRequests: z.boolean().nullable(),
    merge: z.boolean().nullable().default(null),
    rules: z.string().min(1).max(DELEGATION_RULES_MAX).nullable().default(null),
    add: z.array(TaskSpec).max(DELEGATION_TASKS_MAX),
    change: z.array(Change).max(DELEGATION_CARD_TASKS_MAX),
    remove: z.array(N).max(DELEGATION_CARD_TASKS_MAX),
    order: z.array(N).max(DELEGATION_CARD_TASKS_MAX),
    start: z.boolean(),
    stop: z.array(N).max(DELEGATION_CARD_TASKS_MAX),
    retry: z.array(N).max(DELEGATION_CARD_TASKS_MAX),
    send: z
      .array(z.object({ n: N, message: z.string().min(1).max(DELEGATION_BRIEF_MAX) }))
      .max(DELEGATION_TASKS_MAX),
  }),
  async apply(
    tx,
    ctx,
    input,
  ): Promise<{ delegation: DelegationRow; stop: DelegationTaskRow[]; send: TaskSend[]; said: string[] }> {
    const d = await agentsDelegation(ctx, input.delegationId);
    const said: string[] = [];
    // What Whombat merged is being put live in its thread: the list waits (a stop keeps it merged).
    if (
      (await loadTasks(tx, d.id)).some((t) => whombatMerged(t, d)) &&
      (input.add.length ||
        // A row's line changes no work.
        input.change.some((c) =>
          Object.entries(c).some(([k, v]) => k !== 'n' && k !== 'note' && v !== undefined),
        ) ||
        input.remove.length ||
        input.retry.length ||
        input.send.length ||
        input.rules ||
        input.merge !== null ||
        input.pullRequests !== null)
    )
      throw conflict(DEPLOYING_NOW);
    let tasks = await loadTasks(tx, d.id);
    const previousInputs = inputFingerprint(tasks);
    // Every number is the card's as it was before this change.
    const at = (n: number) => tasks[n - 1] ?? null;
    const unknown = [
      ...input.change.map((c) => c.n),
      ...input.remove,
      ...input.order,
      ...input.stop,
      ...input.retry,
      ...input.send.map((s) => s.n),
    ].filter((n) => !at(n));
    if (unknown.length) said.push(`There is no task ${[...new Set(unknown)].join(', ')} on the card.`);
    const live = isLive(d);
    const set: Partial<typeof delegations.$inferInsert> = { updatedAt: ctx.now };
    if (input.title) set.title = input.title;
    if (input.atOnce) set.atOnce = input.atOnce;
    if (input.rules) set.rules = input.rules;
    if (input.pullRequests !== null) set.pullRequests = input.pullRequests;
    // Merging needs pull requests: one turns on the other, and no pull requests means nothing to merge.
    if (input.merge !== null) set.merge = input.merge;
    if (input.merge === true && !(set.pullRequests ?? d.pullRequests)) set.pullRequests = true;
    if ((set.pullRequests ?? d.pullRequests) === false) set.merge = false;

    // Stop first: a task stopped and retried in one change starts again.
    const stopped = await stopTasks(
      ctx,
      d,
      input.stop.flatMap((n) => {
        const t = at(n);
        return t && (t.state === 'working' || t.state === 'queued') ? [t] : [];
      }),
    );

    for (const c of input.change) {
      const t = at(c.n);
      if (!t) continue;
      const fields: Partial<typeof delegationTasks.$inferInsert> = {};
      const notStarted = NOT_STARTED.includes(t.state);
      if (c.title || c.why !== undefined || c.brief) {
        if (notStarted || ENDED.includes(t.state)) {
          if (c.title) fields.title = c.title;
          if (c.why !== undefined) fields.why = c.why.trim() || null;
          if (c.brief) fields.brief = c.brief;
        } else
          said.push(`Task ${c.n} is at work: its words change only once it ended (or send it more work).`);
      }
      if (c.note !== undefined) fields.note = c.note.trim() || null;
      if (c.areas) fields.areas = c.areas;
      if (c.merge !== undefined) {
        if (t.mergeState === 'merged') {
          if (c.merge) said.push(`Task ${c.n} is merged already.`);
        } else if (t.state === 'working' && t.mergeState === 'merging') {
          if (!c.merge) said.push(`Task ${c.n} is being merged now: stop it to keep its pull request open.`);
        } else if (!c.merge) fields.mergeState = 'kept';
        else if (t.state === 'done' && t.pr) fields.mergeState = 'waiting';
        else if (t.state === 'done') said.push(`Task ${c.n} has no pull request to merge.`);
        else if (NOT_STARTED.includes(t.state) || t.state === 'working')
          // Not done yet: merged when it is, if the card merges.
          fields.mergeState = null;
        else said.push(`Task ${c.n} didn’t finish, so there is nothing to merge: try it again first.`);
      }
      if (c.picked !== undefined) {
        if (t.state === 'offered') fields.picked = c.picked;
        else if (c.picked && t.state === 'skipped') Object.assign(fields, { picked: true, state: 'queued' });
        else if (!c.picked && t.state === 'queued')
          Object.assign(fields, { picked: false, state: 'skipped' });
        else if (c.picked !== t.picked) said.push(`Task ${c.n} started already: stop it instead.`);
      }
      if (c.after !== undefined) {
        const after = c.after ? at(c.after) : null;
        if (
          c.after &&
          (!after || after.id === t.id || isFinal(after) || isFinal(t) || loops(tasks, t.id, after.id))
        )
          said.push(`Task ${c.n} can’t come after task ${c.after}.`);
        else if (!notStarted) said.push(`Task ${c.n} started already: what it comes after stays.`);
        else fields.afterId = after?.id ?? null;
      }
      if (fields.mergeState !== undefined) {
        const members = groupMembers(t, tasks).filter((m) => m.mergeState !== 'merged');
        if (members.length)
          await tx
            .update(delegationTasks)
            .set({ mergeState: fields.mergeState })
            .where(
              inArray(
                delegationTasks.id,
                members.map((m) => m.id),
              ),
            );
        delete fields.mergeState;
      }
      if (Object.keys(fields).length)
        await tx.update(delegationTasks).set(fields).where(eq(delegationTasks.id, t.id));
    }

    const removing = input.remove.flatMap((n) => {
      const t = at(n);
      if (!t) return [];
      if (isFinal(t)) {
        said.push('The combined check stays while automatic merging is on.');
        return [];
      }
      if (!NOT_STARTED.includes(t.state)) {
        said.push(`Task ${n} started already, so it stays on the card.`);
        return [];
      }
      return [t.id];
    });
    if (removing.length) {
      await tx
        .update(delegationTasks)
        .set({ afterId: null })
        .where(and(eq(delegationTasks.delegationId, d.id), inArray(delegationTasks.afterId, removing)));
      await tx.delete(delegationTasks).where(inArray(delegationTasks.id, removing));
    }

    if (input.order.length) {
      const first = input.order.flatMap((n) => {
        const t = at(n);
        return t && !removing.includes(t.id) ? [t.id] : [];
      });
      const rest = tasks.filter((t) => !first.includes(t.id) && !removing.includes(t.id)).map((t) => t.id);
      let position = 0;
      for (const id of [...new Set([...first, ...rest])])
        await tx.update(delegationTasks).set({ position: position++ }).where(eq(delegationTasks.id, id));
    }

    let resumeChecked = false;
    // This update changes the work too: putting merged work live again waits for a call of its own.
    const changesWork =
      input.add.length > 0 ||
      input.remove.length > 0 ||
      input.send.length > 0 ||
      input.retry.some((n) => {
        const r = at(n);
        return !!r && !isFinal(r);
      }) ||
      input.change.some((c) =>
        Object.entries(c).some(([k, v]) => k !== 'n' && k !== 'note' && v !== undefined),
      );
    const retryMerge: string[] = [];
    const redeploy: DelegationTaskRow[] = [];
    const retrying = input.retry.flatMap((n) => {
      const t = at(n);
      if (!t) return [];
      if (
        isFinal(t) &&
        t.state === 'done' &&
        t.checks === 'passing' &&
        t.checkedRevision &&
        t.checkedGeneration === t.checkGeneration &&
        t.checkedInputs === inputFingerprint(tasks)
      ) {
        if (t.mergeState === 'merged') {
          // Merged by Whombat (its claim says so): its thread puts it on DEV again. Merged otherwise: nothing to do.
          if (!t.mergeClaimedAt || !t.threadId)
            said.push(`Task ${n} is merged already: there is nothing to try again.`);
          else if (t.stopPending)
            said.push(`Task ${n} is still stopping in T3 Code: try it again in a minute.`);
          else if (changesWork)
            said.push(`Task ${n} is merged: put it live again on its own first, then change the work.`);
          else {
            redeploy.push(t);
            resumeChecked = true;
            said.push('It stays merged: its thread puts it live again.');
          }
          return [];
        }
        resumeChecked = true;
        if (t.mergeState === 'not_merged') {
          // GitHub refused it before: merged again once the blocker is resolved, its completed review kept.
          retryMerge.push(t.id);
          said.push('Kept the completed review: Whombat merges it again now.');
        } else said.push('Kept the completed review and carried on.');
        return [];
      }
      const ended = ENDED.includes(t.state) || stopped.some((s) => s.id === t.id);
      if (!ended) {
        said.push(`Task ${n} hasn’t ended, so there is nothing to try again.`);
        return [];
      }
      if (t.stopPending && !stopped.some((s) => s.id === t.id)) {
        said.push(`Task ${n} is still stopping in T3 Code: try it again in a minute.`);
        return [];
      }
      return [t.id];
    });
    // One shared branch is retried as one job, including a group whose launch has not returned yet.
    for (const id of [...retrying]) {
      const task = tasks.find((t) => t.id === id);
      if (!task) continue;
      for (const mate of groupMembers(task, tasks)) {
        if (
          !retrying.includes(mate.id) &&
          (ENDED.includes(mate.state) || stopped.some((s) => s.id === mate.id)) &&
          (!mate.stopPending || stopped.some((s) => s.id === mate.id))
        )
          retrying.push(mate.id);
      }
    }
    if (retrying.length)
      await tx
        .update(delegationTasks)
        .set({
          state: 'queued',
          picked: true,
          checks: null,
          answer: null,
          // A final check keeps its candidate's address: tried again on the same work, it carries on with it.
          pr: sql`case when ${delegationTasks.kind} = 'final' then ${delegationTasks.pr} else null end`,
          endedAt: null,
          dispatchId: null,
          mergeState: sql`case when ${delegationTasks.mergeState} = 'kept' then 'kept' else null end`,
          mergeAnswer: null,
        })
        .where(inArray(delegationTasks.id, retrying));

    if (retryMerge.length)
      await tx
        .update(delegationTasks)
        .set({ mergeState: 'waiting', note: null, mergeClaimedAt: null })
        .where(inArray(delegationTasks.id, retryMerge));
    const send: TaskSend[] = [];
    for (const t of redeploy) {
      const [row] = await tx
        .update(delegationTasks)
        .set({
          state: 'working',
          mergeState: 'merging',
          startedAt: ctx.now,
          endedAt: null,
          note: null,
          mergeClaimedAt: ctx.now,
        })
        .where(and(eq(delegationTasks.id, t.id), eq(delegationTasks.state, 'done')))
        .returning();
      if (!row?.threadId) continue;
      await rearmWatch(ctx, d, row.threadId, row.id);
      send.push({ task: row, message: DEPLOY_AGAIN, deploy: true });
    }
    // A place for more work sent to an ended task (DLG-25): the tasks at work now, not those waiting for checks.
    let busy = busyTasks(await loadTasks(tx, d.id)).length;
    const sentGroups = new Set<string>();
    for (const s of input.send) {
      const t = at(s.n);
      if (!t) continue;
      if (!t.threadId || t.stopPending || retrying.includes(t.id)) {
        said.push(`Task ${s.n} has no thread to send work to${t.threadId ? ' now' : ' yet'}.`);
        continue;
      }
      if (t.state === 'working' && t.mergeState === 'merging') {
        said.push(`Task ${s.n} is being merged now: send it more work once that ended.`);
        continue;
      }
      // Its work is on the default branch: more work would check it all again.
      if (isFinal(t) && t.mergeState === 'merged') {
        said.push(
          t.mergeClaimedAt
            ? `Task ${s.n} is merged: retry it to put it live again, or add a task for more work.`
            : `Task ${s.n} is merged: add a task for more work.`,
        );
        continue;
      }
      const memberIds = groupMembers(t, tasks).map((m) => m.id);
      const groupKey = t.groupId ?? t.threadId;
      if (sentGroups.has(groupKey)) {
        said.push(`Task ${s.n} shares a thread already sent work in this update.`);
        continue;
      }
      sentGroups.add(groupKey);
      const atWork = t.state === 'working' && t.checks !== 'running';
      if (!atWork && busy >= d.atOnce && live) {
        // No place now: it waits its turn, and its thread gets the work then.
        await tx
          .update(delegationTasks)
          .set({
            state: 'queued',
            sendPending: s.message,
            endedAt: null,
            dispatchId: null,
            checks: null,
            // The task the work is for says again how it went.
            answer: null,
            note: null,
          })
          .where(eq(delegationTasks.id, t.id));
        said.push(`Task ${s.n} gets that when a place frees up (${d.atOnce} work at once).`);
        continue;
      }
      const [row] = await tx
        .update(delegationTasks)
        .set({
          state: 'working',
          endedAt: null,
          dispatchId: null,
          checks: null,
          deadline: null,
          ...(t.state === 'working' ? {} : { startedAt: ctx.now }),
        })
        .where(inArray(delegationTasks.id, memberIds))
        .returning();
      if (!row) continue;
      // The task the work is for says again how it went: its earlier line doesn't stand for it.
      await tx.update(delegationTasks).set({ answer: null, note: null }).where(eq(delegationTasks.id, t.id));
      if (!atWork) busy++;
      await rearmWatch(ctx, d, t.threadId, t.id);
      send.push({ task: row, message: s.message });
    }

    // Merging switched on: done pull requests not kept by the person wait their turn; off: those waiting are left.
    if (set.merge !== undefined && set.merge !== d.merge) {
      const done = (await loadTasks(tx, d.id)).filter((t) => t.state === 'done' && !isFinal(t));
      const turn = set.merge
        ? done.filter((t) => t.pr && t.mergeState === null).map((t) => t.id)
        : done.filter((t) => t.mergeState === 'waiting').map((t) => t.id);
      if (turn.length)
        await tx
          .update(delegationTasks)
          .set({ mergeState: set.merge ? 'waiting' : null })
          .where(inArray(delegationTasks.id, turn));
    }

    tasks = await loadTasks(tx, d.id);
    const stage = live ? d.stage : null;
    let added = 0;
    if (input.add.length) {
      if (tasks.filter((t) => !isFinal(t)).length + input.add.length > DELEGATION_TASKS_MAX)
        said.push(`A card holds at most ${DELEGATION_TASKS_MAX} tasks, so not all were added.`);
      const room = Math.max(0, DELEGATION_TASKS_MAX - tasks.filter((t) => !isFinal(t)).length);
      const { rows, chained } = newTaskRows(
        d,
        // The final check stays last: new tasks take the numbers before it.
        tasks.filter((t) => !isFinal(t)),
        input.add.slice(0, room),
        (spec) => (stage === 'offer' ? 'offered' : spec.picked !== false ? 'queued' : 'skipped'),
        ctx.now,
      );
      said.push(...chainedLines(chained));
      const all = [...tasks, ...rows];
      for (const row of rows) if (row.afterId && loops(all, row.id, row.afterId)) row.afterId = null;
      if (rows.length) await tx.insert(delegationTasks).values(rows);
      added = rows.length;
      tasks = await loadTasks(tx, d.id);
    }

    // Tasks added, retried, sent more work or to be merged on an ended card open it again.
    const reopens =
      !live &&
      (resumeChecked ||
        send.length > 0 ||
        retrying.length > 0 ||
        tasks.some((t) => t.state === 'queued') ||
        mergesWaiting(tasks).length > 0);
    if (reopens)
      Object.assign(set, {
        stage: 'working',
        outcome: null,
        endedAt: null,
        note: null,
        handedAt: d.handedAt ?? ctx.now,
        // A council's checklist opened again after the council ended is a list of its own from now on.
        ...((await councilOver(tx, d.councilId)) ? { councilId: null } : {}),
      });
    await tx.update(delegations).set(set).where(eq(delegations.id, d.id));
    // The final check (DLG-41): there while Whombat merges, checking again once more work lands.
    const handedNow = (set.stage ?? d.stage) === 'working';
    if (handedNow && set.merge === true && set.merge !== d.merge) await addFinal(ctx, d);
    if (set.merge === false && set.merge !== d.merge)
      await tx
        .delete(delegationTasks)
        .where(
          and(
            eq(delegationTasks.delegationId, d.id),
            eq(delegationTasks.kind, 'final'),
            eq(delegationTasks.state, 'queued'),
          ),
        );
    const workChanged =
      added > 0 ||
      retrying.some((id) => tasks.some((t) => t.id === id && !isFinal(t))) ||
      // Putting what Whombat merged live again changes no work.
      send.some((s) => !isFinal(s.task)) ||
      sentGroups.size > 0 ||
      // Stopping the combined check itself changes no work it checks.
      stopped.some((t) => !isFinal(t)) ||
      removing.length > 0 ||
      inputFingerprint(tasks) !== previousInputs ||
      (set.merge !== undefined && set.merge !== d.merge) ||
      (set.pullRequests !== undefined && set.pullRequests !== d.pullRequests) ||
      (set.rules !== undefined && set.rules !== d.rules);
    // Only the check itself tried again: the work it checks is the same, so it may carry on with its candidate.
    if (handedNow && (workChanged || retrying.length > 0)) await finalAgain(ctx, d, !workChanged);
    // A council's checklist got more work after its check (CNL-61): the council builds again. Before Hand over it
    // still waits for the go-ahead.
    if (
      d.councilId &&
      handedNow &&
      (input.add.length || retrying.length || send.some((s) => !isFinal(s.task)))
    )
      await councilHandedOver(ctx, d.councilId);
    const now = (await loadDelegation(tx, ctx.burrow.id, d.id)) ?? d;
    if (input.start) {
      if (now.stage === 'offer' && (await councilChecking(tx, now)))
        said.push(
          'A council is checking this list: hand it over once it answers (you are woken), or stop it first.',
        );
      else if (now.stage === 'offer')
        try {
          await handOver(ctx, now, tasks);
        } catch (err) {
          if (err instanceof Error && err.message === 'none_picked')
            said.push('No task is ticked, so nothing was handed over.');
          else throw err;
        }
      else if (now.stage !== 'working') said.push('This card ended: add or retry tasks to open it again.');
    }
    await refreshCard(ctx, d.id);
    // The agent's words about the change are a reply of their own under the card; progress tells nobody.
    if (input.note) await postUnderCard(ctx, d, input.note, false);
    return {
      delegation: (await loadDelegation(tx, ctx.burrow.id, d.id)) ?? now,
      stop: stopped,
      send,
      said,
    };
  },
});

/* The end -------------------------------------------------------------------------------------------------------- */

/** Whether a task of an ended list didn't get where it was going: it failed, ran out of time, stopped, or wasn't merged. */
function unfinishedOf(tasks: readonly DelegationTaskRow[]): boolean {
  return tasks.some(
    (t) =>
      t.state === 'failed' ||
      t.state === 'timed_out' ||
      t.state === 'stopped' ||
      (t.state === 'done' &&
        (t.mergeState === 'not_merged' ||
          t.mergeState === 'waiting' ||
          t.checks === 'failing' ||
          (isFinal(t) &&
            (t.checks !== 'passing' || !t.checkedRevision || t.checkedGeneration !== t.checkGeneration)))),
  );
}

/** Repair live lists through the normal commit pipeline, including lists handed over before the final row existed. */
export const ensureFinal = defineCommand({
  name: 'delegation.ensure_final',
  schema: z.object({ delegationId: Id, invalidate: z.boolean().default(false) }),
  async apply(_tx, ctx, input): Promise<void> {
    const d = await agentsDelegation(ctx, input.delegationId);
    if (d.stage !== 'working') return;
    await addFinal(ctx, d);
    if (input.invalidate) await finalAgain(ctx, d);
    await refreshCard(ctx, d.id);
  },
});

/** A previously green candidate can lose readiness before its merge starts. Preserve that fact on the card. */
export const holdFinal = defineCommand({
  name: 'delegation.hold_final',
  schema: z.object({
    delegationId: Id,
    taskId: Id,
    revision: z.string(),
    waiting: z.boolean(),
    message: z.string().max(DELEGATION_TASK_NOTE_MAX).optional(),
  }),
  async apply(tx, ctx, input): Promise<void> {
    const d = await agentsDelegation(ctx, input.delegationId);
    const [task] = await tx
      .update(delegationTasks)
      .set(
        input.waiting
          ? {
              checks: 'running',
              note: 'Waiting for the combined checks.',
            }
          : {
              state: 'failed',
              mergeState: 'not_merged',
              checks: 'failing',
              note:
                input.message ?? 'The combined check could not be confirmed. The work is still incomplete.',
            },
      )
      .where(
        and(
          eq(delegationTasks.id, input.taskId),
          eq(delegationTasks.delegationId, d.id),
          eq(delegationTasks.kind, 'final'),
          eq(delegationTasks.state, 'done'),
          eq(delegationTasks.mergeState, 'waiting'),
          eq(delegationTasks.checkedRevision, input.revision),
        ),
      )
      .returning();
    if (!task) return;
    await refreshCard(ctx, d.id);
    if (!input.waiting)
      await wakeFor(ctx, d, [task.id], allOver(await loadTasks(tx, d.id), d.integrationMode === 'batch'));
  },
});

/** Ends a live delegation: what works stops, what waits won't start. The tasks whose threads are to be stopped. */
async function endDelegation(
  ctx: ApplyContext,
  d: DelegationRow,
  how: { stopped: boolean; note: string },
): Promise<DelegationTaskRow[]> {
  const { tx } = ctx;
  // A final check that never became due (nothing was merged) wasn't needed: it isn't something that didn't finish.
  if (!how.stopped)
    await tx
      .update(delegationTasks)
      .set({ state: 'skipped' })
      .where(
        and(
          eq(delegationTasks.delegationId, d.id),
          eq(delegationTasks.kind, 'final'),
          eq(delegationTasks.state, 'queued'),
        ),
      );
  const tasks = await loadTasks(tx, d.id);
  const unfinishedBeforeStop = unfinishedOf(tasks);
  const working = await stopTasks(ctx, d, tasks);
  const ended = await loadTasks(tx, d.id);
  const handed = d.stage === 'working' || !!d.handedAt;
  const unfinished = unfinishedBeforeStop || unfinishedOf(ended);
  await tx
    .update(delegations)
    .set({
      stage: how.stopped ? 'stopped' : 'done',
      outcome: how.stopped || !handed ? 'stopped' : unfinished ? 'incomplete' : 'done',
      note:
        !how.stopped &&
        unfinished &&
        (how.note === DELEGATION_TEXT.done || how.note === DELEGATION_TEXT.withCouncil)
          ? DELEGATION_TEXT.incomplete
          : how.note,
      endedAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(eq(delegations.id, d.id));
  // The shots its tasks' pictures were drawn from go (the sweep takes them), and the picture links end (DLG-27); the
  // drawn pictures stay on the card's message.
  const shots = await tx.select().from(delegationShots).where(eq(delegationShots.delegationId, d.id));
  const raw = shots.flatMap((s) => [s.beforeId, s.afterId].filter((id): id is string => !!id));
  if (raw.length) {
    await tx
      .update(delegationShots)
      .set({ beforeId: null, afterId: null })
      .where(eq(delegationShots.delegationId, d.id));
    await tx.update(attachments).set({ state: 'deleted' }).where(inArray(attachments.id, raw));
  }
  await tx
    .update(delegationTasks)
    .set({ uploadHash: null, uploadUntil: null })
    .where(eq(delegationTasks.delegationId, d.id));
  await refreshCard(ctx, d.id, true);
  await watchFinishedThreads(ctx, d, ended);
  return working;
}

/** Recheck finished threads quietly before settling, including grouped tasks and lists ended before this repair. */
async function watchFinishedThreads(
  ctx: ApplyContext,
  d: DelegationRow,
  tasks: readonly DelegationTaskRow[],
) {
  const ids = tasks.filter((t) => t.state !== 'working' && t.threadId && !t.stopPending).map((t) => t.id);
  if (!ids.length) return;
  await ctx.tx
    .update(t3Watches)
    .set({ state: 'watching', wakes: false, armedAt: ctx.now })
    .where(
      and(
        eq(t3Watches.connectionId, d.connectionId),
        inArray(t3Watches.delegationTaskId, ids),
        eq(t3Watches.state, 'idle'),
        inArray(t3Watches.status, ['completed', 'idle']),
        or(isNull(t3Watches.checkedAt), lt(t3Watches.checkedAt, d.endedAt ?? ctx.now)),
      ),
    );
}

export const cleanupDelegationThreads = defineCommand({
  name: 'delegation.cleanup_threads',
  schema: z.object({ delegationId: Id }),
  async apply(tx, ctx, input): Promise<void> {
    const d = await agentsDelegation(ctx, input.delegationId);
    if (isLive(d) || !d.endedAt) return;
    await watchFinishedThreads(ctx, d, await loadTasks(tx, d.id));
    if (
      d.outcome === 'incomplete' &&
      (d.note === DELEGATION_TEXT.done || d.note === DELEGATION_TEXT.withCouncil)
    ) {
      await tx.update(delegations).set({ note: DELEGATION_TEXT.incomplete }).where(eq(delegations.id, d.id));
      await refreshCard(ctx, d.id);
    }
  },
});

export const finishDelegation = defineCommand({
  name: 'delegation.finish',
  schema: z.object({
    delegationId: Id,
    summary: z.string().min(1).max(DELEGATION_SUMMARY_MAX),
    stopped: z.boolean(),
    /** Quick replies for the person under the card's message (DLG-29). */
    next: z.array(Suggestion).max(SUGGESTIONS_MAX).default([]),
    /** The summary is Whombat's own short status (a council's checklist ending with it), not the agent's words. */
    status: z.boolean().default(false),
  }),
  async apply(tx, ctx, input): Promise<{ messageId: string | null; working: DelegationTaskRow[] }> {
    const d = await agentsDelegation(ctx, input.delegationId);
    const summary = input.summary.trim();
    if (input.next.length && d.messageId)
      await tx.update(messages).set({ suggestions: input.next }).where(eq(messages.id, d.messageId));
    if (!isLive(d)) {
      // Ended already (the person stopped it): the summary goes under the card all the same, quietly.
      if (input.status) {
        await tx
          .update(delegations)
          .set({ note: summary, updatedAt: ctx.now })
          .where(eq(delegations.id, d.id));
        return { messageId: await refreshCard(ctx, d.id, true), working: [] };
      }
      await postUnderCard(ctx, d, summary, false);
      return { messageId: d.messageId, working: [] };
    }
    const tasks = await loadTasks(tx, d.id);
    if (!input.stopped && tasks.some((t) => t.state === 'working')) throw conflict('still_working');
    if (!input.stopped && d.stage === 'working' && readyTasks(tasks, d.integrationMode === 'batch').length)
      throw conflict('still_waiting');
    if (
      !input.stopped &&
      d.stage === 'working' &&
      !allOver(tasks, d.integrationMode === 'batch') &&
      mergesWaiting(tasks).length
    )
      throw conflict('still_merging');
    const working = await endDelegation(ctx, d, {
      stopped: input.stopped,
      note: input.status ? summary : input.stopped ? DELEGATION_TEXT.stopped : DELEGATION_TEXT.done,
    });
    // The agent's summary is a reply of its own under the card. A council's checklist isn't news of its own: the
    // council's end is (DLG-30).
    if (!input.status) await postUnderCard(ctx, d, summary, !d.councilId);
    // The card may have moved to the thread's end as it ended.
    return { messageId: (await loadDelegation(tx, ctx.burrow.id, d.id))?.messageId ?? d.messageId, working };
  },
});

export const expireDelegation = defineCommand({
  name: 'delegation.expire',
  schema: z.object({ delegationId: Id }),
  async apply(tx, ctx, input): Promise<void> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent ends a quiet delegation.');
    const d = await loadDelegation(tx, ctx.burrow.id, input.delegationId);
    if (!d || !isLive(d)) return;
    if ((await loadTasks(tx, d.id)).some((t) => t.state === 'working')) return;
    await endDelegation(ctx, d, { stopped: true, note: DELEGATION_TEXT.quiet });
  },
});

/* Where a thread's delegation is ---------------------------------------------------------------------------------- */

/** The delegation of a thread: the live one there, else the latest. */
export async function delegationOfThread(
  db: Db | Tx,
  burrowId: string,
  conversationId: string,
  threadRootId: string | null,
): Promise<DelegationRow | null> {
  const rows = await db
    .select()
    .from(delegations)
    .where(
      and(
        eq(delegations.burrowId, burrowId),
        eq(delegations.conversationId, conversationId),
        ...(threadRootId ? [eq(delegations.threadRootId, threadRootId)] : []),
      ),
    )
    .orderBy(desc(delegations.createdAt))
    .limit(20);
  return rows.find(isLive) ?? rows[0] ?? null;
}

/** The threads with a delegation still live (they don't settle). */
export async function liveDelegationThreads(
  db: Db | Tx,
  conversationId: string,
  rootIds: readonly string[] | null,
): Promise<Set<string>> {
  const rows = await db
    .select({ root: delegations.threadRootId })
    .from(delegations)
    .where(
      and(
        eq(delegations.conversationId, conversationId),
        inArray(delegations.stage, ['offer', 'working']),
        ...(rootIds ? [inArray(delegations.threadRootId, [...rootIds])] : []),
      ),
    );
  return new Set(rows.flatMap((r) => (r.root ? [r.root] : [])));
}

/**
 * Pull requests of ended tasks that got merged another way (the agent, the person, anyone on GitHub, after the task's
 * thread gave up or while it waited its turn) show as merged, as Whombat's copy of the repository says; an ended
 * delegation's outcome is counted again. A merge going on is its thread's: it is left alone. Whether it changed.
 */
export const mergedElsewhere = defineCommand({
  name: 'delegation.merged_elsewhere',
  schema: z.object({ delegationId: Id }),
  async apply(tx, ctx, input): Promise<{ changed: boolean }> {
    if (ctx.actor.kind !== 'agent')
      throw forbidden('Only the agent hears from a delegation’s pull requests.');
    const d = await loadDelegation(tx, ctx.burrow.id, input.delegationId);
    if (!d) return { changed: false };
    const tasks = await loadTasks(tx, d.id);
    const open = tasks.filter((t) => !isFinal(t) && t.state === 'done' && t.pr && t.mergeState !== 'merged');
    if (!open.length) return { changed: false };
    const final = tasks.find(isFinal);
    const merged = await tx
      .select({ url: pullRequests.url, headSha: pullRequests.headSha })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.burrowId, ctx.burrow.id),
          eq(pullRequests.state, 'merged'),
          inArray(sql<string>`lower(${pullRequests.url})`, [
            ...open.map((t) => (t.pr as string).toLowerCase()),
            ...(final?.pr ? [final.pr.toLowerCase()] : []),
          ]),
        ),
      );
    const urls = new Set(merged.map((m) => m.url?.toLowerCase()));
    const ids = open.filter((t) => urls.has((t.pr as string).toLowerCase())).map((t) => t.id);
    if (!ids.length) return { changed: false };
    await tx
      .update(delegationTasks)
      .set({ mergeState: 'merged', checks: 'passing' })
      .where(and(inArray(delegationTasks.id, ids), eq(delegationTasks.state, 'done')));
    // Merging the checked candidate merges the source pull requests in it too, and GitHub says so before the merge's
    // thread has ended: that is the candidate landing, not work merged around it, so its check stands.
    const checkedLanding =
      final?.state === 'done' &&
      final.mergeState === 'waiting' &&
      final.checks === 'passing' &&
      final.checkedInputs === inputFingerprint(tasks) &&
      final.checkedGeneration === final.checkGeneration &&
      verificationPassed(verificationOf(final.answer), final.checkedInputs, final.checkGeneration) &&
      merged.some(
        (pr) => pr.url?.toLowerCase() === final.pr?.toLowerCase() && pr.headSha === final.checkedRevision,
      );
    // The live GitHub verifier confirms the delivered tree before recording this final row as merged.
    const landing =
      !!final && (final.mergeState === 'merging' || final.mergeState === 'merged' || checkedLanding);
    if (d.merge && !landing) {
      await addFinal(ctx, d);
      await finalAgain(ctx, d);
      if (d.stage === 'done')
        await tx
          .update(delegations)
          .set({
            stage: 'working',
            outcome: null,
            endedAt: null,
            note: null,
            ...((await councilOver(tx, d.councilId)) ? { councilId: null } : {}),
          })
          .where(eq(delegations.id, d.id));
    }
    await tx.update(delegations).set({ updatedAt: ctx.now }).where(eq(delegations.id, d.id));
    await refreshCard(ctx, d.id);
    return { changed: true };
  },
});
