/**
 * The MCP sign-in's stored registrations against a real Postgres (docs/decisions/connection-signin.md SG-19,
 * SG-S42…SG-S48): `offline_access` asked where the server lists it, a registration without it made again once (unless
 * connections already refresh through it), one that covers this sign-in's redirect kept, a dead one dropped at the
 * exchange or a refresh, and `iss` checked before an error. Postgres is the point: the `connection_clients` row per
 * issuer and the connections that sign in through it.
 *
 * Every authorization server is a host of one stub (`<name>.mcp.test` on 192.168.79.x, dialled on 127.0.0.1) with its own
 * issuer, so the cached metadata of one never answers for another.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AnyEndpoint,
  api,
  buildPath,
  CONNECT_HERE_DECLINE,
  DispatchContext,
  type GuideCard,
} from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { catalogConnections, connectionClients, dispatches, messages } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { executeConnectionCall } from './call';
import { clientAad, sealJson } from './crypto';
import { appRedirectUri, mcpRedirectUris } from './redirect';
import { refreshConnectionAccess } from './refresh';
import { answerMcp, type McpToolSpec } from './testing/tool-stubs';

// The hosted UI on a real origin: redirects there make a web application (SG-19c).
const t = useTestServer({
  seed: true,
  listen: true,
  app: true,
  env: { WHOMBAT_APP_URL: 'https://whombat.example.org' },
});
let cookie = '';
let me: PersonalSetup;
let maraAccount = '';

interface World {
  /** The authorization server lists `offline_access`. */
  offline: boolean;
  /** How the token endpoint answers a code, and a refresh. */
  code: 'ok' | 'invalid_client';
  refresh: 'ok' | 'invalid_client';
  registered: Record<string, unknown>[];
}

const NAMES = [
  'fresh',
  'legacy',
  'flowing',
  'covered',
  'dead',
  'refresh',
  'stepup',
  'cardok',
  'carddeny',
  'cardmanual',
  'carddecline',
] as const;
type Name = (typeof NAMES)[number];
const world = (n: Name): World => ({ offline: n !== 'covered', code: 'ok', refresh: 'ok', registered: [] });
const worlds = Object.fromEntries(NAMES.map((n) => [n, world(n)])) as Record<Name, World>;
worlds.dead.code = 'invalid_client';

let server: Server;
let port = 0;
const origin = (name: Name) => `http://${name}.mcp.test:${port}`;

function stub(): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const name = String(req.headers.host ?? '').split('.')[0] as Name;
      const world = worlds[name];
      const issuer = origin(name);
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(value));
      };
      if (!world) return json(404, {});
      if (path === '/mcp' && req.method === 'POST') {
        if (req.headers.authorization === `Bearer access-${name}`) {
          if (name === 'stepup') return answerStepUp(req, res, body);
          return answerMcp(req, res, body, [], 'Stub MCP');
        }
        return json(
          401,
          { error: 'unauthorized' },
          {
            'www-authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="files:read"`,
          },
        );
      }
      if (path === '/.well-known/oauth-protected-resource/mcp')
        return json(200, { resource: `${issuer}/mcp`, authorization_servers: [issuer] });
      if (path === '/.well-known/oauth-authorization-server')
        return json(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          code_challenge_methods_supported: ['S256'],
          scopes_supported: world.offline ? ['files:read', 'offline_access'] : ['files:read'],
          authorization_response_iss_parameter_supported: true,
        });
      if (path === '/register' && req.method === 'POST') {
        world.registered.push(JSON.parse(body));
        return json(201, { client_id: `${name}-client-${world.registered.length}` });
      }
      if (path === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(body);
        const answer = form.get('grant_type') === 'refresh_token' ? world.refresh : world.code;
        if (answer === 'invalid_client') return json(401, { error: 'invalid_client' });
        return json(200, {
          access_token: `access-${name}`,
          refresh_token: `refresh-${name}`,
          expires_in: 3600,
        });
      }
      return json(404, {});
    });
  });
}

const challenge = (scope: string) =>
  `Bearer error="insufficient_scope", scope="${scope}", error_description="needs more"`;

/**
 * The step-up server: WriteFile refuses with the HTTP 403 challenge (a spec client's), DeleteFile with an error result
 * carrying it in `_meta` (a client that reads it there); both name what the token holds and the one more it needs.
 */
function answerStepUp(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> | undefined {
  const rpc = JSON.parse(body) as { id?: number; method?: string; params?: { name?: string } };
  if (rpc.method === 'tools/call' && rpc.params?.name === 'WriteFile') {
    res.writeHead(403, {
      'content-type': 'application/json',
      'www-authenticate': challenge('files:read files:write'),
    });
    res.end(JSON.stringify({ error: 'insufficient_scope' }));
    return;
  }
  if (rpc.method === 'tools/call' && rpc.params?.name === 'DeleteFile') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          content: [{ type: 'text', text: 'This operation needs the files:delete scope' }],
          isError: true,
          _meta: { 'mcp/www_authenticate': challenge('files:read files:delete') },
        },
      }),
    );
    return;
  }
  return answerMcp(req, res, body, STEP_UP_TOOLS, 'Stub MCP');
}

const STEP_UP_TOOLS: McpToolSpec[] = [
  { name: 'WriteFile', description: 'Writes a file.', answer: () => 'written' },
  { name: 'DeleteFile', description: 'Deletes a file.', answer: () => 'deleted' },
];

async function call(ep: AnyEndpoint, body: unknown) {
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
    headers: { cookie },
    payload: body as object,
  });
  // biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

/** Starts a Custom MCP sign-in at `name`'s server: the authorize URL's parameters. */
async function start(name: Name): Promise<URLSearchParams> {
  const res = await call(api.connections.startOAuth, {
    catalogId: 'custom_mcp',
    method: 'mcp_oauth',
    label: `Files at ${name}`,
    fields: { url: `${origin(name)}/mcp` },
    returnTo: '/burrow-hq/settings?tab=connections',
  });
  expect(res.status).toBe(200);
  return new URL(res.body.authorizeUrl).searchParams;
}

const finish = (name: Name, params: URLSearchParams) =>
  call(api.connections.finishOAuth, { code: 'the-code', state: params.get('state'), iss: origin(name) });

const registration = async (name: Name) =>
  (
    await t.services.db
      .select()
      .from(connectionClients)
      .where(eq(connectionClients.issuer, origin(name)))
  )[0];

/** A registration made before SG-19a (no scope recorded), covering `redirects`. */
async function storeRegistration(name: Name, clientId: string, redirects: string[]): Promise<string> {
  const id = `ccl_${name}000000`;
  await t.services.db.insert(connectionClients).values({
    id,
    issuer: origin(name),
    clientEnc: sealJson(t.services.custody, clientAad(id), { clientId, authMethod: 'none' }),
    redirectUri: redirects.join(' '),
    method: 'dcr',
  });
  return id;
}

beforeAll(async () => {
  server = stub();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      const at = NAMES.indexOf(host.replace(/\.mcp\.test$/, '') as Name);
      if (!host.endsWith('.mcp.test') || at < 0)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address: `192.168.79.${10 + at}`, family: 4 }];
    },
    dialAddress: (address) => (address.startsWith('192.168.79.') ? '127.0.0.1' : address),
  });
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  me = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { name: 'Dusty', services: null });
  maraAccount = await accountOf(t.services, IDS.mara);
  const allowed = await call(api.connections.allowNetwork, { cidr: '192.168.79.0/24', port });
  expect(allowed.status).toBe(200);
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('offline_access (SG-19a, SG-19c)', () => {
  it('is asked in the registration and the authorize URL where the server lists it, as a web application', async () => {
    const params = await start('fresh');
    expect(params.get('scope')).toBe('files:read offline_access');
    expect(worlds.fresh.registered).toHaveLength(1);
    expect(worlds.fresh.registered[0]).toMatchObject({
      scope: 'files:read offline_access',
      application_type: 'web',
      redirect_uris: mcpRedirectUris(t.services.config),
    });
    await start('fresh');
    expect(worlds.fresh.registered).toHaveLength(1);
  });

  it('makes a registration without it again, once, under the same row', async () => {
    const id = await storeRegistration('legacy', 'legacy-old', mcpRedirectUris(t.services.config));
    const params = await start('legacy');
    expect(worlds.legacy.registered).toHaveLength(1);
    expect(params.get('client_id')).toBe('legacy-client-1');
    expect(params.get('scope')).toBe('files:read offline_access');
    expect((await registration('legacy'))?.id).toBe(id);
    await start('legacy');
    expect(worlds.legacy.registered).toHaveLength(1);
  });

  it('keeps it when a connection signed in through it holds a refresh token (SG-S44)', async () => {
    const id = await storeRegistration('flowing', 'flowing-old', mcpRedirectUris(t.services.config));
    await t.services.db.insert(catalogConnections).values({
      id: 'ccn_flowing_test',
      catalogId: 'custom_mcp',
      burrowId: t.burrowId,
      label: 'Flowing',
      handle: 'flowing',
      transport: 'mcp',
      signIn: 'mcp_oauth',
      baseUrl: `${origin('flowing')}/mcp`,
      clientId: id,
      issuer: origin('flowing'),
      resource: `${origin('flowing')}/mcp`,
      refreshTokenEnc: 'sealed-refresh-token',
    });
    const params = await start('flowing');
    expect(worlds.flowing.registered).toHaveLength(0);
    expect(params.get('client_id')).toBe('flowing-old');
    expect(params.get('scope')).toBe('files:read');
  });
});

describe('a stored registration (SG-19b, SG-S43, SG-S45)', () => {
  it('is kept while it covers this sign-in’s redirect, however many entries the catalog has', async () => {
    await storeRegistration('covered', 'covered-old', [appRedirectUri(t.services.config, 'custom_mcp')]);
    const params = await start('covered');
    expect(worlds.covered.registered).toHaveLength(0);
    expect(params.get('client_id')).toBe('covered-old');
  });

  it('is dropped when the server no longer knows it at the exchange, and made afresh next time', async () => {
    const first = await start('dead');
    expect(first.get('client_id')).toBe('dead-client-1');
    const done = await finish('dead', first);
    expect(done.body.returnPath).toContain('connect_error=exchange_failed');
    expect(await registration('dead')).toBeUndefined();
    const second = await start('dead');
    expect(second.get('client_id')).toBe('dead-client-2');
    expect(worlds.dead.registered).toHaveLength(2);
  });

  it('is dropped when a refresh says so, and the connection signs in again', async () => {
    const done = await finish('refresh', await start('refresh'));
    expect(done.body.returnPath).toContain('connected=custom_mcp');
    worlds.refresh.refresh = 'invalid_client';
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, done.body.connectionId));
    if (!row) throw new Error('no connection');
    await expect(refreshConnectionAccess(t.services, row, { force: true })).rejects.toThrow(/signed this/);
    expect(await registration('refresh')).toBeUndefined();
    const [after] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, row.id));
    expect(after?.status).toBe('needs_reauth');
  });
});

describe('the redirect back (SG-19d)', () => {
  it('checks iss before acting on an error', async () => {
    const forged = await call(api.connections.finishOAuth, {
      state: (await start('fresh')).get('state'),
      error: 'access_denied',
      iss: 'https://evil.example',
    });
    expect(forged.body.returnPath).toContain('connect_error=issuer_mismatch');
    const denied = await call(api.connections.finishOAuth, {
      state: (await start('fresh')).get('state'),
      error: 'access_denied',
      iss: origin('fresh'),
    });
    expect(denied.body.returnPath).toContain('connect_error=access_denied');
  });
});

describe('asking for more in the middle of a task (step-up, SG-24…SG-27)', () => {
  const row = async (id: string) =>
    (await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id)))[0];
  /** What the connection's page says waits for the person. */
  const askedOf = async (connectionId: string) => {
    const ep = api.connections.tools;
    const res = await t.api.inject({
      method: ep.method,
      url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', connectionId })}`,
      headers: { cookie },
    });
    return (res.json() as { connection: { permissionAsked?: string[] } }).connection.permissionAsked;
  };
  const run = (connectionId: string, tool: string) =>
    executeConnectionCall(t.services, {
      burrowId: t.burrowId,
      agentId: IDS.dusty,
      connectionId,
      tool,
      handle: 'files',
      callId: `evt_stepup_${tool}`,
      args: {},
      where: 'A DM',
      conversationId: IDS.dmDusty,
      threadRootId: null,
      personId: IDS.mara,
    });

  it('keeps what was asked, puts one card in the chat, and asks it at the next sign-in', async () => {
    const done = await finish('stepup', await start('stepup'));
    const id = done.body.connectionId as string;
    // The token answer named no scopes: the connection holds what was asked.
    expect((await row(id))?.scopes).toEqual(['files:read']);

    const refused = await run(id, 'WriteFile');
    expect(refused).toMatchObject({ kind: 'failed', reason: 'needs_permission' });
    expect((await row(id))?.scopesWanted).toEqual(['files:write']);
    const cards = async () =>
      (await t.services.db.select().from(messages).where(eq(messages.conversationId, IDS.dmDusty))).filter(
        (m) => (m.card as { node?: string } | null)?.node === 'allow_more',
      );
    const [card] = await cards();
    expect(JSON.stringify(card?.card)).toContain(`id=${id}`);
    expect((card?.card as GuideCard | undefined)?.connectOAuth).toMatchObject({
      catalogId: 'custom_mcp',
      method: 'mcp_oauth',
      connectionId: id,
    });

    // Asked again: no second card; the other way a server says it (an error result's `_meta`) is heard too.
    expect(await run(id, 'WriteFile')).toMatchObject({ reason: 'needs_permission' });
    expect(await cards()).toHaveLength(1);
    expect(await run(id, 'DeleteFile')).toMatchObject({ reason: 'needs_permission' });
    expect((await row(id))?.scopesWanted).toEqual(['files:write', 'files:delete']);
    expect(await cards()).toHaveLength(2);

    expect(await askedOf(id)).toEqual(['files:write', 'files:delete']);

    const again = await call(api.connections.startOAuth, {
      catalogId: 'custom_mcp',
      method: 'mcp_oauth',
      connectionId: id,
      returnTo: '/burrow-hq/settings?tab=connections',
    });
    const params = new URL(again.body.authorizeUrl).searchParams;
    expect(params.get('scope')?.split(' ').sort()).toEqual(
      ['files:delete', 'files:read', 'files:write', 'offline_access'].sort(),
    );
    expect((await finish('stepup', params)).body.connectionId).toBe(id);
    const after = await row(id);
    // Allowed: nothing waits, and both are asked again at the next sign-in.
    expect(after?.scopes.sort()).toEqual(['files:delete', 'files:read', 'files:write']);
    expect(after?.scopesWanted).toEqual(['files:write', 'files:delete']);
    expect(await askedOf(id)).toEqual([]);
    // Both open step-up cards were closed automatically once the new scopes were granted.
    for (const c of await cards()) {
      expect((c.card as GuideCard).state).toBe('done');
      expect((c.card as GuideCard).answer?.connectionId).toBe(id);
    }
  });
});

describe('OAuth connect cards in chat threads', () => {
  async function turnInThread(text: string) {
    const res = await t.commit(IDS.mara, sendMessage, { conversationId: me.dmId, text });
    if (res.status !== 'ok') throw new Error('not sent');
    const root = (res.result as { id: string }).id;
    await t.services.db
      .update(dispatches)
      .set({ state: 'done' })
      .where(and(eq(dispatches.messageId, root), eq(dispatches.state, 'queued')));
    const d = await agentTokenFor(t.services, t.burrowId, me.agentId, me.dmId, {
      onBehalfOfAccountId: maraAccount,
      threadRootId: root,
      messageId: root,
      trigger: 'dm',
    });
    return { root, token: d.token };
  }

  async function addMcp(token: string, name: Name, label: string) {
    const mcp = await mcpClient(t.baseUrl, token);
    try {
      const res = await mcp.client.callTool({
        name: 'connection_add',
        arguments: { service: 'custom_mcp', name: label, address: `${origin(name)}/mcp` },
      });
      return (res.structuredContent ?? {}) as Record<string, unknown>;
    } finally {
      await mcp.close();
    }
  }

  async function cardOf(messageId: string) {
    const [row] = await t.services.db.select().from(messages).where(eq(messages.id, messageId));
    if (row?.card?.kind !== 'guide') throw new Error('no guide card');
    return { row, card: row.card as GuideCard };
  }

  it('starts OAuth directly from the card, preserves access, returns to the thread, locks the card and wakes the assistant', async () => {
    const turn = await turnInThread('Connect cardok MCP');
    const added = await addMcp(turn.token, 'cardok', 'Gehoord');
    expect(added).toMatchObject({ status: 'ok', service: 'custom_mcp', signIn: 'oauth', access: 'read' });
    const messageId = added.messageId as string;
    const before = await cardOf(messageId);
    expect(before.card.state).toBe('open');
    expect(before.card.connectOAuth).toEqual({
      catalogId: 'custom_mcp',
      method: 'mcp_oauth',
      label: 'Gehoord',
      url: `${origin('cardok')}/mcp`,
      access: 'read',
      returnTo: `/burrow-hq/chat?thread=${turn.root}&guide=${messageId}`,
    });

    const oauth = before.card.connectOAuth;
    if (!oauth) throw new Error('missing connectOAuth');
    const started = await call(api.connections.startOAuth, {
      catalogId: oauth.catalogId,
      method: oauth.method,
      label: oauth.label,
      fields: oauth.url ? { url: oauth.url } : {},
      access: oauth.access,
      returnTo: oauth.returnTo,
    });
    expect(started.status).toBe(200);
    const params = new URL(started.body.authorizeUrl).searchParams;
    const finished = await finish('cardok', params);
    expect(finished.status).toBe(200);
    const connectionId = finished.body.connectionId as string;
    expect(connectionId).toMatch(/^con_/);
    expect(finished.body.returnPath).toContain(`/burrow-hq/chat?thread=${turn.root}&guide=${messageId}`);
    expect(finished.body.returnPath).toContain(`connected=custom_mcp`);
    expect(finished.body.returnPath).toContain(`connection=${connectionId}`);

    const [conn] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    expect(conn).toMatchObject({ label: 'Gehoord', access: 'read', status: 'active' });

    const after = await cardOf(messageId);
    expect(after.card.state).toBe('done');
    expect(after.card.answer).toMatchObject({
      actionId: 'connect',
      connectionId,
      label: 'Connected · Gehoord',
    });

    const [woken] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.agentId, me.agentId), eq(dispatches.messageId, messageId)))
      .orderBy(desc(dispatches.createdAt))
      .limit(1);
    expect(woken).toMatchObject({ trigger: 'dm', threadRootId: turn.root, conversationId: me.dmId });
    if (!woken) throw new Error('not woken');
    const ctx = DispatchContext.parse(await buildDispatchContext(t.services, woken));
    expect(JSON.stringify(ctx)).toContain(connectionId);
  });

  it('keeps the card open and posts a short retry note when OAuth is cancelled', async () => {
    const turn = await turnInThread('Connect carddeny MCP');
    const added = await addMcp(turn.token, 'carddeny', 'Cancelled MCP');
    const messageId = added.messageId as string;
    const oauth = (await cardOf(messageId)).card.connectOAuth;
    if (!oauth) throw new Error('missing connectOAuth');
    const started = await call(api.connections.startOAuth, {
      catalogId: oauth.catalogId,
      method: oauth.method,
      label: oauth.label,
      fields: oauth.url ? { url: oauth.url } : {},
      access: oauth.access,
      returnTo: oauth.returnTo,
    });
    const state = new URL(started.body.authorizeUrl).searchParams.get('state');
    const denied = await call(api.connections.finishOAuth, {
      state,
      error: 'access_denied',
      iss: origin('carddeny'),
    });
    expect(denied.body.returnPath).toContain(`/burrow-hq/chat?thread=${turn.root}&guide=${messageId}`);
    expect(denied.body.returnPath).toContain('connect_error=access_denied');
    expect((await cardOf(messageId)).card.state).toBe('open');

    const replies = await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, me.dmId), eq(messages.threadRootId, turn.root)));
    expect(replies.some((m) => m.text.toLowerCase().includes('cancelled'))).toBe(true);
    const woken = await t.services.db.select().from(dispatches).where(eq(dispatches.messageId, messageId));
    expect(woken).toHaveLength(0);
  });

  it('closes the card quietly when Not now is clicked', async () => {
    const turn = await turnInThread('Connect carddecline MCP');
    const added = await addMcp(turn.token, 'carddecline', 'Declined MCP');
    const messageId = added.messageId as string;
    const res = await t.api.inject({
      method: 'POST',
      url: `${api.guides.act.base}${buildPath(api.guides.act.path, { burrow: 'burrow-hq', messageId })}`,
      headers: { cookie },
      payload: { actionId: CONNECT_HERE_DECLINE },
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await cardOf(messageId);
    expect(after.card.state).toBe('done');
    expect(after.card.answer?.label).toBe('Not now');
    expect(after.card.answer?.connectionId).toBeUndefined();
    const woken = await t.services.db.select().from(dispatches).where(eq(dispatches.messageId, messageId));
    expect(woken).toHaveLength(0);
  });

  it('auto-locks a matching open chat connect card and wakes the assistant when connected through Settings', async () => {
    const turn = await turnInThread('Connect cardmanual MCP');
    const added = await addMcp(turn.token, 'cardmanual', 'Manual MCP');
    const messageId = added.messageId as string;
    expect((await cardOf(messageId)).card.state).toBe('open');

    // Connect through Settings without carrying the guide marker.
    const params = await start('cardmanual');
    const finished = await finish('cardmanual', params);
    const connectionId = finished.body.connectionId as string;
    expect(connectionId).toMatch(/^con_/);

    const after = await cardOf(messageId);
    expect(after.card.state).toBe('done');
    expect(after.card.answer?.connectionId).toBe(connectionId);
    const woken = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.agentId, me.agentId), eq(dispatches.messageId, messageId)));
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({ trigger: 'dm', threadRootId: turn.root, conversationId: me.dmId });
  });
});
