import type { AheadKind } from '@whombat/core';
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { conversations } from './conversations';
import { principals } from './principals';
import { burrows } from './tenancy';

/**
 * Looks ahead's setting per Whombat (docs/decisions/looks-ahead.md): on unless the person switched it off, and only the
 * changes from the default calendars (the ones they can add to and show, so a Family calendar is in and holidays are
 * out) and the kinds of finding they stopped. No row: on, every default calendar, nothing stopped.
 */
export const looksAheadSettings = pgTable('looks_ahead_settings', {
  burrowId: text('burrow_id')
    .primaryKey()
    .references(() => burrows.id, { onDelete: 'cascade' }),
  on: boolean('on').notNull().default(true),
  /** Calendars (`<connection id>:<calendar id>`) switched off that are on by default. */
  calendarsOff: jsonb('calendars_off').$type<string[]>().notNull().default([]),
  /** Calendars switched on that are off by default (one the person can't add to, or hides). */
  calendarsOn: jsonb('calendars_on').$type<string[]>().notNull().default([]),
  /** Kinds of finding the person said to stop checking for. */
  stopped: jsonb('stopped').$type<AheadKind[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One check of one version of an event (docs/decisions/looks-ahead.md): what the calendar said when it began, the turn
 * that checks it, and how it ended. `quiet`: nothing to tell; `told`: a finding posted in its own thread
 * (`thread_root_id`, a message id the check holds before it exists, so the quiet turn has a place of its own); `failed`:
 * the turn ended without a report. Rows go 30 days after the event.
 */
export const aheadChecks = pgTable(
  'ahead_checks',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** `<connection id>:<calendar id>:<event id>`. */
    eventKey: text('event_key').notNull(),
    version: text('version').notNull(),
    summary: text('summary').notNull(),
    location: text('location').notNull(),
    calendar: text('calendar').notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    /** The event as the turn reads it (`AheadDispatchContext` without `stopped`). */
    event: jsonb('event')
      .$type<{
        start: string;
        end: string;
        description: string;
        timeZone: string;
        /** Where it is read again before a finding is told. */
        connectionId: string;
        calendarId: string;
        eventId: string;
      }>()
      .notNull(),
    state: text('state').$type<'checking' | 'quiet' | 'told' | 'failed'>().notNull(),
    kind: text('kind').$type<AheadKind>(),
    text: text('text'),
    /** The person's word on a finding. */
    feedback: text('feedback').$type<'not_useful' | 'stop_kind'>(),
    dispatchId: text('dispatch_id'),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    threadRootId: text('thread_root_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    index('ahead_checks_event_idx').on(t.burrowId, t.eventKey),
    index('ahead_checks_started_idx').on(t.burrowId, t.startedAt),
    uniqueIndex('ahead_checks_thread_idx').on(t.threadRootId),
    index('ahead_checks_dispatch_idx').on(t.dispatchId),
  ],
);

export type AheadCheckRow = typeof aheadChecks.$inferSelect;
export type LooksAheadSettingsRow = typeof looksAheadSettings.$inferSelect;
