/**
 * The demo world's automations (automations-tab.md AP-6312; automation-page.md AP-6337): what the Automations tab lists
 * in fixture mode, so the tab and an automation's page are seen and screenshotted with something in them — a report
 * flow on the made-up Acme Desk tracker that fixes and merges, a GitHub one with a run waiting for a yes, and a weekday check; each with a real
 * definition (core recipes), so its page says what happens step by step. The switches change in memory; an
 * automation's runs are its recent runs.
 */
import {
  type Automation,
  AutomationDefinition,
  type AutomationRun,
  type AutomationRunSummary,
  definitionGrants,
  type RecipeFix,
  recipeDefinition,
} from '@whombat/core';
import { AGENT, BURROW_ID, mara } from '@whombat/fixtures';
import { DEFAULT_CHAT_ID } from './assistant';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-24T11:40:00.000Z');
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

function runs(
  id: string,
  statuses: AutomationRunSummary['status'][],
  waiting = false,
): AutomationRunSummary[] {
  return statuses.map((status, i) => ({
    id: `arn_${id}_${i}`,
    number: statuses.length - i,
    status,
    startedAt: ago(2 + i * 20),
    finishedAt: status === 'waiting' ? null : ago(2 + i * 20 - 0.1),
    waitingOn: waiting && i === 0 ? 'approval' : null,
  }));
}

type RecipeInput = Parameters<typeof recipeDefinition>[0];

const definitionOf = (input: Omit<RecipeInput, 'conversationId' | 'instructions'>) =>
  AutomationDefinition.parse(
    recipeDefinition({
      instructions: 'Do what the job says.',
      conversationId: DEFAULT_CHAT_ID,
      ...input,
    } as RecipeInput),
  );

const FIX: Pick<RecipeFix, 'mode' | 'minImportance' | 'maxPerDay' | 'merge'> = {
  mode: 'auto',
  minImportance: 'high',
  maxPerDay: 5,
  merge: 'checks',
};

function automation(
  id: string,
  name: string,
  description: string,
  definition: AutomationDefinition,
  glance: NonNullable<Automation['glance']>,
  recent: AutomationRunSummary[],
): Automation {
  return {
    id: `aut_${id}`,
    burrowId: BURROW_ID,
    name,
    description,
    status: 'published',
    currentVersion: 1,
    draft: null,
    draftJson: null,
    draftProblems: [],
    draftHash: null,
    definition,
    principalId: AGENT.id,
    createdById: mara.id,
    createdAt: ago(24 * 30),
    updatedAt: ago(24 * 2),
    publishedById: mara.id,
    triggerSummary: glance.trigger,
    summary: '',
    deletedAt: null,
    grants: definitionGrants(definition),
    webhook: { enabled: false, hasSecret: false, path: '' },
    nextRunAt: null,
    lastRun: recent[0] ?? null,
    recentRuns: recent,
    glance,
    waitingPlanId: null,
    talk: null,
  };
}

function automations(): Automation[] {
  return [
    automation(
      'tracker',
      'Assess and fix Acme Desk reports',
      'Neo looks at every new report, answers the customer and fixes clear bugs itself, up to merging the fix.',
      definitionOf({
        when: {
          kind: 'tracker',
          connectionId: 'con_tracker',
          itemKinds: ['bug', 'feature'],
          words: { product: 'Acme Desk', team: 'Acme team' },
        },
        job: 'assess',
        repo: 'lumio/billing',
        fix: FIX,
        writeBack: true,
        replyToCustomer: true,
      }),
      {
        source: 'tracker',
        repo: null,
        trigger: 'New report in Acme Desk',
        agentStep: true,
        room: 'Chat',
        does: [
          { id: 'answer', label: 'Answers', tone: 'plain' },
          { id: 'write_back', label: 'Writes back to Acme Desk', tone: 'changes' },
        ],
      },
      runs('tracker', [
        'succeeded',
        'succeeded',
        'succeeded',
        'skipped',
        'succeeded',
        'succeeded',
        'succeeded',
      ]),
    ),
    automation(
      'prs',
      'Review billing pull requests',
      'Neo reviews every new pull request on billing and says on GitHub what it found.',
      definitionOf({
        when: { kind: 'github', repo: 'lumio/billing', events: ['pr_opened'] },
        job: 'review',
        replyOnGitHub: true,
      }),
      {
        source: 'github',
        repo: 'lumio/billing',
        trigger: 'New pull request · billing',
        agentStep: true,
        room: null,
        does: [
          { id: 'comment', label: 'Comments on GitHub', tone: 'plain' },
          { id: 'merge', label: 'Merges when checks pass', tone: 'merges' },
        ],
      },
      runs('prs', ['waiting', 'succeeded', 'succeeded', 'failed', 'succeeded'], true),
    ),
    automation(
      'morning',
      'Check the billing repository',
      'Every weekday morning Neo checks billing for anything that needs a look and tells you in Chat.',
      definitionOf({
        when: {
          kind: 'schedule',
          schedule: { kind: 'cron', expr: '0 8 * * 1-5' },
          timeZone: 'Europe/Amsterdam',
        },
        job: 'check',
        repo: 'lumio/billing',
      }),
      {
        source: 'schedule',
        repo: null,
        trigger: 'Weekdays at 08:00',
        agentStep: true,
        room: 'Chat',
        does: [{ id: 'post', label: 'Posts a message', tone: 'plain' }],
      },
      runs('morning', ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded']),
    ),
  ];
}

export interface AutomationFixtures {
  handle(
    id: string | undefined,
    params: Record<string, string>,
    init?: RequestInit,
    url?: string,
  ): Response | null;
}

export function createAutomationFixtures(): AutomationFixtures {
  let list = automations();
  return {
    handle(id, params, init, url) {
      switch (id) {
        case 'automations.list':
          return json({ automations: list });
        case 'automations.get': {
          const found = list.find((a) => a.id === params.id);
          return found
            ? json({ automation: found, versions: [], webhookUrl: null })
            : json({ error: { code: 'not_found', message: 'No such automation' } }, 404);
        }
        case 'automations.runs': {
          const of = new URL(url ?? 'http://x/').searchParams.get('automation');
          return json({ runs: list.filter((a) => !of || a.id === of).flatMap(runsOf) });
        }
        case 'automations.setEnabled': {
          const { enabled } = JSON.parse(String(init?.body ?? '{}')) as { enabled?: boolean };
          const found = list.find((a) => a.id === params.id);
          if (!found) return json({ error: { code: 'not_found', message: 'No such automation' } }, 404);
          const next: Automation = { ...found, status: enabled ? 'published' : 'disabled' };
          list = list.map((a) => (a.id === next.id ? next : a));
          return json({ automation: next, versions: [], webhookUrl: null });
        }
        default:
          return null;
      }
    },
  };
}

const REPORTS = [
  'Export to PDF cuts off the last page',
  'Can I add a second admin?',
  'Invoice totals round wrong',
];

/** An automation's recent runs as the runs list has them: what started each, newest first. */
function runsOf(a: Automation): AutomationRun[] {
  return a.recentRuns.map(
    (r, i): AutomationRun => ({
      id: r.id,
      number: r.number,
      burrowId: BURROW_ID,
      automationId: a.id,
      automationName: a.name,
      version: 1,
      status: r.status,
      trigger: {
        kind:
          a.glance?.source === 'tracker'
            ? 'tracker'
            : a.glance?.source === 'schedule'
              ? 'schedule'
              : 'github',
        summary:
          a.glance?.source === 'tracker'
            ? (REPORTS[i % REPORTS.length] ?? '')
            : a.glance?.source === 'schedule'
              ? 'Every weekday at 08:00'
              : `Pull request #${40 + r.number}`,
        actorId: null,
        eventId: null,
        messageId: null,
        scheduledFor: null,
      },
      conversationId: DEFAULT_CHAT_ID,
      threadRootId: null,
      causalDepth: 0,
      startedById: null,
      test: false,
      createdAt: r.startedAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: r.status === 'failed' ? 'Acme Desk didn’t answer.' : null,
      tokens: null,
      steps: [],
    }),
  );
}
