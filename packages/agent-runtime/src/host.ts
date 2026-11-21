/**
 * Host paths from the environment (S-03): `WHOMBAT_HOME` (default `~/.whombat`) holds `workspaces/` unless
 * `WHOMBAT_WORKSPACES` says otherwise. No dependencies beyond Node, so the server imports it
 * from `@whombat/agent-runtime/host` without loading the providers.
 */
import { lstat, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export { type NotifySend, type SdNotifier, sdNotifier } from './sd-notify';

/** A path setting (`/…`, `~` or `~/…`) as an absolute path; null when it is empty or not a full path. */
export function settingPath(raw: string | undefined, home: string = homedir()): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value === '~') return home;
  if (value.startsWith('~/')) return resolve(home, value.slice(2));
  return value.startsWith('/') ? resolve(value) : null;
}

/** A path as a person reads it: `~/…` inside the home, else as it is. */
export function shownPath(path: string, home: string = homedir()): string {
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** `WHOMBAT_HOME`, absolute (`~` expanded). A malformed value falls back to `~/.whombat`. */
export function defaultWhombatHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return settingPath(env.WHOMBAT_HOME, home) ?? join(home, '.whombat');
}

/** Git worktrees for coding work: `WHOMBAT_WORKSPACES`, else `$WHOMBAT_HOME/workspaces`. */
export function defaultWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.WHOMBAT_WORKSPACES?.trim() || join(defaultWhombatHome(env), 'workspaces');
}

/**
 * The runner's own temporary directory (docs/decisions/bp-automations.md BP-C38): `<tmp>/whombat-runner-<uid>`, one per
 * host user, private to it (`privateDir`). Turns' empty working directories and read-only exports live under it
 * (`scratch/`, `read/`), outside `WHOMBAT_HOME`, which every task sandbox denies. `TMPDIR` moves it.
 */
export function runnerTmpRoot(tmp: string = tmpdir()): string {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return join(tmp, `whombat-runner-${uid}`);
}

/** A directory that exists but is not safe to use as private (another owner, a link, open to others). */
export class PrivateDirError extends Error {
  constructor(
    readonly path: string,
    readonly why: string,
  ) {
    super(`${path} ${why}`);
    this.name = 'PrivateDirError';
  }
}

/**
 * Makes `path` a directory only this user can use (0700), or checks that it already is one: a real directory (not a
 * link), owned by this user, with no access for group or others. Anything else is refused, never repaired: on a
 * shared `/tmp` another user may have made it first to read or swap what Whombat puts there.
 */
export async function privateDir(path: string): Promise<string> {
  await mkdir(path, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new PrivateDirError(path, 'is a link, not a directory of its own.');
  if (!info.isDirectory()) throw new PrivateDirError(path, 'is not a directory.');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && info.uid !== uid) throw new PrivateDirError(path, 'belongs to another user.');
  if (info.mode & 0o077)
    throw new PrivateDirError(path, `is open to other users (mode ${(info.mode & 0o777).toString(8)}).`);
  return path;
}

export interface HostPathSettings {
  WHOMBAT_HOME?: string | undefined;
  /** Git worktrees and local origins (default `$WHOMBAT_HOME/workspaces`). */
  WHOMBAT_WORKSPACES?: string | undefined;
}

export interface HostPaths {
  /** The host user's home directory (what `~` means). */
  home: string;
  /** `WHOMBAT_HOME`, absolute (default `~/.whombat`). */
  whombatHome: string;
  /** The runner's workspaces root (worktrees, local origins, the agents' work folders). */
  workspaces: string;
  /** The runner's temporary directory (`runnerTmpRoot`). */
  runnerTmp: string;
}

/** Config problems with the host path settings (listed with every other config problem). */
export function hostPathIssues(settings: HostPathSettings): { path: string[]; message: string }[] {
  if (settings.WHOMBAT_HOME === undefined || settingPath(settings.WHOMBAT_HOME) !== null) return [];
  return [{ path: ['WHOMBAT_HOME'], message: 'Use a full path, starting with / or ~/.' }];
}

/** The host paths from settings in their raw form (`~` allowed), defaults filled. */
export function hostPaths(settings: HostPathSettings, home: string = homedir()): HostPaths {
  const whombatHome = settingPath(settings.WHOMBAT_HOME, home) ?? join(home, '.whombat');
  return {
    home,
    whombatHome,
    workspaces: settingPath(settings.WHOMBAT_WORKSPACES, home) ?? join(whombatHome, 'workspaces'),
    runnerTmp: runnerTmpRoot(),
  };
}
