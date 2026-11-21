/**
 * Clean checkouts at pinned commits (IN-05): a fresh `git clone --no-local` of the component's repository
 * (objects copied, no hardlinks, no working-tree files), then a detached checkout of the exact commit. Nothing
 * from a sibling working tree can leak in: uncommitted changes are not in the object database. The dev stack's copies
 * (`ensureClone`) may start from an earlier clean clone of the same repository instead (`seededClone`).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { must, run } from './proc.ts';

export async function revParse(repo: string, ref: string): Promise<string> {
  return (await must('git', ['rev-parse', `${ref}^{commit}`], { cwd: repo })).stdout.trim();
}

export async function isClean(dir: string): Promise<boolean> {
  const r = await run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: dir });
  return r.code === 0 && r.stdout.trim() === '';
}

export async function headOf(dir: string): Promise<string> {
  return (await must('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
}

/** A clean clone of `source` at `commit` in `dest` (replaced when it exists). */
export async function cleanClone(source: string, commit: string, dest: string): Promise<void> {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  await must('git', ['clone', '--quiet', '--no-local', '--no-checkout', source, dest], {
    cwd: dirname(dest),
  });
  await must('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit], {
    cwd: dest,
  });
  const head = await headOf(dest);
  if (head !== commit) throw new Error(`${dest}: HEAD ${head} is not the pinned ${commit}`);
}

/**
 * A clean clone of `source` at `commit` in `dest` made from `seed`, an earlier clean clone of the same repository: its
 * objects hard-linked (git never changes an object file, and the copy keeps them when the seed is removed), then what is
 * new fetched from `source`, the commit checked out and verified as `cleanClone` does. The seed's objects came from
 * `source` by clean clones and fetches too, so still only committed objects travel. A full `--no-local` clone of
 * Whombat packs its whole history (about 20 s); this takes about a second.
 */
export async function seededClone(seed: string, source: string, commit: string, dest: string): Promise<void> {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  try {
    await must(
      'git',
      ['-c', 'init.defaultBranch=main', 'clone', '--quiet', '--local', '--no-checkout', seed, dest],
      { cwd: dirname(dest) },
    );
    await must('git', ['remote', 'set-url', 'origin', source], { cwd: dest });
    await must('git', ['fetch', '--quiet', '--prune', '--tags', 'origin'], { cwd: dest });
    await must('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit], {
      cwd: dest,
    });
    const head = await headOf(dest);
    if (head !== commit) throw new Error(`${dest}: HEAD ${head} is not the pinned ${commit}`);
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }
}

/**
 * The newest clean clone of `source` beside `dest` to seed it from (`seededClone`): a full clone whose origin is
 * `source`, not a shallow one or one that borrows objects from elsewhere. Null when there is none.
 */
export async function seedFor(source: string, dest: string): Promise<string | null> {
  const parent = dirname(dest);
  if (!existsSync(parent)) return null;
  const clones = readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== basename(dest))
    .map((e) => join(parent, e.name))
    .filter(
      (d) =>
        existsSync(join(d, '.git', 'objects')) &&
        !existsSync(join(d, '.git', 'shallow')) &&
        !existsSync(join(d, '.git', 'objects', 'info', 'alternates')),
    )
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const d of clones) {
    const r = await run('git', ['config', '--get', 'remote.origin.url'], { cwd: d });
    if (r.code === 0 && r.stdout.trim() === source) return d;
  }
  return null;
}

/**
 * Reuses a clean clone at `commit` when `dest` already is one (untracked build outputs such as node_modules
 * and bin/ are ignored by the repositories' .gitignore), else makes one: from an earlier clean clone of the same
 * repository beside it when there is one (`seededClone`), otherwise afresh.
 */
export async function ensureClone(
  source: string,
  commit: string,
  dest: string,
): Promise<'reused' | 'seeded' | 'cloned'> {
  if (existsSync(dest)) {
    try {
      if ((await headOf(dest)) === commit && (await isClean(dest))) return 'reused';
    } catch {
      // broken: re-clone
    }
  }
  const seed = await seedFor(source, dest);
  if (seed)
    try {
      await seededClone(seed, source, commit, dest);
      return 'seeded';
    } catch {
      // a seed that doesn't work: the full clone below
    }
  await cleanClone(source, commit, dest);
  return 'cloned';
}

/** Deterministic `git archive` of a commit as .tar.gz (the source artifact of a component). */
export async function archive(repo: string, commit: string, out: string, prefix: string): Promise<void> {
  await must(
    'bash',
    [
      '-c',
      'set -euo pipefail; git archive --format=tar --prefix="$2" "$3" | gzip -n -9 > "$1"',
      'a',
      out,
      prefix,
      commit,
    ],
    { cwd: repo },
  );
}
