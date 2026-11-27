/**
 * A tracker's feature request put to the person (3.12, CT-1636…CT-1638; Whombat report-trackers.md TA-41…TA-48): the
 * agent scored it from 1 to 10 and drafted both answers; a `tracker_decision` step posts a `feature_request` card in the
 * report's thread and waits for the person's answer (`tracker.decide`) — approve, approve and build, decline with a
 * reason, or ask the customer — and the customer hears it through the tracker. The card's words are here, so the web
 * and the phone say the same.
 */

import { z } from 'zod';
import { coreTranslator } from '../i18n/catalog.js';
import { FeatureRequestId, PrincipalId } from '../ids.js';
import {
  AssessmentImportance,
  AssessmentSize,
  AutomationId,
  AutomationRunId,
  FEATURE_DECLINE_REASON_MAX,
  FEATURE_VALUE_WHY_MAX,
} from './automation.js';
import { Timestamp } from './common.js';
import { TRACKER_CUSTOMER_REPLY_MAX } from './tracker.js';

/**
 * The person's answer: `approve` (Planned), `build` (Approve and build: In progress, then the automation builds it),
 * `decline` (Not planned, with a reason) or `ask` (a question for the customer: Needs information).
 */
export const FEATURE_DECISION_CHOICES = ['approve', 'build', 'decline', 'ask'] as const;
export const FeatureDecisionChoice = z.enum(FEATURE_DECISION_CHOICES);
export type FeatureDecisionChoice = z.infer<typeof FeatureDecisionChoice>;

/**
 * `waiting` for the person · `decided` (see `choice`) · `replaced` by a newer assessment of the same report · `stopped`:
 * it ended before anyone decided — its run stopped, or its report was closed in the tracker (`note` says so).
 */
export const FeatureRequestState = z.enum(['waiting', 'decided', 'replaced', 'stopped']);
export type FeatureRequestState = z.infer<typeof FeatureRequestState>;

/** The longest message the card shows for a choice: a draft with its signature. */
export const FEATURE_MESSAGE_MAX = TRACKER_CUSTOMER_REPLY_MAX + 200;

/** A feature request as its card shows it, resolved by the runtime. */
export const FeatureRequestView = z.object({
  id: FeatureRequestId,
  runId: AutomationRunId,
  automationId: AutomationId,
  /** The tracker connection's label (“Acme Desk dev”) and the report's number and title. */
  connection: z.string().max(80),
  number: z.number().int().positive(),
  title: z.string().max(300),
  /** The customer's organization (people only, as `TrackerItemView`). */
  organization: z.string().max(200).nullable(),
  /** The agent's name (“Dusty”): who scored it and words what the customer reads. */
  agent: z.string().max(80),
  /** The agent's value from 1 to 10; null when it gave none (the card says “Not scored”). */
  value: z.number().int().min(1).max(10).nullable(),
  valueWhy: z.string().max(FEATURE_VALUE_WHY_MAX),
  /** The agent's one plain sentence of what is asked. */
  summary: z.string().max(300),
  importance: AssessmentImportance,
  size: AssessmentSize,
  /** Exactly what the customer reads if approved, or declined for `declineReason`: the drafts, signed. */
  approvedMessage: z.string().max(FEATURE_MESSAGE_MAX),
  declinedMessage: z.string().max(FEATURE_MESSAGE_MAX),
  declineReason: z.string().max(FEATURE_DECLINE_REASON_MAX),
  /** Whether “Approve and build” is offered: the automation builds what is approved. */
  canBuild: z.boolean(),
  state: FeatureRequestState,
  choice: FeatureDecisionChoice.nullable(),
  /**
   * The person's reason (decline) or question (ask), as they wrote it; on a request that ended undecided, why (“The
   * report was closed.”), else null.
   */
  note: z.string().max(FEATURE_DECLINE_REASON_MAX).nullable(),
  decidedById: PrincipalId.nullable(),
  decidedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type FeatureRequestView = z.infer<typeof FeatureRequestView>;

/** The card a feature request posts in its report's thread: server-made (`request` null: not resolved yet). */
export const FeatureRequestCard = z.object({
  kind: z.literal('feature_request'),
  requestId: FeatureRequestId,
  request: FeatureRequestView.nullable().default(null),
});
export type FeatureRequestCard = z.infer<typeof FeatureRequestCard>;

/** Storage form: by reference, resolved on read. */
export const StoredFeatureRequestCard = z.object({
  kind: z.literal('feature_request'),
  requestId: FeatureRequestId,
});
export type StoredFeatureRequestCard = z.infer<typeof StoredFeatureRequestCard>;

/**
 * `tracker.decide`'s body (TA-45): the choice, and for `decline` the reason (absent: the agent's own `declineReason`)
 * and for `ask` the question (required).
 */
export const TrackerDecideBody = z
  .object({
    choice: FeatureDecisionChoice,
    note: z.string().trim().max(FEATURE_DECLINE_REASON_MAX).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.choice === 'ask' && !body.note)
      ctx.addIssue({ code: 'custom', message: 'Write what you want to ask the customer.', path: ['note'] });
  });
export type TrackerDecideBody = z.infer<typeof TrackerDecideBody>;

/** The tracker status a choice sets (TA-45). */
export function featureDecisionStatus(
  choice: FeatureDecisionChoice,
): 'planned' | 'in_progress' | 'not_planned' | 'needs_information' {
  switch (choice) {
    case 'approve':
      return 'planned';
    case 'build':
      return 'in_progress';
    case 'decline':
      return 'not_planned';
    case 'ask':
      return 'needs_information';
  }
}

/** “7 of 10”; “Not scored” without a value. */
export function featureValueText(value: number | null): string {
  return value === null ? 'Not scored' : `${value} of 10`;
}

/** The card's own words (TA-45): the buttons, the two forms and the line under them. */
/** The feature request card's words, in a locale. */
export function featureRequestWords(locale?: string | null) {
  const tr = coreTranslator(locale);
  return {
    label: tr.t('featureRequest.label'),
    value: tr.t('featureRequest.value'),
    approve: tr.t('featureRequest.approve'),
    build: tr.t('featureRequest.build'),
    decline: tr.t('featureRequest.decline'),
    ask: tr.t('featureRequest.ask'),
    cancel: tr.t('featureRequest.cancel'),
    ifApproved: tr.t('featureRequest.ifApproved'),
    ifDeclined: tr.t('featureRequest.ifDeclined'),
    declineLabel: tr.t('featureRequest.declineLabel'),
    declineHint: (agent: string) => tr.t('featureRequest.declineHint', { agent }),
    declineSend: tr.t('featureRequest.declineSend'),
    askLabel: tr.t('featureRequest.askLabel'),
    askHint: (agent: string) => tr.t('featureRequest.askHint', { agent }),
    askSend: tr.t('featureRequest.askSend'),
    /** Under the buttons: asking the agent is a reply in the thread. */
    askAgent: (agent: string) => tr.t('featureRequest.askAgent', { agent }),
  };
}

export const FEATURE_REQUEST_WORDS = featureRequestWords('en');

/** “From HollowMere College · Acme Desk dev #21”. */
export function featureRequestFrom(
  view: Pick<FeatureRequestView, 'organization' | 'connection' | 'number'>,
): string {
  const where = `${view.connection} #${view.number}`;
  return view.organization ? `From ${view.organization} · ${where}` : where;
}

/**
 * What the card says once it doesn't wait any more (the decider's name, else “You”): “Approved by John · Planned”,
 * “Approved by John · Being built”, “Declined by John · “It only helps one customer.””, “John asked the customer ·
 * “Which file format?””, “Replaced by a newer assessment”, “No longer waiting” (with why, when it says: “No longer
 * waiting · The report was closed.”). Null while it waits.
 */
export function featureRequestOutcome(
  view: Pick<FeatureRequestView, 'state' | 'choice' | 'note' | 'declineReason'>,
  decider: string | null,
): { lead: string; detail: string | null; tone: 'ok' | 'bad' | 'mut' | 'warn' } | null {
  const who = decider ?? 'you';
  switch (view.state) {
    case 'waiting':
      return null;
    case 'replaced':
      return { lead: 'Replaced by a newer assessment', detail: null, tone: 'mut' };
    case 'stopped':
      return { lead: 'No longer waiting', detail: view.note || null, tone: 'mut' };
    case 'decided':
      switch (view.choice) {
        case 'approve':
          return { lead: `Approved by ${who}`, detail: 'Planned', tone: 'ok' };
        case 'build':
          return { lead: `Approved by ${who}`, detail: 'Being built', tone: 'ok' };
        case 'decline': {
          const reason = view.note || view.declineReason;
          return { lead: `Declined by ${who}`, detail: reason ? `“${reason}”` : null, tone: 'bad' };
        }
        case 'ask':
          return {
            lead: decider ? `${decider} asked the customer` : 'You asked the customer',
            detail: view.note ? `“${view.note}”` : null,
            tone: 'warn',
          };
        default:
          return { lead: 'Decided', detail: null, tone: 'mut' };
      }
  }
}
