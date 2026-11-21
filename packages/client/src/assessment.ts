/**
 * The assessor's `assessment` card (Whombat docs/decisions/feedback.md FB-32; contracts CT-193): what web and mobile
 * share — the verdict's words and tone, what each option does when picked, and the line that says who picked what.
 * No DOM and no React Native here.
 */
import {
  type AssessmentCard,
  FEEDBACK_BUG_VERDICT_LABELS,
  FEEDBACK_OUTCOME_LABELS,
  type FeedbackBugVerdict,
  type FeedbackDecisionAction,
  type FeedbackDecisionChoice,
} from '@whombat/core/domain';

/** A bug is bad news, no bug good news, unsure needs a person. */
export const VERDICT_TONE: Record<FeedbackBugVerdict, 'ok' | 'warn' | 'bad'> = {
  bug: 'bad',
  not_a_bug: 'ok',
  unsure: 'warn',
};

/** The card's verdict: `Bug` / `Not a bug` / `Unsure` for bug reports, else the outcome (`Duplicate of FB-…`). */
export function assessmentVerdict(card: Pick<AssessmentCard, 'bugVerdict' | 'assessment'>): {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'mut';
} {
  if (card.bugVerdict)
    return { text: FEEDBACK_BUG_VERDICT_LABELS[card.bugVerdict], tone: VERDICT_TONE[card.bugVerdict] };
  const a = card.assessment;
  return {
    text: `${FEEDBACK_OUTCOME_LABELS[a.outcome]}${a.duplicateOf ? ` of ${a.duplicateOf}` : ''}`,
    tone: 'mut',
  };
}

/** What happens when a person picks an option (its button's description). */
export const DECISION_ACTION_HINTS: Record<FeedbackDecisionAction, string> = {
  hand_off: 'Asks you to approve handing the report to development.',
  resolve: 'Marks the report resolved.',
  close: 'Closes the report.',
  keep_open: 'Keeps the report open.',
};

/** What the pick did, after the label: “Mara chose “Won’t fix” · closed · 16:10”. */
export const DECISION_DONE: Record<FeedbackDecisionAction, string> = {
  hand_off: 'asked you to approve',
  resolve: 'marked resolved',
  close: 'closed',
  keep_open: 'kept open',
};

/** The line a decided card shows instead of its buttons. */
export function decidedLine(decided: FeedbackDecisionChoice, who: string, clock: string): string {
  return `${who} chose “${decided.label}” · ${DECISION_DONE[decided.action]} · ${clock}`;
}
