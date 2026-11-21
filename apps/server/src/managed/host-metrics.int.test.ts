/**
 * How the box is doing over a session (docs/decisions/box-status.md BS-06): `host.metrics` for the person, asked of
 * the manager with the person's burrow's time zone and `since` passed through; `unavailable` when the manager is older
 * or doesn't answer, `not_managed` where no manager measures the box. And the manager socket client against a fake
 * manager on a unix socket: the contract both ways, a 404, a slow answer.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostMetricsRequest } from '@whombat/control-contracts/local';
import type { HostMetricsOutput } from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { burrows } from '../db/schema/index';
import { IDS, TEST_BURROW_ID, TEST_TZ } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { HOST_METRICS_TIMEOUT_MS, HostMetricsService } from './host-metrics';
import { ManagerSocketClient } from './manager-client';
import { sampleHostMetrics } from './testing';

const m = useManagedRuntime({ seed: true });
let owner: Awaited<ReturnType<typeof m.enroll>>;

type Out = { t: string; output?: HostMetricsOutput; code?: string; message?: string };

beforeAll(async () => {
  owner = await m.enroll(IDS.mara);
});

describe('host.metrics over a session (BS-06)', () => {
  it('gives the person the manager’s measurements, asked in the burrow’s zone with `since` passed through', async () => {
    const metrics = sampleHostMetrics({ range: 'day', timeZone: TEST_TZ });
    m.manager.onHostMetrics = async () => ({ v: 1, metrics });
    const before = m.manager.hostMetricsRequests.length;
    const client = await m.client(owner);
    const whole = (await client.request('host.metrics', { range: 'day' })) as Out;
    expect(whole).toMatchObject({ t: 'result', output: { metrics, reason: null } });
    const live = (await client.request('host.metrics', {
      range: 'hour',
      since: '2026-10-11T09:59:50Z',
    })) as Out;
    expect(live.t).toBe('result');
    const asked = m.manager.hostMetricsRequests.slice(before);
    expect(asked).toEqual([
      { v: 1, range: 'day', timeZone: TEST_TZ },
      { v: 1, range: 'hour', since: '2026-10-11T09:59:50Z', timeZone: TEST_TZ },
    ]);
    for (const request of asked) HostMetricsRequest.parse(request);
  });

  it('counts the days in the zone of the person’s burrow', async () => {
    m.manager.onHostMetrics = async (request) => ({
      v: 1,
      metrics: sampleHostMetrics({ timeZone: request.timeZone }),
    });
    await m.t.services.db
      .update(burrows)
      .set({ timeZone: 'Asia/Kolkata' })
      .where(eq(burrows.id, TEST_BURROW_ID));
    try {
      const answer = (await (await m.client(owner)).request('host.metrics', { range: 'hour' })) as Out;
      expect(answer.output?.metrics?.timeZone).toBe('Asia/Kolkata');
      expect(m.manager.hostMetricsRequests.at(-1)?.timeZone).toBe('Asia/Kolkata');
    } finally {
      await m.t.services.db.update(burrows).set({ timeZone: TEST_TZ }).where(eq(burrows.id, TEST_BURROW_ID));
    }
  });

  it('is unavailable from an older manager (404) or an answer the contract doesn’t allow', async () => {
    const client = await m.client(owner);
    m.manager.onHostMetrics = null;
    expect(await client.request('host.metrics', { range: 'month' })).toMatchObject({
      t: 'result',
      output: { metrics: null, reason: 'unavailable' },
    });
    m.manager.onHostMetrics = async () => ({ v: 1, metrics: { ...sampleHostMetrics(), now: null } });
    expect(await client.request('host.metrics', { range: 'month' })).toMatchObject({
      t: 'result',
      output: { metrics: null, reason: 'unavailable' },
    });
  });

  it('is not_managed where no manager measures the box', async () => {
    const host = m.runtime.dispatcher.host;
    m.runtime.dispatcher.host = undefined;
    try {
      expect(await (await m.client(owner)).request('host.metrics', { range: 'hour' })).toMatchObject({
        t: 'result',
        output: { metrics: null, reason: 'not_managed' },
      });
    } finally {
      m.runtime.dispatcher.host = host;
    }
  });

  it('refuses a range it doesn’t know', async () => {
    expect(await (await m.client(owner)).request('host.metrics', { range: 'year' })).toMatchObject({
      t: 'error',
      code: 'validation_failed',
    });
  });
});

describe('the manager socket’s host metrics (BS-06)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-host-'));
  const socket = join(dir, 'manager.sock');
  let server: Server;
  const seen: { path: string; body: unknown }[] = [];
  /** How the fake manager answers the next call. */
  let reply: { status: number; body: unknown; delayMs?: number } = { status: 200, body: {} };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
        const send = () => {
          if (res.destroyed) return;
          res.statusCode = reply.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(reply.body));
        };
        if (reply.delayMs) setTimeout(send, reply.delayMs).unref();
        else send();
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('speaks the contract both ways', async () => {
    const metrics = sampleHostMetrics({ range: 'month', points: 360, timeZone: TEST_TZ });
    reply = { status: 200, body: { v: 1, metrics } };
    const host = new HostMetricsService(m.t.services, new ManagerSocketClient(socket));
    expect(await host.read({ range: 'month', since: '2026-10-11T08:00:00Z' }, TEST_TZ)).toEqual({
      metrics,
      reason: null,
    });
    expect(seen.at(-1)).toEqual({
      path: '/v1/host/metrics',
      body: { v: 1, range: 'month', since: '2026-10-11T08:00:00Z', timeZone: TEST_TZ },
    });
  });

  it('is unavailable from an older manager (404), a wrong answer or a slow one', async () => {
    const host = new HostMetricsService(m.t.services, new ManagerSocketClient(socket));
    reply = { status: 404, body: { error: { code: 'not_found', message: 'no such path' } } };
    expect(await host.read({ range: 'hour' }, 'UTC')).toEqual({ metrics: null, reason: 'unavailable' });
    reply = { status: 200, body: { v: 1, metrics: { now: {} } } };
    expect(await host.read({ range: 'hour' }, 'UTC')).toEqual({ metrics: null, reason: 'unavailable' });
    reply = {
      status: 200,
      body: { v: 1, metrics: sampleHostMetrics() },
      delayMs: HOST_METRICS_TIMEOUT_MS + 1000,
    };
    const started = Date.now();
    expect(await host.read({ range: 'hour' }, 'UTC')).toEqual({ metrics: null, reason: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(HOST_METRICS_TIMEOUT_MS + 900);
  });

  it('is unavailable when nobody listens on the socket', async () => {
    const host = new HostMetricsService(m.t.services, new ManagerSocketClient(join(dir, 'gone.sock')));
    expect(await host.read({ range: 'hour' }, 'UTC')).toEqual({ metrics: null, reason: 'unavailable' });
  });
});
