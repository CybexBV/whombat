/**
 * Workspace contention across processes (docs/decisions/managed-sandbox.md MSB-12) and fencing (MSB-11): shared
 * operations on one repository serialise between runner processes, a waiter gives up clearly, a holder that dies
 * releases at once, and a workspace a newer generation prepared refuses the stale one's pushes and landing.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceBusyError, WorkspaceFencedError, WorkspaceManager, type WorkspaceTarget } from './index';
import { hostLock, hostLockWaiters, LockBusyError } from './lock';

const contender = fileURLToPath(new URL('./testing/contender.mts', import.meta.url));

interface Line {
  event: string;
  t: number;
  holder?: string | null;
  message?: string;
  path?: string;
}

function run(args: string[]): {
  lines: Line[];
  done: Promise<number | null>;
  child: ReturnType<typeof spawn>;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', contender, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: Line[] = [];
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)) as Line);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  });
  let err = '';
  child.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
  });
  const done = new Promise<number | null>((r) =>
    child.on('exit', (code) => {
      if (code !== 0 && code !== 3 && err) console.error(err);
      r(code);
    }),
  );
  return { lines, done, child };
}

const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-contend-'));
});

describe('host locks between processes', () => {
  it('serialise: the second holder starts only after the first let go', async () => {
    const name = `test:${dir}`;
    const a = run(['hold', name, join(dir, 'locks'), '400', '10000']);
    await until(() => a.lines.some((l) => l.event === 'held'));
    const b = run(['hold', name, join(dir, 'locks'), '50', '10000']);
    expect(await a.done).toBe(0);
    expect(await b.done).toBe(0);
    const aRelease = a.lines.find((l) => l.event === 'releasing')?.t as number;
    const bHeld = b.lines.find((l) => l.event === 'held')?.t as number;
    expect(bHeld).toBeGreaterThanOrEqual(aRelease);
  }, 30_000);

  it('a waiter gives up after its wait and names the holder', async () => {
    const name = `test:${dir}`;
    const mine = await hostLock(name, { dir: join(dir, 'locks'), holder: 'dsp_holder' });
    try {
      const b = run(['hold', name, join(dir, 'locks'), '10', '200']);
      expect(await b.done).toBe(3);
      expect(b.lines[0]).toMatchObject({ event: 'busy', holder: 'dsp_holder' });
    } finally {
      await mine.release();
    }
  }, 30_000);

  it('a holder that crashed releases the lock with its process', async () => {
    const name = `test:${dir}`;
    const a = run(['hold', name, join(dir, 'locks'), '60000', '0']);
    await until(() => a.lines.some((l) => l.event === 'held'));
    await expect(hostLock(name, { dir: join(dir, 'locks'), holder: 'me' })).rejects.toBeInstanceOf(
      LockBusyError,
    );
    a.child.kill('SIGKILL');
    await a.done;
    const lock = await hostLock(name, { dir: join(dir, 'locks'), holder: 'me', waitMs: 2000, pollMs: 10 });
    await lock.release();
  }, 30_000);

  it('a polite take yields to a caller waiting for the lock, and takes it once nobody waits', async () => {
    const name = `test:${dir}`;
    const locks = join(dir, 'locks');
    const first = await hostLock(name, { dir: locks, holder: 'turn-1' });
    const waiting = hostLock(name, { dir: locks, holder: 'turn-2', waitMs: 10_000, pollMs: 1000 });
    await until(() => hostLockWaiters(name) === 1);
    // Free now, but the waiter's next try is still to come: the polite take leaves it to the waiter.
    await first.release();
    await expect(hostLock(name, { dir: locks, holder: 'deleter', polite: true })).rejects.toBeInstanceOf(
      LockBusyError,
    );
    const second = await waiting;
    expect(hostLockWaiters(name)).toBe(0);
    await second.release();
    const polite = await hostLock(name, { dir: locks, holder: 'deleter', polite: true });
    await polite.release();
  }, 30_000);
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@x',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@x',
    },
  }).trim();

function origin(): string {
  const seed = join(dir, 'seed');
  git(dir, 'init', '--quiet', '-b', 'main', seed);
  writeFileSync(join(seed, 'README.md'), 'x\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'init');
  const bare = join(dir, 'origin.git');
  git(dir, 'clone', '--quiet', '--bare', seed, bare);
  return bare;
}

describe('concurrent turns on one repository', () => {
  it('prepare the mirror and their worktrees one after the other, from several processes', async () => {
    const remote = origin();
    const root = join(dir, 'workspaces');
    const branches = ['feat/a', 'feat/b', 'feat/c', 'feat/a'];
    const runs = branches.map((b, i) => run(['prepare', root, remote, b, `dsp_${i}`]));
    const codes = await Promise.all(runs.map((r) => r.done));
    expect(codes).toEqual([0, 0, 0, 0]);
    for (const r of runs) expect(r.lines.at(-1)).toMatchObject({ event: 'prepared' });
    // One mirror, one workspace per branch, all consistent.
    const m = new WorkspaceManager({ root, credentials: async () => ({ token: 't', remoteUrl: remote }) });
    for (const b of ['feat/a', 'feat/b', 'feat/c']) {
      const ws = await m.prepare({
        burrow: 'b',
        repo: 'o/r',
        branch: b,
        baseBranch: 'main',
        cloneUrl: remote,
      });
      expect(git(ws.path, 'status', '--porcelain')).toBe('');
    }
  }, 60_000);

  it('a turn that waits too long is refused clearly', async () => {
    const remote = origin();
    const root = join(dir, 'workspaces');
    const t: WorkspaceTarget = {
      burrow: 'b',
      repo: 'o/r',
      branch: 'feat/a',
      baseBranch: 'main',
      cloneUrl: remote,
    };
    const first = new WorkspaceManager({
      root,
      credentials: async () => ({ token: 't', remoteUrl: remote }),
    });
    await first.prepare(t);
    // Another runner process is in the middle of an operation on this repository.
    const mirror = first.paths(t).mirror;
    const busy = run(['hold', `ws:${mirror}`, join(root, '.locks'), '3000', '0']);
    await until(() => busy.lines.some((l) => l.event === 'held'));
    const second = new WorkspaceManager({
      root,
      lockWaitMs: 200,
      holder: 'dsp_2',
      credentials: async () => ({ token: 't', remoteUrl: remote }),
    });
    const err = await second.prepare(t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceBusyError);
    expect((err as WorkspaceBusyError).holder).toMatch(/^pid\d+$/);
    busy.child.kill('SIGKILL');
    await busy.done;
    await expect(second.prepare(t)).resolves.toMatchObject({ branch: 'feat/a' });
  }, 30_000);
});

describe('fencing a stale generation out of its workspace', () => {
  it('refuses the old generation’s pushes and prepares once a newer one prepared the workspace', async () => {
    const remote = origin();
    const root = join(dir, 'workspaces');
    const t = (): WorkspaceTarget => ({
      burrow: 'b',
      repo: 'o/r',
      branch: 'feat/a',
      baseBranch: 'main',
      cloneUrl: remote,
    });
    const pushes: string[] = [];
    const creds = async (req: { operation: string }) => {
      pushes.push(req.operation);
      return { token: 't', remoteUrl: remote };
    };
    const g7 = new WorkspaceManager({
      root,
      credentials: creds,
      fence: { generation: 7, dispatch: 'dsp_1', attempt: 1 },
    });
    const ws = await g7.prepare(t());
    git(ws.path, 'commit', '--allow-empty', '-q', '-m', 'from g7');
    // The runner restarts as generation 8 and takes the dispatch over (attempt 2).
    const g8 = new WorkspaceManager({
      root,
      credentials: creds,
      fence: { generation: 8, dispatch: 'dsp_1', attempt: 2 },
    });
    await g8.prepare(t());
    pushes.length = 0;
    await expect(g7.push(t())).rejects.toBeInstanceOf(WorkspaceFencedError);
    await expect(g7.prepare(t())).rejects.toBeInstanceOf(WorkspaceFencedError);
    // An earlier attempt in the same generation is stale too.
    const earlier = new WorkspaceManager({
      root,
      credentials: creds,
      fence: { generation: 8, dispatch: 'dsp_1', attempt: 1 },
    });
    await expect(earlier.push(t())).rejects.toBeInstanceOf(WorkspaceFencedError);
    // No push token was ever asked for (a fetch into the shared mirror may be).
    expect(pushes).not.toContain('push');
    // Another dispatch of the current generation, and the owner, may.
    const other = new WorkspaceManager({
      root,
      credentials: creds,
      fence: { generation: 8, dispatch: 'dsp_2', attempt: 1 },
    });
    await expect(other.push(t())).resolves.toBeUndefined();
    await expect(g8.push(t())).resolves.toBeUndefined();
    // Self-hosted (no token) is unchanged.
    await expect(new WorkspaceManager({ root, credentials: creds }).push(t())).resolves.toBeUndefined();
  }, 30_000);
});
