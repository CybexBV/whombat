/**
 * Approving an agent's push to a shared branch lets it push (docs/decisions/essentials-agents.md EA-05…EA-07), end to
 * end: real Postgres, the real server over HTTP, the real runner with a FAKE PROVIDER (no model) and FakeGitHub backed
 * by a bare repository on disk. Dusty's “Push to shared branches” asks, so:
 *
 *   ask (the runner's push after the turn) → yes → wake (`approval_granted`, the approval in its context, the branch's
 *   workspace) → the push goes through under the approval → the approval is executed: “Allowed Dusty to push …”.
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
import { createRunnerApi, type ProviderRegistry, Runner, testPolicy } from '@whombat/runner';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { startRun } from '../commands/agent-runs';
import { decideApproval } from '../commands/approvals';
import { loadConfig } from '../config';
import { approvals, dispatches, events, principals } from '../db/schema/index';
import { MemoryMailer } from '../mail/mailer';
import { loadSeedWorld } from '../seed/load';
import { IDS, TEST_BURROW_ID, testWorld } from '../seed/test-world';
import { createServices, type Services } from '../services';
import { setGrant } from '../test/approvals';
import { useTestDb } from '../test/db';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { logServerErrors, testLogger } from '../test/log';
import { waitFor } from '../test/runner';
import { SCRIPTED_ENV, scripted } from '../test/scripted';
import { agentTokenFor } from '../test/tokens';

const REPO = 'whombat/billing';
const BRANCH = 'release/2.1';
const testDb = useTestDb();
const root = mkdtempSync(join(tmpdir(), 'whombat-push-approval-'));
const dirs = { git: join(root, 'github'), workspaces: join(root, 'workspaces'), home: join(root, 'home') };
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
  git(work, 'branch', BRANCH);
  mkdirSync(join(dirs.git, 'whombat'), { recursive: true });
  git(root, 'clone', '--quiet', '--bare', work, join(dirs.git, 'whombat', 'billing.git'));
}

/** What each of Dusty's turns got and did. */
const turns: { input: TurnInput; committed: string | null; done: boolean }[] = [];

/** Dusty: commits a fix when its workspace is writable, else only says the push is going out. */
const banjo: AgentProvider = {
  kind: 'claude',
  available: async () => ({ ok: true, version: 'fake' }),
  capabilities: () => BASIC_CAPABILITIES,
  async *runTurn(input): AsyncIterable<TurnEvent> {
    const turn = { input, committed: null as string | null, done: false };
    turns.push(turn);
    const mcp = await connectWhombatMcp(input.mcp);
    try {
      let text = 'Pushing it now.';
      if (input.context.workspace && input.sandbox === 'workspace-write') {
        writeFileSync(join(input.cwd, 'src', 'vat.js'), 'export const vat = (n) => Math.round(n * 0.21);\n');
        git(input.cwd, 'add', '.');
        git(input.cwd, 'commit', '--quiet', '-m', 'Round VAT on the release');
        turn.committed = git(input.cwd, 'rev-parse', 'HEAD');
        text = 'Fixed on the release branch.';
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
  services = createServices({ config, sql: testDb.sql, mailer: new MemoryMailer(), log });
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
  // Writing and pushing the release branch asks a person first.
  await setGrant(services, IDS.dusty, 'branch.shared.push', 'ask');
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
  await services.github.idle().catch(() => {});
  await app.close();
  services.typing.close();
  execFileSync('chmod', ['-R', 'u+w', root]);
  rmSync(root, { recursive: true, force: true });
});

const bare = join(dirs.git, `${REPO}.git`);
const onGitHub = (ref: string) => git(bare, 'rev-parse', ref);

async function approve(number: number) {
  const res = await services.pipeline.commit(
    decideApproval,
    { number, decision: 'approve' },
    { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
  );
  expect(res.status).toBe('ok');
}

const pending = (where: ReturnType<typeof and>) =>
  waitFor(
    async () => {
      const [row] = await services.db.select().from(approvals).where(where);
      return row ?? null;
    },
    20_000,
    'the request',
  );

describe('ask → yes → wake → push → executed', () => {
  it('a yes to Dusty’s push of the release branch lets exactly that commit through', async () => {
    const before = onGitHub(BRANCH);
    // Dusty starts a run on the release branch (its key asks); a person approves, so the run's turn may write there.
    const asking = await agentTokenFor(services, TEST_BURROW_ID, IDS.dusty, IDS.billing);
    const started = await services.pipeline.commit(
      startRun,
      {
        conversationId: IDS.billing,
        title: 'Round VAT on the release',
        repo: REPO,
        branch: BRANCH,
        steps: [{ title: 'Fix it', detail: '' }],
        dispatchId: asking.dispatchId,
      },
      { burrowId: TEST_BURROW_ID, actorId: IDS.dusty },
    );
    if (started.status !== 'pending_approval') throw new Error(`start_run: ${started.status}`);
    await services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, asking.dispatchId));
    await approve(started.approvalNumber);

    // The run's turn commits; its push after the turn asks a person for exactly that commit.
    const fixed = await waitFor(() => turns.find((t) => t.committed && t.done) ?? null, 25_000, 'the fix');
    const sha = fixed.committed as string;
    const push = await pending(
      and(
        eq(approvals.requesterId, IDS.dusty),
        eq(approvals.state, 'pending'),
        eq(approvals.keyId, 'branch.shared.push'),
      ),
    );
    expect(push).toMatchObject({
      conversationId: IDS.billing,
      title: `Push ${sha.slice(0, 6)} to ${BRANCH}`,
      action: { type: 'push_shared_branch', params: { repo: REPO, branch: BRANCH, sha } },
    });
    expect(onGitHub(BRANCH)).toBe(before);

    // Yes → Dusty is woken there with the approval; its turn pushes exactly that commit.
    const woke = turns.length;
    await approve(push.number);
    const wake = await waitFor(
      async () => {
        const rows = await services.db.select().from(dispatches).where(eq(dispatches.approvalId, push.id));
        return rows.length ? rows : null;
      },
      10_000,
      'the wake',
    );
    expect(wake).toHaveLength(1);
    expect(wake[0]).toMatchObject({
      agentId: IDS.dusty,
      trigger: 'approval_granted',
      mode: 'run',
      runId: fixed.input.context.run?.id,
      conversationId: IDS.billing,
    });
    const pushed = await waitFor(
      async () => {
        const [row] = await services.db.select().from(approvals).where(eq(approvals.id, push.id));
        return row?.executedAt ? row : null;
      },
      25_000,
      'the push under the approval',
    );
    expect(pushed.execution.state).toBe('succeeded');
    // The credential completes the approval; git's push lands right after it.
    await waitFor(() => onGitHub(BRANCH) === sha, 15_000, 'the commit on GitHub');

    const turn = turns.slice(woke).find((t) => t.input.context.dispatch.trigger === 'approval_granted');
    expect(turn?.input.context.grantedApproval).toMatchObject({ id: push.id, decidedById: IDS.mara });
    expect(turn?.input.context.workspace).toMatchObject({ repo: REPO, branch: BRANCH, writeApproved: false });
    // It couldn't change what was approved: its sandbox stays read-only under a key that asks.
    expect(turn?.input.sandbox).toBe('read-only');
    expect(turn?.committed).toBeNull();
    expect(turn?.input.prompt).toContain(`approved your push of ${sha.slice(0, 6)} to ${BRANCH} in ${REPO}`);

    const [executed] = await services.db
      .select()
      .from(events)
      .where(and(eq(events.approvalId, push.id), eq(events.type, 'approval.executed')));
    expect(executed).toMatchObject({ actorId: IDS.dusty, text: `Allowed Dusty to push ${BRANCH}` });
  }, 90_000);
});
