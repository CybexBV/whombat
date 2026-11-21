/**
 * Agents' own schedules, read side (docs/decisions/resourceful-agents.md RA-30, RA-DC14, RA-DC15): the stored row as
 * the contract's `AgentSchedule`, which is also what the person sees (every schedule is theirs, one-person.md OP-S79),
 * the agent's view in the `schedule` tool's answers, and the room card.
 */
import {
  type AgentSchedule,
  type AgentScheduleView,
  describeScheduleWhen,
  type ScheduleToolItem,
} from '@whombat/core';
import { and, desc, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db, Tx } from '../db/client';
import { agentSchedules, dispatches, runs } from '../db/schema/index';
import { iso, isoOrNull } from '../lib/time';
import type { PrincipalRow } from '../read/principals';
import { dispatchRun } from '../runtime/dispatch-scope';

export type ScheduleRow = typeof agentSchedules.$inferSelect;

/**
 * The run a schedule's turn continues (run-checkout.md RC-15): the run of the turn that made it (`dispatchRun`), while
 * that run is still live and its agent's. Null: an ordinary scheduled turn.
 */
export async function liveRunOfSchedule(
  tx: Pick<Db, 'select'>,
  row: Pick<ScheduleRow, 'agentId' | 'createdByDispatchId'>,
): Promise<string | null> {
  if (!row.createdByDispatchId) return null;
  const [made] = await tx
    .select({ id: dispatches.id, runId: dispatches.runId })
    .from(dispatches)
    .where(eq(dispatches.id, row.createdByDispatchId));
  const runId = made ? await dispatchRun(tx, made) : null;
  if (!runId) return null;
  const [run] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.status, 'live'), eq(runs.agentId, row.agentId)));
  return run?.id ?? null;
}

/** Ended schedules stay on the agent's page this long (`schedules.list`). */
export const ENDED_LISTED_DAYS = 7;

export function toAgentSchedule(row: ScheduleRow): AgentSchedule {
  return {
    id: row.id,
    agentId: row.agentId,
    conversationId: row.conversationId,
    threadRootId: row.threadRootId,
    prompt: row.prompt,
    when: row.when,
    status: row.status,
    endedReason: row.endedReason ?? null,
    nextAt: isoOrNull(row.nextAt),
    endsAt: isoOrNull(row.endsAt),
    runs: row.runs,
    lastRunAt: isoOrNull(row.lastRunAt),
    createdAt: iso(row.createdAt),
  };
}

export async function loadSchedule(db: Db | Tx, id: string): Promise<ScheduleRow | undefined> {
  const [row] = await db.select().from(agentSchedules).where(eq(agentSchedules.id, id));
  return row;
}

/** Locks a schedule's row for a change (inside the burrow's transaction). */
export async function lockSchedule(tx: Tx, id: string): Promise<ScheduleRow | undefined> {
  const [row] = await tx.select().from(agentSchedules).where(eq(agentSchedules.id, id)).for('update');
  return row;
}

/** An agent's active schedules (at most `SCHEDULES_ACTIVE_MAX`). */
export async function activeScheduleCount(db: Db | Tx, agentId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentSchedules)
    .where(and(eq(agentSchedules.agentId, agentId), eq(agentSchedules.status, 'active')));
  return row?.n ?? 0;
}

/**
 * Whether `viewer` may pause, resume and remove the agent's schedule (RA-30): the person, whose every schedule is
 * (one-person.md OP-S79).
 */
export function mayChangeSchedule(viewer: Pick<PrincipalRow, 'kind'>): boolean {
  return viewer.kind === 'person';
}

/** The room cards of these schedules (`read/messages.ts`, `realtime/fill.ts`); missing ones resolve to null. */
export async function scheduleCardsFor(
  db: Db | Tx,
  scheduleIds: readonly string[],
): Promise<Map<string, AgentScheduleView>> {
  if (scheduleIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(agentSchedules)
    .where(inArray(agentSchedules.id, [...new Set(scheduleIds)]));
  return new Map(rows.map((r) => [r.id, toAgentSchedule(r)]));
}

/**
 * The agent's page (`schedules.list`): active and paused schedules, and those that ended in the last week, newest
 * first.
 */
export async function schedulesOfAgent(db: Db, agent: PrincipalRow, now: Date): Promise<AgentScheduleView[]> {
  const since = new Date(now.getTime() - ENDED_LISTED_DAYS * 86_400_000);
  const rows = await db
    .select()
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.agentId, agent.id),
        or(ne(agentSchedules.status, 'ended'), gt(agentSchedules.updatedAt, since)),
      ),
    )
    .orderBy(desc(agentSchedules.createdAt), desc(agentSchedules.id));
  return rows.map(toAgentSchedule);
}

/** A schedule as the agent reads it in the `schedule` tool's answers. */
export function toolItem(row: ScheduleRow, timeZone: string, now: Date): z.input<typeof ScheduleToolItem> {
  return {
    id: row.id,
    when: row.when,
    description: describeScheduleWhen(row.when, timeZone, now),
    prompt: row.prompt,
    status: row.status,
    nextAt: isoOrNull(row.nextAt),
    endsAt: isoOrNull(row.endsAt),
    runs: row.runs,
    conversationId: row.conversationId,
    threadRootId: row.threadRootId,
  };
}

/**
 * What a turn may see of its agent's schedules (RA-DC15): active and paused ones in this conversation or for the
 * person this turn is for; the rest only counted.
 */
export async function schedulesForTurn(
  db: Db | Tx,
  turn: { agentId: string; conversationId: string; forAccountId: string | null },
): Promise<{ seen: ScheduleRow[]; others: number }> {
  const rows = await db
    .select()
    .from(agentSchedules)
    .where(and(eq(agentSchedules.agentId, turn.agentId), ne(agentSchedules.status, 'ended')))
    .orderBy(agentSchedules.createdAt, agentSchedules.id);
  const seen = rows.filter(
    (r) =>
      r.conversationId === turn.conversationId ||
      (turn.forAccountId !== null && r.forAccountId === turn.forAccountId),
  );
  return { seen, others: rows.length - seen.length };
}
