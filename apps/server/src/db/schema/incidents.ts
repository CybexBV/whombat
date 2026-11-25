/**
 * Incidents: one row per stretch a server, connection or device was down
 * or had a bad dot, opened after two passes in a row and ended after two passes without, kept 90 days. The push it made
 * (if any) is named so it can be withdrawn when the incident ends.
 */
import type { IncidentNature, ThingWatchEvent, ThingWatchStatus } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { automations } from './automations';
import { ts } from './common';
import { conversations, messages } from './conversations';
import { events } from './events';
import { principals } from './principals';
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
    /**
     * Every check it signed an event for while it lasted: the one that opened or worsened it, and each bad check that
     * began counting on it later (`thing.problem` once each), so an automation naming a check starts on it.
     */
    checks: jsonb('checks').$type<string[]>().notNull().default([]),
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

/** One claim per automation and incident. A due time keeps a delayed start across restarts. */
export const incidentTriggers = pgTable(
  'incident_triggers',
  {
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    incidentId: text('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id),
    dueAt: ts('due_at'),
  },
  (t) => [
    primaryKey({ columns: [t.automationId, t.incidentId] }),
    index('incident_triggers_due_idx').on(t.burrowId, t.dueAt).where(sql`${t.dueAt} is not null`),
  ],
);

/** One-time requests from Chat. A signed incident can claim a watch before its reply is posted. */
export const thingWatches = pgTable(
  'thing_watches',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    thing: text('thing_id').notNull(),
    name: text('name').notNull(),
    event: text('event').$type<ThingWatchEvent>().notNull(),
    status: text('status').$type<ThingWatchStatus>().notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    threadRootId: text('thread_root_id'),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
    eventId: text('event_id').references(() => events.id),
    startedAt: ts('started_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    endedAt: ts('ended_at'),
  },
  (t) => [
    index('thing_watches_running_idx').on(t.burrowId, t.thing, t.event).where(sql`${t.status} = 'watching'`),
  ],
);
