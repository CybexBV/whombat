/**
 * `dev/down [--purge]` — stops the harness's processes (process groups from env.json) and its Postgres container.
 * `--purge` also removes the container, its volume and `~/.cache/whombat-mgd/env` (keys, claim card, logs).
 * Never touches anything not started by the harness (the shared Mailpit, other containers).
 */
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquireEnvLock, releaseEnvLock } from '../lib/lock.ts';
import { PG_CONTAINER, paths, STATE_HOME } from '../lib/paths.ts';
import { alive, stopGroup } from '../lib/proc.ts';
import { type EnvState, envPath, loadEnv, RETIRED_SERVICES, type ServiceName, saveEnv } from './env.ts';
import { stopPostgres } from './postgres.ts';

/**
 * Processes left behind by an environment whose env.json was lost (a crash, or two writers): anything of this
 * user whose working directory or command line is inside the harness state (src/, bin/, env/), except this
 * process and its parents. Only harness-started processes live there.
 */
export function orphans(): number[] {
  const mine = new Set<number>([process.pid, process.ppid]);
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    const pid = Number(d);
    if (!Number.isInteger(pid) || mine.has(pid)) continue;
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      const inside = (p: string) =>
        [paths.src, paths.bin, paths.env, `${paths.home}/fixtures`].some(
          (r) => p.startsWith(`${r}/`) || p === r,
        );
      if (
        inside(cwd) ||
        [paths.src, paths.bin, paths.env, `${paths.home}/fixtures`].some((r) => cmd.includes(`${r}/`))
      )
        out.push(pid);
    } catch {
      // gone or not ours
    }
  }
  void STATE_HOME;
  return out;
}

const ORDER: ServiceName[] = [
  'embed',
  'web',
  'runner',
  'runtime',
  'agent-net',
  'hosts',
  'bridge',
  'manager',
  'helper',
  'tuf-refresh',
  'tuf',
  'backup',
  'restic',
  'relay',
  'control',
];

type StopOptions = { purge: boolean; quiet?: boolean; keepPostgres?: boolean };

/**
 * Stops what an older env.json lists of `RETIRED_SERVICES` (the browser host, IN-407; computerd), removes their sockets,
 * the browser host's status file and state (Playwright's Chromium under `env/browser`) and drops them from `state`. The
 * caller saves the state.
 */
export async function stopRetired(state: EnvState, log: (l: string) => void): Promise<void> {
  const services = state.services as Record<string, { pid: number | null } | undefined>;
  for (const name of RETIRED_SERVICES) {
    const s = services[name];
    if (!s) continue;
    if (s.pid && alive(s.pid)) {
      log(`stopping ${name} (pid ${s.pid}; the environment no longer runs it)`);
      await stopGroup(s.pid);
    }
    delete services[name];
  }
  for (const f of [
    join(paths.run, 'computerd.sock'),
    join(paths.run, 'browser.sock'),
    join(paths.run, 'browser-status.json'),
    envPath('browser'),
  ])
    if (existsSync(f)) {
      makeWritable(f);
      rmSync(f, { recursive: true, force: true });
    }
}

export async function stopAll(options: StopOptions): Promise<void> {
  acquireEnvLock('dev/down');
  try {
    await stopAllLocked(options);
  } finally {
    releaseEnvLock();
  }
}

async function stopAllLocked(options: {
  purge: boolean;
  quiet?: boolean;
  keepPostgres?: boolean;
}): Promise<void> {
  const log = (l: string) => options.quiet || process.stderr.write(`${l}\n`);
  const state = loadEnv();
  if (state) {
    for (const name of ORDER) {
      const s = state.services[name];
      if (!s?.pid) continue;
      if (alive(s.pid)) {
        log(`stopping ${name} (pid ${s.pid})`);
        await stopGroup(s.pid);
      }
      s.status = 'stopped';
      s.pid = null;
    }
    await stopRetired(state, log);
    if (state.services.postgres)
      state.services.postgres.status = options.keepPostgres ? 'running' : 'stopped';
    if (!options.purge) saveEnv(state);
  }
  const left = orphans();
  if (left.length) {
    log(`stopping ${left.length} orphaned harness process(es): ${left.join(' ')}`);
    await Promise.all(left.map((p) => stopGroup(p, 5000)));
  }
  if (!options.keepPostgres) {
    log(options.purge ? `removing ${PG_CONTAINER} and its volume` : `stopping ${PG_CONTAINER}`);
    await stopPostgres(options.purge);
  }
  for (const sock of ['manager.sock', 'admin.sock', 'agent-net.sock']) {
    const f = `${paths.run}/${sock}`;
    if (existsSync(f)) rmSync(f);
  }
  if (options.purge && existsSync(paths.env)) {
    log(`removing ${paths.env}`);
    // The runtime keeps skill versions (pack versions before 0.113) and the fake activator its store read-only: make
    // them writable first.
    makeWritable(paths.env);
    rmSync(paths.env, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  await stopAll({ purge: args.includes('--purge'), keepPostgres: args.includes('--keep-postgres') });
  process.stderr.write('down.\n');
}

/** u+w on every directory and file under `dir` (never following symlinks), so a purge can remove read-only trees. */
export function makeWritable(dir: string): void {
  if (!existsSync(dir)) return;
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) return;
  if (!(st.mode & 0o200)) chmodSync(dir, st.mode | 0o200);
  if (st.isDirectory()) for (const e of readdirSync(dir)) makeWritable(join(dir, e));
}
