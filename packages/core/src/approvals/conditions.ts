/**
 * Approval conditions: evaluated from live state (checks on the head commit, the PR review, a person's
 * decision). The person condition is met exactly while the approval is `approved`.
 */

import type {
  Approval,
  ApprovalCondition,
  ApprovalState,
  ChecksPassCondition,
  ChecksState,
  ReviewApprovedCondition,
} from '../domain/approval.js';
import { coreTranslator } from '../i18n/catalog.js';

export interface LiveChecks {
  headSha: string | null;
  state: ChecksState;
  passed: number;
  total: number;
  /** A run is working on the branch. */
  fixing: boolean;
}

export interface LiveReview {
  state: ReviewApprovedCondition['reviewState'];
  at: string | null;
}

/** Live facts the conditions are evaluated against. Missing facts leave a condition unchanged. */
export interface ApprovalLiveState {
  /** Checks of the head commit (applies to every `checks_pass` condition). */
  checks?: LiveChecks;
  /** Reviews keyed by reviewer principal id. */
  reviews?: Readonly<Record<string, LiveReview>>;
}

export function isChecksMet(c: Pick<ChecksPassCondition, 'state'>): boolean {
  return c.state === 'passed';
}

/** Whether a condition is met given the approval's state. */
export function conditionMet(cond: ApprovalCondition, approvalState: ApprovalState): boolean {
  switch (cond.kind) {
    case 'checks_pass':
      return isChecksMet(cond);
    case 'review_approved':
      return cond.reviewState === 'approved';
    case 'person_approves':
      return approvalState === 'approved';
  }
}

/** Applies live facts and recomputes `met` on every condition. Returns a new approval. */
export function evaluate(approval: Approval, live: ApprovalLiveState = {}): Approval {
  const conditions = approval.conditions.map((cond): ApprovalCondition => {
    let next: ApprovalCondition = cond;
    if (cond.kind === 'checks_pass' && live.checks) {
      next = {
        ...cond,
        headSha: live.checks.headSha ?? cond.headSha,
        state: live.checks.state,
        passed: live.checks.passed,
        total: live.checks.total,
        fixing: live.checks.fixing,
      };
    } else if (cond.kind === 'review_approved') {
      const review = live.reviews?.[cond.reviewerId];
      if (review) next = { ...cond, reviewState: review.state, reviewedAt: review.at };
    }
    return { ...next, met: conditionMet(next, approval.state) };
  });
  return { ...approval, conditions };
}

/** Recomputes `met` for the current approval state without new live facts. */
export function refreshMet(approval: Approval): Approval {
  return {
    ...approval,
    conditions: approval.conditions.map((c) => ({ ...c, met: conditionMet(c, approval.state) })),
  };
}

export function allConditionsMet(approval: Pick<Approval, 'conditions' | 'state'>): boolean {
  return approval.conditions.every((c) => conditionMet(c, approval.state));
}

/** Conditions other than the person's decision ("the first two"). */
export function otherConditions(approval: Pick<Approval, 'conditions'>): ApprovalCondition[] {
  return approval.conditions.filter((c) => c.kind !== 'person_approves');
}

/** True when everything except the person's yes is met: the CTA becomes "Approve and deploy". */
export function otherConditionsMet(approval: Pick<Approval, 'conditions' | 'state'>): boolean {
  return otherConditions(approval).every((c) => conditionMet(c, approval.state));
}

/** Unmet conditions other than the person's decision. */
export function unmetOtherConditions(approval: Pick<Approval, 'conditions' | 'state'>): ApprovalCondition[] {
  return otherConditions(approval).filter((c) => !conditionMet(c, approval.state));
}

/**
 * The executor may run the action now. Only from `idle`: a failed execution is not run again on its own
 * (re-evaluation happens after any activity in the burrow); a person retries with Undo and Approve.
 */
export function readyToExecute(approval: Approval): boolean {
  return (
    approval.state === 'approved' &&
    approval.executedAt === null &&
    approval.execution.state === 'idle' &&
    allConditionsMet(approval)
  );
}

/** Default desktop labels the server writes when it creates conditions (stored in English; `locale` for display). */
export function defaultConditionLabel(
  cond:
    | { kind: 'checks_pass' }
    | { kind: 'review_approved'; reviewerName: string }
    | { kind: 'person_approves' },
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  switch (cond.kind) {
    case 'checks_pass':
      return tr.t('approval.condition.checks_pass');
    case 'review_approved':
      return tr.t('approval.condition.review_approved', { name: cond.reviewerName });
    case 'person_approves':
      return tr.t('approval.condition.person_approves');
  }
}
