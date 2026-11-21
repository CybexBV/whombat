import { describe, expect, it } from 'vitest';
import { feedbackEndpoints } from '../contracts/feedback.js';
import { FEEDBACK_MCP_TOOLS } from '../contracts/mcp-feedback.js';
import { CARD_KINDS, MessageCard, PostableCard, StoredCard } from '../domain/cards.js';
import {
  AssessmentCard,
  assessmentDetailRows,
  assessmentHeadline,
  evidenceLine,
  FEEDBACK_DECISION_ACTION_LABELS,
  FEEDBACK_REMOVED_TEXT,
  FeedbackAssessment,
  FeedbackAssessmentStatus,
  FeedbackAssessmentSubmission,
  type FeedbackAssessmentSubmissionInput,
  redactedConclusion,
  splitSubmission,
} from '../domain/feedback.js';

const observed = {
  kind: 'observation' as const,
  ref: 'https://example.com/',
  note: 'The dialog shows it.',
  hypothesis: false,
};

const base: FeedbackAssessmentSubmissionInput = {
  outcome: 'duplicate',
  summary: 'Duplicate company-details request.',
  confidence: 'high',
  reproduction: { status: 'attempted_not_reproduced', notes: 'Opened the footer Contact link.' },
  evidence: [observed] as FeedbackAssessmentSubmissionInput['evidence'],
  revision: { inspected: null },
  severity: { level: 'none' },
  duplicateOf: 'FB-2P7K-8T73',
  reply: 'This one is already covered: the footer’s Contact link shows the address and e-mail.',
  bugVerdict: null,
  decision: {
    question: 'Do you want to change the address?',
    options: [
      { label: 'Keep info@', action: 'resolve', recommended: true },
      { label: 'Switch to hello@', action: 'hand_off' },
    ],
  },
};

const issuesOf = (input: unknown) => {
  const r = FeedbackAssessmentSubmission.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('FeedbackAssessmentSubmission (CT-193)', () => {
  it('is the MCP input and splits into a valid assessment and conclusion', () => {
    expect(FEEDBACK_MCP_TOOLS.submit_assessment.input).toBe(FeedbackAssessmentSubmission);
    const { assessment, conclusion } = splitSubmission(FeedbackAssessmentSubmission.parse(base));
    expect(FeedbackAssessment.parse(assessment)).toEqual(assessment);
    expect(assessment).not.toHaveProperty('reply');
    expect(conclusion).toEqual({
      reply: base.reply,
      bugVerdict: null,
      decision: {
        question: 'Do you want to change the address?',
        options: [
          { label: 'Keep info@', action: 'resolve', recommended: true },
          { label: 'Switch to hello@', action: 'hand_off', recommended: false },
        ],
      },
    });
  });

  it('keeps the assessment’s own rules', () => {
    expect(issuesOf({ ...base, duplicateOf: null })).toEqual(['duplicateOf: Name the report it duplicates.']);
  });

  it('needs a reply of at most 700 characters', () => {
    expect(issuesOf({ ...base, reply: ' ' })).toHaveLength(1);
    expect(issuesOf({ ...base, reply: 'x'.repeat(701) })).toHaveLength(1);
  });

  it('says bug only with observed evidence', () => {
    const bug = { ...base, outcome: 'likely_bug', duplicateOf: null, bugVerdict: 'bug' };
    expect(issuesOf(bug)).toEqual([]);
    expect(issuesOf({ ...bug, evidence: [{ ...observed, hypothesis: true }] })[0]).toMatch(/^bugVerdict: /);
  });

  it('refuses a verdict that contradicts the outcome', () => {
    const plain = { ...base, duplicateOf: null };
    expect(issuesOf({ ...plain, outcome: 'feature_request', bugVerdict: 'bug' })[0]).toMatch(/contradicts/);
    expect(issuesOf({ ...plain, outcome: 'confirmed_bug', bugVerdict: 'unsure' })[0]).toMatch(
      /confirmed bug/,
    );
    expect(issuesOf({ ...plain, outcome: 'likely_bug', bugVerdict: 'not_a_bug' })[0]).toMatch(/say unsure/);
    expect(issuesOf({ ...plain, outcome: 'configuration_or_support', bugVerdict: 'not_a_bug' })).toEqual([]);
  });

  it('asks one question with two to four distinct options and at most one recommendation', () => {
    const opts = base.decision?.options ?? [];
    const decision = (options: unknown[]) => ({ ...base, decision: { question: 'Now what?', options } });
    expect(issuesOf(decision(opts.slice(0, 1)))).toHaveLength(1);
    expect(
      issuesOf(decision([...opts, ...opts.map((o) => ({ ...o, label: `${o.label}!` })), opts[0]])),
    ).not.toEqual([]);
    expect(issuesOf(decision(opts.map((o) => ({ ...o, recommended: true }))))).toEqual([
      'decision.options: Recommend at most one option.',
    ]);
    expect(issuesOf(decision([opts[0], { ...opts[1], label: 'KEEP INFO@' }]))).toEqual([
      'decision.options: Give every option its own label.',
    ]);
    expect(issuesOf(decision([opts[0], { ...opts[1], action: 'merge' }]))).toHaveLength(1);
    expect(issuesOf({ ...base, decision: null })).toEqual([]);
  });
});

describe('redactedConclusion', () => {
  it('keeps the verdict and actions and removes the assessor’s words', () => {
    const { conclusion } = splitSubmission(
      FeedbackAssessmentSubmission.parse({ ...base, bugVerdict: 'not_a_bug' }),
    );
    expect(redactedConclusion(conclusion)).toEqual({
      reply: FEEDBACK_REMOVED_TEXT,
      bugVerdict: 'not_a_bug',
      decision: {
        question: FEEDBACK_REMOVED_TEXT,
        options: [
          { label: 'Mark resolved', action: 'resolve', recommended: true },
          { label: FEEDBACK_DECISION_ACTION_LABELS.hand_off, action: 'hand_off', recommended: false },
        ],
      },
    });
  });
});

describe('the assessment card', () => {
  const { assessment, conclusion } = splitSubmission(FeedbackAssessmentSubmission.parse(base));
  const card = {
    kind: 'assessment',
    reportId: 'fbr_contact',
    reference: 'FB-7H4R-45MG',
    type: 'feature',
    status: 'new',
    assessment,
    bugVerdict: conclusion.bugVerdict,
    decision: conclusion.decision,
    decided: null,
    contentRemoved: false,
  };

  it('is a server-made card kind, stored by reference', () => {
    expect(CARD_KINDS).toContain('assessment');
    expect(MessageCard.parse(card)).toEqual(AssessmentCard.parse(card));
    expect(StoredCard.parse({ kind: 'assessment', reportId: 'fbr_contact' })).toEqual({
      kind: 'assessment',
      reportId: 'fbr_contact',
    });
    expect(PostableCard.safeParse(card).success).toBe(false);
  });

  it('folds to a headline and opens to labelled rows', () => {
    expect(assessmentHeadline(assessment)).toBe(
      'Duplicate of FB-2P7K-8T73 · high confidence · severity none',
    );
    expect(assessmentHeadline({ ...assessment, severity: { level: 'unknown', rationale: '' } })).toBe(
      'Duplicate of FB-2P7K-8T73 · high confidence',
    );
    expect(assessmentDetailRows({ ...assessment, uncertainty: 'Unverified: the alias.' })).toEqual([
      { label: 'Summary', text: 'Duplicate company-details request.' },
      { label: 'Reproduction', text: 'Tried, not reproduced · Opened the footer Contact link.' },
      { label: 'Severity', text: 'none' },
      { label: 'Uncertain', text: 'the alias.' },
    ]);
    expect(evidenceLine(assessment.evidence[0] ?? observed)).toBe(
      'Observed · https://example.com/: The dialog shows it.',
    );
  });
});

describe('decisions on reports', () => {
  it('feedback.decide takes an option index', () => {
    expect(feedbackEndpoints.decide.path).toBe('/burrows/:burrow/feedback/reports/:id/decision');
    expect(feedbackEndpoints.decide.body.safeParse({ option: 3 }).success).toBe(true);
    expect(feedbackEndpoints.decide.body.safeParse({ option: 4 }).success).toBe(false);
  });

  it('reads an assessment status without a conclusion yet', () => {
    const status = {
      state: 'done',
      reason: null,
      attempts: 1,
      dispatchId: null,
      updatedAt: '2026-09-30T14:05:00.000Z',
      result: null,
      workspace: null,
    };
    expect(FeedbackAssessmentStatus.parse(status)).toEqual(status);
  });
});
