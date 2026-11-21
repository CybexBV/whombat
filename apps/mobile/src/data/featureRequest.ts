/**
 * A tracker's feature request on the phone (docs/app/decisions/report-trackers.md): the card's view while it waits for
 * the person — its value, what is asked, what the customer reads either way — and once it doesn't wait any more, what
 * was decided, with who decided. Core's `FEATURE_REQUEST_WORDS` and the client's `featureRequest` rules (what goes to
 * `tracker.decide`, the forms, the fold, the toast) are shared with the web. Pure.
 */
import { customerReads, type FeatureReadView, featureValueLabel } from '@whombat/client';
import {
  FEATURE_REQUEST_WORDS,
  type FeatureRequestView,
  featureRequestFrom,
  featureRequestOutcome,
  featureValueText,
  type MessageCard,
  shortNameOf,
} from '@whombat/core';
import type { People } from './people';

/** What TalkBack and VoiceOver say a button does, after its label. */
export const FEATURE_CARD_HINTS = {
  approve: (agent: string) => `${agent} tells the customer it’s planned`,
  build: (agent: string) => `${agent} tells the customer it’s being built, then the automation builds it`,
  decline: (agent: string) => `${agent} tells the customer it won’t be built, and why`,
  ask: (agent: string) => `${agent} asks the customer your question`,
  opensDecline: 'Asks why not first',
  opensAsk: 'Asks what you want to know first',
} as const;

/** What the card shows: the same card waiting and opened from its line, with the outcome in place of the buttons. */
export interface FeatureRequestCardView {
  requestId: string;
  /** Waiting for the person: the buttons, the forms and the hint under them. */
  waiting: boolean;
  /** “Feature request”. */
  label: string;
  /** “7 of 10”, “Not scored”. */
  value: string;
  /** The value chip's name for screen readers: “Value 7 of 10”. */
  valueLabel: string;
  title: string;
  /** “From HollowMere College · Acme Desk dev #21”. */
  from: string;
  summary: string;
  valueWhy: string;
  /** Who scored it and words what the customer reads (“Dusty”). */
  agent: string;
  /** What the customer reads if approved, then if declined; a missing draft is left out (the agent words it later). */
  reads: FeatureReadView[];
  /** “Approve and build” is offered. */
  canBuild: boolean;
  /** The agent's reason not to build it: the decline form starts with it. */
  declineReason: string;
  /** What was decided (`featureRequestOutcome`), with who decided; null while it waits. */
  outcome: { lead: string; detail: string | null; tone: 'ok' | 'bad' | 'mut' | 'warn' } | null;
}

/**
 * Who decided, by short name as the run's step and the web's line say it (“Mara”: “Approved by Mara · Planned”); null
 * before anyone did.
 */
export function featureDeciderName(
  request: Pick<FeatureRequestView, 'decidedById'>,
  people: Pick<People, 'get' | 'name'>,
): string | null {
  if (!request.decidedById) return null;
  const decider = people.get(request.decidedById);
  return decider ? shortNameOf(decider) : people.name(request.decidedById);
}

export function featureRequestCardView(
  request: FeatureRequestView,
  people: Pick<People, 'get' | 'name'>,
): FeatureRequestCardView {
  return {
    requestId: request.id,
    waiting: request.state === 'waiting',
    label: FEATURE_REQUEST_WORDS.label,
    value: featureValueText(request.value),
    valueLabel: featureValueLabel(request.value),
    title: request.title,
    from: featureRequestFrom(request),
    summary: request.summary.trim(),
    valueWhy: request.valueWhy.trim(),
    agent: request.agent,
    reads: customerReads(request),
    canBuild: request.canBuild,
    declineReason: request.declineReason.trim(),
    outcome: featureRequestOutcome(request, featureDeciderName(request, people)),
  };
}

/** A message's feature request card as its row draws it; null for any other card and one not resolved yet. */
export function featureRequestItem(
  card: MessageCard | null | undefined,
  people: Pick<People, 'get' | 'name'>,
): FeatureRequestCardView | null {
  return card?.kind === 'feature_request' && card.request
    ? featureRequestCardView(card.request, people)
    : null;
}
