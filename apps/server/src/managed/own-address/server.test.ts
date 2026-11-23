/**
 * The own address's listener (own-address.md): door streams (raw TLS bytes, as the relay hands them over) fed into the
 * direct listener made for the door. HTTP/2 and HTTP/1.1, the well-known files, the page's policy, the Host and
 * `:authority` checks, the WebSocket on HTTP/1.1 with its Origin rule, the visitor's address as the peer, and limits
 * without lockouts. A TCP server here stands in for the relay: each connection becomes a plain `Duplex`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect as h2connect } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { createSecureContext, connect as tlsConnect } from 'node:tls';
import { DIRECT_SUBPROTOCOL } from '@whombat/protocol/direct';
import { BOX_ASSET_LINKS } from '@whombat/protocol/own-address';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { silentLogger } from '../../services';
import { DirectGuard, DOOR_LIMITS } from '../direct/limits';
import { DirectListener, type DirectMeta } from '../direct/listener';
import { directWeb } from '../direct/web';
import { OWN_ADDRESS_POLICY, ownAddressDoor, ROBOTS_TXT } from './server';

const HOST = 'maple-otter-river.dev.whombat.app';
/** The host the box is leaving (the fixture certificate names only HOST: clients here don't check the name). */
const OLD = 'cedar-fox-lake.dev.whombat.app';
let served = [HOST];
const SRC = '203.0.113.7';
const pem = readFileSync(join(import.meta.dirname, '__fixtures__', 'own-address-pair.pem'), 'utf8');
const cert = pem.slice(pem.indexOf('-----BEGIN CERTIFICATE-----'));
const context = createSecureContext({ key: pem.slice(0, pem.indexOf('-----BEGIN CERTIFICATE-----')), cert });
const webRoot = mkdtempSync(join(tmpdir(), 'wb-own-web-'));
mkdirSync(join(webRoot, 'assets'));
writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Whombat</title>');

const metas: DirectMeta[] = [];
let listener: DirectListener;
let relay: Server;
let port = 0;
let src = SRC;
const guard = new DirectGuard({ ...DOOR_LIMITS, upgradeBurst: 1000 });

/** A TCP connection as the relay would hand it over: a plain Duplex of its bytes. */
function asDoorStream(socket: Socket): Duplex {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, _enc, cb) {
      socket.write(chunk, cb);
    },
    final(cb) {
      socket.end();
      cb();
    },
    destroy(err, cb) {
      socket.destroy();
      cb(err);
    },
  });
  socket.on('data', (b) => {
    if (!stream.push(b)) socket.pause();
  });
  socket.on('end', () => stream.push(null));
  socket.on('error', () => stream.destroy());
  return stream;
}

beforeAll(async () => {
  listener = new DirectListener({
    port: 0,
    hosts: [],
    interfaces: [],
    hostnames: () => [],
    origins: ['https://app.whombat.test'],
    appliancePeerId: '12D3KooWBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBox',
    development: false,
    log: silentLogger,
    admit: () => 'ok',
    onStream: async (stream, meta) => {
      metas.push(meta);
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
    door: ownAddressDoor({
      webHosts: () => served,
      contextFor: (h) => (served.includes(h) ? context : null),
    }),
    guard,
  });
  relay = createServer((socket) => listener.acceptDoor(asDoorStream(socket), src));
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', () => resolve()));
  const addr = relay.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await listener.close();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
});

const tlsOptions = () => ({ host: '127.0.0.1', port, servername: HOST, ca: cert });

/** One HTTP/2 GET. */
function h2get(
  path: string,
  authority = HOST,
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const session = h2connect(`https://${HOST}`, {
      createConnection: () => tlsConnect({ ...tlsOptions(), ALPNProtocols: ['h2'] }),
    });
    session.on('error', reject);
    const req = session.request({ ':path': path, ':authority': authority });
    let headers: Record<string, unknown> = {};
    let body = '';
    req.on('response', (h) => {
      headers = h;
    });
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      session.close();
      resolve({ status: Number(headers[':status']), headers, body });
    });
    req.on('error', reject);
    req.end();
  });
}

/** One HTTP/1.1 GET. */
function h1get(
  path: string,
  host = HOST,
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        ...tlsOptions(),
        path,
        headers: { host },
        ALPNProtocols: ['http/1.1'],
        agent: false,
      } as import('node:https').RequestOptions,
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('the own address over HTTP/2 and HTTP/1.1', () => {
  it('serves the page on both, with the page’s policy as a header and no HSTS', async () => {
    for (const get of [h2get, h1get]) {
      const page = await get('/c/abcdef');
      expect(page.status).toBe(200);
      expect(page.body).toContain('<title>Whombat</title>');
      expect(page.headers['content-security-policy']).toBe(OWN_ADDRESS_POLICY);
      expect(String(page.headers['content-security-policy'])).toContain("connect-src 'self'");
      expect(page.headers['strict-transport-security']).toBeUndefined();
    }
  });

  it('serves assetlinks.json from the contracts, cached a day; robots.txt; no AASA', async () => {
    const links = await h2get('/.well-known/assetlinks.json');
    expect(links.status).toBe(200);
    expect(JSON.parse(links.body)).toEqual(BOX_ASSET_LINKS);
    expect(links.headers['content-type']).toBe('application/json');
    expect(links.headers['cache-control']).toBe('public, max-age=86400');
    const robots = await h1get('/robots.txt');
    expect(robots.body).toBe(ROBOTS_TXT);
    const aasa = await h2get('/.well-known/apple-app-site-association');
    expect(aasa.status).toBe(404);
    expect(aasa.headers['content-security-policy']).toBe(OWN_ADDRESS_POLICY);
  });

  it('takes its host and host:443 only, never the listener’s port or another name', async () => {
    expect((await h2get('/', `${HOST}:443`)).status).toBe(200);
    expect((await h1get('/', `${HOST}:443`)).status).toBe(200);
    expect((await h2get('/', `${HOST}:4480`)).status).toBe(421);
    expect((await h1get('/', `${HOST}:${port}`)).status).toBe(421);
    expect((await h2get('/', 'other-otter-river.dev.whombat.app')).status).toBe(421);
    expect((await h1get('/', '127.0.0.1')).status).toBe(421);
  });

  it('fails the TLS handshake for any other name', async () => {
    const err = await new Promise<Error | null>((resolve) => {
      const socket = tlsConnect({ ...tlsOptions(), servername: 'other-otter-river.dev.whombat.app' });
      socket.once('secureConnect', () => resolve(null));
      socket.once('error', resolve);
    });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('two hosts for a while after a rename', () => {
  const at = (servername: string) => ({ ...tlsOptions(), servername, checkServerIdentity: () => undefined });

  /** One HTTP/1.1 GET on a connection made to `servername`, with `host` as its Host. */
  function get(servername: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          ...at(servername),
          path: '/',
          headers: { host },
          ALPNProtocols: ['http/1.1'],
          agent: false,
        } as never,
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  function handshake(servername: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = tlsConnect(at(servername));
      socket.once('secureConnect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
  }

  it('serves each host on a connection made to it, and never one host’s name on the other’s connection', async () => {
    served = [HOST, OLD];
    try {
      expect(await get(OLD, OLD)).toBe(200);
      expect(await get(OLD, `${OLD}:443`)).toBe(200);
      expect(await get(HOST, HOST)).toBe(200);
      expect(await get(OLD, HOST)).toBe(421);
      expect(await get(HOST, OLD)).toBe(421);
    } finally {
      served = [HOST];
    }
  });

  it('opens the WebSocket at the old host from its own page only, as a door session arriving there', async () => {
    served = [HOST, OLD];
    try {
      const opened = await new Promise<number | 'open'>((resolve, reject) => {
        const ws = new WebSocket(`wss://${OLD}/v1/direct`, DIRECT_SUBPROTOCOL, {
          createConnection: () => tlsConnect({ ...at(OLD), ALPNProtocols: ['http/1.1'] }),
          origin: `https://${OLD}`,
        } as WebSocket.ClientOptions);
        ws.once('open', () =>
          ws.send(JSON.stringify({ t: 'hello', v: 1, class: 'interactive', client: { build: 'web' } })),
        );
        ws.once('message', () => {
          ws.close();
          resolve('open');
        });
        ws.once('close', (code) => resolve(code));
        ws.once('error', reject);
      });
      expect(opened).toBe('open');
      expect(metas.at(-1)).toMatchObject({ network: 'door', local: OLD, origin: `https://${OLD}` });
      const crossed = await new Promise<number | 'open'>((resolve, reject) => {
        const ws = new WebSocket(`wss://${OLD}/v1/direct`, DIRECT_SUBPROTOCOL, {
          createConnection: () => tlsConnect({ ...at(OLD), ALPNProtocols: ['http/1.1'] }),
          origin: `https://${HOST}`,
        } as WebSocket.ClientOptions);
        ws.once('open', () =>
          ws.send(JSON.stringify({ t: 'hello', v: 1, class: 'interactive', client: { build: 'web' } })),
        );
        ws.once('message', () => resolve('open'));
        ws.once('close', (code) => resolve(code));
        ws.once('error', reject);
      });
      expect(crossed).toBe(4403);
    } finally {
      served = [HOST];
    }
  });

  it('stops at the old host once the box no longer answers there', async () => {
    served = [HOST, OLD];
    expect(await handshake(OLD)).toBe(true);
    served = [HOST];
    expect(await handshake(OLD)).toBe(false);
    expect(await handshake(HOST)).toBe(true);
  });
});

describe('the WebSocket on the own address', () => {
  function open(origin: string | null): Promise<{ ws: WebSocket; welcome: unknown } | { closed: number }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://${HOST}/v1/direct`, DIRECT_SUBPROTOCOL, {
        createConnection: () => tlsConnect({ ...tlsOptions(), ALPNProtocols: ['http/1.1'] }),
        ...(origin ? { origin } : {}),
      } as WebSocket.ClientOptions);
      ws.once('open', () =>
        ws.send(JSON.stringify({ t: 'hello', v: 1, class: 'interactive', client: { build: 'web' } })),
      );
      ws.once('message', (m) => resolve({ ws, welcome: JSON.parse(String(m)) }));
      ws.once('close', (code) => resolve({ closed: code }));
      ws.once('error', reject);
    });
  }

  it('opens on HTTP/1.1 from its own page, as a door session with the visitor’s address', async () => {
    const got = await open(`https://${HOST}`);
    expect('ws' in got && (got.welcome as { t: string }).t).toBe('welcome');
    if ('ws' in got) got.ws.close();
    expect(metas.at(-1)).toMatchObject({
      network: 'door',
      local: HOST,
      remote: SRC,
      tls: true,
      secureContext: true,
    });
  });

  it('opens for a native app (no Origin), and refuses the hosted app’s page and other pages', async () => {
    const native = await open(null);
    expect('ws' in native).toBe(true);
    if ('ws' in native) native.ws.close();
    expect(await open('https://app.whombat.test')).toMatchObject({ closed: 4403 });
    expect(await open(`https://${HOST}:8443`)).toMatchObject({ closed: 4403 });
  });
});

describe('the door’s limits', () => {
  it('count per visitor address and never lock one out', () => {
    const g = new DirectGuard(DOOR_LIMITS);
    for (let i = 0; i < 100; i += 1) g.failed(SRC);
    expect(g.locked(SRC)).toBe(false);
    expect(g.openSocket(SRC)).toBe(true);
    expect(g.stats.lockouts).toBe(0);
    for (let i = 1; i < DOOR_LIMITS.socketsPerPeer; i += 1) g.openSocket(SRC);
    expect(g.openSocket(SRC)).toBe(false);
    expect(g.openSocket('2001:db8:1:2::9')).toBe(true);
  });

  it('closes a stream from an address past its sockets', async () => {
    src = '198.51.100.1';
    const busy = new DirectGuard({ ...DOOR_LIMITS, socketsPerPeer: 0 });
    const blocked = await new Promise<boolean>((resolve) => {
      const before = guard.stats.socketsRefused;
      Object.assign(listener, { guard: busy });
      const socket = tlsConnect(tlsOptions());
      socket.once('secureConnect', () => resolve(false));
      socket.once('error', () =>
        resolve(busy.stats.socketsRefused > 0 || guard.stats.socketsRefused > before),
      );
      socket.once('close', () => resolve(busy.stats.socketsRefused > 0));
    });
    Object.assign(listener, { guard });
    src = SRC;
    expect(blocked).toBe(true);
  });
});
