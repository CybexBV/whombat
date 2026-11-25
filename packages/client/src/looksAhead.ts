/**
 * Looks ahead in Settings → the assistant (Whombat looks-ahead.md), the same on the web and the phone: whether a Whombat
 * has it (and v2 features: Check now, incoming mail, standing rules, recent checks; then “Keeping an eye on”), its
 * words, a change applied to the view while it saves, what the note says once it saved, plain status labels for recent
 * checks, and the line under a thing kept an eye on. Pure.
 */
import {
  AHEAD_KIND_WORDS,
  AHEAD_KINDS,
  AHEAD_RULES_MAX,
  type AheadKind,
  LOOKS_AHEAD_WORDS,
  type LooksAheadCheckItem,
  type LooksAheadMatter,
  type LooksAheadUpdate,
  type LooksAheadView,
} from '@whombat/core';
import { type DateInput, formatDate } from '@whombat/core/text';
import {
  LOOKS_AHEAD_MATTERS_MINOR,
  LOOKS_AHEAD_MINOR,
  LOOKS_AHEAD_V2_MINOR,
  type ProtocolVersion,
  protocolAtLeast,
} from '@whombat/protocol/session';

/** The part's words: the shared ones, and the few only the apps say. */
export const LOOKS_AHEAD_TEXT = {
  ...LOOKS_AHEAD_WORDS,
  /** Read before a part loaded. */
  loading: 'Loading Looks ahead…',
  failed: 'Couldn’t load Looks ahead. Try again in a moment.',
  retry: 'Try again',
  /** A change that didn't go through. */
  notSaved: 'That didn’t go through. Try again.',
  /** A calendar the account names as its own, after its address. */
  primary: 'Main calendar',
  /** A stopped kind's button, for screen readers. */
  turnBackOnLabel: (kind: AheadKind) => `${LOOKS_AHEAD_WORDS.turnBackOn}: ${AHEAD_KIND_WORDS[kind]}`,
  /** A standing rule's remove button, for screen readers. */
  removeRuleLabel: (rule: string) => `${LOOKS_AHEAD_WORDS.removeRule}: ${rule}`,
  /** Link to open a flagged finding's thread in Chat. */
  openThread: 'Open thread',
  /** A look through new mail that is going on now. */
  triageChecking: 'Looking through new mail',
  /** A thing kept an eye on's remove button, for screen readers. */
  removeMatterLabel: (title: string) => `${LOOKS_AHEAD_WORDS.removeMatter}: ${title}`,
} as const;

/** A thing kept an eye on's remove button, for screen readers: “Remove: Answer from the notary”. */
export function removeMatterLabel(title: string): string {
  return LOOKS_AHEAD_TEXT.removeMatterLabel(title);
}

/** Whether this Whombat has Looks ahead's setting (an older one doesn't answer `looksAhead.*`). */
export function hasLooksAhead(protocol: ProtocolVersion | null | undefined): boolean {
  return protocolAtLeast(protocol, LOOKS_AHEAD_MINOR);
}

/** Whether this Whombat supports Looks ahead v2 (`looksAhead.checkNow`, incoming mail, standing rules, recent checks). */
export function hasLooksAheadV2(protocol: ProtocolVersion | null | undefined): boolean {
  return protocolAtLeast(protocol, LOOKS_AHEAD_V2_MINOR);
}

/** Whether this Whombat shows and removes what Looks ahead keeps an eye on (“Keeping an eye on”). */
export function hasLooksAheadMatters(protocol: ProtocolVersion | null | undefined): boolean {
  return protocolAtLeast(protocol, LOOKS_AHEAD_MATTERS_MINOR);
}

/** The view with one change made, while it saves (the Whombat's answer replaces it). */
export function withLooksAheadChange(view: LooksAheadView, update: LooksAheadUpdate): LooksAheadView {
  if ('calendar' in update)
    return {
      ...view,
      calendars: view.calendars.map((c) => (c.key === update.calendar ? { ...c, on: update.on } : c)),
    };
  if ('kind' in update) {
    const stopped = new Set(view.stopped);
    if (update.on) stopped.delete(update.kind);
    else stopped.add(update.kind);
    return { ...view, stopped: AHEAD_KINDS.filter((k) => stopped.has(k)) };
  }
  if ('mailOn' in update) return { ...view, mailOn: update.mailOn };
  if ('addRule' in update) {
    const rule = update.addRule.trim();
    const existing = view.rules ?? [];
    const exists = existing.some((r) => r.toLowerCase() === rule.toLowerCase());
    return { ...view, rules: exists ? existing : [...existing, rule].slice(-AHEAD_RULES_MAX) };
  }
  if ('removeRule' in update) {
    const target = update.removeRule.trim().toLowerCase();
    return { ...view, rules: (view.rules ?? []).filter((r) => r.toLowerCase() !== target) };
  }
  if ('removeMatter' in update)
    return { ...view, matters: (view.matters ?? []).filter((m) => m.id !== update.removeMatter) };
  return { ...view, on: update.on };
}

/** What the note says once a change saved. */
export function looksAheadSavedText(view: LooksAheadView, update: LooksAheadUpdate): string {
  if ('calendar' in update) {
    const name = view.calendars.find((c) => c.key === update.calendar)?.name || LOOKS_AHEAD_WORDS.calendars;
    return LOOKS_AHEAD_WORDS.calendarSwitched(name, update.on);
  }
  if ('kind' in update) return LOOKS_AHEAD_WORDS.kindSwitched(update.kind, update.on);
  if ('mailOn' in update) return LOOKS_AHEAD_WORDS.mailSwitched(update.mailOn);
  if ('addRule' in update) return LOOKS_AHEAD_WORDS.ruleAdded;
  if ('removeRule' in update) return LOOKS_AHEAD_WORDS.ruleRemoved;
  if ('removeMatter' in update) return LOOKS_AHEAD_WORDS.matterRemoved;
  return LOOKS_AHEAD_WORDS.switched(update.on);
}

/** A calendar's line under its name: its account, and whether it is the account's main one. */
export function looksAheadCalendarMeta(calendar: { account: string; primary: boolean }): string {
  return [calendar.account, calendar.primary ? LOOKS_AHEAD_TEXT.primary : ''].filter(Boolean).join(' · ');
}

const STAGE_LABEL: Readonly<Record<LooksAheadCheckItem['stage'], string>> = {
  early: 'Early check',
  eve: 'Day-before check',
  morning: 'Morning-of check',
  mail: 'Incoming mail',
};

/**
 * The line under a thing kept an eye on: who, whom it waits on, and its date (“The notary · Waiting for an answer · by
 * 20 Dec”). Without a zone the date is the day as written; with one, the day in that zone. The year shows only when it
 * isn't `now`'s (never without `now`).
 */
export function matterLine(
  matter: Pick<LooksAheadMatter, 'who' | 'waitingOn' | 'due'>,
  timeZone?: string,
  now?: DateInput,
): string {
  const due = matter.due ? matterDueDate(matter.due, timeZone, now) : '';
  return [
    matter.who?.trim() ?? '',
    LOOKS_AHEAD_WORDS.matterWaiting[matter.waitingOn],
    due ? LOOKS_AHEAD_WORDS.matterDue(due) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** `20 Dec`, or '' for a date that can't be read. */
function matterDueDate(due: string, timeZone: string | undefined, now: DateInput | undefined): string {
  const year = now === undefined ? ('never' as const) : ('auto' as const);
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(due);
  // A bare day, or no zone to read a moment in: the calendar day as written, read at noon UTC so no zone moves it.
  if (day && (!timeZone || due.length === 10)) {
    const at = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12));
    return formatDate(at, 'UTC', { year, now });
  }
  const at = new Date(due);
  if (Number.isNaN(at.getTime())) return '';
  return formatDate(at, timeZone ?? 'UTC', { year, now });
}

/**
 * A recent row's first words when it is a look through new mail (“Looked through 42 new mails, 2 to check”) or a
 * follow-up (“Follow-up”), or null for an ordinary check (`looksAheadCheckMeta` says those).
 */
export function looksAheadRecentLabel(
  item: Pick<LooksAheadCheckItem, 'of' | 'count' | 'picked'>,
): string | null {
  if (item.of === 'triage') return LOOKS_AHEAD_WORDS.recentTriage(item.count ?? 0, item.picked ?? 0);
  if (item.of === 'matter') return LOOKS_AHEAD_WORDS.recentMatter;
  return null;
}

/**
 * Plain status line for one row in Settings → Looks ahead → Recent checks. A look through new mail says what it looked
 * through and picked; a follow-up says so instead of its stage.
 */
export function looksAheadCheckMeta(
  item: Pick<LooksAheadCheckItem, 'stage' | 'state' | 'kind' | 'feedback' | 'of' | 'count' | 'picked'>,
): string {
  if (item.of === 'triage') {
    // A look's own words say what came of it once it ended.
    if (item.state === 'checking') return LOOKS_AHEAD_TEXT.triageChecking;
    if (item.state === 'failed') return `${LOOKS_AHEAD_TEXT.triageChecking} · Couldn’t finish`;
    return LOOKS_AHEAD_WORDS.recentTriage(item.count ?? 0, item.picked ?? 0);
  }
  const origin = looksAheadRecentLabel(item) ?? STAGE_LABEL[item.stage];
  let outcome: string;
  if (item.state === 'checking') outcome = 'Checking now';
  else if (item.state === 'failed') outcome = 'Couldn’t finish';
  else if (item.state === 'told')
    outcome = item.kind ? `Flagged · ${AHEAD_KIND_WORDS[item.kind]}` : 'Flagged';
  else outcome = 'Checked · nothing to flag';
  const fb =
    item.feedback === 'not_useful'
      ? 'Marked not useful'
      : item.feedback === 'stop_kind'
        ? 'Stopped this kind'
        : '';
  return [origin, outcome, fb].filter(Boolean).join(' · ');
}
