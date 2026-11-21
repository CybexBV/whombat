/**
 * What of a turn its commands see (one-person.md OP-S109), at its own path: the task sandbox's working directory, its
 * commit paths and readable directories with the same mode; a readable file through its directory only when that
 * directory is the turn's own (named after the dispatch); the conversation's Files read-only at `~/files`; git's
 * control files read-only inside a writable checkout. Never a directory with a denied path inside it, never the
 * credential home; a nested path only when it changes the mode (read-write inside read-only).
 */
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SandboxTask } from '@whombat/agent-runtime';
import type { Bind } from './wrapper';

/** At most this many binds of a turn. */
const MAX_BINDS = 24;

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

function realDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return lstatSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface TurnBindsOptions {
  task: Pick<SandboxTask, 'cwd' | 'writeCwd' | 'writable' | 'readable' | 'readOnlyInside' | 'credentialHome'>;
  /** Paths never bound even when inside a bound one (the sandbox's denied paths). */
  denied: readonly string[];
  dispatchId: string;
  /** More of the turn's (an automation step's own folder, read-write). */
  extra?: readonly { path: string; readonly: boolean }[];
  /** The conversation's Files tree (FS-09), read-only at `<home>/files`. */
  files?: { tree: string; home: string } | null;
  /** Already in every command's view (the agent's home): not bound again. */
  covered?: readonly string[];
}

export function turnBinds(o: TurnBindsOptions): Bind[] {
  const { task } = o;
  const wanted: { path: string; readonly: boolean }[] = [];
  const add = (path: string, readonly: boolean) => {
    const dir = realDir(path);
    if (dir) wanted.push({ path: dir, readonly });
  };
  add(task.cwd, !task.writeCwd);
  if (task.writeCwd) for (const p of task.writable ?? []) add(p, false);
  for (const p of task.readable ?? []) {
    if (realDir(p)) add(p, true);
    else if (basename(dirname(p)).includes(o.dispatchId)) add(dirname(p), true);
  }
  for (const e of o.extra ?? []) add(e.path, e.readonly);
  const denied = o.denied.map(real);
  const credential = task.credentialHome ? (realDir(task.credentialHome) ?? task.credentialHome) : null;
  const covered = (o.covered ?? []).map(real);
  const ok = wanted.filter(
    (s) =>
      !denied.some((d) => d !== s.path && within(d, s.path)) &&
      !(credential && (within(s.path, credential) || within(credential, s.path))),
  );
  // Read-write wins on the same path; parents first; a nested path only when it opens writing.
  const byPath = new Map<string, { path: string; readonly: boolean }>();
  for (const s of ok) {
    const had = byPath.get(s.path);
    if (!had || (had.readonly && !s.readonly)) byPath.set(s.path, s);
  }
  const sorted = [...byPath.values()].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const out: { path: string; readonly: boolean }[] = [];
  for (const s of sorted) {
    const parent = out.filter((x) => within(s.path, x.path)).pop();
    if (parent && (!parent.readonly || s.readonly)) continue;
    // Inside the agent's home already, read-write: nothing to add (a step's folder, the work folder).
    if (!s.readonly && covered.some((c) => within(s.path, c))) continue;
    out.push(s);
  }
  const binds: Bind[] = out
    .slice(0, MAX_BINDS)
    .map((s) => ({ src: s.path, dest: s.path, mode: s.readonly ? 'ro' : 'rw' }));
  // git's control files stay read-only inside a writable checkout (AC-22: restored after the turn anyway).
  for (const p of task.readOnlyInside ?? []) {
    const path = real(p);
    if (exists(path) && binds.some((b) => b.mode === 'rw' && within(path, b.dest)))
      binds.push({ src: path, dest: path, mode: 'ro' });
  }
  const tree = o.files ? realDir(o.files.tree) : null;
  if (tree && o.files) binds.push({ src: tree, dest: join(o.files.home, 'files'), mode: 'ro' });
  return binds;
}
