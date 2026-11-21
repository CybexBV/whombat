/**
 * Where a delegation's tasks are (docs/decisions/delegate.md): whose turn it is, which hold a place, what waits to be
 * merged and whether it is all over. Pure, so the council can read it too without the delegation's commands.
 */
import type { DelegationTaskRow } from '../db/schema/delegations';
import { inOrder } from './card';
import { type GroupAiDefaults, togetherWith as groupedTasks, leadsWith as ledTasks } from './group';

export { groupMembers } from './group';

type Row = Pick<DelegationTaskRow, 'id' | 'state' | 'mergeState' | 'afterId' | 'threadId' | 'checks'> &
  Partial<Pick<DelegationTaskRow, 'kind' | 'sendPending' | 'position' | 'createdAt' | 'groupId'>>;

type GroupTask = Parameters<typeof groupedTasks>[0] & { stopPending?: boolean };

/** Work whose stop has not finished cannot be claimed again as part of another task. */
export function togetherWith<T extends GroupTask>(
  lead: GroupTask,
  tasks: readonly T[],
  defaults?: GroupAiDefaults,
): T[] {
  return lead.stopPending
    ? []
    : groupedTasks(
        lead,
        tasks.filter((task) => !task.stopPending),
        defaults,
      );
}

/** The tasks a starting task's thread leads; work still stopping is never claimed again. */
export function leadsWith<T extends GroupTask>(
  lead: GroupTask,
  tasks: readonly T[],
  defaults?: GroupAiDefaults,
): T[] {
  return lead.stopPending
    ? []
    : ledTasks(
        lead,
        tasks.filter((task) => !task.stopPending),
        defaults,
      );
}

/** The check of everything merged together at the end of a list (DLG-41). */
export const isFinal = (t: Pick<DelegationTaskRow, 'kind'> | Partial<Pick<DelegationTaskRow, 'kind'>>) =>
  t.kind === 'final';

/**
 * Whether a predecessor's branch can be used. A batch can build on a verified source PR before integration; the
 * older workflow waits for the predecessor to merge first.
 */
export function landed(
  t:
    | (Pick<DelegationTaskRow, 'state' | 'mergeState'> &
        Partial<Pick<DelegationTaskRow, 'checks' | 'pr' | 'branch' | 'stopPending'>>)
    | undefined,
  batch = false,
): boolean {
  if (t?.state !== 'done' || t.stopPending) return false;
  if (batch) {
    if (t.checks === 'running' || t.checks === 'failing') return false;
    if (t.mergeState === 'waiting' || t.mergeState === 'kept')
      return (t.checks === 'passing' || t.checks === 'none') && !!t.pr && !!t.branch;
  }
  return t.mergeState !== 'waiting' && t.mergeState !== 'merging' && t.mergeState !== 'not_merged';
}

/** A branch kept for review must not reach main indirectly through one of its descendants. */
function keptAncestor(t: DelegationTaskRow, byId: Map<string, DelegationTaskRow>): boolean {
  const seen = new Set([t.id]);
  let id = t.afterId;
  while (id) {
    if (seen.has(id)) return true;
    seen.add(id);
    const before = byId.get(id);
    if (!before) return false;
    if (before.mergeState === 'kept') return true;
    id = before.afterId;
  }
  return false;
}

/**
 * Ordinary tasks whose predecessor's branch is ready. More work for an existing thread can resume directly. Queued
 * descendants are claimed with their predecessor, except incompatible choices that need their own later thread.
 */
function readyOrdinary(tasks: readonly DelegationTaskRow[], batch = false): DelegationTaskRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return inOrder(tasks).filter(
    (t) =>
      !isFinal(t) &&
      t.state === 'queued' &&
      t.picked !== false &&
      !t.stopPending &&
      (!batch || t.mergeState === 'kept' || !keptAncestor(t, byId)) &&
      (!!(t.sendPending && t.threadId) || !t.afterId || landed(byId.get(t.afterId), batch)),
  );
}

/** Ordinary work is over once none works or can start; a batch's final thread handles the waiting source PRs. */
function ordinaryOver(tasks: readonly DelegationTaskRow[], batch = false): boolean {
  const ordinary = tasks.filter((t) => !isFinal(t));
  return (
    !ordinary.some((t) => t.state === 'working') &&
    readyOrdinary(ordinary, batch).length === 0 &&
    (batch || mergesWaiting(ordinary).length === 0)
  );
}

/** Passing source branches to combine, each after its prerequisites even when the card is displayed another way. */
export function eligibleIntegration(tasks: readonly DelegationTaskRow[]): DelegationTaskRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const eligible = new Set(
    tasks
      .filter(
        (t) =>
          !isFinal(t) &&
          t.state === 'done' &&
          t.mergeState === 'waiting' &&
          t.picked !== false &&
          !t.stopPending &&
          !!t.pr &&
          (t.checks === 'passing' || t.checks === 'none') &&
          !keptAncestor(t, byId),
      )
      .map((t) => t.id),
  );
  const out: DelegationTaskRow[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (t: DelegationTaskRow): boolean => {
    if (visited.has(t.id)) return true;
    if (visiting.has(t.id)) return false;
    visiting.add(t.id);
    const before = t.afterId ? byId.get(t.afterId) : undefined;
    if (before && !visit(before)) return false;
    visiting.delete(t.id);
    visited.add(t.id);
    if (eligible.has(t.id)) out.push(t);
    return true;
  };
  for (const task of inOrder(tasks)) if (eligible.has(task.id)) visit(task);
  return out;
}

/** The work to combine, one line per pull request: tasks done in one thread share theirs. */
export function byPullRequest(
  tasks: readonly Pick<DelegationTaskRow, 'title' | 'pr' | 'branch'>[],
): { title: string; pr: string; branch: string | null }[] {
  const out = new Map<string, { titles: string[]; branch: string | null }>();
  for (const t of tasks) {
    if (!t.pr) continue;
    const at = out.get(t.pr) ?? { titles: [], branch: t.branch };
    at.titles.push(t.title);
    out.set(t.pr, at);
  }
  return [...out].map(([pr, { titles, branch }]) => ({ title: titles.join('; '), pr, branch }));
}

/**
 * The one pull request all the work to combine is in (one thread led it all), or null: the final check then checks that
 * pull request itself instead of copying it into another.
 */
export function onePullRequest(
  tasks: readonly DelegationTaskRow[],
): { title: string; pr: string; branch: string | null } | null {
  const prs = byPullRequest(eligibleIntegration(tasks));
  return prs.length === 1 ? (prs[0] ?? null) : null;
}

/** The combined check waits for ordinary work, then checks eligible branches or work already merged. */
export function finalDue(tasks: readonly DelegationTaskRow[], batch = false): boolean {
  return (
    ordinaryOver(tasks, batch) &&
    ((batch && eligibleIntegration(tasks).length > 0) ||
      tasks.some((t) => !isFinal(t) && t.mergeState === 'merged'))
  );
}

/** The tasks whose turn it is now, in order; the final check last, once it is due. */
export function readyTasks(tasks: readonly DelegationTaskRow[], batch = false): DelegationTaskRow[] {
  const ready = readyOrdinary(tasks, batch);
  const final = tasks.find((t) => isFinal(t) && t.state === 'queued' && !t.stopPending);
  if (final && ((!batch && final.sendPending && final.threadId) || finalDue(tasks, batch))) ready.push(final);
  return ready;
}

/**
 * The task a working task's thread started for: tasks done together share one thread (DLG-42), its first holds the
 * place. Followed through what each comes after while that one works in the same thread (or both are still starting).
 */
function placeOf(t: Row, byId: Map<string, Row>): string {
  let at = t;
  for (let i = 0; i <= byId.size; i++) {
    const before = at.afterId ? byId.get(at.afterId) : undefined;
    if (before?.state !== 'working' || before.threadId !== at.threadId) break;
    at = before;
  }
  return at.id;
}

/**
 * The tasks holding a place now, one per thread: at work, but not one only waiting for its pull request's checks
 * (DLG-21); tasks done together in one thread hold one place (DLG-42), whether or not one comes after another: those
 * in one thread share it, and those launched together share their group while the thread starts.
 */
export function busyTasks<T extends Row>(tasks: readonly T[]): T[] {
  const byId = new Map<string, Row>(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  return tasks.filter((t) => {
    if (t.state !== 'working' || t.checks === 'running') return false;
    const place = t.threadId ? `thread:${t.threadId}` : t.groupId ? `group:${t.groupId}` : placeOf(t, byId);
    if (seen.has(place)) return false;
    seen.add(place);
    return true;
  });
}

/** Done tasks whose pull request waits its turn to be merged, in order. */
export function mergesWaiting(tasks: readonly DelegationTaskRow[]): DelegationTaskRow[] {
  return inOrder(tasks).filter((t) => t.state === 'done' && t.mergeState === 'waiting');
}

/**
 * Whether automatic progress ended. A batch remains open for its combined check and merge; when that check fails,
 * its source PRs stay open while the agent finishes honestly as incomplete.
 */
export function allOver(tasks: readonly DelegationTaskRow[], batch = false): boolean {
  if (tasks.some((t) => t.state === 'working') || readyTasks(tasks, batch).length > 0) return false;
  if (!batch) return mergesWaiting(tasks).length === 0;
  // The final thread first checks its candidate, then gets permission to merge that exact candidate.
  if (tasks.some((t) => isFinal(t) && t.state === 'done' && t.mergeState === 'waiting')) return false;
  // A missing mandatory check cannot make passing but unmerged source branches look finished.
  if (!tasks.some(isFinal) && eligibleIntegration(tasks).length > 0) return false;
  // A terminal failed check leaves source PRs open and lets the agent honestly finish as incomplete.
  return true;
}
