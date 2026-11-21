import { describe, expect, it } from 'vitest';
import { AutomationDefinition, type AutomationDefinitionInput } from '../domain/automation.js';
import {
  automationFlow,
  automationPlanView,
  definitionGrants,
  plainTemplate,
  planChanges,
  planPrompts,
  planSections,
  planTryIt,
  UNKNOWN_START,
} from './plan.js';
import { recipeDefinition } from './recipes.js';

const names = {
  agent: 'Dusty',
  conversationTitle: (id: string) => (id === 'cnv_chat' ? 'Chat' : undefined),
  connectionLabel: (id: string) => (id === 'con_tracker' ? 'Acme Desk dev' : undefined),
};

const def = (input: Partial<AutomationDefinitionInput>) =>
  AutomationDefinition.parse({
    version: 1,
    conversationId: 'cnv_chat',
    triggers: [{ kind: 'github', event: 'issue_opened', repo: 'acme/web', bots: false }],
    steps: [{ id: 'ask', kind: 'dispatch_agent', prompt: 'Look at {{trigger.text}}', assessment: true }],
    ...input,
  });

const texts = (d: ReturnType<typeof def>, id: string, grants = definitionGrants(d)) =>
  planSections(d, grants, names)
    .find((s) => s.id === id)
    ?.lines.map((l) => (l.detail ? `${l.text} | ${l.detail}` : l.text));

describe('plan sections', () => {
  it('say what starts it, what the agent does, what asks, where it posts and its limits', () => {
    const d = def({});
    expect(planSections(d, [], names).map((s) => [s.id, s.label])).toEqual([
      ['when', 'WHEN'],
      ['does', 'DUSTY'],
      ['asks', 'ASKS YOU'],
      ['posts', 'POSTS'],
      ['limits', 'LIMIT'],
    ]);
    expect(texts(d, 'when')).toEqual(['A new issue on acme/web | Not from bots']);
    expect(texts(d, 'does')).toEqual([
      'Look at … | Says what it is, how important it is and how big a fix would be',
    ]);
    expect(texts(d, 'asks')).toEqual(['Nothing: it only reads and tells you']);
    expect(texts(d, 'posts')).toEqual(['One thread per issue in Chat | Nothing outside Whombat']);
    expect(texts(d, 'limits')).toEqual(['At most 50 runs a day']);
  });

  it('name what leaves Whombat and what waits for a yes', () => {
    const d = def({
      steps: [
        {
          id: 'ask',
          kind: 'dispatch_agent',
          name: 'Fix it',
          prompt: 'Fix',
          workspace: { repo: 'acme/web', access: 'write', branch: 'feat/issue-{{trigger.number}}' },
        },
        { id: 'yes', kind: 'request_approval', title: 'Merge #{{trigger.number}}?', details: 'It merges.' },
        {
          id: 'pr',
          kind: 'open_pull_request',
          repo: 'acme/web',
          branch: 'feat/issue-{{trigger.number}}',
          title: 'Fix',
        },
        { id: 'merge', kind: 'merge_pull_request', repo: 'acme/web', number: '{{steps.pr.prNumber}}' },
        {
          id: 'tell',
          kind: 'tracker_reply',
          connectionId: 'con_tracker',
          report: '{{trigger.reportId}}',
          from: 'ask',
        },
      ],
    });
    expect(texts(d, 'does')).toEqual([
      'Fix it | Changes the code of acme/web on its own branch feat/issue-N',
    ]);
    expect(texts(d, 'asks', definitionGrants(d, ['merge']))).toEqual([
      'Merge #N?',
      'Before it merges a pull request',
    ]);
    expect(texts(d, 'posts')).toEqual([
      'One thread per issue in Chat',
      'Opens a pull request on acme/web | From feat/issue-N',
      'Merges the pull request once its checks pass | acme/web',
      'Replies to the customer in Acme Desk dev',
    ]);
  });

  it('say the person merges a pull request no step merges', () => {
    const d = def({
      steps: [
        {
          id: 'ask',
          kind: 'dispatch_agent',
          prompt: 'Fix',
          workspace: { repo: 'acme/web', access: 'write', branch: 'feat/x' },
        },
        { id: 'pr', kind: 'open_pull_request', repo: 'acme/web', branch: 'feat/x', title: 'Fix' },
      ],
    });
    expect(texts(d, 'posts')).toContain('Opens a pull request on acme/web | From feat/x · You merge it');
  });

  it('name a weekly schedule’s days', () => {
    const weekly = (expr: string) =>
      texts(
        def({
          triggers: [{ kind: 'schedule', schedule: { kind: 'cron', expr }, timeZone: 'Europe/Amsterdam' }],
        }),
        'when',
      );
    expect(weekly('0 9 * * 1')).toEqual(['Every Monday at 09:00']);
    expect(weekly('30 7 * * 1,4')).toEqual(['Every Monday and Thursday at 07:30']);
    expect(weekly('0 10 * * 0,6')).toEqual(['Every Saturday and Sunday at 10:00']);
  });

  it('read schedules and messages in plain words', () => {
    const d = def({
      triggers: [
        { kind: 'schedule', schedule: { kind: 'cron', expr: '0 9 * * 1-5' }, timeZone: 'Europe/Amsterdam' },
        { kind: 'message_posted', conversationId: 'cnv_chat', contains: ['bug'], includeReplies: true },
      ],
    });
    expect(texts(d, 'when')).toEqual([
      'Every weekday at 09:00',
      'A message with “bug” in Chat | Thread replies count too',
    ]);
    expect(texts(d, 'posts')?.[0]).toContain('each time it runs');
  });
});

describe('the keys a plan gives', () => {
  it('are what its steps need, scoped to their repositories, at Can unless asked', () => {
    const d = def({
      steps: [
        { id: 'ask', kind: 'dispatch_agent', prompt: 'x' },
        { id: 'c1', kind: 'github_comment', repo: 'acme/web', number: '1', text: 'hi' },
        { id: 'c2', kind: 'github_comment', repo: 'acme/api', number: '1', text: 'hi' },
        { id: 'm', kind: 'merge_pull_request', repo: 'acme/web', number: '1' },
        { id: 'h', kind: 'http_callback', url: 'https://example.com/hook' },
      ],
    });
    expect(definitionGrants(d, ['merge.main', 'messages.external'])).toEqual([
      { keyId: 'pr.comment', tier: 'can', repos: ['acme/web', 'acme/api'] },
      { keyId: 'merge.main', tier: 'ask', repos: ['acme/web'] },
      { keyId: 'merge', tier: 'ask', repos: ['acme/web'] },
      // Calling a URL never asks (an approval step before it does).
      { keyId: 'messages.external', tier: 'can' },
    ]);
  });
});

describe('a change', () => {
  it('lists the lines added and removed, and the agent’s words that changed', () => {
    const before = def({});
    const after = def({
      steps: [
        { id: 'ask', kind: 'dispatch_agent', prompt: 'Look closer at {{trigger.text}}', assessment: true },
        {
          id: 'c',
          kind: 'github_comment',
          repo: 'acme/web',
          number: '{{trigger.number}}',
          text: '{{steps.ask.reply}}',
        },
      ],
      limits: { maxRunsPerDay: 5, maxConcurrentRuns: 1, runTimeoutMinutes: 60 },
    });
    const view = (d: typeof before) => ({
      sections: planSections(d, definitionGrants(d), names),
      prompts: planPrompts(d),
    });
    const changes = planChanges(view(before), view(after), 'Dusty');
    expect(changes).toEqual(
      expect.arrayContaining([
        { change: 'added', section: 'posts', text: 'Comments on GitHub on acme/web' },
        { change: 'added', section: 'limits', text: 'At most 5 runs a day' },
        { change: 'removed', section: 'limits', text: 'At most 50 runs a day' },
        { change: 'changed', section: 'does', text: 'What Dusty is asked in “Ask the agent”' },
      ]),
    );
    expect(planChanges(view(before), view(before), 'Dusty')).toEqual([]);
  });

  it('shows on the view only when there is a live version', () => {
    const d = def({});
    const facts = {
      planId: 'apl_1',
      automationId: 'aut_1',
      name: 'Issues',
      description: '',
      state: 'waiting' as const,
      definition: d,
      grants: [],
      thinking: ['One', 'Two'],
      decidedById: null,
      decidedAt: null,
      version: null,
      createdAt: '2026-10-28T10:00:00.000Z',
    };
    expect(automationPlanView({ ...facts, base: null }, names)).toMatchObject({ change: false, changes: [] });
    expect(automationPlanView({ ...facts, base: { definition: d, grants: [] } }, names)).toMatchObject({
      change: true,
      thinking: ['One', 'Two'],
      tryIt: 'sample',
    });
  });
});

describe('a fixing recipe', () => {
  it('reads without its gates, says when it asks, and lists each outside step once', () => {
    const d = AutomationDefinition.parse(
      recipeDefinition({
        when: { kind: 'github', repo: 'acme/web', events: ['issue_opened'] },
        job: 'assess',
        instructions: 'Say what it is.',
        conversationId: 'cnv_chat',
        replyOnGitHub: true,
        fix: { mode: 'auto', merge: 'checks' },
      }),
    );
    const does = texts(d, 'does') ?? [];
    expect(does.some((l) => l.includes('?'))).toBe(false);
    expect(texts(d, 'asks', definitionGrants(d))?.[0]).toMatch(/^Before a fix it isn’t sure about/);
    const posts = texts(d, 'posts') ?? [];
    expect(posts.filter((l) => l === 'Comments on GitHub on acme/web')).toHaveLength(1);
  });

  it('says a line that stays but reads differently is changed, not added and removed', () => {
    const before = def({});
    const after = def({
      steps: [
        {
          id: 'ask',
          kind: 'dispatch_agent',
          prompt: 'Look at {{trigger.text}}',
          assessment: true,
          workspace: { repo: 'acme/web', access: 'read' },
        },
      ],
    });
    const view = (d: typeof before) => ({ sections: planSections(d, [], names), prompts: planPrompts(d) });
    expect(planChanges(view(before), view(after), 'Dusty')).toEqual([
      {
        change: 'changed',
        section: 'does',
        text: 'Look at … (Reads the code of acme/web · Says what it is, how important it is and how big a fix would be)',
      },
    ]);
  });
});

describe('small helpers', () => {
  it('read templates and pick what Try it does', () => {
    expect(plainTemplate('Fix #{{trigger.number}}: {{trigger.title}}')).toBe('Fix #N: …');
    expect(planTryIt(def({}))).toBe('sample');
    expect(planTryIt(def({ triggers: [{ kind: 'manual' }] }))).toBe('now');
  });
});

describe('what happens, step by step (automation-page.md AP-6331)', () => {
  const trackerFix = AutomationDefinition.parse(
    recipeDefinition({
      when: { kind: 'tracker', connectionId: 'con_tracker', itemKinds: ['bug', 'feature'] },
      job: 'assess',
      instructions: 'Look at it',
      repo: 'acme/web',
      fix: { mode: 'auto', minImportance: 'high', maxPerDay: 5, merge: 'checks' },
      writeBack: true,
      replyToCustomer: true,
      conversationId: 'cnv_chat',
    }),
  );

  it('starts with what starts it, the other triggers and where its runs show', () => {
    const [when] = automationFlow(trackerFix, definitionGrants(trackerFix), names);
    expect(when?.kind).toBe('when');
    if (when?.kind !== 'when') return;
    expect(when.text).toContain('Acme Desk dev');
    expect(when.details.some((d) => d.startsWith('Or ') && d.includes('writes back'))).toBe(true);
    expect(when.details.at(-1)).toContain('Chat');
  });

  it('lists every step in order, with the checks between them and what a no does', () => {
    const flow = automationFlow(trackerFix, definitionGrants(trackerFix), names);
    expect(flow.map((i) => (i.kind === 'step' ? i.icon : i.kind))).toEqual([
      'when',
      'agent',
      'report',
      'reply',
      'gate',
      'gate',
      'ask',
      'agent',
      'agent',
      'gate',
      'pull_request',
      'merge',
    ]);
    const gates = flow.filter((i) => i.kind === 'gate').map((i) => (i.kind === 'gate' ? i.text : ''));
    expect(gates[0]).toContain('stops here');
    // “Does a person need to say yes?” skips ahead to the fix when no one needs to.
    expect(gates[1]).toContain('Fix it or make the change');
  });

  it('marks what reaches outside Whombat, changes code or merges by itself', () => {
    const flow = automationFlow(trackerFix, definitionGrants(trackerFix), names);
    const marks = (icon: string) =>
      flow.flatMap((i) =>
        i.kind === 'step' && i.icon === icon ? i.marks.map((m) => `${m.tone}:${m.label}`) : [],
      );
    expect(marks('report')).toEqual(['plain:Acme Desk dev']);
    expect(marks('reply')).toEqual(['plain:Acme Desk dev']);
    expect(marks('agent')).toEqual(['changes:Changes code']);
    expect(marks('merge')).toEqual(['merges:Merges by itself']);
    expect(marks('pull_request')).toEqual(['plain:GitHub']);
    // When merging asks first, the merge says so instead.
    const asking = definitionGrants(trackerFix, ['merge']);
    expect(
      automationFlow(trackerFix, asking, names).flatMap((i) =>
        i.kind === 'step' && i.icon === 'merge' ? i.marks.map((m) => m.label) : [],
      ),
    ).toEqual(['Asks you first']);
  });

  it('says a tracker fix depends on how important the bug is, not on who filed it', () => {
    const asks = planSections(trackerFix, definitionGrants(trackerFix), names).find((s) => s.id === 'asks');
    expect(asks?.lines[0]?.detail).toContain('high importance');
    expect(asks?.lines[0]?.detail).not.toContain('opened the issue');
  });
});

describe('an old plan’s card', () => {
  it('says a start and a step of kinds this Whombat no longer knows plainly, never failing', () => {
    // As an earlier release stored a plan already answered: a start and a step this Whombat no longer has.
    const old = {
      ...def({}),
      triggers: [{ kind: 'retired_kind', connectionId: 'con_tracker' }],
      steps: [
        { id: 'ask', kind: 'dispatch_agent', prompt: 'Look at it', assessment: true },
        { id: 'write', kind: 'retired_step', connectionId: 'con_tracker' },
      ],
    } as unknown as ReturnType<typeof def>;
    const view = automationPlanView(
      {
        planId: 'apl_old',
        automationId: 'aut_old',
        name: 'Old reports',
        description: '',
        state: 'accepted',
        definition: old,
        grants: [],
        base: { definition: old, grants: [] },
        thinking: [],
        decidedById: null,
        decidedAt: null,
        version: 2,
        createdAt: '2026-11-10T09:00:00.000Z',
      },
      names,
    );
    expect(view.sections.find((s) => s.id === 'when')?.lines.map((l) => l.text)).toEqual([UNKNOWN_START]);
    expect(view.sections.find((s) => s.id === 'does')?.lines).toHaveLength(1);
  });
});
