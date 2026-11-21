/**
 * A feedback report's assessment (docs/decisions/feedback.md FB-20 … FB-23) and the assessor's conclusion (CT-193):
 * its short reply in its own words, the bug verdict and the decision it puts to people, with the `assessment` chat card
 * that shows them. Kept apart from `feedback.ts` so `cards.ts` can include the card without importing messages.
 */
import { z } from 'zod';
import { FeedbackReportId, PrincipalId } from '../ids.js';
import { Timestamp } from './common.js';
import {
  FEEDBACK_OUTCOME_LABELS,
  FeedbackOutcome,
  FeedbackReference,
  FeedbackReportStatus,
  FeedbackReportType,
} from './feedback-card.js';

// ---------------------------------------------------------------------------------------------------------
// Assessment (FB-20 … FB-23)

export const FeedbackReproduction = z.enum([
  'not_attempted',
  'attempted_not_reproduced',
  'reproduced',
  'unknown',
]);
export type FeedbackReproduction = z.infer<typeof FeedbackReproduction>;

export const FeedbackSeverity = z.enum(['critical', 'high', 'medium', 'low', 'none', 'unknown']);
export type FeedbackSeverity = z.infer<typeof FeedbackSeverity>;

export const FeedbackEvidence = z.strictObject({
  kind: z.enum(['file', 'test', 'doc', 'observation', 'report']),
  /** `src/billing/invoice.ts:88`, a test name, a doc path, or a short description. */
  ref: z.string().trim().min(1).max(300),
  note: z.string().trim().max(500).default(''),
  /** True when this is a hypothesis from reading code, not something observed. */
  hypothesis: z.boolean(),
});
export type FeedbackEvidence = z.infer<typeof FeedbackEvidence>;

const assessmentShape = {
  outcome: FeedbackOutcome,
  summary: z.string().trim().min(1).max(1200),
  confidence: z.enum(['low', 'medium', 'high']),
  /** What is uncertain and why. */
  uncertainty: z.string().trim().max(800).default(''),
  reproduction: z.strictObject({
    status: FeedbackReproduction,
    notes: z.string().trim().max(1200).default(''),
  }),
  evidence: z.array(FeedbackEvidence).max(20).default([]),
  revision: z.strictObject({
    /** Commit or branch actually inspected; null when no code was read. */
    inspected: z.string().trim().max(80).nullable(),
    /** Version the report says it came from, if any. */
    reported: z.string().trim().max(80).nullable().default(null),
    /** How they differ, when known. */
    mismatch: z.string().trim().max(400).nullable().default(null),
  }),
  severity: z.strictObject({ level: FeedbackSeverity, rationale: z.string().trim().max(600).default('') }),
  missingInformation: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  nextAction: z.string().trim().max(600).default(''),
  duplicateOf: FeedbackReference.nullable().default(null),
  feature: z
    .strictObject({
      goal: z.string().trim().max(800).default(''),
      existingBehavior: z.string().trim().max(800).default(''),
      workarounds: z.string().trim().max(800).default(''),
      scope: z.string().trim().max(800).default(''),
      tradeoffs: z.string().trim().max(800).default(''),
    })
    .nullable()
    .default(null),
};

/** At least one thing the assessor observed itself (not a hypothesis): a file, a test or an observation. */
export function hasObservedEvidence(evidence: readonly FeedbackEvidence[]): boolean {
  return evidence.some(
    (e) => !e.hypothesis && (e.kind === 'file' || e.kind === 'test' || e.kind === 'observation'),
  );
}

type AssessmentFields = z.infer<z.ZodObject<typeof assessmentShape>>;

function assessmentIssues(a: AssessmentFields, ctx: z.RefinementCtx): void {
  if (a.outcome === 'confirmed_bug' && !hasObservedEvidence(a.evidence)) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message:
        'A confirmed bug needs at least one observed (non-hypothesis) file, test or observation. Otherwise use likely_bug.',
    });
  }
  if (a.outcome === 'duplicate' && !a.duplicateOf)
    ctx.addIssue({ code: 'custom', path: ['duplicateOf'], message: 'Name the report it duplicates.' });
  if (a.reproduction.status === 'reproduced' && a.reproduction.notes.length === 0)
    ctx.addIssue({
      code: 'custom',
      path: ['reproduction', 'notes'],
      message: 'Say how it was reproduced.',
    });
}

/** The assessment as stored and shown: the structured findings. Free text is display data only. */
export const FeedbackAssessment = z.strictObject(assessmentShape).superRefine(assessmentIssues);
export type FeedbackAssessment = z.infer<typeof FeedbackAssessment>;

/** What replaces the assessor's words once a report's content is removed (FB-25, FB-F3-11). */
export const FEEDBACK_REMOVED_TEXT = 'Removed with the report’s content.';

/**
 * An assessment with every free-text field removed (FB-F3-11): the outcome, confidence, severity level, reproduction
 * status, evidence kinds and the duplicate reference stay; text a field needs (the summary, an evidence reference,
 * reproduction notes of a reproduced report) becomes `FEEDBACK_REMOVED_TEXT`, the rest is emptied. Still valid.
 */
export function redactedAssessment(a: FeedbackAssessment): FeedbackAssessment {
  return {
    outcome: a.outcome,
    summary: FEEDBACK_REMOVED_TEXT,
    confidence: a.confidence,
    uncertainty: '',
    reproduction: {
      status: a.reproduction.status,
      notes: a.reproduction.status === 'reproduced' ? FEEDBACK_REMOVED_TEXT : '',
    },
    evidence: a.evidence.map((e) => ({
      kind: e.kind,
      ref: FEEDBACK_REMOVED_TEXT,
      note: '',
      hypothesis: e.hypothesis,
    })),
    revision: { inspected: null, reported: null, mismatch: null },
    severity: { level: a.severity.level, rationale: '' },
    missingInformation: [],
    nextAction: '',
    duplicateOf: a.duplicateOf,
    feature: a.feature ? { goal: '', existingBehavior: '', workarounds: '', scope: '', tradeoffs: '' } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The conclusion (CT-193): the assessor's reply, the bug verdict and the decision it asks people for

/** Longest reply an assessor writes: two to four sentences in its own words. */
export const FEEDBACK_REPLY_MAX = 700;

/** For a bug report, always one of three answers: it is a bug, it isn't, or the assessor can't tell yet. */
export const FeedbackBugVerdict = z.enum(['bug', 'not_a_bug', 'unsure']);
export type FeedbackBugVerdict = z.infer<typeof FeedbackBugVerdict>;

export const FEEDBACK_BUG_VERDICT_LABELS: Record<FeedbackBugVerdict, string> = {
  bug: 'Bug',
  not_a_bug: 'Not a bug',
  unsure: 'Unsure',
};

/**
 * What an option of the decision does when a person picks it. The assessor writes the words; the action is always one
 * of these, so a click does something real: `hand_off` asks the owners to approve building the fix, a development turn
 * of the agent (FB-24, OA-16), `resolve` marks it resolved (already done, fixed or answered), `close` closes
 * it (won't do, not a bug, a duplicate), `keep_open` marks it triaged and leaves it open.
 */
export const FeedbackDecisionAction = z.enum(['hand_off', 'resolve', 'close', 'keep_open']);
export type FeedbackDecisionAction = z.infer<typeof FeedbackDecisionAction>;

/** What each action does, in Whombat's words (under the chosen option; the labels of a redacted decision). */
export const FEEDBACK_DECISION_ACTION_LABELS: Record<FeedbackDecisionAction, string> = {
  hand_off: 'Build the fix',
  resolve: 'Mark resolved',
  close: 'Close',
  keep_open: 'Keep open',
};

/** The report status each action but `hand_off` sets (a handoff leaves the status to the approval). */
export const FEEDBACK_DECISION_STATUS: Record<
  Exclude<FeedbackDecisionAction, 'hand_off'>,
  FeedbackReportStatus
> = {
  resolve: 'resolved',
  close: 'closed',
  keep_open: 'triaged',
};

export const FEEDBACK_DECISION_LABEL_MAX = 60;
export const FEEDBACK_DECISION_OPTIONS_MAX = 4;

export const FeedbackDecisionOption = z.strictObject({
  /** The button, in the assessor's words: “Keep info@”, “Switch to hello@”. */
  label: z.string().trim().min(1).max(FEEDBACK_DECISION_LABEL_MAX),
  action: FeedbackDecisionAction,
  /** The assessor's recommendation; at most one option. */
  recommended: z.boolean().default(false),
});
export type FeedbackDecisionOption = z.infer<typeof FeedbackDecisionOption>;

export const FeedbackDecision = z
  .strictObject({
    /** One question to the person: “Do you want to switch the address to hello@?” */
    question: z.string().trim().min(1).max(300),
    options: z.array(FeedbackDecisionOption).min(2).max(FEEDBACK_DECISION_OPTIONS_MAX),
  })
  .superRefine((d, ctx) => {
    if (d.options.filter((o) => o.recommended).length > 1)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Recommend at most one option.' });
    const labels = d.options.map((o) => o.label.toLowerCase());
    if (new Set(labels).size !== labels.length)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Give every option its own label.' });
  });
export type FeedbackDecision = z.infer<typeof FeedbackDecision>;

/** What the assessor concludes, apart from the findings: stored next to the assessment, shown on its card. */
export const FeedbackConclusion = z.strictObject({
  /** The message itself: plain text, first person, the conclusion first. */
  reply: z.string().trim().min(1).max(FEEDBACK_REPLY_MAX),
  /** Required for a bug report (the server checks the report's type); may be given for a feature request. */
  bugVerdict: FeedbackBugVerdict.nullable().default(null),
  /** Null when nothing is left for people to decide. */
  decision: FeedbackDecision.nullable().default(null),
});
export type FeedbackConclusion = z.infer<typeof FeedbackConclusion>;

/** The option a person picked (once per report). */
export const FeedbackDecisionChoice = z.object({
  option: z
    .number()
    .int()
    .min(0)
    .max(FEEDBACK_DECISION_OPTIONS_MAX - 1),
  label: z.string().max(FEEDBACK_DECISION_LABEL_MAX),
  action: FeedbackDecisionAction,
  decidedById: PrincipalId,
  decidedAt: Timestamp,
});
export type FeedbackDecisionChoice = z.infer<typeof FeedbackDecisionChoice>;

/**
 * What the assessor submits with `submit_assessment`: the assessment's fields plus the conclusion's (`reply`,
 * `bugVerdict`, `decision`), checked together. `splitSubmission` separates them for storage.
 */
export const FeedbackAssessmentSubmission = z
  .strictObject({
    ...assessmentShape,
    reply: FeedbackConclusion.shape.reply,
    bugVerdict: FeedbackConclusion.shape.bugVerdict,
    decision: FeedbackConclusion.shape.decision,
  })
  .superRefine((s, ctx) => {
    assessmentIssues(s, ctx);
    if (s.bugVerdict === 'bug' && !hasObservedEvidence(s.evidence))
      ctx.addIssue({
        code: 'custom',
        path: ['bugVerdict'],
        message:
          'Saying it is a bug needs at least one observed (non-hypothesis) file, test or observation. Otherwise say unsure.',
      });
    if (
      s.bugVerdict === 'bug' &&
      (s.outcome === 'feature_request' || s.outcome === 'configuration_or_support')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['bugVerdict'],
        message: `bugVerdict bug contradicts the outcome ${s.outcome}.`,
      });
    if (s.bugVerdict && s.bugVerdict !== 'bug' && s.outcome === 'confirmed_bug')
      ctx.addIssue({
        code: 'custom',
        path: ['bugVerdict'],
        message: 'A confirmed bug is bugVerdict bug.',
      });
    if (s.bugVerdict === 'not_a_bug' && s.outcome === 'likely_bug')
      ctx.addIssue({
        code: 'custom',
        path: ['bugVerdict'],
        message: 'bugVerdict not_a_bug contradicts the outcome likely_bug; say unsure.',
      });
  });
export type FeedbackAssessmentSubmission = z.infer<typeof FeedbackAssessmentSubmission>;
export type FeedbackAssessmentSubmissionInput = z.input<typeof FeedbackAssessmentSubmission>;

/** The stored halves of a submission. */
export function splitSubmission(s: FeedbackAssessmentSubmission): {
  assessment: FeedbackAssessment;
  conclusion: FeedbackConclusion;
} {
  const { reply, bugVerdict, decision, ...assessment } = s;
  return { assessment, conclusion: { reply, bugVerdict, decision } };
}

/**
 * A conclusion with the assessor's words removed (FB-F3-11, like `redactedAssessment`): the verdict and the options'
 * actions stay, the reply and the question become `FEEDBACK_REMOVED_TEXT` and each label says what its action does.
 */
export function redactedConclusion(c: FeedbackConclusion): FeedbackConclusion {
  return {
    reply: FEEDBACK_REMOVED_TEXT,
    bugVerdict: c.bugVerdict,
    decision: c.decision
      ? {
          question: FEEDBACK_REMOVED_TEXT,
          options: c.decision.options.map((o) => ({
            label: FEEDBACK_DECISION_ACTION_LABELS[o.action],
            action: o.action,
            recommended: o.recommended,
          })),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The `assessment` card (CT-193)

/**
 * The card on the assessor's reply: the verdict, the decision with its options (or the one picked) and the full
 * assessment, folded until opened. Server-made only; stored by reference (`StoredAssessmentCard`) and resolved on read,
 * so a decision updates it for everyone. Everything the assessor wrote is plain text: never Markdown, links or mentions.
 */
export const AssessmentCard = z.object({
  kind: z.literal('assessment'),
  reportId: FeedbackReportId,
  reference: FeedbackReference,
  type: FeedbackReportType,
  status: FeedbackReportStatus,
  assessment: FeedbackAssessment,
  bugVerdict: FeedbackBugVerdict.nullable(),
  decision: FeedbackDecision.nullable(),
  decided: FeedbackDecisionChoice.nullable(),
  contentRemoved: z.boolean(),
});
export type AssessmentCard = z.infer<typeof AssessmentCard>;

/** Storage form: by reference, resolved on read. */
export const StoredAssessmentCard = z.object({ kind: z.literal('assessment'), reportId: FeedbackReportId });

export const FEEDBACK_REPRODUCTION_LABELS: Record<FeedbackReproduction, string> = {
  not_attempted: 'Not attempted',
  attempted_not_reproduced: 'Tried, not reproduced',
  reproduced: 'Reproduced',
  unknown: 'Unknown',
};

/** Card header: `ASSESSMENT · FB-7K3Q-9M2X`. */
export function assessmentCardLabel(card: Pick<AssessmentCard, 'reference'>): string {
  return `ASSESSMENT · ${card.reference}`;
}

/** The folded line: `Duplicate of FB-2P7K-8T73 · high confidence · severity none`. */
export function assessmentHeadline(
  a: Pick<FeedbackAssessment, 'outcome' | 'duplicateOf' | 'confidence' | 'severity'>,
): string {
  const outcome = `${FEEDBACK_OUTCOME_LABELS[a.outcome]}${a.duplicateOf ? ` of ${a.duplicateOf}` : ''}`;
  const severity = a.severity.level === 'unknown' ? '' : ` · severity ${a.severity.level}`;
  return `${outcome} · ${a.confidence} confidence${severity}`;
}

/** Agent text without a lead-in that repeats the label it goes under (“Uncertain: Unverified: …”). */
function withoutLead(text: string, leads: readonly string[]): string {
  const m = /^\s*([A-Za-z][A-Za-z ]{0,20}):\s*/.exec(text);
  return m?.[1] && leads.includes(m[1].trim().toLowerCase()) ? text.slice(m[0].length) : text;
}

export interface AssessmentDetailRow {
  label: string;
  text: string;
}

/**
 * The full assessment as labelled rows, in reading order, leaving out what has nothing to say (the layout of FB-29,
 * shared by web and mobile): the summary, a feature request's goal, today, workarounds, scope and trade-offs, the next
 * step, reproduction, severity, what is uncertain or missing, and the code read. The evidence is its own list.
 */
export function assessmentDetailRows(a: FeedbackAssessment): AssessmentDetailRow[] {
  const rows: AssessmentDetailRow[] = [{ label: 'Summary', text: a.summary }];
  if (a.feature) {
    const f = a.feature;
    for (const [label, text] of [
      ['Goal', f.goal],
      ['Today', f.existingBehavior],
      ['Workarounds', f.workarounds],
      ['Scope', f.scope],
      ['Trade-offs', f.tradeoffs],
    ] as const)
      if (text) rows.push({ label, text });
  }
  if (a.nextAction) rows.push({ label: 'Next', text: withoutLead(a.nextAction, ['next', 'next step']) });
  const notes = a.reproduction.notes ? ` · ${a.reproduction.notes}` : '';
  rows.push({
    label: 'Reproduction',
    text: `${FEEDBACK_REPRODUCTION_LABELS[a.reproduction.status]}${notes}`,
  });
  if (a.severity.level !== 'unknown' || a.severity.rationale) {
    const why = a.severity.rationale ? ` · ${withoutLead(a.severity.rationale, ['severity'])}` : '';
    rows.push({ label: 'Severity', text: `${a.severity.level}${why}` });
  }
  if (a.uncertainty)
    rows.push({
      label: 'Uncertain',
      text: withoutLead(a.uncertainty, ['uncertain', 'uncertainty', 'unverified']),
    });
  if (a.missingInformation.length) rows.push({ label: 'Missing', text: a.missingInformation.join('; ') });
  const { inspected, reported, mismatch } = a.revision;
  if (inspected || reported || mismatch)
    rows.push({
      label: 'Code',
      text: [
        inspected ? `read ${inspected}` : 'not read',
        reported ? `reported version ${reported}` : null,
        mismatch,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  return rows;
}

/** One evidence line: `Observed · src/app.ts:12: note` / `Hypothesis · …`. */
export function evidenceLine(e: FeedbackEvidence): string {
  return `${e.hypothesis ? 'Hypothesis' : 'Observed'} · ${e.ref}${e.note ? `: ${e.note}` : ''}`;
}
