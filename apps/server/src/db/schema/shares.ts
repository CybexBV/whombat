/**
 * The person's shared links (docs/decisions/share-links.md): one row per link to a copy of part of a Chat thread. The
 * copy itself is only at control, sealed; the box keeps the link's key (sealed at rest, `share:<id>:key`) so the person
 * can copy the link again, and what the link shows (the thread, from which message, with or without pictures). Changed
 * only through the commit pipeline; deleting the thread stops its links (the share round).
 */
import { boolean, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { burrows } from './tenancy';

export const shares = pgTable(
  'shares',
  {
    /** The box's own id, `shr_` + 22 base64url characters; control keeps the copy under it. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /**
     * The Chat it came from and the thread's first message. No foreign keys: a link outlives a deleted thread or chat
     * here until the share round has stopped it at control too.
     */
    conversationId: text('conversation_id').notNull(),
    rootId: text('root_id').notNull(),
    fromMessageId: text('from_message_id'),
    createdById: text('created_by_id').references(() => principals.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** The key, sealed with the box's custody key. */
    keyEnc: text('key_enc').notNull(),
    /** Control's viewer page for it, without the key; null until control kept the copy. */
    viewerUrl: text('viewer_url'),
    messages: integer('messages').notNull(),
    pictures: boolean('pictures').notNull(),
    bytes: integer('bytes').notNull(),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at'),
    stoppedAt: ts('stopped_at'),
    /** Stopped here but control hasn't deleted the copy yet: the round tries again. */
    stopPending: boolean('stop_pending').notNull().default(false),
  },
  (t) => [index('shares_burrow_idx').on(t.burrowId, t.createdAt), index('shares_root_idx').on(t.rootId)],
);
