/**
 * Pages by time of day in the editor (Whombat docs/decisions/desk-display.md, “Pages by time”): a page's window set or
 * cleared as a new draft, and the words a page tab and its dialog say (“07:00–09:00”, “Weekdays, 07:00–09:00”). Pure,
 * for the web and the phone alike.
 */
import { WEEKDAY_KEYS } from '@whombat/core/domain';
import { daysText } from '../notifications';
import { type DeskLayout, type DeskPage, type DeskPageShow, fillDeskWords } from './contract';
import { DESK_SCREENS_TEXT, deskScreensText } from './screens';

/** The page-times words in a locale (English when none is given). */
function timesWords(locale?: string | null) {
  return (locale === undefined || locale === null ? DESK_SCREENS_TEXT : deskScreensText(locale)).editor.times;
}

/** A window a page starts with when someone chooses set times: mornings, every day. */
export const PAGE_TIMES_DEFAULT: DeskPageShow = { from: '07:00', to: '09:00' };

/**
 * Page `index` shown at `show`, or always (`null`). Every day is kept as no days at all; a window without a day is
 * refused (null), as the dialog says.
 */
export function setPageShow(layout: DeskLayout, index: number, show: DeskPageShow | null): DeskLayout | null {
  const page = layout.pages[index];
  if (!page) return layout;
  let next: DeskPage;
  if (!show) {
    if (!page.show) return layout;
    const { show: _gone, ...rest } = page;
    next = rest;
  } else {
    const days = WEEKDAY_KEYS.filter((d) => show.days === undefined || show.days.includes(d));
    if (days.length === 0) return null;
    next = { ...page, show: { from: show.from, to: show.to, ...(days.length < 7 ? { days } : {}) } };
  }
  return { ...layout, pages: layout.pages.map((p, i) => (i === index ? next : p)) };
}

/** A page tab's hours: “07:00–09:00”; a whole day says its days (“Weekends”) or “All day”. */
export function pageHoursText(show: DeskPageShow, locale?: string | null): string {
  if (show.from !== show.to) return `${show.from}–${show.to}`;
  return show.days && show.days.length < 7 ? daysText(show.days, locale) : timesWords(locale).allDay;
}

/** When a page shows, in full: “Weekdays, 07:00–09:00”, “Every day, 22:00–06:00”, “Weekends”. */
export function pageWhenText(show: DeskPageShow, locale?: string | null): string {
  const days = daysText(show.days ?? WEEKDAY_KEYS, locale);
  return show.from === show.to ? days : `${days}, ${show.from}–${show.to}`;
}

/** What saying the change says: “Morning shows Weekdays, 07:00–09:00.”, “Morning shows all the time again.” */
export function pageShowSaid(name: string, show: DeskPageShow | null, locale?: string | null): string {
  const T = timesWords(locale);
  return show
    ? fillDeskWords(T.set, { name, when: pageWhenText(show, locale) })
    : fillDeskWords(T.cleared, { name });
}
