/**
 * A pull request's read-only checkout (Whombat automation-recipes.md): the server names the branch `pull/<n>/head`, and
 * the runner fetches GitHub's `refs/pull/<n>/head` for it — a fork's head too, which is on no branch of the repo.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pullRequestRef, WorkspaceManager, type WorkspaceTarget } from './index';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();

let dir: string;
let origin: string;
let forkHead: string;

/** A bare "GitHub" repo with main, and a fork's commit only reachable from `refs/pull/7/head`. */
function makeOrigin(): string {
  const seed = join(dir, 'seed');
  git(dir, 'init', '--quiet', '-b', 'main', seed);
  writeFileSync(join(seed, 'README.md'), 'web\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'Initial commit');
  git(seed, 'checkout', '--quiet', '-b', 'patch-1');
  writeFileSync(join(seed, 'fork.txt'), 'from a fork\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'A fork’s change');
  forkHead = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'checkout', '--quiet', 'main');
  const bare = join(dir, 'origin.git');
  git(dir, 'clone', '--quiet', '--bare', seed, bare);
  // GitHub keeps a pull request's head under refs/pull; the fork's branch is not one of the repo's.
  git(bare, 'update-ref', 'refs/pull/7/head', forkHead);
  git(bare, 'update-ref', '-d', 'refs/heads/patch-1');
  return bare;
}

function target(branch: string): WorkspaceTarget {
  return { burrow: 'burrow-hq', repo: 'acme/web', branch, baseBranch: 'main', cloneUrl: origin };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-pull-'));
  origin = makeOrigin();
});

describe('pullRequestRef', () => {
  it('names GitHub’s ref for pull/<n>/head only', () => {
    expect(pullRequestRef('pull/7/head')).toBe('refs/pull/7/head');
    expect(pullRequestRef('pull/0/head')).toBeNull();
    expect(pullRequestRef('pull/7/merge')).toBeNull();
    expect(pullRequestRef('feat/pull/7/head')).toBeNull();
    expect(pullRequestRef('main')).toBeNull();
  });
});

describe('a pull request’s checkout', () => {
  it('exports the fork’s head from Whombat’s mirror', async () => {
    const m = new WorkspaceManager({
      root: join(dir, 'workspaces'),
      credentials: async () => ({ token: 'gho_token', remoteUrl: origin }),
    });
    const t = target('pull/7/head');
    await m.prepare(t);
    const out = join(dir, 'export');
    expect(await m.exportTree(t, out)).toBe(forkHead);
    expect(readFileSync(join(out, 'fork.txt'), 'utf8')).toBe('from a fork\n');
    // What it changes against its base, as a reviewer reads it.
    const changes = await m.changes(t);
    expect(changes?.commits).toMatch(/A fork’s change$/);
    expect(changes?.stat).toContain('fork.txt');
  });

  it('fails rather than read the base when GitHub has no such pull request', async () => {
    const m = new WorkspaceManager({
      root: join(dir, 'workspaces'),
      credentials: async () => ({ token: 'gho_token', remoteUrl: origin }),
    });
    await expect(m.prepare(target('pull/8/head'))).rejects.toThrow();
  });
});
