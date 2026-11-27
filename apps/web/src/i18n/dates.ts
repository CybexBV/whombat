/**
 * Day, month and weekday names in the page's language, for dates the web app writes itself. English keeps the exact
 * words it always had (“3 Nov”, “3 November”, “Sunday”); Dutch gets Intl's names without the abbreviation's dot
 * (“3 nov”, “3 november”, “zondag”), so a Dutch sentence never carries an English month.
 */
import { resolveLanguage } from '@whombat/core/i18n';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = [
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
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The Intl locale for a page tag, or null for English (and the pseudo-locale, which keeps English names). */
function intlLocale(tag: string | null | undefined): string | null {
  return tag && resolveLanguage(tag) === 'nl' && tag !== 'pseudo' ? 'nl-NL' : null;
}

function part(
  date: Date,
  locale: string,
  options: Intl.DateTimeFormatOptions,
  type: Intl.DateTimeFormatPartTypes,
) {
  const found = new Intl.DateTimeFormat(locale, options).formatToParts(date).find((p) => p.type === type);
  return (found?.value ?? '').replace(/\.$/, '');
}

/** “Nov” / “nov”: a month's short name. */
export function shortMonthName(month: number, tag?: string | null): string {
  const locale = intlLocale(tag);
  if (!locale) return SHORT_MONTHS[month] ?? '';
  return part(new Date(2000, month, 1), locale, { month: 'short' }, 'month');
}

/** “November” / “november”: a month's full name. */
export function longMonthName(month: number, tag?: string | null): string {
  const locale = intlLocale(tag);
  if (!locale) return LONG_MONTHS[month] ?? '';
  return part(new Date(2000, month, 1), locale, { month: 'long' }, 'month');
}

/** “Sunday” / “zondag”: a weekday's full name (0 is Sunday). */
export function weekdayName(day: number, tag?: string | null): string {
  const locale = intlLocale(tag);
  if (!locale) return WEEKDAYS[day] ?? '';
  // 2 January 2000 was a Sunday.
  return part(new Date(2000, 0, 2 + day), locale, { weekday: 'long' }, 'weekday');
}

/** “3 Nov” / “3 nov” (local). */
export function dayShortMonth(iso: string | Date, tag?: string | null): string {
  const d = new Date(iso);
  return `${d.getDate()} ${shortMonthName(d.getMonth(), tag)}`;
}

/** “3 November” / “3 november” (local). */
export function dayLongMonth(iso: string | Date, tag?: string | null): string {
  const d = new Date(iso);
  return `${d.getDate()} ${longMonthName(d.getMonth(), tag)}`;
}
