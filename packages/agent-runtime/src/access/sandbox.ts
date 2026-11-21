/**
 * Finding bubblewrap for the managed sandbox (`WHOMBAT_BWRAP`, else `bwrap` on `PATH`) and other commands on `PATH`.
 */
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First `name` on `PATH` that is executable. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return null;
}

/** The bubblewrap binary: `WHOMBAT_BWRAP`, else `bwrap` on `PATH`. */
export function findBwrap(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.WHOMBAT_BWRAP?.trim();
  if (configured) return isAbsolute(configured) && executable(configured) ? configured : null;
  return onPath('bwrap', env);
}
