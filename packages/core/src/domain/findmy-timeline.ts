/**
 * A Find My timeline (docs/implementation/macos/findmy-timeline.md): where the people the person ticked were, kept on
 * the box for 30 days and only while the person keeps a timeline. The box keeps one row per stretch where Whombat's
 * reads of a person said the same (`FindMyStop`); the apps and the assistant get each day as segments built from those
 * rows (`findMyTimelineDay`), cut at the day's bounds in the viewer's time zone (`findMyDayBounds`).
 */
import { z } from 'zod';
import { ConnectionId, EventId } from '../ids.js';
import { type DateInput, toDate, zonedParts } from '../text/time.js';
import { IsoDate, Timestamp } from './common.js';
import { HOST_SCREEN_IMAGE_MAX } from './hosts.js';
import {
  FindMyPersonId,
  findMyPlaceKey,
  HOST_FIND_MY_PEOPLE_MAX,
  HostFindMyCode,
  HostFindMyMapQuery,
} from './hosts-findmy.js';

/** Days a timeline keeps: rows whose last read is older are deleted by themselves. */
export const FIND_MY_TIMELINE_DAYS = 30;

/** Days one `findMyTimeline` answers at most (the week view). */
export const FIND_MY_TIMELINE_SPAN_MAX = 7;

/** Pins on a day's map at most: the day's first distinct spots, in order. */
export const FIND_MY_TIMELINE_PINS_MAX = 20;

/** Segments of one person's day at most (a read every 5 minutes is 288 reads a day). */
export const FIND_MY_TIMELINE_SEGMENTS_MAX = 2000;

/** Added to twice the pace before a pause between two reads counts as not read (ms). */
export const FIND_MY_TIMELINE_SLACK_MS = 5 * 60_000;

/** The key of the tab a Find My connection's page shows its timeline on, after its Find My tab. */
export const FIND_MY_TIMELINE_TAB = 'timeline';

/**
 * How far apart two reads may be and still count as one stretch (ms): twice the connection's pace plus 5 minutes. A
 * longer pause is time Whombat didn't read.
 */
export function findMyTimelineTolerance(paceMs: number): number {
  return 2 * paceMs + FIND_MY_TIMELINE_SLACK_MS;
}

/* What the box keeps ------------------------------------------------------------------------------ */

/**
 * What one row says of a person: `place` (Find My had a place for them), `none` (Find My had no location, “No location
 * found”) or `unread` (a background read of the Mac didn't work).
 */
export const FIND_MY_STOP_KINDS = ['place', 'none', 'unread'] as const;
export const FindMyStopKind = z.enum(FIND_MY_STOP_KINDS);
export type FindMyStopKind = z.infer<typeof FindMyStopKind>;

/** Where the Mac's geocoder put a place's street (else its words): about `accuracyM` metres, not Find My's dot. */
export const FindMySpot = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative(),
});
export type FindMySpot = z.infer<typeof FindMySpot>;

/** Find My's place words and street as a read gives them (`HostFindMyPerson.place`, `.address`). */
const PlaceWords = z.string().min(1).max(300);
const Street = z.string().min(1).max(300);

const Stretch = { firstAt: Timestamp, lastAt: Timestamp };

/**
 * One stretch where Whombat's reads of a person said the same, from its first read to its last: a place (its words,
 * street and spot), no location, or a background read that didn't work (`code`: the read's problem, `in_use` when
 * someone used the Mac). Never Find My's “seen …” words or a picture.
 */
export const FindMyStop = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('place'),
    place: PlaceWords,
    address: Street.nullable(),
    spot: FindMySpot.nullable(),
    ...Stretch,
  }),
  z.object({ kind: z.literal('none'), ...Stretch }),
  z.object({ kind: z.literal('unread'), code: HostFindMyCode, ...Stretch }),
]);
export type FindMyStop = z.infer<typeof FindMyStop>;

/** A row as `findMyTimelineDay` takes it: a `FindMyStop` whose times may be a `Date`, ISO text or milliseconds. */
export type FindMyTimelineRow = FindMyStop extends infer S
  ? S extends FindMyStop
    ? Omit<S, 'firstAt' | 'lastAt'> & { firstAt: DateInput; lastAt: DateInput }
    : never
  : never;

/**
 * What makes two reads of a person the same for the timeline: the kind and, for a place, its street when Find My gave
 * one, else its place words, without case or spaces (`findMyPlaceKey`). A read with the same key as the person's last
 * row, within the tolerance, extends that row; the day's stays with the same key join up across gaps.
 */
export function findMyStopKey(row: {
  kind: FindMyStopKind;
  place?: string | null;
  address?: string | null;
}): string {
  if (row.kind !== 'place') return row.kind;
  return row.address ? `street:${findMyPlaceKey(row.address)}` : `place:${findMyPlaceKey(row.place ?? '')}`;
}

/* A day of segments ------------------------------------------------------------------------------ */

/**
 * Why a stretch has no place: `no_location` (Find My had none), `not_read` (Whombat didn't read: the box was off or
 * reads were further apart than the tolerance), or the problem code of a background read that didn't work.
 */
export const FIND_MY_TIMELINE_WHYS = ['no_location', 'not_read'] as const;
export const FindMyTimelineWhy = z.union([z.enum(FIND_MY_TIMELINE_WHYS), HostFindMyCode]);
export type FindMyTimelineWhy = z.infer<typeof FindMyTimelineWhy>;

/** A stretch inside one stay where Whombat had no place for the person, and why (“No location 02:10–06:30”). */
export const FindMyTimelineHole = z.object({ from: Timestamp, to: Timestamp, why: FindMyTimelineWhy });
export type FindMyTimelineHole = z.infer<typeof FindMyTimelineHole>;

/**
 * A stop: Find My's place words, the street and the geocoder's spot (null: none) of the stretch's last read. `ongoing`
 * on today's last stay while it is still going: it runs to now. `holes` are the stretches inside it without a place.
 */
export const FindMyTimelineStay = z.object({
  kind: z.literal('stay'),
  from: Timestamp,
  to: Timestamp,
  place: PlaceWords,
  address: Street.nullable(),
  spot: FindMySpot.nullable(),
  ongoing: z.boolean(),
  holes: z.array(FindMyTimelineHole).max(FIND_MY_TIMELINE_SEGMENTS_MAX),
});
export type FindMyTimelineStay = z.infer<typeof FindMyTimelineStay>;

/** On the way: between two different stops read within the tolerance of each other. */
export const FindMyTimelineTrip = z.object({ kind: z.literal('trip'), from: Timestamp, to: Timestamp });
export type FindMyTimelineTrip = z.infer<typeof FindMyTimelineTrip>;

/** A stretch without a place between stops, and why. */
export const FindMyTimelineGap = z.object({
  kind: z.literal('gap'),
  from: Timestamp,
  to: Timestamp,
  why: FindMyTimelineWhy,
});
export type FindMyTimelineGap = z.infer<typeof FindMyTimelineGap>;

export const FindMyTimelineSegment = z.discriminatedUnion('kind', [
  FindMyTimelineStay,
  FindMyTimelineTrip,
  FindMyTimelineGap,
]);
export type FindMyTimelineSegment = z.infer<typeof FindMyTimelineSegment>;

/* What the apps ask ------------------------------------------------------------------------------ */

function knownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone (`Europe/Amsterdam`): the viewer's, whose days the timeline is cut into. */
export const FindMyTimeZone = z.string().min(1).max(64).refine(knownTimeZone, 'Not a time zone.');

/**
 * `connections.findMyTimeline`'s query: the last day asked (`YYYY-MM-DD`), the viewer's time zone, and how many days
 * up to it (1, or 7 for the week).
 */
export const FindMyTimelineQuery = z.object({
  date: IsoDate,
  tz: FindMyTimeZone,
  days: z.coerce.number().int().min(1).max(FIND_MY_TIMELINE_SPAN_MAX).default(1),
});
export type FindMyTimelineQuery = z.infer<typeof FindMyTimelineQuery>;

/**
 * Someone on the Mac's last read or kept on the timeline: Find My's stable id and name, whether the timeline keeps
 * them and since when, and what the last read said of them now (memory only, never kept; null: the last read didn't
 * have them, or there is none since the box started). Find My's `when` words are in the Mac's language (“5 min ago”).
 */
export const FindMyTimelinePerson = z.object({
  id: FindMyPersonId,
  name: z.string().min(1).max(200),
  kept: z.boolean(),
  keptSince: Timestamp.nullable(),
  now: z
    .object({
      place: z.string().max(300).nullable(),
      when: z.string().max(100).nullable(),
      nearby: z.boolean(),
    })
    .nullable(),
});
export type FindMyTimelinePerson = z.infer<typeof FindMyTimelinePerson>;

/** One kept person's day: its segments in order, cut at the day's bounds (today's end at now). */
export const FindMyTimelinePersonDay = z.object({
  person: FindMyPersonId,
  segments: z.array(FindMyTimelineSegment).max(FIND_MY_TIMELINE_SEGMENTS_MAX),
});
export type FindMyTimelinePersonDay = z.infer<typeof FindMyTimelinePersonDay>;

/** One day in the viewer's time zone: its date, its bounds (23 or 25 hours on a clock change), each kept person's. */
export const FindMyTimelineDay = z.object({
  date: IsoDate,
  from: Timestamp,
  to: Timestamp,
  people: z.array(FindMyTimelinePersonDay).max(HOST_FIND_MY_PEOPLE_MAX),
});
export type FindMyTimelineDay = z.infer<typeof FindMyTimelineDay>;

/**
 * `connections.findMyTimeline`: the days asked, oldest first, ending on `date`; everyone on the Mac's last read and
 * everyone kept (kept or not, kept since); how often the connection reads (minutes; null: only while someone looks);
 * when it last read (null: not since the box started); whether the assistant can read it (`findmy_timeline` Allowed).
 */
export const FindMyTimeline = z.object({
  connectionId: ConnectionId,
  days: z.array(FindMyTimelineDay).min(1).max(FIND_MY_TIMELINE_SPAN_MAX),
  people: z.array(FindMyTimelinePerson).max(2 * HOST_FIND_MY_PEOPLE_MAX),
  paceMinutes: z.number().int().positive().nullable(),
  readAt: Timestamp.nullable(),
  assistantReads: z.boolean(),
});
export type FindMyTimeline = z.infer<typeof FindMyTimeline>;

/** `connections.findMyTimelineSet`'s body: whose days to keep. Empty stops the timeline and deletes everything. */
export const FindMyTimelineSetBody = z.strictObject({
  people: z
    .array(FindMyPersonId)
    .max(HOST_FIND_MY_PEOPLE_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'Each person once.'),
});
export type FindMyTimelineSetBody = z.infer<typeof FindMyTimelineSetBody>;

/** `connections.findMyTimelineDelete`'s body: nothing to say (every day kept so far goes; whose stays). */
export const FindMyTimelineDeleteBody = z.strictObject({});
export type FindMyTimelineDeleteBody = z.infer<typeof FindMyTimelineDeleteBody>;

/**
 * What `connections.findMyTimelineSet` and `connections.findMyTimelineDelete` answer: the signed event (null: nothing
 * changed) and everyone as `connections.findMyTimeline` lists them now.
 */
export const FindMyTimelineChanged = z.object({
  ok: z.literal(true),
  eventId: EventId.nullable(),
  people: z.array(FindMyTimelinePerson).max(2 * HOST_FIND_MY_PEOPLE_MAX),
});
export type FindMyTimelineChanged = z.infer<typeof FindMyTimelineChanged>;

/**
 * `connections.findMyTimelineMap`'s query: whose day, which day in which time zone, and the picture's size in points
 * and theme, as `hosts.findMyMap`'s.
 */
export const FindMyTimelineMapQuery = HostFindMyMapQuery.pick({ w: true, h: true, dark: true }).extend({
  person: FindMyPersonId,
  date: IsoDate,
  tz: FindMyTimeZone,
});
export type FindMyTimelineMapQuery = z.infer<typeof FindMyTimelineMapQuery>;

/**
 * `connections.findMyTimelineMap`: the Mac's map picture (`w` × `h` pixels) around one person's stops of one day, each
 * pin's point on it in the asked points with the stops it stands for (numbered from 1 among the day's stays:
 * `findMyTimelinePins`; pins outside the picture are left out), and the region drawn (centre, shorter side in metres).
 */
export const FindMyTimelineMap = z.object({
  connectionId: ConnectionId,
  person: FindMyPersonId,
  date: IsoDate,
  imageB64: z.string().max(HOST_SCREEN_IMAGE_MAX),
  format: z.enum(['png', 'jpeg']),
  w: z.number().int().nonnegative(),
  h: z.number().int().nonnegative(),
  points: z
    .array(
      z.object({
        stops: z.array(z.number().int().positive()).min(1).max(FIND_MY_TIMELINE_SEGMENTS_MAX),
        x: z.number(),
        y: z.number(),
      }),
    )
    .max(FIND_MY_TIMELINE_PINS_MAX),
  lat: z.number(),
  lon: z.number(),
  spanM: z.number(),
});
export type FindMyTimelineMap = z.infer<typeof FindMyTimelineMap>;

/* The assistant's tool ---------------------------------------------------------------------------- */

/** `findmy_timeline`'s input: everyone kept, or one person by name or first name; today, or another day. */
export const FindMyTimelineArgs = z.strictObject({
  person: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('A name or first name (Mara); leave out for everyone kept'),
  date: IsoDate.optional().describe('The day as YYYY-MM-DD; leave out for today'),
});
export type FindMyTimelineArgs = z.infer<typeof FindMyTimelineArgs>;

/* Days and their bounds --------------------------------------------------------------------------- */

const SECOND_MS = 1000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function parseDate(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [y, m, d] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [Number.NaN, 0, 0];
  const at = new Date(Date.UTC(y, m - 1, d));
  if (!match || at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d)
    throw new RangeError(`Not a date: ${date}`);
  return { y, m, d };
}

/** The date `days` days after `date` (before, when negative), both `YYYY-MM-DD`. */
export function findMyDateAdd(date: string, days: number): string {
  const { y, m, d } = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The `days` dates ending on `date`, oldest first: what `connections.findMyTimeline` answers. */
export function findMyTimelineDates(date: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => findMyDateAdd(date, i - days + 1));
}

/** The zone's offset at an instant (ms; local = UTC + offset). */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / SECOND_MS) * SECOND_MS
  );
}

function dateNumber(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return p.year * 10_000 + p.month * 100 + p.day;
}

/** The first instant of a local day: its midnight, the first one when the clock repeats it, the jump when it skips it. */
function startOfDay(date: string, tz: string): number {
  const { y, m, d } = parseDate(date);
  const wall = Date.UTC(y, m - 1, d);
  const midnights = [wall - DAY_MS, wall, wall + DAY_MS]
    .map((probe) => wall - offsetAt(probe, tz))
    .filter((t) => {
      const p = zonedParts(t, tz);
      return p.year === y && p.month === m && p.day === d && p.hour === 0 && p.minute === 0 && p.second === 0;
    });
  if (midnights.length > 0) return Math.min(...midnights);
  // The clock jumped over midnight: the day starts at the jump, the first second whose local date is the day's.
  const want = y * 10_000 + m * 100 + d;
  let before = wall - 15 * HOUR_MS;
  let after = wall + 15 * HOUR_MS;
  while (after - before > SECOND_MS) {
    const mid = before + Math.floor((after - before) / (2 * SECOND_MS)) * SECOND_MS;
    if (dateNumber(mid, tz) >= want) after = mid;
    else before = mid;
  }
  return after;
}

/**
 * The start and end of a local day (`YYYY-MM-DD`) in an IANA time zone, as instants: 24 hours apart, 23 or 25 on a day
 * the clock changes. Throws a `RangeError` for a date or zone it doesn't know.
 */
export function findMyDayBounds(date: string, tz: string): { from: string; to: string } {
  return {
    from: new Date(startOfDay(date, tz)).toISOString(),
    to: new Date(startOfDay(findMyDateAdd(date, 1), tz)).toISOString(),
  };
}

/* From rows to a day ------------------------------------------------------------------------------ */

type Why = FindMyTimelineWhy;

type Piece =
  | {
      kind: 'stay';
      from: number;
      to: number;
      key: string;
      place: string;
      address: string | null;
      spot: FindMySpot | null;
      ongoing: boolean;
      holes: { from: number; to: number; why: Why }[];
    }
  | { kind: 'trip'; from: number; to: number }
  | { kind: 'gap'; from: number; to: number; why: Why };

const ms = (input: DateInput) => toDate(input).getTime();
const iso = (t: number) => new Date(t).toISOString();

function pieceOf(row: FindMyTimelineRow, from: number, to: number): Piece {
  if (row.kind === 'place')
    return {
      kind: 'stay',
      from,
      to,
      key: findMyStopKey(row),
      place: row.place,
      address: row.address,
      spot: row.spot,
      ongoing: false,
      holes: [],
    };
  return { kind: 'gap', from, to, why: row.kind === 'none' ? 'no_location' : row.code };
}

/**
 * One person's day as segments, from their rows (`rows`: the ones that touch the day, with the last one before it and
 * the first one after it when there are, so the time across midnight is known), cut at the day's bounds (`from`, `to`:
 * `findMyDayBounds`) and at `now`:
 *
 * - each `place` row is a `stay`, each `none` row a `no_location` gap and each `unread` row a gap with its code;
 * - between two rows read within `toleranceMs` of each other (`findMyTimelineTolerance`): a `trip` between two
 *   different places, otherwise the row without a place takes the time between; further apart, a `not_read` gap;
 * - two stays with the same key (`findMyStopKey`) with only gaps between them are one stay with those gaps as holes;
 * - the last stay, while its last read is within the tolerance of now, runs to now, `ongoing` on today;
 * - after the last row, time longer than the tolerance up to now is `not_read`; before the first row there is nothing.
 */
export function findMyTimelineDay(
  rows: readonly FindMyTimelineRow[],
  opts: { from: DateInput; to: DateInput; now: DateInput; toleranceMs: number },
): FindMyTimelineSegment[] {
  const dayFrom = ms(opts.from);
  const dayTo = ms(opts.to);
  const now = ms(opts.now);
  const tolerance = opts.toleranceMs;
  const end = Math.min(dayTo, now);
  if (end <= dayFrom) return [];

  const sorted = rows
    .map((row) => ({ row, first: ms(row.firstAt), last: ms(row.lastAt) }))
    .sort((a, b) => a.first - b.first || a.last - b.last);

  // Rows into pieces, with the time between two rows given to one of them, to a trip or to a not-read gap.
  const pieces: Piece[] = [];
  let prevEnd = Number.NEGATIVE_INFINITY;
  let prevRow: FindMyTimelineRow | null = null;
  for (const { row, first: rawFirst, last: rawLast } of sorted) {
    const first = Math.max(rawFirst, prevEnd);
    const last = Math.max(rawLast, first);
    let start = first;
    const before = pieces.at(-1);
    if (prevRow && before) {
      if (first - prevEnd > tolerance)
        pieces.push({ kind: 'gap', from: prevEnd, to: first, why: 'not_read' });
      else if (prevRow.kind === 'place' && row.kind === 'place') {
        if (findMyStopKey(prevRow) === findMyStopKey(row)) start = prevEnd;
        else if (first > prevEnd) pieces.push({ kind: 'trip', from: prevEnd, to: first });
      } else if (prevRow.kind !== 'place') before.to = first;
      else start = prevEnd;
    }
    pieces.push(pieceOf(row, start, last));
    prevEnd = last;
    prevRow = row;
  }

  // After the last row: a place read lately is still going; a pause longer than the tolerance wasn't read.
  const lastPiece = pieces.at(-1);
  if (lastPiece) {
    if (now - prevEnd > tolerance) pieces.push({ kind: 'gap', from: prevEnd, to: now, why: 'not_read' });
    else if (lastPiece.kind === 'stay') {
      lastPiece.to = Math.max(lastPiece.to, now);
      lastPiece.ongoing = true;
    }
  }

  // Stays with the same key and only gaps between them become one, the gaps its holes.
  const joined: Piece[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'stay') {
      let i = joined.length - 1;
      while (i >= 0 && joined[i]?.kind === 'gap') i--;
      const earlier = joined[i];
      if (earlier?.kind === 'stay' && earlier.key === piece.key) {
        const between = joined.splice(i + 1) as Extract<Piece, { kind: 'gap' }>[];
        earlier.holes.push(...between.map((g) => ({ from: g.from, to: g.to, why: g.why })), ...piece.holes);
        earlier.to = Math.max(earlier.to, piece.to);
        earlier.place = piece.place;
        earlier.address = piece.address;
        earlier.spot = piece.spot ?? earlier.spot;
        earlier.ongoing = piece.ongoing;
        continue;
      }
    }
    joined.push(piece);
  }

  // Cut at the day's bounds and now. A stay of one read has no length and stays when it falls in the day.
  const today = dayFrom <= now && now < dayTo;
  const out: FindMyTimelineSegment[] = [];
  for (const piece of joined) {
    const from = Math.max(piece.from, dayFrom);
    const to = Math.min(piece.to, end);
    const kept =
      piece.from === piece.to
        ? piece.kind === 'stay' && piece.from >= dayFrom && piece.from <= end && piece.from < dayTo
        : to > from;
    if (!kept) continue;
    if (piece.kind === 'stay') {
      const holes = piece.holes
        .map((h) => ({ from: Math.max(h.from, from), to: Math.min(h.to, to), why: h.why }))
        .filter((h) => h.to > h.from)
        .map((h) => ({ from: iso(h.from), to: iso(h.to), why: h.why }));
      out.push({
        kind: 'stay',
        from: iso(from),
        to: iso(to),
        place: piece.place,
        address: piece.address,
        spot: piece.spot,
        ongoing: piece.ongoing && today,
        holes,
      });
    } else if (piece.kind === 'trip') out.push({ kind: 'trip', from: iso(from), to: iso(to) });
    else out.push({ kind: 'gap', from: iso(from), to: iso(to), why: piece.why });
  }
  return out;
}

/** A pin on a day's map: one distinct spot and the stops at it, numbered from 1 among the day's stays (“2, 4”). */
export interface FindMyTimelinePin {
  spot: FindMySpot;
  stops: number[];
}

/**
 * The pins of a day's map: each distinct spot of the day's stays in the order first visited, with the numbers of the
 * stops there, at most `max` (`FIND_MY_TIMELINE_PINS_MAX`). Stays are numbered from 1 in order, those without a spot
 * included; a stay without a spot has no pin. Spots are the same when their stays' keys are (`findMyStopKey`).
 */
export function findMyTimelinePins(
  segments: readonly FindMyTimelineSegment[],
  max: number = FIND_MY_TIMELINE_PINS_MAX,
): FindMyTimelinePin[] {
  const pins = new Map<string, FindMyTimelinePin>();
  let stop = 0;
  for (const s of segments) {
    if (s.kind !== 'stay') continue;
    stop++;
    if (!s.spot) continue;
    const key = findMyStopKey({ kind: 'place', place: s.place, address: s.address });
    const pin = pins.get(key);
    if (pin) pin.stops.push(stop);
    else if (pins.size < max) pins.set(key, { spot: s.spot, stops: [stop] });
  }
  return [...pins.values()];
}
