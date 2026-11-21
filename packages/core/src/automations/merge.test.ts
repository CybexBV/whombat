/** Merging an automation's fix once its checks pass (0.70, CT-326; Whombat automation-recipes.md AR-44…AR-47). */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_KEYS,
  AutomationDefinition,
  type AutomationDefinitionInput,
  AutomationGrant,
  type AutomationRecipeInput,
  AutomationRunStep,
  EXTERNAL_STEP_KINDS,
  REPEATABLE_EXTERNAL_STEP_KINDS,
  STEP_KIND_LABELS,
} from '../domain/automation.js';
import { KEY_CATALOG } from '../keys/catalog.js';
import {
  describeAutomation,
  RECIPE_FIX_MERGE,
  recipeDefinition,
  recipeInstructions,
  recipeIsCurrent,
  recipeOf,
  recipeProblem,
  recipeSentence,
  refreshRecipe,
} from './recipes.js';
import { stepActsIn, stepContentRooms } from './rooms.js';
import { validateDefinition } from './validate.js';

const ROOM = 'cnv_web';
const WHEN = { kind: 'github' as const, repo: 'acme/web', events: ['issue_opened' as const] };

const recipe = (
  fix: Partial<NonNullable<AutomationRecipeInput['fix']>> = {},
  over: Partial<AutomationRecipeInput> = {},
): AutomationRecipeInput => ({
  when: WHEN,
  job: 'assess',
  instructions: recipeInstructions('assess', WHEN),
  conversationId: ROOM,
  replyOnGitHub: true,
  fix: { mode: 'ask', ...fix },
  ...over,
});

const def = (r: AutomationRecipeInput) => AutomationDefinition.parse(recipeDefinition(r));
const names = { agent: 'Dusty', room: '#web' };

const MERGE_STEP = {
  id: 'merge',
  name: 'Merge the fix',
  kind: 'merge_pull_request',
  repo: 'acme/web',
  number: '{{steps.pr.prNumber}}',
  method: 'squash',
  waitMinutes: 24 * 60,
  otherwise: 'fail',
  retries: 0,
};

describe('a recipe that merges its fix', () => {
  it('merges last, after the pull request and the word on the issue', () => {
    const d = def(recipe({ merge: 'checks' }));
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
      'merge',
    ]);
    expect(d.steps.at(-1)).toEqual(MERGE_STEP);
    expect(d.recipe?.fix?.merge).toBe('checks');
  });

  it('merges right after the pull request when it doesn’t answer on GitHub, and when it fixes on its own', () => {
    const quiet = def(recipe({ merge: 'checks' }, { replyOnGitHub: false }));
    expect(quiet.steps.map((s) => s.id).slice(-2)).toEqual(['pr', 'merge']);
    const auto = def(recipe({ mode: 'auto', merge: 'checks' }));
    expect(validateDefinition(auto).problems).toEqual([]);
    expect(auto.steps.at(-1)).toEqual(MERGE_STEP);
  });

  it('says on the approval card that the fix is merged once its checks pass', () => {
    const approve = def(recipe({ merge: 'checks' })).steps.find((s) => s.id === 'approve');
    if (approve?.kind !== 'request_approval') throw new Error('approve');
    expect(approve.details).toMatch(
      /a pull request is opened that closes the issue, and it is merged into main once its checks pass\.$/,
    );
    expect(approve.details).not.toContain('Nothing is merged');
  });

  it('says so in its sentence', () => {
    expect(recipeSentence(def(recipe({ merge: 'checks' })).recipe as never, names)).toMatch(
      /once a person says yes, and merges the fix once its checks pass\.$/,
    );
    const auto = def(recipe({ mode: 'auto', merge: 'checks' }));
    const said = describeAutomation(auto, { agent: 'Dusty', conversationTitle: () => '#web' });
    expect(said).toContain('Dusty assesses it in #web');
    expect(said).toMatch(
      /anything else Dusty suggests waits for a person’s yes, and merges the fix once its checks pass\.$/,
    );
  });

  it('has the form’s words', () => {
    expect(RECIPE_FIX_MERGE).toEqual({
      label: 'Merge the fix into main once its checks pass',
      hint: 'After the review approves it. If checks fail or someone changes the pull request, it waits for you.',
    });
  });

  it('refuses merging without new issues, as fixing does', () => {
    expect(recipeProblem(recipe({ merge: 'checks' }))).toBeNull();
    expect(
      recipeProblem(
        recipe({ merge: 'checks' }, { when: { kind: 'github', repo: 'acme/web', events: ['pr_opened'] } }),
      ),
    ).toBe('Fixing bugs needs new issues: tick New issues.');
  });
});

describe('a recipe that leaves merging to a person', () => {
  it('makes what 0.69 made: no merge step, no merge in the recipe, and the card says nothing is merged', () => {
    const d = def(recipe());
    expect(d.steps.map((s) => s.kind)).not.toContain('merge_pull_request');
    expect(Object.keys(d.recipe?.fix ?? {}).sort()).toEqual(['maxPerDay', 'minImportance', 'mode']);
    const approve = d.steps.find((s) => s.id === 'approve');
    expect(approve).toMatchObject({
      details: expect.stringMatching(/Nothing is merged: that stays with a person\.$/),
    });
    expect(recipeSentence(d.recipe as never, names)).not.toContain('merges');
  });
});

describe('recipeOf and recipeIsCurrent with merging', () => {
  it('keeps a recipe without merging current, through a round trip of its JSON', () => {
    const stored = AutomationDefinition.parse(JSON.parse(JSON.stringify(def(recipe()))));
    expect(recipeOf(stored)).toEqual(stored.recipe);
    expect(recipeIsCurrent(stored)).toBe(true);
    expect(refreshRecipe(stored.recipe as never)).toEqual(stored.recipe);
  });

  it('rebuilds a recipe with merging with the extra step, and it is current', () => {
    const d = def(recipe({ merge: 'checks' }));
    expect(recipeOf(d)?.fix?.merge).toBe('checks');
    expect(recipeIsCurrent(d)).toBe(true);
    const rebuilt = AutomationDefinition.parse(recipeDefinition(d.recipe as AutomationRecipeInput));
    expect(rebuilt).toEqual(d);
  });

  it('stops being its recipe when the merge step and the recipe disagree', () => {
    const merged = def(recipe({ merge: 'checks' }));
    // The step taken out in the step editor: an ordinary definition.
    expect(recipeOf({ ...merged, steps: merged.steps.slice(0, -1) })).toBeNull();
    // Merging ticked in the recipe without the step to do it: not what the recipe makes.
    const plain = def(recipe());
    const fix = plain.recipe?.fix;
    if (!plain.recipe || !fix) throw new Error('recipe');
    expect(recipeOf({ ...plain, recipe: { ...plain.recipe, fix: { ...fix, merge: 'checks' } } })).toBeNull();
    // Another way of merging, or a shorter wait, is a change of shape too.
    const rebased = merged.steps.map((s) =>
      s.kind === 'merge_pull_request' ? { ...s, method: 'rebase' as const } : s,
    );
    expect(recipeOf({ ...merged, steps: rebased })).toBeNull();
    const hurried = merged.steps.map((s) =>
      s.kind === 'merge_pull_request' ? { ...s, waitMinutes: 60 } : s,
    );
    expect(recipeOf({ ...merged, steps: hurried })).toBeNull();
  });
});

describe('a tracker report’s fix (TA-39)', () => {
  const when = { kind: 'tracker' as const, connectionId: 'con_trackerdev', itemKinds: ['bug' as const] };
  const tracker = (fix: NonNullable<AutomationRecipeInput['fix']>): AutomationRecipeInput => ({
    when,
    job: 'assess',
    instructions: recipeInstructions('assess', when),
    conversationId: 'cnv_reports',
    repo: 'lumio/tracker',
    fix,
  });

  it('merges a fix for a customer’s report once its checks pass, when asked', () => {
    expect(recipeProblem(tracker({ mode: 'ask', merge: 'checks' }))).toBeNull();
    const d = def(tracker({ mode: 'ask', merge: 'checks' }));
    expect(d.steps.at(-1)).toMatchObject({
      kind: 'merge_pull_request',
      repo: 'lumio/tracker',
      method: 'squash',
    });
    expect(d.steps.find((s) => s.id === 'approve')).toMatchObject({
      details: expect.stringContaining('merged into main once its checks pass'),
    });
    expect(recipeSentence(d.recipe as never, { ...names, connection: 'Acme Desk dev' })).toContain(
      'merges the fix',
    );
  });

  it('leaves the pull request for a person without it', () => {
    const d = def(tracker({ mode: 'ask' }));
    expect(d.steps.map((s) => s.kind)).not.toContain('merge_pull_request');
    expect(d.steps.find((s) => s.id === 'approve')).toMatchObject({
      details: expect.stringContaining('Nothing is merged and nothing is sent to the customer'),
    });
  });
});

describe('the merge_pull_request step', () => {
  const base = (step: Record<string, unknown>): AutomationDefinitionInput => ({
    version: 1,
    conversationId: ROOM,
    triggers: [{ kind: 'manual' }],
    steps: [
      { id: 'ask', kind: 'dispatch_agent', prompt: 'Fix it', conversation: 'cnv_private' },
      {
        id: 'pr',
        kind: 'open_pull_request',
        repo: 'acme/web',
        branch: 'feat/x',
        title: '{{steps.ask.text}}',
      },
      { id: 'merge', kind: 'merge_pull_request', repo: 'acme/web', number: '{{steps.pr.prNumber}}', ...step },
    ],
  });

  it('squashes, waits a day for the checks and fails the run when it may not merge, by default', () => {
    const v = validateDefinition(base({}));
    expect(v.problems).toEqual([]);
    expect(v.definition?.steps[2]).toEqual({
      id: 'merge',
      kind: 'merge_pull_request',
      repo: 'acme/web',
      number: '{{steps.pr.prNumber}}',
      method: 'squash',
      waitMinutes: 1440,
      otherwise: 'fail',
      retries: 0,
    });
    expect(validateDefinition(base({ method: 'merge', waitMinutes: 5, otherwise: 'skip' })).problems).toEqual(
      [],
    );
  });

  it('refuses a wait out of bounds, an unknown field and a pull request of a later step', () => {
    expect(validateDefinition(base({ waitMinutes: 4 })).ok).toBe(false);
    expect(validateDefinition(base({ waitMinutes: 7 * 24 * 60 + 1 })).ok).toBe(false);
    expect(validateDefinition(base({ method: 'fast-forward' })).ok).toBe(false);
    expect(validateDefinition(base({ base: 'main' })).problems).toEqual(['steps[2]: unknown field “base”.']);
    expect(validateDefinition(base({ number: '{{steps.later.prNumber}}' })).problems).toEqual([
      'steps[2].number: there is no step “later”.',
    ]);
    expect(validateDefinition(base({ number: '{{env.PR}}' })).problems).toEqual([
      'steps[2].number: {{env.PR}} is not something a step can use.',
    ]);
  });

  it('is an external step, not one safe to repeat, posting in the run’s room', () => {
    expect(EXTERNAL_STEP_KINDS).toContain('merge_pull_request');
    expect(REPEATABLE_EXTERNAL_STEP_KINDS).not.toContain('merge_pull_request');
    const d = AutomationDefinition.parse(base({}));
    const merge = d.steps[2];
    if (!merge) throw new Error('merge');
    expect(stepActsIn(merge, ROOM)).toBe(ROOM);
    // It reads the pull request step, which read the agent's private room.
    expect(stepContentRooms(d, ROOM)[2]?.sort()).toEqual([ROOM, 'cnv_private'].sort());
  });

  it('has a label, and a run’s step may be one', () => {
    expect(STEP_KIND_LABELS.merge_pull_request).toBe('Merge a pull request');
    expect(AutomationRunStep.shape.kind.parse('merge_pull_request')).toBe('merge_pull_request');
  });
});

describe('the merge keys', () => {
  it('may be held by an automation, for its repos', () => {
    expect(AUTOMATION_KEYS).toEqual(expect.arrayContaining(['merge', 'merge.main']));
    expect(KEY_CATALOG.merge.label).toBe('Merge');
    expect(KEY_CATALOG['merge.main'].label).toBe('Merge into main');
    expect(AutomationGrant.parse({ keyId: 'merge.main', tier: 'can', repos: ['acme/web'] })).toEqual({
      keyId: 'merge.main',
      tier: 'can',
      repos: ['acme/web'],
    });
    expect(AutomationGrant.safeParse({ keyId: 'deploy', tier: 'can' }).success).toBe(false);
  });
});
