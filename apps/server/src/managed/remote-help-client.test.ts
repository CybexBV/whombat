import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SupportCallError,
  SupportSocketClient,
  supportRefused,
  supportRoute,
  tolerantVisits,
} from './remote-help-client';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function listen(handler: RequestListener): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-support-'));
  const path = join(dir, 'api.sock');
  const server = createServer(handler);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return path;
}

const STATE = {
  v: 1,
  available: true,
  foreverAllowed: false,
  helpCodeRequired: true,
  environment: 'prod',
  hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHdob21iYXQtZmFrZS1zdXBwb3J0LWhvc3Qta2V5ISEh',
  grant: null,
  connected: [],
};

describe('the support socket’s client (RH-S02)', () => {
  it('asks each route with its method and body, and checks the answer against the contract', async () => {
    const seen: { method?: string; url?: string; body: string }[] = [];
    const path = await listen(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const p of req) parts.push(p);
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(parts).toString() });
      if (req.url?.startsWith('/v1/events')) res.end(JSON.stringify({ v: 1, events: [], next: 7 }));
      else if (req.url?.startsWith('/v1/visits')) res.end(JSON.stringify({ v: 1, visits: [] }));
      else res.end(JSON.stringify(STATE));
    });
    const client = new SupportSocketClient(path);
    expect(await client.state()).toEqual(STATE);
    const by = { accountId: 'acc_1', name: 'Mara' };
    await client.grant({ level: 'fix', duration: 'hour', grantedBy: by });
    await client.stop({ reason: 'desk' });
    await client.visits({ before: 'v_1', limit: 50 });
    expect(await client.events(3, 99)).toEqual({ v: 1, events: [], next: 7 });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /v1/state',
      'POST /v1/grant',
      'POST /v1/stop',
      'GET /v1/visits?before=v_1&limit=20',
      'GET /v1/events?after=3&waitS=25',
    ]);
    expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ v: 1, level: 'fix', duration: 'hour', grantedBy: by });
    expect(JSON.parse(seen[2]?.body ?? '')).toEqual({ v: 1, reason: 'desk' });
  });

  it('keeps the status and code of a refusal, never the words; an answer off the contract is invalid', async () => {
    let answer: [number, string] = [409, '{"error":{"code":"forever_not_allowed","message":"secret words"}}'];
    const path = await listen((_req, res) => res.writeHead(answer[0]).end(answer[1]));
    const client = new SupportSocketClient(path);
    const err = await client
      .grant({ level: 'look', duration: 'forever', grantedBy: { accountId: 'acc_1', name: 'M' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupportCallError);
    expect(err).toMatchObject({ status: 409, code: 'forever_not_allowed' });
    expect((err as Error).message).not.toContain('secret');
    expect(supportRefused(err)).toBe(true);
    answer = [200, JSON.stringify({ ...STATE, environment: 'staging' })];
    await expect(client.state()).rejects.toMatchObject({ code: 'invalid_answer' });
    // The schema's, but not a valid state: a prod box that needs no help code (RH-05).
    answer = [200, JSON.stringify({ ...STATE, helpCodeRequired: false })];
    await expect(client.state()).rejects.toMatchObject({ code: 'invalid_answer' });
  });

  it('says nobody answered when nothing listens (a refusal: nothing happened)', async () => {
    const err = await new SupportSocketClient('/nonexistent/api.sock').state().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: 'unreachable' });
    expect(supportRefused(err)).toBe(true);
  });

  it('streams a transcript, null when there is none, and refuses a malformed visit id unasked', async () => {
    const urls: string[] = [];
    const path = await listen((req, res) => {
      urls.push(req.url ?? '');
      if (req.url === '/v1/visits/v_1/transcript') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('line one\n');
        res.end('line two\n');
      } else res.writeHead(404).end('{"error":{"code":"not_found"}}');
    });
    const client = new SupportSocketClient(path);
    const stream = await client.transcript('v_1');
    const parts: Buffer[] = [];
    for await (const p of stream ?? []) parts.push(Buffer.from(p));
    expect(Buffer.concat(parts).toString()).toBe('line one\nline two\n');
    expect(await client.transcript('v_2')).toBeNull();
    expect(await client.transcript('../../etc/shadow')).toBeNull();
    expect(urls).toEqual(['/v1/visits/v_1/transcript', '/v1/visits/v_2/transcript']);
  });

  it('reads a route with or without its method', () => {
    expect(supportRoute('GET /v1/state')).toEqual({ method: 'GET', path: '/v1/state' });
    expect(supportRoute('/v1/grant', 'POST')).toEqual({ method: 'POST', path: '/v1/grant' });
  });
});

describe('a visits page with an odd record', () => {
  const visit = (id: string, steps: unknown[]) => ({
    id,
    who: 'Claude',
    level: 'look',
    startedAt: '2026-10-21T20:00:00Z',
    endedAt: null,
    steps,
    truncated: false,
    transcriptBytes: 0,
  });

  it('keeps every visit, with a bad step as a refusal', () => {
    const good = { at: '2026-10-21T20:01:00Z', kind: 'look', command: 'status' };
    const bad = { at: '2026-10-21T20:02:00Z', kind: 'exec', line: 'echo\n\u001b[2J' };
    const visits = tolerantVisits([
      visit('20261021T200000Z-00000001', [good, bad, { kind: 'forward' }]),
      visit('20261021T190000Z-00000002', [good]),
      { id: 'not a visit' },
    ]);
    expect(visits.map((v) => v.id)).toEqual(['20261021T200000Z-00000001', '20261021T190000Z-00000002']);
    expect(visits[0]?.steps.map((s) => s.kind)).toEqual(['look', 'refused', 'refused']);
    expect(visits[0]?.steps[2]?.at).toBe('2026-10-21T20:00:00Z');
  });
});
