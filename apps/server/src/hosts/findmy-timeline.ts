/**
 * A Find My timeline (docs/decisions/findmy-timeline.md): only while the person keeps one on a Find My connection, and
 * only for the people they ticked, the box keeps where Whombat's reads found them, 30 days. After every read of a Mac
 * that worked (the page's, the background's, the assistant's) each kept person's last row is extended when the read
 * says the same, or a new row starts; after a background read that didn't work, each kept person gets an `unread` row
 * with the read's problem. Rows are written by the burrow's Find My signer through the commit pipeline with no event, so
 * the event log never holds where anyone was. Turning it on, changing whose and deleting are the person's own signed
 * commands, with names only.
 */
import {
  ConnectionId,
  FIND_MY_LISTENED_MS,
  FIND_MY_TIMELINE_DAYS,
  FIND_MY_TIMELINE_SEGMENTS_MAX,
  FindMyPersonId,
  FindMySpot,
  type FindMyStopKind,
  type FindMyTimelinePerson,
  type FindMyTimelineRow,
  type FindMyTimelineSegment,
  findMyStopKey,
  findMyTimelineDay,
  findMyTimelineTolerance,
  HOST_FIND_MY_PEOPLE_MAX,
  HostFindMyCode,
  type HostFindMyPerson,
  thingHref,
} from '@whombat/core';
import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { findMyStops, findMyTimelinePeople } from '../db/schema/index';
import { recordChange } from '../home/registry';
import { forbidden, notFound } from '../lib/errors';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { findMyConnectionRow, findMyConnections, findMyPace } from './findmy-connection';
import { findMyPrincipal } from './findmy-places';

/** How often a connection that keeps a timeline reads at least (minutes), as one an automation listens to. */
export const FIND_MY_TIMELINE_EVERY_MIN = FIND_MY_LISTENED_MS / 60_000;

/** Rows one retention commit deletes at most; a pass deletes a few batches and the next pass the rest. */
export const FIND_MY_TIMELINE_EXPIRE_BATCH = 500;
const EXPIRE_BATCHES_PER_PASS = 20;

const DAY_MS = 86_400_000;
const WORDS_MAX = 300;

/** How often a connection with a timeline reads (minutes): its own setting when sooner, else every 15 minutes. */
export function timelinePaceMinutes(background: string | undefined): number {
  return (
    findMyPace(background, null, FIND_MY_TIMELINE_EVERY_MIN, true)?.everyMinutes ?? FIND_MY_TIMELINE_EVERY_MIN
  );
}

/* What a read says (pure) ------------------------------------------------------------------------------------------ */

/** What a read says of one kept person, as a row keeps it. */
export type TimelineSays =
  | { kind: 'place'; place: string; address: string | null; spot: FindMySpot | null }
  | { kind: 'none' }
  | { kind: 'unread'; code: HostFindMyCode };

const words = (s: string | null | undefined): string | null => {
  const w = s?.replace(/\s+/g, ' ').trim().slice(0, WORDS_MAX);
  return w ? w : null;
};

/**
 * What a read says of a person: Find My had a place (its words, else the street when it gave only that), with the street
 * and the geocoder's spot; or, without a place or not on the read at all, no location.
 */
export function saysOf(
  p: Pick<HostFindMyPerson, 'place' | 'address' | 'location'> | undefined,
): TimelineSays {
  const address = words(p?.address);
  const place = words(p?.place) ?? address;
  if (!p || !place) return { kind: 'none' };
  const spot = p.location && FindMySpot.safeParse(p.location).success ? { ...p.location } : null;
  return { kind: 'place', place, address, spot };
}

/** A person's last row, as the writer compares a read with it. */
export interface LastStop {
  id: number;
  person: string;
  kind: FindMyStopKind;
  place: string | null;
  address: string | null;
  code: string | null;
  lastAt: Date;
}

/** One write a read makes: a person's last row extended to the read, or a new row from it. */
export type StopWrite =
  | { kind: 'extend'; id: number; person: string; at: Date; says: TimelineSays }
  | { kind: 'start'; person: string; at: Date; says: TimelineSays };

/** Whether a read says what a row says: the same kind and place (`findMyStopKey`), and the same problem. */
export function sameStop(
  row: Pick<LastStop, 'kind' | 'place' | 'address' | 'code'>,
  says: TimelineSays,
): boolean {
  if (findMyStopKey(row) !== findMyStopKey(says)) return false;
  return says.kind !== 'unread' || row.code === says.code;
}

/**
 * The writes of one read for the kept people (pure): a person's last row is extended when the read says the same and
 * the row's last read is within `toleranceMs` (`findMyTimelineTolerance`); otherwise a new row starts at the read. A read
 * no newer than a person's last row (the same read noted twice) writes nothing for them.
 */
export function timelineWrites(
  kept: readonly string[],
  last: ReadonlyMap<string, LastStop>,
  says: (person: string) => TimelineSays,
  at: Date,
  toleranceMs: number,
): StopWrite[] {
  const writes: StopWrite[] = [];
  for (const person of new Set(kept)) {
    const s = says(person);
    const before = last.get(person);
    if (before && at.getTime() <= before.lastAt.getTime()) continue;
    if (before && sameStop(before, s) && at.getTime() - before.lastAt.getTime() <= toleranceMs)
      writes.push({ kind: 'extend', id: before.id, person, at, says: s });
    else writes.push({ kind: 'start', person, at, says: s });
  }
  return writes;
}

/* Reading what is kept --------------------------------------------------------------------------------------------- */

/** A person a connection keeps a timeline of. */
export interface KeptPerson {
  person: string;
  name: string;
  keptSince: Date;
}

/** Whose days a connection keeps, in the order they were ticked. */
export async function keptTimelinePeople(db: Db | Tx, connectionId: string): Promise<KeptPerson[]> {
  return db
    .select({
      person: findMyTimelinePeople.person,
      name: findMyTimelinePeople.name,
      keptSince: findMyTimelinePeople.keptSince,
    })
    .from(findMyTimelinePeople)
    .where(eq(findMyTimelinePeople.connectionId, connectionId))
    .orderBy(asc(findMyTimelinePeople.keptSince), asc(findMyTimelinePeople.name));
}

/** The connections that keep a timeline (have someone ticked). */
export async function timelineConnectionIds(db: Db | Tx): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ connectionId: findMyTimelinePeople.connectionId })
    .from(findMyTimelinePeople);
  return new Set(rows.map((r) => r.connectionId));
}

type StopRow = typeof findMyStops.$inferSelect;

/** A stored row as `findMyTimelineDay` takes it. */
export function rowOf(r: StopRow): FindMyTimelineRow {
  const at = { firstAt: r.firstAt, lastAt: r.lastAt };
  if (r.kind === 'place' && r.place)
    return {
      kind: 'place',
      place: r.place,
      address: r.address,
      spot: r.lat !== null && r.lon !== null ? { lat: r.lat, lon: r.lon, accuracyM: r.accuracyM ?? 0 } : null,
      ...at,
    };
  if (r.kind === 'unread' && r.code) return { kind: 'unread', code: r.code, ...at };
  return { kind: 'none', ...at };
}

const msOf = (t: FindMyTimelineRow['firstAt']) => (t instanceof Date ? t.getTime() : new Date(t).getTime());

/**
 * The rows one day needs, from a person's rows sorted by their first read (pure): those that touch the day, the last
 * one before it and the first one after it, so the time across midnight is known.
 */
export function rowsForDay(rows: readonly FindMyTimelineRow[], from: Date, to: Date): FindMyTimelineRow[] {
  const f = from.getTime();
  const t = to.getTime();
  let before: FindMyTimelineRow | null = null;
  let after: FindMyTimelineRow | null = null;
  const touching: FindMyTimelineRow[] = [];
  for (const r of rows) {
    const first = msOf(r.firstAt);
    const last = msOf(r.lastAt);
    if (last < f) {
      if (!before || last > msOf(before.lastAt)) before = r;
    } else if (first >= t) {
      if (!after || first < msOf(after.firstAt)) after = r;
    } else touching.push(r);
  }
  return [...(before ? [before] : []), ...touching, ...(after ? [after] : [])];
}

/** One person's day as segments, at most as many as the answer carries. */
export function timelineDay(
  rows: readonly FindMyTimelineRow[],
  opts: { from: Date; to: Date; now: Date; toleranceMs: number },
): FindMyTimelineSegment[] {
  const segments = findMyTimelineDay(rowsForDay(rows, opts.from, opts.to), opts);
  return segments
    .slice(0, FIND_MY_TIMELINE_SEGMENTS_MAX)
    .map((s) =>
      s.kind === 'stay' && s.holes.length > FIND_MY_TIMELINE_SEGMENTS_MAX
        ? { ...s, holes: s.holes.slice(0, FIND_MY_TIMELINE_SEGMENTS_MAX) }
        : s,
    );
}

/**
 * The rows of kept people over a span, each person's sorted by their first read: those that touch it, the last one
 * before it and the first one after it.
 */
export async function stopsAround(
  db: Db | Tx,
  connectionId: string,
  persons: readonly string[],
  from: Date,
  to: Date,
): Promise<Map<string, FindMyTimelineRow[]>> {
  const out = new Map<string, FindMyTimelineRow[]>(persons.map((p) => [p, []]));
  if (!persons.length) return out;
  const mine = and(eq(findMyStops.connectionId, connectionId), inArray(findMyStops.person, [...persons]));
  const [within, before, after] = await Promise.all([
    db
      .select()
      .from(findMyStops)
      .where(and(mine, gte(findMyStops.lastAt, from), lt(findMyStops.firstAt, to)))
      .orderBy(asc(findMyStops.firstAt), asc(findMyStops.id)),
    db
      .selectDistinctOn([findMyStops.person])
      .from(findMyStops)
      .where(and(mine, lt(findMyStops.lastAt, from)))
      .orderBy(findMyStops.person, desc(findMyStops.lastAt), desc(findMyStops.id)),
    db
      .selectDistinctOn([findMyStops.person])
      .from(findMyStops)
      .where(and(mine, gte(findMyStops.firstAt, to)))
      .orderBy(findMyStops.person, asc(findMyStops.firstAt), asc(findMyStops.id)),
  ]);
  for (const r of before) out.get(r.person)?.push(rowOf(r));
  for (const r of within) out.get(r.person)?.push(rowOf(r));
  for (const r of after) out.get(r.person)?.push(rowOf(r));
  return out;
}

/**
 * Everyone as the timeline lists them (pure): the people of the Mac's last read in its order, kept or not, with what
 * that read says of them now, then those kept who weren't on it.
 */
export function timelinePeople(
  read: readonly HostFindMyPerson[],
  kept: readonly KeptPerson[],
): FindMyTimelinePerson[] {
  const keptBy = new Map(kept.map((k) => [k.person, k]));
  const seen = new Set<string>();
  const out: FindMyTimelinePerson[] = [];
  for (const p of read) {
    if (seen.has(p.id) || !FindMyPersonId.safeParse(p.id).success) continue;
    seen.add(p.id);
    const k = keptBy.get(p.id);
    out.push({
      id: p.id,
      name: p.name,
      kept: Boolean(k),
      keptSince: k ? k.keptSince.toISOString() : null,
      now: { place: p.place, when: p.when, nearby: p.nearby },
    });
  }
  for (const k of kept)
    if (!seen.has(k.person)) {
      seen.add(k.person);
      out.push({ id: k.person, name: k.name, kept: true, keptSince: k.keptSince.toISOString(), now: null });
    }
  return out;
}

/* Commands --------------------------------------------------------------------------------------------------------- */

async function requireSigner(tx: Tx, actorId: string): Promise<void> {
  const row = await loadPrincipalRow(tx, actorId);
  if (!findMyPrincipal.is(row)) throw forbidden('Only Whombat’s Find My keeps the timeline.');
}

function requirePerson(ctx: Pick<ApplyContext, 'actor'>): void {
  if (ctx.actor.kind !== 'person') throw forbidden('Only you can change the Find My timeline.');
}

const Says = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('place'),
    place: z.string().min(1).max(WORDS_MAX),
    address: z.string().min(1).max(WORDS_MAX).nullable(),
    spot: FindMySpot.nullable(),
  }),
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('unread'), code: HostFindMyCode }),
]);

/** The last row of each of these people on a connection. */
async function lastStops(tx: Tx, connectionId: string, persons: readonly string[]) {
  if (!persons.length) return new Map<string, LastStop>();
  const rows = await tx
    .selectDistinctOn([findMyStops.person], {
      id: findMyStops.id,
      person: findMyStops.person,
      kind: findMyStops.kind,
      place: findMyStops.place,
      address: findMyStops.address,
      code: findMyStops.code,
      lastAt: findMyStops.lastAt,
    })
    .from(findMyStops)
    .where(and(eq(findMyStops.connectionId, connectionId), inArray(findMyStops.person, [...persons])))
    .orderBy(findMyStops.person, desc(findMyStops.lastAt), desc(findMyStops.id));
  return new Map(rows.map((r) => [r.person, r]));
}

const placeColumns = (s: TimelineSays) =>
  s.kind === 'place'
    ? {
        place: s.place,
        address: s.address,
        lat: s.spot?.lat ?? null,
        lon: s.spot?.lon ?? null,
        accuracyM: s.spot?.accuracyM ?? null,
      }
    : { place: null, address: null, lat: null, lon: null, accuracyM: null };

/**
 * Notes one read of a connection's Mac on its timeline: for each person it keeps, what the read said of them (`read`;
 * someone missing from it has no location), or that the background read didn't work (`unread`). Signed by nobody: it
 * emits no event, so where people were is only ever in these rows. Nothing happens on a connection that is gone or keeps
 * no timeline, or for someone who isn't kept (any more).
 */
export const noteFindMyTimeline = defineCommand({
  name: 'findmy.timeline_noted',
  schema: z.object({
    connectionId: ConnectionId,
    at: z.string().datetime(),
    paceMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60),
    outcome: z.union([
      z.object({
        read: z.array(z.object({ person: FindMyPersonId, says: Says })).max(HOST_FIND_MY_PEOPLE_MAX),
      }),
      z.object({ unread: HostFindMyCode }),
    ]),
  }),
  async apply(tx, ctx, input) {
    await requireSigner(tx, ctx.actor.id);
    if (!(await findMyConnectionRow(tx, ctx.burrow.id, input.connectionId))) return { written: 0 };
    const kept = (await keptTimelinePeople(tx, input.connectionId)).map((k) => k.person);
    if (!kept.length) return { written: 0 };
    const outcome = input.outcome;
    const read = 'read' in outcome ? new Map(outcome.read.map((r) => [r.person, r.says])) : null;
    const says = (person: string): TimelineSays =>
      'unread' in outcome
        ? { kind: 'unread', code: outcome.unread }
        : (read?.get(person) ?? { kind: 'none' });
    const at = new Date(input.at);
    const writes = timelineWrites(
      kept,
      await lastStops(tx, input.connectionId, kept),
      says,
      at,
      findMyTimelineTolerance(input.paceMinutes * 60_000),
    );
    for (const w of writes) {
      if (w.kind === 'extend') {
        // The same place: its words and spot from this read (a spot found now is kept, none found keeps the last).
        const refresh =
          w.says.kind === 'place'
            ? {
                place: w.says.place,
                address: w.says.address,
                ...(w.says.spot
                  ? { lat: w.says.spot.lat, lon: w.says.spot.lon, accuracyM: w.says.spot.accuracyM }
                  : {}),
              }
            : {};
        await tx
          .update(findMyStops)
          .set({ lastAt: w.at, ...refresh })
          .where(eq(findMyStops.id, w.id));
      } else
        await tx.insert(findMyStops).values({
          connectionId: input.connectionId,
          burrowId: ctx.burrow.id,
          person: w.person,
          kind: w.says.kind,
          ...placeColumns(w.says),
          code: w.says.kind === 'unread' ? w.says.code : null,
          firstAt: w.at,
          lastAt: w.at,
        });
    }
    return { written: writes.length };
  },
});

/** Deletes a burrow's timeline rows whose last read is older than `before`, at most `limit` of them (the 30 days). */
export const expireFindMyTimeline = defineCommand({
  name: 'findmy.timeline_expired',
  schema: z.object({
    before: z.string().datetime(),
    limit: z.number().int().min(1).max(FIND_MY_TIMELINE_EXPIRE_BATCH),
  }),
  async apply(tx, ctx, input) {
    await requireSigner(tx, ctx.actor.id);
    const old = tx
      .select({ id: findMyStops.id })
      .from(findMyStops)
      .where(and(eq(findMyStops.burrowId, ctx.burrow.id), lt(findMyStops.lastAt, new Date(input.before))))
      .orderBy(asc(findMyStops.lastAt))
      .limit(input.limit);
    const gone = await tx
      .delete(findMyStops)
      .where(inArray(findMyStops.id, old))
      .returning({ id: findMyStops.id });
    return { deleted: gone.length };
  },
});

/** “Noor Visser”, “Noor Visser and Ruben Visser”, “Noor Visser, Ruben Visser and Ilse Visser”. */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A sentence about people, by name while it fits in `max`, else by count. */
function aboutPeople(lead: string, names: readonly string[], max: number, tail = ''): string {
  const named = `${lead}${nameList(names)}${tail}`;
  return named.length <= max ? named : `${lead}${names.length} people${tail}`;
}

/** “Kept a Find My timeline for Noor Visser and Ruben Visser”, or “Stopped keeping a Find My timeline”. */
export function timelineSetText(kept: readonly string[], max = 200): string {
  return kept.length
    ? aboutPeople('Kept a Find My timeline for ', kept, max)
    : 'Stopped keeping a Find My timeline';
}

/** Whose days went with the change: “Deleted Ilse Visser’s days.” */
export function timelineDroppedText(dropped: readonly string[], max = 500): string | null {
  if (!dropped.length) return null;
  return dropped.length === 1
    ? `Deleted ${dropped[0]}’s days.`.slice(0, max)
    : aboutPeople('Deleted the days of ', dropped, max, '.');
}

/** Records the person's change on the connection's page (its Activity), with the same words. */
async function recordTimelineChange(
  ctx: ApplyContext,
  row: { id: string; label: string },
  kind: string,
  title: string,
  detail: string | null,
) {
  await recordChange(ctx, {
    burrowId: ctx.burrow.id,
    actorId: ctx.actor.id,
    personId: ctx.actor.id,
    kind,
    title,
    detail,
    subject: { kind: 'connection', id: row.id, name: row.label.slice(0, 120) },
    link: thingHref('connection', row.id),
    at: ctx.now,
  });
}

/**
 * The person chooses whose days a Find My connection keeps (`people`, with the names Find My gives them): someone
 * unticked loses their rows in the same commit, and no one stops the timeline and deletes everything. Signed with names
 * only; nothing changed signs nothing.
 */
export const setFindMyTimeline = defineCommand({
  name: 'findmy.timeline_set',
  schema: z.object({
    connectionId: ConnectionId,
    people: z
      .array(z.object({ person: FindMyPersonId, name: z.string().min(1).max(200) }))
      .max(HOST_FIND_MY_PEOPLE_MAX),
  }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await findMyConnectionRow(tx, ctx.burrow.id, input.connectionId);
    if (!row) throw notFound('Find My connection');
    const before = await keptTimelinePeople(tx, row.id);
    const want = new Map(input.people.map((p) => [p.person, p]));
    const had = new Set(before.map((b) => b.person));
    const added = [...want.values()].filter((p) => !had.has(p.person));
    const dropped = before.filter((b) => !want.has(b.person));
    if (!added.length && !dropped.length) return { eventId: null as string | null };
    if (dropped.length) {
      const persons = dropped.map((d) => d.person);
      await tx
        .delete(findMyStops)
        .where(and(eq(findMyStops.connectionId, row.id), inArray(findMyStops.person, persons)));
      await tx
        .delete(findMyTimelinePeople)
        .where(
          and(eq(findMyTimelinePeople.connectionId, row.id), inArray(findMyTimelinePeople.person, persons)),
        );
    }
    if (added.length)
      await tx.insert(findMyTimelinePeople).values(
        added.map((p) => ({
          connectionId: row.id,
          person: p.person,
          burrowId: ctx.burrow.id,
          name: p.name,
          keptSince: ctx.now,
        })),
      );
    const keptNames = [...want.values()].map((p) => p.name);
    const droppedNames = dropped.map((d) => d.name);
    const text = timelineSetText(keptNames, 500);
    const detail = keptNames.length ? timelineDroppedText(droppedNames) : 'Deleted every day it kept.';
    const event = await ctx.emit({
      type: 'findmy.timeline_set',
      kind: 'System',
      text,
      where: row.label.slice(0, 200),
      payload: {
        connectionId: row.id,
        kept: [...want.values()].map((p) => ({ person: p.person, name: p.name })),
        dropped: dropped.map((d) => ({ person: d.person, name: d.name })),
      },
    });
    await recordTimelineChange(ctx, row, 'findmy.timeline_set', timelineSetText(keptNames), detail);
    return { eventId: event.id as string | null };
  },
});

/**
 * The person deletes every day a Find My connection kept so far; whose days it keeps stays, kept from now on. Signed
 * “Deleted the Find My timeline”; a connection that keeps no timeline signs nothing.
 */
export const deleteFindMyTimeline = defineCommand({
  name: 'findmy.timeline_deleted',
  schema: z.object({ connectionId: ConnectionId }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await findMyConnectionRow(tx, ctx.burrow.id, input.connectionId);
    if (!row) throw notFound('Find My connection');
    if (!(await keptTimelinePeople(tx, row.id)).length) return { eventId: null as string | null, deleted: 0 };
    const gone = await tx
      .delete(findMyStops)
      .where(eq(findMyStops.connectionId, row.id))
      .returning({ id: findMyStops.id });
    // The days kept start again now.
    await tx
      .update(findMyTimelinePeople)
      .set({ keptSince: ctx.now })
      .where(eq(findMyTimelinePeople.connectionId, row.id));
    const text = 'Deleted the Find My timeline';
    const event = await ctx.emit({
      type: 'findmy.timeline_deleted',
      kind: 'System',
      text,
      where: row.label.slice(0, 200),
      payload: { connectionId: row.id },
    });
    await recordTimelineChange(ctx, row, 'findmy.timeline_deleted', text, 'Removed every day kept so far.');
    return { eventId: event.id as string | null, deleted: gone.length };
  },
});

export const FIND_MY_TIMELINE_COMMANDS = [
  noteFindMyTimeline,
  expireFindMyTimeline,
  setFindMyTimeline,
  deleteFindMyTimeline,
];

/* The writer ------------------------------------------------------------------------------------------------------- */

/**
 * Notes reads on the timelines of the Find My connections on a Mac (one at a time per Mac, so reads close together are
 * noted in order), and deletes what is past 30 days. Never throws: a read that can't be noted is said in the log, with
 * the Mac only.
 */
export class FindMyTimelineWriter {
  readonly #chains = new Map<string, Promise<void>>();

  constructor(private readonly services: Services) {}

  #inLine(serverId: string, work: () => Promise<void>): Promise<void> {
    const key = serverId.toLowerCase();
    const next = (this.#chains.get(key) ?? Promise.resolve())
      .then(work)
      .catch((err: unknown) =>
        this.services.log.warn(
          { server: serverId, err: err instanceof Error ? err.name : 'error' },
          'Find My: a read wasn’t noted on the timeline',
        ),
      );
    this.#chains.set(key, next);
    void next.finally(() => {
      if (this.#chains.get(key) === next) this.#chains.delete(key);
    });
    return next;
  }

  /** A read of the Mac that worked: each connection there that keeps a timeline notes it. */
  noted(serverId: string, people: readonly HostFindMyPerson[], at: Date): Promise<void> {
    return this.#inLine(serverId, async () => {
      for (const c of await this.#keeping(serverId)) {
        const kept = new Set((await keptTimelinePeople(this.services.db, c.id)).map((k) => k.person));
        const read = people
          .filter((p) => kept.has(p.id) && FindMyPersonId.safeParse(p.id).success)
          .map((p) => ({ person: p.id, says: saysOf(p) }));
        await this.#commit(c, at, { read });
      }
    });
  }

  /** A background read of the Mac for this connection didn't work: its kept people weren't read, and why. */
  failed(serverId: string, connectionId: string, code: HostFindMyCode, at: Date): Promise<void> {
    return this.#inLine(serverId, async () => {
      for (const c of await this.#keeping(serverId))
        if (c.id === connectionId) await this.#commit(c, at, { unread: code });
    });
  }

  /** The Find My connections on the Mac that keep a timeline. */
  async #keeping(serverId: string) {
    if (this.services.schemaAccess === 'read-only') return [];
    const connections = await findMyConnections(this.services.db, { mac: serverId });
    if (!connections.length) return [];
    const keeping = await timelineConnectionIds(this.services.db);
    return connections.filter((c) => keeping.has(c.id));
  }

  async #commit(
    c: { id: string; burrowId: string; fields: Readonly<Record<string, string>> },
    at: Date,
    outcome: z.input<typeof noteFindMyTimeline.schema>['outcome'],
  ): Promise<void> {
    const actorId = await findMyPrincipal.ensure(this.services, c.burrowId);
    await this.services.pipeline.commit(
      noteFindMyTimeline,
      {
        connectionId: c.id,
        at: at.toISOString(),
        paceMinutes: timelinePaceMinutes(c.fields.background),
        outcome,
      },
      { burrowId: c.burrowId, actorId },
    );
  }

  /**
   * Deletes the rows whose last read is over 30 days old (each pass of the background), a batch at a time; what is left
   * goes on the next pass. Returns how many went.
   */
  async expire(now: Date): Promise<number> {
    const services = this.services;
    if (services.schemaAccess === 'read-only') return 0;
    const before = new Date(now.getTime() - FIND_MY_TIMELINE_DAYS * DAY_MS);
    const burrows = await services.db
      .selectDistinct({ burrowId: findMyStops.burrowId })
      .from(findMyStops)
      .where(lt(findMyStops.lastAt, before));
    let deleted = 0;
    for (const { burrowId } of burrows) {
      const actorId = await findMyPrincipal.ensure(services, burrowId);
      for (let i = 0; i < EXPIRE_BATCHES_PER_PASS; i++) {
        const res = await services.pipeline.commit(
          expireFindMyTimeline,
          { before: before.toISOString(), limit: FIND_MY_TIMELINE_EXPIRE_BATCH },
          { burrowId, actorId },
        );
        const n = res.status === 'ok' ? res.result.deleted : 0;
        deleted += n;
        if (n < FIND_MY_TIMELINE_EXPIRE_BATCH) break;
      }
    }
    return deleted;
  }
}

const writers = new WeakMap<Services, FindMyTimelineWriter>();

/** The process's timeline writer (one per `Services`). */
export function findMyTimelineFor(services: Services): FindMyTimelineWriter {
  let w = writers.get(services);
  if (!w) {
    w = new FindMyTimelineWriter(services);
    writers.set(services, w);
  }
  return w;
}
