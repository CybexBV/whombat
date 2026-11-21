/**
 * The checks of the agent's own pull request wake it in a person's Chat (health-checks-wake.md HW-01…HW-04, one-agent.md
 * OA-S19), against FakeGitHub through the poller: its run's pull request finishing its round posts GitHub's message where
 * the run was asked (the person's Chat) and queues one turn on the run, for that person; its own pull request without a
 * run, with a check failed on the commit Whombat pushed for a person, wakes it in that person's Chat.
 */
import { and, asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { startRun } from '../commands/agent-runs';
import { openPr } from '../commands/agent-tools';
import { dispatches, messages, principals, pullRequests } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { fakeOf, linkLogin, syncGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { accountOf } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
const REPO = 'whombat/billing';
const URL = (n: number) => `https://github.fake.whombat.local/${REPO}/pull/${n}`;
const sha = (c: string) => c.repeat(40);

/** The agent and Mara's Chat with it. */
const agent = { agentId: IDS.dusty, handle: 'dusty', dmId: IDS.dmDusty };

beforeAll(async () => {
  await linkLogin(t, 'mara-gh', IDS.mara);
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

const turnsFor = (messageId: string) =>
  t.services.db.select().from(dispatches).where(eq(dispatches.messageId, messageId));

async function checks(head: string, results: Record<string, 'success' | 'failure'>) {
  for (const [name, conclusion] of Object.entries(results))
    await fakeOf(t).simulateCheckRun({ repo: REPO, sha: head, name, conclusion });
}

/** The agent's run on a pull request, started from a turn in Mara's Chat, for `forId`'s account. */
async function assistantRun(prNumber: number, title: string, forId: string) {
  const [turn] = await t.services.db
    .insert(dispatches)
    .values({
      id: `dsp_${title.replace(/\W+/g, '-').slice(0, 20)}`,
      burrowId: t.burrowId,
      agentId: agent.agentId,
      trigger: 'dm',
      mode: 'reply',
      conversationId: agent.dmId,
      messageId: null,
      threadRootId: null,
      state: 'done',
      createdAt: new Date(),
      onBehalfOfAccountId: await accountOf(t.services, forId),
    })
    .returning();
  const started = await t.commit(agent.agentId, startRun, {
    conversationId: agent.dmId,
    title,
    repo: REPO,
    branch: 'ignored',
    prNumber,
    dispatchId: turn?.id,
    steps: [{ title: 'Change it', detail: '' }],
  });
  if (started.status !== 'ok') throw new Error(`start_run: ${started.status}`);
  await t.services.db
    .update(dispatches)
    .set({ state: 'done' })
    .where(and(eq(dispatches.runId, started.result.runId), eq(dispatches.state, 'queued')));
  return started.result.runId;
}

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

async function finish(head: string, results: Record<string, 'success' | 'failure'>) {
  await checks(head, results);
  await syncGitHub(t);
  await syncGitHub(t);
}

describe('the agent’s own pull request, asked in a person’s Chat', () => {
  it('its run’s round finishing wakes it on the run, in the person’s Chat, for them', async () => {
    const pr = await personPr('feat/dusty-run', 'Dusty’s run');
    const runId = await assistantRun(pr, 'fix the rounding', IDS.mara);
    const head = (await prRow(pr)).headSha;
    await finish(head, { lint: 'success', unit: 'failure' });
    const wake = (await wakes()).at(-1);
    expect(wake).toMatchObject({
      conversationId: agent.dmId,
      text: `The checks on [PR #${pr}](${URL(pr)}) failed (unit).`,
      mentions: [agent.agentId],
    });
    expect(await turnsFor(wake?.id ?? '')).toMatchObject([
      {
        agentId: agent.agentId,
        trigger: 'mention',
        mode: 'run',
        runId,
        state: 'queued',
        onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
      },
    ]);
  });

  it('its own pull request without a run: a failed check on the commit it pushed for Mara wakes it in her Chat', async () => {
    const branch = 'feat/dusty-alone';
    const head = sha('e');
    await t.services.github.recordPushGrant({
      burrowId: t.burrowId,
      repo: REPO,
      branch,
      agentId: agent.agentId,
      dispatchId: null,
      onBehalfOf: { text: 'Mara', principalId: IDS.mara },
      sha: head,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await fakeOf(t).simulatePush({
      repo: REPO,
      branch,
      commits: [{ sha: head, message: 'Alone', authorEmail: `${agent.handle}@agents.burrow-hq.whombat.com` }],
    });
    const opened = await t.commit(agent.agentId, openPr, { repo: REPO, branch, title: 'Alone' });
    if (opened.status !== 'ok') throw new Error(`open_pr: ${opened.status}`);
    await syncGitHub(t);
    await finish(head, { lint: 'success', unit: 'failure' });
    const wake = (await wakes()).at(-1);
    expect(wake).toMatchObject({ conversationId: agent.dmId, threadRootId: null, mentions: [agent.agentId] });
    expect(await turnsFor(wake?.id ?? '')).toMatchObject([
      {
        agentId: agent.agentId,
        trigger: 'mention',
        runId: null,
        conversationId: agent.dmId,
        onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
      },
    ]);
  });
});
