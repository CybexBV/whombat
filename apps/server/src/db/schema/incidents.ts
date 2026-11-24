/**
 * Incidents (docs/decisions/monitoring.md MON-06, MON-09): one row per stretch a server, connection or device was down
 * or had a bad dot, opened after two passes in a row and ended after two passes without, kept 90 days. The push it made
 * (if any) is named so it can be withdrawn when the incident ends.
 */
import type { IncidentNature } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { burrows } from './tenancy';

export const incidents = pgTable(
  'incidents',
  {
    /** `inc_…`. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The thing's id (`server:pve-02`, `connection:con_…`, `device:…`), as its look's key. */
    thingId: text('thing_id').notNull(),
    kind: text('kind').$type<'server' | 'connection' | 'device'>().notNull(),
    /** Its name when the incident opened. */
    name: text('name').notNull(),
    /** `down` or `problem`: the worst it was while it lasted. */
    nature: text('nature').$type<IncidentNature>().notNull(),
    /** What was wrong, in Whombat's words (the worst line's). */
    words: text('words').notNull(),
    /** The check and item of the worst line, when known ('' the thing as a whole). */
    checkId: text('check_id'),
    subject: text('subject').notNull().default(''),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    /** Down because what it runs on was down: that thing's id and name. Such an incident never pushes. */
    causeThing: text('cause_thing'),
    causeName: text('cause_name'),
    /**
     * When it was pushed, and the push's group: shared by the incidents one push named, it is the push's group on the
     * phone and its inbox row's key, by which it is withdrawn once all of them ended.
     */
    pushedAt: ts('pushed_at'),
    pushGroup: text('push_group'),
    withdrawnAt: ts('withdrawn_at'),
  },
  (t) => [
    // One open incident per thing.
    uniqueIndex('incidents_open_idx').on(t.burrowId, t.thingId).where(sql`${t.endedAt} is null`),
    // A thing's history, and the day's pushes.
    index('incidents_thing_idx').on(t.burrowId, t.thingId, t.startedAt),
    index('incidents_burrow_idx').on(t.burrowId, t.startedAt),
  ],
);

export type IncidentRow = typeof incidents.$inferSelect;
