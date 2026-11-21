/**
 * One writer per environment (IN-18): `dev/up`, `dev/down`, `harness/validate` and `harness/demo` hold
 * `<WB_MGD_HOME>/env.lock` (an exclusive directory with the holder's pid and command) while they run. A second
 * command refuses with who holds it; a lock whose holder died is taken over. Parallel users use their own
 * `WB_MGD_HOME`, container name and ports (docs/runbooks/local-dev.md).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_HOME } from './paths.ts';

const LOCK = join(STATE_HOME, 'env.lock');

function holder(): { pid: number; what: string; since: string } | null {
  try {
    return JSON.parse(readFileSync(join(LOCK, 'holder.json'), 'utf8'));
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let held = 0;

/** Takes the environment lock for this process (re-entrant). */
export function acquireEnvLock(what: string): void {
  if (held++ > 0) return;
  mkdirSync(STATE_HOME, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(LOCK);
      writeFileSync(
        join(LOCK, 'holder.json'),
        JSON.stringify({ pid: process.pid, what, since: new Date().toISOString() }),
      );
      process.once('exit', () => releaseEnvLock(true));
      return;
    } catch {
      const h = holder();
      if (h && h.pid !== process.pid && alive(h.pid)) {
        held = 0;
        throw new Error(
          `the environment in ${STATE_HOME} is in use by pid ${h.pid} (${h.what}, since ${h.since}).\n` +
            '  Wait for it, or use your own environment: WB_MGD_HOME, WB_MGD_PG_CONTAINER and ports (docs/runbooks/local-dev.md).',
        );
      }
      if (h?.pid === process.pid) return;
      rmSync(LOCK, { recursive: true, force: true }); // stale
    }
  }
  held = 0;
  throw new Error(`could not take ${LOCK}`);
}

export function releaseEnvLock(force = false): void {
  if (!force && --held > 0) return;
  held = 0;
  const h = holder();
  if (h?.pid === process.pid) rmSync(LOCK, { recursive: true, force: true });
}
