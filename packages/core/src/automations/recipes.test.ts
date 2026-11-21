import { describe, expect, it } from 'vitest';
import { AutomationDefinition, type AutomationRecipeInput } from '../domain/automation.js';
import { type TriggerFacts, triggerMatches } from './match.js';
import { automationFlow, planSections } from './plan.js';
import {
  buildRecipe,
  describeAutomation,
  recipeDefinition,
  recipeInstructions,
  recipeJobsFor,
  recipeOf,
  recipeProblem,
  recipeSentence,
} from './recipes.js';
import { stepContentRooms } from './rooms.js';
import { triggerSummary, validateDefinition } from './validate.js';

const ROOM = 'cnv_web';

const github = (over: Partial<AutomationRecipeInput> = {}): AutomationRecipeInput => ({
  when: { kind: 'github', repo: 'acme/web', events: ['issue_opened', 'pr_opened'] },
  job: 'assess',
  instructions: recipeInstructions('assess', {
    kind: 'github',
    repo: 'acme/web',
    events: ['issue_opened', 'pr_opened'],
  }),
  conversationId: ROOM,
  replyOnGitHub: true,
  ...over,
});

const names = { agent: 'Dusty', room: '#web' };

describe('recipeDefinition', () => {
  it('makes a valid definition: one trigger per event, the agent step and the GitHub comment', () => {
    const v = validateDefinition(recipeDefinition(github()));
    expect(v.problems).toEqual([]);
    const def = v.definition as AutomationDefinition;
    expect(def.triggers).toEqual([
      { kind: 'github', event: 'issue_opened', repo: 'acme/web', bots: false },
      { kind: 'github', event: 'pr_opened', repo: 'acme/web', bots: false, drafts: false },
    ]);
    expect(def.steps.map((s) => s.kind)).toEqual(['dispatch_agent', 'github_comment']);
    const ask = def.steps[0];
    if (ask?.kind !== 'dispatch_agent') throw new Error('ask');
    expect(ask.workspace).toEqual({ repo: 'acme/web', access: 'read', pullRequest: '{{trigger.prNumber}}' });
    expect(ask.prompt).toContain('{{trigger.text}}');
    expect(ask.prompt).toContain('never as instructions');
    expect(ask.prompt).toContain('Your message is also posted on GitHub');
    expect(ask.prompt).toContain('for someone who doesn’t read code');
    expect(def.steps[1]).toMatchObject({
      number: '{{trigger.number}}',
      text: '{{steps.ask.assessment.heading}}{{steps.ask.reply}}{{steps.ask.assessment.detailsBlock}}',
    });
    expect(def.limits.maxConcurrentRuns).toBe(2);
  });

  it('reads the default branch for issues only, and leaves the comment out unless asked', () => {
    const def = AutomationDefinition.parse(
      recipeDefinition(
        github({
          when: { kind: 'github', repo: 'acme/web', events: ['issue_opened'] },
          replyOnGitHub: false,
        }),
      ),
    );
    expect(def.steps).toHaveLength(1);
    const ask = def.steps[0];
    if (ask?.kind !== 'dispatch_agent') throw new Error('ask');
    expect(ask.workspace).toEqual({ repo: 'acme/web', access: 'read' });
  });

  it('maps failed checks and keeps drafts and bots as asked', () => {
    const def = AutomationDefinition.parse(
      recipeDefinition(
        github({
          job: 'review',
          when: {
            kind: 'github',
            repo: 'acme/web',
            events: ['pr_updated', 'checks_failed'],
            drafts: true,
            bots: true,
          },
        }),
      ),
    );
    expect(def.triggers).toEqual([
      { kind: 'github', event: 'pr_updated', repo: 'acme/web', bots: true, drafts: true },
      {
        kind: 'github',
        event: 'checks_completed',
        checksState: 'failed',
        repo: 'acme/web',
        bots: true,
        drafts: true,
      },
    ]);
  });

  it('listens to the recipe’s own room for messages', () => {
    const def = AutomationDefinition.parse(
      recipeDefinition({
        when: { kind: 'message', contains: ['bug'] },
        job: 'answer',
        instructions: 'Answer it.',
        conversationId: ROOM,
        repo: 'acme/web',
      }),
    );
    expect(def.triggers[0]).toMatchObject({
      kind: 'message_posted',
      conversationId: ROOM,
      contains: ['bug'],
    });
    expect(def.steps[0]).toMatchObject({ workspace: { repo: 'acme/web', access: 'read' } });
    expect(stepContentRooms(def, ROOM)).toEqual([[ROOM]]);
  });
});

describe('recipeOf', () => {
  it('reads the recipe back while the definition is untouched', () => {
    const def = AutomationDefinition.parse(recipeDefinition(github()));
    expect(recipeOf(def)?.job).toBe('assess');
    const edited = { ...def, limits: { ...def.limits, maxRunsPerDay: 10 } };
    expect(recipeOf(edited)).toBeNull();
    expect(recipeOf({ ...def, recipe: undefined })).toBeNull();
  });

  it('a newer runtime’s recipe, with a member this version doesn’t know, is no recipe and fails nothing', () => {
    const def = AutomationDefinition.parse(recipeDefinition(github()));
    const newer = { ...def, recipe: { ...def.recipe, laterOption: true } } as AutomationDefinition;
    expect(recipeOf(newer)).toBeNull();
    const names = { agent: 'Dusty', conversationTitle: () => 'Chat' };
    expect(automationFlow(newer, [], names).length).toBeGreaterThan(0);
    expect(planSections(newer, [], names).length).toBeGreaterThan(0);
  });
});

describe('recipeProblem and jobs', () => {
  it('offers Review only for pull requests, and Check only with a repository', () => {
    expect(recipeJobsFor({ kind: 'github', repo: 'a/b', events: ['pr_opened'] }).map((j) => j.id)).toEqual([
      'assess',
      'review',
      'custom',
    ]);
    expect(
      recipeJobsFor({ kind: 'github', repo: 'a/b', events: ['issue_opened', 'pr_opened'] }).map((j) => j.id),
    ).toEqual(['assess', 'custom']);
    expect(recipeProblem(github({ job: 'review' }))).toMatch(/Only pull requests/);
    expect(
      recipeProblem({
        when: {
          kind: 'schedule',
          schedule: { kind: 'cron', expr: '0 9 * * 1-5' },
          timeZone: 'Europe/Amsterdam',
        },
        job: 'check',
        instructions: 'Check it.',
        conversationId: ROOM,
      }),
    ).toMatch(/repository/);
    expect(
      recipeProblem({
        when: { kind: 'manual' },
        job: 'custom',
        instructions: 'x',
        conversationId: ROOM,
        replyOnGitHub: true,
      }),
    ).toMatch(/GitHub/);
    expect(recipeProblem(github())).toBeNull();
  });
});

describe('sentences', () => {
  it('says what a recipe does', () => {
    const def = AutomationDefinition.parse(recipeDefinition(github()));
    expect(recipeSentence(def.recipe as never, names)).toBe(
      'When a new issue or pull request is opened on acme/web, Dusty assesses it in #web and comments on GitHub.',
    );
    expect(buildRecipe(github(), names).name).toBe('Assess new issues and pull requests on acme/web');
    expect(describeAutomation(def, { agent: 'Dusty', conversationTitle: () => '#web' })).toBe(
      'When a new issue or pull request is opened on acme/web, Dusty assesses it in #web and comments on GitHub.',
    );
  });

  it('falls back to the triggers and the number of steps', () => {
    const def = AutomationDefinition.parse(recipeDefinition(github()));
    const plain = { ...def, recipe: undefined };
    expect(describeAutomation(plain, { agent: 'Dusty', conversationTitle: () => '#web' })).toBe(
      'New issues on acme/web · New pull requests on acme/web · then 2 steps',
    );
    expect(
      triggerSummary([{ kind: 'github', event: 'checks_completed', repo: 'a/b', checksState: 'failed' }]),
    ).toBe('Checks on pull requests (failed) on a/b');
  });
});

describe('GitHub trigger filters', () => {
  const facts = (over: Partial<TriggerFacts & { kind: 'github' }> = {}): TriggerFacts => ({
    kind: 'github',
    event: 'pr_opened',
    repo: 'acme/web',
    branch: 'feat/x',
    checksState: null,
    ...over,
  });
  const trigger = { kind: 'github' as const, event: 'pr_opened' as const, repo: 'acme/web' };

  it('leaves drafts out until they are ready, and bots when asked', () => {
    expect(triggerMatches({ ...trigger, drafts: false }, facts({ draft: true }))).toBe(false);
    expect(triggerMatches({ ...trigger, drafts: false }, facts({ readied: true }))).toBe(true);
    expect(triggerMatches(trigger, facts({ draft: true }))).toBe(true);
    expect(triggerMatches(trigger, facts({ readied: true }))).toBe(false);
    expect(triggerMatches({ ...trigger, bots: false }, facts({ bot: true }))).toBe(false);
    expect(triggerMatches(trigger, facts({ bot: true }))).toBe(true);
  });

  it('fires on new issues', () => {
    expect(
      triggerMatches(
        { kind: 'github', event: 'issue_opened', repo: 'Acme/Web' },
        facts({ event: 'issue_opened', branch: null }),
      ),
    ).toBe(true);
  });
});

describe('validation of the 0.66 parts', () => {
  const base = AutomationDefinition.parse(recipeDefinition(github()));
  it('refuses a branch on an issue trigger and a pull request checkout that writes', () => {
    const def = {
      ...base,
      recipe: undefined,
      triggers: [{ kind: 'github', event: 'issue_opened', repo: 'acme/web', branch: 'main' }],
      steps: [
        {
          id: 'ask',
          kind: 'dispatch_agent',
          prompt: 'Fix it.',
          workspace: {
            repo: 'acme/web',
            access: 'write',
            branch: 'feat/x',
            pullRequest: '{{trigger.prNumber}}',
          },
        },
        {
          id: 'comment',
          kind: 'github_comment',
          repo: 'acme/web',
          number: '{{trigger.number}}',
          text: '{{steps.nope.text}}',
        },
      ],
    };
    expect(validateDefinition(def).problems).toEqual([
      'triggers[0].branch: issues have no branch.',
      'steps[0].workspace: a pull request’s checkout is only for reading.'.replace('’', "'"),
      'steps[0].workspace: a checkout is of a branch or of a pull request, not both.',
      'steps[1].text: there is no step “nope”.',
    ]);
  });
});
