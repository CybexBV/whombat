/** What a push service's “this token is gone” removes: a live activity's token alone, never the phone behind it. */
import type { PushPayload } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { devices, liveActivities } from '../db/schema/index';
import { silentLogger } from '../services';
import { PushSender } from './sender';
import type { PushDevice } from './types';

vi.mock('./apns', () => ({ sendApns: async () => 'prune' }));

const payload: PushPayload = {
  burrow: 'burrow-hq',
  notificationId: null,
  kind: 'agent_update',
  title: 'Run',
  body: 'Done',
  path: '/burrow-hq/runs/run_1',
};

/** Records which table each delete and update touched. */
function recordingDb(seen: string[]) {
  const name = (table: unknown) =>
    table === devices ? 'devices' : table === liveActivities ? 'live_activities' : 'other';
  return {
    delete: (table: unknown) => ({
      where: () => {
        seen.push(`delete ${name(table)}`);
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: () => {
          seen.push(`update ${name(table)}`);
          return Promise.resolve();
        },
      }),
    }),
  } as never;
}

describe('PushSender pruning', () => {
  const config = loadConfig({});

  it('removes a dead activity update token, not the iPhone', async () => {
    const seen: string[] = [];
    const sender = new PushSender(recordingDb(seen), config, silentLogger, () => Promise.resolve());
    const target: PushDevice = {
      id: 'dev_1',
      provider: 'apns',
      token: 'activity-token',
      webPush: null,
      liveActivity: { kind: 'run', refId: 'run_1' },
    };
    expect(await sender.send(target, payload)).toBe('prune');
    expect(seen).toEqual(['delete live_activities']);
  });

  it('forgets a dead push-to-start token, not the iPhone', async () => {
    const seen: string[] = [];
    const sender = new PushSender(recordingDb(seen), config, silentLogger, () => Promise.resolve());
    const target: PushDevice = {
      id: 'dev_1',
      provider: 'apns',
      token: 'start-token',
      webPush: null,
      apnsPushToStart: true,
      liveActivity: { kind: 'approval', refId: 'approval_1' },
    };
    expect(await sender.send(target, payload)).toBe('prune');
    expect(seen).toEqual(['update devices']);
  });

  it('removes the device when its own token is gone', async () => {
    const seen: string[] = [];
    const sender = new PushSender(recordingDb(seen), config, silentLogger, () => Promise.resolve());
    const target: PushDevice = { id: 'dev_1', provider: 'apns', token: 'alert-token', webPush: null };
    expect(await sender.send(target, payload)).toBe('prune');
    expect(seen).toEqual(['delete devices']);
  });
});
