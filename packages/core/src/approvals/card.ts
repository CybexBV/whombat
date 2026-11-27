/**
 * The one approval card's facts and words (approval-card.md): the thread's card, the approval's Details, the Inbox's
 * row and the phone's approval screen draw an everyday ask from the same pieces, in the same order — who asks and
 * when, the title, what happens to what, the permission it uses, what it still waits for, the exact time *Yes,
 * tonight* means, then the answers, all with equal weight, in one order. Pure.
 */

import type { Approval } from '../domain/approval.js';
import { coreTranslator } from '../i18n/catalog.js';
import { KEY_CATALOG, type KeyId, keyLabel } from '../keys/catalog.js';
import {
  type DateInput,
  formatClock,
  MONTHS,
  monthName,
  WEEKDAYS,
  weekdayName,
  zonedParts,
} from '../text/time.js';
import { APPROVAL_ASK_WORDS, type ApprovalView, approvalAskWords } from './display.js';

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

const CARD_WORD_KEYS = [
  'permission',
  'notSupplied',
  'waiting',
  'means',
  'details',
  'answersLabel',
  'contentLabel',
  'unknown',
  'unknownBody',
  'lastReviewed',
  'loading',
  'empty',
  'emptyBody',
  'openInbox',
  'failed',
  'failedRefresh',
  'noSaved',
  'saved',
  'retry',
  'moreDetail',
  'close',
] as const;

/** `APPROVAL_CARD_WORDS` in a locale. */
export function approvalCardWords(locale?: string | null): {
  [K in (typeof CARD_WORD_KEYS)[number]]: string;
} & { check: (name: string) => string; checkText: (title: string) => string } {
  const tr = coreTranslator(locale);
  const words = Object.fromEntries(CARD_WORD_KEYS.map((key) => [key, tr.t(`approval.card.${key}`)])) as {
    [K in (typeof CARD_WORD_KEYS)[number]]: string;
  };
  return {
    ...words,
    check: (name: string) => tr.t('approval.card.check', { name }),
    checkText: (title: string) => tr.t('approval.card.checkText', { title }),
  };
}

/** “Change things in connected services” in quotes, or *Not supplied in this request* without a key. */
export function approvalPermissionText(keyId: KeyId | null | undefined, locale?: string | null): string {
  const def = keyId ? KEY_CATALOG[keyId] : undefined;
  if (!def || !keyId) return coreTranslator(locale).t('approval.card.notSupplied');
  return `“${keyLabel(keyId, locale)}”`;
}

/** “Thursday, 24 September 2026 at 03:00 · Europe/Amsterdam”: an exact moment, its day, year and zone spelled out. */
export function exactMomentText(at: DateInput, timeZone: string, locale?: string | null): string {
  const p = zonedParts(at, timeZone);
  const tr = coreTranslator(locale);
  if (tr.language === 'en')
    return `${WEEKDAYS[p.weekday]}, ${p.day} ${MONTHS[p.month - 1]} ${p.year} at ${formatClock(at, timeZone)} · ${timeZone}`;
  return tr.t('approval.card.moment', {
    weekday: weekdayName(p.weekday, locale),
    day: p.day,
    month: monthName(p.month, locale),
    year: p.year,
    clock: formatClock(at, timeZone),
    zone: timeZone,
  });
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
  locale?: string | null,
): ApprovalTonightView | null {
  if (at === null || at === undefined) return null;
  const tr = coreTranslator(locale);
  return {
    label: tr.t('approval.ask.later'),
    means: tr.t('approval.card.means'),
    at: exactMomentText(at, timeZone, locale),
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
export function approvalAnswerChoices(offersLater: boolean, locale?: string | null): ApprovalAnswerChoice[] {
  const W = locale ? approvalAskWords(locale) : APPROVAL_ASK_WORDS;
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
  options: { timeZone: string; tonight?: DateInput | null; locale?: string | null },
): ApprovalCardFacts {
  return {
    status: view.ask?.needs ?? view.kicker,
    asked: formatClock(approval.createdAt, options.timeZone),
    title: view.title,
    happens: view.whatHappens.map((s) => s.text),
    permission: approvalPermissionText(approval.keyId, options.locale),
    unmet: approvalUnmet(view),
    tonight: approvalTonight(options.tonight, options.timeZone, options.locale),
  };
}
