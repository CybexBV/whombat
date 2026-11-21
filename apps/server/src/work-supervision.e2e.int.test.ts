/**
 * Work supervision end to end (docs/decisions/work-supervision.md; one agent, one-agent.md OA-14), deterministic: real
 * Postgres, the real server over HTTP, the real runner with a FAKE PROVIDER (no model) that emits provider-shaped tool
 * events and acts through Whombat's MCP, and a fresh, unseeded burrow made over REST by the person, with its one agent.
 *
 *  1. Fran asks Dusty in her Chat for work; Dusty makes a plan from the message (the card lands in its thread) and
 *     nothing starts.
 *  2. Fran starts step 1: Dusty is asked in the plan's thread; its turn edits a file, runs a failing command (with a
 *     secret in its output) and starts a run for the step, which fails. The step is blocked (never done), the
 *     activity rows tell what happened (redacted evidence), and the Work view shows the blocked step with its next
 *     actions.
 *  3. Fran retries the step; the new run finishes and the step is done. Reconciling again (a restart) changes nothing.
 *  4. Fran starts step 2: Dusty asks to deploy (the approval gates the step, its activity row waits for it); Fran
 *     approves, the deploy executes, the step is done.
 *  5. The plan and the decision are searchable with their state; Dusty answers from them with receipts that open the
 *     exact decision and plan.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentProvider,
  BASIC_CAPABILITIES,
  connectWhombatMcp,
  type TurnEvent,
} from '@whombat/agent-runtime';
import {
  api,
  buildPath,
  type McpToolName,
  type Plan,
  type SearchResponse,
  type WorkOverview,
} from '@whombat/core';
import { createRunnerApi, type ProviderRegistry, Runner, testPolicy } from '@whombat/runner';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activities, burrows, dispatches, principals, runs } from './db/schema/index';
import { reconcilePlans } from './domain/plan-follow';
import { IDS } from './seed/test-world';
import { simulateExecutors } from './test/approvals';
import { connectGitHubAs, signInsEnv } from './test/github';
import { useTestServer } from './test/harness';
import { extraBurrow } from './test/managed';
import { chatWith } from './test/rooms';
import { waitFor } from './test/runner';
import { SCRIPTED_ENV, scripted } from './test/scripted';
import { sessionFor } from './test/tokens';

const t = useTestServer({ seed: true, listen: true, env: { ...SCRIPTED_ENV, ...signInsEnv() } });
// Agents' git and gh run on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
beforeAll(() => connectGitHubAs(t.services, IDS.mara));
const workspaces = mkdtempSync(join(tmpdir(), 'whombat-e2e-ws-'));
const REPO = 'whombat/web';
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const BUILD = 'Build the export endpoint';
const DEPLOY = 'Deploy to staging';

let runner: Runner | null = null;
let fran = ''; // the person's cookie (Mara's account, so she can connect GitHub)
let slug = '';
let burrowId = '';
let agentId = '';
let chatId = '';
/** What the fake provider's turns did, in order. */
const turns: string[] = [];

/* The fake provider ------------------------------------------------------------------------------------------------ */

function fakeProvider(): AgentProvider {
  return {
    kind: 'claude',
    available: async () => ({ ok: true, version: 'fake' }),
    capabilities: () => BASIC_CAPABILITIES,
    async *runTurn(input): AsyncIterable<TurnEvent> {
      const ctx = input.context;
      const mcp = await connectWhombatMcp(input.mcp);
      const n = turns.length + 1;
      let seq = 0;
      /** A Whombat tool call as a provider reports it: the call, then its result with the structured outcome. */
      async function* tool(name: McpToolName, args: Record<string, unknown>) {
        const id = `toolu_${n}_${++seq}`;
        yield { type: 'tool_call', id, name, input: args, category: 'mcp' } as TurnEvent;
        const res = await mcp.call(name, args);
        yield {
          type: 'tool_result',
          id,
          name,
          ok: res.body.status !== 'blocked',
          outcome: { structured: res.body },
        } as TurnEvent;
        return res.body as Record<string, unknown>;
      }
      try {
        const step = ctx.planStep ?? null;
        if (ctx.search) {
          turns.push('answer');
          const cite = ctx.search.results.filter((r) => r.type === 'PLAN' || r.type === 'DECISION');
          yield* tool('post_answer', {
            answerId: ctx.search.answerId,
            text: cite.map((_, i) => `Source [${i + 1}].`).join(' ') || 'Nothing found.',
            citations: cite.map((r, i) => ({ n: i + 1, resultId: r.id })),
          });
        } else if (step?.title === BUILD) {
          const failing = !turns.includes('build');
          turns.push('build');
          // The provider's own tool events: an edit and a command, with ids, exit code and output.
          yield {
            type: 'tool_call',
            id: `toolu_edit_${n}`,
            name: 'Edit',
            input: { file_path: join(input.cwd, 'src/invoice-pdf.ts') },
            category: 'edit',
          };
          yield { type: 'tool_result', id: `toolu_edit_${n}`, name: 'Edit', ok: true, outcome: {} };
          yield {
            type: 'tool_call',
            id: `toolu_bash_${n}`,
            name: 'Bash',
            input: { command: 'pnpm test billing/pdf' },
            category: 'command',
          };
          yield {
            type: 'tool_result',
            id: `toolu_bash_${n}`,
            name: 'Bash',
            ok: !failing,
            outcome: failing
              ? {
                  exitCode: 1,
                  error: 'error',
                  output: `✗ 3 failing in invoice_format_test\nGITHUB_TOKEN=${SECRET}`,
                }
              : { exitCode: 0, output: '✓ 41 passed' },
          };
          const started = yield* tool('start_run', {
            conversationId: ctx.conversation.id,
            title: step.title,
            repo: REPO,
            branch: 'feat/invoice-pdf',
            steps: [{ title: 'Build it', detail: '' }],
          });
          expect(started.status).toBe('ok');
          if (!failing) yield* tool('run_step', { run: started.number, step: 0, state: 'done' });
          yield* tool('finish_run', {
            run: started.number,
            outcome: failing ? 'failed' : 'done',
            summary: failing
              ? '3 tests fail in invoice_format_test.'
              : 'Export endpoint built, 41 of 41 pass.',
          });
        } else if (step?.title === DEPLOY) {
          turns.push('deploy');
          const asked = yield* tool('request_approval', {
            conversationId: ctx.conversation.id,
            action: {
              type: 'deploy',
              params: { environment: 'staging', service: 'billing-api', ref: 'feat/invoice-pdf', sha: null },
            },
            whatHappens: ['Staging serves the new PDF endpoint'],
            explainer: 'Staging deploys ask a person first.',
            summary: 'Deploy the invoice PDF export to staging.',
          });
          // Asked in the turn the step was started for: the approval gates the step by itself.
          expect(asked.status).toBe('ok');
        } else if (!step && !turns.includes('plan')) {
          turns.push('plan');
          const out = yield* tool('plan_create', {
            conversationId: ctx.conversation.id,
            title: 'Invoice PDF export',
            sourceMessageId: ctx.trigger?.id,
            steps: [{ title: BUILD }, { title: DEPLOY }],
          });
          expect(out.status).toBe('ok');
        } else turns.push('other');
        yield { type: 'final', text: '' };
      } finally {
        await mcp.close();
      }
    },
  };
}

const provider = fakeProvider();
const registry: ProviderRegistry = scripted({
  claims: () => ['claude'],
  for: (kind) => (kind === 'claude' ? provider : null),
  report: () => [],
});

/* HTTP helpers ----------------------------------------------------------------------------------------------------- */

type Ep = { base: string; path: string; method: string };
async function call<T = Record<string, unknown>>(
  ep: Ep,
  params: Record<string, string | number>,
  opts: { cookie?: string; body?: object; query?: string } = {},
): Promise<{ status: number; body: T }> {
  const res = await t.api.inject({
    method: ep.method as 'GET',
    url: `${ep.base}${buildPath(ep.path, { burrow: slug, ...params })}${opts.query ?? ''}`,
    headers: { cookie: opts.cookie ?? fran },
    ...(opts.body ? { payload: opts.body } : {}),
  });
  return { status: res.statusCode, body: res.json() as T };
}

const planOf = async (planId: string) => (await call<{ plan: Plan }>(api.plans.get, { planId })).body.plan;

beforeAll(async () => {
  // The story's deploy is a stand-in the suite asks for (no workflow here; essentials-agents.md EA-02).
  simulateExecutors(t.services, 'deploy');
  const mara = await sessionFor(t.services, IDS.mara);
  fran = mara.cookie;
  // A fresh burrow with its agent beside the box's own (one burrow per box, HE-S165), then GitHub and one repo over
  // REST.
  burrowId = (await extraBurrow(t.services, mara.accountId, 'Moss Works')).burrowId;
  const [b] = await t.services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  slug = b?.slug ?? '';
  const done = await call(api.onboarding.complete, {}, { body: { invites: [] } });
  expect(done.status).toBe(200);
  expect((await call(api.github.connect, {})).status).toBe(200);
  expect((await call(api.repos.add, {}, { body: { fullName: REPO } })).status).toBe(200);
  const rows = await t.services.db.select().from(principals).where(eq(principals.burrowId, burrowId));
  const agent = rows.find((r) => r.kind === 'agent');
  const person = rows.find((r) => r.kind === 'person');
  if (!agent || !person) throw new Error('the burrow has no agent or no person');
  expect(rows.filter((r) => r.kind === 'agent')).toHaveLength(1);
  agentId = agent.id;
  // The agent on the (fake) live provider.
  await t.services.db
    .update(principals)
    .set({
      runtime: { ...agent.runtime, provider: 'claude' },
    })
    .where(eq(principals.id, agent.id));
  chatId = await chatWith(t.services, burrowId, agent.id, person.id);
  runner = new Runner({
    api: createRunnerApi(t.baseUrl, 'dev-runner-token'),
    registry,
    managed: testPolicy(),
    serverUrl: t.baseUrl,
    workspacesRoot: workspaces,
    host: { home: tmpdir(), whombatHome: workspaces },
    waitMs: 300,
    heartbeatMs: 200,
    progressMs: 50,
  });
  runner.start();
}, 60_000);

afterAll(async () => {
  await runner?.stop(3000);
  rmSync(workspaces, { recursive: true, force: true });
});

/** The agent's turn for the message `messageId` (or its search answer) has finished. */
async function turnFor(messageId: string | null) {
  await waitFor(
    async () => {
      const rows = await t.services.db
        .select()
        .from(dispatches)
        .where(
          and(
            eq(dispatches.burrowId, burrowId),
            messageId ? eq(dispatches.messageId, messageId) : isNotNull(dispatches.search),
          ),
        );
      return rows.some((d) => d.state === 'done' || d.state === 'failed');
    },
    20_000,
    `the turn for ${messageId ?? 'the search answer'}`,
  );
}

let planId = '';
let step1 = '';
let step2 = '';
let requestId = '';

describe('a request becomes a plan, and nothing starts by itself', () => {
  it('Dusty makes the plan from Fran’s message in her Chat; the card is in the message’s thread', async () => {
    const sent = await call<{ message: { id: string } }>(
      api.messages.send,
      { conversationId: chatId },
      { body: { text: 'Plan the invoice PDF export: build it, then ship it to staging.' } },
    );
    expect(sent.status).toBe(201);
    requestId = sent.body.message.id;
    await turnFor(requestId);
    const list = await call<{ plans: Plan[] }>(api.plans.list, {}, { query: `?conversationId=${chatId}` });
    const [plan] = list.body.plans;
    if (!plan) throw new Error('no plan');
    planId = plan.id;
    step1 = plan.steps[0]?.id ?? '';
    step2 = plan.steps[1]?.id ?? '';
    expect(plan).toMatchObject({
      title: 'Invoice PDF export',
      createdById: agentId,
      source: { messageId: requestId, threadRootId: requestId },
    });
    expect(plan.steps.map((s) => [s.title, s.state])).toEqual([
      [BUILD, 'queued'],
      [DEPLOY, 'queued'],
    ]);
    // Making the plan started nothing: the request's turn is the agent's only one.
    const all = await t.services.db.select().from(dispatches).where(eq(dispatches.burrowId, burrowId));
    expect(all.map((d) => d.messageId)).toEqual([requestId]);
    expect(turns).toEqual(['plan']);
  });
});

describe('asked work, visible progress, failure', () => {
  it('starting step 1 asks Dusty in the plan’s thread; its failed run blocks the step and says why', async () => {
    const started = await call<{ messageId: string | null }>(
      api.plans.startStep,
      { planId, stepId: step1 },
      { body: {} },
    );
    expect(started.status).toBe(200);
    expect(started.body.messageId).toBeTruthy();
    await turnFor(started.body.messageId);
    const plan = await waitFor(async () => {
      const p = await planOf(planId);
      return p.steps[0]?.state === 'blocked' ? p : null;
    });
    const s = plan.steps[0];
    expect(s).toMatchObject({ state: 'blocked', stateLabel: 'Run failed' });
    expect(s?.note).toMatch(/^Run #\d+ failed\. Retry it\.$/);
    expect(s?.refs.runNumber).toBeGreaterThan(0);
  });

  it('the activity rows tell what happened, one row per action, the secret redacted', async () => {
    const [run] = await t.services.db.select().from(runs).where(eq(runs.burrowId, burrowId));
    const page = await call<{
      activities: {
        title: string;
        status: string;
        kind: string;
        detail: string | null;
        evidence: { output: string | null } | null;
      }[];
      reported: boolean;
    }>(api.activity.list, {}, { query: `?runNumber=${run?.number}` });
    expect(page.status).toBe(200);
    expect(page.body.reported).toBe(true);
    const titles = page.body.activities.map((a) => [a.title, a.status]);
    expect(titles).toEqual(
      expect.arrayContaining([
        ['Edited invoice-pdf.ts', 'done'],
        ['Command failed', 'failed'],
        ['Started a run', 'done'],
        ['Finished the run', 'done'],
      ]),
    );
    const failed = page.body.activities.find((a) => a.title === 'Command failed');
    expect(failed?.detail).toBe('exit 1');
    expect(failed?.evidence?.output).toContain('3 failing');
    const all = await t.services.db.select().from(activities).where(eq(activities.burrowId, burrowId));
    expect(JSON.stringify(all)).not.toContain(SECRET);
    expect(new Set(all.map((a) => `${a.dispatchId}:${a.key}`)).size).toBe(all.length);
  });

  it('the Work view shows the blocked step with its next actions', async () => {
    const work = await call<WorkOverview>(api.work.overview, {});
    expect(work.status).toBe(200);
    const blocked = work.body.sections.find((x) => x.section === 'blocked')?.items ?? [];
    const item = blocked.find((i) => i.refs.stepId === step1);
    expect(item).toBeTruthy();
    expect(item?.actions).toEqual(expect.arrayContaining(['retry_step']));
    expect(item?.link).toMatchObject({ type: 'plan', planId, stepId: step1 });
  });
});

describe('recovery and completion', () => {
  it('retrying the step asks Dusty again; the new run finishes and the step is done, once', async () => {
    const retried = await call<{ messageId: string | null }>(
      api.plans.startStep,
      { planId, stepId: step1 },
      { body: { message: 'Try again.' } },
    );
    expect(retried.status).toBe(200);
    await turnFor(retried.body.messageId);
    const plan = await waitFor(async () => {
      const p = await planOf(planId);
      return p.steps[0]?.state === 'done' ? p : null;
    });
    expect(plan.steps[0]?.stateLabel).toBe('Done');
    // The same follow again (a repeated event, a restart's reconcile) changes nothing.
    const before = JSON.stringify((await planOf(planId)).steps);
    await reconcilePlans(t.services);
    await reconcilePlans(t.services);
    expect(JSON.stringify((await planOf(planId)).steps)).toBe(before);
  });

  it('step 2 waits for a person; approving deploys and completes it', async () => {
    const started = await call<{ messageId: string | null }>(
      api.plans.startStep,
      { planId, stepId: step2 },
      { body: {} },
    );
    expect(started.status).toBe(200);
    await turnFor(started.body.messageId);
    const gated = await waitFor(async () => {
      const p = await planOf(planId);
      return p.steps[1]?.state === 'gate' ? p : null;
    });
    const number = gated.steps[1]?.refs.approvalNumber;
    expect(number).toBeGreaterThan(0);
    const waiting = await t.services.db
      .select()
      .from(activities)
      .where(and(eq(activities.burrowId, burrowId), eq(activities.status, 'waiting')));
    expect(waiting.map((a) => a.title)).toEqual(['Waiting for approval']);
    const work = await call<WorkOverview>(api.work.overview, {});
    const needs = work.body.sections.find((x) => x.section === 'needs_you')?.items ?? [];
    expect(needs.find((i) => i.refs.approvalNumber === number)?.actions).toEqual(
      expect.arrayContaining(['approve', 'decline']),
    );
    // One decision, one item: the step it gates isn't listed again next to the approval.
    expect(needs.filter((i) => i.refs.stepId === step2)).toEqual([]);
    const decided = await call(
      api.approvals.decide,
      { number: number as number },
      { body: { decision: 'approve' } },
    );
    expect(decided.status).toBe(200);
    const plan = await waitFor(
      async () => {
        const p = await planOf(planId);
        return p.steps[1]?.state === 'done' ? p : null;
      },
      15_000,
      'the deploy step to be done',
    );
    expect(plan.steps[1]?.stateLabel).toBe('Deployed');
    expect(turns.slice(0, 4)).toEqual(['plan', 'build', 'build', 'deploy']);
  });
});

describe('searchable evidence', () => {
  it('finds the plan and the decision with their state, and Dusty cites them with receipts', async () => {
    const plans = await call<SearchResponse>(
      api.search.query,
      {},
      { query: '?q=invoice%20PDF%20export&type=plans' },
    );
    expect(plans.body.results[0]).toMatchObject({
      type: 'PLAN',
      link: { type: 'plan', planId },
      status: { text: '2 OF 2 DONE' },
    });
    const decisions = await call<SearchResponse>(
      api.search.query,
      {},
      { query: '?q=staging&type=decisions' },
    );
    const decision = decisions.body.results[0];
    expect(decision).toMatchObject({ type: 'DECISION', link: { type: 'approval' } });
    expect(decision?.status?.tone).toBe('ok');
    // The plan and approval cards aren't indexed a second time as messages (WS-23).
    const everything = await call<SearchResponse>(
      api.search.query,
      {},
      { query: '?q=invoice%20PDF%20export%20staging' },
    );
    const cardIds = [(await planOf(planId)).messageId].filter(Boolean);
    expect(everything.body.results.filter((r) => cardIds.includes(r.id))).toEqual([]);

    const asked = await call<{ answer: { id: string } }>(
      api.search.ask,
      {},
      { body: { q: 'invoice PDF export staging' } },
    );
    expect(asked.status).toBe(202);
    await turnFor(null);
    const answer = await waitFor(
      async () => {
        const r = await call<{ answer: { status: string; citations: { resultId: string }[] } }>(
          api.search.getAnswer,
          { answerId: asked.body.answer.id },
        );
        return r.body.answer.status === 'ready' ? r.body.answer : null;
      },
      20_000,
      'Dusty’s answer',
    );
    expect(answer.citations.map((c) => c.resultId).sort()).toEqual(
      expect.arrayContaining([planId, decision?.id].filter(Boolean) as string[]),
    );
  });
});
