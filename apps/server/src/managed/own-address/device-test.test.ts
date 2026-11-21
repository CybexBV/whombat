/**
 * The phone passkey device test's box side (device-test.ts): off unless its file is there, refused on a prod runtime
 * and outside the DEV zone, a week at most; with it on, the well-known requests are logged with the visitor's address
 * and User-Agent, `assetlinks.json` can be turned off, and the test page is served under the page's policy.
 */
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect as h2connect } from 'node:http2';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { createSecureContext, connect as tlsConnect } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../services';
import { DirectGuard, DOOR_LIMITS } from '../direct/limits';
import { DirectListener } from '../direct/listener';
import {
  DEVICE_TEST_FILE,
  DEVICE_TEST_MAX_AGE_MS,
  DEVICE_TEST_PAGE,
  DEVICE_TEST_PRF_SALT_HEX,
  type DeviceTest,
  deviceTestRoutes,
  readDeviceTest,
} from './device-test';
import { OWN_ADDRESS_POLICY, ownAddressDoor } from './server';

const HOST = 'maple-otter-river.dev.whombat.app';
const SRC = '203.0.113.9';
const pem = readFileSync(join(import.meta.dirname, '__fixtures__', 'own-address-pair.pem'), 'utf8');
const cert = pem.slice(pem.indexOf('-----BEGIN CERTIFICATE-----'));
const context = createSecureContext({ key: pem.slice(0, pem.indexOf('-----BEGIN CERTIFICATE-----')), cert });

interface Line {
  level: 'info' | 'warn';
  obj: Record<string, unknown>;
  msg: string | undefined;
}
function recorder(): Logger & { lines: Line[] } {
  const lines: Line[] = [];
  const push = (level: Line['level']) => (obj: unknown, msg?: string) =>
    lines.push({ level, obj: obj as Record<string, unknown>, msg });
  return { lines, info: push('info'), warn: push('warn'), error() {}, debug() {} };
}

function homeWith(word: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'wb-device-test-'));
  if (word !== null) writeFileSync(join(home, DEVICE_TEST_FILE), `${word}\n`);
  return home;
}

describe('the switch', () => {
  it('is off without its file, and says nothing', () => {
    const log = recorder();
    expect(readDeviceTest({ home: homeWith(null), env: { WHOMBAT_ENV: 'local' }, log })).toBeNull();
    expect(log.lines).toEqual([]);
  });

  it('turns on with `on` or `assetlinks-off` on a DEV or local runtime', () => {
    const log = recorder();
    expect(readDeviceTest({ home: homeWith('on'), env: { WHOMBAT_ENV: 'local' }, log })?.assetLinks).toBe(
      true,
    );
    expect(readDeviceTest({ home: homeWith('assetlinks-off'), env: {}, log })?.assetLinks).toBe(false);
    expect(log.lines.filter((l) => l.msg?.includes(': on'))).toHaveLength(2);
  });

  it('is refused on a prod runtime', () => {
    const log = recorder();
    expect(readDeviceTest({ home: homeWith('on'), env: { WHOMBAT_ENV: 'prod' }, log })).toBeNull();
    expect(log.lines[0]?.msg).toContain('prod');
  });

  it('stays off for an unknown word or a file older than a week', () => {
    const log = recorder();
    expect(readDeviceTest({ home: homeWith('yes'), env: {}, log })).toBeNull();
    const home = homeWith('on');
    const old = new Date(Date.now() - DEVICE_TEST_MAX_AGE_MS - 60_000);
    utimesSync(join(home, DEVICE_TEST_FILE), old, old);
    expect(readDeviceTest({ home, env: {}, log })).toBeNull();
    expect(log.lines.map((l) => l.level)).toEqual(['warn', 'warn']);
  });
});

/** A request as the routes see it, for the cases a real listener can't reach (another zone, a later clock). */
function fakeAnswer(path: string): {
  req: IncomingMessage;
  res: ServerResponse;
  status: () => number | null;
} {
  let status: number | null = null;
  const req = {
    method: 'GET',
    url: path,
    headers: {},
    socket: { remoteAddress: SRC },
  } as unknown as IncomingMessage;
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end() {},
  } as unknown as ServerResponse;
  return { req, res, status: () => status };
}

describe('where it works', () => {
  const test: DeviceTest = { assetLinks: false, since: new Date() };

  it('does nothing at an address outside the DEV zone, and says so once', () => {
    const log = recorder();
    const routes = deviceTestRoutes(test, () => 'maple-otter-river.box.whombat.app', log);
    for (const path of ['/.well-known/assetlinks.json', DEVICE_TEST_PAGE]) {
      const a = fakeAnswer(path);
      expect(routes(a.req, a.res, path)).toBe(false);
      expect(a.status()).toBeNull();
    }
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]?.level).toBe('warn');
  });

  it('stops a week after the switch was written, even while running', () => {
    const later = () => new Date(test.since.getTime() + DEVICE_TEST_MAX_AGE_MS + 1);
    const routes = deviceTestRoutes(test, () => HOST, recorder(), later);
    const a = fakeAnswer(DEVICE_TEST_PAGE);
    expect(routes(a.req, a.res, DEVICE_TEST_PAGE)).toBe(false);
  });
});

/* Through the own address's listener, as the door hands streams over ------------------------------------------ */

let listener: DirectListener | null = null;
let relay: Server | null = null;

afterEach(async () => {
  await listener?.close();
  await new Promise<void>((resolve) => (relay ? relay.close(() => resolve()) : resolve()));
  listener = null;
  relay = null;
});

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

async function ownAddress(test: DeviceTest | null, log: Logger): Promise<number> {
  const routes = test ? deviceTestRoutes(test, () => HOST, log) : undefined;
  listener = new DirectListener({
    port: 0,
    hosts: [],
    interfaces: [],
    hostnames: () => [],
    appliancePeerId: '12D3KooWBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBox',
    development: false,
    log,
    admit: () => 'ok',
    onStream: async () => 'session',
    web: null,
    door: ownAddressDoor({ host: () => HOST, context: () => context }, routes),
    guard: new DirectGuard({ ...DOOR_LIMITS, upgradeBurst: 1000 }),
  });
  const own = listener;
  relay = createServer((socket) => own.acceptDoor(asDoorStream(socket), SRC));
  const server = relay;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

function h2get(
  port: number,
  path: string,
  agent = 'Google-Test',
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const session = h2connect(`https://${HOST}`, {
      createConnection: () =>
        tlsConnect({ host: '127.0.0.1', port, servername: HOST, ca: cert, ALPNProtocols: ['h2'] }),
    });
    session.on('error', reject);
    const req = session.request({ ':path': path, ':authority': HOST, 'user-agent': agent });
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

describe('on the own address', () => {
  it('switched off: assetlinks.json as usual, no log, no test page', async () => {
    const log = recorder();
    const port = await ownAddress(null, log);
    expect((await h2get(port, '/.well-known/assetlinks.json')).status).toBe(200);
    expect((await h2get(port, DEVICE_TEST_PAGE)).status).not.toBe(200);
    expect(log.lines.filter((l) => l.msg?.includes('device test'))).toEqual([]);
  });

  it('on: logs each well-known request with the visitor’s address and User-Agent', async () => {
    const log = recorder();
    const port = await ownAddress({ assetLinks: true, since: new Date() }, log);
    expect((await h2get(port, '/.well-known/assetlinks.json', 'Google-Digital-Asset-Links')).status).toBe(
      200,
    );
    expect((await h2get(port, '/.well-known/apple-app-site-association', 'AASA-Bot/1.0')).status).toBe(404);
    const lines = log.lines.filter((l) => l.msg?.includes('well-known'));
    expect(lines.map((l) => [l.obj.path, l.obj.src, l.obj.userAgent])).toEqual([
      ['/.well-known/assetlinks.json', SRC, 'Google-Digital-Asset-Links'],
      ['/.well-known/apple-app-site-association', SRC, 'AASA-Bot/1.0'],
    ]);
  });

  it('assetlinks-off: assetlinks.json answers 404, logged as such', async () => {
    const log = recorder();
    const port = await ownAddress({ assetLinks: false, since: new Date() }, log);
    const links = await h2get(port, '/.well-known/assetlinks.json');
    expect(links.status).toBe(404);
    expect(links.headers['content-security-policy']).toBe(OWN_ADDRESS_POLICY);
    expect(log.lines.find((l) => l.msg?.includes('well-known'))?.obj.answer).toBe(404);
  });

  it('serves the test page, its script and style under the page’s policy', async () => {
    const port = await ownAddress({ assetLinks: true, since: new Date() }, recorder());
    const page = await h2get(port, DEVICE_TEST_PAGE);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toBe(OWN_ADDRESS_POLICY);
    expect(page.body).toContain(`src="${DEVICE_TEST_PAGE}.js"`);
    const script = await h2get(port, `${DEVICE_TEST_PAGE}.js`);
    expect(script.headers['content-type']).toContain('javascript');
    expect(script.body).toContain(DEVICE_TEST_PRF_SALT_HEX);
    expect(script.body).toContain('whombat://box-passkey-test');
    expect((await h2get(port, `${DEVICE_TEST_PAGE}.css`)).headers['content-type']).toContain('text/css');
  });
});
