/**
 * Where this Whombat is, as the server keeps it (docs/decisions/weather-news.md): `burrows.place`, the place the person
 * chose, its latitude and longitude to two decimals; without one, the time zone's guess. Pure.
 */
import { type Place, PlaceInput, placeFromTimeZone } from '@whombat/core';

/** `Burrow.place`: the place the person chose, else the time zone's guess (`guessed`), else null. */
export function placeOfBurrow(burrow: { place: PlaceInput | null; timeZone: string }): Place | null {
  const kept = burrow.place ? PlaceInput.safeParse(burrow.place) : null;
  if (kept?.success) return { ...kept.data, guessed: false };
  return placeFromTimeZone(burrow.timeZone);
}
