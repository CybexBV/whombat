/**
 * A stand-in for the task sandbox in tests (hermes-engine.md HE-13: “a fake in unit tests”). Every turn runs in a task
 * sandbox (one mode, HE-48); this one opens each task as asked and records it, and starts its processes on the host in
 * a process group of their own, so nothing walls them. Never for a real runner: `startManaged` builds the real one.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { type SandboxSession, type SandboxTask, SandboxUnavailable } from '@whombat/agent-runtime';
import type { ManagedPolicy, TaskSandboxes } from './managed';

export interface UnwalledSandbox extends TaskSandboxes {
  /** The tasks opened, in order. */
  readonly tasks: SandboxTask[];
}

function killGroup(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** A task sandbox that walls nothing (tests only); `unavailable` makes every open fail as a host without one would. */
export function unwalledSandbox(options: { unavailable?: string } = {}): UnwalledSandbox {
  const tasks: SandboxTask[] = [];
  return {
    tasks,
    node: process.execPath,
    config: { deniedPaths: [], bwrap: '/usr/bin/bwrap' },
    async open(task: SandboxTask): Promise<SandboxSession> {
      if (options.unavailable) throw new SandboxUnavailable(options.unavailable);
      tasks.push(task);
      const children: ChildProcessWithoutNullStreams[] = [];
      const kill = async () => {
        for (const child of children) killGroup(child);
      };
      return {
        id: task.id,
        mcpUrl: undefined,
        spawn: (command, args, opts) => {
          // The task's own variables on top, as the real sandbox sets them (`SandboxTask.env`).
          const env = opts.env || task.env ? { ...(opts.env ?? {}), ...(task.env ?? {}) } : undefined;
          const child = spawn(command, [...args], {
            ...(opts.cwd ? { cwd: opts.cwd } : {}),
            ...(env ? { env } : {}),
            stdio: 'pipe',
            detached: true,
          });
          children.push(child);
          return child;
        },
        kill,
        close: kill,
        violations: async () => [],
        stats: async () => null,
        egressEvents: () => [],
        setEgress: () => {},
        cgroupPath: () => '/sys/fs/cgroup/whombat-test',
        commandsCgroup: () => null,
      };
    },
  };
}

/** The execution policy of a test runner: an unwalled sandbox (`unwalledSandbox`) and whatever else the test sets. */
export function testPolicy(over: Partial<ManagedPolicy> = {}): ManagedPolicy {
  return { sandbox: unwalledSandbox(), ...over };
}
