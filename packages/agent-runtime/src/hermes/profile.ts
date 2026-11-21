/**
 * Where Hermes lives, in Hermes's own layout (docs/decisions/one-person.md OP-08; hermes-engine.md HE-16):
 *
 * - `WHOMBAT_HERMES_BIN` (default `hermes` on `PATH`; development: `pnpm hermes:install`'s environment);
 * - `WHOMBAT_HERMES_ROOT` (appliance `/persist/whombat/hermes`, development `$WHOMBAT_HOME/hermes`), private to the
 *   runner: the person's own Hermes home — Hermes's default profile, its `HERMES_HOME`: memory, sessions, the ChatGPT
 *   login (`auth.json`), and `skills/` (Hermes's built-ins, hub installs and what the agent learned, `skills.ts`) — with
 *   `profiles/_feedback/` beside it for the turns outsiders' input starts (OP-17) and `locks/` (the holders of the
 *   profile locks). The runner's own folders there (`locks/`, `profiles/` and the Hermes-home service's) are never
 *   visible to the person's Hermes (`HERMES_PRIVATE_DIRS`);
 * - at most one Hermes process per profile at a time (Hermes: “never point two agent processes at the same
 *   profile”): a host-wide lock per profile, held by the pod for its life or a task's Hermes for its turn.
 */
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { HERMES_HOME_PROFILES } from '@whombat/core';
import { defaultWhombatHome, privateDir } from '../host';
import { type HostLock, hostLock } from '../workspace/lock';
import { HERMES_PIN } from './pin';
import { hermesSkillsDir } from './skills';

export const HERMES_BIN_SETTING = 'WHOMBAT_HERMES_BIN';
export const HERMES_ROOT_SETTING = 'WHOMBAT_HERMES_ROOT';
/**
 * The profile of the turns outsiders' input starts (one-person.md OP-17: Feedback assessments, trackers' customers,
 * incoming mail): a named profile beside the person's, one Hermes per turn in a task sandbox of its own, never the
 * person's pod, memory, skills or Vault.
 */
export const HERMES_FEEDBACK_PROFILE = HERMES_HOME_PROFILES.outside;
/**
 * The runner's own folders in the root, never the person's Hermes's (the pod and a person's task cover them): the
 * profile locks, the outsiders' profile, the Hermes-home service's transfers and pending deletes, the ChatGPT sign-in's
 * staging, the skills Whombat set aside, skills being written (`.skills-staging`), the home Hermes's own commands run
 * with.
 */
export const HERMES_PRIVATE_DIRS = [
  'locks',
  'profiles',
  'transfers',
  'pending',
  'signin',
  'skills-set-aside',
  '.skills-staging',
  'check',
] as const;
export { HERMES_PIN } from './pin';

/** Where `pnpm hermes:install` puts its environment: `$XDG_CACHE_HOME/whombat/hermes/venv-<version>`. */
export function hermesDevVenv(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME || homedir(),
): string {
  const cache = env.XDG_CACHE_HOME?.trim() || join(home, '.cache');
  return join(cache, 'whombat', 'hermes', `venv-${HERMES_PIN.version}`);
}

/**
 * The `hermes` executable: `WHOMBAT_HERMES_BIN`, else the development environment `pnpm hermes:install` made, else
 * `hermes` on `PATH`.
 */
export function hermesBin(env: NodeJS.ProcessEnv = process.env): string {
  const set = env[HERMES_BIN_SETTING]?.trim();
  if (set) return set;
  const dev = join(hermesDevVenv(env), 'bin', 'hermes');
  return existsSync(dev) ? dev : 'hermes';
}

/** `WHOMBAT_HERMES_ROOT`, else `$WHOMBAT_HOME/hermes`. */
export function hermesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env[HERMES_ROOT_SETTING]?.trim() || join(defaultWhombatHome(env), 'hermes');
}

/** The person's Hermes home: Hermes's default profile, the root itself (OP-08). */
export function hermesPersonProfile(root: string): string {
  return root;
}

/** The outsiders' profile (`profiles/_feedback`, OP-17). */
export function hermesFeedbackProfile(root: string): string {
  return join(root, 'profiles', HERMES_FEEDBACK_PROFILE);
}

/** Hermes's login store and its lock in a profile. */
const LOGIN_FILES = ['auth.json', 'auth.lock'] as const;

/**
 * Takes the ChatGPT access token lent to the outsiders' profile out of it (one-person.md OP-S89): after their turn,
 * and at the runner's start (a turn the last runner left behind; no Hermes runs there then). `rm` unlinks a link, never
 * follows it.
 */
export async function clearLentLogin(root: string): Promise<void> {
  for (const name of LOGIN_FILES) await rm(join(hermesFeedbackProfile(root), name), { force: true });
}

/**
 * Makes the root and the runner's own folders in it (each private, 0700, so the person's Hermes can be kept out of
 * them), `profile` when it is the outsiders', and the person's skills folder (the runner fills it at start).
 */
export async function prepareHermesProfile(root: string, profile: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await privateDir(root);
  for (const name of HERMES_PRIVATE_DIRS) await privateDir(join(root, name));
  if (profile !== root) await privateDir(profile);
  await mkdir(hermesSkillsDir(root), { recursive: true, mode: 0o700 });
}

/**
 * The profile's lock (HE-S19): waits up to `waitMs` (default 0) for another Hermes on the profile to end; throws
 * `LockBusyError` when it doesn't. `polite`: refused while a turn of this runner waits for the profile (background
 * work goes after it).
 */
export function lockHermesProfile(
  root: string,
  profile: string,
  options: { holder: string; waitMs?: number; signal?: AbortSignal; polite?: boolean },
): Promise<HostLock> {
  return hostLock(`hermes-profile:${profile}`, {
    dir: join(root, 'locks'),
    holder: options.holder,
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
    pollMs: 250,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.polite ? { polite: true } : {}),
  });
}

/** The real file of a command (`~/.local/bin/claude` → its install), for the profile and the sandbox. */
export function realCommand(command: string, env: NodeJS.ProcessEnv): string {
  const dirs = command.includes('/') ? [''] : (env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of dirs) {
    try {
      return realpathSync(dir ? `${dir}/${command}` : command);
    } catch {
      // not here
    }
  }
  return command;
}

/**
 * The `python` beside `hermes` (a venv's; on the appliance the wrapper with Hermes's environment, HSK-S01), or null when
 * there is none (development's scripted Hermes): the one that runs the plugin's steps (skills, ChatGPT's sign-in).
 */
export function hermesPythonBeside(bin: string, env: NodeJS.ProcessEnv): string | null {
  const beside = join(dirname(realCommand(bin, env)), 'python');
  return existsSync(beside) ? beside : null;
}

/** The install a venv's `python` links to (`uv`'s Python), at the link's own path and its real one. */
function venvPython(binDir: string): string[] {
  try {
    const link = readlinkSync(join(binDir, 'python'));
    const target = isAbsolute(link) ? link : join(binDir, link);
    return [...new Set([dirname(dirname(target)), dirname(dirname(realpathSync(target)))])];
  } catch {
    return [];
  }
}

/**
 * What a sandbox needs readable to run Hermes's own Python (the `hermes` at `bin`): a venv's own files beside its `bin/`
 * and the Python it links to (development; the image's store paths are mounted anyway).
 */
export function hermesInstalls(bin: string): string[] {
  return [dirname(dirname(bin)), ...venvPython(dirname(bin))];
}
