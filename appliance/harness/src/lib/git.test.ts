import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureClone, seedFor } from './git.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'harness-git-'));
  roots.push(root);
  const source = join(root, 'source');
  const src = join(root, 'src');
  mkdirSync(source);
  mkdirSync(src);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.email', 'test@example.com');
  git(source, 'config', 'user.name', 'test');
  const commit = (file: string) => {
    writeFileSync(join(source, file), `${file}\n`);
    git(source, 'add', '.');
    git(source, 'commit', '-q', '-m', file);
    return git(source, 'rev-parse', 'HEAD');
  };
  return { root, source, src, git, commit };
}

const packOf = (repo: string) => {
  const dir = join(repo, '.git', 'objects', 'pack');
  const pack = readdirSync(dir).find((f) => f.endsWith('.pack'));
  if (!pack) throw new Error(`${repo} has no pack`);
  return join(dir, pack);
};

describe("the dev stack's clean clones (IN-05)", () => {
  it('clones the first copy afresh and seeds the next one from it', async () => {
    const { source, src, git, commit } = setup();
    const first = commit('a.txt');
    expect(await ensureClone(source, first, join(src, 'app@1'))).toBe('cloned');

    const second = commit('b.txt');
    // Staged but not committed: it must not reach a copy.
    writeFileSync(join(source, 'secret.txt'), 'not committed\n');
    git(source, 'add', 'secret.txt');
    const staged = git(source, 'rev-parse', ':secret.txt');

    const dest = join(src, 'app@2');
    expect(await ensureClone(source, second, dest)).toBe('seeded');
    expect(git(dest, 'rev-parse', 'HEAD')).toBe(second);
    expect(git(dest, 'status', '--porcelain')).toBe('');
    expect(git(dest, 'config', '--get', 'remote.origin.url')).toBe(source);
    expect(() => git(dest, 'cat-file', '-e', staged)).toThrow();
    // The seed's pack is shared, not copied.
    expect(statSync(packOf(dest)).ino).toBe(statSync(packOf(join(src, 'app@1'))).ino);

    // Removing the seed leaves the copy whole.
    rmSync(join(src, 'app@1'), { recursive: true, force: true });
    expect(git(dest, 'fsck', '--connectivity-only', '--no-dangling')).toBe('');
    expect(await ensureClone(source, second, dest)).toBe('reused');
  });

  it('seeds only from a clone of the same repository', async () => {
    const { root, source, src, git, commit } = setup();
    const rev = commit('a.txt');
    const other = join(root, 'other');
    mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    git(
      other,
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    );
    git(src, 'clone', '-q', other, 'relay@1');
    expect(await seedFor(source, join(src, 'app@1'))).toBeNull();
    expect(await ensureClone(source, rev, join(src, 'app@1'))).toBe('cloned');
    expect(await seedFor(source, join(src, 'app@2'))).toBe(join(src, 'app@1'));
  });

  it('still makes a whole copy from a seed that lost its objects', async () => {
    const { source, src, git, commit } = setup();
    const rev = commit('a.txt');
    expect(await ensureClone(source, rev, join(src, 'app@1'))).toBe('cloned');
    // A commit the source doesn't have: neither way can check it out.
    await expect(ensureClone(source, '0'.repeat(40), join(src, 'app@0'))).rejects.toThrow();
    const next = commit('b.txt');
    rmSync(join(src, 'app@1', '.git', 'objects', 'pack'), { recursive: true, force: true });
    const dest = join(src, 'app@2');
    expect(['seeded', 'cloned']).toContain(await ensureClone(source, next, dest));
    expect(git(dest, 'rev-parse', 'HEAD')).toBe(next);
    expect(git(dest, 'fsck', '--connectivity-only', '--no-dangling')).toBe('');
  });
});
