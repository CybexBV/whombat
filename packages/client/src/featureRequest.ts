/**
 * A tracker's feature request's card (Whombat report-trackers.md TA-45; docs/app/decisions/report-trackers.md): the
 * rules the web and the phone share — what goes to `tracker.decide`, when a form may be sent, what the customer reads in
 * the fold, the value chip's name and the words the apps add around core's `FEATURE_REQUEST_WORDS`. No DOM and no React
 * Native here.
 */
import {
  FEATURE_DECLINE_REASON_MAX,
  type FeatureDecisionChoice,
  type FeatureRequestView,
  featureRequestWords,
  featureValueText,
  type TrackerDecideBody,
} from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from './i18n/catalog';
import { AUTOMATIONS_AREA_WORDS } from './i18n/messages/chatWork/automations';

const words = (locale?: string | null) => clientTree(locale, AUTOMATIONS_AREA_WORDS).feature;

/** The apps' own words on the card, beside core's, in a locale (English when none). */
export function featureCardText(locale?: string | null) {
  /** The fold with both drafts. */
  return { reads: words(locale).reads };
}

/** The apps' own words on the card, beside core's. */
export const FEATURE_CARD_TEXT = featureCardText();

/** The longest reason or question a person sends (the contract's limit). */
export const FEATURE_NOTE_MAX = FEATURE_DECLINE_REASON_MAX;

/** The card's two forms: a reason to decline, a question for the customer. */
export type FeatureForm = 'decline' | 'ask';

/** One answer the customer could read, under its label (“If you approve, they read”). */
export interface FeatureReadView {
  id: 'approved' | 'declined';
  label: string;
  text: string;
}

/**
 * What `tracker.decide` gets: approving carries no words; a decline the reason as written (the form starts with the
 * agent's own), a question the question, both trimmed.
 */
export function featureDecideBody(choice: FeatureDecisionChoice, text = ''): TrackerDecideBody {
  if (choice === 'approve' || choice === 'build') return { choice };
  const note = text.trim();
  return note ? { choice, note } : { choice };
}

/**
 * Whether a form's words can go: a question needs some, and so does a decline — the form shows the agent's reason, so
 * sending an emptied box would send words the person no longer sees.
 */
export function canSendNote(text: string): boolean {
  const note = text.trim();
  return note.length > 0 && note.length <= FEATURE_NOTE_MAX;
}

/** What the fold shows: each answer the customer could read, with its label; an empty draft is left out. */
export function customerReads(
  view: Pick<FeatureRequestView, 'approvedMessage' | 'declinedMessage'>,
  locale?: string | null,
): FeatureReadView[] {
  const w = featureRequestWords(locale);
  const reads: FeatureReadView[] = [
    { id: 'approved', label: w.ifApproved, text: view.approvedMessage.trim() },
    { id: 'declined', label: w.ifDeclined, text: view.declinedMessage.trim() },
  ];
  return reads.filter((r) => r.text !== '');
}

/** The value chip's name for screen readers: “Value 7 of 10”; “Not scored” without one. */
export function featureValueLabel(value: number | null, locale?: string | null): string {
  return value === null
    ? featureValueText(null, locale)
    : `${featureRequestWords(locale).value} ${featureValueText(value, locale)}`;
}

/** The card's and its line's name: “Feature request: Schedule rollouts for the evening”. */
export function featureRequestLabel(view: Pick<FeatureRequestView, 'title'>, locale?: string | null): string {
  return `${featureRequestWords(locale).label}: ${view.title}`;
}

/** The toast once the answer is kept: what happens next, in a sentence. */
export function featureDecidedToast(
  choice: FeatureDecisionChoice,
  agent: string,
  locale?: string | null,
): string {
  const w = words(locale);
  switch (choice) {
    case 'approve':
      return interpolate(w.approve, { agent });
    case 'build':
      return interpolate(w.build, { agent });
    case 'decline':
      return interpolate(w.decline, { agent });
    case 'ask':
      return interpolate(w.ask, { agent });
  }
}
