/**
 * A `TaskStore` in memory for the follow-up's unit tests (`follow.ts`): what the database store keeps, without the card,
 * Done recently and the wake — `told` lists every end as the database store would have told it.
 */
import type { TaskCardState } from '@whombat/core';
import type { FollowedTask, NewFollowedTask, TaskEnd, TaskStore } from '../follow';

export interface MemoryTask extends FollowedTask {
  state: TaskCardState;
  checkedAt: number | null;
  endedAt: number | null;
  approvalId: string | null;
}

export interface MemoryTaskStore extends TaskStore {
  readonly rows: Map<string, MemoryTask>;
  /** Every end told, in order. */
  readonly told: { task: FollowedTask; end: TaskEnd }[];
  /** The running ones. */
  running_(): MemoryTask[];
}

export function memoryTaskStore(): MemoryTaskStore {
  const rows = new Map<string, MemoryTask>();
  const told: { task: FollowedTask; end: TaskEnd }[] = [];
  let n = 0;
  const find = (serverId: string, taskId: string) =>
    [...rows.values()].find((r) => r.serverId === serverId && r.taskId === taskId) ?? null;
  return {
    rows,
    told,
    running_: () => [...rows.values()].filter((r) => r.state === 'running'),
    async start(task: NewFollowedTask, at: number) {
      if (find(task.serverId, task.taskId)) return null;
      const { change: _change, approvalId, ...rest } = task;
      const row: MemoryTask = {
        ...rest,
        id: `ftk_t${++n}`,
        at,
        state: 'running',
        checkedAt: null,
        endedAt: null,
        approvalId: approvalId ?? null,
      };
      rows.set(row.id, row);
      return row;
    },
    async running(serverId, taskId) {
      const row = find(serverId, taskId);
      return row?.state === 'running' ? row : null;
    },
    async toAsk(filter, at) {
      const out = [...rows.values()].filter(
        (r) =>
          r.state === 'running' &&
          (!filter ||
            (r.at < filter.startedBefore && (r.checkedAt === null || r.checkedAt < filter.checkedBefore))),
      );
      for (const r of out) r.checkedAt = at;
      return out;
    },
    async end(task, end) {
      const row = rows.get(task.id);
      if (row?.state !== 'running') return false;
      row.state = end.state;
      row.endedAt = end.endedAt;
      told.push({ task: row, end });
      return true;
    },
    async sweep(before) {
      for (const [id, r] of rows) if (r.state !== 'running' && (r.endedAt ?? 0) < before) rows.delete(id);
    },
  };
}
