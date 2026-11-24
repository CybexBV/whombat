/**
 * Outages and their history (Whombat docs/decisions/monitoring.md MON-06, MON-09): an incident is kept for a server,
 * connection or device while its dot is bad (`problem`) or it doesn't answer (`down`), confirmed over two passes; it
 * ends after two passes without. Kept 90 days. A thing's page says its week in one line (`ThingUptime`), and
 * `things.history` lists its incidents over 30 or 90 days. Opening and ending each sign a neutral event that automations
 * may start on (`thing.down`, `thing.problem`, `thing.back`).
 */
import { z } from 'zod';
import { Timestamp } from './common.js';

/** `down`: it doesn't answer (offline); `problem`: it answers but its dot is bad. */
export const INCIDENT_NATURES = ['down', 'problem'] as const;
export const IncidentNature = z.enum(INCIDENT_NATURES);
export type IncidentNature = z.infer<typeof IncidentNature>;

/** How long incidents are kept. */
export const INCIDENTS_KEEP_DAYS = 90;

/** The periods `things.history` reads, in days. */
export const THING_HISTORY_DAYS = [30, 90] as const;

/** What another thing being down took with it: the server or machine this one runs on. */
export const IncidentCause = z.object({
  /** Its thingId (`server:pve-02`). */
  thing: z.string().min(3).max(220),
  name: z.string().min(1).max(120),
});
export type IncidentCause = z.infer<typeof IncidentCause>;

/** One incident as the apps list it: when, how long, what it was and its cause. */
export const ThingIncident = z.object({
  /** `inc_…`. */
  id: z.string().min(1).max(80),
  nature: IncidentNature,
  /** What was wrong, in Whombat's words (“Not answering”, “A disk is failing”). */
  words: z.string().min(1).max(200),
  startedAt: Timestamp,
  /** Null while it lasts. */
  endedAt: Timestamp.nullable(),
  /** How long it lasted (so far), in whole minutes. */
  minutes: z.number().int().min(0),
  /** Down because what it runs on was down; absent: its own. */
  cause: IncidentCause.optional(),
});
export type ThingIncident = z.infer<typeof ThingIncident>;

/** A server alert the hosts service resolved (or still has open), as a server's history lists it. */
export const ThingHistoryAlert = z.object({
  title: z.string().max(300),
  severity: z.enum(['critical', 'warning']),
  rule: z.string().max(120),
  openedAt: Timestamp,
  /** Null while it is open. */
  resolvedAt: Timestamp.nullable(),
});
export type ThingHistoryAlert = z.infer<typeof ThingHistoryAlert>;

/**
 * A thing's week in one line (MON-09): “Up 99.6 % this week · down 3 times, 41 min”, “Up all week”. `upPct` is the share
 * of the period it answered (rolled-up hours weighed as hours), null when Whombat has no checks of it to tell; `downs`
 * and `downMinutes` count its `down` incidents in the period (a server's offline alerts too). `from` is where the period
 * starts: a week ago, or when Whombat started watching it when that is later.
 */
export const ThingUptime = z.object({
  text: z.string().min(1).max(120),
  upPct: z.number().min(0).max(100).nullable(),
  downs: z.number().int().min(0),
  downMinutes: z.number().int().min(0),
  from: Timestamp,
});
export type ThingUptime = z.infer<typeof ThingUptime>;

/** `things.history`'s query: the last 30 (default) or 90 days. */
export const ThingHistoryQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => (THING_HISTORY_DAYS as readonly number[]).includes(d), 'days: 30 or 90')
    .optional(),
});
export type ThingHistoryQuery = z.infer<typeof ThingHistoryQuery>;

/**
 * `things.history` (session minor 9): a thing's incidents over the period, newest first, its uptime over it, and for a
 * server the alerts the hosts service had in it, newest first.
 */
export const ThingHistory = z.object({
  thing: z.string().min(3).max(220),
  days: z.number().int().min(1).max(INCIDENTS_KEEP_DAYS),
  from: Timestamp,
  uptime: ThingUptime.nullable(),
  incidents: z.array(ThingIncident).max(500),
  alerts: z.array(ThingHistoryAlert).max(500).optional(),
});
export type ThingHistory = z.infer<typeof ThingHistory>;

/** The page id used by monitoring triggers and watches. */
export const ThingIncidentTarget = z
  .string()
  .max(220)
  .regex(/^(server|connection|device):.+$/);

/* Events for automations --------------------------------------------------------------------------------------------- */

/** A thing stopped answering: an incident of nature `down` opened, or a `problem` one became `down`. */
export const THING_DOWN = 'thing.down';
/** A thing's dot turned bad while it still answers: an incident of nature `problem` opened. */
export const THING_PROBLEM = 'thing.problem';
/** An incident ended: the thing is fine again (or only amber). */
export const THING_BACK = 'thing.back';
export const THING_INCIDENT_EVENTS = [THING_DOWN, THING_PROBLEM, THING_BACK] as const;

/**
 * The payload of `thing.down`, `thing.problem` and `thing.back`: the thing (its thingId, kind and name), the incident,
 * its nature and words, when it started, when it ended (`thing.back` only) and its cause when another thing being down
 * took it with it. No address, id of an item or log: what an automation's condition and its words need.
 */
export const ThingIncidentEvent = z.strictObject({
  incidentId: z.string().min(1).max(80),
  thing: z.string().min(3).max(220),
  kind: z.enum(['server', 'connection', 'device']),
  name: z.string().min(1).max(120),
  /** The catalog entry for a connection and the check that opened or worsened the incident. */
  catalogId: z.string().max(120).optional(),
  check: z.string().max(80).optional(),
  nature: IncidentNature,
  words: z.string().min(1).max(200),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  cause: IncidentCause.optional(),
});
export type ThingIncidentEvent = z.infer<typeof ThingIncidentEvent>;
