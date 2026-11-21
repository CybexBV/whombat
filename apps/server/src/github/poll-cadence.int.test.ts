/**
 * The poller's adaptive cadence and heads without check runs, end to end against FakeGitHub with a clock the test steps
 * (docs/decisions/polling.md PL-01, PL-02): a repo is fast while an agent's run, push, deploy or pull request checks are
 * live there, active while a person is, idle otherwise; only due repos are read; a push token, a run going live and a
 * person coming back wake it; an hour of polling per state (the requests the decision records); the checks wake's
 * latency on the fast cadence against the old fixed 30 s; and a head without checks that is handled after a minute,
 * read for checks on the idle rhythm only, and still wakes the run when CI starts late.
 */
import { topics } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRun } from '../commands/agent-runs';
import { sendMessage } from '../commands/messages';
import {
  dispatches,
  githubDeploys,
  githubPollCursors,
  githubPushGrants,
  grants,
  messages,
  principals,
  pullRequests,
  runs,
} from '../db/schema/index';
import { loadRun } from '../read/work';
import { presenceFor } from '../realtime/presence-tracker';
import { IDS } from '../seed/test-world';
import { fakeOf, linkLogin, syncGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { accountOf } from '../test/tokens';
import { WAKE_GAP_MS } from './poll-cadence';
import { NO_CHECKS_SETTLE_MS } from './poll-plan';
import { GitHubPoller } from './poller';

const t = useTestServer({ seed: true, app: true });
const REPO = 'whombat/billing';
const PRESENCE_KEY = 'poll-cadence-test';

/** The clock every poller of this file runs on. */
let now = Date.now();
const clock = () => new Date(now);
// The account's own repositories aren't read here (owned-repos.ts, connect.int.test.ts): only the repos' reads count.
const newPoller = (cadences?: { fast: number; active: number; idle: number }) =>
  new GitHubPoller(t.services, t.services.github, { clock, cadences, ownedEveryMs: 0 });

beforeAll(async () => {
  await linkLogin(t, 'mara-gh', IDS.mara);
  for (const keyId of ['pr.open', 'branch.feature.readwrite'])
    await t.services.db
      .update(grants)
      .set({ tier: 'can' })
      .where(and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, keyId)));
  expect(await syncGitHub(t)).toMatchObject({ changes: 0, skipped: null });
  // PR #482 (Dusty's) has CI on GitHub too, a check still running; it moved a day ago.
  const head = (await prRow(482)).headSha;
  await fakeOf(t).simulateCheckRun({ repo: REPO, sha: head, name: 'pdf-snapshot', status: 'in_progress' });
  await syncGitHub(t);
  await t.services.db
    .update(pullRequests)
    .set({ updatedAt: new Date(now - 24 * 3600_000) })
    .where(eq(pullRequests.number, 482));
});

afterAll(() => {
  presenceFor(t.services).disconnect(PRESENCE_KEY);
});

/** Run #1907 (seeded, live on PR #482) needs a person, or goes on. */
async function run1907(live: boolean) {
  await t.services.db
    .update(runs)
    .set({ attention: live ? null : 'Dusty stopped without finishing this run.' })
    .where(eq(runs.id, 'run_1907'));
}

function personActive(active: boolean) {
  const presence = presenceFor(t.services);
  if (active) presence.connect(PRESENCE_KEY, t.burrowId, IDS.mara);
  else presence.disconnect(PRESENCE_KEY);
}

async function prRow(number: number) {
  const [row] = await t.services.db.select().from(pullRequests).where(eq(pullRequests.number, number));
  if (!row) throw new Error(`no PR #${number}`);
  return row;
}

/** GitHub's messages that name someone: the wakes. */
async function wakes() {
  const [github] = await t.services.db.select().from(principals).where(eq(principals.system, 'github'));
  if (!github) return [];
  const rows = await t.services.db
    .select()
    .from(messages)
    .where(eq(messages.authorId, github.id))
    .orderBy(asc(messages.ord));
  return rows.filter((m) => m.mentions.length > 0);
}

let turns = 0;

/** Mara asks Dusty in a thread of #billing-v2; Dusty's turn starts a run on the pull request. */
async function runOn(prNumber: number, title: string) {
  const asked = await t.commit(IDS.mara, sendMessage, {
    conversationId: IDS.billing,
    text: `Please ${title}.`,
  });
  if (asked.status !== 'ok') throw new Error('send failed');
  const [turn] = await t.services.db
    .insert(dispatches)
    .values({
      id: `dsp_cadence-${++turns}`,
      burrowId: t.burrowId,
      agentId: IDS.dusty,
      trigger: 'mention',
      mode: 'reply',
      conversationId: IDS.billing,
      messageId: asked.result.id,
      threadRootId: asked.result.id,
      state: 'done',
      createdAt: new Date(),
      onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
    })
    .returning();
  const started = await t.commit(IDS.dusty, startRun, {
    conversationId: IDS.billing,
    title,
    repo: REPO,
    branch: 'ignored',
    prNumber,
    dispatchId: turn?.id,
    steps: [{ title: 'Change it', detail: '' }],
  });
  if (started.status !== 'ok') throw new Error(`start_run: ${started.status}`);
  // Its first turns ran.
  await t.services.db
    .update(dispatches)
    .set({ state: 'done' })
    .where(and(eq(dispatches.runId, started.result.runId), eq(dispatches.state, 'queued')));
  return { runId: started.result.runId, threadRootId: asked.result.id };
}

/** Steps the clock from tick to tick for `ms`, as the timer would; what GitHub was asked meanwhile. */
async function simulate(p: GitHubPoller, ms: number, each?: () => Promise<boolean>) {
  const fake = fakeOf(t);
  const from = fake.reads.length;
  const end = now + ms;
  let polls = 0;
  for (;;) {
    const at = p.nextDueAt();
    if (at > end) break;
    now = at;
    polls += (await p.pollDue()).repos;
    if (each && (await each())) break;
  }
  if (!each) now = end;
  const reads = fake.reads.slice(from);
  return { polls, reads: reads.length, counted: reads.filter((r) => r.status === 200).length };
}

describe('a repo’s cadence (PL-01)', () => {
  const plan = (p: GitHubPoller) => p.planOf(t.burrowId, REPO);

  it('is fast while a run is live there, idle when nothing is and nobody is there, active while a person is', async () => {
    const p = newPoller();
    await p.pollNow();
    expect(plan(p)).toMatchObject({ cadence: 'fast', reason: 'run', polledAt: now });
    // The seeded run needs a person now: nothing live.
    await run1907(false);
    await p.pollNow();
    expect(plan(p)).toMatchObject({ cadence: 'idle', reason: 'quiet' });
    personActive(true);
    await p.pollNow();
    expect(plan(p)).toMatchObject({ cadence: 'active', reason: 'person' });
    personActive(false);
    await p.pollNow();
    expect(plan(p)).toMatchObject({ cadence: 'idle' });
  });

  it('is fast for ten minutes after a push token was handed out, which wakes it at once', async () => {
    const p = newPoller();
    await p.pollNow();
    expect(plan(p)?.wokenAt).toBeNull();
    now += 1_000;
    await t.services.github.recordPushGrant({
      burrowId: t.burrowId,
      repo: REPO,
      branch: 'feat/cadence-push',
      agentId: IDS.dusty,
      dispatchId: null,
      onBehalfOf: {},
      sha: null,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    // The service's own poller was woken; this one only by hand.
    p.wake(t.burrowId, REPO);
    expect(plan(p)?.wokenAt).toBe(now);
    expect(await p.pollDue()).toMatchObject({ repos: 1 });
    expect(plan(p)).toMatchObject({ cadence: 'fast', reason: 'push' });
    // Ten minutes on (the test's clock runs ahead of the grant's), the push has long landed.
    now += 20 * 60_000;
    await p.pollNow();
    expect(plan(p)).toMatchObject({ cadence: 'idle' });
    await t.services.db.delete(githubPushGrants).where(eq(githubPushGrants.branch, 'feat/cadence-push'));
  });

  it('is fast while a deploy is in flight', async () => {
    const p = newPoller();
    await t.services.db.insert(githubDeploys).values({
      approvalId: 'apr_cadence',
      burrowId: t.burrowId,
      repo: REPO,
      workflow: 'deploy.yml',
      ref: 'main',
      environment: 'staging',
      state: 'running',
      dispatchedAt: new Date(now - 60_000),
    });
    await p.pollNow();
    expect(plan(p)).toMatchObject({ cadence: 'fast', reason: 'deploy' });
    await t.services.db.delete(githubDeploys).where(eq(githubDeploys.approvalId, 'apr_cadence'));
    await p.pollNow();
    expect(plan(p)).toMatchObject({ cadence: 'idle' });
  });

  it('is fast while an agent’s pull request that moved in the last hour has checks to finish', async () => {
    const p = newPoller();
    // PR #482 is Dusty's and its pdf-snapshot check is still running; it moved a day ago.
    await p.pollNow();
    expect(plan(p)).toMatchObject({ cadence: 'idle' });
    await t.services.db
      .update(pullRequests)
      .set({ updatedAt: new Date(now - 60_000) })
      .where(eq(pullRequests.number, 482));
    await p.pollNow();
    expect(plan(p)).toMatchObject({ cadence: 'fast', reason: 'checks' });
    // Its round handled: nothing to wait for.
    await t.services.db
      .update(pullRequests)
      .set({ checksHandledSha: (await prRow(482)).headSha })
      .where(eq(pullRequests.number, 482));
    await p.pollNow();
    expect(plan(p)).toMatchObject({ cadence: 'idle' });
    await t.services.db
      .update(pullRequests)
      .set({ checksHandledSha: null, updatedAt: new Date(now - 24 * 3600_000) })
      .where(eq(pullRequests.number, 482));
  });
});

describe('the schedule (PL-01)', () => {
  const plan = (p: GitHubPoller) => p.planOf(t.burrowId, REPO);

  it('reads only the repos that are due; a wake makes one due at once', async () => {
    const p = newPoller();
    await p.pollNow();
    expect(plan(p)).toMatchObject({ cadence: 'idle' });
    expect(await p.pollDue()).toMatchObject({ repos: 0 });
    now += 170_000;
    expect(await p.pollDue()).toMatchObject({ repos: 0 });
    now += 10_000;
    expect(await p.pollDue()).toMatchObject({ repos: 1 });
    now += 5_000;
    p.wake(t.burrowId, REPO);
    expect(await p.pollDue()).toMatchObject({ repos: 1 });
    expect(await p.pollDue()).toMatchObject({ repos: 0 });
  });

  it('a run going live and a person coming back wake it from the bus', async () => {
    const p = newPoller();
    p.listen();
    try {
      await p.pollNow();
      now += 5_000;
      const run = await loadRun(t.services.db, 'run_1907');
      if (!run) throw new Error('no run #1907');
      // The run card's frame after a commit: a run going live is news once.
      t.services.bus.publish({
        topic: topics.burrow(t.burrowId),
        event: { type: 'run.updated', run: { ...run, status: 'live' } },
        eventId: null,
        at: new Date(now).toISOString(),
        outboxId: null,
      });
      expect(plan(p)?.wokenAt).toBe(now);
      expect(await p.pollDue()).toMatchObject({ repos: 1 });
      // Mara opens Whombat: her burrow's idle repos are read on the active cadence from now.
      expect(plan(p)).toMatchObject({ cadence: 'idle' });
      personActive(true);
      expect(plan(p)).toMatchObject({ cadence: 'active', reason: 'person' });
      now += 30_000;
      expect(await p.pollDue()).toMatchObject({ repos: 1 });
    } finally {
      personActive(false);
      await p.stop();
    }
  });
});

describe('an hour of polling (PL-01; numbers in docs/decisions/polling.md)', () => {
  /** Five open pull requests whose checks ran (as with CI on every PR). */
  beforeAll(async () => {
    const fake = fakeOf(t);
    for (const n of [1, 2, 3, 4]) {
      const number = await fake.simulateOpenPullRequest({
        repo: REPO,
        head: `feat/hour-${n}`,
        title: `Hour ${n}`,
        login: 'mara-gh',
      });
      const head = fake.repos.get(REPO)?.prs.get(number)?.headSha ?? '';
      await fake.simulateCheckRun({ repo: REPO, sha: head, name: 'unit', conclusion: 'success' });
    }
    await syncGitHub(t);
    await syncGitHub(t);
  });

  // 11 requests each with five PRs in polling.md, plus the repository's own read (agent-repos.md AGR-15): a 304 GitHub
  // doesn't count while the repository keeps its name and settings, so the counted ones stay 11 a refresh.
  it('idle: every 3 minutes; active: every 30 s; fast: every 10 s — 12 requests each with five PRs', async () => {
    const hour = 3600_000;
    const open = await t.services.db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, 'rep_billing'), eq(pullRequests.state, 'open')));
    expect(open).toHaveLength(5);

    const idle = newPoller();
    await idle.pollNow();
    expect(idle.planOf(t.burrowId, REPO)?.cadence).toBe('idle');
    const quiet = await simulate(idle, hour);
    expect(quiet.polls).toBe(20);
    expect(quiet.reads).toBe(20 * 12);

    personActive(true);
    const active = newPoller();
    await active.pollNow();
    const busy = await simulate(active, hour);
    personActive(false);
    expect(busy.polls).toBe(120);
    expect(busy.reads).toBe(120 * 12);

    await run1907(true);
    const fast = newPoller();
    await fast.pollNow();
    const live = await simulate(fast, hour);
    await run1907(false);
    expect(live.polls).toBe(360);
    expect(live.reads).toBe(360 * 12);

    // Before PL-01: every 30 s whatever happens, a refresh every 10 minutes.
    const fixed = newPoller({ fast: 30_000, active: 30_000, idle: 30_000 });
    await fixed.pollNow();
    const before = await simulate(fixed, hour);
    expect(before.polls).toBe(120);
    expect(before.reads).toBe(120 * 12);

    // Only answers other than 304 count against the rate limit: the refreshes, here.
    expect(quiet.counted).toBe(5 * 11);
    expect(busy.counted).toBe(2 * 11);
    expect(live.counted).toBe(2 * 11);
    expect(before.counted).toBe(6 * 11);
  });
});

describe('the checks wake’s latency (PL-01, HW-01)', () => {
  /** A run waits on its PR's checks; they finish just after a poll. Returns how long until GitHub's message. */
  async function latency(p: GitHubPoller, branch: string) {
    const fake = fakeOf(t);
    const number = await fake.simulateOpenPullRequest({
      repo: REPO,
      head: branch,
      title: branch,
      login: 'mara-gh',
    });
    await p.pollNow();
    await runOn(number, `wait on ${branch}`);
    const head = (await prRow(number)).headSha;
    await fake.simulateCheckRun({ repo: REPO, sha: head, name: 'unit', status: 'in_progress' });
    await p.pollNow();
    const count = (await wakes()).length;
    const finishedAt = now + 1;
    await fake.simulateCheckRun({ repo: REPO, sha: head, name: 'unit', conclusion: 'success' });
    await simulate(p, 5 * 60_000, async () => (await wakes()).length > count);
    expect(await wakes()).toHaveLength(count + 1);
    return now - finishedAt;
  }

  it('is two fast polls at most (≤ 20 s), against two 30 s polls before (≤ 60 s)', async () => {
    const after = await latency(newPoller(), 'feat/latency-fast');
    expect(after).toBeGreaterThan(10_000);
    expect(after).toBeLessThanOrEqual(20_000);
    const before = await latency(
      newPoller({ fast: 30_000, active: 30_000, idle: 30_000 }),
      'feat/latency-30s',
    );
    expect(before).toBeGreaterThan(30_000);
    expect(before).toBeLessThanOrEqual(60_000);
  });
});

describe('a head without check runs (PL-02)', () => {
  it('is handled a minute on, read for checks on the idle rhythm only, and still wakes the run when CI starts late', async () => {
    const fake = fakeOf(t);
    const p = newPoller();
    const number = await fake.simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/late-ci',
      title: 'Late CI',
      login: 'mara-gh',
    });
    await p.pollNow();
    const run = await runOn(number, 'wait on late CI');
    const head = (await prRow(number)).headSha;
    const checksRead = `checks ${REPO}@${head.slice(0, 7)}`;
    const readsOfHead = (from: number) => fake.reads.slice(from).filter((r) => r.what === checksRead).length;

    // Ten seconds on (the run makes it fast): still none, but CI may be starting.
    now += 10_000;
    await p.pollNow();
    expect(p.planOf(t.burrowId, REPO)).toMatchObject({ cadence: 'fast', reason: 'run' });
    expect((await prRow(number)).checksHandledSha).toBeNull();
    // A minute after the first empty answer, a poll that still finds none handles the head.
    await simulate(p, NO_CHECKS_SETTLE_MS - 10_000);
    expect((await prRow(number)).checksHandledSha).toBe(head);
    const [cursor] = await t.services.db
      .select()
      .from(githubPollCursors)
      .where(eq(githubPollCursors.repo, REPO));
    expect(cursor?.etags[`checks:${number}:${head}:none`]).toMatch(/^\d+\/\d+$/);

    // From now on its checks are asked on the idle rhythm (3 min), not on every 10 s poll.
    let from = fake.reads.length;
    await simulate(p, 120_000);
    expect(readsOfHead(from)).toBe(0);

    // CI starts late: the next ask sees it, lifts the mark, and the finished round wakes Dusty on the run.
    await fake.simulateCheckRun({ repo: REPO, sha: head, name: 'unit', status: 'in_progress' });
    from = fake.reads.length;
    const startedAt = now;
    await simulate(p, 180_000, async () => readsOfHead(from) > 0);
    expect(readsOfHead(from)).toBe(1);
    expect(now - startedAt).toBeLessThanOrEqual(60_000);
    expect((await prRow(number)).checksHandledSha).toBeNull();
    const count = (await wakes()).length;
    await fake.simulateCheckRun({ repo: REPO, sha: head, name: 'unit', conclusion: 'success' });
    await simulate(p, 30_000);
    const wake = (await wakes()).at(-1);
    expect(await wakes()).toHaveLength(count + 1);
    expect(wake).toMatchObject({ threadRootId: run.threadRootId, mentions: [IDS.dusty] });
    expect((await prRow(number)).checksHandledSha).toBe(head);
  });

  it('an agent’s pull request without checks keeps its repo fast only until it is handled', async () => {
    const fake = fakeOf(t);
    const p = newPoller();
    // The runs of the tests before need a person now: nothing else is live.
    await t.services.db.update(runs).set({ attention: 'Needs a person.' }).where(eq(runs.status, 'live'));
    const number = await fake.simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/no-ci',
      title: 'No CI',
      login: 'mara-gh',
    });
    await p.pollNow();
    // Dusty's (as `open_pr` records it), moved just now.
    await t.services.db
      .update(pullRequests)
      .set({ authorId: IDS.dusty, updatedAt: new Date(now) })
      .where(eq(pullRequests.number, number));
    now += 10_000;
    await p.pollNow();
    expect(p.planOf(t.burrowId, REPO)).toMatchObject({ cadence: 'fast', reason: 'checks' });
    await simulate(p, NO_CHECKS_SETTLE_MS);
    expect((await prRow(number)).checksHandledSha).toBe((await prRow(number)).headSha);
    expect(p.planOf(t.burrowId, REPO)).toMatchObject({ cadence: 'idle' });
  });
});

describe('the timer (PL-01)', () => {
  it('polls soon after start, and soon after a wake although the repo’s cadence is a minute', async () => {
    const fake = fakeOf(t);
    const pulls = () => fake.reads.filter((r) => r.what === `pulls ${REPO}`).length;
    // The poller's clock, stepped past the wake gap instead of waiting it out (TS-S09).
    let ahead = 0;
    const p = new GitHubPoller(t.services, t.services.github, {
      cadences: { fast: 60_000, active: 60_000, idle: 60_000 },
      firstTickMs: 100,
      clock: () => new Date(Date.now() + ahead),
    });
    const before = pulls();
    p.start();
    try {
      await expect.poll(pulls, { timeout: 10_000, interval: 50 }).toBe(before + 1);
      await p.idle();
      // Two polls of a repo are at least WAKE_GAP_MS apart, however soon it is woken.
      ahead += WAKE_GAP_MS;
      p.wake(t.burrowId, REPO);
      await expect.poll(pulls, { timeout: 5_000, interval: 50 }).toBe(before + 2);
    } finally {
      await p.stop();
    }
  });
});
