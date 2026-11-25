/**
 * Looks ahead in Settings → the assistant (Whombat looks-ahead.md), the same on the web and the phone: whether a Whombat
 * has it, its words, a change applied to the view while it saves, and what the note says once it saved. Pure.
 */
import {
  AHEAD_KIND_WORDS,
  AHEAD_KINDS,
  type AheadKind,
  LOOKS_AHEAD_WORDS,
  type LooksAheadUpdate,
  type LooksAheadView,
} from '@whombat/core';
import { LOOKS_AHEAD_MINOR, type ProtocolVersion, protocolAtLeast } from '@whombat/protocol/session';

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
} as const;

/** Whether this Whombat has Looks ahead's setting (an older one doesn't answer `looksAhead.*`). */
export function hasLooksAhead(protocol: ProtocolVersion | null | undefined): boolean {
  return protocolAtLeast(protocol, LOOKS_AHEAD_MINOR);
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
  return { ...view, on: update.on };
}

/** What the note says once a change saved. */
export function looksAheadSavedText(view: LooksAheadView, update: LooksAheadUpdate): string {
  if ('calendar' in update) {
    const name = view.calendars.find((c) => c.key === update.calendar)?.name || LOOKS_AHEAD_WORDS.calendars;
    return LOOKS_AHEAD_WORDS.calendarSwitched(name, update.on);
  }
  if ('kind' in update) return LOOKS_AHEAD_WORDS.kindSwitched(update.kind, update.on);
  return LOOKS_AHEAD_WORDS.switched(update.on);
}

/** A calendar's line under its name: its account, and whether it is the account's main one. */
export function looksAheadCalendarMeta(calendar: { account: string; primary: boolean }): string {
  return [calendar.account, calendar.primary ? LOOKS_AHEAD_TEXT.primary : ''].filter(Boolean).join(' · ');
}
