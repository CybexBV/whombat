/**
 * `activity.list` (docs/decisions/work-supervision.md WS-16): the observed activity of a run (all its turns), a turn,
 * or a conversation's recent turns, of the viewer's burrow (every conversation is the person's).
 * Oldest change first after the cursor (the rows' `rev`), so a client catches up on new rows and updated ones alike.
 */
import type { Activity } from '@whombat/core';
import { and, asc, eq, gt, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { activities, dispatches } from '../db/schema/index';
import { ApiError, notFound } from '../lib/errors';
import { toActivities } from '../runtime/activity';
import { inBurrow } from './conversations';
import type { PrincipalRow } from './principals';
import { runByNumber } from './work';
import { readableRun } from './work-views';

/** A conversation's “recent turns”: the turns with the newest activity. */
const RECENT_TURNS = 20;

export interface ActivityQuery {
  runNumber?: number | undefined;
  dispatchId?: string | undefined;
  conversationId?: string | undefined;
  after?: string | undefined;
  limit: number;
}

export interface ActivityPage {
  activities: Activity[];
  cursor: string | null;
  hasMore: boolean;
  reported: boolean;
}

export async function activityList(
  db: Db,
  viewer: PrincipalRow,
  burrowId: string,
  query: ActivityQuery,
): Promise<ActivityPage> {
  let scope: SQL | undefined;
  if (query.runNumber !== undefined) {
    const run = readableRun(viewer, await runByNumber(db, burrowId, query.runNumber));
    // Every turn that worked on it: rows carry the run once it exists, and the turns that started or resumed it.
    const turns = db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(
        or(eq(dispatches.runId, run.id), run.dispatchId ? eq(dispatches.id, run.dispatchId) : undefined),
      );
    scope = or(eq(activities.runId, run.id), inArray(activities.dispatchId, turns));
  } else if (query.dispatchId) {
    const [d] = await db
      .select({ conversationId: dispatches.conversationId, burrowId: dispatches.burrowId })
      .from(dispatches)
      .where(eq(dispatches.id, query.dispatchId));
    if (!d || d.burrowId !== burrowId) throw notFound('Turn');
    scope = eq(activities.dispatchId, query.dispatchId);
  } else if (query.conversationId) {
    if (!(await inBurrow(db, burrowId, query.conversationId))) throw notFound('Conversation');
    const recent = sql`(select a.dispatch_id from ${activities} a where a.conversation_id = ${query.conversationId}
      group by a.dispatch_id order by max(a.rev) desc limit ${RECENT_TURNS})`;
    scope = and(
      eq(activities.conversationId, query.conversationId),
      sql`${activities.dispatchId} in ${recent}`,
    );
  } else {
    throw new ApiError('validation_failed', 'Say which run, turn or conversation.', {
      fields: { runNumber: ['Give runNumber, dispatchId or conversationId.'] },
    });
  }
  // Only rows of the burrow's turns (a run's turns may span rooms, all of them the person's).
  const visible = and(eq(activities.burrowId, burrowId), scope);
  const after = query.after && /^\d{1,18}$/.test(query.after) ? Number(query.after) : null;
  const rows = await db
    .select()
    .from(activities)
    .where(after !== null ? and(visible, gt(activities.rev, after)) : visible)
    .orderBy(asc(activities.rev))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const reported =
    rows.length > 0 || (await db.select({ one: sql`1` }).from(activities).where(visible).limit(1)).length > 0;
  return {
    activities: await toActivities(db, page),
    cursor: last ? String(last.rev) : (query.after ?? null),
    hasMore: rows.length > query.limit,
    reported,
  };
}
