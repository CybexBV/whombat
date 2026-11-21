/**
 * Unauthenticated probes (connections-setup.md CS-13, CS-14): the certificate is read, not enforced, on the home network
 * only; anywhere else it must verify or nothing is written. No redirects, a 64 KiB answer, a short deadline.
 */
import { X509Certificate } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SELF_SIGNED_CERT_A, SELF_SIGNED_KEY_A } from '../test/self-signed';
import { OutboundError, type OutboundPolicy } from './outbound';
import { PROBE_BODY_MAX, type ProbeDial, probeRequest } from './probe';

const PIN_A = new X509Certificate(SELF_SIGNED_CERT_A).fingerprint256;

let tlsServer: HttpsServer;
let plain: HttpServer;
let tlsPort = 0;
let plainPort = 0;
/** Requests the https server saw. */
let seen = 0;

beforeAll(async () => {
  tlsServer = createHttpsServer({ cert: SELF_SIGNED_CERT_A, key: SELF_SIGNED_KEY_A }, (req, res) => {
    seen++;
    res.writeHead(200, { 'content-type': 'application/json', server: 'pve-api-daemon/3.0' });
    res.end(JSON.stringify({ data: [{ realm: 'pve', type: 'pve' }], host: req.headers.host ?? null }));
  });
  plain = createHttpServer((req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { location: 'http://elsewhere.test/' });
      res.end();
    } else if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(PROBE_BODY_MAX * 3));
    } else if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 2_000).unref();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'Home Assistant', method: req.method }));
    }
  });
  await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
  tlsPort = (tlsServer.address() as AddressInfo).port;
  plainPort = (plain.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const s of [tlsServer, plain]) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** pve.home.test resolves to `address` (a home-network address by default); every address dials the local servers. */
function policy(address = '192.168.50.10', extra: Partial<OutboundPolicy> = {}): OutboundPolicy {
  return {
    destination: { schemes: ['http:', 'https:'], check: () => {} },
    resolve: async () => [{ address, family: 4 }],
    deadlineMs: 2_000,
    ...extra,
  };
}

/** 8006 is the https server, 8123 the http one; anything else has nothing listening. */
const dial: ProbeDial = (_address, port) =>
  port === 8006
    ? { address: '127.0.0.1', port: tlsPort }
    : port === 8123
      ? { address: '127.0.0.1', port: plainPort }
      : null;

async function refusal(promise: Promise<unknown>): Promise<OutboundError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OutboundError);
  return err as OutboundError;
}

describe('probes over https (CS-13)', () => {
  it('reads a self-signed certificate on the home network and answers', async () => {
    const res = await probeRequest(
      'https://pve.home.test:8006/api2/json/access/domains',
      { method: 'GET' },
      policy(),
      { dial },
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ data: [{ type: 'pve' }], host: 'pve.home.test:8006' });
    expect(res.headers.server).toBe('pve-api-daemon/3.0');
    expect(res.certificate).toEqual({ sha256: PIN_A, trusted: false });
    expect(res.certificate?.sha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('reads it at a home-network IP literal too, and ignores a pin in the policy', async () => {
    const res = await probeRequest(
      'https://192.168.50.10:8006/',
      { method: 'GET' },
      policy(undefined, { pinnedCertSha256: 'AB'.repeat(32) }),
      { dial },
    );
    expect(res.certificate).toEqual({ sha256: PIN_A, trusted: false });
  });

  it('refuses an unverified certificate on a public address before writing the request', async () => {
    const before = seen;
    const named = await refusal(
      probeRequest('https://pve.home.test:8006/', { method: 'GET' }, policy('142.250.74.10'), { dial }),
    );
    expect(named.reason).toBe('untrusted_certificate');
    const literal = await refusal(
      probeRequest('https://142.250.74.10:8006/', { method: 'GET' }, policy(), { dial }),
    );
    expect(literal.reason).toBe('untrusted_certificate');
    expect(seen).toBe(before);
  });

  it('says trusted when chain and host name verify, and not when only the chain does', async () => {
    const defaults = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...defaults, SELF_SIGNED_CERT_A]);
    try {
      const named = await probeRequest('https://pve.home.test:8006/', { method: 'GET' }, policy(), { dial });
      expect(named.certificate).toEqual({ sha256: PIN_A, trusted: true });
      // Verified, so a public address may answer too.
      const pub = await probeRequest(
        'https://pve.home.test:8006/',
        { method: 'GET' },
        policy('142.250.74.10'),
        { dial },
      );
      expect(pub.certificate?.trusted).toBe(true);
      // The certificate names pve.home.test, not this address.
      const literal = await probeRequest('https://192.168.50.10:8006/', { method: 'GET' }, policy(), {
        dial,
      });
      expect(literal.certificate?.trusted).toBe(false);
    } finally {
      tls.setDefaultCACertificates(defaults);
    }
  });
});

describe('probes over http (CS-13, CS-14)', () => {
  it('answers without a certificate, with the probe’s method and body', async () => {
    const res = await probeRequest(
      'http://ha.home.test:8123/manifest.json',
      { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
      policy(),
      { dial },
    );
    expect(res).toMatchObject({ status: 200, certificate: null });
    expect(JSON.parse(res.body)).toEqual({ name: 'Home Assistant', method: 'POST' });
  });

  it('follows no redirect', async () => {
    const res = await probeRequest('http://ha.home.test:8123/moved', { method: 'GET' }, policy(), { dial });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://elsewhere.test/');
  });

  it('keeps 64 KiB of a long answer', async () => {
    const res = await probeRequest('http://ha.home.test:8123/big', { method: 'GET' }, policy(), { dial });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(PROBE_BODY_MAX);
  });

  it('gives up at the deadline, and on a port where nothing listens', async () => {
    const started = Date.now();
    const slow = await refusal(
      probeRequest(
        'http://ha.home.test:8123/slow',
        { method: 'GET' },
        policy(undefined, { deadlineMs: 300 }),
        {
          dial,
        },
      ),
    );
    expect(slow.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(
      (await refusal(probeRequest('http://ha.home.test:9/', { method: 'GET' }, policy(), { dial }))).reason,
    ).toBe('network');
  });

  it('keeps the policy’s destination rule', async () => {
    const before = seen;
    const refused = policy(undefined, {
      destination: {
        schemes: ['http:', 'https:'],
        check: () => {
          throw new OutboundError('destination', 'not allowed');
        },
      },
    });
    expect(
      (await refusal(probeRequest('https://pve.home.test:8006/', { method: 'GET' }, refused, { dial })))
        .reason,
    ).toBe('destination');
    expect(
      (await refusal(probeRequest('https://192.168.50.10:8006/', { method: 'GET' }, refused, { dial })))
        .reason,
    ).toBe('destination');
    expect(seen).toBe(before);
  });
});
