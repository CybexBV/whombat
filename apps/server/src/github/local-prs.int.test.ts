/**
 * Pull requests on a repository created on the Whombat (docs/decisions/runs-approvals.md MDS-D05, MDS-D06): an agent
 * opens one from the branch it pushed to the origin, and merging it — the agent's Merge row On, its card at Ask, or a
 * person — merges inside the bare origin with the server's git, squash by default, as whoever merges. A conflict
 * refuses and leaves the origin and the pull request as they were.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCommitEmail, type GrantInput, withKeyRowTier } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentAuth } from '../auth/agent-tokens';
import { setAgentKeys } from '../commands/agents';
import { decideApproval } from '../commands/approvals';
import { events, prCommits, prFiles, pullRequests, repos } from '../db/schema/index';
import { callTool } from '../mcp/server';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { agentTokenFor, sessionFor } from '../test/tokens';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'wb-local-prs-')));
const workspaces = join(base, 'workspaces');
const t = useTestServer({
  seed: true,
  app: true,
  env: { WHOMBAT_WORKSPACES: workspaces, WHOMBAT_HOME: join(base, '.whombat') },
});
const REPO = 'local/Site';
let origin = '';

const DUSTY_EMAIL = agentCommitEmail('dusty', 'burrow-hq');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', `safe.directory=${origin}`, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dusty',
      GIT_AUTHOR_EMAIL: DUSTY_EMAIL,
      GIT_COMMITTER_NAME: 'Dusty',
      GIT_COMMITTER_EMAIL: DUSTY_EMAIL,
    },
  }).trim();

/** Dusty's push: `branch` off main with these files, in the origin (what the runner's push leaves). */
function push(branch: string, files: Record<string, string>) {
  const work = mkdtempSync(join(base, 'clone-'));
  git(base, 'clone', '--quiet', origin, work);
  git(work, 'checkout', '--quiet', '-b', branch);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', `Add ${Object.keys(files).join(', ')}`);
  git(work, 'push', '--quiet', 'origin', branch);
  return git(work, 'rev-parse', 'HEAD');
}

async function tool(name: string, args: Record<string, unknown>) {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
  const auth: AgentAuth = { dispatchId, agentId: IDS.dusty, burrowId: t.burrowId };
  const res = await callTool(t.services, auth, name, args);
  return res.structuredContent as Record<string, unknown> & { error?: { code: string; message: string } };
}

async function mergeRow(tier: 'cannot' | 'ask' | 'can') {
  const held: GrantInput[] = [
    { keyId: 'branch.feature.readwrite', tier: 'can' },
    { keyId: 'pr.open', tier: 'can' },
    { keyId: 'merge.main', tier: 'cannot' },
  ];
  const res = await t.commit(IDS.mara, setAgentKeys, {
    grants: withKeyRowTier(held, 'merge', tier),
  });
  expect(res.status).toBe('ok');
}

async function open(branch: string, title: string) {
  const res = await tool('open_pull_request', { repo: REPO, branch, base: 'main', title, body: '' });
  expect(res.status, JSON.stringify(res)).toBe('ok');
  return res.number as number;
}

const prRow = async (number: number) => {
  const [repo] = await t.services.db.select().from(repos).where(eq(repos.fullName, REPO));
  const [row] = await t.services.db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repo?.id ?? ''), eq(pullRequests.number, number)));
  if (!row) throw new Error(`no PR #${number}`);
  return row;
};

const mainLog = () => git(base, '--git-dir', origin, 'log', '-1', '--format=%an <%ae>|%s|%b', 'main');

beforeAll(async () => {
  // A branch that isn't pushed is waited for 20 s in production; here a moment is enough to prove it refuses.
  t.services.github.branchWaitMs = 300;
  const { cookie } = await sessionFor(t.services, IDS.mara);
  const res = await t.api.inject({
    method: 'POST',
    url: '/api/v1/burrows/burrow-hq/repos/local',
    headers: { cookie },
    payload: { name: 'Site', description: 'The website.' },
  });
  expect(res.statusCode).toBe(201);
  origin = join(workspaces, '.origins', t.burrowId, 'Site.git');
});

describe('pull requests on a repository kept on this Whombat', () => {
  it('opens from the pushed branch: head, files, diff and commits from the origin, no GitHub link', async () => {
    await mergeRow('can');
    const head = push('feat/landing', { 'index.html': '<h1>Site</h1>\n' });
    const number = await open('feat/landing', 'Landing page');
    expect(number).toBe(1);
    const row = await prRow(number);
    expect(row).toMatchObject({
      headSha: head,
      url: null,
      localOnly: true,
      state: 'open',
      diff: { add: 1, del: 0, files: 1 },
    });
    expect(await t.services.db.select().from(prFiles).where(eq(prFiles.prId, row.id))).toMatchObject([
      { path: 'index.html', add: 1, del: 0 },
    ]);
    expect(await t.services.db.select().from(prCommits).where(eq(prCommits.prId, row.id))).toMatchObject([
      { sha: head, message: 'Add index.html', authorId: IDS.dusty },
    ]);
    // A branch that isn't there yet says what to do.
    const missing = await tool('open_pull_request', {
      repo: REPO,
      branch: 'feat/nothing',
      base: 'main',
      title: 'Nothing',
      body: '',
    });
    expect(missing).toMatchObject({ error: { code: 'conflict' } });
  }, 60_000);

  it('Merge On: the agent merges, squashed into main as the agent; nobody else could review it here (MA-02)', async () => {
    const res = await tool('merge_pull_request', { prNumber: 1, repo: REPO });
    expect(res).toMatchObject({ status: 'ok', merged: true });
    expect(await prRow(1)).toMatchObject({ state: 'merged', mergedById: IDS.dusty });
    expect(mainLog()).toBe(`Dusty <${DUSTY_EMAIL}>|Landing page (#1)|Merged by Dusty in Whombat.`);
    expect(git(base, '--git-dir', origin, 'show', 'main:index.html')).toBe('<h1>Site</h1>');
    const [merged] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'pr.merged'), eq(events.actorId, IDS.dusty)));
    expect(merged).toMatchObject({ text: 'Merged PR #1 into main', where: `${REPO} · PR #1` });
    expect(merged?.payload).toMatchObject({ onGitHub: false, onWhombat: true });
  }, 60_000);

  it('Merge Ask: a card; the person’s yes merges as them, their yes is the review', async () => {
    await mergeRow('ask');
    push('feat/about', { 'about.html': '<h1>About</h1>\n' });
    const number = await open('feat/about', 'About page');
    const res = await tool('merge_pull_request', { prNumber: number, repo: REPO });
    expect(res).toMatchObject({ status: 'pending_approval' });
    expect((await prRow(number)).state).toBe('open');
    await t.commit(IDS.mara, decideApproval, { number: res.approvalNumber as number, decision: 'approve' });
    expect(await prRow(number)).toMatchObject({ state: 'merged', mergedById: IDS.mara });
    expect(mainLog()).toMatch(/^Mara Okafor <[^>]+>\|About page \(#2\)\|Merged by Mara Okafor in Whombat\.$/);
    expect(git(base, '--git-dir', origin, 'show', 'main:about.html')).toBe('<h1>About</h1>');
  }, 60_000);

  it('a conflict refuses: the origin’s main and the pull request stay as they were', async () => {
    push('feat/readme-a', { 'README.md': 'A\n' });
    push('feat/readme-b', { 'README.md': 'B\n' });
    const a = await open('feat/readme-a', 'Readme A');
    const b = await open('feat/readme-b', 'Readme B');
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const merge = (n: number) =>
      t.api.inject({
        method: 'POST',
        url: `/api/v1/burrows/burrow-hq/prs/${n}/merge?repo=${encodeURIComponent(REPO)}`,
        headers: { cookie },
        payload: { method: 'merge' },
      });
    const first = await merge(a);
    expect(first.statusCode, first.body).toBe(200);
    const main = git(base, '--git-dir', origin, 'rev-parse', 'main');
    // A merge commit (method `merge`): both parents.
    expect(
      git(base, '--git-dir', origin, 'rev-list', '--parents', '-n', '1', 'main').split(' '),
    ).toHaveLength(3);
    const second = await merge(b);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toBe(
      `Whombat didn’t merge PR #${b}: feat/readme-b conflicts with main in README.md. Bring feat/readme-b up to date with main first.`,
    );
    expect(git(base, '--git-dir', origin, 'rev-parse', 'main')).toBe(main);
    expect((await prRow(b)).state).toBe('open');
  }, 60_000);
});
