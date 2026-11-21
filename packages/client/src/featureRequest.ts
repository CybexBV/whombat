/**
 * A tracker's feature request's card (Whombat report-trackers.md TA-45; docs/app/decisions/report-trackers.md): the
 * rules the web and the phone share — what goes to `tracker.decide`, when a form may be sent, what the customer reads in
 * the fold, the value chip's name and the words the apps add around core's `FEATURE_REQUEST_WORDS`. No DOM and no React
 * Native here.
 */
import {
  FEATURE_DECLINE_REASON_MAX,
  FEATURE_REQUEST_WORDS,
  type FeatureDecisionChoice,
  type FeatureRequestView,
  featureValueText,
  type TrackerDecideBody,
} from '@whombat/core';

/** The apps' own words on the card, beside core's. */
export const FEATURE_CARD_TEXT = {
  /** The fold with both drafts. */
  reads: 'What the customer reads',
} as const;

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
): FeatureReadView[] {
  const reads: FeatureReadView[] = [
    { id: 'approved', label: FEATURE_REQUEST_WORDS.ifApproved, text: view.approvedMessage.trim() },
    { id: 'declined', label: FEATURE_REQUEST_WORDS.ifDeclined, text: view.declinedMessage.trim() },
  ];
  return reads.filter((r) => r.text !== '');
}

/** The value chip's name for screen readers: “Value 7 of 10”; “Not scored” without one. */
export function featureValueLabel(value: number | null): string {
  return value === null
    ? featureValueText(null)
    : `${FEATURE_REQUEST_WORDS.value} ${featureValueText(value)}`;
}

/** The card's and its line's name: “Feature request: Schedule rollouts for the evening”. */
export function featureRequestLabel(view: Pick<FeatureRequestView, 'title'>): string {
  return `${FEATURE_REQUEST_WORDS.label}: ${view.title}`;
}

/** The toast once the answer is kept: what happens next, in a sentence. */
export function featureDecidedToast(choice: FeatureDecisionChoice, agent: string): string {
  switch (choice) {
    case 'approve':
      return `Approved. ${agent} tells the customer it’s planned.`;
    case 'build':
      return `Approved. ${agent} tells the customer it’s being built.`;
    case 'decline':
      return `Declined. ${agent} tells the customer why.`;
    case 'ask':
      return `${agent} asks the customer. Their answer comes back here.`;
  }
}
