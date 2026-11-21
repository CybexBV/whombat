/**
 * A “Try it” run reuses a fresh, identical assessment (run9 review RN-S2), on a real database with the in-memory
 * FakeGitHub and FAKE AGENTS: a test run on an issue an earlier run assessed the same way (same agent, checkout and
 * instructions, within 24 hours) uses that assessment instead of asking again, says so in its own thread, and the steps
 * after it go on; another issue, edited instructions, an older assessment and a pull request are assessed afresh.
 */
import {
  type AutomationRecipeInput,
  type AutomationRun,
  type ReportAssessmentInput,
  recipeDefinition,
  recipeInstructions,
} from '@whombat/core';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { approvals, automations, dispatches, messages } from '../db/schema/index';
import type { FakeGitHub } from '../github/fake';
import { callTool } from '../mcp/server';
import { IDS, useAutomationWorld } from '../test/automations';
import { createAutomation, deleteAutomation, runAutomationNow, saveAutomationDraft } from './commands';
import { fetchGitHubItem } from './github-items';
import { loadRunRow } from './store';

const w = useAutomationWorld();
const REPO = 'whombat/billing';
const BILLING = IDS.billing;

const fake = (): FakeGitHub => {
  const f = w.services.github.fake;
  if (!f) throw new Error('no FakeGitHub');
  return f;
};

async function poll() {
  const report = await w.services.github.poller.pollNow({ burrowId: w.burrowId });
  if (report.errors.length) throw new Error(report.errors.join('; '));
  await w.settle();
}

type Fix = NonNullable<AutomationRecipeInput['fix']>;
const WHEN = { kind: 'github' as const, repo: REPO, events: ['issue_opened' as const] };
const recipeInput = (over: Partial<AutomationRecipeInput> = {}): AutomationRecipeInput => ({
  when: WHEN,
  job: 'assess',
  instructions: recipeInstructions('assess', WHEN),
  conversationId: BILLING,
  replyOnGitHub: false,
  fix: { mode: 'ask' } satisfies Fix,
  ...over,
});

/** A recipe that assesses the repo's new issues in #billing-v2 and fixes them once a person says yes. */
async function recipe(
  over: Partial<AutomationRecipeInput> = {},
  name = 'Assess new issues',
): Promise<string> {
  const { automationId } = await w.ok(IDS.mara, createAutomation, {
    name,
    source: { kind: 'recipe', recipe: recipeInput(over) },
    publish: true,
  });
  return automationId;
}

async function done(automationId: string) {
  await w.ok(IDS.mara, deleteAutomation, { automationId });
}

async function issueRun(automationId: string, title: string) {
  const n = await fake().simulateOpenIssue({ repo: REPO, title, login: 'jdoe' });
  await poll();
  const run = (await w.runs(automationId)).at(-1) as AutomationRun;
  expect(run.trigger.kind).toBe('github');
  return { n, run };
}

async function tryOn(automationId: string, n: number) {
  const { runId } = await w.ok(IDS.mara, runAutomationNow, {
    automationId,
    test: true,
    sample: { number: n },
    sampleItem: await fetchGitHubItem(fake(), w.burrowId, REPO, n),
  });
  await w.settle();
  return w.run(runId as string);
}

const step = (run: AutomationRun, id: string) => {
  const s = run.steps.find((x) => x.stepId === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

async function claimed(dispatchId: string) {
  await w.services.db.update(dispatches).set({ state: 'running' }).where(eq(dispatches.id, dispatchId));
}

async function tool(dispatchId: string, name: string, args: Record<string, unknown>, agentId = IDS.dusty) {
  const res = await callTool(w.services, { dispatchId, agentId, burrowId: w.burrowId }, name, args);
  return { isError: res.isError === true, body: (res.structuredContent ?? {}) as Record<string, unknown> };
}

const bug = (over: Partial<ReportAssessmentInput> = {}): ReportAssessmentInput => ({
  kind: 'bug',
  importance: 'high',
  confidence: 'high',
  size: 'small',
  summary: 'Totals are rounded twice.',
  fixPlan: 'Round once, in totals.ts.',
  recommends: 'change',
  ...over,
});

/** The FAKE AGENT's assessment turn: it reports, answers, and the engine moves on. */
async function assess(runId: string, answer = 'Totals round twice: once per line, once at the end.') {
  const dispatchId = step(await w.run(runId), 'ask').dispatchId as string;
  expect(dispatchId).toBeTruthy();
  await claimed(dispatchId);
  expect(await tool(dispatchId, 'report_assessment', bug())).toMatchObject({ isError: false });
  await w.fakeAgentReply(dispatchId, answer);
  await w.settle();
  return w.run(runId);
}

async function decide(run: AutomationRun, id: string, decision: 'approve' | 'decline') {
  const [a] = await w.services.db
    .select()
    .from(approvals)
    .where(eq(approvals.id, step(run, id).approvalId as string));
  await w.ok(IDS.mara, decideApproval, { number: a?.number as number, decision });
  await w.settle();
  return w.run(run.id);
}

/** The run's thread as people read it (in Mara's Feedback room, where an assessing recipe's runs post): its first
 * message, then the replies, oldest first. */
async function thread(runId: string) {
  const row = await loadRunRow(w.services.db, runId);
  const root = row.threadRootId as string;
  const rows = await w.services.db
    .select({
      id: messages.id,
      authorId: messages.authorId,
      text: messages.text,
      root: messages.threadRootId,
    })
    .from(messages)
    .where(eq(messages.conversationId, row.conversationId))
    .orderBy(asc(messages.ord));
  return rows.filter((m) => m.id === root || m.root === root);
}

async function principalOf(automationId: string) {
  const [a] = await w.services.db.select().from(automations).where(eq(automations.id, automationId));
  return a?.principalId as string;
}

const automationDispatches = async () => (await w.dispatchesOf('automation')).length;
describe('a “Try it” run on an issue assessed a moment ago (RN-S2)', () => {
  it('uses that assessment, says so in its own thread, and the steps after it go on', async () => {
    const id = await recipe();
    await poll();
    const { n, run: first } = await issueRun(id, 'Totals are off by a cent');
    let real = await assess(first.id);
    expect(step(real, 'approve').state).toBe('waiting');
    real = await decide(real, 'approve', 'decline');
    const assessed = step(real, 'ask');

    w.advance(90 * 60_000);
    const before = await automationDispatches();
    let tried = await tryOn(id, n);
    // Nobody was asked: the step took the earlier assessment and answer.
    expect(await automationDispatches()).toBe(before);
    const ask = step(tried, 'ask');
    expect(ask).toMatchObject({
      state: 'succeeded',
      dispatchId: null,
      inputSummary: `Used Dusty’s assessment from run #${real.number}: the issue and the instructions haven’t changed`,
    });
    expect(ask.output).toMatchObject({
      instructions: assessed.output.instructions,
      workspace: assessed.output.workspace,
      assessment: assessed.output.assessment,
      text: assessed.output.text,
      reply: 'Totals round twice: once per line, once at the end.',
      reusedFrom: { runId: real.id, runNumber: real.number },
    });
    // One message starts the test run's own thread (AR-17); the card under it asks as for a fresh assessment.
    const said = await thread(tried.id);
    expect(said.map((m) => m.text)).toEqual([
      `Dusty assessed this issue in run #${real.number} an hour ago and nothing has changed since, so I’m using that assessment:\n\n> Totals round twice: once per line, once at the end.\n\nAsk Dusty here if you want a fresh look.`,
      `I need a person to say yes before I go on: Fix #${n}: Totals are off by a cent`,
    ]);
    expect(said[0]?.authorId).toBe(await principalOf(id));
    expect((await loadRunRow(w.services.db, tried.id)).threadRootId).not.toBe(
      (await loadRunRow(w.services.db, real.id)).threadRootId,
    );
    // The check and the card read the copied assessment as they read a fresh one.
    expect(step(tried, 'worth_fixing').output).toMatchObject({ result: true });
    expect(step(tried, 'approve').state).toBe('waiting');
    const [card] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, step(tried, 'approve').approvalId as string));
    expect(card).toMatchObject({ title: `Fix #${n}: Totals are off by a cent`, question: 'Fix this bug?' });
    tried = await decide(tried, 'approve', 'decline');

    // Another issue: assessed afresh.
    const other = await fake().simulateOpenIssue({ repo: REPO, title: 'Another one', login: 'jdoe' });
    const fresh = await tryOn(id, other);
    expect(step(fresh, 'ask')).toMatchObject({ state: 'waiting' });
    expect(step(fresh, 'ask').dispatchId).toBeTruthy();
    await decide(await assess(fresh.id), 'approve', 'decline');

    // A day later the assessment is too old: assessed afresh. That test run's assessment then counts too.
    w.advance(23 * 3_600_000);
    const late = await tryOn(id, n);
    expect(step(late, 'ask').dispatchId).toBeTruthy();
    await decide(await assess(late.id, 'Still rounding twice.'), 'approve', 'decline');
    const again = await tryOn(id, n);
    expect(step(again, 'ask').output).toMatchObject({
      reply: 'Still rounding twice.',
      reusedFrom: { runId: late.id, runNumber: (await w.run(late.id)).number },
    });
    expect(step(again, 'ask').inputSummary).toContain(`from run #${(await w.run(late.id)).number}`);
    await decide(again, 'approve', 'decline');

    // Edited instructions (the draft a test run tries): assessed afresh.
    await w.ok(IDS.mara, saveAutomationDraft, {
      automationId: id,
      definition: JSON.parse(
        JSON.stringify(recipeDefinition(recipeInput({ instructions: 'Assess it, briefly.' }))),
      ),
    });
    const edited = await tryOn(id, n);
    expect(step(edited, 'ask').dispatchId).toBeTruthy();
    expect(String(step(edited, 'ask').output.instructions)).toMatch(/^Assess it, briefly\./);
    await decide(await assess(edited.id), 'approve', 'decline');
    await done(id);
  });

  it('never for a pull request, and never for a real run', async () => {
    const id = await recipe(
      { when: { kind: 'github', repo: REPO, events: ['pr_opened'] }, fix: undefined, job: 'assess' },
      'Assess new pull requests',
    );
    await poll();
    await w.fakePush(REPO, 'feat/pdf-totals', 'Totals in the PDF');
    const pr = await fake().simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/pdf-totals',
      title: 'Totals in the PDF',
      login: 'jdoe',
    });
    await poll();
    const [real] = await w.runs(id);
    expect((await loadRunRow(w.services.db, real?.id as string)).scope).toMatchObject({
      item: 'pull_request',
      number: pr,
    });
    expect(step(await assess(real?.id as string), 'ask').state).toBe('succeeded');
    const tried = await tryOn(id, pr);
    expect(step(tried, 'ask').dispatchId).toBeTruthy();
    expect(step(tried, 'ask').output.reusedFrom).toBeUndefined();
    await assess(tried.id);
    await done(id);
  });
});
