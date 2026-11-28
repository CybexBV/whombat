/**
 * Delayed starts of automations that act without AI (docs/decisions/direct-automations.md): a Home Assistant entity
 * that changed to the state a trigger names, waiting until it has stayed so `forMinutes`. One row per automation and
 * stretch of that state (`key`: `home:<connection>:<entity>:<since>`), kept across restarts and removed when its time
 * comes, whether it starts a run or the entity changed meanwhile. A row of a version since replaced, or of an
 * automation switched off, starts nothing.
 */
import { index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { automations } from './automations';
import { ts } from './common';
import { events } from './events';
import { burrows } from './tenancy';

export const automationWaits = pgTable(
  'automation_waits',
  {
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** The signed change it waits on: the run's trigger once it starts. */
    eventId: text('event_id')
      .notNull()
      .references(() => events.id),
    dueAt: ts('due_at').notNull(),
    /** The time it was first due; a start Whombat can't check yet tries again each minute for an hour after it. */
    firstDueAt: ts('first_due_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.automationId, t.key] }),
    index('automation_waits_due_idx').on(t.burrowId, t.dueAt),
  ],
);
