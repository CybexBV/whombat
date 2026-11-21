import { describe, expect, it } from 'vitest';
import {
  AutomationAssessment,
  AutomationDefinition,
  type AutomationRecipeInput,
} from '../domain/automation.js';
import { evaluateCondition } from './expr.js';
import {
  assessmentLine,
  describeAutomation,
  recipeDefinition,
  recipeOf,
  recipeProblem,
  recipeSentence,
  unassessed,
} from './recipes.js';
import { validateDefinition } from './validate.js';

const recipe = (
  fix: AutomationRecipeInput['fix'],
  over: Partial<AutomationRecipeInput> = {},
): AutomationRecipeInput => ({
  when: { kind: 'github', repo: 'acme/web', events: ['issue_opened'] },
  job: 'assess',
  instructions: 'Assess this.',
  conversationId: 'cnv_web',
  replyOnGitHub: true,
  ...(fix ? { fix } : {}),
  ...over,
});

const def = (r: AutomationRecipeInput) => AutomationDefinition.parse(recipeDefinition(r));

/** Runs a condition step's expression against a scope (what the engine does). */
function holds(d: AutomationDefinition, id: string, scope: Record<string, unknown>): boolean {
  const step = d.steps.find((s) => s.id === id);
  if (step?.kind !== 'condition') throw new Error(`no condition ${id}`);
  return evaluateCondition(step.if, scope);
}

const bug = (over: Partial<AutomationAssessment> = {}) =>
  AutomationAssessment.parse({
    kind: 'bug',
    importance: 'high',
    confidence: 'high',
    size: 'small',
    summary: 'Totals round twice.',
    ...over,
  });

const scope = (
  a: AutomationAssessment,
  trigger: Record<string, unknown> = {},
  run: Record<string, unknown> = {},
) => ({
  trigger: { item: 'issue', trusted: true, assigned: false, linkedPr: false, ...trigger },
  steps: { ask: { assessment: a } },
  run: { test: false, today: { fix: 0 }, ...run },
});

describe('a recipe that fixes bugs', () => {
  it('only assesses without fix, as in 0.66', () => {
    const d = def(recipe(undefined));
    expect(d.steps.map((s) => s.id)).toEqual(['ask', 'comment']);
    // Assessing reports an assessment since 0.68 (CT-324), fixing or not.
    expect(d.steps[0]).toMatchObject({ assessment: true });
  });

  it('asks a person before each fix, then fixes, reviews and opens the pull request', () => {
    const d = def(recipe({ mode: 'ask' }));
    expect(validateDefinition(d).problems).toEqual([]);
    expect(d.steps.map((s) => s.id)).toEqual([
      'ask',
      'comment',
      'worth_fixing',
      'approve',
      'fix',
      'review',
      'approved',
      'pr',
      'pr_open',
      'linked',
    ]);
    expect(d.steps[0]).toMatchObject({ assessment: true });
    expect(d.steps[0]?.kind === 'dispatch_agent' && d.steps[0].prompt).toContain('report_assessment');
    expect(d.steps[1]).toMatchObject({
      text: '{{steps.ask.assessment.heading}}{{steps.ask.reply}}{{steps.ask.assessment.detailsBlock}}',
    });
    expect(d.steps.find((s) => s.id === 'fix')).toMatchObject({
      workspace: { repo: 'acme/web', branch: 'feat/issue-{{trigger.number}}', access: 'write' },
    });
    expect(d.steps.find((s) => s.id === 'review')).toMatchObject({ verdict: true });
    expect(d.steps.find((s) => s.id === 'pr')).toMatchObject({
      body: expect.stringMatching(/^Fixes #\{\{trigger\.number\}\}\./),
    });
    expect(d.limits.runTimeoutMinutes).toBe(7 * 24 * 60);
    expect(recipeOf(d)?.fix?.mode).toBe('ask');
  });

  it('fixes only issues that are bugs at least as important as asked', () => {
    const d = def(recipe({ mode: 'ask', minImportance: 'high' }));
    expect(holds(d, 'worth_fixing', scope(bug()))).toBe(true);
    expect(holds(d, 'worth_fixing', scope(bug({ importance: 'critical' })))).toBe(true);
    expect(holds(d, 'worth_fixing', scope(bug({ importance: 'medium' })))).toBe(false);
    expect(holds(d, 'worth_fixing', scope(bug({ kind: 'feature' })))).toBe(false);
    expect(holds(d, 'worth_fixing', scope(bug(), { item: 'pull_request' }))).toBe(false);
    expect(holds(d, 'worth_fixing', scope(unassessed()))).toBe(false);
    const any = def(recipe({ mode: 'ask', minImportance: 'low' }));
    expect(holds(any, 'worth_fixing', scope(bug({ importance: 'low' })))).toBe(true);
  });

  it('fixes on its own only when every gate passes, and asks otherwise', () => {
    const d = def(recipe({ mode: 'auto', maxPerDay: 3 }));
    expect(d.steps.map((s) => s.id).slice(2, 5)).toEqual(['worth_fixing', 'needs_yes', 'approve']);
    expect(d.steps.find((s) => s.id === 'needs_yes')).toMatchObject({ else: { skipTo: 'fix' } });
    // `needs_yes` holds when a person must say yes.
    expect(holds(d, 'needs_yes', scope(bug()))).toBe(false);
    expect(holds(d, 'needs_yes', scope(bug({ confidence: 'medium' })))).toBe(true);
    expect(holds(d, 'needs_yes', scope(bug({ size: 'large' })))).toBe(true);
    expect(holds(d, 'needs_yes', scope(bug(), { trusted: false }))).toBe(true);
    expect(holds(d, 'needs_yes', scope(bug(), { assigned: true }))).toBe(true);
    expect(holds(d, 'needs_yes', scope(bug(), { linkedPr: true }))).toBe(true);
    expect(holds(d, 'needs_yes', scope(bug(), {}, { test: true }))).toBe(true);
    expect(holds(d, 'needs_yes', scope(bug(), {}, { today: { fix: 2 } }))).toBe(false);
    expect(holds(d, 'needs_yes', scope(bug(), {}, { today: { fix: 3 } }))).toBe(true);
    expect(validateDefinition(d).problems).toEqual([]);
  });

  it('leaves the issue comments out unless it answers on GitHub', () => {
    const d = def(recipe({ mode: 'ask' }, { replyOnGitHub: false }));
    expect(d.steps.map((s) => s.id)).not.toContain('linked');
  });

  it('refuses what it can’t do', () => {
    expect(
      recipeProblem(
        recipe({ mode: 'ask' }, { when: { kind: 'github', repo: 'acme/web', events: ['pr_opened'] } }),
      ),
    ).toMatch(/New issues/);
    expect(recipeProblem(recipe({ mode: 'auto' }))).toBeNull();
  });

  it('says what it does', () => {
    const names = { agent: 'Dusty', room: '#web' };
    const ask = recipeSentence(def(recipe({ mode: 'ask' })).recipe as never, names);
    expect(ask).toMatch(
      /^When a new issue is opened on acme\/web, Dusty assesses it in #web and comments on GitHub/,
    );
    expect(ask).toContain('the changes Dusty suggests once a person says yes');
    const auto = recipeSentence(
      def(recipe({ mode: 'auto', minImportance: 'critical' })).recipe as never,
      names,
    );
    expect(auto).toContain('fixes critical bugs on its own when it’s sure');
    expect(auto).toContain('anything else Dusty suggests waits');
  });
});

describe('assessments', () => {
  it('reads as one line', () => {
    expect(assessmentLine(bug())).toBe('Bug · high importance · sure · small fix');
    expect(
      assessmentLine(bug({ kind: 'duplicate', duplicateOf: 12, confidence: 'medium', importance: 'low' })),
    ).toBe('Duplicate of #12 · low importance · fairly sure');
    expect(assessmentLine(unassessed())).toBe('Not assessed');
  });

  it('is a verdict or an assessment, not both', () => {
    const d = def(recipe({ mode: 'ask' }));
    const both = {
      ...d,
      recipe: undefined,
      steps: d.steps.map((s) => (s.id === 'ask' ? { ...s, verdict: true } : s)),
    };
    expect(validateDefinition(both).problems).toEqual([
      'steps[0]: an agent gives a verdict or an assessment, not both.',
    ]);
  });
});

describe('describeAutomation', () => {
  it('says a recipe’s sentence with the agent’s name, else the trigger and the steps', () => {
    const d = def(recipe({ mode: 'ask' }));
    const names = { agent: 'Dusty', conversationTitle: () => '#web' };
    expect(describeAutomation(d, names)).toContain('Dusty assesses it in #web');
    expect(describeAutomation({ ...d, recipe: undefined }, names)).toMatch(/ · then 10 steps$/);
  });
});
