/**
 * A server's name against the fake hosts service (names.ts): the person names a server on `hosts.updateServer` without
 * the hosts service changing anything; the fleet, the server's page, its settings, the assistant's tools and the words
 * of later changes say the name; an agent finds the server by it; a name another server goes by is refused; Undo and an
 * empty name put the id back; removing a server removes its name. Postgres: the rename is a commit with its own row,
 * signed event and undo.
 */
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changes, events, serverNames } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent } from '../test/personal';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { startHosts } from './index';
import { ensureServersConnection } from './provision';
import { FakeHostsService } from './testing/fake';

const fake = new FakeHostsService();
const t = useTestServer({
  seed: true,
  listen: true,
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});

let personCookie = '';
let dusty = { agentId: '', dmId: '' };

async function as(method: string, path: string, body?: unknown) {
  const res = await t.api.inject({
    method: method as 'GET',
    url: `/api/v1/burrows/burrow-hq${path}`,
    headers: {
      cookie: personCookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown> & { error?: { code: string; message: string } },
  };
}

async function call(tool: string, args: Record<string, unknown>) {
  const d = await agentTokenFor(t.services, t.burrowId, dusty.agentId, dusty.dmId, {
    onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
  });
  const mcp = await mcpClient(t.baseUrl, d.token);
  const res = await mcp.client.callTool({
    name: 'connection_call',
    arguments: { connection: 'servers', tool, arguments: args },
  });
  await mcp.close();
  return (res.structuredContent ?? {}) as { status: string; content?: string; message?: string };
}

async function nameRow(serverId: string) {
  const [row] = await t.services.db
    .select()
    .from(serverNames)
    .where(and(eq(serverNames.burrowId, t.burrowId), eq(serverNames.serverId, serverId)));
  return row ?? null;
}

async function lastEvent(type: string) {
  const [row] = await t.services.db
    .select()
    .from(events)
    .where(eq(events.type, type))
    .orderBy(desc(events.seq))
    .limit(1);
  return row ?? null;
}

const fleetRow = async (id: string) =>
  ((await as('GET', '/hosts/fleet')).body.servers as { id: string; name: string }[]).find((s) => s.id === id);

beforeAll(async () => {
  await fake.start();
  personCookie = (await sessionFor(t.services, IDS.mara)).cookie;
  const made = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { name: 'Dusty', services: null });
  dusty = { agentId: made.agentId, dmId: made.dmId };
  await setConnectionKeys(t.services, dusty.agentId, { read: 'can', write: 'can' });
  startHosts(t.services);
  for (let i = 0; !(await ensureServersConnection(t.services).catch(() => null)); i++) {
    if (i > 100) throw new Error('no Servers connection');
    await new Promise((r) => setTimeout(r, 50));
  }
});

afterAll(async () => {
  await fake.stop();
});

describe('naming a server', () => {
  it('keeps the name in Whombat and every read says it', async () => {
    const patches = fake.calls('PATCH', '/api/v1/servers/granite').length;
    const res = await as('PATCH', '/hosts/servers/granite', { name: '  The Rock ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'granite', name: 'The Rock' });
    expect(fake.calls('PATCH', '/api/v1/servers/granite').length).toBe(patches);
    expect(await nameRow('granite')).toMatchObject({ name: 'The Rock', changedById: IDS.mara });
    const event = await lastEvent('servers.renamed');
    expect(event?.text).toContain('granite');
    expect(event?.text).toContain('The Rock');

    expect(await fleetRow('granite')).toMatchObject({ name: 'The Rock' });
    expect((await as('GET', '/hosts/servers/granite')).body.server).toMatchObject({
      id: 'granite',
      name: 'The Rock',
    });
    expect((await as('GET', '/hosts/servers/granite/settings')).body.name).toBe('The Rock');
    // A server nobody named goes by its id.
    expect(await fleetRow('shale')).toMatchObject({ name: 'shale' });
    expect((await as('GET', '/hosts/servers/shale/settings')).body.name).toBeNull();
  });

  it('tells the assistant the name, and finds the server by it', async () => {
    const overview = JSON.parse((await call('servers_overview', {})).content ?? '{}') as {
      servers: { id: string; name?: string }[];
    };
    expect(overview.servers.find((s) => s.id === 'granite')?.name).toBe('The Rock');
    expect(overview.servers.find((s) => s.id === 'shale')?.name).toBeUndefined();
    const detail = await call('server_detail', { server: 'the rock' });
    expect(detail.status).toBe('ok');
    expect(JSON.parse(detail.content ?? '{}').server).toMatchObject({ id: 'granite', name: 'The Rock' });
  });

  it('says the name in the words of later changes', async () => {
    expect((await as('PATCH', '/hosts/servers/granite', { asksFirst: 'risky' })).status).toBe(200);
    expect((await lastEvent('servers.asks_changed'))?.text).toContain('The Rock');
    expect((await as('PATCH', '/hosts/servers/granite', { location: 'Rack 3' })).status).toBe(200);
    expect((await lastEvent('hosts.change'))?.text).toContain('The Rock');
  });

  it('refuses a name another server goes by, ignoring case', async () => {
    const taken = await as('PATCH', '/hosts/servers/shale', { name: 'the ROCK' });
    expect(taken.status).toBe(409);
    expect(taken.body.error?.code).toBe('conflict');
    const anId = await as('PATCH', '/hosts/servers/shale', { name: 'GRANITE' });
    expect(anId.status).toBe(409);
    expect(await nameRow('shale')).toBeNull();
    // Its own name in other capitals is fine.
    expect((await as('PATCH', '/hosts/servers/granite', { name: 'The ROCK' })).body.name).toBe('The ROCK');
  });

  it('refuses a name of two lines or too long', async () => {
    expect((await as('PATCH', '/hosts/servers/shale', { name: 'a\nb' })).status).toBe(400);
    expect((await as('PATCH', '/hosts/servers/shale', { name: 'x'.repeat(61) })).status).toBe(400);
  });

  it('puts the name before back with Undo, and the id with an empty name', async () => {
    const [change] = await t.services.db
      .select()
      .from(changes)
      .where(and(eq(changes.kind, 'servers.rename'), eq(changes.subjectId, 'granite')))
      .orderBy(desc(changes.createdAt))
      .limit(1);
    const undo = await as('POST', `/changes/${change?.id}/undo`);
    expect(undo).toMatchObject({ status: 200, body: { state: 'undone' } });
    expect(await nameRow('granite')).toMatchObject({ name: 'The Rock' });

    const back = await as('PATCH', '/hosts/servers/granite', { name: null });
    expect(back.body).toMatchObject({ id: 'granite', name: null });
    expect(await nameRow('granite')).toBeNull();
    expect(await fleetRow('granite')).toMatchObject({ name: 'granite' });
  });

  it('removes the name with the server', async () => {
    expect((await as('PATCH', '/hosts/servers/flint', { name: 'Kitchen box' })).status).toBe(200);
    expect(await nameRow('flint')).not.toBeNull();
    expect((await as('DELETE', '/hosts/servers/flint')).status).toBe(200);
    expect(await nameRow('flint')).toBeNull();
  });
});
