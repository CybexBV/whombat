/**
 * Turns agents schedule for themselves (docs/decisions/resourceful-agents.md RA-30, migration 0067): made with the MCP
 * `schedule` tool in a turn, they run in that turn's conversation and thread, for the person, as
 * dispatches with trigger `schedule` (`dispatches.schedule_id`, `DispatchContext.schedule`). The schedules service
 * (`schedules/`) is the only writer, through the commit pipeline: the tool, the person's Pause / Resume / Remove, its
 * ticker and offboarding.
 */
import type { ScheduleEndReason, ScheduleStatus, ScheduleWhen } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { burrows } from './tenancy';

export const agentSchedules = pgTable(
  'agent_schedules',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id),
    /** Where its turns run and post: the conversation and thread of the turn that made it. */
    conversationId: text('conversation_id').notNull(),
    threadRootId: text('thread_root_id'),
    /** The person its turns are for (an account): the one the creating turn was for. */
    forAccountId: text('for_account_id').notNull(),
    /** What the agent told itself to do then (never in a signed event, RA-DC12). */
    prompt: text('prompt').notNull(),
    when: jsonb('when').$type<ScheduleWhen>().notNull(),
    status: text('status').$type<ScheduleStatus>().notNull(),
    endedReason: text('ended_reason').$type<ScheduleEndReason>(),
    /** The next run (the ticker's timer); null while paused or ended. */
    nextAt: ts('next_at'),
    /** A repeating schedule's end (made or renewed + 90 days); null for a one-off. */
    endsAt: ts('ends_at'),
    /** When it was made or last resumed: an `every` schedule counts its interval from here. */
    anchorAt: ts('anchor_at').notNull(),
    runs: integer('runs').notNull().default(0),
    lastRunAt: ts('last_run_at'),
    /** The turn that made it. */
    createdByDispatchId: text('created_by_dispatch_id'),
    /** The `schedule` card posted when it was made (republished when it changes). */
    messageId: text('message_id'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    // The ticker: active schedules by their next run.
    index('agent_schedules_due_idx').on(t.nextAt).where(sql`${t.status} = 'active'`),
    // An agent's list and its count of active ones (at most 20).
    index('agent_schedules_agent_idx').on(t.agentId, t.status),
    // A person who leaves the burrow ends theirs.
    index('agent_schedules_for_idx').on(t.burrowId, t.forAccountId).where(sql`${t.status} <> 'ended'`),
  ],
);
