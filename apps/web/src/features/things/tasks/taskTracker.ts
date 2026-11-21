/**
 * The tasks started in this browser (PX-05; ported from Rackoon's `features/guest/taskEvents.ts`): every change that
 * answers with a task is tracked here (`useManage` does it), the task dialog shows one at a time, and the tracker
 * (`HostTasks`, mounted once in the shell) settles each from the `hosts.task` frame or by asking, then toasts the
 * outcome. `whenTaskEnds` lets a page act on it (a deleted guest leaves its page). Kept for the session, at most 50.
 */
import type { HostManagePlatform } from '@whombat/core/domain';
import { useSyncExternalStore } from 'react';
import type { z } from 'zod';

/** Whose task it is (`pve`, `incus`, `unraid` since contracts 0.83): what `hosts.getTask` asks with. */
export type TaskPlatform = z.infer<typeof HostManagePlatform>;

export interface TaskOutcome {
  result: 'ok' | 'warning' | 'error';
  message: string;
}

export interface TrackedTask {
  burrow: string;
  serverId: string;
  taskId: string;
  platform: TaskPlatform;
  /** The change that started it (`backup.create`); empty for a task opened from a list. */
  op: string;
  /** What the toasts and the dialog call it (“Backup of web”). */
  what: string;
  guestId?: string;
  /** The new guest's id (create, clone, restore as new). */
  newId?: string;
  /** The toast when it ended well, instead of “<what> finished.” (“The array on BlackBox is started.”). */
  finished?: string;
  outcome?: TaskOutcome;
}

const tasks = new Map<string, TrackedTask>();
const waiting = new Map<string, Set<(o: TaskOutcome) => void>>();
const subs = new Set<() => void>();
let open: TrackedTask | null = null;
let running: TrackedTask[] = [];

function emit() {
  const now = [...tasks.values()].filter((t) => !t.outcome);
  // The same list keeps its identity, so a watcher of the running ones doesn't start over for nothing.
  if (now.length !== running.length || now.some((t, i) => t !== running[i])) running = now;
  for (const s of subs) s();
}

function subscribe(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** Follow a task started here: its outcome gets a toast. */
export function trackTask(task: TrackedTask): void {
  tasks.set(task.taskId, task);
  if (tasks.size > 50) {
    const oldest = tasks.keys().next().value;
    if (oldest !== undefined) tasks.delete(oldest);
  }
  emit();
}

/** A tracked task (with its outcome once it ended). */
export function trackedTask(taskId: string): TrackedTask | undefined {
  return tasks.get(taskId);
}

/** Open the task dialog (one at a time); null closes it. */
export function showTask(task: TrackedTask | null): void {
  open = task;
  emit();
}

export function useOpenTask(): TrackedTask | null {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => null,
  );
}

/** The tracked tasks that haven't ended. */
export function useRunningTasks(): readonly TrackedTask[] {
  return useSyncExternalStore(
    subscribe,
    () => running,
    () => running,
  );
}

/**
 * A task ended: keep the outcome, wake the waiters once. Returns the task the first time (the caller toasts it), null
 * for one that isn't tracked or already ended.
 */
export function settleTask(taskId: string, outcome: TaskOutcome): TrackedTask | null {
  const task = tasks.get(taskId);
  if (task?.outcome) return null;
  for (const fn of waiting.get(taskId) ?? []) fn(outcome);
  waiting.delete(taskId);
  if (!task) return null;
  const done = { ...task, outcome };
  tasks.set(taskId, done);
  emit();
  return done;
}

/** Resolves when the task ends (at once when it already has); `cancel` stops waiting (the page went). */
export function whenTaskEnds(taskId: string): { promise: Promise<TaskOutcome>; cancel: () => void } {
  const early = tasks.get(taskId)?.outcome;
  if (early) return { promise: Promise.resolve(early), cancel: () => {} };
  let fn: (o: TaskOutcome) => void = () => {};
  const promise = new Promise<TaskOutcome>((resolve) => {
    fn = resolve;
  });
  let set = waiting.get(taskId);
  if (!set) {
    set = new Set();
    waiting.set(taskId, set);
  }
  set.add(fn);
  return { promise, cancel: () => waiting.get(taskId)?.delete(fn) };
}
