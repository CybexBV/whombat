/**
 * The automation owns the pull request of its fix (run9 review RN-S3, RN-S4), on a real database with the in-memory
 * FakeGitHub and FAKE AGENTS: the developer is told so in its instructions, its `open_pull_request` is refused in that
 * turn, a run it started there gets no pull request from RC-08, the `pr` step says where the pull request is in the
 * run's thread, and when someone opened the pull request anyway the automation's body — the review in it — goes on it as
 * one comment.
 */
import {
  type AutomationRecipeInput,
  type AutomationRun,
  newId,
  type ReportAssessmentInput,
  recipeInstructions,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openPr } from '../commands/agent-tools';
import { decideApproval } from '../commands/approvals';
import { approvals, automations, dispatches, grants, pullRequests, runs } from '../db/schema/index';
import type { FakeGitHub } from '../github/fake';
import { callTool } from '../mcp/server';
import { buildDispatchContext } from '../runtime/context';
import { afterRunTurn } from '../runtime/run-recovery';
import { IDS, useAutomationWorld } from '../test/automations';
import { createAutomation, deleteAutomation } from './commands';
import { automationOpensPrText, ownPullRequestLine } from './workspace';

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

/**
 * The run's thread as people read it, in the publisher's Feedback room where an assessing recipe's runs post: its first
 * message, then the replies, oldest first.
 */
async function thread(runId: string) {
  return w.runThread(runId);
}

async function principalOf(automationId: string) {
  const [a] = await w.services.db.select().from(automations).where(eq(automations.id, automationId));
  return a?.principalId as string;
}

/** Dusty's “Open pull requests” at Can: RC-08 would open one for his pushed run at once. */
async function banjoOpensPrs() {
  await w.services.db
    .update(grants)
    .set({ tier: 'can' })
    .where(and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, 'pr.open')));
}

describe('the automation owns its pull request (RN-S3, RN-S4)', () => {
  it('tells the developer, refuses its own pull request and RC-08’s, then opens it and says where', async () => {
    await banjoOpensPrs();
    const id = await recipe();
    await poll();
    const { n, run } = await issueRun(id, 'Discounts apply twice');
    let now = await decide(await assess(run.id), 'approve', 'approve');
    const branch = `feat/issue-${n}`;

    // (a) The developer's instructions end with one line about the pull request; it reads them with its turn.
    const fix = step(now, 'fix');
    const fixTurn = fix.dispatchId as string;
    const instructions = String(fix.output.instructions);
    expect(instructions.endsWith(`\n\n${ownPullRequestLine(true)}`)).toBe(true);
    await claimed(fixTurn);
    const [turnRow] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, fixTurn));
    const seen = await buildDispatchContext(w.services, turnRow as NonNullable<typeof turnRow>);
    expect(seen.trigger?.text).toBe(`@Dusty ${instructions}`);
    // (b) Its open_pull_request is refused in this turn, in plain words.
    await w.fakePush(REPO, branch, 'Apply discounts once');
    expect(
      await tool(fixTurn, 'open_pull_request', { repo: REPO, branch, base: 'main', title: 'Fix', body: '' }),
    ).toEqual({
      isError: true,
      body: { error: { code: 'forbidden', message: automationOpensPrText(true) } },
    });
    // (c) A run it started in this turn gets no pull request after the turn (RC-08).
    await w.services.db.insert(runs).values({
      id: newId('run'),
      burrowId: w.burrowId,
      number: 9101,
      agentId: IDS.dusty,
      title: 'Apply discounts once',
      branch,
      repoId: 'rep_billing',
      status: 'done',
      askedById: IDS.mara,
      conversationId: BILLING,
      dispatchId: fixTurn,
      startedAt: w.now(),
    });
    await w.fakeAgentReply(fixTurn, 'Discounts apply once now; a test covers it.');
    await afterRunTurn(w.services, fixTurn, { workspace: { pushedCommits: 1, problems: [] } });
    expect(await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch))).toEqual(
      [],
    );
    await w.settle();
    now = await w.run(run.id);
    expect(step(now, 'fix').state).toBe('succeeded');
    expect(String(step(now, 'review').output.instructions)).not.toContain(ownPullRequestLine(true));

    // The review approves: the automation opens it, with the review in its body, and says where it is (RN-S4).
    const review = step(now, 'review').dispatchId as string;
    await w.fakeAgentReply(review, 'Approve: the test fails without the fix and passes with it.');
    await w.settle();
    now = await w.run(run.id);
    const [pr] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch));
    expect(pr).toMatchObject({ state: 'open', title: `Fix #${n}: Discounts apply twice` });
    expect(step(now, 'pr').output).toMatchObject({ opened: true, prNumber: pr?.number, announced: true });
    expect(step(now, 'pr').output.alreadyOpen).toBeUndefined();
    const lines = (await thread(run.id)).filter((m) => m.text.includes(`PR #${pr?.number}`));
    expect(lines.map((m) => m.text)).toEqual([`Opened [PR #${pr?.number}](${pr?.url}).`]);
    expect(lines[0]?.authorId).toBe(await principalOf(id));
    await done(id);
  });

  it('RC-08 still opens one for a run that isn’t an automation’s fix', async () => {
    await banjoOpensPrs();
    const turn = newId('dispatch');
    await w.services.db.insert(dispatches).values({
      id: turn,
      burrowId: w.burrowId,
      agentId: IDS.dusty,
      trigger: 'mention',
      mode: 'reply',
      conversationId: BILLING,
      state: 'done',
      createdAt: w.now(),
    });
    const branch = 'feat/rc08-control';
    await w.fakePush(REPO, branch, 'A change asked for in the room');
    await w.services.db.insert(runs).values({
      id: newId('run'),
      burrowId: w.burrowId,
      number: 9102,
      agentId: IDS.dusty,
      title: 'A change asked for in the room',
      branch,
      repoId: 'rep_billing',
      status: 'done',
      askedById: IDS.mara,
      conversationId: BILLING,
      dispatchId: turn,
      startedAt: w.now(),
    });
    await afterRunTurn(w.services, turn, { workspace: { pushedCommits: 1, problems: [] } });
    expect(
      await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch)),
    ).toMatchObject([{ state: 'open', title: 'A change asked for in the room' }]);
  });

  it('comments its own body on a pull request someone opened meanwhile, once, and says it was already open', async () => {
    const id = await recipe({}, 'Assess and fix');
    await poll();
    const { n, run } = await issueRun(id, 'Refunds round down');
    let now = await decide(await assess(run.id), 'approve', 'approve');
    const branch = `feat/issue-${n}`;
    await w.fakePush(REPO, branch, 'Round refunds half up');
    await w.fakeAgentReply(step(now, 'fix').dispatchId as string, 'Refunds round half up now.');
    await w.settle();
    // A person opens it by hand before the review is done.
    const mine = await w.ok(IDS.mara, openPr, {
      repo: REPO,
      branch,
      base: 'main',
      title: 'Refunds, by hand',
      body: 'Opened by Mara.',
    });
    now = await w.run(run.id);
    const comments = fake().comments.length;
    await w.fakeAgentReply(step(now, 'review').dispatchId as string, 'Approve: rounding is right now.');
    await w.settle();
    now = await w.run(run.id);
    const [pr] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch));
    expect(pr?.number).toBe(mine.number);
    expect(step(now, 'pr')).toMatchObject({
      state: 'succeeded',
      prNumber: mine.number,
      inputSummary: `PR #${mine.number} was already open from ${branch}`,
    });
    expect(step(now, 'pr').output).toMatchObject({
      alreadyOpen: true,
      commented: true,
      comment: null,
      announced: true,
    });
    // Its title and body stay Mara's; the automation's body — with the review — is one comment on it.
    const onGitHub = fake().repos.get(REPO)?.prs.get(mine.number);
    expect(onGitHub?.title).toBe('Refunds, by hand');
    const posted = fake().comments.slice(comments);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ repo: REPO, number: mine.number });
    expect(posted[0]?.body).toMatch(
      new RegExp(`^Fixes #${n}\\.\\n\\n## What changed\\n\\nRefunds round half up now\\.`),
    );
    expect(posted[0]?.body).toContain('## Review\n\nApprove: rounding is right now.');
    expect(posted[0]?.body).toMatch(/\n\n— .+ via Whombat$/);
    const lines = (await thread(run.id)).filter((m) => m.text.includes(`PR #${mine.number}`));
    expect(lines.map((m) => m.text)).toEqual([`[PR #${mine.number}](${pr?.url}) was already open.`]);
    // Once.
    await w.settle();
    expect(fake().comments.slice(comments)).toHaveLength(1);
    await done(id);
  });
});
