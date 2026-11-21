/**
 * Quiet notices (docs/decisions/quiet-notices.md QN-10…QN-17, QN-S01…), migration 0136: the lines of Worth a look a
 * person ignored or snoozed (`notice_quiets`), the checks Whombat stopped watching for a thing or one of its items
 * (`watch_offs`), the checks that start off and someone turned on for a thing (`watch_ons`, migration 0020;
 * docs/decisions/watch-defaults.md), and what the health pass saw of each line from one pass to the next
 * (`notice_states`).
 *
 * `owner_id` is whose the quiet is: the burrow of the thing (a connection, a mail account, a device, a server; one-person.md
 * OP-S52). `thing_id` is the thing's id as
 * `things.page` takes it (`connection:…`, `device:…`, `server:…`), `check_id` the line's check, `subject` its item (`''`:
 * the line about the whole thing; in `watch_offs`, `''` is the whole check). People's rows are written by commands in
 * the commit pipeline; the health pass deletes the ones that end by themselves and writes `notice_states`
 * (operational, like the glance).
 */
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { ts } from './common';

/** An Ignore or a Remind me tomorrow of one line (QN-11, QN-12, QN-14). */
export const noticeQuiets = pgTable(
  'notice_quiets',
  {
    ownerId: text('owner_id').notNull(),
    thingId: text('thing_id').notNull(),
    checkId: text('check_id').notNull(),
    subject: text('subject').notNull().default(''),
    state: text('state').$type<'ignored' | 'snoozed'>().notNull(),
    /** How an Ignore ends by itself (`fixed`, `newer`, `period`); null for a snooze. */
    lifts: text('lifts').$type<'fixed' | 'newer' | 'period'>(),
    /** The line's episode then: a different one ends it. */
    episode: text('episode'),
    /** The line's tone and band then: a worse one ends it. */
    tone: text('tone').$type<'bad' | 'warn' | 'info'>().notNull(),
    band: integer('band'),
    /** A snooze's end (09:00 tomorrow), a `period` Ignore's (when the week resets); null otherwise. */
    until: ts('until'),
    /** Health passes in a row that saw the line gone (`fixed` ends at two). */
    clearPasses: integer('clear_passes').notNull().default(0),
    /** The line's title and item name then, for Activity and What Whombat watches. */
    title: text('title').notNull(),
    subjectName: text('subject_name'),
    /** When you'll hear again, as the line said it (“Until it’s back online.”). */
    words: text('words'),
    byId: text('by_id'),
    at: ts('at').notNull(),
  },
  (t) => [primaryKey({ name: 'notice_quiets_pk', columns: [t.ownerId, t.thingId, t.checkId, t.subject] })],
);

/** A check Whombat stopped watching for a thing, or for one of its items (QN-13, QN-15). */
export const watchOffs = pgTable(
  'watch_offs',
  {
    ownerId: text('owner_id').notNull(),
    thingId: text('thing_id').notNull(),
    checkId: text('check_id').notNull(),
    /** The item; `''`: the whole check. */
    subject: text('subject').notNull().default(''),
    subjectName: text('subject_name'),
    byId: text('by_id'),
    at: ts('at').notNull(),
  },
  (t) => [primaryKey({ name: 'watch_offs_pk', columns: [t.ownerId, t.thingId, t.checkId, t.subject] })],
);

/** A check that starts off and that someone turned on for a thing (watch-defaults.md): always the whole check. */
export const watchOns = pgTable(
  'watch_ons',
  {
    ownerId: text('owner_id').notNull(),
    thingId: text('thing_id').notNull(),
    checkId: text('check_id').notNull(),
    byId: text('by_id'),
    at: ts('at').notNull(),
  },
  (t) => [primaryKey({ name: 'watch_ons_pk', columns: [t.ownerId, t.thingId, t.checkId] })],
);

/** What the health pass saw of a line: since when, and how many passes in a row (QN-04 `confirm`). Operational. */
export const noticeStates = pgTable(
  'notice_states',
  {
    thingId: text('thing_id').notNull(),
    checkId: text('check_id').notNull(),
    subject: text('subject').notNull().default(''),
    firstSeen: ts('first_seen').notNull(),
    lastSeen: ts('last_seen').notNull(),
    seenPasses: integer('seen_passes').notNull(),
    tone: text('tone').$type<'bad' | 'warn' | 'info'>().notNull(),
  },
  (t) => [primaryKey({ name: 'notice_states_pk', columns: [t.thingId, t.checkId, t.subject] })],
);

export type NoticeQuietRow = typeof noticeQuiets.$inferSelect;
export type WatchOffRow = typeof watchOffs.$inferSelect;
export type WatchOnRow = typeof watchOns.$inferSelect;
export type NoticeStateRow = typeof noticeStates.$inferSelect;
