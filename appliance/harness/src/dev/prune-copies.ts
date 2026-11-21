/**
 * Retention for the harness's per-commit copies. `dev/up` keeps a clean clone per component and commit under `src/`
 * (`<id>@<commit12>`, with its `.installed` marker), Go builds under `bin/` (`<id>@<commit12>[-dirty][-agents]`) and
 * runtime fixtures under `fixtures/` (`runtime-<kind>@<commit12>-f<N>`). Every new candidate adds a few GB, so after
 * `dev/up` the copies nobody needs go:
 *
 * - kept: every copy at a commit env.json runs, every copy a running process uses (its working directory, binary or
 *   command line), every copy used in the last hour, and the newest `WB_MGD_KEEP_COPIES` (default 3) per component and
 *   directory, by when they were last used (`dev/up` touches a copy each time it reuses one);
 * - removed: the rest. Anything else in those directories (rest-server, postgresql-17, whombat-console) is never touched.
 *
 * `WB_MGD_KEEP_COPIES=all` turns it off. By hand: `dev/prune [--dry-run]`.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { acquireEnvLock, releaseEnvLock } from '../lib/lock.ts';
import { paths } from '../lib/paths.ts';
import { makeWritable } from './down.ts';
import { type EnvState, loadEnv } from './env.ts';

export const DEFAULT_KEEP_COPIES = 3;
/** Copies used this recently stay whatever else is true (a build of another command in flight). */
export const RECENT_MS = 60 * 60_000;

export type CopyDir = 'src' | 'bin' | 'fixtures';

export interface Copy {
  dir: CopyDir;
  /** The entry's name in its directory. */
  name: string;
  path: string;
  component: string;
  /** The 12-character commit prefix in the name. */
  commit: string;
  /** Last use (mtime; `dev/up` touches what it reuses). */
  usedAt: number;
}

/** The suffixes after `<id>@<commit12>` each directory's copies have; other names are not copies. */
const SUFFIX: Record<CopyDir, RegExp> = {
  src: /^(\.installed)?$/,
  bin: /^(-dirty)?(-agents)?$/,
  fixtures: /^-f\d+$/,
};

/** `{component, commit}` when `name` is one of the harness's per-commit copies in `dir`, else null. */
export function parseCopy(dir: CopyDir, name: string): { component: string; commit: string } | null {
  const [, component, commit, suffix] = /^(.+)@([0-9a-f]{12})(.*)$/.exec(name) ?? [];
  if (component === undefined || commit === undefined || !SUFFIX[dir].test(suffix ?? '')) return null;
  return { component, commit };
}

export interface KeepRules {
  /** Newest copies kept per component and directory. */
  keep: number;
  now: number;
  /** Commits (full or 12-character) whose copies stay: what env.json runs. */
  commits: Iterable<string>;
  /** Copy paths a running process uses. */
  inUse: ReadonlySet<string>;
}

/**
 * The copies to remove. A version (component and commit in one directory: the clone and its marker, or a build and
 * its `-dirty`/`-agents` siblings) stays or goes as a whole.
 */
export function selectPrunable(copies: Copy[], rules: KeepRules): Copy[] {
  const commits = new Set([...rules.commits].map((c) => c.slice(0, 12)));
  // Per component and directory, its versions (one per commit) with when the version was last used.
  const byComponent = new Map<string, Map<string, { usedAt: number; copies: Copy[] }>>();
  for (const c of copies) {
    const key = `${c.dir}\0${c.component}`;
    const component = byComponent.get(key) ?? new Map<string, { usedAt: number; copies: Copy[] }>();
    byComponent.set(key, component);
    const v = component.get(c.commit) ?? { usedAt: c.usedAt, copies: [] };
    component.set(c.commit, v);
    v.usedAt = Math.max(v.usedAt, c.usedAt);
    v.copies.push(c);
  }
  const out: Copy[] = [];
  for (const component of byComponent.values()) {
    const newestFirst = [...component.values()].sort((a, b) => b.usedAt - a.usedAt);
    newestFirst.forEach((v, i) => {
      const kept =
        i < rules.keep ||
        rules.now - v.usedAt < RECENT_MS ||
        v.copies.some((c) => commits.has(c.commit) || rules.inUse.has(c.path));
      if (!kept) out.push(...v.copies);
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const copyDirs = (): Record<CopyDir, string> => ({
  src: paths.src,
  bin: paths.bin,
  fixtures: join(paths.home, 'fixtures'),
});

/** The per-commit copies on disk. */
export function listCopies(dirs: Record<CopyDir, string> = copyDirs()): Copy[] {
  const out: Copy[] = [];
  for (const dir of Object.keys(dirs) as CopyDir[]) {
    const root = dirs[dir];
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const p = parseCopy(dir, name);
      if (!p) continue;
      const path = join(root, name);
      try {
        out.push({ dir, name, path, ...p, usedAt: lstatSync(path).mtimeMs });
      } catch {
        // gone meanwhile
      }
    }
  }
  return out;
}

/**
 * The entries directly under `roots` that a running process uses: its working directory, its binary or a path on its
 * command line inside one of them.
 */
export function copiesInUse(roots: string[], proc = '/proc'): Set<string> {
  const used = new Set<string>();
  const pick = (s: string) => {
    for (const root of roots) {
      let i = s.indexOf(`${root}/`);
      while (i >= 0) {
        const rest = s.slice(i + root.length + 1);
        const name = /^[^/\s\0]+/.exec(rest)?.[0];
        if (name) used.add(join(root, name));
        i = s.indexOf(`${root}/`, i + 1);
      }
    }
  };
  for (const d of readdirSync(proc)) {
    if (!/^\d+$/.test(d)) continue;
    for (const read of [
      () => `${readlinkSync(join(proc, d, 'cwd'))}/`,
      () => readlinkSync(join(proc, d, 'exe')),
      () => readFileSync(join(proc, d, 'cmdline'), 'utf8').replace(/\0/g, ' '),
    ])
      try {
        pick(read());
      } catch {
        // gone, or not ours
      }
  }
  return used;
}

/** `WB_MGD_KEEP_COPIES`: a count, or `all` (null: never prune). */
export function keepFromEnv(v = process.env.WB_MGD_KEEP_COPIES): number | null {
  const s = (v ?? '').trim();
  if (!s) return DEFAULT_KEEP_COPIES;
  if (s === 'all') return null;
  if (!/^\d+$/.test(s)) throw new Error(`WB_MGD_KEEP_COPIES must be a number or all, not ${s}`);
  return Number(s);
}

/** Marks a copy as used now, so retention counts it among the newest. */
export function touchCopy(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // not there (yet): nothing to mark
  }
}

export interface PruneResult {
  removed: Copy[];
  kept: number;
}

/** Removes the copies nobody needs (see the top of this file). The caller holds the environment lock. */
export function pruneCopies(
  state: EnvState | null,
  log: (l: string) => void,
  options: { dryRun?: boolean; keep?: number | null } = {},
): PruneResult {
  const keep = options.keep === undefined ? keepFromEnv() : options.keep;
  const copies = listCopies();
  if (keep === null) return { removed: [], kept: copies.length };
  const dirs = copyDirs();
  const removed = selectPrunable(copies, {
    keep,
    now: Date.now(),
    commits: Object.values(state?.sources ?? {}).map((s) => s.commit),
    inUse: copiesInUse(Object.values(dirs)),
  });
  for (const c of removed) {
    if (options.dryRun) {
      log(`copies: would remove ${c.dir}/${c.name}`);
      continue;
    }
    makeWritable(c.path);
    rmSync(c.path, { recursive: true, force: true });
  }
  if (removed.length)
    log(
      `copies: ${options.dryRun ? 'would remove' : 'removed'} ${removed.length} old per-commit cop${removed.length === 1 ? 'y' : 'ies'}, kept ${copies.length - removed.length} (WB_MGD_KEEP_COPIES=${keep})`,
    );
  return { removed, kept: copies.length - removed.length };
}

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run');
  acquireEnvLock('dev/prune');
  try {
    const r = pruneCopies(loadEnv(), (l) => process.stderr.write(`${l}\n`), { dryRun });
    if (!r.removed.length) process.stderr.write(`copies: nothing to remove (${r.kept} kept)\n`);
  } finally {
    releaseEnvLock();
  }
}
