/**
 * A prompt's “Merge into main when it’s done” (prompts.md): once the T3 Code thread's job ended with a pull request,
 * Whombat merges it when its checks pass and says so in the person's thread; failed checks or no pull request leave a
 * line for the person instead. Postgres because the watch, Whombat's copy of GitHub and the message are commits; GitHub
 * is the in-memory FakeGitHub.
 */
import { T3ThreadUpdate } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { MERGE_WORDS } from '../automations/merge';
import { catalogConnections, messages, pullRequests, t3Watches } from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';
import { mergePromptJobs, PROMPT_MERGE_GRACE_MS, PROMPT_MERGE_WORDS } from './merge';

const w = useAutomationWorld();
const REPO = 'whombat/billing';
const CONNECTION = 'cnc_t3_prompt_merge';

beforeAll(async () => {
  await w.services.db.insert(catalogConnections).values({
    id: CONNECTION,
    burrowId: w.burrowId,
    catalogId: 't3code',
    label: 'thetitan',
    handle: 't3',
    transport: 'mcp',
    signIn: 'password',
    baseUrl: 'http://t3.invalid',
  });
});

function fake() {
  const f = w.services.github.fake;
  if (!f) throw new Error('no FakeGitHub');
  return f;
}

/** A pull request on GitHub with one check, and Whombat's copy of it. */
async function openPr(branch: string, check: 'success' | 'failure'): Promise<number> {
  await w.fakePush(REPO, branch);
  const number = await fake().simulateOpenPullRequest({
    repo: REPO,
    head: branch,
    title: `Do ${branch}`,
    login: 'mara',
  });
  const head = (await fake().getPullRequest(REPO, number)).headSha;
  await fake().simulateCheckRun({ repo: REPO, sha: head, name: 'check', conclusion: check });
  await w.services.github.poller.pollNow({ burrowId: w.burrowId });
  return number;
}

/** A prompt's job whose thread ended and was told, with its pull request when it opened one. */
async function endedJob(threadId: string, pr: number | null) {
  const at = w.now();
  await w.services.db.insert(t3Watches).values({
    burrowId: w.burrowId,
    connectionId: CONNECTION,
    threadId,
    title: 'Dusty - Find what’s broken',
    conversationId: IDS.dmDusty,
    threadRootId: null,
    agentId: IDS.dusty,
    personId: IDS.mara,
    state: 'idle',
    armedAt: at,
    status: 'completed',
    runStartedAt: at,
    runEndedAt: at,
    told: T3ThreadUpdate.parse({
      connection: 't3',
      threadId,
      title: 'Dusty - Find what’s broken',
      event: 'finished',
      status: 'completed',
      answer: null,
      requestId: null,
      questions: [],
      approval: null,
      url: null,
      at: at.toISOString(),
      reported: true,
    }),
    merge: { state: 'wanted' },
    progress: pr
      ? {
          pullRequest: {
            number: pr,
            url: `https://github.com/${REPO}/pull/${pr}`,
            state: 'open',
            repo: REPO,
          },
        }
      : {},
  });
}

const mergeOf = async (threadId: string) =>
  (await w.services.db.select().from(t3Watches).where(eq(t3Watches.threadId, threadId)))[0]?.merge;

const said = async (text: string) =>
  w.services.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, IDS.dmDusty),
        eq(messages.authorId, IDS.dusty),
        eq(messages.text, text),
      ),
    );

describe('a prompt’s work merged when it’s done', () => {
  it('merges the pull request once its checks pass, and says so in the thread', async () => {
    const number = await openPr('prompt/green', 'success');
    await endedJob('mcp:thread-green', number);
    await mergePromptJobs(w.services);

    expect(fake().merges).toContainEqual({ repo: REPO, number, method: 'merge' });
    expect(await mergeOf('mcp:thread-green')).toMatchObject({ state: 'merged' });
    const [row] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.number, number));
    expect(row?.state).toBe('merged');
    expect(await said(MERGE_WORDS.merged(number, 'main'))).toHaveLength(1);

    // Only once: the next pass leaves it alone.
    await mergePromptJobs(w.services);
    expect(fake().merges.filter((m) => m.number === number)).toHaveLength(1);
    expect(await said(MERGE_WORDS.merged(number, 'main'))).toHaveLength(1);
  });

  it('leaves a pull request whose checks failed for the person', async () => {
    const number = await openPr('prompt/red', 'failure');
    await endedJob('mcp:thread-red', number);
    await mergePromptJobs(w.services);

    expect(fake().merges.some((m) => m.number === number)).toBe(false);
    expect(await mergeOf('mcp:thread-red')).toMatchObject({ state: 'left' });
    expect(await said(MERGE_WORDS.checksFailed(number))).toHaveLength(1);
  });

  it('says there was nothing to merge when the job opened no pull request', async () => {
    await endedJob('mcp:thread-none', null);
    await mergePromptJobs(w.services);
    // The pull request may still show for a moment after the job ended.
    expect(await mergeOf('mcp:thread-none')).toMatchObject({ state: 'wanted' });

    w.advance(PROMPT_MERGE_GRACE_MS + 1_000);
    await mergePromptJobs(w.services);
    expect(await mergeOf('mcp:thread-none')).toMatchObject({ state: 'left' });
    expect(await said(PROMPT_MERGE_WORDS.nothing)).toHaveLength(1);
  });
});
