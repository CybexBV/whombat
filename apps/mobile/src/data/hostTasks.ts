/**
 * Long server work that reports back on the phone (Whombat proxmox.md PX-05; proxmox-mobile.md AP-1490): a change
 * that answers with a task (`hosts.manage` → `task.id`) or an action (`hosts.guestAction` → `actionId`) is followed
 * here until the `hosts.task` frame says it ended (or, for a task, its read does), then one note says how. Kept in
 * memory for 24 hours: a restart of the app forgets them; the task itself is unaffected. Pure apart from the module's
 * one list; `screens/HostTasksBridge.tsx` listens and polls.
 */
import type { FollowWords } from '@whombat/client/hosts/mobile';

export const FOLLOW_MAX_MS = 24 * 3600_000;

export interface FollowedTask {
  /** `task:<id>` or `action:<id>`. */
  key: string;
  serverId: string;
  taskId?: string;
  actionId?: string;
  words: FollowWords;
  /** Who reads it: `pve`, `incus`, `unraid`, `libvirt` or `host` (by its id when left out, AP-1641, AP-2884). */
  platform?: 'pve' | 'incus' | 'unraid' | 'libvirt' | 'host';
  /** Only a task that didn't go well says how it ended (a guest's power: its dot already shows it). */
  quiet?: boolean;
  at: number;
}

export interface TaskFrame {
  serverId: string;
  taskId?: string | undefined;
  actionId?: string | undefined;
}

let list: readonly FollowedTask[] = [];
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};

export function followKey(t: { taskId?: string | undefined; actionId?: string | undefined }): string | null {
  if (t.taskId) return `task:${t.taskId}`;
  if (t.actionId) return `action:${t.actionId}`;
  return null;
}

/** The followed task a frame ends, if any (same server, same task or action). */
export function frameMatch(followed: readonly FollowedTask[], frame: TaskFrame): FollowedTask | null {
  return (
    followed.find(
      (t) =>
        t.serverId === frame.serverId &&
        ((!!frame.taskId && t.taskId === frame.taskId) ||
          (!!frame.actionId && t.actionId === frame.actionId)),
    ) ?? null
  );
}

/** The list with one more (the same one once), those older than a day left out. */
export function withFollowed(
  followed: readonly FollowedTask[],
  next: FollowedTask,
  now: number,
): readonly FollowedTask[] {
  return [...followed.filter((t) => t.key !== next.key && now - t.at < FOLLOW_MAX_MS), next];
}

export function followHostTask(t: Omit<FollowedTask, 'key' | 'at'>, now = Date.now()): void {
  const key = followKey(t);
  if (!key) return;
  list = withFollowed(list, { ...t, key, at: now }, now);
  changed();
}

/** Stop following one; returns it when it was followed (so its note is said once). */
export function endHostTask(key: string): FollowedTask | null {
  const t = list.find((x) => x.key === key) ?? null;
  if (!t) return null;
  list = list.filter((x) => x.key !== key);
  changed();
  return t;
}

export function hostTasksSnapshot(): readonly FollowedTask[] {
  return list;
}

export function subscribeHostTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only: forget everything. */
export function resetHostTasks(): void {
  list = [];
  changed();
}
