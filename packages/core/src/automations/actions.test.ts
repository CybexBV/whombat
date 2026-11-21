/** Fixing issues the repo's own GitHub Actions opened (0.73, CT-329; Whombat automation-recipes.md AR-55). */
import { describe, expect, it } from 'vitest';
import {
  AutomationAssessment,
  AutomationDefinition,
  type AutomationRecipeInput,
} from '../domain/automation.js';
import { evaluateCondition } from './expr.js';
import {
  GITHUB_ACTIONS_LOGIN,
  RECIPE_FIX_ACTIONS,
  recipeConditionStory,
  recipeDefinition,
  recipeIsCurrent,
  recipeOf,
  recipeProblem,
  recipeSentence,
} from './recipes.js';
import { validateDefinition } from './validate.js';

const WHEN = { kind: 'github' as const, repo: 'acme/web', events: ['issue_opened' as const], bots: true };

const recipe = (
  fix: Partial<NonNullable<AutomationRecipeInput['fix']>> = {},
  over: Partial<AutomationRecipeInput> = {},
): AutomationRecipeInput => ({
  when: WHEN,
  job: 'assess',
  instructions: 'Assess this.',
  conversationId: 'cnv_web',
  replyOnGitHub: true,
  fix: { mode: 'auto', ...fix },
  ...over,
});

const def = (r: AutomationRecipeInput) => AutomationDefinition.parse(recipeDefinition(r));

const bug = AutomationAssessment.parse({
  kind: 'bug',
  importance: 'high',
  confidence: 'high',
  size: 'small',
  summary: 'Fusebox matches the previous release.',
});

/** What the engine evaluates `needs_yes` with: an issue nobody works on, opened by `author`. */
const scope = (author: string, trusted: boolean) => ({
  trigger: { item: 'issue', author, trusted, assigned: false, linkedPr: false },
  steps: { ask: { assessment: bug } },
  run: { test: false, today: { fix: 0 } },
});

function needsYes(d: AutomationDefinition, s: Record<string, unknown>): boolean {
  const step = d.steps.find((x) => x.id === 'needs_yes');
  if (step?.kind !== 'condition') throw new Error('needs_yes');
  return evaluateCondition(step.if, s);
}

const names = { agent: 'Dusty', room: '#web' };

describe('a recipe that trusts the repo’s GitHub Actions', () => {
  it('fixes an issue GitHub Actions opened on its own, and still asks for anyone else outside the repo', () => {
    const d = def(recipe({ trustActions: true }));
    expect(validateDefinition(d).problems).toEqual([]);
    expect(d.recipe?.fix?.trustActions).toBe(true);
    expect(needsYes(d, scope(GITHUB_ACTIONS_LOGIN, false))).toBe(false);
    expect(needsYes(d, scope('octocat', true))).toBe(false);
    expect(needsYes(d, scope('stranger', false))).toBe(true);
    expect(needsYes(d, scope('dependabot[bot]', false))).toBe(true);
    // Every other gate still holds it back.
    expect(
      needsYes(d, { ...scope(GITHUB_ACTIONS_LOGIN, false), run: { test: false, today: { fix: 5 } } }),
    ).toBe(true);
  });

  it('asks for GitHub Actions’ issues when it doesn’t, as before 0.73', () => {
    const d = def(recipe());
    expect(needsYes(d, scope(GITHUB_ACTIONS_LOGIN, false))).toBe(true);
    expect(Object.keys(d.recipe?.fix ?? {})).not.toContain('trustActions');
  });

  it('keeps it only when on, so off makes what 0.72 made', () => {
    const off = def(recipe({ trustActions: false }));
    expect(off).toEqual(def(recipe()));
    expect(recipeOf(off)).not.toBeNull();
    expect(recipeIsCurrent(off)).toBe(true);
    const on = def(recipe({ trustActions: true }));
    expect(recipeOf(on)?.fix?.trustActions).toBe(true);
    expect(recipeIsCurrent(on)).toBe(true);
  });

  it('says in the check why a person decides, naming GitHub Actions when it is off', () => {
    const on = def(recipe({ trustActions: true })).recipe;
    const off = def(recipe()).recipe;
    if (!on || !off) throw new Error('recipe');
    expect(recipeConditionStory(on, 'needs_yes', false, scope(GITHUB_ACTIONS_LOGIN, false), names)).toBe(
      'No: everything checks out, so Dusty fixes it on its own.',
    );
    expect(recipeConditionStory(off, 'needs_yes', true, scope(GITHUB_ACTIONS_LOGIN, false), names)).toBe(
      'Yes, a person decides: GitHub Actions opened the issue, and fixing those on its own is off.',
    );
    expect(recipeConditionStory(on, 'needs_yes', true, scope('stranger', false), names)).toBe(
      'Yes, a person decides: someone without access to the repo opened the issue.',
    );
  });

  it('says so in its sentence', () => {
    const r = def(recipe({ trustActions: true })).recipe;
    if (!r) throw new Error('recipe');
    const sentence = recipeSentence(r, names);
    expect(sentence).toContain('on its own when it’s sure (also in issues GitHub Actions opens)');
    expect(sentence).toContain('anything else Dusty suggests waits');
  });

  it('refuses it without Fix it when sure, or while bots are skipped', () => {
    expect(recipeProblem(recipe({ trustActions: true }))).toBeNull();
    expect(recipeProblem(recipe({ mode: 'ask', trustActions: true }))).toBe(
      'Fixing issues GitHub Actions opened on its own needs Fix it when sure.',
    );
    expect(recipeProblem(recipe({ trustActions: true }, { when: { ...WHEN, bots: false } }))).toBe(
      'Issues GitHub Actions opens start nothing while bots are skipped: untick Bots.',
    );
  });

  it('has the form’s words', () => {
    expect(GITHUB_ACTIONS_LOGIN).toBe('github-actions[bot]');
    expect(RECIPE_FIX_ACTIONS).toEqual({
      label: 'Also fix issues opened by this repo’s GitHub Actions',
      hint: 'Such as a workflow that opens an issue when a new version is out. Leave it off if a workflow copies what other people write into issues.',
    });
  });
});
