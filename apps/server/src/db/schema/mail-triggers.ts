import type { MailAttachment } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { MailProviderCursor } from '../../connectors/types';
import { connections } from './connectors';
import { burrows } from './tenancy';

/**
 * Per-mailbox high-water mark for mail-triggered automations. Updated only through the commit pipeline so a mailbox
 * never fires twice for the same message and never replays mail that was already present when watching began.
 */
export const mailCursors = pgTable('mail_cursors', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => connections.id, { onDelete: 'cascade' }),
  burrowId: text('burrow_id')
    .notNull()
    .references(() => burrows.id, { onDelete: 'cascade' }),
  /** Provider-specific high-water mark (Gmail historyId, Graph deltaLink, IMAP uidValidity+lastUid, or fake seq). */
  cursor: jsonb('cursor').$type<MailProviderCursor | null>(),
  /** When this mailbox started being watched: mail received before this baseline never starts a run. */
  since: timestamp('since', { withTimezone: true }),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  succeededAt: timestamp('succeeded_at', { withTimezone: true }),
  problemCode: text('problem_code'),
  problem: text('problem'),
  /** Consecutive full-read failure counts per provider message id (cleared once read succeeds or skipped after 3 tries). */
  readFailures: jsonb('read_failures').$type<Record<string, number> | null>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Incoming emails that matched at least one live mail automation trigger. Deduplicated on `(connection_id, external_id)`
 * so the same message can never trigger twice; the signed `mail.received` event carries only the row id (content-free).
 */
export const mailTriggerItems = pgTable(
  'mail_trigger_items',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    mailbox: text('mailbox').notNull(),
    externalId: text('external_id').notNull(),
    /** Normalized RFC 5322 Message-ID when the provider reports one (deduplicates moves across folders/UIDs). */
    messageId: text('message_id'),
    threadId: text('thread_id').notNull(),
    fromHeader: text('from_header').notNull(),
    fromAddress: text('from_address').notNull(),
    subject: text('subject').notNull(),
    snippet: text('snippet').notNull(),
    body: text('body').notNull(),
    bodyTruncated: boolean('body_truncated').notNull().default(false),
    attachments: jsonb('attachments').$type<MailAttachment[]>().notNull().default([]),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    mirroredAt: timestamp('mirrored_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_trigger_items_connection_external_idx').on(t.connectionId, t.externalId),
    uniqueIndex('mail_trigger_items_connection_message_id_idx')
      .on(t.connectionId, t.messageId)
      .where(sql`${t.messageId} is not null`),
    index('mail_trigger_items_burrow_idx').on(t.burrowId, t.mirroredAt),
  ],
);
