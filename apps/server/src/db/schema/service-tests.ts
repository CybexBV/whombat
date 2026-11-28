/**
 * “Does it really work?” (docs/decisions/service-works.md): one row per run of a service's read-only test, kept 30 days,
 * the newest first by connection. Only the result is kept — how it ended, the step it stopped at, the service's answer
 * code and how long it took — and a few facts its words need (the library's name, how old the newest sensor reading
 * was); never what the test opened. Written by the server's pipeline (`works/store.ts`), like the health pass's glance.
 */
import type { ServiceTestBy, ServiceTestOutcome } from '@whombat/core';
import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { catalogConnections } from './connections-catalog';
import { burrows } from './tenancy';

/**
 * Why a step failed, beside its answer code: no answer in time, an answer Whombat couldn't read, nothing there, or a
 * web page where the service's data should be (`page`: a sign-in page in front of it, or a wrong address).
 */
export type ServiceTestReason = 'status' | 'timeout' | 'unreadable' | 'missing' | 'stale' | 'page';

/** What a run's words say besides its outcome. */
export interface ServiceTestFacts {
  /** The library it opened an item of (Jellyfin, Plex): a library's name, never the item's. */
  library?: string;
  /** How long ago the newest sensor reading was, in seconds (Home Assistant). */
  ageS?: number;
}

export const serviceTestRuns = pgTable(
  'service_test_runs',
  {
    /** `wtr_…`. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    at: ts('at').notNull(),
    outcome: text('outcome').$type<ServiceTestOutcome>().notNull(),
    /** The step it stopped at (`list`, `open`, `find`), absent when it passed. */
    step: text('step'),
    reason: text('reason').$type<ServiceTestReason>(),
    /** The service's answer code at that step, when it answered. */
    status: integer('status'),
    ms: integer('ms').notNull(),
    by: text('by').$type<ServiceTestBy>().notNull(),
    facts: jsonb('facts').$type<ServiceTestFacts>().notNull().default({}),
  },
  (t) => [index('service_test_runs_connection_idx').on(t.connectionId, t.at)],
);

export type ServiceTestRunRow = typeof serviceTestRuns.$inferSelect;
