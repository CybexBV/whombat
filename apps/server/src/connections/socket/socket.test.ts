/**
 * The socket transport against in-process fakes (docs/decisions/connections-more.md CM-13…CM-16): the socket under the
 * destination policy (pinned addresses, a pinned certificate), the two dialects (TrueNAS's JSON-RPC, ESPHome's Device
 * Builder), signing in as the spec says, streams bounded by their seconds, one socket per call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { OutboundError } from '../../lib/outbound';
import { SocketUpgradeRefused } from './channel';
import { SocketProtocolError, SocketSignInRefused } from './dialect';
import { runOnSocket, type SocketTarget } from './run';
import { fillLoginParams, type SocketSpec } from './spec';
import {
  behind,
  FAKE_CERT_SHA256,
  type FakeSocketServer,
  fakeDeviceBuilder,
  fakeHomePolicy,
  fakeTrueNas,
} from './testing';

const KEY = '1-tRuEnAsApIkEy0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP';

const TRUENAS: SocketSpec = {
  dialect: 'jsonrpc',
  path: '/api/current',
  login: { method: 'auth.login_with_api_key', params: ['{secret}'], when: 'always' },
  reads: ['.*\\.query', 'system\\.info'],
  streams: [],
  refused: ['auth\\..*', 'core\\.subscribe'],
  missing: 'This TrueNAS is older than 25.04: update it, then connect it.',
};

const ESPHOME: SocketSpec = {
  dialect: 'esphome',
  path: '/ws',
  login: { method: 'auth/login', params: { username: '{username}', password: '{secret}' }, when: 'asked' },
  reads: ['config/version', 'devices/list', 'devices/logs', 'devices/validate'],
  streams: ['devices/logs', 'devices/validate'],
  refused: ['auth/login', 'auth'],
  missing: 'This ESPHome dashboard is too old: update ESPHome, then connect it.',
};

let fake: FakeSocketServer | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

function target(spec: SocketSpec, server: FakeSocketServer, extra: Partial<SocketTarget> = {}): SocketTarget {
  return {
    spec,
    baseUrl: behind(server, 'box.home.test'),
    login: null,
    policy: fakeHomePolicy('box.home.test', '192.168.90.20'),
    deadlineMs: 3000,
    ...extra,
  };
}

/** Waits until the fake has no socket open (the client closed its one). */
async function allClosed(server: FakeSocketServer): Promise<void> {
  for (let i = 0; i < 100 && server.open() > 0; i++) await new Promise((r) => setTimeout(r, 10));
  expect(server.open()).toBe(0);
}

describe('TrueNAS over JSON-RPC (CM-05, CM-13)', () => {
  it('signs in with the key on a pinned https socket, skips notifications and closes the socket', async () => {
    fake = await fakeTrueNas({ apiKey: KEY, tls: true });
    const out = await runOnSocket(
      target(TRUENAS, fake, {
        login: { secret: KEY, fields: {} },
        policy: fakeHomePolicy('box.home.test', '192.168.90.20', { pinnedCertSha256: FAKE_CERT_SHA256 }),
      }),
      { method: 'system.info' },
    );
    expect(out.reply).toMatchObject({ ok: true, result: { version: 'TrueNAS-25.10.1' }, stopped: false });
    expect(fake.received.map((m) => [m.method, m.params])).toEqual([
      ['auth.login_with_api_key', [KEY]],
      ['system.info', []],
    ]);
    expect(fake.received[1]).toMatchObject({ jsonrpc: '2.0', id: 2 });
    expect(fake.connections).toBe(1);
    await allClosed(fake);
  });

  it('refuses a key TrueNAS doesn’t take, and says an older TrueNAS has no socket', async () => {
    fake = await fakeTrueNas({ apiKey: KEY });
    await expect(
      runOnSocket(target(TRUENAS, fake, { login: { secret: 'wrong', fields: {} } }), {
        method: 'system.info',
      }),
    ).rejects.toBeInstanceOf(SocketSignInRefused);
    expect(fake.received.map((m) => m.method)).toEqual(['auth.login_with_api_key']);
    await fake.close();

    fake = await fakeTrueNas({ apiKey: KEY, missing: true });
    const err = await runOnSocket(target(TRUENAS, fake, { login: { secret: KEY, fields: {} } }), {
      method: 'system.info',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocketUpgradeRefused);
    expect((err as SocketUpgradeRefused).status).toBe(404);
  });

  it('answers the service’s error without its trace', async () => {
    fake = await fakeTrueNas({ apiKey: KEY });
    const out = await runOnSocket(target(TRUENAS, fake, { login: { secret: KEY, fields: {} } }), {
      method: 'pool.nothing',
      params: [],
    });
    expect(out.reply.ok).toBe(false);
    if (out.reply.ok) return;
    expect(out.reply.code).toBe('-32601');
    expect(out.reply.error).toMatchObject({ code: -32601, data: { errname: 'ENOMETHOD' } });
    expect(JSON.stringify(out.reply.error)).not.toContain('Traceback');
  });

  it('stays under the policy: another address, an unpinned self-signed certificate, a wrong pin', async () => {
    fake = await fakeTrueNas({ apiKey: KEY, tls: true });
    const login = { secret: KEY, fields: {} };
    const elsewhere = await runOnSocket(
      target(TRUENAS, fake, {
        login,
        policy: fakeHomePolicy('box.home.test', '192.168.90.20', {
          resolve: async () => [{ address: '192.168.91.5', family: 4 }],
        }),
      }),
      { method: 'system.info' },
    ).catch((e: unknown) => e);
    expect(elsewhere).toBeInstanceOf(OutboundError);
    expect((elsewhere as OutboundError).reason).toBe('destination');

    const unpinned = await runOnSocket(target(TRUENAS, fake, { login }), { method: 'system.info' }).catch(
      (e: unknown) => e,
    );
    expect((unpinned as OutboundError).reason).toBe('untrusted_certificate');

    const wrongPin = await runOnSocket(
      target(TRUENAS, fake, {
        login,
        policy: fakeHomePolicy('box.home.test', '192.168.90.20', { pinnedCertSha256: 'AB'.repeat(32) }),
      }),
      { method: 'system.info' },
    ).catch((e: unknown) => e);
    expect((wrongPin as OutboundError).reason).toBe('certificate');
    // Nothing reached the server: not the key, not a method.
    expect(fake.received).toEqual([]);
  });

  it('gives up at the call’s deadline when nothing answers', async () => {
    fake = await fakeTrueNas({ apiKey: KEY, methods: { 'core.hang': () => new Promise(() => {}) } });
    const started = Date.now();
    const err = await runOnSocket(
      target(TRUENAS, fake, { login: { secret: KEY, fields: {} }, deadlineMs: 300 }),
      { method: 'core.hang' },
    ).catch((e: unknown) => e);
    expect((err as OutboundError).reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    await allClosed(fake);
  });
});

describe('ESPHome’s Device Builder (CM-07, CM-13, CM-14)', () => {
  it('reads the server info, signs in only when it asks, and skips others’ broadcasts', async () => {
    fake = await fakeDeviceBuilder();
    const open = await runOnSocket(target(ESPHOME, fake), { method: 'devices/list' });
    expect(open.hello).toEqual({ version: '2026.6.5', asksSignIn: false });
    expect(open.reply).toMatchObject({ ok: true, result: { configured: [{ name: 'porch' }] } });
    expect(fake.received.map((m) => m.command)).toEqual(['devices/list']);
    expect(fake.received[0]).toMatchObject({ message_id: '1', args: {} });
    await fake.close();

    fake = await fakeDeviceBuilder({ login: { username: 'admin', password: 'hunter22' } });
    const out = await runOnSocket(
      target(ESPHOME, fake, { login: { secret: 'hunter22', fields: { username: 'admin' } } }),
      { method: 'config/version' },
    );
    expect(out.reply).toMatchObject({ ok: true, result: { version: '2026.6.5' } });
    expect(out.learned).toEqual(['builder-session-token-0f3e']);
    expect(fake.received[0]).toMatchObject({
      command: 'auth/login',
      args: { username: 'admin', password: 'hunter22' },
    });
  });

  it('refuses a wrong password, a paused sign-in and a Builder that asks for one this connection lacks', async () => {
    fake = await fakeDeviceBuilder({ login: { username: 'admin', password: 'hunter22' } });
    const wrong = await runOnSocket(
      target(ESPHOME, fake, { login: { secret: 'nope', fields: { username: 'admin' } } }),
      { method: 'devices/list' },
    ).catch((e: unknown) => e);
    expect((wrong as SocketSignInRefused).reason).toBe('refused');
    const none = await runOnSocket(target(ESPHOME, fake), { method: 'devices/list' }).catch(
      (e: unknown) => e,
    );
    expect((none as SocketSignInRefused).reason).toBe('needed');
    // Only the one wrong password was sent; nothing after it.
    expect(fake.received.map((m) => m.command)).toEqual(['auth/login']);
    await fake.close();

    fake = await fakeDeviceBuilder({ login: { username: 'admin', password: 'hunter22' }, rateLimited: true });
    const locked = await runOnSocket(
      target(ESPHOME, fake, { login: { secret: 'hunter22', fields: { username: 'admin' } } }),
      { method: 'devices/list' },
    ).catch((e: unknown) => e);
    expect((locked as SocketSignInRefused).reason).toBe('locked');
  });

  it('collects a stream’s output until its result, or until its seconds are up', async () => {
    fake = await fakeDeviceBuilder();
    const validated = await runOnSocket(target(ESPHOME, fake), {
      method: 'devices/validate',
      params: { configuration: 'porch.yaml' },
      streamSeconds: 5,
    });
    expect(validated.reply).toMatchObject({ ok: true, result: { success: true, code: 0 }, stopped: false });
    if (!validated.reply.ok) return;
    expect(validated.reply.output.join('')).toContain('Configuration is valid');

    const logs = await runOnSocket(target(ESPHOME, fake), {
      method: 'devices/logs',
      params: { configuration: 'porch.yaml', port: 'OTA' },
      streamSeconds: 0.15,
    });
    expect(logs.reply).toMatchObject({ ok: true, result: null, stopped: true });
    if (!logs.reply.ok) return;
    expect(logs.reply.output.length).toBeGreaterThan(1);
    expect(logs.reply.output[0]).toContain('porch temperature');
    await allClosed(fake);
  });

  it('says an older dashboard isn’t the Builder', async () => {
    fake = await fakeDeviceBuilder({ noServerInfo: true });
    const err = await runOnSocket(target(ESPHOME, fake), { method: 'devices/list' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocketProtocolError);
    expect((err as SocketProtocolError).missing).toBe(true);
    await fake.close();

    fake = await fakeDeviceBuilder({ missing: true });
    const none = await runOnSocket(target(ESPHOME, fake), { method: 'devices/list' }).catch(
      (e: unknown) => e,
    );
    expect((none as SocketUpgradeRefused).status).toBe(404);
  });
});

describe('spec helpers (CM-13)', () => {
  it('fills the login’s templates inside strings, and says when a value is missing', () => {
    const values = { secret: 's3cr3t', fields: { username: 'admin' } };
    expect(fillLoginParams(['{secret}'], values)).toEqual(['s3cr3t']);
    expect(fillLoginParams({ username: '{username}', password: '{secret}', keep: 1 }, values)).toEqual({
      username: 'admin',
      password: 's3cr3t',
      keep: 1,
    });
    expect(fillLoginParams({ username: '{username}' }, { secret: 'x', fields: {} })).toBeNull();
  });
});
