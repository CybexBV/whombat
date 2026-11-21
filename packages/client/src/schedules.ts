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
  SCHEDULE_END_LABELS,
  SCHEDULE_STATUS_LABELS,
} from '@whombat/core';

/** What a change says. Removing is core's `cancelled`. */
export const SCHEDULE_TEXT = {
  paused: 'Paused. It won’t run until you resume it.',
  resumed: 'Resumed.',
  failed: 'That didn’t work. Try again in a moment.',
  loadFailed: 'Couldn’t load the schedules. Try again in a moment.',
  /** A card whose schedule isn't there (not read yet, or removed). */
  gone: 'This schedule isn’t there any more.',
} as const;

/** “Active”, “Paused”, “Ended · Ran its 90 days”. */
export function scheduleStatusText(schedule: Pick<AgentScheduleView, 'status' | 'endedReason'>): string {
  const label = SCHEDULE_STATUS_LABELS[schedule.status];
  return schedule.status === 'ended' && schedule.endedReason
    ? `${label} · ${SCHEDULE_END_LABELS[schedule.endedReason]}`
    : label;
}

/** “Thu 24 Sep at 08:30” (the year only when it isn't `now`'s): when it runs next, as `describeScheduleWhen` says it. */
export function scheduleTimeText(at: string, timeZone: string, now: DateInput): string {
  return `${formatWeekday(at, timeZone).slice(0, 3)} ${formatDate(at, timeZone, { now })} at ${formatClock(at, timeZone)}`;
}

/** The confirm's title and text, from core's one sentence: “Remove this schedule?” · “Neo won’t run it again.” */
export function splitConfirm(sentence: string): { title: string; text: string } {
  const at = sentence.indexOf('? ');
  return at < 0
    ? { title: sentence, text: '' }
    : { title: sentence.slice(0, at + 1), text: sentence.slice(at + 2) };
}
