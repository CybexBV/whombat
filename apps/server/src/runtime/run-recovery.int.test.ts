/**
 * Runs that don't get stuck (docs/decisions/run-checkout.md RC-06…RC-13), end to end: the real runner against a test
 * server with FakeGitHub backed by bare repositories on disk, Dusty working in a worktree of Whombat's own mirror.
 *
 *  - a coding check: Mara asks in a thread, Dusty starts a run (no checkout), its run turn edits a tracked file and
 *    commits, the runner pushes it, Whombat opens the pull request;
 *  - a run left live with nothing to wait on wakes Dusty once, then needs a person;
 *  - a run whose goal waits on a person needs them in Dusty's words, and their answer wakes Dusty on it (RA-DS62);
 *  - a run that waits on CI with a turn scheduled to look again stays live, and that turn continues it (RC-15);
 *  - a run that waits on its pull request's checks stays live without one, and their result wakes Dusty on it
 *    (health-checks-wake.md HW-01, HW-06);
 *  - Try again on a failed run; “Browse the web” for pushing is answered once.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentProvider,
  BASIC_CAPABILITIES,
  connectWhombatMcp,
  type TurnEvent,
  type TurnInput,
} from '@whombat/agent-runtime';
import { newId } from '@whombat/core';
import { createRunnerApi, type ProviderRegistry, Runner, testPolicy } from '@whombat/runner';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wakeForApproval } from '../approvals/wake';
import { finishRun, startRun } from '../commands/agent-runs';
import { decideApproval, requestApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import { retryRun, stalledText } from '../commands/run-recovery';
import {
  approvals,
  dispatches,
  grants,
  messages,
  notifications,
  principals,
  pullRequests,
  repos,
  runs,
} from '../db/schema/index';
import { NO_NETWORK_FOR_GIT } from '../mcp/tools';
import { loadPrincipalRow } from '../read/principals';
import { workOverview } from '../read/work-overview';
import { schedulesFor } from '../schedules/ticker';
import { IDS } from '../seed/test-world';
import { connectGitHubAs, fakeOf, signInsEnv, syncGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { waitFor } from '../test/runner';
import { SCRIPTED_ENV, scripted } from '../test/scripted';
import { accountOf } from '../test/tokens';
import { dispatchScopeOf, runInDispatchScope } from './dispatch-scope';
import { afterRunTurn } from './run-recovery';

const gitRoot = mkdtempSync(join(tmpdir(), 'whombat-run-recovery-github-'));
const t = useTestServer({
  seed: true,
  listen: true,
  env: { ...SCRIPTED_ENV, ...signInsEnv(), WHOMBAT_FAKE_GITHUB_GIT_ROOT: gitRoot },
});
// Agents' git and gh run on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
beforeAll(() => connectGitHubAs(t.services, IDS.mara));
const REPO = 'whombat/billing';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'whombat-run-recovery-home-')));
const host = { home, whombatHome: join(home, '.whombat') };

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Mara',
      GIT_AUTHOR_EMAIL: 'mara@example.com',
      GIT_COMMITTER_NAME: 'Mara',
      GIT_COMMITTER_EMAIL: 'mara@example.com',
    },
  }).trim();

/** What Dusty does in a turn: given the turn, it may edit, commit and call Whombat's tools. */
type Script = (input: TurnInput, mcp: Awaited<ReturnType<typeof connectWhombatMcp>>) => Promise<void>;
const turns: { input: TurnInput; done: boolean }[] = [];
let script: Script = async () => {};

const banjo: AgentProvider = {
  kind: 'codex',
  available: async () => ({ ok: true, version: 'test' }),
  capabilities: () => BASIC_CAPABILITIES,
  async *runTurn(input): AsyncIterable<TurnEvent> {
    const turn = { input, done: false };
    turns.push(turn);
    yield { type: 'session', sessionId: `recovery-${turns.length}` };
    const mcp = await connectWhombatMcp(input.mcp);
    try {
      await script(input, mcp);
      yield { type: 'final', text: 'NO_REPLY' };
    } finally {
      await mcp.close();
      turn.done = true;
    }
  },
};

/** The first tracked file of the checkout, edited and committed with the agent's own git env. */
function editTracked(input: TurnInput, line: string) {
  const env = { ...process.env, ...input.host?.env };
  const file =
    execFileSync('git', ['ls-files'], { cwd: input.cwd, env, encoding: 'utf8' }).split('\n')[0] ?? '';
  appendFileSync(join(input.cwd, file), `${line}\n`);
  execFileSync('git', ['commit', '--quiet', '-am', line], { cwd: input.cwd, env });
  return file;
}

let runner: Runner | null = null;

beforeAll(async () => {
  await fakeOf(t).ready();
  await t.services.db
    .update(principals)
    .set({ runtime: { provider: 'codex' } })
    .where(eq(principals.id, IDS.dusty));
  // Dusty opens pull requests and writes feature branches without asking.
  for (const keyId of ['pr.open', 'branch.feature.readwrite'])
    await t.services.db
      .update(grants)
      .set({ tier: 'can' })
      .where(and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, keyId)));
  const registry: ProviderRegistry = scripted({
    claims: () => ['codex'],
    for: (kind) => (kind === 'codex' ? banjo : null),
    report: () => [],
  });
  runner = new Runner({
    api: createRunnerApi(t.baseUrl, 'dev-runner-token'),
    registry,
    managed: testPolicy(),
    serverUrl: t.baseUrl,
    workspacesRoot: join(host.whombatHome, 'workspaces'),
    host,
    waitMs: 300,
    heartbeatMs: 200,
    progressMs: 50,
  });
  runner.start();
});

afterAll(async () => {
  await runner?.stop(2000);
});

/**
 * Mara asks in a thread; Dusty's mention turn (no checkout) starts the run, which queues its run turn (RC-01). `woken`:
 * the starting turn is a woken one with the thread but no message of its own (an `approval_granted` turn).
 */
async function askForRun(branch: string, title: string, options: { woken?: boolean; repo?: string } = {}) {
  const asked = await t.commit(IDS.mara, sendMessage, {
    conversationId: IDS.billing,
    text: `Please ${title}.`,
  });
  if (asked.status !== 'ok') throw new Error('send failed');
  const turn = newId('dispatch');
  await t.services.db.insert(dispatches).values({
    id: turn,
    burrowId: t.burrowId,
    agentId: IDS.dusty,
    trigger: options.woken ? 'approval_granted' : 'mention',
    mode: 'reply',
    conversationId: IDS.billing,
    messageId: options.woken ? null : asked.result.id,
    threadRootId: asked.result.id,
    state: 'done',
    createdAt: new Date(),
    onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
  });
  const started = await t.commit(IDS.dusty, startRun, {
    conversationId: IDS.billing,
    title,
    repo: options.repo ?? REPO,
    branch,
    dispatchId: turn,
    steps: [{ title: 'Change it', detail: '' }],
  });
  if (started.status !== 'ok') throw new Error(`start_run: ${started.status}`);
  return { runId: started.result.runId, number: started.result.number, askedId: asked.result.id };
}

const runRow = async (id: string) => (await t.services.db.select().from(runs).where(eq(runs.id, id)))[0];
const turnsOf = (runId: string) => turns.filter((x) => x.input.context.run?.id === runId);

/** These providers simulate a completed one-step task; report the step before finishing. */
async function completeRun(
  mcp: Parameters<typeof script>[1],
  input: { run: number; outcome: 'done'; summary: string },
) {
  await mcp.call('run_step', { run: input.run, step: 0, state: 'done' });
  return mcp.call('finish_run', input);
}

describe('a coding run, end to end (RC-13)', () => {
  it('edits a tracked file, is pushed and gets its pull request', async () => {
    const branch = 'feat/round-totals';
    script = async (input, mcp) => {
      if (!input.context.run) return;
      editTracked(input, '// rounded totals');
      await completeRun(mcp, {
        run: input.context.run.number,
        outcome: 'done',
        summary: 'Totals are rounded.',
      });
    };
    const { runId, askedId } = await askForRun(branch, 'round the totals');
    const run = await waitFor(
      async () => ((await runRow(runId))?.prNumber ? runRow(runId) : null),
      30_000,
      'the PR',
    );
    expect(run?.status).toBe('done');
    const [pr] = await t.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch));
    expect(pr).toMatchObject({ state: 'open', number: run?.prNumber, title: 'round the totals' });
    // Pushed.
    expect(git(join(gitRoot, `${REPO}.git`), 'log', '-1', '--format=%s', branch)).toBe('// rounded totals');
    // The run's card is in the thread Mara asked in, not in the channel (RC-14).
    const [card] = await t.services.db
      .select({ threadRootId: messages.threadRootId })
      .from(messages)
      .where(eq(messages.id, run?.messageId ?? ''));
    expect(card?.threadRootId).toBe(askedId);
    // The run turn ran where Mara asked, in its worktree.
    const [turn] = turnsOf(runId);
    expect(turn?.input.cwd.startsWith(join(host.whombatHome, 'workspaces'))).toBe(true);
    expect(turn?.input.context.dispatch.threadRootId).toBeTruthy();
  });
});

describe('a run started in a woken turn (VA-02)', () => {
  it('keeps the thread: its card and its run turn are where Mara asked', async () => {
    script = async (input, mcp) => {
      if (!input.context.run) return;
      await completeRun(mcp, { run: input.context.run.number, outcome: 'done', summary: 'Checked.' });
    };
    const { runId, askedId } = await askForRun('feat/woken-thread', 'check the totals', { woken: true });
    const [turn] = await waitFor(
      async () => {
        const rows = await t.services.db.select().from(dispatches).where(eq(dispatches.runId, runId));
        return rows.length ? rows : null;
      },
      10_000,
      'the run turn',
    );
    expect(turn).toMatchObject({ trigger: 'run_control', threadRootId: askedId });
    const run = await runRow(runId);
    const [card] = await t.services.db
      .select({ threadRootId: messages.threadRootId })
      .from(messages)
      .where(eq(messages.id, run?.messageId ?? ''));
    expect(card?.threadRootId).toBe(askedId);
    await waitFor(async () => (await runRow(runId))?.status !== 'live', 30_000, 'the run to end');
  });
});

describe('a run left live with nothing to wait on (RC-11)', () => {
  it('wakes the agent once, then needs a person', async () => {
    script = async () => {};
    const { runId, number } = await askForRun('feat/left-live', 'leave it live');
    // The run turn, then the turn Whombat woke because the run stalled.
    const woken = await waitFor(
      () => turnsOf(runId).find((x) => x.input.context.stalledRun === true && x.done) ?? null,
      30_000,
      'the woken turn',
    );
    expect(woken.input.context.dispatch.trigger).toBe('run_control');
    const run = await waitFor(
      async () => ((await runRow(runId))?.attention ? runRow(runId) : null),
      15_000,
      'attention',
    );
    expect(run?.attention).toBe(stalledText('Dusty'));
    expect(run?.status).toBe('live');
    const note = await waitFor(
      async () =>
        (
          await t.services.db
            .select()
            .from(notifications)
            .where(and(eq(notifications.principalId, IDS.mara), eq(notifications.kind, 'needs_you')))
            .orderBy(desc(notifications.createdAt))
            .limit(1)
        )[0] ?? null,
      10_000,
      'the needs-you row',
    );
    expect(note.text).toBe(`Dusty stopped without finishing run #${number} “leave it live”.`);
    // Woken once only.
    expect(turnsOf(runId).filter((x) => x.input.context.stalledRun)).toHaveLength(1);
    // The agent moving the run clears it.
    await t.commit(IDS.dusty, finishRun, { run: number, outcome: 'failed', summary: 'Left it.' });
    expect((await runRow(runId))?.attention).toBeNull();
  });
});

describe('a run whose goal waits on a person (RA-DS62)', () => {
  it('needs that person in the agent’s own words, and their answer wakes the agent on the run to finish it', async () => {
    const need =
      'To publish it I need the web server’s SSH key: add it in the Vault and give me a key to it; then I’ll publish it — I’ll ask you first.';
    script = async (input, mcp) => {
      const run = input.context.run;
      if (!run) return;
      // The run turn: the fix is checked, publishing needs Mara. It asks and leaves the run live.
      if (input.context.dispatch.trigger === 'run_control') {
        await mcp.call('reply_in_thread', {
          messageId: input.context.dispatch.threadRootId ?? '',
          text: `@Mara ${need}`,
          asks: true,
        });
        return;
      }
      await completeRun(mcp, { run: run.number, outcome: 'done', summary: 'Published it.' });
    };
    const { runId, askedId } = await askForRun('feat/publish-it', 'publish the accent fix');
    const run = await waitFor(
      async () => ((await runRow(runId))?.attention ? runRow(runId) : null),
      30_000,
      'attention',
    );
    expect(run).toMatchObject({ status: 'live', attention: need });
    // It waits on Mara's answer: not woken as a run left with nothing to wait on (RC-11).
    await new Promise((r) => setTimeout(r, 1000));
    expect(turnsOf(runId)).toHaveLength(1);
    // Work shows the run as needing a person, with what Dusty asked for.
    const mara = await loadPrincipalRow(t.services.db, IDS.mara);
    if (!mara) throw new Error('no Mara');
    const items = async () =>
      (await workOverview(t.services, mara, t.burrowId)).sections.flatMap((s) => s.items);
    expect((await items()).find((i) => i.id === `run:${runId}`)).toMatchObject({
      section: 'blocked',
      status: { text: 'NEEDS A PERSON', tone: 'warn' },
      detail: need,
    });
    // Someone else's message there isn't the answer the run waits on.
    await t.commit(IDS.dusty, sendMessage, {
      conversationId: IDS.billing,
      threadRootId: askedId,
      text: 'Looks right to me.',
    });
    await new Promise((r) => setTimeout(r, 500));
    expect((await runRow(runId))?.attention).toBe(need);
    expect(turnsOf(runId)).toHaveLength(1);
    // Mara's answer, without naming Dusty: the run no longer needs her, and Dusty is woken on it, in its checkout.
    const answer = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      threadRootId: askedId,
      text: 'Added it to the Vault and gave you a key.',
    });
    if (answer.status !== 'ok') throw new Error('send failed');
    expect((await runRow(runId))?.attention).toBeNull();
    const woken = await waitFor(
      () => turnsOf(runId).find((x) => x.input.context.dispatch.trigger === 'mention' && x.done) ?? null,
      30_000,
      'the turn Mara’s answer woke',
    );
    expect(woken.input.context.dispatch).toMatchObject({
      mode: 'run',
      runId,
      messageId: answer.result.id,
      threadRootId: askedId,
    });
    expect(woken.input.context.workspace).toMatchObject({ repo: REPO, branch: 'feat/publish-it' });
    await waitFor(async () => ((await runRow(runId))?.status === 'done' ? true : null), 10_000, 'done');
    // Her message woke no chat turn beside it.
    const chat = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.messageId, answer.result.id), eq(dispatches.mode, 'reply')));
    expect(chat).toEqual([]);
  });
});

describe('a run that waits on CI (RC-15)', () => {
  it('stays live with a turn scheduled to look again, and that turn continues the run', async () => {
    const lookAt = new Date(Date.now() + 60 * 60_000);
    script = async (input, mcp) => {
      const run = input.context.run;
      if (!run) return;
      // The run turn: pushed, CI is still running. It schedules a look and leaves the run live.
      if (input.context.dispatch.trigger === 'run_control') {
        await mcp.call('run_log', { run: run.number, lines: ['CI is still running on the branch.'] });
        const made = await mcp.call('schedule', {
          action: 'create',
          when: { kind: 'at', at: lookAt.toISOString() },
          prompt: `Look at CI on run #${run.number} and finish it.`,
        });
        expect(made.body).toMatchObject({ status: 'ok' });
        return;
      }
      // The scheduled turn, on the run: CI is green now.
      if (input.context.dispatch.trigger === 'schedule')
        await completeRun(mcp, { run: run.number, outcome: 'done', summary: 'CI green, merged.' });
    };
    const { runId } = await askForRun('feat/wait-for-ci', 'merge it once CI is green');
    await waitFor(
      () => turnsOf(runId).find((x) => x.input.context.dispatch.trigger === 'run_control' && x.done) ?? null,
      30_000,
      'the run turn',
    );
    // Not stalled: no woken turn, no attention, still live.
    await new Promise((r) => setTimeout(r, 1000));
    expect(turnsOf(runId).filter((x) => x.input.context.stalledRun)).toHaveLength(0);
    expect(await runRow(runId)).toMatchObject({ status: 'live', attention: null, stalledAt: null });
    // At its time the scheduled turn is a turn on the run, in its checkout.
    expect(await schedulesFor(t.services).tick(new Date(lookAt.getTime() + 1000))).toBeGreaterThanOrEqual(1);
    const scheduled = await waitFor(
      () => turnsOf(runId).find((x) => x.input.context.dispatch.trigger === 'schedule' && x.done) ?? null,
      30_000,
      'the scheduled turn',
    );
    expect(scheduled.input.context.dispatch).toMatchObject({ mode: 'run', runId });
    expect(scheduled.input.context.schedule?.prompt).toContain('Look at CI');
    expect(scheduled.input.context.workspace).toMatchObject({ repo: REPO, branch: 'feat/wait-for-ci' });
    await waitFor(async () => ((await runRow(runId))?.status === 'done' ? true : null), 10_000, 'done');
  });
});

describe('a run that waits on its pull request’s checks (health-checks-wake.md HW-06)', () => {
  it('stays live without a schedule, and the checks’ result wakes the agent on the run', async () => {
    const branch = 'feat/wait-for-checks';
    script = async (input, mcp) => {
      const run = input.context.run;
      if (!run) return;
      // The run turn: a change committed; the runner pushes it and Whombat opens the pull request. CI decides.
      if (input.context.dispatch.trigger === 'run_control') {
        editTracked(input, '// waits for the checks');
        await mcp.call('run_log', { run: run.number, lines: ['Pushed; waiting for the checks.'] });
        return;
      }
      // GitHub's message with the result woke it, on the run.
      if (input.context.dispatch.trigger === 'mention')
        await completeRun(mcp, { run: run.number, outcome: 'done', summary: 'The checks passed.' });
    };
    const { runId, askedId } = await askForRun(branch, 'merge it once the checks pass');
    const run = await waitFor(
      async () => ((await runRow(runId))?.prNumber ? runRow(runId) : null),
      30_000,
      'the pull request',
    );
    // Not stalled: the checks still to come wake it (whombat/billing's pull requests have checks).
    await new Promise((r) => setTimeout(r, 1000));
    expect(turnsOf(runId).filter((x) => x.input.context.stalledRun)).toHaveLength(0);
    expect(await runRow(runId)).toMatchObject({ status: 'live', attention: null, stalledAt: null });
    const [pr] = await t.services.db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.number, run?.prNumber ?? 0));
    await fakeOf(t).simulateCheckRun({
      repo: REPO,
      sha: pr?.headSha ?? '',
      name: 'ci',
      conclusion: 'success',
    });
    await syncGitHub(t);
    await syncGitHub(t);
    const woken = await waitFor(
      () => turnsOf(runId).find((x) => x.input.context.dispatch.trigger === 'mention' && x.done) ?? null,
      30_000,
      'the turn the checks woke',
    );
    expect(woken.input.context.dispatch).toMatchObject({ mode: 'run', runId, threadRootId: askedId });
    expect(woken.input.context.trigger?.text).toContain(`The checks on [PR #${run?.prNumber}]`);
    expect(woken.input.context.workspace).toMatchObject({ repo: REPO, branch });
    await waitFor(async () => ((await runRow(runId))?.status === 'done' ? true : null), 10_000, 'done');
  });
});

describe('Try again on a failed run (RC-10)', () => {
  it('makes the run live and gives the agent a run turn where it was asked', async () => {
    script = async () => {};
    const { runId, number, askedId } = await askForRun('feat/try-again', 'try it again');
    await waitFor(() => turnsOf(runId).find((x) => x.done) ?? null, 30_000, 'the first run turn');
    await t.commit(IDS.dusty, finishRun, { run: number, outcome: 'failed', summary: 'Stuck.' });
    const before = turnsOf(runId).length;
    script = async (input, mcp) => {
      if (input.context.run)
        await completeRun(mcp, {
          run: input.context.run.number,
          outcome: 'done',
          summary: 'Done now.',
        });
    };
    const res = await t.commit(IDS.mara, retryRun, { number });
    expect(res.status).toBe('ok');
    const turn = await waitFor(
      () =>
        turnsOf(runId)
          .slice(before)
          .find((x) => x.done) ?? null,
      30_000,
      'the retry',
    );
    expect(turn.input.context.dispatch).toMatchObject({
      mode: 'run',
      messageId: askedId,
      threadRootId: askedId,
    });
    expect(turn.input.context.workspace).toMatchObject({ repo: REPO, branch: 'feat/try-again' });
    await waitFor(async () => ((await runRow(runId))?.status === 'done' ? true : null), 10_000, 'done');
    // Only a failed run.
    await expect(t.commit(IDS.mara, retryRun, { number })).rejects.toThrow(
      'Only a failed run can be tried again.',
    );
  });
});

describe('“Browse the web” to push (RC-12)', () => {
  it('is answered once in a run turn, and asked for real the second time', async () => {
    // Without the key yet, nor “Use a web browser”, which brings it in.
    await t.services.db
      .delete(grants)
      .where(and(eq(grants.agentId, IDS.dusty), inArray(grants.keyId, ['web.browse', 'browser.use'])));
    const answers: string[] = [];
    script = async (input, mcp) => {
      if (!input.context.run) return;
      for (let i = 0; i < 2; i++) {
        const res = await mcp
          .call('request_approval', {
            conversationId: input.context.conversation.id,
            action: { type: 'grant_key', params: { keyId: 'web.browse' } },
            title: 'Browse the web',
            question: 'May I use the network to push?',
            whatHappens: ['Dusty may use the network.'],
            explainer: 'To push the branch.',
            summary: 'Network for the push',
          })
          .then((r) => JSON.stringify(r))
          .catch((err: unknown) => String(err));
        answers.push(res);
      }
      await completeRun(mcp, { run: input.context.run.number, outcome: 'done', summary: 'Asked.' });
    };
    const { runId, askedId } = await askForRun('feat/network', 'check the network');
    await waitFor(() => turnsOf(runId).find((x) => x.done) ?? null, 30_000, 'the run turn');
    expect(answers[0]).toContain(NO_NETWORK_FOR_GIT.slice(0, 40));
    expect(answers[1]).not.toContain(NO_NETWORK_FOR_GIT.slice(0, 40));
    // The key request is the person's to decide, in the room it was asked in (one-person.md OP-S62).
    const [request] = await t.services.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.requesterId, IDS.dusty), eq(approvals.keyId, 'web.browse')))
      .orderBy(desc(approvals.createdAt))
      .limit(1);
    expect(request?.conversationId).toBe(IDS.billing);
    expect(askedId).toBeTruthy();
  });
});

describe('a run turn whose checkout can’t be made (RA-DS54, RA-DS55)', () => {
  it('doesn’t start Dusty: the run fails with what is missing, said once, and nothing runs again by itself', async () => {
    // A repository of the burrow that GitHub (the fake) doesn't have: the credentials route refuses it.
    const elsewhere = 'whombat/elsewhere';
    await t.services.db.insert(repos).values({
      id: newId('repo'),
      burrowId: t.burrowId,
      fullName: elsewhere,
      description: '',
      defaultBranch: 'main',
      enabled: true,
      position: 99,
    });
    script = async () => {};
    const { runId, number, askedId } = await askForRun('feat/elsewhere', 'change it elsewhere', {
      repo: elsewhere,
    });
    const run = await waitFor(
      async () => ((await runRow(runId))?.status === 'failed' ? runRow(runId) : null),
      30_000,
      'the run to fail',
    );
    const said = `I couldn’t check out ${elsewhere} for run #${number}: ${elsewhere} is not connected to GitHub, then choose Try again.`;
    expect(run?.summary).toBe(said);
    // The model never ran for it.
    expect(turnsOf(runId)).toEqual([]);
    // One message in the thread, with Try again; its card says nothing else; no “Whombat couldn’t …” beside it.
    await new Promise((r) => setTimeout(r, 1000));
    const posted = await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.threadRootId, askedId), eq(messages.authorId, IDS.dusty)));
    const failures = posted.filter((m) => m.card?.kind === 'turn_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ text: said, card: { code: 'workspace', reason: said } });
    expect(posted.filter((m) => m.text.includes('Whombat couldn’t'))).toEqual([]);
    expect(posted.filter((m) => m.text.includes('..'))).toEqual([]);
    // Nothing queued for the run until a person acts.
    const queued = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.runId, runId), eq(dispatches.state, 'queued')));
    expect(queued).toEqual([]);
  });
});

// These cases use the same database and server without a model. They exercise commit/restart boundaries directly.
describe('durable reconciliation after asynchronous work', () => {
  beforeAll(async () => {
    await runner?.stop(2000);
    runner = null;
    t.services.runtime.options.sweepMs = 3_600_000;
  });

  let fixtureNumber = 0;
  const queuedFor = (runId: string) =>
    t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.runId, runId), eq(dispatches.state, 'queued')));
  async function endedRun() {
    const f = await askForRun(`feat/reconcile-${++fixtureNumber}`, 'check the saved work');
    const [turn] = await queuedFor(f.runId);
    if (!turn) throw new Error('No run turn');
    await end(turn.id);
    return { ...f, turn };
  }
  async function end(id: string) {
    await t.services.db
      .update(dispatches)
      .set({ state: 'done', finishedAt: new Date() })
      .where(eq(dispatches.id, id));
  }
  async function askApproval(turn: typeof dispatches.$inferSelect) {
    const result = await runInDispatchScope(dispatchScopeOf(turn), () =>
      t.commit(IDS.dusty, requestApproval, {
        conversationId: turn.conversationId,
        action: {
          type: 'custom',
          params: { name: 'continue the saved work', keyId: 'deploy.staging', data: {} },
        },
        whatHappens: ['Continue the saved work'],
        explainer: '',
        summary: '',
        dispatchId: turn.id,
      }),
    );
    if (result.status !== 'ok') throw new Error(`Approval: ${result.status}`);
    return result.result;
  }

  it('keeps both approval continuations on an answered stalled run and consumes no extra recovery attempt', async () => {
    const f = await endedRun();
    await afterRunTurn(t.services, f.turn.id, {});
    const [recovery] = await queuedFor(f.runId);
    if (!recovery) throw new Error('No recovery');
    await end(recovery.id);
    await afterRunTurn(t.services, recovery.id, {});
    expect((await runRow(f.runId))?.attention).toBeTruthy();
    await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      threadRootId: f.askedId,
      text: 'Please apply the changes now.',
    });
    expect((await runRow(f.runId))?.attention).toBeNull();
    const [answer] = await queuedFor(f.runId);
    if (!answer) throw new Error('No resumed turn');
    const asks = [await askApproval(answer), await askApproval(answer)];
    for (const ask of asks) {
      const [stored] = await t.services.db.select().from(approvals).where(eq(approvals.id, ask.approvalId));
      expect(stored).toMatchObject({ runId: f.runId, createdByDispatchId: answer.id });
    }
    await end(answer.id);
    await afterRunTurn(t.services, answer.id, {});
    expect((await runRow(f.runId))?.attention).toBeNull();
    for (const ask of asks)
      await t.commit(IDS.mara, decideApproval, { number: ask.number, decision: 'approve' });
    const followups = await queuedFor(f.runId);
    expect(followups).toHaveLength(2);
    for (const followup of followups) {
      expect(followup).toMatchObject({
        mode: 'run',
        runId: f.runId,
        threadRootId: f.askedId,
        trigger: 'approval_granted',
      });
      await end(followup.id);
    }
    for (const followup of followups) await afterRunTurn(t.services, followup.id, {});
    expect((await runRow(f.runId))?.attention).toBe(stalledText('Dusty'));
    await t.services.runtime.sweep();
    expect(await queuedFor(f.runId)).toEqual([]);
  });

  it.each(['turn', 'approval', 'question'] as const)('ignores an unrelated thread’s %s', async (kind) => {
    const f = await endedRun();
    const root = newId('message');
    await t.services.db.insert(messages).values({
      id: root,
      burrowId: t.burrowId,
      conversationId: IDS.billing,
      authorId: IDS.mara,
      text: 'Another task',
      createdAt: new Date(),
    });
    const [other] = await t.services.db
      .insert(dispatches)
      .values({
        ...f.turn,
        id: newId('dispatch'),
        runId: null,
        mode: 'reply',
        trigger: 'mention',
        threadRootId: root,
        messageId: root,
        state: 'queued',
        createdAt: new Date(),
        finishedAt: null,
      })
      .returning();
    if (!other) throw new Error('No other turn');
    if (kind !== 'turn') await end(other.id);
    if (kind === 'approval') await askApproval(other);
    if (kind === 'question')
      await runInDispatchScope(dispatchScopeOf(other), () =>
        t.commit(IDS.dusty, sendMessage, {
          conversationId: IDS.billing,
          threadRootId: root,
          text: 'Which time for the other task?',
          asks: true,
        }),
      );
    await afterRunTurn(t.services, f.turn.id, {});
    expect((await runRow(f.runId))?.attention).toBeNull();
    expect((await runRow(f.runId))?.stalledAt).not.toBeNull();
    expect(await queuedFor(f.runId)).toHaveLength(1);
  });

  it('repairs a saved completion with a lost callback, and concurrent sweeps queue only one recovery', async () => {
    const f = await endedRun();
    await Promise.all([t.services.runtime.sweep(), t.services.runtime.sweep()]);
    const [recovery] = await queuedFor(f.runId);
    expect(await queuedFor(f.runId)).toHaveLength(1);
    if (!recovery) throw new Error('No recovery');
    await end(recovery.id);
    // The recovery turn’s callback is lost too: the durable run is still found.
    await t.services.runtime.sweep();
    expect((await runRow(f.runId))?.attention).toBe(stalledText('Dusty'));
    expect(await queuedFor(f.runId)).toEqual([]);
  });

  it('repairs a historical live record after an unassociated approval reply ended', async () => {
    const f = await endedRun();
    await t.services.db.update(runs).set({ stalledAt: new Date() }).where(eq(runs.id, f.runId));
    const replyId = newId('dispatch');
    await t.services.db.insert(dispatches).values({
      ...f.turn,
      id: replyId,
      runId: null,
      mode: 'reply',
      trigger: 'approval_granted',
      state: 'done',
      createdAt: new Date(),
      finishedAt: new Date(),
    });
    await afterRunTurn(t.services, replyId, {});
    expect((await runRow(f.runId))?.attention).toBeNull();
    await t.services.runtime.sweep();
    expect((await runRow(f.runId))?.attention).toBe(stalledText('Dusty'));
    expect(await queuedFor(f.runId)).toEqual([]);
  });

  it('waits for an approved action still executing and recovers after execution fails', async () => {
    const f = await endedRun();
    const ask = await askApproval(f.turn);
    await t.services.db
      .update(approvals)
      .set({
        state: 'approved',
        execution: {
          state: 'running',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          durationMs: null,
          error: null,
          resultUrl: null,
        },
      })
      .where(eq(approvals.id, ask.approvalId));
    await t.services.runtime.sweep();
    expect((await runRow(f.runId))?.stalledAt).toBeNull();
    expect(await queuedFor(f.runId)).toEqual([]);
    await t.services.approvals.completeDeferred(ask.approvalId, { ok: false, error: 'The action failed.' });
    await t.services.runtime.sweep();
    expect(await queuedFor(f.runId)).toHaveLength(1);
  });

  it('carries a decline into a run turn', async () => {
    const f = await endedRun();
    const ask = await askApproval(f.turn);
    await t.commit(IDS.mara, decideApproval, { number: ask.number, decision: 'decline' });
    const [followup] = await queuedFor(f.runId);
    expect(followup).toMatchObject({ trigger: 'approval_declined', mode: 'run', threadRootId: f.askedId });
  });

  it.each(['paused', 'taken_over', 'done'] as const)('does not resume a %s run', async (status) => {
    const f = await endedRun();
    const ask = await askApproval(f.turn);
    await t.services.db.update(runs).set({ status }).where(eq(runs.id, f.runId));
    await t.services.db.update(approvals).set({ state: 'approved' }).where(eq(approvals.id, ask.approvalId));
    await t.commit(IDS.mara, wakeForApproval, { approvalId: ask.approvalId });
    await t.services.runtime.sweep();
    expect(await queuedFor(f.runId)).toEqual([]);
    expect((await runRow(f.runId))?.status).toBe(status);
  });

  it('shows a cancelled turn’s recorded question without restarting it', async () => {
    const f = await endedRun();
    const question = 'Which destination should I use?';
    await runInDispatchScope(dispatchScopeOf(f.turn), () =>
      t.commit(IDS.dusty, sendMessage, {
        conversationId: IDS.billing,
        threadRootId: f.askedId,
        text: question,
        asks: true,
      }),
    );
    await t.services.db
      .update(dispatches)
      .set({ state: 'cancelled', stoppedById: IDS.mara })
      .where(eq(dispatches.id, f.turn.id));
    await t.services.runtime.sweep();
    expect(await queuedFor(f.runId)).toEqual([]);
    expect((await runRow(f.runId))?.attention).toBe(question);
  });

  it('never wakes again when a person stopped the last turn', async () => {
    const f = await endedRun();
    await t.services.db
      .update(dispatches)
      .set({ state: 'cancelled', stoppedById: IDS.mara })
      .where(eq(dispatches.id, f.turn.id));
    await t.services.runtime.sweep();
    expect(await queuedFor(f.runId)).toEqual([]);
    expect((await runRow(f.runId))?.attention).toBe(stalledText('Dusty'));
  });
});
