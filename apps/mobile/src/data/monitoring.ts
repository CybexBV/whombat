/**
 * Monitoring on the phone: what the phone adds around the shared
 * parts (`@whombat/client`'s `keepQuietOptions`, `holdView`, `historyView`, `limitView`, `useKeepQuiet`, …) — Pick a
 * time as a row of days and a clock, the ⋯ menus that offer Keep quiet…, the head's week line without its copy among
 * the facts, and the words a screen reader hears. Pure; the screens are `screens/thing/Monitoring.tsx`,
 * `ThingPageScreen` and `ServerScreen`.
 */

import {
  holdSaysBadge,
  holdView,
  KEEP_QUIET_WORDS,
  LIMIT_WORDS,
  type LimitView,
  limitLine,
  limitView,
  withoutHoldLine,
} from '@whombat/client';
import type { ThingPage, ThingWatchCheck } from '@whombat/core';
import { zonedParts } from '@whombat/core/text';
import { mobileTranslator } from '../i18n/translate';
import { type NativeMenuSpec, plainMenu } from './nativeMenu';
import { RENAME_COPY } from './rename';

export function monitoringCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    keepQuiet: KEEP_QUIET_WORDS.menu,
    endNow: KEEP_QUIET_WORDS.endNow,
    endNowHint: t('monitoring.monitoringCopy.endNowHint'),
    /** Pick a time's two parts. */
    day: t('monitoring.monitoringCopy.day'),
    time: t('monitoring.monitoringCopy.time'),
    today: t('monitoring.monitoringCopy.today'),
    tomorrow: t('monitoring.monitoringCopy.tomorrow'),
    /** The cause's link under the state: “Open downloads”, and what it opens. */
    openCauseHint: t('monitoring.monitoringCopy.openCauseHint'),
    history: t('monitoring.monitoringCopy.history'),
    historyLoading: t('monitoring.monitoringCopy.historyLoading'),
    changeLimit: LIMIT_WORDS.menu,
    changeLimitHint: (name: string) => t('monitoring.monitoringCopy.changeLimitHint', { name }),
    /** The ⋯ of a page with nothing else in it. */
    more: (name: string) => t('monitoring.monitoringCopy.more', { name }),
  } as const;
}
export const MONITORING_COPY = monitoringCopy();

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
      label:
        i === 0 ? MONITORING_COPY.today : i === 1 ? MONITORING_COPY.tomorrow : `${weekday} ${d.getUTCDate()}`,
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

/**
 * Which sides of Pick a time's scrolling days fade into the sheet: a side with more days past it, so a day the edge
 * cuts off reads as more to scroll to, never as a stray sliver beside the clock. A pixel of rounding isn't more.
 */
export function daysEdges(view: number, content: number, x: number): { left: boolean; right: boolean } {
  return { left: x > 1, right: x + view < content - 1 };
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

/**
 * The page without the hold's heads-up line in Worth a look (“Quiet until 23:00”, “Not answering while pve-02 is
 * down”): the server sends it first for an app that doesn't draw the hold, and the phone draws it under the head.
 */
export function withoutHoldLines(page: ThingPage): ThingPage {
  if (!page.keptQuiet && !page.causedBy) return page;
  return {
    ...page,
    tabs: page.tabs.map((t) => ({
      ...t,
      panels: t.panels.map((p) =>
        p.kind === 'notices' ? { ...p, items: [...withoutHoldLine(p.items, page)] } : p,
      ),
    })),
  };
}

/**
 * Whether the head draws the hold as a line under its state: kept quiet always (who and End now are there); held by a
 * cause only when the state pill doesn't say it already. The pill's words are the cause's, cut to the badge's length,
 * so a long cause still counts as said.
 */
export function holdLineShown(page: Pick<ThingPage, 'badge' | 'keptQuiet' | 'causedBy'>): boolean {
  const hold = holdView(page);
  return !!hold && (hold.kind === 'window' || !holdSaysBadge(page));
}

/** One limit line under a check in What Whombat watches. */
export interface WatchLimitLine {
  key: string;
  /** “Warns above 90 %, the default”, “/mnt/backup above 95 %”. */
  text: string;
  /** Change's hint: what it changes. */
  spoken: string;
  /** What Change opens; null for someone who can't change it, who reads the line without Change. */
  view: LimitView | null;
}

/**
 * A check's limit as What Whombat watches lists it: the server's line, then each item with its own. Someone who can't
 * change them still reads them, as on the web; only Change is left out. Empty without a limit.
 */
export function watchLimitLines(check: ThingWatchCheck, mayChange: boolean): WatchLimitLine[] {
  const line = limitLine(check);
  if (!line) return [];
  return [
    {
      key: check.check,
      text: line.words,
      spoken: MONITORING_COPY.changeLimitHint(check.name),
      view: mayChange ? limitView(check) : null,
    },
    ...line.items.map((item) => ({
      key: `${check.check}|${item.subject.id}`,
      text: `${item.subject.name} ${item.words}`,
      spoken: MONITORING_COPY.changeLimitHint(`${check.name} · ${item.subject.name}`),
      view: mayChange ? limitView(check, item.subject) : null,
    })),
  ];
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
