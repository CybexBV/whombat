/**
 * T3 Code threads the agent handed work to wake it when they move on (docs/decisions/t3code.md), so it neither waits in
 * its turn nor schedules turns to look again:
 *
 * - `t3code.follow_thread`: the agent's own calls through `connection_call` keep the watch — starting a thread, sending
 *   it a message or answering its question watches it from that turn's conversation and thread, for its person;
 *   stopping it ends the watch; what a call showed it (a wait that saw it end, a read, its questions) is seen. A thread
 *   an automation's step (or another turn that waits for its thread itself) hands work to is watched without waking anyone (that turn waits for it
 *   itself), only so it is settled once its work completed. A thread a customer's report's turn starts is marked as
 *   that report's, and stays so when a person's turn hands it more work from the report's own Chat thread
 *   (`connections/report-turn.ts`); a report's turn never takes a hand-over a person still waits for.
 * - `t3code.thread_moved`: the watcher (`watch.ts`) read something the agent hasn't told or seen. Under the burrow's
 *   lock it checks again and wakes the agent there with a `t3_thread` turn — a queued one in the same place takes up to
 *   `T3_THREADS_MAX` threads — once per key; while a turn of the agent is at work there it waits for the next pass.
 * - `t3ThreadsOf` is a `t3_thread` turn's `DispatchContext.t3Threads`.
 * - `t3CallArgs`: a thread the agent starts carries its name first, so the person sees in T3 Code who handed it over,
 *   and a message to a thread carries what the person wrote, unchanged, when their own message started the turn. A
 *   message that hands over an automation's fix and asks for a review also says to keep the commits a review read
 *   (`withReviewedCommitRules`).
 */
import {
  type DispatchContext,
  JOB_REPORT_LINES,
  JOB_REPORT_MARK,
  JOB_REPORT_MAX,
  JobResult,
  PROMPT_MERGE_MARK,
  T3_THREADS_MAX,
  T3ThreadUpdate,
} from '@whombat/core';
import { and, asc, count, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { readsRoom } from '../chats/rooms';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import {
  automationRunSteps,
  catalogConnections,
  dispatches,
  type T3WatchRow,
  t3Watches,
} from '../db/schema/index';
import { SUBAGENT_MARK, subagentRules } from '../delegate/briefs';
import { agentBriefOf } from '../domain/agent-brief';
import { wakeQuietly } from '../domain/wake';
import { forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import { loadPrincipalRow, shortName } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import { outsidersTurn } from '../runtime/person';
import type { Services } from '../services';
import { publishHandoffs } from './handoffs';
import { PERSON_WORDS_MARK, personWordsOfTurn, withPersonWords } from './person-words';
import { postJobResult } from './result';
import { launchTitle, seenOfCall } from './threads';

const Id = z.string().min(1).max(64);
const ThreadId = z.string().min(1).max(300);
const Key = z.string().min(1).max(200);

/** The watch of one thread of a connection of this burrow. */
const theWatch = (burrowId: string, connectionId: string, threadId: string) =>
  and(
    eq(t3Watches.burrowId, burrowId),
    eq(t3Watches.connectionId, connectionId),
    eq(t3Watches.threadId, threadId),
  );

/** The thread a watch's turn works in: its root when it is still there, else the top. */
const inThread = (row: Pick<T3WatchRow, 'threadRootId'>) =>
  row.threadRootId ? eq(dispatches.threadRootId, row.threadRootId) : isNull(dispatches.threadRootId);

export const followT3Thread = defineCommand({
  name: 't3code.follow_thread',
  schema: z.discriminatedUnion('how', [
    z.object({
      how: z.literal('arm'),
      connectionId: Id,
      threadId: ThreadId,
      title: z.string().min(1).max(160).nullable(),
      conversationId: Id,
      threadRootId: Id.nullable(),
      personId: Id.nullable(),
      /** False: watched only to be settled (`handsOver`). */
      wakes: z.boolean(),
      /** A prompt's thread whose pull request Whombat merges once it is done (`mergeAsked`); a later arm keeps it. */
      merge: z.boolean().optional(),
      /** A turn on a customer's report hands it work: the thread is that report's, where its turns work. */
      report: z.boolean().optional(),
    }),
    z.object({
      how: z.literal('seen'),
      connectionId: Id,
      threadId: ThreadId,
      key: Key,
      /** A report's turn saw it: a hand-over a person still waits for is left for their wake. */
      report: z.boolean().optional(),
    }),
    z.object({
      how: z.literal('stop'),
      connectionId: Id,
      threadId: ThreadId,
      /** A report's turn stopped it: a person who still waits for it hears that it ended. */
      report: z.boolean().optional(),
    }),
  ]),
  async apply(tx, ctx, input): Promise<{ watching: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent hands work to T3 Code.');
    const where = theWatch(ctx.burrow.id, input.connectionId, input.threadId);
    // A hand-over a person still waits for: their turn is woken when the thread moves on. A report's turn that works
    // on the same thread meanwhile (a restarted step) must not use that wake up or take it away.
    const personWaits = sql`(${t3Watches.personId} is not null and ${t3Watches.wakes} and ${t3Watches.state} = 'watching')`;
    const notTheirs = input.report ? sql`not ${personWaits}` : undefined;
    if (input.how === 'seen') {
      const rows = await tx
        .update(t3Watches)
        .set({ seenKey: input.key })
        .where(and(where, eq(t3Watches.agentId, ctx.actor.id), notTheirs))
        .returning({ state: t3Watches.state });
      return { watching: rows[0]?.state === 'watching' };
    }
    if (input.how === 'stop') {
      await tx
        .update(t3Watches)
        .set({ state: 'idle' })
        .where(and(where, eq(t3Watches.agentId, ctx.actor.id), notTheirs));
      return { watching: false };
    }
    const [connection] = await tx
      .select({ id: catalogConnections.id })
      .from(catalogConnections)
      .where(
        and(
          eq(catalogConnections.id, input.connectionId),
          eq(catalogConnections.burrowId, ctx.burrow.id),
          eq(catalogConnections.catalogId, 't3code'),
        ),
      );
    if (!connection) throw notFound('Connection');
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const place = {
      conversationId: conversation.id,
      threadRootId: input.threadRootId,
      agentId: ctx.actor.id,
      personId: input.personId,
      wakes: input.wakes,
      state: 'watching' as const,
      armedAt: ctx.now,
      // New work: what the person saw of the last run is read again.
      status: null,
      pending: null,
      asks: null,
      steps: null,
      prs: null,
      runStartedAt: null,
      runEndedAt: null,
    };
    // Whose thread it is doesn't follow the latest hand-over. A report's turn can only start a thread or hand work to
    // one that is its own already, so its hand-over marks the thread as its report's. Anyone else's hand-over from the
    // report's own Chat thread keeps the mark (a follow-up the person asked for there, which the run's review must
    // still read), and a watch from before the mark that is still as a report's turn left it (for nobody, with no
    // wake) gets it then. A hand-over from anywhere else ends it: what a person's turn tells a thread there, their own
    // words too, isn't for a stranger's report to read.
    const reports = input.report
      ? { reportConversationId: conversation.id, reportThreadRootId: input.threadRootId }
      : {};
    const root = sql`${input.threadRootId}::text`;
    const here = (conversationOf: AnyPgColumn, rootOf: AnyPgColumn) =>
      sql`${conversationOf} = ${conversation.id} and ${rootOf} is not distinct from ${root}`;
    const staysReports = sql`((${here(t3Watches.reportConversationId, t3Watches.reportThreadRootId)}) or (${t3Watches.reportConversationId} is null and ${t3Watches.personId} is null and ${t3Watches.wakes} = false and ${t3Watches.councilId} is null and ${t3Watches.delegationTaskId} is null and ${here(t3Watches.conversationId, t3Watches.threadRootId)}))`;
    const keptReports = input.report
      ? {
          ...reports,
          // The person who still waits for it keeps their wake: the report's turn waits for the thread itself.
          personId: sql`case when ${personWaits} then ${t3Watches.personId} else ${input.personId}::text end`,
          wakes: sql`case when ${personWaits} then true else ${input.wakes}::boolean end`,
        }
      : {
          reportConversationId: sql`case when ${staysReports} then ${conversation.id}::text else null end`,
          reportThreadRootId: sql`case when ${staysReports} then ${root} else null end`,
        };
    // The latest hand-over says where it is told; what the agent knew of it stays known.
    await tx
      .insert(t3Watches)
      .values({
        burrowId: ctx.burrow.id,
        connectionId: connection.id,
        threadId: input.threadId,
        title: input.title ?? 'A T3 Code thread',
        ...place,
        ...reports,
        ...(input.merge ? { merge: { state: 'wanted' as const } } : {}),
      })
      .onConflictDoUpdate({
        target: [t3Watches.connectionId, t3Watches.threadId],
        set: {
          ...place,
          ...keptReports,
          ...(input.title ? { title: input.title } : {}),
          ...(input.merge ? { merge: { state: 'wanted' as const } } : {}),
          // The job's track goes on through answers and messages; work on a thread whose job was over starts it anew.
          progress: sql`case when ${t3Watches.state} = 'idle' then null else ${t3Watches.progress} end`,
        },
      });
    return { watching: true };
  },
});

/**
 * A turn of the agent at work where the watch is told (any but a `t3_thread`, `council` or `delegation` turn still queued
 * there).
 */
async function busyThere(db: Db | Tx, row: T3WatchRow): Promise<boolean> {
  const [busy] = await db
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.agentId, row.agentId),
        eq(dispatches.conversationId, row.conversationId),
        inThread(row),
        or(
          inArray(dispatches.state, ['claimed', 'running']),
          // A queued wake of the same kind takes more news; a council's wake takes its members' ends (council.md), a
          // delegation's its tasks' (delegate.md).
          and(
            eq(dispatches.state, 'queued'),
            notInArray(dispatches.trigger, ['t3_thread', 'council', 'delegation']),
          ),
        ),
      ),
    )
    .limit(1);
  return !!busy;
}

/** Whether the watcher should leave a watch for now: a turn of its agent is at work where it is told. */
export const waitsForTurn = busyThere;

/**
 * The agent woken for a thread that moved on: a `t3_thread` turn of it queued in the same conversation, thread
 * and for the same person, with room for one more, takes it; else a new one. Null when it can't be woken there (the
 * person left, or a room of the person's they can't read any more).
 */
async function wakeFor(ctx: ApplyContext, row: T3WatchRow): Promise<string | null> {
  const personRow = row.personId ? await loadPrincipalRow(ctx.tx, row.personId) : null;
  const person = personRow?.accountId ?? null;
  const room = await loadConversationRow(ctx.tx, row.conversationId);
  if (!person || !room || !readsRoom(room, personRow ?? null)) return null;
  const queued = await ctx.tx
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.agentId, row.agentId),
        eq(dispatches.conversationId, row.conversationId),
        eq(dispatches.state, 'queued'),
        eq(dispatches.trigger, 't3_thread'),
        inThread(row),
        eq(dispatches.onBehalfOfAccountId, person),
      ),
    )
    .orderBy(asc(dispatches.createdAt));
  for (const q of queued) {
    const [taken] = await ctx.tx
      .select({ n: count() })
      .from(t3Watches)
      .where(and(eq(t3Watches.dispatchId, q.id), ne(t3Watches.threadId, row.threadId)));
    if (Number(taken?.n ?? 0) < T3_THREADS_MAX) return q.id;
  }
  const woken = await wakeQuietly(ctx, {
    agentId: row.agentId,
    conversationId: row.conversationId,
    threadRootId: row.threadRootId,
    person,
    trigger: 't3_thread',
    coalesce: false,
    own: true,
  });
  return woken?.dispatchId ?? null;
}

export interface T3Moved {
  /** The turn that tells it; null when nobody was woken. */
  dispatchId: string | null;
  /** A turn of the agent is at work there: the next pass decides again. */
  later: boolean;
}

export const t3ThreadMoved = defineCommand({
  name: 't3code.thread_moved',
  schema: z.object({
    connectionId: Id,
    threadId: ThreadId,
    key: Key,
    /** Its work ended: the watch goes quiet once told. */
    ends: z.boolean(),
    update: T3ThreadUpdate,
    /**
     * An ordinary hand-over's run ended: its report and facts, which Whombat posts in the thread as the job's result
     * (`result.ts`) in the same commit as the wake. Null for anything else.
     */
    result: z
      .object({ text: z.string().max(JOB_REPORT_MAX).nullable(), jobResult: JobResult.omit({ sends: true }) })
      .nullable()
      .default(null),
  }),
  async apply(tx, ctx, input): Promise<T3Moved> {
    // A lapsed licence starts no agent turn: it is told after the resume.
    if (ctx.services.licence.lapsed) return { dispatchId: null, later: true };
    const [row] = await tx
      .select()
      .from(t3Watches)
      .where(
        and(
          theWatch(ctx.burrow.id, input.connectionId, input.threadId),
          eq(t3Watches.agentId, ctx.actor.id),
          eq(t3Watches.state, 'watching'),
        ),
      );
    if (!row?.wakes) return { dispatchId: null, later: false };
    // Told or seen already: an ended thread just goes quiet.
    if (row.seenKey === input.key) {
      if (input.ends)
        await tx
          .update(t3Watches)
          .set({ state: 'idle' })
          .where(theWatch(ctx.burrow.id, row.connectionId, row.threadId));
      return { dispatchId: null, later: false };
    }
    // The agent is at work there and may be reading the thread itself; once that turn is over the next pass decides.
    if (await busyThere(tx, row)) return { dispatchId: null, later: true };
    // The report goes in the thread before the wake, so the turn that is told finds it there.
    const resultMessageId =
      input.result && input.update.event === 'finished'
        ? await postJobResult(ctx, row, input.result, input.update.title)
        : null;
    const dispatchId = await wakeFor(ctx, row);
    await tx
      .update(t3Watches)
      .set({
        seenKey: input.key,
        told: { ...input.update, reported: resultMessageId !== null },
        title: input.update.title,
        dispatchId,
        state: input.ends || !dispatchId ? 'idle' : 'watching',
        ...(resultMessageId ? { resultMessageId } : {}),
      })
      .where(theWatch(ctx.burrow.id, row.connectionId, row.threadId));
    return { dispatchId, later: false };
  },
});

/**
 * `DispatchContext.t3Threads` of a `t3_thread` turn: the threads that woke it, in the order they moved on, at
 * most `T3_THREADS_MAX`; null for any other turn or when none is left.
 */
export async function t3ThreadsOf(
  db: Db,
  row: { id: string; trigger: string },
): Promise<DispatchContext['t3Threads']> {
  if (row.trigger !== 't3_thread') return null;
  const rows = await db
    .select({ told: t3Watches.told })
    .from(t3Watches)
    .where(and(eq(t3Watches.dispatchId, row.id), isNotNull(t3Watches.told)));
  const told = rows
    .map((r) => T3ThreadUpdate.safeParse(r.told))
    .flatMap((p) => (p.success ? [p.data] : []))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, T3_THREADS_MAX);
  return told.length ? told : null;
}

/** How many subagents a thread the agent hands work to may run at once (as a checklist's default). */
const HANDOVER_SUBAGENTS = 3;

/** The turn whose call goes out: its agent, its dispatch and whether it works on a customer's report. */
export interface T3CallTurn {
  agentId: string;
  dispatch: Pick<DispatchRow, 'id' | 'trigger' | 'mode' | 'onBehalfOfAccountId' | 'messageId'>;
  reportTurn: boolean;
  /** A person's turn in the thread of a report's fix that didn't land yet (`trackers/unlanded.ts`). */
  followsUpFix?: boolean;
}

/**
 * The threads each turn already gave its person's words to, so a second message of the same turn to the same thread
 * doesn't repeat them. Kept in memory: after a restart a thread may read them once more, which costs nothing.
 */
const wordsGiven = new Map<string, Set<string>>();
const WORDS_GIVEN_TURNS = 500;

function rememberWords(dispatchId: string, threadId: string): void {
  const threads = wordsGiven.get(dispatchId) ?? new Set<string>();
  threads.add(threadId);
  wordsGiven.delete(dispatchId);
  wordsGiven.set(dispatchId, threads);
  if (wordsGiven.size > WORDS_GIVEN_TURNS) wordsGiven.delete(wordsGiven.keys().next().value as string);
}

/**
 * What the person wrote to start this turn, when it is theirs to pass on (`personWordsOfTurn`); else null. Also what
 * the turn's preface goes by (`DispatchContext.t3PersonWords`), so the agent is told exactly when its brief gets them.
 */
export async function personWordsFor(db: Db, turn: T3CallTurn): Promise<string | null> {
  const { dispatch } = turn;
  if (!dispatch.messageId) return null;
  const about = { ...dispatch, reportTurn: turn.reportTurn };
  // Decided without a read for every turn no person's message started.
  const theirs = {
    text: '-',
    authorKind: 'person',
    authorAccountId: dispatch.onBehalfOfAccountId,
    provenance: null,
    briefed: false,
    deleted: false,
  };
  if (!personWordsOfTurn(about, theirs)) return null;
  const message = await loadMessageRow(db, dispatch.messageId);
  const author = message ? await loadPrincipalRow(db, message.authorId) : null;
  if (!message || !author) return null;
  return personWordsOfTurn(about, {
    text: message.text,
    authorKind: author.kind,
    authorAccountId: author.accountId ?? null,
    provenance: message.provenance ?? null,
    briefed: (await agentBriefOf(db, message.burrowId, message.id, turn.agentId)) !== null,
    deleted: message.deletedAt !== null,
  });
}

/** How `REVIEWED_COMMIT_LINES` begin: a message that has them already keeps it. */
export const REVIEWED_COMMITS_MARK = 'Keep every commit a review has read';

/**
 * What a thread that fixes something for an automation is told about the commits its reviews read. Whombat merges the fix only when the commit
 * the last review names is on the pushed branch; a thread that rewrote its history after the review (a push hook
 * refused something in an earlier commit) left a fix nobody could merge, and the run stopped for the person.
 */
export const REVIEWED_COMMIT_LINES = [
  `${REVIEWED_COMMITS_MARK}: never amend, rebase or squash it afterwards. The fix is merged only when the commit the last review names is on the pushed branch.`,
  'Before the first review, run git push --dry-run for the branch, so a hook that refuses the push shows while nothing was reviewed yet.',
  'If history must change after a review all the same, have the new head reviewed again the same way before you finish, and name the commit that review read.',
] as const;

/** A message that hands over a fix and asks for a review, with `REVIEWED_COMMIT_LINES` at its end (once). Pure. */
export function withReviewedCommitRules(message: string): string {
  if (!/\breview/i.test(message) || message.includes(REVIEWED_COMMITS_MARK)) return message;
  return `${message.trimEnd()}\n\n${REVIEWED_COMMIT_LINES.join('\n')}`;
}

/**
 * Whether this turn hands a fix to T3 Code that Whombat's own steps then review and merge: an automation's fix step
 * (the step named `fix`, as `unlanded.ts` reads it), or a person's turn that follows up on such a fix that didn't land
 * (`followsUpFix`).
 */
async function handsOverFix(db: Db, turn: T3CallTurn): Promise<boolean> {
  if (turn.followsUpFix) return true;
  if (turn.dispatch.trigger !== 'automation') return false;
  const [row] = await db
    .select({ stepId: automationRunSteps.stepId })
    .from(automationRunSteps)
    .where(eq(automationRunSteps.dispatchId, turn.dispatch.id))
    .limit(1);
  return row?.stepId === 'fix';
}

/** How `wordsGiven` remembers that a turn gave a thread `REVIEWED_COMMIT_LINES`. */
const commitRulesKey = (threadId: string) => `commit-rules ${threadId}`;

/**
 * The arguments of an agent's call to T3 Code as they go out. A message that starts a thread or goes to one ends with
 * what the person wrote, word for word, when their own message started the turn, so the coding agents read the request
 * as it was asked (once per turn and thread). A thread the agent starts is titled “<its name> - <title>”, and its
 * message then says when to use subagents, which the thread would not start unasked (docs/decisions/delegate.md).
 */
export async function t3CallArgs(
  db: Db,
  turn: T3CallTurn,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const launches = tool === 't3_thread_launch';
  if (!launches && tool !== 't3_thread_send') return args;
  if (launches && typeof args.title !== 'string') return args;
  let message = args.message;
  if (typeof message === 'string' && message.trim()) {
    const threadId = launches ? null : typeof args.threadId === 'string' ? args.threadId : null;
    const given = threadId !== null && wordsGiven.get(turn.dispatch.id)?.has(threadId) === true;
    if (!given) message = withPersonWords(message, await personWordsFor(db, turn));
    if (launches) message = withLaunchRules(message as string, turn.dispatch);
    // Once per turn and thread, like the person's words: an answer about a finding doesn't repeat them.
    const told =
      threadId !== null && wordsGiven.get(turn.dispatch.id)?.has(commitRulesKey(threadId)) === true;
    if (!told && (await handsOverFix(db, turn))) message = withReviewedCommitRules(message as string);
  }
  if (!launches) return message === args.message ? args : { ...args, message };
  const agent = await loadPrincipalRow(db, turn.agentId);
  if (!agent) return args;
  return { ...args, title: launchTitle(shortName(agent), args.title as string), message };
}

/**
 * A new thread's message as it goes out: when to use subagents, and, when Whombat posts its last message in the
 * person's chat as the job's result (a turn that hands the work over for the person), how to write that message. Each
 * once: a message that has them already keeps it.
 */
export function withLaunchRules(
  message: string,
  dispatch: Pick<DispatchRow, 'trigger' | 'mode' | 'onBehalfOfAccountId'>,
): string {
  let out = message;
  if (!out.includes(SUBAGENT_MARK))
    out = `${out.trimEnd()}\n\n${subagentRules(HANDOVER_SUBAGENTS).join('\n')}`;
  if (reportsToPerson(dispatch) && !out.includes(JOB_REPORT_MARK))
    out = `${out.trimEnd()}\n\n${JOB_REPORT_LINES.join('\n')}`;
  return out;
}

/**
 * Whether the end of a thread this turn starts is posted in the person's chat as the job's result: a hand-over for the
 * person, not a council's or a checklist's turn, whose threads report to their cards.
 */
function reportsToPerson(dispatch: Pick<DispatchRow, 'trigger' | 'mode' | 'onBehalfOfAccountId'>): boolean {
  return handsOver(dispatch) && dispatch.trigger !== 'council' && dispatch.trigger !== 'delegation';
}

/**
 * The turns that hand work to T3 Code for the person, and are woken when it moves on. The others still have their
 * threads settled: Whombat started them, so it tidies them away too.
 */
function handsOver(dispatch: Pick<DispatchRow, 'trigger' | 'mode' | 'onBehalfOfAccountId'>): boolean {
  // An outsiders' turn and an automation's step wait for their thread in their own turn.
  if (outsidersTurn(dispatch) || dispatch.mode === 'answer') return false;
  return dispatch.trigger !== 'automation' && dispatch.trigger !== 'feedback';
}

/**
 * Whether a thread the agent starts is a prompt's whose work Whombat merges (prompts.md): the person used a prompt with
 * “Merge into main when it’s done” (the brief Whombat recorded on their message says so) and the thread was given the
 * merge lines. Only the start counts; a later message to the thread keeps what its start said.
 */
async function mergeAsked(
  db: Db,
  call: {
    burrowId: string;
    agentId: string;
    tool: string;
    args: Record<string, unknown>;
    dispatch: Pick<DispatchRow, 'messageId'>;
  },
): Promise<boolean> {
  if (call.tool !== 't3_thread_launch' || !call.dispatch.messageId) return false;
  if (typeof call.args.message !== 'string' || !call.args.message.includes(PROMPT_MERGE_MARK)) return false;
  const brief = await agentBriefOf(db, call.burrowId, call.dispatch.messageId, call.agentId);
  return brief?.includes(PROMPT_MERGE_MARK) === true;
}

/**
 * What one of the agent's calls to T3 Code means for the threads Whombat watches for it: committed as
 * the agent, after the call. A failure here never fails the call: the watch is a convenience.
 */
export async function followT3Call(
  services: Services,
  call: {
    burrowId: string;
    agentId: string;
    connectionId: string;
    dispatch: Pick<
      DispatchRow,
      'id' | 'trigger' | 'mode' | 'onBehalfOfAccountId' | 'conversationId' | 'threadRootId' | 'messageId'
    >;
    personId: string | null;
    /** The turn works on a customer's report: a thread it hands work to is that report's (`report-turn.ts`). */
    reportTurn?: boolean;
    tool: string;
    args: Record<string, unknown>;
    output: { content: string; structured?: unknown; isError: boolean };
  },
): Promise<void> {
  if (call.output.isError) return;
  let body: unknown = call.output.structured;
  if (body === undefined) {
    try {
      body = JSON.parse(call.output.content);
    } catch {
      return;
    }
  }
  const meaning = seenOfCall(call.tool, call.args, body);
  if (!meaning) return;
  const opts = { burrowId: call.burrowId, actorId: call.agentId };
  try {
    if (meaning.how === 'arm') {
      // The thread has this turn's person's words now: a later message of the turn doesn't repeat them.
      if (typeof call.args.message === 'string' && call.args.message.includes(PERSON_WORDS_MARK))
        rememberWords(call.dispatch.id, meaning.threadId);
      if (typeof call.args.message === 'string' && call.args.message.includes(REVIEWED_COMMITS_MARK))
        rememberWords(call.dispatch.id, commitRulesKey(meaning.threadId));
      await services.pipeline.commit(
        followT3Thread,
        {
          how: 'arm',
          connectionId: call.connectionId,
          threadId: meaning.threadId,
          title: meaning.title,
          conversationId: call.dispatch.conversationId,
          threadRootId: call.dispatch.threadRootId ?? null,
          personId: call.personId,
          wakes: handsOver(call.dispatch),
          ...(call.reportTurn ? { report: true } : {}),
          ...((await mergeAsked(services.db, call)) ? { merge: true } : {}),
        },
        opts,
      );
      // The thread shows it at once, not at the watcher's next read.
      await publishHandoffs(services, call.burrowId, call.dispatch.conversationId);
      return;
    }
    // Only a watch there is to change: most reads are of threads nobody watches, or show what is known already.
    const [watch] = await services.db
      .select({ seenKey: t3Watches.seenKey, state: t3Watches.state })
      .from(t3Watches)
      .where(
        and(
          theWatch(call.burrowId, call.connectionId, meaning.threadId),
          eq(t3Watches.agentId, call.agentId),
        ),
      );
    if (!watch) return;
    if (meaning.how === 'stop' ? watch.state === 'idle' : watch.seenKey === meaning.key) return;
    await services.pipeline.commit(
      followT3Thread,
      meaning.how === 'stop'
        ? {
            how: 'stop',
            connectionId: call.connectionId,
            threadId: meaning.threadId,
            ...(call.reportTurn ? { report: true } : {}),
          }
        : {
            how: 'seen',
            connectionId: call.connectionId,
            threadId: meaning.threadId,
            key: meaning.key,
            ...(call.reportTurn ? { report: true } : {}),
          },
      opts,
    );
    if (meaning.how === 'stop') await publishHandoffs(services, call.burrowId, call.dispatch.conversationId);
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error', tool: call.tool },
      't3 watch: a call could not be followed',
    );
  }
}
