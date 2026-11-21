/**
 * A real coding turn, end to end, against FakeGitHub backed by bare git repositories on disk: the runner
 * prepares Dusty's worktree with a fetch token, the agent commits and opens a pull request through MCP (on
 * GitHub as the gh account, its body saying Dusty opened it), the runner pushes (push token = Dusty holds
 * "Read and write feat/* branches") before the PR is opened and again after the turn; the poller brings the
 * second push back signed by Dusty, with the PR's commits and files.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
import {
  createRunnerApi,
  type ProviderRegistry,
  Runner,
  type TurnOutcome,
  testPolicy,
} from '@whombat/runner';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRun } from '../commands/agent-runs';
import { sendMessage } from '../commands/messages';
import { dispatches, events, prCommits, prFiles, principals, pullRequests } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { connectGitHubAs, fakeOf, signInsEnv, syncGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { waitFor } from '../test/runner';
import { SCRIPTED_ENV, scripted } from '../test/scripted';

const gitRoot = mkdtempSync(join(tmpdir(), 'whombat-fake-github-'));
const t = useTestServer({
  seed: true,
  listen: true,
  env: { ...SCRIPTED_ENV, ...signInsEnv(), WHOMBAT_FAKE_GITHUB_GIT_ROOT: gitRoot },
});
// Agents' git and gh run on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
beforeAll(() => connectGitHubAs(t.services, IDS.mara));
const REPO = 'whombat/billing';
const BRANCH = 'feat/credit-notes';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A live-provider stand-in that codes like an agent: edit, commit, open a PR through MCP, commit again. */
function codingProvider(seen: { input?: TurnInput; pr?: Record<string, unknown> }): AgentProvider {
  return {
    kind: 'codex',
    available: async () => ({ ok: true, version: 'test' }),
    capabilities: () => BASIC_CAPABILITIES,
    async *runTurn(input): AsyncIterable<TurnEvent> {
      seen.input = input;
      yield { type: 'session', sessionId: 'coding-1' };
      mkdirSync(join(input.cwd, 'billing'), { recursive: true });
      writeFileSync(join(input.cwd, 'billing', 'credit-notes.ts'), 'export const creditNotes = true;\n');
      git(input.cwd, 'add', '.');
      git(input.cwd, 'commit', '--quiet', '-m', 'Add credit-note PDFs');
      const args = { repo: REPO, branch: BRANCH, title: 'Credit-note PDFs', body: 'Adds credit notes.' };
      yield { type: 'tool_call', name: 'open_pull_request', input: args };
      const mcp = await connectWhombatMcp(input.mcp);
      try {
        const res = await mcp.call('open_pull_request', args);
        seen.pr = res.body;
        yield { type: 'tool_result', name: 'open_pull_request', ok: res.ok };
      } finally {
        await mcp.close();
      }
      writeFileSync(join(input.cwd, 'billing', 'credit-notes.test.ts'), 'test("credit notes", () => {});\n');
      git(input.cwd, 'add', '.');
      git(input.cwd, 'commit', '--quiet', '-m', 'Test credit notes');
      yield { type: 'final', text: `Opened PR #${String(seen.pr?.number)} · Credit-note PDFs.` };
    },
  };
}

let runner: Runner | null = null;

afterAll(async () => {
  await runner?.stop(2000);
});

describe('a coding turn', () => {
  it('commits, pushes with Dusty’s key and opens a real pull request', async () => {
    const seen: { input?: TurnInput; pr?: Record<string, unknown> } = {};
    const provider = codingProvider(seen);
    const registry: ProviderRegistry = scripted({
      claims: () => ['codex'],
      for: (kind) => (kind === 'codex' ? provider : null),
      report: () => [],
    });
    // Dusty runs on Codex here, with a run on a new branch of a switched-on repo.
    await t.services.db
      .update(principals)
      .set({ runtime: { provider: 'codex' } })
      .where(eq(principals.id, IDS.dusty));
    // Mara asked for it in billing-v2: Dusty started the run in the turn her message woke him for.
    const asked = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: 'Credit-note PDFs next, please.',
    });
    if (asked.status !== 'ok') throw new Error('send failed');
    const turn = newId('dispatch');
    await t.services.db.insert(dispatches).values({
      id: turn,
      burrowId: t.burrowId,
      agentId: IDS.dusty,
      trigger: 'mention',
      mode: 'reply',
      conversationId: IDS.billing,
      messageId: asked.result.id,
      state: 'done',
      createdAt: new Date(),
    });
    const started = await t.commit(IDS.dusty, startRun, {
      conversationId: IDS.billing,
      title: 'Add credit-note PDFs',
      repo: REPO,
      branch: BRANCH,
      dispatchId: turn,
      steps: [{ title: 'Write credit-note PDFs', detail: '' }],
    });
    if (started.status !== 'ok') throw new Error(`start_run: ${started.status}`);

    const outcomes: TurnOutcome[] = [];
    runner = new Runner({
      api: createRunnerApi(t.baseUrl, 'dev-runner-token'),
      registry,
      managed: testPolicy(),
      serverUrl: t.baseUrl,
      workspacesRoot: mkdtempSync(join(tmpdir(), 'whombat-coding-ws-')),
      // A throwaway host: turns make an empty gh config dir under WHOMBAT_HOME.
      host: { home: tmpdir(), whombatHome: mkdtempSync(join(tmpdir(), 'whombat-coding-home-')) },
      waitMs: 300,
      heartbeatMs: 200,
      progressMs: 50,
      onTurn: (_id, outcome) => outcomes.push(outcome),
    });
    // start_run queued Dusty's run turn (the mention turn had no checkout, run-checkout.md RC-01).
    runner.start();

    const outcome = await waitFor(() => outcomes[0], 30_000, 'the coding turn');
    expect(outcome).toMatchObject({
      outcome: 'done',
      pushes: ['pushed 1 commit(s) before opening the pull request', 'pushed 1 commit(s) after the turn'],
    });

    // The worktree was a checkout of the branch, committed as Dusty.
    const cwd = seen.input?.cwd ?? '';
    expect(cwd).toContain(join('burrow-hq', 'whombat--billing', 'feat--credit-notes'));
    expect(seen.input?.sandbox).toBe('workspace-write');
    expect(git(cwd, 'log', '-1', '--format=%an <%ae>')).toBe('Dusty <dusty@agents.burrow-hq.whombat.com>');

    // Both commits are on "GitHub".
    const bare = join(gitRoot, `${REPO}.git`);
    const head = git(bare, 'rev-parse', `refs/heads/${BRANCH}`);
    expect(head).toBe(git(cwd, 'rev-parse', 'HEAD'));
    expect(git(bare, 'log', '--format=%s', `main..${BRANCH}`).split('\n')).toEqual([
      'Test credit notes',
      'Add credit-note PDFs',
    ]);

    // The PR is GitHub's (#483 after the seeded #482) and has its branch room.
    expect(seen.pr).toMatchObject({ status: 'ok', number: 483 });
    const fake = fakeOf(t);
    expect(fake.repos.get(REPO)?.prs.get(483)).toMatchObject({
      head: BRANCH,
      base: 'main',
      state: 'open',
      body: 'Adds credit notes.\n\nOpened by Dusty via Whombat',
      authorLogin: fake.login,
    });
    const pr = await waitFor(
      async () => {
        await syncGitHub(t);
        const [row] = await t.services.db.select().from(pullRequests).where(eq(pullRequests.number, 483));
        return row?.headSha === head ? row : null;
      },
      10_000,
      'the second push to reach the PR',
    );
    expect(pr).toMatchObject({ branch: BRANCH, authorId: IDS.dusty, state: 'open' });
    expect(pr.url).toBe(`https://github.fake.whombat.local/${REPO}/pull/483`);

    // Commits and files came back from GitHub, the commits attributed to Dusty by his commit email.
    const commits = await t.services.db
      .select()
      .from(prCommits)
      .where(eq(prCommits.prId, pr.id))
      .orderBy(asc(prCommits.position));
    expect(commits.map((c) => [c.message, c.authorId])).toEqual([
      ['Add credit-note PDFs', IDS.dusty],
      ['Test credit notes', IDS.dusty],
    ]);
    const files = await t.services.db.select().from(prFiles).where(eq(prFiles.prId, pr.id));
    expect(files.map((f) => f.path).sort()).toEqual([
      'billing/credit-notes.test.ts',
      'billing/credit-notes.ts',
    ]);

    // The pushes are Dusty's, under his branch key, on behalf of Mara (who asked for the run).
    const pushes = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'branch.pushed'), eq(events.actorId, IDS.dusty)))
      .orderBy(asc(events.seq));
    expect(pushes.at(-1)).toMatchObject({
      text: `Pushed ${head.slice(0, 6)} to ${BRANCH}`,
      keyUsed: { id: 'branch.feature.readwrite' },
      onBehalfOf: 'Mara in billing-v2',
    });
    const opened = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'pr.opened'), eq(events.actorId, IDS.dusty)))
      .orderBy(asc(events.seq));
    expect(opened.at(-1)).toMatchObject({
      text: 'Opened PR #483 · Credit-note PDFs',
      payload: { onGitHub: true },
    });
  });
});
