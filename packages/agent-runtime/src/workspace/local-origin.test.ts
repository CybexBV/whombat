import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceManager, type WorkspaceTarget } from './index';
import {
  createLocalOrigin,
  LocalMergeRefused,
  LocalOriginExistsError,
  localBranchHead,
  localChanges,
  localCommitParent,
  localFileAt,
  localMergeBase,
  localOriginPath,
  localReadme,
  localRemoteConfig,
  mergeLocalBranch,
} from './local-origin';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dusty',
      GIT_AUTHOR_EMAIL: 'dusty@agents.burrow-hq.whombat.com',
      GIT_COMMITTER_NAME: 'Dusty',
      GIT_COMMITTER_EMAIL: 'dusty@agents.burrow-hq.whombat.com',
    },
  }).trim();

let dir: string;
let workspaces: string;
const author = { name: 'Mara Okafor', email: 'mara@example.com' };
const now = new Date('2026-09-30T12:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-local-'));
  workspaces = join(dir, 'workspaces');
});

describe('local repos’ origins (repositories.md RP-02)', () => {
  it('makes a shared bare repo with main and a first commit by the person who created it', async () => {
    const { path, head } = await createLocalOrigin({
      workspaces,
      burrowId: 'bur_hq',
      name: 'Whombat_Website',
      description: 'The public website.',
      author,
      now,
    });
    expect(path).toBe(localOriginPath(workspaces, 'bur_hq', 'Whombat_Website'));
    expect(git(path, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(git(path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(git(path, 'rev-parse', 'main')).toBe(head);
    // `%at`, not `%aI`: how git writes a UTC offset in ISO dates (`Z` or `+00:00`) depends on its version (CI-T06).
    expect(git(path, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s|%at', 'main')).toBe(
      `Mara Okafor <mara@example.com>|Mara Okafor <mara@example.com>|Create Whombat_Website|${now.getTime() / 1000}`,
    );
    expect(git(path, 'show', 'main:README.md')).toBe(
      localReadme('Whombat_Website', 'The public website.').trim(),
    );
    expect(git(path, 'config', 'user.name')).toBe('Mara Okafor');
    expect(git(path, 'config', 'user.email')).toBe('mara@example.com');
    expect(git(path, 'config', 'core.sharedRepository')).toBe('1');
    // The runner (another user in the workspaces group) reads and writes it.
    expect(statSync(path).mode & 0o7777).toBe(0o2770);
    expect(existsSync(join(path, 'hooks'))).toBe(false);
  });

  it('refuses a name already kept there and leaves nothing half-made', async () => {
    const o = { workspaces, burrowId: 'bur_hq', name: 'site', author, now };
    await createLocalOrigin(o);
    await expect(createLocalOrigin(o)).rejects.toBeInstanceOf(LocalOriginExistsError);
    expect(readdirSync(join(workspaces, '.origins', 'bur_hq'))).toEqual(['site.git']);
  });

  it('asks git for the file protocol and a safe directory only for a path', () => {
    expect(localRemoteConfig('https://github.com/whombat/billing.git')).toEqual([]);
    expect(localRemoteConfig('/persist/whombat/workspaces/.origins/bur_hq/site.git')).toEqual([
      'protocol.file.allow=always',
      'safe.directory=/persist/whombat/workspaces/.origins/bur_hq/site.git',
    ]);
  });

  it('lets an agent check it out, commit and push without a token, and cleanup keeps it', async () => {
    const { path } = await createLocalOrigin({ workspaces, burrowId: 'bur_hq', name: 'site', author, now });
    const calls: string[] = [];
    const m = new WorkspaceManager({
      root: workspaces,
      credentials: async (req) => {
        calls.push(req.operation);
        // What the server answers for a local repo: no token, the origin as the remote.
        return { token: '', remoteUrl: path };
      },
    });
    const t: WorkspaceTarget = {
      burrow: 'burrow-hq',
      repo: 'local/site',
      branch: 'feat/landing',
      baseBranch: 'main',
      cloneUrl: path,
      identity: { name: 'Dusty', email: 'dusty@agents.burrow-hq.whombat.com' },
    };
    const ws = await m.prepare(t);
    expect(existsSync(join(ws.path, 'README.md'))).toBe(true);
    writeFileSync(join(ws.path, 'index.html'), '<h1>Whombat</h1>\n');
    git(ws.path, 'add', '.');
    git(ws.path, 'commit', '--quiet', '-m', 'Add a landing page');
    await m.push(t);
    expect(git(path, 'rev-parse', 'feat/landing')).toBe(git(ws.path, 'rev-parse', 'HEAD'));
    expect(git(path, 'log', '-1', '--format=%an', 'feat/landing')).toBe('Dusty');
    expect(calls).toContain('push');

    const result = await m.cleanup({ olderThanMs: -1, now: Date.now() + 10 * 86_400_000 });
    expect(result.removed.some((p) => p.includes('.origins'))).toBe(false);
    expect(git(path, 'rev-parse', 'feat/landing')).toMatch(/^[0-9a-f]{40}$/);
  });
});

/** A clone of the origin with `branch` committed on top of main (and pushed), as an agent's push leaves it. */
function pushBranch(origin: string, branch: string, files: Record<string, string>, base = 'main') {
  const work = join(dir, `clone-${branch.replace(/\W/g, '-')}-${Math.random().toString(36).slice(2)}`);
  execFileSync('git', ['clone', '--quiet', '--branch', base, origin, work]);
  git(work, 'checkout', '--quiet', '-b', branch);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', `Change ${Object.keys(files).join(', ')}`);
  git(work, 'push', '--quiet', 'origin', branch);
  return git(work, 'rev-parse', 'HEAD');
}

describe('pull requests on a local origin (runs-approvals.md MDS-D05)', () => {
  const merge = {
    author,
    now,
    title: 'Add a landing page (#1)',
    message: 'Merged by Mara Okafor in Whombat.',
  };

  it('lists file names as they are, not quoted (PF-08)', async () => {
    const { path, head: first } = await createLocalOrigin({
      workspaces,
      burrowId: 'bur_hq',
      name: 'names',
      author,
      now,
    });
    const head = pushBranch(path, 'feat/names', { 'café menu.md': 'Koffie\n' });
    expect((await localChanges(path, first, head)).files).toEqual([{ path: 'café menu.md', add: 1, del: 0 }]);
  });

  it('reads a branch’s changes and squashes it into main as the person who merged', async () => {
    const { path, head: first } = await createLocalOrigin({
      workspaces,
      burrowId: 'bur_hq',
      name: 'site',
      author,
      now,
    });
    const head = pushBranch(path, 'feat/landing', { 'index.html': '<h1>Whombat</h1>\n<p>Hi</p>\n' });
    expect(await localBranchHead(path, 'feat/landing')).toBe(head);
    expect(await localBranchHead(path, 'feat/none')).toBeNull();
    const changes = await localChanges(path, first, head);
    expect(changes.files).toEqual([{ path: 'index.html', add: 2, del: 0 }]);
    expect(changes.diff).toEqual({ add: 2, del: 0, files: 1 });
    expect(changes.commits).toMatchObject([{ sha: head, message: 'Change index.html', authorName: 'Dusty' }]);

    const res = await mergeLocalBranch(path, {
      ...merge,
      base: 'main',
      branch: 'feat/landing',
      method: 'squash',
    });
    expect(res).toMatchObject({ headSha: head, baseSha: first });
    expect(git(path, 'rev-parse', 'main')).toBe(res.sha);
    expect(git(path, 'rev-list', '--parents', '-n', '1', 'main')).toBe(`${res.sha} ${first}`);
    expect(git(path, 'log', '-1', '--format=%an <%ae>|%s|%b', 'main')).toBe(
      'Mara Okafor <mara@example.com>|Add a landing page (#1)|Merged by Mara Okafor in Whombat.',
    );
    expect(git(path, 'show', 'main:index.html')).toBe('<h1>Whombat</h1>\n<p>Hi</p>');
    // Merged already: nothing to merge again.
    await expect(
      mergeLocalBranch(path, { ...merge, base: 'main', branch: 'feat/landing', method: 'merge' }),
    ).rejects.toBeInstanceOf(LocalMergeRefused);
  });

  it('makes a merge commit when asked, and refuses a conflict without touching main', async () => {
    const { path } = await createLocalOrigin({ workspaces, burrowId: 'bur_hq', name: 'site', author, now });
    const a = pushBranch(path, 'feat/a', { 'README.md': 'A\n' });
    const b = pushBranch(path, 'feat/b', { 'README.md': 'B\n' });
    const res = await mergeLocalBranch(path, { ...merge, base: 'main', branch: 'feat/a', method: 'merge' });
    expect(git(path, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1)).toEqual([
      expect.any(String),
      a,
    ]);
    const conflict = mergeLocalBranch(path, { ...merge, base: 'main', branch: 'feat/b', method: 'squash' });
    await expect(conflict).rejects.toBeInstanceOf(LocalMergeRefused);
    await expect(conflict).rejects.toThrow('feat/b conflicts with main in README.md');
    expect(git(path, 'rev-parse', 'main')).toBe(res.sha);
    expect(git(path, 'rev-parse', 'feat/b')).toBe(b);
    await expect(
      mergeLocalBranch(path, { ...merge, base: 'main', branch: 'feat/gone', method: 'squash' }),
    ).rejects.toThrow('feat/gone isn’t on this Whombat’s copy of the repository.');
  });
});

describe('a pull request’s file, whole (pr-file-view.md PF-03, PF-04)', () => {
  const read = (path: string, commit: string, file: string, maxBytes = 1024) =>
    localFileAt(path, commit, file, { maxBytes });
  const text = (v: Awaited<ReturnType<typeof localFileAt>>) =>
    v?.kind === 'file' ? new TextDecoder().decode(v.bytes) : v;

  it('reads the merge base, a commit’s parent and a file at a commit, exactly and within the limit', async () => {
    const { path, head: first } = await createLocalOrigin({
      workspaces,
      burrowId: 'bur_hq',
      name: 'site',
      author,
      now,
    });
    const head = pushBranch(path, 'feat/x', {
      'index.html': 'a\nb\n',
      'big.txt': 'x'.repeat(2000),
      '*': 'star\n',
    });
    expect(await localMergeBase(path, 'refs/heads/main', head)).toBe(first);
    expect(await localMergeBase(path, 'refs/heads/gone', head)).toBeNull();
    await expect(localMergeBase(path, '--all', head)).rejects.toThrow('isn’t a revision');
    expect(await localCommitParent(path, head)).toBe(first);
    expect(await localCommitParent(path, first)).toBeNull();
    expect(await localCommitParent(path, 'HEAD')).toBeNull();

    expect(text(await read(path, first, 'README.md'))).toBe(localReadme('site'));
    expect(await read(path, first, 'index.html')).toBeNull();
    expect(text(await read(path, head, 'index.html'))).toBe('a\nb\n');
    expect(await read(path, head, 'big.txt')).toEqual({ kind: 'too_large', size: 2000 });
    // Literal paths: `*` is the file called `*`, never a glob; a directory or `..` is no file.
    expect(text(await read(path, head, '*'))).toBe('star\n');
    expect(await read(path, first, '*')).toBeNull();
    expect(await read(path, head, '.')).toBeNull();
    expect(await read(path, head, '../site.git/HEAD')).toBeNull();
    expect(await read(path, 'main', 'README.md')).toBeNull();
  });
});

describe('origins the runner shares, under the appliance’s umask (GF-08)', () => {
  it('makes an owner-only `.origins` an older runtime left again, with the group’s bits, and the origin in it', async () => {
    const { mkdirSync, chmodSync } = await import('node:fs');
    const origins = join(workspaces, '.origins');
    mkdirSync(origins, { recursive: true });
    chmodSync(origins, 0o700);
    const made = await createLocalOrigin({ workspaces, burrowId: 'bur_x', name: 'site', author, now });
    expect(existsSync(made.path)).toBe(true);
    for (const dir of [origins, join(origins, 'bur_x'), made.path, join(made.path, 'objects')])
      expect(statSync(dir).mode & 0o070, dir).toBe(0o070);
  });
});
