/**
 * T3 Code end to end against a real Postgres (docs/decisions/t3code.md T3-02…T3-05), with a stand-in T3 Code behind a
 * home-network address: `connections.create` with a pairing code (no account) stores the token T3 Code gave as the
 * entry's token sign-in with when it ends; its tools as served (the thread-only ones never, a thread read as a read);
 * an agent's calls through `connection_call` with the per-call access on Look only; a sign-in that ended marks the
 * connection, and `connections.setSecret` with a new pairing code signs in again with its tools' tiers kept. Postgres
 * because all of it goes through the commit pipeline, the stored row and the agent's MCP door.
 */
import { type AnyEndpoint, api, buildPath } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogConnections, connectionTools, vaultNetworks } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { openConnectionSecret } from './crypto';
import { startT3Code, type T3CodeStub } from './testing/t3code-stub';

const t = useTestServer({ seed: true, listen: true });

const HOSTS: Record<string, string> = { 't3.home.test': '192.168.91.10' };
const DAY_MS = 24 * 60 * 60 * 1000;

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
type Json = Record<string, any>;

let t3: T3CodeStub;
let cookie = '';
let mara = '';

async function call(ep: AnyEndpoint, params: Record<string, string>, body?: unknown) {
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...params })}`,
    headers: { cookie },
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

async function turn(): Promise<TestMcp> {
  const d = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing, {
    onBehalfOfAccountId: mara,
  });
  return mcpClient(t.baseUrl, d.token);
}

async function tool(mcp: TestMcp, name: string, args: Record<string, unknown>): Promise<Json> {
  const res = await mcp.client.callTool({ name, arguments: args });
  return (res.structuredContent ?? {}) as Json;
}

async function rowOf(id: string) {
  const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  if (!row) throw new Error('no connection');
  return row;
}

async function toolsOf(id: string) {
  return t.services.db.select().from(connectionTools).where(eq(connectionTools.connectionId, id));
}

const create = (password: string, access: 'read' | 'manage' = 'manage', extra: Json = {}) =>
  call(
    api.connections.create,
    {},
    {
      catalogId: 't3code',
      signIn: 'password',
      fields: { url: `http://t3.home.test:${t3.port}` },
      login: { password },
      access,
      ...extra,
    },
  );

beforeAll(async () => {
  t3 = await startT3Code();
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      const address = HOSTS[host];
      if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    },
    dialAddress: (address) => (address.startsWith('192.168.91.') ? '127.0.0.1' : address),
    deadlineMs: 5000,
  });
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_t3code_test',
    cidr: '192.168.91.0/24',
    ports: [t3.port],
    note: 'T3 Code stand-in',
    addedAt: t.services.clock(),
  });
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  mara = await accountOf(t.services, IDS.mara);
  await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'can' });
});

afterAll(async () => {
  await t3?.close();
});

let manageId = '';
let lookId = '';
let lookHandle = '';

describe('adding T3 Code with a pairing code (T3-02, T3-03)', () => {
  it('asks only for the code, and refuses one that didn’t work or can’t give full access', async () => {
    const none = await create('x', 'manage', { login: undefined });
    expect(none.status).toBe(400);
    expect(Object.keys(none.body.error.fields)).toEqual(['login.password']);
    const wrong = await create('ABCD2345EFGH');
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.details).toEqual({ code: 'sign_in_refused', reason: 'password' });
    const short = await create(t3.pairingCode('read'), 'manage');
    expect(short.body.error.details).toEqual({ code: 'sign_in_refused', reason: 'rights' });
  });

  it('keeps the token T3 Code gave as the entry’s token, with when it ends, and serves its tools', async () => {
    const code = t3.pairingCode();
    const res = await create(code);
    expect(res.status).toBe(201);
    const c = res.body.connection;
    manageId = c.id;
    expect(c).toMatchObject({
      catalogId: 't3code',
      signIn: 'token',
      access: 'manage',
      status: 'active',
      detail: 'thetitan',
    });
    expect(c.handle).toBe('t3');
    expect(t3.registered.at(-1)).toBe('Whombat');
    const row = await rowOf(c.id);
    const issued = t3.issued.at(-1);
    expect(issued?.access).toBe('full-access');
    expect(openConnectionSecret(t.services.custody, row.id, 'secret', row.secretEnc as string)).toBe(
      issued?.token,
    );
    expect(row.auth).toEqual({ type: 'bearer' });
    expect(row.accessTokenEnc).toBeNull();
    const left = (row.accessExpiresAt?.getTime() ?? 0) - t.services.clock().getTime();
    expect(left).toBeGreaterThan(30 * DAY_MS - 60_000);
    expect(left).toBeLessThanOrEqual(30 * DAY_MS);
    // The code is nowhere in what was kept.
    expect(JSON.stringify(row)).not.toContain(code);
    const tools = await toolsOf(c.id);
    const names = tools.map((x) => x.name).sort();
    expect(names).toEqual([
      'list_thread_pull_requests',
      't3_environment_read',
      't3_pending_request',
      't3_project_list',
      't3_thread_interrupt',
      't3_thread_launch',
      't3_thread_organize',
      't3_thread_read',
      't3_thread_send',
      't3_thread_wait',
    ]);
    expect(tools.find((x) => x.name === 't3_thread_read')?.access).toBe('read');
    expect(tools.find((x) => x.name === 't3_pending_request')?.access).toBe('write');
  });
});

describe('an agent’s calls (T3-04)', () => {
  it('reads questions on Look only but can’t answer them, and never reaches a thread-only tool', async () => {
    const res = await create(t3.pairingCode('read'), 'read', { label: 'T3 Code to look at' });
    expect(res.status).toBe(201);
    lookId = res.body.connection.id;
    lookHandle = res.body.connection.handle;
    expect(t3.issued.at(-1)?.access).toBe('read-only');
    const mcp = await turn();
    const listed = await tool(mcp, 'connection_tools', { connection: lookHandle });
    const pending = (listed.tools as Json[]).find((x) => x.name === 't3_pending_request');
    expect(pending).toMatchObject({ access: 'read', tier: 'can' });
    expect((listed.tools as Json[]).map((x) => x.name)).not.toContain('preview_open');

    const list = await tool(mcp, 'connection_call', {
      connection: lookHandle,
      tool: 't3_pending_request',
      arguments: { action: 'list', threadId: 'thread-1' },
    });
    expect(list).toMatchObject({ status: 'ok', isError: false });
    expect(JSON.parse(list.content)).toEqual({ requestIds: ['request-1'] });
    // The answer once: its text is its structured content written out.
    expect(list.structured).toBeUndefined();

    const before = t3.calls.length;
    const respond = await tool(mcp, 'connection_call', {
      connection: lookHandle,
      tool: 't3_pending_request',
      arguments: { action: 'respond', threadId: 'thread-1', requestId: 'request-1', answers: { q1: 'Yes' } },
    });
    expect(respond.status).toBe('blocked');
    const hidden = await tool(mcp, 'connection_call', {
      connection: lookHandle,
      tool: 'preview_open',
      arguments: {},
    });
    expect(hidden).toMatchObject({ status: 'failed', reason: 'unknown_tool' });
    expect(t3.calls.length).toBe(before);

    // A declared failure reaches the agent as T3 Code's own JSON.
    const outside = await tool(mcp, 'connection_call', {
      connection: lookHandle,
      tool: 't3_pending_request',
      arguments: { action: 'list' },
    });
    expect(outside).toMatchObject({ status: 'ok', isError: true });
    expect(JSON.parse(outside.content)).toMatchObject({ code: 'target_required' });
    await mcp.close();
  });
});

describe('thirty days, then a new code (T3-05)', () => {
  it('marks the connection when T3 Code ends the sign-in, and signs in again with a new code, tiers kept', async () => {
    await t.services.db
      .update(connectionTools)
      .set({ tier: 'off' })
      .where(and(eq(connectionTools.connectionId, manageId), eq(connectionTools.name, 't3_thread_launch')));
    const old = await rowOf(manageId);
    const oldToken = openConnectionSecret(t.services.custody, old.id, 'secret', old.secretEnc as string);
    t3.end(oldToken);

    const mcp = await turn();
    const refused = await tool(mcp, 'connection_call', {
      connection: 't3',
      tool: 't3_project_list',
      arguments: {},
    });
    expect(refused.status).toBe('failed');
    await t.services.guides.settle();
    expect(await rowOf(manageId)).toMatchObject({ status: 'needs_reauth', reauthReason: 'token_invalid' });

    const wrong = await call(
      api.connections.setSecret,
      { connectionId: manageId },
      { secret: 'ABCD2345EFGH' },
    );
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.details).toEqual({ code: 'sign_in_refused', reason: 'password' });
    expect((await rowOf(manageId)).credentialVersion).toBe(old.credentialVersion);

    const again = await call(
      api.connections.setSecret,
      { connectionId: manageId },
      { secret: t3.pairingCode() },
    );
    expect(again.status).toBe(200);
    expect(again.body.connection).toMatchObject({
      id: manageId,
      status: 'active',
      signIn: 'token',
      access: 'manage',
    });
    const row = await rowOf(manageId);
    const issued = t3.issued.at(-1);
    expect(issued?.access).toBe('full-access');
    expect(openConnectionSecret(t.services.custody, row.id, 'secret', row.secretEnc as string)).toBe(
      issued?.token,
    );
    expect(row.credentialVersion).toBe(old.credentialVersion + 1);
    expect(row.reauthReason).toBeNull();
    expect((row.accessExpiresAt?.getTime() ?? 0) - t.services.clock().getTime()).toBeGreaterThan(29 * DAY_MS);
    const tiers = Object.fromEntries((await toolsOf(manageId)).map((x) => [x.name, x.tier]));
    expect(tiers.t3_thread_launch).toBe('off');

    // The pooled client reconnects with the new token.
    const ok = await tool(mcp, 'connection_call', {
      connection: 't3',
      tool: 't3_project_list',
      arguments: {},
    });
    expect(ok).toMatchObject({ status: 'ok', isError: false });
    expect(t3.calls.at(-1)?.token).toBe(issued?.token);
    await mcp.close();
  });

  it('signs in again at the connection’s own level', async () => {
    const res = await call(
      api.connections.setSecret,
      { connectionId: lookId },
      { secret: t3.pairingCode('read') },
    );
    expect(res.status).toBe(200);
    expect(t3.issued.at(-1)?.access).toBe('read-only');
    const decision = t3.seen.filter((r) => r.path === '/oauth/mcp/decision').at(-1);
    expect(JSON.parse(decision?.body ?? '{}').decision.access).toBe('read-only');
  });
});
