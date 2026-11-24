/**
 * What Whombat sees of every thing right now, as the incident watcher reads it: Home's things and the servers' cards
 * for the burrow's person, and the looks the desk makes of them (`deskLooks`). The watcher reads it every minute; an
 * automation that waited reads it again at its deadline, to know whether the check it waits on still counts.
 */
import type { ThingSummary } from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { BurrowRow } from '../commit/types';
import { burrows } from '../db/schema/index';
import { type DeskFleet, deskFleet, deskLooks, lookLinesOf } from '../desk/glance';
import type { DeskLook } from '../desk/shapes';
import { thePerson } from '../domain/the-person';
import { type HomeViewer, things } from '../home/overview';
import type { Services } from '../services';

/** Every look counts here, not only the desk's first ones. */
const LOOKS_MAX = 200;

export interface LiveLooks {
  burrow: BurrowRow;
  thingList: ThingSummary[];
  /** Null when the servers couldn't be read, or the burrow has none. */
  fleet: DeskFleet | null;
  /** The servers' cards were read: a server without a look is fine; else unknown. */
  serversRead: boolean;
  looks: DeskLook[];
}

/** One read of what Whombat sees now; null when Home's things couldn't be read (nothing can be said then). */
export async function readLiveLooks(
  services: Services,
  burrowId: string,
  now: Date,
): Promise<LiveLooks | null> {
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  const person = await thePerson(services.db, burrowId);
  if (!burrow || !person) return null;
  const viewer: HomeViewer = { burrow, principal: person };
  const thingList = await things(services, viewer, now).catch(() => null);
  if (!thingList) return null;
  let serversRead = true;
  const fleet = await deskFleet(services, burrowId).catch(() => {
    serversRead = false;
    return null;
  });
  return {
    burrow,
    thingList,
    fleet,
    serversRead,
    looks: deskLooks(fleet?.cards ?? [], thingList, LOOKS_MAX),
  };
}

/**
 * The checks whose lines count on a thing now (watched, not quiet, confirmed): none when it has no look; null when
 * Whombat couldn't read it (a server while the servers weren't read).
 */
export function activeChecks(live: LiveLooks, thing: string): Set<string> | null {
  if (thing.startsWith('server:') && !live.serversRead) return null;
  const look = live.looks.find((l) => l.key === thing);
  if (!look) return new Set();
  return new Set(
    [look.notice?.check, ...lookLinesOf(look).map((l) => l.check)].filter((c): c is string => !!c),
  );
}

/** How a server's or a thing's status reads to someone waiting for it: answering, down, or not known. */
export function observedOf(status: string): 'up' | 'down' | 'unknown' {
  if (status === 'offline') return 'down';
  return status === 'ok' || status === 'warn' ? 'up' : 'unknown';
}

/**
 * The things Whombat sees answering now, by their own state: a server answering, a connection or device answering that
 * isn't kept quiet or down because of something else.
 */
export function seenFine(live: LiveLooks): Set<string> {
  const fine = new Set<string>();
  for (const t of live.thingList)
    if (t.kind !== 'server' && !t.causedBy && !t.quietUntil && observedOf(t.status) === 'up') fine.add(t.id);
  for (const [id, row] of live.fleet?.rows ?? [])
    if (observedOf(row.status) === 'up') fine.add(`server:${id}`);
  return fine;
}
