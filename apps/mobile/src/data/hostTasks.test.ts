/** Followed server work (proxmox-mobile.md AP-1490): which frame ends which task, and a day's memory. */
import { followWords } from '@whombat/client/hosts/mobile';
import { afterEach, describe, expect, it } from 'vitest';
import {
  endHostTask,
  FOLLOW_MAX_MS,
  type FollowedTask,
  followHostTask,
  followKey,
  frameMatch,
  hostTasksSnapshot,
  resetHostTasks,
  subscribeHostTasks,
  withFollowed,
} from './hostTasks';

const words = followWords('backup.create', 'web');
const task = (over: Partial<FollowedTask>): FollowedTask => ({
  key: 'task:UPID:1',
  serverId: 'pve-02',
  taskId: 'UPID:1',
  words,
  at: 0,
  ...over,
});

afterEach(() => resetHostTasks());

describe('following server work', () => {
  it('matches a frame by its task or action on the same server', () => {
    const list = [task({}), task({ key: 'action:act_9', taskId: undefined, actionId: 'act_9', quiet: true })];
    expect(frameMatch(list, { serverId: 'pve-02', taskId: 'UPID:1' })?.key).toBe('task:UPID:1');
    expect(frameMatch(list, { serverId: 'pve-02', actionId: 'act_9' })?.key).toBe('action:act_9');
    expect(frameMatch(list, { serverId: 'pve-01', taskId: 'UPID:1' })).toBeNull();
    expect(frameMatch(list, { serverId: 'pve-02' })).toBeNull();
  });

  it('keeps one entry per task and forgets those older than a day', () => {
    const old = task({ key: 'task:old', taskId: 'old', at: 0 });
    const next = withFollowed([old, task({ at: 5 })], task({ at: 10 }), FOLLOW_MAX_MS + 1);
    expect(next.map((t) => [t.key, t.at])).toEqual([['task:UPID:1', 10]]);
    expect(followKey({})).toBeNull();
  });

  it('says how it ended once: the second end finds nothing', () => {
    let calls = 0;
    const off = subscribeHostTasks(() => {
      calls++;
    });
    followHostTask({ serverId: 'pve-02', taskId: 'UPID:7', words }, 1000);
    expect(hostTasksSnapshot().map((t) => t.key)).toEqual(['task:UPID:7']);
    expect(endHostTask('task:UPID:7')?.words.done).toBe('The backup of web is done.');
    expect(endHostTask('task:UPID:7')).toBeNull();
    expect(calls).toBe(2);
    off();
  });
});
