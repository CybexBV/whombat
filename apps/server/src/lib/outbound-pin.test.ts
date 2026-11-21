/**
 * Certificate pinning for home-network services with a self-signed certificate (connections-catalog.md CX-60, Proxmox):
 * `pinnedCertSha256` accepts exactly the pinned leaf certificate, refuses any other before the request is written,
 * and holds only for non-public addresses over https.
 */
import { X509Certificate } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SELF_SIGNED_CERT_A, SELF_SIGNED_CERT_B, SELF_SIGNED_KEY_A } from '../test/self-signed';
import {
  normalisedPin,
  OutboundError,
  type OutboundPolicy,
  outboundRequest,
  presentedCertSha256,
} from './outbound';

const CERT_A = SELF_SIGNED_CERT_A;
const KEY_A = SELF_SIGNED_KEY_A;
const CERT_B = SELF_SIGNED_CERT_B;

const PIN_A = new X509Certificate(CERT_A).fingerprint256;
const PIN_B = new X509Certificate(CERT_B).fingerprint256;

let server: Server;
let port = 0;
let seen = 0;

beforeAll(async () => {
  server = createServer({ cert: CERT_A, key: KEY_A }, (req, res) => {
    seen++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { version: '8.2' }, auth: req.headers.authorization ?? null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** pve.home.test resolves to `address` (a home-network address by default) and is dialled at the local server. */
function policy(pin: string | undefined, address = '192.168.50.10'): OutboundPolicy {
  return {
    destination: { schemes: ['http:', 'https:'], check: () => {} },
    resolve: async () => [{ address, family: 4 }],
    dialAddress: () => '127.0.0.1',
    timeoutMs: 5_000,
    ...(pin !== undefined ? { pinnedCertSha256: pin } : {}),
  };
}

const url = () => `https://pve.home.test:${port}/api2/json/version`;
const init = { method: 'GET', headers: { authorization: 'PVEAPIToken=root@pam!whombat=secret' } };

async function refusal(promise: Promise<unknown>): Promise<OutboundError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OutboundError);
  return err as OutboundError;
}

describe('pinned certificates (CX-60)', () => {
  it('accepts the pinned self-signed certificate', async () => {
    const res = await outboundRequest(url(), init, policy(PIN_A));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString())).toMatchObject({ data: { version: '8.2' } });
  });

  it('takes the fingerprint in either case, with or without colons', async () => {
    const res = await outboundRequest(url(), init, policy(PIN_A.replace(/:/g, '').toLowerCase()));
    expect(res.status).toBe(200);
    expect(normalisedPin(PIN_A.toLowerCase())).toBe(PIN_A.replace(/:/g, ''));
  });

  it('refuses any other certificate before the request (and its token) is written', async () => {
    const before = seen;
    const err = await refusal(outboundRequest(url(), init, policy(PIN_B)));
    expect(err.reason).toBe('certificate');
    expect(seen).toBe(before);
  });

  it('still verifies certificates normally without a pin: a self-signed one is untrusted (CX-D33)', async () => {
    const before = seen;
    const err = await refusal(outboundRequest(url(), init, policy(undefined)));
    expect(err.reason).toBe('untrusted_certificate');
    expect(seen).toBe(before);
  });

  it('holds only for home-network addresses', async () => {
    const before = seen;
    const err = await refusal(outboundRequest(url(), init, policy(PIN_A, '142.250.74.10')));
    expect(err.reason).toBe('destination');
    const literal = await refusal(outboundRequest('https://142.250.74.10/', init, policy(PIN_A)));
    expect(literal.reason).toBe('destination');
    expect(seen).toBe(before);
  });

  it('needs https and a real fingerprint', async () => {
    expect(
      (await refusal(outboundRequest(`http://pve.home.test:${port}/`, init, policy(PIN_A)))).reason,
    ).toBe('scheme');
    expect((await refusal(outboundRequest(url(), init, policy('AB:CD')))).reason).toBe('bad_url');
  });
});

describe('the presented certificate (CX-D33)', () => {
  it('reads the fingerprint a home-network server presents, without sending a request', async () => {
    const before = seen;
    expect(await presentedCertSha256(url(), policy(undefined))).toBe(PIN_A);
    expect(seen).toBe(before);
  });

  it('ignores a pin in the policy: it reads what is there', async () => {
    expect(await presentedCertSha256(url(), policy(PIN_B))).toBe(PIN_A);
  });

  it('holds only for home-network addresses over https', async () => {
    expect((await refusal(presentedCertSha256(url(), policy(undefined, '142.250.74.10')))).reason).toBe(
      'destination',
    );
    expect((await refusal(presentedCertSha256('https://142.250.74.10/', policy(undefined)))).reason).toBe(
      'destination',
    );
    expect(
      (await refusal(presentedCertSha256(`http://pve.home.test:${port}/`, policy(undefined)))).reason,
    ).toBe('scheme');
  });
});
