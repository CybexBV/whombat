/**
 * The tables of the removed repository setup and night runs (docs/decisions/fast-testing.md). Nothing reads or writes
 * them; they stay until a later migration drops them.
 */
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { repoPlaces } from './repo-manager';
import { burrows } from './tenancy';

/** A repository's setup with the assistant; a new start stops the one before it, so one is going at a time. */
export const repoSetups = pgTable(
  'repo_setups',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    placeId: text('place_id')
      .notNull()
      .references(() => repoPlaces.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    state: text('state').notNull(),
    /** What the person asked the assistant to aim for. */
    goal: text('goal').notNull().default('recommended'),
    /** What the look showed as it went. */
    lines: jsonb('lines').notNull(),
    facts: jsonb('facts'),
    answers: jsonb('answers').notNull(),
    plan: jsonb('plan'),
    planHash: text('plan_hash'),
    practice: jsonb('practice'),
    /** The plan hash the last practice passed for: Use is offered while it equals `plan_hash`. */
    practicedHash: text('practiced_hash'),
    filesThread: jsonb('files_thread').$type<{ id: string; title: string }>(),
    problem: text('problem'),
    startedById: text('started_by').references(() => principals.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('repo_setups_burrow_idx').on(t.burrowId),
    uniqueIndex('repo_setups_one_going').on(t.placeId, t.repo).where(sql`${t.state} <> 'stopped'`),
  ],
);
export type RepoSetupRow = typeof repoSetups.$inferSelect;

/** One night run of a repository: the default branch's commit through the build server, by the clock or the person. */
export const repoNightRuns = pgTable(
  'repo_night_runs',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    placeId: text('place_id')
      .notNull()
      .references(() => repoPlaces.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    revision: text('revision'),
    state: text('state').$type<'running' | 'passed' | 'failed' | 'couldnt_run'>().notNull(),
    jobs: jsonb('jobs').notNull(),
    words: text('words'),
    by: text('by').$type<'schedule' | 'person'>().notNull(),
  },
  (t) => [
    index('repo_night_runs_repo_idx').on(t.placeId, t.repo, t.startedAt),
    uniqueIndex('repo_night_runs_one_running').on(t.placeId, t.repo).where(sql`${t.state} = 'running'`),
  ],
);
export type RepoNightRunRow = typeof repoNightRuns.$inferSelect;
