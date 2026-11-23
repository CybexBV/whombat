/**
 * A one-time Find My watch (docs/decisions/findmy-watch.md): the person asks in Chat “tell me when Noor leaves where she
 * is now” (or “when she gets home”), and the assistant starts a watch with `findmy_watch`. Whombat reads Find My on the
 * connection's Mac in the background and compares each read itself, with no AI turn; the first read that shows the
 * change posts one message in that thread and ends the watch. A watch nobody saw happen stops after
 * `FIND_MY_WATCH_HOURS` and says so. Pure: the contract, the rule that decides it happened, and its words.
 */
import { z } from 'zod';
import { FindMyWatchId } from '../ids.js';
import { type DateInput, dayKey, formatClock, toDate } from '../text/time.js';
import { Timestamp } from './common.js';
import type { FindMySpot } from './findmy-timeline.js';
import { FIND_MY_PLACE_MAX, findMyPlaceKey, type HostFindMyPerson } from './hosts-findmy.js';

/** How long a watch lasts when nothing happens (hours). */
export const FIND_MY_WATCH_HOURS = 24;
/**
 * How far someone must be from where they were to have left (metres): Find My's spots are the Mac geocoder's guess of
 * a street address, about 100 m, so a smaller jump is the same place.
 */
export const FIND_MY_WATCH_AWAY_M = 250;
/** How often a connection with a watch reads at least (minutes). */
export const FIND_MY_WATCH_EVERY_MIN = 5;
/** Watches a Whombat runs at once. */
export const FIND_MY_WATCHES_MAX = 10;

/** `leaves`: where they are when the watch starts; `arrives`: a place in Find My's words (“Home”, a town). */
export const FIND_MY_WATCH_CHANGES = ['leaves', 'arrives'] as const;
export const FindMyWatchChange = z.enum(FIND_MY_WATCH_CHANGES);
export type FindMyWatchChange = z.infer<typeof FindMyWatchChange>;

/**
 * `watching` until it ends: `happened` (Whombat saw it and told the person), `cancelled` (the person or the assistant),
 * `expired` (nothing happened in `FIND_MY_WATCH_HOURS`), `stopped` (its Find My connection or Mac went).
 */
export const FIND_MY_WATCH_STATUSES = ['watching', 'happened', 'cancelled', 'expired', 'stopped'] as const;
export const FindMyWatchStatus = z.enum(FIND_MY_WATCH_STATUSES);
export type FindMyWatchStatus = z.infer<typeof FindMyWatchStatus>;

/** A watch as the card and the assistant read it: words and times, never a spot. */
export const FindMyWatchView = z.object({
  id: FindMyWatchId,
  /** The person watched, as Find My names them. */
  name: z.string().min(1).max(200),
  change: FindMyWatchChange,
  /** Where: the street they were on (or Find My's words when it gave no street) for `leaves`, the place for `arrives`. */
  place: z.string().min(1).max(300),
  status: FindMyWatchStatus,
  startedAt: Timestamp,
  endsAt: Timestamp,
  endedAt: Timestamp.nullable(),
  /** For `happened`: where Find My had them then (its words), when it said. */
  to: z.string().max(300).nullable(),
});
export type FindMyWatchView = z.infer<typeof FindMyWatchView>;

/**
 * The card on the assistant's message that started a watch: what it watches, until when, and Cancel while it watches;
 * one line once it ended. Server-made (`findmy_watch`), resolved on read for every reader alike.
 */
export const FindMyWatchCard = z.object({
  kind: z.literal('findmy_watch'),
  watchId: FindMyWatchId,
  watch: FindMyWatchView.nullable().default(null),
});
export type FindMyWatchCard = z.infer<typeof FindMyWatchCard>;

/** Storage form: by reference, resolved on read. */
export const StoredFindMyWatchCard = z.object({ kind: z.literal('findmy_watch'), watchId: FindMyWatchId });
export type StoredFindMyWatchCard = z.infer<typeof StoredFindMyWatchCard>;

/** `connections.findMyWatchCancel`'s body: nothing to say. */
export const FindMyWatchCancelBody = z.strictObject({});
export type FindMyWatchCancelBody = z.infer<typeof FindMyWatchCancelBody>;

/**
 * `findmy_watch`'s input: `start` (the default) a watch of `person` for `change` (`leaves` where they are now, or
 * `arrives` at `place`), `list` the watches running, `cancel` one (`watchId`).
 */
export const FindMyWatchArgs = z.object({
  action: z.enum(['start', 'list', 'cancel']).default('start'),
  person: z.string().trim().min(1).max(200).optional(),
  change: FindMyWatchChange.default('leaves'),
  place: z.string().trim().min(1).max(FIND_MY_PLACE_MAX).optional(),
  watchId: FindMyWatchId.optional(),
});
export type FindMyWatchArgs = z.infer<typeof FindMyWatchArgs>;

/* The rule ------------------------------------------------------------------------------------------------------- */

/** Where someone was when a `leaves` watch started: Find My's words, the street and the geocoder's spot. */
export interface FindMyWatchOrigin {
  place: string | null;
  address: string | null;
  spot: FindMySpot | null;
}

/** Metres between two spots on the earth (haversine). */
export function findMyDistanceM(
  a: Pick<FindMySpot, 'lat' | 'lon'>,
  b: Pick<FindMySpot, 'lat' | 'lon'>,
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const key = (s: string | null | undefined) => (s ? findMyPlaceKey(s) : '');

/**
 * Whether a read shows someone left where a watch found them (pure). Someone Find My has no place for now hasn't left.
 * With a spot then and now: further than `FIND_MY_WATCH_AWAY_M` (or than either spot's accuracy) and, when both reads
 * gave a street, on another street. Without spots: another street, or without streets other place words.
 */
export function findMyWatchLeft(
  origin: FindMyWatchOrigin,
  now: Pick<HostFindMyPerson, 'place' | 'address' | 'location'>,
): boolean {
  if (!key(now.place) && !key(now.address)) return false;
  const otherStreet = Boolean(origin.address && now.address) && key(origin.address) !== key(now.address);
  if (origin.spot && now.location) {
    const far = Math.max(FIND_MY_WATCH_AWAY_M, origin.spot.accuracyM, now.location.accuracyM);
    if (findMyDistanceM(origin.spot, now.location) <= far) return false;
    return origin.address && now.address ? otherStreet : true;
  }
  if (origin.address && now.address) return otherStreet;
  return key(origin.place ?? origin.address) !== key(now.place ?? now.address);
}

/** Whether a read shows someone arrived at a place in Find My's words (pure): Find My names that place for them now. */
export function findMyWatchArrived(place: string, now: Pick<HostFindMyPerson, 'place'>): boolean {
  return key(now.place) !== '' && key(now.place) === key(place);
}

/* Words ---------------------------------------------------------------------------------------------------------- */

/** Find My's own names for places where someone is “at” (Home, Work), else “in” a town; a street is “on”. */
const AT_PLACES: ReadonlySet<string> = new Set(['home', 'work', 'school', 'gym']);

/** “at Home”, “in Lelystad”. */
export function findMyWhere(place: string): string {
  return AT_PLACES.has(findMyPlaceKey(place)) ? `at ${place}` : `in ${place}`;
}

/** “Noor Visser leaves Keizersgracht”, “Noor Visser arrives at Home”. */
function what(watch: Pick<FindMyWatchView, 'name' | 'change' | 'place'>): string {
  return watch.change === 'leaves'
    ? `${watch.name} leaves ${watch.place}`
    : `${watch.name} arrives ${findMyWhere(watch.place)}`;
}

/** The started watch's message, under its card: “I’ll tell you when Noor Visser leaves Keizersgracht.” */
export function findMyWatchStartText(watch: Pick<FindMyWatchView, 'name' | 'change' | 'place'>): string {
  return `I’ll tell you when ${what(watch)}.`;
}

/**
 * What the assistant posts in the thread when a watch ends by itself: it happened (“Noor Visser has left Keizersgracht
 * and is now in Amstelveen.”), nothing happened in a day, or its Find My went. Null when the person or the assistant
 * cancelled it: the card says so.
 */
export function findMyWatchEndText(
  watch: Pick<FindMyWatchView, 'name' | 'change' | 'place' | 'status' | 'to'>,
): string | null {
  const { name, place } = watch;
  switch (watch.status) {
    case 'happened':
      if (watch.change === 'arrives') return `${name} has arrived ${findMyWhere(place)}.`;
      return watch.to && key(watch.to) !== key(place)
        ? `${name} has left ${place} and is now ${findMyWhere(watch.to)}.`
        : `${name} has left ${place}.`;
    case 'expired':
      return watch.change === 'leaves'
        ? `${name} is still at ${place} after ${FIND_MY_WATCH_HOURS} hours, so I’ve stopped watching.`
        : `${name} didn’t arrive ${findMyWhere(place)} within ${FIND_MY_WATCH_HOURS} hours, so I’ve stopped watching.`;
    case 'stopped':
      return `I’ve stopped watching ${name} because Find My isn’t connected any more.`;
    default:
      return null;
  }
}

/** The card's words: a title, a muted line, and whether Cancel shows. */
export interface FindMyWatchCardLines {
  title: string;
  detail: string | null;
  canCancel: boolean;
}

/** “14:05”, or “tomorrow at 14:05” when it isn't today where the person is. */
function when(at: DateInput, timeZone: string, now: DateInput): string {
  const clock = formatClock(at, timeZone);
  if (dayKey(at, timeZone) === dayKey(now, timeZone)) return clock;
  const tomorrow = new Date(toDate(now).getTime() + 86_400_000);
  return dayKey(at, timeZone) === dayKey(tomorrow, timeZone) ? `tomorrow at ${clock}` : clock;
}

/**
 * The card as people read it (web and phone alike): while it watches, “Watching for Noor Visser to leave
 * Keizersgracht” and “Until tomorrow at 14:05” with Cancel; once ended, one line and no detail.
 */
export function findMyWatchCardLines(
  watch: FindMyWatchView,
  timeZone: string,
  now: DateInput = new Date(),
): FindMyWatchCardLines {
  const { name, place } = watch;
  const ended = watch.endedAt ?? now;
  switch (watch.status) {
    case 'watching':
      return {
        title:
          watch.change === 'leaves'
            ? `Watching for ${name} to leave ${place}`
            : `Watching for ${name} to arrive ${findMyWhere(place)}`,
        detail: `Until ${when(watch.endsAt, timeZone, now)}`,
        canCancel: true,
      };
    case 'happened':
      return {
        title:
          watch.change === 'leaves'
            ? `${name} left ${place} · ${formatClock(ended, timeZone)}`
            : `${name} arrived ${findMyWhere(place)} · ${formatClock(ended, timeZone)}`,
        detail: null,
        canCancel: false,
      };
    case 'cancelled':
      return { title: `Stopped watching ${name}`, detail: null, canCancel: false };
    case 'expired':
      return {
        title: `Stopped watching ${name} after ${FIND_MY_WATCH_HOURS} hours`,
        detail: null,
        canCancel: false,
      };
    case 'stopped':
      return { title: `Stopped watching ${name}: Find My isn’t connected`, detail: null, canCancel: false };
  }
}

/** The card as text (inbox, search, other windows): “[watch: Noor Visser leaves Keizersgracht; watching]”. */
export function findMyWatchCardText(card: Pick<FindMyWatchCard, 'watch'>): string {
  return card.watch ? `[watch: ${what(card.watch)}; ${card.watch.status}]` : '[watch]';
}
