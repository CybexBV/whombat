/**
 * Locks for shared workspace operations across processes (docs/decisions/managed-sandbox.md MSB-12): fetch, worktree
 * add / remove / prune and pushing on one repository.
 *
 * The lock is a Linux abstract unix socket bound by the holder (`\0whombat-lock-<sha256(name)>`): the kernel
 * gives a name to one process at a time and releases it the moment that process dies — no stale lock files,
 * no takeover races, no pid reuse. (It lives in the runner's network namespace; sandboxed tasks have their own
 * and can't touch it.) Next to it a holder file (`<dir>/<hash>.json`) says who holds it, for the refusal.
 * Waiters poll until `waitMs`, then fail with `LockBusyError`; an aborted wait fails at once. A `polite` take (background
 * work that may wait, such as deleting a person's Hermes sessions) is refused while another caller in this process
 * waits for the same lock, so a waiting turn goes first instead of losing every poll to it.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

export interface HostLock {
  name: string;
  release(): Promise<void>;
}

interface Holder {
  pid: number;
  holder: string;
  name: string;
  at: string;
}

export class LockBusyError extends Error {
  constructor(
    readonly lock: string,
    readonly holder: string | null,
  ) {
    super(`${lock} is in use${holder ? ` by ${holder}` : ''}.`);
    this.name = 'LockBusyError';
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

function bind(address: string): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') resolve(null);
      else reject(err);
    });
    server.listen(address, () => {
      server.unref();
      resolve(server);
    });
  });
}

const hashOf = (name: string) => createHash('sha256').update(name).digest('hex').slice(0, 32);

/** How many callers in this process are waiting for each lock now (a `polite` take yields to them). */
const waiters = new Map<string, number>();

/** How many callers in this process wait for `name` now. */
export function hostLockWaiters(name: string): number {
  return waiters.get(name) ?? 0;
}

function countWaiter(name: string, delta: 1 | -1): void {
  const n = (waiters.get(name) ?? 0) + delta;
  if (n > 0) waiters.set(name, n);
  else waiters.delete(name);
}

/**
 * Takes the host-wide lock `name`, waiting up to `waitMs` (default 0: try once). `dir` keeps the holder files
 * (a Whombat-owned directory, e.g. `$WHOMBAT_HOME/locks`); `holder` names who holds it (a dispatch id). `polite`:
 * refused at once while another caller in this process waits for it.
 */
export async function hostLock(
  name: string,
  options: {
    dir: string;
    holder: string;
    waitMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
    polite?: boolean;
  },
): Promise<HostLock> {
  if (process.platform !== 'linux') throw new Error('Workspace locks need Linux (abstract unix sockets).');
  if (options.polite && waiters.has(name)) throw new LockBusyError(name, null);
  const hash = hashOf(name);
  const address = `\0whombat-lock-${hash}`;
  const info = join(options.dir, `${hash}.json`);
  await mkdir(options.dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.waitMs ?? 0);
  let waiting = false;
  try {
    return await take();
  } finally {
    if (waiting) countWaiter(name, -1);
  }

  async function take(): Promise<HostLock> {
    for (;;) {
      const server = await bind(address);
      if (server) {
        const mine: Holder = { pid: process.pid, holder: options.holder, name, at: new Date().toISOString() };
        await writeFile(info, JSON.stringify(mine), { mode: 0o600 }).catch(() => {});
        let released = false;
        return {
          name,
          release: async () => {
            if (released) return;
            released = true;
            await rm(info, { force: true }).catch(() => {});
            await new Promise<void>((r) => server.close(() => r()));
          },
        };
      }
      if (options.signal?.aborted || Date.now() >= deadline) {
        const current = await readFile(info, 'utf8')
          .then((t) => JSON.parse(t) as Holder)
          .catch(() => null);
        throw new LockBusyError(name, current?.holder ?? null);
      }
      if (!waiting) {
        waiting = true;
        countWaiter(name, 1);
      }
      await sleep(Math.min(options.pollMs ?? 100, Math.max(1, deadline - Date.now())), options.signal);
    }
  }
}

/** Runs `fn` holding the host-wide lock `name`. */
export async function withHostLock<T>(
  name: string,
  options: Parameters<typeof hostLock>[1],
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await hostLock(name, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
