/**
 * Local times for Home's buttons (one-whombat.md ONE-10): “Tonight at 03:00” (the next 03:00 in the burrow's zone) and
 * “Remind me tomorrow” (tomorrow at 09:00). Pure, on core's zone helpers.
 */
import { instantsForLocal, localParts, offsetAt } from '@whombat/core';

const DAY_MS = 86_400_000;

/** When “Remind me tomorrow” and “Not now” bring an item back: tomorrow at this local time (QN-12). */
export const SNOOZE_HOUR = 9;

/** The instant of a local wall-clock time on the local day `dayOffset` days after `now`'s; a DST gap moves it an hour. */
function localAt(now: Date, timeZone: string, dayOffset: number, hour: number, minute: number): Date {
  const today = localParts(now.getTime(), timeZone);
  // Noon of the wanted local day, so the day arithmetic never crosses a DST edge.
  const noon = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset, 12));
  const local = {
    year: noon.getUTCFullYear(),
    month: noon.getUTCMonth() + 1,
    day: noon.getUTCDate(),
    hour,
    minute,
  };
  const found = instantsForLocal(local, timeZone);
  if (found[0] !== undefined) return new Date(found[0]);
  return new Date((instantsForLocal({ ...local, hour: hour + 1 }, timeZone)[0] ?? noon.getTime()) as number);
}

/** The next time it is `hour:minute` in the zone, strictly after `now` (“Tonight at 03:00”). */
export function nextLocalTime(now: Date, timeZone: string, hour: number, minute = 0): Date {
  const today = localAt(now, timeZone, 0, hour, minute);
  return today.getTime() > now.getTime() ? today : localAt(now, timeZone, 1, hour, minute);
}

/** Tomorrow at `hour:minute` in the zone (“Remind me tomorrow”). */
export function tomorrowAt(now: Date, timeZone: string, hour = 9, minute = 0): Date {
  return localAt(now, timeZone, 1, hour, minute);
}

/** The start of `now`'s local day in the zone. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const p = localParts(now.getTime(), timeZone);
  const found = instantsForLocal({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, timeZone);
  if (found[0] !== undefined) return new Date(found[0]);
  // A clock change skipped midnight (Chile, Paraguay, Cuba spring forward at 00:00): the day starts where the gap ends,
  // which is midnight read with the offset from before it.
  const midnight = Date.UTC(p.year, p.month - 1, p.day);
  return new Date(midnight - offsetAt(midnight - DAY_MS, timeZone));
}

/** “03:00”: a time as the button says it. */
export function hhmm(hour: number, minute = 0): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
