/**
 * Notifications people control (0.26, CT-175, CT-176): a person's quiet time (Do not disturb, quiet hours), email
 * digests and thread replies, and the rule for whether a message notifies someone. Pure: the runtime decides with these
 * and the apps show the same state.
 */
import { z } from 'zod';
import { type DateInput, toDate, zonedParts } from '../text/time.js';
import { Timestamp } from './common.js';
import { type ConversationKind, type NotifyLevel, notifyLevelOf } from './conversation.js';

/** A wall-clock time `HH:MM` (24-hour) in the person's zone. */
export const ClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
export type ClockTime = z.infer<typeof ClockTime>;

export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const Weekday = z.enum(WEEKDAY_KEYS);
export type Weekday = z.infer<typeof Weekday>;

/**
 * Quiet hours in the person's time zone (`Preferences.timeZone`, else the burrow's): from `start` to `end` on the
 * listed `days` (the day the quiet time starts; `22:00`–`08:00` on `fri` runs into Saturday morning). `start` = `end`
 * is quiet all day.
 */
export const QuietHours = z.object({
  enabled: z.boolean(),
  start: ClockTime,
  end: ClockTime,
  days: z.array(Weekday).max(7),
});
export type QuietHours = z.infer<typeof QuietHours>;

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  start: '22:00',
  end: '08:00',
  days: [...WEEKDAY_KEYS],
};

/**
 * Email about what stayed unread (CT-175): `off`, at most one an `hourly`, or one `daily` at 08:00 local. Only on
 * Whombats that can send mail (`Bootstrap.capabilities.emailNotifications`).
 */
export const EmailNotifications = z.enum(['off', 'hourly', 'daily']);
export type EmailNotifications = z.infer<typeof EmailNotifications>;

/** A person's notification settings (`Preferences.notifications`, 0.26). Absent = {@link DEFAULT_NOTIFICATION_PREFERENCES}. */
export const NotificationPreferences = z.object({
  /** Do not disturb until then (push and email held back; the inbox still fills); null = off. */
  dndUntil: Timestamp.nullable().default(null),
  schedule: QuietHours.default(() => ({ ...DEFAULT_QUIET_HOURS, days: [...DEFAULT_QUIET_HOURS.days] })),
  email: EmailNotifications.default('hourly'),
  /** Replies in threads the person is in notify at level `mentions` too. */
  threadReplies: z.boolean().default(true),
  /**
   * Phone and browser notifications show who wrote and the start of the message (CT-286); off = a generic text by kind
   * (“An agent has an update for you”). Only on runtimes with feature `notifications.previews`.
   */
  previews: z.boolean().default(true),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  dndUntil: null,
  schedule: DEFAULT_QUIET_HOURS,
  email: 'hourly',
  threadReplies: true,
  previews: true,
};

/** The settings in effect: the person's own, else the defaults. */
export function notificationPreferencesOf(prefs: {
  notifications?: NotificationPreferences | null;
}): NotificationPreferences {
  return prefs.notifications ?? DEFAULT_NOTIFICATION_PREFERENCES;
}

/** How long an unread item waits before it may go in an email (CT-175). */
export const EMAIL_UNREAD_AFTER_MS = 30 * 60_000;
/** At most one email per person per this long, when `email` is `hourly`. */
export const EMAIL_HOURLY_MS = 60 * 60_000;
/** The local time of the `daily` email. */
export const EMAIL_DAILY_AT = '08:00';

/** Whether Do not disturb is on at `now`. */
export function isDndActive(prefs: Pick<NotificationPreferences, 'dndUntil'>, now: DateInput): boolean {
  return prefs.dndUntil !== null && toDate(prefs.dndUntil).getTime() > toDate(now).getTime();
}

const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** `zonedParts().weekday` (0 = Sunday) as a `Weekday`. */
const weekdayKey = (weekday: number): Weekday => WEEKDAY_KEYS[(weekday + 6) % 7] as Weekday;

/** Whether `now` falls in the quiet hours, in `timeZone`. */
export function inQuietHours(schedule: QuietHours, now: DateInput, timeZone: string): boolean {
  if (!schedule.enabled || schedule.days.length === 0) return false;
  const p = zonedParts(now, timeZone);
  const at = p.hour * 60 + p.minute;
  const start = minutesOf(schedule.start);
  const end = minutesOf(schedule.end);
  const today = weekdayKey(p.weekday);
  const yesterday = weekdayKey((p.weekday + 6) % 7);
  if (start === end) return schedule.days.includes(today);
  if (start < end) return schedule.days.includes(today) && at >= start && at < end;
  // Overnight: the evening part belongs to today, the morning part to the day it started (yesterday).
  return (schedule.days.includes(today) && at >= start) || (schedule.days.includes(yesterday) && at < end);
}

/**
 * Whether `now` falls in a quiet window that applies every day (0.100, CT-518; the desk screen's quiet hours, Whombat
 * desk-display.md DK-09): `inQuietHours` with all seven days. `start` = `end` is quiet all day, as there.
 */
export function inQuietWindow(
  window: Pick<QuietHours, 'enabled' | 'start' | 'end'>,
  now: DateInput,
  timeZone: string,
): boolean {
  return inQuietHours({ ...window, days: [...WEEKDAY_KEYS] }, now, timeZone);
}

/**
 * Whether push and email are held back at `now` (DND or quiet hours); the inbox still fills. Both end on time. Needs-you
 * items are held back too: they wait in the inbox.
 */
export function isQuietNow(prefs: NotificationPreferences, now: DateInput, timeZone: string): boolean {
  return isDndActive(prefs, now) || inQuietHours(prefs.schedule, now, timeZone);
}

/**
 * The instant a wall-clock time in `timeZone` names (`2026-10-01`, `08:00` in `Europe/Amsterdam`). In a DST gap the
 * later side is used; in an overlap the first.
 */
export function zonedInstant(
  date: { year: number; month: number; day: number },
  time: string,
  timeZone: string,
): Date {
  const wall = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    Number(time.slice(0, 2)),
    Number(time.slice(3, 5)),
  );
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, timeZone);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wall - seen;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/** Quick Do-not-disturb durations: 30 min, 1 h, until tomorrow (08:00 local). “Custom” sets `dndUntil` itself. */
export const DndPreset = z.enum(['30m', '1h', 'tomorrow']);
export type DndPreset = z.infer<typeof DndPreset>;

export const DND_PRESET_LABELS: Record<DndPreset, string> = {
  '30m': '30 minutes',
  '1h': '1 hour',
  tomorrow: 'Until tomorrow',
};

/** When a Do-not-disturb preset ends: now + 30 min, now + 1 h, or 08:00 tomorrow in `timeZone`. */
export function dndUntilFor(preset: DndPreset, now: DateInput, timeZone: string): string {
  const t = toDate(now).getTime();
  if (preset === '30m') return new Date(t + 30 * 60_000).toISOString();
  if (preset === '1h') return new Date(t + 60 * 60_000).toISOString();
  const p = zonedParts(t + 24 * 60 * 60_000, timeZone);
  return zonedInstant(p, EMAIL_DAILY_AT, timeZone).toISOString();
}

/** Why a message notifies a person (CT-175); the runtime maps it to a `NotificationKind`. */
export type NotifyReason = 'mention' | 'reply' | 'all';

/**
 * Whether a message notifies one person, and why (CT-175). Needs-you items addressed to the person always notify and
 * are not decided here. Order: the author never; `none` nothing; a mention; a reply in a thread they're in (when
 * `threadReplies`); at `all` any other message. DND and quiet hours don't change this: they hold back push and email
 * only (`isQuietNow`).
 */
export function notifyReason(input: {
  kind: ConversationKind;
  /** The person's own level for the conversation (`ConversationSummary.notify`); absent = the default. */
  notify?: NotifyLevel | null;
  recipientId: string;
  authorId: string;
  mentionIds: readonly string[];
  /** The message is a thread reply and the person is in that thread (wrote its root or a reply, or was mentioned). */
  inThread?: boolean;
  threadReplies?: boolean;
}): NotifyReason | null {
  if (input.recipientId === input.authorId) return null;
  const level = notifyLevelOf({ kind: input.kind, notify: input.notify });
  if (level === 'none') return null;
  if (input.mentionIds.includes(input.recipientId)) return 'mention';
  if (input.inThread && input.threadReplies !== false) return 'reply';
  if (level === 'all') return 'all';
  return null;
}
