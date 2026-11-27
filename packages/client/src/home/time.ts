/**
 * The one-Whombat shell's times (app docs/decisions/one-whombat-shell.md AP-1264): how long a Needs you item has waited
 * (`3 days ago`, or the clock today), when a change was made (`10:12`, `Fri`), what an automation did today (`ran 08:00`,
 * `runs 22:00`), and the moments the buttons pick (“Remind me tomorrow” at 09:00, “Tonight at 03:00”). Pure; web and
 * phone share it.
 */
import type { AutomationToday } from '@whombat/core';
import { zonedInstant } from '@whombat/core';
import { formatLocaleOf } from '@whombat/core/i18n';
import {
  daysAgo,
  formatAgo,
  formatClock,
  formatDate,
  formatShortWeekday,
  toDate,
  zonedParts,
} from '@whombat/core/text';
import { clientTranslator } from '../i18n/catalog';

function locShortWeekday(at: string | Date | number, timeZone: string, locale?: string | null): string {
  if (!locale) return formatShortWeekday(at, timeZone);
  return new Intl.DateTimeFormat(formatLocaleOf(locale), { weekday: 'short', timeZone })
    .format(toDate(at))
    .replace(/\.$/, '');
}

function locDate(
  at: string | Date | number,
  timeZone: string,
  now: Date | number,
  locale?: string | null,
): string {
  if (!locale) return formatDate(at, timeZone, { now: toDate(now) });
  const d = toDate(at);
  const sameYear = zonedParts(d, timeZone).year === zonedParts(now, timeZone).year;
  return new Intl.DateTimeFormat(formatLocaleOf(locale), {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone,
  })
    .format(d)
    .replace(/\.$/, '');
}

/** A Needs you item's corner: the clock when it came today, else how long it has waited (`1 day ago`, `3 days ago`). */
export function needsYouWhen(
  at: string,
  now: Date | number,
  timeZone: string,
  locale?: string | null,
): string {
  const days = daysAgo(at, now, timeZone);
  if (days <= 0) return formatClock(at, timeZone);
  return clientTranslator(locale).tp('home.time.daysAgo', days);
}

/** When a change was made (Done recently): the clock today, the weekday this week, else the date. */
export function doneWhen(at: string, now: Date | number, timeZone: string, locale?: string | null): string {
  const days = daysAgo(at, now, timeZone);
  if (days <= 0) return formatClock(at, timeZone);
  if (days < 7) return locShortWeekday(at, timeZone, locale);
  return locDate(at, timeZone, now, locale);
}

/** An automation's line on Home: `ran 08:00`, `failed 07:10`, `runs 22:00`. */
export function automationWhen(
  item: Pick<AutomationToday, 'state' | 'at'>,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = clientTranslator(locale);
  const clock = formatClock(item.at, timeZone);
  switch (item.state) {
    case 'ran':
      return tr.t('home.time.ran', { clock });
    case 'failed':
      return tr.t('home.time.failed', { clock });
    case 'scheduled':
      return tr.t('home.time.runs', { clock });
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
export function untilText(
  until: string,
  now: Date | number,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = clientTranslator(locale);
  const ahead = -daysAgo(until, now, timeZone);
  const clock = formatClock(until, timeZone);
  if (ahead <= 0) return tr.t('home.time.untilClock', { clock });
  if (ahead === 1) return tr.t('home.time.untilTomorrow', { clock });
  if (ahead < 7)
    return tr.t('home.time.untilDayClock', { day: locShortWeekday(until, timeZone, locale), clock });
  return tr.t('home.time.untilDate', { date: locDate(until, timeZone, now, locale) });
}

/** When something comes back, as said in a sentence: `at 18:00`, `tomorrow at 09:00`, `on Fri at 09:00`, `on 3 Oct`. */
export function atText(at: string, now: Date | number, timeZone: string, locale?: string | null): string {
  const tr = clientTranslator(locale);
  const ahead = -daysAgo(at, now, timeZone);
  const clock = formatClock(at, timeZone);
  if (ahead <= 0) return tr.t('home.time.atClock', { clock });
  if (ahead === 1) return tr.t('home.time.tomorrowAt', { clock });
  if (ahead < 7) return tr.t('home.time.onDayAt', { day: locShortWeekday(at, timeZone, locale), clock });
  return tr.t('home.time.onDate', { date: locDate(at, timeZone, now, locale) });
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
  locale?: string | null,
): { text: string; exact: string; known: boolean } {
  const tr = clientTranslator(locale);
  const t = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(t)) {
    const unknown = tr.t('home.time.readingUnknown');
    return { text: unknown, exact: unknown, known: false };
  }
  const ago = locale ? localizedAgo(t, now, timeZone, locale) : formatAgo(t, now, timeZone);
  return {
    text: tr.t('home.time.readAgo', { ago }),
    exact: tr.t('home.time.readAt', { moment: readingsMoment(t, timeZone, locale) }),
    known: true,
  };
}

function localizedAgo(t: number, now: Date | number, timeZone: string, locale: string): string {
  const tr = clientTranslator(locale);
  const sec = Math.max(0, Math.round((toDate(now).getTime() - t) / 1000));
  if (sec < 60) return tr.t('managed.ago.justNow');
  if (sec < 3600) return tr.t('hosts.ago.min', { n: Math.floor(sec / 60) });
  if (sec < 86_400) return tr.t('hosts.ago.h', { n: Math.floor(sec / 3600) });
  return locDate(t, timeZone, now, locale);
}

/** A saved reading's moment, the day always said: “14:00 on 23 Sept”. */
export function readingsMoment(at: Date | number | string, timeZone: string, locale?: string | null): string {
  const day = new Intl.DateTimeFormat(formatLocaleOf(locale), { day: 'numeric', month: 'short', timeZone })
    .format(toDate(at))
    .replace(/\.$/, '');
  return clientTranslator(locale).t('home.time.clockOnDay', { clock: formatClock(at, timeZone), day });
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
