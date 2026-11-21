import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPublicAddress, OutboundError, outboundRequest } from './outbound';

describe('isPublicAddress', () => {
  it('refuses private, loopback, link-local, shared, multicast and reserved ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '64:ff9b::a9fe:a9fe',
      // Core's stricter rule (CT-98): cloud metadata, IPv4-compatible ::/96, 3fff::/20 documentation.
      '168.63.129.16',
      '::7f00:1',
      '3fff::1',
      'not an ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('accepts public addresses', () => {
    for (const ip of [
      '142.250.74.10',
      '8.8.8.8',
      '172.32.0.1',
      '2a00:1450:4001:82b::200a',
      '::ffff:8.8.8.8',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });
});

describe('outboundRequest', () => {
  let server: Server;
  let hits: string[] = [];
  let respond: (url: string) => { status: number; headers?: Record<string, string>; body?: string };

  beforeEach(async () => {
    hits = [];
    respond = () => ({ status: 200, body: 'ok' });
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      const r = respond(req.url ?? '');
      res.writeHead(r.status, r.headers ?? {});
      res.end(r.body ?? '');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const port = () => (server.address() as AddressInfo).port;

  it('refuses plain http, private IP literals and names that resolve to private addresses', async () => {
    for (const [url, reason] of [
      [`http://127.0.0.1:${port()}/x`, 'scheme'],
      [`https://127.0.0.1:${port()}/x`, 'private_address'],
      [`https://localhost:${port()}/x`, 'private_address'],
      ['https://169.254.169.254/latest/meta-data/', 'private_address'],
      ['https://[::1]/x', 'private_address'],
      ['https://[::ffff:7f00:1]/x', 'private_address'],
      ['file:///etc/passwd', 'scheme'],
      ['not a url', 'bad_url'],
    ] as const) {
      await expect(outboundRequest(url, { method: 'POST' }), url).rejects.toMatchObject({ reason });
    }
    expect(hits).toEqual([]);
  });

  it('checks the resolved address when it connects (a public-looking name pointing inside)', async () => {
    const resolve = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(
      outboundRequest(`https://push.example.test:${port()}/x`, { method: 'POST' }, { resolve }),
    ).rejects.toMatchObject({ reason: 'private_address' });
    const allowHost = (host: string) => host === 'fcm.googleapis.com';
    await expect(
      outboundRequest('https://evil.example/x', { method: 'POST' }, { allowHost }),
    ).rejects.toMatchObject({ reason: 'host_not_allowed' });
    expect(hits).toEqual([]);
  });

  it('with the test-only allowance: sends, returns redirects without following them, caps the body', async () => {
    const allow = { allowPrivate: true };
    const ok = await outboundRequest(`http://127.0.0.1:${port()}/x`, { method: 'POST', body: 'hi' }, allow);
    expect(ok.status).toBe(200);
    expect(ok.body.toString()).toBe('ok');

    respond = (url) =>
      url === '/r' ? { status: 302, headers: { location: '/elsewhere' } } : { status: 200 };
    const redirected = await outboundRequest(`http://127.0.0.1:${port()}/r`, { method: 'GET' }, allow);
    expect(redirected.status).toBe(302);
    expect(hits).toEqual(['/x', '/r']);

    respond = () => ({ status: 200, body: 'x'.repeat(5000) });
    await expect(
      outboundRequest(`http://127.0.0.1:${port()}/big`, { method: 'GET' }, { ...allow, maxBytes: 1000 }),
    ).rejects.toSatisfy((err) => err instanceof OutboundError && err.reason === 'too_large');
  });
});

describe('per-call destination rules, deadlines and caps (docs/decisions/vault.md VT-10)', () => {
  let server: Server;
  let hits = 0;
  beforeEach(async () => {
    hits = 0;
    server = createServer((req, res) => {
      hits++;
      if (req.url === '/trickle') {
        // A byte every 50 ms: the idle timeout never fires, the total deadline does.
        res.writeHead(200);
        const timer = setInterval(() => res.write('.'), 50);
        res.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('z'.repeat(1000));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = () => (server.address() as AddressInfo).port;
  const checked: string[][] = [];
  const destination = {
    schemes: ['http:', 'https:'] as const,
    check: (_host: string, addresses: readonly string[]) => {
      checked.push([...addresses]);
      if (addresses.some((a) => a !== '192.168.50.7'))
        throw new OutboundError('destination', 'This Vault entry’s address isn’t allowed any more.');
    },
  };
  const seam = {
    resolve: async () => [{ address: '192.168.50.7', family: 4 }],
    dialAddress: (a: string) => (a === '192.168.50.7' ? '127.0.0.1' : a),
  };

  it('checks every resolved address with the caller’s rule, then dials one of exactly those', async () => {
    const ok = await outboundRequest(
      `http://home.test:${port()}/x`,
      { method: 'GET' },
      { destination, ...seam },
    );
    expect(ok.status).toBe(200);
    expect(checked.at(-1)).toEqual(['192.168.50.7']);
    const rebound = {
      resolve: async () => [
        { address: '192.168.50.7', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      dialAddress: seam.dialAddress,
    };
    await expect(
      outboundRequest(`http://home.test:${port()}/x`, { method: 'GET' }, { destination, ...rebound }),
    ).rejects.toMatchObject({ reason: 'destination', refused: true });
    // An IP literal is checked before anything connects.
    await expect(
      outboundRequest(`http://127.0.0.1:${port()}/x`, { method: 'GET' }, { destination }),
    ).rejects.toMatchObject({ reason: 'destination' });
    expect(hits).toBe(1);
  });

  it('stops at the total deadline, keeps a truncated answer, and caps the request body', async () => {
    const started = Date.now();
    await expect(
      outboundRequest(
        `http://home.test:${port()}/trickle`,
        { method: 'GET' },
        { destination, ...seam, deadlineMs: 300, timeoutMs: 5000 },
      ),
    ).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    const cut = await outboundRequest(
      `http://home.test:${port()}/x`,
      { method: 'GET' },
      { destination, ...seam, truncateAt: 100 },
    );
    expect(cut.truncated).toBe(true);
    expect(cut.body.length).toBe(100);
    await expect(
      outboundRequest(
        `http://home.test:${port()}/x`,
        { method: 'POST', body: 'b'.repeat(2000) },
        { destination, ...seam, maxRequestBytes: 1000 },
      ),
    ).rejects.toMatchObject({ reason: 'too_large' });
  });
});
