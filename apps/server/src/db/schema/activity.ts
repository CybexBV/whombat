/**
 * Observed agent activity (docs/decisions/work-supervision.md WS-11…WS-17): one row per action of a turn, upserted by
 * `(dispatch, key)` from the runner's reports and updated through its lifecycle. Runtime telemetry, not signed into
 * the audit log (WS-14); written by the runtime service with its outbox frame.
 */
import type { ActivityEvidence, ActivityFailure, ActivityKind, ActivityStatus } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { bigserial, boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { burrows } from './tenancy';

export const activities = pgTable(
  'activities',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    dispatchId: text('dispatch_id').notNull(),
    /** The run the turn works on, once there is one (backfilled when the turn starts a run later). */
    runId: text('run_id'),
    agentId: text('agent_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    threadRootId: text('thread_root_id'),
    /** `<attempt>:<provider tool id>` (or the runner's sequence number). */
    key: text('key').notNull(),
    attempt: integer('attempt').notNull(),
    /** The runner's per-dispatch sequence of the report the row shows; older reports are ignored. */
    seq: integer('seq').notNull(),
    kind: text('kind').$type<ActivityKind>().notNull(),
    tool: text('tool').notNull(),
    status: text('status').$type<ActivityStatus>().notNull(),
    title: text('title').notNull(),
    object: text('object'),
    detail: text('detail'),
    important: boolean('important').notNull(),
    exitCode: integer('exit_code'),
    failure: text('failure').$type<ActivityFailure>(),
    keyNeeded: text('key_needed'),
    approvalId: text('approval_id'),
    evidence: jsonb('evidence').$type<ActivityEvidence>(),
    /** Change counter (a sequence, renewed on every write): the `activity.list` cursor. */
    rev: bigserial('rev', { mode: 'number' }).notNull(),
    startedAt: ts('started_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    uniqueIndex('activities_dispatch_key_idx').on(t.dispatchId, t.key),
    index('activities_dispatch_rev_idx').on(t.dispatchId, t.rev),
    index('activities_run_rev_idx').on(t.runId, t.rev),
    index('activities_conversation_idx').on(t.conversationId, t.updatedAt),
    index('activities_open_idx').on(t.status).where(sql`${t.status} in ('running', 'waiting')`),
  ],
);
