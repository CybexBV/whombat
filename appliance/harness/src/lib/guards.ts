/**
 * The maintainers' private guard list and their whombat-ops checkout, which live outside the public repositories. The
 * list names private values that must never be published (addresses, device ids, domains, an old product name), in
 * sections; contributors don't have it, and what reads it skips without it unless a maintainer's release tool requires
 * it (WHOMBAT_GUARDS_REQUIRED=1). Looked for in the same order as `scripts/guards.sh`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function gitConfig(repo: string, key: string): string {
  try {
    return execFileSync('git', ['-C', repo, 'config', '--get', key], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** whombat-ops: WHOMBAT_OPS, else `git config whombat.ops` in `repo`, else ~/Code/whombat-ops; null without it. */
export function opsDir(repo: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of [env.WHOMBAT_OPS, gitConfig(repo, 'whombat.ops'), join(homedir(), 'Code', 'whombat-ops')])
    if (dir && existsSync(join(dir, 'guards'))) return dir;
  return null;
}

/** The guard list: WHOMBAT_GUARDS, else whombat-ops' guards/forbid.txt; null without it. */
export function guardsFile(repo: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.WHOMBAT_GUARDS && existsSync(env.WHOMBAT_GUARDS)) return env.WHOMBAT_GUARDS;
  const ops = opsDir(repo, env);
  const file = ops ? join(ops, 'guards', 'forbid.txt') : null;
  return file && existsSync(file) ? file : null;
}

/** A command of whombat-ops' `bin/` (the maintainers' shipping tools), or an error naming what is missing. */
export function opsCommand(repo: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  const ops = opsDir(repo, env);
  if (!ops) throw new Error(`${name} is a maintainers' command of whombat-ops, which isn't on this machine`);
  return join(ops, 'bin', name);
}
