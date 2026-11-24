/**
 * Monitoring on a thing's page, the parts web and phone share (Whombat docs/decisions/monitoring.md MON-04, MON-07,
 * MON-09, MON-15): Keep quiet… and its choices with the time each ends, the line a page draws while a thing is kept
 * quiet or down because of something else, which Worth a look lines are held (End now, not Undo), a thing's state words
 * in a list, the “What happened” list, and the sheet that changes a server check's limit. Pure.
 */
import {
  fillQuietWords,
  KEEP_QUIET_MAX_MINUTES,
  KEEP_QUIET_MIN_MINUTES,
  type KeepQuietBody,
  type KeptQuiet,
  type NoticeQuiet,
  type NoticeSubject,
  QUIET_SNOOZE_HOUR,
  type ThingCause,
  type ThingHistory,
  type ThingHistoryAlert,
  type ThingIncident,
  type ThingPageNotice,
  type ThingSummary,
  type ThingWatchCheck,
  zonedInstant,
} from '@whombat/core';
import { daysAgo, formatClock, formatDate, formatShortWeekday, toDate, zonedParts } from '@whombat/core/text';
import { localAt, untilText } from './time';

/* Keep quiet… (MON-04) --------------------------------------------------------------------------------------------- */

export const KEEP_QUIET_WORDS = {
  /** The ⋯ item; it opens the sheet. */
  menu: 'Keep quiet…',
  title: 'Keep {name} quiet',
  body: 'Until then Whombat won’t warn you about it, look into it or send a push. What is still wrong counts again when it ends.',
  hour: 'For an hour',
  tonight: 'Until tonight',
  morning: 'Until tomorrow morning',
  pick: 'Pick a time',
  pickLabel: 'Until',
  note: 'Note (optional)',
  notePlaceholder: 'Moving the NAS',
  button: 'Keep quiet',
  endNow: 'End now',
  /** The toast after Keep quiet, with Undo (which ends it). */
  kept: 'Quiet until {time}.',
  /** The toast after End now. */
  ended: 'Whombat watches {name} again.',
  pickPast: 'Pick a time that is still ahead.',
  pickFar: 'Pick a time within a month.',
  pickEmpty: 'Pick a day and a time.',
  /** Worth a look's lines quiet with the whole thing, folded under one row. */
  showHeld: (n: number) => `Show ${n} on hold`,
  hideHeld: 'Hide what’s on hold',
} as const;

export type KeepQuietChoice = 'hour' | 'tonight' | 'morning' | 'pick';

/** Tonight ends at 23:00; offered from 05:00 until half an hour before it. */
const TONIGHT = '23:00';
const TONIGHT_FROM_HOUR = 5;
const TONIGHT_LAST_MS = 30 * 60_000;
/** Tomorrow morning is 09:00, as Remind me tomorrow; before 05:00 it is this morning's. */
const MORNING = `${String(QUIET_SNOOZE_HOUR).padStart(2, '0')}:00`;

/**
 * When a choice ends, as an instant (ISO), or null when it isn't offered now (“Until tonight” late in the evening and
 * at night). `pick` is the datetime-local value (`2026-11-24T23:00`) read in the Whombat's zone.
 */
export function keepQuietUntil(
  choice: KeepQuietChoice,
  now: Date | number,
  timeZone: string,
  picked?: string,
): string | null {
  const t = toDate(now).getTime();
  switch (choice) {
    case 'hour':
      return new Date(t + 60 * 60_000).toISOString();
    case 'tonight': {
      const hour = zonedParts(now, timeZone).hour;
      const end = localAt(now, timeZone, TONIGHT, 0);
      if (hour < TONIGHT_FROM_HOUR || Date.parse(end) - t < TONIGHT_LAST_MS) return null;
      return end;
    }
    case 'morning':
      return localAt(now, timeZone, MORNING, zonedParts(now, timeZone).hour < TONIGHT_FROM_HOUR ? 0 : 1);
    case 'pick':
      return picked ? pickedInstant(picked, timeZone) : null;
  }
}

/** A datetime-local value (`2026-11-24T23:00`) in `timeZone`, as ISO; null when it isn't one. */
export function pickedInstant(value: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(value.trim());
  if (!m) return null;
  const at = zonedInstant(
    { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
    m[4] as string,
    timeZone,
  );
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

/** A datetime-local value for an instant in `timeZone` (the picker's first value and its minimum). */
export function pickerValue(at: Date | number | string, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}

/** “14:32”, “tomorrow 09:00”, “Fri 09:00”, “3 Dec”: when a quiet ends, after “until”. */
export function quietEndWords(until: string, now: Date | number, timeZone: string): string {
  return untilText(until, now, timeZone).replace(/^until /, '');
}

export interface KeepQuietOption {
  choice: KeepQuietChoice;
  label: string;
  /** When it ends (“14:32”, “tomorrow 09:00”); null for Pick a time. */
  ends: string | null;
}

/** The sheet's choices now, in order; “Until tonight” only while it is ahead and still tonight. */
export function keepQuietOptions(now: Date | number, timeZone: string): KeepQuietOption[] {
  return (['hour', 'tonight', 'morning', 'pick'] as const).flatMap((choice): KeepQuietOption[] => {
    if (choice === 'pick') return [{ choice, label: KEEP_QUIET_WORDS.pick, ends: null }];
    const until = keepQuietUntil(choice, now, timeZone);
    return until
      ? [{ choice, label: KEEP_QUIET_WORDS[choice], ends: quietEndWords(until, now, timeZone) }]
      : [];
  });
}

/**
 * The body of `things.keepQuiet` for a choice, or the problem to show under Pick a time. An hour is sent as minutes,
 * the others as their end; the note is trimmed and left out when empty.
 */
export function keepQuietBody(
  choice: KeepQuietChoice,
  input: { now: Date | number; timeZone: string; picked?: string; note?: string },
): { body: KeepQuietBody } | { problem: string } {
  const note = input.note?.trim().slice(0, 120);
  const withNote = note ? { note } : {};
  if (choice === 'hour') return { body: { minutes: 60, ...withNote } };
  if (choice === 'pick' && !input.picked?.trim()) return { problem: KEEP_QUIET_WORDS.pickEmpty };
  const until = keepQuietUntil(choice, input.now, input.timeZone, input.picked);
  if (!until) return { problem: choice === 'pick' ? KEEP_QUIET_WORDS.pickEmpty : KEEP_QUIET_WORDS.pickPast };
  const ahead = Date.parse(until) - toDate(input.now).getTime();
  if (ahead < KEEP_QUIET_MIN_MINUTES * 60_000) return { problem: KEEP_QUIET_WORDS.pickPast };
  if (ahead > KEEP_QUIET_MAX_MINUTES * 60_000) return { problem: KEEP_QUIET_WORDS.pickFar };
  return { body: { until, ...withNote } };
}

/** The toast after Keep quiet: “Quiet until 23:00.” */
export function keptToast(until: string, now: Date | number, timeZone: string): string {
  return fillQuietWords(KEEP_QUIET_WORDS.kept, { time: quietEndWords(until, now, timeZone) });
}

/** The toast after End now: “Whombat watches the NAS again.” */
export function endedToast(name: string): string {
  return fillQuietWords(KEEP_QUIET_WORDS.ended, { name });
}

/** The sheet's title: “Keep pve-02 quiet”. */
export function keepQuietTitle(name: string): string {
  return fillQuietWords(KEEP_QUIET_WORDS.title, { name });
}

/* The line under a page's head (MON-04, MON-07) -------------------------------------------------------------------- */

export interface HoldView {
  kind: 'window' | 'cause';
  /** “Quiet until 23:00 · Moving the NAS”, “Not answering while pve-02 is down”. */
  words: string;
  /** Who kept it quiet, for a tooltip: “Kept quiet by Mara”, “Whombat keeps it quiet for its own work”. */
  who: string | null;
  /** End now, for who may end it; never for a cause. */
  endNow: boolean;
  /** The cause's page and its link's words (“Open pve-02”); null without a page (the internet). */
  link: { href: string; label: string } | null;
}

/**
 * What a page says under its head while it is held: kept quiet (with End now when `canEnd`), else down or quiet
 * because of something else (with a link to the cause). Null while neither holds.
 */
export function holdView(page: {
  keptQuiet?: KeptQuiet | null;
  causedBy?: ThingCause | null;
}): HoldView | null {
  const kept = page.keptQuiet;
  if (kept)
    return {
      kind: 'window',
      words: kept.words,
      who: kept.whombat
        ? 'Whombat keeps it quiet for its own work'
        : kept.by
          ? `Kept quiet by ${kept.by.name}`
          : null,
      endNow: kept.canEnd,
      link: null,
    };
  const cause = page.causedBy;
  if (cause)
    return {
      kind: 'cause',
      words: cause.words,
      who: null,
      endNow: false,
      link: cause.href ? { href: cause.href, label: `Open ${cause.name}` } : null,
    };
  return null;
}

/**
 * Whether the head's state pill would say what the hold's line under it says: kept quiet, the server's badge is the
 * window's first words (“Quiet until 23:00”); down because of something else, the cause's words (cut to the badge's
 * length). A page that draws the line leaves the pill out then, so the words are said once.
 */
export function holdSaysBadge(page: {
  badge: string;
  keptQuiet?: KeptQuiet | null;
  causedBy?: ThingCause | null;
}): boolean {
  const hold = holdView(page);
  const badge = page.badge.trim();
  if (!hold || !badge) return false;
  return hold.kind === 'window' ? hold.words.split(' · ')[0] === badge : hold.words.startsWith(badge);
}

/**
 * The ids of the heads-up line a page sends first while it is held, for an app that doesn't draw `keptQuiet` or
 * `causedBy` itself (the server's `keptLine` and `causeLine`). An app that draws the hold under the head leaves it out.
 */
export const HOLD_LINE_IDS = { window: 'quiet-window', cause: 'quiet-cause' } as const;

/** Worth a look without the hold's heads-up line, when the page draws the hold itself; the same list otherwise. */
export function withoutHoldLine<T extends Pick<ThingPageNotice, 'id'>>(
  items: readonly T[],
  page: { keptQuiet?: KeptQuiet | null; causedBy?: ThingCause | null },
): readonly T[] {
  const drop = new Set<string>();
  if (page.keptQuiet) drop.add(HOLD_LINE_IDS.window);
  if (page.causedBy) drop.add(HOLD_LINE_IDS.cause);
  return drop.size && items.some((n) => drop.has(n.id)) ? items.filter((n) => !drop.has(n.id)) : items;
}

/**
 * Whether a quiet line is quiet with the whole thing: `window` (it offers End now, not Undo), `cause` (it offers
 * neither: it lifts when its cause is back), or null for a line's own Ignore or snooze.
 */
export function heldLine(line: { quiet?: Pick<NoticeQuiet, 'held'> | null }): 'window' | 'cause' | null {
  return line.quiet?.held ?? null;
}

/* A thing's state in a list (MON-04, MON-07) ----------------------------------------------------------------------- */

/**
 * The words a list draws for a thing's state: “Quiet until 23:00” while it is kept quiet, else why it is down because of
 * something else, else its own line. Null when it has none. The window comes first as on its page: someone chose it, and
 * it holds whatever the cause.
 */
export function thingStateWords(
  thing: Pick<ThingSummary, 'causedBy' | 'quietUntil' | 'line'>,
  now: Date | number,
  timeZone: string,
): string | null {
  if (thing.quietUntil && Date.parse(thing.quietUntil) > toDate(now).getTime())
    return `Quiet until ${quietEndWords(thing.quietUntil, now, timeZone)}`;
  if (thing.causedBy) return thing.causedBy.words;
  return thing.line ?? null;
}

/* What happened (MON-09) ------------------------------------------------------------------------------------------- */

export const HISTORY_WORDS = {
  title: 'What happened',
  empty: (days: number) => `Nothing went wrong in the last ${days} days.`,
  still: 'still going',
  /** The fold under the incidents with a server's own alerts. */
  alerts: (n: number) => `Show ${n} ${n === 1 ? 'alert' : 'alerts'} from the server`,
  hideAlerts: 'Hide the alerts from the server',
  /** The small heading over a server's own alerts once they are shown. */
  fromServer: 'From the server',
  fewer: 'Show fewer',
  failed: 'What happened couldn’t load. Try again.',
} as const;

/** “41 min”, “2 h 5 min”, “1 d 3 h”: at least a minute (the server's words for the same). */
export function durationWords(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  const d = Math.floor(m / (24 * 60));
  const h = Math.floor((m % (24 * 60)) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** “Today 07:31”, “Yesterday 22:10”, “Mon 07:31”, “17 Nov 07:31”: when something started. */
export function historyWhen(at: string, now: Date | number, timeZone: string): string {
  const days = daysAgo(at, now, timeZone);
  const clock = formatClock(at, timeZone);
  if (days <= 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  if (days < 7) return `${formatShortWeekday(at, timeZone)} ${clock}`;
  return `${formatDate(at, timeZone, { now: toDate(now) })} ${clock}`;
}

export interface HistoryRow {
  id: string;
  /** Down is bad, a problem amber; a server's warning amber, its critical alert bad. */
  tone: 'bad' | 'warn';
  /** What it was: “Not answering”, “A disk is failing”. */
  words: string;
  /** “Mon 07:31 · 41 min”, “Today 07:31 · still going”. */
  when: string;
  /** “While pve-02 was down”; null for its own. */
  cause: string | null;
  /** Still going: drawn with its tone's dot. */
  open: boolean;
}

export interface HistoryView {
  /** The period's uptime line (“Up 99.6 % in the last 30 days · down 3 times, 41 min”); null without one. */
  uptime: string | null;
  rows: HistoryRow[];
  /** A server's alerts in the period, newest first (folded under the incidents). */
  alerts: HistoryRow[];
  /** “Nothing went wrong in the last 30 days.” when there is neither an incident nor an alert. */
  empty: string | null;
}

function incidentRow(i: ThingIncident, now: Date | number, timeZone: string): HistoryRow {
  const open = i.endedAt === null;
  return {
    id: i.id,
    tone: i.nature === 'down' ? 'bad' : 'warn',
    words: i.words,
    when: `${historyWhen(i.startedAt, now, timeZone)} · ${open ? HISTORY_WORDS.still : durationWords(i.minutes)}`,
    cause: i.cause ? `While ${i.cause.name} was down` : null,
    open,
  };
}

function alertRow(a: ThingHistoryAlert, index: number, now: Date | number, timeZone: string): HistoryRow {
  const open = a.resolvedAt === null;
  const minutes =
    ((a.resolvedAt ? Date.parse(a.resolvedAt) : toDate(now).getTime()) - Date.parse(a.openedAt)) / 60_000;
  return {
    id: `${a.rule}|${a.openedAt}|${index}`,
    tone: a.severity === 'critical' ? 'bad' : 'warn',
    words: a.title,
    when: `${historyWhen(a.openedAt, now, timeZone)} · ${open ? HISTORY_WORDS.still : durationWords(minutes)}`,
    cause: null,
    open,
  };
}

/** The hosts service's alert that says a server stopped checking in: its offline time. */
export const SERVER_OFFLINE_RULE = 'agent.heartbeat_missing';

/**
 * Whether a server's alert is an outage the incidents list already has: it stopped checking in while a `down` incident
 * was open. The two start a pass or two apart, so they count as one when their times overlap.
 */
export function sameOutage(
  alert: Pick<ThingHistoryAlert, 'rule' | 'openedAt' | 'resolvedAt'>,
  incidents: readonly Pick<ThingIncident, 'nature' | 'startedAt' | 'endedAt'>[],
  now: Date | number,
): boolean {
  if (alert.rule !== SERVER_OFFLINE_RULE) return false;
  const end = toDate(now).getTime();
  const from = Date.parse(alert.openedAt);
  const to = alert.resolvedAt ? Date.parse(alert.resolvedAt) : end;
  return incidents.some(
    (i) =>
      i.nature === 'down' &&
      Date.parse(i.startedAt) <= to &&
      (i.endedAt ? Date.parse(i.endedAt) : end) >= from,
  );
}

/**
 * `things.history` as the list draws it: newest first, its uptime line, and the empty words. A server's alert that is the
 * same outage as one of its incidents is left out: the incident already says it.
 */
export function historyView(history: ThingHistory, now: Date | number, timeZone: string): HistoryView {
  const rows = history.incidents.map((i) => incidentRow(i, now, timeZone));
  const alerts = (history.alerts ?? [])
    .filter((a) => !sameOutage(a, history.incidents, now))
    .map((a, i) => alertRow(a, i, now, timeZone));
  return {
    uptime: history.uptime?.text ?? null,
    rows,
    alerts,
    empty: rows.length || alerts.length ? null : HISTORY_WORDS.empty(history.days),
  };
}

/* Change the limit (MON-15) ---------------------------------------------------------------------------------------- */

export const LIMIT_WORDS = {
  menu: 'Change the limit',
  title: 'Change the limit',
  useDefault: 'Use the default',
  save: 'Save',
  label: 'Warn above',
  range: (min: number, max: number, unit: string) => `From ${min} to ${max} ${unit}.`,
  problem: (min: number, max: number, unit: string) => `Choose a limit from ${min} to ${max} ${unit}.`,
  /** The toasts, with Undo. */
  set: (name: string, value: string) => `${name}: warns above ${value} now.`,
  cleared: (name: string) => `${name} uses the default again.`,
} as const;

/** “90 %”, “80 °C”. */
export function limitText(value: number, unit: string): string {
  return `${value} ${unit}`;
}

export interface LimitView {
  /** The check's name (“Disks filling up”), or the item's (“/mnt/backup”) when the sheet is for one item. */
  name: string;
  /** The check's name when the sheet is for one item: “Disks filling up · /mnt/backup”. */
  about: string;
  check: string;
  subject: NoticeSubject | null;
  unit: string;
  min: number;
  max: number;
  /** What the sheet starts with: its own limit, else what applies now. */
  value: number | null;
  /** Whether it has a limit of its own (Use the default clears it). */
  own: boolean;
  /** What applies without one of its own, in words: “The default is 90 %.”, “Without its own it follows the server: 85 %.” */
  defaultWords: string;
  /** The limit that applies without one of its own; null when each sensor has its own. */
  defaultValue: number | null;
  rangeWords: string;
}

/**
 * The sheet for a check's limit, for the whole server or for one item (`subject`); null when the check has no limit
 * (or an older Whombat doesn't send it).
 */
export function limitView(
  check: Pick<ThingWatchCheck, 'check' | 'name' | 'limit'>,
  subject?: NoticeSubject | null,
): LimitView | null {
  const limit = check.limit;
  if (!limit) return null;
  const item = subject ? limit.items.find((i) => i.subject.id === subject.id) : undefined;
  const own = subject ? item !== undefined : limit.value !== null;
  // Without its own: an item follows the server's limit, the server the check's default.
  const fallback = subject ? (limit.value ?? limit.defaultValue ?? null) : (limit.defaultValue ?? null);
  const defaultWords =
    fallback === null
      ? 'Without one, each sensor uses its own limit.'
      : subject && limit.value !== null
        ? `Without its own it follows the server: ${limitText(fallback, limit.unit)}.`
        : `The default is ${limitText(fallback, limit.unit)}.`;
  return {
    name: subject?.name ?? check.name,
    about: subject ? `${check.name} · ${subject.name}` : check.name,
    check: check.check,
    subject: subject ?? null,
    unit: limit.unit,
    min: limit.min,
    max: limit.max,
    value: item?.value ?? (subject ? fallback : (limit.value ?? fallback)),
    own,
    defaultWords,
    defaultValue: fallback,
    rangeWords: LIMIT_WORDS.range(limit.min, limit.max, limit.unit),
  };
}

/**
 * A check's limit as What Whombat watches says it under its name: “Warns above 85 %”, “Warns above 90 %, the default”,
 * “Each sensor warns at its own limit”; with the items that have their own (“/mnt/backup above 97 %”). Null: no limit.
 */
export function limitLine(
  check: Pick<ThingWatchCheck, 'limit'>,
): { words: string; items: { subject: NoticeSubject; words: string }[] } | null {
  const l = check.limit;
  if (!l) return null;
  const words =
    l.value !== null
      ? `Warns above ${limitText(l.value, l.unit)}`
      : l.defaultValue !== undefined
        ? `Warns above ${limitText(l.defaultValue, l.unit)}, the default`
        : 'Each sensor warns at its own limit';
  return {
    words,
    items: l.items.map((i) => ({ subject: i.subject, words: `above ${limitText(i.value, l.unit)}` })),
  };
}

/** The limit that applies now, under Change the limit in a line's ⋯: “Now 90 %”, “Each sensor has its own now”. */
export function limitNow(view: Pick<LimitView, 'value' | 'unit'>): string {
  return view.value === null ? 'Each sensor has its own now' : `Now ${limitText(view.value, view.unit)}`;
}

/** What was typed as a limit, or the problem to show under the field. */
export function parseLimit(
  typed: string,
  view: Pick<LimitView, 'min' | 'max' | 'unit'>,
): number | { problem: string } {
  const n = Number(typed.trim().replace(',', '.'));
  if (!typed.trim() || !Number.isFinite(n) || n < view.min || n > view.max)
    return { problem: LIMIT_WORDS.problem(view.min, view.max, view.unit) };
  return Math.round(n * 10) / 10;
}

/** The limit a line's ⋯ offers to change: its check's, for its item when the check has items. Null: none. */
export function lineLimit(
  line: Pick<ThingPageNotice, 'check' | 'subject'>,
  checks: readonly Pick<ThingWatchCheck, 'check' | 'name' | 'limit' | 'perItem'>[] | null | undefined,
): LimitView | null {
  if (!line.check || !checks) return null;
  const c = checks.find((x) => x.check === line.check);
  if (!c?.limit) return null;
  return limitView(c, c.perItem && line.subject ? line.subject : null);
}
