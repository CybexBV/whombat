/**
 * A tracker fix made in T3 Code, through the real automation engine (docs/decisions/report-trackers.md): the review
 * step's approval holds only when the reviewer's own last answer — read in the stand-in T3 Code, the newest `subagent`
 * child of the fix thread the run's turn started — is another model's and names a commit on the branch on the in-memory
 * FakeGitHub, the head or one the fixes of what it found came after. Then the pull request opens at the head and merges
 * once its checks pass; a review of a commit that isn't on the branch, a relay that says changes are needed, or a
 * reviewer that can't be read (asked once more first) open nothing. And a report that can't go on reaches the person's
 * Inbox once per run, never for a test run or a run a person stopped. FAKE AGENTS answer the turns. Postgres because the
 * run and its steps, the watch the review is found by, the pull request's mirror and the Inbox's notifications are all
 * commits.
 */
import {
  type AutomationRecipeInput,
  type AutomationRun,
  CONNECTION_CALL_DEADLINE_MS,
  CreateConnectionBody,
  type ReportAssessmentInput,
  recipeInstructions,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BurrowAccess } from '../auth/request';
import { FIX_TRIES_MAX, NOT_REVIEWED_THIS_TRY, REVIEW_REDO_LINE } from '../automations/again';
import { controlAutomationRun, createAutomation, runAutomationNow } from '../automations/commands';
import { ORGANIZATION_IN_COMMITS } from '../automations/engine/external';
import { MERGE_CHECKS_GRACE_MS } from '../automations/merge';
import { sampleReport } from '../automations/routes';
import { automationStep } from '../automations/steps';
import { FIX_WAITS_WORDS } from '../automations/steps/dispatch-agent';
import { loadRunRow, runTokens } from '../automations/store';
import { STEP_WAIT_SLICE_MS } from '../automations/turn-waits';
import { loadBurrowRow } from '../commit/pipeline';
import { createConnection, viewerFor } from '../connections/connect';
import { startT3Code, type T3CodeStub } from '../connections/testing/t3code-stub';
import {
  automationRuns,
  automations,
  dispatches,
  notifications,
  pullRequests,
  t3Watches,
  trackerFixes,
  vaultNetworks,
} from '../db/schema/index';
import { GitHubError } from '../github/adapter';
import type { FakeGitHub } from '../github/fake';
import { UPDATE_WAITS_MS } from '../lib/maintenance';
import { callTool } from '../mcp/server';
import { loadPrincipalRow } from '../read/principals';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { accountOf } from '../test/tokens';
import { FakeTracker } from '../test/tracker';
import { useFakeTrackerDriver } from '../test/tracker-driver';
import { useVaultNetForTests } from '../vault/net';

const w = useAutomationWorld();
const tracker = new FakeTracker();
let t3: T3CodeStub;
const TRACKER_HOST = 'dev.tracker.review.test';
const T3_HOST = 't3.review.test';
const TRACKER_ADDRESS = '192.168.96.10';
const T3_ADDRESS = '192.168.96.11';
const REPO = 'whombat/billing';
/** The fix thread's model and its reviewer's: another provider's, as the fix prompt asks. */
const FIXER = 'claude-opus-5-5';
const REVIEWER = 'gpt-6.1-sol';
let externalId = '';
let t3Id = '';
let automationId = '';
let automationPrincipal = '';

const fake = (): FakeGitHub => {
  const f = w.services.github.fake;
  if (!f) throw new Error('no FakeGitHub');
  return f;
};

/** “Assess new reports” answering the customer, fixing bugs in T3 Code on its own and merging once checks pass. */
async function recipe(): Promise<string> {
  const when = { kind: 'tracker' as const, connectionId: externalId, itemKinds: ['bug' as const] };
  const input: AutomationRecipeInput = {
    when,
    job: 'assess',
    instructions: recipeInstructions('assess', when),
    conversationId: IDS.billing,
    replyToCustomer: true,
    repo: REPO,
    t3: 't3',
    fix: { mode: 'auto', minImportance: 'low', maxPerDay: 20, merge: 'checks' },
  };
  const { automationId: id } = await w.ok(IDS.mara, createAutomation, {
    name: 'Fix Acme Desk reports in T3 Code',
    source: { kind: 'recipe', recipe: input },
    publish: true,
  });
  return id;
}

beforeAll(async () => {
  await tracker.start();
  useFakeTrackerDriver(w.services, tracker);
  t3 = await startT3Code();
  const trackerPort = Number(new URL(tracker.url).port);
  useVaultNetForTests(w.services, {
    resolve: async (host) => {
      if (host === TRACKER_HOST) return [{ address: TRACKER_ADDRESS, family: 4 }];
      if (host === T3_HOST) return [{ address: T3_ADDRESS, family: 4 }];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
    dialAddress: (a) => (a === TRACKER_ADDRESS || a === T3_ADDRESS ? '127.0.0.1' : a),
    deadlineMs: 5000,
  });
  await w.services.db.insert(vaultNetworks).values({
    id: 'vnw_review_binding',
    cidr: '192.168.96.0/24',
    ports: [trackerPort, t3.port],
    note: 'Fake tracker and T3 Code',
    addedAt: w.now(),
  });
  externalId = await insertConnection(w.services, {
    catalogId: 'tracker',
    burrowId: w.burrowId,
    label: 'Acme dev',
    handle: 'tracker-dev',
    fields: { url: `http://${TRACKER_HOST}:${trackerPort}` },
    secret: tracker.token,
  });
  // T3 Code signed in with a pairing code, as the person does: the server reads the review through it.
  const viewer = await viewerFor(w.services, await accountOf(w.services, IDS.mara), w.burrowId);
  if (!viewer) throw new Error('Mara is no member');
  const { row } = await createConnection(
    w.services,
    viewer,
    CreateConnectionBody.parse({
      catalogId: 't3code',
      signIn: 'password',
      fields: { url: `http://${T3_HOST}:${t3.port}` },
      login: { password: t3.pairingCode() },
      access: 'manage',
    }),
  );
  t3Id = row.id;
  expect(row.handle).toBe('t3');
  automationId = await recipe();
  const [a] = await w.services.db.select().from(automations).where(eq(automations.id, automationId));
  automationPrincipal = a?.principalId as string;
  expect(await poll()).toMatchObject({ baseline: true });
});

afterAll(async () => {
  await tracker.stop();
  await t3?.close();
});

/** The most tries the engine makes at a fix that doesn't get through. */
const tries = (n: number) => {
  w.services.automations.options.fixTriesMax = n;
};
// These tests are about how a run ends: one try, unless a test says otherwise (a fix going round again has its own).
beforeEach(() => tries(1));

// A run a test left going holds one of the automation's two places: it is stopped (as a person stops it).
afterEach(async () => {
  tries(FIX_TRIES_MAX);
  for (const r of await w.runs(automationId))
    if (['queued', 'running', 'waiting', 'paused', 'needs_review'].includes(r.status))
      await w.ok(IDS.mara, controlAutomationRun, { number: r.number, action: 'cancel' });
});

async function poll() {
  const result = await w.services.tracker.pollNow(externalId);
  await w.settle();
  await w.services.tracker.settled();
  return result;
}

/** One poll of the burrow's repos, then the engine until nothing moves. */
async function pollGitHub() {
  const report = await w.services.github.poller.pollNow({ burrowId: w.burrowId });
  if (report.errors.length) throw new Error(report.errors.join('; '));
  await w.settle();
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
  reply: 'Thanks for telling us. Saving fails because of a problem on our side, and we are looking into it.',
  replyAsks: false,
  language: 'en',
  ...over,
});

/** A new report polled into a run of the automation. */
async function newRun(title: string) {
  const at = w.now().toISOString();
  const report = tracker.add({ title, created_at: at, updated_at: at });
  await poll();
  const run = (await w.runs(automationId)).at(-1) as AutomationRun;
  expect((await loadRunRow(w.services.db, run.id)).scope).toMatchObject({ number: report.number });
  return { report, runId: run.id };
}

/** The FAKE AGENT's assessment in the run's `ask` turn. */
async function assess(runId: string, a: ReportAssessmentInput) {
  const dispatchId = step(await w.run(runId), 'ask').dispatchId as string;
  expect(dispatchId).toBeTruthy();
  await w.services.db.update(dispatches).set({ state: 'running' }).where(eq(dispatches.id, dispatchId));
  const res = await callTool(
    w.services,
    { dispatchId, agentId: IDS.dusty, burrowId: w.burrowId },
    'report_assessment',
    a,
  );
  expect(res.isError).not.toBe(true);
  await w.fakeAgentReply(dispatchId, 'A real bug in saving.');
  await w.settle();
  await w.services.tracker.settled();
  return w.run(runId);
}

/**
 * A report assessed as a bug and the customer answered, up to its fix: the fix turn hands the work to a T3 Code thread
 * run by `FIXER` (T3 Code has it, and Whombat watches it from the run's thread, as the turn's launch leaves it).
 */
async function toFix(title: string) {
  const { report, runId } = await newRun(title);
  const run = await assess(runId, bug());
  expect(step(run, 'reply').output).toMatchObject({ sent: true });
  const fix = step(run, 'fix');
  expect(fix.state).toBe('waiting');
  const [turn] = await w.services.db
    .select()
    .from(dispatches)
    .where(eq(dispatches.id, fix.dispatchId as string));
  if (!turn) throw new Error('no fix turn');
  const row = await loadRunRow(w.services.db, runId);
  // The review is found through the run's own place: the fix turn worked in it.
  expect({ conversationId: turn.conversationId, threadRootId: turn.threadRootId }).toEqual({
    conversationId: row.conversationId,
    threadRootId: row.threadRootId,
  });
  const fixThread = `mcp:fix-${report.number}`;
  t3.addThread(fixThread, `Dusty - Fix Acme dev #${report.number}`, FIXER);
  await w.services.db.insert(t3Watches).values({
    burrowId: w.burrowId,
    connectionId: t3Id,
    threadId: fixThread,
    title: `Dusty - Fix Acme dev #${report.number}`,
    conversationId: turn.conversationId,
    threadRootId: turn.threadRootId,
    agentId: IDS.dusty,
    wakes: false,
    armedAt: w.now(),
  });
  const prTitle = (step(run, 'ask').output as { assessment?: { prTitle?: string } }).assessment?.prTitle;
  expect(prTitle).toBeTruthy();
  return {
    report,
    runId,
    fixThread,
    branch: `feat/${row.scope.ref as string}`,
    reviewTitle: `Review Acme dev #${report.number}: ${prTitle}`,
    fixTurn: turn.id,
  };
}

async function headOf(branch: string): Promise<string> {
  const read = await fake().branchHead(REPO, branch, null);
  if (!read.modified || !read.data) throw new Error(`no head on ${branch}`);
  return read.data;
}

/** The fix thread pushed `branch` and the fix turn said so: the review step's turn is next. Answers the head. */
async function fixed(runId: string, branch: string, message: string): Promise<string> {
  await w.fakePush(REPO, branch, message);
  const fix = step(await w.run(runId), 'fix').dispatchId as string;
  await w.fakeAgentReply(
    fix,
    `A failing test first, then the fix; its review approved it and ${branch} was pushed.`,
  );
  await w.settle();
  const run = await w.run(runId);
  expect(step(run, 'fix').state).toBe('succeeded');
  expect(step(run, 'review').state).toBe('waiting');
  return headOf(branch);
}

/** The review step's FAKE AGENT relays the review (its turn's reply). */
async function relay(runId: string, text: string) {
  const dispatchId = step(await w.run(runId), 'review').dispatchId as string;
  expect(dispatchId).toBeTruthy();
  await w.fakeAgentReply(dispatchId, text);
  await w.settle();
  await w.services.background.settle();
  return w.run(runId);
}

const short = (sha: string) => sha.slice(0, 7);

/** The Inbox notifications a run's report that can't go on gives the person (TA-61). */
async function unlanded(runId: string) {
  await w.services.background.settle();
  return w.services.db
    .select()
    .from(notifications)
    .where(eq(notifications.dedupKey, `tracker_unlanded:${runId}`));
}

/** What the automation itself said in the run's thread, oldest first. */
async function automationLines(runId: string) {
  return w.runThread(runId, automationPrincipal);
}

async function prsOn(branch: string) {
  return w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch));
}

/** The calls that looked for the review of report #`number` in T3 Code. */
const reviewLookups = (number: number) =>
  t3.calls.filter(
    (c) => c.name === 't3_thread_list' && c.args.titleContains === `Review Acme dev #${number}:`,
  );

describe('the review of a T3 Code fix binds the reviewer’s own answer to the branch it read', () => {
  it('the reviewer approves the branch’s head: the pull request opens and merges once its checks pass', async () => {
    const { report, runId, fixThread, branch, reviewTitle } = await toFix('Blueprint won’t save');
    const head = await fixed(runId, branch, 'Handle the failed save');
    const reviewId = t3.delegate(fixThread, {
      title: reviewTitle,
      model: REVIEWER,
      answer: `Approve — reviewed ${short(head)}. The new test fails on main and passes on the branch.`,
    });
    let run = await relay(
      runId,
      `Approve — reviewed ${short(head)}\n\nThe reviewer ran the new test on both branches.`,
    );
    expect(step(run, 'review')).toMatchObject({
      state: 'succeeded',
      output: { verdict: 'approve', reviewer: 'read', head },
    });
    // The server read the reviewer's own last answer: found by the review's title, among the fix thread's children.
    expect(reviewLookups(report.number).length).toBeGreaterThanOrEqual(1);
    expect(t3.calls.some((c) => c.name === 't3_thread_read' && c.args.threadId === reviewId)).toBe(true);
    expect(step(run, 'pr')).toMatchObject({ state: 'succeeded', output: { opened: true } });
    const [pr] = await prsOn(branch);
    if (!pr) throw new Error('no pull request');
    expect(pr.headSha).toBe(head);
    expect(step(run, 'merge').state).toBe('waiting');

    // Its checks pass; a report's fix gives late checks a grace before it merges.
    await pollGitHub();
    await fake().simulateCheckRun({ repo: REPO, sha: head, name: 'ci', conclusion: 'success' });
    await pollGitHub();
    w.advance(MERGE_CHECKS_GRACE_MS + 60_000);
    await w.settle();
    run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'merge')).toMatchObject({ state: 'succeeded', output: { merged: true } });
    expect(fake().merges.filter((m) => m.repo === REPO && m.number === pr.number)).toHaveLength(1);
    // It landed: nothing for the person.
    expect(await unlanded(runId)).toEqual([]);
    // Its fix is followed from the merge on; the merge step's own line said it, so the thread hears it once.
    w.advance(61_000);
    await w.services.tracker.followFixesNow();
    await w.settle();
    const [followed] = await w.services.db.select().from(trackerFixes).where(eq(trackerFixes.runId, runId));
    expect(followed?.state).toBe('merged');
    const lines = (await w.runThread(runId)).map((m) => m.text);
    expect(lines.filter((t) => t.includes(`PR #${pr.number}`) && /merged/i.test(t))).toHaveLength(1);
  });

  it('a branch whose commits name the organization: the pull request is left for the person, who hears why', async () => {
    const { runId, fixThread, branch, reviewTitle } = await toFix('Kiosk mode exits by itself');
    // The name only in the commit's body, below its first line.
    const head = await fixed(
      runId,
      branch,
      'Keep kiosk mode on\n\nReported by Acme Fleet for their lobby devices.',
    );
    t3.delegate(fixThread, {
      title: reviewTitle,
      model: REVIEWER,
      answer: `Approve — reviewed ${short(head)}. The new test fails on main and passes on the branch.`,
    });
    const run = await relay(runId, `Approve — reviewed ${short(head)}`);
    expect(step(run, 'pr')).toMatchObject({ state: 'succeeded', output: { opened: false } });
    expect(await prsOn(branch)).toEqual([]);
    const notes = await unlanded(runId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('organization');
    expect(notes[0]?.text).not.toContain('Acme Fleet');
  });

  it('GitHub not showing the branch’s commits: read again twice, then the pull request is left for the person', async () => {
    const { runId, fixThread, branch, reviewTitle } = await toFix('Screen saver ignores its timeout');
    const head = await fixed(runId, branch, 'Respect the screen saver timeout');
    t3.delegate(fixThread, {
      title: reviewTitle,
      model: REVIEWER,
      answer: `Approve — reviewed ${short(head)}. The new test fails on main and passes on the branch.`,
    });
    const github = fake();
    const real = github.compare.bind(github);
    let reads = 0;
    github.compare = async () => {
      reads++;
      throw new GitHubError('GitHub answered 503', 503);
    };
    try {
      let run = await relay(runId, `Approve — reviewed ${short(head)}`);
      for (let i = 0; i < 5 && step(run, 'pr').state !== 'succeeded'; i++) {
        w.advance(10 * 60_000);
        await w.settle();
        await w.services.background.settle();
        run = await w.run(runId);
      }
      // Three tries of the pull request step (the review read the branch once before it).
      expect(reads).toBeGreaterThanOrEqual(3);
      expect(step(run, 'pr')).toMatchObject({ state: 'succeeded', attempt: 2, output: { opened: false } });
    } finally {
      github.compare = real;
    }
    expect(await prsOn(branch)).toEqual([]);
    const notes = await unlanded(runId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('commits');
  });

  it('one review asked for changes and the fix thread fixed them: the pull request opens at the new head', async () => {
    const { runId, fixThread, branch, reviewTitle } = await toFix('Exports drop the last row');
    const reviewed = await fixed(runId, branch, 'Keep the last row');
    t3.delegate(fixThread, {
      title: reviewTitle,
      model: REVIEWER,
      answer: `Changes needed — reviewed ${short(reviewed)}. An empty export still drops its header.`,
    });
    // The fixes of what it found come after the review, with no second one.
    w.advance(1000);
    await w.fakePush(REPO, branch, 'Keep the header of an empty export');
    const head = await headOf(branch);
    expect(head).not.toBe(reviewed);

    const run = await relay(
      runId,
      `Approve — reviewed ${short(reviewed)}\n\nThe review found the empty export; the fix thread fixed it.`,
    );
    expect(step(run, 'review')).toMatchObject({
      state: 'succeeded',
      output: { verdict: 'approve', reviewer: 'read', head },
    });
    expect(step(run, 'pr')).toMatchObject({ state: 'succeeded', output: { opened: true } });
    expect((await prsOn(branch)).map((p) => p.headSha)).toEqual([head]);
    expect(await unlanded(runId)).toEqual([]);
  });

  it('a review of a commit that isn’t on the branch: no pull request, and the person hears once', async () => {
    const { report, runId, fixThread, branch, reviewTitle } = await toFix('Exports drop the first row');
    await fixed(runId, branch, 'Keep the first row');
    t3.delegate(fixThread, {
      title: reviewTitle,
      model: REVIEWER,
      answer: 'Approve — reviewed deadbee. The new test covers the first row.',
    });
    const before = (await automationLines(runId)).length;

    const run = await relay(runId, 'Approve — reviewed deadbee\n\nThe review checked the export.');
    expect(step(run, 'review')).toMatchObject({
      state: 'succeeded',
      output: { verdict: 'changes_needed', reviewer: 'read', unbound: expect.stringContaining('commit') },
    });
    expect(step(run, 'review').output.head).toBeUndefined();
    // The run stops at “Did the review approve it?”: nothing opens.
    expect(run.status).toBe('succeeded');
    expect(step(run, 'pr').state).toBe('skipped');
    expect(await prsOn(branch)).toEqual([]);

    // One line from the automation in the run's thread, and one Inbox item pointing at it.
    const lines = await automationLines(runId);
    expect(lines.length - before).toBe(1);
    const notes = await unlanded(runId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'needs_you', where: 'Acme dev', messageId: lines.at(-1)?.id });
    expect(notes[0]?.text).toContain(`#${report.number}`);
  });

  it('what the review found was left without a reason: no pull request; ended again, still one Inbox item', async () => {
    const { runId, fixThread, branch, reviewTitle } = await toFix('Device names won’t save');
    const head = await fixed(runId, branch, 'Save device names');
    t3.delegate(fixThread, {
      title: reviewTitle,
      model: REVIEWER,
      answer: `Changes needed — reviewed ${short(head)}. The new test passes on main too, so it doesn’t reproduce the bug.`,
    });
    const run = await relay(
      runId,
      `Changes needed — reviewed ${short(head)}\n\nThe test doesn’t reproduce the bug, and the fix turn left it.`,
    );
    expect(step(run, 'review')).toMatchObject({ state: 'succeeded', output: { verdict: 'changes_needed' } });
    expect(run.status).toBe('succeeded');
    expect(step(run, 'pr').state).toBe('skipped');
    expect(await prsOn(branch)).toEqual([]);
    expect(await unlanded(runId)).toHaveLength(1);

    // The same run finished once more (an engine re-taking it): the Inbox keeps the one item.
    const [row] = await w.services.db.select().from(automationRuns).where(eq(automationRuns.id, runId));
    if (!row) throw new Error('no run');
    await w.services.db
      .update(automationRuns)
      .set({ leaseOwner: 'test-engine', leaseExpiresAt: new Date(w.now().getTime() + 60_000) })
      .where(eq(automationRuns.id, runId));
    const again = await w.commit(
      automationPrincipal,
      automationStep,
      { runId, fence: row.fence, owner: 'test-engine', op: 'finish', status: 'succeeded', error: null },
      {},
    );
    expect(again.status).toBe('ok');
    expect(await unlanded(runId)).toHaveLength(1);
  });

  it('the reviewer can’t be read: the step is asked once more, then it is no approval', async () => {
    const { report, runId, branch } = await toFix('Blueprint names vanish');
    const head = await fixed(runId, branch, 'Keep blueprint names');
    // No review was handed out: T3 Code lists none for this report.
    let run = await relay(runId, `Approve — reviewed ${short(head)}\n\nThe review approved it.`);
    const first = step(run, 'review');
    expect(first).toMatchObject({ state: 'pending', attempt: 1 });
    expect(first.error).toContain('read again');
    expect(reviewLookups(report.number)).toHaveLength(1);
    const firstTurn = (
      await w.services.db
        .select({ id: dispatches.id })
        .from(dispatches)
        .where(and(eq(dispatches.runId, runId), eq(dispatches.trigger, 'automation')))
    ).map((d) => d.id);

    // A fresh turn after the backoff.
    w.advance(31_000);
    await w.settle();
    run = await w.run(runId);
    const second = step(run, 'review');
    expect(second).toMatchObject({ state: 'waiting', attempt: 1 });
    expect(firstTurn).not.toContain(second.dispatchId);

    run = await relay(runId, `Approve — reviewed ${short(head)}\n\nThe review approved it.`);
    expect(step(run, 'review')).toMatchObject({
      state: 'succeeded',
      attempt: 1,
      output: { verdict: 'changes_needed', reviewer: 'unread' },
    });
    expect(reviewLookups(report.number)).toHaveLength(2);
    expect(await prsOn(branch)).toEqual([]);
    expect(await unlanded(runId)).toHaveLength(1);
  });

  it('the reviewer read on the second attempt approves the head: the pull request opens', async () => {
    const { runId, fixThread, branch, reviewTitle } = await toFix('Saving a policy fails');
    const head = await fixed(runId, branch, 'Save policies');
    let run = await relay(runId, `Approve — reviewed ${short(head)}`);
    expect(step(run, 'review')).toMatchObject({ state: 'pending', attempt: 1 });
    // The review shows up by the time the step asks again.
    t3.delegate(fixThread, {
      title: reviewTitle,
      model: REVIEWER,
      answer: `Approve — reviewed ${short(head)}. The test reproduces it.`,
    });
    w.advance(31_000);
    await w.settle();
    run = await relay(runId, `Approve — reviewed ${short(head)}`);
    expect(step(run, 'review')).toMatchObject({
      state: 'succeeded',
      output: { verdict: 'approve', reviewer: 'read', head },
    });
    expect(step(run, 'pr')).toMatchObject({ state: 'succeeded', output: { opened: true } });
    expect((await prsOn(branch)).map((p) => p.headSha)).toEqual([head]);
  });

  it('a reviewer naming no commit holds only for a head committed before the review began', async () => {
    // Committed before the review began: the head it read.
    const before = await toFix('Saving a printer fails');
    const head = await fixed(before.runId, before.branch, 'Save printers');
    t3.delegate(before.fixThread, {
      title: before.reviewTitle,
      model: REVIEWER,
      answer: 'Approve. The new test reproduces it and passes with the fix.',
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const approved = await relay(before.runId, 'Approve: the review approved it.');
    expect(step(approved, 'review')).toMatchObject({
      state: 'succeeded',
      output: { verdict: 'approve', reviewer: 'read', head },
    });
    expect((await prsOn(before.branch)).map((p) => p.headSha)).toEqual([head]);

    // Committed after the review began: not what it read.
    const after = await toFix('Saving a scanner fails');
    await fixed(after.runId, after.branch, 'Save scanners');
    t3.delegate(after.fixThread, {
      title: after.reviewTitle,
      model: REVIEWER,
      answer: 'Approve. Looks right.',
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const moved = await relay(after.runId, 'Approve: the review approved it.');
    expect(step(moved, 'review')).toMatchObject({
      state: 'succeeded',
      output: { verdict: 'changes_needed', unbound: expect.stringContaining('which commit') },
    });
    expect(await prsOn(after.branch)).toEqual([]);
  });

  it('a review by the fix’s own model is no approval', async () => {
    const { runId, fixThread, branch, reviewTitle } = await toFix('Saving a schedule fails');
    const head = await fixed(runId, branch, 'Save schedules');
    t3.delegate(fixThread, {
      title: reviewTitle,
      model: FIXER,
      answer: `Approve — reviewed ${short(head)}. Looks right.`,
    });
    const run = await relay(runId, `Approve — reviewed ${short(head)}`);
    expect(step(run, 'review')).toMatchObject({
      state: 'succeeded',
      output: { verdict: 'changes_needed', reviewer: 'read', unbound: expect.stringContaining('same model') },
    });
    expect(await prsOn(branch)).toEqual([]);
    expect(await unlanded(runId)).toHaveLength(1);
  });
});

describe('a report that can’t go on reaches the person, once (TA-61)', () => {
  it('a fix that fails: one Inbox item, and the failed run’s own notice is the one line', async () => {
    const { report, runId, fixTurn } = await toFix('Saving a group fails');
    const before = (await automationLines(runId)).length;
    await w.services.db
      .update(dispatches)
      .set({ state: 'failed', error: 'The thread stopped.', finishedAt: w.now() })
      .where(eq(dispatches.id, fixTurn));
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('failed');
    expect(step(run, 'fix').state).toBe('failed');
    const lines = await automationLines(runId);
    expect(lines.length - before).toBe(1);
    const notes = await unlanded(runId);
    expect(notes).toHaveLength(1);
    const row = await loadRunRow(w.services.db, runId);
    // It points at the run's thread; the customer heard back, so it says so.
    expect(notes[0]).toMatchObject({ kind: 'needs_you', where: 'Acme dev', messageId: row.threadRootId });
    expect(notes[0]?.text).toContain(`#${report.number}`);
    expect(notes[0]?.text).toContain('customer was told');

    // Lost right after the run ended (a restart, a failed write): the sweep sends it again, once.
    await w.services.db.delete(notifications).where(eq(notifications.dedupKey, `tracker_unlanded:${runId}`));
    w.advance(2 * 60_000);
    const { resendUnlanded } = await import('./unlanded');
    expect(await resendUnlanded(w.services)).toBe(1);
    expect(await unlanded(runId)).toHaveLength(1);
    expect(await resendUnlanded(w.services)).toBe(0);
    expect(await unlanded(runId)).toHaveLength(1);
  });

  it('a run that fails before the customer was answered: one Inbox item, no line beyond its own notice', async () => {
    const { report, runId } = await newRun('Nothing loads');
    const ask = step(await w.run(runId), 'ask').dispatchId as string;
    const before = (await automationLines(runId)).length;
    await w.services.db
      .update(dispatches)
      .set({ state: 'failed', error: 'The agent couldn’t start.', finishedAt: w.now() })
      .where(eq(dispatches.id, ask));
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('failed');
    expect(step(run, 'reply').output.sent).not.toBe(true);
    expect(tracker.reports.get(report.id)?.messages).toEqual([]);
    expect((await automationLines(runId)).length - before).toBe(1);
    const notes = await unlanded(runId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'needs_you' });
    expect(notes[0]?.text).toContain(`#${report.number}`);
    expect(notes[0]?.text).not.toContain('customer was told');
  });

  it('a turn that reports no assessment: the run ends without a reply, and the person hears once', async () => {
    const { report, runId } = await newRun('Reports page is blank');
    const ask = step(await w.run(runId), 'ask').dispatchId as string;
    await w.fakeAgentReply(ask, 'I had a look.');
    await w.settle();
    await w.services.background.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'ask').output).toMatchObject({ unassessed: true });
    expect(step(run, 'reply').output.sent).not.toBe(true);
    expect(tracker.reports.get(report.id)?.messages).toEqual([]);
    const notes = await unlanded(runId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'needs_you' });
    expect(notes[0]?.text).toContain(`#${report.number}`);
  });

  it('a test run (Try it) that fails tells nobody', async () => {
    const mara = await access(IDS.mara);
    const at = w.now().toISOString();
    const open = tracker.add({ title: 'Tried on this one', created_at: at, updated_at: at });
    const report = await sampleReport(w.services, mara, automationId, open.id);
    const { runId } = await w.ok(IDS.mara, runAutomationNow, {
      automationId,
      test: true,
      sample: { reportId: open.id },
      sampleReport: report,
    });
    await w.settle();
    const id = runId as string;
    expect((await w.run(id)).test).toBe(true);
    const ask = step(await w.run(id), 'ask').dispatchId as string;
    await w.services.db
      .update(dispatches)
      .set({ state: 'failed', error: 'The agent couldn’t start.', finishedAt: w.now() })
      .where(eq(dispatches.id, ask));
    await w.settle();
    expect((await w.run(id)).status).toBe('failed');
    expect(await unlanded(id)).toEqual([]);
  });

  it('a run a person stopped during its fix tells nobody', async () => {
    const { runId } = await toFix('Saving a tag fails');
    const run = await w.run(runId);
    await w.ok(IDS.mara, controlAutomationRun, { number: run.number, action: 'cancel' });
    await w.settle();
    expect((await w.run(runId)).status).toBe('cancelled');
    expect(await unlanded(runId)).toEqual([]);
  });
});

describe('a T3 Code fix that doesn’t get through goes round again by itself', () => {
  // The automation fixes at most 20 reports a day on its own: these start on the next day, so the reports above don't
  // count (and the ones below share it with these).
  beforeAll(() => w.advance(24 * 60 * 60_000));
  beforeEach(() => tries(FIX_TRIES_MAX));

  /** The automation's lines in the run's thread that say it goes again. */
  const againLines = async (runId: string) =>
    (await automationLines(runId)).map((m) => m.text).filter((t) => t.includes('again (try'));

  it('the review asked for changes: the fix thread is asked again, then the approved head is opened and merged', async () => {
    const { runId, fixThread, branch, reviewTitle } = await toFix('Exports lose their header');
    const first = await fixed(runId, branch, 'Keep the header');
    t3.delegate(fixThread, {
      title: reviewTitle,
      model: REVIEWER,
      answer: `Changes needed — reviewed ${short(first)}. An empty export still drops its header.`,
    });
    let run = await relay(
      runId,
      `Changes needed — reviewed ${short(first)}\n\nAn empty export still drops its header.`,
    );
    // From the fix again: each later step a new attempt, the run going.
    expect(run.status).toBe('waiting');
    expect(step(run, 'fix')).toMatchObject({ state: 'waiting', attempt: 1 });
    for (const later of ['review', 'pr', 'merge'])
      expect(step(run, later)).toMatchObject({ state: 'pending', attempt: 1 });
    const told = String(step(run, 'fix').output.instructions);
    expect(told).toContain('try 2 of 10');
    expect(told).toContain('An empty export still drops its header');
    expect(told).toContain('t3_thread_send');
    // The count and the head it went again at, and the review's attempt this try starts at (its one re-read of an
    // unread reviewer is this try's).
    expect(step(run, 'fix').output.again).toMatchObject({
      tries: 2,
      head: { sha: first },
      cause: 'review_changes',
      reviewAttempt: 1,
    });
    expect(await againLines(runId)).toEqual([
      'The review asked for changes, so the fix is being worked on again (try 2 of 10).',
    ]);
    expect(await unlanded(runId)).toEqual([]);

    // The thread fixes it on the same branch and has the new head reviewed; this time it approves.
    w.advance(60_000);
    const head = await fixed(runId, branch, 'Keep the header of an empty export');
    expect(head).not.toBe(first);
    t3.delegate(fixThread, {
      title: reviewTitle,
      model: REVIEWER,
      answer: `Approve — reviewed ${short(head)}. The empty export keeps its header.`,
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    });
    run = await relay(runId, `Approve — reviewed ${short(head)}`);
    expect(step(run, 'review')).toMatchObject({ state: 'succeeded', output: { verdict: 'approve', head } });
    expect(step(run, 'pr')).toMatchObject({ state: 'succeeded', output: { opened: true } });
    const [pr] = await prsOn(branch);
    expect(pr?.headSha).toBe(head);
    await pollGitHub();
    await fake().simulateCheckRun({ repo: REPO, sha: head, name: 'ci', conclusion: 'success' });
    await pollGitHub();
    w.advance(MERGE_CHECKS_GRACE_MS + 60_000);
    await w.settle();
    run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'merge')).toMatchObject({ state: 'succeeded', output: { merged: true } });
    // One line for the one time it went again, and nothing for the person.
    expect(await againLines(runId)).toHaveLength(1);
    expect(await unlanded(runId)).toEqual([]);
  });

  it('goes on while the branch moves, and ends when a try left it as it was, saying how many tries it had', async () => {
    const { runId, fixThread, branch, reviewTitle } = await toFix('Device groups won’t save');
    const changes = async (head: string, at: number) => {
      t3.delegate(fixThread, {
        title: reviewTitle,
        model: REVIEWER,
        answer: `Changes needed — reviewed ${short(head)}. Saving an empty group still fails.`,
        createdAt: new Date(Date.now() + at).toISOString(),
      });
      return relay(runId, `Changes needed — reviewed ${short(head)}\n\nSaving an empty group still fails.`);
    };
    // Try 1: changes asked: try 2 always may.
    let run = await changes(await fixed(runId, branch, 'Save groups'), 0);
    expect(step(run, 'fix')).toMatchObject({ state: 'waiting', attempt: 1 });
    // Try 2 pushed a new head: try 3 may.
    w.advance(60_000);
    run = await changes(await fixed(runId, branch, 'Save empty groups'), 60_000);
    expect(step(run, 'fix')).toMatchObject({ state: 'waiting', attempt: 2 });
    expect(String(step(run, 'fix').output.instructions)).toContain('try 3 of 10');
    // Try 3 pushed nothing: it ends there.
    const same = await headOf(branch);
    await w.fakeAgentReply(step(run, 'fix').dispatchId as string, 'Nothing more to change; pushed nothing.');
    await w.settle();
    run = await changes(same, 120_000);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'pr').state).toBe('skipped');
    expect(step(run, 'fix').attempt).toBe(2);
    expect(await againLines(runId)).toHaveLength(2);
    const notes = await unlanded(runId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('after 3 tries');
  });

  it('a failed review is done again on its own; a failed fix goes again from the fix', async () => {
    // The review's turn broke: only the review again, the fix thread isn't asked, and it isn't a try at the fix.
    const review = await toFix('Saving a label fails');
    await fixed(review.runId, review.branch, 'Save labels');
    let run = await w.run(review.runId);
    const fixTurn = step(run, 'fix').dispatchId;
    await w.services.db
      .update(dispatches)
      .set({ state: 'failed', error: 'The turn broke.', finishedAt: w.now() })
      .where(eq(dispatches.id, step(run, 'review').dispatchId as string));
    await w.settle();
    run = await w.run(review.runId);
    expect(run.status).toBe('waiting');
    expect(step(run, 'fix')).toMatchObject({ state: 'succeeded', attempt: 0, dispatchId: fixTurn });
    expect(step(run, 'fix').output.again).toMatchObject({ tries: 1, reviewRedo: 1 });
    expect(step(run, 'review')).toMatchObject({ state: 'waiting', attempt: 1 });
    expect((await automationLines(review.runId)).map((m) => m.text)).toContain(REVIEW_REDO_LINE);
    expect(await againLines(review.runId)).toEqual([]);

    // The fix's own turn broke: from the fix again, told how the earlier try ended.
    const fix = await toFix('Saving a note fails');
    await w.services.db
      .update(dispatches)
      .set({ state: 'failed', error: 'The thread stopped.', finishedAt: w.now() })
      .where(eq(dispatches.id, fix.fixTurn));
    await w.settle();
    run = await w.run(fix.runId);
    expect(run.status).toBe('waiting');
    expect(step(run, 'fix')).toMatchObject({ state: 'waiting', attempt: 1 });
    expect(step(run, 'fix').dispatchId).not.toBe(fix.fixTurn);
    expect(String(step(run, 'fix').output.instructions)).toContain('the fix step failed');
    expect(await againLines(fix.runId)).toEqual([
      'The fix couldn’t be finished, so it’s being worked on again (try 2 of 10).',
    ]);
  });

  /** The checks of `sha` fail, as GitHub reports them. */
  const red = async (sha: string) => {
    await pollGitHub();
    await fake().simulateCheckRun({ repo: REPO, sha, name: 'ci', conclusion: 'failure' });
    await pollGitHub();
  };
  /** A review of `sha` by another model, begun `after` ms from now on Whombat's clock. */
  const review = (fixThread: string, reviewTitle: string, sha: string, after = 0) =>
    t3.delegate(fixThread, {
      title: reviewTitle,
      model: REVIEWER,
      answer: `Approve — reviewed ${short(sha)}. The new test fails on main and passes on the branch.`,
      createdAt: new Date(w.now().getTime() + after).toISOString(),
    });

  it('a later try’s approval holds only for a review that began after it went again', async () => {
    const { runId, fixThread, branch, reviewTitle } = await toFix('Exports drop their footer');
    // Try 1: reviewed and approved, opened; its checks fail.
    const first = await fixed(runId, branch, 'Keep the footer');
    review(fixThread, reviewTitle, first);
    let run = await relay(runId, `Approve — reviewed ${short(first)}`);
    expect(step(run, 'pr')).toMatchObject({ state: 'succeeded', output: { opened: true } });
    const [pr] = await prsOn(branch);
    if (!pr) throw new Error('no pull request');
    await red(first);
    run = await w.run(runId);
    expect(step(run, 'fix')).toMatchObject({ state: 'waiting', attempt: 1 });
    expect(step(run, 'fix').output.again).toMatchObject({ tries: 2, cause: 'checks_failed' });

    // Try 2 pushes a new head that nobody reviews, and the review step relays try 1's approval: no approval.
    w.advance(60_000);
    const second = await fixed(runId, branch, 'Keep the footer of an empty export');
    run = await relay(runId, `Approve — reviewed ${short(first)}`);
    // Nothing merged: the branch moved, so it goes round again, saying why.
    const merges = () => fake().merges.filter((m) => m.repo === REPO && m.number === pr.number);
    expect(merges()).toEqual([]);
    expect(step(run, 'fix')).toMatchObject({ state: 'waiting', attempt: 2 });
    expect(step(run, 'fix').output.again).toMatchObject({
      tries: 3,
      head: { sha: second },
      cause: 'review_unconfirmed',
      detail: NOT_REVIEWED_THIS_TRY,
    });
    const told = String(step(run, 'fix').output.instructions);
    expect(told).toContain('couldn’t be confirmed for the branch as it is');
    expect(told).toContain(NOT_REVIEWED_THIS_TRY);
    expect(await againLines(runId)).toEqual([
      'The pull request’s checks failed, so the fix is being worked on again (try 2 of 10).',
      'The review couldn’t be confirmed, so the fix is being worked on again (try 3 of 10).',
    ]);

    // Try 3 has its own review: that approval holds, and the open pull request merges once its checks pass.
    w.advance(60_000);
    const third = await fixed(runId, branch, 'Keep the footer of every export');
    review(fixThread, reviewTitle, third, 1000);
    run = await relay(runId, `Approve — reviewed ${short(third)}`);
    expect(step(run, 'review')).toMatchObject({
      state: 'succeeded',
      output: { verdict: 'approve', head: third },
    });
    expect(step(run, 'pr')).toMatchObject({
      state: 'succeeded',
      output: { prNumber: pr.number, alreadyOpen: true },
    });
    await pollGitHub();
    await fake().simulateCheckRun({ repo: REPO, sha: third, name: 'ci', conclusion: 'success' });
    await pollGitHub();
    w.advance(MERGE_CHECKS_GRACE_MS + 60_000);
    await w.settle();
    run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(merges()).toHaveLength(1);
  });

  it('a later try’s reviewer that can’t be read is asked once more in that try too', async () => {
    const { runId, fixThread, branch, reviewTitle } = await toFix('Imports skip the last row');
    // Try 1: no review handed out: read again once, then no approval, which couldn't be confirmed: try 2.
    const first = await fixed(runId, branch, 'Keep the last row');
    let run = await relay(runId, `Approve — reviewed ${short(first)}`);
    expect(step(run, 'review')).toMatchObject({ state: 'pending', attempt: 1 });
    w.advance(31_000);
    await w.settle();
    run = await relay(runId, `Approve — reviewed ${short(first)}`);
    expect(step(run, 'fix')).toMatchObject({ state: 'waiting', attempt: 1 });
    expect(step(run, 'fix').output.again).toMatchObject({
      tries: 2,
      cause: 'review_unconfirmed',
      reviewAttempt: 2,
    });
    expect(await againLines(runId)).toEqual([
      'The review couldn’t be confirmed, so the fix is being worked on again (try 2 of 10).',
    ]);

    // Try 2: the reviewer still can't be read at first: this try's own read again.
    w.advance(60_000);
    const second = await fixed(runId, branch, 'Keep the last row of a short file');
    run = await relay(runId, `Approve — reviewed ${short(second)}`);
    expect(step(run, 'review')).toMatchObject({ state: 'pending', attempt: 3 });
    expect(step(run, 'review').error).toContain('read again');
    // The review shows up by the time the step asks again: it holds.
    review(fixThread, reviewTitle, second, 1000);
    w.advance(31_000);
    await w.settle();
    run = await relay(runId, `Approve — reviewed ${short(second)}`);
    expect(step(run, 'review')).toMatchObject({
      state: 'succeeded',
      attempt: 3,
      output: { verdict: 'approve', head: second },
    });
    expect(step(run, 'pr')).toMatchObject({ state: 'succeeded', output: { opened: true } });
  });

  it('a later try’s new commits are checked for the organization before its open pull request is used again', async () => {
    const { runId, fixThread, branch, reviewTitle } = await toFix('Kiosk mode drops the logo');
    const first = await fixed(runId, branch, 'Keep the logo');
    review(fixThread, reviewTitle, first);
    let run = await relay(runId, `Approve — reviewed ${short(first)}`);
    expect(step(run, 'pr')).toMatchObject({ state: 'succeeded', output: { opened: true } });
    const [pr] = await prsOn(branch);
    if (!pr) throw new Error('no pull request');
    await red(first);
    expect(step(await w.run(runId), 'fix')).toMatchObject({ state: 'waiting', attempt: 1 });

    // Try 2's commit names the customer's organization: the open pull request isn't used, nothing merges.
    w.advance(60_000);
    const second = await fixed(
      runId,
      branch,
      'Keep the logo in kiosk mode\n\nReported by Acme Fleet for their lobby devices.',
    );
    review(fixThread, reviewTitle, second, 1000);
    run = await relay(runId, `Approve — reviewed ${short(second)}`);
    expect(step(run, 'pr')).toMatchObject({
      state: 'succeeded',
      output: { opened: false, reason: ORGANIZATION_IN_COMMITS },
    });
    expect(fake().merges.filter((m) => m.repo === REPO && m.number === pr.number)).toEqual([]);
    expect(['succeeded', 'failed']).toContain(run.status);
    const notes = await unlanded(runId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('organization');
    expect(notes[0]?.text).not.toContain('Acme Fleet');
  });

  it('never for a run a person stopped', async () => {
    const { runId } = await toFix('Saving a printer name fails');
    const run = await w.run(runId);
    await w.ok(IDS.mara, controlAutomationRun, { number: run.number, action: 'cancel' });
    await w.settle();
    const after = await w.run(runId);
    expect(after.status).toBe('cancelled');
    expect(step(after, 'fix').attempt).toBe(0);
    expect(await againLines(runId)).toEqual([]);
  });
});

async function access(principalId: string): Promise<BurrowAccess> {
  const burrow = await loadBurrowRow(w.services.db, w.burrowId);
  const principal = await loadPrincipalRow(w.services.db, principalId);
  if (!burrow || !principal) throw new Error('no access');
  return { burrow, principal };
}

describe('the sweep behind a run’s end (TA-61)', () => {
  it('pages through every run whose notice was lost, however many finished runs need none', async () => {
    const lost = () =>
      w.services.db
        .select({ key: notifications.dedupKey })
        .from(notifications)
        .where(sql`${notifications.dedupKey} like 'tracker_unlanded:%'`);
    const before = await lost();
    expect(before.length).toBeGreaterThanOrEqual(2);
    await w.services.db.delete(notifications).where(sql`${notifications.dedupKey} like 'tracker_unlanded:%'`);
    w.advance(2 * 60_000);
    const { resendUnlanded } = await import('./unlanded');
    // One run a page: it still reaches them all.
    expect(await resendUnlanded(w.services, 1)).toBe(before.length);
    await w.services.background.settle();
    expect((await lost()).map((n) => n.key).sort()).toEqual(before.map((n) => n.key).sort());
  });
});

/** The fix turn's `t3_thread_wait` on its thread, as Dusty calls it through `connection_call`. */
async function waitCall(dispatchId: string, threadId: string, timeoutMs = 3_600_000) {
  const res = await callTool(
    w.services,
    { dispatchId, agentId: IDS.dusty, burrowId: w.burrowId },
    'connection_call',
    {
      connection: 't3',
      tool: 't3_thread_wait',
      arguments: { threadId, untilDelegatedWorkSettled: true, timeoutMs },
    },
  );
  expect(res.isError).not.toBe(true);
  const out = res.structuredContent as { status: string; content?: string; message?: string };
  expect(out.status).toBe('ok');
  return JSON.parse(out.content ?? '{}') as Record<string, unknown>;
}

/** The fix turn at work (claimed by a runner), its T3 Code thread still at work. */
async function fixAtWork(title: string) {
  const fix = await toFix(title);
  await w.services.db
    .update(dispatches)
    .set({ state: 'running', claimedAt: w.now() })
    .where(eq(dispatches.id, fix.fixTurn));
  const thread = t3.threads.get(fix.fixThread);
  if (!thread) throw new Error('no fix thread');
  thread.status = 'running';
  return fix;
}

describe('a step’s turn hands its T3 Code wait to Whombat while another customer waits', () => {
  it('nobody waiting: the wait goes to T3 Code, cut to fit a call', async () => {
    const { fixTurn, fixThread } = await fixAtWork('Export stops at 100 rows');
    const answer = await waitCall(fixTurn, fixThread);
    expect(answer).toMatchObject({ timedOut: true });
    expect(answer.handedToWhombat).toBeUndefined();
    const waits = t3.calls.filter((c) => c.name === 't3_thread_wait' && c.args.threadId === fixThread);
    expect(waits.at(-1)?.args.timeoutMs).toBe(STEP_WAIT_SLICE_MS);
    expect(STEP_WAIT_SLICE_MS).toBeLessThan(CONNECTION_CALL_DEADLINE_MS);
    const [turn] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, fixTurn));
    expect(turn?.waitsOn).toBeNull();
  });

  it('an update waits for running work: the turn hands its wait over, so the update needn’t wait for the fix', async () => {
    const { fixTurn, fixThread } = await fixAtWork('Licence page shows last year');
    w.services.maintenance.noteUpdateWaits(w.now());
    try {
      const answer = await waitCall(fixTurn, fixThread);
      expect(answer).toMatchObject({ timedOut: true, handedToWhombat: true, next: 'end_turn' });
      const [handed] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, fixTurn));
      expect(handed?.waitsOn).toMatchObject({ connectionId: t3Id, threadId: fixThread });
    } finally {
      // The update's question counts for a while only: later turns wait as before.
      w.advance(UPDATE_WAITS_MS + 1_000);
    }
    expect(w.services.maintenance.updateWaits(w.now())).toBe(false);
  });

  it('another report queued: the turn ends, the step waits for the thread, then a new turn finishes it', async () => {
    const { runId, fixTurn, fixThread, branch } = await fixAtWork('Blueprint list is empty');
    // Another customer's report arrives: its assessment turn waits for the one outsiders' profile.
    const other = await newRun('Device page shows the wrong owner');
    expect(step(await w.run(other.runId), 'ask').state).toBe('waiting');
    const answer = await waitCall(fixTurn, fixThread);
    expect(answer).toMatchObject({ timedOut: true, handedToWhombat: true, next: 'end_turn' });
    const [handed] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, fixTurn));
    expect(handed?.waitsOn).toMatchObject({ connectionId: t3Id, threadId: fixThread, settled: true });
    // Nothing more runs in the turn that handed over: another call hears it ended, and T3 Code isn't asked.
    const asked = t3.calls.length;
    const again = await callTool(
      w.services,
      { dispatchId: fixTurn, agentId: IDS.dusty, burrowId: w.burrowId },
      'connection_call',
      { connection: 't3', tool: 't3_thread_wait', arguments: { threadId: fixThread, timeoutMs: 25_000 } },
    );
    expect(again.isError).toBe(true);
    expect(t3.calls.length).toBe(asked);
    // The turn ends with a short line; the step goes on waiting, for the thread now.
    await w.fakeAgentReply(fixTurn, 'T3 Code is still working on the fix.');
    await w.settle();
    let fix = step(await w.run(runId), 'fix');
    expect(fix.state).toBe('waiting');
    expect(fix.dispatchId).toBe(fixTurn);
    // What the handed turn used still counts for the run's limits.
    await w.services.db
      .update(dispatches)
      .set({ usage: { inputTokens: 5000, outputTokens: 100 } })
      .where(eq(dispatches.id, fixTurn));
    // The thread finishes: the step's next turn is queued, in reply to the same request, with a line on the thread.
    t3.finish(
      fixThread,
      `A failing test first, then the fix; its review approved it and ${branch} was pushed.`,
    );
    w.advance(30_000);
    await w.settle();
    fix = step(await w.run(runId), 'fix');
    expect(fix.state).toBe('waiting');
    expect(fix.dispatchId).not.toBe(fixTurn);
    const [next] = await w.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, fix.dispatchId as string));
    expect(next).toMatchObject({ state: 'queued', messageId: handed?.messageId, waitsOn: null });
    expect(next?.onBehalfOfAccountId).toBeNull();
    expect(await runTokens(w.services.db, runId)).toBeGreaterThanOrEqual(5100);
    const { dispatchInstructions } = await import('../automations/workspace');
    const told = await dispatchInstructions(w.services.db, next?.id as string);
    expect(told).toContain(fixThread);
    expect(told).toContain('t3_thread_read');
    // Only what the new turn says is the step's result.
    await w.fakePush(REPO, branch, 'Show the blueprints again');
    await w.fakeAgentReply(next?.id as string, `The fix is in and ${branch} was pushed.`);
    await w.settle();
    fix = step(await w.run(runId), 'fix');
    expect(fix.state).toBe('succeeded');
    expect((fix.output as { reply?: string }).reply).toBe(`The fix is in and ${branch} was pushed.`);
    expect((fix.output as { text?: string }).text).not.toContain('still working');
    expect(step(await w.run(runId), 'review').state).toBe('waiting');
  });

  it('a handed turn that fails winding down, or doesn’t end, still leaves the step waiting for its thread', async () => {
    for (const ending of ['fails', 'lingers'] as const) {
      const { runId, fixTurn, fixThread } = await fixAtWork(`Labels print blank (${ending})`);
      await newRun(`Battery report is empty (${ending})`);
      expect(await waitCall(fixTurn, fixThread)).toMatchObject({ handedToWhombat: true });
      if (ending === 'fails') {
        // Its last line is refused, so the runner reports it failed: not queued again, no failure message (Try
        // again would start the work twice), and the step waits for its thread all the same.
        await w.services.runtime.finalize(fixTurn, {
          outcome: 'failed',
          error: 'The answer could not be posted to the conversation.',
        });
        await w.settle();
        const [failed] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, fixTurn));
        expect(failed).toMatchObject({ state: 'failed', failure: null });
      } else {
        // It keeps going after the hand-over: Whombat stops it, and the wait carries on.
        w.advance(3 * 60_000);
        await w.settle();
        const [stopped] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, fixTurn));
        expect(stopped).toMatchObject({ state: 'cancelled', error: 'handed_over' });
      }
      await w.settle();
      expect(step(await w.run(runId), 'fix')).toMatchObject({ state: 'waiting', dispatchId: fixTurn });
      t3.finish(fixThread, 'A failing test first, then the fix; its review approved it.');
      w.advance(30_000);
      await w.settle();
      const fix = step(await w.run(runId), 'fix');
      expect(fix.state).toBe('waiting');
      expect(fix.dispatchId).not.toBe(fixTurn);
    }
  });

  it('two fixes at work hold no place: the next customer’s report starts and its turn waits only for the profile', async () => {
    await fixAtWork('Exports drop their header');
    await fixAtWork('Device page stays blank');
    const third = await newRun('Users can’t sign in after an update');
    const run = await w.run(third.runId);
    expect(run.status).not.toBe('queued');
    expect(step(run, 'ask').state).toBe('waiting');
  });

  it('a third fix waits while two are at work, and starts once one of them ends', async () => {
    // A new day: the fixes the tests before started today don't count toward the automation's daily limit.
    w.advance(25 * 60 * 60_000);
    const first = await fixAtWork('Clock drifts on kiosks');
    await fixAtWork('Wallpaper resets at login');
    const third = await newRun('Printers vanish from the list');
    let run = await assess(third.runId, bug());
    expect(step(run, 'fix')).toMatchObject({ state: 'pending', inputSummary: FIX_WAITS_WORDS });
    expect(run.status).not.toBe('queued');
    // One fix ends: a minute later the third one starts.
    const [firstRun] = await w.services.db
      .select({ number: automationRuns.number })
      .from(automationRuns)
      .where(eq(automationRuns.id, first.runId));
    await w.ok(IDS.mara, controlAutomationRun, { number: firstRun?.number as number, action: 'cancel' });
    w.advance(61_000);
    await w.settle();
    run = await w.run(third.runId);
    expect(step(run, 'fix').state).toBe('waiting');
  });

  it('the step’s time counts from its first turn: a thread that never finishes fails it in time', async () => {
    const { runId, fixTurn, fixThread } = await fixAtWork('Reports page times out');
    await newRun('Nest settings won’t save');
    expect(await waitCall(fixTurn, fixThread)).toMatchObject({ handedToWhombat: true });
    await w.fakeAgentReply(fixTurn, 'T3 Code is still working on the fix.');
    await w.settle();
    expect(step(await w.run(runId), 'fix').state).toBe('waiting');
    w.advance(24 * 60 * 60_000);
    await w.settle();
    const fix = step(await w.run(runId), 'fix');
    expect(fix.state).not.toBe('waiting');
    expect(fix.error).toContain('in time');
  });
});
