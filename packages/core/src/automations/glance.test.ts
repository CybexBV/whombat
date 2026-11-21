import { describe, expect, it } from 'vitest';
import { GitHubAvatar } from '../contracts/github.js';
import { AutomationDefinition, AutomationGlance, type AutomationRecipeInput } from '../domain/automation.js';
import { automationGlance } from './glance.js';
import { recipeDefinition, recipeInstructions } from './recipes.js';

const ROOM = 'cnv_reports';
const CON = 'con_trackerdev';
const ROOMS: Record<string, string> = { [ROOM]: '#reports', cnv_bugs: '#bugs' };
const names = {
  conversationTitle: (id: string) => ROOMS[id],
  connectionLabel: (id: string) => (id === CON ? 'Acme Desk Dev' : undefined),
};

const glanceOf = (r: AutomationRecipeInput) =>
  AutomationGlance.parse(automationGlance(AutomationDefinition.parse(recipeDefinition(r)), names));

const github = { kind: 'github' as const, repo: 'acme/Fusebox', events: ['issue_opened' as const] };
const tracker = {
  kind: 'tracker' as const,
  connectionId: CON,
  itemKinds: ['bug', 'feature'] as ('bug' | 'feature')[],
  words: {
    product: 'Acme Desk',
    team: 'Acme Desk team',
    source: 'A signed-in Acme Desk customer sent the report below through Acme Desk’s own Feedback',
    access: 'its devices, deployments and audit',
  },
};

const recipe = (when: AutomationRecipeInput['when'], over: Partial<AutomationRecipeInput> = {}) =>
  ({
    when,
    job: 'assess',
    instructions: recipeInstructions('assess', when),
    conversationId: ROOM,
    ...over,
  }) as AutomationRecipeInput;

describe('an automation at a glance', () => {
  it('shows a GitHub recipe that fixes and merges by itself with its repo, agent, room and tags mildest first', () => {
    const g = glanceOf(recipe(github, { replyOnGitHub: true, fix: { mode: 'auto', merge: 'checks' } }));
    expect(g).toEqual({
      source: 'github',
      repo: 'acme/Fusebox',
      trigger: 'New issue · Fusebox',
      agentStep: true,
      room: '#reports',
      does: [
        { id: 'assess', label: 'Assesses', tone: 'plain' },
        { id: 'comment', label: 'Comments on GitHub', tone: 'plain' },
        { id: 'fix_auto', label: 'Fixes when sure', tone: 'changes' },
        { id: 'merge', label: 'Merges when checks pass', tone: 'merges' },
      ],
    });
  });

  it('names every GitHub event it listens to', () => {
    const g = glanceOf(
      recipe(
        { ...github, events: ['issue_opened', 'pr_opened'] },
        { job: 'custom', instructions: 'Say hello.' },
      ),
    );
    expect(g.trigger).toBe('New issue or new pull request · Fusebox');
    expect(g.does).toEqual([{ id: 'instructions', label: 'Follows your instructions', tone: 'plain' }]);
  });

  it('shows a Acme Desk recipe that writes back and fixes after a yes, with its connection', () => {
    const g = glanceOf(recipe(tracker, { fix: { mode: 'ask' } }));
    expect(g.source).toBe('tracker');
    expect(g.repo).toBeNull();
    expect(g.trigger).toBe('New report · Acme Desk Dev');
    expect(g.does.map((d) => d.label)).toEqual(['Assesses', 'Writes back to Acme Desk', 'Fixes after a yes']);
  });

  it('says “a tracker connection” and “a private room” for what the viewer can’t see', () => {
    const g = AutomationGlance.parse(
      automationGlance(
        AutomationDefinition.parse(recipeDefinition(recipe({ ...tracker, connectionId: 'con_x' }))),
        {
          conversationTitle: () => undefined,
        },
      ),
    );
    expect(g.trigger).toBe('New report · a tracker connection');
    expect(g.room).toBe('a private room');
  });

  it('shows a message, a schedule and a start by hand in a few words', () => {
    const message = { kind: 'message' as const, contains: ['deploy', 'ship'] };
    expect(
      glanceOf(recipe(message, { job: 'answer', instructions: recipeInstructions('answer', message) }))
        .trigger,
    ).toBe('Message with “deploy”…');
    const schedule = {
      kind: 'schedule' as const,
      schedule: { kind: 'cron' as const, expr: '0 9 * * 1-5' },
      timeZone: 'Europe/Amsterdam',
    };
    const check = glanceOf(
      recipe(schedule, {
        job: 'check',
        instructions: recipeInstructions('check', schedule, 'acme/Fusebox'),
        repo: 'acme/Fusebox',
      }),
    );
    expect(check).toMatchObject({ source: 'schedule', repo: null, trigger: 'Every weekday at 09:00' });
    expect(check.does.map((d) => d.id)).toEqual(['check']);
    const manual = { kind: 'manual' as const };
    expect(
      glanceOf(
        recipe(manual, {
          job: 'check',
          instructions: recipeInstructions('check', manual, 'acme/Fusebox'),
          repo: 'acme/Fusebox',
        }),
      ).trigger,
    ).toBe('Started by hand');
  });

  it('reads a step editor’s definition from its first trigger and its steps', () => {
    const d = AutomationDefinition.parse({
      version: 1,
      conversationId: 'cnv_bugs',
      triggers: [
        { kind: 'message_posted', conversationId: 'cnv_bugs' },
        { kind: 'reaction_added', conversationId: 'cnv_bugs', value: '🐛' },
      ],
      steps: [
        { id: 'ask', name: 'Ask', kind: 'dispatch_agent', prompt: 'Look at it.' },
        {
          id: 'merge',
          name: 'Merge',
          kind: 'merge_pull_request',
          repo: 'acme/web',
          number: '1',
          method: 'squash',
          waitMinutes: 60,
          otherwise: 'fail',
        },
        {
          id: 'pr',
          name: 'PR',
          kind: 'open_pull_request',
          repo: 'acme/web',
          branch: 'feat/x',
          title: 'Fix',
          body: 'Fix',
        },
        { id: 'tell', name: 'Tell', kind: 'post_message', text: 'Done.' },
        { id: 'tell2', name: 'Tell again', kind: 'post_message', text: 'Done again.' },
      ],
    });
    const g = AutomationGlance.parse(automationGlance(d, names));
    expect(g).toMatchObject({
      source: 'message',
      repo: null,
      trigger: 'Message and 1 more',
      agentStep: true,
      room: '#bugs',
    });
    expect(g.does.map((t) => t.id)).toEqual(['agent', 'post', 'open_pr', 'merge']);
    const reaction = AutomationGlance.parse(
      automationGlance({ ...d, triggers: [d.triggers[1] as (typeof d.triggers)[number]] }, names),
    );
    expect(reaction).toMatchObject({ source: 'reaction', trigger: 'Reaction 🐛' });
  });

  it('takes a GitHub step editor’s repo for the tile', () => {
    const d = AutomationDefinition.parse({
      version: 1,
      conversationId: ROOM,
      triggers: [{ kind: 'github', event: 'pr_opened', repo: 'acme/web' }],
      steps: [{ id: 'tell', name: 'Tell', kind: 'post_message', text: 'A new pull request.' }],
    });
    const g = automationGlance(d, names);
    expect(g.source).toBe('github');
    expect(g.repo).toBe('acme/web');
    expect(g.agentStep).toBe(false);
  });
});

describe('a GitHub owner’s picture', () => {
  it('is a data URL of a raster image, never SVG', () => {
    expect(
      GitHubAvatar.safeParse({ owner: 'acme', image: 'data:image/png;base64,iVBORw0KGgo=' }).success,
    ).toBe(true);
    expect(GitHubAvatar.safeParse({ owner: 'acme', image: null }).success).toBe(true);
    expect(
      GitHubAvatar.safeParse({ owner: 'acme', image: 'data:image/svg+xml;base64,PHN2Zz4=' }).success,
    ).toBe(false);
    expect(GitHubAvatar.safeParse({ owner: 'Digital/Pals', image: null }).success).toBe(false);
  });
});
