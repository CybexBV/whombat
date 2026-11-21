/**
 * Whombat's own widgets that have a view (docs/decisions/desk-display.md DK-139): *{assistant}’s work*, *Coming up* and
 * *Done today*, each a `list`. They read what the glance already read for the calm glance (the work with its steps, the
 * automations' next runs, the tasks finished), so they cost no read of their own and are as fresh as the glance.
 * *Clock*, *How things are*, *What’s going on* and *Servers* have no view: the screen draws them from the calm glance.
 * Pure.
 */
import {
  DESK_SCREEN_WORDS,
  DESK_VIEW_ROWS_MAX,
  type DeskCalmComing,
  type DeskCalmWork,
  type DeskViewRow,
  type DeskWidgetView,
  fillDeskWords,
} from '@whombat/core';
import { screenText } from '../glance';
import type { Resolved } from './types';

/** Whombat's own widgets are read with the glance (every 10 s); a minute is what DK-148 asks of the screen. */
export const OWN_REFRESH_S = 60;
/** *Coming up* says only the hour of what comes within this long. */
const COMING_HOURS_MS = 12 * 3_600_000;

/** Words Whombat's own widgets say besides their names. */
export const OWN_WIDGET_WORDS = {
  idle: '{assistant} isn’t working on anything right now.',
  steps: { done: 'done', now: 'now', next: 'next' },
  nothingComing: 'Nothing planned in the next 24 hours.',
  doneOne: '{assistant} did 1 thing today',
  doneMany: '{assistant} did {n} things today',
  nothingDone: 'Nothing finished yet today.',
} as const;

const words = (template: string, assistant: string, n?: number) =>
  fillDeskWords(template, { assistant, ...(n !== undefined ? { n } : {}) });

/** “02:00” in the person's zone. */
export function clockIn(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

/** “Thu” in the person's zone. */
function weekdayIn(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(at);
  } catch {
    return at.toUTCString().slice(0, 3);
  }
}

/** The day in the person's zone, to tell today from another day. */
function dayIn(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * *{assistant}’s work* (DK-139): what it's working on as the head, its steps as rows (“done”, “now”, “next”, the done
 * ones fine), how far along; when it's working on nothing, it says so. The work's title shows locked too, as the calm
 * glance's moment does; only its steps' words are its own.
 */
export function workView(id: string, work: DeskCalmWork | null, assistant: string): Resolved {
  const title = screenText(words(DESK_SCREEN_WORDS.own.work.name, assistant), 60);
  if (!work?.title) {
    return {
      view: {
        kind: 'list',
        id,
        title,
        rows: [],
        empty: screenText(words(OWN_WIDGET_WORDS.idle, assistant), 120),
      },
      private: false,
      refreshS: OWN_REFRESH_S,
    };
  }
  const done = work.steps.filter((s) => s.state === 'done').length;
  // The window around the step going on, as the old glance showed it.
  const now = work.steps.findIndex((s) => s.state !== 'done');
  const all = work.steps.length;
  const start =
    all <= DESK_VIEW_ROWS_MAX
      ? 0
      : Math.max(0, Math.min((now < 0 ? all : now) - 1, all - DESK_VIEW_ROWS_MAX));
  const rows: DeskViewRow[] = work.steps.slice(start, start + DESK_VIEW_ROWS_MAX).map((s) => ({
    title: screenText(s.label, 120) || '…',
    meta: OWN_WIDGET_WORDS.steps[s.state],
    ...(s.state === 'done' ? { tone: 'ok' as const } : {}),
  }));
  const view: DeskWidgetView = {
    kind: 'list',
    id,
    title,
    head: screenText(work.title, 80),
    rows,
    ...(all > 0 ? { progress: Math.round((done / all) * 100) } : {}),
    ...(all > rows.length ? { count: all } : {}),
  };
  return { view, private: false, refreshS: OWN_REFRESH_S };
}

/**
 * *Coming up* (DK-139): the automations' next runs within a day, soonest first, each at its hour (“02:00”) today or
 * within 12 hours, else with its day (“Thu 08:00”). The names show locked, as the calm glance's *Coming up* does.
 */
export function comingView(
  id: string,
  coming: readonly DeskCalmComing[],
  now: Date,
  timeZone: string,
): Resolved {
  const today = dayIn(now, timeZone);
  const rows: DeskViewRow[] = coming.slice(0, DESK_VIEW_ROWS_MAX).flatMap((c) => {
    const at = new Date(c.at);
    const title = screenText(c.name, 120);
    if (!title || !Number.isFinite(at.getTime())) return [];
    // Tonight's backups at 02:00 are “02:00”; further on, the day says which.
    const soon = dayIn(at, timeZone) === today || at.getTime() - now.getTime() <= COMING_HOURS_MS;
    const time = soon ? clockIn(at, timeZone) : `${weekdayIn(at, timeZone)} ${clockIn(at, timeZone)}`;
    return [{ title, time }];
  });
  return {
    view: {
      kind: 'list',
      id,
      title: DESK_SCREEN_WORDS.own.coming.name,
      rows,
      ...(rows.length === 0 ? { empty: OWN_WIDGET_WORDS.nothingComing } : {}),
    },
    private: false,
    refreshS: OWN_REFRESH_S,
  };
}

/**
 * *Done today* (DK-139): what the assistant finished today, newest first, at its hour; its title counts them (“Dusty
 * did 3 things today”). What it did is its own words about the person's business, so a locked screen in *A summary*
 * keeps only the count.
 */
export function doneView(
  id: string,
  recent: readonly { text: string; at: string }[],
  startOfToday: number,
  assistant: string,
  timeZone: string,
): Resolved {
  const today = recent.filter((d) => Date.parse(d.at) >= startOfToday && d.text);
  const rows: DeskViewRow[] = today.slice(0, DESK_VIEW_ROWS_MAX).map((d) => ({
    title: screenText(d.text, 120) || '…',
    time: clockIn(new Date(d.at), timeZone),
    tone: 'ok' as const,
  }));
  const title =
    today.length === 0
      ? DESK_SCREEN_WORDS.own.done.name
      : screenText(
          today.length === 1
            ? words(OWN_WIDGET_WORDS.doneOne, assistant)
            : words(OWN_WIDGET_WORDS.doneMany, assistant, today.length),
          60,
        );
  return {
    view: {
      kind: 'list',
      id,
      title,
      rows,
      ...(today.length > rows.length ? { count: today.length } : {}),
      ...(rows.length === 0 ? { empty: OWN_WIDGET_WORDS.nothingDone } : {}),
    },
    private: rows.length > 0,
    refreshS: OWN_REFRESH_S,
  };
}
