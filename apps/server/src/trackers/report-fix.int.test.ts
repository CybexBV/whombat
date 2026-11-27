/**
 * Run #9 on John's DEV box, from a tracker report (run9 review), with the FakeTracker, the in-memory FakeGitHub and FAKE
 * AGENTS: a “Try it” run on a report its real trigger assessed a little earlier uses that assessment (RN-S2) and writes
 * it back as ever; the fix's pull request is announced in the run's thread with who sets the report's status (RN-S4);
 * and once it is merged, one line says so and what to set the tracker to (RN-S5), and once it is live that the customer wasn't
 * told (report-trackers.md TA-36) — The tracker itself is never told: this automation doesn't reply to customers.
 */
import {
  type AutomationRecipeInput,
  type AutomationRun,
  type ReportAssessmentInput,
  recipeInstructions,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BurrowAccess } from '../auth/request';
import { cleanUpMergedBranches } from '../automations/cleanup';
import {
  createAutomation,
  deleteAutomation,
  runAutomationNow,
  setAutomationKeys,
} from '../automations/commands';
import { sampleReport } from '../automations/routes';
import { automationGrants } from '../automations/store';
import { decideApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import { loadBurrowRow } from '../commit/pipeline';
import { approvals, automations, dispatches, pullRequests, vaultNetworks } from '../db/schema/index';
import { callTool } from '../mcp/server';
import { loadPrincipalRow } from '../read/principals';
import { buildDispatchContext } from '../runtime/context';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { FakeTracker, type FakeTrackerItem } from '../test/tracker';
import { useFakeTrackerDriver } from '../test/tracker-driver';
import { useVaultNetForTests } from '../vault/net';
import { unlandedFixOf } from './unlanded';

const w = useAutomationWorld();
const tracker = new FakeTracker();
const HOST = 'tracker-run9.home.test';
const ADDRESS = '192.168.92.10';
const REPO = 'whombat/billing';
let connectionId = '';

beforeAll(async () => {
  await tracker.start();
  useFakeTrackerDriver(w.services, tracker);
  const port = Number(new URL(tracker.url).port);
  useVaultNetForTests(w.services, {
    resolve: async (host) => {
      if (host !== HOST)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address: ADDRESS, family: 4 }];
    },
    dialAddress: (a) => (a === ADDRESS ? '127.0.0.1' : a),
    deadlineMs: 3000,
  });
  await w.services.db.insert(vaultNetworks).values({
    id: 'vnw_tracker_run9',
    cidr: '192.168.92.0/24',
    ports: [port],
    note: 'Fake tracker',
    addedAt: w.now(),
  });
  connectionId = await insertConnection(w.services, {
    catalogId: 'tracker',
    burrowId: w.burrowId,
    label: 'Acme dev',
    fields: { url: `http://${HOST}:${port}` },
    secret: tracker.token,
  });
});

afterAll(async () => {
  await tracker.stop();
});

function file(over: Partial<FakeTrackerItem> = {}): FakeTrackerItem {
  const at = w.now().toISOString();
  return tracker.add({ created_at: at, updated_at: at, ...over });
}

async function poll() {
  const result = await w.services.tracker.pollNow(connectionId);
  await w.settle();
  await w.services.tracker.settled();
  return result;
}

/** “Assess new reports in Acme dev” from billing-v2, writing back; with `fix`, fixing in whombat/billing on a yes. */
async function recipe(over: Partial<AutomationRecipeInput> = {}): Promise<string> {
  const when = {
    kind: 'tracker' as const,
    connectionId,
    itemKinds: ['bug', 'feature'] as ('bug' | 'feature')[],
  };
  const { automationId } = await w.ok(IDS.mara, createAutomation, {
    name: 'Assess new reports in Acme dev',
    source: {
      kind: 'recipe',
      recipe: {
        when,
        job: 'assess',
        instructions: recipeInstructions('assess', when),
        conversationId: IDS.billing,
        ...over,
      },
    },
    publish: true,
  });
  return automationId;
}

const step = (run: AutomationRun, id: string) => {
  const s = run.steps.find((x) => x.stepId === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const bug = (over: Partial<ReportAssessmentInput> = {}): ReportAssessmentInput => ({
  kind: 'bug',
  importance: 'high',
  confidence: 'high',
  size: 'small',
  summary: 'Saving a blueprint fails.',
  fixPlan: 'Handle the 500 in the save route.',
  recommends: 'change',
  ...over,
});

async function assess(runId: string, answer = 'A real bug in saving.') {
  const dispatchId = step(await w.run(runId), 'ask').dispatchId as string;
  expect(dispatchId).toBeTruthy();
  await w.services.db.update(dispatches).set({ state: 'running' }).where(eq(dispatches.id, dispatchId));
  const res = await callTool(
    w.services,
    { dispatchId, agentId: IDS.dusty, burrowId: w.burrowId },
    'report_assessment',
    bug(),
  );
  expect(res.isError).not.toBe(true);
  await w.fakeAgentReply(dispatchId, answer);
  await w.settle();
  await w.services.tracker.settled();
  return w.run(runId);
}

async function access(principalId: string): Promise<BurrowAccess> {
  const burrow = await loadBurrowRow(w.services.db, w.burrowId);
  const principal = await loadPrincipalRow(w.services.db, principalId);
  if (!burrow || !principal) throw new Error('no access');
  return { burrow, principal };
}

/** The texts of the run's own thread, in Mara's Feedback room (an assessing recipe's runs post there). */
async function thread(runId: string) {
  return (await w.runThread(runId)).map((m) => m.text);
}

describe('a “Try it” run on a report its trigger just assessed (RN-S2)', () => {
  it('uses that assessment and writes it back as ever; another report is assessed afresh', async () => {
    const id = await recipe();
    expect(await poll()).toMatchObject({ baseline: true });
    const report = file({ title: 'Saving a blueprint fails' });
    await poll();
    const [real] = await w.runs(id);
    const assessed = await assess(real?.id as string);
    expect(assessed.status).toBe('succeeded');

    w.advance(90 * 60_000);
    const automationTurns = (await w.dispatchesOf('automation')).length;
    const { runId } = await w.ok(IDS.mara, runAutomationNow, {
      automationId: id,
      test: true,
      sample: { reportId: report.id },
      sampleReport: await sampleReport(w.services, await access(IDS.mara), id, report.id),
    });
    await w.settle();
    await w.services.tracker.settled();
    const tried = await w.run(runId as string);
    expect((await w.dispatchesOf('automation')).length).toBe(automationTurns);
    expect(step(tried, 'ask')).toMatchObject({
      state: 'succeeded',
      inputSummary: `Used Dusty’s assessment from run #${assessed.number}: the report and the instructions haven’t changed`,
      output: {
        reusedFrom: { runId: assessed.id, runNumber: assessed.number },
        reply: 'A real bug in saving.',
      },
    });
    expect(step(tried, 'ask').output.assessment).toEqual(step(assessed, 'ask').output.assessment);
    expect(await thread(tried.id)).toEqual([
      `Dusty assessed this report in run #${assessed.number} an hour ago and nothing has changed since, so I’m using that assessment:\n\n> A real bug in saving.\n\nAsk Dusty here if you want a fresh look.`,
    ]);
    // Writing back reads the copied assessment: the tracker has it already, so there is nothing to send.
    expect(tried.status).toBe('succeeded');
    expect(step(tried, 'write_back')).toMatchObject({
      state: 'skipped',
      inputSummary: 'Nothing to write: Acme Desk already has this assessment and priority.',
      output: { write: { assessment: 'likely_bug', priority: 'high' }, wrote: false },
    });

    // Another report: assessed afresh.
    const other = file({ title: 'Rollouts never finish' });
    const { runId: otherRun } = await w.ok(IDS.mara, runAutomationNow, {
      automationId: id,
      test: true,
      sample: { reportId: other.id },
      sampleReport: await sampleReport(w.services, await access(IDS.mara), id, other.id),
    });
    await w.settle();
    const fresh = await w.run(otherRun as string);
    expect(step(fresh, 'ask').dispatchId).toBeTruthy();
    await assess(fresh.id);
    await poll();
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('the fix for a report (RN-S4, RN-S5)', () => {
  it('says where the pull request is and who sets the status, then once that it was merged; the tracker hears nothing', async () => {
    const id = await recipe({ repo: REPO, fix: { mode: 'ask' } });
    await poll();
    const report = file({ title: 'Exports lose the last row' });
    await poll();
    const run = (await w.runs(id)).at(-1) as AutomationRun;
    let now = await assess(run.id);
    const [card] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, step(now, 'approve').approvalId as string));
    await w.ok(IDS.mara, decideApproval, { number: card?.number as number, decision: 'approve' });
    await w.settle();
    now = await w.run(run.id);
    const branch = `feat/tracker-${report.number}`;
    await w.fakePush(REPO, branch, 'Keep the last row');
    await w.fakeAgentReply(step(now, 'fix').dispatchId as string, 'Exports keep the last row now.');
    await w.settle();
    now = await w.run(run.id);
    await w.fakeAgentReply(step(now, 'review').dispatchId as string, 'Approve: a test covers it.');
    await w.settle();
    now = await w.run(run.id);
    expect(now.status).toBe('succeeded');
    const [pr] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch));
    const link = `[PR #${pr?.number}](${pr?.url})`;
    expect((await thread(run.id)).filter((t) => t.includes(link))).toEqual([
      `Opened ${link}. Acme Desk isn’t told about it; you can set #${report.number}’s status on the run page.`,
    ]);

    const posts = tracker.posts.length;
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    const fake = w.services.github.fake;
    if (!fake) throw new Error('no FakeGitHub');
    await fake.simulateClose({ repo: REPO, number: pr?.number as number, login: 'mara-gh', merged: true });
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    expect(await cleanUpMergedBranches(w.services, w.now(), new Map())).toBe(1);
    // Whombat follows the fix (report-trackers.md TA-29), and it says the merge in RN-S5's words: this automation
    // doesn't reply to customers.
    const follow = async () => {
      w.advance(61_000);
      await w.services.tracker.followFixesNow();
    };
    await follow();
    const merged = `${link} was merged. If the customer should hear, set Acme Desk #${report.number} to “Fixed, waiting for a release” on the run page.`;
    expect((await thread(run.id)).filter((t) => t.includes('was merged'))).toEqual([merged]);
    expect(step(await w.run(run.id), 'pr').output).toMatchObject({
      mergedNotice: true,
      branchCleanup: { outcome: 'deleted' },
    });
    // Once, and nothing written to the tracker for it.
    expect(await cleanUpMergedBranches(w.services, w.now(), new Map())).toBe(0);
    await follow();
    expect((await thread(run.id)).filter((t) => t.includes('was merged'))).toHaveLength(1);
    expect(tracker.posts.slice(posts)).toEqual([]);
    // Live where the customer is (this tracker is production by its address, TA-32): the thread says so, and that the
    // customer wasn't told (TA-36).
    const revision = await fake.simulateCommitOn({ repo: REPO, branch: 'main' });
    tracker.health = {
      ...tracker.health,
      version: '0.1.176',
      source_revision: revision,
      source_dirty: false,
    };
    await follow();
    expect(await thread(run.id)).toContain(
      `The fix is live on ${HOST} (Acme Desk 0.1.176). The customer wasn’t told: this automation doesn’t reply to customers, so tell them on the run page.`,
    );
    expect(tracker.posts.slice(posts)).toEqual([]);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('opens a fix’s pull request a person said yes to, once, as it asked (the tracker’s line in its body)', async () => {
    const id = await recipe({ repo: REPO, fix: { mode: 'ask' } });
    const [row] = await w.services.db
      .select({ principalId: automations.principalId })
      .from(automations)
      .where(eq(automations.id, id));
    const grants = await automationGrants(w.services.db, row?.principalId as string);
    await w.ok(IDS.mara, setAutomationKeys, {
      automationId: id,
      grants: [
        ...grants.filter((g) => g.keyId !== 'pr.open'),
        { keyId: 'pr.open', tier: 'ask', repos: [REPO] },
      ],
    });
    await poll();
    const report = file({ title: 'Totals skip the last page' });
    await poll();
    const run = (await w.runs(id)).at(-1) as AutomationRun;
    let now = await assess(run.id);
    const [card] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, step(now, 'approve').approvalId as string));
    await w.ok(IDS.mara, decideApproval, { number: card?.number as number, decision: 'approve' });
    await w.settle();
    now = await w.run(run.id);
    const branch = `feat/tracker-${report.number}`;
    await w.fakePush(REPO, branch, 'Count the last page');
    await w.fakeAgentReply(step(now, 'fix').dispatchId as string, 'Totals count the last page now.');
    await w.settle();
    now = await w.run(run.id);
    await w.fakeAgentReply(step(now, 'review').dispatchId as string, 'Approve: a test covers it.');
    await w.settle();
    now = await w.run(run.id);
    // It asks before it opens the pull request; one yes opens it, never a second ask.
    expect(step(now, 'pr').state).toBe('waiting');
    const [ask] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, step(now, 'pr').approvalId as string));
    await w.ok(IDS.mara, decideApproval, { number: ask?.number as number, decision: 'approve' });
    await w.settle();
    now = await w.run(run.id);
    expect(step(now, 'pr').state).toBe('succeeded');
    const [done] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, ask?.id as string));
    expect(done?.execution.state).toBe('succeeded');
    const [pr] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch));
    expect(pr).toBeTruthy();
    // What it opened: the tracker's line before the marker that names the report.
    const body = String((done?.command?.input as { body?: unknown } | undefined)?.body);
    expect(body).toContain(
      `Tracker report: ${HOST} #${report.number}\n<!-- whombat-tracker:${connectionId}:${report.number} -->`,
    );
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('continues an unlanded report run from review in the person’s follow-up turn and opens the pull request', async () => {
    const id = await recipe({ repo: REPO, fix: { mode: 'ask' } });
    await poll();
    const report = file({ title: 'Exports drop the final row' });
    await poll();
    const run = (await w.runs(id)).at(-1) as AutomationRun;
    let now = await assess(run.id);
    const [card] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, step(now, 'approve').approvalId as string));
    await w.ok(IDS.mara, decideApproval, { number: card?.number as number, decision: 'approve' });
    await w.settle();
    now = await w.run(run.id);
    const branch = `feat/tracker-${report.number}`;
    await w.fakePush(REPO, branch, 'Keep the final row');
    await w.fakeAgentReply(step(now, 'fix').dispatchId as string, 'Exports keep the final row now.');
    await w.settle();
    now = await w.run(run.id);
    // Review asks for changes: the run finishes unlanded before opening the PR.
    await w.fakeAgentReply(
      step(now, 'review').dispatchId as string,
      'Changes needed: add a test for empty exports.',
    );
    await w.settle();
    now = await w.run(run.id);
    expect(now.status).toBe('succeeded');
    expect(step(now, 'pr').state).toBe('skipped');
    const threadRootId = now.threadRootId as string;

    // unlandedFixOf reports the unlanded run with `review` as the next step.
    const unlanded = await unlandedFixOf(w.services.db, {
      burrowId: w.burrowId,
      conversationId: now.conversationId,
      threadRootId,
    });
    expect(unlanded).toMatchObject({
      runId: run.id,
      reportNumber: report.number,
      repo: REPO,
      branch,
      nextStepId: 'review',
    });

    // Mara writes in the thread, creating a person turn whose DispatchContext carries `unlandedFix`.
    await w.ok(IDS.mara, sendMessage, {
      conversationId: now.conversationId,
      threadRootId,
      text: '@dusty Finish fixing the test and land it.',
    });
    const personDispatches = await w.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.threadRootId, threadRootId));
    const personDispatch = personDispatches.find((d) => d.trigger !== 'automation');
    if (!personDispatch) throw new Error('expected person dispatch');
    const dispatchCtx = await buildDispatchContext(w.services, personDispatch);
    expect(dispatchCtx.unlandedFix).toMatchObject({ runId: run.id, nextStepId: 'review' });

    // An automation-step dispatch cannot call automation_continue_run.
    const autoDispatch = personDispatches.find((d) => d.trigger === 'automation');
    if (!autoDispatch) throw new Error('expected automation dispatch');
    const blocked = await callTool(
      w.services,
      {
        burrowId: w.burrowId,
        agentId: IDS.dusty,
        dispatchId: autoDispatch.id,
      },
      'automation_continue_run',
      { runId: run.id, fromStepId: 'review' },
    );
    expect(blocked.isError).toBe(true);

    // Past a review that asked for changes nothing merges: the turn hears it, and the run stays as it ended.
    const skipped = await callTool(
      w.services,
      { burrowId: w.burrowId, agentId: IDS.dusty, dispatchId: personDispatch.id },
      'automation_continue_run',
      { runId: run.id, fromStepId: 'pr' },
    );
    expect(JSON.stringify(skipped)).toContain('review');
    expect(skipped.structuredContent).not.toMatchObject({ status: 'ok' });
    expect((await w.run(run.id)).status).toBe(now.status);

    // The person turn continues the run from `review` with a note about the pushed follow-up commit.
    await w.fakePush(REPO, branch, 'Add empty export test');
    const resumed = await callTool(
      w.services,
      {
        burrowId: w.burrowId,
        agentId: IDS.dusty,
        dispatchId: personDispatch.id,
      },
      'automation_continue_run',
      {
        runId: run.id,
        fromStepId: 'review',
        note: 'Added the empty-exports test and pushed the updated branch.',
      },
    );
    expect(resumed.isError).not.toBe(true);
    expect(resumed.structuredContent).toMatchObject({ status: 'ok', runId: run.id, fromStepId: 'review' });
    await w.settle();
    now = await w.run(run.id);
    expect(now.status).toBe('waiting');
    expect(step(now, 'review').state).toBe('waiting');
    expect(String((step(now, 'fix').output as { reply?: unknown }).reply)).toContain(
      'Added the empty-exports test',
    );
    // The fresh review approves -> Whombat opens the pull request and finishes the run!
    await w.fakeAgentReply(step(now, 'review').dispatchId as string, 'Approve: empty export test passes.');
    await w.settle();
    now = await w.run(run.id);
    expect(now.status).toBe('succeeded');
    expect(step(now, 'pr').state).toBe('succeeded');
    const [pr] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch));
    expect(pr).toBeTruthy();
    // Now that the PR opened (for a recipe without auto-merge), unlandedFixOf returns null.
    expect(
      await unlandedFixOf(w.services.db, {
        burrowId: w.burrowId,
        conversationId: now.conversationId,
        threadRootId,
      }),
    ).toBeNull();
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});
