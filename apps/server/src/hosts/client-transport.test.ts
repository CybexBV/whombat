import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTS_MAX_BODY, HostsClient, HostsError } from './client';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function service(handler: RequestListener) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-host-http-'));
  const socket = join(dir, 'api.sock');
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 'old-token');
  const server = createServer(handler);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { client: new HostsClient({ socket, tokenFile }), tokenFile };
}

describe('hosts socket transport policy', () => {
  it('refreshes the token exactly once after 401 even when its cached mtime is unchanged', async () => {
    const tokens: (string | undefined)[] = [];
    const { client, tokenFile } = await service((req, res) => {
      tokens.push(req.headers.authorization);
      if (tokens.length === 1) {
        const st = statSync(tokenFile);
        writeFileSync(tokenFile, 'new-token');
        utimesSync(tokenFile, st.atime, st.mtime);
        res.writeHead(401).end('{}');
      } else res.end('{"ok":true}');
    });
    await client.token();
    await expect(client.json({ path: '/' })).resolves.toEqual({ ok: true });
    expect(tokens).toEqual(['Bearer old-token', 'Bearer new-token']);
  });

  it('stops after a second 401, and does not refresh or retry streaming open', async () => {
    let calls = 0;
    const { client } = await service((_req, res) => {
      calls++;
      res.writeHead(401).end('{"code":"invalid_token"}');
    });
    await expect(client.json({ path: '/' })).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    expect(calls).toBe(2);
    await expect(client.open({ path: '/' })).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    expect(calls).toBe(3);
  });

  it('returns any raw status, maps JSON problems, and never retries a service refusal of a write', async () => {
    const methods: (string | undefined)[] = [];
    const { client } = await service((req, res) => {
      methods.push(req.method);
      res
        .writeHead(503)
        .end('{"code":"agent_offline","detail":"Offline.","field_errors":{"server":"offline"}}');
    });
    expect((await client.send({ path: '/' })).status).toBe(503);
    const error = await client
      .json({ path: '/', method: 'POST', body: { action: 'restart' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostsError);
    expect(error).toMatchObject({
      status: 503,
      code: 'agent_offline',
      detail: 'Offline.',
      fieldErrors: { server: 'offline' },
    });
    expect(methods).toEqual(['GET', 'POST']);
  });

  it.each([204, 200])('returns null for an empty JSON answer with status %s', async (status) => {
    const { client } = await service((_req, res) => res.writeHead(status).end());
    await expect(client.json({ path: '/' })).resolves.toBeNull();
  });

  it('keeps malformed JSON success and plain text refusal policies', async () => {
    const { client } = await service((req, res) => {
      res.writeHead(req.url === '/error' ? 400 : 200).end('not JSON');
    });
    await expect(client.json({ path: '/' })).rejects.toMatchObject({
      reason: 'broken',
      message: expect.stringContaining('isn’t JSON'),
    });
    await expect(client.json({ path: '/error' })).rejects.toMatchObject({
      status: 400,
      code: 'http_400',
      detail: 'not JSON',
    });
  });

  it('rejects a partial body with its existing closed-answer words', async () => {
    let calls = 0;
    const { client } = await service((_req, res) => {
      calls++;
      res.writeHead(200, { 'content-length': 20 }).end('{"ok":true}');
    });
    await expect(client.json({ path: '/', method: 'POST', body: {} })).rejects.toMatchObject({
      reason: 'broken',
      message: expect.stringContaining('closed the answer'),
    });
    expect(calls).toBe(1);
  });

  it('keeps the separate caps for buffered answers and streaming error bodies', async () => {
    const { client } = await service((req, res) => {
      if (req.url === '/stream') res.writeHead(500).end(Buffer.alloc(64 * 1024 + 1));
      else res.end(Buffer.alloc(HOSTS_MAX_BODY + 1));
    });
    await Promise.all(
      [client.send({ path: '/' }), client.open({ path: '/stream' })].map((pending) =>
        expect(pending).rejects.toMatchObject({
          reason: 'broken',
          message: expect.stringContaining('too much'),
        }),
      ),
    );
  });

  it('applies the total deadline through the buffered body', async () => {
    const received = deferred<void>();
    const { client } = await service((_req, res) => {
      res.write('first');
      received.resolve();
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = client.send({ path: '/', timeoutMs: 50 });
    const failed = expect(pending).rejects.toMatchObject({ reason: 'timeout' });
    await received.promise;
    vi.advanceTimersByTime(50);
    await failed;
  });

  it('hands off a successful stream at headers and leaves it alive beyond the header deadline', async () => {
    let response: ServerResponse | undefined;
    const { client } = await service((_req, res) => {
      response = res;
      res.flushHeaders();
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { res, request } = await client.open({ path: '/events', timeoutMs: 20 });
    vi.advanceTimersByTime(100);
    expect(res.destroyed).toBe(false);
    const closed = once(request, 'close');
    response?.end('event data');
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('event data');
    await closed;
    expect(request.destroyed).toBe(true);
  });

  it('reads streaming error bodies before creating a HostsError and rejects truncated ones', async () => {
    const { client } = await service((req, res) => {
      res.writeHead(409, req.url === '/truncated' ? { 'content-length': 200 } : {});
      res.end('{"code":"busy"}');
    });
    await expect(client.open({ path: '/' })).rejects.toMatchObject({ status: 409, code: 'busy' });
    await expect(client.open({ path: '/truncated' })).rejects.toMatchObject({ reason: 'broken' });
  });
});
