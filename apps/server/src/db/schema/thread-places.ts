/**
 * Where a thread of a person's Chat was listed while Whombat had a separate Code list. Nothing reads or writes it now:
 * every thread is Chat's (docs/decisions/one-chat.md). It stays until a later release drops it, so a box rolled back
 * to the release before still finds it (docs/decisions/managed-db.md MD-03).
 */
import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { conversations, messages } from './conversations';
import { burrows } from './tenancy';

export type ThreadPlaceValue = 'chat' | 'code';
/** Who put it there: work that started in it, its person, or the assistant asked to. */
export type ThreadPlacedBy = 'work' | 'person' | 'agent';

export const threadPlaces = pgTable(
  'thread_places',
  {
    /** The thread's first message. */
    rootId: text('root_id')
      .primaryKey()
      .references(() => messages.id, { onDelete: 'cascade' }),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    place: text('place').$type<ThreadPlaceValue>().notNull(),
    /** The job in a few words, as the work that moved it named it. */
    title: text('title').notNull(),
    /** The repository's name in T3 Code, when known. */
    project: text('project'),
    placedBy: text('placed_by').$type<ThreadPlacedBy>().notNull(),
    movedAt: ts('moved_at').notNull(),
    /** When its person opened it in Code after it moved (Chat's pointer goes then). */
    seenAt: ts('seen_at'),
  },
  (t) => [index('thread_places_conversation_idx').on(t.conversationId, t.place)],
);

export type ThreadPlaceRow = typeof threadPlaces.$inferSelect;
