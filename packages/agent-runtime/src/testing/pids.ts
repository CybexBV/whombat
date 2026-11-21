import { existsSync, readFileSync } from 'node:fs';

/** True while `pid` runs (zombies count as dead: they only wait to be reaped). */
export function isAlive(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      return state !== 'Z' && state !== 'X';
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for a JSON file written by `family.mjs` and returns its pids. */
export async function readPids(
  file: string,
  timeoutMs = 10_000,
): Promise<{ pid: number; child: number; escaped: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (text.trim()) return JSON.parse(text);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`No pids written to ${file}`);
}

/** Polls until every pid is gone (or throws). */
export async function expectAllDead(pids: number[], timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((p) => !isAlive(p))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const alive = pids.filter(isAlive);
  for (const p of alive) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // gone
    }
  }
  throw new Error(`Processes still alive: ${alive.join(', ')}`);
}
