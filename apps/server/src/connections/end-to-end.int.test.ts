/**
 * The connections catalog end to end, with no stand-ins on either side (docs/decisions/connections-catalog.md): a
 * manager connects a Home Assistant-like stub on a listed home network with a token over REST (connect side: the
 * destination rule, the check, sealing, the signed event), its tools are synced (tools side: MCP `tools/list` through the
 * pooled client, `request` next to them), an agent lists them with `connection_tools` and calls a read with
 * `connection_call` (Allowed), the manager sets a tool to Asks over REST, the agent's call becomes an approval, and a
 * yes runs it once against the stub and posts the result where the agent asked.
 */
import { type AnyEndpoint, api, buildPath } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { approvals, connectionTools, dispatches, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { type HomeStub, stubHome } from './testing/tool-stubs';

const t = useTestServer({ seed: true, listen: true });

const TOKEN = 'ha-llat-e2e-Vq7Rk3Nw9Xc5';
const ADDRESS = '192.168.91.10';
let home: HomeStub;
let cookie = '';

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
type Json = Record<string, any>;

async function rest(ep: AnyEndpoint, params: Record<string, string>, body?: unknown) {
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...params })}`,
    headers: { cookie },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, body: res.json() as Json };
}

async function tool(mcp: TestMcp, name: string, args: Record<string, unknown>) {
  const res = await mcp.client.callTool({ name, arguments: args });
  return (res.structuredContent ?? {}) as Json;
}

beforeAll(async () => {
  home = await stubHome(TOKEN);
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      if (host !== 'house.home.test')
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address: ADDRESS, family: 4 }];
    },
    dialAddress: (address) => (address === ADDRESS ? '127.0.0.1' : address),
    deadlineMs: 3000,
  });
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'can' });
});

afterAll(async () => {
  await home?.close();
});

describe('a connection from connecting to an approved call', () => {
  it('connects, syncs, lists, calls, asks and runs after a yes', async () => {
    // Mara allows the home network the stub stands on, then connects it.
    const allowed = await rest(
      api.connections.allowNetwork,
      {},
      { cidr: '192.168.91.0/24', port: home.port },
    );
    expect(allowed.status).toBe(200);
    const created = await rest(
      api.connections.create,
      {},
      {
        catalogId: 'homeassistant',
        fields: { url: `http://house.home.test:${home.port}` },
        secret: TOKEN,
        label: 'House',
      },
    );
    expect(created.status).toBe(201);
    const connection = created.body.connection as Json;
    expect(connection).toMatchObject({ handle: 'homeassistant', status: 'active', toolCount: 4 });
    expect(connection.checks.map((c: Json) => `${c.id}:${c.state}`)).toEqual([
      'credential:ok',
      'destination:warning',
      'mcp:ok',
    ]);
    // Synced on connect: the server's tools, the destructive one marked, `request` last.
    const listed = await rest(api.connections.tools, { connectionId: connection.id });
    expect(listed.body.tools.map((x: Json) => [x.name, x.tier, x.sensitive])).toEqual([
      ['GetLiveContext', 'can', false],
      ['HassTurnOn', 'can', false],
      ['EraseEverything', 'can', true],
      ['request', 'can', false],
    ]);

    // Dusty sees the connection and its tools, and reads without asking.
    const turn = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing, {
      onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
    });
    const mcp = await mcpClient(t.baseUrl, turn.token);
    const names = (await mcp.client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['connection_tools', 'connection_call']));
    const tools = await tool(mcp, 'connection_tools', { connection: 'homeassistant' });
    expect(tools.status).toBe('ok');
    expect(tools.tools.map((x: Json) => x.name)).toEqual([
      'GetLiveContext',
      'HassTurnOn',
      'EraseEverything',
      'request',
    ]);
    const read = await tool(mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'GetLiveContext',
      arguments: {},
    });
    expect(read).toMatchObject({ status: 'ok', content: 'Kitchen light: on.' });

    // Mara sets HassTurnOn to Asks (it was Asks by default; Allowed first, then back, both signed).
    for (const tier of ['can', 'ask'] as const) {
      const set = await rest(
        api.connections.setTool,
        { connectionId: connection.id, tool: 'HassTurnOn' },
        { tier },
      );
      expect(set.status).toBe(200);
    }
    const [row] = await t.services.db
      .select()
      .from(connectionTools)
      .where(and(eq(connectionTools.connectionId, connection.id), eq(connectionTools.name, 'HassTurnOn')));
    expect(row?.tier).toBe('ask');

    // Dusty's write becomes an approval; nothing reaches the service until Mara says yes.
    const calls = () =>
      home.seen.filter((s) => s.body.includes('"tools/call"') && s.body.includes('HassTurnOn')).length;
    const asked = await tool(mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'HassTurnOn',
      arguments: { name: 'porch' },
    });
    expect(asked.status).toBe('pending_approval');
    const number = Number(asked.approvalNumber);
    const [approval] = await t.services.db.select().from(approvals).where(eq(approvals.number, number));
    expect(approval?.action).toMatchObject({ type: 'connection_call' });
    expect(calls()).toBe(0);
    const decided = await t.commit(IDS.mara, decideApproval, { number, decision: 'approve' });
    expect(decided.status).toBe('ok');
    // The agent is woken with the result where it asked (HR-04); nothing raw is posted.
    await expect
      .poll(
        async () =>
          (
            await t.services.db
              .select({ id: dispatches.id })
              .from(dispatches)
              .where(
                and(
                  eq(dispatches.approvalId, approval?.id ?? ''),
                  eq(dispatches.trigger, 'approval_granted'),
                ),
              )
          ).length,
        { timeout: 10_000 },
      )
      .toBe(1);
    expect(
      (
        await t.services.db
          .select()
          .from(messages)
          .where(and(eq(messages.conversationId, IDS.billing), eq(messages.authorId, IDS.dusty)))
      ).some((m) => m.text.includes('ran after approval')),
    ).toBe(false);
    expect(calls()).toBe(1);
    // The token went only as the stub's bearer header, never to the agent.
    expect(JSON.stringify([tools, read, asked])).not.toContain(TOKEN);
    await mcp.close();
  });
});
