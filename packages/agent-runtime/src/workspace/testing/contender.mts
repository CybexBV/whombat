// A second runner process for the contention tests: takes a host lock, or prepares a workspace, and reports.

import { WorkspaceManager } from '../index';
import { hostLock, LockBusyError } from '../lock';

const [mode, ...rest] = process.argv.slice(2);
const say = (o: object) => process.stdout.write(`${JSON.stringify({ ...o, t: Date.now() })}\n`);

if (mode === 'hold') {
  const [name, dir, holdMs, waitMs] = rest;
  try {
    const lock = await hostLock(name as string, {
      dir: dir as string,
      holder: `pid${process.pid}`,
      waitMs: Number(waitMs ?? 0),
      pollMs: 10,
    });
    say({ event: 'held' });
    await new Promise((r) => setTimeout(r, Number(holdMs)));
    say({ event: 'releasing' });
    await lock.release();
  } catch (err) {
    say({
      event: err instanceof LockBusyError ? 'busy' : 'error',
      holder: (err as LockBusyError).holder ?? null,
      message: String(err),
    });
    process.exit(3);
  }
} else if (mode === 'prepare') {
  const [root, origin, branch, id] = rest;
  const m = new WorkspaceManager({
    root: root as string,
    holder: id as string,
    credentials: async () => ({ token: 't', remoteUrl: origin as string }),
  });
  try {
    const ws = await m.prepare({
      burrow: 'b',
      repo: 'o/r',
      branch: branch as string,
      baseBranch: 'main',
      cloneUrl: origin as string,
    });
    say({ event: 'prepared', path: ws.path, head: ws.head });
  } catch (err) {
    say({ event: 'error', message: String(err) });
    process.exit(1);
  }
}
