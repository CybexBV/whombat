/**
 * Pages only over HTTPS (docs/decisions/whombat-link.md LNK-10; direct-connection.md DC-19): on the local network a
 * plain-HTTP GET of the page gets one sentence naming the box's HTTPS addresses and no app code; the same page over
 * HTTPS (the Tailscale name) is served; the identity GET and the apps' WebSocket stay on plain HTTP (LNK-11). The
 * local network is played by an interface table that puts 127.0.0.1 on a LAN card.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { DIRECT_SUBPROTOCOL } from '@whombat/protocol/direct';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { silentLogger } from '../../services';
import { DirectGuard } from './limits';
import { DirectListener, httpsOnlyText } from './listener';
import { directWeb } from './web';

const NAME = 'box.tail0000.ts.net';
const pem = readFileSync(join(import.meta.dirname, '__fixtures__', 'tailscale-cert-pair.pem'), 'utf8');
const context = createSecureContext({
  key: pem.slice(0, pem.indexOf('-----BEGIN CERTIFICATE-----')),
  cert: pem.slice(pem.indexOf('-----BEGIN CERTIFICATE-----')),
});
const webRoot = mkdtempSync(join(tmpdir(), 'wb-direct-https-'));
writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Whombat</title>');
let addresses: string[] = [];

const listener = new DirectListener({
  port: 0,
  hosts: ['127.0.0.1'],
  interfaces: ['lan'],
  // 127.0.0.1 on a LAN card: every connection here arrives on the local network.
  interfaceTable: () => ({
    eth0: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:01',
        internal: false,
        cidr: '127.0.0.0/8',
      },
    ],
  }),
  hostnames: () => [NAME],
  appliancePeerId: '12D3KooWBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBoxBox',
  development: false,
  log: silentLogger,
  admit: () => 'ok',
  onStream: async () => 'session',
  web: directWeb(webRoot),
  tls: async (name) => (name === NAME ? context : null),
  guard: new DirectGuard({ upgradeBurst: 1000, failures: 1000 }),
  httpsAddresses: () => addresses,
});
let port = 0;

beforeAll(async () => {
  await listener.listen();
  port = listener.boundPort();
});
afterAll(async () => {
  await listener.close();
  rmSync(webRoot, { recursive: true, force: true });
});

function plain(path: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () =>
        resolve({
          status: r.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          type: String(r.headers['content-type']),
        }),
      );
    }).on('error', reject);
  });
}

describe('pages only over HTTPS (LNK-10)', () => {
  it('a plain-HTTP page on the local network names the HTTPS addresses, and nothing else', async () => {
    addresses = ['https://quiet-otter-lamp.box.whombat.app/', `https://${NAME}/`];
    const res = await plain('/');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/^text\/plain/);
    expect(res.body).toContain('https://quiet-otter-lamp.box.whombat.app/');
    expect(res.body).toContain(`https://${NAME}/`);
    expect(res.body).not.toContain('<title>Whombat');
    // Any path of the app: the same sentence, no code.
    expect((await plain('/burrow/c/general')).body).not.toContain('<');
  });

  it('without any HTTPS address it says how to get one: the box’s screen before the claim, the app after', async () => {
    addresses = [];
    expect((await plain('/')).body).toBe(httpsOnlyText([]));
    expect(httpsOnlyText([])).toMatch(/screen/);
    expect(httpsOnlyText([], false)).toBe(httpsOnlyText([]));
    expect(httpsOnlyText([], true)).toMatch(/Whombat Link or Tailscale in the Whombat app/);
  });

  it('serves the page over HTTPS on the Tailscale name', async () => {
    const body = await new Promise<string>((resolve, reject) => {
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
          const chunks: Buffer[] = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve(Buffer.concat(chunks).toString()));
        },
      ).on('error', reject);
    });
    expect(body).toContain('<title>Whombat');
  });

  it('keeps the identity GET and the apps’ WebSocket on plain HTTP (LNK-11)', async () => {
    expect(JSON.parse((await plain('/v1/direct')).body)).toMatchObject({
      v: 1,
      appliance: expect.any(String),
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/direct`, [DIRECT_SUBPROTOCOL], {
      headers: { host: `127.0.0.1:${port}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.close();
  });
});

describe('httpsOnlyText', () => {
  it('names one, two or more addresses in plain words', () => {
    expect(httpsOnlyText(['https://a.example.com/'])).toBe('This Whombat opens at https://a.example.com/');
    expect(httpsOnlyText(['https://a.example.com/', 'https://b.example.com/'])).toBe(
      'This Whombat opens at https://a.example.com/ or https://b.example.com/',
    );
  });
});
