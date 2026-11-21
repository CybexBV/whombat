import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { safeSegment, WorkspaceManager, type WorkspaceTarget } from './index';

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
let calls: { repo: string; branch: string; operation: string }[];

/** A bare "GitHub" repo with main and an existing feature branch. */
function makeOrigin(): string {
  const seed = join(dir, 'seed');
  git(dir, 'init', '--quiet', '-b', 'main', seed);
  writeFileSync(join(seed, 'README.md'), 'billing-api\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'Initial commit');
  git(seed, 'checkout', '--quiet', '-b', 'feat/existing');
  writeFileSync(join(seed, 'feature.txt'), 'existing\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'Existing feature');
  git(seed, 'checkout', '--quiet', 'main');
  const bare = join(dir, 'origin.git');
  git(dir, 'clone', '--quiet', '--bare', seed, bare);
  return bare;
}

function manager() {
  return new WorkspaceManager({
    root: join(dir, 'workspaces'),
    credentials: async (req) => {
      calls.push(req);
      return { token: 'gho_host_account_token', remoteUrl: origin };
    },
  });
}

function target(branch: string, extra: Partial<WorkspaceTarget> = {}): WorkspaceTarget {
  return {
    burrow: 'burrow-hq',
    repo: 'burrowhq/billing-api',
    branch,
    baseBranch: 'main',
    cloneUrl: origin,
    ...extra,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-ws-'));
  origin = makeOrigin();
  calls = [];
});

describe('WorkspaceManager', () => {
  it('lays out one worktree per burrow, repo and branch', () => {
    const m = manager();
    expect(m.paths(target('feat/invoice-pdf'))).toEqual({
      mirror: join(dir, 'workspaces', 'burrow-hq', '.mirrors', 'burrowhq--billing-api.git'),
      worktree: join(dir, 'workspaces', 'burrow-hq', 'burrowhq--billing-api', 'feat--invoice-pdf'),
      repo: join(dir, 'workspaces', 'burrow-hq', '.repos', 'burrowhq--billing-api', 'feat--invoice-pdf.git'),
    });
    // Names that are not plain keep a readable form (never a dot name) plus a hash of the exact name.
    expect(safeSegment('..')).toMatch(/^_\.\.~[0-9a-f]{12}$/);
    expect(safeSegment('.git')).toMatch(/^_\.git~[0-9a-f]{12}$/);
    expect(safeSegment('a b/c')).toMatch(/^a-b--c~[0-9a-f]{12}$/);
    expect(safeSegment('feat--x')).not.toBe(safeSegment('feat/x'));
    expect(safeSegment('x'.repeat(255))).toHaveLength(80 + 13);
  });

  it('gives every branch its own worktree, even when their names look alike', async () => {
    const m = manager();
    const names = [
      'feat/x',
      'feat--x',
      'feat-/x',
      'feat/-x',
      'feat/ä',
      'feat/ö',
      'Feat/X',
      'feat/X',
      'main',
      'Main',
    ];
    const paths = names.map((branch) => m.paths(target(branch)).worktree);
    expect(new Set(paths).size).toBe(names.length);
    // Also on case-insensitive file systems (macOS runners).
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(names.length);
    // A turn for one never lands in the other's checkout.
    const a = await m.prepare(target('feat/x'));
    const b = await m.prepare(target('feat--x'));
    expect(b).toMatchObject({ created: true });
    expect(b.path).not.toBe(a.path);
    expect(git(a.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/x');
    expect(git(b.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat--x');
  });

  it('puts a reused worktree back on its branch, and refuses one left elsewhere with changes', async () => {
    const m = manager();
    const ws = await m.prepare(target('feat/existing'));
    git(ws.path, 'switch', '--quiet', '-c', 'feat/elsewhere');
    const again = await m.prepare(target('feat/existing'));
    expect(again).toMatchObject({ created: false, path: ws.path, branch: 'feat/existing' });
    expect(git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/existing');
    git(ws.path, 'switch', '--quiet', 'feat/elsewhere');
    writeFileSync(join(ws.path, 'wip.txt'), 'local work\n');
    await expect(m.prepare(target('feat/existing'))).rejects.toThrow(/feat\/elsewhere/);
    expect(readFileSync(join(ws.path, 'wip.txt'), 'utf8')).toBe('local work\n');
  });

  it('creates a new branch from the base branch, with the agent’s identity', async () => {
    const m = manager();
    const ws = await m.prepare(
      target('feat/invoice-pdf', { identity: { name: 'Dusty', email: 'dusty@agents.whombat.com' } }),
    );
    expect(ws.created).toBe(true);
    expect(git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/invoice-pdf');
    expect(ws.head).toBe(git(origin, 'rev-parse', 'main'));
    expect(readFileSync(join(ws.path, 'README.md'), 'utf8')).toBe('billing-api\n');
    expect(git(ws.path, 'config', 'user.name')).toBe('Dusty');
    // The agent can commit there, as itself (the bare mirror's core.bare does not leak into it).
    writeFileSync(join(ws.path, 'pdf.ts'), 'export {};\n');
    execFileSync('git', ['add', '.'], { cwd: ws.path });
    execFileSync('git', ['commit', '--quiet', '-m', 'Add PDF'], { cwd: ws.path });
    expect(git(ws.path, 'log', '-1', '--format=%an <%ae>')).toBe('Dusty <dusty@agents.whombat.com>');
    expect(calls).toEqual([{ repo: 'burrowhq/billing-api', branch: 'feat/invoice-pdf', operation: 'fetch' }]);
    // The token never lands in git config.
    const config = readFileSync(join(m.paths(target('x')).mirror, 'config'), 'utf8');
    expect(config).not.toContain('gho_host_account_token');
    // Preparing again keeps working.
    expect(
      (await m.prepare(target('feat/invoice-pdf', { identity: { name: 'Dusty', email: 'b@x' } }))).created,
    ).toBe(false);
  });

  it('checks out an existing remote branch and reuses the worktree next time', async () => {
    const m = manager();
    const first = await m.prepare(target('feat/existing'));
    expect(first.created).toBe(true);
    expect(existsSync(join(first.path, 'feature.txt'))).toBe(true);
    writeFileSync(join(first.path, 'wip.txt'), 'local work\n');
    const second = await m.prepare(target('feat/existing'));
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    expect(readFileSync(join(second.path, 'wip.txt'), 'utf8')).toBe('local work\n');
  });

  it('fast-forwards a clean worktree when the remote moved', async () => {
    const m = manager();
    const ws = await m.prepare(target('feat/existing'));
    const other = join(dir, 'other');
    git(dir, 'clone', '--quiet', '-b', 'feat/existing', origin, other);
    writeFileSync(join(other, 'more.txt'), 'more\n');
    git(other, 'add', '.');
    git(other, 'commit', '--quiet', '-m', 'More');
    git(other, 'push', '--quiet', 'origin', 'feat/existing');
    const again = await m.prepare(target('feat/existing'));
    expect(again.head).toBe(git(origin, 'rev-parse', 'feat/existing'));
    expect(existsSync(join(ws.path, 'more.txt'))).toBe(true);
  });

  it('fetches nothing when its copy of the branch is at the head Whombat knows (turn-efficiency.md TE-10)', async () => {
    const m = manager();
    await m.prepare(target('feat/existing'));
    const head = git(origin, 'rev-parse', 'feat/existing');
    const fetches = () => calls.filter((c) => c.operation === 'fetch').length;
    const before = fetches();
    const again = await m.prepare(target('feat/existing', { headSha: head }));
    expect(fetches()).toBe(before);
    expect(again.head).toBe(head);
    // Someone pushed since: the head Whombat knows is new here, so it fetches.
    const other = join(dir, 'other');
    git(dir, 'clone', '--quiet', '-b', 'feat/existing', origin, other);
    writeFileSync(join(other, 'more.txt'), 'more\n');
    git(other, 'add', '.');
    git(other, 'commit', '--quiet', '-m', 'More');
    git(other, 'push', '--quiet', 'origin', 'feat/existing');
    const moved = git(origin, 'rev-parse', 'feat/existing');
    const third = await m.prepare(target('feat/existing', { headSha: moved }));
    expect(fetches()).toBe(before + 1);
    expect(third.head).toBe(moved);
    // The runner's own push leaves the source on the pushed head: the next turn on it fetches nothing.
    writeFileSync(join(third.path, 'mine.txt'), 'mine\n');
    git(third.path, 'add', '.');
    git(third.path, 'commit', '--quiet', '-m', 'Mine');
    await m.push(target('feat/existing'));
    const pushed = git(origin, 'rev-parse', 'feat/existing');
    const after = fetches();
    expect((await m.prepare(target('feat/existing', { headSha: pushed }))).head).toBe(pushed);
    expect(fetches()).toBe(after);
  });

  it('pushes the branch with push credentials', async () => {
    const m = manager();
    const ws = await m.prepare(target('feat/new-thing'));
    writeFileSync(join(ws.path, 'new.txt'), 'new\n');
    git(ws.path, 'add', '.');
    git(ws.path, 'commit', '--quiet', '-m', 'Add new thing');
    expect(await m.ahead(target('feat/new-thing'))).toBe(1);
    await m.push(target('feat/new-thing'));
    expect(git(origin, 'rev-parse', 'feat/new-thing')).toBe(git(ws.path, 'rev-parse', 'HEAD'));
    expect(await m.ahead(target('feat/new-thing'))).toBe(0);
    expect(await m.ahead(target('feat/never-prepared'))).toBe(0);
    expect(calls.at(-1)).toEqual({
      repo: 'burrowhq/billing-api',
      branch: 'feat/new-thing',
      operation: 'push',
      sha: git(ws.path, 'rev-parse', 'HEAD'),
    });
  });

  it('never runs git with hooks or config the agent planted in its worktree', async () => {
    const m = manager();
    const t = target('feat/hooked', { identity: { name: 'Dusty', email: 'dusty@agents.whombat.com' } });
    const ws = await m.prepare(t);
    const { repo } = m.paths(t);
    // A trusted agent (or one whose sandbox failed) points `.git` at a git dir it made in its cwd: the real
    // refs and objects (commondir → its workspace repo) plus config of its own.
    const admin = readFileSync(join(ws.path, '.git'), 'utf8').replace('gitdir:', '').trim();
    const fake = join(ws.path, '.g');
    mkdirSync(fake);
    copyFileSync(join(admin, 'HEAD'), join(fake, 'HEAD'));
    copyFileSync(join(admin, 'index'), join(fake, 'index'));
    writeFileSync(join(fake, 'commondir'), `${repo}\n`);
    writeFileSync(join(ws.path, '.git'), `gitdir: ${fake}\n`);
    // It commits, so the runner has something to push…
    writeFileSync(join(ws.path, 'feature.ts'), 'export {};\n');
    git(ws.path, 'add', 'feature.ts');
    git(ws.path, 'commit', '--quiet', '-m', 'Add feature');
    const commit = git(ws.path, 'rev-parse', 'HEAD');
    // …then plants hooks and an fsmonitor that would run as the runner, outside any sandbox.
    const stolen = join(dir, 'stolen-env.txt');
    const hooks = join(ws.path, 'h');
    mkdirSync(hooks);
    for (const hook of ['pre-push', 'reference-transaction', 'post-merge', 'post-checkout'])
      writeFileSync(join(hooks, hook), `#!/bin/sh\nenv >> '${stolen}'\n`, { mode: 0o755 });
    writeFileSync(join(hooks, 'fsmonitor'), `#!/bin/sh\nenv >> '${stolen}'\nexit 1\n`, { mode: 0o755 });
    writeFileSync(
      join(fake, 'config.worktree'),
      `[core]\n\thooksPath = ${hooks}\n\tfsmonitor = ${join(hooks, 'fsmonitor')}\n`,
    );

    expect(await m.ahead(t)).toBe(1);
    await m.push(t);
    await m.prepare(t);
    expect(await m.ahead(t)).toBe(0);
    await m.push(t);

    // Nothing the agent planted ran, so the push token never left the runner…
    expect(existsSync(stolen) ? readFileSync(stolen, 'utf8') : '').toBe('');
    // …and the agent's commit was pushed all the same.
    expect(git(origin, 'rev-parse', 'feat/hooked')).toBe(commit);
  });

  it('serialises concurrent prepares of the same repo', async () => {
    const m = manager();
    const [a, b] = await Promise.all([m.prepare(target('feat/a')), m.prepare(target('feat/b'))]);
    expect(a.created && b.created).toBe(true);
    expect(git(a.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/a');
    expect(git(b.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/b');
  });

  it('rejects unsafe branch names and a missing base', async () => {
    const m = manager();
    await expect(m.prepare(target('--upload-pack=evil'))).rejects.toThrow('Invalid branch name');
    await expect(m.prepare(target('feat/../../etc'))).rejects.toThrow('Invalid branch name');
    await expect(m.prepare(target('feat/x', { baseBranch: 'nope' }))).rejects.toThrow(
      'Base branch nope does not exist',
    );
  });

  it('removes a workspace, worktree and git dir', async () => {
    const m = manager();
    const a = await m.prepare(target('feat/a'));
    await m.remove(target('feat/a'));
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(m.paths(target('feat/a')).repo)).toBe(false);
    expect((await m.prepare(target('feat/a'))).created).toBe(true);
  });

  it('cleans up merged and idle workspaces, never uncommitted or unpushed work', async () => {
    const m = manager();
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    const age = (path: string, n: number) => utimesSync(path, days(n), days(n));
    const commit = (ws: { path: string; env: Record<string, string> }, file: string) => {
      writeFileSync(join(ws.path, file), `${file}\n`);
      git(ws.path, 'add', file);
      git(ws.path, 'commit', '--quiet', '-m', `Add ${file}`);
    };
    // Merged into main on GitHub (no commits of its own), idle two days: goes.
    const merged = await m.prepare(target('feat/merged'));
    // Pushed, idle 20 days: goes.
    const pushed = await m.prepare(target('feat/pushed'));
    commit(pushed, 'pushed.txt');
    await m.push(target('feat/pushed'));
    // Committed, never pushed, idle 20 days: stays.
    const unpushed = await m.prepare(target('feat/unpushed'));
    commit(unpushed, 'unpushed.txt');
    // Uncommitted work (an untracked file), idle 20 days: stays.
    const dirty = await m.prepare(target('feat/dirty'));
    writeFileSync(join(dirty.path, 'draft.txt'), 'draft\n');
    // Used yesterday: not due.
    const recent = await m.prepare(target('feat/recent'));
    commit(recent, 'recent.txt');
    // A turn works in it right now: left alone.
    const busy = await m.prepare(target('feat/busy'));
    const release = m.hold(target('feat/busy'));
    const scratch = await m.scratch('dsp_1');
    age(merged.path, 2);
    for (const ws of [pushed, unpushed, dirty, busy]) age(ws.path, 20);
    age(recent.path, 1);
    age(scratch, 20);

    const result = await m.cleanup({ olderThanMs: 14 * 86_400_000 });
    expect(result.removed.sort()).toEqual([merged.path, pushed.path, scratch].sort());
    expect(result.kept).toEqual(
      expect.arrayContaining([
        { path: unpushed.path, reason: '1 commit(s) not on GitHub' },
        { path: dirty.path, reason: 'uncommitted changes' },
      ]),
    );
    expect(result.kept).toHaveLength(2);
    for (const ws of [merged, pushed]) {
      expect(existsSync(ws.path)).toBe(false);
      expect(existsSync(m.paths(target(ws.branch)).repo)).toBe(false);
    }
    for (const ws of [unpushed, dirty, recent, busy]) expect(existsSync(ws.path)).toBe(true);
    expect(readFileSync(join(dirty.path, 'draft.txt'), 'utf8')).toBe('draft\n');
    // Released, the busy one is due like any other (clean, nothing of its own): merged, so it goes.
    release();
    expect((await m.cleanup({ olderThanMs: 14 * 86_400_000 })).removed).toEqual([busy.path]);
    // A cleaned-up branch can be prepared again; the pushed one picks up where GitHub is.
    expect((await m.prepare(target('feat/merged'))).created).toBe(true);
    const again = await m.prepare(target('feat/pushed'));
    expect(existsSync(join(again.path, 'pushed.txt'))).toBe(true);
  });

  it('adopts a worktree an earlier runner added to the mirror, and cleans up old-layout ones there', async () => {
    const m = manager();
    const t = target('feat/old');
    // Before workspace repos: the worktree was registered in the mirror, its branch in the mirror's refs.
    await m.prepare(target('feat/seed-mirror'));
    const { mirror, worktree } = m.paths(t);
    git(dir, '--git-dir', mirror, 'worktree', 'add', '--quiet', '-b', 'feat/old', worktree, 'origin/main');
    writeFileSync(join(worktree, 'old.txt'), 'old\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '--quiet', '-m', 'Old work');
    const ws = await m.prepare(t);
    expect(ws).toMatchObject({ created: false, path: worktree });
    expect(git(dir, '--git-dir', mirror, 'worktree', 'list')).not.toContain(worktree);
    expect(await m.ahead(t)).toBe(1);

    // An old-layout worktree nobody prepared since, idle and pushed: removed from the mirror with git.
    const stale = m.paths(target('feat/stale')).worktree;
    git(dir, '--git-dir', mirror, 'worktree', 'add', '--quiet', '-b', 'feat/stale', stale, 'origin/main');
    const old = new Date(Date.now() - 20 * 86_400_000);
    utimesSync(stale, old, old);
    const result = await m.cleanup({ olderThanMs: 14 * 86_400_000 });
    expect(result.removed).toEqual([stale]);
    expect(git(dir, '--git-dir', mirror, 'worktree', 'list')).not.toContain(stale);
  });
});

describe('the agent’s git in a worktree (RN-R1)', () => {
  /** git as the agent's shell runs it: nothing of the test's own git environment, the workspace's on top. */
  const agentGit = (cwd: string, env: Record<string, string>, ...args: string[]) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...clean,
        GIT_AUTHOR_NAME: 'Dusty',
        GIT_AUTHOR_EMAIL: 'dusty@agents.example',
        GIT_COMMITTER_NAME: 'Dusty',
        GIT_COMMITTER_EMAIL: 'dusty@agents.example',
        ...env,
      },
    }).trim();
  };

  it('finds its git dir through the worktree’s .git file; a test fixture’s repository elsewhere stays its own', async () => {
    const m = manager();
    const t = target('feat/tracker-16');
    const ws = await m.prepare(t);
    const { repo } = m.paths(t);
    // Nothing names a git dir in the agent's environment: the worktree's `.git` file does.
    expect(ws.env).toEqual({});
    const admin = readFileSync(join(ws.path, '.git'), 'utf8')
      .replace(/^gitdir:\s*/, '')
      .trim();
    expect(realpathSync(admin).startsWith(`${realpathSync(join(repo, 'worktrees'))}/`)).toBe(true);
    expect(realpathSync(agentGit(ws.path, ws.env, 'rev-parse', '--absolute-git-dir'))).toBe(
      realpathSync(admin),
    );
    expect(
      realpathSync(agentGit(ws.path, ws.env, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
    ).toBe(realpathSync(repo));
    // The agent commits on its branch as before.
    writeFileSync(join(ws.path, 'fix.ts'), 'export {};\n');
    agentGit(ws.path, ws.env, 'add', 'fix.ts');
    agentGit(ws.path, ws.env, 'commit', '--quiet', '-m', 'Fix it');
    expect(await m.ahead(t)).toBe(1);
    const tip = agentGit(ws.path, ws.env, 'rev-parse', 'HEAD');

    // The repository's own tests make a repository in a temporary folder and commit a baseline there.
    const fixture = mkdtempSync(join(tmpdir(), 'wb-fixture-'));
    agentGit(fixture, ws.env, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(fixture, 'baseline.txt'), 'baseline\n');
    agentGit(fixture, ws.env, 'add', '.');
    agentGit(fixture, ws.env, 'commit', '--quiet', '--allow-empty', '-m', 'baseline');
    expect(agentGit(fixture, ws.env, 'log', '--format=%s')).toBe('baseline');
    expect(realpathSync(agentGit(fixture, ws.env, 'rev-parse', '--absolute-git-dir'))).toBe(
      realpathSync(join(fixture, '.git')),
    );
    // The agent's branch, its worktree and its git dir are as they were.
    expect(agentGit(ws.path, ws.env, 'rev-parse', 'HEAD')).toBe(tip);
    expect(agentGit(ws.path, ws.env, 'status', '--porcelain')).toBe('');
    expect(await m.ahead(t)).toBe(1);

    // What `GIT_DIR` in its environment did (run #9): the fixture's commit landed on the agent's branch.
    const pinned = { GIT_DIR: admin, GIT_WORK_TREE: ws.path };
    agentGit(fixture, pinned, 'commit', '--quiet', '--allow-empty', '-m', 'baseline');
    expect(agentGit(ws.path, ws.env, 'log', '-1', '--format=%s')).toBe('baseline');
    expect(await m.ahead(t)).toBe(2);
  });
});

describe('WorkspaceManager cleanup of squash-merged branches', () => {
  const IDLE = 14 * 86_400_000;
  const age = (path: string, n: number) => {
    const at = new Date(Date.now() - n * 86_400_000);
    utimesSync(path, at, at);
  };
  const commit = (path: string, file: string, content = `${file}\n`) => {
    writeFileSync(join(path, file), content);
    git(path, 'add', file);
    git(path, 'commit', '--quiet', '-m', `Change ${file}`);
  };
  let clones = 0;
  /** Does `work` in a fresh clone of the "GitHub" repo on main and pushes main. */
  const onMain = (work: (clone: string) => void) => {
    const clone = join(dir, `github-${clones++}`);
    git(dir, 'clone', '--quiet', origin, clone);
    work(clone);
    git(clone, 'push', '--quiet', 'origin', 'main');
  };
  /** GitHub's “Squash and merge”: the branch's whole change as one new commit on main. */
  const squashMerge = (branch: string) =>
    onMain((clone) => {
      git(clone, 'merge', '--squash', '--quiet', `origin/${branch}`);
      git(clone, 'commit', '--quiet', '-m', `Squashed ${branch} (#5)`);
    });
  /** A workspace with two pushed commits to `file` on `branch`, squash-merged into main on GitHub. */
  const squashed = async (m: WorkspaceManager, branch: string, file = 'fix.txt') => {
    const ws = await m.prepare(target(branch));
    commit(ws.path, file);
    commit(ws.path, file, `${file}\nand a second commit\n`);
    await m.push(target(branch));
    squashMerge(branch);
    return ws;
  };
  /** The runner's next fetch of the repo (any turn in it): the mirror learns main, the workspace does not. */
  const fetched = (m: WorkspaceManager) => m.prepare(target('feat/other-turn'));
  const gone = (m: WorkspaceManager, ws: { path: string; branch: string }) =>
    !existsSync(ws.path) && !existsSync(m.paths(target(ws.branch)).repo);

  it('removes a squash-merged branch after the merged idle time, never earlier or while a turn holds it', async () => {
    const m = manager();
    const merged = await squashed(m, 'feat/issue-5');
    const recent = await squashed(m, 'feat/recent', 'recent.txt');
    const busy = await squashed(m, 'feat/busy', 'busy.txt');
    const release = m.hold(target('feat/busy'));
    // An ordinary merge commit, seen only in the mirror too.
    const mergeCommit = await m.prepare(target('feat/merge-commit'));
    commit(mergeCommit.path, 'merged.txt');
    await m.push(target('feat/merge-commit'));
    onMain((clone) => git(clone, 'merge', '--no-ff', '--quiet', '-m', 'Merge', 'origin/feat/merge-commit'));
    await fetched(m);
    for (const ws of [merged, busy, mergeCommit]) age(ws.path, 2);
    age(recent.path, 0.5);

    const result = await m.cleanup({ olderThanMs: IDLE });
    expect(result.removed.sort()).toEqual([merged.path, mergeCommit.path].sort());
    expect(result.kept).toEqual([]);
    expect(gone(m, merged)).toBe(true);
    expect(gone(m, mergeCommit)).toBe(true);
    for (const ws of [recent, busy]) expect(existsSync(ws.path)).toBe(true);
    release();
    expect((await m.cleanup({ olderThanMs: IDLE })).removed).toEqual([busy.path]);
  });

  it('removes a squash-merged branch whose head branch GitHub deleted, though its commits are on no remote', async () => {
    const m = manager();
    const ws = await squashed(m, 'feat/issue-5');
    // The automation's head branch goes after the merge; a fetch with --prune drops its remote-tracking ref.
    git(origin, 'branch', '-D', 'feat/issue-5');
    const repo = m.paths(target('feat/issue-5')).repo;
    git(dir, '--git-dir', repo, 'fetch', '--prune', '--quiet', 'origin');
    expect(git(ws.path, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin')).toBe('2');
    age(ws.path, 2);

    const result = await m.cleanup({ olderThanMs: IDLE });
    expect(result).toEqual({ removed: [ws.path], kept: [] });
    expect(gone(m, ws)).toBe(true);
  });

  it('removes a squash-merged branch when more commits landed on the base since', async () => {
    const m = manager();
    const ws = await squashed(m, 'feat/issue-5');
    onMain((clone) => commit(clone, 'later.txt'));
    onMain((clone) => commit(clone, 'fix.txt', 'fix.txt\nand a second commit\nand a later edit on main\n'));
    await fetched(m);
    age(ws.path, 2);

    expect((await m.cleanup({ olderThanMs: IDLE })).removed).toEqual([ws.path]);
    expect(gone(m, ws)).toBe(true);
  });

  it('keeps a branch whose change is not in the base', async () => {
    const m = manager();
    // The base has a different change to the same file.
    const other = await m.prepare(target('feat/other-fix'));
    commit(other.path, 'fix.txt');
    // Only what it pushed was squash-merged; a commit made after is its own.
    const more = await squashed(m, 'feat/more', 'part.txt');
    commit(more.path, 'more.txt');
    onMain((clone) => commit(clone, 'fix.txt', 'fixed differently\n'));
    await fetched(m);
    for (const ws of [other, more]) age(ws.path, 2);

    expect(await m.cleanup({ olderThanMs: IDLE })).toEqual({ removed: [], kept: [] });
    for (const ws of [other, more]) age(ws.path, 20);
    const result = await m.cleanup({ olderThanMs: IDLE });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(
      expect.arrayContaining([
        { path: other.path, reason: '1 commit(s) not on GitHub' },
        { path: more.path, reason: '1 commit(s) not on GitHub' },
      ]),
    );
    expect(result.kept).toHaveLength(2);
  });

  it('keeps a squash-merged worktree with uncommitted changes', async () => {
    const m = manager();
    const ws = await squashed(m, 'feat/issue-5');
    await fetched(m);
    writeFileSync(join(ws.path, 'draft.txt'), 'draft\n');
    age(ws.path, 2);

    expect(await m.cleanup({ olderThanMs: IDLE })).toEqual({
      removed: [],
      kept: [{ path: ws.path, reason: 'uncommitted changes' }],
    });
    expect(readFileSync(join(ws.path, 'draft.txt'), 'utf8')).toBe('draft\n');
  });
});
