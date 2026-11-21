/** Processes: captured commands, detached services with log files, health waits. */
import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path';
import { TMP_DIR } from './paths.ts';

export interface RunResult {
  command: string;
  cwd: string;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Append combined output to this file as well. */
  logFile?: string;
  timeoutMs?: number;
  /** Echo output to our stderr while running. */
  echo?: boolean;
  input?: string;
  /** Keep only the last N bytes of stdout/stderr in memory (default 4 MiB). */
  maxCapture?: number;
  /** Each chunk of stdout and stderr as it arrives (to act on a step while the command goes on). */
  onOutput?: (chunk: string) => void;
  /**
   * Run it in a transient user scope with this MemoryHigh (`1G`, `4G`), whose page cache and dentries are reclaimed
   * over the mark and when the command ends (`scopeCommand`): the kernel otherwise keeps them while the host has
   * memory free, and on the build machine they pin ZFS ARC metadata. Above what the command needs itself, or it is throttled.
   * Run as it is where no scope can be had (`scopes`), with WB_MEMORY_SCOPE=0, or when the command isn't found.
   */
  memoryHigh?: string;
}

/** Environment every child gets: shared-host TMPDIR, no colour codes in logs. */
export function baseEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    TMPDIR: TMP_DIR,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...extra,
  }))
    if (v !== undefined) env[k] = v;
  return env;
}

export function quote(cmd: string, args: readonly string[]): string {
  return [cmd, ...args]
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/** A MemoryHigh systemd takes: bytes, K/M/G/T, a percentage of the host's memory, or infinity. */
const MEMORY_HIGH = /^(\d+(\.\d+)?[KMGT]?|\d+(\.\d+)?%|infinity)$/;

/**
 * The user unit this process runs in and its slice, from /proc/self/cgroup, for a scope to be stopped with it as the
 * command would have been in its cgroup (a T3 agent's scope stops with KillMode=control-group). Null outside the user
 * manager: an SSH session, a system service.
 */
export function callerUnit(cgroup: string): { unit: string; slice: string | null } | null {
  const parts = (
    cgroup
      .split('\n')
      .find((l) => l.startsWith('0::'))
      ?.slice(3) ?? ''
  ).split('/');
  const at = parts.findIndex((p) => /^user@\d+\.service$/.test(p));
  const unit = parts.at(-1) ?? '';
  if (at < 0 || parts.length < at + 3 || !/\.(scope|service)$/.test(unit)) return null;
  const slice = parts.at(-2) ?? '';
  return { unit, slice: slice.endsWith('.slice') ? slice : null };
}

/**
 * The scope's shell: the command, then what the scope still holds of page cache and slab reclaimed
 * (`memory.reclaim`, swappiness=0 so nothing is swapped), then its exit code passed on, or its signal raised again.
 * MemoryHigh reclaims only over the mark: a scope that ends under it leaves its dentries to the parent cgroup, where
 * ZFS's arc_prune doesn't reach them either. The reclaim may fall short (EAGAIN); that is fine.
 */
export const RECLAIM_SH = [
  '"$@"; rc=$?',
  'IFS=: read -r _ _ cg </proc/self/cgroup; cg=/sys/fs/cgroup$cg',
  'read -r n <"$cg/memory.current" && echo "$n swappiness=0" >"$cg/memory.reclaim" 2>/dev/null',
  '[ $rc -gt 128 ] && [ $rc -lt 160 ] && kill -$((rc - 128)) $$',
  'exit $rc',
].join('\n');

/**
 * `cmd args` under `systemd-run --user --scope`, which starts the scope and then execs what it runs: the same pid and
 * process group, stdio, environment and working directory. With `reclaim` it runs `/bin/sh -c RECLAIM_SH`, which
 * runs the command and passes on its exit code; without, the command itself. The scope is named `unit` (to stop
 * it), in the caller's slice and stopped with the caller's unit. `--expand-environment=no` keeps the arguments as
 * they are: newer systemd (259) expands `${NAME}` and turns `$$` into `$` in a scope's command line, as it does for
 * a service's, which would change a shell script, a Nix expression or RECLAIM_SH itself.
 */
export function scopeCommand(
  cmd: string,
  args: readonly string[],
  o: {
    memoryHigh: string;
    unit: string;
    caller: { unit: string; slice: string | null } | null;
    reclaim: boolean;
  },
): { cmd: string; args: string[] } {
  if (!MEMORY_HIGH.test(o.memoryHigh))
    throw new Error(`MemoryHigh ${o.memoryHigh} is not a size systemd takes (512M, 4G, 10%)`);
  const caller = o.caller
    ? [...(o.caller.slice ? [`--slice=${o.caller.slice}`] : []), '-p', `BindsTo=${o.caller.unit}`]
    : [];
  return {
    cmd: 'systemd-run',
    args: [
      ...[
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        '--expand-environment=no',
        `--unit=${o.unit}`,
        ...caller,
      ],
      ...['-p', `MemoryHigh=${o.memoryHigh}`, '--'],
      ...(o.reclaim ? ['/bin/sh', '-c', RECLAIM_SH, 'sh'] : []),
      cmd,
      ...args,
    ],
  };
}

let scopesWork: boolean | undefined;
let scopeCount = 0;

/**
 * Whether commands may run in a scope of their own: not with WB_MEMORY_SCOPE=0, in a nix build or a container (no
 * user manager there, and their own cgroup already holds what they read), and only where `systemd-run --user --scope`
 * works with the options `scopeCommand` gives it (asked once): a systemd older than 254 doesn't know
 * `--expand-environment`, and its commands run as they are.
 */
export function scopes(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WB_MEMORY_SCOPE === '0' || env.NIX_BUILD_TOP || env.container) return false;
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return false;
  scopesWork ??=
    spawnSync(
      'systemd-run',
      ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no', '--', 'true'],
      {
        stdio: 'ignore',
        timeout: 15_000,
      },
    ).status === 0;
  return scopesWork;
}

/** Whether `cmd` is an executable file, by its path from `cwd` or on `PATH` (systemd-run exits 1 without one). */
function found(cmd: string, cwd: string, path = ''): boolean {
  const ok = (f: string) => {
    try {
      accessSync(f, constants.X_OK);
      return statSync(f).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes('/')) return ok(resolvePath(cwd, cmd));
  return path.split(delimiter).some((d) => d !== '' && ok(join(d, cmd)));
}

function ownCgroup(): string {
  try {
    return readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return '';
  }
}

/**
 * What `run` spawns: the command in a scope of its own when `memoryHigh` asks for one and it can, and the scope.
 * WB_MEMORY_RECLAIM=0 keeps the MemoryHigh without the reclaim when the command ends.
 */
function scopedSpawn(
  cmd: string,
  args: readonly string[],
  options: RunOptions,
  env: Record<string, string>,
): { cmd: string; args: readonly string[]; unit: string | null } {
  if (!options.memoryHigh || !scopes(env) || !found(cmd, options.cwd, env.PATH))
    return { cmd, args, unit: null };
  const unit = `wb-run-${process.pid}-${++scopeCount}.scope`;
  const caller = callerUnit(ownCgroup());
  const reclaim = env.WB_MEMORY_RECLAIM !== '0' && existsSync('/bin/sh');
  return { ...scopeCommand(cmd, args, { memoryHigh: options.memoryHigh, unit, caller, reclaim }), unit };
}

/** SIGKILL to all in the scope, what left the command's process group too. */
function killScope(unit: string): void {
  spawn('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit], { stdio: 'ignore' }).on('error', () => {});
}

export function run(cmd: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const max = options.maxCapture ?? 4 * 1024 * 1024;
  mkdirSync(TMP_DIR, { recursive: true });
  const env = baseEnv(options.env);
  const spawned = scopedSpawn(cmd, args, options, env);
  return new Promise((resolve, reject) => {
    const child = spawn(spawned.cmd, spawned.args, {
      cwd: options.cwd,
      env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let log: ReturnType<typeof createWriteStream> | null = null;
    if (options.logFile) {
      mkdirSync(dirname(options.logFile), { recursive: true });
      log = createWriteStream(options.logFile, { flags: 'a' });
      log.on('error', reject);
      log.write(`\n$ (cd ${options.cwd} && ${quote(cmd, args)})\n`);
    }
    let stdout = '';
    let stderr = '';
    const keep = (s: string) => (s.length > max ? s.slice(s.length - max) : s);
    child.stdout?.on('data', (d: Buffer) => {
      stdout = keep(stdout + d.toString());
      log?.write(d);
      if (options.echo) process.stderr.write(d);
      options.onOutput?.(d.toString());
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr = keep(stderr + d.toString());
      log?.write(d);
      if (options.echo) process.stderr.write(d);
      options.onOutput?.(d.toString());
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            // already gone
          }
          if (spawned.unit) killScope(spawned.unit);
        }, options.timeoutMs)
      : null;
    let finishing = false;
    const finish = (code: number | null, signal: string | null) => {
      if (finishing) return;
      finishing = true;
      if (timer) clearTimeout(timer);
      const result: RunResult = {
        command: quote(cmd, args),
        cwd: options.cwd,
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      };
      // Callers may copy/hash the log as soon as run() resolves. Include every byte and the exit footer first.
      if (log)
        log.end(
          `\n[exit ${code ?? signal}${timedOut ? ' (timeout)' : ''} after ${result.durationMs} ms]\n`,
          () => resolve(result),
        );
      else resolve(result);
    };
    child.on('error', (err) => {
      stderr += String(err);
      finish(127, null);
    });
    child.on('close', finish);
  });
}

/** Like `run` but throws with the tail of the output when the command fails. */
export async function must(cmd: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const r = await run(cmd, args, options);
  if (r.code !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-30).join('\n');
    throw new Error(`command failed (${r.code ?? r.signal}): ${r.command}\n  in ${r.cwd}\n${tail}`);
  }
  return r;
}

/** Starts a long-running service in its own process group, output appended to `logFile`. */
export function spawnService(
  cmd: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string | undefined>; logFile: string },
): number {
  mkdirSync(dirname(options.logFile), { recursive: true });
  const fd = openSync(options.logFile, 'a');
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: baseEnv(options.env),
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  child.unref();
  if (!child.pid) throw new Error(`could not start ${quote(cmd, args)}`);
  return child.pid;
}

export function alive(pid: number | undefined | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the process group, then SIGKILL after `graceMs`. */
export async function stopGroup(pid: number, graceMs = 8000): Promise<void> {
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      try {
        process.kill(pid, s);
      } catch {
        // gone
      }
    }
  };
  // The whole group, not just its leader: a pnpm wrapper exits before the node child that holds the port.
  const groupAlive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return alive(pid);
    }
  };
  signal('SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until) {
    if (!groupAlive()) return;
    await sleep(100);
  }
  signal('SIGKILL');
  const hard = Date.now() + 5000;
  while (Date.now() < hard && groupAlive()) await sleep(100);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class WaitTimeout extends Error {
  override name = 'WaitTimeout';
}

/** Polls `probe` until it returns a truthy value; the last error explains a timeout. */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; alive?: () => boolean; hint?: string } = {},
): Promise<T> {
  const until = Date.now() + (options.timeoutMs ?? 60_000);
  let last = '';
  while (Date.now() < until) {
    if (options.alive && !options.alive())
      throw new Error(`${label}: the process exited${hintOf(options.hint)}`);
    try {
      const v = await probe();
      if (v) return v;
      last = 'not ready';
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(options.intervalMs ?? 500);
  }
  throw new WaitTimeout(
    `${label}: not ready after ${options.timeoutMs ?? 60_000} ms (${last})${hintOf(options.hint)}`,
  );
}

const hintOf = (h?: string) => (h ? `\n  → ${h}` : '');

/** GET a URL with a short timeout; resolves to the response or throws. */
export async function httpGet(url: string, timeoutMs = 3000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}
