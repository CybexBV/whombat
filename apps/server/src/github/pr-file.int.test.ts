/**
 * A pull request's file, whole (`prs.file`, docs/decisions/pr-file-view.md; contracts CT-241): read from a local repo's
 * origin and from GitHub (the fake), at the PR's merge base and head — after a merge commit, at the commit the branch
 * started from — and only for files the PR changes.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { agentCommitEmail, type PrFileView } from '@whombat/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentAuth } from '../auth/agent-tokens';
import { setAgentKeys } from '../commands/agents';
import { callTool } from '../mcp/server';
import { IDS } from '../seed/test-world';
import { fakeOf, linkLogin, syncGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { agentTokenFor, sessionFor } from '../test/tokens';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'wb-pr-file-')));
const workspaces = join(base, 'workspaces');
const t = useTestServer({
  seed: true,
  app: true,
  env: { WHOMBAT_WORKSPACES: workspaces, WHOMBAT_HOME: join(base, '.whombat') },
});
const LOCAL = 'local/Site';
const GITHUB = 'whombat/billing';
let origin = '';
let cookie = '';

const BANJO_EMAIL = agentCommitEmail('dusty', 'burrow-hq');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', `safe.directory=${origin}`, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dusty',
      GIT_AUTHOR_EMAIL: BANJO_EMAIL,
      GIT_COMMITTER_NAME: 'Dusty',
      GIT_COMMITTER_EMAIL: BANJO_EMAIL,
    },
  }).trim();

/** Dusty's push: `branch` off main, one commit per entry of `commits` (a file's text, bytes, or null to remove it). */
function push(branch: string, commits: Record<string, string | Uint8Array | null>[]) {
  const work = mkdtempSync(join(base, 'clone-'));
  git(base, 'clone', '--quiet', origin, work);
  git(work, 'checkout', '--quiet', '-b', branch);
  for (const files of commits) {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) git(work, 'rm', '--quiet', name);
      else {
        mkdirSync(dirname(join(work, name)), { recursive: true });
        writeFileSync(join(work, name), content);
      }
    }
    git(work, 'add', '.');
    git(work, 'commit', '--quiet', '-m', `Change ${Object.keys(files).join(', ')}`);
  }
  git(work, 'push', '--quiet', 'origin', branch);
  return git(work, 'rev-parse', 'HEAD');
}

async function openLocal(branch: string, title: string) {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
  const auth: AgentAuth = { dispatchId, agentId: IDS.dusty, burrowId: t.burrowId };
  const res = await callTool(t.services, auth, 'open_pull_request', {
    repo: LOCAL,
    branch,
    base: 'main',
    title,
    body: '',
  });
  const out = res.structuredContent as { status: string; number: number };
  expect(out.status, JSON.stringify(out)).toBe('ok');
  return out.number;
}

const fileView = (number: number, repo: string, path: string) =>
  t.api.inject({
    method: 'GET',
    url: `/api/v1/burrows/burrow-hq/prs/${number}/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
    headers: { cookie },
  });

async function view(number: number, repo: string, path: string): Promise<PrFileView> {
  const res = await fileView(number, repo, path);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as PrFileView;
}

beforeAll(async () => {
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  const res = await t.api.inject({
    method: 'POST',
    url: '/api/v1/burrows/burrow-hq/repos/local',
    headers: { cookie },
    payload: { name: 'Site', description: 'The website.' },
  });
  expect(res.statusCode).toBe(201);
  origin = join(workspaces, '.origins', t.burrowId, 'Site.git');
  const keys = await t.commit(IDS.mara, setAgentKeys, {
    grants: [
      { keyId: 'branch.feature.readwrite', tier: 'can' },
      { keyId: 'pr.open', tier: 'can' },
    ],
  });
  expect(keys.status).toBe('ok');
  await linkLogin(t, 'mara-gh', IDS.mara);
  expect(await syncGitHub(t)).toMatchObject({ skipped: null });
});

describe('the file view of a repository kept on this Whombat', () => {
  let number = 0;
  let main = '';

  it('shows a changed file whole: removed and added lines in place, numbered in each version', async () => {
    main = git(base, '--git-dir', origin, 'rev-parse', 'main');
    const head = push('feat/readme', [
      { 'README.md': '# Site\n\nOur website.\n\nMore soon.\n', 'src/app.ts': 'export const app = 1;\n' },
      { 'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]) },
    ]);
    number = await openLocal('feat/readme', 'Readme and app');
    const readme = await view(number, LOCAL, 'README.md');
    expect(readme).toEqual({
      path: 'README.md',
      status: 'modified',
      shown: 'text',
      add: 3,
      del: 1,
      lines: [
        { kind: 'context', old: 1, new: 1, text: '# Site' },
        { kind: 'context', old: 2, new: 2, text: '' },
        { kind: 'del', old: 3, new: null, text: 'The website.' },
        { kind: 'add', old: null, new: 3, text: 'Our website.' },
        { kind: 'add', old: null, new: 4, text: '' },
        { kind: 'add', old: null, new: 5, text: 'More soon.' },
      ],
      baseSha: main,
      headSha: head,
    });
    expect(await view(number, LOCAL, 'src/app.ts')).toMatchObject({
      status: 'added',
      shown: 'text',
      add: 1,
      del: 0,
      lines: [{ kind: 'add', old: null, new: 1, text: 'export const app = 1;' }],
      baseSha: main,
    });
    expect(await view(number, LOCAL, 'logo.png')).toMatchObject({
      status: 'added',
      shown: 'binary',
      add: 0,
      del: 0,
      lines: [],
    });
  }, 60_000);

  it('answers 404 for a file the pull request doesn’t change, or a PR that isn’t there', async () => {
    for (const path of ['index.html', '../Site.git/HEAD', 'src', '*']) {
      const res = await fileView(number, LOCAL, path);
      expect(res.statusCode, path).toBe(404);
    }
    expect((await fileView(number, LOCAL, 'index.html')).json().error.message).toBe(
      `PR #${number} doesn’t change index.html.`,
    );
    expect((await fileView(9999, LOCAL, 'README.md')).statusCode).toBe(404);
  });

  it('after a merge commit, still from the commit the branch started from', async () => {
    const merged = await t.api.inject({
      method: 'POST',
      url: `/api/v1/burrows/burrow-hq/prs/${number}/merge?repo=${encodeURIComponent(LOCAL)}`,
      headers: { cookie },
      payload: { method: 'merge' },
    });
    expect(merged.statusCode, merged.body).toBe(200);
    // The head is in main now: its merge base with main is the head itself.
    expect(
      git(base, '--git-dir', origin, 'rev-list', '--parents', '-n', '1', 'main').split(' '),
    ).toHaveLength(3);
    expect(await view(number, LOCAL, 'README.md')).toMatchObject({
      status: 'modified',
      add: 3,
      del: 1,
      baseSha: main,
    });
  }, 60_000);

  it('a removed file', async () => {
    const start = git(base, '--git-dir', origin, 'rev-parse', 'main');
    push('feat/no-app', [{ 'src/app.ts': null }]);
    const n = await openLocal('feat/no-app', 'Remove the app');
    expect(await view(n, LOCAL, 'src/app.ts')).toMatchObject({
      status: 'deleted',
      shown: 'text',
      add: 0,
      del: 1,
      lines: [{ kind: 'del', old: 1, new: null, text: 'export const app = 1;' }],
      baseSha: start,
    });
  }, 60_000);
});

describe('the file view of a GitHub repository', () => {
  it('a seeded pull request’s files, made up to show their +add −del', async () => {
    expect(await view(482, GITHUB, 'billing/pdf/format.ts')).toMatchObject({
      status: 'modified',
      shown: 'text',
      add: 34,
      del: 9,
      headSha: 'e9f114',
    });
    expect(await view(482, GITHUB, 'billing/pdf/render.ts')).toMatchObject({
      status: 'added',
      add: 128,
      del: 0,
    });
    // `repo` is optional, as for prs.get.
    const plain = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/prs/482/file?path=billing%2Fapi%2Finvoices.ts',
      headers: { cookie },
    });
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.json()).toMatchObject({ add: 22, del: 1 });
  });

  it('reads both versions from GitHub: the merge base and the head; once in main, the first commit’s parent', async () => {
    const fake = fakeOf(t);
    const repo = fake.repos.get(GITHUB);
    const tip = repo?.branches.get('main');
    if (!repo || !tip) throw new Error('no main in the fake');
    const head = `f11e00${'3'.repeat(34)}`;
    await fake.simulateFiles({ repo: GITHUB, sha: tip, files: { 'billing/vat.ts': 'a\nb\nc\n' } });
    await fake.simulatePush({
      repo: GITHUB,
      branch: 'feat/vat',
      commits: [{ sha: head, message: 'Round VAT', authorEmail: BANJO_EMAIL }],
    });
    await fake.simulateFiles({
      repo: GITHUB,
      sha: head,
      parent: tip,
      files: { 'billing/vat.ts': 'a\nB\nc\nd\n' },
    });
    const number = await fake.simulateOpenPullRequest({
      repo: GITHUB,
      head: 'feat/vat',
      title: 'Round VAT',
      login: 'mara-gh',
      files: [{ path: 'billing/vat.ts', add: 2, del: 1 }],
    });
    await syncGitHub(t);
    const expected = {
      path: 'billing/vat.ts',
      status: 'modified',
      shown: 'text',
      add: 2,
      del: 1,
      lines: [
        { kind: 'context', old: 1, new: 1, text: 'a' },
        { kind: 'del', old: 2, new: null, text: 'b' },
        { kind: 'add', old: null, new: 2, text: 'B' },
        { kind: 'context', old: 3, new: 3, text: 'c' },
        { kind: 'add', old: null, new: 4, text: 'd' },
      ],
      baseSha: tip,
      headSha: head,
    };
    expect(await view(number, GITHUB, 'billing/vat.ts')).toEqual(expected);
    // Main fast-forwards to the head: GitHub's merge base is the head; the first commit's parent is the base.
    repo.branches.set('main', head);
    expect(await view(number, GITHUB, 'billing/vat.ts')).toEqual(expected);
    repo.branches.set('main', tip);

    // gh logged out: a 409 that says so, with the fix.
    fake.loggedOut = true;
    try {
      const res = await fileView(number, GITHUB, 'billing/vat.ts');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain('GitHub isn’t connected');
    } finally {
      fake.loggedOut = false;
    }
  });
});
