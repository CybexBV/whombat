/**
 * The runner's generation (docs/decisions/managed-sandbox.md MSB-09): a counter persisted in the runner's state
 * directory, advanced once per start, under a host-wide lock that also makes the runner the only one on its
 * state. The generation is part of the runner id (`rnr_<base>_g<n>`), so the server's lease — runner id and
 * attempt — is a fencing token no earlier generation can present; it names the task cgroups (`g<n>-<dispatch>`),
 * so a restarted runner finds and kills what its predecessors left; and it is in every workspace the runner
 * prepares (`whombat.fence`), so an earlier generation can't push or land from it any more.
 */
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { type HostLock, hostLock, LockBusyError } from '@whombat/agent-runtime';

export interface RunnerGeneration {
  generation: number;
  /** `g<n>`: the prefix of this generation's cgroups and control directories. */
  prefix: string;
  runnerId: string;
  /** Held for the runner's life: a second runner on the same state refuses to start. */
  lock: HostLock;
}

export class RunnerAlreadyRunning extends Error {
  constructor(readonly stateDir: string) {
    super(`Another runner is running on ${stateDir}.`);
    this.name = 'RunnerAlreadyRunning';
  }
}

/** Advances and persists the generation (write, fsync, rename): a crash never reuses one. */
export async function nextGeneration(stateDir: string, base = 'rnr_appliance'): Promise<RunnerGeneration> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let lock: HostLock;
  try {
    lock = await hostLock(`runner:${stateDir}`, {
      dir: join(stateDir, 'locks'),
      holder: `runner pid ${process.pid}`,
    });
  } catch (err) {
    if (err instanceof LockBusyError) throw new RunnerAlreadyRunning(stateDir);
    throw err;
  }
  const file = join(stateDir, 'generation');
  const previous = Number.parseInt((await readFile(file, 'utf8').catch(() => '0')).trim(), 10);
  const generation = (Number.isInteger(previous) && previous > 0 ? previous : 0) + 1;
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try {
    await handle.writeFile(`${generation}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  const dir = await open(stateDir, 'r');
  await dir.sync().catch(() => {});
  await dir.close();
  const safeBase = base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 50);
  return { generation, prefix: `g${generation}`, runnerId: `${safeBase}_g${generation}`, lock };
}
