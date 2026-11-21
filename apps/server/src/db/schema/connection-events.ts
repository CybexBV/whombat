/**
 * A connection's recent events (docs/decisions/service-slots.md, migration 0135): what a service sent over its event
 * stream that it keeps no history of itself — UniFi Protect's detections — for its page's today and the last two
 * weeks. One row per the service's own event id (later updates of an event replace it). Operational state like
 * `gateway_usage`: written by the server's subscriber (`things/kinds/home/protect-events.ts`), never signed; older than
 * 14 days removed hourly.
 */
import { index, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { catalogConnections } from './connections-catalog';

/** What a stored event carries besides its kind: what was detected, when it ended. */
export interface ConnectionEventPayload {
  /** Protect's smart detections (`person`, `vehicle`, `animal`, `package`, `licensePlate`, `face`, `alrmSmoke` …). */
  detected?: string[];
  /** When the event ended (ISO), once the service said so. */
  end?: string;
}

export const connectionEvents = pgTable(
  'connection_events',
  {
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    /** The service's own id of the event. */
    eventId: text('event_id').notNull(),
    at: ts('at').notNull(),
    /** The service's kind of event (Protect: `motion`, `ring`, `smartDetectZone`, `smartDetectLine` …). */
    kind: text('kind').notNull(),
    /** The device it came from (a camera's id), when it says. */
    device: text('device'),
    /** The device's name as it was then (“Front door”). */
    title: text('title').notNull(),
    payload: jsonb('payload').$type<ConnectionEventPayload>().notNull().default({}),
  },
  (t) => [
    primaryKey({ name: 'connection_events_pk', columns: [t.connectionId, t.eventId] }),
    index('connection_events_recent_idx').on(t.connectionId, t.at),
    index('connection_events_at_idx').on(t.at),
  ],
);
