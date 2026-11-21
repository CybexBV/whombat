/**
 * Settings → Notifications' words that the web and the phone say alike: when Do not disturb ends, the note after
 * turning it on, and what the quiet hours are and on which days. How each shows Do not disturb's state and takes a
 * custom end stays with its page. Pure.
 */
import {
  type DateInput,
  daysAgo,
  formatClock,
  formatDate,
  formatShortWeekday,
  type QuietHours,
  WEEKDAY_KEYS,
  type Weekday,
} from '@whombat/core';

/** The days' short names, Monday first (`WEEKDAY_KEYS`). */
export const WEEKDAY_LABELS: Record<Weekday, { short: string; long: string }> = {
  mon: { short: 'Mon', long: 'Monday' },
  tue: { short: 'Tue', long: 'Tuesday' },
  wed: { short: 'Wed', long: 'Wednesday' },
  thu: { short: 'Thu', long: 'Thursday' },
  fri: { short: 'Fri', long: 'Friday' },
  sat: { short: 'Sat', long: 'Saturday' },
  sun: { short: 'Sun', long: 'Sunday' },
};

/**
 * When something ends, as people say it in their zone: `14:52` today, `tomorrow at 08:00`, `Fri at 08:00` within the
 * week, `3 Oct at 08:00` after that.
 */
export function endsText(at: DateInput, now: DateInput, timeZone: string): string {
  const clock = formatClock(at, timeZone);
  const days = -daysAgo(at, now, timeZone);
  if (days <= 0) return clock;
  if (days === 1) return `tomorrow at ${clock}`;
  if (days < 7) return `${formatShortWeekday(at, timeZone)} at ${clock}`;
  return `${formatDate(at, timeZone, { now })} at ${clock}`;
}

/** The note after turning Do not disturb on: “Do not disturb until 14:52.” */
export function dndSetText(until: string, now: DateInput, timeZone: string): string {
  return `Do not disturb until ${endsText(until, now, timeZone)}.`;
}

/** `Mon, Tue and Fri`; `Every day`; `Weekdays`; `Weekends`. */
export function daysText(days: readonly Weekday[]): string {
  const set = new Set(days);
  const ordered = WEEKDAY_KEYS.filter((d) => set.has(d));
  if (ordered.length === 7) return 'Every day';
  if (ordered.length === 5 && !set.has('sat') && !set.has('sun')) return 'Weekdays';
  if (ordered.length === 2 && set.has('sat') && set.has('sun')) return 'Weekends';
  const names = ordered.map((d) => WEEKDAY_LABELS[d].short);
  if (names.length <= 1) return names[0] ?? 'No days';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * What the quiet hours are: “Every day, 22:00–08:00 (until the next morning)”, “Weekends, all day”, “Off”. A night that
 * starts on Friday ends on Saturday morning, which the note in brackets says.
 */
export function quietHoursText(schedule: QuietHours): string {
  if (!schedule.enabled || schedule.days.length === 0) return 'Off';
  const days = daysText(schedule.days);
  if (schedule.start === schedule.end) return `${days}, all day`;
  const overnight = schedule.start > schedule.end ? ' (until the next morning)' : '';
  return `${days}, ${schedule.start}–${schedule.end}${overnight}`;
}

/** The days in the week's order, `day` switched. */
export function toggleDay(days: readonly Weekday[], day: Weekday): Weekday[] {
  const set = new Set(days);
  if (set.has(day)) set.delete(day);
  else set.add(day);
  return WEEKDAY_KEYS.filter((d) => set.has(d));
}
