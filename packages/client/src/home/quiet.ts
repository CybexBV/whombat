/**
 * Quiet notices, the parts web and phone share (Whombat quiet-notices.md QN-01…QN-24; contracts 0.122.0
 * CT-1060…CT-1068; app quiet-notices.md AP-4800…AP-4819): what a Worth a look line's ⋯ menu holds (Ignore with its
 * words, Remind me tomorrow, Stop watching {item}), which link a line keeps for its kind (only problems ask), how a quiet
 * line reads greyed at the bottom (“Ignored by John until it’s back online”), the page as it looks the moment someone
 * quiets a line or stops watching one (the server's answer then takes over), the toasts, and What Whombat watches as
 * rows of switches with their exceptions. Pure.
 */
import {
  fillDeskWords,
  fillQuietWords,
  type LookResearch,
  type NoticeIgnore,
  type NoticeNature,
  type NoticeQuiet,
  type NoticeRef,
  type NoticeSubject,
  noticeNature,
  QUIET_WORDS,
  quietLine,
  quietWordsOf,
  stopWatchingLabel,
  type ThingPage,
  type ThingPageLink,
  type ThingPageNotice,
  type ThingPagePanel,
  type ThingWatch,
  type ThingWatchCheck,
  type ThingWatchException,
} from '@whombat/core';
import { formatDate, toDate } from '@whombat/core/text';
import { LOOK_PLAN_WORDS } from './lookPlan';
import { tomorrowMorning, untilText } from './time';

/** What a line needs for its menu, its link and its quiet words (a page's line, a server's line). */
export type QuietLine = Pick<
  ThingPageNotice,
  'title' | 'tone' | 'link' | 'nature' | 'check' | 'subject' | 'ignore' | 'quiet'
>;

/* A line's kind, its ref and its link (QN-01…QN-03, QN-S49) ---------------------------------------------------------- */

/** The line's kind (QN-01): its own `nature`, else as an older server's line reads (`noticeNature`). */
export function lineNature(n: Pick<ThingPageNotice, 'nature' | 'tone' | 'link'>): NoticeNature {
  return noticeNature(n);
}

/** Which line it is (its check and item), or null for a line without a check (an older server's, a generic one). */
export function noticeRef(n: Pick<ThingPageNotice, 'check' | 'subject'>): NoticeRef | null {
  if (!n.check) return null;
  return n.subject ? { check: n.check, subject: n.subject.id } : { check: n.check };
}

/** One key per line: `check|subject` (`''` for the thing as a whole). */
export function noticeRefKey(ref: NoticeRef): string {
  return `${ref.check}|${ref.subject ?? ''}`;
}

/** Whether a line is the one `ref` names. */
export function isNotice(n: Pick<ThingPageNotice, 'check' | 'subject'>, ref: NoticeRef): boolean {
  return n.check === ref.check && (n.subject?.id ?? '') === (ref.subject ?? '');
}

/**
 * The link a line keeps for its kind (QN-02, QN-S49): only a problem asks the assistant; an only-you line or a heads-up
 * keeps its other links (where it's done, what shows more) and never asks. A quiet line keeps no link: its Undo is its
 * button. `askLabel` is the one word for asking on every surface (“Ask Neo”), whatever the line's kind wrote.
 */
export function noticeLink(
  n: Pick<ThingPageNotice, 'link' | 'nature' | 'tone' | 'quiet'>,
  askLabel?: string,
): ThingPageLink | undefined {
  if (!n.link || n.quiet) return undefined;
  if (n.link.kind === 'ask' && lineNature(n) !== 'problem') return undefined;
  return n.link.kind === 'ask' && askLabel ? { ...n.link, label: askLabel } : n.link;
}

/* The ⋯ menu (QN-10) ----------------------------------------------------------------------------------------------- */

export interface QuietMenuView {
  ref: NoticeRef;
  /** The ⋯ button's label: “More for Hallway AP is offline”. */
  label: string;
  /** Ignore, with when you'll hear again in the check's own words under it (“Until it’s back online.”). */
  ignore: { label: string; words: string };
  /** Remind me tomorrow. */
  snooze: { label: string };
  /** Stop watching Hallway AP, or Stop watching this, with what that means under it. */
  stop: { label: string; words: string; subject?: NoticeSubject };
}

/** The line under Stop watching in the ⋯ menu (the quiet mock's words). */
export const STOP_WATCHING_WORDS = 'Whombat won’t warn about it until you turn this back on.';

/**
 * The ⋯ menu of a line (QN-10), for people who may quiet it: only a line with `ignore` (the server sends it to them
 * alone) that isn't quiet already. Null: no menu (Look only, guests, an older server, a line without a check).
 */
export function quietMenu(n: QuietLine): QuietMenuView | null {
  const ref = noticeRef(n);
  if (!ref || !n.ignore || n.quiet) return null;
  return {
    ref,
    label: fillQuietWords(QUIET_WORDS.menu, { title: n.title }),
    ignore: { label: QUIET_WORDS.ignore, words: n.ignore.words },
    snooze: { label: QUIET_WORDS.snooze },
    stop: {
      label: stopWatchingLabel(n.subject),
      words: STOP_WATCHING_WORDS,
      ...(n.subject ? { subject: n.subject } : {}),
    },
  };
}

/** A quiet line's grey words (QN-14): “Ignored by John until it’s back online”; null when the line isn't quiet. */
export function quietLineText(n: Pick<ThingPageNotice, 'quiet'>): string | null {
  return n.quiet ? quietLine(n.quiet) : null;
}

/** Whether a quiet line offers Undo: to who may quiet it (the line carries `ignore` for them). */
export function quietUndo(n: QuietLine): boolean {
  return !!n.quiet && !!n.ignore && !!n.check;
}

/** The name a toast gives what stopped being watched: the item (“Hallway AP”), else the line in quotes. */
export function stopName(n: Pick<ThingPageNotice, 'title' | 'subject'>): string {
  return n.subject?.name ?? `“${n.title}”`;
}

/* The toasts (QN-10…QN-13, QN-21) ---------------------------------------------------------------------------------- */

export const QUIET_TOASTS = {
  ignored: QUIET_WORDS.toastIgnored,
  snoozed: QUIET_WORDS.toastSnoozed,
  stopped: (name: string) => fillQuietWords(QUIET_WORDS.toastStopped, { name }),
  watched: (name: string) => fillQuietWords(QUIET_WORDS.toastWatched, { name }),
  undo: QUIET_WORDS.undo,
} as const;

/* The page the moment it changes (optimistic; the server's answer takes over) ----------------------------------------- */

/**
 * How a line reads quiet before the server answers (QN-14): ignored with Ignore's own words (“until it’s back
 * online”), or snoozed until 09:00 tomorrow in the Whombat's zone. Without `by`: the answer names the person.
 */
export function expectedQuiet(
  how: 'ignore' | 'snooze',
  ignore: Pick<NoticeIgnore, 'words' | 'until'> | undefined,
  now: number,
  timeZone: string,
  until?: string,
): NoticeQuiet {
  const at = new Date(now).toISOString();
  if (how === 'ignore')
    return {
      state: 'ignored',
      words: quietWordsOf(ignore?.words ?? 'Until it changes.') || 'until it changes',
      ...(ignore?.until ? { until: ignore.until } : {}),
      at,
    };
  const end = until ?? tomorrowMorning(now, timeZone);
  return { state: 'snoozed', words: untilText(end, now, timeZone), until: end, at };
}

/** Active lines first in their order, then the quiet ones (QN-14: greyed at the bottom). */
export function quietLast<T extends Pick<ThingPageNotice, 'quiet'>>(items: readonly T[]): T[] {
  return [...items.filter((n) => !n.quiet), ...items.filter((n) => n.quiet)];
}

/** A page's notices panels with `fn` applied to each line list; the same page when nothing changed. */
function mapNotices(page: ThingPage, fn: (items: ThingPageNotice[]) => ThingPageNotice[]): ThingPage {
  let changed = false;
  const tabs = page.tabs.map((t) => {
    let tabChanged = false;
    const panels = t.panels.map((p): ThingPagePanel => {
      if (p.kind !== 'notices') return p;
      const items = fn(p.items);
      if (items === p.items) return p;
      tabChanged = true;
      return { ...p, items };
    });
    if (!tabChanged) return t;
    changed = true;
    return { ...t, panels };
  });
  return changed ? { ...page, tabs } : page;
}

/** The page with one line quiet now (`quiet`) or active again (null), moved to its place. */
export function withNoticeQuiet(page: ThingPage, ref: NoticeRef, quiet: NoticeQuiet | null): ThingPage {
  return mapNotices(page, (items) => {
    if (!items.some((n) => isNotice(n, ref))) return items;
    const next = items.map((n): ThingPageNotice => {
      if (!isNotice(n, ref)) return n;
      if (quiet) return { ...n, quiet };
      const { quiet: _q, ...rest } = n;
      return rest;
    });
    return quietLast(next);
  });
}

/** The page without the lines of a check (for one item, or all of them) once it isn't watched (QN-13). */
export function withoutWatchedLines(page: ThingPage, check: string, subject?: string): ThingPage {
  return mapNotices(page, (items) => {
    const keep = items.filter(
      (n) => !(n.check === check && (subject === undefined || n.subject?.id === subject)),
    );
    return keep.length === items.length ? items : keep;
  });
}

/** Active lines, for a panel's count (QN-14: quiet ones count for nothing). */
export function activeCount(items: readonly Pick<ThingPageNotice, 'quiet'>[]): number {
  return items.filter((n) => !n.quiet).length;
}

/* Worth a look in two parts ---------------------------------------------------------------------------------------- */

/**
 * A Worth a look card opens on what asks for the person: problems and only-you lines, in their order, plus a heads-up
 * that carries a button of its own (Resume a paused blocker, Retry). The other heads-ups and the quiet lines fold under
 * one row (“Show 3 heads-ups”), so routine news (updates waiting, a forecast) doesn't bury the one thing that needs them.
 * The card's count is the lines that ask.
 */
export interface NoticeGroups<T> {
  /** Drawn open, in their order. */
  shown: T[];
  /** Problems and only-you lines: the card's count, and what the assistant can be handed in one go. */
  asking: T[];
  /** Heads-ups, then the quiet lines (greyed). */
  folded: T[];
  /** The folded row's words while closed: “Show 3 heads-ups”, “Show 2 heads-ups and 1 ignored”; null: nothing folded. */
  foldLabel: string | null;
}

export function noticeGroups<
  T extends Pick<ThingPageNotice, 'quiet' | 'nature' | 'tone' | 'link' | 'action'>,
>(items: readonly T[]): NoticeGroups<T> {
  const shown: T[] = [];
  const asking: T[] = [];
  const fyi: T[] = [];
  const quiet: T[] = [];
  for (const n of items) {
    if (n.quiet) quiet.push(n);
    else if (lineNature(n) !== 'fyi') {
      asking.push(n);
      shown.push(n);
    } else if (n.action) shown.push(n);
    else fyi.push(n);
  }
  const snoozed = quiet.filter((n) => n.quiet?.state === 'snoozed').length;
  const quietWords = !quiet.length
    ? null
    : snoozed === quiet.length
      ? `${quiet.length} snoozed`
      : snoozed
        ? `${quiet.length} ignored or snoozed`
        : `${quiet.length} ignored`;
  const parts = [fyi.length ? `${fyi.length} heads-up${fyi.length === 1 ? '' : 's'}` : null, quietWords];
  const words = parts.filter(Boolean).join(' and ');
  return { shown, asking, folded: [...fyi, ...quiet], foldLabel: words ? `Show ${words}` : null };
}

/** The ask link's limits (contracts' `ThingPageLink` `ask`). */
const ASK_LABEL_MAX = 30;
const ASK_QUESTION_MAX = 300;

/**
 * One button for the whole card when two or more lines ask: the assistant gets the list and is asked to sort out what it
 * safely can and say what needs the person. Null for fewer lines: each line's own way out is enough then.
 */
export function handleTheseLink(
  asking: readonly Pick<ThingPageNotice, 'title' | 'detail' | 'quiet'>[],
  thing: string,
  assistant: string,
): Extract<ThingPageLink, { kind: 'ask' }> | null {
  const lines = asking.filter((n) => !n.quiet);
  if (lines.length < 2) return null;
  const named = `Ask ${assistant} to handle these`;
  const ask = `Please sort out what you safely can and tell me what needs me.`;
  const head = `These need a look on ${thing}:`;
  let list = '';
  for (const n of lines) {
    const detail = n.detail ? ` (${n.detail.split(' · ')[0]})` : '';
    const line = `\n- ${n.title}${detail.length > 70 ? '' : detail}`;
    if (head.length + list.length + line.length + ask.length + 2 > ASK_QUESTION_MAX) break;
    list += line;
  }
  return {
    kind: 'ask',
    label: named.length <= ASK_LABEL_MAX ? named : 'Ask for help with these',
    question: `${head}${list}\n${ask}`.slice(0, ASK_QUESTION_MAX),
  };
}

/**
 * The card's one button for its lines that ask, as the screen draws it now (handle-it.md): *Ask {assistant} to handle
 * these*, which hands everything there to the assistant (`looks.handle`; on a Whombat without it the Ask pane opens with
 * `fallback`'s question); while it looks into them no button but “{assistant} is looking into these”, while it takes
 * the steps “{assistant} is on it”; nothing while a step or plan it found waits for the person (the card above has its
 * Go ahead). Null with fewer than two lines that ask.
 */
export interface HandleTheseView {
  /** The button's words; null while the assistant is on it. */
  label: string | null;
  /** The line in its place while the assistant is on it. */
  busy: string | null;
  /** The ask for a Whombat without `looks.handle`: today's question in the Ask pane. */
  fallback: Extract<ThingPageLink, { kind: 'ask' }>;
}

export function handleTheseView(
  asking: readonly Pick<ThingPageNotice, 'title' | 'detail' | 'quiet'>[],
  research: Pick<LookResearch, 'state' | 'fix' | 'plan'> | null | undefined,
  thing: string,
  assistant: string,
): HandleTheseView | null {
  const fallback = handleTheseLink(asking, thing, assistant);
  if (!fallback) return null;
  if (research?.state === 'looking')
    return { label: null, busy: fillDeskWords(LOOK_PLAN_WORDS.looking, { assistant }), fallback };
  if (research?.state === 'fixing')
    return { label: null, busy: fillDeskWords(LOOK_PLAN_WORDS.onIt, { assistant }), fallback };
  if (research?.state === 'found' && (research.fix || research.plan?.length)) return null;
  return { label: fallback.label, busy: null, fallback };
}

/* What Whombat watches (QN-15) ------------------------------------------------------------------------------------- */

export interface WatchExceptionView {
  /** `stopped|subject`, `ignored|`. */
  key: string;
  /** “Garage AP”; for the check as a whole: “Ignored”, “Snoozed”. */
  name: string;
  /** “until it’s back”, “always”. */
  words: string;
  /** Who and when, for a tooltip: “John, 20 Oct”. */
  who: string | null;
  /** What Undo does: watch it again (`stopped`) or take back the ignore or snooze. */
  undo: { kind: 'watch'; check: string; subject?: NoticeSubject } | { kind: 'quiet'; ref: NoticeRef };
  /** Undo's accessible name: “Undo: Garage AP until it’s back”. */
  undoLabel: string;
}

export interface WatchCheckView {
  check: string;
  name: string;
  nature: NoticeNature;
  on: boolean;
  /** “Off since 20 Oct (John)” while switched off; null while on. */
  offLine: string | null;
  exceptions: WatchExceptionView[];
  /** The switch's accessible name: “Watch: Access points and switches going offline”. */
  switchLabel: string;
}

export interface ThingWatchView {
  rows: WatchCheckView[];
  /** Switches and Undo only where they can be changed. */
  mayChange: boolean;
  /** “Nothing to watch here yet.” when there are no checks. */
  empty: string | null;
}

function whoWhen(by: { name: string } | undefined, at: string, timeZone: string, now: number): string {
  const day = formatDate(at, timeZone, { now: toDate(now) });
  return by ? `${by.name}, ${day}` : day;
}

function exceptionView(
  c: ThingWatchCheck,
  e: ThingWatchException,
  timeZone: string,
  now: number,
): WatchExceptionView {
  const name = e.subject?.name ?? (e.state === 'snoozed' ? 'Snoozed' : 'Ignored');
  const words = e.words ?? (e.state === 'stopped' ? QUIET_WORDS.always : '');
  return {
    key: `${e.state}|${e.subject?.id ?? ''}`,
    name,
    words,
    who: whoWhen(e.by, e.at, timeZone, now),
    undo:
      e.state === 'stopped'
        ? { kind: 'watch', check: c.check, ...(e.subject ? { subject: e.subject } : {}) }
        : { kind: 'quiet', ref: e.subject ? { check: c.check, subject: e.subject.id } : { check: c.check } },
    undoLabel: `${QUIET_WORDS.undo}: ${[name, words].filter(Boolean).join(' ')}`,
  };
}

/**
 * What Whombat watches as rows (QN-15): one switch per check in the server's order, “Off since 20 Oct (John)” under
 * one switched off, and under each what is excepted (“Not for: Garage AP until it’s back · Attic AP always”), each with
 * Undo. Look only and guests get the same rows without switches (`mayChange` false).
 */
export function thingWatchView(watch: ThingWatch, timeZone: string, now: number): ThingWatchView {
  const rows = watch.checks.map(
    (c): WatchCheckView => ({
      check: c.check,
      name: c.name,
      nature: c.nature,
      on: c.on,
      offLine: c.on
        ? null
        : c.off
          ? `Off since ${formatDate(c.off.at, timeZone, { now: toDate(now) })}${c.off.by ? ` (${c.off.by.name})` : ''}`
          : 'Off',
      exceptions: c.exceptions.map((e) => exceptionView(c, e, timeZone, now)),
      switchLabel: `Watch: ${c.name}`,
    }),
  );
  return { rows, mayChange: watch.mayChange, empty: rows.length ? null : QUIET_WORDS.watchEmpty };
}

/** The watch list as it looks once a check is switched (QN-13), before the server's answer. */
export function withWatched(
  watch: ThingWatch,
  check: string,
  subject: NoticeSubject | undefined,
  watched: boolean,
  now: number,
): ThingWatch {
  const at = new Date(now).toISOString();
  return {
    ...watch,
    checks: watch.checks.map((c) => {
      if (c.check !== check) return c;
      if (!subject) {
        if (watched) {
          const { off: _off, ...rest } = c;
          return { ...rest, on: true };
        }
        return { ...c, on: false, off: { at } };
      }
      const others = c.exceptions.filter((e) => !(e.state === 'stopped' && e.subject?.id === subject.id));
      return {
        ...c,
        exceptions: watched
          ? others
          : [...others, { subject, state: 'stopped' as const, words: QUIET_WORDS.always, at }],
      };
    }),
  };
}

/** The watch list once an ignore or snooze is taken back (Undo on its exception). */
export function withoutQuietException(watch: ThingWatch, ref: NoticeRef): ThingWatch {
  return {
    ...watch,
    checks: watch.checks.map((c) =>
      c.check !== ref.check
        ? c
        : {
            ...c,
            exceptions: c.exceptions.filter(
              (e) => e.state === 'stopped' || (e.subject?.id ?? '') !== (ref.subject ?? ''),
            ),
          },
    ),
  };
}
