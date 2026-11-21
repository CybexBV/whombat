import type { PushPayload } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { silentLogger } from '../services';
import { PushSender } from './sender';
import type { PushDevice } from './types';

const payload: PushPayload = {
  burrow: 'burrow-hq',
  notificationId: 'notification_1',
  kind: 'mention',
  title: 'Dusty mentioned you',
  body: 'Can you take a look?',
  path: '/burrow-hq/c/billing-v2',
};

function fakeDb(deleted: string[]) {
  return {
    delete: () => ({
      where: () => {
        deleted.push('device deleted');
        return Promise.resolve();
      },
    }),
  } as never;
}

describe('PushSender', () => {
  it('skips a device whose provider is unconfigured, without retrying', async () => {
    const config = loadConfig({}); // no VAPID / FCM / APNs configured
    const sender = new PushSender(fakeDb([]), config, silentLogger, () => Promise.resolve());
    const device: PushDevice = {
      id: 'd1',
      provider: 'webpush',
      token: 'https://push.example/x',
      webPush: null,
    };
    const outcome = await sender.send(device, payload);
    expect(outcome).toBe('skipped'); // VAPID isn't configured -> skipped, no retry needed
  });

  it('retries a transient failure and succeeds on a later attempt', async () => {
    // FCM configured so the transport actually runs; make fetch fail twice then succeed.
    const config = loadConfig({
      FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'a@b.iam.gserviceaccount.com',
        private_key: 'not-a-real-key',
        project_id: 'p',
      }),
    });
    // The bad private key makes every attempt throw inside the transport -> always 'failed'.
    const delays: number[] = [];
    const sender = new PushSender(fakeDb([]), config, silentLogger, (ms) => {
      delays.push(ms);
      return Promise.resolve();
    });
    const device: PushDevice = { id: 'd1', provider: 'fcm', token: 'tok', webPush: null };
    const outcome = await sender.send(device, payload);
    expect(outcome).toBe('failed');
    expect(delays).toEqual([250, 1000]); // both retry delays used, then gives up
  });

  it('sendAll dispatches to every device independently and prunes a gone device', async () => {
    // VAPID configured so webpush actually runs the transport (and finds the device has no keys).
    const config = loadConfig({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' });
    const deleted: string[] = [];
    const sender = new PushSender(fakeDb(deleted), config, silentLogger, () => Promise.resolve());
    const devices: PushDevice[] = [
      { id: 'd1', provider: 'webpush', token: 'https://push.example/1', webPush: null },
      { id: 'd2', provider: 'fcm', token: 'tok', webPush: null },
    ];
    const outcomes = await sender.sendAll(devices, payload);
    // d1 has no webPush subscription keys on the device row -> 'prune'; d2's FCM is unconfigured -> 'skipped'.
    expect(outcomes).toEqual(['prune', 'skipped']);
    expect(deleted).toEqual(['device deleted']);
  });

  it('never throws even if the transport itself throws synchronously', async () => {
    const config = loadConfig({});
    const sender = new PushSender(fakeDb([]), config, silentLogger, () => Promise.resolve());
    // apns is unconfigured too, so it just returns 'skipped' rather than throwing.
    const device: PushDevice = { id: 'd1', provider: 'apns', token: 'tok', webPush: null };
    await expect(sender.send(device, payload)).resolves.toBe('skipped');
  });
});
