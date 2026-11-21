import { getEventListeners, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as httpServer, type RequestListener, type ServerResponse } from 'node:http';
import { createServer as netServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openUnixHttp, readUnixHttpBody, requestUnixHttp } from './index';

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

async function listen(server: Server): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-http-'));
  const path = join(dir, 'api.sock');
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return path;
}

const answer = (handler: RequestListener) => listen(httpServer(handler));

describe('bounded HTTP over a local Unix socket', () => {
  it('keeps raw status, headers and bytes across chunks, and sends one request body', async () => {
    const seen = deferred<{ method?: string; path?: string; body: string }>();
    const socketPath = await answer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.resolve({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString() });
      res.writeHead(409, { 'x-test': 'raw' });
      const bytes = Buffer.from('€42');
      res.write(bytes.subarray(0, 1));
      res.end(bytes.subarray(1));
    });
    const response = await requestUnixHttp({
      socketPath,
      path: '/change?x=1',
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"on":true}',
      maxResponseBytes: 5,
    });
    expect(await seen.promise).toEqual({ method: 'PUT', path: '/change?x=1', body: '{"on":true}' });
    expect(response.status).toBe(409);
    expect(response.headers['x-test']).toBe('raw');
    expect(response.body.equals(Buffer.from('€42'))).toBe(true);
  });

  it('accepts an empty answer at a zero byte bound', async () => {
    const socketPath = await answer((_req, res) => res.writeHead(204).end());
    const res = await requestUnixHttp({ socketPath, path: '/', maxResponseBytes: 0 });
    expect(res.status).toBe(204);
    expect(res.body).toHaveLength(0);
  });

  it.each(['Content-Length: 9\r\n\r\n{}', 'Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n'])(
    'refuses a truncated response even when its partial bytes are valid JSON (%s)',
    async (body) => {
      const socketPath = await listen(
        netServer((socket) => {
          socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\n${body}`));
        }),
      );
      await expect(requestUnixHttp({ socketPath, path: '/', maxResponseBytes: 32 })).rejects.toMatchObject({
        kind: 'incomplete',
      });
    },
  );

  it('propagates a malformed HTTP body as a failure', async () => {
    const socketPath = await listen(
      netServer((socket) => {
        socket.once('data', () =>
          socket.end('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nnot-a-size\r\n'),
        );
      }),
    );
    await expect(requestUnixHttp({ socketPath, path: '/', maxResponseBytes: 32 })).rejects.toThrow();
  });

  it('rejects a protocol upgrade instead of leaving a pending request behind', async () => {
    const socketPath = await listen(
      netServer((socket) => {
        socket.once('data', () =>
          socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: test\r\n\r\n'),
        );
      }),
    );
    await expect(requestUnixHttp({ socketPath, path: '/', maxResponseBytes: 32 })).rejects.toMatchObject({
      kind: 'incomplete',
    });
  });

  it('cuts off an oversized answer and closes its connection', async () => {
    const closed = deferred<void>();
    const socketPath = await answer((req, res) => {
      req.socket.once('close', () => closed.resolve());
      res.write('123456789');
    });
    const controller = new AbortController();
    await expect(
      requestUnixHttp({ socketPath, path: '/', maxResponseBytes: 8, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'too_large' });
    await closed.promise;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not send a request for a pre-aborted signal', async () => {
    let calls = 0;
    const socketPath = await answer((_req, res) => {
      calls++;
      res.end('unexpected');
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestUnixHttp({ socketPath, path: '/', maxResponseBytes: 32, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(calls).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('aborts before headers and releases the abort listener and connection', async () => {
    const received = deferred<void>();
    const closed = deferred<void>();
    const socketPath = await answer((req) => {
      req.socket.once('close', () => closed.resolve());
      received.resolve();
    });
    const controller = new AbortController();
    const pending = requestUnixHttp({
      socketPath,
      path: '/',
      maxResponseBytes: 32,
      signal: controller.signal,
    });
    const failed = expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    await received.promise;
    controller.abort();
    await failed;
    await closed.promise;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('keeps cancellation after handing off a stream, including a reader attached after abort', async () => {
    const socketPath = await answer((_req, res) => res.write('first'));
    const controller = new AbortController();
    const { res } = await openUnixHttp({ socketPath, path: '/', signal: controller.signal });
    controller.abort();
    await expect(readUnixHttpBody(res, 32)).rejects.toMatchObject({ kind: 'aborted' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('aborts during a body read and removes the listener', async () => {
    const socketPath = await answer((_req, res) => res.write('first'));
    const controller = new AbortController();
    const { res } = await openUnixHttp({ socketPath, path: '/', signal: controller.signal });
    res.once('data', () => controller.abort());
    await expect(readUnixHttpBody(res, 32)).rejects.toMatchObject({ kind: 'aborted' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('releases cancellation when a streaming caller destroys the response', async () => {
    const socketPath = await answer((_req, res) => res.flushHeaders());
    const controller = new AbortController();
    const { res } = await openUnixHttp({ socketPath, path: '/', signal: controller.signal });
    const closed = once(res, 'close');
    res.destroy();
    await closed;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('releases the listener after success and socket refusal', async () => {
    const socketPath = await answer((_req, res) => res.end('done'));
    const controller = new AbortController();
    await requestUnixHttp({ socketPath, path: '/', maxResponseBytes: 32, signal: controller.signal });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await expect(
      requestUnixHttp({
        socketPath: `${socketPath}.missing`,
        path: '/',
        maxResponseBytes: 32,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort();
  });

  it.each([false, true])(
    'times out an idle socket before or after headers (headers: %s)',
    async (headers) => {
      const socketPath = await answer((_req, res) => {
        if (headers) res.write('first');
      });
      await expect(
        requestUnixHttp({ socketPath, path: '/', maxResponseBytes: 32, idleTimeoutMs: 30 }),
      ).rejects.toMatchObject({ kind: 'timeout' });
    },
  );

  it('resets an idle timeout as data arrives instead of imposing a total deadline', async () => {
    const socketPath = await answer((_req, res) => {
      let sent = 0;
      const timer = setInterval(() => {
        res.write('.');
        if (++sent === 20) {
          clearInterval(timer);
          res.end();
        }
      }, 10);
      res.once('close', () => clearInterval(timer));
    });
    const res = await requestUnixHttp({ socketPath, path: '/', maxResponseBytes: 32, idleTimeoutMs: 100 });
    expect(res.body.toString()).toBe('.'.repeat(20));
  });

  it('enforces a total deadline while the body is still active', async () => {
    let response: ServerResponse | undefined;
    const socketPath = await answer((_req, res) => {
      response = res;
      res.write('first');
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { res } = await openUnixHttp({ socketPath, path: '/', deadlineMs: 50, idleTimeoutMs: 1000 });
    const pending = readUnixHttpBody(res, 32);
    const failed = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    vi.advanceTimersByTime(25);
    response?.write('second');
    await once(res, 'data');
    vi.advanceTimersByTime(25);
    await failed;
  });

  it.each([0, 50])(
    'enforces a %s ms deadline before headers and releases cancellation',
    async (deadlineMs) => {
      const received = deferred<void>();
      const socketPath = await answer(() => received.resolve());
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const controller = new AbortController();
      const pending = requestUnixHttp({
        socketPath,
        path: '/',
        deadlineMs,
        maxResponseBytes: 32,
        signal: controller.signal,
      });
      const failed = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
      await received.promise;
      vi.advanceTimersByTime(deadlineMs);
      await failed;
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    },
  );

  it('stops a header deadline at the head and leaves the caller in control of the stream', async () => {
    let response: ServerResponse | undefined;
    const socketPath = await answer((_req, res) => {
      response = res;
      res.flushHeaders();
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const { res } = await openUnixHttp({
      socketPath,
      path: '/',
      deadlineMs: 20,
      deadlineUntil: 'headers',
      signal: controller.signal,
    });
    vi.advanceTimersByTime(100);
    expect(res.destroyed).toBe(false);
    const pending = readUnixHttpBody(res, 32);
    response?.end('late data');
    expect((await pending).toString()).toBe('late data');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
