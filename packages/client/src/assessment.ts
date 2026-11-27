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
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from './i18n/catalog';
import { AUTOMATIONS_AREA_WORDS } from './i18n/messages/chatWork/automations';

/** A bug is bad news, no bug good news, unsure needs a person. */
export const VERDICT_TONE: Record<FeedbackBugVerdict, 'ok' | 'warn' | 'bad'> = {
  bug: 'bad',
  not_a_bug: 'ok',
  unsure: 'warn',
};

/** The card's verdict: `Bug` / `Not a bug` / `Unsure` for bug reports, else the outcome (`Duplicate of FB-…`). */
export function assessmentVerdict(
  card: Pick<AssessmentCard, 'bugVerdict' | 'assessment'>,
  locale?: string | null,
): {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'mut';
} {
  if (card.bugVerdict)
    return { text: FEEDBACK_BUG_VERDICT_LABELS[card.bugVerdict], tone: VERDICT_TONE[card.bugVerdict] };
  const a = card.assessment;
  return {
    text: a.duplicateOf
      ? interpolate(words(locale).duplicateOf, {
          outcome: FEEDBACK_OUTCOME_LABELS[a.outcome],
          reference: a.duplicateOf,
        })
      : FEEDBACK_OUTCOME_LABELS[a.outcome],
    tone: 'mut',
  };
}

const words = (locale?: string | null) => clientTree(locale, AUTOMATIONS_AREA_WORDS).assessment;

/** What happens when a person picks an option (its button's description), in a locale. */
export function decisionActionHints(locale?: string | null): Record<FeedbackDecisionAction, string> {
  const h = words(locale).hints;
  return { hand_off: h.hand_off, resolve: h.resolve, close: h.close, keep_open: h.keep_open };
}

/** What happens when a person picks an option (its button's description). */
export const DECISION_ACTION_HINTS: Record<FeedbackDecisionAction, string> = decisionActionHints();

/** What the pick did, after the label, in a locale: “Mara chose “Won’t fix” · closed · 16:10”. */
export function decisionDone(locale?: string | null): Record<FeedbackDecisionAction, string> {
  const d = words(locale).done;
  return { hand_off: d.hand_off, resolve: d.resolve, close: d.close, keep_open: d.keep_open };
}

/** What the pick did, after the label: “Mara chose “Won’t fix” · closed · 16:10”. */
export const DECISION_DONE: Record<FeedbackDecisionAction, string> = decisionDone();

/** The line a decided card shows instead of its buttons. */
export function decidedLine(
  decided: FeedbackDecisionChoice,
  who: string,
  clock: string,
  locale?: string | null,
): string {
  return interpolate(words(locale).decided, {
    who,
    label: decided.label,
    done: decisionDone(locale)[decided.action],
    clock,
  });
}
