/**
 * An automation merges its fix once its checks pass (docs/decisions/automation-recipes.md AR-44…AR-47), on a real
 * database with the in-memory FakeGitHub, its poller and FAKE AGENTS (test/automations.ts): a recipe made and published
 * with merging gets “Merge into main”; its fix's pull request waits for the checks and merges — passed, pending then
 * passed, none after the grace —, and AR-42 then deletes the branch; failed checks, a head that moved after the review,
 * changes requested, a closed pull request and checks that don't finish in time leave it for a person; merged by
 * someone meanwhile succeeds; failed GitHub Actions jobs run once more (AR-57), only for an infrastructure fault where
 * the repository says so; the key at No and at Asks; and no pull request skips the step.
 */
import type { AutomationRecipeInput, AutomationRun, ReportAssessmentInput } from '@whombat/core';
import { recipeDefinition, recipeInstructions } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import {
  approvals,
  automationRunSteps,
  automations,
  dispatches,
  events,
  messages,
  prChecks,
  pullRequests,
} from '../db/schema/index';
import { GitHubError } from '../github/adapter';
import type { FakeGitHub } from '../github/fake';
import { callTool } from '../mcp/server';
import { IDS, useAutomationWorld } from '../test/automations';
import { FIX_TRIES_MAX } from './again';
import { cleanUpMergedBranches } from './cleanup';
import {
  createAutomation,
  deleteAutomation,
  publishAutomationDraft,
  saveAutomationDraft,
  setAutomationKeys,
} from './commands';
import { MERGE_CHECKS_GRACE_MS, NOTHING_TO_MERGE } from './merge';
import { loadAutomationRow, loadRunRow, toAutomation } from './store';

const w = useAutomationWorld();
const REPO = 'whombat/billing';
const BILLING = IDS.billing;

const fake = (): FakeGitHub => {
  const f = w.services.github.fake;
  if (!f) throw new Error('no FakeGitHub');
  return f;
};

/** One poll cycle of the burrow's repos, then the engine until nothing moves. */
async function poll() {
  const report = await w.services.github.poller.pollNow({ burrowId: w.burrowId });
  if (report.errors.length) throw new Error(report.errors.join('; '));
  await w.settle();
}

type Fix = NonNullable<AutomationRecipeInput['fix']>;

const plainRecipe = (over: Partial<AutomationRecipeInput> = {}) => {
  const when = { kind: 'github' as const, repo: REPO, events: ['issue_opened' as const] };
  return {
    when,
    job: 'assess' as const,
    instructions: recipeInstructions('assess', when),
    conversationId: BILLING,
    replyOnGitHub: true,
    ...over,
  };
};

/** A recipe that assesses new issues, fixes bugs once a person says yes and merges the fix, made and published. */
async function recipe(fix: Partial<Fix> = {}, over: Partial<AutomationRecipeInput> = {}): Promise<string> {
  const { automationId } = await w.ok(IDS.mara, createAutomation, {
    source: {
      kind: 'recipe',
      recipe: plainRecipe({ fix: { mode: 'ask', merge: 'checks', ...fix }, ...over }),
    },
    publish: true,
  });
  await poll();
  return automationId;
}

async function grantsOf(automationId: string) {
  const row = await loadAutomationRow(w.services.db, w.burrowId, automationId);
  return (await toAutomation(w.services.db, row)).grants;
}

async function principalOf(automationId: string) {
  const [a] = await w.services.db.select().from(automations).where(eq(automations.id, automationId));
  return a?.principalId as string;
}

const step = (run: AutomationRun, id: string) => {
  const s = run.steps.find((x) => x.stepId === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const bug: ReportAssessmentInput = {
  kind: 'bug',
  importance: 'high',
  confidence: 'high',
  size: 'small',
  summary: 'Totals are rounded twice.',
  fixPlan: 'Round once, in totals.ts.',
  recommends: 'change',
};

async function approvalOf(run: AutomationRun, id: string) {
  const [a] = await w.services.db
    .select()
    .from(approvals)
    .where(eq(approvals.id, step(run, id).approvalId as string));
  if (!a) throw new Error(`no approval for ${id}`);
  return a;
}

async function decide(run: AutomationRun, id: string, decision: 'approve' | 'decline') {
  const a = await approvalOf(run, id);
  await w.ok(IDS.mara, decideApproval, { number: a.number, decision });
  await w.settle();
  return w.run(run.id);
}

/** The FAKE AGENT answers an agent step; `push` lands a commit on the branch first. */
async function agentStep(runId: string, id: string, text: string, push?: string) {
  const dispatchId = step(await w.run(runId), id).dispatchId as string;
  expect(dispatchId).toBeTruthy();
  if (push) await w.fakePush(REPO, push, `Round once (${runId})`);
  await w.fakeAgentReply(dispatchId, text);
  await w.settle();
  return w.run(runId);
}

/** A new issue, assessed as a bug, a person's yes, the fix pushed, the review's “Approve”: the run past its review. */
async function reviewed(automationId: string, title: string) {
  const n = await fake().simulateOpenIssue({ repo: REPO, title, login: 'jdoe' });
  await poll();
  const runs = await w.runs(automationId);
  const runId = (runs.at(-1) as AutomationRun).id;
  expect((await loadRunRow(w.services.db, runId)).scope).toMatchObject({ number: n });
  const ask = step(await w.run(runId), 'ask').dispatchId as string;
  await w.services.db.update(dispatches).set({ state: 'running' }).where(eq(dispatches.id, ask));
  await callTool(
    w.services,
    { dispatchId: ask, agentId: IDS.dusty, burrowId: w.burrowId },
    'report_assessment',
    bug,
  );
  await w.fakeAgentReply(ask, 'A rounding bug in totals.ts.');
  await w.settle();
  let run = await decide(await w.run(runId), 'approve', 'approve');
  run = await agentStep(runId, 'fix', 'Added a failing test, then rounded once.', `feat/issue-${n}`);
  expect(step(run, 'fix').output.head).toEqual(expect.any(String));
  run = await agentStep(runId, 'review', 'Approve: the test fails without the fix and passes with it.');
  return { n, runId, run };
}

/** `reviewed`, and the fix's pull request as the mirror has it: the run up to its merge step. */
async function fixed(automationId: string, title: string) {
  const { n, runId, run } = await reviewed(automationId, title);
  const [pr] = await w.services.db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.branch, `feat/issue-${n}`));
  if (!pr) throw new Error('no pull request');
  // The pull request is the reviewed commit.
  expect(pr.headSha).toBe(step(run, 'fix').output.head);
  // The poller sees it open, as it would long before anything happens to it.
  await poll();
  return { n, runId, run: await w.run(runId), pr };
}

async function checks(
  sha: string,
  o: { status?: 'in_progress' | 'completed'; conclusion?: 'success' | 'failure' },
) {
  await fake().simulateCheckRun({ repo: REPO, sha, name: 'ci', ...o });
  await poll();
}

/** The automation's lines in the run's thread. */
async function threadLines(runId: string, automationId: string) {
  const run = await loadRunRow(w.services.db, runId);
  const rows = await w.services.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.threadRootId, run.threadRootId as string),
        eq(messages.authorId, await principalOf(automationId)),
      ),
    )
    .orderBy(asc(messages.ord));
  return rows.map((m) => m.text);
}

const merged = (number: number) => fake().merges.filter((m) => m.repo === REPO && m.number === number);

async function done(automationId: string) {
  await w.ok(IDS.mara, deleteAutomation, { automationId });
}

/**
 * The most tries the engine makes at a fix. Tests of how a merge leaves its pull request for a person make one, so the
 * run ends there; a fix that goes round again by itself has its own tests below.
 */
const tries = (n: number) => {
  w.services.automations.options.fixTriesMax = n;
};
afterEach(() => tries(FIX_TRIES_MAX));

describe('a recipe that merges its fix (AR-44)', () => {
  it('is made with “Merge into main”, its merge step last and its sentence saying so', async () => {
    const id = await recipe();
    expect(await grantsOf(id)).toEqual([
      { keyId: 'pr.comment', tier: 'can', repos: [REPO] },
      { keyId: 'pr.open', tier: 'can', repos: [REPO] },
      { keyId: 'merge.main', tier: 'can', repos: [REPO] },
    ]);
    const row = await loadAutomationRow(w.services.db, w.burrowId, id);
    const automation = await toAutomation(w.services.db, row);
    expect(automation.definition?.steps.map((s) => s.id).at(-1)).toBe('merge');
    expect(automation.description).toBe(
      'When a new issue is opened on whombat/billing, Dusty assesses it in billing-v2 and comments on GitHub, and fixes bugs or makes the changes Dusty suggests once a person says yes, and merges the fix once its checks pass.',
    );
    await done(id);
  });

  it('published again with merging, gets “Merge into main” unless a person set that key', async () => {
    const edit = async (automationId: string) => {
      const merging = recipeDefinition(plainRecipe({ fix: { mode: 'ask', merge: 'checks' } }));
      await w.ok(IDS.mara, saveAutomationDraft, {
        automationId,
        definition: JSON.parse(JSON.stringify(merging)),
      });
      await w.ok(IDS.mara, publishAutomationDraft, {
        automationId,
        definitionHash: await w.draftHash(automationId),
      });
      return grantsOf(automationId);
    };
    const fixing = async () =>
      (
        await w.ok(IDS.mara, createAutomation, {
          source: { kind: 'recipe', recipe: plainRecipe({ fix: { mode: 'ask' } }) },
          publish: true,
        })
      ).automationId;
    const id = await fixing();
    expect((await grantsOf(id)).map((g) => g.keyId)).not.toContain('merge.main');
    expect(await edit(id)).toContainEqual({ keyId: 'merge.main', tier: 'can', repos: [REPO] });
    await done(id);

    const kept = await fixing();
    await w.ok(IDS.mara, setAutomationKeys, {
      automationId: kept,
      grants: [
        { keyId: 'pr.comment', tier: 'can', repos: [REPO] },
        { keyId: 'pr.open', tier: 'can', repos: [REPO] },
        { keyId: 'merge.main', tier: 'ask', repos: [REPO] },
      ],
    });
    expect(await edit(kept)).toContainEqual({ keyId: 'merge.main', tier: 'ask', repos: [REPO] });
    await done(kept);
  });
});

describe('merging once the checks pass (AR-45…AR-47)', () => {
  it('merges when the checks pass, says so in the thread, and AR-42 then deletes the branch', async () => {
    const id = await recipe();
    const { n, runId, run, pr } = await fixed(id, 'Totals are off by a cent');
    expect(run.status).toBe('waiting');
    const waiting = step(run, 'merge');
    expect(waiting).toMatchObject({
      state: 'waiting',
      inputSummary: `Waiting for checks on PR #${pr.number}`,
      prNumber: pr.number,
    });
    // The apps show “until” when it gives up: a day after it began waiting.
    expect(Date.parse(waiting.wakeAt as string) - Date.parse(waiting.startedAt as string)).toBe(
      24 * 60 * 60_000,
    );
    expect(merged(pr.number)).toEqual([]);

    await checks(pr.headSha, { conclusion: 'success' });
    const after = await w.run(runId);
    expect(after.status).toBe('succeeded');
    expect(step(after, 'merge')).toMatchObject({
      state: 'succeeded',
      inputSummary: `Checks passed on PR #${pr.number}`,
      output: { merged: true, text: `Merged PR #${pr.number} into main.` },
    });
    expect(merged(pr.number)).toEqual([{ repo: REPO, number: pr.number, method: 'squash' }]);
    const [mirror] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.id, pr.id));
    expect(mirror).toMatchObject({ state: 'merged', mergedById: await principalOf(id) });
    // One plain line from the automation in the run's thread.
    expect((await threadLines(runId, id)).at(-1)).toBe(`Merged PR #${pr.number} into main.`);
    const [signed] = await w.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'pr.merged'), eq(events.actorId, await principalOf(id))));
    expect(signed?.text).toBe(`Merged PR #${pr.number} into main`);

    // The branch goes (AR-42).
    expect(await cleanUpMergedBranches(w.services, w.now(), new Map())).toBeGreaterThanOrEqual(1);
    expect(fake().deletedBranches).toContainEqual({ repo: REPO, branch: `feat/issue-${n}` });
    await done(id);
  });

  it('waits while the checks run, then merges once they pass', async () => {
    const id = await recipe();
    const { runId, pr } = await fixed(id, 'Pending, then green');
    await checks(pr.headSha, { status: 'in_progress' });
    let run = await w.run(runId);
    expect(step(run, 'merge')).toMatchObject({
      state: 'waiting',
      inputSummary: `Waiting for checks on PR #${pr.number}`,
    });
    w.advance(5 * 60_000);
    await w.settle();
    expect(step(await w.run(runId), 'merge').state).toBe('waiting');
    expect(merged(pr.number)).toEqual([]);
    await checks(pr.headSha, { conclusion: 'success' });
    run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'merge').output.text).toBe(`Merged PR #${pr.number} into main.`);
    expect(merged(pr.number)).toHaveLength(1);
    await done(id);
  });

  it('waits for the checks a repository runs on every merge, and never merges without them (TA-58)', async () => {
    const id = await recipe();
    // A merge whose checks passed: this repository runs “ci”.
    const first = await fixed(id, 'With CI');
    await checks(first.pr.headSha, { conclusion: 'success' });
    expect((await w.run(first.runId)).status).toBe('succeeded');
    // The next pull request shows no checks: past the grace it still waits, and past its wait it is left for a person.
    const { runId, pr } = await fixed(id, 'CI never reported');
    w.advance(MERGE_CHECKS_GRACE_MS + 60_000);
    await poll();
    expect(step(await w.run(runId), 'merge').state).toBe('waiting');
    w.advance(24 * 60 * 60_000);
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('failed');
    expect(step(run, 'merge')).toMatchObject({ inputSummary: `No checks ran on PR #${pr.number}` });
    expect(merged(pr.number)).toEqual([]);
    await done(id);
  });

  it('merges a pull request without checks once the grace is over, in a repository that runs none', async () => {
    // No merge of this repository ran checks.
    await w.services.db.delete(prChecks);
    const id = await recipe();
    const { runId, pr } = await fixed(id, 'No CI here');
    w.advance(MERGE_CHECKS_GRACE_MS - 60_000);
    await poll();
    expect(step(await w.run(runId), 'merge').state).toBe('waiting');
    w.advance(2 * 60_000);
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'merge')).toMatchObject({
      inputSummary: `No checks on PR #${pr.number}`,
      output: { text: `Merged PR #${pr.number} into main.` },
    });
    expect(merged(pr.number)).toHaveLength(1);
    await done(id);
  });
});

describe('leaving it for a person (AR-46)', () => {
  /** The run failed at its merge step with `line` and why (`cause`), nothing merged, and the thread said so. */
  async function leftForYou(
    automationId: string,
    runId: string,
    number: number,
    line: string,
    summary: string,
    cause: string,
  ) {
    const run = await w.run(runId);
    expect(run.status).toBe('failed');
    // What it found replaces “Waiting for checks on PR #n”.
    expect(step(run, 'merge')).toMatchObject({
      state: 'failed',
      error: line,
      inputSummary: summary,
      output: { cause },
    });
    // It ended at its first try.
    expect(step(run, 'fix').attempt).toBe(0);
    expect(merged(number)).toEqual([]);
    expect((await threadLines(runId, automationId)).at(-1)).toContain(line);
  }

  it('fails when the checks fail', async () => {
    tries(1);
    const id = await recipe();
    const { runId, pr } = await fixed(id, 'Red CI');
    await checks(pr.headSha, { conclusion: 'failure' });
    await leftForYou(
      id,
      runId,
      pr.number,
      `Checks failed on PR #${pr.number}, so I left it for you.`,
      `Checks failed on PR #${pr.number}`,
      'checks_failed',
    );
    await done(id);
  });

  it('fails when the pull request changed after the review', async () => {
    tries(1);
    const id = await recipe();
    const { n, runId, pr } = await fixed(id, 'Pushed to after the review');
    await w.fakePush(REPO, `feat/issue-${n}`, 'One more thing');
    await poll();
    await leftForYou(
      id,
      runId,
      pr.number,
      `PR #${pr.number} changed after the review, so I left it for you.`,
      `PR #${pr.number} changed after the review`,
      'changed',
    );
    await done(id);
  });

  it('fails when someone asks for changes', async () => {
    // With tries to spare: whoever can review on GitHub never steers the fix round again.
    const id = await recipe();
    const { runId, pr } = await fixed(id, 'Changes requested on GitHub');
    await fake().simulateReview({ repo: REPO, number: pr.number, login: 'jdoe', state: 'changes_requested' });
    await poll();
    await leftForYou(
      id,
      runId,
      pr.number,
      `Someone asked for changes on PR #${pr.number}, so I left it for you.`,
      `Changes requested on PR #${pr.number}`,
      'changes_requested',
    );
    await done(id);
  });

  it('fails when the pull request is closed', async () => {
    const id = await recipe();
    const { runId, pr } = await fixed(id, 'Closed by hand');
    await fake().simulateClose({ repo: REPO, number: pr.number, login: 'jdoe', merged: false });
    await poll();
    await leftForYou(
      id,
      runId,
      pr.number,
      `PR #${pr.number} was closed, so there was nothing to merge.`,
      `PR #${pr.number} was closed`,
      'closed',
    );
    await done(id);
  });

  it('fails when the checks don’t finish in time', async () => {
    const id = await recipe();
    const { runId, pr } = await fixed(id, 'CI hangs');
    await checks(pr.headSha, { status: 'in_progress' });
    w.advance(24 * 60 * 60_000 - 60_000);
    await w.settle();
    expect(step(await w.run(runId), 'merge').state).toBe('waiting');
    w.advance(2 * 60_000);
    await w.settle();
    await leftForYou(
      id,
      runId,
      pr.number,
      `Checks on PR #${pr.number} didn’t finish in time, so I left it for you.`,
      `Checks on PR #${pr.number} didn’t finish in time`,
      'timed_out',
    );
    await done(id);
  });

  it('without a review bound to its commit, needs an approving review on GitHub as merge_pr does', async () => {
    /** The run's review, as if GitHub hadn't said which commit the fix left (`output.head` unknown). */
    const unbound = async (runId: string) => {
      const [fix] = await w.services.db
        .select()
        .from(automationRunSteps)
        .where(and(eq(automationRunSteps.runId, runId), eq(automationRunSteps.stepId, 'fix')));
      const { head: _head, ...output } = (fix?.output ?? {}) as Record<string, unknown>;
      await w.services.db
        .update(automationRunSteps)
        .set({ output: output as never })
        .where(and(eq(automationRunSteps.runId, runId), eq(automationRunSteps.stepId, 'fix')));
    };
    const id = await recipe();
    const first = await fixed(id, 'Nobody reviewed this commit');
    await unbound(first.runId);
    await checks(first.pr.headSha, { conclusion: 'success' });
    await leftForYou(
      id,
      first.runId,
      first.pr.number,
      `PR #${first.pr.number} needs an approving review first, so I left it for you.`,
      `No approving review on PR #${first.pr.number}`,
      'needs_review',
    );
    // Someone's approving review on GitHub is one.
    const second = await fixed(id, 'Approved on GitHub');
    await unbound(second.runId);
    await fake().simulateReview({ repo: REPO, number: second.pr.number, login: 'jdoe', state: 'approved' });
    await checks(second.pr.headSha, { conclusion: 'success' });
    expect((await w.run(second.runId)).status).toBe('succeeded');
    expect(merged(second.pr.number)).toHaveLength(1);
    await done(id);
  });

  it('fails with GitHub’s reason when GitHub refuses, and asks a person to check when it doesn’t answer', async () => {
    // With tries to spare: a refusal that isn't a clash with the base branch is for a person.
    const id = await recipe();
    const refused = await fixed(id, 'Protected main');
    fake().failNextMerge = new GitHubError(
      'At least 1 approving review is required by reviewers with write access.',
      405,
    );
    await checks(refused.pr.headSha, { conclusion: 'success' });
    await leftForYou(
      id,
      refused.runId,
      refused.pr.number,
      `GitHub wouldn’t merge PR #${refused.pr.number}: At least 1 approving review is required by reviewers with write access.`,
      `Checks passed on PR #${refused.pr.number}`,
      'refused',
    );
    const lost = await fixed(id, 'GitHub went quiet');
    fake().failNextMerge = new Error('socket hang up');
    await checks(lost.pr.headSha, { conclusion: 'success' });
    const run = await w.run(lost.runId);
    expect(run.status).toBe('needs_review');
    expect(step(run, 'merge')).toMatchObject({
      state: 'uncertain',
      error: `GitHub didn’t answer, so PR #${lost.pr.number} may or may not be merged. Check it on GitHub, then say what happened.`,
    });
    await done(id);
  });

  it('succeeds when someone merged it meanwhile', async () => {
    const id = await recipe();
    const { runId, pr } = await fixed(id, 'Merged by hand');
    await fake().simulateClose({ repo: REPO, number: pr.number, login: 'jdoe', merged: true });
    await poll();
    const run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'merge')).toMatchObject({
      state: 'succeeded',
      inputSummary: `PR #${pr.number} was already merged`,
      output: { merged: true, alreadyMerged: true, text: `PR #${pr.number} was already merged.` },
    });
    expect(merged(pr.number)).toEqual([]);
    await done(id);
  });
});

describe('a fix whose merge didn’t get through goes round again by itself', () => {
  it('failed checks: the fix is worked on again, the open pull request is used again and merged once checks pass', async () => {
    const id = await recipe();
    const { n, runId, pr } = await fixed(id, 'Red CI, then green');
    const branch = `feat/issue-${n}`;
    await checks(pr.headSha, { conclusion: 'failure' });
    let run = await w.run(runId);
    // Not ended: from the fix again, each step a new attempt; the fix turn hears which try and why.
    expect(run.status).toBe('waiting');
    expect(step(run, 'fix')).toMatchObject({ state: 'waiting', attempt: 1, output: { again: { tries: 2 } } });
    for (const later of ['review', 'pr', 'merge'])
      expect(step(run, later)).toMatchObject({ state: 'pending', attempt: 1 });
    const told = String(step(run, 'fix').output.instructions);
    expect(told).toContain('try 2 of 10');
    expect(told).toContain('checks failed');
    // An own checkout: it commits on the branch it has, no T3 Code thread.
    expect(told).not.toContain('t3_thread_send');
    // The engine's count isn't something the step's templates read.
    expect(told).not.toContain('"tries"');
    const line = 'The pull request’s checks failed, so the fix is being worked on again (try 2 of 10).';
    expect((await threadLines(runId, id)).filter((t) => t === line)).toHaveLength(1);
    // This run's own: other tests in this file go round again too.
    const [again] = (
      await w.services.db
        .select()
        .from(events)
        .where(and(eq(events.type, 'automation.run.again')))
        .orderBy(asc(events.seq))
    ).filter((e) => (e.payload as { runId?: unknown }).runId === runId);
    expect(again?.payload).toMatchObject({ runId, fromStepId: 'fix', cause: 'checks_failed', tries: 2 });

    // The fix pushes a new commit; the review approves it; the pull request already open is the one.
    w.advance(60_000);
    run = await agentStep(runId, 'fix', 'Fixed what the checks found.', branch);
    await poll();
    run = await agentStep(runId, 'review', 'Approve: the checks pass now.');
    expect(step(run, 'pr')).toMatchObject({
      state: 'succeeded',
      output: { prNumber: pr.number, alreadyOpen: true },
    });
    const [now] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.id, pr.id));
    expect(now?.headSha).toBe(step(run, 'fix').output.head);
    expect(now?.headSha).not.toBe(pr.headSha);
    await checks(now?.headSha as string, { conclusion: 'success' });
    run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'merge')).toMatchObject({ state: 'succeeded', attempt: 1 });
    expect(merged(pr.number)).toHaveLength(1);
    // Only one pull request for the branch.
    expect(
      await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch)),
    ).toHaveLength(1);
    // What was said and sent once isn't repeated: the issue heard of the fix once, the thread where the pull request
    // is once; the open pull request got the new try's words.
    expect(step(run, 'linked')).toMatchObject({ state: 'succeeded', attempt: 0 });
    const toIssue = fake().comments.filter((c) => c.repo === REPO && c.number === n);
    expect(toIssue.filter((c) => c.body.startsWith('A fix is ready for review'))).toHaveLength(1);
    const lines = await threadLines(runId, id);
    expect(lines.filter((t) => /already open/.test(t))).toEqual([]);
    expect(lines.filter((t) => t.startsWith('Opened ') && t.includes(`PR #${pr.number}`))).toHaveLength(1);
    expect(
      fake().comments.some((c) => c.number === pr.number && c.body.includes('Fixed what the checks found.')),
    ).toBe(true);
    await done(id);
  });

  it('waits a while for a later try’s new head to reach the mirror before calling it changed', async () => {
    const id = await recipe();
    const { n, runId, pr } = await fixed(id, 'Red CI, then a slow mirror');
    await checks(pr.headSha, { conclusion: 'failure' });
    w.advance(60_000);
    await agentStep(runId, 'fix', 'Fixed what the checks found.', `feat/issue-${n}`);
    // No poll: the mirror still has the earlier head when the review approves the new one.
    let run = await agentStep(runId, 'review', 'Approve: the checks pass now.');
    const head = step(run, 'fix').output.head as string;
    const [stale] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.id, pr.id));
    expect(stale?.headSha).toBe(pr.headSha);
    expect(step(run, 'merge').state).toBe('waiting');
    expect(step(run, 'fix').attempt).toBe(1);
    // The mirror catches up, the checks pass: merged on this try.
    await poll();
    await checks(head, { conclusion: 'success' });
    run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'fix').attempt).toBe(1);
    expect(merged(pr.number)).toHaveLength(1);
    await done(id);
  });

  it('a pull request that clashes with its base branch: the fix merges the base branch in, and it merges', async () => {
    const id = await recipe();
    const { n, runId, pr } = await fixed(id, 'Main moved on');
    fake().simulateConflict(REPO, pr.number);
    await checks(pr.headSha, { conclusion: 'success' });
    let run = await w.run(runId);
    expect(step(run, 'fix')).toMatchObject({ state: 'waiting', attempt: 1 });
    expect(step(run, 'fix').output.again).toMatchObject({ tries: 2, cause: 'conflict' });
    const told = String(step(run, 'fix').output.instructions);
    expect(told).toContain('merge the base branch');
    expect(told).toContain('never rebase');
    expect(await threadLines(runId, id)).toContain(
      'The pull request clashes with newer changes on its base branch, so the fix is being worked on again (try 2 of 10).',
    );
    expect(merged(pr.number)).toEqual([]);

    // The fix merges main in and pushes; reviewed again, it merges.
    fake().simulateConflict(REPO, pr.number, false);
    w.advance(60_000);
    await agentStep(runId, 'fix', 'Merged main in; the totals test still passes.', `feat/issue-${n}`);
    await poll();
    run = await agentStep(runId, 'review', 'Approve: main merged in cleanly.');
    await checks(step(run, 'fix').output.head as string, { conclusion: 'success' });
    run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(merged(pr.number)).toHaveLength(1);
    await done(id);
  });

  it('a merge that failed for what another try can’t change ends as before', async () => {
    const id = await recipe();
    const { runId, pr } = await fixed(id, 'Closed by hand, once');
    await fake().simulateClose({ repo: REPO, number: pr.number, login: 'jdoe', merged: false });
    await poll();
    const run = await w.run(runId);
    expect(run.status).toBe('failed');
    expect(step(run, 'merge')).toMatchObject({ state: 'failed', output: { cause: 'closed' } });
    expect(step(run, 'fix').attempt).toBe(0);
    await done(id);
  });
});

describe('failed checks run once more (AR-57)', () => {
  /** Each test's own workflow run, and the re-runs GitHub was asked for since the test began (one FakeGitHub). */
  let workflowRun = 70;
  let rerunsBefore = 0;
  const reruns = () => fake().reruns.slice(rerunsBefore);
  beforeEach(async () => {
    workflowRun++;
    rerunsBefore = fake().reruns.length;
    // How the merge step's one re-run ends: the fix doesn't go round again here.
    tries(1);
    // The checks a repository runs on every merge are learnt from its last merges, which here are other tests' (the
    // ones above and each other): each test starts from a repository whose merges ran none, so a pull request waits
    // only for its own jobs.
    await w.services.db.delete(prChecks);
  });

  /** A GitHub Actions job of the test's workflow run reports on `sha` (or a check at `url`): its page names the run. */
  async function job(
    sha: string,
    name: string,
    o: { status?: 'in_progress' | 'completed'; conclusion?: 'success' | 'failure' },
    url?: string | null,
  ) {
    await fake().simulateCheckRun({
      repo: REPO,
      sha,
      name,
      url: url ?? `https://github.com/${REPO}/actions/runs/${workflowRun}/job/${name.length}`,
      ...o,
    });
  }
  /** The page of the job behind `name` now: another one once GitHub ran it again. */
  const jobUrl = (sha: string, name: string) =>
    fake()
      .repos.get(REPO)
      ?.checks.get(sha)
      ?.find((c) => c.name === name)?.url ?? null;

  it('runs a failed job again once its workflow run is done, and merges when it passes', async () => {
    const id = await recipe();
    const { runId, pr } = await fixed(id, 'Flaky on macOS');
    const sha = pr.headSha;
    await job(sha, 'test (ubuntu)', { conclusion: 'success' });
    await job(sha, 'test (macos)', { conclusion: 'failure' });
    await job(sha, 'test (windows)', { status: 'in_progress' });
    await poll();
    // GitHub re-runs only a finished workflow run: it waits for windows.
    expect(step(await w.run(runId), 'merge').state).toBe('waiting');
    expect(reruns()).toEqual([]);

    await job(sha, 'test (windows)', { conclusion: 'success' });
    await poll();
    let run = await w.run(runId);
    expect(reruns()).toEqual([{ repo: REPO, runId: workflowRun }]);
    expect(step(run, 'merge')).toMatchObject({
      state: 'waiting',
      inputSummary: `Running the failed checks on PR #${pr.number} once more`,
    });
    const again = jobUrl(sha, 'test (macos)');
    expect(again).not.toBe(`https://github.com/${REPO}/actions/runs/${workflowRun}/job/12`);

    // The mirror sees it queued, then passing.
    await poll();
    expect(step(await w.run(runId), 'merge').state).toBe('waiting');
    expect(merged(pr.number)).toEqual([]);
    await job(sha, 'test (macos)', { conclusion: 'success' }, again);
    await poll();
    run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'merge')).toMatchObject({
      state: 'succeeded',
      inputSummary: `Checks passed on PR #${pr.number}`,
      output: { merged: true, text: `Merged PR #${pr.number} into main.` },
    });
    expect(merged(pr.number)).toHaveLength(1);
    expect(reruns()).toHaveLength(1);
    expect((await threadLines(runId, id)).at(-1)).toBe(`Merged PR #${pr.number} into main.`);
    await done(id);
  });

  it('leaves it for a person when the job fails again, without a second re-run', async () => {
    const id = await recipe();
    const { runId, pr } = await fixed(id, 'Really broken');
    const sha = pr.headSha;
    await job(sha, 'test', { conclusion: 'failure' });
    await poll();
    expect(reruns()).toHaveLength(1);
    await job(sha, 'test', { conclusion: 'failure' }, jobUrl(sha, 'test'));
    await poll();
    const run = await w.run(runId);
    expect(run.status).toBe('failed');
    const line = `Checks failed again on PR #${pr.number}, so I left it for you.`;
    expect(step(run, 'merge')).toMatchObject({
      state: 'failed',
      error: line,
      inputSummary: `Checks failed again on PR #${pr.number}`,
    });
    expect(merged(pr.number)).toEqual([]);
    expect(reruns()).toHaveLength(1);
    expect((await threadLines(runId, id)).at(-1)).toContain(line);
    await done(id);
  });

  it('leaves it for a person at once when GitHub won’t run it again, or it isn’t GitHub Actions', async () => {
    const id = await recipe();
    const refused = await fixed(id, 'No right to re-run');
    fake().failNextRerun = new GitHubError('Resource not accessible by integration', 403);
    await job(refused.pr.headSha, 'test', { conclusion: 'failure' });
    await poll();
    const line = (n: number) => `Checks failed on PR #${n}, so I left it for you.`;
    expect(step(await w.run(refused.runId), 'merge')).toMatchObject({
      state: 'failed',
      error: line(refused.pr.number),
      inputSummary: `Checks failed on PR #${refused.pr.number}`,
    });

    const other = await fixed(id, 'Another CI');
    await job(other.pr.headSha, 'ci/external', { conclusion: 'failure' }, 'https://ci.example.com/build/5');
    await poll();
    expect(step(await w.run(other.runId), 'merge')).toMatchObject({
      state: 'failed',
      error: line(other.pr.number),
    });
    expect(reruns()).toEqual([]);
    expect(merged(refused.pr.number)).toEqual([]);
    expect(merged(other.pr.number)).toEqual([]);
    await done(id);
  });

  describe('in a repository that re-runs only infrastructure faults', () => {
    const config = () => w.services.config as { WHOMBAT_MERGE_RERUN?: string };
    let saved: string | undefined;
    /** Job ids unique across the file, as GitHub's are. */
    let nextJob = 9_000;
    beforeEach(() => {
      saved = config().WHOMBAT_MERGE_RERUN;
      config().WHOMBAT_MERGE_RERUN = `${REPO}=infrastructure,*=once`;
    });
    afterEach(() => {
      config().WHOMBAT_MERGE_RERUN = saved;
    });

    /** A finished job of the test's workflow run, with what GitHub says of its steps and annotations. */
    async function failedJob(
      sha: string,
      name: string,
      o: {
        conclusion: 'failure' | 'timed_out' | 'cancelled' | 'success';
        failedStep?: string;
        annotations?: string[];
      },
    ) {
      const url = `https://github.com/${REPO}/actions/runs/${workflowRun}/job/${nextJob++}`;
      await fake().simulateCheckRun({
        repo: REPO,
        sha,
        name,
        url,
        status: 'completed',
        conclusion: o.conclusion,
        steps: [
          {
            name: 'Set up job',
            status: 'completed',
            conclusion: o.failedStep === 'Set up job' ? 'failure' : 'success',
          },
          ...(o.failedStep && o.failedStep !== 'Set up job'
            ? [{ name: o.failedStep, status: 'completed', conclusion: 'failure' }]
            : []),
        ],
        annotations: o.annotations ?? [],
      });
      return url;
    }
    const line = (n: number) => `Checks failed on PR #${n}, so I left it for you.`;

    it('runs a timed-out job and one whose runner was lost once more, and merges when they pass', async () => {
      const id = await recipe();
      const { runId, pr } = await fixed(id, 'The runner went away');
      const sha = pr.headSha;
      await failedJob(sha, 'build', { conclusion: 'success' });
      await failedJob(sha, 'test (linux)', { conclusion: 'timed_out' });
      await failedJob(sha, 'test (windows)', {
        conclusion: 'failure',
        annotations: ['The self-hosted runner: falcon-ci-2 lost communication with the server.'],
      });
      await poll();
      expect(reruns()).toEqual([{ repo: REPO, runId: workflowRun }]);
      expect(step(await w.run(runId), 'merge')).toMatchObject({
        state: 'waiting',
        inputSummary: `Running the failed checks on PR #${pr.number} once more`,
      });
      for (const name of ['test (linux)', 'test (windows)'])
        await job(sha, name, { conclusion: 'success' }, jobUrl(sha, name));
      await poll();
      const run = await w.run(runId);
      expect(run.status).toBe('succeeded');
      expect(merged(pr.number)).toHaveLength(1);
      expect(reruns()).toHaveLength(1);
      await done(id);
    });

    it('leaves a failed test step for a person at once, saying why on the step', async () => {
      const id = await recipe();
      const { runId, pr } = await fixed(id, 'A real failure');
      await failedJob(pr.headSha, 'test', { conclusion: 'failure', failedStep: 'Run cargo test' });
      await poll();
      const run = await w.run(runId);
      expect(run.status).toBe('failed');
      expect(step(run, 'merge')).toMatchObject({
        state: 'failed',
        error: line(pr.number),
        inputSummary: `Checks failed on PR #${pr.number}`,
        output: { noRerun: expect.stringContaining('Run cargo test') },
      });
      expect(reruns()).toEqual([]);
      expect(merged(pr.number)).toEqual([]);
      expect((await threadLines(runId, id)).at(-1)).toContain(line(pr.number));
      await done(id);
    });

    it('doesn’t run a mix of infrastructure and test failures once more', async () => {
      const id = await recipe();
      const { runId, pr } = await fixed(id, 'Both at once');
      await failedJob(pr.headSha, 'lint', { conclusion: 'failure', failedStep: 'Set up job' });
      await failedJob(pr.headSha, 'test', { conclusion: 'failure', failedStep: 'Run tests' });
      await poll();
      expect(step(await w.run(runId), 'merge')).toMatchObject({
        state: 'failed',
        error: line(pr.number),
        output: { noRerun: expect.stringContaining('Run tests') },
      });
      expect(reruns()).toEqual([]);
      await done(id);
    });
  });
});

describe('its key (AR-45)', () => {
  const keys = (merge: 'can' | 'ask' | 'cannot', open: 'can' | 'cannot' = 'can') => [
    { keyId: 'pr.comment' as const, tier: 'can' as const, repos: [REPO] },
    { keyId: 'pr.open' as const, tier: open, repos: [REPO] },
    { keyId: 'merge.main' as const, tier: merge, repos: [REPO] },
  ];

  it('at No, stops the run as Blocked before anything is merged', async () => {
    const id = await recipe();
    await w.ok(IDS.mara, setAutomationKeys, { automationId: id, grants: keys('cannot') });
    const { runId, pr } = await fixed(id, 'Not allowed to merge');
    const run = await w.run(runId);
    const line = 'It may not merge into main in whombat/billing: it doesn’t hold “Merge into main” for it.';
    expect(run).toMatchObject({ status: 'failed', error: line });
    expect(step(run, 'merge')).toMatchObject({ state: 'blocked', error: line });
    expect(merged(pr.number)).toEqual([]);
    await done(id);
  });

  it('at Asks, asks in the run’s thread, and the yes merges once the checks pass', async () => {
    // Earlier merges here ran other checks, which this one would wait for (TA-58): this repository runs only “ci”.
    await w.services.db.delete(prChecks);
    const id = await recipe();
    await w.ok(IDS.mara, setAutomationKeys, { automationId: id, grants: keys('ask') });
    const { runId, run, pr } = await fixed(id, 'Ask before merging');
    expect(step(run, 'merge').state).toBe('waiting');
    expect(step(run, 'merge').inputSummary).toMatch(
      new RegExp(`^Asked to merge PR #${pr.number} into main \\(request #\\d+\\)$`),
    );
    const asked = await approvalOf(run, 'merge');
    expect(asked.title).toBe(`Merge PR #${pr.number} into main`);
    const [card] = await w.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, asked.messageId as string));
    expect(card?.threadRootId).toBe((await loadRunRow(w.services.db, runId)).threadRootId);

    const yes = await decide(run, 'merge', 'approve');
    expect(step(yes, 'merge')).toMatchObject({
      state: 'waiting',
      inputSummary: `Waiting for checks on PR #${pr.number}`,
    });
    expect(merged(pr.number)).toEqual([]);
    await checks(pr.headSha, { conclusion: 'success' });
    const after = await w.run(runId);
    expect(after.status).toBe('succeeded');
    expect(step(after, 'merge').output.text).toBe(`Merged PR #${pr.number} into main.`);
    expect(merged(pr.number)).toHaveLength(1);
    await done(id);
  });

  it('is skipped when no pull request was opened', async () => {
    // Without “Also answer on GitHub” nothing checks that the pull request opened; at No it is posted for a person.
    const id = await recipe({}, { replyOnGitHub: false });
    await w.ok(IDS.mara, setAutomationKeys, {
      automationId: id,
      grants: keys('can', 'cannot').filter((g) => g.keyId !== 'pr.comment'),
    });
    const { run } = await reviewed(id, 'Prepared for a person');
    expect(step(run, 'pr').output).toMatchObject({ opened: false });
    expect(step(run, 'merge')).toMatchObject({ state: 'skipped', inputSummary: NOTHING_TO_MERGE });
    expect(run.status).toBe('succeeded');
    await done(id);
  });
});
