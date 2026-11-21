/**
 * The watcher crosses the real T3 connection and commits each phase to Postgres: focused source work becomes one
 * checked candidate, then a separate guarded merge. Independent GitHub evidence must hold across both runs.
 */
import { api, buildPath, DelegationCard, type DelegationVerification, newId } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startT3Code, type T3CodeStub } from '../connections/testing/t3code-stub';
import {
  catalogConnections,
  councils,
  delegations,
  delegationTasks,
  dispatches,
  messages,
  pullRequests,
  t3Watches,
  vaultNetworks,
} from '../db/schema/index';
import { GitHubError } from '../github/adapter';
import { IDS } from '../seed/test-world';
import { progressOf } from '../t3code/progress';
import { T3Watcher } from '../t3code/watch';
import { setConnectionKeys } from '../test/connections';
import { fakeOf } from '../test/github';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import * as t3Tools from '../things/kinds/business/t3code';
import { useVaultNetForTests } from '../vault/net';
import { delegationCard, numbersOf } from './card';
import {
  CHECKS_STUCK_NOTE,
  finishDelegation,
  loadTasks,
  MERGE_CLAIM_MS,
  offerDelegation,
  stopDelegation,
  stopTaskByPerson,
  updateDelegation,
} from './commands';
import { delegationContext } from './context';
import { sendToTasks, startReady } from './run';
import { inputFingerprint } from './verification';

const t = useTestServer({ seed: true, listen: true });
const db = () => t.services.db;
const pass = () => new T3Watcher(t.services).pass();
/** A pass once finished threads have been quiet long enough to be settled in T3 Code. */
const quietPass = () => new T3Watcher(t.services, { quietMs: 0 }).pass();
/** Whether Whombat settles the thread in T3 Code once it has been quiet (settling it at once would stop its commands). */
const settles = async (threadId: string) =>
  progressOf((await db().select().from(t3Watches).where(eq(t3Watches.threadId, threadId)))[0]?.progress)
    .settle !== null;
const root = 'msg_dm-mara-1402';
let t3: T3CodeStub;
let connectionId = '';

const launches = () => t3.calls.filter((call) => call.name === 't3_thread_launch');
const sends = () => t3.calls.filter((call) => call.name === 't3_thread_send');

async function finalOf(id: string) {
  const final = (await loadTasks(db(), id)).find((row) => row.kind === 'final');
  if (!final) throw new Error('Missing combined check');
  return final;
}

/** What Whombat merged goes to its thread to be put on DEV; that thread's end finishes the final row. */
async function putOnDev(f: { id: string; threadId: string }) {
  expect(await finalOf(f.id)).toMatchObject({ state: 'working', mergeState: 'merging' });
  const told = sends().at(-1);
  expect(told?.args.threadId).toBe(f.threadId);
  for (const fact of ['DEV', 'AGENTS.md', 'Never deploy to production'])
    expect(String(told?.args.message)).toContain(fact);
  t3.pullRequestsDone(f.threadId);
  t3.finish(f.threadId, 'Put it on DEV.\nNote: DEV runs the new version.');
  await pass();
}

const delegationOf = async (id: string) => {
  const [row] = await db().select().from(delegations).where(eq(delegations.id, id));
  if (!row) throw new Error('Missing delegation');
  return row;
};

async function sourceOf(id: string) {
  const source = (await loadTasks(db(), id)).find((row) => row.kind === 'task');
  if (!source?.threadId || !source.branch) throw new Error('Source task was not launched');
  return { ...source, threadId: source.threadId, branch: source.branch };
}

/** Finish ordinary work through T3, letting the real watcher claim and launch the combined candidate. */
async function candidate(required = ['ci/check'], watchSource = false) {
  const id = newId('delegation');
  const offered = await t.commit(IDS.dusty, offerDelegation, {
    id,
    conversationId: IDS.dmDusty,
    threadRootId: root,
    personId: IDS.mara,
    connectionId,
    project: { id: `batch-${id}`, title: 'Batch project', root: '/workspace/batch' },
    title: 'One checked delivery',
    intro: 'Making the changes together.',
    atOnce: 2,
    pullRequests: true,
    merge: true,
    tasks: [
      {
        title: 'Readable settings',
        brief: 'Make the settings names clear.',
        why: null,
        picked: true,
        after: null,
        provider: null,
        model: null,
        modelLabel: null,
      },
    ],
    start: true,
  });
  expect(offered.status).toBe('ok');
  expect(await startReady(t.services, id, t.burrowId)).toBe(1);
  expect(launches()).toHaveLength(1);
  expect(sends()).toHaveLength(0);
  const source = await sourceOf(id);
  const github = fakeOf(t);
  const repo = `batch/${id}`;
  const state = await github.addRepo({ fullName: repo });
  const base = state.branches.get('main');
  if (!base) throw new Error('Missing default branch');
  state.requiredChecks.set('main', required);
  const sourceNumber = await github.simulateOpenPullRequest({
    repo,
    head: source.branch,
    title: source.title,
    login: 'john',
  });
  const sourceHead = (await github.getPullRequest(repo, sourceNumber)).headSha;
  await github.simulateFiles({
    repo,
    sha: sourceHead,
    parent: base,
    files: { 'settings.txt': 'Readable names' },
  });
  const sourceUrl = `https://github.com/${repo}/pull/${sourceNumber}`;
  t3.linkPullRequest(source.threadId, sourceUrl);
  if (watchSource) t3.watchPullRequest(source.threadId, sourceUrl);
  t3.finish(source.threadId, 'Updated the names.\nNote: The settings are clearer.\nChecks: passing');
  await pass();
  expect(await sourceOf(id)).toMatchObject({ state: 'done', checks: 'passing', mergeState: 'waiting' });
  expect(await settles(source.threadId)).toBe(!watchSource);
  expect((await github.getPullRequest(repo, sourceNumber)).merged).toBe(false);
  expect(sends()).toHaveLength(0);
  const final = await finalOf(id);
  if (!final.threadId || !final.branch) throw new Error('The watcher did not launch the combined check');
  expect(final.state).toBe('working');
  expect(launches()).toHaveLength(2);
  const brief = String(launches().at(-1)?.args.message);
  expect(brief).toContain(sourceUrl);
  expect(brief).toContain(final.checkedInputs);
  expect(final.checkedInputs).toBe(inputFingerprint(await loadTasks(db(), id)));
  expect(brief).toContain(`"generation":${final.checkGeneration}`);
  const number = await github.simulateOpenPullRequest({
    repo,
    head: final.branch,
    title: 'Combined settings change',
    login: 'john',
  });
  const revision = (await github.getPullRequest(repo, number)).headSha;
  // This candidate includes the source commit, rather than a copy of its patch.
  await github.simulateFiles({
    repo,
    sha: revision,
    parent: sourceHead,
    files: { 'settings.txt': 'Readable names' },
  });
  await github.simulateCheckRun({ repo, sha: revision, name: 'ci/check', conclusion: 'success' });
  const url = `https://github.com/${repo}/pull/${number}`;
  const proof: DelegationVerification = {
    revision,
    base,
    inputs: final.checkedInputs as string,
    generation: final.checkGeneration,
    expected: ['ci/check'],
    results: [{ name: 'ci/check', revision, state: 'passing' }],
  };
  const threadId = final.threadId;
  t3.watchPullRequest(threadId, url);
  t3.finish(
    threadId,
    `Checked the candidate.\nNote: The combined checks passed.\nChecks: passing\nVerification: ${JSON.stringify(proof)}`,
  );
  return {
    id,
    github,
    repo,
    state,
    base,
    source,
    sourceNumber,
    sourceHead,
    number,
    url,
    revision,
    threadId,
    proof,
  };
}

beforeAll(async () => {
  t3 = await startT3Code();
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      if (host !== 't3.batch.test') throw new Error(`Unexpected host ${host}`);
      return [{ address: '192.168.96.10', family: 4 }];
    },
    dialAddress: (address) => (address === '192.168.96.10' ? '127.0.0.1' : address),
    deadlineMs: 5000,
  });
  await db()
    .insert(vaultNetworks)
    .values({
      id: 'vnw_batch_test',
      cidr: '192.168.96.0/24',
      ports: [t3.port],
      note: 'T3 Code batch stand-in',
      addedAt: t.services.clock(),
    });
  const { cookie } = await sessionFor(t.services, IDS.mara);
  await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'can' });
  const ep = api.connections.create;
  const connected = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
    headers: { cookie },
    payload: {
      catalogId: 't3code',
      signIn: 'password',
      fields: { url: `http://t3.batch.test:${t3.port}` },
      login: { password: t3.pairingCode() },
      access: 'manage',
    },
  });
  expect(connected.statusCode).toBe(201);
  const [connection] = await db()
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.catalogId, 't3code'));
  if (!connection) throw new Error('Missing T3 connection');
  connectionId = connection.id;
});

beforeEach(async () => {
  // Each case owns this database and starts with no remaining watched task from another scenario.
  await db().delete(t3Watches);
  await db().delete(delegations);
  t3.calls.length = 0;
  t3.threads.clear();
});

afterAll(async () => {
  await t3?.close();
});

afterEach(() => vi.restoreAllMocks());

describe('the checked combined candidate across T3 watcher runs', () => {
  it('retains a completed review and retries only independent verification after a GitHub outage', async () => {
    const f = await candidate();
    const initial = await finalOf(f.id);
    let now = t.services.clock();
    vi.spyOn(t.services, 'clock').mockImplementation(() => now);
    const policy = vi
      .spyOn(f.github, 'requiredStatusChecks')
      .mockRejectedValue(new GitHubError('Resource not accessible by integration', 403));
    await db().update(dispatches).set({ state: 'done' }).where(eq(dispatches.state, 'queued'));
    const wakes = async () =>
      (
        await db()
          .select()
          .from(dispatches)
          .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.trigger, 'delegation')))
      ).length;
    const before = await wakes();
    await pass();
    const held = await finalOf(f.id);
    expect(held).toMatchObject({
      state: 'working',
      checks: 'running',
      pr: f.url,
      attempt: initial.attempt,
      checkGeneration: initial.checkGeneration,
    });
    expect(held.answer).toContain(JSON.stringify(f.proof));
    expect(held.note).toContain('Resource not accessible by integration');
    const [d] = await db().select().from(delegations).where(eq(delegations.id, f.id));
    const watches = await db().select().from(t3Watches);
    expect(d && delegationCard(d, await loadTasks(db(), f.id), watches).tasks.at(-1)?.step).toBe(
      'Waiting for GitHub verification',
    );
    expect(await wakes()).toBe(before + 1);
    expect(sends()).toHaveLength(0);
    await pass();
    expect(policy).toHaveBeenCalledTimes(1);
    await db().update(dispatches).set({ state: 'done' }).where(eq(dispatches.state, 'queued'));
    now = new Date(now.getTime() + 16_000);
    await pass();
    expect(policy).toHaveBeenCalledTimes(2);
    expect(await wakes()).toBe(before + 1);
    policy.mockRestore();
    now = new Date(now.getTime() + 31_000);
    await pass();
    // Confirmed at last: Whombat merges the same checked candidate, without a new review, and it goes to DEV.
    expect(launches()).toHaveLength(2);
    await putOnDev(f);
    expect(await finalOf(f.id)).toMatchObject({
      mergeState: 'merged',
      checks: 'passing',
      attempt: initial.attempt,
      checkedRevision: f.revision,
    });
    expect((await finalOf(f.id)).note).not.toContain('blocked');
  });

  it('also preserves the checked candidate if GitHub becomes unavailable just before merging', async () => {
    const f = await candidate();
    const original = f.github.requiredStatusChecks.bind(f.github);
    vi.spyOn(f.github, 'requiredStatusChecks')
      .mockImplementation(original)
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new GitHubError('GitHub is temporarily unavailable', 503));
    await pass();
    expect(await finalOf(f.id)).toMatchObject({
      state: 'working',
      checks: 'running',
      pr: f.url,
      checkedRevision: f.revision,
    });
    expect(sends()).toHaveLength(0);
    await pass();
    expect(launches()).toHaveLength(2);
    await putOnDev(f);
    expect(await finalOf(f.id)).toMatchObject({ mergeState: 'merged', checkedRevision: f.revision });
  });

  it('still rejects stale evidence when the base moves during a verification outage', async () => {
    const f = await candidate();
    const now = t.services.clock();
    const policy = vi
      .spyOn(f.github, 'requiredStatusChecks')
      .mockRejectedValue(new GitHubError('Service unavailable', 503));
    await pass();
    policy.mockRestore();
    await f.github.simulateCommitOn({ repo: f.repo, branch: 'main' });
    vi.spyOn(t.services, 'clock').mockReturnValue(new Date(now.getTime() + 16_000));
    t3.pullRequestsDone(f.threadId);
    await pass();
    expect(await finalOf(f.id)).toMatchObject({
      state: 'failed',
      checks: 'failing',
      mergeState: 'not_merged',
    });
    expect((await finalOf(f.id)).note).toContain('base changed');
    expect(sends()).toHaveLength(0);
  });

  it('cleans up historical grouped work when its list ends, without claiming an incomplete delivery is done', async () => {
    const f = await candidate();
    const source = t3.threads.get(f.source.threadId);
    if (!source) throw new Error('Missing source thread');
    source.settled = false;
    // Reproduce an idle source watch kept by the old batch merge path, with several tasks sharing its thread.
    await db()
      .insert(delegationTasks)
      .values({
        ...f.source,
        id: newId('delegationTask'),
        position: 2,
        state: 'done',
        checks: 'passing',
        mergeState: 'waiting',
      });
    await db()
      .update(t3Watches)
      .set({ state: 'idle', checkedAt: new Date(t.services.clock().getTime() - 1000) })
      .where(eq(t3Watches.threadId, f.source.threadId));
    t3.pullRequestsDone(f.threadId);
    t3.finish(f.threadId, 'The combined check needs a fix.\nChecks: failing');
    await pass();
    await t.commit(IDS.dusty, finishDelegation, {
      delegationId: f.id,
      summary: 'The work is written; its final check did not pass.',
      stopped: false,
    });
    const [ended] = await db().select().from(delegations).where(eq(delegations.id, f.id));
    expect(ended).toMatchObject({
      stage: 'done',
      outcome: 'incomplete',
      note: 'Some work is still incomplete.',
    });
    // Reproduce a list already ended on the old release, including its misleading default status.
    await db().update(delegations).set({ note: 'Done.' }).where(eq(delegations.id, f.id));
    await db()
      .update(t3Watches)
      .set({ state: 'idle', checkedAt: new Date((ended?.endedAt?.getTime() ?? 0) - 1000) })
      .where(eq(t3Watches.threadId, source.id));
    const before = t3.calls.filter(
      (call) => call.name === 't3_thread_organize' && call.args.threadId === f.source.threadId,
    ).length;
    await pass();
    await quietPass();
    expect(source.settled).toBe(true);
    expect((await db().select().from(delegations).where(eq(delegations.id, f.id)))[0]?.note).toBe(
      'Some work is still incomplete.',
    );
    expect(
      t3.calls.filter(
        (call) => call.name === 't3_thread_organize' && call.args.threadId === f.source.threadId,
      ),
    ).toHaveLength(before + 1);
    await quietPass();
    expect(
      t3.calls.filter(
        (call) => call.name === 't3_thread_organize' && call.args.threadId === f.source.threadId,
      ),
    ).toHaveLength(before + 1);
  });

  it('keeps completed source threads active while T3 still watches their pull requests', async () => {
    const f = await candidate(undefined, true);
    const source = t3.threads.get(f.source.threadId);
    if (!source) throw new Error('Missing source thread');
    await pass();
    expect(source.settled).toBe(false);
    expect((await sourceOf(f.id)).state).toBe('done');
    t3.pullRequestsDone(source.id);
    await pass();
    await quietPass();
    expect(source.settled).toBe(true);
  });

  it('does not mistake an unreadable pull-request watch list for an unwatched thread', async () => {
    const f = await candidate();
    const original = t3Tools.callT3;
    const calls = vi.spyOn(t3Tools, 'callT3').mockImplementation(async (...args) => {
      if (args[2] === 'list_thread_pull_requests')
        throw new t3Tools.T3Failure('orchestration_error', 'Temporarily unavailable');
      return original(...args);
    });
    await pass();
    expect(await finalOf(f.id)).toMatchObject({ state: 'working' });
    expect(t3.threads.get(f.threadId)?.settled).toBe(false);
    expect(sends()).toHaveLength(0);
    calls.mockRestore();
    await pass();
    await putOnDev(f);
    expect(await finalOf(f.id)).toMatchObject({ state: 'done', mergeState: 'merged' });
    expect(sends()).toHaveLength(1);
  });

  it('retries a refused settlement after rechecking the completed source thread', async () => {
    const f = await candidate();
    const source = t3.threads.get(f.source.threadId);
    if (!source) throw new Error('Missing source thread');
    source.settled = false;
    await db()
      .update(t3Watches)
      .set({ state: 'watching', wakes: false })
      .where(eq(t3Watches.threadId, source.id));
    const original = t3Tools.callT3;
    const calls = vi.spyOn(t3Tools, 'callT3').mockImplementation(async (...args) => {
      if (args[2] === 't3_thread_organize' && args[3].threadId === source.id)
        throw new t3Tools.T3Failure('orchestration_error', 'Temporarily unavailable');
      return original(...args);
    });
    await pass();
    await quietPass();
    expect(source.settled).toBe(false);
    expect(await settles(source.id)).toBe(true);
    calls.mockRestore();
    await quietPass();
    expect(source.settled).toBe(true);
    expect(await settles(source.id)).toBe(false);
  });

  it.each(['running', 'completed'])(
    'does not settle %s work resumed after its delegation ended',
    async (status) => {
      const f = await candidate();
      t3.pullRequestsDone(f.threadId);
      t3.finish(f.threadId, 'The combined check needs a fix.\nChecks: failing');
      await pass();
      await t.commit(IDS.dusty, finishDelegation, {
        delegationId: f.id,
        summary: 'The final check needs a fix.',
        stopped: false,
      });
      const [ended] = await db().select().from(delegations).where(eq(delegations.id, f.id));
      const source = t3.threads.get(f.source.threadId);
      if (!source || !ended?.endedAt) throw new Error('Missing ended work');
      source.settled = false;
      source.status = status;
      source.startedAt = new Date(ended.endedAt.getTime() + 1000).toISOString();
      await pass();
      expect(source.settled).toBe(false);
      expect((await db().select().from(t3Watches).where(eq(t3Watches.threadId, source.id)))[0]?.state).toBe(
        'idle',
      );
    },
  );
  it('checks source ancestry and the exact candidate, merges that commit itself, then completes', async () => {
    const f = await candidate();
    const checkedTree = await f.github.commitTree(f.repo, f.revision);
    expect(checkedTree).toBeTruthy();
    await pass();
    // Whombat merged the checked candidate on GitHub, with a merge commit, only at the checked head: no thread merges.
    expect(f.github.merges.at(-1)).toMatchObject({ repo: f.repo, number: f.number, method: 'merge' });
    const merged = await f.github.getPullRequest(f.repo, f.number);
    expect(merged.merged).toBe(true);
    expect(await f.github.commitTree(f.repo, merged.mergeCommitSha as string)).toBe(checkedTree);
    // Its thread is told only to put it on DEV, and its end finishes it.
    await putOnDev(f);
    expect(await finalOf(f.id)).toMatchObject({
      state: 'done',
      checks: 'passing',
      mergeState: 'merged',
      checkedRevision: f.revision,
      checkedBase: f.base,
    });
    expect((await sourceOf(f.id)).mergeState).toBe('merged');
    const finished = await t.commit(IDS.dusty, finishDelegation, {
      delegationId: f.id,
      summary: 'The settings changes are checked and merged.',
      stopped: false,
    });
    expect(finished.status).toBe('ok');
    const [done] = await db().select().from(delegations).where(eq(delegations.id, f.id));
    expect(done).toMatchObject({ stage: 'done', outcome: 'done' });
  });

  it('merges nothing when the candidate or its base moved after its check, and checks again', async () => {
    const f = await candidate();
    // Someone pushed to main after the combined check; GitHub's merge would combine untested work.
    const moved = await f.github.simulateOpenPullRequest({
      repo: f.repo,
      head: 'other',
      title: 'Other',
      login: 'john',
    });
    await f.github.simulateClose({ repo: f.repo, number: moved, login: 'john', merged: true });
    await pass();
    expect((await f.github.getPullRequest(f.repo, f.number)).merged).toBe(false);
    // Its check no longer covers main as it is: a fresh combined check takes its place.
    expect(await finalOf(f.id)).toMatchObject({ mergeState: null, checkedRevision: null });
  });

  it('leaves the candidate open and says why when GitHub refuses the merge', async () => {
    const f = await candidate();
    await db().update(dispatches).set({ state: 'done' }).where(eq(dispatches.state, 'queued'));
    f.github.failNextMerge = new GitHubError('Merge commits are not allowed on this repository.', 405);
    await pass();
    expect((await f.github.getPullRequest(f.repo, f.number)).merged).toBe(false);
    const final = await finalOf(f.id);
    expect(final).toMatchObject({ state: 'done', mergeState: 'not_merged', checks: 'passing' });
    expect(final.note).toContain('Merge commits are not allowed');
    expect(final.dispatchId).toBeTruthy();
    expect(sends()).toHaveLength(0);
    // Once the person resolved it, trying again merges the same checked candidate, its review kept.
    const again = await t.commit(IDS.dusty, updateDelegation, {
      delegationId: f.id,
      note: null,
      title: null,
      atOnce: null,
      pullRequests: null,
      add: [],
      change: [],
      remove: [],
      order: [],
      start: false,
      stop: [],
      retry: [2],
      send: [],
    });
    expect(again.status).toBe('ok');
    await pass();
    expect((await f.github.getPullRequest(f.repo, f.number)).merged).toBe(true);
    await putOnDev(f);
    expect(await finalOf(f.id)).toMatchObject({
      state: 'done',
      mergeState: 'merged',
      checkedRevision: final.checkedRevision,
      attempt: final.attempt,
    });
  });

  it('reads whether it merged when GitHub’s answer to the merge was lost, holding changes back meanwhile', async () => {
    const f = await candidate();
    let now = t.services.clock();
    vi.spyOn(t.services, 'clock').mockImplementation(() => now);
    f.github.failNextMerge = new GitHubError('Bad gateway', 502);
    await pass();
    expect(await finalOf(f.id)).toMatchObject({ state: 'done', mergeState: 'waiting' });
    expect((await finalOf(f.id)).mergeClaimedAt).toBeTruthy();
    // It may have merged: a change that would replace its check waits, and nothing merges it twice.
    const held = await t
      .commit(IDS.dusty, updateDelegation, {
        delegationId: f.id,
        note: null,
        title: null,
        atOnce: null,
        pullRequests: null,
        add: [],
        change: [],
        remove: [],
        order: [],
        start: false,
        stop: [],
        retry: [1],
        send: [],
      })
      .catch((err: unknown) => ({ status: 'refused', err }));
    expect(held.status).not.toBe('ok');
    await pass();
    expect(f.github.merges.filter((m) => m.repo === f.repo && m.number === f.number)).toHaveLength(0);
    // GitHub says it didn't: once the claim runs out it is merged.
    now = new Date(now.getTime() + MERGE_CLAIM_MS + 1000);
    await pass();
    await putOnDev(f);
    expect(await finalOf(f.id)).toMatchObject({ state: 'done', mergeState: 'merged' });
    expect(f.github.merges.filter((m) => m.repo === f.repo && m.number === f.number)).toHaveLength(1);
  });

  it.each(['while GitHub is read', 'right before Whombat merges'])(
    'records a candidate someone merged at its checked head %s, without checking it again',
    async (when) => {
      const f = await candidate();
      const merge = vi.spyOn(f.github, 'mergePullRequest');
      const close = () =>
        f.github.simulateClose({ repo: f.repo, number: f.number, login: 'john', merged: true });
      if (when === 'while GitHub is read') {
        const original = f.github.requiredStatusChecks.bind(f.github);
        vi.spyOn(f.github, 'requiredStatusChecks').mockImplementationOnce(async (...args) => {
          await close();
          return original(...args);
        });
      } else {
        const commit = t.services.pipeline.commit.bind(t.services.pipeline);
        vi.spyOn(t.services.pipeline, 'commit').mockImplementation(async (command, input, options) => {
          const res = await commit(command, input, options);
          if (typeof command !== 'string' && command.name === 'delegation.claim_final_merge') await close();
          return res;
        });
      }
      await pass();
      await pass();
      expect(merge).not.toHaveBeenCalled();
      // Merged under Whombat's own claim: its thread puts it on DEV as for Whombat's own merge.
      if (when === 'right before Whombat merges') await putOnDev(f);
      expect(await finalOf(f.id)).toMatchObject({
        state: 'done',
        mergeState: 'merged',
        checkedRevision: f.revision,
      });
    },
  );

  it('merges nothing that a change replaced while GitHub was being read', async () => {
    const f = await candidate();
    const merge = vi.spyOn(f.github, 'mergePullRequest');
    const original = f.github.requiredStatusChecks.bind(f.github);
    let once = false;
    vi.spyOn(f.github, 'requiredStatusChecks').mockImplementation(async (...args) => {
      // While Whombat reads GitHub, the agent changes a task: the checked candidate no longer covers the list.
      if (!once) {
        once = true;
        const changed = await t.commit(IDS.dusty, updateDelegation, {
          delegationId: f.id,
          note: null,
          title: null,
          atOnce: null,
          pullRequests: null,
          add: [],
          change: [],
          remove: [],
          order: [],
          start: false,
          stop: [],
          retry: [1],
          send: [],
        });
        expect(changed.status).toBe('ok');
      }
      return original(...args);
    });
    await pass();
    expect(merge).not.toHaveBeenCalled();
    expect((await f.github.getPullRequest(f.repo, f.number)).merged).toBe(false);
    expect((await finalOf(f.id)).checkedRevision).toBeNull();
  });

  it('keeps its row at work while its thread puts what Whombat merged live, and its end finishes it', async () => {
    const f = await candidate();
    await pass();
    expect((await f.github.getPullRequest(f.repo, f.number)).merged).toBe(true);
    // At work while it deploys: Stop and the list's end see it; its claim says Whombat merged it.
    expect(await finalOf(f.id)).toMatchObject({ state: 'working', mergeState: 'merging' });
    expect((await finalOf(f.id)).mergeClaimedAt).toBeTruthy();
    expect(sends()).toHaveLength(1);
    const told = String(sends()[0]?.args.message);
    expect(sends()[0]?.args.threadId).toBe(f.threadId);
    for (const fact of ['AGENTS.md', 'DEV', f.revision, 'Don’t merge', 'Note:']) expect(told).toContain(fact);
    t3.pullRequestsDone(f.threadId);
    t3.finish(f.threadId, 'The release went out.\nNote: DEV runs the new version.');
    await pass();
    expect(await finalOf(f.id)).toMatchObject({
      state: 'done',
      mergeState: 'merged',
      note: 'DEV runs the new version.',
    });
    expect((await sourceOf(f.id)).mergeState).toBe('merged');
  });

  it('stops the thread putting what Whombat merged live on the person’s Stop, and the work stays merged', async () => {
    const f = await candidate();
    await pass();
    expect(await finalOf(f.id)).toMatchObject({ state: 'working', mergeState: 'merging' });
    const stopped = await t.commit(IDS.mara, stopDelegation, { delegationId: f.id });
    expect(stopped.status).toBe('ok');
    if (stopped.status === 'ok') expect(stopped.result.working.map((r) => r.threadId)).toContain(f.threadId);
    expect((await delegationOf(f.id)).stage).toBe('stopped');
    expect(await finalOf(f.id)).toMatchObject({ state: 'done', mergeState: 'merged', checks: 'passing' });
    expect((await finalOf(f.id)).note).toContain('stopped');
    expect((await sourceOf(f.id)).mergeState).toBe('merged');
  });

  it.each(['failed', 'gone'])('keeps what Whombat merged merged when its deploy thread %s', async (how) => {
    const f = await candidate();
    await pass();
    expect(await finalOf(f.id)).toMatchObject({ state: 'working', mergeState: 'merging' });
    t3.pullRequestsDone(f.threadId);
    if (how === 'failed') t3.finish(f.threadId, null, 'failed');
    else t3.threads.delete(f.threadId);
    await pass();
    expect(await finalOf(f.id)).toMatchObject({ state: 'done', mergeState: 'merged', checks: 'passing' });
    expect((await finalOf(f.id)).note).toContain('It is merged');
    expect((await sourceOf(f.id)).mergeState).toBe('merged');
    // A combined check is never started again for work already on main.
    expect((await finalOf(f.id)).checkedRevision).toBe(f.revision);
  });

  it('holds a Stop back for a moment while Whombat merges the candidate on GitHub', async () => {
    const f = await candidate();
    const commit = t.services.pipeline.commit.bind(t.services.pipeline);
    let refused: unknown = null;
    vi.spyOn(t.services.pipeline, 'commit').mockImplementation(async (command, input, options) => {
      const res = await commit(command, input, options);
      if (typeof command !== 'string' && command.name === 'delegation.claim_final_merge')
        refused = await commit(
          stopDelegation,
          { delegationId: f.id },
          { burrowId: t.burrowId, actorId: IDS.mara },
        )
          .then((r) => r.status)
          .catch(() => 'refused');
      return res;
    });
    await pass();
    expect(refused).not.toBe('ok');
    // Merged: its thread puts it on DEV now, and the list goes on.
    expect(await finalOf(f.id)).toMatchObject({ state: 'working', mergeState: 'merging' });
    expect((await delegationOf(f.id)).stage).toBe('working');
  });

  const update = (delegationId: string, over: Record<string, unknown>) =>
    t
      .commit(IDS.dusty, updateDelegation, {
        delegationId,
        note: null,
        title: null,
        atOnce: null,
        pullRequests: null,
        add: [],
        change: [],
        remove: [],
        order: [],
        start: false,
        stop: [],
        retry: [],
        send: [],
        ...over,
      })
      .catch((err: unknown) => ({ status: 'refused' as const, err }));

  it('keeps what Whombat merged while it is put live: the list waits, and the agent’s stop keeps it merged', async () => {
    const f = await candidate();
    await pass();
    expect(await finalOf(f.id)).toMatchObject({ state: 'working', mergeState: 'merging' });
    // More work, or a source kept open or stopped, waits until it is live.
    const more = {
      title: 'One more',
      brief: 'Fix the footer.',
      why: null,
      picked: true,
      after: null,
      provider: null,
      model: null,
      modelLabel: null,
    };
    expect((await update(f.id, { add: [more] })).status).not.toBe('ok');
    const source = await sourceOf(f.id);
    const byPerson = await t
      .commit(IDS.mara, stopTaskByPerson, { delegationId: f.id, taskId: source.id })
      .catch((err: unknown) => ({ status: 'refused' as const, err }));
    expect(byPerson.status).not.toBe('ok');
    expect(await finalOf(f.id)).toMatchObject({ state: 'working', mergeState: 'merging' });
    // Stopping the putting live itself keeps it merged, and no combined check starts again.
    expect((await update(f.id, { stop: [2] })).status).toBe('ok');
    expect(await finalOf(f.id)).toMatchObject({
      state: 'done',
      mergeState: 'merged',
      checks: 'passing',
      checkedRevision: f.revision,
    });
    expect((await sourceOf(f.id)).mergeState).toBe('merged');
    await pass();
    expect((await finalOf(f.id)).state).toBe('done');
  });

  it.each([
    ['its run failed', null, 'failed'],
    [
      'its run ended saying it isn’t live',
      'The release failed.\nNote: It isn’t live: the release failed.',
      undefined,
    ],
  ] as const)('puts what Whombat merged live again when tried again after %s', async (_, answer, status) => {
    const f = await candidate();
    await pass();
    t3.pullRequestsDone(f.threadId);
    t3.finish(f.threadId, answer, status);
    await pass();
    expect(await finalOf(f.id)).toMatchObject({ state: 'done', mergeState: 'merged' });
    // More work for its thread would check merged work again: it is refused.
    const before = sends().length;
    const sent = await update(f.id, { send: [{ n: 2, message: 'Try the release again.' }] });
    expect(sent.status).toBe('ok');
    expect(sends().length).toBe(before);
    expect(await finalOf(f.id)).toMatchObject({
      state: 'done',
      mergeState: 'merged',
      checkedRevision: f.revision,
    });
    // Trying it again puts it live again, with the repository's deploy step.
    const again = await update(f.id, { retry: [2] });
    expect(again.status).toBe('ok');
    if (again.status === 'ok') await sendToTasks(t.services, again.result.delegation, again.result.send);
    expect(sends().length).toBe(before + 1);
    const told = String(sends().at(-1)?.args.message);
    for (const fact of ['AGENTS.md', 'Don’t merge', f.revision]) expect(told).toContain(fact);
    expect(await finalOf(f.id)).toMatchObject({ state: 'working', mergeState: 'merging' });
    t3.finish(f.threadId, 'Released again.\nNote: DEV runs the new version.');
    await pass();
    expect(await finalOf(f.id)).toMatchObject({
      state: 'done',
      mergeState: 'merged',
      note: 'DEV runs the new version.',
      checkedRevision: f.revision,
    });
    // Merged once: nothing was merged or checked again.
    expect(f.github.merges.filter((m) => m.repo === f.repo && m.number === f.number)).toHaveLength(1);
  });

  it('finishes what Whombat merged when a restart cut off its deploy hand-on', async () => {
    const f = await candidate();
    const original = t3Tools.callT3;
    vi.spyOn(t3Tools, 'callT3').mockImplementation(async (...args) => {
      if (args[2] === 't3_thread_send')
        throw new t3Tools.T3Failure('orchestration_error', 'Gone for a moment');
      return original(...args);
    });
    await pass();
    // Its thread couldn't be given the deploy: what was merged is still recorded as merged.
    expect((await f.github.getPullRequest(f.repo, f.number)).merged).toBe(true);
    expect(await finalOf(f.id)).toMatchObject({ state: 'done', mergeState: 'merged' });
  });

  it('ends a council’s checklist that a restart left working after the council ended', async () => {
    const f = await candidate();
    const councilId = newId('council');
    const now = t.services.clock();
    await db().insert(councils).values({
      id: councilId,
      burrowId: t.burrowId,
      conversationId: IDS.dmDusty,
      threadRootId: root,
      agentId: IDS.dusty,
      personId: IDS.mara,
      connectionId,
      kind: 'improve',
      seats: [],
      title: 'Improve it',
      question: 'Improve it.',
      stage: 'build',
      roundsMax: 3,
      state: 'stopped',
      createdAt: now,
      updatedAt: now,
    });
    await db().update(delegations).set({ councilId }).where(eq(delegations.id, f.id));
    await pass();
    expect((await delegationOf(f.id)).stage).toBe('stopped');
    expect((await f.github.getPullRequest(f.repo, f.number)).merged).toBe(false);
    const interrupted = t3.calls.filter((c) => c.name === 't3_thread_interrupt').map((c) => c.args.threadId);
    expect(interrupted).toContain(f.threadId);
  });

  it('keeps the final row working while an independently required check has not reported', async () => {
    const f = await candidate(['ci/check', 'ci/package']);
    await pass();
    await pass();
    expect(await finalOf(f.id)).toMatchObject({ state: 'working', checks: 'running', pr: f.url });
    expect((await sourceOf(f.id)).mergeState).toBe('waiting');
    expect(sends()).toHaveLength(0);
    expect(f.state.branches.get('main')).toBe(f.base);
    expect((await f.github.getPullRequest(f.repo, f.number)).merged).toBe(false);
    expect(t3.threads.get(f.threadId)?.settled).toBe(false);
    // A later GitHub result resumes verification even when T3 has not made another run or changed its answer.
    await f.github.simulateCheckRun({
      repo: f.repo,
      sha: f.revision,
      name: 'ci/package',
      conclusion: 'success',
    });
    await pass();
    await putOnDev(f);
    expect((await finalOf(f.id)).mergeState).toBe('merged');
  });

  it('carries on with its open candidate when the combined check is tried again on the same work', async () => {
    const f = await candidate(['ci/check', 'ci/package']);
    await pass();
    await pass();
    const before = await finalOf(f.id);
    expect(before).toMatchObject({ state: 'working', pr: f.url });
    // It combines two pull requests (one checklist row whose work went to a second thread), and gave up while a check
    // was still out; nothing in the work changed since, and its candidate is still open.
    await db()
      .insert(delegationTasks)
      .values({
        id: newId('delegationTask'),
        delegationId: f.id,
        burrowId: t.burrowId,
        position: -1,
        title: 'Clear help text',
        brief: 'Explain each setting.',
        picked: true,
        state: 'done',
        attempt: 1,
        branch: 'delegate/clear-help-text',
        pr: `https://github.com/${f.repo}/pull/77`,
        checks: 'passing',
        mergeState: 'waiting',
        createdAt: t.services.clock(),
      });
    await db()
      .update(delegationTasks)
      .set({
        state: 'failed',
        endedAt: t.services.clock(),
        checkedInputs: inputFingerprint(await loadTasks(db(), f.id)),
      })
      .where(eq(delegationTasks.id, before.id));
    await db().update(t3Watches).set({ state: 'idle' }).where(eq(t3Watches.threadId, f.threadId));
    await db()
      .insert(pullRequests)
      .values({
        id: newId('pullRequest'),
        burrowId: t.burrowId,
        repoId: 'rep_billing',
        number: f.number,
        branch: before.branch as string,
        title: 'Combined settings change',
        state: 'open',
        headSha: f.revision,
        conversationId: IDS.dmDusty,
        openedAt: t.services.clock(),
        url: f.url,
      });
    const retried = await t.commit(IDS.dusty, updateDelegation, {
      delegationId: f.id,
      note: null,
      title: null,
      atOnce: null,
      pullRequests: null,
      add: [],
      change: [],
      remove: [],
      order: [],
      start: false,
      stop: [],
      retry: [numbersOf(await loadTasks(db(), f.id)).get(before.id) as number],
      send: [],
    });
    expect(retried.status).toBe('ok');
    expect(await startReady(t.services, f.id, t.burrowId)).toBe(1);
    const again = await finalOf(f.id);
    expect(again).toMatchObject({
      state: 'working',
      attempt: before.attempt + 1,
      branch: before.branch,
      pr: f.url,
    });
    const brief = String(launches().at(-1)?.args.message);
    expect(brief).toContain(f.url);
    expect(brief).toContain(`origin/${before.branch}`);
  });

  it('tells the agent once when a check waits in the CI queue too long, and takes the line away once it runs', async () => {
    const f = await candidate(['ci/check', 'ci/package']);
    const wakes = async () =>
      (
        await db()
          .select()
          .from(dispatches)
          .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.trigger, 'delegation')))
      ).length;
    // A queued turn takes later wakes into it: start from none queued.
    await db().update(dispatches).set({ state: 'done' }).where(eq(dispatches.state, 'queued'));
    const before = await wakes();
    // Our CI took it 40 minutes ago and hasn't started it.
    const queuedAt = new Date(t.services.clock().getTime() - 40 * 60_000).toISOString();
    f.state.statuses.set(f.revision, [
      ...(f.state.statuses.get(f.revision) ?? []),
      {
        id: 9001,
        context: 'ci/package',
        state: 'pending',
        description: 'Waiting in the CI queue',
        createdAt: queuedAt,
        updatedAt: queuedAt,
        url: null,
      },
    ]);
    await pass();
    await pass();
    expect(await finalOf(f.id)).toMatchObject({
      state: 'working',
      checks: 'running',
      note: CHECKS_STUCK_NOTE,
    });
    expect(await wakes()).toBe(before + 1);
    // Its turn is over; the same wait doesn't wake it again.
    await db().update(dispatches).set({ state: 'done' }).where(eq(dispatches.state, 'queued'));
    await pass();
    expect(await wakes()).toBe(before + 1);
    // It starts after all: running checks tell nobody, and the row's line about the wait goes.
    f.state.statuses.set(f.revision, [
      ...(f.state.statuses.get(f.revision) ?? []).filter((x) => x.id !== 9001),
      {
        id: 9002,
        context: 'ci/package',
        state: 'pending',
        description: 'Shared CI verification.',
        createdAt: new Date().toISOString(),
        updatedAt: null,
        url: null,
      },
    ]);
    await pass();
    expect((await finalOf(f.id)).note).toBeNull();
    expect(await wakes()).toBe(before + 1);
  });
});

describe('one thread leading the list', () => {
  it('checks the one pull request itself, without a copy of it, then merges it', async () => {
    const id = newId('delegation');
    const offered = await t.commit(IDS.dusty, offerDelegation, {
      id,
      conversationId: IDS.dmDusty,
      threadRootId: root,
      personId: IDS.mara,
      connectionId,
      project: { id: `single-${id}`, title: 'Single project', root: '/workspace/single' },
      title: 'One pull request',
      intro: 'Handing it over.',
      atOnce: 2,
      pullRequests: true,
      merge: true,
      tasks: [
        {
          title: 'Readable settings',
          brief: 'Make the settings names clear.',
          why: null,
          picked: true,
          after: null,
          provider: null,
          model: null,
          modelLabel: null,
        },
      ],
      start: true,
    });
    expect(offered.status).toBe('ok');
    expect(await startReady(t.services, id, t.burrowId)).toBe(1);
    const source = await sourceOf(id);
    const github = fakeOf(t);
    const repo = `single/${id}`;
    const state = await github.addRepo({ fullName: repo });
    const base = state.branches.get('main');
    if (!base) throw new Error('Missing default branch');
    state.requiredChecks.set('main', ['ci/check']);
    const number = await github.simulateOpenPullRequest({
      repo,
      head: source.branch,
      title: source.title,
      login: 'john',
    });
    const head = (await github.getPullRequest(repo, number)).headSha;
    await github.simulateFiles({
      repo,
      sha: head,
      parent: base,
      files: { 'settings.txt': 'Readable names' },
    });
    const url = `https://github.com/${repo}/pull/${number}`;
    t3.linkPullRequest(source.threadId, url);
    t3.finish(source.threadId, 'Updated the names.\nNote: The settings are clearer.\nChecks: passing');
    await pass();

    // The final check is given that pull request, not a branch to copy it onto.
    const final = await finalOf(id);
    expect(final).toMatchObject({ state: 'working', pr: url });
    const brief = String(launches().at(-1)?.args.message);
    expect(brief).toContain(url);
    expect(brief).toContain(`origin/${source.branch}`);
    expect(brief).toMatch(/don’t open another/);
    if (!final.threadId) throw new Error('The final check did not start');

    // It checks the pull request's own head and watches it.
    await github.simulateCheckRun({ repo, sha: head, name: 'ci/check', conclusion: 'success' });
    const proof: DelegationVerification = {
      revision: head,
      base,
      inputs: final.checkedInputs as string,
      generation: final.checkGeneration,
      expected: ['ci/check'],
      results: [{ name: 'ci/check', revision: head, state: 'passing' }],
    };
    t3.watchPullRequest(final.threadId, url);
    t3.finish(
      final.threadId,
      `Checked it.\nNote: Its checks passed.\nChecks: passing\nVerification: ${JSON.stringify(proof)}`,
    );
    await pass();
    // Whombat merges the one checked pull request itself: both rows merged, no third thread or second pull request.
    expect(github.merges.at(-1)).toMatchObject({ repo, number, method: 'merge' });
    await putOnDev({ id, threadId: final.threadId });
    expect(await finalOf(id)).toMatchObject({ state: 'done', mergeState: 'merged', checkedRevision: head });
    expect((await sourceOf(id)).mergeState).toBe('merged');
    expect(launches()).toHaveLength(2);
  });

  it('merges on the thread’s own fast-test run, without waiting for CI, when GitHub requires no checks', async () => {
    const id = newId('delegation');
    const offered = await t.commit(IDS.dusty, offerDelegation, {
      id,
      conversationId: IDS.dmDusty,
      threadRootId: root,
      personId: IDS.mara,
      connectionId,
      project: { id: `local-${id}`, title: 'Single project', root: '/workspace/single' },
      title: 'One pull request',
      intro: 'Handing it over.',
      atOnce: 2,
      pullRequests: true,
      merge: true,
      tasks: [
        {
          title: 'Readable settings',
          brief: 'Make the settings names clear.',
          why: null,
          picked: true,
          after: null,
          provider: null,
          model: null,
          modelLabel: null,
        },
      ],
      start: true,
    });
    expect(offered.status).toBe('ok');
    expect(await startReady(t.services, id, t.burrowId)).toBe(1);
    const source = await sourceOf(id);
    const github = fakeOf(t);
    const repo = `local/${id}`;
    const state = await github.addRepo({ fullName: repo });
    const base = state.branches.get('main');
    if (!base) throw new Error('Missing default branch');
    const number = await github.simulateOpenPullRequest({
      repo,
      head: source.branch,
      title: source.title,
      login: 'john',
    });
    const head = (await github.getPullRequest(repo, number)).headSha;
    await github.simulateFiles({
      repo,
      sha: head,
      parent: base,
      files: { 'settings.txt': 'Readable names' },
    });
    const url = `https://github.com/${repo}/pull/${number}`;
    t3.linkPullRequest(source.threadId, url);
    t3.finish(source.threadId, 'Updated the names.\nNote: The settings are clearer.\nChecks: passing');
    await pass();

    // The final check is given that pull request, not a branch to copy it onto.
    const final = await finalOf(id);
    expect(final).toMatchObject({ state: 'working', pr: url });
    const brief = String(launches().at(-1)?.args.message);
    expect(brief).toContain(url);
    expect(brief).toContain(`origin/${source.branch}`);
    expect(brief).toMatch(/don’t open another/);
    expect(brief).toContain('local: fast-test');
    if (!final.threadId) throw new Error('The final check did not start');

    // It runs fast-test itself; CI on GitHub hasn't reported anything.
    const proof: DelegationVerification = {
      revision: head,
      base,
      inputs: final.checkedInputs as string,
      generation: final.checkGeneration,
      expected: ['local: fast-test'],
      results: [{ name: 'local: fast-test', revision: head, state: 'passing' }],
    };
    t3.finish(
      final.threadId,
      `Checked it.\nNote: Its checks passed.\nChecks: passing\nVerification: ${JSON.stringify(proof)}`,
    );
    await pass();
    // Whombat merges the one checked pull request itself: both rows merged, no third thread or second pull request.
    expect(github.merges.at(-1)).toMatchObject({ repo, number, method: 'merge' });
    await putOnDev({ id, threadId: final.threadId });
    expect(await finalOf(id)).toMatchObject({ state: 'done', mergeState: 'merged', checkedRevision: head });
    expect((await sourceOf(id)).mergeState).toBe('merged');
    expect(launches()).toHaveLength(2);
  });

  const spec = (title: string, brief: string, extra: Record<string, unknown> = {}) => ({
    title,
    brief,
    why: null,
    picked: true,
    after: null,
    provider: null,
    model: null,
    modelLabel: null,
    ...extra,
  });

  it('hands every compatible task to one thread with subagents allowed, and reads each item’s line', async () => {
    const id = newId('delegation');
    const offered = await t.commit(IDS.dusty, offerDelegation, {
      id,
      conversationId: IDS.dmDusty,
      threadRootId: root,
      personId: IDS.mara,
      connectionId,
      project: { id: `lead-${id}`, title: 'Lead project', root: '/workspace/lead' },
      title: 'Simplify the Exams page',
      intro: 'Handing these over.',
      atOnce: 2,
      pullRequests: true,
      merge: true,
      tasks: [
        spec('Clear names', 'Rename the version words.'),
        spec('Calmer cards', 'Shorten the seat cards.'),
        spec('Matching icons', 'Use one icon set.', { after: 1 }),
        // Another AI chosen for it: a thread of its own.
        spec('Sol reviews the words', 'Read every label.', {
          provider: 'codex',
          model: 'gpt-6.1-sol',
          modelLabel: 'GPT 6.1 Sol',
        }),
      ],
      start: true,
    });
    expect(offered.status).toBe('ok');
    expect(await startReady(t.services, id, t.burrowId)).toBe(2);
    expect(launches()).toHaveLength(2);
    const lead = launches().find((call) => String(call.args.message).includes('Rename the version words.'));
    const brief = String(lead?.args.message);
    // All three of the same AI in one brief, numbered as on the card, led with a few subagents at most.
    for (const fact of ['Shorten the seat cards.', 'Use one icon set.', 'Item 3 (builds on item 1)'])
      expect(brief).toContain(fact);
    expect(brief).not.toContain('Read every label.');
    expect(brief).toContain('You may start subagents.');
    expect(brief).toContain('At most 2 at a time');
    expect(brief).toMatch(/^Item 2: </m);
    expect(brief).toMatch(/Other threads change this project/);
    expect(String(lead?.args.title)).toContain('Simplify the Exams page (3 items)');

    const rows = (await loadTasks(db(), id)).filter((row) => row.kind === 'task');
    const [first, second, third, sol] = rows;
    expect(second?.threadId).toBe(first?.threadId);
    expect(third?.threadId).toBe(first?.threadId);
    expect(sol?.threadId).not.toBe(first?.threadId);
    // On the card the others are done with the first, whose row says what the thread does.
    const [d] = await db().select().from(delegations).where(eq(delegations.id, id));
    const [shown] = await db()
      .select()
      .from(messages)
      .where(eq(messages.id, d?.messageId ?? ''));
    expect(DelegationCard.parse(shown?.card).tasks.map((task) => task.after)).toEqual([
      null,
      1,
      1,
      null,
      null,
    ]);

    t3.finish(
      first?.threadId as string,
      [
        'Done, one pull request.',
        'Item 1: The version words are gone.',
        'Item 2: not done: the cards were already short.',
        'Item 3: The icons match now.',
        'Note: The Exams page reads more plainly.',
        'Checks: passing',
      ].join('\n'),
    );
    await pass();
    const ended = (await loadTasks(db(), id)).filter((row) => row.kind === 'task');
    expect(ended.slice(0, 3).map((row) => [row.state, row.note])).toEqual([
      ['done', 'The version words are gone.'],
      ['failed', 'The cards were already short.'],
      ['done', 'The icons match now.'],
    ]);
    // The agent reads the thread's one answer once, on its first item; the others point to it.
    const [dl] = await db().select().from(delegations).where(eq(delegations.id, id));
    const read = await delegationContext(db(), dl as NonNullable<typeof dl>, 'all', () => true);
    expect(read?.tasks.slice(0, 3).map((task) => [!!task.answer, task.answerWith ?? null])).toEqual([
      [true, null],
      [false, 1],
      [false, 1],
    ]);
    // An item it didn't do needs the agent's judgment.
    const woken = await db()
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.trigger, 'delegation')));
    expect(woken.length).toBeGreaterThan(0);
  });

  it('asks a lead sent more work for each item’s line, and an item the new answer leaves alone keeps how it went', async () => {
    const id = newId('delegation');
    const offered = await t.commit(IDS.dusty, offerDelegation, {
      id,
      conversationId: IDS.dmDusty,
      threadRootId: root,
      personId: IDS.mara,
      connectionId,
      project: { id: `more-${id}`, title: 'More project', root: '/workspace/more' },
      title: 'Tidy the Rooms page',
      intro: 'Handing these over.',
      atOnce: 2,
      pullRequests: true,
      merge: false,
      tasks: [
        spec('Shorter titles', 'Shorten the room titles.'),
        spec('One colour', 'Use one colour for free rooms.'),
        spec('Bigger map', 'Make the floor map bigger.'),
      ],
      start: true,
    });
    expect(offered.status).toBe('ok');
    expect(await startReady(t.services, id, t.burrowId)).toBe(1);
    const [first] = (await loadTasks(db(), id)).filter((row) => row.kind === 'task');
    const thread = first?.threadId as string;
    t3.finish(
      thread,
      [
        'Done.',
        'Item 1: The titles are shorter.',
        'Item 2: Free rooms are green.',
        'Item 3: The map is bigger.',
      ].join('\n'),
    );
    await pass();
    expect((await loadTasks(db(), id)).filter((row) => row.kind === 'task').map((row) => row.state)).toEqual([
      'done',
      'done',
      'done',
    ]);
    const before = sends().length;
    const sendRes = await t.commit(IDS.dusty, updateDelegation, {
      delegationId: id,
      note: null,
      title: null,
      atOnce: null,
      pullRequests: null,
      add: [],
      change: [],
      remove: [],
      order: [],
      start: false,
      stop: [],
      retry: [],
      send: [{ n: 1, message: 'Also make the titles bold.' }],
    });
    expect(sendRes.status).toBe('ok');
    if (sendRes.status === 'ok')
      await sendToTasks(t.services, sendRes.result.delegation, sendRes.result.send);
    const told = String(sends().at(-1)?.args.message);
    expect(sends().length).toBeGreaterThan(before);
    for (const fact of ['Also make the titles bold.', 'Item 1:', 'Item 2:', 'Item 3:'])
      expect(told).toContain(fact);
    // Its new answer speaks of item 1 only: the others keep how its earlier answer said they went.
    t3.finish(thread, 'Made them bold.\nItem 1: The titles are shorter and bold.');
    await pass();
    expect(
      (await loadTasks(db(), id)).filter((row) => row.kind === 'task').map((row) => [row.state, row.note]),
    ).toEqual([
      // The task the work was for has its new line.
      ['done', 'The titles are shorter and bold.'],
      ['done', 'Free rooms are green.'],
      ['done', 'The map is bigger.'],
    ]);
    // More work again, now for item 2, and again an answer about item 1 only: item 3 keeps its line from the first
    // answer, and item 2, which the work was for, isn't taken as done without a word.
    const again = await t.commit(IDS.dusty, updateDelegation, {
      delegationId: id,
      note: null,
      title: null,
      atOnce: null,
      pullRequests: null,
      add: [],
      change: [],
      remove: [],
      order: [],
      start: false,
      stop: [],
      retry: [],
      send: [{ n: 2, message: 'Use a softer green.' }],
    });
    expect(again.status).toBe('ok');
    if (again.status === 'ok') await sendToTasks(t.services, again.result.delegation, again.result.send);
    t3.finish(thread, 'Softened the colour.\nItem 1: The titles are still bold.');
    await pass();
    expect(
      (await loadTasks(db(), id)).filter((row) => row.kind === 'task').map((row) => [row.state, row.note]),
    ).toEqual([
      ['done', 'The titles are shorter and bold.'],
      ['failed', 'Its thread didn’t say whether it did this one.'],
      ['done', 'The map is bigger.'],
    ]);
  });

  it('lets a council’s checklist opened again after the council ended work on as a list of its own', async () => {
    const f = await candidate();
    const councilId = newId('council');
    const now = t.services.clock();
    await db().insert(councils).values({
      id: councilId,
      burrowId: t.burrowId,
      conversationId: IDS.dmDusty,
      threadRootId: root,
      agentId: IDS.dusty,
      personId: IDS.mara,
      connectionId,
      kind: 'improve',
      seats: [],
      title: 'Improve it',
      question: 'Improve it.',
      stage: 'done',
      roundsMax: 3,
      state: 'done',
      createdAt: now,
      updatedAt: now,
    });
    await db().update(delegations).set({ councilId }).where(eq(delegations.id, f.id));
    const ended = await t.commit(IDS.dusty, finishDelegation, {
      delegationId: f.id,
      summary: 'Stopped with the council.',
      stopped: true,
    });
    expect(ended.status).toBe('ok');
    // The person asks for one more fix in that thread: the card opens again for it.
    const added = await t.commit(IDS.dusty, updateDelegation, {
      delegationId: f.id,
      note: null,
      title: null,
      atOnce: null,
      pullRequests: null,
      add: [spec('One more fix', 'Fix the footer link.')],
      change: [],
      remove: [],
      order: [],
      start: true,
      stop: [],
      retry: [],
      send: [],
    });
    expect(added.status).toBe('ok');
    expect(await delegationOf(f.id)).toMatchObject({ stage: 'working', councilId: null });
    await pass();
    expect((await delegationOf(f.id)).stage).toBe('working');
  });

  it('reads each item by the number its thread was told after the card changed, and an item it left out needs a look', async () => {
    const id = newId('delegation');
    const offered = await t.commit(IDS.dusty, offerDelegation, {
      id,
      conversationId: IDS.dmDusty,
      threadRootId: root,
      personId: IDS.mara,
      connectionId,
      project: { id: `items-${id}`, title: 'Items project', root: '/workspace/items' },
      title: 'Tidy the Rooms page',
      intro: 'Handing these over.',
      atOnce: 2,
      pullRequests: true,
      merge: true,
      tasks: [
        spec('Shorter titles', 'Shorten the room titles.'),
        spec('One colour', 'Use one colour for free rooms.'),
        spec('Bigger map', 'Make the floor map bigger.'),
      ],
      start: true,
    });
    expect(offered.status).toBe('ok');
    expect(await startReady(t.services, id, t.burrowId)).toBe(1);
    const brief = String(launches().at(-1)?.args.message);
    expect(brief).toMatch(/^Item 3: </m);
    const [titles, colour, map] = (await loadTasks(db(), id)).filter((row) => row.kind === 'task');
    expect([titles?.item, colour?.item, map?.item]).toEqual([1, 2, 3]);
    // The agent moves the map to the top while the thread works: the card's numbers change, the thread's don't.
    await t.commit(IDS.dusty, updateDelegation, {
      delegationId: id,
      note: null,
      title: null,
      atOnce: null,
      pullRequests: null,
      add: [],
      change: [],
      remove: [],
      order: [3, 1, 2],
      start: false,
      stop: [],
      retry: [],
      send: [],
    });
    t3.finish(
      titles?.threadId as string,
      [
        'Done, one pull request.',
        'Item 1: The titles are shorter.',
        'Item 3: The map is bigger.',
        'Note: The Rooms page is tidier.',
        'Checks: passing',
      ].join('\n'),
    );
    await pass();
    const ended = new Map((await loadTasks(db(), id)).map((row) => [row.id, row]));
    expect(
      [titles, map].map((row) => [ended.get(row?.id ?? '')?.state, ended.get(row?.id ?? '')?.note]),
    ).toEqual([
      ['done', 'The titles are shorter.'],
      ['done', 'The map is bigger.'],
    ]);
    // The thread said nothing about the colour: it isn't taken as done, and the agent is woken for it.
    expect(ended.get(colour?.id ?? '')).toMatchObject({ state: 'failed', mergeState: null });
    expect(ended.get(colour?.id ?? '')?.dispatchId).toBeTruthy();
  });

  it('keeps a long run going, and ends it when T3 Code no longer has its thread', async () => {
    const id = newId('delegation');
    const offered = await t.commit(IDS.dusty, offerDelegation, {
      id,
      conversationId: IDS.dmDusty,
      threadRootId: root,
      personId: IDS.mara,
      connectionId,
      project: { id: `long-${id}`, title: 'Long project', root: '/workspace/long' },
      title: 'A long job',
      intro: 'Handing it over.',
      atOnce: 2,
      pullRequests: true,
      merge: true,
      tasks: [
        spec('Server checks', 'Check the target on the server.'),
        spec('Exact scores', 'Read scores exactly.'),
      ],
      start: true,
    });
    expect(offered.status).toBe('ok');
    expect(await startReady(t.services, id, t.burrowId)).toBe(1);
    const rows = () => loadTasks(db(), id).then((all) => all.filter((row) => row.kind === 'task'));
    const [lead] = await rows();
    const threadId = lead?.threadId as string;
    // Working for a day, and a deadline from before tasks had none: it goes on.
    const dayAgo = new Date(t.services.clock().getTime() - 24 * 3_600_000);
    await db()
      .update(delegationTasks)
      .set({ startedAt: dayAgo, deadline: dayAgo })
      .where(eq(delegationTasks.delegationId, id));
    await pass();
    expect((await rows()).map((row) => row.state)).toEqual(['working', 'working']);
    expect(t3.calls.some((c) => c.name === 't3_thread_interrupt' && c.args.threadId === threadId)).toBe(
      false,
    );

    // T3 Code no longer has its thread: the work is over, its row says why, and the agent looks at it.
    t3.threads.delete(threadId);
    await pass();
    const ended = await rows();
    expect(ended.map((row) => row.state)).toEqual(['failed', 'failed']);
    expect(ended[0]?.note).toContain('gone');
    expect(ended[0]?.dispatchId).toBeTruthy();
  });
});

/** The policy is read independently from GitHub; transport answers are injected while command transitions use Postgres. */
