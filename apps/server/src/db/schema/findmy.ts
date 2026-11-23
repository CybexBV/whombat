import { index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { catalogConnections } from './connections-catalog';
import { burrows } from './tenancy';

/**
 * Each person's last known place on a Find My connection that a live automation listens to
 * (docs/decisions/findmy-connection.md): Find My's own words for it (“Home”, “Lelystad”) and since when, one row per
 * person, so an update or a restart neither makes up an arrival nor misses one. Never a street, coordinates or a
 * history: a row changes only when the place does, through the commit pipeline, and the rows go when no automation
 * listens any more or the connection is removed.
 */
export const findMyPlaces = pgTable(
  'findmy_places',
  {
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    /** Find My's stable id for the person (12 hex characters of the SHA-256 of their name). */
    person: text('person').notNull(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    place: text('place').notNull(),
    since: timestamp('since', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.person] }),
    index('findmy_places_burrow_idx').on(t.burrowId),
  ],
);
