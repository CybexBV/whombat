import type {
  AheadKind,
  AheadMatterMatch,
  AheadMatterReason,
  AheadStage,
  AheadTriggerSource,
  AheadWaitingOn,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { conversations } from './conversations';
import { principals } from './principals';
import { burrows } from './tenancy';

/**
 * Looks ahead's setting per Whombat (docs/decisions/looks-ahead.md): on unless the person switched it off, only the
 * changes from the default calendars (the ones they can add to and show, so a Family calendar is in and holidays are
 * out), whether incoming mail is watched too, user-owned standing rules (“What to watch for”), and the kinds of
 * finding they stopped. No row: on, incoming mail on, every default calendar, no rules, nothing stopped.
 */
export const looksAheadSettings = pgTable('looks_ahead_settings', {
  burrowId: text('burrow_id')
    .primaryKey()
    .references(() => burrows.id, { onDelete: 'cascade' }),
  on: boolean('on').notNull().default(true),
  /** Watch incoming mail on its own for missing bookings, mismatches and deadlines. */
  mailOn: boolean('mail_on').notNull().default(true),
  /** Calendars (`<connection id>:<calendar id>`) switched off that are on by default. */
  calendarsOff: jsonb('calendars_off').$type<string[]>().notNull().default([]),
  /** Calendars switched on that are off by default (one the person can't add to, or hides). */
  calendarsOn: jsonb('calendars_on').$type<string[]>().notNull().default([]),
  /** User-owned standing rules (“What to watch for”) passed into every check. */
  rules: jsonb('rules').$type<string[]>().notNull().default([]),
  /** Kinds of finding the person said to stop checking for. */
  stopped: jsonb('stopped').$type<AheadKind[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One thing Looks ahead keeps an eye on (“Keeping an eye on”, docs/decisions/looks-ahead.md): what it is, who it is with,
 * whom it waits on, an optional date and a short note, and how mail is matched to it. Fixed short fields Whombat scrubs,
 * shown and removable in Settings, so nothing a stranger wrote settles here unseen. The person opens one in Chat
 * (`origin` `person`, matched by their own words) or a mail check does (`check`, matched only by that mail's thread and
 * sender). `closed`: done, removed by the person, or expired after 30 days without news.
 */
export const aheadMatters = pgTable(
  'ahead_matters',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** Who opened it: the person in their own words, or a mail check. */
    origin: text('origin').$type<'person' | 'check'>().notNull(),
    title: text('title').notNull(),
    who: text('who').notNull().default(''),
    waitingOn: text('waiting_on').$type<AheadWaitingOn>().notNull(),
    /** Its date, when it has one: what a follow-up is timed by. */
    dueAt: timestamp('due_at', { withTimezone: true }),
    /** A short factual note on where it stands, for the next check about it. */
    note: text('note'),
    /** How new mail is matched to it: its threads, sender words and (only the person's own) subject words. */
    match: jsonb('match').$type<AheadMatterMatch>().notNull(),
    state: text('state').$type<'open' | 'closed'>().notNull(),
    closedReason: text('closed_reason').$type<'done' | 'removed' | 'expired'>(),
    /** The Chat its findings go in. */
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    /** The Chat thread its findings go in: for one the person asked for, the thread they asked in. */
    threadRootId: text('thread_root_id'),
    /** The reasons it was followed up for already, each once. */
    followedUp: jsonb('followed_up').$type<AheadMatterReason[]>().notNull().default([]),
    /** The last mail about it, or when it began: a follow-up for no answer and the expiry count from here. */
    lastNewsAt: timestamp('last_news_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('ahead_matters_state_idx').on(t.burrowId, t.state)],
);

/**
 * One check of one stage/version of an event, one incoming email, one follow-up of a thing kept an eye on
 * (`matter_id`), or one look through new mail (`triage`) (docs/decisions/looks-ahead.md): what the calendar or mailbox
 * said when it began, the turn that checks it, and how it ended. `quiet`: nothing to tell (for a look: it picked, and
 * its picks wait in `event.triage.picks`); `told`: a finding posted in its thread (`thread_root_id`, a unique message id
 * the check holds before it exists, so the quiet turn has a place of its own); `failed`: the turn ended without a
 * report. Rows go 30 days after `end_at`.
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
    /** What started this check: a calendar event, an incoming email, a look through new mail, or a thing kept an eye on. */
    source: text('source').$type<AheadTriggerSource>().notNull().default('calendar'),
    /** Check stage: early (2–7d), eve (afternoon before), morning (2–4h), mail, triage or matter. */
    stage: text('stage').$type<AheadStage>().notNull().default('eve'),
    /**
     * `uid:...` / `<connection id>:<calendar id>:<event id>`, `mail:<connection id>:<message id>`, `matter:<id>` or
     * `triage:<start>`.
     */
    eventKey: text('event_key').notNull(),
    /** Event version hash (`eve` keeps bare hash; other stages suffix `:stage` for unique indexing). */
    version: text('version').notNull(),
    summary: text('summary').notNull(),
    location: text('location').notNull(),
    calendar: text('calendar').notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    /** The event or email payload as the turn reads it (`AheadDispatchContext` fields). */
    event: jsonb('event')
      .$type<{
        start: string;
        end: string;
        description: string;
        timeZone: string;
        allDay?: boolean;
        /** Where a calendar event is read again before a finding is told. */
        connectionId: string;
        calendarId: string;
        eventId: string;
        /** Its guests' names and addresses: never search words. */
        guests?: string[];
        /** Other accepted events on the same day (or next 14 days for mail checks). */
        daySchedule?: {
          summary: string;
          start: string;
          end: string;
          location: string;
          calendar: string;
          allDay?: boolean;
        }[];
        /** Incoming email metadata when `source === 'mail'`. */
        mail?: {
          provider: 'google' | 'microsoft' | 'imap';
          messageId: string;
          from: string;
          subject: string;
          date: string;
          snippet: string;
          /** The thread it is in: what a thing kept an eye on is matched by. */
          threadId?: string;
        };
        /** A look through new mail: what it covered, the mails it listed (by number) and what it picked. */
        triage?: {
          /** The mail it covers came after this (ISO). */
          since: string;
          /** How many mails it looked through. */
          count: number;
          mails: {
            ref: string;
            connectionId: string;
            provider: 'google' | 'microsoft' | 'imap';
            account: string;
            messageId: string;
            threadId: string;
            from: string;
            subject: string;
            date: string;
            snippet: string;
          }[];
          /** Its picks, which wait here as mail checks for 48 hours. */
          picks?: { ref: string; matterId?: string }[];
        };
        /** The thing kept an eye on a mail check or a follow-up is about, and why a follow-up runs. */
        matter?: { id: string; reason?: AheadMatterReason };
      }>()
      .notNull(),
    state: text('state').$type<'checking' | 'quiet' | 'told' | 'failed'>().notNull(),
    kind: text('kind').$type<AheadKind>(),
    /** Additional finding kinds when a single message reports more than one issue. */
    extraKinds: jsonb('extra_kinds').$type<AheadKind[]>().notNull().default([]),
    text: text('text'),
    /** Optional one-tap action chip label proposed with the finding. */
    actionLabel: text('action_label'),
    /** Brief factual note kept only for later stages of the same event (never in Hermes memory). */
    note: text('note'),
    /** The person's word on a finding. */
    feedback: text('feedback').$type<'not_useful' | 'stop_kind'>(),
    /** Optional plain reason the person gave for a `not_useful` verdict. */
    feedbackNote: text('feedback_note'),
    dispatchId: text('dispatch_id'),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    threadRootId: text('thread_root_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    /** The check read private data (mail, files or docs): nothing more of it goes to the web. */
    mailReadAt: timestamp('mail_read_at', { withTimezone: true }),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** The thing kept an eye on this check is about; its checks stay when it goes. */
    matterId: text('matter_id').references(() => aheadMatters.id, { onDelete: 'set null' }),
  },
  (t) => [
    // One check of a version+stage, and one going on at a time per Whombat, whatever starts them.
    uniqueIndex('ahead_checks_version_idx').on(t.burrowId, t.eventKey, t.version),
    uniqueIndex('ahead_checks_one_checking_idx').on(t.burrowId).where(sql`${t.state} = 'checking'`),
    index('ahead_checks_event_idx').on(t.burrowId, t.eventKey),
    index('ahead_checks_started_idx').on(t.burrowId, t.startedAt),
    uniqueIndex('ahead_checks_thread_idx').on(t.threadRootId),
    index('ahead_checks_dispatch_idx').on(t.dispatchId),
    index('ahead_checks_matter_idx').on(t.burrowId, t.matterId),
  ],
);

export type AheadCheckRow = typeof aheadChecks.$inferSelect;
export type LooksAheadSettingsRow = typeof looksAheadSettings.$inferSelect;
export type AheadMatterRow = typeof aheadMatters.$inferSelect;
