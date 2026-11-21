/**
 * The agent's suggestions get a card, and Acme Desk access follows the token (0.71, CT-327; Whombat
 * automation-recipes.md AR-51…AR-54, report-trackers.md TA-23).
 */
import { describe, expect, it } from 'vitest';
import { inputJsonSchema, MCP_TOOLS } from '../contracts/mcp.js';
import {
  AutomationAssessment,
  AutomationDefinition,
  type AutomationRecipeInput,
  type AutomationStep,
  ReportAssessmentInput,
} from '../domain/automation.js';
import { evaluateCondition } from './expr.js';
import {
  assessmentOffer,
  assessmentQuestion,
  recipeConditionStory,
  recipeDefinition,
  recipeInstructions,
  unassessed,
} from './recipes.js';
import { trackerAccessAsked } from './tracker.js';
import { validateDefinition } from './validate.js';

const GH = { kind: 'github' as const, repo: 'acme/web', events: ['issue_opened' as const] };
const TI = {
  kind: 'tracker' as const,
  connectionId: 'con_trackerdev',
  itemKinds: ['bug' as const, 'feature' as const],
};

const github = (fix: NonNullable<AutomationRecipeInput['fix']>): AutomationRecipeInput => ({
  when: GH,
  job: 'assess',
  instructions: recipeInstructions('assess', GH),
  conversationId: 'cnv_web',
  replyOnGitHub: true,
  fix,
});
const tracker = (over: Partial<AutomationRecipeInput> = {}): AutomationRecipeInput => ({
  when: TI,
  job: 'assess',
  instructions: recipeInstructions('assess', TI),
  conversationId: 'cnv_reports',
  repo: 'lumio/tracker',
  fix: { mode: 'ask' },
  ...over,
});
const def = (r: AutomationRecipeInput) => AutomationDefinition.parse(recipeDefinition(r));
const step = (d: AutomationDefinition, id: string) => {
  const s = d.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};
function holds(d: AutomationDefinition, id: string, scope: Record<string, unknown>): boolean {
  const s = step(d, id);
  if (s.kind !== 'condition') throw new Error(`${id} isn’t a condition`);
  return evaluateCondition(s.if, scope);
}

const assessed = (over: Partial<AutomationAssessment> = {}) =>
  AutomationAssessment.parse({
    kind: 'bug',
    importance: 'high',
    confidence: 'high',
    size: 'small',
    summary: 'Totals round twice.',
    ...over,
  });
const scope = (a: AutomationAssessment, trigger: Record<string, unknown> = {}, item = 'issue') => ({
  trigger: { item, trusted: true, assigned: false, linkedPr: false, ...trigger },
  steps: { ask: { assessment: a } },
  run: { test: false, today: { fix: 0 } },
});
const names = { agent: 'Dusty' };

describe('an assessment says whether it recommends a change (AR-51)', () => {
  it('is optional on the stored shape, absent on older reports', () => {
    expect(
      AutomationAssessment.parse({
        kind: 'bug',
        importance: 'high',
        confidence: 'high',
        size: 'small',
        summary: 'x',
      }),
    ).not.toHaveProperty('recommends');
    expect(assessed({ recommends: 'change' }).recommends).toBe('change');
    expect(AutomationAssessment.safeParse({ ...assessed(), recommends: 'maybe' }).success).toBe(false);
    expect(unassessed().recommends).toBe('nothing');
  });

  it('is required in report_assessment, with its meaning in plain words', () => {
    const input = MCP_TOOLS.report_assessment.input;
    expect(input).toBe(ReportAssessmentInput);
    const report = { kind: 'feature', importance: 'medium', confidence: 'high', size: 'small', summary: 'x' };
    expect(input.safeParse(report).success).toBe(false);
    expect(input.parse({ ...report, recommends: 'change' }).recommends).toBe('change');
    expect(input.safeParse({ ...report, recommends: 'nothing', extra: 1 }).success).toBe(false);
    const schema = inputJsonSchema('report_assessment') as {
      required: string[];
      properties: Record<string, { description?: string; enum?: string[] }>;
    };
    expect(schema.required).toContain('recommends');
    expect(schema.properties.recommends?.enum).toEqual(['change', 'nothing']);
    expect(schema.properties.recommends?.description).toMatch(/^change: you recommend changing the code/);
    expect(MCP_TOOLS.report_assessment.description).toContain(
      'recommends: change when you recommend changing the code — a fix, an improvement or a feature — with fixPlan saying what; nothing for a question, a duplicate, something unclear or a report that needs no change.',
    );
  });

  it('is asked for by every recipe that assesses', () => {
    for (const d of [def(github({ mode: 'ask' })), def(tracker({ fix: undefined }))]) {
      const ask = step(d, 'ask');
      if (ask.kind !== 'dispatch_agent') throw new Error('ask');
      expect(ask.prompt).toContain(
        'whether you recommend changing the code (and if so, what, in the fix plan)',
      );
    }
    const ask = step(def(github({ mode: 'ask' })), 'ask');
    expect(ask.kind === 'dispatch_agent' && ask.prompt).toContain(
      'A bug you report or a change you recommend may be worked on next',
    );
  });

  it('asks the card’s question and starts its title in the case’s words', () => {
    expect(assessmentQuestion(assessed())).toBe('Fix this bug?');
    expect(assessmentOffer(assessed())).toBe('Fix');
    for (const kind of ['feature', 'question', 'not_a_bug', 'duplicate', 'unclear'] as const) {
      expect(assessmentQuestion({ kind })).toBe('Make this change?');
      expect(assessmentOffer({ kind })).toBe('Suggested change for');
    }
  });
});

describe('anything it recommends gets the card (AR-52)', () => {
  const d = def(github({ mode: 'ask', minImportance: 'high' }));

  it('keeps the chain and its order, with plain step names', () => {
    expect(validateDefinition(d).problems).toEqual([]);
    expect(d.steps.map((s) => [s.id, s.name])).toEqual([
      ['ask', 'Assess it'],
      ['comment', 'Comment on GitHub'],
      ['worth_fixing', 'A bug worth fixing or a suggested change?'],
      ['approve', 'Approve it'],
      ['fix', 'Fix it or make the change'],
      ['review', 'Review the work'],
      ['approved', 'Did the review approve it?'],
      ['pr', 'Open the pull request'],
      ['pr_open', 'Is the pull request open?'],
      ['linked', 'Say so on the issue'],
    ]);
  });

  it('takes up a bug important enough, or anything the agent recommends changing', () => {
    expect(step(d, 'worth_fixing')).toMatchObject({
      if: 'trigger.item == "issue" && ((steps.ask.assessment.kind == "bug" && (steps.ask.assessment.importance == "critical" || steps.ask.assessment.importance == "high")) || steps.ask.assessment.recommends == "change")',
    });
    // As before 0.71: an important bug, whatever it recommends (older reports have no `recommends`).
    expect(holds(d, 'worth_fixing', scope(assessed()))).toBe(true);
    expect(holds(d, 'worth_fixing', scope(assessed({ recommends: 'nothing' })))).toBe(true);
    // A bug below the threshold, a feature or an improvement it recommends.
    expect(holds(d, 'worth_fixing', scope(assessed({ importance: 'medium', recommends: 'change' })))).toBe(
      true,
    );
    expect(holds(d, 'worth_fixing', scope(assessed({ kind: 'feature', recommends: 'change' })))).toBe(true);
    expect(holds(d, 'worth_fixing', scope(assessed({ kind: 'not_a_bug', recommends: 'change' })))).toBe(true);
    // Nothing recommended, or said before 0.71: the run ends as before.
    expect(holds(d, 'worth_fixing', scope(assessed({ importance: 'medium' })))).toBe(false);
    expect(holds(d, 'worth_fixing', scope(assessed({ importance: 'low', recommends: 'nothing' })))).toBe(
      false,
    );
    expect(holds(d, 'worth_fixing', scope(assessed({ kind: 'feature', recommends: 'nothing' })))).toBe(false);
    expect(holds(d, 'worth_fixing', scope(assessed({ kind: 'feature' })))).toBe(false);
    expect(holds(d, 'worth_fixing', scope(unassessed()))).toBe(false);
    // Never a pull request, whatever it recommends.
    expect(holds(d, 'worth_fixing', scope(assessed({ recommends: 'change' }), {}, 'pull_request'))).toBe(
      false,
    );
    // Any bug: no importance in the condition.
    const any = def(github({ mode: 'ask', minImportance: 'low' }));
    expect(step(any, 'worth_fixing')).toMatchObject({
      if: 'trigger.item == "issue" && ((steps.ask.assessment.kind == "bug") || steps.ask.assessment.recommends == "change")',
    });
  });

  it('asks on the card in the case’s words, and says what a yes does for a bug and for another change', () => {
    const approve = step(d, 'approve');
    if (approve.kind !== 'request_approval') throw new Error('approve');
    expect(approve.title).toBe('{{steps.ask.assessment.offer}} #{{trigger.number}}: {{trigger.title}}');
    // The pull request's title stays as it was.
    expect(step(d, 'pr')).toMatchObject({ title: 'Fix #{{trigger.number}}: {{trigger.title}}' });
    expect(approve.details.split('\n\n')).toEqual([
      '{{steps.ask.assessment.question}} {{steps.ask.assessment.summary}}',
      'If you say yes, the agent works on feat/issue-{{trigger.number}} in acme/web: for a bug, a failing test first; for another change, tests that cover it.',
      'A fresh review turn checks the work and a pull request is opened that closes the issue. Nothing is merged: that stays with a person.',
    ]);
    const merging = step(def(github({ mode: 'ask', merge: 'checks' })), 'approve');
    expect(merging).toMatchObject({
      details: expect.stringMatching(
        /\n\nA fresh review turn checks the work and a pull request is opened that closes the issue, and it is merged into main once its checks pass\.$/,
      ),
    });
  });

  it('says it in short paragraphs, each one item of at most 280 characters (AR-34), even for a long repository name', () => {
    const long = 'acmecorp-organization/fusebox-backend-ui';
    expect(long).toHaveLength(40);
    const longGitHub = { kind: 'github' as const, repo: long, events: ['issue_opened' as const] };
    const variants = [
      def({ ...github({ mode: 'ask' }), when: longGitHub }),
      def({ ...github({ mode: 'auto', merge: 'checks' }), when: longGitHub }),
      def(tracker({ repo: long })),
    ];
    for (const v of variants) {
      const approve = step(v, 'approve');
      if (approve.kind !== 'request_approval') throw new Error('approve');
      const paragraphs = approve.details.split('\n\n');
      expect(paragraphs).toHaveLength(3);
      expect(paragraphs[1]).toContain(long);
      // The templates are longer than what they render (`{{trigger.number}}`, `{{trigger.ref}}`).
      for (const p of paragraphs) expect(p.length, p).toBeLessThanOrEqual(280);
    }
  });

  it('has the fix turn and a fresh review turn handle a bug and another change', () => {
    const fix = step(d, 'fix');
    const review = step(d, 'review');
    if (fix.kind !== 'dispatch_agent' || review.kind !== 'dispatch_agent') throw new Error('agents');
    expect(fix.prompt).toMatch(
      /^Do what the assessment of issue #\{\{trigger\.number\}\} recommends, in acme\/web\./,
    );
    expect(fix.prompt).toContain(
      'For a bug: first write a test that reproduces it and check that it fails, then fix the bug so the test passes. For another change, such as an improvement or a feature: make the change, with tests that cover it.',
    );
    expect(fix.prompt).toContain('If you can’t do it safely');
    expect(fix.prompt).toContain('commit nothing and say why');
    expect(fix.prompt).toContain(
      'The assessment: {{steps.ask.assessment.line}}. {{steps.ask.assessment.summary}}\nWhat to do: {{steps.ask.assessment.fixPlan}}',
    );
    expect(review.prompt).toMatch(/^Review the work for issue #\{\{trigger\.number\}\}, on feat\/issue-/);
    // The same agent reviews, in a turn of its own.
    expect(review.prompt).toContain('with fresh eyes');
    expect(review.prompt).toContain(
      'For a bug, check that a test reproduces it and that the fix makes it pass; for another change, that it does what the assessment recommends and that tests cover it.',
    );
    expect(review.prompt).toContain('{{steps.ask.assessment.fixPlan}}');
    expect(review.prompt).toContain('Start your reply with “Approve”');
  });

  it('works the same for a Acme Desk report, and nothing goes to the customer', () => {
    const t = def(tracker());
    expect(validateDefinition(t).problems).toEqual([]);
    expect(step(t, 'worth_fixing')).toMatchObject({
      if: expect.stringMatching(
        /^trigger\.item == "report" && .*steps\.ask\.assessment\.recommends == "change"\)$/,
      ),
    });
    const feature = assessed({ kind: 'feature', importance: 'medium', recommends: 'change' });
    expect(holds(t, 'worth_fixing', scope(feature, {}, 'report'))).toBe(true);
    expect(holds(t, 'worth_fixing', scope(assessed({ importance: 'medium' }), {}, 'report'))).toBe(false);
    const approve = step(t, 'approve');
    if (approve.kind !== 'request_approval') throw new Error('approve');
    expect(approve.title).toBe(
      '{{steps.ask.assessment.offer}} {{trigger.connection}} #{{trigger.number}}: {{trigger.title}}',
    );
    expect(step(t, 'pr')).toMatchObject({
      title: 'Fix {{trigger.connection}} #{{trigger.number}}: {{steps.ask.assessment.prTitle}}',
    });
    expect(approve.details).toMatch(
      /^\{\{steps\.ask\.assessment\.question\}\} \{\{steps\.ask\.assessment\.summary\}\}\n\n/,
    );
    expect(approve.details).toContain(
      'If you say yes, the agent works on feat/{{trigger.ref}} in lumio/tracker: for a bug, a failing test first; for another change, tests that cover it.',
    );
    expect(approve.details).toMatch(
      /\n\nA fresh review turn checks the work and a pull request is opened for it\. Nothing is merged and nothing is sent to the customer: that stays with a person\.$/,
    );
  });
});

describe('the threshold is about doing it without asking (AR-53)', () => {
  const d = def(github({ mode: 'auto', minImportance: 'medium', merge: 'checks' }));

  it('fixes only a bug important enough on its own; anything else it recommends asks', () => {
    expect(validateDefinition(d).problems).toEqual([]);
    expect(step(d, 'needs_yes')).toMatchObject({
      if: '!(steps.ask.assessment.kind == "bug" && (steps.ask.assessment.importance == "critical" || steps.ask.assessment.importance == "high" || steps.ask.assessment.importance == "medium") && steps.ask.assessment.confidence == "high" && steps.ask.assessment.size == "small" && trigger.trusted == true && trigger.assigned == false && trigger.linkedPr == false && run.test == false && run.today.fix < 5)',
      else: { skipTo: 'fix' },
    });
    expect(holds(d, 'needs_yes', scope(assessed({ importance: 'medium' })))).toBe(false);
    expect(holds(d, 'needs_yes', scope(assessed({ importance: 'medium', recommends: 'change' })))).toBe(
      false,
    );
    expect(holds(d, 'needs_yes', scope(assessed({ importance: 'low', recommends: 'change' })))).toBe(true);
    expect(holds(d, 'needs_yes', scope(assessed({ kind: 'feature', recommends: 'change' })))).toBe(true);
    expect(holds(d, 'needs_yes', scope(assessed(), { trusted: false }))).toBe(true);
  });

  it('says why in plain words', () => {
    const r = d.recipe as NonNullable<AutomationDefinition['recipe']>;
    const story = (id: string, ok: boolean, a: AutomationAssessment) =>
      recipeConditionStory(r, id, ok, scope(a), names);
    expect(story('needs_yes', false, assessed({ importance: 'medium' }))).toBe(
      'No: everything checks out, so Dusty fixes it on its own.',
    );
    expect(story('needs_yes', true, assessed({ kind: 'feature', recommends: 'change' }))).toBe(
      'Yes, a person decides: Dusty suggests a change, and only bugs of medium importance or more are fixed without asking.',
    );
    expect(story('needs_yes', true, assessed({ importance: 'low', recommends: 'change' }))).toBe(
      'Yes, a person decides: it’s a bug of low importance, and only bugs of medium importance or more are fixed without asking.',
    );
    expect(story('needs_yes', true, assessed({ confidence: 'medium' }))).toBe(
      'Yes, a person decides: Dusty isn’t sure enough.',
    );
  });
});

describe('what the widened check decided, in plain words', () => {
  const r = def(github({ mode: 'ask' })).recipe as NonNullable<AutomationDefinition['recipe']>;
  const story = (ok: boolean, a: AutomationAssessment) =>
    recipeConditionStory(r, 'worth_fixing', ok, scope(a), names);

  it('says what it suggests, or that it recommends no change', () => {
    expect(story(true, assessed())).toBe('Yes: Dusty says it’s a bug of high importance.');
    expect(story(true, assessed({ importance: 'critical', recommends: 'nothing' }))).toBe(
      'Yes: Dusty says it’s a critical bug.',
    );
    expect(story(true, assessed({ importance: 'medium', recommends: 'change' }))).toBe(
      'Yes: Dusty suggests fixing this bug of medium importance.',
    );
    expect(story(true, assessed({ kind: 'feature', recommends: 'change' }))).toBe(
      'Yes: Dusty suggests a change.',
    );
    expect(story(false, assessed({ kind: 'feature', recommends: 'nothing' }))).toBe(
      'No: Dusty says it’s a feature request and recommends no change.',
    );
    expect(story(false, assessed({ kind: 'question' }))).toBe(
      'No: Dusty says it’s a question and recommends no change.',
    );
    expect(story(false, assessed({ importance: 'medium' }))).toBe(
      'No: it’s a bug of medium importance and Dusty recommends no change.',
    );
    expect(story(false, unassessed())).toBe('No: Dusty didn’t say what it is.');
  });
});

describe('trackerAccessAsked (TA-23)', () => {
  const agent = (over: Record<string, unknown> = {}) =>
    ({ id: 'a', kind: 'dispatch_agent', prompt: 'x', ...over }) as AutomationStep;

  it('asks for every agent step that neither writes code nor gives a verdict', () => {
    expect(trackerAccessAsked(agent())).toBe(true);
    expect(trackerAccessAsked(agent({ assessment: true }))).toBe(true);
    expect(trackerAccessAsked(agent({ workspace: { repo: 'lumio/tracker', access: 'read' } }))).toBe(true);
    expect(
      trackerAccessAsked(agent({ workspace: { repo: 'lumio/tracker', branch: 'feat/x', access: 'write' } })),
    ).toBe(false);
    expect(trackerAccessAsked(agent({ verdict: true }))).toBe(false);
    const t = def(tracker());
    expect(t.steps.filter(trackerAccessAsked).map((s) => s.id)).toEqual(['ask']);
    expect(trackerAccessAsked(step(t, 'write_back'))).toBe(false);
    expect(trackerAccessAsked(step(t, 'approve'))).toBe(false);
  });
});
