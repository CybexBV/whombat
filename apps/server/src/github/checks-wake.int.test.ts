/**
 * The checks of a pull request wake the agent whose work it is (docs/decisions/health-checks-wake.md), end to end
 * against FakeGitHub through the poller: checks still running wake nobody; a finished round on a live run's pull request
 * posts one message from GitHub in the run's thread and queues one turn on the run; the same head again wakes nobody,
 * also after a restart; a new head wakes once more; a paused run
 * gets the message without a turn; a pull request nobody's run waits on wakes nobody (and a run started on it later
 * isn't woken with old news), unless it is the agent's own and a check failed on the commit Whombat pushed for it: then
 * in the Chat of the person the push was for (one-agent.md OA-S19).
 */
import { and, asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { startRun } from '../commands/agent-runs';
import { openPr } from '../commands/agent-tools';
import { sendMessage } from '../commands/messages';
import { pauseRun } from '../commands/runs';
import { dispatches, grants, messages, principals, pullRequests } from '../db/schema/index';
import { mcpToolList } from '../mcp/server';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { fakeOf, linkLogin, syncGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { accountOf } from '../test/tokens';
import { GitHubPoller } from './poller';

const t = useTestServer({ seed: true, app: true });
const REPO = 'whombat/billing';
const URL = (n: number) => `https://github.fake.whombat.local/${REPO}/pull/${n}`;
const DUSTY_EMAIL = 'dusty@agents.burrow-hq.whombat.com';
const sha = (c: string) => c.repeat(40);

beforeAll(async () => {
  await linkLogin(t, 'mara-gh', IDS.mara);
  // Dusty works on feature branches and opens pull requests without asking.
  for (const keyId of ['pr.open', 'branch.feature.readwrite'])
    await t.services.db
      .update(grants)
      .set({ tier: 'can' })
      .where(and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, keyId)));
  expect(await syncGitHub(t)).toMatchObject({ changes: 0, skipped: null });
});

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

/** What the agent reads of a wake in its turn: the plain line, then the commit and the counts. */
async function agentReads(messageId: string) {
  const [turn] = await turnsFor(messageId);
  if (!turn) throw new Error('no turn for the wake');
  return (await buildDispatchContext(t.services, turn)).trigger?.text ?? '';
}

const turnsFor = (messageId: string) =>
  t.services.db.select().from(dispatches).where(eq(dispatches.messageId, messageId));

/** Turns of a run still queued are run: what the agent's turn would have done meanwhile. */
async function ranTurnsOf(runId: string) {
  await t.services.db
    .update(dispatches)
    .set({ state: 'done' })
    .where(and(eq(dispatches.runId, runId), eq(dispatches.state, 'queued')));
}

/** Mara opens a pull request on GitHub; the poller brings it in. */
async function personPr(branch: string, title: string): Promise<number> {
  const number = await fakeOf(t).simulateOpenPullRequest({
    repo: REPO,
    head: branch,
    title,
    login: 'mara-gh',
  });
  await syncGitHub(t);
  return number;
}

/** Mara asks Dusty in a thread of billing-v2; Dusty's turn starts a run on the pull request (its card in the thread). */
async function runOn(prNumber: number, title: string) {
  const asked = await t.commit(IDS.mara, sendMessage, {
    conversationId: IDS.billing,
    text: `Please ${title}.`,
  });
  if (asked.status !== 'ok') throw new Error('send failed');
  const [turn] = await t.services.db
    .insert(dispatches)
    .values({
      id: `dsp_${title.replace(/\W+/g, '-').slice(0, 20)}`,
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
  await ranTurnsOf(started.result.runId);
  return { runId: started.result.runId, number: started.result.number, threadRootId: asked.result.id };
}

async function checks(head: string, results: Record<string, 'success' | 'failure' | 'in_progress'>) {
  for (const [name, result] of Object.entries(results))
    await fakeOf(t).simulateCheckRun(
      result === 'in_progress'
        ? { repo: REPO, sha: head, name, status: 'in_progress' }
        : { repo: REPO, sha: head, name, conclusion: result },
    );
}

describe('the checks of a pull request an agent’s run works on (HW-01…HW-03)', () => {
  let pr = 0;
  let run: Awaited<ReturnType<typeof runOn>>;
  let head = '';

  it('wake nobody while one is still running', async () => {
    pr = await personPr('feat/wake-on-checks', 'Wake on checks');
    run = await runOn(pr, 'wake on checks');
    head = (await prRow(pr)).headSha;
    await checks(head, { lint: 'success', unit: 'in_progress' });
    await syncGitHub(t);
    await syncGitHub(t);
    expect(await wakes()).toEqual([]);
    expect((await prRow(pr)).checksHandledSha).toBeNull();
  });

  it('once finished, wake the run’s agent once: GitHub’s message in the run’s thread and a turn on the run', async () => {
    await checks(head, { unit: 'failure', build: 'success' });
    // The poll that sees the round finish waits for the next one: a job that needs another may still show up.
    await syncGitHub(t);
    expect(await wakes()).toEqual([]);
    await syncGitHub(t);
    const [wake, ...more] = await wakes();
    expect(more).toEqual([]);
    expect(wake).toMatchObject({
      conversationId: IDS.billing,
      threadRootId: run.threadRootId,
      text: `The checks on [PR #${pr}](${URL(pr)}) failed (unit).`,
      mentions: [IDS.dusty],
    });
    // The commit and the counts are the agent's alone.
    const reads = await agentReads(wake?.id ?? '');
    for (const fact of [
      wake?.text ?? '',
      head.slice(0, 6),
      '2 passed, 1 failed (unit)',
      'feat/wake-on-checks',
    ])
      expect(reads).toContain(fact);
    const turns = await turnsFor(wake?.id ?? '');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      agentId: IDS.dusty,
      trigger: 'mention',
      mode: 'run',
      runId: run.runId,
      conversationId: IDS.billing,
      threadRootId: run.threadRootId,
      state: 'queued',
      // For the person the run is for (SUB-28).
      onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
    });
    expect((await prRow(pr)).checksHandledSha).toBe(head);
  });

  it('the same head polled again wakes nobody, also after a restart', async () => {
    await syncGitHub(t);
    const restarted = new GitHubPoller(t.services, t.services.github);
    expect(await restarted.pollNow({ burrowId: t.burrowId })).toMatchObject({ errors: [] });
    expect(await wakes()).toHaveLength(1);
    expect(await t.services.db.select().from(dispatches).where(eq(dispatches.runId, run.runId))).toHaveLength(
      2,
    );
  });

  it('a new head wakes the agent once more', async () => {
    await ranTurnsOf(run.runId);
    const next = sha('a');
    await fakeOf(t).simulatePush({
      repo: REPO,
      branch: 'feat/wake-on-checks',
      commits: [{ sha: next, message: 'Fix the unit tests', authorEmail: DUSTY_EMAIL }],
    });
    await syncGitHub(t);
    expect((await prRow(pr)).headSha).toBe(next);
    await checks(next, { lint: 'success', unit: 'success', build: 'success' });
    await syncGitHub(t);
    await syncGitHub(t);
    const all = await wakes();
    expect(all).toHaveLength(2);
    expect(all[1]?.text).toBe(`The checks on [PR #${pr}](${URL(pr)}) passed.`);
    expect(await turnsFor(all[1]?.id ?? '')).toMatchObject([
      { agentId: IDS.dusty, mode: 'run', runId: run.runId },
    ]);
  });
});

describe('a paused run (HW-04)', () => {
  it('gets the message in its thread, and no turn: the person paused it', async () => {
    const pr = await personPr('feat/paused-on-checks', 'Paused on checks');
    const run = await runOn(pr, 'pause on checks');
    const paused = await t.commit(IDS.mara, pauseRun, { number: run.number });
    expect(paused.status).toBe('ok');
    const head = (await prRow(pr)).headSha;
    await checks(head, { lint: 'success' });
    await syncGitHub(t);
    await syncGitHub(t);
    const wake = (await wakes()).at(-1);
    expect(wake).toMatchObject({
      threadRootId: run.threadRootId,
      text: `The checks on [PR #${pr}](${URL(pr)}) passed.`,
    });
    expect(await turnsFor(wake?.id ?? '')).toEqual([]);
    expect((await prRow(pr)).checksHandledSha).toBe(head);
  });
});

describe('a pull request no agent’s run waits on (HW-04)', () => {
  it('a person’s: nobody is woken, the head is handled, and a run started on it later isn’t woken with old news', async () => {
    const before = (await wakes()).length;
    const pr = await personPr('feat/people-only', 'People only');
    const head = (await prRow(pr)).headSha;
    await checks(head, { lint: 'success', unit: 'failure' });
    await syncGitHub(t);
    await syncGitHub(t);
    expect(await wakes()).toHaveLength(before);
    expect((await prRow(pr)).checksHandledSha).toBe(head);
    await runOn(pr, 'look at people only');
    await syncGitHub(t);
    expect(await wakes()).toHaveLength(before);
  });

  it('the agent’s own: a check failed on the commit Whombat pushed for Mara wakes it in her Chat; a pass doesn’t', async () => {
    const fake = fakeOf(t);
    const branch = 'feat/dusty-alone';
    const pushed = async (head: string, message: string) => {
      await t.services.github.recordPushGrant({
        burrowId: t.burrowId,
        repo: REPO,
        branch,
        agentId: IDS.dusty,
        dispatchId: null,
        onBehalfOf: { text: 'Mara in billing-v2', principalId: IDS.mara },
        sha: head,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      await fake.simulatePush({
        repo: REPO,
        branch,
        commits: [{ sha: head, message, authorEmail: DUSTY_EMAIL }],
      });
    };
    const first = sha('c');
    await pushed(first, 'Alone');
    const opened = await t.commit(IDS.dusty, openPr, { repo: REPO, branch, title: 'Alone' });
    if (opened.status !== 'ok') throw new Error(`open_pr: ${opened.status}`);
    const pr = opened.result.number;
    await syncGitHub(t);
    await checks(first, { lint: 'success', unit: 'failure' });
    await syncGitHub(t);
    await syncGitHub(t);
    const wake = (await wakes()).at(-1);
    const room = IDS.dmDusty;
    expect(wake).toMatchObject({
      conversationId: room,
      threadRootId: null,
      text: `The checks on [PR #${pr}](${URL(pr)}) failed (unit).`,
    });
    expect(await agentReads(wake?.id ?? '')).toContain(first.slice(0, 6));
    expect(await turnsFor(wake?.id ?? '')).toMatchObject([
      {
        agentId: IDS.dusty,
        trigger: 'mention',
        mode: 'reply',
        runId: null,
        conversationId: room,
        onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
      },
    ]);
    // Its fix passes: that is the person's news, in the room already.
    const count = (await wakes()).length;
    const second = sha('d');
    await pushed(second, 'Alone, fixed');
    await syncGitHub(t);
    await checks(second, { lint: 'success', unit: 'success' });
    await syncGitHub(t);
    await syncGitHub(t);
    expect(await wakes()).toHaveLength(count);
    expect((await prRow(pr)).checksHandledSha).toBe(second);
  });
});

describe('the schedule tool as served (HW-08)', () => {
  it('says checks and CI, and T3 Code threads, are not waited for with it', async () => {
    const tools = await mcpToolList(t.services, IDS.dusty);
    const description = tools.find((tool) => tool.name === 'schedule')?.description ?? '';
    for (const fact of [
      'checks or CI',
      'T3 Code thread',
      'Whombat wakes you',
      'Schedule only what time alone brings',
    ])
      expect(description).toContain(fact);
  });
});
