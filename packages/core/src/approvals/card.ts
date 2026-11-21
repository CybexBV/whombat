/**
 * The one approval card's facts and words (approval-card.md): the thread's card, the approval's Details, the Inbox's
 * row and the phone's approval screen draw an everyday ask from the same pieces, in the same order — who asks and
 * when, the title, what happens to what, the permission it uses, what it still waits for, the exact time *Yes,
 * tonight* means, then the answers, all with equal weight, in one order. Pure.
 */

import type { Approval } from '../domain/approval.js';
import { KEY_CATALOG, type KeyId } from '../keys/catalog.js';
import { type DateInput, formatClock, MONTHS, WEEKDAYS, zonedParts } from '../text/time.js';
import { APPROVAL_ASK_WORDS, type ApprovalView } from './display.js';

export const APPROVAL_CARD_WORDS = {
  /** Above the key's label. */
  permission: 'Permission used',
  /** Where the request doesn't say which key it uses (an Inbox row carries none). */
  notSupplied: 'Not supplied in this request',
  /** Above the conditions not met yet (a deploy's checks, a review). */
  waiting: 'Still waiting for',
  /** “**Yes, tonight** means Thursday, 24 September 2026 at 03:00 · Europe/Amsterdam.” */
  means: 'means',
  /** The fold with the target, the call and the lasting yes. */
  details: 'Details',
  /** The answers' group and the scrolled facts, for screen readers. */
  answersLabel: 'Approval answers',
  contentLabel: 'Approval content',
  /** The answer may have reached the Whombat (the connection dropped after it left): never sent again by itself. */
  unknown: 'Your answer may have gone through.',
  unknownBody: 'Whombat didn’t get a reply. Check what happened before answering again.',
  check: (name: string) => `Ask ${name} to check`,
  /** What *Ask {assistant} to check* says to the assistant, in the person's words. */
  checkText: (title: string) =>
    `Did my answer to “${title}” go through? Please check what happened. Don’t send it again or run it again.`,
  lastReviewed: 'Last reviewed details',
  /** The approval's read states (the Details dialog, the phone's screen). */
  loading: 'Loading the approval…',
  empty: 'No approval to show.',
  emptyBody: 'Open a request from Chat or the Inbox.',
  openInbox: 'Open Inbox',
  failed: 'Couldn’t read the approval.',
  failedRefresh: 'Couldn’t refresh the approval.',
  noSaved: 'There’s no saved copy to show on this device yet.',
  saved: 'Showing the saved details already on this device.',
  retry: 'Try again',
  moreDetail: 'More detail',
  /** Closes the “may have gone through” alert without doing anything. */
  close: 'Close',
} as const;

/** “Change things in connected services” in quotes, or *Not supplied in this request* without a key. */
export function approvalPermissionText(keyId: KeyId | null | undefined): string {
  const def = keyId ? KEY_CATALOG[keyId] : undefined;
  return def ? `“${def.label}”` : APPROVAL_CARD_WORDS.notSupplied;
}

/** “Thursday, 24 September 2026 at 03:00 · Europe/Amsterdam”: an exact moment, its day, year and zone spelled out. */
export function exactMomentText(at: DateInput, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${WEEKDAYS[p.weekday]}, ${p.day} ${MONTHS[p.month - 1]} ${p.year} at ${formatClock(at, timeZone)} · ${timeZone}`;
}

/** What *Yes, tonight* means, before the answers: its label and the exact moment. */
export interface ApprovalTonightView {
  /** “Yes, tonight” */
  label: string;
  /** “means” */
  means: string;
  /** “Thursday, 24 September 2026 at 03:00 · Europe/Amsterdam” */
  at: string;
}

export function approvalTonight(
  at: DateInput | null | undefined,
  timeZone: string,
): ApprovalTonightView | null {
  if (at === null || at === undefined) return null;
  return {
    label: APPROVAL_ASK_WORDS.later,
    means: APPROVAL_CARD_WORDS.means,
    at: exactMomentText(at, timeZone),
  };
}

/** An everyday ask's answer: *Yes, now* (or *Yes, do it*), *Yes, tonight*, *No*. */
export type ApprovalAnswerKey = 'now' | 'later' | 'no';

export interface ApprovalAnswerChoice {
  key: ApprovalAnswerKey;
  label: string;
}

/**
 * The answers in the one order every place uses, all of equal weight: *Yes, now* · *Yes, tonight* · *No* where a later
 * time is offered, *Yes, do it* · *No* where it isn't.
 */
export function approvalAnswerChoices(offersLater: boolean): ApprovalAnswerChoice[] {
  const W = APPROVAL_ASK_WORDS;
  return offersLater
    ? [
        { key: 'now', label: W.now },
        { key: 'later', label: W.later },
        { key: 'no', label: W.no },
      ]
    : [
        { key: 'now', label: W.yes },
        { key: 'no', label: W.no },
      ];
}

/** A condition the approval still waits for, besides the person's yes (which the answers themselves ask). */
export interface ApprovalUnmetView {
  id: string;
  label: string;
  note: string;
}

/**
 * What it still waits for: the conditions not met yet, without *A person says yes* — the question and its answers
 * already ask the person, so no box says “Not yet · you”.
 */
export function approvalUnmet(view: Pick<ApprovalView, 'conditions'>): ApprovalUnmetView[] {
  return view.conditions
    .filter((c) => c.kind !== 'person_approves' && !c.met)
    .map((c) => ({ id: c.id, label: c.label, note: c.note }));
}

/** The facts the card shows before its answers, from a whole approval. */
export interface ApprovalCardFacts {
  /** “Neo needs your OK” */
  status: string;
  /** “14:03”: when it asked. */
  asked: string;
  title: string;
  /** What happens to what, in its steps. */
  happens: string[];
  permission: string;
  unmet: ApprovalUnmetView[];
  tonight: ApprovalTonightView | null;
}

export function approvalCardFacts(
  approval: Pick<Approval, 'keyId' | 'createdAt'>,
  view: Pick<ApprovalView, 'ask' | 'title' | 'whatHappens' | 'conditions' | 'kicker'>,
  options: { timeZone: string; tonight?: DateInput | null },
): ApprovalCardFacts {
  return {
    status: view.ask?.needs ?? view.kicker,
    asked: formatClock(approval.createdAt, options.timeZone),
    title: view.title,
    happens: view.whatHappens.map((s) => s.text),
    permission: approvalPermissionText(approval.keyId),
    unmet: approvalUnmet(view),
    tonight: approvalTonight(options.tonight, options.timeZone),
  };
}
