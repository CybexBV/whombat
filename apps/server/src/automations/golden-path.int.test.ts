/**
 * The integrated golden path (buzz-parity A–E), deterministic: real Postgres, the real server over HTTP, the real
 * runner with FAKE PROVIDERS (no model), FakeGitHub backed by a bare git repository on disk.
 *
 *  1. Mara (in billing-v2) uploads a screenshot and reports a suspected bug.
 *  2. The “Suspected bug” automation (published by Mara from the template, `pr.open` for the repo) dispatches Dusty in
 *     the run's thread in Mara's Chat (where a run posts, automations/rooms.ts); the turn gets the image bytes, the
 *     approved and sourced room knowledge.
 *  3. Dusty publishes an evidence artifact; the automation posts the evidence and asks a person to approve.
 *  4. Server AND runner restart while the approval is pending; Mara approves the exact request; the run continues
 *     without replaying anything it already did.
 *  5. Dusty fixes it in an isolated worktree of the bare repo on `feat/bug-N` and commits; the runner pushes; a fresh
 *     turn of Dusty (no session of the fix, one-agent.md OA-15) reads the branch from a read-only checkout (with its
 *     diff) and says “Approve”.
 *  6. The pull request is opened on FakeGitHub and the report lands in the run's thread.
 *  7. The agent cannot decide or escalate.
 *
 * The investigator reads the code too: its turn has a read-only checkout of the base (bp-automations BP-C26).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { decideApproval } from '../commands/approvals';
import { loadConfig } from '../config';
import { approvals, automationRuns, dispatches, events, messages, principals } from '../db/schema/index';
import { MemoryMailer } from '../mail/mailer';
import { providerLogins } from '../managed/providers/service';
import { loadSeedWorld } from '../seed/load';
import { IDS, TEST_BURROW_ID, testWorld } from '../seed/test-world';
import { createServices, type Services } from '../services';
import { inProcessApi } from '../test/api';
import { BUSY_POOL_SIZE, useTestDb } from '../test/db';
import { makePng } from '../test/files';
import { connectGitHubAs, FAKE_GH, signInsEnv } from '../test/github';
import { logServerErrors, testLogger } from '../test/log';
import { waitFor } from '../test/runner';
import { SCRIPTED_ENV, scripted } from '../test/scripted';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { loadRunRow, toRun } from './store';

const REPO = 'whombat/billing';
const BILLING = IDS.billing;
const API = '/api/v1/burrows/burrow-hq';

const testDb = useTestDb({ poolSize: BUSY_POOL_SIZE });
const root = mkdtempSync(join(tmpdir(), 'whombat-golden-'));
const dirs = {
  git: join(root, 'github'),
  files: join(root, 'files'),
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

/** whombat/billing on “GitHub”: a small repo whose invoice total rounds VAT once at the end (the bug). */
function seedBareRepo() {
  const work = join(root, 'seed');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(
    join(work, 'src', 'vat.js'),
    [
      'export const lineVat = (netCents, rate) => (netCents * rate) / 100;',
      'export function invoiceTotal(lines) {',
      '  let net = 0;',
      '  let vat = 0;',
      '  for (const l of lines) { net += l.netCents; vat += lineVat(l.netCents, l.rate); }',
      '  return net + Math.round(vat);',
      '}',
      '',
    ].join('\n'),
  );
  git(work, 'init', '--quiet', '--initial-branch=main');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'Billing: VAT and totals');
  mkdirSync(join(dirs.git, 'whombat'), { recursive: true });
  git(root, 'clone', '--quiet', '--bare', work, join(dirs.git, 'whombat', 'billing.git'));
}

/* The fake providers --------------------------------------------------------------------------------------------- */

interface Seen {
  investigator?: TurnInput & { imageSha?: string; code?: string };
  developer?: TurnInput;
  reviewer?: TurnInput & { code?: string };
  artifactId?: string;
}
/** What a read-only turn sees of the repo in its working directory. */
const codeIn = (cwd: string) => {
  try {
    return readFileSync(join(cwd, 'src', 'vat.js'), 'utf8');
  } catch {
    return undefined;
  }
};
const seen: Seen = {};
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * A provider that answers like the agent, per step of the run, through Whombat's MCP (never the model): the fix has a
 * writable checkout, the review the branch's changes in its prompt, the investigation neither.
 */
function fakeProvider(kind: 'claude' | 'codex'): AgentProvider {
  return {
    kind,
    available: async () => ({ ok: true, version: 'fake' }),
    capabilities: () => ({ ...BASIC_CAPABILITIES, images: true }),
    async *runTurn(input): AsyncIterable<TurnEvent> {
      const role =
        input.context.workspace?.access === 'write'
          ? 'developer'
          : input.prompt.includes('[[changes ')
            ? 'reviewer'
            : 'investigator';
      const rootId = input.context.thread?.root.id ?? input.context.dispatch.threadRootId ?? '';
      const mcp = await connectWhombatMcp(input.mcp);
      try {
        if (role === 'investigator') {
          // The image as the provider gets it: a file the runner fetched and checked.
          const image = input.attachments?.find((a) => a.kind === 'image');
          seen.investigator = {
            ...input,
            ...(image ? { imageSha: sha256(readFileSync(image.path)) } : {}),
            code: codeIn(input.cwd),
          };
          yield { type: 'tool_call', name: 'upload_file', input: {} };
          const up = await mcp.call('upload_file', {
            conversationId: input.context.conversation.id,
            name: 'evidence.txt',
            text: 'Trace QUOKKA-5521: 2 × 225 half-cents summed then rounded once → 545, per line → 546.',
          });
          seen.artifactId = String(up.body.attachmentId);
          yield { type: 'tool_call', name: 'reply_in_thread', input: {} };
          await mcp.call('reply_in_thread', {
            messageId: rootId,
            text: 'invoiceTotal rounds the summed VAT once (src/vat.js). Round per line (FIN-ROUND-12).',
            attachmentIds: [seen.artifactId],
          });
          yield { type: 'final', text: '' };
          return;
        }
        if (role === 'developer') {
          seen.developer = input;
          const ws = input.context.workspace;
          if (ws && input.sandbox === 'workspace-write') {
            writeFileSync(
              join(input.cwd, 'src', 'vat.js'),
              [
                'export const lineVat = (netCents, rate) => Math.round((netCents * rate) / 100);',
                'export function invoiceTotal(lines) {',
                '  return lines.reduce((t, l) => t + l.netCents + lineVat(l.netCents, l.rate), 0);',
                '}',
                '',
              ].join('\n'),
            );
            git(input.cwd, 'add', '.');
            git(input.cwd, 'commit', '--quiet', '-m', 'Round VAT per line');
            yield { type: 'tool_call', name: 'reply_in_thread', input: {} };
            await mcp.call('reply_in_thread', { messageId: rootId, text: 'Fixed: VAT rounded per line.' });
          } else {
            yield { type: 'tool_call', name: 'reply_in_thread', input: {} };
            await mcp.call('reply_in_thread', {
              messageId: rootId,
              text: 'I have no workspace to fix it in.',
            });
          }
          yield { type: 'final', text: '' };
          return;
        }
        if (role === 'reviewer') {
          seen.reviewer = { ...input, code: codeIn(input.cwd) };
          yield { type: 'tool_call', name: 'reply_in_thread', input: {} };
          await mcp.call('reply_in_thread', {
            messageId: rootId,
            text: 'Approve: VAT is rounded per line now, and the total matches finance.',
          });
          yield { type: 'final', text: '' };
          return;
        }
      } finally {
        await mcp.close();
      }
    },
  };
}

const providers = { claude: fakeProvider('claude'), codex: fakeProvider('codex') };
const registry: ProviderRegistry = scripted({
  claims: () => ['claude', 'codex'],
  for: (kind) => (kind === 'claude' || kind === 'codex' ? providers[kind] : null),
  report: () => [],
});

/* Server + runner that restart together --------------------------------------------------------------------------- */

let services: Services;
let app: FastifyInstance;
let runner: Runner | null = null;
let port = 0;
let baseUrl = '';
/** The sign-ins outlive a restart, like the box's credentials root. */
const signIns = signInsEnv();

async function boot() {
  const config = loadConfig({
    ...SCRIPTED_ENV,
    ...signIns,
    WHOMBAT_GITHUB: 'fake',
    WHOMBAT_FAKE_GITHUB_GIT_ROOT: dirs.git,
    WHOMBAT_FILES_DIR: dirs.files,
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
    // The engine takes over at once instead of after the production handover's two 5 s lock checks (TS-S07).
    automations: { lockCheckMs: 50 },
  });
  // Mara's GitHub token is read through the fake gh, after a restart too.
  providerLogins(services, { commands: { gh: FAKE_GH } });
  app = await buildApp({ services, logger: false });
  logServerErrors(app, log);
  await app.listen({ host: '127.0.0.1', port });
  const address = app.server.address();
  if (address && typeof address === 'object') port = address.port;
  baseUrl = `http://127.0.0.1:${port}`;
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
}

async function shutdown() {
  await runner?.stop(3000);
  runner = null;
  await services.github.idle().catch(() => {});
  // The stopped runner's last claim would hold app.close() on its keep-alive connection for ~70 s (TS-S05).
  app.server.closeAllConnections();
  await app.close();
  services.typing.close();
}

beforeAll(async () => {
  seedBareRepo();
  await boot();
  await loadSeedWorld(services, testWorld());
  await connectGitHubAs(services, IDS.mara);
  // The agent on the (fake) live provider, guarded.
  await services.db
    .update(principals)
    .set({ runtime: { provider: 'claude' } })
    .where(eq(principals.id, IDS.dusty));
}, 120_000);

afterAll(async () => {
  await shutdown().catch(() => {});
  // Installed pack versions are read-only on disk (bp-packs BP-D04).
  execFileSync('chmod', ['-R', 'u+w', root]);
  rmSync(root, { recursive: true, force: true });
});

/* Requests as people ----------------------------------------------------------------------------------------------- */

const auth: Record<string, string> = {};
async function as(who: 'mara') {
  auth[who] ??= (await sessionFor(services, IDS[who])).bearer;
  return auth[who] as string;
}

/** People's requests, in-process as their sessions run them (`test/api.ts`). */
const caller = inProcessApi(
  () => services,
  () => app,
);

async function http(
  who: 'mara' | { bearer: string },
  method: string,
  path: string,
  body?: unknown,
  raw?: Buffer,
) {
  const authorization = typeof who === 'string' ? await as(who) : who.bearer;
  const res = await caller.inject({
    method,
    url: path.startsWith('/api') ? path : `${API}${path}`,
    headers: { authorization },
    ...(raw ? { payload: raw } : body !== undefined ? { payload: body } : {}),
  });
  const text = res.body;
  // The test reads a few fields of untyped answers (the contracts are checked in routes/endpoints.int.test.ts).
  // biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
  let json: Record<string, any> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.statusCode, json, bytes: text };
}

async function ok(...args: Parameters<typeof http>) {
  const res = await http(...args);
  if (res.status >= 300) throw new Error(`${args[1]} ${args[2]} → ${res.status} ${res.bytes.slice(0, 300)}`);
  return res.json;
}

const runOf = async (runId: string) => toRun(services.db, await loadRunRow(services.db, runId));

/* The path ------------------------------------------------------------------------------------------------------ */

const state: {
  automationId?: string;
  principalId?: string;
  screenshot?: Buffer;
  screenshotId?: string;
  reportId?: string;
  runId?: string;
  /** The run's thread, in Mara's Chat. */
  threadId?: string;
  approvalNumber?: number;
  approvalHash?: string;
  evidenceId?: string;
  evidenceCopyId?: string;
} = {};

describe('golden path: a reported bug with a screenshot, through “Suspected bug”', () => {
  it('prepares through the product: the UI review pack on Dusty, the template published', async () => {
    // Automations → New → From a template, keys (Open pull requests: Can, this repo), Publish.
    const created = await ok('mara', 'POST', '/automations', {
      source: {
        kind: 'template',
        template: 'suspected_bug',
        params: {
          conversationId: BILLING,
          repo: REPO,
        },
      },
    });
    state.automationId = created.automation.id;
    state.principalId = created.automation.principalId;
    await ok('mara', 'PUT', `/automations/${state.automationId}/keys`, {
      grants: [{ keyId: 'pr.open', tier: 'can', repos: [REPO] }],
    });
    // Publish exactly the draft on screen (BP-C21).
    const published = await ok('mara', 'POST', `/automations/${state.automationId}/publish`, {
      enable: true,
      definitionHash: created.automation.draftHash,
    });
    expect(published.automation.status).toBe('published');
  });

  it('1 · a person uploads a screenshot and reports the bug; the automation starts', async () => {
    state.screenshot = makePng(64, 48, [250, 230, 90]);
    const reserved = await ok('mara', 'POST', '/uploads', {
      conversationId: BILLING,
      name: 'invoice-screenshot.png',
      contentType: 'image/png',
      size: state.screenshot.length,
    });
    const put = await ok('mara', 'PUT', reserved.uploadUrl, undefined, state.screenshot);
    state.screenshotId = put.attachment.id;
    expect(put.attachment).toMatchObject({ kind: 'image', width: 64, height: 48 });
    const sent = await ok('mara', 'POST', `/conversations/${BILLING}/messages`, {
      text: 'The invoice total looks broken: €5.45 where finance expects €5.46. Screenshot attached.',
      attachmentIds: [state.screenshotId],
    });
    state.reportId = sent.message.id;

    const run = await waitFor(
      async () => {
        const [row] = await services.db
          .select()
          .from(automationRuns)
          .where(eq(automationRuns.automationId, state.automationId as string));
        return row;
      },
      15_000,
      'the automation run',
    );
    state.runId = run.id;
    // It posts in its publisher's Chat, in a thread of its own (the report is in another room).
    expect(run.conversationId).toBe(IDS.dmDusty);
  });

  it('2–3 · the investigator gets the image, the knowledge and the pack; evidence is posted; a person is asked', async () => {
    const waiting = await waitFor(
      async () => {
        const r = await runOf(state.runId as string);
        return r.steps[2]?.state === 'waiting' ? r : null;
      },
      25_000,
      'the approval step',
    );
    const input = seen.investigator;
    expect(input?.context.agent.handle).toBe('dusty');
    state.threadId = (await loadRunRow(services.db, state.runId as string)).threadRootId as string;
    expect(state.threadId).toBeTruthy();
    // The actual image — a copy on the post that starts the run's thread, the report being in another room — as bytes
    // the runner fetched and verified.
    const image = input?.context.attachments.find((a) => a.kind === 'image');
    expect(image?.name).toBe('invoice-screenshot.png');
    expect(image?.id).not.toBe(state.screenshotId);
    expect(input?.imageSha).toBe(sha256(state.screenshot as Buffer));
    // The code, from a read-only checkout of the base (no writes, nothing pushed).
    expect(input?.context.workspace).toMatchObject({ repo: REPO, branch: 'main', access: 'read' });
    expect(input?.sandbox).toBe('read-only');
    expect(input?.code).toContain('return net + Math.round(vat);');

    // Evidence in the thread, with the investigator's artifact attached.
    expect(waiting.steps.map((s) => s.state).slice(0, 3)).toEqual(['succeeded', 'succeeded', 'waiting']);
    const evidenceId = waiting.steps[1]?.messageIds[0] as string;
    state.evidenceId = evidenceId;
    const [evidence] = await services.db.select().from(messages).where(eq(messages.id, evidenceId));
    expect(evidence?.threadRootId).toBe(state.threadId);
    expect(evidence?.text).toContain('FIN-ROUND-12');
    const thread = await ok('mara', 'GET', `/messages/${state.threadId}/thread`);
    const posted = [thread.root, ...thread.replies].find((m: { id: string }) => m.id === evidenceId);
    // `attachFrom` copies the investigator's artifact onto the evidence post (BP-C25): same file, its own row.
    const copy = posted.attachments.find((a: { name: string }) => a.name === 'evidence.txt');
    expect(copy?.id).toBeTruthy();
    expect(copy.id).not.toBe(seen.artifactId);
    state.evidenceCopyId = copy.id;
    expect((await http('mara', 'GET', `/attachments/${seen.artifactId}`)).status).toBe(200);
    expect((await http('mara', 'GET', `/attachments/${copy.id}`)).status).toBe(200);

    // The approval binds to the exact action.
    const [approval] = await services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, waiting.steps[2]?.approvalId as string));
    expect(approval?.state).toBe('pending');
    expect(approval?.actionHash).toMatch(/^[0-9a-f]{64}$/);
    state.approvalNumber = approval?.number;
    state.approvalHash = approval?.actionHash ?? undefined;
  });

  it('4a · server and runner restart while the approval is pending; nothing is replayed', async () => {
    const before = {
      posts: (
        await services.db
          .select()
          .from(messages)
          .where(eq(messages.authorId, state.principalId as string))
      ).length,
      dispatches: (await services.db.select().from(dispatches).where(eq(dispatches.trigger, 'automation')))
        .length,
    };
    await shutdown();
    await boot();
    // The new engine active (its boot recovery and first pass done), two more passes, and a few runner claims (300 ms
    // long polls) on the new processes.
    await waitFor(() => services.automations.isActive, 5000, 'the engine to take over');
    await services.automations.tick();
    await new Promise((r) => setTimeout(r, 1000));
    await services.automations.tick();
    const after = {
      posts: (
        await services.db
          .select()
          .from(messages)
          .where(eq(messages.authorId, state.principalId as string))
      ).length,
      dispatches: (await services.db.select().from(dispatches).where(eq(dispatches.trigger, 'automation')))
        .length,
    };
    expect(after).toEqual(before);
    const run = await runOf(state.runId as string);
    expect(run.status).toBe('waiting');
    expect(run.steps[2]?.state).toBe('waiting');
  });

  it('7 · agents cannot decide or escalate', async () => {
    const n = state.approvalNumber as number;
    // A report where the automation does not listen starts nothing.
    await ok('mara', 'POST', `/conversations/${IDS.general}/messages`, {
      text: 'Something is broken, a bug!',
    });
    await new Promise((r) => setTimeout(r, 1500));
    const runs = await services.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, state.automationId as string));
    expect(runs).toHaveLength(1);

    // The agent cannot decide: not through the pipeline, not over REST with its dispatch token.
    const byAgent = await services.pipeline.commit(
      decideApproval,
      { number: n, decision: 'approve' },
      { burrowId: TEST_BURROW_ID, actorId: IDS.dusty },
    );
    expect(byAgent.status).not.toBe('ok');
    const agent = await agentTokenFor(services, TEST_BURROW_ID, IDS.dusty, BILLING);
    expect([401, 403, 404]).toContain(
      (await http({ bearer: agent.bearer }, 'POST', `/approvals/${n}/decide`, { decision: 'approve' }))
        .status,
    );
    const [still] = await services.db.select().from(approvals).where(eq(approvals.number, n));
    expect(still?.state).toBe('pending');
  });

  it('4b · Mara approves the exact request; the run continues once, without replaying', async () => {
    const n = state.approvalNumber as number;
    const shown = await ok('mara', 'GET', `/approvals/${n}`);
    expect(JSON.stringify(shown)).toContain('Fix the suspected bug in whombat/billing');
    await ok('mara', 'POST', `/approvals/${n}/decide`, { decision: 'approve' });
    const run = await waitFor(
      async () => {
        const r = await runOf(state.runId as string);
        return r.steps[3]?.dispatchId ? r : null;
      },
      15_000,
      'the developer dispatch',
    );
    expect(run.steps[2]?.state).toBe('succeeded');
    expect(run.steps[2]?.output.decision).toBe('approved');
    const [approval] = await services.db.select().from(approvals).where(eq(approvals.number, n));
    expect(approval?.actionHash).toBe(state.approvalHash);
    // Exactly once each: one investigation turn (and now the fix's), one evidence post, one approval card.
    const auto = await services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.trigger, 'automation'), eq(dispatches.agentId, IDS.dusty)))
      .orderBy(asc(dispatches.createdAt));
    expect(auto.map((d) => d.id)).toEqual([run.steps[0]?.dispatchId, run.steps[3]?.dispatchId]);
    const posts = await services.db
      .select()
      .from(messages)
      .where(eq(messages.authorId, state.principalId as string))
      .orderBy(asc(messages.ord));
    expect(posts.filter((m) => m.text.startsWith('@Dusty'))).toHaveLength(2);
    expect(posts.filter((m) => m.text.startsWith('Here’s what the investigation found'))).toHaveLength(1);
    expect(posts.filter((m) => m.text.startsWith('I need a person to say yes'))).toHaveLength(1);
    const approved = await services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'approval.approved'), eq(events.actorId, IDS.mara)));
    expect(approved).toHaveLength(1);
  });

  it('5–6 · Dusty fixes it in a worktree, a fresh turn reviews, the PR opens and the report is in the thread', async () => {
    const run = await waitFor(
      async () => {
        const r = await runOf(state.runId as string);
        return ['succeeded', 'failed', 'cancelled', 'needs_review'].includes(r.status) ? r : null;
      },
      25_000,
      'the run to end',
    );
    expect(run.error).toBeNull();
    // 5 · an isolated worktree of the bare repo on the run's feat/* branch, writable; the commit is on “GitHub”.
    const branch = `feat/bug-${run.number}`;
    expect(seen.developer?.context.workspace).toMatchObject({ repo: REPO, branch, access: 'write' });
    expect(seen.developer?.sandbox).toBe('workspace-write');
    expect(seen.developer?.cwd).toContain(join('burrow-hq', 'whombat--billing'));
    const bare = join(dirs.git, `${REPO}.git`);
    expect(git(bare, 'log', '-1', '--format=%s', branch)).toBe('Round VAT per line');
    expect(run.steps[3]?.state).toBe('succeeded');
    expect(run.steps[3]?.output.commits).toBe(1);
    // …and a fresh turn reviews that branch, with no session of the fix: a read-only export of what is on GitHub, plus
    // its diff.
    expect(seen.reviewer?.context.agent.handle).toBe('dusty');
    expect(seen.reviewer?.resumeSessionId).toBeUndefined();
    expect(seen.reviewer?.context.workspace).toMatchObject({ repo: REPO, branch, access: 'read' });
    expect(seen.reviewer?.sandbox).toBe('read-only');
    expect(seen.reviewer?.cwd).not.toBe(seen.developer?.cwd);
    expect(seen.reviewer?.code).toContain('Math.round((netCents * rate) / 100)');
    expect(seen.reviewer?.prompt).toContain(`[[changes ${branch} against main`);
    expect(seen.reviewer?.prompt).toContain('Round VAT per line');
    expect(seen.reviewer?.prompt).toContain('-  return net + Math.round(vat);');
    expect(run.steps[4]?.output.verdict).toBe('approve');
    expect(run.steps[5]?.output.result).toBe(true);
    // 6 · the PR on FakeGitHub and the report back in the run's thread.
    expect(run.status).toBe('succeeded');
    const prNumber = run.steps[6]?.prNumber as number;
    expect(prNumber).toBeGreaterThan(0);
    expect(services.github.fake?.repos.get(REPO)?.prs.get(prNumber)?.head).toBe(branch);
    const report = await services.db
      .select()
      .from(messages)
      .where(eq(messages.id, run.steps[7]?.messageIds[0] as string));
    expect(report[0]?.threadRootId).toBe(state.threadId);
    expect(report[0]?.text).toContain(`PR #${prNumber}`);
    // Everything the run said is in its thread — its approval card too (automation-recipes.md AR-31) — except the
    // “Opened PR” line in the pull request's own branch room.
    const posts = await services.db
      .select()
      .from(messages)
      .where(eq(messages.authorId, state.principalId as string))
      .orderBy(asc(messages.createdAt));
    const outside = posts.filter((m) => m.id !== state.threadId && m.threadRootId !== state.threadId);
    expect(outside.map((m) => m.card?.kind ?? m.text.split(' · ')[0])).toEqual([`Opened PR #${prNumber}`]);
    expect(outside[0]?.conversationId).not.toBe(IDS.dmDusty);
    const card = posts.find((m) => m.card?.kind === 'approval');
    expect(card).toMatchObject({ conversationId: IDS.dmDusty, threadRootId: state.threadId });
    // One run: the agent's replies in the thread (“bug” included) started nothing more.
    expect(
      await services.db
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.automationId, state.automationId as string)),
    ).toHaveLength(1);
  });
});
