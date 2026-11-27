/**
 * The page looked at last in each place (servers-connections-places.md), kept in this browser: opening Servers
 * or Connections on a wide window shows it again when it is still listed.
 */
import type { ThingPlace } from '@whombat/client';

/** One per Whombat: another Whombat's server of the same name was never looked at here. */
export const LAST_VIEWED_KEY = (burrow: string, place: ThingPlace) => `whombat.place.${burrow}.${place}`;

export function readLastViewed(burrow: string, place: ThingPlace): string | null {
  try {
    return localStorage.getItem(LAST_VIEWED_KEY(burrow, place));
  } catch {
    return null;
  }
}

export function keepLastViewed(burrow: string, place: ThingPlace, thingId: string): void {
  try {
    localStorage.setItem(LAST_VIEWED_KEY(burrow, place), thingId);
  } catch {
    // Private mode or full storage: the place opens on its first row instead, nothing worse.
  }
}
