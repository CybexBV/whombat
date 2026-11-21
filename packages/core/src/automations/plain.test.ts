import { describe, expect, it } from 'vitest';
import {
  AutomationAssessment,
  AutomationDefinition,
  type AutomationRecipeInput,
} from '../domain/automation.js';
import {
  assessmentMarkdown,
  recipeConditionStory,
  recipeDefinition,
  recipeInstructions,
  recipeIsCurrent,
  recipeOf,
  refreshRecipe,
  unassessed,
} from './recipes.js';

const WHEN = { kind: 'github' as const, repo: 'acme/web', events: ['issue_opened' as const] };
const recipe = (over: Partial<AutomationRecipeInput> = {}): AutomationRecipeInput => ({
  when: WHEN,
  job: 'assess',
  instructions: recipeInstructions('assess', WHEN),
  conversationId: 'cnv_web',
  replyOnGitHub: true,
  fix: { mode: 'auto', maxPerDay: 5 },
  ...over,
});
const def = (r: AutomationRecipeInput) => AutomationDefinition.parse(recipeDefinition(r));
const bug = (over: Partial<AutomationAssessment> = {}) =>
  AutomationAssessment.parse({
    kind: 'bug',
    importance: 'high',
    confidence: 'high',
    size: 'small',
    summary: 'Totals round down.',
    ...over,
  });
const names = { agent: 'Dusty' };
const scope = (
  a: AutomationAssessment,
  trigger: Record<string, unknown> = {},
  run: Record<string, unknown> = {},
) => ({
  trigger: { item: 'issue', trusted: true, assigned: false, linkedPr: false, ...trigger },
  steps: { ask: { assessment: a } },
  run: { test: false, today: { fix: 0 }, ...run },
});

describe('the words around an answer', () => {
  it('heads a comment with the assessment and folds the details', () => {
    expect(assessmentMarkdown(bug({ details: 'See `src/total.ts:42`.' }))).toEqual({
      heading: '**Bug · high importance · sure · small fix**\n\n',
      detailsBlock:
        '\n\n<details>\n<summary>Technical details</summary>\n\nSee `src/total.ts:42`.\n\n</details>',
    });
    expect(assessmentMarkdown(unassessed())).toEqual({ heading: '', detailsBlock: '' });
  });
});

describe('a recipe made with older words', () => {
  const older = (d: AutomationDefinition): AutomationDefinition => ({
    ...d,
    steps: d.steps.map((s) =>
      s.kind === 'dispatch_agent' && s.id === 'ask'
        ? { ...s, prompt: `${s.prompt} (0.67 words)`, name: 'Assess' }
        : s.kind === 'github_comment' && s.id === 'comment'
          ? { ...s, text: '**{{steps.ask.assessment.line}}**\n\n{{steps.ask.reply}}' }
          : s,
    ),
  });

  it('is still its recipe, though not current', () => {
    const d = def(recipe());
    expect(recipeIsCurrent(d)).toBe(true);
    const old = older(d);
    expect(recipeOf(old)?.job).toBe('assess');
    expect(recipeIsCurrent(old)).toBe(false);
  });

  it('stops being one when its shape changed', () => {
    const d = def(recipe());
    expect(recipeOf({ ...d, limits: { ...d.limits, maxRunsPerDay: 3 } })).toBeNull();
    expect(recipeOf({ ...d, steps: d.steps.slice(0, -1) })).toBeNull();
  });

  it('gets this version’s default words, keeping a person’s own', () => {
    const legacy =
      'Assess this. For an issue: is it a bug, a feature request or a question; how urgent is it; which part of the code it touches (files and lines); and what should happen next. Keep it short and end with your recommendation.';
    const parsed = def(recipe({ instructions: legacy })).recipe;
    if (!parsed) throw new Error('recipe');
    expect(refreshRecipe(parsed).instructions).toBe(recipeInstructions('assess', WHEN));
    expect(recipeIsCurrent(def(recipe({ instructions: legacy })))).toBe(false);
    const own = def(recipe({ instructions: 'Only tell me if it is urgent.' })).recipe;
    if (!own) throw new Error('recipe');
    expect(refreshRecipe(own).instructions).toBe('Only tell me if it is urgent.');
  });
});

describe('what a check decided, in plain words', () => {
  const r = def(recipe()).recipe as NonNullable<AutomationDefinition['recipe']>;
  it('says why something is or isn’t a bug worth fixing', () => {
    expect(recipeConditionStory(r, 'worth_fixing', true, scope(bug()), names)).toBe(
      'Yes: Dusty says it’s a bug of high importance.',
    );
    expect(recipeConditionStory(r, 'worth_fixing', false, scope(bug({ kind: 'not_a_bug' })), names)).toBe(
      'No: Dusty says it’s not a bug and recommends no change.',
    );
    expect(
      recipeConditionStory(
        r,
        'worth_fixing',
        false,
        scope(bug({ kind: 'duplicate', duplicateOf: 7 })),
        names,
      ),
    ).toBe('No: Dusty says it’s a duplicate of #7 and recommends no change.');
    expect(recipeConditionStory(r, 'worth_fixing', false, scope(bug({ importance: 'low' })), names)).toBe(
      'No: it’s a bug of low importance and Dusty recommends no change.',
    );
    expect(recipeConditionStory(r, 'worth_fixing', false, scope(unassessed()), names)).toBe(
      'No: Dusty didn’t say what it is.',
    );
  });

  it('says why a person decides, or that it goes ahead', () => {
    expect(recipeConditionStory(r, 'needs_yes', false, scope(bug()), names)).toBe(
      'No: everything checks out, so Dusty fixes it on its own.',
    );
    expect(
      recipeConditionStory(
        r,
        'needs_yes',
        true,
        scope(bug({ confidence: 'medium' }), { assigned: true }),
        names,
      ),
    ).toBe('Yes, a person decides: Dusty isn’t sure enough and someone is assigned to it.');
    expect(
      recipeConditionStory(r, 'needs_yes', true, scope(bug(), {}, { test: true, today: { fix: 5 } }), names),
    ).toBe('Yes, a person decides: it’s a test run and 5 fixes already started today.');
    const once = def(recipe({ fix: { mode: 'auto', maxPerDay: 1 } })).recipe;
    if (!once) throw new Error('recipe');
    expect(
      recipeConditionStory(once, 'needs_yes', true, scope(bug(), {}, { today: { fix: 1 } }), names),
    ).toBe('Yes, a person decides: 1 fix already started today.');
    expect(recipeConditionStory(r, 'approved', false, scope(bug()), names)).toBe(
      'No: the review asked for changes, so it stopped here.',
    );
    expect(recipeConditionStory(r, 'ask', true, scope(bug()), names)).toBeNull();
  });
});
