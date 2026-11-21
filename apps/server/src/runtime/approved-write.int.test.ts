/**
 * A person's approval of writing a branch reaches the sandbox (docs/decisions/bp-automations.md BP-C37), end to end:
 * real Postgres, the real server over HTTP, the real runner with a FAKE PROVIDER (no model) that commits only when its
 * sandbox is writable, and FakeGitHub backed by a bare repository on disk. Dusty's “Read and write feat/* branches”
 * asks, so:
 *
 *  A. an automation's coding step asks a person first; once approved, the dispatch says so (`writeApproved`), the
 *     turn is writable, the commit lands and the runner pushes it under that approval;
 *  B. an agent's `start_run` asks; once approved, the agent woken on the run gets a writable worktree of exactly the
 *     run's branch and commits (its push still asks, as before);
 *  C. a `start_run` the agent may make without asking, from a turn without a checkout, goes on in a run turn with one
 *     (docs/decisions/run-checkout.md RC-01);
 *
 * and neither holds for a branch whose key is No, nor for a turn nobody approved.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentProvider,
  BASIC_CAPABILITIES,
  connectWhombatMcp,
  type TurnEvent,
  type TurnInput,
} from '@whombat/agent-runtime';
import { type AutomationDefinitionInput, definitionHash, validateDefinition } from '@whombat/core';
import { createRunnerApi, type ProviderRegistry, Runner, sandboxFor, testPolicy } from '@whombat/runner';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app';
import { createAutomation, publishAutomationDraft } from '../automations/commands';
import { loadAutomationRow, loadRunRow, toRun } from '../automations/store';
import { finishRun, startRun } from '../commands/agent-runs';
import { decideApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import type { CommandDef } from '../commit/types';
import { loadConfig } from '../config';
import { approvals, automationRuns, dispatches, grants, principals, runs } from '../db/schema/index';
import { MemoryMailer } from '../mail/mailer';
import { loadSeedWorld } from '../seed/load';
import { IDS, TEST_BURROW_ID, testWorld } from '../seed/test-world';
import { createServices, type Services } from '../services';
import { BUSY_POOL_SIZE, useTestDb } from '../test/db';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { logServerErrors, testLogger } from '../test/log';
import { waitFor } from '../test/runner';
import { SCRIPTED_ENV, scripted } from '../test/scripted';
import { agentTokenFor } from '../test/tokens';
import { buildDispatchContext } from './context';

const REPO = 'whombat/billing';
const BILLING = IDS.billing;

const testDb = useTestDb({ poolSize: BUSY_POOL_SIZE });
const root = mkdtempSync(join(tmpdir(), 'whombat-approved-write-'));
const dirs = {
  git: join(root, 'github'),
  workspaces: join(root, 'workspaces'),
  home: join(root, 'home'),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Seed',
      GIT_AUTHOR_EMAIL: 'seed@example.invalid',
      GIT_COMMITTER_NAME: 'Seed',
      GIT_COMMITTER_EMAIL: 'seed@example.invalid',
    },
  }).trim();

function seedBareRepo() {
  const work = join(root, 'seed');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'vat.js'), 'export const vat = (n) => n * 0.21;\n');
  git(work, 'init', '--quiet', '--initial-branch=main');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'Billing');
  mkdirSync(join(dirs.git, 'whombat'), { recursive: true });
  git(root, 'clone', '--quiet', '--bare', work, join(dirs.git, 'whombat', 'billing.git'));
}

/** What each of Dusty's turns got, what it managed to commit, and whether the turn has ended. */
const turns: { input: TurnInput; committed: string | null; done: boolean }[] = [];

/** Dusty: commits a change when (and only when) its sandbox is writable, then says so in the thread. */
const banjo: AgentProvider = {
  kind: 'claude',
  available: async () => ({ ok: true, version: 'fake' }),
  capabilities: () => BASIC_CAPABILITIES,
  async *runTurn(input): AsyncIterable<TurnEvent> {
    const turn = { input, committed: null as string | null, done: false };
    turns.push(turn);
    const mcp = await connectWhombatMcp(input.mcp);
    try {
      let text = 'I can only read here.';
      if (input.context.workspace && input.sandbox === 'workspace-write') {
        writeFileSync(join(input.cwd, 'src', 'vat.js'), 'export const vat = (n) => Math.round(n * 0.21);\n');
        git(input.cwd, 'add', '.');
        git(input.cwd, 'commit', '--quiet', '-m', 'Round VAT');
        turn.committed = git(input.cwd, 'log', '-1', '--format=%s');
        text = 'Fixed: VAT is rounded.';
      }
      const rootId = input.context.dispatch.threadRootId;
      yield { type: 'tool_call', name: rootId ? 'reply_in_thread' : 'post_message', input: {} };
      if (rootId) await mcp.call('reply_in_thread', { messageId: rootId, text });
      else await mcp.call('post_message', { conversationId: input.context.conversation.id, text });
      yield { type: 'final', text: '' };
    } finally {
      await mcp.close();
      turn.done = true;
    }
  },
};
const registry: ProviderRegistry = scripted({
  claims: () => ['claude'],
  for: (kind) => (kind === 'claude' ? banjo : null),
  report: () => [],
});

let services: Services;
let app: FastifyInstance;
let runner: Runner | null = null;

beforeAll(async () => {
  seedBareRepo();
  const config = loadConfig({
    ...SCRIPTED_ENV,
    ...signInsEnv(),
    WHOMBAT_GITHUB: 'fake',
    WHOMBAT_FAKE_GITHUB_GIT_ROOT: dirs.git,
    WHOMBAT_FILES_DIR: join(root, 'files'),
    WHOMBAT_GITHUB_POLL_MS: '0',
    DATABASE_URL: testDb.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });
  const log = testLogger();
  services = createServices({
    config,
    sql: testDb.sql,
    mailer: new MemoryMailer(),
    log,
    // The only engine on this database acts at once instead of after the production handover's two 5 s lock checks.
    automations: { lockCheckMs: 50 },
  });
  app = await buildApp({ services, logger: false });
  logServerErrors(app, log);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;
  await loadSeedWorld(services, testWorld());
  await connectGitHubAs(services, IDS.mara);
  await services.db
    .update(principals)
    .set({ runtime: { provider: 'claude' } })
    .where(eq(principals.id, IDS.dusty));
  // Dusty's feat/* key asks: every write of a feature branch needs a person first.
  await setBanjo('ask');
  services.automations.start();
  runner = new Runner({
    api: createRunnerApi(baseUrl, 'dev-runner-token'),
    registry,
    managed: testPolicy(),
    serverUrl: baseUrl,
    workspacesRoot: dirs.workspaces,
    host: { home: tmpdir(), whombatHome: dirs.home },
    waitMs: 300,
    heartbeatMs: 200,
    progressMs: 50,
  });
  runner.start();
}, 120_000);

afterAll(async () => {
  await runner?.stop(3000);
  await services.automations.close();
  await services.github.idle().catch(() => {});
  // The stopped runner's requests still open (its last long poll, MCP streams) would hold app.close() until they time
  // out, about 70 s: end them first.
  app.server.closeAllConnections();
  await app.close();
  services.typing.close();
  execFileSync('chmod', ['-R', 'u+w', root]);
  rmSync(root, { recursive: true, force: true });
});

async function setBanjo(tier: 'can' | 'ask' | 'cannot') {
  await services.db
    .update(grants)
    .set({ tier })
    .where(and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, 'branch.feature.readwrite')));
}

async function ok<S extends z.ZodType, R>(actorId: string, command: CommandDef<S, R>, input: z.input<S>) {
  const res = await services.pipeline.commit(command, input, { burrowId: TEST_BURROW_ID, actorId });
  if (res.status !== 'ok') throw new Error(`${command.name}: ${res.status}`);
  return res.result;
}

const bare = join(dirs.git, `${REPO}.git`);
const onGitHub = (branch: string) => {
  try {
    return git(bare, 'log', '-1', '--format=%s', branch);
  } catch {
    return null;
  }
};

describe('A · an automation’s coding step whose branch key asks', () => {
  it('is writable once a person approved it; the commit is pushed under that approval', async () => {
    const definition: AutomationDefinitionInput = {
      version: 1,
      conversationId: BILLING,
      triggers: [{ kind: 'message_posted', conversationId: BILLING, contains: ['wobbly'] }],
      steps: [
        {
          id: 'implement',
          kind: 'dispatch_agent',
          prompt: 'Fix it: {{trigger.text}}',
          workspace: { repo: REPO, branch: 'feat/vat-{{run.number}}', access: 'write' },
        },
      ],
      limits: { runTimeoutMinutes: 600, maxConcurrentRuns: 2, maxRunsPerDay: 20 },
    };
    const { automationId } = await ok(IDS.mara, createAutomation, {
      name: 'Fix VAT',
      source: {
        kind: 'import',
        file: { whombat: 'automation', name: 'Fix VAT', description: '', definition },
      },
    });
    const row = await loadAutomationRow(services.db, TEST_BURROW_ID, automationId);
    const check = validateDefinition(row.draftJson);
    if (!check.ok) throw new Error(check.problems.join(' '));
    await ok(IDS.mara, publishAutomationDraft, {
      automationId,
      enable: true,
      definitionHash: definitionHash(check.definition),
    });
    await ok(IDS.mara, sendMessage, {
      conversationId: BILLING,
      text: 'VAT is wobbly on invoices',
    });
    const [pending] = await waitFor(
      async () => {
        const rows = await services.db
          .select()
          .from(approvals)
          .where(and(eq(approvals.keyId, 'branch.feature.readwrite'), eq(approvals.state, 'pending')));
        return rows.length ? rows : null;
      },
      15_000,
      'the branch request',
    );
    // Nobody works before the approval.
    expect(turns).toHaveLength(0);
    await ok(IDS.mara, decideApproval, {
      number: pending?.number as number,
      decision: 'approve',
    });
    const [runRow] = await services.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId));
    const run = await waitFor(
      async () => {
        const r = await toRun(services.db, await loadRunRow(services.db, runRow?.id as string));
        return ['succeeded', 'failed', 'needs_review', 'cancelled'].includes(r.status) ? r : null;
      },
      25_000,
      'the run to end',
    );
    const branch = `feat/vat-${run.number}`;
    const turn = turns.at(-1);
    expect(turn?.input.context.workspace).toMatchObject({
      repo: REPO,
      branch,
      defaultBranch: 'main',
      access: 'write',
      writeApproved: true,
    });
    expect(turn?.input.sandbox).toBe('workspace-write');
    expect(turn?.committed).toBe('Round VAT');
    // The runner pushed it under the approval; the step saw the new commit.
    expect(onGitHub(branch)).toBe('Round VAT');
    expect(run.steps[0]?.state).toBe('succeeded');
    expect(run.steps[0]?.output.commits).toBe(1);
    expect(run.status).toBe('succeeded');
  });
});

describe('B · an agent’s start_run whose branch key asks', () => {
  it('wakes the agent in a writable worktree of exactly the run’s branch once approved', async () => {
    const before = turns.length;
    // The turn Dusty asked from (it ended when the tool said a person has to approve).
    const asking = await agentTokenFor(services, TEST_BURROW_ID, IDS.dusty, BILLING);
    const branch = 'feat/vat-hotfix';
    const res = await services.pipeline.commit(
      startRun,
      {
        conversationId: BILLING,
        title: 'Round the VAT',
        repo: REPO,
        branch,
        steps: [{ title: 'Fix it', detail: '' }],
        dispatchId: asking.dispatchId,
      },
      { burrowId: TEST_BURROW_ID, actorId: IDS.dusty },
    );
    expect(res.status).toBe('pending_approval');
    if (res.status !== 'pending_approval') return;
    await services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, asking.dispatchId));
    expect(turns.length).toBe(before);
    await ok(IDS.mara, decideApproval, {
      number: res.approvalNumber,
      decision: 'approve',
    });
    const turn = await waitFor(
      // The turn is recorded when it starts; wait until it has ended (and so committed, if it could).
      () => turns.slice(before).find((t) => t.input.context.dispatch.mode === 'run' && t.done) ?? null,
      20_000,
      'the woken run turn to finish',
    );
    expect(turn.input.context.workspace).toMatchObject({
      repo: REPO,
      branch,
      defaultBranch: 'main',
      access: 'write',
      writeApproved: true,
    });
    expect(turn.input.sandbox).toBe('workspace-write');
    expect(turn.committed).toBe('Round VAT');
    // Its push still asks per push (bp-automations known limits): a person is asked, nothing reached GitHub yet.
    const [run] = await services.db.select().from(runs).where(eq(runs.branch, branch));
    const pushAsk = await waitFor(
      async () => {
        const rows = await services.db
          .select()
          .from(approvals)
          .where(and(eq(approvals.keyId, 'branch.feature.readwrite'), eq(approvals.state, 'pending')));
        return rows.find((a) => a.target.includes(branch) || a.title.includes(branch)) ?? null;
      },
      15_000,
      'the push request',
    );
    expect(pushAsk).toBeTruthy();
    expect(onGitHub(branch)).toBeNull();

    // Once the key is No, the approval no longer makes a turn writable (the runner decides the key again).
    await setBanjo('cannot');
    const ctx = await buildContextFor(run?.id as string);
    expect(ctx.workspace?.writeApproved).toBe(true);
    expect(sandboxFor(ctx)).toBe('read-only');
    await setBanjo('ask');
  });

  it('a run nobody approved is not writable', async () => {
    const asking = await agentTokenFor(services, TEST_BURROW_ID, IDS.dusty, BILLING);
    // Started while the key allowed it, then the key asks: that run carries no approval.
    await setBanjo('can');
    const res = await services.pipeline.commit(
      startRun,
      {
        conversationId: BILLING,
        title: 'Tidy the totals',
        repo: REPO,
        branch: 'feat/tidy',
        steps: [{ title: 'Tidy', detail: '' }],
        dispatchId: asking.dispatchId,
      },
      { burrowId: TEST_BURROW_ID, actorId: IDS.dusty },
    );
    await setBanjo('ask');
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    await services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, asking.dispatchId));
    const ctx = await buildContextFor(res.result.runId);
    expect(ctx.workspace).toMatchObject({ branch: 'feat/tidy', writeApproved: false });
  });
});

describe('C · a run the agent may start without asking (RC-01)', () => {
  it('goes on in a run turn with a checkout of its branch, answering where it was asked', async () => {
    await setBanjo('can');
    const before = turns.length;
    // Asked in a thread: the turn that starts the run has no checkout.
    const asked = await ok(IDS.mara, sendMessage, { conversationId: BILLING, text: 'Round the VAT please' });
    const asking = await agentTokenFor(services, TEST_BURROW_ID, IDS.dusty, BILLING, {
      messageId: asked.id,
      threadRootId: asked.id,
    });
    const branch = 'feat/vat-round';
    const { runId } = await ok(IDS.dusty, startRun, {
      conversationId: BILLING,
      title: 'Round the VAT',
      repo: REPO,
      branch,
      steps: [{ title: 'Fix it', detail: '' }],
      dispatchId: asking.dispatchId,
    });
    // Queued while the starting turn still runs; it starts once that one ended.
    const queued = await waitFor(
      async () => {
        const rows = await services.db.select().from(dispatches).where(eq(dispatches.runId, runId));
        return rows[0] ?? null;
      },
      10_000,
      'the run turn',
    );
    expect(queued).toMatchObject({
      trigger: 'run_control',
      mode: 'run',
      state: 'queued',
      messageId: asked.id,
      threadRootId: asked.id,
    });
    await services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, asking.dispatchId));
    const turn = await waitFor(
      () =>
        turns
          .slice(before)
          .find(
            (t) => t.input.context.dispatch.mode === 'run' && t.input.context.run?.id === runId && t.done,
          ) ?? null,
      20_000,
      'the run turn to finish',
    );
    expect(turn.input.context.workspace).toMatchObject({ repo: REPO, branch, access: 'write' });
    expect(turn.input.sandbox).toBe('workspace-write');
    expect(turn.committed).toBe('Round VAT');
    // Dusty may write feat/*: the runner pushes what it committed.
    await waitFor(async () => onGitHub(branch), 15_000, 'the push');
    // A run turn of the run on its own branch starts nothing more.
    expect(await services.db.select().from(dispatches).where(eq(dispatches.runId, runId))).toHaveLength(1);
    await setBanjo('ask');
  });

  it('a run finished in its starting turn drops its run turn, queued or already claimed', async () => {
    await setBanjo('can');
    const asking = await agentTokenFor(services, TEST_BURROW_ID, IDS.dusty, BILLING);
    const { runId, number } = await ok(IDS.dusty, startRun, {
      conversationId: BILLING,
      title: 'Never mind',
      repo: REPO,
      branch: 'feat/never-mind',
      steps: [{ title: 'Look', detail: '' }],
      dispatchId: asking.dispatchId,
    });
    await waitFor(
      async () => (await services.db.select().from(dispatches).where(eq(dispatches.runId, runId)))[0] ?? null,
      10_000,
      'the run turn',
    );
    await ok(IDS.dusty, finishRun, {
      run: number,
      outcome: 'failed',
      summary: 'Not needed.',
      dispatchId: asking.dispatchId,
    });
    // Still queued, it is dropped at once; already claimed beside the starting turn (HRS-01), it is told to stop and
    // ends cancelled at its next beat (HRS-06).
    const dropped = await waitFor(
      async () => {
        const [d] = await services.db.select().from(dispatches).where(eq(dispatches.runId, runId));
        return d?.state === 'cancelled' ? d : null;
      },
      10_000,
      'the run turn dropped',
    );
    expect(dropped.cancelReason).toBe('cancelled');
    await services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, asking.dispatchId));
    await setBanjo('ask');
  });
});

/** The context a run-mode dispatch of the run would get (without handing out a real dispatch). */
async function buildContextFor(runId: string) {
  const asking = await agentTokenFor(services, TEST_BURROW_ID, IDS.dusty, BILLING);
  await services.db
    .update(dispatches)
    .set({ runId, mode: 'run', trigger: 'run_control' })
    .where(eq(dispatches.id, asking.dispatchId));
  const [row] = await services.db.select().from(dispatches).where(eq(dispatches.id, asking.dispatchId));
  const ctx = await buildDispatchContext(services, row as NonNullable<typeof row>);
  await services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, asking.dispatchId));
  return ctx;
}
