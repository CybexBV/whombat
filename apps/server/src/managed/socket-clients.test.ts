import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupSocketClient } from './backup';
import { ManagerSocketClient } from './manager-client';
import { ManagerCallError } from './ports';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function listen(handler: RequestListener): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ipc-'));
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

const claimed = { claimId: 'clm_test_0001', claimedAt: '2026-09-25T12:00:00.000Z' };

describe('manager socket response policy', () => {
  it('sends validated JSON to the same route and checks the response contract', async () => {
    const seen: { method?: string; path?: string; body: unknown }[] = [];
    const path = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({ method: req.method, path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.end(JSON.stringify(seen.length === 1 ? { ok: true } : { ok: 'yes' }));
    });
    const client = new ManagerSocketClient(path);
    await client.reportClaimed(claimed);
    expect(seen).toEqual([{ method: 'POST', path: '/v1/runtime/claimed', body: claimed }]);
    await expect(client.reportClaimed(claimed)).rejects.toThrow();
    await expect(client.reportClaimed({ ...claimed, claimedAt: 'bad' })).rejects.toThrow();
    expect(seen).toHaveLength(2);
  });

  it.each([
    [503, '{"error":{"code":"unavailable"}}', 'unavailable'],
    [429, '{"error":{"code":"busy"}}', 'busy'],
    [302, 'redirect', 'error'],
    [400, JSON.stringify({ error: { code: 'x'.repeat(80) } }), 'x'.repeat(64)],
  ])('keeps status %s and its error code without retrying', async (status, body, code) => {
    let calls = 0;
    const path = await listen((_req, res) => {
      calls++;
      res.writeHead(status).end(body);
    });
    const error = await new ManagerSocketClient(path).reportClaimed(claimed).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ManagerCallError);
    expect(error).toMatchObject({ path: '/v1/runtime/claimed', status, code });
    expect(calls).toBe(1);
  });

  it('keeps malformed success JSON separate from a manager HTTP error', async () => {
    const path = await listen((_req, res) => res.end('not JSON'));
    const error = await new ManagerSocketClient(path).reportClaimed(claimed).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ManagerCallError);
    expect((error as Error).message).toContain('not JSON');
  });

  it('keeps the manager body cap and timeout error vocabulary', async () => {
    const path = await listen((req, res) => {
      if (req.url === '/v1/runtime/claimed') res.end('x'.repeat(64 * 1024 + 1));
    });
    const client = new ManagerSocketClient(path, 30);
    await expect(client.reportClaimed(claimed)).rejects.toMatchObject({
      status: 0,
      code: 'unreachable',
      message: expect.stringContaining('manager answer too large'),
    });
    await expect(client.ticket('interactive')).rejects.toMatchObject({
      status: 0,
      code: 'unreachable',
      message: expect.stringContaining('timed out'),
    });
  });
});

describe('backup socket response policy', () => {
  it.each([
    [200, '{"ok":true}', { ok: true }],
    [503, '{"reason":"busy"}', { reason: 'busy' }],
    [404, 'not JSON', null],
    [200, '', null],
    [204, '', null],
  ])('returns status %s and permissively decoded JSON', async (status, body, parsed) => {
    const path = await listen((_req, res) => res.writeHead(status).end(body));
    await expect(new BackupSocketClient(path).call('GET', '/v1/status')).resolves.toEqual({
      status,
      body: parsed,
    });
  });

  it('sends destination input unchanged and never retries a refused mutation', async () => {
    const seen: unknown[] = [];
    const input = { repository: 's3:https://example.com/b', s3SecretAccessKey: 'secret-42' };
    const path = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({ method: req.method, path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(409).end('{"error":"refused"}');
    });
    await expect(new BackupSocketClient(path).call('PUT', '/v1/destination', input)).resolves.toEqual({
      status: 409,
      body: { error: 'refused' },
    });
    expect(seen).toEqual([{ method: 'PUT', path: '/v1/destination', body: input }]);
  });

  it('keeps its body cap and idle timeout words', async () => {
    const path = await listen((req, res) => {
      if (req.url === '/large') res.end('x'.repeat(256 * 1024 + 1));
    });
    const client = new BackupSocketClient(path, 30);
    await expect(client.call('GET', '/large')).rejects.toThrow('backup service answer too large');
    await expect(client.call('GET', '/silent')).rejects.toThrow('backup service timed out');
  });
});

describe('manager and backup body lifecycle', () => {
  it('rejects truncated answers instead of accepting partial JSON, without replaying writes', async () => {
    let calls = 0;
    const path = await listen((_req, res) => {
      calls++;
      res.writeHead(200, { 'content-length': 20 });
      res.end('{"ok":true}');
    });
    await expect(new ManagerSocketClient(path).reportClaimed(claimed)).rejects.toMatchObject({
      status: 0,
      code: 'unreachable',
    });
    await expect(new BackupSocketClient(path).call('POST', '/v1/checkpoints')).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it('allows an answer that stays active beyond each client’s idle timeout', async () => {
    const path = await listen((_req, res: ServerResponse) => {
      res.write('{"ok":');
      let sent = 0;
      const timer = setInterval(() => {
        res.write(' ');
        if (++sent === 20) {
          clearInterval(timer);
          res.end('true}');
        }
      }, 10);
      res.once('close', () => clearInterval(timer));
    });
    await Promise.all([
      expect(new ManagerSocketClient(path, 100).reportClaimed(claimed)).resolves.toBeUndefined(),
      expect(new BackupSocketClient(path, 100).call('POST', '/v1/checkpoints')).resolves.toEqual({
        status: 200,
        body: { ok: true },
      }),
    ]);
  });
});
