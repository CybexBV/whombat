import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applianceIn,
  archives,
  dirAt,
  findSource,
  flakeAtCommit,
  flakeHasInput,
  flakeOf,
  samePathsAt,
  showAt,
  sourceRecord,
  treeFlake,
} from './source.ts';

// The same cases as release/source_test.go, which tries release/lib/source.sh.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with one commit per map of files; the commits' ids in order. */
function repository(name: string, ...commits: Record<string, string>[]): { dir: string; revs: string[] } {
  if (roots.length === 0) roots.push(realpathSync(mkdtempSync(join(tmpdir(), 'harness-source-'))));
  const dir = join(roots[0] as string, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  const revs = commits.map((files, i) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `commit ${i}`);
    return git(dir, 'rev-parse', 'HEAD');
  });
  return { dir, revs };
}

const APPLIANCE = { 'flake.nix': '{ }\n', 'nix/profiles/prod.nix': '{ }\n', 'release/note': 'own\n' };
const inFolder = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [`appliance/${path}`, text]));

/** The old appliance repository, and Whombat: first without the appliance, then with it as a folder. */
function world() {
  const old = repository('whombat-appliance', APPLIANCE);
  const whombat = repository(
    'whombat',
    { 'package.json': '{}\n' },
    { ...inFolder({ ...APPLIANCE, 'release/note': 'folder\n' }) },
  );
  return {
    old: old.dir,
    oldRev: old.revs[0] as string,
    whombat: whombat.dir,
    before: whombat.revs[0] as string,
    folderRev: whombat.revs[1] as string,
  };
}

describe('where a release’s source is', () => {
  it('finds a commit of the appliance’s own repository at its top', () => {
    const w = world();
    const s = findSource(w.oldRev, { checkout: w.old, archives: [] });
    expect(s).toEqual({ repository: w.old, rev: w.oldRev, dir: '' });
    expect(flakeOf(s)).toBe(`git+file://${w.old}?rev=${w.oldRev}`);
    expect(showAt(s, 'release/note')).toBe('own\n');
    expect(applianceIn('/x/worktree', s)).toBe('/x/worktree');
    expect(sourceRecord(s, false)).toEqual({ repository: 'whombat-appliance', rev: w.oldRev, dirty: false });
  });

  it('finds a commit of Whombat with the appliance in its folder', () => {
    const w = world();
    const s = findSource(w.folderRev, { checkout: join(w.whombat, 'appliance'), archives: [] });
    expect(s).toEqual({ repository: w.whombat, rev: w.folderRev, dir: 'appliance' });
    expect(flakeOf(s)).toBe(`git+file://${w.whombat}?rev=${w.folderRev}&dir=appliance`);
    expect(showAt(s, 'release/note')).toBe('folder\n');
    expect(applianceIn('/x/worktree', s)).toBe('/x/worktree/appliance');
    expect(sourceRecord(s, true)).toEqual({
      repository: 'whombat',
      rev: w.folderRev,
      dir: 'appliance',
      dirty: true,
    });
  });

  it('looks in the archives, in order, for a commit the checkout doesn’t have', () => {
    const w = world();
    const other = repository('other', { 'README.md': 'nothing\n' });
    const o = { checkout: join(w.whombat, 'appliance'), archives: [other.dir, w.old] };
    expect(findSource(w.oldRev, o)).toEqual({ repository: w.old, rev: w.oldRev, dir: '' });
    expect(flakeAtCommit(w.oldRev, o)).toBe(`git+file://${w.old}?rev=${w.oldRev}`);
    // The checkout comes first, even when an archive has the commit too.
    expect(findSource(w.folderRev, { ...o, archives: [w.whombat] }).repository).toBe(w.whombat);
  });

  it('compares paths at two commits that are in different repositories', () => {
    // The history from before, kept as an archive, and the published repository: one commit with the same files.
    const web = { 'apps/web/index.html': '<p>hello</p>\n', 'package.json': '{}\n' };
    const archive = repository(
      'archive',
      { ...web, 'notes/private.md': 'old\n' },
      { ...web, 'apps/web/index.html': '<p>new</p>\n' },
    );
    const published = repository('published', web, { 'docs/readme.md': 'more\n' });
    const [old, changed] = archive.revs as [string, string];
    const [root, later] = published.revs as [string, string];
    const o = { checkout: published.dir, archives: [archive.dir] };
    const paths = ['apps/web', 'apps/widget', 'package.json'];
    // The root holds the files the archive's commit held, though neither repository has the other's commit.
    expect(samePathsAt(old, root, paths, o)).toBe(true);
    // A short id, as a build stamp carries it, and a later commit that touched nothing of the paths.
    expect(samePathsAt(old.slice(0, 7), later, paths, o)).toBe(true);
    expect(samePathsAt(changed, root, paths, o)).toBe(false);
    // A path only one of them has is a difference; a commit nobody has is no answer.
    expect(samePathsAt(old, root, [...paths, 'notes'], o)).toBe(false);
    expect(samePathsAt('0'.repeat(40), root, paths, o)).toBeNull();
    expect(samePathsAt(old, root, paths, { checkout: published.dir, archives: [] })).toBeNull();
  });

  it('refuses a commit nobody has, and one that holds no appliance', () => {
    const w = world();
    const missing = '0123456789012345678901234567890123456789';
    expect(() => findSource(missing, { checkout: w.whombat, archives: [w.old] })).toThrow(/WB_ARCHIVE_GIT/);
    expect(() => findSource(w.before, { checkout: w.whombat, archives: [] })).toThrow(/holds no appliance/);
    expect(() => dirAt(w.whombat, w.before)).toThrow(/holds no appliance/);
  });

  it('names the working tree’s flake: the folder itself at a repository’s top, the repository around a folder', () => {
    const w = world();
    expect(treeFlake(w.old)).toBe(`path:${w.old}`);
    expect(treeFlake(join(w.whombat, 'appliance'))).toBe(`git+file://${w.whombat}?dir=appliance`);
  });

  it('reads the archives from WB_ARCHIVE_GIT, else the maintainers’ old checkouts that exist', () => {
    expect(archives({ WB_ARCHIVE_GIT: '/a:/b::' })).toEqual(['/a', '/b']);
    expect(archives({ WB_ARCHIVE_GIT: '' })).toEqual([]);
    const found = archives({}, (p) => p.endsWith('whombat-appliance'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/\/Code\/whombat-appliance$/);
  });

  it('says whether a flake takes an input of its own', () => {
    const lock = JSON.stringify({ nodes: { root: { inputs: { nixpkgs: 'nixpkgs', whombat: 'whombat' } } } });
    expect(flakeHasInput(lock, 'whombat')).toBe(true);
    expect(flakeHasInput(lock, 'whombat-hosts')).toBe(false);
  });
});
