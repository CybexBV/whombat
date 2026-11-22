/**
 * The new connections end to end (docs/decisions/connections-more.md CM-10…CM-18, connections-more-server.md): connected
 * over REST and used by an agent through `/mcp` against a real Postgres, because what they add lives in it — a session
 * kept sealed in the connection's row, renewed and signed out across calls and marked `needs_reauth` when its password
 * stops working; a socket connection's `call` tool synced, hashed and decided per method through the pipeline, with
 * approvals for what asks; reads by a query parameter deciding the tier.
 *
 * The services are in-process fakes behind home-network addresses (the Vault's network seam): a Pi-hole v6 and a
 * SABnzbd over http, a TrueNAS over wss with the self-signed certificate pinned, an ESPHome Device Builder over ws, and
 * (desk-found.md NS-01…NS-04) a Synology DSM and a QNAP over http, built from the vendors' documentation: a session by
 * form, the password in base64 and the XML token, an ended session or a refusal in a 200, sign in again once.
 */
import { type AnyEndpoint, api, buildPath } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nasPlaceDriver } from '../backup-places/nas/transport';
import { catalogConnections, connectionTools, vaultNetworks } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { signingOnlyAs } from './bound-targets';
import { ConnectionChangedError, callTarget } from './call-target';
import { credentialFor } from './credentials';
import { type Stub, type StubReply, type StubRequest, startStub } from './provision/testing-home';
import { sessionAccess } from './session';
import { FAKE_CERT_SHA256, type FakeSocketServer, fakeDeviceBuilder, fakeTrueNas } from './socket/testing';
import type { CatalogConnectionRow } from './types';

const t = useTestServer({ seed: true, listen: true });

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
type Json = Record<string, any>;

const NET = '192.168.93';
const HOSTS: Record<string, string> = {
  'pihole.more.test': `${NET}.10`,
  'nas.more.test': `${NET}.20`,
  'old-nas.more.test': `${NET}.21`,
  'esphome.more.test': `${NET}.30`,
  'sab.more.test': `${NET}.40`,
  'syno.more.test': `${NET}.50`,
  'qnap.more.test': `${NET}.51`,
  // Other addresses for the same fakes: where a connection is repointed while work bound to the first one waits.
  'pihole-other.more.test': `${NET}.12`,
  'qnap-other.more.test': `${NET}.52`,
};

const APP_PASSWORD = 'pihole-app-password-Qx7nV2pL';
const NAS_KEY = `1-${'k'.repeat(64)}`;
const SAB_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

let mara = '';

async function rest(ep: AnyEndpoint, params: Record<string, string>, body?: unknown) {
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...params })}`,
    headers: { cookie: mara },
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

const connect = (body: Record<string, unknown>) => rest(api.connections.create, {}, { ...body });

async function turn(): Promise<TestMcp> {
  const d = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing, {
    onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
  });
  return mcpClient(t.baseUrl, d.token);
}

async function callTool(handle: string, tool: string, args: Record<string, unknown>): Promise<Json> {
  const mcp = await turn();
  try {
    const res = await mcp.client.callTool({
      name: 'connection_call',
      arguments: { connection: handle, tool, arguments: args },
    });
    return (res.structuredContent ?? {}) as Json;
  } finally {
    await mcp.close();
  }
}

async function setTier(connectionId: string, tier: 'can' | 'ask' | 'off') {
  await t.services.db
    .update(connectionTools)
    .set({ tier })
    .where(eq(connectionTools.connectionId, connectionId));
}

/* The fakes ---------------------------------------------------------------------------------------------------------- */

/** A Pi-hole v6: sessions by number, any of them expired or the app password changed on demand. */
const pi = { password: APP_PASSWORD, next: 1, live: new Set<string>() };
function fakePihole(req: StubRequest): StubReply {
  if (req.path === '/api/auth' && req.method === 'POST') {
    if (req.json()?.password !== pi.password)
      return { status: 401, json: { session: { valid: false, sid: null, message: 'password incorrect' } } };
    const sid = `sid-${pi.next++}`;
    pi.live.add(sid);
    return { json: { session: { valid: true, totp: false, sid, csrf: 'x', validity: 1800 }, took: 0.01 } };
  }
  const sid = String(req.headers['x-ftl-sid'] ?? '');
  if (!pi.live.has(sid))
    return { status: 401, json: { error: { key: 'unauthorized', message: 'Unauthorized' } } };
  if (req.path === '/api/auth' && req.method === 'DELETE') {
    pi.live.delete(sid);
    return { status: 204 };
  }
  if (req.path === '/api/info/version')
    return { json: { version: { core: { local: { version: 'v6.2' } } } } };
  if (req.path === '/api/stats/summary') return { json: { queries: { total: 1200, blocked: 300 } } };
  return { status: 404, json: { error: { key: 'not_found' } } };
}

/** A SABnzbd: everything through `GET /api?mode=…&apikey=…`. */
function fakeSabnzbd(req: StubRequest): StubReply {
  if (req.path !== '/api') return { status: 404 };
  if (req.query.get('apikey') !== SAB_KEY)
    return { status: 403, json: { status: false, error: 'API Key Incorrect' } };
  const mode = req.query.get('mode');
  if (mode === 'version') return { json: { version: '4.5.1' } };
  if (mode === 'queue') return { json: { queue: { status: 'Idle', slots: [] } } };
  return { json: { status: true } };
}

/** A Synology DSM 7: `SYNO.API.Auth` login by form, sessions by number in `_sid`, codes in a 200 (NS-01, NS-03). */
const syno = { password: APP_PASSWORD, next: 1, live: new Set<string>(), code: 0 };
function fakeSynology(req: StubRequest): StubReply {
  if (req.path !== '/webapi/entry.cgi') return { status: 404 };
  const q = req.query;
  if (q.get('api') === 'SYNO.API.Auth' && q.get('method') === 'login') {
    const form = req.form();
    if (req.method !== 'POST') return { json: { error: { code: 101 }, success: false } };
    if (syno.code) return { json: { error: { code: syno.code }, success: false } };
    if (form.account !== 'whombat' || form.passwd !== syno.password)
      return { json: { error: { code: 400 }, success: false } };
    const sid = `syno-${syno.next++}`;
    syno.live.add(sid);
    return { json: { data: { sid }, success: true } };
  }
  const sid = q.get('_sid') ?? '';
  if (q.get('api') === 'SYNO.API.Auth' && q.get('method') === 'logout') {
    syno.live.delete(sid);
    return { json: { success: true } };
  }
  // DSM answers an ended session 200 with error 119 (“SID not found”).
  if (!syno.live.has(sid)) return { json: { error: { code: 119 }, success: false } };
  if (q.get('api') === 'SYNO.FileStation.Info')
    return { json: { data: { hostname: 'nas', is_manager: true }, success: true } };
  if (q.get('api') === 'SYNO.Core.System' && q.get('method') === 'info')
    return { json: { data: { model: 'DS923+', temperature: 41 }, success: true } };
  return { json: { error: { code: 102 }, success: false } };
}

/** A QNAP QTS 5: `authLogin.cgi` by form with the password in base64, the XML `authSid` in `sid` (NS-01, NS-03). */
const qn = { password: APP_PASSWORD, next: 1, live: new Set<string>() };
function fakeQnap(req: StubRequest): StubReply {
  const xml = (inner: string): StubReply => ({
    headers: { 'content-type': 'text/xml' },
    body: `<?xml version="1.0" encoding="UTF-8" ?>\n<QDocRoot version="1.0">${inner}</QDocRoot>`,
  });
  if (req.path === '/cgi-bin/authLogin.cgi' && req.method === 'POST') {
    const form = req.form();
    if (form.user !== 'whombat' || Buffer.from(form.pwd ?? '', 'base64').toString('utf8') !== qn.password)
      return xml('<authPassed><![CDATA[0]]></authPassed><errorValue><![CDATA[-1]]></errorValue>');
    const sid = `qsid${qn.next++}`;
    qn.live.add(sid);
    return xml(`<authPassed><![CDATA[1]]></authPassed><authSid><![CDATA[${sid}]]></authSid>`);
  }
  const sid = req.query.get('sid') ?? '';
  if (req.path === '/cgi-bin/authLogout.cgi') {
    qn.live.delete(sid);
    return xml('<authPassed><![CDATA[0]]></authPassed>');
  }
  if (req.path === '/cgi-bin/filemanager/utilRequest.cgi')
    return { json: { status: qn.live.has(sid) ? 1 : 3 } };
  // QTS answers an ended session 200 with authPassed 0.
  if (!qn.live.has(sid)) return xml('<authPassed><![CDATA[0]]></authPassed>');
  if (req.path === '/cgi-bin/management/manaRequest.cgi')
    return xml('<func><ownContent><root><cpu_usage><![CDATA[12 %]]></cpu_usage></root></ownContent></func>');
  return { status: 404 };
}

let pihole: Stub;
let sab: Stub;
let synology: Stub;
let qnap: Stub;
let nas: FakeSocketServer;
let oldNas: FakeSocketServer;
let esphome: FakeSocketServer;

beforeAll(async () => {
  pihole = await startStub(fakePihole);
  sab = await startStub(fakeSabnzbd);
  synology = await startStub(fakeSynology);
  qnap = await startStub(fakeQnap);
  nas = await fakeTrueNas({
    apiKey: NAS_KEY,
    tls: true,
    methods: {
      'pool.query': () => [{ id: 1, name: 'tank', status: 'ONLINE', healthy: true }],
      'pool.export': () => null,
    },
  });
  oldNas = await fakeTrueNas({ apiKey: NAS_KEY, tls: true, missing: true });
  esphome = await fakeDeviceBuilder();
  const port = (url: string) => Number(new URL(url).port);
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      const address = HOSTS[host];
      if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    },
    dialAddress: (address) => (address.startsWith(`${NET}.`) ? '127.0.0.1' : address),
    deadlineMs: 5000,
  });
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_connections_more',
    cidr: `${NET}.0/24`,
    ports: [
      port(pihole.url),
      port(sab.url),
      port(synology.url),
      port(qnap.url),
      nas.port,
      oldNas.port,
      esphome.port,
    ].sort((a, b) => a - b),
    note: 'More connections fakes',
    addedAt: t.services.clock(),
  });
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
  await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'can' });
});

afterAll(async () => {
  await Promise.all([
    pihole?.close(),
    sab?.close(),
    synology?.close(),
    qnap?.close(),
    nas?.close(),
    oldNas?.close(),
    esphome?.close(),
  ]);
});

const at = (server: { url: string }, host: string) => server.url.replace('127.0.0.1', host);

async function rowOf(id: string): Promise<CatalogConnectionRow> {
  const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  if (!row) throw new Error('no connection');
  return row;
}

/**
 * Points the connection at `url` as a new sign-in would (another address, its credential's version bumped) with its
 * session due, so the next credential signs in; returns what puts it back.
 */
async function repoint(row: CatalogConnectionRow, url: string): Promise<() => Promise<void>> {
  await t.services.db
    .update(catalogConnections)
    .set({
      baseUrl: url,
      fields: { ...row.fields, url },
      credentialVersion: row.credentialVersion + 1,
      accessExpiresAt: new Date(Date.now() - 1000),
    })
    .where(eq(catalogConnections.id, row.id));
  return async () => {
    await t.services.db
      .update(catalogConnections)
      .set({
        baseUrl: row.baseUrl,
        fields: row.fields,
        credentialVersion: row.credentialVersion,
        accessTokenEnc: row.accessTokenEnc,
        accessExpiresAt: row.accessExpiresAt,
      })
      .where(eq(catalogConnections.id, row.id));
  };
}

/* Pi-hole: a session (CM-10…CM-12) ------------------------------------------------------------------------------------ */

describe('a session sign-in (CM-10…CM-12)', () => {
  let id = '';

  it('signs in for the check and keeps that session, sealed', async () => {
    const res = await connect({
      catalogId: 'pihole',
      fields: { url: at(pihole, 'pihole.more.test') },
      secret: APP_PASSWORD,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    id = res.body.connection.id;
    expect(res.body.connection.checks.find((c: Json) => c.id === 'credential')).toMatchObject({
      state: 'ok',
    });
    expect(pihole.calls('POST /api/auth')).toHaveLength(1);
    expect(pihole.calls('GET /api/info/version')[0]?.headers['x-ftl-sid']).toBe('sid-1');
    const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
    expect(row?.accessTokenEnc).toBeTruthy();
    expect(row?.accessTokenEnc).not.toContain('sid-1');
    expect(row?.accessExpiresAt).toBeInstanceOf(Date);
  });

  it('calls with the kept session, and signs in again once when it has expired, signing the old one out', async () => {
    const first = await callTool('pihole', 'request', { method: 'GET', path: '/api/stats/summary' });
    expect(first).toMatchObject({ status: 'ok', httpStatus: 200 });
    expect(pihole.calls('POST /api/auth')).toHaveLength(1);

    pi.live.delete('sid-1');
    const again = await callTool('pihole', 'request', { method: 'GET', path: '/api/stats/summary' });
    expect(again).toMatchObject({ status: 'ok', httpStatus: 200 });
    expect(pihole.calls('POST /api/auth')).toHaveLength(2);
    expect(pihole.calls('GET /api/stats/summary').map((r) => r.headers['x-ftl-sid'])).toEqual([
      'sid-1',
      'sid-1',
      'sid-2',
    ]);
    // The replaced session is signed out in the background (sid-1 had expired: the fake says 401, which is fine).
    await vi.waitFor(() => expect(pihole.calls('DELETE /api/auth').length).toBeGreaterThan(0));
    expect(JSON.stringify(again)).not.toContain('sid-2');
  });

  it('signs in nowhere, and writes nothing, for a call bound to it before it was given another address', async () => {
    const asked = await rowOf(id);
    const checked = callTarget(asked);
    const other = at(pihole, 'pihole-other.more.test');
    // The person points it at another Pi-hole while a call bound to the first waits, and its session is due.
    const restore = await repoint(asked, other);
    try {
      const moved = await rowOf(id);
      const sent = pihole.requests.length;
      // The row it was asked with or the row as it is now: neither signs in anywhere.
      for (const row of [asked, moved])
        await expect(
          signingOnlyAs({ [id]: checked }, () => credentialFor(t.services, row)),
        ).rejects.toBeInstanceOf(ConnectionChangedError);
      // The sign-in itself reads the connection again and refuses before it asks.
      await expect(
        signingOnlyAs({ [id]: checked }, () => sessionAccess(t.services, asked, { force: true })),
      ).rejects.toBeInstanceOf(ConnectionChangedError);
      expect(pihole.requests.length).toBe(sent);
      expect(await rowOf(id)).toMatchObject({ status: 'active', accessTokenEnc: moved.accessTokenEnc });
      // Not bound to the first, the connection signs in where it goes now.
      await credentialFor(t.services, moved);
      expect(pihole.calls('POST /api/auth').at(-1)?.headers.host).toContain('pihole-other.more.test');
    } finally {
      await restore();
    }
  });

  it('marks the connection as needing a new password when Pi-hole refuses it', async () => {
    pi.password = 'changed-in-pihole';
    pi.live.clear();
    const refused = await callTool('pihole', 'request', { method: 'GET', path: '/api/stats/summary' });
    expect(refused.status).toBe('failed');
    expect(refused.reason).toBe('needs_reauth');
    const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
    expect(row).toMatchObject({
      status: 'needs_reauth',
      reauthReason: 'token_invalid',
      accessTokenEnc: null,
    });
    expect(row?.checks[0]?.message).toMatch(/new password/i);
    pi.password = APP_PASSWORD;
  });
});

/* Synology DSM and QNAP: the session sign-in grown (NS-01…NS-04) ----------------------------------------------------- */

describe('Synology DSM: a session by form, an ended one told in a 200 (NS-01…NS-04)', () => {
  let id = '';
  const info = {
    method: 'GET',
    path: '/webapi/entry.cgi',
    query: { api: 'SYNO.Core.System', version: '1', method: 'info' },
  };

  it('signs in with a form for the check, the password kept out of the address, the session as _sid', async () => {
    const res = await connect({
      catalogId: 'synology',
      fields: { url: at(synology, 'syno.more.test'), username: 'whombat' },
      secret: APP_PASSWORD,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    id = res.body.connection.id;
    const [login] = synology.calls('POST /webapi/entry.cgi');
    expect(login?.form()).toMatchObject({ account: 'whombat', passwd: APP_PASSWORD });
    expect(login?.query.get('passwd')).toBeNull();
    const check = synology
      .calls('GET /webapi/entry.cgi')
      .find((r) => r.query.get('api') === 'SYNO.FileStation.Info');
    expect(check?.query.get('_sid')).toBe('syno-1');
  });

  it('reads at once, and signs in again once when DSM says the session ended', async () => {
    await setTier(id, 'ask');
    expect(await callTool('synology', 'request', info)).toMatchObject({ status: 'ok', httpStatus: 200 });
    syno.live.clear();
    const again = await callTool('synology', 'request', info);
    expect(again).toMatchObject({ status: 'ok', httpStatus: 200 });
    expect(JSON.stringify(again)).toContain('DS923+');
    expect(synology.calls('POST /webapi/entry.cgi')).toHaveLength(2);
    // A method that writes asks first (NS-05).
    const restart = await callTool('synology', 'request', {
      method: 'GET',
      path: '/webapi/entry.cgi',
      query: { api: 'SYNO.Core.System', version: '1', method: 'reboot' },
    });
    expect(restart.status).toBe('pending_approval');
  });

  it('needs the person when DSM says the account is switched off, in plain words', async () => {
    syno.code = 401;
    syno.live.clear();
    const refused = await callTool('synology', 'request', info);
    expect(refused).toMatchObject({ status: 'failed', reason: 'needs_reauth' });
    const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
    expect(row?.status).toBe('needs_reauth');
    expect(row?.checks[0]?.message).toMatch(/switched off/i);
    syno.code = 0;
  });
});

describe('QNAP: a base64 password and an XML session (NS-01…NS-04)', () => {
  const sysinfo = {
    method: 'GET',
    path: '/cgi-bin/management/manaRequest.cgi',
    query: { subfunc: 'sysinfo', hd: 'no' },
  };

  it('says a refused password in QNAP’s words, then connects with the right one', async () => {
    const wrong = await connect({
      catalogId: 'qnap',
      fields: { url: at(qnap, 'qnap.more.test'), username: 'whombat' },
      secret: 'not-the-password',
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.details.code).toBe('check_failed');
    expect(wrong.body.error.message).toMatch(/QNAP refused the account name or password/);
    const res = await connect({
      catalogId: 'qnap',
      fields: { url: at(qnap, 'qnap.more.test'), username: 'whombat' },
      secret: APP_PASSWORD,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const login = qnap.calls('POST /cgi-bin/authLogin.cgi').at(-1);
    expect(login?.form().pwd).toBe(Buffer.from(APP_PASSWORD).toString('base64'));
    expect(qnap.calls('GET /cgi-bin/filemanager/utilRequest.cgi')[0]?.query.get('sid')).toBe('qsid1');
  });

  it('signs in nowhere for work bound to it before it was given another address', async () => {
    const [found] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.catalogId, 'qnap'));
    if (!found) throw new Error('no QNAP');
    // Backups need it on Manage (the level isn't where its calls go), and its session is due: the work signs in first.
    await t.services.db
      .update(catalogConnections)
      .set({ access: 'manage', accessExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(catalogConnections.id, found.id));
    const asked = await rowOf(found.id);
    const checked = callTarget(asked);
    const restore = await repoint(asked, at(qnap, 'qnap-other.more.test'));
    try {
      const sent = qnap.requests.length;
      await expect(
        signingOnlyAs({ [asked.id]: checked }, () => nasPlaceDriver(t.services, asked).look()),
      ).rejects.toBeInstanceOf(ConnectionChangedError);
      expect(qnap.requests.length).toBe(sent);
      expect((await rowOf(asked.id)).accessTokenEnc).toBe(asked.accessTokenEnc);
    } finally {
      await restore();
      await t.services.db
        .update(catalogConnections)
        .set({ access: found.access, accessExpiresAt: found.accessExpiresAt })
        .where(eq(catalogConnections.id, found.id));
    }
  });

  it('signs in again once when QTS answers that the session ended', async () => {
    expect(await callTool('qnap', 'request', sysinfo)).toMatchObject({ status: 'ok', httpStatus: 200 });
    qn.live.clear();
    const again = await callTool('qnap', 'request', sysinfo);
    expect(again).toMatchObject({ status: 'ok', httpStatus: 200 });
    expect(JSON.stringify(again)).toContain('cpu_usage');
    expect(qnap.calls('POST /cgi-bin/authLogin.cgi')).toHaveLength(3);
  });
});

/* TrueNAS: a socket (CM-13…CM-17) ------------------------------------------------------------------------------------- */

describe('a socket connection: TrueNAS (CM-05, CM-13…CM-17)', () => {
  const url = () => at(nas, 'nas.more.test');

  it('refuses plain http, and names the certificate a TrueNAS presents when it isn’t the pinned one', async () => {
    const http = await connect({
      catalogId: 'truenas',
      fields: { url: url().replace('https:', 'http:') },
      secret: NAS_KEY,
    });
    expect(http.status).toBe(400);
    expect(Object.keys(http.body.error.fields)).toContain('fields.url');
    const other = FAKE_CERT_SHA256.replace(/^../, FAKE_CERT_SHA256.startsWith('00') ? '11' : '00');
    const unpinned = await connect({
      catalogId: 'truenas',
      fields: { url: url(), fingerprint: other },
      secret: NAS_KEY,
    });
    expect(unpinned.status).toBe(409);
    expect(unpinned.body.error.details).toMatchObject({
      code: 'check_failed',
      certificateSha256: FAKE_CERT_SHA256,
    });
    expect(nas.received).toEqual([]);
  });

  it('says an older TrueNAS has no socket', async () => {
    const res = await connect({
      catalogId: 'truenas',
      fields: { url: at(oldNas, 'old-nas.more.test'), fingerprint: FAKE_CERT_SHA256 },
      secret: NAS_KEY,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/older than 25\.04/);
  });

  it('connects with the pinned certificate, says its version, and gets one call tool', async () => {
    const res = await connect({
      catalogId: 'truenas',
      fields: { url: url(), fingerprint: FAKE_CERT_SHA256 },
      secret: NAS_KEY,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.connection).toMatchObject({ transport: 'socket', toolCount: 1 });
    expect(res.body.connection.checks.find((c: Json) => c.id === 'credential')?.message).toBe(
      'TrueNAS 25.10.1',
    );
    const tools = await t.services.db
      .select()
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, res.body.connection.id));
    expect(tools.map((x) => [x.name, x.origin, x.access])).toEqual([['call', 'socket', 'write']]);
    expect(nas.received.map((m) => m.method)).toEqual(['auth.login_with_api_key', 'system.info']);
  });

  it('runs a read at once, asks before a sensitive method, and never sends the sign-in for an agent', async () => {
    const before = nas.received.length;
    const read = await callTool('truenas', 'call', { method: 'pool.query' });
    expect(read).toMatchObject({ status: 'ok', isError: false });
    expect(JSON.parse(String(read.content))).toEqual([expect.objectContaining({ name: 'tank' })]);
    expect(JSON.stringify(read)).not.toContain(NAS_KEY);

    const exported = await callTool('truenas', 'call', { method: 'pool.export', params: [1] });
    expect(exported.status).toBe('pending_approval');

    const login = await callTool('truenas', 'call', { method: 'auth.login_with_api_key', params: ['x'] });
    expect(login).toMatchObject({ status: 'failed', reason: 'invalid_arguments' });
    // Only the read went out (with its own sign-in): nothing for the asked or the refused method.
    expect(nas.received.slice(before).map((m) => m.method)).toEqual([
      'auth.login_with_api_key',
      'pool.query',
    ]);
  });
});

/* ESPHome without a sign-in (CM-07, CM-14) ---------------------------------------------------------------------------- */

describe('a socket connection: ESPHome’s Device Builder (CM-07, CM-14)', () => {
  it('connects without a sign-in, says its version, and reads a log stream for its seconds', async () => {
    const res = await connect({
      catalogId: 'esphome',
      signIn: 'none',
      fields: { url: at(esphome, 'esphome.more.test') },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const checks = res.body.connection.checks as Json[];
    expect(checks.find((c) => c.id === 'credential')?.message).toBe('ESPHome 2026.6.5');
    // Nothing secret crosses the network, so no http warning.
    expect(checks.some((c) => c.id === 'destination')).toBe(false);

    const logs = await callTool('esphome', 'call', {
      method: 'devices/logs',
      params: { configuration: 'porch.yaml', port: 'OTA' },
      seconds: 1,
    });
    expect(logs).toMatchObject({ status: 'ok', isError: false });
    expect(String(logs.content)).toContain('porch temperature');
    expect(String(logs.content)).toMatch(/still going after 1 s/);
  });
});

/* SABnzbd: reads by a query parameter (CM-18) -------------------------------------------------------------------------- */

describe('reads by a query parameter: SABnzbd (CM-18)', () => {
  it('runs mode=queue at once and asks for a delete or a pause, whatever the method says', async () => {
    const res = await connect({
      catalogId: 'sabnzbd',
      fields: { url: at(sab, 'sab.more.test') },
      secret: SAB_KEY,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await setTier(res.body.connection.id, 'ask');
    const queue = await callTool('sabnzbd', 'request', {
      method: 'GET',
      path: '/api',
      query: { mode: 'queue', output: 'json' },
    });
    expect(queue).toMatchObject({ status: 'ok', httpStatus: 200 });
    const deleted = await callTool('sabnzbd', 'request', {
      method: 'GET',
      path: '/api',
      query: { mode: 'queue', name: 'delete', value: 'SABnzbd_nzo_1' },
    });
    expect(deleted.status).toBe('pending_approval');
    const paused = await callTool('sabnzbd', 'request', {
      method: 'GET',
      path: '/api',
      query: { mode: 'pause' },
    });
    expect(paused.status).toBe('pending_approval');
    // The check and the read went out; the delete and the pause wait for a person.
    expect(sab.calls('GET /api').map((r) => r.query.get('mode'))).toEqual(['queue', 'queue']);
  });
});
