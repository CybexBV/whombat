/**
 * Open to the internet (docs/decisions/internet-exposure.md), migration 0044: the openings Whombat has seen per
 * connection whose settings open them, so it can tell what is new. Only a fingerprint and when it was seen are kept,
 * never the names or addresses (the source's settings hold those). The row `*` says the first list of that connection
 * is kept: openings in it were there before Whombat looked (`baseline`) and raise nothing. Operational state, like the
 * glance: written by the health pass.
 */
import { boolean, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { catalogConnections } from './connections-catalog';

export const exposureOpenings = pgTable(
  'exposure_openings',
  {
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    /** `op_<hash>` of the opening, or `*` once the first list is kept. */
    openingId: text('opening_id').notNull(),
    firstSeen: ts('first_seen').notNull(),
    lastSeen: ts('last_seen').notNull(),
    /** In the first list: there before Whombat looked, so never new. */
    baseline: boolean('baseline').notNull().default(false),
  },
  (t) => [primaryKey({ name: 'exposure_openings_pk', columns: [t.connectionId, t.openingId] })],
);
