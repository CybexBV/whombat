import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { agentSchedules, approvals, dispatches, messages, runs } from '../db/schema/index';
import { checksToCome } from '../github/checks-wake';

/** Only this run's work can keep it waiting; other Chat threads may run independently. */
export async function runWaitsOn(
  db: Db,
  turn: typeof dispatches.$inferSelect,
  run: typeof runs.$inferSelect,
  pushed = false,
): Promise<{ question: string | null } | null> {
  const [next] = await db
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.burrowId, run.burrowId),
        eq(dispatches.agentId, run.agentId),
        inArray(dispatches.state, ['queued', 'claimed', 'running']),
        or(eq(dispatches.runId, run.id), run.dispatchId ? eq(dispatches.id, run.dispatchId) : undefined),
      ),
    )
    .limit(1);
  if (next) return { question: null };
  const [later] = await db
    .select({ id: agentSchedules.id })
    .from(agentSchedules)
    .innerJoin(dispatches, eq(dispatches.id, agentSchedules.createdByDispatchId))
    .where(
      and(
        eq(agentSchedules.agentId, run.agentId),
        eq(agentSchedules.status, 'active'),
        isNotNull(agentSchedules.nextAt),
        or(eq(dispatches.runId, run.id), run.dispatchId ? eq(dispatches.id, run.dispatchId) : undefined),
      ),
    )
    .limit(1);
  if (later || (await checksToCome(db, run, pushed))) return { question: null };
  const [ask] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.burrowId, run.burrowId),
        eq(approvals.requesterId, run.agentId),
        or(
          eq(approvals.runId, run.id),
          and(
            isNull(approvals.runId),
            run.dispatchId ? eq(approvals.createdByDispatchId, run.dispatchId) : sql`false`,
            sql`(select count(*) from ${runs} started where started.dispatch_id = ${run.dispatchId}) = 1`,
          ),
        ),
        ne(approvals.state, 'declined'),
        isNull(approvals.executedAt),
        // An approved action can still be queued for tonight, waiting for conditions, or executing.
        sql`${approvals.execution}->>'state' not in ('succeeded', 'failed')`,
      ),
    )
    .limit(1);
  if (ask) return { question: null };
  const [question] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.burrowId, run.burrowId),
        eq(messages.authorId, run.agentId),
        eq(messages.asks, true),
        gte(messages.createdAt, turn.claimedAt ?? turn.createdAt),
        or(
          eq(messages.dispatchId, turn.id),
          and(
            isNull(messages.dispatchId),
            eq(messages.conversationId, turn.conversationId),
            turn.threadRootId ? eq(messages.threadRootId, turn.threadRootId) : isNull(messages.threadRootId),
          ),
        ),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return question ? { question: question.id } : null;
}
