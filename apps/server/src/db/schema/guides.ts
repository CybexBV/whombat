/**
 * Guided setup in the personal assistant's DM (docs/decisions/assistant-guides.md AG-04, AG-07, AG-10, AG-11):
 * what the assistant already did for the person in a burrow (the welcome, the last suggestion). Written by the guide
 * engine (`guides/`) through the commit pipeline's transactions.
 */
import type { KnownGuideTopic } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { accounts, burrows } from './tenancy';

/** The person in a burrow: the welcome (once) and the last suggestion. */
export const assistantStates = pgTable(
  'assistant_states',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The welcome was posted (or skipped because the DM already had messages) at this time: never again (AG-04). */
    welcomedAt: ts('welcomed_at'),
    /** The last occasional suggestion (AG-11) and its topic. */
    suggestedAt: ts('suggested_at'),
    suggestedTopic: text('suggested_topic').$type<KnownGuideTopic>(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.burrowId, t.personId] }),
    index('assistant_states_account_idx').on(t.accountId),
  ],
);

/**
 * The person's morning and evening brief times. Nothing reads or writes them: the brief is gone, and the table stays
 * until a later release drops it, because dropping a table needs a checkpoint on every box (managed-db.md MD-03).
 */
export const personalSchedules = pgTable(
  'personal_schedules',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    cron: text('cron').notNull(),
    timeZone: text('time_zone').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** The next time it is due (null while off). */
    nextRunAt: ts('next_run_at'),
    lastRunAt: ts('last_run_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('personal_schedules_person_kind_idx').on(t.burrowId, t.personId, t.kind),
    index('personal_schedules_due_idx').on(t.nextRunAt).where(sql`${t.enabled}`),
  ],
);

/** The briefs Whombat made. Unused and kept until a later release drops it, like `personal_schedules`. */
export const briefs = pgTable(
  'briefs',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    day: text('day').notNull(),
    windowFrom: ts('window_from').notNull(),
    windowTo: ts('window_to').notNull(),
    timeZone: text('time_zone').notNull(),
    content: jsonb('content').notNull(),
    facts: jsonb('facts').notNull(),
    lead: text('lead'),
    state: text('state').notNull(),
    dispatchId: text('dispatch_id'),
    conversationId: text('conversation_id'),
    messageId: text('message_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    postedAt: ts('posted_at'),
  },
  (t) => [
    uniqueIndex('briefs_person_day_idx').on(t.burrowId, t.personId, t.kind, t.day),
    index('briefs_writing_idx').on(t.createdAt).where(sql`${t.state} = 'writing'`),
  ],
);
