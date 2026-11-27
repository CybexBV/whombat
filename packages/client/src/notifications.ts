/**
 * Settings → Notifications' words that the web and the phone say alike: when Do not disturb ends, the note after
 * turning it on, and what the quiet hours are and on which days. How each shows Do not disturb's state and takes a
 * custom end stays with its page. Pure.
 */
import {
  type DateInput,
  daysAgo,
  formatClock,
  type QuietHours,
  toDate,
  WEEKDAY_KEYS,
  type Weekday,
  zonedParts,
} from '@whombat/core';
import { formatLocaleList, formatLocaleOf } from '@whombat/core/i18n';
import { clientTranslator } from './i18n/catalog';

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

export function weekdayLabels(locale?: string | null): Record<Weekday, { short: string; long: string }> {
  const tr = clientTranslator(locale);
  return {
    mon: { short: tr.t('weekday.mon.short'), long: tr.t('weekday.mon.long') },
    tue: { short: tr.t('weekday.tue.short'), long: tr.t('weekday.tue.long') },
    wed: { short: tr.t('weekday.wed.short'), long: tr.t('weekday.wed.long') },
    thu: { short: tr.t('weekday.thu.short'), long: tr.t('weekday.thu.long') },
    fri: { short: tr.t('weekday.fri.short'), long: tr.t('weekday.fri.long') },
    sat: { short: tr.t('weekday.sat.short'), long: tr.t('weekday.sat.long') },
    sun: { short: tr.t('weekday.sun.short'), long: tr.t('weekday.sun.long') },
  };
}

function localizedShortWeekday(at: DateInput, timeZone: string, locale?: string | null): string {
  const raw = new Intl.DateTimeFormat(formatLocaleOf(locale), { weekday: 'short', timeZone }).format(
    toDate(at),
  );
  return raw.replace(/\.$/, '');
}

function localizedDate(at: DateInput, timeZone: string, now: DateInput, locale?: string | null): string {
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

/**
 * When something ends, as people say it in their zone: `14:52` today, `tomorrow at 08:00`, `Fri at 08:00` within the
 * week, `3 Oct at 08:00` after that.
 */
export function endsText(at: DateInput, now: DateInput, timeZone: string, locale?: string | null): string {
  const tr = clientTranslator(locale);
  const clock = formatClock(at, timeZone);
  const days = -daysAgo(at, now, timeZone);
  if (days <= 0) return clock;
  if (days === 1) return tr.t('notifications.tomorrowAt', { clock });
  if (days < 7)
    return tr.t('notifications.dayAt', { day: localizedShortWeekday(at, timeZone, locale), clock });
  return tr.t('notifications.dayAt', { day: localizedDate(at, timeZone, now, locale), clock });
}

/** The note after turning Do not disturb on: “Do not disturb until 14:52.” */
export function dndSetText(until: string, now: DateInput, timeZone: string, locale?: string | null): string {
  return clientTranslator(locale).t('notifications.dndSet', { when: endsText(until, now, timeZone, locale) });
}

/** `Mon, Tue and Fri`; `Every day`; `Weekdays`; `Weekends`. */
export function daysText(days: readonly Weekday[], locale?: string | null): string {
  const tr = clientTranslator(locale);
  const set = new Set(days);
  const ordered = WEEKDAY_KEYS.filter((d) => set.has(d));
  if (ordered.length === 7) return tr.t('notifications.everyDay');
  if (ordered.length === 5 && !set.has('sat') && !set.has('sun')) return tr.t('notifications.weekdays');
  if (ordered.length === 2 && set.has('sat') && set.has('sun')) return tr.t('notifications.weekends');
  const labels = weekdayLabels(locale);
  const names = ordered.map((d) => labels[d].short);
  if (names.length <= 1) return names[0] ?? tr.t('notifications.noDays');
  return formatLocaleList(names, locale, 'conjunction');
}

/**
 * What the quiet hours are: “Every day, 22:00–08:00 (until the next morning)”, “Weekends, all day”, “Off”. A night that
 * starts on Friday ends on Saturday morning, which the note in brackets says.
 */
export function quietHoursText(schedule: QuietHours, locale?: string | null): string {
  const tr = clientTranslator(locale);
  if (!schedule.enabled || schedule.days.length === 0) return tr.t('notifications.off');
  const days = daysText(schedule.days, locale);
  if (schedule.start === schedule.end) return tr.t('notifications.allDay', { days });
  const overnight = schedule.start > schedule.end ? tr.t('notifications.overnight') : '';
  return `${days}, ${schedule.start}–${schedule.end}${overnight}`;
}

/** The days in the week's order, `day` switched. */
export function toggleDay(days: readonly Weekday[], day: Weekday): Weekday[] {
  const set = new Set(days);
  if (set.has(day)) set.delete(day);
  else set.add(day);
  return WEEKDAY_KEYS.filter((d) => set.has(d));
}
