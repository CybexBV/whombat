/**
 * Monitoring on the phone (Whombat monitoring.md MON-04, MON-07, MON-09, MON-15): what the phone adds around the shared
 * parts (`@whombat/client`'s `keepQuietOptions`, `holdView`, `historyView`, `limitView`, `useKeepQuiet`, …) — Pick a
 * time as a row of days and a clock, the ⋯ menus that offer Keep quiet…, the head's week line without its copy among
 * the facts, and the words a screen reader hears. Pure; the screens are `screens/thing/Monitoring.tsx`,
 * `ThingPageScreen` and `ServerScreen`.
 */
import { KEEP_QUIET_WORDS, LIMIT_WORDS } from '@whombat/client';
import type { ThingPage } from '@whombat/core';
import { zonedParts } from '@whombat/core/text';
import { type NativeMenuSpec, plainMenu } from './nativeMenu';
import { RENAME_COPY } from './rename';

export const MONITORING_COPY = {
  keepQuiet: KEEP_QUIET_WORDS.menu,
  endNow: KEEP_QUIET_WORDS.endNow,
  endNowHint: 'Whombat watches it again',
  /** Pick a time's two parts. */
  day: 'Day',
  time: 'Time',
  today: 'Today',
  tomorrow: 'Tomorrow',
  /** The cause's link under the state: “Open downloads”, and what it opens. */
  openCauseHint: 'Opens what it depends on',
  history: 'What happened',
  historyLoading: 'Loading what happened',
  /** A check with a limit in What Whombat watches: “Warns above 90 %”, and its button. */
  warnsAbove: (value: string) => `Warns above ${value}`,
  ownLimits: (n: number) => `${n} ${n === 1 ? 'item has' : 'items have'} its own`,
  changeLimit: LIMIT_WORDS.menu,
  changeLimitHint: (name: string) => `Changes when Whombat warns about “${name}”`,
  /** The ⋯ of a page with nothing else in it. */
  more: (name: string) => `More for ${name}`,
} as const;

/** One of Pick a time's days: its date (`2026-09-23`) and its words (“Today”, “Tomorrow”, “Fri 25”). */
export interface PickDay {
  value: string;
  label: string;
}

const two = (n: number) => String(n).padStart(2, '0');

/** The days Pick a time offers: today and the next `count - 1`, in the Whombat's zone. */
export function pickDays(now: Date | number, timeZone: string, count = 7): PickDay[] {
  const t = typeof now === 'number' ? now : now.getTime();
  const out: PickDay[] = [];
  const seen = new Set<string>();
  // Noon steps, so a summer-time change never skips or repeats a day.
  const base = zonedParts(t, timeZone);
  const noon = Date.UTC(base.year, base.month - 1, base.day, 12);
  for (let i = 0; out.length < count && i < count + 2; i++) {
    const d = new Date(noon + i * 86_400_000);
    const value = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
    if (seen.has(value)) continue;
    seen.add(value);
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(d);
    out.push({
      value,
      label: i === 0 ? MONITORING_COPY.today : i === 1 ? MONITORING_COPY.tomorrow : `${weekday} ${d.getUTCDate()}`,
    });
  }
  return out;
}

/** What Pick a time starts with: today, two whole hours from now (“16:00” at 14:05); past 21:00, tomorrow at 09:00. */
export function firstPick(now: Date | number, timeZone: string): { day: string; clock: string } {
  const p = zonedParts(now, timeZone);
  const [today, tomorrow] = pickDays(now, timeZone, 2);
  if (p.hour >= 21 || !today) return { day: tomorrow?.value ?? today?.value ?? '', clock: '09:00' };
  return { day: today.value, clock: `${two(p.hour + 2)}:00` };
}

/** Pick a time's day and clock as the shared `keepQuietBody` reads them (`2026-09-23T16:00`). */
export function pickedValue(day: string, clock: string): string {
  return `${day}T${clock}`;
}

/** The head's facts without the week's line, which the head draws on its own (the server sends both). */
export function factsWithoutUptime(
  facts: ThingPage['facts'],
  uptime: ThingPage['uptime'] | null | undefined,
): ThingPage['facts'] {
  if (!uptime) return facts;
  const text = (f: ThingPage['facts'][number]) => f.map((p) => p.text).join('');
  return facts.filter((f) => text(f) !== uptime.text);
}

export type MonitoringPick = 'keep_quiet';

/** A page's ⋯ when nothing else is in it: Keep quiet…. */
export function thingMoreMenu(): NativeMenuSpec {
  return plainMenu([[{ id: 'keep_quiet', title: MONITORING_COPY.keepQuiet, icon: 'bell.slash' }]]);
}

/** A server page's ⋯: Rename, then Keep quiet… where it may be kept quiet. */
export function serverMoreMenu(keepQuiet: boolean): NativeMenuSpec {
  return plainMenu([
    [{ id: 'rename', title: RENAME_COPY.rename, icon: 'pencil' }],
    keepQuiet ? [{ id: 'keep_quiet', title: MONITORING_COPY.keepQuiet, icon: 'bell.slash' }] : [],
  ]);
}

export function parseMonitoringPick(id: string): MonitoringPick | null {
  return id === 'keep_quiet' ? id : null;
}
