/**
 * Says how followed server work ended (Whombat proxmox.md PX-05; proxmox-mobile.md AP-1490): while anything is
 * followed (`data/hostTasks.ts`) it listens to the `hosts` topic for the `hosts.task` frame and reads each task every
 * 3 seconds as well (a frame can be missed while the phone sleeps); the first to know ends it with one short note.
 * Mounted once, beside the navigator, so the note comes on whatever screen the person is on.
 */
import { followEndText, taskPlatform, taskResult } from '@whombat/client/hosts/mobile';
import { useHostsLive, useHostTask, useRefreshHosts } from '@whombat/client/hosts/react';
import { useRealtimeEvent } from '@whombat/client/react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useBurrowBase } from '../data/BurrowProvider';
import {
  endHostTask,
  type FollowedTask,
  frameMatch,
  hostTasksSnapshot,
  subscribeHostTasks,
} from '../data/hostTasks';
import { showFailure, showNotice } from './feedback';

/** A task whose read keeps failing (gone, or never readable) is dropped quietly after this many tries. */
const MAX_READ_ERRORS = 5;

function useFinish() {
  const refresh = useRefreshHosts();
  return useCallback(
    (t: FollowedTask, result: 'ok' | 'warning' | 'error', message?: string | null) => {
      if (!endHostTask(t.key)) return;
      refresh();
      if (t.quiet && result === 'ok') return;
      const text = followEndText(t.words, result, message);
      if (result === 'error') showFailure(text);
      else showNotice(text);
    },
    [refresh],
  );
}

export function HostTasksBridge() {
  const { currentBootstrap } = useBurrowBase();
  const followed = useSyncExternalStore(subscribeHostTasks, hostTasksSnapshot, hostTasksSnapshot);
  const finish = useFinish();
  useHostsLive(followed.length ? currentBootstrap().burrow.id : null);
  useRealtimeEvent('hosts.task', (e) => {
    const t = frameMatch(hostTasksSnapshot(), e);
    if (t) finish(t, e.result, e.message);
  });
  return (
    <>
      {followed
        .filter((t) => t.taskId)
        .map((t) => (
          <TaskPoll key={t.key} task={t} onEnd={finish} />
        ))}
    </>
  );
}

function TaskPoll({ task, onEnd }: { task: FollowedTask; onEnd: ReturnType<typeof useFinish> }) {
  const { slug } = useBurrowBase();
  const q = useHostTask(
    {
      params: { burrow: slug, serverId: task.serverId, taskId: task.taskId ?? '' },
      query: { platform: task.platform ?? taskPlatform(task.taskId ?? '') },
    },
    { refetchInterval: 3000, retry: false },
  );
  const result = taskResult(q.data);
  const message = q.data?.message;
  useEffect(() => {
    if (result) onEnd(task, result, message);
    else if (q.errorUpdateCount >= MAX_READ_ERRORS) endHostTask(task.key);
  }, [result, message, q.errorUpdateCount, task, onEnd]);
  return null;
}
