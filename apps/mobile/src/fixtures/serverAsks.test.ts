/** “Asks you first” in the one-Whombat demo world (server-asks-mobile.md AP-1746): the setting, and approval #32. */
import { type AnyEndpoint, api } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { createClock } from '../lib/time';
import { createFixtureServer } from './fixture-server';
import { DOCKER_CHAT_ID, SERVER_ASKS_APPROVAL } from './serverAsks';

const burrow = 'burrow-hq';

function world() {
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now: createClock(new Date(at('14:05')), Date.now()),
    setTimer: () => undefined,
    assistant: true,
    // The task chats of before Chat (chatChannel.test.ts has Chat's world).
    chat: false,
  });
  server.realtime.connect();
  const types: string[] = [];
  server.realtime.onEvent((event) => types.push(event.type));
  /** The answer, checked against the endpoint's response schema. */
  const call = async (ep: AnyEndpoint, path: string, init?: RequestInit) => {
    const res = await server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`, init);
    const parsed = ep.response.safeParse(await res.json());
    if (!parsed.success) throw new Error(`${ep.id}: ${parsed.error.message}`);
    return parsed.data as never;
  };
  /** The answer as it came, refusals included. */
  const raw = (path: string, init?: RequestInit) =>
    server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`, init);
  return { call, raw, types };
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Asks you first in the demo world', () => {
  it('starts at Before risky actions and keeps what you choose', async () => {
    const w = world();
    const before: { server: { asksFirst?: string } } = await w.call(
      api.hosts.getServer,
      '/hosts/servers/thetitan',
    );
    expect(before.server.asksFirst).toBe('risky');
    const saved: { asksFirst?: string } = await w.call(
      api.hosts.updateServer,
      '/hosts/servers/thetitan',
      send('PATCH', { asksFirst: 'never' }),
    );
    expect(saved.asksFirst).toBe('never');
    const after: { server: { asksFirst?: string } } = await w.call(
      api.hosts.getServer,
      '/hosts/servers/thetitan',
    );
    expect(after.server.asksFirst).toBe('never');
    const settings: { asksFirst?: string } = await w.call(
      api.hosts.serverSettings,
      '/hosts/servers/thetitan/settings',
    );
    expect(settings.asksFirst).toBe('never');
    const fleet: { servers: { id: string; asksFirst?: string }[] } = await w.call(
      api.hosts.fleet,
      '/hosts/fleet',
    );
    expect(fleet.servers.find((s) => s.id === 'pve-01')?.asksFirst).toBe('risky');
  });

  it('shows Neo’s command on thetitan as a card, and “Don’t ask again” stops asking there', async () => {
    const w = world();
    const page: { messages: { card: { kind: string } | null }[] } = await w.call(
      api.messages.list,
      `/conversations/${DOCKER_CHAT_ID}/messages?limit=50`,
    );
    expect(page.messages.some((m) => m.card?.kind === 'approval')).toBe(true);
    const asked: { approval: { state: string; action: { params: { server?: unknown } } } } = await w.call(
      api.approvals.get,
      `/approvals/${SERVER_ASKS_APPROVAL}`,
    );
    expect(asked.approval.state).toBe('pending');
    expect(asked.approval.action.params.server).toEqual({ id: 'thetitan', name: 'thetitan' });
    const decided: { approval: { state: string; scope?: string } } = await w.call(
      api.approvals.decide,
      `/approvals/${SERVER_ASKS_APPROVAL}/decide`,
      send('POST', { decision: 'approve', scope: 'agent' }),
    );
    expect(decided.approval).toMatchObject({ state: 'approved', scope: 'agent' });
    const after: { server: { asksFirst?: string } } = await w.call(
      api.hosts.getServer,
      '/hosts/servers/thetitan',
    );
    expect(after.server.asksFirst).toBe('never');
    expect(w.types).toEqual(expect.arrayContaining(['message.updated', 'approval.updated', 'hosts.server']));
  });
});

describe('Renaming in the demo world', () => {
  type Named = { id: string; name: string };

  it('keeps a server’s name, says it everywhere and puts the id back for null', async () => {
    const w = world();
    const saved: { name?: string | null } = await w.call(
      api.hosts.updateServer,
      '/hosts/servers/thetitan',
      send('PATCH', { name: 'The Titan' }),
    );
    expect(saved.name).toBe('The Titan');
    const fleet: { servers: Named[] } = await w.call(api.hosts.fleet, '/hosts/fleet');
    expect(fleet.servers.find((s) => s.id === 'thetitan')?.name).toBe('The Titan');
    const page: { server: { name?: string } } = await w.call(api.hosts.getServer, '/hosts/servers/thetitan');
    expect(page.server.name).toBe('The Titan');
    const home: { things: Named[] } = await w.call(api.home.overview, '/home');
    expect(home.things.find((t) => t.id === 'server:thetitan')?.name).toBe('The Titan');
    const settings: { name?: string | null } = await w.call(
      api.hosts.serverSettings,
      '/hosts/servers/thetitan/settings',
    );
    expect(settings.name).toBe('The Titan');

    await w.call(api.hosts.updateServer, '/hosts/servers/thetitan', send('PATCH', { name: null }));
    const back: { server: { name?: string } } = await w.call(api.hosts.getServer, '/hosts/servers/thetitan');
    expect(back.server.name).toBeUndefined();
  });

  it('refuses a name another server goes by, on the name', async () => {
    const w = world();
    const res = await w.raw('/hosts/servers/thetitan', send('PATCH', { name: 'PVE-01' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { fields: { name?: string[] } } };
    expect(body.error.fields.name?.length).toBe(1);
  });

  it('keeps a connection’s label, on Home and in its list', async () => {
    const w = world();
    const saved: { connection: { label: string } } = await w.call(
      api.connections.update,
      '/connections/con_ha',
      send('PATCH', { label: 'House' }),
    );
    expect(saved.connection.label).toBe('House');
    const home: { things: Named[] } = await w.call(api.home.overview, '/home');
    expect(home.things.find((t) => t.id === 'connection:con_ha')?.name).toBe('House');
    const list: { connections: { id: string; label: string }[] } = await w.call(
      api.connections.list,
      '/connections',
    );
    expect(list.connections.find((c) => c.id === 'con_ha')?.label).toBe('House');
  });
});
