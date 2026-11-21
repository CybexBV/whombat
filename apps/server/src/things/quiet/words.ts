/**
 * The words around a quiet line (quiet-notices.md QN-10, QN-12, QN-14, QN-17): when a snooze ends (09:00 tomorrow in
 * the Whombat's zone), the lower-case words after “Ignored by John …” and the titles of the changes in a thing's
 * Activity. Pure.
 */
import { localParts, quietWordsOf } from '@whombat/core';
import { SNOOZE_HOUR, tomorrowAt } from '../../home/time';

/** Remind me tomorrow (QN-12): 09:00 tomorrow in the burrow's zone, as Home's snoozes. */
export function snoozeUntil(now: Date, timeZone: string): Date {
  return tomorrowAt(now, timeZone, SNOOZE_HOUR);
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** “Until it’s back online.” → “until it’s back online” (after “Ignored by John”; the contract's `quietWordsOf`). */
export function lowerWords(words: string | null | undefined): string {
  const w = quietWordsOf((words ?? '').trim());
  return w ? clip(w, 60) : 'until it changes';
}

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });

/** “until 09:00” today, “until tomorrow 09:00”, else “until Thu 09:00”, in the zone. */
export function untilWords(until: Date, now: Date, timeZone: string): string {
  const at = localParts(until.getTime(), timeZone);
  const today = localParts(now.getTime(), timeZone);
  const hm = `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`;
  const day = (p: { year: number; month: number; day: number }) => Date.UTC(p.year, p.month - 1, p.day);
  const days = Math.round((day(at) - day(today)) / 86_400_000);
  if (days <= 0) return `until ${hm}`;
  if (days === 1) return `until tomorrow ${hm}`;
  return `until ${WEEKDAY.format(new Date(day(at)))} ${hm}`;
}

/** What the change in Activity says (QN-17); the person is the change's actor. */
export function quietTitle(
  how: 'ignore' | 'snooze' | 'unignore' | 'unsnooze',
  title: string,
  words: string,
): string {
  const t = `“${clip(title, 120)}”`;
  if (how === 'ignore') return `Ignored ${t} ${words}`;
  if (how === 'snooze') return `Snoozed ${t} ${words}`;
  if (how === 'unignore') return `Stopped ignoring ${t}`;
  return `Took back the snooze of ${t}`;
}

/** “Stopped watching Garage AP”, “Watching “Access points going offline” again”, “Started watching “Firmware updates”” (a check that starts off, turned on). */
export function watchTitle(watched: boolean, name: string, whole: boolean, started = false): string {
  const n = whole ? `“${clip(name, 120)}”` : clip(name, 120);
  if (started) return `Started watching ${n}`;
  return watched ? `Watching ${n} again` : `Stopped watching ${n}`;
}
