/**
 * A thread's reply row under its root, worded as Slack does (docs/decisions/slack-thread-link.md AP-940…): the last
 * repliers' faces, `5 replies` and `Last reply 2 hours ago`. Shared by web and mobile. Pure, no DOM and no React Native.
 */
import { type DateInput, formatAgo, formatDate } from '@whombat/core/text';

const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * `Last reply just now`, `Last reply 12 min ago`, `Last reply 2 hours ago`, `Last reply 3 days ago`, then the date a
 * week on: `Last reply on 3 Mar`, `Last reply on 3 Mar 2025` (core `formatAgo`, `formatDate`).
 */
export function lastReplyLabel(at: DateInput, now: DateInput, timeZone: string): string {
  const age = new Date(now).getTime() - new Date(at).getTime();
  return age < WEEK_MS
    ? `Last reply ${formatAgo(at, now, timeZone)}`
    : `Last reply on ${formatDate(at, timeZone, { now })}`;
}
