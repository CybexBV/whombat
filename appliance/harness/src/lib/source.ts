/**
 * Where a release's source is. The release tools in bash have the same in `release/lib/source.sh`, and both pass the
 * same cases (`source.test.ts` here, `release/source_test.go` there).
 *
 * The appliance has lived in two places: at the root of its own repository (the appliance), and in the folder
 * `appliance/` of the Whombat repository. A release names the commit it was built from, and that commit may be in the
 * checkout these tools run from or only in an older repository kept as an archive (`WB_ARCHIVE_GIT`: repositories
 * separated by `:`, searched in order; unset, the maintainers' two old checkouts when they exist). Every tool that
 * needs a commit's flake, or a file of it, asks here instead of assuming one place.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { expandHome, REPO_DIR } from './paths.ts';

/** A commit that holds the appliance. */
export interface Source {
  /** The top folder of the repository that has the commit. */
  repository: string;
  rev: string;
  /** Where the appliance is in that commit: `appliance` in Whombat, empty in an appliance repository of its own. */
  dir: string;
}

/** What a build records as its source (build.json `source`). */
export type BuildSource =
  | { repository: 'whombat-appliance'; rev: string; dirty: boolean }
  | { repository: 'whombat'; rev: string; dir: string; dirty: boolean };

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const quiet = (repo: string, ...args: string[]) => {
  try {
    git(repo, ...args);
    return true;
  } catch {
    return false;
  }
};

/** The git checkout `dir` is in (its top folder). */
export const topOf = (dir: string): string => git(dir, 'rev-parse', '--show-toplevel').trim();

/** Where the appliance is in a commit: `appliance`, or empty for a commit of an appliance repository of its own. */
export function dirAt(repository: string, rev: string): string {
  if (quiet(repository, 'cat-file', '-e', `${rev}:appliance/flake.nix`)) return 'appliance';
  if (
    quiet(repository, 'cat-file', '-e', `${rev}:flake.nix`) &&
    quiet(repository, 'cat-file', '-e', `${rev}:nix/profiles`)
  )
    return '';
  throw new Error(
    `${rev} in ${repository} holds no appliance (neither appliance/flake.nix nor flake.nix beside nix/profiles)`,
  );
}

/** The archive repositories, in the order they are searched. */
export function archives(
  env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (p: string) => boolean = existsSync,
): string[] {
  if (env.WB_ARCHIVE_GIT !== undefined) return env.WB_ARCHIVE_GIT.split(':').filter(Boolean).map(expandHome);
  return ['whombat-appliance', 'whombat-hosts'].map((name) => join(homedir(), 'Code', name)).filter(exists);
}

export interface FindOptions {
  /** A folder of the checkout searched first (default: this harness's own). */
  checkout?: string;
  archives?: readonly string[];
}

/** The repository that has the commit (the checkout, else each archive in order), or null. */
export function whereIs(rev: string, o: FindOptions = {}): string | null {
  const checkout = o.checkout ?? REPO_DIR;
  const top = topOf(checkout);
  // At a repository's top, the folder as the caller names it.
  if (quiet(top, 'cat-file', '-e', `${rev}^{commit}`)) return realpathSync(checkout) === top ? checkout : top;
  for (const repo of o.archives ?? archives())
    if (existsSync(repo) && quiet(repo, 'cat-file', '-e', `${rev}^{commit}`)) return topOfOr(repo);
  return null;
}

/** The commit with its repository and the appliance's place in it; throws when nobody has it or it holds none. */
export function findSource(rev: string, o: FindOptions = {}): Source {
  const repository = whereIs(rev, o);
  if (!repository)
    throw new Error(
      `the commit ${rev} is not in ${topOf(o.checkout ?? REPO_DIR)} nor in an archive (WB_ARCHIVE_GIT: ${(o.archives ?? archives()).join(' ') || 'none'})`,
    );
  return { repository, rev, dir: dirAt(repository, rev) };
}

/**
 * A file of the appliance at a commit, wherever the commit is, or null when the commit or the file isn't there.
 * Unlike `findSource` it asks nothing of the commit but the file: `appliance/<path>` when that is there, else `<path>`.
 */
export function fileAt(rev: string, path: string, o: FindOptions = {}): string | null {
  const repository = whereIs(rev, o);
  if (!repository) return null;
  for (const p of [`appliance/${path}`, path])
    if (quiet(repository, 'cat-file', '-e', `${rev}:${p}`)) return git(repository, 'show', `${rev}:${p}`);
  return null;
}

/**
 * Whether `paths` hold the same files at two commits, each read from the repository that has it (the checkout or an
 * archive), or null when one of the commits is nowhere. Git names content by its id, so two commits need not be in
 * one repository to be compared: the same id at a path is the same file or folder, and a path neither has is the
 * same too. Only the candidate asks this (is the hosted web what this commit would build?), so `release/lib/source.sh`
 * has no counterpart.
 */
export function samePathsAt(
  a: string,
  b: string,
  paths: readonly string[],
  o: FindOptions = {},
): boolean | null {
  const [inA, inB] = [whereIs(a, o), whereIs(b, o)];
  if (!inA || !inB) return null;
  const id = (repository: string, rev: string, path: string) => {
    try {
      return git(repository, 'rev-parse', '--verify', '--quiet', `${rev}:${path}`).trim();
    } catch {
      return '';
    }
  };
  return paths.every((path) => id(inA, a, path) === id(inB, b, path));
}

/** A bare archive has no top folder: it is its own. */
function topOfOr(repo: string): string {
  try {
    return topOf(repo);
  } catch {
    return realpathSync(repo);
  }
}

/** The commit's flake: never a working tree, so a release can be evaluated again from its build.json. */
export const flakeOf = (s: Source): string =>
  `git+file://${s.repository}?rev=${s.rev}${s.dir ? `&dir=${s.dir}` : ''}`;

/** The flake of a commit, wherever it is. */
export const flakeAtCommit = (rev: string, o: FindOptions = {}): string => flakeOf(findSource(rev, o));

/** A file of the appliance at that commit (`path` as seen from the appliance). */
export const showAt = (s: Source, path: string): string =>
  git(s.repository, 'show', `${s.rev}:${s.dir ? `${s.dir}/` : ''}${path}`);

/** The appliance's folder in a checkout or worktree of a commit's repository. */
export const applianceIn = (top: string, s: Pick<Source, 'dir'>): string => (s.dir ? join(top, s.dir) : top);

/**
 * A checkout's flake as it is now, uncommitted changes included. At a repository's top Nix reads the folder itself;
 * inside a larger repository it must read the repository (a `path:` flake can't reach the folders beside it), which
 * takes every tracked file as it is.
 */
export function treeFlake(appliance: string = REPO_DIR): string {
  const top = topOf(appliance);
  const here = realpathSync(appliance);
  return top === here ? `path:${appliance}` : `git+file://${top}?dir=${relative(top, here)}`;
}

export function sourceRecord(s: Source, dirty: boolean): BuildSource {
  return s.dir
    ? { repository: 'whombat', rev: s.rev, dir: s.dir, dirty }
    : { repository: 'whombat-appliance', rev: s.rev, dirty };
}

/** Whether a flake (its `flake.lock` text) takes `name` as an input of its own. */
export function flakeHasInput(lock: string, name: string): boolean {
  const nodes = (JSON.parse(lock) as { nodes?: { root?: { inputs?: Record<string, unknown> } } }).nodes;
  return name in (nodes?.root?.inputs ?? {});
}
