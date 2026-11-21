/**
 * “Asks you first” per server against the fake hosts service (docs/decisions/server-asks.md SA-01…SA-07, SA-10;
 * server-asks-server.md): every server starts at Never; the person sets it on `hosts.updateServer` without the hosts
 * service changing anything, the fleet and the server's pages say it, Undo puts it back; a sensitive Servers call runs
 * at Allowed on a server set to Never and asks on one set to Before risky actions, `server_power` on the server this
 * Whombat runs on still asks; a card that asks only for the
 * sensitive rules names its server and “Don’t ask again on {server}” approves and sets it to Never in one commit;
 * installing updates on the server this Whombat runs on still asks (server-updates.md SWU-08); removing a server removes
 * its row.
 */
import { api, buildPath } from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvals, changes, events, serverAsks } from '../db/schema/index';
import { toApproval } from '../read/work';
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
let hazel = { agentId: '', dmId: '' };

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
  const d = await agentTokenFor(t.services, t.burrowId, hazel.agentId, hazel.dmId, {
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

async function lastApproval() {
  const [row] = await t.services.db.select().from(approvals).orderBy(desc(approvals.number)).limit(1);
  if (!row) throw new Error('no approval');
  return toApproval(row);
}

async function asksRow(serverId: string) {
  const [row] = await t.services.db
    .select()
    .from(serverAsks)
    .where(and(eq(serverAsks.burrowId, t.burrowId), eq(serverAsks.serverId, serverId)));
  return row ?? null;
}

async function decide(number: number, body: Record<string, unknown>) {
  const res = await t.api.inject({
    method: 'POST',
    url: `/api/v1${buildPath(api.approvals.decide.path, { burrow: 'burrow-hq', number })}`,
    headers: { cookie: personCookie },
    payload: body,
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  await fake.start();
  personCookie = (await sessionFor(t.services, IDS.mara)).cookie;
  const made = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { name: 'Dusty', services: null });
  hazel = { agentId: made.agentId, dmId: made.dmId };
  await setConnectionKeys(t.services, hazel.agentId, { read: 'can', write: 'can' });
  startHosts(t.services);
  // The Servers connection, made by the start (or here, whichever comes first).
  for (let i = 0; !(await ensureServersConnection(t.services).catch(() => null)); i++) {
    if (i > 100) throw new Error('no Servers connection');
    await new Promise((r) => setTimeout(r, 50));
  }
});

afterAll(async () => {
  await fake.stop();
});

describe('Asks you first on the server’s settings (SA-04, SA-05)', () => {
  it('starts at Never everywhere', async () => {
    const s = await as('GET', '/hosts/servers/granite/settings');
    expect(s.status).toBe(200);
    expect(s.body.asksFirst).toBe('never');
    expect(await asksRow('granite')).toBeNull();
    const fleet = await as('GET', '/hosts/fleet');
    const servers = fleet.body.servers as { id: string; asksFirst?: string }[];
    expect(servers.length).toBeGreaterThan(0);
    expect(servers.every((x) => x.asksFirst === 'never')).toBe(true);
  });

  it('sets Never for the person without changing the hosts service', async () => {
    // From Before risky actions, which the person chose first.
    expect((await as('PATCH', '/hosts/servers/granite', { asksFirst: 'risky' })).status).toBe(200);
    expect(await asksRow('granite')).toMatchObject({ asksFirst: 'risky' });
    expect(JSON.parse((await call('server_detail', { server: 'granite' })).content ?? '{}').asksFirst).toBe(
      'risky',
    );
    const patches = fake.calls('PATCH', '/api/v1/servers/granite').length;
    const set = await as('PATCH', '/hosts/servers/granite', { asksFirst: 'never' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ id: 'granite', asksFirst: 'never' });
    expect(fake.calls('PATCH', '/api/v1/servers/granite').length).toBe(patches);
    expect(await asksRow('granite')).toMatchObject({ asksFirst: 'never', changedById: IDS.mara });
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'servers.asks_changed'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(event).toMatchObject({ text: 'Whombat stopped asking first on granite' });
    // The fleet, the server's page and the assistant's tools say it.
    const fleet = await as('GET', '/hosts/fleet');
    expect(
      (fleet.body.servers as { id: string; asksFirst?: string }[]).find((x) => x.id === 'granite'),
    ).toMatchObject({ asksFirst: 'never' });
    expect((await as('GET', '/hosts/servers/granite')).body.asksFirst).toBe('never');
    const detail = await call('server_detail', { server: 'granite' });
    expect(JSON.parse(detail.content ?? '{}').asksFirst).toBe('never');
    const overview = await call('servers_overview', {});
    const lines = JSON.parse(overview.content ?? '{}').servers as { id: string; asksFirst: string }[];
    expect(lines.find((x) => x.id === 'granite')?.asksFirst).toBe('never');
    // A server nobody set says the default.
    expect(lines.find((x) => x.id === 'shale')?.asksFirst).toBe('never');
  });

  it('patches the hosts service as before when the body has more, and sets asks in the same request', async () => {
    const patches = fake.calls('PATCH', '/api/v1/servers/flint').length;
    const res = await as('PATCH', '/hosts/servers/flint', {
      location: 'Rack 2',
      asksFirst: 'never',
    });
    expect(res.status).toBe(200);
    expect(res.body.asksFirst).toBe('never');
    expect(fake.calls('PATCH', '/api/v1/servers/flint').length).toBe(patches + 1);
    expect(fake.calls('PATCH', '/api/v1/servers/flint').at(-1)?.body).toEqual({ location: 'Rack 2' });
    // Back to Before risky actions needs no more than that.
    const back = await as('PATCH', '/hosts/servers/flint', { asksFirst: 'risky' });
    expect(back.body.asksFirst).toBe('risky');
  });
});

describe('Servers calls on a server set to Never (SA-03, SA-06)', () => {
  it('runs a command at Allowed on Never, and asks on a server that asks before risky actions', async () => {
    expect((await as('PATCH', '/hosts/servers/shale', { asksFirst: 'risky' })).status).toBe(200);
    const ran = await call('server_command', {
      server: 'GRANITE',
      command: 'uptime',
      reason: 'How long it ran',
    });
    expect(ran.status).toBe('ok');
    expect(fake.calls('POST', '/api/v1/servers/granite/exec').length).toBe(1);
    const asked = await call('server_command', {
      server: 'shale',
      command: 'uptime',
      reason: 'How long it ran',
    });
    expect(asked.status).toBe('pending_approval');
    const approval = await lastApproval();
    expect(approval.action).toMatchObject({
      type: 'connection_call',
      params: { tool: 'server_command', server: { id: 'shale', name: 'shale' } },
    });
  });

  it('still asks before restarting the server this Whombat runs on, and offers no way around it', async () => {
    expect((await as('PATCH', '/hosts/servers/basalt', { asksFirst: 'never' })).status).toBe(200);
    const power = await call('server_power', { server: 'basalt', action: 'reboot' });
    expect(power.status).toBe('pending_approval');
    const approval = await lastApproval();
    expect(approval.action.type).toBe('connection_call');
    expect((approval.action.params as { server?: unknown }).server).toBeUndefined();
    // A command there runs.
    const ran = await call('server_command', {
      server: 'basalt',
      command: 'uptime',
      reason: 'How long it ran',
    });
    expect(ran.status).toBe('ok');
  });

  it('still asks before installing updates on the server this Whombat runs on, and checks without asking', async () => {
    const install = await call('server_update', {
      server: 'basalt',
      action: 'install',
      reason: 'Monthly updates',
    });
    expect(install.status).toBe('pending_approval');
    const approval = await lastApproval();
    expect((approval.action.params as { server?: unknown }).server).toBeUndefined();
    expect(fake.calls('POST', '/api/v1/servers/basalt/packages/install')).toHaveLength(0);
    const check = await call('server_update', {
      server: 'basalt',
      action: 'check',
      reason: 'See what waits',
    });
    expect(check.status).toBe('ok');
    // Elsewhere on Never, an Install runs at once.
    expect((await as('PATCH', '/hosts/servers/kvm-lab', { asksFirst: 'never' })).status).toBe(200);
    const lab = await call('server_update', {
      server: 'kvm-lab',
      action: 'install',
      reason: 'Monthly updates',
    });
    expect(lab.status).toBe('ok');
  });
});

describe('Don’t ask again on {server} (SA-07)', () => {
  it('refuses any other scope; the person’s yes runs the call and sets the server to Never', async () => {
    // shale asks before risky actions, so the card offers to stop asking there.
    expect((await as('PATCH', '/hosts/servers/shale', { asksFirst: 'risky' })).status).toBe(200);
    const asked = await call('server_command', { server: 'shale', command: 'df -h', reason: 'Disk space' });
    expect(asked.status).toBe('pending_approval');
    const approval = await lastApproval();
    expect((await decide(approval.number, { decision: 'approve', scope: 'task' })).status).toBe(400);
    expect(await asksRow('shale')).toMatchObject({ asksFirst: 'risky' });
    const execs = fake.calls('POST', '/api/v1/servers/shale/exec').length;
    const yes = await decide(approval.number, { decision: 'approve', scope: 'agent' });
    expect(yes.status).toBe(200);
    expect(await asksRow('shale')).toMatchObject({ asksFirst: 'never' });
    const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(row?.scope).toBe('agent');
    await expect
      .poll(() => fake.calls('POST', '/api/v1/servers/shale/exec').length, { timeout: 10_000 })
      .toBe(execs + 1);
    // The next command there runs without a card.
    expect(
      (await call('server_command', { server: 'shale', command: 'uptime', reason: 'How long it ran' }))
        .status,
    ).toBe('ok');
  });

  it('puts it back with Undo on Done recently', async () => {
    const [change] = await t.services.db
      .select()
      .from(changes)
      .where(and(eq(changes.kind, 'servers.asks'), eq(changes.subjectId, 'granite')))
      .orderBy(desc(changes.createdAt))
      .limit(1);
    expect(change?.title).toBe('Whombat stopped asking first on granite');
    const undo = await as('POST', `/changes/${change?.id}/undo`);
    expect(undo).toMatchObject({ status: 200, body: { state: 'undone' } });
    expect(await asksRow('granite')).toMatchObject({ asksFirst: 'risky' });
    expect(
      (await call('server_command', { server: 'granite', command: 'uptime', reason: 'How long it ran' }))
        .status,
    ).toBe('pending_approval');
  });

  it('removes the row with the server', async () => {
    expect(await asksRow('shale')).not.toBeNull();
    expect((await as('DELETE', '/hosts/servers/shale')).status).toBe(200);
    expect(await asksRow('shale')).toBeNull();
  });
});
