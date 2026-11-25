/**
 * Looks ahead in Settings → the assistant (Whombat looks-ahead.md), the same on the web and the phone: whether a Whombat
 * has it (and v2 features: Check now, incoming mail, standing rules, recent checks), its words, a change applied to the
 * view while it saves, what the note says once it saved, and plain status labels for recent checks. Pure.
 */
import {
  AHEAD_KIND_WORDS,
  AHEAD_KINDS,
  AHEAD_RULES_MAX,
  type AheadKind,
  LOOKS_AHEAD_WORDS,
  type LooksAheadCheckItem,
  type LooksAheadUpdate,
  type LooksAheadView,
} from '@whombat/core';
import {
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
} as const;

/** Whether this Whombat has Looks ahead's setting (an older one doesn't answer `looksAhead.*`). */
export function hasLooksAhead(protocol: ProtocolVersion | null | undefined): boolean {
  return protocolAtLeast(protocol, LOOKS_AHEAD_MINOR);
}

/** Whether this Whombat supports Looks ahead v2 (`looksAhead.checkNow`, incoming mail, standing rules, recent checks). */
export function hasLooksAheadV2(protocol: ProtocolVersion | null | undefined): boolean {
  return protocolAtLeast(protocol, LOOKS_AHEAD_V2_MINOR);
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

/** Plain status line for one row in Settings → Looks ahead → Recent checks. */
export function looksAheadCheckMeta(
  item: Pick<LooksAheadCheckItem, 'stage' | 'state' | 'kind' | 'feedback'>,
): string {
  const origin = STAGE_LABEL[item.stage];
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
