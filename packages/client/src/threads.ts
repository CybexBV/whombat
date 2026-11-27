/**
 * A thread's reply row under its root, worded as Slack does (docs/decisions/slack-thread-link.md AP-940…): the last
 * repliers' faces, `5 replies` and `Last reply 2 hours ago`. Shared by web and mobile. Pure, no DOM and no React Native.
 */
import { interpolate } from '@whombat/core/i18n';
import { type DateInput, formatAgo, formatDate } from '@whombat/core/text';
import { clientTree } from './i18n/catalog';
import { WORK_AREA_WORDS } from './i18n/messages/chatWork/work';

const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * `Last reply just now`, `Last reply 12 min ago`, `Last reply 2 hours ago`, `Last reply 3 days ago`, then the date a
 * week on: `Last reply on 3 Mar`, `Last reply on 3 Mar 2025` (core `formatAgo`, `formatDate`).
 */
export function lastReplyLabel(
  at: DateInput,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const w = clientTree(locale, WORK_AREA_WORDS).threads;
  const age = new Date(now).getTime() - new Date(at).getTime();
  return age < WEEK_MS
    ? interpolate(w.lastReply, { when: formatAgo(at, now, timeZone, locale) })
    : interpolate(w.lastReplyOn, { date: formatDate(at, timeZone, { now }, locale) });
}
