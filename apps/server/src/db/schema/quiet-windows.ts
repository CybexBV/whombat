/**
 * Keeping things quiet for a while, causes, and the box's own way out (` `).
 *
 * - `quiet_windows`: a server, connection or device kept quiet until a time, by a person (with an optional note) or by
 *   Whombat for its own planned work (`work`). `thing_id` is the thing's id as `things.page` takes it; `guest_id` narrows
 *   a server's window to one of its machines (Whombat's work on one guest). A server's window is also a maintenance
 *   window in the hosts service (`maintenance_id`). Ended early: `ended_at`.
 * - `thing_causes`: a thing that is down because of something else (its server offline, its machine stopped or kept
 *   quiet, the internet down), kept current by a job every minute (operational, like the glance).
 * - `way_out_outages`: the box's own way out failing (its router, name lookups, the internet), since when and until when,
 *   for the Inbox while it lasts and for history after.
 *
 * `owner_id` is the burrow, as in `notice_quiets`. No foreign keys: a thing id names several kinds of row.
 */
import { index, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';

/** A thing kept quiet until a time. */
export const quietWindows = pgTable(
  'quiet_windows',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    thingId: text('thing_id').notNull(),
    /** One machine of the server `thing_id` names (Whombat's own work on a guest); null: the thing as a whole. */
    guestId: text('guest_id'),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    /** The person's note (“Moving the NAS”), or Whombat's words for its work (“Whombat is updating it”). */
    note: text('note'),
    /** Who kept it quiet; null: Whombat itself. */
    byId: text('by_id'),
    /** Whombat's own planned work this covers (`care:<id>`, `power:<server>/<guest>`): ends 15 minutes after it. */
    work: text('work'),
    /** The hosts service's maintenance window of a server's window, while it holds. */
    maintenanceId: text('maintenance_id'),
    endedAt: ts('ended_at'),
    endedById: text('ended_by_id'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    index('quiet_windows_thing_idx').on(t.ownerId, t.thingId),
    index('quiet_windows_ends_idx').on(t.endsAt),
    uniqueIndex('quiet_windows_work_idx').on(t.work),
  ],
);

/** A thing down because of something else. */
export const thingCauses = pgTable(
  'thing_causes',
  {
    ownerId: text('owner_id').notNull(),
    thingId: text('thing_id').notNull(),
    /** What it is down because of, as a thing id: `server:pve-02`, `box:network`. */
    causeThing: text('cause_thing').notNull(),
    /** Its name as people know it (“pve-02”, “homeassistant”, “the internet”). */
    causeName: text('cause_name').notNull(),
    /**
     * `down`: it doesn't answer because of the cause (its server down, its machine stopped, the internet); `quiet`: it
     * is quiet with a server or machine kept quiet, whatever it answers.
     */
    kind: text('kind').$type<'down' | 'quiet'>().notNull().default('down'),
    /** Why, lower case without a full stop: “while pve-02 is down”, “while pve-02 is kept quiet”. */
    words: text('words').notNull(),
    since: ts('since').notNull(),
    /** When the job last found it still so: a row the job no longer keeps current doesn't count. */
    checkedAt: ts('checked_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'thing_causes_pk', columns: [t.ownerId, t.thingId] }),
    index('thing_causes_cause_idx').on(t.ownerId, t.causeThing),
  ],
);

/** The box's way out failing at one step. */
export const wayOutOutages = pgTable(
  'way_out_outages',
  {
    id: text('id').primaryKey(),
    /** `router`, `names` (name lookups) or `internet`. */
    step: text('step').$type<'router' | 'names' | 'internet'>().notNull(),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
  },
  (t) => [index('way_out_outages_started_idx').on(t.startedAt)],
);

export type QuietWindowRow = typeof quietWindows.$inferSelect;
export type ThingCauseRow = typeof thingCauses.$inferSelect;
export type WayOutOutageRow = typeof wayOutOutages.$inferSelect;
