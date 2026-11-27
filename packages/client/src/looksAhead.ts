/**
 * Looks ahead in Settings → the assistant (Whombat looks-ahead.md), the same on the web and the phone: whether a Whombat
 * has it (and v2 features: Check now, incoming mail, standing rules, recent checks; then “Keeping an eye on”), its
 * words, a change applied to the view while it saves, what the note says once it saved, plain status labels for recent
 * checks, and the line under a thing kept an eye on. Pure.
 */
import {
  AHEAD_KINDS,
  AHEAD_RULES_MAX,
  type AheadKind,
  aheadKindWords,
  aheadWords,
  type LooksAheadCheckItem,
  type LooksAheadMatter,
  type LooksAheadUpdate,
  type LooksAheadView,
} from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { type DateInput, formatDate } from '@whombat/core/text';
import {
  LOOKS_AHEAD_INBOX_MINOR,
  LOOKS_AHEAD_MATTERS_MINOR,
  LOOKS_AHEAD_MINOR,
  LOOKS_AHEAD_V2_MINOR,
  type ProtocolVersion,
  protocolAtLeast,
} from '@whombat/protocol/session';
import { clientTree } from './i18n/catalog';
import { SETTINGS_AREA_WORDS } from './i18n/messages/chatWork/settings';

/** The part's words: the shared ones, and the few only the apps say, in a locale (English when none). */
export function looksAheadText(locale?: string | null) {
  const shared = aheadWords(locale);
  const kinds = aheadKindWords(locale);
  const w = clientTree(locale, SETTINGS_AREA_WORDS).ahead;
  const labelled = (label: string, what: string) => interpolate(w.labelled, { label, what });
  return {
    ...shared,
    /** Read before a part loaded. */
    loading: w.loading,
    failed: w.failed,
    retry: w.retry,
    /** A change that didn't go through. */
    notSaved: w.notSaved,
    /** A calendar the account names as its own, after its address. */
    primary: w.primary,
    /** A stopped kind's button, for screen readers. */
    turnBackOnLabel: (kind: AheadKind) => labelled(shared.turnBackOn, kinds[kind]),
    /** A standing rule's remove button, for screen readers. */
    removeRuleLabel: (rule: string) => labelled(shared.removeRule, rule),
    /** Link to open a flagged finding's thread in Chat. */
    openThread: w.openThread,
    /** A look through new mail that is going on now. */
    triageChecking: w.triageChecking,
    /** A thing kept an eye on's remove button, for screen readers. */
    removeMatterLabel: (title: string) => labelled(shared.removeMatter, title),
    /** A recent check's feedback: the person stopped a kind of check, or (under a follow-up) the thing kept an eye on. */
    stoppedKind: w.stoppedKind,
    stoppedMatter: w.stoppedMatter,
    notUseful: w.notUseful,
  };
}

export const LOOKS_AHEAD_TEXT = looksAheadText();

/** A thing kept an eye on's remove button, for screen readers: “Remove: Answer from the notary”. */
export function removeMatterLabel(title: string, locale?: string | null): string {
  return looksAheadText(locale).removeMatterLabel(title);
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

/** Whether this Whombat lands unsolicited Looks ahead findings in the Inbox (`looksAhead.promote` / `feedback`). */
export function hasLooksAheadInbox(protocol: ProtocolVersion | null | undefined): boolean {
  return protocolAtLeast(protocol, LOOKS_AHEAD_INBOX_MINOR);
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
export function looksAheadSavedText(
  view: LooksAheadView,
  update: LooksAheadUpdate,
  locale?: string | null,
): string {
  const shared = aheadWords(locale);
  if ('calendar' in update) {
    const name = view.calendars.find((c) => c.key === update.calendar)?.name || shared.calendars;
    return shared.calendarSwitched(name, update.on);
  }
  if ('kind' in update) return shared.kindSwitched(update.kind, update.on);
  if ('mailOn' in update) return shared.mailSwitched(update.mailOn);
  if ('addRule' in update) return shared.ruleAdded;
  if ('removeRule' in update) return shared.ruleRemoved;
  if ('removeMatter' in update) return shared.matterRemoved;
  return shared.switched(update.on);
}

/** A calendar's line under its name: its account, and whether it is the account's main one. */
export function looksAheadCalendarMeta(
  calendar: { account: string; primary: boolean },
  locale?: string | null,
): string {
  const primary = clientTree(locale, SETTINGS_AREA_WORDS).ahead.primary;
  return [calendar.account, calendar.primary ? primary : ''].filter(Boolean).join(' · ');
}

/**
 * The line under a thing kept an eye on: who, whom it waits on, and its date (“The notary · Waiting for an answer · by
 * 20 Dec”). Without a zone the date is the day as written; with one, the day in that zone. The year shows only when it
 * isn't `now`'s (never without `now`).
 */
export function matterLine(
  matter: Pick<LooksAheadMatter, 'who' | 'waitingOn' | 'due'>,
  timeZone?: string,
  now?: DateInput,
  locale?: string | null,
): string {
  const shared = aheadWords(locale);
  const due = matter.due ? matterDueDate(matter.due, timeZone, now, locale) : '';
  return [matter.who?.trim() ?? '', shared.matterWaiting[matter.waitingOn], due ? shared.matterDue(due) : '']
    .filter(Boolean)
    .join(' · ');
}

/** `20 Dec`, or '' for a date that can't be read. */
function matterDueDate(
  due: string,
  timeZone: string | undefined,
  now: DateInput | undefined,
  locale?: string | null,
): string {
  const year = now === undefined ? ('never' as const) : ('auto' as const);
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(due);
  // A bare day, or no zone to read a moment in: the calendar day as written, read at noon UTC so no zone moves it.
  if (day && (!timeZone || due.length === 10)) {
    const at = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12));
    return formatDate(at, 'UTC', { year, now }, locale);
  }
  const at = new Date(due);
  if (Number.isNaN(at.getTime())) return '';
  return formatDate(at, timeZone ?? 'UTC', { year, now }, locale);
}

/**
 * A recent row's first words when it is a look through new mail (“Looked through 42 new mails, 2 to check”) or a
 * follow-up (“Follow-up”), or null for an ordinary check (`looksAheadCheckMeta` says those).
 */
export function looksAheadRecentLabel(
  item: Pick<LooksAheadCheckItem, 'of' | 'count' | 'picked'>,
  locale?: string | null,
): string | null {
  const shared = aheadWords(locale);
  if (item.of === 'triage') return shared.recentTriage(item.count ?? 0, item.picked ?? 0);
  if (item.of === 'matter') return shared.recentMatter;
  return null;
}

/**
 * Plain status line for one row in Settings → Looks ahead → Recent checks. A look through new mail says what it looked
 * through and picked; a follow-up says so instead of its stage.
 */
export function looksAheadCheckMeta(
  item: Pick<LooksAheadCheckItem, 'stage' | 'state' | 'kind' | 'feedback' | 'of' | 'count' | 'picked'>,
  locale?: string | null,
): string {
  const w = clientTree(locale, SETTINGS_AREA_WORDS).ahead;
  if (item.of === 'triage') {
    // A look's own words say what came of it once it ended.
    if (item.state === 'checking') return w.triageChecking;
    if (item.state === 'failed') return `${w.triageChecking} · ${w.couldntFinish}`;
    return aheadWords(locale).recentTriage(item.count ?? 0, item.picked ?? 0);
  }
  const origin = looksAheadRecentLabel(item, locale) ?? w.stage[item.stage];
  let outcome: string;
  if (item.state === 'checking') outcome = w.checkingNow;
  else if (item.state === 'failed') outcome = w.couldntFinish;
  else if (item.state === 'told')
    outcome = item.kind ? `${w.flagged} · ${aheadKindWords(locale)[item.kind]}` : w.flagged;
  else outcome = w.checked;
  // Under a follow-up, “Stop checking for this” stopped keeping an eye on that one thing, not a kind. A mail check's
  // row doesn't say whether its finding was about a matter, so it keeps the kind's words.
  const fb =
    item.feedback === 'not_useful'
      ? w.notUseful
      : item.feedback === 'stop_kind'
        ? item.of === 'matter'
          ? w.stoppedMatter
          : w.stoppedKind
        : '';
  return [origin, outcome, fb].filter(Boolean).join(' · ');
}
