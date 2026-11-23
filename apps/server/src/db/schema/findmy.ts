import type { FindMyStopKind, FindMyWatchChange, FindMyWatchStatus, HostFindMyCode } from '@whombat/core';
import { bigserial, doublePrecision, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { catalogConnections } from './connections-catalog';
import { conversations, messages } from './conversations';
import { principals } from './principals';
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

/**
 * One-time Find My watches (docs/decisions/findmy-watch.md): the assistant started one in a thread to tell the person
 * once when someone leaves where they were (`leaves`, with where that was) or arrives at a place in Find My's words
 * (`arrives`). Whombat compares each read of the connection's Mac with it and ends it when it happened, after 24 hours,
 * or when the person cancels it. Where they were (the street and the spot) is kept only while it watches: ending a
 * watch clears it. A removed connection leaves its watches to be stopped by the next pass, which tells the person.
 */
export const findMyWatches = pgTable(
  'findmy_watches',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** Null once the connection was removed: the next background pass stops the watch and says so. */
    connectionId: text('connection_id').references(() => catalogConnections.id, { onDelete: 'set null' }),
    /** Find My's stable id for the person, and their name as it gives it. */
    person: text('person').notNull(),
    name: text('name').notNull(),
    change: text('change').$type<FindMyWatchChange>().notNull(),
    /** The card's words: the street they were on (or Find My's words) for `leaves`, the place for `arrives`. */
    place: text('place').notNull(),
    /** Where they were when a `leaves` watch started; null once it ended. */
    fromPlace: text('from_place'),
    fromAddress: text('from_address'),
    lat: doublePrecision('lat'),
    lon: doublePrecision('lon'),
    accuracyM: doublePrecision('accuracy_m'),
    /** The assistant that started it, where it posts, and its card's message. */
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    threadRootId: text('thread_root_id'),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
    status: text('status').$type<FindMyWatchStatus>().notNull(),
    /** Where Find My had them when it happened (its words). */
    to: text('to'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('findmy_watches_connection_idx').on(t.connectionId, t.status),
    index('findmy_watches_burrow_idx').on(t.burrowId, t.status),
  ],
);
