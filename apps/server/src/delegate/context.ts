/**
 * What the agent reads of a delegation (docs/decisions/delegate.md): `DispatchContext.delegation` of a `delegation`
 * turn (the tasks whose end woke it, with their answers; every task's once all are over), of any other turn of the
 * person's in the delegation's thread (`reply`: the card as it is, so the agent can change it after they talked about
 * it), and `delegate_read`'s answer (every answer). Answers are their agents' words: the persona fences them in as data.
 */
import {
  DELEGATION_ANSWER_MAX,
  DELEGATION_BRIEF_MAX,
  type DelegationDispatchContext,
  type DelegationEvent,
  type DelegationTaskUpdate,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import {
  catalogConnections,
  councilMembers,
  type DelegationRow,
  type DelegationTaskRow,
  delegations,
  delegationTasks,
  messages,
} from '../db/schema/index';
import { loadPrincipalRow } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import { fitAnswer } from '../t3code/threads';
import { mergeOnCard } from './card';
import { allOver, delegationOfThread, isLive, loadTasks, taskWatches } from './commands';

/** An ended delegation still comes with the person's turns in its thread this long (to retry, add, talk about it). */
export const DELEGATION_RECENT_DAYS = 7;
/** How much of each brief a turn carries (the whole one: `delegate_read`). */
const BRIEF_SHOWN = 500;
/** How much of each answer a turn tells. */
const ANSWER_TOLD = 4000;
/**
 * How much of each answer the turn after every task tells, with more than a few tasks: their notes and the lines the
 * summary needs are at the answers' ends (DLG-26), and `delegate_read` has the rest.
 */
const ANSWER_TOLD_ALL = 1500;
const MERGE_TOLD_ALL = 600;

/** The end of an answer, where its summary and last lines are. */
const tail = (s: string, max: number) => (s.length > max ? `…${s.slice(s.length - max + 1).trimStart()}` : s);

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * The delegation as the agent reads it. `told(task)`: whether this turn tells that task's answer; `full`: whole briefs
 * and answers (`delegate_read`).
 */
export async function delegationContext(
  db: Db | Tx,
  d: DelegationRow,
  event: DelegationEvent,
  told: (t: DelegationTaskRow) => boolean,
  full = false,
): Promise<DelegationDispatchContext | null> {
  const [tasks, connection] = await Promise.all([
    loadTasks(db, d.id),
    db
      .select({ handle: catalogConnections.handle })
      .from(catalogConnections)
      .where(eq(catalogConnections.id, d.connectionId)),
  ]);
  const handle = connection[0]?.handle;
  if (!handle) return null;
  const watches = await taskWatches(db, d, tasks);
  const pendingOf = new Map(watches.map((w) => [w.threadId, w.pending]));
  const numbers = new Map(tasks.map((t, i) => [t.id, i + 1]));
  const brief = !full && event === 'all' && tasks.length > 3;
  // Its start and its end: the lines the agent needs close an answer.
  const answerOf = (text: string) =>
    full
      ? cut(text, DELEGATION_ANSWER_MAX)
      : brief
        ? tail(text, ANSWER_TOLD_ALL)
        : fitAnswer(text, ANSWER_TOLD);
  // Tasks one thread did together share its answer: it is told once, on the first of them.
  const toldIn = new Map<string, { n: number; answer: string }>();
  const list: DelegationTaskUpdate[] = tasks.map((t) => {
    const tells = told(t) && !!t.answer;
    const first = tells && t.threadId ? toldIn.get(t.threadId) : undefined;
    const shared = first && first.answer === t.answer ? first.n : null;
    if (tells && t.threadId && t.answer && !first)
      toldIn.set(t.threadId, { n: numbers.get(t.id) ?? 1, answer: t.answer });
    return {
      taskId: t.id as DelegationTaskUpdate['taskId'],
      n: numbers.get(t.id) ?? 1,
      title: t.title.slice(0, 120),
      why: t.why?.slice(0, 200) ?? null,
      brief: cut(t.brief, full ? DELEGATION_BRIEF_MAX : BRIEF_SHOWN),
      picked: t.picked,
      after: t.afterId ? (numbers.get(t.afterId) ?? null) : null,
      state: t.state,
      pending: t.state === 'working' && t.threadId ? (pendingOf.get(t.threadId) ?? null) : null,
      threadId: t.threadId?.slice(0, 300) ?? null,
      branch: t.branch?.slice(0, 300) ?? null,
      pr: t.pr?.slice(0, 500) ?? null,
      note: t.note?.slice(0, 300) ?? null,
      told: tells,
      answer: tells && t.answer && shared === null ? answerOf(t.answer) : null,
      ...(shared !== null ? { answerWith: shared } : {}),
      ...(t.item && t.item !== numbers.get(t.id) ? { item: t.item } : {}),
      merge: mergeOnCard(t),
      mergeAnswer:
        tells && t.mergeAnswer
          ? brief
            ? tail(t.mergeAnswer, MERGE_TOLD_ALL)
            : cut(t.mergeAnswer, full ? DELEGATION_ANSWER_MAX : ANSWER_TOLD)
          : null,
      checks: t.checks,
      ...(t.areas.length ? { areas: t.areas.slice(0, 8) } : {}),
    };
  });
  return {
    delegationId: d.id as DelegationDispatchContext['delegationId'],
    title: d.title.slice(0, 120),
    project: d.projectTitle?.slice(0, 200) || null,
    stage: d.stage,
    event,
    atOnce: d.atOnce,
    pullRequests: d.pullRequests,
    merge: d.merge,
    connection: handle as DelegationDispatchContext['connection'],
    tasks: list,
    rules: d.rules,
    councilId: (d.councilId as DelegationDispatchContext['councilId']) ?? null,
  };
}

/** A `delegation` turn's delegation: the one whose tasks told it. */
async function wokenBy(db: Db, dispatchId: string): Promise<DelegationDispatchContext | null> {
  const [told] = await db
    .select({ delegationId: delegationTasks.delegationId })
    .from(delegationTasks)
    .where(eq(delegationTasks.dispatchId, dispatchId))
    .limit(1);
  if (!told) return null;
  const [d] = await db.select().from(delegations).where(eq(delegations.id, told.delegationId));
  if (!d) return null;
  const tasks = await loadTasks(db, d.id);
  const over = d.stage === 'working' && allOver(tasks, d.integrationMode === 'batch');
  // Once all are over, every ended task's answer: the agent sums them up.
  return delegationContext(db, d, over ? 'all' : 'task', (t) =>
    over ? ['done', 'failed', 'stopped', 'timed_out'].includes(t.state) : t.dispatchId === dispatchId,
  );
}

/**
 * `DispatchContext.delegation`: a `delegation` turn's, else the delegation of the thread a turn of the person's with
 * this agent works in (live, or ended in the last week); null for any other turn.
 */
export async function delegationOfTurn(
  db: Db,
  row: Pick<DispatchRow, 'id' | 'trigger' | 'burrowId' | 'agentId' | 'conversationId'> &
    Partial<Pick<DispatchRow, 'threadRootId' | 'messageId' | 'onBehalfOfAccountId'>>,
  now: Date,
): Promise<DelegationDispatchContext | null> {
  if (row.trigger === 'delegation') return wokenBy(db, row.id);
  // A council's turn once its plan's tasks are over (CNL-61): the checklist, every answer told.
  if (row.trigger === 'council') return councilsChecklist(db, row);
  if (!row.onBehalfOfAccountId) return null;
  let root = row.threadRootId ?? null;
  if (!root && row.messageId) {
    const [m] = await db
      .select({ id: messages.id, threadRootId: messages.threadRootId })
      .from(messages)
      .where(eq(messages.id, row.messageId));
    root = m ? (m.threadRootId ?? m.id) : null;
  }
  if (!root) return null;
  const d = await delegationOfThread(db, row.burrowId, row.conversationId, root);
  if (!d || d.threadRootId !== root || d.agentId !== row.agentId) return null;
  if (!isLive(d) && (!d.endedAt || now.getTime() - d.endedAt.getTime() > DELEGATION_RECENT_DAYS * 86_400_000))
    return null;
  // Only the person it works for: another person's turn in a shared room doesn't change their card.
  const person = d.personId ? await loadPrincipalRow(db, d.personId) : null;
  if (!person?.accountId || person.accountId !== row.onBehalfOfAccountId) return null;
  return delegationContext(db, d, 'reply', () => false);
}

/**
 * The checklist a council's turn carries (CNL-61): its plan's delegation in the thread, once handed over. The turn its
 * tasks' end woke is told their answers; a member's answer in a check round is told the checklist as it is, without
 * them again (`delegate_read` has them).
 */
async function councilsChecklist(
  db: Db,
  row: Pick<DispatchRow, 'id' | 'burrowId' | 'agentId' | 'conversationId'> &
    Partial<Pick<DispatchRow, 'threadRootId'>>,
): Promise<DelegationDispatchContext | null> {
  const d = await delegationOfThread(db, row.burrowId, row.conversationId, row.threadRootId ?? null);
  if (!d?.councilId || !d.handedAt || d.agentId !== row.agentId) return null;
  const tasks = await loadTasks(db, d.id);
  const over = d.stage !== 'working' || allOver(tasks, d.integrationMode === 'batch');
  const [member] = await db
    .select({ id: councilMembers.id })
    .from(councilMembers)
    .where(eq(councilMembers.dispatchId, row.id))
    .limit(1);
  return delegationContext(
    db,
    d,
    over ? 'all' : 'task',
    (t) => !member && ['done', 'failed', 'stopped', 'timed_out'].includes(t.state),
  );
}
