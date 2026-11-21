/**
 * Hermes housekeeping the server owes the runner's homes (docs/decisions/hermes-native.md HN-K02; one-person.md OP-S47),
 * kept here so it survives a runner that isn't there and a restart: the sessions Whombat forgot.
 */
import type { HermesHome } from '@whombat/core';
import { index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { ts } from './common';

/**
 * A Hermes session no turn names any more (HE-40, HE-S119): written in the commit that forgets it, handed to the
 * runner (`sessions.delete`) until it takes it (`handed_at`), and kept after that, so a restored home that brings it
 * back has it deleted again.
 */
export const hermesSessionDrops = pgTable(
  'hermes_session_drops',
  {
    /** The home it lives in: the person's, or the outsiders' (`HermesHome`, OP-S47). */
    home: text('home').$type<HermesHome>().notNull(),
    /** Hermes's id, without `hermes:`. */
    sessionId: text('session_id').notNull(),
    droppedAt: ts('dropped_at').notNull(),
    /** When the runner took it for deletion; null while it still has to. */
    handedAt: ts('handed_at'),
  },
  (t) => [
    primaryKey({ name: 'hermes_session_drops_pk', columns: [t.home, t.sessionId] }),
    index('hermes_session_drops_handed_idx').on(t.handedAt),
  ],
);
