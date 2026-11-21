/**
 * The one-Whombat shell's times (app docs/decisions/one-whombat-shell.md AP-1264): how long a Needs you item has waited
 * (`3 days ago`, or the clock today), when a change was made (`10:12`, `Fri`), what an automation did today (`ran 08:00`,
 * `runs 22:00`), and the moments the buttons pick (“Remind me tomorrow” at 09:00, “Tonight at 03:00”). Pure; web and
 * phone share it.
 */
import type { AutomationToday } from '@whombat/core';
import { zonedInstant } from '@whombat/core';
import {
  daysAgo,
  formatAgo,
  formatClock,
  formatDate,
  formatShortWeekday,
  toDate,
  zonedParts,
} from '@whombat/core/text';

/** A Needs you item's corner: the clock when it came today, else how long it has waited (`1 day ago`, `3 days ago`). */
export function needsYouWhen(at: string, now: Date | number, timeZone: string): string {
  const days = daysAgo(at, now, timeZone);
  if (days <= 0) return formatClock(at, timeZone);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** When a change was made (Done recently): the clock today, the weekday this week, else the date. */
export function doneWhen(at: string, now: Date | number, timeZone: string): string {
  const days = daysAgo(at, now, timeZone);
  if (days <= 0) return formatClock(at, timeZone);
  if (days < 7) return formatShortWeekday(at, timeZone);
  return formatDate(at, timeZone, { now: toDate(now) });
}

/** An automation's line on Home: `ran 08:00`, `failed 07:10`, `runs 22:00`. */
export function automationWhen(item: Pick<AutomationToday, 'state' | 'at'>, timeZone: string): string {
  const clock = formatClock(item.at, timeZone);
  switch (item.state) {
    case 'ran':
      return `ran ${clock}`;
    case 'failed':
      return `failed ${clock}`;
    case 'scheduled':
      return `runs ${clock}`;
  }
}

/** The instant of `hh:mm` local on the day `addDays` after today's (in `timeZone`), as ISO. */
export function localAt(now: Date | number, timeZone: string, time: string, addDays = 0): string {
  const today = zonedParts(now, timeZone);
  // Noon of the day, moved by whole days: the calendar day there, whatever the DST change in between.
  const noon = Date.UTC(today.year, today.month - 1, today.day + addDays, 12);
  const day = zonedParts(new Date(noon), 'UTC');
  return zonedInstant({ year: day.year, month: day.month, day: day.day }, time, timeZone).toISOString();
}

/** “Remind me tomorrow”, “Not now” without a time: tomorrow at 09:00 local (contracts `NeedsYouAction.at`, CT-336). */
export function tomorrowMorning(now: Date | number, timeZone: string): string {
  return localAt(now, timeZone, '09:00', 1);
}

/** The next 03:00 local after `now` (“Tonight at 03:00”): today's when still ahead, else tomorrow's. */
export function nextAt(now: Date | number, timeZone: string, time: string): string {
  const today = localAt(now, timeZone, time, 0);
  return Date.parse(today) > toDate(now).getTime() ? today : localAt(now, timeZone, time, 1);
}

/** `until tomorrow 09:00`, `until 18:00`, `until Fri 09:00`: when something snoozed comes back. */
export function untilText(until: string, now: Date | number, timeZone: string): string {
  const ahead = -daysAgo(until, now, timeZone);
  const clock = formatClock(until, timeZone);
  if (ahead <= 0) return `until ${clock}`;
  if (ahead === 1) return `until tomorrow ${clock}`;
  if (ahead < 7) return `until ${formatShortWeekday(until, timeZone)} ${clock}`;
  return `until ${formatDate(until, timeZone, { now: toDate(now) })}`;
}

/** When something comes back, as said in a sentence: `at 18:00`, `tomorrow at 09:00`, `on Fri at 09:00`, `on 3 Oct`. */
export function atText(at: string, now: Date | number, timeZone: string): string {
  const ahead = -daysAgo(at, now, timeZone);
  const clock = formatClock(at, timeZone);
  if (ahead <= 0) return `at ${clock}`;
  if (ahead === 1) return `tomorrow at ${clock}`;
  if (ahead < 7) return `on ${formatShortWeekday(at, timeZone)} at ${clock}`;
  return `on ${formatDate(at, timeZone, { now: toDate(now) })}`;
}

/**
 * When a server's readings were taken, from its own report (`lastSeen`), never the fleet's or the fetch's time: “Read
 * 12 min ago”, “Read just now”, or “Reading time unknown” without one. `exact` is the moment in full for a screen
 * reader or a tooltip (“Read at 13:53 on 23 Sept”).
 */
export function readingTime(
  at: string | null | undefined,
  now: Date | number,
  timeZone: string,
): { text: string; exact: string; known: boolean } {
  const t = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(t))
    return { text: 'Reading time unknown', exact: 'Reading time unknown', known: false };
  return {
    text: `Read ${formatAgo(t, now, timeZone)}`,
    exact: `Read at ${readingsMoment(t, timeZone)}`,
    known: true,
  };
}

/** A saved reading's moment, the day always said: “14:00 on 23 Sept”. */
export function readingsMoment(at: Date | number | string, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(
    toDate(at),
  );
  return `${formatClock(at, timeZone)} on ${day}`;
}

/**
 * What a page shows while it reads (`loading`, nothing yet), after its first read failed (`failed`, nothing saved), once
 * it has readings (`ready`), while it reads them again (`refreshing`, the readings stay), and after a refresh failed
 * (`saved`, the readings stay with their own time). Kept apart so “Refreshing” never reads as a failure.
 */
export type ReadState = 'loading' | 'failed' | 'ready' | 'refreshing' | 'saved';

export function readState(q: { hasData: boolean; error: unknown; fetching?: boolean }): ReadState {
  if (!q.hasData) return q.error ? 'failed' : 'loading';
  if (q.error) return 'saved';
  return q.fetching ? 'refreshing' : 'ready';
}
