/**
 * What goes on from each thread, for its row: the newest live council or checklist (`ChatThread.work`). A thread's row
 * says who is at work, what they do now and how far along it is (docs/decisions/one-chat.md).
 */
import type { ChatThread, CouncilStage, ThreadWork } from '@whombat/core';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { markOf } from '../council/members';
import type { Db } from '../db/client';
import { councilMembers, councils, delegations, delegationTasks, t3Watches } from '../db/schema/index';
import { numbersOf } from '../delegate/card';
import { iso } from '../lib/time';
import { progressOf } from '../t3code/progress';

const TASKS_DONE = ['done'] as const;
const TASKS_LEFT_OUT = ['offered', 'skipped'] as const;

/**
 * A council or checklist going on from each thread, for its row: the newest live one. A council at its
 * go-ahead or a checklist with a task that waits for the person's OK needs them.
 */
export async function threadWorks(
  db: Db,
  conversationId: string,
  rootIds: readonly string[],
): Promise<Map<string, ThreadWork>> {
  const out = new Map<string, ThreadWork>();
  if (!rootIds.length) return out;
  const ids = [...rootIds];
  const live = await db
    .select({
      id: councils.id,
      rootId: councils.threadRootId,
      stage: councils.stage,
      round: councils.round,
      createdAt: councils.createdAt,
    })
    .from(councils)
    .where(
      and(
        eq(councils.conversationId, conversationId),
        inArray(councils.threadRootId, ids),
        notInArray(councils.stage, ['done', 'stopped']),
      ),
    )
    .orderBy(desc(councils.createdAt));
  const councilIds = live.map((c) => c.id);
  const members = councilIds.length
    ? await db
        .select({
          councilId: councilMembers.councilId,
          role: councilMembers.role,
          stage: councilMembers.stage,
          round: councilMembers.round,
          position: councilMembers.position,
          provider: councilMembers.provider,
          label: councilMembers.label,
          state: councilMembers.state,
        })
        .from(councilMembers)
        .where(inArray(councilMembers.councilId, councilIds))
    : [];
  for (const c of live) {
    if (!c.rootId || out.has(c.rootId)) continue;
    const round = members
      .filter(
        (m) => m.councilId === c.id && m.role === 'member' && m.stage === c.stage && m.round === c.round,
      )
      .sort((a, b) => a.position - b.position);
    out.set(c.rootId, {
      kind: 'council',
      stage: c.stage as CouncilStage,
      answered: round.filter((m) => m.state !== 'working').length,
      of: round.length,
      members: round.slice(0, 6).map((m) => ({
        mark: markOf(m.provider),
        letter: (m.label.trim()[0] ?? '?').toUpperCase(),
        working: m.state === 'working',
      })),
      since: iso(c.createdAt),
    });
  }
  const checklists = await db
    .select({
      id: delegations.id,
      rootId: delegations.threadRootId,
      stage: delegations.stage,
      handedAt: delegations.handedAt,
      createdAt: delegations.createdAt,
    })
    .from(delegations)
    .where(
      and(
        eq(delegations.conversationId, conversationId),
        inArray(delegations.threadRootId, ids),
        inArray(delegations.stage, ['working', 'offer']),
      ),
    )
    .orderBy(desc(delegations.createdAt));
  const listIds = checklists.map((d) => d.id);
  const tasks = listIds.length
    ? await db
        .select({
          id: delegationTasks.id,
          delegationId: delegationTasks.delegationId,
          state: delegationTasks.state,
          mergeState: delegationTasks.mergeState,
          threadId: delegationTasks.threadId,
          position: delegationTasks.position,
          createdAt: delegationTasks.createdAt,
          kind: delegationTasks.kind,
        })
        .from(delegationTasks)
        .where(inArray(delegationTasks.delegationId, listIds))
    : [];
  const needsYou = await tasksNeedingYou(db, listIds);
  const reported = await reportedTasks(db, tasks);
  for (const d of checklists) {
    if (!d.rootId || out.has(d.rootId)) continue;
    if (d.stage === 'offer') {
      // An offered list waits for the person's Hand over (a council's own says so on the council's line).
      out.set(d.rootId, {
        kind: 'tasks',
        done: 0,
        total: tasks.filter((t) => t.delegationId === d.id && t.state === 'offered' && t.kind === 'task')
          .length,
        working: 0,
        needsYou: true,
        offered: true,
        since: iso(d.createdAt),
      });
      continue;
    }
    const mine = tasks.filter(
      (t) => t.delegationId === d.id && !(TASKS_LEFT_OUT as readonly string[]).includes(t.state),
    );
    // A thread doing several tasks works as one, and what it said it finished is done.
    const working = mine.filter((t) => t.state === 'working');
    out.set(d.rootId, {
      kind: 'tasks',
      done:
        mine.filter((t) => (TASKS_DONE as readonly string[]).includes(t.state)).length +
        working.filter((t) => reported.has(t.id)).length,
      total: mine.length,
      working: new Set(working.map((t) => t.threadId ?? t.id)).size,
      needsYou: needsYou.has(d.id),
      since: iso(d.handedAt ?? new Date()),
    });
  }
  return out;
}

/** The checklists with a task whose T3 Code thread waits for the person's answer or permission. */
async function tasksNeedingYou(db: Db, delegationIds: readonly string[]): Promise<Set<string>> {
  if (!delegationIds.length) return new Set();
  const rows = await db
    .select({ delegationId: delegationTasks.delegationId, pending: t3Watches.pending })
    .from(t3Watches)
    .innerJoin(delegationTasks, eq(delegationTasks.id, t3Watches.delegationTaskId))
    .where(and(inArray(delegationTasks.delegationId, [...delegationIds]), eq(t3Watches.state, 'watching')));
  return new Set(rows.filter((r) => r.pending !== null).map((r) => r.delegationId));
}

/**
 * The working tasks whose thread said it finished them (`Item 3 done: …`, kept on the thread's watch by the number the
 * task has on its card).
 */
async function reportedTasks(
  db: Db,
  tasks: readonly {
    id: string;
    delegationId: string;
    state: string;
    threadId: string | null;
    position: number;
    createdAt: Date;
    kind: string;
  }[],
): Promise<Set<string>> {
  const working = tasks.filter((t) => t.state === 'working' && t.threadId);
  if (!working.length) return new Set();
  const watches = await db
    .select({
      taskId: t3Watches.delegationTaskId,
      threadId: t3Watches.threadId,
      progress: t3Watches.progress,
    })
    .from(t3Watches)
    .where(
      inArray(
        t3Watches.delegationTaskId,
        working.map((t) => t.id),
      ),
    );
  const saidOf = new Map(watches.map((w) => [w.threadId, progressOf(w.progress).reported]));
  const out = new Set<string>();
  for (const id of new Set(working.map((t) => t.delegationId))) {
    const list = tasks.filter((t) => t.delegationId === id);
    const numbers = numbersOf(list);
    for (const t of working)
      if (
        t.delegationId === id &&
        t.kind !== 'final' &&
        saidOf.get(t.threadId as string)?.[String(numbers.get(t.id))]
      )
        out.add(t.id);
  }
  return out;
}

/** A thread with the work going on from it. */
export function withWork(thread: ChatThread, work: ThreadWork | undefined): ChatThread {
  return work ? { ...thread, work } : thread;
}
