/**
 * Work supervision in the cache (contracts 0.12, Whombat work-supervision WS-01…WS-19): plans everywhere they
 * show, observed activity rows, and the work overview (`work.overview`), derived on the server and only ever refetched.
 *
 * - Plans are versioned by `updatedAt`: an older plan (a late event, a mutation's answer that raced a newer
 *   event) never replaces a newer one.
 * - Activity rows are upserted by id and ordered by `(seq, updatedAt)`: a duplicate or an older report changes
 *   nothing (WS-12), so duplicates and out-of-order delivery end in the same list.
 * - `work.overview` is built per viewer from approvals, plans, turns, runs and automation runs: the events that can
 *   move an item mark it stale (active views refetch) instead of guessing the server's sections.
 */
import type { QueryClient } from '@tanstack/query-core';
import type { Activity, CanvasDetail, Plan, RunDetail, WorkOverview } from '@whombat/core';
import { endpointQueries, patchEndpoint, sameBurrow } from './cache';
import { queryKeys } from './keys';
import { cardPatchers, mapList, mapMessagesIn, patchCard, removeWhere } from './reducers';

/* Plans ------------------------------------------------------------------------------------------ */

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NEGATIVE_INFINITY);

/** `next` is at least as new as `prev` (by `updatedAt`). */
export function planIsNewer(prev: Plan, next: Plan): boolean {
  return time(next.updatedAt) >= time(prev.updatedAt);
}

/** Open = some step is neither done nor cancelled (`plans.list?status=open`). */
export function planIsOpen(plan: Pick<Plan, 'steps'>): boolean {
  return plan.steps.some((s) => s.state !== 'done' && s.state !== 'cancelled');
}

/**
 * One plan into a `plans.list` page: replaced in place (unless ours is newer), inserted newest first when it
 * matches the list's filter, removed when it no longer does.
 */
export function reducePlanList(
  plans: readonly Plan[],
  plan: Plan,
  filter: { conversationId?: unknown; status?: unknown },
): Plan[] {
  const i = plans.findIndex((p) => p.id === plan.id);
  if (i >= 0 && !planIsNewer(plans[i] as Plan, plan)) return plans as Plan[];
  const matches =
    (typeof filter.conversationId !== 'string' || filter.conversationId === plan.conversationId) &&
    (filter.status === 'all' || planIsOpen(plan));
  if (!matches) return removeWhere(plans, (p) => p.id === plan.id);
  if (i >= 0) {
    if (plans[i] === plan) return plans as Plan[];
    const next = [...plans];
    next[i] = plan;
    return next;
  }
  // Newest first by creation (plans without a creation time are seeded ones: last).
  const at = (p: Plan) => time(p.createdAt ?? null);
  const next = [...plans];
  const j = next.findIndex((p) => at(p) < at(plan));
  next.splice(j < 0 ? next.length : j, 0, plan);
  return next;
}

/**
 * Put a plan's new state everywhere it shows: `plans.get`, `plans.list`, plan cards in every cached message
 * list / thread / message, and the canvas it belongs to. Older states are ignored.
 */
export function applyPlan(qc: QueryClient, plan: Plan): void {
  patchEndpoint<{ plan: Plan }>(qc, 'plans.get', (d) =>
    d.plan.id === plan.id && d.plan !== plan && planIsNewer(d.plan, plan) ? { ...d, plan } : d,
  );
  patchEndpoint<{ plans: Plan[] }>(qc, 'plans.list', (d, key) => {
    if (!sameBurrow(qc, key, plan.burrowId)) return d;
    const plans = reducePlanList(d.plans, plan, key.query);
    return plans === d.plans ? d : { ...d, plans };
  });
  const patch = cardPatchers.plan(plan);
  for (const id of ['messages.list', 'messages.thread', 'messages.get']) {
    patchEndpoint<unknown>(qc, id, (d) =>
      mapMessagesIn(d, (m) => {
        const card = m.card;
        if (card?.kind !== 'plan' || card.plan.id !== plan.id || !planIsNewer(card.plan, plan)) return m;
        return patchCard(m, patch);
      }),
    );
  }
  patchEndpoint<CanvasDetail>(qc, 'canvases.get', (d) =>
    d.plan?.id === plan.id && planIsNewer(d.plan, plan) ? { ...d, plan } : d,
  );
}

/* Activity --------------------------------------------------------------------------------------- */

/** `next` reports something the row doesn't have yet (a later `seq`, or the same one updated later). */
export function activityIsNewer(prev: Activity, next: Activity): boolean {
  if (next.seq !== prev.seq) return next.seq > prev.seq;
  return time(next.updatedAt) > time(prev.updatedAt);
}

/** Oldest first, as `activity.list` returns them: by start, then attempt and seq, then id. */
function compareActivity(a: Activity, b: Activity): number {
  return (
    time(a.startedAt) - time(b.startedAt) ||
    a.attempt - b.attempt ||
    a.seq - b.seq ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Upsert one row into an oldest-first list; an older or repeated report returns the list unchanged. */
export function reduceActivityList(list: readonly Activity[], activity: Activity): Activity[] {
  const i = list.findIndex((a) => a.id === activity.id);
  if (i >= 0) {
    const prev = list[i] as Activity;
    if (!activityIsNewer(prev, activity)) return list as Activity[];
    const next = [...list];
    next[i] = activity;
    // A row keeps its place unless its start moved (it never does in practice).
    return prev.startedAt === activity.startedAt ? next : next.sort(compareActivity);
  }
  const next = [...list];
  let j = next.length;
  while (j > 0 && compareActivity(next[j - 1] as Activity, activity) > 0) j--;
  next.splice(j, 0, activity);
  return next;
}

export interface ActivityListData {
  activities: Activity[];
  cursor: string | null;
  hasMore: boolean;
}

/**
 * Put one activity row into every cached `activity.list` it belongs to (by conversation, turn or run) and into the
 * Work item of its turn. A list by run number whose run id the cache can't tell is refetched instead.
 */
export function applyActivity(qc: QueryClient, activity: Activity): void {
  const runIdOf = (number: number): string | null => {
    for (const q of endpointQueries(qc, 'runs.get')) {
      const d = q.state.data as RunDetail | undefined;
      if (d?.run.number === number) return d.run.id;
    }
    return null;
  };
  let unknownRun = false;
  patchEndpoint<ActivityListData>(qc, 'activity.list', (d, key) => {
    if (!sameBurrow(qc, key, activity.burrowId)) return d;
    const q = key.query;
    let belongs = false;
    if (typeof q.dispatchId === 'string') belongs = q.dispatchId === activity.dispatchId;
    else if (typeof q.runNumber === 'number') {
      const runId = runIdOf(q.runNumber);
      if (runId) belongs = activity.runId === runId;
      else if (d.activities.some((a) => a.dispatchId === activity.dispatchId)) belongs = true;
      else if (activity.runId) unknownRun = true;
    } else if (typeof q.conversationId === 'string') belongs = q.conversationId === activity.conversationId;
    if (!belongs) return d;
    const activities = reduceActivityList(d.activities, activity);
    return activities === d.activities ? d : { ...d, activities };
  });
  if (unknownRun) void qc.invalidateQueries({ queryKey: queryKeys.scope('activity.list') });

  // The Work item of this turn shows its latest important row (WS-18).
  if (!activity.important) return;
  patchEndpoint<WorkOverview>(qc, 'work.overview', (d, key) => {
    if (!sameBurrow(qc, key, activity.burrowId)) return d;
    let changed = false;
    const sections = d.sections.map((s) => {
      const items = mapList(s.items, (item) => {
        if (item.refs.dispatchId !== activity.dispatchId && item.activity?.dispatchId !== activity.dispatchId)
          return item;
        const prev = item.activity;
        if (prev && prev.id === activity.id && !activityIsNewer(prev, activity)) return item;
        if (prev && prev.id !== activity.id && time(prev.startedAt) > time(activity.startedAt)) return item;
        changed = true;
        return { ...item, activity };
      });
      return items === s.items ? s : { ...s, items };
    });
    return changed ? { ...d, sections } : d;
  });
}

/* The work overview ------------------------------------------------------------------------------ */

/**
 * Mark `work.overview` stale; what shows it refetches (WS-19): the Inbox's NEEDS YOU and the agent pane's Stop (the web
 * has no Work view any more, work-removal.md AP-849).
 */
export function invalidateWork(qc: QueryClient): void {
  if (endpointQueries(qc, 'work.overview').length === 0) return;
  void qc.invalidateQueries({ queryKey: queryKeys.scope('work.overview') });
}
