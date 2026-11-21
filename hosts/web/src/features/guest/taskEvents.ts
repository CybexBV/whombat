// Long operations on a host (create, clone, backups, downloads, ...) answer
// 202 with a task: announceTask toasts "… started" with "Show progress",
// which opens the task dialog (TaskDialog.tsx, mounted once in the shell).
// The hub's SSE `task.finished` toasts the outcome of the tasks started in
// this browser (events.ts invalidates the lists); whenTaskFinished lets a
// form act on it (create: open the new guest).

import { useEffect, useSyncExternalStore } from 'react';
import { onServerEvent } from '../../api/events';
import type { ManagePlatform, TaskState } from '../../api/manage';
import { toast } from '../../components/Toast';
import { t } from '../../lib/i18n';

export interface OpenTask {
  serverId: string;
  platform: ManagePlatform;
  taskId: string;
  /** "Back up web-01"; the dialog falls back to the task type. */
  label?: string;
}

export interface TaskOutcome {
  result: Exclude<TaskState, 'running'>;
  message: string;
}

// ---------------------------------------------------------------- the open dialog

let open: OpenTask | null = null;
const subs = new Set<() => void>();
const emit = () => {
  for (const s of subs) s();
};

/** Open the task dialog for a task (one at a time). */
export function showTask(task: OpenTask | null): void {
  open = task;
  emit();
}

export function useOpenTask(): OpenTask | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => open,
    () => open,
  );
}

// ---------------------------------------------------------------- outcomes

/** Labels of the tasks started here: only those get an outcome toast. */
const started = new Map<string, OpenTask>();
const settled = new Map<string, TaskOutcome>();
const waiting = new Map<string, Set<(o: TaskOutcome) => void>>();

/**
 * Toast "<label> started" with "Show progress" (opens the task dialog). Call
 * it for every 202 answer of the manage endpoints.
 */
export function announceTask(serverId: string, platform: ManagePlatform, taskId: string, label: string): void {
  const task: OpenTask = { serverId, platform, taskId, label };
  started.set(taskId, task);
  if (started.size > 50) started.delete(started.keys().next().value!);
  toast(t('{label} started', { label }), 'info', 10_000, { label: t('Show progress'), onSelect: () => showTask(task) });
}

/** Resolves when the task ends (from SSE or the task dialog); the outcome is kept for late callers. */
export function whenTaskFinished(taskId: string): { promise: Promise<TaskOutcome>; cancel: () => void } {
  const early = settled.get(taskId);
  if (early) return { promise: Promise.resolve(early), cancel: () => {} };
  let fn: (o: TaskOutcome) => void = () => {};
  const promise = new Promise<TaskOutcome>((resolve) => {
    fn = resolve;
  });
  let set = waiting.get(taskId);
  if (!set) waiting.set(taskId, (set = new Set()));
  set.add(fn);
  return { promise, cancel: () => waiting.get(taskId)?.delete(fn) };
}

/**
 * A task ended: wake the waiters once and toast the outcome of tasks started
 * here, unless their dialog is open (it shows the outcome itself).
 */
export function taskSettled(taskId: string, outcome: TaskOutcome): void {
  if (settled.has(taskId)) return;
  settled.set(taskId, outcome);
  if (settled.size > 100) settled.delete(settled.keys().next().value!);
  for (const fn of waiting.get(taskId) ?? []) fn(outcome);
  waiting.delete(taskId);
  const task = started.get(taskId);
  if (!task || open?.taskId === taskId) return;
  const label = task.label ?? t('Task');
  if (outcome.result === 'ok') toast(t('{label}: done.', { label }), 'success');
  else if (outcome.result === 'warning') toast(t('{label} finished with warnings: {message}', { label, message: outcome.message }), 'info', 10_000, { label: t('Show log'), onSelect: () => showTask(task) });
  else toast(t('{label} failed: {error}', { label, error: outcome.message || t('see the task log') }), 'error', 12_000, { label: t('Show log'), onSelect: () => showTask(task) });
}

/** The shell's listener for `task.finished` (mounted once). */
export function useTaskEvents(): void {
  useEffect(
    () =>
      onServerEvent('task.finished', (d) => {
        const id = typeof d.task === 'string' ? d.task : '';
        const r = d.result;
        if (!id || (r !== 'ok' && r !== 'warning' && r !== 'error')) return;
        taskSettled(id, { result: r, message: typeof d.message === 'string' ? d.message : '' });
      }),
    [],
  );
}
