/**
 * An agent's schedules, the few words core leaves to the clients and the web and the phone say alike: what a change
 * says, a schedule's state, when it runs next, and the remove confirm split from core's one sentence. Core holds the
 * rest of the words (`SCHEDULE_COPY`, `describeScheduleWhen`, `schedulePromptLine`) and the rules (`scheduleActions`);
 * how a state's dot looks is each app's. Pure.
 */
import {
  type AgentScheduleView,
  type DateInput,
  formatClock,
  formatDate,
  formatWeekday,
  toDate,
  zonedParts,
} from '@whombat/core';
import { formatLocaleOf, resolveLanguage } from '@whombat/core/i18n';
import { clientTranslator } from './i18n/catalog';

/** What a change says. Removing is core's `cancelled`. */
export const SCHEDULE_TEXT = {
  paused: 'Paused. It won’t run until you resume it.',
  resumed: 'Resumed.',
  failed: 'That didn’t work. Try again in a moment.',
  loadFailed: 'Couldn’t load the schedules. Try again in a moment.',
  /** A card whose schedule isn't there (not read yet, or removed). */
  gone: 'This schedule isn’t there any more.',
} as const;

export function scheduleText(locale?: string | null) {
  const tr = clientTranslator(locale);
  return {
    paused: tr.t('schedules.paused'),
    resumed: tr.t('schedules.resumed'),
    failed: tr.t('schedules.failed'),
    loadFailed: tr.t('schedules.loadFailed'),
    gone: tr.t('schedules.gone'),
  };
}

/** “Active”, “Paused”, “Ended · Ran its 90 days”. */
export function scheduleStatusText(
  schedule: Pick<AgentScheduleView, 'status' | 'endedReason'>,
  locale?: string | null,
): string {
  const tr = clientTranslator(locale);
  const label = tr.t(`schedules.status.${schedule.status}`);
  return schedule.status === 'ended' && schedule.endedReason
    ? `${label} · ${tr.t(`schedules.end.${schedule.endedReason}`)}`
    : label;
}

/** “Thu 24 Sep at 08:30” (the year only when it isn't `now`'s): when it runs next, as `describeScheduleWhen` says it. */
export function scheduleTimeText(
  at: string,
  timeZone: string,
  now: DateInput,
  locale?: string | null,
): string {
  const tr = clientTranslator(locale);
  const clock = formatClock(at, timeZone);
  if (resolveLanguage(locale) === 'en' && !locale) {
    return tr.t('schedules.timeAt', {
      weekday: formatWeekday(at, timeZone).slice(0, 3),
      date: formatDate(at, timeZone, { now }),
      clock,
    });
  }
  const d = toDate(at);
  const fmtLocale = formatLocaleOf(locale);
  const weekday = new Intl.DateTimeFormat(fmtLocale, { weekday: 'short', timeZone })
    .format(d)
    .replace(/\.$/, '');
  const sameYear = zonedParts(d, timeZone).year === zonedParts(now, timeZone).year;
  const date = new Intl.DateTimeFormat(fmtLocale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone,
  })
    .format(d)
    .replace(/\.$/, '');
  return tr.t('schedules.timeAt', { weekday, date, clock });
}

/** The confirm's title and text, from core's one sentence: “Remove this schedule?” · “Neo won’t run it again.” */
export function splitConfirm(sentence: string): { title: string; text: string } {
  const at = sentence.indexOf('? ');
  return at < 0
    ? { title: sentence, text: '' }
    : { title: sentence.slice(0, at + 1), text: sentence.slice(at + 2) };
}
