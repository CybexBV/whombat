import { getEventListeners } from 'node:events';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SignInSocketUntrusted, signInSocketFetch } from './signin-socket';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function service(handler: RequestListener) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-signin-http-'));
  const path = join(dir, 'api.sock');
  const server = createServer(handler);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { dir, fetch: signInSocketFetch(path, process.getuid?.()) };
}

const url = 'http://localhost/internal/runner/signin/poll';

describe('sign-in socket fetch transport', () => {
  it('preserves request and response status, leaving JSON decoding to the caller', async () => {
    const seen: unknown[] = [];
    const { fetch } = await service(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({
        method: req.method,
        path: req.url,
        token: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(401).end('sign in again');
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer runner-token', 'content-type': 'application/json' },
      body: '{"waitMs":25000}',
    });
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/internal/runner/signin/poll',
        token: 'Bearer runner-token',
        body: '{"waitMs":25000}',
      },
    ]);
    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
    expect(await res.text()).toBe('sign in again');
    await expect((await fetch(url)).json()).rejects.toThrow();
    expect(seen).toHaveLength(2);
  });

  it('checks filesystem ownership before every call, before any token is sent', async () => {
    let calls = 0;
    const { dir, fetch } = await service((_req, res) => {
      calls++;
      res.end('{}');
    });
    await expect(fetch(url)).resolves.toMatchObject({ status: 200 });
    chmodSync(dir, 0o777);
    await expect(fetch(url, { headers: { authorization: 'Bearer runner-token' } })).rejects.toBeInstanceOf(
      SignInSocketUntrusted,
    );
    expect(calls).toBe(1);
  });

  it('does not send a request for a pre-aborted signal', async () => {
    let calls = 0;
    const { fetch } = await service((_req, res) => {
      calls++;
      res.end('{}');
    });
    const controller = new AbortController();
    controller.abort();
    await expect(fetch(url, { signal: controller.signal })).rejects.toThrow('aborted');
    expect(calls).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each([false, true])(
    'aborts a pending request and removes its listener (headers: %s)',
    async (headers) => {
      const received = deferred<void>();
      const closed = deferred<void>();
      const { fetch } = await service((req, res) => {
        req.socket.once('close', () => closed.resolve());
        if (headers) res.write('{');
        received.resolve();
      });
      const controller = new AbortController();
      const pending = fetch(url, { signal: controller.signal });
      const failed = expect(pending).rejects.toThrow('aborted');
      await received.promise;
      controller.abort();
      await failed;
      await closed.promise;
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    },
  );

  it('releases the abort listener after every successful poll', async () => {
    const { fetch } = await service((_req, res) => res.end('{"requests":[]}'));
    const controller = new AbortController();
    for (let i = 0; i < 12; i++) {
      const res = await fetch(url, { signal: controller.signal });
      expect(await res.json()).toEqual({ requests: [] });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
    controller.abort();
  });

  it('refuses truncated JSON even when the bytes received would decode', async () => {
    let calls = 0;
    const { fetch } = await service((_req, res) => {
      calls++;
      res.writeHead(200, { 'content-length': 20 }).end('{}');
    });
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('bounds a broken server’s response and cleans up cancellation', async () => {
    const { fetch } = await service((_req, res) => res.end(Buffer.alloc(16 * 1024 * 1024 + 1)));
    const controller = new AbortController();
    await expect(fetch(url, { signal: controller.signal })).rejects.toMatchObject({ kind: 'too_large' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
