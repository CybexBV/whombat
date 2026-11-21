import { createECDH, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PushPayload } from '@whombat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { silentLogger } from '../services';
import type { PushDevice } from './types';
import { sendWebPush, webPush } from './webpush';

const payload: PushPayload = {
  burrow: 'burrow-hq',
  notificationId: 'notification_1',
  kind: 'needs_you',
  title: 'Dusty is asking',
  body: 'Deploy feat/invoice-pdf to staging?',
  path: '/burrow-hq/log?approval=12',
};

const { publicKey, privateKey } = webPush.generateVAPIDKeys();

/** A real P-256 subscription key pair (uncompressed point) so payload encryption doesn't reject it. */
const subscriptionEcdh = createECDH('prime256v1');
subscriptionEcdh.generateKeys();
const p256dh = subscriptionEcdh.getPublicKey('base64url');
const auth = randomBytes(16).toString('base64url');

describe('sendWebPush', () => {
  let server: Server;
  let status = 201;
  let received: { url: string; headers: Record<string, string | string[] | undefined>; body: string } | null =
    null;
  let requests = 0;
  /** The mock push service is on 127.0.0.1 over plain HTTP: only reachable with the test-only flag. */
  const MOCK = { WHOMBAT_OUTBOUND_ALLOW_PRIVATE: 'true' };

  beforeEach(async () => {
    received = null;
    requests = 0;
    server = createServer((req, res) => {
      requests += 1;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received = {
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(status, status >= 300 && status < 400 ? { location: '/elsewhere' } : {});
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function device(): PushDevice {
    const { port } = server.address() as AddressInfo;
    return {
      id: 'device_1',
      provider: 'webpush',
      token: `http://127.0.0.1:${port}/push/abc`,
      webPush: { p256dh, auth },
    };
  }

  it('skips when VAPID keys are not configured', async () => {
    const config = loadConfig({});
    const outcome = await sendWebPush(config, silentLogger, device(), payload);
    expect(outcome).toBe('skipped');
  });

  it('prunes a device with no subscription keys', async () => {
    const config = loadConfig({ ...MOCK, VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey });
    const outcome = await sendWebPush(config, silentLogger, { ...device(), webPush: null }, payload);
    expect(outcome).toBe('prune');
  });

  it('sends an encrypted, VAPID-authenticated request to the endpoint over plain HTTP (test mock)', async () => {
    status = 201;
    const config = loadConfig({ ...MOCK, VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey });
    const outcome = await sendWebPush(config, silentLogger, device(), payload);
    expect(outcome).toBe('sent');
    expect(received).not.toBeNull();
    expect(received?.url).toBe('/push/abc');
    expect(received?.headers.authorization).toMatch(/^vapid /);
    // The payload is AES-GCM encrypted; it must not contain the plaintext body or title.
    expect(received?.body).not.toContain(payload.body);
    expect(received?.body.length).toBeGreaterThan(0);
  });

  it('prunes the device when the push service reports the subscription is gone (410)', async () => {
    status = 410;
    const config = loadConfig({ ...MOCK, VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey });
    const outcome = await sendWebPush(config, silentLogger, device(), payload);
    expect(outcome).toBe('prune');
  });

  it('reports failed on other error statuses without pruning', async () => {
    status = 500;
    const config = loadConfig({ ...MOCK, VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey });
    const outcome = await sendWebPush(config, silentLogger, device(), payload);
    expect(outcome).toBe('failed');
  });

  it('never dials an endpoint that is not a push service (SSRF), and prunes the device', async () => {
    const config = loadConfig({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey });
    const outcome = await sendWebPush(config, silentLogger, device(), payload);
    expect(outcome).toBe('prune');
    expect(requests).toBe(0);
    for (const token of ['https://169.254.169.254/latest/meta-data/', 'https://internal.corp.example/hook']) {
      expect(await sendWebPush(config, silentLogger, { ...device(), token }, payload)).toBe('prune');
    }
  });

  it('does not follow redirects', async () => {
    status = 307;
    const config = loadConfig({ ...MOCK, VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey });
    const outcome = await sendWebPush(config, silentLogger, device(), payload);
    expect(outcome).toBe('failed');
    expect(requests).toBe(1);
  });
});
