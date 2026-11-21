import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PushPayload } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { silentLogger } from '../services';
import { buildFcmMessage, parseServiceAccount, sendFcm } from './fcm';
import type { PushDevice } from './types';

/** A throwaway RSA key so `sendFcm`'s JWT signing step succeeds without a real Google credential. */
const TEST_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

const payload: PushPayload = {
  burrow: 'burrow-hq',
  notificationId: 'notification_1',
  kind: 'mention',
  title: 'Dusty mentioned you',
  body: 'Can you take a look?',
  path: '/burrow-hq/c/billing-v2',
};

describe('buildFcmMessage', () => {
  it('is a data-only message carrying the full payload and the deep link', () => {
    const message = buildFcmMessage(payload, 'device-token');
    expect(message.message.token).toBe('device-token');
    expect(message.message.data.title).toBe('Dusty mentioned you');
    expect(message.message.data.path).toBe('/burrow-hq/c/billing-v2');
    expect(JSON.parse(message.message.data.payload)).toEqual(payload);
    expect(message.message.android.priority).toBe('high');
  });

  it('sets a collapse key per live activity so rapid updates of one run coalesce', () => {
    const activity = {
      kind: 'run' as const,
      runId: 'run_1',
      number: 1,
      burrowId: 'burrow_1',
      agentId: 'prn_1',
      agentName: 'Dusty',
      title: 'Fix invoices',
      branch: 'feat/x',
      progress: 50,
      currentStep: null,
      testsPassed: null,
      testsTotal: null,
      state: 'live' as const,
    };
    const liveActivityPayload: PushPayload = {
      ...payload,
      kind: 'run_progress',
      liveActivity: {
        event: 'update',
        activity,
        display: {
          key: 'run:run_1',
          kind: 'run',
          number: 1,
          label: 'RUN · LIVE',
          tone: 'ok',
          title: 'Fix invoices',
          text: 'Dusty · Working',
          progress: 50,
          segments: 1,
          chip: '50%',
          ongoing: true,
          actions: ['open_run'],
        },
      },
    };
    const message = buildFcmMessage(liveActivityPayload, 'device-token');
    expect(message.message.android.collapseKey).toBe('run:run_1');
    const { display } = liveActivityPayload.liveActivity ?? {};
    if (!display) throw new Error('display');
    const other = buildFcmMessage(
      {
        ...liveActivityPayload,
        liveActivity: { event: 'update', display, activity: { ...activity, runId: 'run_2' } },
      },
      'device-token',
    );
    expect(other.message.android.collapseKey).toBe('run:run_2');
    expect(buildFcmMessage(payload, 'device-token').message.android.collapseKey).toBeUndefined();
  });
});

describe('parseServiceAccount', () => {
  it('accepts a well-formed Google service account key', () => {
    const json = JSON.stringify({
      client_email: 'push@whombat.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
      project_id: 'whombat-prod',
    });
    expect(parseServiceAccount(json)).toEqual({
      client_email: 'push@whombat.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
      project_id: 'whombat-prod',
    });
  });

  it('rejects invalid JSON and JSON missing required fields', () => {
    expect(parseServiceAccount('not json')).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ client_email: 'a@b.com' }))).toBeNull();
  });
});

describe('sendFcm', () => {
  const device: PushDevice = { id: 'device_1', provider: 'fcm', token: 'tok', webPush: null };

  it('skips (without throwing) when FCM_SERVICE_ACCOUNT_JSON is unset', async () => {
    const config = loadConfig({});
    const outcome = await sendFcm(config, silentLogger, device, payload);
    expect(outcome).toBe('skipped');
  });

  it('skips when the JSON is not a valid service account key', async () => {
    const config = loadConfig({ FCM_SERVICE_ACCOUNT_JSON: '{"nope":true}' });
    const outcome = await sendFcm(config, silentLogger, device, payload);
    expect(outcome).toBe('skipped');
  });

  it('development: posts the FCM message to FCM_RELAY_URL instead of Google', async () => {
    const received: unknown[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const config = loadConfig({ FCM_RELAY_URL: `http://127.0.0.1:${port}/fcm` });
      expect(await sendFcm(config, silentLogger, device, payload)).toBe('sent');
      expect(received).toEqual([buildFcmMessage(payload, 'tok')]);
    } finally {
      server.close();
    }
    const unreachable = loadConfig({ FCM_RELAY_URL: `http://127.0.0.1:${port}/fcm` });
    expect(await sendFcm(unreachable, silentLogger, device, payload)).toBe('failed');
    expect(() => loadConfig({ NODE_ENV: 'production', FCM_RELAY_URL: 'http://127.0.0.1:1/fcm' })).toThrow(
      /FCM_RELAY_URL/,
    );
  });

  it('prunes the device when Google reports the token as gone', async () => {
    const config = loadConfig({
      FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'push@whombat.iam.gserviceaccount.com',
        private_key: TEST_PRIVATE_KEY,
        project_id: 'whombat-prod',
      }),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'a-token', expires_in: 3600 }), { status: 200 });
      }
      return new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', {
        status: 404,
      });
    });
    try {
      const outcome = await sendFcm(config, silentLogger, device, payload);
      expect(outcome).toBe('prune');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
