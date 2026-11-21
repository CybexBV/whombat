/**
 * The runner's chatty routes (long-poll claim, heartbeats, progress) stay out of the request log at `info`,
 * so journald and whombat.log aren't flooded with a line per poll; their errors are still logged, and every
 * other route keeps its request lines.
 */
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { MemoryMailer } from '../mail/mailer';
import { createServices, type Services } from '../services';
import { useTestDb } from '../test/db';
import { testLogger } from '../test/log';

const testDb = useTestDb();
const AUTH = { authorization: 'Bearer dev-runner-token' };
let services: Services;
let app: FastifyInstance;
let lines: { level: number; msg?: string; req?: { url?: string }; reqId?: string }[] = [];

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL: testDb.url, NODE_ENV: 'test', LOG_LEVEL: 'info' });
  services = createServices({ config, sql: testDb.sql, mailer: new MemoryMailer(), log: testLogger() });
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split('\n')) if (line.trim()) lines.push(JSON.parse(line));
      done();
    },
  });
  app = await buildApp({ services, logger: { level: 'info', stream } });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  services?.typing.close();
});

/** Log lines of the one request to `url` (Fastify tags the incoming line with the URL, the rest by reqId). */
function linesFor(url: string) {
  const ids = new Set(lines.filter((l) => l.req?.url === url).map((l) => l.reqId));
  return lines.filter((l) => l.reqId && ids.has(l.reqId));
}

describe('runner route log levels', () => {
  it('does not log the long-poll claim, heartbeats or progress at info', async () => {
    lines = [];
    const claim = await app.inject({
      method: 'POST',
      url: '/internal/runner/claim',
      headers: AUTH,
      payload: { runnerId: 'rnr_quiet', providers: ['claude'], waitMs: 0 },
    });
    expect(claim.statusCode).toBe(200);
    const heartbeat = await app.inject({
      method: 'POST',
      url: '/internal/runner/heartbeat',
      headers: AUTH,
      payload: { runnerId: 'rnr_quiet', active: [] },
    });
    expect(heartbeat.statusCode).toBe(200);
    const progress = await app.inject({
      method: 'POST',
      url: '/internal/runner/dispatches/dsp_missing/progress',
      headers: AUTH,
      payload: { state: 'running' },
    });
    expect(progress.statusCode).toBeLessThan(500);
    expect(lines.filter((l) => l.req?.url?.startsWith('/internal/runner/'))).toEqual([]);
    expect(lines.filter((l) => l.msg === 'request completed')).toEqual([]);

    // Other routes still log their requests.
    await app.inject({ method: 'GET', url: '/api/v1/auth/options' });
    expect(linesFor('/api/v1/auth/options').map((l) => l.msg)).toContain('request completed');
  });

  it('still logs a runner route’s errors', async () => {
    lines = [];
    const spy = vi.spyOn(services.runtime, 'heartbeat').mockRejectedValueOnce(new Error('boom'));
    const res = await app.inject({
      method: 'POST',
      url: '/internal/runner/heartbeat',
      headers: AUTH,
      payload: { runnerId: 'rnr_quiet', active: [] },
    });
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    const errors = lines.filter((l) => l.level >= 50);
    expect(errors.map((l) => l.msg)).toContain('unhandled error');
  });
});
