/**
 * The direct listener's outer layer (direct-connection.md DC-02…DC-09) with a stand-in for the session: the hello and
 * welcome, then binary bytes both ways; the refusals (bad hello, Host, Origin, rate, drain, capacity); the page; and
 * HTTPS on the Tailscale name from the first byte, on the same port. Noise and admission are `direct.int.test.ts`'s.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, get as httpGet, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, type TLSSocket } from 'node:tls';
import { gzipSync } from 'node:zlib';
import { DIRECT_CLOSE, DIRECT_SUBPROTOCOL } from '@whombat/protocol/direct';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { silentLogger } from '../../services';
import { DirectGuard } from './limits';
import { type DirectAdmit, DirectListener, type DirectMeta, type DirectOutcome } from './listener';
import { directWeb } from './web';

const NAME = 'box.tail0000.ts.net';
const pem = readFileSync(join(import.meta.dirname, '__fixtures__', 'tailscale-cert-pair.pem'), 'utf8');
const pair = {
  key: pem.slice(0, pem.indexOf('-----BEGIN CERTIFICATE-----')),
  cert: pem.slice(pem.indexOf('-----BEGIN CERTIFICATE-----')),
};
const context = createSecureContext(pair);
const webRoot = mkdtempSync(join(tmpdir(), 'wb-direct-web-'));
mkdirSync(join(webRoot, 'assets'));
writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Whombat</title>');
writeFileSync(join(webRoot, 'assets', 'app-1a2b.js'), 'console.log("whombat")');
writeFileSync(join(webRoot, 'assets', 'app-1a2b.js.gz'), gzipSync('console.log("whombat")'));

/** The hosted app's origin, read per upgrade: a box inside A3 has none (own-address.md). */
let hostedOrigins: string[] = ['https://app.whombat.test'];
let admit: DirectAdmit = 'ok';
let outcome: DirectOutcome = 'session';
const metas: DirectMeta[] = [];
const guard = new DirectGuard({ upgradeBurst: 1000, failures: 1000 });

function makeListener(options: { development?: boolean; guard?: DirectGuard } = {}) {
  return new DirectListener({
    port: 0,
    hosts: ['127.0.0.1'],
    interfaces: ['loopback'],
    hostnames: () => [NAME],
    origins: () => hostedOrigins,
    appliancePeerId: '12D3KooWBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBox',
    development: options.development ?? false,
    log: silentLogger,
    admit: () => admit,
    // Echoes every chunk: the bytes after the welcome are the session's.
    onStream: async (stream, meta) => {
      metas.push(meta);
      if (outcome !== 'session') {
        stream.abort(new Error('refused'));
        return outcome;
      }
      void (async () => {
        for (;;) {
          const chunk = await stream.read().catch(() => null);
          if (!chunk) return;
          stream.write(chunk);
        }
      })();
      return 'session';
    },
    web: directWeb(webRoot),
    tls: async (name) => (name === NAME ? context : null),
    guard: options.guard ?? guard,
  });
}

const listener = makeListener();
const dev = makeListener({ development: true });
let port = 0;
let devPort = 0;

beforeAll(async () => {
  await listener.listen();
  await dev.listen();
  port = listener.boundPort();
  devPort = dev.boundPort();
});
afterAll(async () => {
  await listener.close();
  await dev.close();
  rmSync(webRoot, { recursive: true, force: true });
});
afterEach(() => {
  admit = 'ok';
  outcome = 'session';
});

interface Opened {
  ws: WebSocket | null;
  status?: number;
}

function open(
  options: {
    port?: number;
    path?: string;
    host?: string;
    origin?: string;
    protocol?: string | null;
    tls?: boolean;
  } = {},
): Promise<Opened> {
  const p = options.port ?? port;
  const scheme = options.tls ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${scheme}://127.0.0.1:${p}${options.path ?? '/v1/direct'}`,
    options.protocol === null ? [] : [options.protocol ?? DIRECT_SUBPROTOCOL],
    {
      // `ws` leaves out an empty `origin` option, so an empty Origin goes in as a header, as the phone apps send it.
      headers: { host: options.host ?? `127.0.0.1:${p}`, ...(options.origin === '' && { origin: '' }) },
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.tls ? { servername: NAME, rejectUnauthorized: false } : {}),
    },
  );
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res: IncomingMessage) =>
      resolve({ ws: null, status: res.statusCode ?? 0 }),
    );
    ws.once('error', () => resolve({ ws: null, status: 0 }));
  });
}

/** Sends `text` (or the hello) and resolves with the first text message or the close. */
function first(ws: WebSocket, text = JSON.stringify({ t: 'hello', v: 1, class: 'interactive' })) {
  return new Promise<{ message?: Record<string, unknown>; close?: number; reason?: string }>((resolve) => {
    ws.once('message', (raw, bin) => {
      if (!bin) resolve({ message: JSON.parse(raw.toString()) });
    });
    ws.once('close', (code, reason) => resolve({ close: code, reason: reason.toString() }));
    if (text) ws.send(text);
  });
}

function fetchText(path: string, headers: Record<string, string> = {}, p = port) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>(
    (resolve, reject) => {
      httpGet(
        { host: '127.0.0.1', port: p, path, headers: { host: `127.0.0.1:${p}`, ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('latin1'),
            }),
          );
        },
      ).on('error', reject);
    },
  );
}

describe('the direct WebSocket', () => {
  it('answers hello with welcome, then carries binary both ways', async () => {
    const { ws } = await open();
    if (!ws) throw new Error('no socket');
    const answer = await first(ws);
    expect(answer.message).toMatchObject({ t: 'welcome', v: 1, maxMessage: 262_144 });
    const echoed = new Promise<Buffer>((resolve) => ws.once('message', (m) => resolve(m as Buffer)));
    ws.send(Buffer.from([1, 2, 3]));
    expect([...(await echoed)]).toEqual([1, 2, 3]);
    expect(metas.at(-1)).toMatchObject({
      network: 'loopback',
      tls: false,
      origin: null,
      secureContext: null,
    });
    ws.close();
  });

  it('closes 4400 on a bad or binary hello', async () => {
    for (const text of ['{"t":"hello","v":2,"class":"interactive"}', 'not json']) {
      const { ws } = await open();
      expect((await first(ws as WebSocket, text)).close).toBe(DIRECT_CLOSE.badHello);
    }
    const { ws } = await open();
    const closed = first(ws as WebSocket, '');
    ws?.send(Buffer.from([0x16]));
    expect((await closed).close).toBe(DIRECT_CLOSE.badHello);
  });

  it('refuses another Host, another path and a client without the subprotocol', async () => {
    expect((await open({ host: 'evil.example:80' })).status).toBe(421);
    expect((await open({ path: '/v1/connect' })).status).toBe(404);
    expect((await open({ protocol: null })).status).toBe(400);
  });

  it('takes a page of this box, the hosted app or no page, and closes 4403 for another site’s', async () => {
    expect(
      (await first((await open({ origin: `http://127.0.0.1:${port}` })).ws as WebSocket)).message?.t,
    ).toBe('welcome');
    expect(metas.at(-1)).toMatchObject({ origin: `http://127.0.0.1:${port}`, secureContext: false });
    expect(
      (await first((await open({ origin: 'https://app.whombat.test' })).ws as WebSocket)).message?.t,
    ).toBe('welcome');
    for (const origin of ['https://evil.example', 'http://127.0.0.1:5173', `http://${NAME}:1`]) {
      const { ws } = await open({ origin });
      expect((await first(ws as WebSocket, '')).close).toBe(DIRECT_CLOSE.forbidden);
    }
  });

  it('takes an empty Origin as no page: the phone apps send one', async () => {
    const { ws } = await open({ origin: '' });
    expect((await first(ws as WebSocket)).message?.t).toBe('welcome');
    expect(metas.at(-1)).toMatchObject({ origin: null, secureContext: null });
    ws?.close();
  });

  it('refuses the hosted app once the box no longer takes it (a box inside A3)', async () => {
    hostedOrigins = [];
    try {
      const { ws } = await open({ origin: 'https://app.whombat.test' });
      expect((await first(ws as WebSocket, '')).close).toBe(DIRECT_CLOSE.forbidden);
    } finally {
      hostedOrigins = ['https://app.whombat.test'];
    }
  });

  it('takes a development page on loopback only in development', async () => {
    const { ws } = await open({ port: devPort, origin: 'http://localhost:5173' });
    expect((await first(ws as WebSocket)).message?.t).toBe('welcome');
    expect(metas.at(-1)).toMatchObject({
      network: 'loopback',
      origin: 'http://localhost:5173',
      secureContext: true,
    });
    const elsewhere = await open({ origin: 'http://localhost:5173' });
    expect((await first(elsewhere.ws as WebSocket, '')).close).toBe(DIRECT_CLOSE.forbidden);
  });

  it('says it is draining (4503 with the wait) or busy (4429)', async () => {
    admit = { draining: 5000 };
    const draining = await first((await open()).ws as WebSocket);
    expect(draining).toMatchObject({ close: DIRECT_CLOSE.draining });
    expect(JSON.parse(draining.reason ?? '{}')).toEqual({ retryAfterMs: 5000 });
    admit = 'full';
    expect((await first((await open()).ws as WebSocket)).close).toBe(DIRECT_CLOSE.rateLimited);
  });

  it('turns away an address that keeps failing, and one that opens too many', async () => {
    const strict = makeListener({ guard: new DirectGuard({ failures: 2, upgradeBurst: 100 }) });
    await strict.listen();
    const p = strict.boundPort();
    outcome = 'refused';
    for (let i = 0; i < 2; i++) {
      const { ws } = await open({ port: p });
      await first(ws as WebSocket);
      await new Promise<void>((r) => ws?.once('close', () => r()));
    }
    // Locked out: the socket itself is closed before anything is read.
    expect((await open({ port: p })).ws).toBeNull();
    await strict.close();
    const tight = makeListener({ guard: new DirectGuard({ upgradeBurst: 1, upgradesPerSecond: 0.001 }) });
    await tight.listen();
    expect((await first((await open({ port: tight.boundPort() })).ws as WebSocket)).message?.t).toBe(
      'welcome',
    );
    expect((await first((await open({ port: tight.boundPort() })).ws as WebSocket)).close).toBe(
      DIRECT_CLOSE.rateLimited,
    );
    await tight.close();
  });
});

describe('the page on the direct listener', () => {
  it('serves the web build: the shell never cached, assets for a year, precompressed when accepted', async () => {
    const shell = await fetchText('/');
    expect(shell).toMatchObject({ status: 200, body: '<!doctype html><title>Whombat</title>' });
    expect(shell.headers['cache-control']).toBe('no-store, max-age=0');
    expect(shell.headers['x-frame-options']).toBe('DENY');
    expect(shell.headers['strict-transport-security']).toBeUndefined();
    expect((await fetchText('/burrow/c/general')).body).toContain('<title>Whombat');
    const asset = await fetchText('/assets/app-1a2b.js', { 'accept-encoding': 'gzip' });
    expect(asset.headers['content-encoding']).toBe('gzip');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await fetchText('/assets/gone.js')).status).toBe(404);
    expect((await fetchText('/../../etc/passwd')).status).not.toBe(200);
  });

  it('says which box this is on a plain GET of the WebSocket path, and refuses another Host', async () => {
    expect(JSON.parse((await fetchText('/v1/direct')).body)).toMatchObject({
      v: 1,
      appliance: expect.any(String),
    });
    expect((await fetchText('/', { host: 'evil.example' })).status).toBe(421);
  });

  it('speaks HTTPS with the Tailscale name’s certificate on the same port', async () => {
    const res = await new Promise<{ status: number; body: string; cert: string }>((resolve, reject) => {
      httpsGet(
        {
          host: '127.0.0.1',
          port,
          path: '/',
          servername: NAME,
          rejectUnauthorized: false,
          headers: { host: NAME },
        },
        (r) => {
          const cert = String((r.socket as TLSSocket).getPeerCertificate().subject?.CN ?? '');
          const chunks: Buffer[] = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () =>
            resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString(), cert }),
          );
        },
      ).on('error', reject);
    });
    expect(res).toMatchObject({ status: 200, cert: NAME });
    const { ws } = await open({ tls: true, host: `${NAME}:${port}`, origin: `https://${NAME}:${port}` });
    expect((await first(ws as WebSocket)).message?.t).toBe('welcome');
    expect(metas.at(-1)).toMatchObject({ tls: true, origin: `https://${NAME}:${port}`, secureContext: true });
    ws?.close();
  });

  it('turns Nagle off on the sockets it accepts', async () => {
    // Handed to the HTTP(S) server by hand, they would otherwise keep it: about 40 ms on a browser's first HTTPS byte.
    // A page request, not a WebSocket: `ws` sets no-delay itself on upgrade. Node keeps the socket's no-delay choice
    // under this symbol; there is no public getter.
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      httpGet(
        { host: '127.0.0.1', port, path: '/v1/direct', agent, headers: { host: `127.0.0.1:${port}` } },
        (res) => res.resume().on('end', () => resolve()),
      ).on('error', reject);
    });
    const sockets = [...(listener as unknown as { sockets: Set<Socket> }).sockets];
    const noDelay = (s: Socket) => {
      const key = Object.getOwnPropertySymbols(s).find((k) => k.description === 'kSetNoDelay');
      return key ? (s as unknown as Record<symbol, unknown>)[key] : undefined;
    };
    expect(sockets.length).toBeGreaterThan(0);
    expect(sockets.map(noDelay)).toEqual(sockets.map(() => true));
    agent.destroy();
  });
});
