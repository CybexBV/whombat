import type { FindMyStopKind, HostFindMyCode } from '@whombat/core';
import { bigserial, doublePrecision, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
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

/**
 * The people a Find My connection keeps a timeline of (docs/decisions/findmy-timeline.md): one row per person the
 * person ticked, their name as Find My gives it and since when. A connection keeps a timeline while it has rows here;
 * they go with the connection, when the person unticks someone or stops the timeline.
 */
export const findMyTimelinePeople = pgTable(
  'findmy_timeline_people',
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
    keptSince: timestamp('kept_since', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.person] }),
    index('findmy_timeline_people_burrow_idx').on(t.burrowId),
  ],
);

/**
 * A Find My timeline's rows: one per stretch where Whombat's reads of a kept person said the same, from its first read
 * to its last. `place`: Find My's place words, the street and the Mac geocoder's spot (null when it had none); `none`:
 * Find My had no location; `unread`: a background read of the Mac didn't work (`code`). Never Find My's “seen …” words
 * or a picture. Rows whose last read is over 30 days old are deleted by the background, and all of a connection's go
 * with it.
 */
export const findMyStops = pgTable(
  'findmy_stops',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    person: text('person').notNull(),
    kind: text('kind').$type<FindMyStopKind>().notNull(),
    place: text('place'),
    address: text('address'),
    lat: doublePrecision('lat'),
    lon: doublePrecision('lon'),
    accuracyM: doublePrecision('accuracy_m'),
    code: text('code').$type<HostFindMyCode>(),
    firstAt: timestamp('first_at', { withTimezone: true }).notNull(),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('findmy_stops_person_idx').on(t.connectionId, t.person, t.lastAt),
    index('findmy_stops_last_idx').on(t.lastAt),
  ],
);
