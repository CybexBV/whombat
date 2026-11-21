/**
 * Provider subprocesses run in their own process group (`detached: true`) so every cancellation path
 * can kill the CLI together with everything it started (MCP stdio servers, shells, test runners).
 * On Linux we also walk `/proc` for descendants that moved to their own session (PTY shells call
 * `setsid`) and kill those groups too.
 */
import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export interface GroupSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Spawns `command` as the leader of a new process group with piped stdio. */
export function spawnGroup(
  command: string,
  args: readonly string[],
  options: GroupSpawnOptions = {},
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signal(target: number, sig: NodeJS.Signals): void {
  try {
    process.kill(target, sig);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

/** `pid → [ppid, pgid]` for every process, Linux only (empty elsewhere). */
function processTable(): Map<number, { ppid: number; pgid: number }> {
  const table = new Map<number, { ppid: number; pgid: number }>();
  if (process.platform !== 'linux') return table;
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return table;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      // "pid (comm) state ppid pgrp …" — comm may contain spaces and parens.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // Zombies are already dead; they only wait to be reaped.
      if (fields[0] === 'Z' || fields[0] === 'X') continue;
      table.set(Number(entry), { ppid: Number(fields[1]), pgid: Number(fields[2]) });
    } catch {
      // Process exited while scanning.
    }
  }
  return table;
}

/** Descendant pids of `root` (not including it), best effort. */
export function descendantsOf(root: number): number[] {
  const table = processTable();
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) {
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop() as number;
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** Members of process group `pgid` still alive (Linux; elsewhere just the leader check). */
export function groupMembers(pgid: number): number[] {
  const table = processTable();
  if (!table.size) return alive(pgid) ? [pgid] : [];
  return [...table].filter(([, info]) => info.pgid === pgid).map(([pid]) => pid);
}

export interface KillOptions {
  /** Time between SIGTERM and SIGKILL. */
  graceMs?: number;
}

/**
 * Kills the process group led by `child` (and escaped descendants): SIGTERM, wait up to `graceMs`
 * for the group to drain, then SIGKILL whatever is left. Resolves once nothing is left alive
 * (bounded). Safe to call repeatedly and after the leader exited.
 */
export async function killProcessTree(child: ChildProcess, options: KillOptions = {}): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const graceMs = options.graceMs ?? 2000;
  // Snapshot descendants first: once the leader dies they are reparented and untraceable.
  const escaped = new Set<number>();
  const collect = () => {
    for (const d of descendantsOf(pid)) escaped.add(d);
  };
  collect();
  const everyone = () => {
    const table = processTable();
    if (!table.size) return alive(pid) ? [pid] : [];
    const left = [...table].filter(([p, info]) => info.pgid === pid || escaped.has(p));
    return left.map(([p]) => p);
  };
  const send = (sig: NodeJS.Signals) => {
    signal(-pid, sig);
    const table = processTable();
    for (const d of escaped) {
      const info = table.get(d);
      if (!info) continue;
      signal(d, sig);
      // A descendant that became a group leader (setsid) takes its own group down with it.
      if (info.pgid === d && d !== process.pid) signal(-d, sig);
    }
  };
  send('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    collect();
    if (everyone().length === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  collect();
  send('SIGKILL');
  const hardDeadline = Date.now() + 2000;
  while (Date.now() < hardDeadline && everyone().length > 0) {
    await new Promise((r) => setTimeout(r, 25));
  }
}
