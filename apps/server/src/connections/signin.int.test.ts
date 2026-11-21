/**
 * Connections that sign in properly, against a real Postgres (docs/decisions/connection-signin.md): the flow rows and
 * the saving are the point. Signing in on the service's own page (SG-01…SG-05: Plex's PIN, the flow a sealed
 * `connection_pending` row bound to its account and used once, the token stored as the Plex token, a reconnect), a
 * second factor's challenge handed back sealed and opened again (SG-06), and Synology's two-step code asked once with
 * the trusted device kept in migration 0128's `remembered_enc` (SG-09).
 *
 * Stubs listen on 127.0.0.1 behind home-network addresses (the Vault's network seam): a plex.tv, a Plex Media Server,
 * a Synology DSM and a UniFi console's API.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AnyEndpoint, api, buildPath } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogConnections, connectionPending, vaultNetworks } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { openConnectionSecret } from './crypto';
import { useProvisionerForTests } from './provision/index';
import { needSecondFactor, refuseSignIn } from './provision/types';
import { useServiceLoginForTests } from './service-login/index';
import { plexServiceLogin } from './service-login/plex';

// The local network closed: private addresses need the home network list (VT-12, LN-01).
const t = useTestServer({ seed: true, app: true, env: { WHOMBAT_LOCAL_NETWORK: 'off' } });

const DSM_PASSWORD = 'dsm-Pw-4kQ7-canary';

const HOSTS: Record<string, string> = {
  'plextv.signin.test': '192.168.78.10',
  'pms.signin.test': '192.168.78.11',
  'dsm.signin.test': '192.168.78.12',
  'unifi.signin.test': '192.168.78.13',
};

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
type Json = Record<string, any>;

interface Seen {
  method: string;
  url: URL;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Stub {
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

/** A stub server: the handler answers `[status, json]` for each request, every request kept. */
async function stub(handler: (req: Seen) => [number, unknown]): Promise<Stub> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const one: Seen = {
        method: req.method ?? 'GET',
        url: new URL(req.url ?? '/', 'http://stub'),
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(one);
      const [status, body] = handler(one);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** plex.tv: PINs, approved one by one; the account's name. */
const plexTv = { pins: new Map<string, { code: string; token: string | null }>(), next: 100 };
/** The Plex Media Server: which account tokens it lets in. */
const pmsKnobs = { owners: new Set(['plex-account-token-1', 'plex-account-token-2']) };
/** Synology DSM: the trusted devices of the user `whombat`, whose two-step code is 246810. */
const dsmKnobs = { trusted: new Set<string>(), issued: 0, sessions: new Set<string>() };

let plex: Stub;
let pms: Stub;
let dsm: Stub;
let unifi: Stub;
const cookies: Record<'mara', string> = { mara: '' };

async function call(
  ep: AnyEndpoint,
  params: Record<string, string>,
  body?: unknown,
  who: keyof typeof cookies = 'mara',
): Promise<{ status: number; body: Json }> {
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...params })}`,
    headers: { cookie: cookies[who] },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  let parsed: Json = {};
  try {
    parsed = res.json();
  } catch {
    parsed = {};
  }
  return { status: res.statusCode, body: parsed };
}

async function rowOf(id: string) {
  const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  if (!row) throw new Error('no connection');
  return row;
}

/** Ends a connection's kept session, so its next use signs in again. */
async function endSession(id: string) {
  await t.services.db
    .update(catalogConnections)
    .set({ accessExpiresAt: new Date(t.services.clock().getTime() - 1000) })
    .where(eq(catalogConnections.id, id));
}

beforeAll(async () => {
  plex = await stub((req) => {
    const path = req.url.pathname;
    if (req.method === 'POST' && path === '/api/v2/pins') {
      const id = String(plexTv.next++);
      const code = `code${id}`;
      plexTv.pins.set(id, { code, token: null });
      return [201, { id: Number(id), code, expiresIn: 1800, authToken: null }];
    }
    const pin = /^\/api\/v2\/pins\/(\d+)$/.exec(path);
    if (req.method === 'GET' && pin) {
      const found = plexTv.pins.get(pin[1] ?? '');
      if (!found || req.url.searchParams.get('code') !== found.code) return [404, { errors: [] }];
      return [200, { id: Number(pin[1]), code: found.code, authToken: found.token }];
    }
    if (req.method === 'GET' && path === '/api/v2/user')
      return req.headers['x-plex-token'] ? [200, { username: 'mara', email: 'mara@example.com' }] : [401, {}];
    return [404, {}];
  });
  pms = await stub((req) => {
    const token = String(req.headers['x-plex-token'] ?? '');
    if (!pmsKnobs.owners.has(token)) return [401, { error: 'Unauthorized' }];
    return [200, { MediaContainer: { size: 1, Directory: [{ key: '1', title: 'Films' }] } }];
  });
  dsm = await stub((req) => {
    const q = req.url.searchParams;
    if (q.get('api') === 'SYNO.API.Auth' && q.get('method') === 'login') {
      const form = Object.fromEntries(new URLSearchParams(req.body));
      if (form.account !== 'whombat' || form.passwd !== DSM_PASSWORD)
        return [200, { error: { code: 400 }, success: false }];
      const sid = `sid-${++dsmKnobs.issued}`;
      if (form.device_id && dsmKnobs.trusted.has(form.device_id)) {
        dsmKnobs.sessions.add(sid);
        return [200, { data: { sid }, success: true }];
      }
      if (!form.otp_code)
        return [200, { error: { code: 403, errors: { types: [{ type: 'otp' }] } }, success: false }];
      if (form.otp_code !== '246810') return [200, { error: { code: 404 }, success: false }];
      const did = form.enable_device_token === 'yes' ? `did-${dsmKnobs.issued}` : undefined;
      if (did) dsmKnobs.trusted.add(did);
      dsmKnobs.sessions.add(sid);
      return [200, { data: { sid, ...(did ? { did } : {}) }, success: true }];
    }
    if (q.get('method') === 'logout') return [200, { success: true }];
    if (!dsmKnobs.sessions.has(q.get('_sid') ?? '')) return [200, { error: { code: 119 }, success: false }];
    return [200, { data: { hostname: 'nas', is_manager: true }, success: true }];
  });
  unifi = await stub((req) =>
    req.headers['x-api-key'] === 'unifi-key-1' ? [200, { applicationVersion: '9.4.19' }] : [401, {}],
  );
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      const address = HOSTS[host];
      if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    },
    dialAddress: (address) => (address.startsWith('192.168.78.') ? '127.0.0.1' : address),
    deadlineMs: 5000,
  });
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_signin_test',
    cidr: '192.168.78.0/24',
    ports: [plex.port, pms.port, dsm.port, unifi.port].sort((a, b) => a - b),
    note: 'Sign-in stubs',
    addedAt: t.services.clock(),
  });
  for (const who of ['mara'] as const) cookies[who] = (await sessionFor(t.services, IDS[who])).cookie;
  // Plex's own adapter, pointed at the stub plex.tv.
  useServiceLoginForTests('plex', plexServiceLogin({ plexTv: `http://plextv.signin.test:${plex.port}` }));
});

afterAll(async () => {
  useServiceLoginForTests('plex', null);
  useProvisionerForTests('unifi_network', null);
  await Promise.all([plex?.close(), pms?.close(), dsm?.close(), unifi?.close()]);
});

/** The PIN the last start made, approved on plex.tv with this account token. */
function approveLastPin(token: string) {
  const id = String(plexTv.next - 1);
  const pin = plexTv.pins.get(id);
  if (!pin) throw new Error('no PIN');
  pin.token = token;
}

describe('signing in on the service’s own page (SG-01…SG-05)', () => {
  const pmsUrl = () => `http://pms.signin.test:${pms.port}`;
  const start = (extra: Json = {}, who: 'mara' = 'mara') =>
    call(
      api.connections.startServiceLogin,
      {},
      { catalogId: 'plex', fields: { url: pmsUrl() }, access: 'read', ...extra },
      who,
    );
  const poll = (flowId: string, who: 'mara' = 'mara') =>
    call(api.connections.pollServiceLogin, { flowId }, undefined, who);
  let plexId = '';

  it('checks the address first, then starts Plex’s PIN in a flow bound to the account, sealed', async () => {
    const refused = await start({ fields: { url: 'http://10.9.9.9:32400' } });
    expect(refused.body.error.details.code).toBe('destination_refused');
    expect(plex.seen.filter((s) => s.method === 'POST')).toHaveLength(0);

    const res = await start();
    expect(res.status).toBe(200);
    const { loginUrl, flowId, pollEveryMs, userCode, expiresAt } = res.body;
    const pinCode = plexTv.pins.get(String(plexTv.next - 1))?.code ?? '';
    expect(loginUrl).toContain('https://app.plex.tv/auth#?clientID=whombat-');
    expect(loginUrl).toContain(`code=${pinCode}`);
    expect([pollEveryMs, userCode]).toEqual([2000, null]);
    expect(Date.parse(expiresAt) - t.services.clock().getTime()).toBeLessThanOrEqual(10 * 60_000);
    const create = plex.seen.find((s) => s.method === 'POST');
    expect(create?.headers['x-plex-product']).toBe('Whombat');
    expect(String(create?.headers['x-plex-client-identifier'])).toMatch(/^whombat-/);

    const [row] = await t.services.db
      .select()
      .from(connectionPending)
      .where(eq(connectionPending.id, flowId));
    expect(row?.signIn).toBe('service_login');
    expect(row?.stateEnc).not.toContain(pinCode);
    expect((await poll(flowId)).body).toEqual({ state: 'pending' });
  });

  it('stores Plex’s token as the Plex token at the level asked, once', async () => {
    const res = await start();
    approveLastPin('plex-account-token-1');
    const done = await poll(res.body.flowId);
    expect(done.body.state).toBe('connected');
    const c = done.body.connection;
    plexId = c.id;
    expect(c).toMatchObject({ catalogId: 'plex', signIn: 'token', access: 'read', status: 'active' });
    const row = await rowOf(plexId);
    expect(row.auth).toEqual({ type: 'header', name: 'X-Plex-Token', template: '{secret}' });
    expect(row.externalName).toBe('mara@example.com');
    expect(openConnectionSecret(t.services.custody, row.id, 'secret', row.secretEnc as string)).toBe(
      'plex-account-token-1',
    );
    expect(pms.seen.at(-1)?.headers['x-plex-token']).toBe('plex-account-token-1');
    // The token was answered once: the flow is used up.
    expect((await poll(res.body.flowId)).body).toEqual({ state: 'expired' });
  });

  it('reconnects by the connection, and says when the server didn’t accept the account', async () => {
    const notOwner = await start({ connectionId: plexId, fields: {} });
    approveLastPin('someone-elses-token');
    const failed = await poll(notOwner.body.flowId);
    expect(failed.body.state).toBe('failed');
    expect(failed.body.message).toContain('server’s owner');

    const before = await rowOf(plexId);
    const again = await start({ connectionId: plexId, fields: {} });
    approveLastPin('plex-account-token-2');
    const done = await poll(again.body.flowId);
    expect(done.body.state).toBe('connected');
    expect(done.body.connection.id).toBe(plexId);
    const row = await rowOf(plexId);
    expect(row.credentialVersion).toBe(before.credentialVersion + 1);
    expect(openConnectionSecret(t.services.custody, row.id, 'secret', row.secretEnc as string)).toBe(
      'plex-account-token-2',
    );
  });

  it('tells an older app’s sign in once for Plex to make a token', async () => {
    const res = await call(
      api.connections.create,
      {},
      {
        catalogId: 'plex',
        signIn: 'password',
        fields: { url: pmsUrl() },
        login: { account: 'mara@example.com', password: 'whatever' },
      },
    );
    expect(res.body.error.details).toMatchObject({ code: 'not_supported' });
    expect(res.body.error.message).toContain('Make a token instead.');
  });
});

describe('a second factor’s challenge comes back sealed (SG-06)', () => {
  it('hands the challenge back sealed with the ask, and opens it for the code', async () => {
    const challenges: (string | null)[] = [];
    useProvisionerForTests('unifi_network', async (input) => {
      challenges.push(input.challenge);
      if (!input.challenge) throw needSecondFactor('Enter the code UniFi just emailed you.', 'ubic-chal-1');
      if (input.code !== '100001') throw refuseSignIn('code', 'That code didn’t work.', null, 'ubic-chal-2');
      return { fields: {}, secret: 'unifi-key-1', limited: false, note: null };
    });
    const body = (login: Json) => ({
      catalogId: 'unifi_network',
      signIn: 'password',
      fields: { url: `http://unifi.signin.test:${unifi.port}` },
      login: { account: 'Mara', password: 'pw', ...login },
    });
    const ask = await call(api.connections.create, {}, body({}));
    expect(ask.body.error.details.code).toBe('second_factor_needed');
    const sealed = ask.body.error.details.challenge as string;
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain('ubic-chal-1');

    const wrong = await call(api.connections.create, {}, body({ code: '999999', challenge: sealed }));
    expect(wrong.body.error.details).toMatchObject({ code: 'sign_in_refused', reason: 'code' });
    const renewed = wrong.body.error.details.challenge as string;
    expect(renewed).toMatch(/^v1:/);

    // Another account's (any case is the same account) or a broken one is ignored: the sign-in starts fresh.
    await call(api.connections.create, {}, body({ account: 'pip', code: '100001', challenge: renewed }));
    const ok = await call(
      api.connections.create,
      {},
      body({ account: 'MARA', code: '100001', challenge: renewed }),
    );
    expect(ok.status).toBe(201);
    expect(challenges).toEqual([null, 'ubic-chal-1', null, 'ubic-chal-2']);
  });
});

describe('Synology asks for a two-step code once (SG-09)', () => {
  const dsmUrl = () => `http://dsm.signin.test:${dsm.port}`;
  const create = (extra: Json = {}) =>
    call(
      api.connections.create,
      {},
      {
        catalogId: 'synology',
        fields: { url: dsmUrl(), username: 'whombat' },
        secret: DSM_PASSWORD,
        ...extra,
      },
    );
  const logins = () =>
    dsm.seen
      .filter((s) => s.url.searchParams.get('method') === 'login')
      .map((s) => Object.fromEntries(new URLSearchParams(s.body)));
  let dsmId = '';

  it('asks for the code, refuses a wrong one, and keeps the device DSM trusts sealed', async () => {
    const ask = await create();
    expect(ask.status).toBe(409);
    expect(ask.body.error.details).toEqual({ code: 'second_factor_needed' });
    const wrong = await create({ code: '111111' });
    expect(wrong.body.error.details).toEqual({ code: 'sign_in_refused', reason: 'code' });
    const ok = await create({ code: '246 810' });
    expect(ok.status).toBe(201);
    dsmId = ok.body.connection.id;
    expect(logins().at(-1)).toMatchObject({
      otp_code: '246810',
      enable_device_token: 'yes',
      device_name: 'Whombat',
    });
    const row = await rowOf(dsmId);
    expect(row.rememberedEnc).toMatch(/^v1:/);
    expect(openConnectionSecret(t.services.custody, row.id, 'remembered', row.rememberedEnc as string)).toBe(
      `did-${dsmKnobs.issued}`,
    );
  });

  it('signs in again with the trusted device instead of a code', async () => {
    await endSession(dsmId);
    const res = await call(api.connections.recheck, { connectionId: dsmId });
    expect(res.body.connection.status).toBe('active');
    const last = logins().at(-1);
    expect(last).toMatchObject({ device_name: 'Whombat' });
    expect(last?.device_id).toMatch(/^did-/);
    expect(last).not.toHaveProperty('otp_code');
  });

  it('needs a new sign-in in Synology’s words when DSM forgot the device, and a new password with a code mends it', async () => {
    dsmKnobs.trusted.clear();
    await endSession(dsmId);
    const res = await call(api.connections.recheck, { connectionId: dsmId });
    expect(res.body.connection.status).toBe('needs_reauth');
    const row = await rowOf(dsmId);
    expect(row.checks[0]?.message).toContain('two-step code again');

    const noCode = await call(api.connections.setSecret, { connectionId: dsmId }, { secret: DSM_PASSWORD });
    expect(noCode.body.error.details).toEqual({ code: 'second_factor_needed' });
    // The old device isn't sent with the new password.
    expect(logins().at(-1)).not.toHaveProperty('device_id');
    const mended = await call(
      api.connections.setSecret,
      { connectionId: dsmId },
      { secret: DSM_PASSWORD, code: '246810' },
    );
    expect(mended.body.connection.status).toBe('active');
    const after = await rowOf(dsmId);
    expect(
      openConnectionSecret(t.services.custody, after.id, 'remembered', after.rememberedEnc as string),
    ).toBe(`did-${dsmKnobs.issued}`);
  });
});
