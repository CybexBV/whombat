/** Web push endpoints are user-supplied URLs the server POSTs to: only push services are accepted (SSRF). */
import { describe, expect, it } from 'vitest';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { devicesForActivity } from './devices';

const t = useTestServer({ seed: true, app: true });
const webPush = { p256dh: 'BExamplePublicKey', auth: 'ExampleAuth' };

async function register(token: string) {
  const { cookie } = await sessionFor(t.services, IDS.mara);
  return t.api.inject({
    method: 'POST',
    url: '/api/v1/devices',
    headers: { cookie },
    payload: { platform: 'web', provider: 'webpush', token, webPush },
  });
}

describe('web push device registration', () => {
  it('refuses endpoints that are not a push service over https', async () => {
    for (const token of [
      'http://127.0.0.1:58025/api/v1/messages',
      'https://127.0.0.1/push',
      'http://169.254.169.254/latest/meta-data/',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/push',
      'https://10.0.0.5:8080/admin',
      'https://internal-admin.corp.example/hook',
      'https://fcm.googleapis.com.evil.example/fcm/send/x',
      'not a url',
    ]) {
      const res = await register(token);
      expect(res.statusCode, token).toBe(400);
    }
    const [row] = await t.services.sql`select count(*)::int as n from devices where provider = 'webpush'`;
    expect(row?.n).toBe(0);
  });

  it('accepts the browsers’ push services', async () => {
    for (const token of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://web.push.apple.com/QGxyz',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
    ]) {
      const res = await register(token);
      expect(res.statusCode, token).toBe(201);
    }
  });

  it('refuses moving a web push device to an internal endpoint', async () => {
    const created = await register('https://fcm.googleapis.com/fcm/send/move-me');
    expect(created.statusCode).toBe(201);
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const moved = await t.api.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${created.json().device.id}`,
      headers: { cookie },
      payload: { token: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(moved.statusCode).toBe(400);
  });
});

describe('live activity targets', () => {
  it('reach phones, never a browser', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const android = await t.api.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { cookie },
      payload: { platform: 'android', provider: 'fcm', token: 'fcm-live-activity' },
    });
    expect(android.statusCode, android.body).toBe(201);
    expect((await register('https://fcm.googleapis.com/fcm/send/live-activity')).statusCode).toBe(201);
    const targets = await devicesForActivity(t.services.db, 'run', 'run_live', [IDS.mara]);
    expect(targets.map((d) => d.provider)).toContain('fcm');
    expect(targets.some((d) => d.provider === 'webpush')).toBe(false);
  });
});
