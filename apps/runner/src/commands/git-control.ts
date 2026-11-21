/**
 * Git control files can't be planted (docs/decisions/agent-computer.md AC-22, AC-DR12; one-person.md OP-S109). In a
 * commands turn the checkout is writable for the agent's commands (its control files mounted read-only), so the files
 * the runner's own git trusts — a repository's `config`, `config.worktree`, `info/`, `hooks/`, `objects/info`, an admin dir's `commondir` and
 * `gitdir`, the worktree's `.git` file — are snapshotted before the turn and restored byte for byte (anything new
 * deleted, links never followed) before the runner runs any git of its own. The runner's git keeps
 * `core.hooksPath=/dev/null` and `core.fsmonitor=false` on every command line anyway.
 */
import { chmod, lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

type Entry =
  | { kind: 'file'; data: Buffer; mode: number }
  | { kind: 'dir'; mode: number }
  | { kind: 'link'; target: string }
  | { kind: 'missing' };

/** Within a git dir: what code outside the commands' sandbox trusts. */
const GIT_DIR_CONTROL = [
  'config',
  'config.worktree',
  'info',
  'hooks',
  'commondir',
  'gitdir',
  join('objects', 'info'),
];
/** Largest snapshot (bytes of file contents) before refusing: control files are small. */
const MAX_BYTES = 64 * 1024 * 1024;

async function entryOf(path: string): Promise<Entry> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(path);
  } catch {
    return { kind: 'missing' };
  }
  if (st.isSymbolicLink()) return { kind: 'link', target: await readlink(path) };
  if (st.isDirectory()) return { kind: 'dir', mode: st.mode & 0o7777 };
  if (st.isFile()) return { kind: 'file', data: await readFile(path), mode: st.mode & 0o7777 };
  // A fifo, socket or device where a control file belongs: recorded as missing, so it is removed.
  return { kind: 'missing' };
}

/** A `.git` directory (or a repository's common dir) given as a whole: only its control files. */
async function isGitDir(path: string): Promise<boolean> {
  if (basename(path) === '.git' || path.endsWith('.git')) {
    const st = await lstat(path).catch(() => null);
    return Boolean(st?.isDirectory());
  }
  return false;
}

export interface GitControlSnapshot {
  /** The roots it covers (each file or directory restored as a whole). */
  readonly roots: readonly string[];
  /** Puts every root back as it was; returns what couldn't be (the runner then runs no git of its own). */
  restore(): Promise<string[]>;
}

/** Snapshots the control paths (`CommitPaths.denyWrite` of the turn's checkout). */
export async function snapshotGitControl(paths: readonly string[]): Promise<GitControlSnapshot> {
  const roots: string[] = [];
  for (const p of [...new Set(paths)]) {
    if (await isGitDir(p)) roots.push(...GIT_DIR_CONTROL.map((c) => join(p, c)));
    else roots.push(p);
  }
  // Nested roots: the outer one covers the inner.
  const unique = roots.filter(
    (r, i) => roots.indexOf(r) === i && !roots.some((o) => o !== r && r.startsWith(`${o}/`)),
  );
  const saved = new Map<string, Entry>();
  let bytes = 0;
  const walk = async (path: string) => {
    const e = await entryOf(path);
    saved.set(path, e);
    if (e.kind === 'file') {
      bytes += e.data.length;
      if (bytes > MAX_BYTES) throw new Error(`git control files under ${path} are too large to keep`);
    }
    if (e.kind === 'dir') for (const name of await readdir(path)) await walk(join(path, name));
  };
  for (const r of unique) await walk(r);
  return {
    roots: unique,
    restore: async () => {
      const problems: string[] = [];
      for (const r of unique) {
        try {
          await restoreTree(r, saved);
        } catch (err) {
          problems.push(`${r}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return problems;
    },
  };
}

async function restoreTree(root: string, saved: Map<string, Entry>): Promise<void> {
  // Whatever is there now and wasn't: removed (links themselves, never what they point to).
  const removeExtra = async (path: string) => {
    const now = await entryOf(path);
    const was = saved.get(path);
    if (now.kind === 'missing') return;
    if (
      !was ||
      was.kind !== now.kind ||
      (now.kind === 'link' && was.kind === 'link' && was.target !== now.target)
    ) {
      await rm(path, { recursive: true, force: true });
      return;
    }
    if (now.kind === 'dir') for (const name of await readdir(path)) await removeExtra(join(path, name));
  };
  await removeExtra(root);
  // What was there: put back, parents first.
  const paths = [...saved.keys()].filter((p) => p === root || p.startsWith(`${root}/`)).sort();
  for (const path of paths) {
    const was = saved.get(path) as Entry;
    const now = await entryOf(path);
    if (was.kind === 'missing') continue;
    if (was.kind === 'dir') {
      if (now.kind !== 'dir') await mkdir(path, { mode: was.mode });
      await chmod(path, was.mode);
    } else if (was.kind === 'link') {
      if (now.kind !== 'link') {
        await mkdir(dirname(path), { recursive: true });
        await symlink(was.target, path);
      }
    } else {
      const same = now.kind === 'file' && now.data.equals(was.data) && now.mode === was.mode;
      if (same) continue;
      // A new inode: never write through a hard link a command may have made.
      if (now.kind !== 'missing') await rm(path, { force: true });
      await writeFile(path, was.data, { mode: was.mode, flag: 'wx' });
      await chmod(path, was.mode);
    }
  }
}
