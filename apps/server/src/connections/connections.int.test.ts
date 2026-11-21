/**
 * The connections catalog's connect side over REST against a real Postgres (docs/decisions/connections-catalog.md):
 * the burrow's connections, one kind (CX-25; one-person.md OP-S50), token connections with their checks and destination refusals (CX-10, CX-40, CX-41), handles
 * and limits (CX-05), signed burrow events for every change (CX-22), tool tiers, “Check again” and needs-reauth with
 * the repair message (CX-15), removal (CX-24), Home Assistant OAuth with refresh (CX-12), MCP authorization with
 * dynamic registration and the `iss` check (CX-13), the Custom MCP probe (CX-61), Nextcloud's login flow (CX-11), an
 * the person's Dropbox app (CX-14) and “Add this network”.
 *
 * Services are one stub server behind virtual home-network addresses (the Vault's network seam), reached through the
 * real destination policy and the tools side's real `syncTools` (Home Assistant's stub has an MCP server).
 */
import { X509Certificate } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { type AnyEndpoint, api, buildPath, CONNECTIONS_MAX } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  catalogConnections,
  connectionClients,
  connectionTools,
  events,
  messages,
  noticeQuiets,
  noticeStates,
  watchOffs,
  watchOns,
} from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent } from '../test/personal';
import { SELF_SIGNED_CERT_A, SELF_SIGNED_KEY_A } from '../test/self-signed';
import { sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { appRedirectUri, haClientId } from './redirect';
import { refreshConnectionAccess } from './refresh';
import { ensureTools } from './sync';
import { type Stubs, startStubs } from './testing/stubs';

// The local network closed: private addresses need the home network list (VT-12, LN-01).
const t = useTestServer({ seed: true, app: true, env: { WHOMBAT_LOCAL_NETWORK: 'off' } });
let stubs: Stubs;
const cookies: Record<'mara', string> = { mara: '' };

const HOSTS: Record<string, string[]> = {
  'ha.home.test': ['192.168.77.10'],
  'mcp.home.test': ['192.168.77.20'],
  'open.home.test': ['192.168.77.21'],
  'cloud.home.test': ['192.168.77.30'],
  'api.home.test': ['192.168.77.40'],
  'printer.home.test': ['192.168.78.5'],
  'pve.home.test': ['192.168.77.50'],
  'tower.home.test': ['192.168.77.60'],
  'ps5.home.test': ['192.168.77.70'],
};

async function call(
  ep: AnyEndpoint,
  params: Record<string, string>,
  body?: unknown,
  who: keyof typeof cookies = 'mara',
): Promise<{ status: number; body: Json; headers: Record<string, unknown> }> {
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
  return { status: res.statusCode, body: parsed, headers: res.headers };
}

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
type Json = Record<string, any>;

const haUrl = () => stubs.url('ha.home.test');

beforeAll(async () => {
  stubs = await startStubs();
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      const list = HOSTS[host];
      if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return list.map((address) => ({ address, family: 4 }));
    },
    dialAddress: (address) => (address.startsWith('192.168.77.') ? '127.0.0.1' : address),
  });
  for (const who of ['mara'] as const) cookies[who] = (await sessionFor(t.services, IDS[who])).cookie;
  // Mara's Assistant: the repair messages land in her DM with it.
  await addPersonalAgent(t.services, t.burrowId, IDS.mara, { name: 'Dusty', services: null });
});

afterAll(async () => {
  await stubs?.close();
});

describe('the catalog (CX-14, CX-75)', () => {
  it('offers every entry, an app_oauth one once its app is set', async () => {
    const res = await call(api.connections.catalog, {}, undefined, 'mara');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(CONNECTIONS_MAX);
    const dropbox = res.body.entries.find((e: { catalogId: string }) => e.catalogId === 'dropbox');
    expect(dropbox).toMatchObject({
      available: false,
      reason: 'app_not_configured',
      app: { configured: false, redirectUri: appRedirectUri(t.services.config, 'dropbox') },
    });
  });
});

describe('a PS5 without a sign-in', () => {
  it('creates and rechecks through Payload Manager, keeping its typed tools', async () => {
    const allowed = await call(
      api.connections.allowNetwork,
      {},
      {
        cidr: '192.168.77.0/24',
        port: stubs.port,
      },
    );
    expect(allowed.status).toBe(200);
    const created = await call(
      api.connections.create,
      {},
      {
        catalogId: 'ps5',
        signIn: 'none',
        fields: { url: stubs.url('ps5.home.test') },
      },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const connection = created.body.connection;
    expect(connection).toMatchObject({
      catalogId: 'ps5',
      signIn: 'none',
      transport: 'rest',
      status: 'active',
      toolCount: 20,
    });
    expect(connection.checks).toEqual([{ id: 'credential', state: 'ok', message: null }]);
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connection.id));
    expect(row?.secretEnc).toBeNull();
    const tools = await call(api.connections.tools, { connectionId: connection.id });
    expect(tools.body.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        'ps5_status',
        'ps5_update_payload',
        'ps5_update_webkit',
        'ps5_eject_usb',
        'ps5_power_status',
        'ps5_enable_remote_reboot',
        'ps5_reboot',
      ]),
    );
    // An already connected PS5 gets the new bundled tools immediately after an upgrade, with its choices intact.
    if (!row) throw new Error('Missing PS5 connection');
    await t.services.pipeline.transactAccount(async (tx) => {
      await tx
        .delete(connectionTools)
        .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, 'ps5_reboot')));
      await tx
        .update(connectionTools)
        .set({ tier: 'off' })
        .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, 'ps5_run_payload')));
    });
    const refreshed = await ensureTools(t.services, row);
    expect(refreshed.tools.find((tool) => tool.name === 'ps5_reboot')).toBeDefined();
    expect(refreshed.tools.find((tool) => tool.name === 'ps5_run_payload')?.tier).toBe('off');
    const checked = await call(api.connections.recheck, { connectionId: connection.id });
    expect(checked.status).toBe(200);
    expect(checked.body.connection).toMatchObject({
      status: 'active',
      checks: [{ id: 'credential', state: 'ok', message: null }],
    });
    expect(
      stubs.requests
        .filter((request) => request.host === 'ps5.home.test')
        .map(({ method, path, body, headers }) => [method, path, body, headers.authorization]),
    ).toEqual([
      ['GET', '/list_payloads', '', undefined],
      ['GET', '/list_payloads', '', undefined],
    ]);
    const removed = await call(api.connections.disconnect, { connectionId: connection.id });
    expect(removed.status).toBe(200);
  });
});

describe('token connections (CX-10, CX-40, CX-41)', () => {
  let sharedId = '';

  it('refuses an address on an unlisted home network, saying what to add', async () => {
    const body = {
      catalogId: 'homeassistant',
      fields: { url: 'http://printer.home.test:8123' },
      secret: 'x',
    };
    const res = await call(api.connections.create, {}, body, 'mara');
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({
      code: 'destination_refused',
      cidr: '192.168.78.0/24',
      port: 8123,
    });
    expect(res.body.error.message).toBe(
      'That address is on your network. Add 192.168.78.0/24 port 8123 to the home network list to connect.',
    );
  });

  it('“Add this network” adds a port to a listed network', async () => {
    const added = await call(
      api.connections.allowNetwork,
      {},
      { cidr: '192.168.77.0/24', port: 8123 },
      'mara',
    );
    expect(added.status).toBe(200);
    const again = await call(
      api.connections.allowNetwork,
      {},
      { cidr: '192.168.77.7/24', port: stubs.port },
      'mara',
    );
    expect(again.status).toBe(200);
    const net = again.body.networks.find((n: { cidr: string }) => n.cidr === '192.168.77.0/24');
    expect(net.ports).toEqual([8123, stubs.port].sort((a, b) => a - b));
  });

  it('runs the check: a refused token is a sentence, not a connection', async () => {
    const res = await call(
      api.connections.create,
      {},
      { catalogId: 'homeassistant', fields: { url: haUrl() }, secret: 'wrong' },
      'mara',
    );
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ code: 'check_failed', status: 401 });
    expect(res.body.error.message).toBe('The service refused the token. Check it and try again.');
  });

  it('checks fields and refuses a built-in entry', async () => {
    const bad = await call(
      api.connections.create,
      {},
      { catalogId: 'homeassistant', fields: { url: 'not a url' }, secret: 'x' },
      'mara',
    );
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fields)).toEqual(['fields.url']);
    const builtin = await call(api.connections.create, {}, { catalogId: 'github', secret: 'x' }, 'mara');
    expect(builtin.body.error.details.code).toBe('not_supported');
  });

  it('connects Home Assistant: sealed token, signed event, tools read, http warned', async () => {
    const res = await call(
      api.connections.create,
      {},
      {
        catalogId: 'homeassistant',
        fields: { url: `${haUrl()}/` },
        secret: stubs.knobs.haToken,
      },
      'mara',
    );
    expect(res.status).toBe(201);
    const c = res.body.connection;
    sharedId = c.id;
    expect(c).toMatchObject({
      catalogId: 'homeassistant',
      handle: 'homeassistant',
      // The first of its service is named after it, without its address (home-redesign.md HR-07).
      label: 'Home Assistant',
      connectedBy: { id: IDS.mara, name: 'Mara Okafor' },
      signIn: 'token',
      transport: 'mcp',
      status: 'active',
      // Its MCP server's two tools and `request` (the tools side's real sync).
      toolCount: 3,
    });
    expect(c.checks.map((x: { id: string; state: string }) => `${x.id}:${x.state}`)).toEqual([
      'credential:ok',
      'destination:warning',
      'mcp:ok',
    ]);
    expect(res.body.eventId).toMatch(/^evt_/);
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, sharedId));
    expect(row?.connectedById).toBe(IDS.mara);
    expect(row?.baseUrl).toBe(haUrl());
    expect(row?.secretEnc).not.toContain(stubs.knobs.haToken);
    const [event] = await t.services.db.select().from(events).where(eq(events.id, res.body.eventId));
    expect(event).toMatchObject({ type: 'connection.added', kind: 'System' });
    expect(JSON.stringify(event)).not.toContain(stubs.knobs.haToken);
  });

  it('names a second connection of the same service with its address (HR-07)', async () => {
    const second = await call(
      api.connections.create,
      {},
      {
        catalogId: 'homeassistant',
        fields: { url: haUrl() },
        secret: stubs.knobs.haToken,
      },
      'mara',
    );
    expect(second.status).toBe(201);
    expect(second.body.connection.label).toBe(`Home Assistant · ha.home.test:${stubs.port}`);
    const gone = await call(
      api.connections.disconnect,
      { connectionId: second.body.connection.id },
      undefined,
      'mara',
    );
    expect(gone.status).toBe(200);
  });

  it('lists the burrow’s connections, a second of a service with its own handle (CX-05, CX-25)', async () => {
    const other = await call(
      api.connections.create,
      {},
      {
        catalogId: 'homeassistant',
        fields: { url: haUrl() },
        secret: stubs.knobs.haToken,
        label: 'My house',
      },
      'mara',
    );
    expect(other.status).toBe(201);
    expect(other.body.connection).toMatchObject({
      handle: 'homeassistant-2',
      label: 'My house',
    });
    expect(other.body.eventId).toMatch(/^evt_/);
    const list = await call(api.connections.list, {}, undefined, 'mara');
    expect(list.body.connections.map((c: { id: string }) => c.id).sort()).toEqual(
      [sharedId, other.body.connection.id].sort(),
    );
    expect(list.body.count).toBe(2);
    expect(
      (await call(api.connections.disconnect, { connectionId: other.body.connection.id }, undefined, 'mara'))
        .status,
    ).toBe(200);
  });

  it('renames, sets tool tiers and replaces the token, signing each change (CX-22)', async () => {
    const renamed = await call(
      api.connections.update,
      { connectionId: sharedId },
      { label: 'House' },
      'mara',
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.connection.label).toBe('House');
    expect(renamed.body.eventId).toMatch(/^evt_/);

    const tools = await call(api.connections.tools, { connectionId: sharedId }, undefined, 'mara');
    expect(
      tools.body.tools.map((x: { name: string; tier: string; isNew: boolean }) => [x.name, x.tier, x.isNew]),
    ).toEqual([
      // The first sync marks nothing New (CX-D26); every tool starts Allowed (CX-20a).
      ['list_things', 'can', false],
      ['change_thing', 'can', false],
      ['request', 'can', false],
    ]);
    expect(tools.body.guide).toContain('Home Assistant’s REST API');
    const tier = await call(
      api.connections.setTool,
      { connectionId: sharedId, tool: 'change_thing' },
      { tier: 'off' },
      'mara',
    );
    expect(tier.status).toBe(200);
    expect(tier.body.tools.find((x: { name: string }) => x.name === 'change_thing')).toMatchObject({
      tier: 'off',
      isNew: false,
    });
    const unknown = await call(
      api.connections.setTool,
      { connectionId: sharedId, tool: 'nope' },
      { tier: 'off' },
      'mara',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.details.code).toBe('unknown_tool');

    const wrong = await call(
      api.connections.setSecret,
      { connectionId: sharedId },
      { secret: 'wrong' },
      'mara',
    );
    expect(wrong.body.error.details.code).toBe('check_failed');
    stubs.knobs.haToken = 'ha-second-token';
    const [before] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, sharedId));
    const replaced = await call(
      api.connections.setSecret,
      { connectionId: sharedId },
      { secret: 'ha-second-token' },
      'mara',
    );
    expect(replaced.status).toBe(200);
    const [after] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, sharedId));
    expect(after?.credentialVersion).toBe((before?.credentialVersion ?? 0) + 1);

    const signed = await t.services.db
      .select({ type: events.type, text: events.text })
      .from(events)
      .where(eq(events.burrowId, t.burrowId));
    const mine = signed.filter((e) => e.type.startsWith('connection.'));
    expect(mine).toEqual(
      expect.arrayContaining([
        { type: 'connection.changed', text: 'Renamed Home Assistant to House' },
        { type: 'connection.tool_tier_changed', text: 'Set change_thing on House to Off' },
        { type: 'connection.changed', text: 'Replaced the token of House' },
      ]),
    );
  });

  it('“Check again” marks a refused token needs_reauth, signs it, and tells the person once', async () => {
    stubs.knobs.haToken = 'rotated-elsewhere';
    const res = await call(api.connections.recheck, { connectionId: sharedId }, undefined, 'mara');
    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ status: 'needs_reauth', reauthReason: 'token_invalid' });
    await t.services.guides.settle();
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.burrowId, t.burrowId), eq(events.type, 'connection.needs_reauth')));
    expect(event?.text).toBe('House needs you to sign in again');
    const told = await t.services.db.select({ text: messages.text }).from(messages);
    expect(told.filter((m) => m.text.startsWith('House stopped accepting my sign-in'))).toHaveLength(1);
    // Fixed with a new token: active again.
    stubs.knobs.haToken = 'ha-third-token';
    const fixed = await call(
      api.connections.setSecret,
      { connectionId: sharedId },
      { secret: 'ha-third-token' },
      'mara',
    );
    expect(fixed.body.connection).toMatchObject({ status: 'active', reauthReason: null });
  });

  it('removes a connection with its tools, signed (CX-24)', async () => {
    // What Whombat watched of it, as a connection and as a device, and another thing's that stays.
    const things = [`connection:${sharedId}`, `device:${sharedId}`, 'server:stays'];
    const at = new Date();
    for (const thingId of things) {
      const row = { ownerId: t.burrowId, thingId, checkId: 'conn.down', at };
      await t.services.db
        .insert(noticeQuiets)
        .values({ ...row, state: 'ignored', tone: 'bad', title: 'Down' });
      await t.services.db.insert(watchOffs).values(row);
      await t.services.db.insert(watchOns).values(row);
      await t.services.db
        .insert(noticeStates)
        .values({ thingId, checkId: 'conn.down', firstSeen: at, lastSeen: at, seenPasses: 1, tone: 'bad' });
    }
    const res = await call(api.connections.disconnect, { connectionId: sharedId }, undefined, 'mara');
    expect(res.status).toBe(200);
    expect(res.body.eventId).toMatch(/^evt_/);
    expect(
      await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, sharedId)),
    ).toEqual([]);
    expect(
      await t.services.db.select().from(connectionTools).where(eq(connectionTools.connectionId, sharedId)),
    ).toEqual([]);
    for (const table of [noticeQuiets, watchOffs, watchOns, noticeStates]) {
      const left = await t.services.db
        .select({ thingId: table.thingId })
        .from(table)
        .where(inArray(table.thingId, things));
      expect(left.map((r) => r.thingId)).toEqual(['server:stays']);
    }
  });

  it('a Custom API connects when its root answers anything but a refusal (reach)', async () => {
    const res = await call(
      api.connections.create,
      {},
      {
        catalogId: 'custom_api',
        label: 'Inventory',
        fields: { url: stubs.url('api.home.test', '/v1'), description: 'Our stock API.' },
        secret: stubs.knobs.apiToken,
      },
      'mara',
    );
    expect(res.status).toBe(201);
    expect(res.body.connection.handle).toBe('inventory');
    const tools = await call(
      api.connections.tools,
      { connectionId: res.body.connection.id },
      undefined,
      'mara',
    );
    expect(tools.body.guide).toBe('Our stock API.');
  });

  it('keeps to the limit (CX-05)', async () => {
    const now = new Date();
    const have = (await call(api.connections.list, {}, undefined, 'mara')).body.connections.length;
    for (let i = have; i < CONNECTIONS_MAX; i++)
      await t.services.db.insert(catalogConnections).values({
        id: `con_limit${String(i).padStart(4, '0')}`,
        catalogId: 'todoist',
        burrowId: t.burrowId,
        label: `Todoist ${i}`,
        handle: `todoist-limit-${i}`,
        transport: 'rest',
        signIn: 'token',
        baseUrl: 'https://api.todoist.com',
        createdAt: now,
        updatedAt: now,
      });
    const res = await call(
      api.connections.create,
      {},
      {
        catalogId: 'homeassistant',
        fields: { url: haUrl() },
        secret: stubs.knobs.haToken,
      },
      'mara',
    );
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ code: 'limit_reached', max: CONNECTIONS_MAX });
    await t.services.db.delete(catalogConnections).where(eq(catalogConnections.catalogId, 'todoist'));
  });
});

describe('Home Assistant sign-in (CX-12)', () => {
  it('signs in with this Whombat as client, is finished over the session, refreshes, and needs reauth on invalid_grant', async () => {
    const start = await call(
      api.connections.startOAuth,
      {},
      {
        catalogId: 'homeassistant',
        method: 'ha_oauth',
        fields: { url: haUrl() },
        returnTo: '/burrow-hq/settings?tab=connections&connection=homeassistant',
      },
      'mara',
    );
    expect(start.status).toBe(200);
    const authorize = new URL(start.body.authorizeUrl);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${haUrl()}/auth/authorize`);
    expect(authorize.searchParams.get('client_id')).toBe(haClientId(t.services.config));
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      appRedirectUri(t.services.config, 'homeassistant'),
    );
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authorize.searchParams.get('state') ?? '';

    // The hosted UI hands the redirect over the session (`connections.finishOAuth`).
    const finish = (who: keyof typeof cookies) =>
      call(api.connections.finishOAuth, {}, { code: 'ha-code', state }, who);
    const back = await finish('mara');
    expect(back.status).toBe(200);
    const location = new URL(String(back.body.returnPath), 'http://x');
    expect(location.pathname).toBe('/burrow-hq/settings');
    expect(location.searchParams.get('connected')).toBe('homeassistant');
    const id = location.searchParams.get('connection') ?? '';
    expect(id).toMatch(/^con_/);
    expect(back.body.connectionId).toBe(id);
    const reused = await finish('mara');
    expect(reused.body.returnPath).toContain('connect_error=invalid_state');

    let [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
    expect(row).toMatchObject({
      signIn: 'ha_oauth',
      burrowId: t.burrowId,
      status: 'active',
      clientId: haClientId(t.services.config),
    });
    if (!row) throw new Error('no row');
    const fresh = await refreshConnectionAccess(t.services, row);
    expect(fresh.accessToken).toBe(stubs.knobs.haToken);
    const forced = await refreshConnectionAccess(t.services, row, { force: true });
    expect(forced.accessToken).toBe(stubs.knobs.haToken);
    expect(forced.accessToken).not.toBe(fresh.accessToken);

    stubs.knobs.haRefreshDead = true;
    [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
    if (!row) throw new Error('no row');
    await expect(refreshConnectionAccess(t.services, row, { force: true })).rejects.toThrow(
      /signed this connection out/,
    );
    [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
    expect(row).toMatchObject({ status: 'needs_reauth', reauthReason: 'revoked', accessTokenEnc: null });
    stubs.knobs.haRefreshDead = false;
  });
});

describe('MCP authorization (CX-13, CX-61)', () => {
  const mcpUrl = () => stubs.url('mcp.home.test', '/mcp');

  it('the probe tells an OAuth server from an open one', async () => {
    const oauth = await call(
      api.connections.probe,
      {},
      { catalogId: 'custom_mcp', fields: { url: mcpUrl() } },
      'mara',
    );
    expect(oauth.body).toEqual({
      needs: 'oauth',
      issuer: stubs.url('mcp.home.test'),
      serverName: null,
      message: null,
    });
    const open = await call(
      api.connections.probe,
      {},
      { catalogId: 'custom_mcp', fields: { url: stubs.url('open.home.test', '/mcp') } },
      'mara',
    );
    expect(open.body).toMatchObject({ needs: 'open', serverName: 'Open MCP' });
  });

  it('registers once, signs in with PKCE and resource, checks iss, and connects', async () => {
    const startBody = {
      catalogId: 'custom_mcp',
      method: 'mcp_oauth',
      label: 'Files server',
      fields: { url: mcpUrl() },
      returnTo: '/burrow-hq/settings?tab=connections',
    };
    const start = await call(api.connections.startOAuth, {}, startBody, 'mara');
    expect(start.status).toBe(200);
    const authorize = new URL(start.body.authorizeUrl);
    expect(authorize.pathname).toBe('/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('dcr-client-1');
    expect(authorize.searchParams.get('resource')).toBe(mcpUrl());
    expect(authorize.searchParams.get('scope')).toBe('files:read');
    const [client] = await t.services.db.select().from(connectionClients);
    expect(client).toMatchObject({ issuer: stubs.url('mcp.home.test'), method: 'dcr' });
    expect(client?.clientEnc).not.toContain('dcr-client-1');

    // A wrong issuer, and a missing one from a server that promises it, are refused (RFC 9207).
    const wrong = await call(
      api.connections.finishOAuth,
      {},
      { code: 'mcp-code', state: authorize.searchParams.get('state'), iss: 'https://evil.example' },
      'mara',
    );
    expect(wrong.body.returnPath).toContain('connect_error=issuer_mismatch');
    const again = new URL((await call(api.connections.startOAuth, {}, startBody, 'mara')).body.authorizeUrl);
    const missing = await call(
      api.connections.finishOAuth,
      {},
      { code: 'mcp-code', state: again.searchParams.get('state') },
      'mara',
    );
    expect(missing.body.returnPath).toContain('connect_error=issuer_mismatch');
    expect(stubs.requests.filter((r) => r.path === '/register')).toHaveLength(1);

    const third = new URL((await call(api.connections.startOAuth, {}, startBody, 'mara')).body.authorizeUrl);
    const done = await call(
      api.connections.finishOAuth,
      {},
      { code: 'mcp-code', state: third.searchParams.get('state'), iss: stubs.url('mcp.home.test') },
      'mara',
    );
    expect(done.status).toBe(200);
    expect(done.body.returnPath).toContain('connected=custom_mcp');
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, done.body.connectionId));
    expect(row).toMatchObject({
      signIn: 'mcp_oauth',
      transport: 'mcp',
      handle: 'files-server',
      issuer: stubs.url('mcp.home.test'),
      resource: mcpUrl(),
      clientId: client?.id,
    });
  });
});

describe('Nextcloud login (CX-11)', () => {
  it('starts the flow, polls until Nextcloud grants access, and connects with the app password', async () => {
    const start = await call(
      api.connections.startNextcloud,
      {},
      { fields: { url: stubs.url('cloud.home.test') } },
      'mara',
    );
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({
      loginUrl: stubs.url('cloud.home.test', '/login/v2/flow/abc'),
      pollEveryMs: 2000,
    });
    const flowId = start.body.flowId;
    expect((await call(api.connections.pollNextcloud, { flowId }, undefined, 'mara')).body).toEqual({
      state: 'pending',
    });
    const done = await call(api.connections.pollNextcloud, { flowId }, undefined, 'mara');
    expect(done.body.state).toBe('connected');
    expect(done.body.connection).toMatchObject({
      catalogId: 'nextcloud',
      signIn: 'nextcloud_login',
      // The user id from the check (SG-15a).
      fields: { url: stubs.url('cloud.home.test'), username: 'mara', userId: 'mara-uid' },
      detail: 'mara',
    });
    expect((await call(api.connections.pollNextcloud, { flowId }, undefined, 'mara')).body).toEqual({
      state: 'expired',
    });
  });
});

describe('the person’s app (CX-14)', () => {
  it('makes Dropbox available, signs in with PKCE offline, and goes', async () => {
    const notApp = await call(api.connectors.setApp, { catalogId: 'todoist' }, { clientId: 'abcd' }, 'mara');
    expect(notApp.body.error.details.code).toBe('not_supported');
    const set = await call(
      api.connectors.setApp,
      { catalogId: 'dropbox' },
      { clientId: 'dbx-app-key' },
      'mara',
    );
    expect(set.status).toBe(200);
    expect(set.body.entries.find((e: { catalogId: string }) => e.catalogId === 'dropbox')).toMatchObject({
      available: true,
      reason: null,
      app: { configured: true, source: 'settings', secretSet: false, clientIdHint: 'dbx-app-key' },
    });
    const start = await call(
      api.connections.startOAuth,
      {},
      {
        catalogId: 'dropbox',
        method: 'app_oauth',
        returnTo: '/burrow-hq/settings?tab=connections',
      },
      'mara',
    );
    const authorize = new URL(start.body.authorizeUrl);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('dbx-app-key');
    expect(authorize.searchParams.get('token_access_type')).toBe('offline');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const removed = await call(api.connectors.removeApp, { catalogId: 'dropbox' }, undefined, 'mara');
    expect(removed.body.entries.find((e: { catalogId: string }) => e.catalogId === 'dropbox').available).toBe(
      false,
    );
    const noApp = await call(
      api.connections.startOAuth,
      {},
      {
        catalogId: 'dropbox',
        method: 'app_oauth',
        returnTo: '/burrow-hq/settings?tab=connections',
      },
      'mara',
    );
    expect(noApp.body.error.details.code).toBe('app_not_configured');
  });
});

describe('a self-signed certificate (CX-D33, CS-54)', () => {
  let pve: HttpsServer;
  let port = 0;
  const pin = new X509Certificate(SELF_SIGNED_CERT_A).fingerprint256;

  beforeAll(async () => {
    pve = createHttpsServer({ cert: SELF_SIGNED_CERT_A, key: SELF_SIGNED_KEY_A }, (req, res) => {
      const ok = req.headers.authorization === 'PVEAPIToken=root@pam!whombat=pve-secret';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { data: { version: '9.0' } } : { data: null }));
    });
    await new Promise<void>((resolve) => pve.listen(0, '127.0.0.1', resolve));
    port = (pve.address() as AddressInfo).port;
    const added = await call(api.connections.allowNetwork, {}, { cidr: '192.168.77.0/24', port }, 'mara');
    expect(added.status).toBe(200);
  });

  afterAll(async () => {
    pve.closeAllConnections();
    await new Promise<void>((resolve) => pve.close(() => resolve()));
  });

  const body = (fields: Record<string, string> = {}) => ({
    catalogId: 'proxmox',
    fields: { url: `https://pve.home.test:${port}`, tokenId: 'root@pam!whombat', ...fields },
    secret: 'pve-secret',
  });

  it('trusts the certificate a home-network server made for itself, and only that one', async () => {
    const res = await call(api.connections.create, {}, body(), 'mara');
    expect(res.status).toBe(201);
    expect(res.body.connection).toMatchObject({ status: 'active', fields: { fingerprint: pin } });
    const removed = await call(
      api.connections.disconnect,
      { connectionId: res.body.connection.id },
      undefined,
      'mara',
    );
    expect(removed.status).toBe(200);
  });

  it('says so when a pinned fingerprint is not the one presented', async () => {
    const other = pin.replace(/^../, pin.startsWith('00') ? '11' : '00');
    const res = await call(api.connections.create, {}, body({ fingerprint: other }), 'mara');
    expect(res.status).toBe(409);
    expect(res.body.error.details.certificateSha256).toBe(pin);
    expect(res.body.error.message).toMatch(
      /^Its certificate isn’t the one pinned for this connection\. It presents/,
    );
  });

  it('connects with the fingerprint it offered', async () => {
    const res = await call(api.connections.create, {}, body({ fingerprint: pin }), 'mara');
    expect(res.status).toBe(201);
    expect(res.body.connection).toMatchObject({ catalogId: 'proxmox', status: 'active' });
    const removed = await call(
      api.connections.disconnect,
      { connectionId: res.body.connection.id },
      undefined,
      'mara',
    );
    expect(removed.status).toBe(200);
  });
});

describe('a check that reads the answer (Unraid, CT-313)', () => {
  let tower: HttpServer;
  let port = 0;

  beforeAll(async () => {
    // Unraid's GraphQL answers a wrong key 200 with `errors`, not 401.
    tower = createHttpServer((req, res) => {
      const ok = req.headers['x-api-key'] === 'tower-key';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          ok
            ? { data: { me: { name: 'Whombat', roles: ['ADMIN'] } } }
            : { data: null, errors: [{ message: 'Unauthorized' }] },
        ),
      );
    });
    await new Promise<void>((resolve) => tower.listen(0, '127.0.0.1', resolve));
    port = (tower.address() as AddressInfo).port;
    const added = await call(api.connections.allowNetwork, {}, { cidr: '192.168.77.0/24', port }, 'mara');
    expect(added.status).toBe(200);
  });

  afterAll(async () => {
    tower.closeAllConnections();
    await new Promise<void>((resolve) => tower.close(() => resolve()));
  });

  const body = (secret: string) => ({
    catalogId: 'unraid',
    fields: { url: `http://tower.home.test:${port}` },
    secret,
  });

  it('refuses a key the answer doesn’t accept, though it said 200', async () => {
    const res = await call(api.connections.create, {}, body('wrong'), 'mara');
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ code: 'check_failed', status: 200 });
    expect(res.body.error.message).toBe('The service refused the token. Check it and try again.');
  });

  it('connects with a key it answers for', async () => {
    const res = await call(api.connections.create, {}, body('tower-key'), 'mara');
    expect(res.status).toBe(201);
    expect(res.body.connection).toMatchObject({ catalogId: 'unraid', status: 'active' });
    const removed = await call(
      api.connections.disconnect,
      { connectionId: res.body.connection.id },
      undefined,
      'mara',
    );
    expect(removed.status).toBe(200);
  });
});
