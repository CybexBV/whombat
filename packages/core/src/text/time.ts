/**
 * Time and date formatting used on screens. All functions take an explicit IANA time zone (the viewer's,
 * else the burrow's) so server, web and mobile render the same strings. English names are built in, so
 * output does not depend on the runtime locale.
 *
 *   formatClock        11:22
 *   formatDayDivider   Today · Wednesday 23 September
 *   formatLogDay       TODAY · 23 SEP / YESTERDAY · 22 SEP
 *   formatRecent       09:13 / Yesterday / Mon / 3 Mar
 *   formatDuration     12s / 2m 14s / 14m 08s
 *
 * Every formatter that shows words takes an optional `locale` (default English). The internal parser
 * (`zonedParts`) stays pinned to English weekday names so it reads the same on every runtime.
 */
import { type CoreMessageKey, coreTranslator } from '../i18n/catalog.js';
import { formatLocaleNumber } from '../i18n/format.js';
import { formatLocaleOf } from '../i18n/locale.js';

export type DateInput = Date | string | number;

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
export const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
export const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
}

export function toDate(input: DateInput): Date {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date: ${String(input)}`);
  return d;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(input: DateInput, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(toDate(input));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = SHORT_WEEKDAYS.indexOf(get('weekday') as (typeof SHORT_WEEKDAYS)[number]);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: weekday < 0 ? 0 : weekday,
  };
}

function dayNumber(p: Pick<ZonedParts, 'year' | 'month' | 'day'>): number {
  return Math.round(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000);
}

/** Calendar days from `input` to `now` in the zone: 0 = same day, 1 = yesterday. */
export function daysAgo(input: DateInput, now: DateInput, timeZone: string): number {
  return dayNumber(zonedParts(now, timeZone)) - dayNumber(zonedParts(input, timeZone));
}

/** Key for grouping by calendar day in the zone: `2026-09-23`. */
export function dayKey(input: DateInput, timeZone: string): string {
  const p = zonedParts(input, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 24-hour clock: `11:22`. */
export function formatClock(input: DateInput, timeZone: string): string {
  const p = zonedParts(input, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Weekday name for 0 = Sunday in a locale (`Wednesday`, `woensdag`). */
export function weekdayName(weekday: number, locale?: string | null): string {
  return coreTranslator(locale).t(`time.weekday.${weekday}` as CoreMessageKey);
}

/** Short weekday name for 0 = Sunday in a locale (`Wed`, `wo`). */
export function shortWeekdayName(weekday: number, locale?: string | null): string {
  return coreTranslator(locale).t(`time.weekdayShort.${weekday}` as CoreMessageKey);
}

/** Month name for 1–12 in a locale (`September`, `september`). */
export function monthName(month: number, locale?: string | null): string {
  return coreTranslator(locale).t(`time.month.${month}` as CoreMessageKey);
}

/** Short month name for 1–12 in a locale (`Sep`, `mrt`). */
export function shortMonthName(month: number, locale?: string | null): string {
  return coreTranslator(locale).t(`time.monthShort.${month}` as CoreMessageKey);
}

/** `Wed` */
export function formatShortWeekday(input: DateInput, timeZone: string, locale?: string | null): string {
  return shortWeekdayName(zonedParts(input, timeZone).weekday, locale);
}

/** `Wednesday` */
export function formatWeekday(input: DateInput, timeZone: string, locale?: string | null): string {
  return weekdayName(zonedParts(input, timeZone).weekday, locale);
}

export interface DateFormatOptions {
  /** `always` → 3 Mar 2026, `never` → 3 Mar, `auto` → year only when it differs from `now`'s year. */
  year?: 'always' | 'never' | 'auto';
  now?: DateInput;
}

/** `3 Mar`, `3 Mar 2026` (`3 mrt 2026` in Dutch) */
export function formatDate(
  input: DateInput,
  timeZone: string,
  options: DateFormatOptions = {},
  locale?: string | null,
): string {
  const p = zonedParts(input, timeZone);
  const mode = options.year ?? 'auto';
  const showYear =
    mode === 'always' ||
    (mode === 'auto' && (!options.now || zonedParts(options.now, timeZone).year !== p.year));
  return `${p.day} ${shortMonthName(p.month, locale)}${showYear ? ` ${p.year}` : ''}`;
}

/** First letter upper case, in the locale's own rules. */
function capitalize(text: string, locale?: string | null): string {
  if (!text) return text;
  return text.charAt(0).toLocaleUpperCase(formatLocaleOf(locale)) + text.slice(1);
}

/**
 * Day divider in a conversation: `Today · Wednesday 23 September`, `Yesterday · Tuesday 22 September`,
 * otherwise `Monday 21 September` (plus the year when it differs).
 */
export function formatDayDivider(
  input: DateInput,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const p = zonedParts(input, timeZone);
  const n = zonedParts(now, timeZone);
  const date = `${weekdayName(p.weekday, locale)} ${p.day} ${monthName(p.month, locale)}${p.year !== n.year ? ` ${p.year}` : ''}`;
  const diff = dayNumber(n) - dayNumber(p);
  if (diff === 0) return tr.t('time.dividerToday', { date });
  if (diff === 1) return tr.t('time.dividerYesterday', { date });
  return capitalize(date, locale);
}

/** Audit log day header: `TODAY · 23 SEP`, `YESTERDAY · 22 SEP`, `MON · 21 SEP`. */
export function formatLogDay(
  input: DateInput,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const upper = (text: string) => text.toLocaleUpperCase(formatLocaleOf(locale));
  const p = zonedParts(input, timeZone);
  const n = zonedParts(now, timeZone);
  const date = `${p.day} ${upper(shortMonthName(p.month, locale))}${p.year !== n.year ? ` ${p.year}` : ''}`;
  const diff = dayNumber(n) - dayNumber(p);
  if (diff === 0) return tr.t('time.logToday', { date });
  if (diff === 1) return tr.t('time.logYesterday', { date });
  return `${upper(shortWeekdayName(p.weekday, locale))} · ${date}`;
}

/**
 * Compact "when" for lists (agent RECENT, inbox rows, thread links): `just now` under a minute,
 * `09:13` today, `Yesterday`, `Mon` within the week, else `3 Mar` / `3 Mar 2025`.
 */
export function formatRecent(
  input: DateInput,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const d = toDate(input);
  const n = toDate(now);
  const seconds = (n.getTime() - d.getTime()) / 1000;
  if (seconds >= 0 && seconds < 60) return tr.t('time.justNow');
  const diff = daysAgo(d, n, timeZone);
  if (diff <= 0) return formatClock(d, timeZone);
  if (diff === 1) return tr.t('time.yesterday');
  if (diff < 7) return formatShortWeekday(d, timeZone, locale);
  return formatDate(d, timeZone, { now: n }, locale);
}

/** Thread link time: `last 10:06` (the clock today, never "last just now"), then `last Yesterday`, … */
export function formatThreadLast(
  input: DateInput,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const d = toDate(input);
  if (daysAgo(d, toDate(now), timeZone) <= 0)
    return tr.t('time.threadLast', { when: formatClock(d, timeZone) });
  return tr.t('time.threadLast', { when: formatRecent(d, now, timeZone, locale) });
}

/** `12s`, `2m 14s`, `14m 08s`, `1h 04m` (`1u 04m` in Dutch). */
export function formatDuration(ms: number, locale?: string | null): string {
  const tr = coreTranslator(locale);
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return tr.t('time.durationSeconds', { s: total });
  if (total < 3600) return tr.t('time.durationMinutes', { m: Math.floor(total / 60), s: pad2(total % 60) });
  return tr.t('time.durationHours', {
    h: Math.floor(total / 3600),
    m: pad2(Math.floor((total % 3600) / 60)),
  });
}

/** `1.8s` — answer latency (`1,8s` in Dutch). */
export function formatSeconds(ms: number, locale?: string | null): string {
  const tr = coreTranslator(locale);
  const s = formatLocaleNumber(Number((Math.max(0, ms) / 1000).toFixed(1)), tr.locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  });
  return tr.t('time.seconds', { s });
}

/** `just now`, `12 min ago`, `2 hours ago`, `3 days ago`, else a date. Canvas provenance, toasts. */
export function formatAgo(
  input: DateInput,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const d = toDate(input);
  const n = toDate(now);
  const seconds = Math.max(0, (n.getTime() - d.getTime()) / 1000);
  if (seconds < 60) return tr.t('time.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return tr.tp('time.agoMinutes', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr.tp('time.agoHours', hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return tr.tp('time.agoDays', days);
  return formatDate(d, timeZone, { now: n }, locale);
}

/**
 * Repo freshness after "updated": `12 minutes ago`, `2 hours ago` (under 3 hours), `today`, `yesterday`,
 * `Monday` (this week), `last week`, else `3 Mar`.
 */
export function formatUpdated(
  input: DateInput,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const d = toDate(input);
  const n = toDate(now);
  const minutes = Math.max(0, Math.floor((n.getTime() - d.getTime()) / 60_000));
  if (minutes < 1) return tr.t('time.justNow');
  if (minutes < 60) return tr.tp('time.updatedMinutes', minutes);
  const hours = Math.floor(minutes / 60);
  const diff = daysAgo(d, n, timeZone);
  if (hours < 3 && diff === 0) return tr.tp('time.agoHours', hours);
  if (diff <= 0) return tr.t('time.todayLower');
  if (diff === 1) return tr.t('time.yesterdayLower');
  if (diff < 7) return formatWeekday(d, timeZone, locale);
  if (diff < 14) return tr.t('time.lastWeek');
  return formatDate(d, timeZone, { now: n }, locale);
}

/** Plan card due date from `YYYY-MM-DD`: `Due 14 Oct`. */
export function formatDue(isoDate: string, locale?: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new RangeError(`Invalid date: ${isoDate}`);
  return coreTranslator(locale).t('time.due', {
    date: `${Number(m[3])} ${shortMonthName(Number(m[2]), locale)}`,
  });
}
