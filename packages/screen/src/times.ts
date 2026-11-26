/**
 * Pages by time of day (Whombat desk-display.md): a page with `show` is in the screen's turning only
 * inside its window, in the person's time zone; a page without one always is. The pages turned through now are the
 * rotation: the top bar names only these, and the screen goes back to its home — the first page whose window is open
 * now, else the first without a window. Pure, with the clock and the zone passed in.
 */
import type { DeskPageShow, Weekday } from './types';

/** The week, Monday first (the contract's `WEEKDAY_KEYS`). */
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const SHORT_DAYS: Readonly<Record<string, Weekday>> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

const formats = new Map<string, Intl.DateTimeFormat>();
function dayAndTime(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let f = formats.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    };
    try {
      f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone });
    } catch {
      // An unknown zone keeps the device's own time rather than no pages.
      f = new Intl.DateTimeFormat('en-GB', opts);
    }
    formats.set(key, f);
  }
  return f;
}

/** The day of the week and the minute of the day at `ms`, in `timeZone` (the device's own without one). */
export function zonedMinute(ms: number, timeZone?: string): { day: Weekday; minute: number } {
  const parts = dayAndTime(timeZone).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    day: SHORT_DAYS[get('weekday')] ?? 'mon',
    minute: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/**
 * Whether a page shows at `at` (`zonedMinute`'s): always without a window; inside it otherwise. A window past midnight
 * belongs to the day it starts (`22:00`–`06:00` on Friday runs into Saturday morning); the same time twice is the whole
 * day.
 */
export function pageShowsAt(show: DeskPageShow | undefined, at: { day: Weekday; minute: number }): boolean {
  if (!show) return true;
  const days = show.days ?? WEEKDAYS;
  const from = minutesOf(show.from);
  const to = minutesOf(show.to);
  if (from === to) return days.includes(at.day);
  if (from < to) return days.includes(at.day) && at.minute >= from && at.minute < to;
  const yesterday = WEEKDAYS[(WEEKDAYS.indexOf(at.day) + 6) % 7] as Weekday;
  return (days.includes(at.day) && at.minute >= from) || (days.includes(yesterday) && at.minute < to);
}

/** Whether a page shows at `ms` in `timeZone`. */
export function pageShowing(show: DeskPageShow | undefined, ms: number, timeZone?: string): boolean {
  return !show || pageShowsAt(show, zonedMinute(ms, timeZone));
}

/** The pages a screen turns through now. */
export interface Rotation {
  /** Every page of the layout. */
  count: number;
  /** The pages in the turning (their places in the layout, in its order); never empty. */
  pages: readonly number[];
  /** Where the screen goes back to after a while untouched. */
  home: number;
  /** The pages with a window that is open now. */
  open: readonly { id: string; page: number }[];
}

/** Every page, the first as home: a layout without windows, and the editor. */
export function everyPage(count: number): Rotation {
  const n = Math.max(1, count);
  return { count: n, pages: Array.from({ length: n }, (_, i) => i), home: 0, open: [] };
}

/**
 * The rotation at `ms` in `timeZone`: the pages without a window and those whose window is open, in the layout's
 * order. Home is the first open window's page, else the first page without one; with nothing in it, the first page
 * alone (a screen is never blank).
 */
export function rotationNow(
  pages: readonly { id: string; show?: DeskPageShow | undefined }[],
  ms: number,
  timeZone?: string,
): Rotation {
  if (!pages.some((p) => p.show)) return everyPage(pages.length);
  const at = zonedMinute(ms, timeZone);
  const shown: number[] = [];
  const open: { id: string; page: number }[] = [];
  let always = -1;
  pages.forEach((p, i) => {
    if (!p.show) {
      shown.push(i);
      if (always < 0) always = i;
    } else if (pageShowsAt(p.show, at)) {
      shown.push(i);
      open.push({ id: p.id, page: i });
    }
  });
  if (shown.length === 0) return { count: pages.length, pages: [0], home: 0, open: [] };
  return { count: pages.length, pages: shown, home: open[0]?.page ?? always, open };
}
