/**
 * Reports to the Whombat Team on the box (docs/decisions/team-reports.md). Control keeps the reports; the box keeps a
 * copy of each of its own as the person last read it, so the list still shows while control can't be reached and the
 * box knows what is new (`revision` past `read_revision`). And the reports the assistant drafted, which only the
 * person's press sends. Changed only through the commit pipeline.
 */
import type { TeamReport } from '@whombat/core/domain';
import { bigint, index, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { burrows } from './tenancy';

export const teamReportCopies = pgTable(
  'team_report_copies',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** Control's id (`tr_…`). */
    reportId: text('report_id').notNull(),
    number: bigint('number', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    /** Control's times. */
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    /** The latest revision of the team's changes the box has seen. */
    revision: bigint('revision', { mode: 'number' }).notNull(),
    /** The revision the person last read: the report is unread while `revision` is past it. */
    readRevision: bigint('read_revision', { mode: 'number' }).notNull().default(0),
    /** The whole report as last read (`TeamReport`); null for one the box knows only from control's list. */
    report: jsonb('report').$type<TeamReport>(),
    /** Who sent it from this box; null once they are gone. */
    createdById: text('created_by_id').references(() => principals.id, { onDelete: 'set null' }),
    copiedAt: ts('copied_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'team_report_copies_pk', columns: [t.burrowId, t.reportId] }),
    index('team_report_copies_burrow_idx').on(t.burrowId, t.createdAt),
  ],
);

export const teamReportDrafts = pgTable(
  'team_report_drafts',
  {
    /** The box's own id; the card's Edit opens the form with it. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The person it is for: only their press sends it. */
    personId: text('person_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => principals.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id'),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    expected: text('expected').notNull(),
    /** The card that asks the person. */
    approvalId: text('approval_id'),
    /** `waiting` for the person, `sent`, or `declined`. */
    state: text('state').notNull().default('waiting'),
    /** The report it became, once sent. */
    reportId: text('report_id'),
    createdAt: ts('created_at').notNull(),
    doneAt: ts('done_at'),
  },
  (t) => [index('team_report_drafts_burrow_idx').on(t.burrowId, t.createdAt)],
);
