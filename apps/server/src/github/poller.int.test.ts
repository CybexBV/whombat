/**
 * The poller end to end against FakeGitHub (what webhooks used to feed): PRs opened on GitHub open branch
 * rooms, pushes land commits (cards for people, signed by the agent whose push grant it was), check runs
 * update checks / post the failure pill / re-evaluate approvals, reviews post review cards and pills, and
 * merged / closed / reopened PRs change the room's state. Then: polling again or after a restart changes
 * nothing (ETags answer 304, pushes and reviews are recorded once), agents' branches without a PR, a GitHub
 * sign-in that stopped working and a low rate limit. The burrow is connected as Mara's own GitHub account, `whombat`
 * (EA-10).
 */
import { prStatus } from '@whombat/core';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBurrowChain } from '../audit/verify';
import { openPr } from '../commands/agent-tools';
import {
  conversations,
  events,
  githubBranchHeads,
  githubConnections,
  githubPollCursors,
  messages,
  prCommits,
  principals,
  pullRequests,
  repos,
} from '../db/schema/index';
import { loadAgentRow } from '../read/principals';
import { approvalByNumber, loadPullRequest, toApproval } from '../read/work';
import { IDS } from '../seed/test-world';
import { fakeOf, linkLogin, syncGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { GitHubError } from './adapter';
import { GitHubPoller, POLLED_AT_EVERY_MS } from './poller';

const t = useTestServer({ seed: true, app: true });
const REPO = 'whombat/billing';

beforeAll(async () => {
  // Connected by Mara as her own GitHub account (the fake's login): what Whombat does on GitHub, it does as that account.
  await t.services.db
    .insert(githubConnections)
    .values({ burrowId: t.burrowId, login: fakeOf(t).login, connectedById: IDS.mara })
    .onConflictDoUpdate({
      target: githubConnections.burrowId,
      set: { login: fakeOf(t).login, connectedById: IDS.mara },
    });
  await linkLogin(t, 'mara-gh', IDS.mara);
  // The first cycle is the baseline: the seeded world is already what the fake says.
  const first = await syncGitHub(t);
  expect(first).toMatchObject({ changes: 0, skipped: null });
});

async function prRow(number: number) {
  const [row] = await t.services.db.select().from(pullRequests).where(eq(pullRequests.number, number));
  if (!row) throw new Error(`no PR #${number}`);
  return row;
}

async function pr(number: number) {
  return loadPullRequest(t.services.db, await prRow(number));
}

async function roomMessages(number: number) {
  const row = await prRow(number);
  return t.services.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, row.conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.ord));
}

async function lastEvent(type: string, actorId?: string) {
  const [row] = await t.services.db
    .select()
    .from(events)
    .where(actorId ? and(eq(events.type, type), eq(events.actorId, actorId)) : eq(events.type, type))
    .orderBy(desc(events.seq))
    .limit(1);
  return row;
}

/** The burrow's GitHub signer (created on first use). */
async function githubSigner() {
  const [system] = await t.services.db.select().from(principals).where(eq(principals.system, 'github'));
  if (!system) throw new Error('no GitHub signer yet');
  return system.id;
}

/** The statements the server sends Postgres while `fn` runs (postgres.js's `debug` hook on the suite's pool). */
async function statements(fn: () => Promise<unknown>): Promise<string[]> {
  const options = (t.services.sql as unknown as { options: { debug: unknown } }).options;
  const before = options.debug;
  const seen: string[] = [];
  options.debug = (_connection: number, query: string) => seen.push(query);
  try {
    await fn();
  } finally {
    options.debug = before;
  }
  return seen;
}

async function totals() {
  const [m] = await t.services.db.select({ n: count() }).from(messages);
  const [e] = await t.services.db.select({ n: count() }).from(events);
  return { messages: m?.n ?? 0, events: e?.n ?? 0 };
}

describe('pull requests', () => {
  it('a PR opened on GitHub opens a branch room with its people and the commits card', async () => {
    const fake = fakeOf(t);
    const number = await fake.simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/credit-notes',
      title: 'Credit-note PDFs',
      login: 'mara-gh',
      reviewers: ['mara-gh'],
    });
    expect(number).toBe(483);
    expect((await syncGitHub(t)).changes).toBe(1);
    const row = await prRow(483);
    const [room] = await t.services.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, row.conversationId));
    expect(room).toMatchObject({
      kind: 'branch',
      title: 'feat/credit-notes',
      topic: 'PR #483 · Credit-note PDFs · opened by Mara',
      prNumber: 483,
    });
    const [opened] = await roomMessages(483);
    expect(opened).toMatchObject({
      authorId: IDS.mara,
      text: 'Opened PR #483 · Credit-note PDFs.',
      card: {
        kind: 'commits',
        prNumber: 483,
        commits: [{ message: 'Credit-note PDFs' }],
        signedById: IDS.mara,
      },
    });
    const view = await pr(483);
    expect(view.reviewers).toEqual([{ principalId: IDS.mara, state: 'pending', at: null }]);
    expect(prStatus(view)).toBe('in_review');
    expect((await lastEvent('pr.opened', IDS.mara))?.text).toBe('Opened PR #483 · Credit-note PDFs');
  });

  it('a push Whombat did not make is signed by GitHub, saying whose commits they are; the head moves', async () => {
    const fake = fakeOf(t);
    const sha = `c0ffee${'1'.repeat(34)}`;
    await fake.simulatePush({
      repo: REPO,
      branch: 'feat/credit-notes',
      commits: [
        {
          sha,
          message: 'Add credit-note totals',
          authorName: 'Mara Okafor',
          authorEmail: 'mara@burrowhq.example',
        },
      ],
    });
    await syncGitHub(t);
    expect((await prRow(483)).headSha).toBe(sha);
    const system = await githubSigner();
    const last = (await roomMessages(483)).at(-1);
    expect(last).toMatchObject({
      authorId: system,
      text: 'Pushed 1 commit by Mara Okafor to feat/credit-notes.',
      card: { kind: 'commits', commits: [{ sha, message: 'Add credit-note totals' }] },
    });
    const pushed = await lastEvent('branch.pushed', system);
    expect(pushed).toMatchObject({
      text: 'Pushed c0ffee to feat/credit-notes',
      keyUsed: null,
      payload: { authors: 'Mara Okafor' },
    });
    expect(await lastEvent('branch.pushed', IDS.mara)).toBeUndefined();
    // The commit list still shows whose commit it is.
    const [commit] = await t.services.db.select().from(prCommits).where(eq(prCommits.sha, sha));
    expect(commit?.authorId).toBe(IDS.mara);
  });

  it('the push of the commit Whombat pushed for an agent is signed by the agent, under its branch key', async () => {
    const fake = fakeOf(t);
    const sha = `bead00${'2'.repeat(34)}`;
    await t.services.github.recordPushGrant({
      burrowId: t.burrowId,
      repo: REPO,
      branch: 'feat/credit-notes',
      agentId: IDS.dusty,
      dispatchId: null,
      onBehalfOf: { text: 'Mara in billing-v2', principalId: IDS.mara },
      sha,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const before = (await roomMessages(483)).length;
    await fake.simulatePush({
      repo: REPO,
      branch: 'feat/credit-notes',
      commits: [{ sha, message: 'Round credit notes', authorEmail: 'dusty@agents.burrow-hq.whombat.com' }],
    });
    await syncGitHub(t);
    expect(await lastEvent('branch.pushed', IDS.dusty)).toMatchObject({
      text: 'Pushed bead00 to feat/credit-notes',
      keyUsed: { id: 'branch.feature.readwrite', label: 'Read and write feat/* branches' },
      onBehalfOf: 'Mara in billing-v2',
    });
    // Agents announce their own pushes: no commits card from the mirror.
    expect((await roomMessages(483)).length).toBe(before);
    const [commit] = await t.services.db.select().from(prCommits).where(eq(prCommits.sha, sha));
    expect(commit?.authorId).toBe(IDS.dusty);
  });

  it('a commit written as the agent’s or the person’s is not their push (the grant is for another commit)', async () => {
    const fake = fakeOf(t);
    const system = await githubSigner();
    // Dusty's push grant for this branch is still live, for bead00…; these commits only say who wrote them.
    for (const [sha, authorName, authorEmail] of [
      [`5b00f0${'6'.repeat(34)}`, 'Dusty', 'dusty@agents.burrow-hq.whombat.com'],
      [`5b00f1${'7'.repeat(34)}`, 'Mara Okafor', 'mara@burrowhq.example'],
    ] as const) {
      await fake.simulatePush({
        repo: REPO,
        branch: 'feat/credit-notes',
        commits: [{ sha, message: 'Looks legit', authorName, authorEmail }],
      });
      await syncGitHub(t);
      const [event] = await t.services.db
        .select()
        .from(events)
        .where(and(eq(events.type, 'branch.pushed'), sql`${events.payload}->>'sha' = ${sha}`));
      expect(event).toMatchObject({ actorId: system, keyUsed: null, onBehalfOf: null });
      expect((await roomMessages(483)).at(-1)).toMatchObject({
        authorId: system,
        text: `Pushed 1 commit by ${authorName} to feat/credit-notes.`,
      });
    }
  });

  it('a fork’s PR from a branch named like the agent’s never touches the agent’s PR', async () => {
    const fake = fakeOf(t);
    const agentsPr = await prRow(483);
    const number = await fake.simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/credit-notes',
      fork: 'stranger/billing',
      title: 'Totally legit',
      login: 'stranger',
    });
    await syncGitHub(t);
    expect(await prRow(number)).toMatchObject({ branch: 'stranger:feat/credit-notes', authorId: null });
    const sha = `f0f0f0${'8'.repeat(34)}`;
    await fake.simulatePush({
      repo: REPO,
      branch: 'feat/credit-notes',
      fork: 'stranger/billing',
      commits: [
        {
          sha,
          message: 'Push as Dusty',
          authorName: 'Dusty',
          authorEmail: 'dusty@agents.burrow-hq.whombat.com',
        },
      ],
    });
    // Whombat pushed that very commit for Dusty to the same-named branch of the repo: still not the fork's.
    await t.services.github.recordPushGrant({
      burrowId: t.burrowId,
      repo: REPO,
      branch: 'feat/credit-notes',
      agentId: IDS.dusty,
      dispatchId: null,
      onBehalfOf: {},
      sha,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await syncGitHub(t);
    expect((await prRow(number)).headSha).toBe(sha);
    expect((await prRow(483)).headSha).toBe(agentsPr.headSha);
    const onAgentsPr = await t.services.db.select().from(prCommits).where(eq(prCommits.prId, agentsPr.id));
    expect(onAgentsPr.map((c) => c.sha)).not.toContain(sha);
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'branch.pushed'), sql`${events.payload}->>'sha' = ${sha}`));
    expect(event).toMatchObject({
      actorId: await githubSigner(),
      text: 'Pushed f0f0f0 to stranger:feat/credit-notes',
      keyUsed: null,
    });
    await fake.simulateClose({ repo: REPO, number, login: 'mara-gh', merged: false });
    await syncGitHub(t);
  });

  it('pushes by someone unknown are signed by GitHub, which stays off the roster', async () => {
    const fake = fakeOf(t);
    await fake.simulatePush({
      repo: REPO,
      branch: 'feat/credit-notes',
      commits: [{ sha: `0c7ca7${'3'.repeat(34)}`, message: 'Drive-by fix', authorEmail: 'octo@example.com' }],
    });
    await syncGitHub(t);
    const [system] = await t.services.db.select().from(principals).where(eq(principals.system, 'github'));
    expect(system).toMatchObject({ name: 'GitHub', kind: 'system' });
    expect((await lastEvent('branch.pushed', system?.id))?.text).toBe('Pushed 0c7ca7 to feat/credit-notes');
    expect((await roomMessages(483)).at(-1)).toMatchObject({
      authorId: system?.id,
      card: { kind: 'commits' },
    });
    // GitHub's signer is part of Whombat itself (one-agent.md OA-17), never the agent.
    expect((await loadAgentRow(t.services.db, t.burrowId))?.name).not.toBe('GitHub');
  });

  it('a PR the connection’s account opened on the commit Whombat pushed for an agent is the agent’s', async () => {
    const fake = fakeOf(t);
    const sha = `a9e270${'9'.repeat(34)}`;
    await fake.simulatePush({
      repo: REPO,
      branch: 'feat/agent-pr',
      commits: [{ sha, message: 'Agent work', authorEmail: 'dusty@agents.burrow-hq.whombat.com' }],
    });
    await t.services.github.recordPushGrant({
      burrowId: t.burrowId,
      repo: REPO,
      branch: 'feat/agent-pr',
      agentId: IDS.dusty,
      dispatchId: null,
      onBehalfOf: {},
      sha,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const number = await fake.simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/agent-pr',
      title: 'Agent PR',
      login: fake.login,
    });
    // The same account's PR whose head only claims to be Dusty's is not his.
    await fake.simulatePush({
      repo: REPO,
      branch: 'feat/claims-banjo',
      commits: [
        {
          sha: `c1a1e5${'0'.repeat(34)}`,
          message: 'Claims',
          authorEmail: 'dusty@agents.burrow-hq.whombat.com',
        },
      ],
    });
    const claims = await fake.simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/claims-banjo',
      title: 'Claims to be Dusty’s',
      login: fake.login,
    });
    await syncGitHub(t);
    expect(await prRow(number)).toMatchObject({ authorId: IDS.dusty });
    expect((await roomMessages(number))[0]?.authorId).toBe(IDS.dusty);
    expect((await prRow(claims)).authorId).not.toBe(IDS.dusty);
  });
});

describe('checks', () => {
  it('update the PR, post the failure pill once a round fails, and are reported by the CI agent', async () => {
    const fake = fakeOf(t);
    const sha = (await prRow(483)).headSha;
    await fake.simulateCheckRun({ repo: REPO, sha, name: 'lint', conclusion: 'success', durationMs: 12_000 });
    await fake.simulateCheckRun({ repo: REPO, sha, name: 'unit', status: 'in_progress' });
    await syncGitHub(t);
    expect((await pr(483)).checks).toMatchObject([
      { name: 'lint', state: 'passed', note: '12s' },
      { name: 'unit', state: 'running', note: 'running' },
    ]);
    await fake.simulateCheckRun({
      repo: REPO,
      sha,
      name: 'unit',
      conclusion: 'failure',
      title: '38 of 41 passed',
    });
    await syncGitHub(t);
    const view = await pr(483);
    expect(view.checks[1]).toMatchObject({
      state: 'failed',
      note: '38/41',
      tests: { passed: 38, total: 41 },
    });
    expect(prStatus(view)).toBe('checks_failing');
    // One plain line naming the pull request and the failing check; the commit and the counts stay on the PR.
    const posted = (await roomMessages(483)).at(-1);
    expect(posted).toMatchObject({
      authorId: IDS.dusty,
      text: expect.stringMatching(/^Checks failed on .*PR #483/),
      card: { kind: 'pill', text: 'unit failed', tone: 'warn' },
    });
    expect(posted?.text).not.toContain(sha.slice(0, 6));
    expect((await lastEvent('checks.completed', IDS.dusty))?.text).toBe('Checks failed on PR #483 (unit).');
    // Polling again posts nothing twice.
    const before = await totals();
    await syncGitHub(t);
    expect(await totals()).toEqual(before);
  });

  it('re-evaluate approval conditions: green checks on PR #482 meet Dusty’s deploy condition', async () => {
    const fake = fakeOf(t);
    const checks = () =>
      approvalByNumber(t.services.db, t.burrowId, 12).then(
        (row) => row && toApproval(row).conditions.find((c) => c.kind === 'checks_pass'),
      );
    expect(await checks()).toMatchObject({ met: false });
    const sha = (await prRow(482)).headSha;
    await fake.simulateCheckRun({
      repo: REPO,
      sha,
      name: 'unit · billing',
      conclusion: 'success',
      title: '41 of 41 passed',
    });
    await fake.simulateCheckRun({
      repo: REPO,
      sha,
      name: 'pdf-snapshot',
      conclusion: 'success',
      durationMs: 9_000,
    });
    await syncGitHub(t);
    expect(await checks()).toMatchObject({ met: true, state: 'passed', passed: 41, total: 41 });
    expect((await lastEvent('checks.completed', IDS.dusty))?.text).toBe('Checks passed on PR #482.');
  });

  it('a second open PR on the same head gets its own checks (not the first PR’s 304)', async () => {
    const fake = fakeOf(t);
    const sha = (await prRow(482)).headSha;
    fake.repos.get(REPO)?.branches.set('feat/invoice-pdf-v2', sha);
    const number = await fake.simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/invoice-pdf-v2',
      base: 'release',
      title: 'Invoice PDF export (release)',
      login: 'mara-gh',
    });
    await syncGitHub(t);
    expect((await pr(number)).checks.map((c) => [c.name, c.state])).toEqual([
      ['unit · billing', 'passed'],
      ['pdf-snapshot', 'passed'],
    ]);
  });
});

describe('reviews', () => {
  it('changes requested posts the review card; approving posts the pill and moves the reviewer', async () => {
    const fake = fakeOf(t);
    await fake.simulateReview({
      repo: REPO,
      number: 483,
      login: 'mara-gh',
      state: 'changes_requested',
      body: '',
      comments: [
        {
          path: 'billing/pdf/credit.ts',
          line: 12,
          body: 'Round before `formatAmount`.',
          diffHunk:
            '@@ -10,3 +10,3 @@\n const total = sum(lines);\n-return formatAmount(total);\n+return formatAmount(round(total));',
        },
      ],
    });
    await syncGitHub(t);
    expect((await roomMessages(483)).at(-1)).toMatchObject({
      authorId: IDS.mara,
      text: 'Requested 1 change on PR #483.',
      card: {
        kind: 'review',
        prNumber: 483,
        file: 'billing/pdf/credit.ts',
        line: 12,
        changesRequested: 1,
        comments: [{ n: 1, text: 'Round before `formatAmount`.' }],
      },
    });
    expect((await pr(483)).reviewers.find((r) => r.principalId === IDS.mara)?.state).toBe(
      'changes_requested',
    );
    expect((await lastEvent('pr.changes_requested', IDS.mara))?.text).toBe('Requested 1 change on PR #483');

    await fake.simulateReview({ repo: REPO, number: 483, login: 'mara-gh', state: 'approved' });
    await syncGitHub(t);
    expect((await roomMessages(483)).at(-1)).toMatchObject({
      authorId: IDS.mara,
      text: 'Approved.',
      card: { kind: 'pill', text: 'Approved · PR #483', tone: 'ok' },
    });
    expect((await pr(483)).reviewers.find((r) => r.principalId === IDS.mara)?.state).toBe('approved');
  });

  it('names reviewers nobody linked, and never posts a review twice', async () => {
    const fake = fakeOf(t);
    await fake.simulateReview({
      repo: REPO,
      number: 483,
      login: 'stranger',
      state: 'commented',
      body: 'Nice.',
    });
    await syncGitHub(t);
    expect((await roomMessages(483)).at(-1)?.text).toBe('stranger on GitHub: Nice.');
    const before = await totals();
    await syncGitHub(t);
    await syncGitHub(t);
    expect(await totals()).toEqual(before);
  });

  it('reviews from before the poller started watching a PR the burrow had are history, not news', async () => {
    const fake = fakeOf(t);
    const repo = fake.repos.get(REPO);
    if (!repo) throw new Error('no fake repo');
    const [cursor] = await t.services.db
      .select()
      .from(githubPollCursors)
      .where(eq(githubPollCursors.repo, REPO));
    expect(cursor?.knownPrs).toContain(482);
    repo.reviews.push({
      id: 99_001,
      prNumber: 482,
      state: 'approved',
      author: 'joris-gh',
      body: 'Old approval.',
      submittedAt: new Date((cursor?.baselineAt.getTime() ?? 0) - 60_000).toISOString(),
      comments: [],
    });
    const before = (await roomMessages(482)).length;
    await syncGitHub(t);
    expect((await roomMessages(482)).length).toBe(before);
  });
});

describe('merged, closed, reopened and review requests', () => {
  it('a merge on GitHub merges the room’s PR, signed by whoever merged', async () => {
    const fake = fakeOf(t);
    await fake.simulateClose({ repo: REPO, number: 483, login: 'mara-gh', merged: true });
    await syncGitHub(t);
    expect(await prRow(483)).toMatchObject({ state: 'merged', mergedById: IDS.mara });
    expect(prStatus(await pr(483))).toBe('merged');
    expect((await lastEvent('pr.merged', IDS.mara))?.text).toBe('Merged PR #483 into main');
  });

  it('review requests, closing without merging and reopening', async () => {
    const fake = fakeOf(t);
    const number = await fake.simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/abandoned',
      title: 'Abandoned idea',
      login: 'joris-gh',
    });
    await syncGitHub(t);
    await fake.simulateRequestReviewers({ repo: REPO, number, logins: ['mara-gh'] });
    await syncGitHub(t);
    expect((await lastEvent('pr.review_requested'))?.text).toBe(`Asked Mara to review PR #${number}`);
    expect((await pr(number)).reviewers.map((r) => r.principalId)).toEqual([IDS.mara]);

    await fake.simulateClose({ repo: REPO, number, login: 'joris-gh', merged: false });
    await syncGitHub(t);
    expect((await prRow(number)).state).toBe('closed');
    expect(prStatus(await pr(number))).toBe('closed');
    expect((await lastEvent('pr.closed'))?.text).toBe(`Closed PR #${number}`);

    await fake.simulateReopen({ repo: REPO, number });
    await syncGitHub(t);
    expect((await prRow(number)).state).toBe('open');
    expect((await lastEvent('pr.reopened'))?.text).toBe(`Reopened PR #${number}`);
    expect((await verifyBurrowChain(t.services.db, t.burrowId)).ok).toBe(true);
  });
});

describe('review requests nobody in the burrow can take', () => {
  it('change nothing when the list is read again, nor on the refresh without ETags', async () => {
    const fake = fakeOf(t);
    const number = await fake.simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/outside-review',
      title: 'Outside review',
      login: 'joris-gh',
      reviewers: ['octocat'],
    });
    await syncGitHub(t);
    expect((await pr(number)).reviewers).toEqual([]);
    const before = await totals();
    // The list changes (another unlinked login asked), and a cycle reads everything without ETags.
    await fake.simulateRequestReviewers({ repo: REPO, number, logins: ['hubot'] });
    await syncGitHub(t);
    await t.services.db
      .update(githubPollCursors)
      .set({ refreshedAt: new Date(0) })
      .where(eq(githubPollCursors.repo, REPO));
    await syncGitHub(t);
    expect(await totals()).toEqual(before);
  });
});

describe('pull requests GitHub does not have', () => {
  it('leaves a PR opened in Whombat before the burrow was connected alone', async () => {
    const fake = fakeOf(t);
    const billing = await prRow(482);
    await t.services.db.insert(pullRequests).values({
      id: 'pr_whombat-only',
      burrowId: t.burrowId,
      repoId: billing.repoId,
      number: 900,
      branch: 'feat/local-only',
      title: 'Only in Whombat',
      headSha: 'abc1234',
      conversationId: billing.conversationId,
      openedAt: new Date(),
    });
    // Something changes on GitHub, so the list is read again and #900 is missing from it.
    await fake.simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/elsewhere',
      title: 'Elsewhere',
      login: 'joris-gh',
    });
    await syncGitHub(t);
    expect(await prRow(900)).toMatchObject({ state: 'open', localOnly: true });
  });

  it('never mirrors GitHub’s PR with the same number onto one opened while the repo was not connected', async () => {
    const fake = fakeOf(t);
    await t.services.db.update(repos).set({ enabled: true }).where(eq(repos.fullName, 'whombat/web'));
    // whombat/web is not on GitHub yet: Dusty's PR is Whombat's own, #1.
    const web = fake.repos.get('whombat/web');
    if (!web) throw new Error('no fake repo');
    fake.repos.delete('whombat/web');
    const opened = await t.commit(IDS.dusty, openPr, {
      repo: 'whombat/web',
      branch: 'feat/offline',
      title: 'Offline work',
    });
    fake.repos.set('whombat/web', web);
    if (opened.status !== 'ok') throw new Error(`open_pr: ${opened.status}`);
    expect(opened.result.number).toBe(1);
    const [local] = await t.services.db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.conversationId, opened.result.conversationId));
    expect(local).toMatchObject({ number: 1, localOnly: true });
    // Then the repo is on GitHub, where someone else's PR is #1.
    await fake.simulateOpenPullRequest({
      repo: 'whombat/web',
      head: 'feat/someone-else',
      title: 'Someone else’s first PR',
      login: 'joris-gh',
    });
    await syncGitHub(t);
    await syncGitHub(t);
    const [after] = await t.services.db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.id, local?.id ?? ''));
    expect(after).toMatchObject({
      state: 'open',
      title: 'Offline work',
      branch: 'feat/offline',
      headSha: local?.headSha,
    });
    // Merging it in Whombat never merges GitHub's #1.
    const merged = await t.services.github.mergeOutcome({
      burrowId: t.burrowId,
      repo: 'whombat/web',
      number: 1,
      method: 'squash',
      headSha: local?.headSha ?? '',
      title: 'Offline work',
      mergedBy: 'Mara Okafor',
    });
    expect(merged).toEqual({ outcome: 'here' });
    expect(web.prs.get(1)?.state).toBe('open');
  });
});

describe('a PR Whombat opened on GitHub', () => {
  it('gets its commits, files and diff from GitHub though its head never moves', async () => {
    const fake = fakeOf(t);
    const sha = `9e1e70${'5'.repeat(34)}`;
    // Dusty's runner pushed, Dusty opened the PR through Whombat, and nothing happened after.
    await fake.simulatePush({
      repo: REPO,
      branch: 'feat/quiet',
      commits: [{ sha, message: 'Add quiet mode', authorEmail: 'dusty@agents.burrow-hq.whombat.com' }],
    });
    const opened = await t.commit(IDS.dusty, openPr, {
      repo: REPO,
      branch: 'feat/quiet',
      title: 'Quiet mode',
    });
    if (opened.status !== 'ok') throw new Error(`open_pr: ${opened.status}`);
    const number = opened.result.number;
    const onGitHub = fake.repos.get(REPO)?.prs.get(number);
    if (!onGitHub) throw new Error('not on GitHub');
    onGitHub.files = [{ path: 'billing/quiet.ts', add: 12, del: 3 }];
    expect((await pr(number)).commits).toEqual([]);
    await syncGitHub(t);
    const view = await pr(number);
    expect(view.commits.map((c) => [c.sha, c.message, c.authorId])).toEqual([
      [sha, 'Add quiet mode', IDS.dusty],
    ]);
    expect(view.files).toEqual([{ path: 'billing/quiet.ts', add: 12, del: 3 }]);
    expect(view.diff).toEqual({ add: 12, del: 3, files: 1 });
    // Read once: the next list change asks nothing more of it.
    const before = await totals();
    await fake.simulateRequestReviewers({ repo: REPO, number, logins: ['octocat'] });
    await syncGitHub(t);
    expect(await totals()).toEqual(before);
  });
});

describe('agents’ branches before a pull request', () => {
  it('mirror the push of a branch an agent holds a push grant for, once', async () => {
    const fake = fakeOf(t);
    const sha = `ea41e0${'4'.repeat(34)}`;
    await t.services.github.recordPushGrant({
      burrowId: t.burrowId,
      repo: REPO,
      branch: 'feat/early',
      agentId: IDS.dusty,
      dispatchId: null,
      onBehalfOf: { text: 'Mara in billing-v2', principalId: IDS.mara },
      sha,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await syncGitHub(t); // not pushed yet
    await fake.simulatePush({
      repo: REPO,
      branch: 'feat/early',
      commits: [{ sha, message: 'Start early', authorEmail: 'dusty@agents.burrow-hq.whombat.com' }],
    });
    await syncGitHub(t);
    expect(await lastEvent('branch.pushed', IDS.dusty)).toMatchObject({
      text: 'Pushed ea41e0 to feat/early',
      onBehalfOf: 'Mara in billing-v2',
    });
    const before = await totals();
    await syncGitHub(t);
    expect(await totals()).toEqual(before);
  });
});

describe('an agent’s branch someone else pushed first', () => {
  it('is only where the branch is, not a push by the agent', async () => {
    const fake = fakeOf(t);
    await t.services.github.recordPushGrant({
      burrowId: t.burrowId,
      repo: REPO,
      branch: 'feat/spoofed',
      agentId: IDS.dusty,
      dispatchId: null,
      onBehalfOf: {},
      sha: `5a1e00${'1'.repeat(34)}`,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const sha = `5a1e01${'2'.repeat(34)}`;
    await fake.simulatePush({
      repo: REPO,
      branch: 'feat/spoofed',
      commits: [{ sha, message: 'Not Dusty', authorEmail: 'dusty@agents.burrow-hq.whombat.com' }],
    });
    const before = await totals();
    await syncGitHub(t);
    expect(await totals()).toEqual(before);
    const [head] = await t.services.db
      .select()
      .from(githubBranchHeads)
      .where(eq(githubBranchHeads.branch, 'feat/spoofed'));
    expect(head?.sha).toBe(sha);
  });
});

describe('a PR GitHub refuses', () => {
  it('is skipped and reported; the other PRs, the branches and the refresh go on', async () => {
    const fake = fakeOf(t);
    const reviews = fake.reviews.bind(fake);
    fake.reviews = async (repo, number, etags) => {
      if (number === 482) throw new GitHubError('Server Error', 502);
      return reviews(repo, number, etags);
    };
    try {
      // An open PR numbered after #482 (read after it).
      const [later] = await t.services.db
        .select({ number: pullRequests.number, headSha: pullRequests.headSha })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repoId, 'rep_billing'),
            eq(pullRequests.state, 'open'),
            eq(pullRequests.localOnly, false),
          ),
        )
        .orderBy(desc(pullRequests.number))
        .limit(1);
      if (!later || later.number <= 482) throw new Error('no open PR after #482');
      const { number, headSha: sha } = later;
      await fake.simulateCheckRun({ repo: REPO, sha, name: 'late-check', conclusion: 'success' });
      // The ten-minute read without ETags is due.
      await t.services.db
        .update(githubPollCursors)
        .set({ refreshedAt: new Date(0) })
        .where(eq(githubPollCursors.repo, REPO));
      const from = fake.reads.length;
      const report = await t.services.github.poller.pollNow({ burrowId: t.burrowId });
      expect(report.errors).toEqual([expect.stringMatching(/^whombat\/billing: PR #482: .*Server Error/)]);
      expect((await pr(number)).checks.map((c) => c.name)).toContain('late-check');
      // Agents' branches were still read (feat/early has a live push grant and no PR).
      expect(fake.reads.slice(from).map((r) => r.what)).toContain(`branch ${REPO}:feat/early`);
      const [cursor] = await t.services.db
        .select()
        .from(githubPollCursors)
        .where(eq(githubPollCursors.repo, REPO));
      expect(cursor?.refreshedAt?.getTime()).toBeGreaterThan(0);
      expect(cursor?.error).toMatch(/PR #482/);
    } finally {
      fake.reviews = reviews;
    }
    expect((await syncGitHub(t)).errors).toEqual([]);
  });
});

describe('a PR closed before the poller started, reopened after', () => {
  it('keeps its older reviews as history', async () => {
    const fake = fakeOf(t);
    const number = await fake.simulateOpenPullRequest({
      repo: REPO,
      head: 'feat/old-reviews',
      title: 'Old reviews',
      login: 'joris-gh',
    });
    await syncGitHub(t);
    await fake.simulateClose({ repo: REPO, number, login: 'joris-gh', merged: false });
    await syncGitHub(t);
    expect((await prRow(number)).state).toBe('closed');
    // The cutover: the poller starts watching the repo now (webhooks mirrored the reviews before).
    await t.services.db.delete(githubPollCursors).where(eq(githubPollCursors.repo, REPO));
    await syncGitHub(t);
    const [cursor] = await t.services.db
      .select()
      .from(githubPollCursors)
      .where(eq(githubPollCursors.repo, REPO));
    expect(cursor?.knownPrs).toContain(number);
    fake.repos.get(REPO)?.reviews.push({
      id: 99_002,
      prNumber: number,
      state: 'approved',
      author: 'mara-gh',
      body: 'Approved before the cutover.',
      submittedAt: new Date((cursor?.baselineAt.getTime() ?? 0) - 60_000).toISOString(),
      comments: [],
    });
    const before = (await roomMessages(number)).length;
    await fake.simulateReopen({ repo: REPO, number });
    await syncGitHub(t);
    expect((await prRow(number)).state).toBe('open');
    expect((await roomMessages(number)).length).toBe(before);
    expect((await pr(number)).reviewers).toEqual([]);
  });
});

describe('polling again', () => {
  it('answers from ETags and changes nothing, also after a restart', async () => {
    const fake = fakeOf(t);
    await syncGitHub(t);
    const before = await totals();
    const from = fake.reads.length;
    await syncGitHub(t);
    const reads = fake.reads.slice(from);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((r) => r.status === 200)).toEqual([]);
    // A new server process: the cursors are in the database.
    const restarted = new GitHubPoller(t.services, t.services.github);
    const report = await restarted.pollNow({ burrowId: t.burrowId });
    expect(report).toMatchObject({ changes: 0, errors: [] });
    expect(fake.reads.slice(from + reads.length).every((r) => r.status === 304)).toBe(true);
    expect(await totals()).toEqual(before);
  });

  it('reads the burrows and the automations once a cycle, and saves a cursor only when something changed', async () => {
    let now = Date.now();
    const poller = new GitHubPoller(t.services, t.services.github, { clock: () => new Date(now) });
    // The first scheduled cycle reads the account's own repositories; later ones within the hour don't.
    await poller.pollDue();
    const targets = await poller.targets({ burrowId: t.burrowId });
    expect(targets.length).toBeGreaterThan(0);
    const cursorWrites = (seen: string[]) => seen.filter((q) => q.startsWith('update "github_poll_cursors"'));

    // Every repo due again: one read of the connected burrows and of the burrow's automations for all of them.
    now += 10 * 60_000;
    const due = await statements(() => poller.pollDue());
    expect(due.filter((q) => q.includes('from "github_connections"'))).toHaveLength(1);
    expect(due.filter((q) => q.includes('from "automations"'))).toHaveLength(1);
    expect(cursorWrites(due).length).toBeGreaterThan(0);

    // Ten seconds on, every answer a 304: nothing to save.
    now += 10_000;
    const quiet = await statements(() => poller.pollNow({ burrowId: t.burrowId }));
    expect(quiet.filter((q) => q.includes('from "github_poll_cursors"')).length).toBe(targets.length);
    expect(cursorWrites(quiet)).toEqual([]);

    // A minute after it was saved, the cursor says again when the repo was last read (the GitHub status's `polledAt`).
    now += POLLED_AT_EVERY_MS;
    expect(cursorWrites(await statements(() => poller.pollNow({ burrowId: t.burrowId })))).toHaveLength(
      targets.length,
    );
    const [cursor] = await t.services.db
      .select({ polledAt: githubPollCursors.polledAt })
      .from(githubPollCursors)
      .where(eq(githubPollCursors.repo, REPO));
    expect(cursor?.polledAt?.getTime()).toBe(now);
  });

  it('skips while GitHub refuses the sign-in, and says so in the status', async () => {
    const fake = fakeOf(t);
    fake.loggedOut = true;
    t.services.github.forgetConnection();
    try {
      expect(await t.services.github.poller.pollNow({ burrowId: t.burrowId })).toMatchObject({
        skipped: 'not_connected',
      });
    } finally {
      fake.loggedOut = false;
      t.services.github.forgetConnection();
    }
    expect((await syncGitHub(t)).skipped).toBeNull();
  });

  it('waits for the rate limit window when GitHub runs low', async () => {
    const fake = fakeOf(t);
    const rate = fake.rateLimit.bind(fake);
    fake.rateLimit = () => ({ remaining: 12, limit: 5000, resetAt: Date.now() + 60_000 });
    try {
      const poller = new GitHubPoller(t.services, t.services.github);
      expect(await poller.pollNow()).toMatchObject({ skipped: 'rate_limited', repos: 0 });
      fake.rateLimit = rate;
      // Still inside the window it was told to wait for.
      expect(await poller.pollNow()).toMatchObject({ skipped: 'rate_limited' });
    } finally {
      fake.rateLimit = rate;
    }
  });
});
