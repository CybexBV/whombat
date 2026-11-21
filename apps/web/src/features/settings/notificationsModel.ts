/**
 * Settings → Notifications (Whombat essentials item 12; contracts CT-175; AP-490…): the pure parts — what Do not
 * disturb's state says, a custom end in the person's zone, and the one-field changes the page saves (the words the
 * phone says alike are `@whombat/client`'s). Every
 * change replaces `Preferences.notifications` whole (`me.updatePreferences`), built from what the server has now.
 */
import { endsText } from '@whombat/client';
import {
  type DateInput,
  isDndActive,
  type NotificationPreferences,
  toDate,
  zonedInstant,
  zonedParts,
} from '@whombat/core';

/** “Do not disturb is on until 14:52.”, or null while it's off. */
export function dndStateText(
  prefs: Pick<NotificationPreferences, 'dndUntil'>,
  now: DateInput,
  timeZone: string,
): string | null {
  if (!isDndActive(prefs, now) || !prefs.dndUntil) return null;
  return `Do not disturb is on until ${endsText(prefs.dndUntil, now, timeZone)}.`;
}

/** `2026-09-23T18:30` (a `datetime-local` value) for `at` in `timeZone`. */
export function localInputValue(at: DateInput, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * A custom end typed as a `datetime-local` value, read in the person's zone (not the browser's): the ISO instant, or
 * why it can't be used.
 */
export function customDndUntil(
  value: string,
  now: DateInput,
  timeZone: string,
): { ok: true; until: string } | { ok: false; error: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return { ok: false, error: 'Pick a day and a time.' };
  const at = zonedInstant(
    { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
    `${m[4]}:${m[5]}`,
    timeZone,
  );
  if (Number.isNaN(at.getTime())) return { ok: false, error: 'Pick a day and a time.' };
  if (at.getTime() <= toDate(now).getTime()) return { ok: false, error: 'Pick a time that’s still to come.' };
  return { ok: true, until: at.toISOString() };
}

/** Email about what stayed unread (CT-175): the choices and what each means. */
export const EMAIL_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
] as const;

/**
 * The words that differ in the assistant shell (docs/decisions/less-is-more.md AP-1790, AP-1791): its chats are with one
 * assistant, have no bell and no inbox, so the page names the assistant and doesn't mention mentions, the bell or the
 * inbox. `assistant` null: the crew shell's words.
 */
export interface NotificationsWords {
  intro: string;
  /** Do not disturb's line while it's on (“until then”: the time in its title) and while it's off. */
  dndMeta: { on: string; off: string };
  email: Record<NotificationPreferences['email'], string>;
  /** THIS BROWSER while notifications are off, and where it can't show them. */
  pushOff: string;
  pushUnsupported: string;
  /** The way out where this browser can't notify: the phone app tells you instead. */
  getApp: string;
  /** THREADS: “Replies in your threads” only means something where a conversation can be set to mentions. */
  threads: boolean;
}

export function notificationsWords(burrow: string, agent: string): NotificationsWords {
  return {
    intro: `These are yours alone, for every chat in ${burrow}.`,
    dndMeta: {
      on: 'Holds back push and email notifications until then, and ends by itself.',
      off: 'Pause push and email notifications for a while. They come back on by themselves.',
    },
    email: {
      off: 'No email. This browser’s notifications still tell you.',
      hourly: `At most one email an hour about messages from ${agent} and things that need you, once they stayed unread for 30 minutes.`,
      daily: `One email at 08:00 about messages from ${agent} and things that need you that stayed unread.`,
    },
    pushOff: `Turn them on to hear from ${agent} and about things that need you.`,
    pushUnsupported:
      'This browser can’t show notifications. Get the phone app to be told when something needs you.',
    getApp: 'Get the app',
    threads: false,
  };
}
