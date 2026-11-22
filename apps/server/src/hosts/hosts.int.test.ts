/**
 * Servers through Whombat against the fake hosts service on a unix socket (one-whombat-servers.md): the REST routes
 * (actor headers, roles, mapping, refusals in plain words), changes signed and recorded with
 * Undo, the console proxy, the event stream as realtime frames, Home's sources, Add a server, and the built-in Servers
 * connection's tools through `/mcp` with real agent tokens (tiers, sensitive calls asking, changes recorded).
 */
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startChat } from '../chats/commands';
import { decideApproval } from '../commands/approvals';
import {
  approvals,
  catalogConnections,
  changes,
  connectionTools,
  dispatches,
  events,
  messages,
  widgetPoints,
  widgets,
} from '../db/schema/index';
import { listChanges } from '../home/changes';
import { openChange } from '../home/registry';
import { pinWidget, refreshWidget } from '../home/widgets';
import { loadPrincipalRow } from '../read/principals';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent } from '../test/personal';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { FIXED_PASSES } from '../things/quiet/apply';
import { startHosts } from './index';
import { ensureServersConnection } from './provision';
import { quietServerPass } from './quiet';
import { serverLabel } from './self';
import { hostsFor } from './service';
import { hostsNeedsYou, hostsThings, hostsWatch } from './sources';
import { FakeHostsService } from './testing/fake';

const fake = new FakeHostsService();
const t = useTestServer({
  seed: true,
  listen: true,
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});

let personCookie = '';
let whombat = { agentId: '', dmId: '' };
const frames: BusFrame[] = [];

const base = () => '/api/v1/burrows/burrow-hq/hosts';

async function as(method: string, path: string, body?: unknown) {
  const res = await t.api.inject({
    method: method as 'GET',
    url: `${base()}${path}`,
    headers: {
      cookie: personCookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown> & { error?: { message: string } },
  };
}

/** Undo as a person presses it: `changes.undo` (one-whombat-assistant.md ONE-DW19, ONE-DW20). */
async function pressUndo(changeId: string) {
  const res = await t.api.inject({
    method: 'POST',
    url: `/api/v1/burrows/burrow-hq/changes/${changeId}/undo`,
    headers: { cookie: personCookie },
  });
  return {
    status: res.statusCode,
    body: res.json() as { state?: string; error?: { message: string } },
  };
}

async function lastChange(kind?: string) {
  const rows = await t.services.db
    .select()
    .from(changes)
    .where(kind ? eq(changes.kind, kind) : undefined)
    .orderBy(desc(changes.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

async function principalRow(id: string) {
  const row = await loadPrincipalRow(t.services.db, id);
  if (!row) throw new Error(id);
  return row;
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 4000): Promise<NonNullable<T>> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A turn of the agent for Mara through `/mcp` (one-person.md OP-S41), no message of hers needed (a schedule's). */
async function turn() {
  const d = await agentTokenFor(t.services, t.burrowId, whombat.agentId, whombat.dmId, {
    onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
  });
  return mcpClient(t.baseUrl, d.token);
}

/** One Servers tool through `connection_call`. */
async function call(tool: string, args: Record<string, unknown>) {
  const mcp = await turn();
  const res = await mcp.client.callTool({
    name: 'connection_call',
    arguments: { connection: 'servers', tool, arguments: args },
  });
  await mcp.close();
  return (res.structuredContent ?? {}) as { status: string; content?: string; message?: string };
}

beforeAll(async () => {
  await fake.start();
  personCookie = (await sessionFor(t.services, IDS.mara)).cookie;
  const made = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null });
  whombat = { agentId: made.agentId, dmId: made.dmId };
  await setConnectionKeys(t.services, whombat.agentId, { read: 'can', write: 'can' });
  t.services.bus.onFrame((f) => {
    if (f.topic.startsWith('hosts:')) frames.push(f);
  });
  // Server reports are batched for 5 s in production; a moment here (TS-S08).
  startHosts(t.services, { serverFlushMs: 200 });
  await waitFor(() => fake.streams === 1);
});

afterAll(async () => {
  await fake.stop();
});

describe('status and reads', () => {
  it('says the service is here and healthy', async () => {
    const o = await as('GET', '/status');
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({ present: true, healthy: true, servers: 10 });
    expect(o.body.agentUrl).toBe('wss://10.100.0.2:8443');
  });

  it('reads the fleet, and a detail read as the person', async () => {
    const res = await as('GET', '/fleet');
    expect(res.status).toBe(200);
    const servers = res.body.servers as { id: string; status: string; cpu24h: unknown[] }[];
    expect(servers.map((s) => s.id)).toContain('shale');
    expect(servers.find((s) => s.id === 'basalt')?.cpu24h).toHaveLength(48);
    // Whombat's own cached reads go as Whombat; a detail read goes as the person.
    await as('GET', '/servers/basalt');
    const call = fake.calls('GET', '/api/v1/servers/basalt').at(-1);
    expect(call?.actor).toBe('prn_mara|Mara Okafor');
    expect(call?.role).toBe('admin');
  });

  it('maps a Proxmox server and refuses an unknown one in plain words', async () => {
    const shale = await as('GET', '/servers/shale');
    expect(shale.status).toBe(200);
    expect((shale.body.server as { platform: string }).platform).toBe('proxmox');
    const none = await as('GET', '/servers/nope');
    expect(none.status).toBe(404);
    expect(none.body.error?.message).toBe('There’s no server called nope.');
  });

  it('lists guests, reads one with what may be done, and its configuration', async () => {
    const page = await as('GET', '/guests?server=shale');
    expect((page.body.guests as unknown[]).length).toBeGreaterThan(5);
    const guest = await as('GET', '/servers/shale/guests/pve:101');
    expect(guest.body).toMatchObject({ id: 'pve:101', serverId: 'shale', name: 'win-build' });
    const config = await as('GET', '/servers/shale/manage?op=config.get&guestId=pve:101');
    expect(config.status).toBe(200);
    expect((config.body.config as { digest: string }).digest).toBe('d1');
  });
});

describe('changes', () => {
  it('asks for a confirmation the service needs', async () => {
    const o = await as('POST', '/servers/basalt/guests/docker:redis/actions', { action: 'restart' });
    expect(o.status).toBe(400);
  });

  it('starts a guest as the person, signs it and records it with its inverse; Undo stops it again', async () => {
    const res = await as('POST', '/servers/basalt/guests/docker:backup-job/actions', {
      action: 'start',
    });
    expect(res.status).toBe(202);
    expect(res.body.actionId).toMatch(/^act_/);
    const call = fake.calls('POST', '/api/v1/servers/basalt/guests/docker:backup-job/actions').at(-1);
    expect(call?.actor).toBe('prn_mara|Mara Okafor');
    expect(call?.role).toBe('admin');
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'hosts.change'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(event?.text).toBe('Started backup-job on basalt');
    const change = await lastChange('hosts.guest_power');
    expect(change).toMatchObject({ title: 'Started backup-job on basalt', undoKind: 'hosts.guest_power' });
    // Undo by the person: the inverse runs on the service at once and marks the change undone.
    const undo = await pressUndo(change?.id as string);
    expect(undo).toMatchObject({ status: 200, body: { state: 'undone' } });
    const inverse = fake.calls('POST', '/api/v1/servers/basalt/guests/docker:backup-job/actions').at(-1);
    expect(inverse?.body).toEqual({ action: 'stop', confirm: true });
    const [after] = await t.services.db
      .select()
      .from(changes)
      .where(eq(changes.id, change?.id as string));
    expect(after?.undoneAt).toBeTruthy();
  });

  it('changes a configuration with its digest, and Undo puts the old values back unless changed again', async () => {
    const res = await as('POST', '/servers/shale/manage', {
      op: 'config.set',
      guestId: 'pve:103',
      params: { set: { memory: '24576' } },
      digest: 'd1',
    });
    expect(res.status).toBe(200);
    expect(res.body.changes).toEqual([{ key: 'memory', old: '16384', new: '24576', pending: true }]);
    const change = await lastChange('hosts.guest_config');
    expect(change?.title).toBe('Changed the memory of postgres-prod on shale');
    expect(change?.detail).toBe('memory: 16384 → 24576 (after a restart)');
    // A digest that doesn't match anymore: “Changed meanwhile — review again.”
    const stale = await as('POST', '/servers/shale/manage', {
      op: 'config.set',
      guestId: 'pve:103',
      params: { set: { cores: '8' } },
      digest: 'd1',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.message).toBe('Changed meanwhile — review again.');
    const undo = await pressUndo(change?.id as string);
    expect(undo).toMatchObject({ status: 200, body: { state: 'undone' } });
    expect(fake.configs.get('shale/pve:103')?.values.memory).toBe('16384');
    // Undone again by hand meanwhile: the next change's Undo refuses.
    await as('POST', '/servers/shale/manage', {
      op: 'config.set',
      guestId: 'pve:103',
      params: { set: { cores: '6' } },
      digest: `d${fake.configs.get('shale/pve:103')?.digest}`,
    });
    const second = await lastChange('hosts.guest_config');
    const config = fake.configs.get('shale/pve:103');
    if (config) config.values.cores = '2';
    const refused = await pressUndo(second?.id as string);
    expect(refused).toMatchObject({
      status: 409,
      body: {
        error: {
          message: 'The settings of postgres-prod were changed again since, so this can’t be undone.',
        },
      },
    });
  });

  it('saves of a server’s settings in a row are one change, kept off Home, and Undo goes back before the first', async () => {
    const before = (await as('GET', '/servers/shale/settings')).body as {
      group: string;
      remoteControl: Record<string, boolean>;
    };
    const count = async () =>
      (await t.services.db.select().from(changes).where(eq(changes.kind, 'hosts.server_settings'))).length;
    const rows = await count();
    for (const body of [
      { remoteControl: { console: !before.remoteControl.console } },
      { remoteControl: { power: !before.remoteControl.power } },
      { group: 'lab-hr06' },
    ])
      expect((await as('PATCH', '/servers/shale', body)).status).toBe(200);
    expect(await count()).toBe(rows + 1);
    const change = await lastChange('hosts.server_settings');
    expect(change?.mergeFields).toEqual(['switch.console', 'switch.power', 'group']);
    expect(change?.title).toMatch(/group of shale and what Whombat may do/);
    // A person's own change stays off Home; the server's page keeps it (HR-05).
    const mara = await principalRow(IDS.mara);
    const home = await listChanges(t.services.db, mara, { now: t.services.clock() });
    expect(home.changes.map((c) => c.id)).not.toContain(change?.id);
    const page = await listChanges(t.services.db, mara, { thing: 'server:shale', now: t.services.clock() });
    expect(page.changes[0]).toMatchObject({ id: change?.id, actor: { kind: 'person', id: IDS.mara } });
    expect(page.changes[0]?.link).toBe('/things/server%3Ashale');
    const undo = await pressUndo(change?.id as string);
    expect(undo).toMatchObject({ status: 200, body: { state: 'undone' } });
    expect(fake.calls('PATCH', '/api/v1/servers/shale').at(-1)?.body).toEqual({
      group: before.group,
      remote_control: { console: before.remoteControl.console, power: before.remoteControl.power },
    });
  });

  it('snoozes an alert, with Undo taking the snooze back', async () => {
    const res = await as('POST', '/alerts/al_02/ack', { minutes: 120 });
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toMatchObject({ by: 'Mara Okafor (prn_mara)' });
    const change = await lastChange('hosts.alert_ack');
    expect(change?.title).toBe('Snoozed “Disk nvme1n1 is 78% worn out” for 2 hours');
    const undo = await pressUndo(change?.id as string);
    expect(undo).toMatchObject({ status: 200, body: { state: 'undone' } });
    expect(fake.alerts.find((a) => a.id === 'al_02')?.acknowledged).toBeNull();
  });

  it('acknowledges an alert from Watch on the service, and a hint on the person’s own view (CT-349)', async () => {
    const ack = async (ref: { kind: string; id: string }, acknowledged?: boolean) => {
      const res = await t.api.inject({
        method: 'POST',
        url: '/api/v1/burrows/burrow-hq/watch/acknowledge',
        headers: { cookie: personCookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ ref, ...(acknowledged === undefined ? {} : { acknowledged }) }),
      });
      return { status: res.statusCode, body: res.json() as { state?: string } };
    };
    expect(await ack({ kind: 'alert', id: 'al_01' })).toEqual({
      status: 200,
      body: { ref: { kind: 'alert', id: 'al_01' }, state: 'acknowledged' },
    });
    expect(fake.alerts.find((a) => a.id === 'al_01')?.acknowledged).toMatchObject({
      by: 'Mara Okafor (prn_mara)',
    });
    expect((await lastChange('hosts.alert_ack'))?.title).toMatch(/^Acknowledged “/);
    expect((await ack({ kind: 'alert', id: 'al_01' }, false)).body.state).toBe('open');
    expect(fake.alerts.find((a) => a.id === 'al_01')?.acknowledged).toBeNull();
    // A hint has no acknowledgement on the service: it is the person's own.
    hostsFor(t.services).forget();
    const watch = async () => {
      const res = await t.api.inject({
        method: 'GET',
        url: '/api/v1/burrows/burrow-hq/watch?state=all',
        headers: { cookie: personCookie },
      });
      return (res.json() as { items: { ref: { kind: string; id: string }; state: string }[] }).items;
    };
    const hint = (await watch()).find((i) => i.ref.kind === 'hint');
    expect(hint).toBeDefined();
    const ref = hint?.ref as { kind: string; id: string };
    expect((await ack(ref)).body.state).toBe('acknowledged');
    const same = (items: { ref: { kind: string; id: string }; state: string }[]) =>
      items.find((i) => i.ref.kind === ref.kind && i.ref.id === ref.id)?.state;
    expect(same(await watch())).toBe('acknowledged');
    expect((await ack(ref, false)).body.state).toBe('open');
    expect(same(await watch())).toBe('open');
  });

  it('adds a server: the install command, the waiting server on Needs you, approval', async () => {
    const made = await as('POST', '/enrollments');
    expect(made.status).toBe(201);
    expect(String(made.body.installCommand)).toContain('--pinnedpubkey');
    const pending = fake.requestEnrollment('pebble');
    const list = await as('GET', '/enrollments');
    expect((list.body.items as { hostname: string }[]).map((e) => e.hostname)).toContain('pebble');
    hostsFor(t.services).forget();
    const needs = await hostsNeedsYou({
      db: t.services.db,
      burrowId: t.burrowId,
      personId: IDS.mara,
      now: new Date(),
      services: t.services,
    });
    expect(needs.find((n) => n.kind === 'enrollment')?.title).toBe('pebble wants to be added');
    const approved = await as('POST', `/enrollments/${pending.id}/approve`, { group: 'Lab' });
    expect(approved.body).toEqual({ serverId: 'pebble' });
  });
});

describe('events, Home and Watch', () => {
  it('turns the service’s events into hosts frames', async () => {
    frames.length = 0;
    fake.emit('alert.opened', {
      id: 'al_9',
      server: 'granite',
      severity: 'critical',
      title: 'RAID degraded',
      detail: 'md0 lost a disk',
      opened_at: '2026-10-11T13:59:00Z',
      rule: 'raid.degraded',
      state: 'open',
      attention: true,
    });
    fake.emit('guest.state_changed', { server: 'basalt', id: 'docker:redis', state: 'stopped' });
    const alert = await waitFor(() => frames.find((f) => f.event.type === 'hosts.alert'));
    expect(alert.topic).toBe(`hosts:${t.burrowId}`);
    expect(alert.event).toMatchObject({ alert: { id: 'al_9', serverId: 'granite', severity: 'critical' } });
    expect(await waitFor(() => frames.find((f) => f.event.type === 'hosts.guest'))).toBeTruthy();
    await waitFor(() => frames.find((f) => f.event.type === 'hosts.server'));
  });

  it('shows servers as things, alerts and hints on Watch, critical alerts on Needs you', async () => {
    hostsFor(t.services).forget();
    const ctx = {
      db: t.services.db,
      burrowId: t.burrowId,
      personId: IDS.mara,
      now: new Date(),
      services: t.services,
    };
    const things = await hostsThings(ctx);
    const basalt = things.find((x) => x.id === 'server:basalt');
    expect(basalt).toMatchObject({
      kind: 'server',
      status: 'warn',
      href: '/things/server%3Abasalt',
      icon: 'nixos',
    });
    expect(basalt?.facts.map((f) => f.label)).toEqual(['CPU', 'Memory', 'Hottest', 'Guests']);
    const watch = await hostsWatch(ctx);
    expect(watch.find((w) => w.id === 'hosts.alert:al_01')).toMatchObject({ severity: 'bad', state: 'open' });
    expect(watch.some((w) => w.ref.kind === 'hint')).toBe(true);
    const needs = await hostsNeedsYou(ctx);
    expect(needs.find((n) => n.id === 'hosts.alert:al_01')?.actions.map((a) => a.label)).toEqual([
      'Look into it',
      'Remind me tomorrow',
    ]);
  });
});

describe('a chat and a widget about a server', () => {
  it('names a chat’s server as the service does, and refuses one it doesn’t know', async () => {
    const res = await t.commit(IDS.mara, startChat, {
      text: 'Why is basalt busy?',
      subject: { kind: 'server', id: 'basalt', name: 'Made up by the app' },
    });
    if (res.status !== 'ok') throw new Error(res.status);
    const [m] = await t.services.db.select().from(messages).where(eq(messages.id, res.result.messageId));
    expect(m).toMatchObject({
      subjectKind: 'server',
      subjectId: 'basalt',
      subjectName: serverLabel('basalt'),
    });
    expect(m?.subjectName).not.toBe('Made up by the app');
    await expect(
      t.commit(IDS.mara, startChat, {
        text: 'And this one?',
        subject: { kind: 'server', id: 'no-such-server', name: 'Ghost' },
      }),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Server not found.' });
  });

  it('starts a chat about a server from the last fleet read while the hosts service hangs', async () => {
    await hostsFor(t.services).fleetRaw();
    let release: () => void = () => {};
    const hung = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    fake.on('GET', '/api/v1/fleet', () => hung);
    hostsFor(t.services).forget('fleet');
    try {
      const started = Date.now();
      const res = await t.commit(IDS.mara, startChat, {
        text: 'Is basalt still busy?',
        subject: { kind: 'server', id: 'basalt', name: 'Made up by the app' },
      });
      // The write never waits on the service: well under the 2 s it would give a first read.
      expect(Date.now() - started).toBeLessThan(1_500);
      if (res.status !== 'ok') throw new Error(res.status);
      const [m] = await t.services.db.select().from(messages).where(eq(messages.id, res.result.messageId));
      expect(m).toMatchObject({ subjectId: 'basalt', subjectName: serverLabel('basalt') });
      await expect(
        t.commit(IDS.mara, startChat, {
          text: 'And this one?',
          subject: { kind: 'server', id: 'no-such-server', name: 'Ghost' },
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      release();
    }
  });

  it('pins a server’s metrics and reads their newest values; a server that is gone says so', async () => {
    const forMara = { onBehalfOf: { principalId: IDS.mara } };
    const pin = (serverId: string) =>
      t.commit(
        whombat.agentId,
        pinWidget,
        { title: 'Basalt', source: { kind: 'server_metric', serverId, series: ['cpu_pct', 'mem_pct'] } },
        forMara,
      );
    const res = await pin('basalt');
    if (res.status !== 'ok') throw new Error(res.status);
    await t.services.background.settle();
    expect(await refreshWidget(t.services, res.result.widgetId)).toBe(true);
    const [point] = await t.services.db
      .select()
      .from(widgetPoints)
      .where(eq(widgetPoints.widgetId, res.result.widgetId))
      .orderBy(desc(widgetPoints.t))
      .limit(1);
    expect(point?.values.cpu_pct).toEqual(expect.any(Number));
    expect(point?.values.mem_pct).toEqual(expect.any(Number));
    const gone = await pin('no-such-server');
    if (gone.status !== 'ok') throw new Error(gone.status);
    await t.services.background.settle();
    expect(await refreshWidget(t.services, gone.result.widgetId)).toBe(false);
    const [row] = await t.services.db.select().from(widgets).where(eq(widgets.id, gone.result.widgetId));
    expect(row?.lastError).toContain('isn’t in your servers');
  });
});

describe('the Servers connection', () => {
  async function setTier(tool: string, tier: 'can' | 'ask' | 'off') {
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.catalogId, 'whombat_servers'));
    await t.services.db
      .update(connectionTools)
      .set({ tier })
      .where(and(eq(connectionTools.connectionId, row?.id as string), eq(connectionTools.name, tool)));
  }

  it('is provisioned in the burrow with the Servers tools', async () => {
    const id = await ensureServersConnection(t.services);
    expect(id).toBeTruthy();
    const tools = await t.services.db
      .select()
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, id as string));
    expect(tools.map((x) => x.name)).toContain('server_command');
    expect(tools.find((x) => x.name === 'servers_overview')?.tier).toBe('can');
    // Changes start Allowed like every connection's (CX-20a); the sensitive ones ask whatever the tier.
    expect(tools.find((x) => x.name === 'guest_power')?.tier).toBe('can');
  });

  it('signs in with `none`, setting the first version’s `builtin` right, so the Connections list reads it', async () => {
    const servers = async () =>
      (
        await t.services.db
          .select()
          .from(catalogConnections)
          .where(eq(catalogConnections.catalogId, 'whombat_servers'))
      )[0];
    expect((await servers())?.signIn).toBe('none');
    await t.services.db
      .update(catalogConnections)
      .set({ signIn: 'builtin' as never })
      .where(eq(catalogConnections.catalogId, 'whombat_servers'));
    await ensureServersConnection(t.services);
    expect((await servers())?.signIn).toBe('none');
    // Outside production every answer is checked against the contract: a `builtin` here would be a 500.
    const res = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/connections',
      headers: { cookie: personCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { connections: { catalogId: string; signIn: string }[] };
    expect(list.connections.find((c) => c.catalogId === 'whombat_servers')?.signIn).toBe('none');
  });

  it('reads the servers for the agent, as “Dusty for Mara”', async () => {
    const res = await call('servers_overview', {});
    expect(res.status).toBe('ok');
    const body = JSON.parse(res.content ?? '{}') as { servers: { id: string }[] };
    expect(body.servers.map((s) => s.id)).toContain('basalt');
    const detail = await call('server_detail', { server: 'SHALE' });
    expect(detail.status).toBe('ok');
    expect(fake.calls('GET', '/api/v1/servers/shale').at(-1)?.actor).toBe(
      `${whombat.agentId}|Dusty for Mara`,
    );
    // The switches the server's changes meet: read as admin, not as a viewer who sees them all off (TF-01).
    expect(fake.calls('GET', '/api/v1/servers/shale').at(-1)?.role).toBe('admin');
    const rc = (JSON.parse(detail.content ?? '{}') as { server: { remoteControl: Record<string, unknown> } })
      .server.remoteControl;
    expect(rc).toMatchObject({ manage: true, power: true, console: true });
    expect(rc.manageReason).toBeUndefined();
  });

  it('asks before a change at Ask, runs it at Allowed and records it; stopping asks where it asks before risky actions', async () => {
    // basalt asks before risky actions (every server starts at Never), so stopping and commands ask there.
    expect((await as('PATCH', '/servers/basalt', { asksFirst: 'risky' })).status).toBe(200);
    await setTier('guest_power', 'ask');
    const asked = await call('guest_power', { server: 'basalt', guest: 'backup-job', action: 'start' });
    expect(asked.status).toBe('pending_approval');
    // The approval says what it does in words, as the mock's “Restart … on pve-02?”.
    const [approval] = await t.services.db.select().from(approvals).orderBy(desc(approvals.number)).limit(1);
    expect(approval?.title).toBe('Start backup-job on basalt');
    expect(approval?.question).toBe('Start backup-job on basalt?');
    const decided = await t.commit(IDS.mara, decideApproval, {
      number: approval?.number as number,
      decision: 'approve',
    });
    expect(decided.status).toBe('ok');
    // The agent is woken with the result to say how it went, as after any other yes (task-feedback.md TF-S10).
    await expect
      .poll(
        async () =>
          (
            await t.services.db
              .select()
              .from(dispatches)
              .where(
                and(
                  eq(dispatches.approvalId, approval?.id as string),
                  eq(dispatches.trigger, 'approval_granted'),
                ),
              )
          ).length,
        { timeout: 10_000 },
      )
      .toBe(1);
    expect(
      (await t.services.db.select().from(messages).where(eq(messages.conversationId, whombat.dmId))).some(
        (m) => m.text === 'Starting backup-job on basalt now.',
      ),
    ).toBe(false);
    await setTier('guest_power', 'can');
    const ran = await call('guest_power', { server: 'basalt', guest: 'backup-job', action: 'start' });
    expect(ran.status).toBe('ok');
    const change = await lastChange('hosts.guest_power');
    expect(change).toMatchObject({
      agentId: whombat.agentId,
      personId: IDS.mara,
      title: 'Started backup-job on basalt',
    });
    const stop = await call('guest_power', { server: 'basalt', guest: 'backup-job', action: 'stop' });
    expect(stop.status).toBe('pending_approval');
    const command = await call('server_command', {
      server: 'basalt',
      command: 'uptime',
      reason: 'See how long it has run',
    });
    expect(command.status).toBe('pending_approval');
  });

  it('undoes the agent’s change as a new call of the agent', async () => {
    const change = await lastChange('hosts.guest_power');
    const before = fake.calls('POST', '/api/v1/servers/basalt/guests/docker:backup-job/actions').length;
    const undo = await pressUndo(change?.id as string);
    expect(undo).toMatchObject({ status: 200, body: { state: 'asked' } });
    // The inverse (stop) is sensitive: it asks a person instead of running.
    expect(fake.calls('POST', '/api/v1/servers/basalt/guests/docker:backup-job/actions').length).toBe(before);
  });

  it('undoes the agent’s change only where it went', async () => {
    const change = await lastChange('hosts.guest_power');
    const recorded = change ? openChange(t.services.custody, change) : null;
    expect(recorded?.undo.payload).toMatchObject({ serverId: 'basalt', destination: expect.any(String) });
    const [servers] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.catalogId, 'whombat_servers'));
    if (!servers) throw new Error('no Servers connection');
    // The Servers connection goes elsewhere since: the inverse would go there, so Undo refuses and nothing is sent.
    await t.services.db
      .update(catalogConnections)
      .set({ credentialVersion: servers.credentialVersion + 1 })
      .where(eq(catalogConnections.id, servers.id));
    try {
      const before = fake.calls('POST', '/api/v1/servers/basalt/guests/docker:backup-job/actions').length;
      const undo = await pressUndo(change?.id as string);
      expect(undo.status).toBe(409);
      expect(undo.body.error?.message).toContain('changed since, so this can’t be undone here');
      expect(fake.calls('POST', '/api/v1/servers/basalt/guests/docker:backup-job/actions').length).toBe(
        before,
      );
    } finally {
      await t.services.db
        .update(catalogConnections)
        .set({ credentialVersion: servers.credentialVersion })
        .where(eq(catalogConnections.id, servers.id));
    }
  });

  it('runs read-only checks and says why a tool can’t be used', async () => {
    const list = await call('server_diagnose', { server: 'basalt' });
    expect(JSON.parse(list.content ?? '{}').checks.length).toBe(4);
    const ran = await call('server_diagnose', { server: 'basalt', check: 'smart' });
    expect(JSON.parse(ran.content ?? '{}')).toMatchObject({ ok: true, server: 'basalt' });
    const usage = await call('server_disk_usage', { server: 'basalt', mount: '/' });
    expect(JSON.parse(usage.content ?? '{}')).toMatchObject({
      ok: true,
      server: 'basalt',
      mount: '/',
    });
    const detail = await as('GET', '/servers/basalt');
    expect(detail.status).toBe(200);
    expect((detail.body.diskUsage as { mount: string }[] | undefined)?.[0]?.mount).toBe('/');
    const routeUsage = await as('POST', '/servers/basalt/disk-usage', { mount: '/' });
    expect(routeUsage.status).toBe(200);
    expect(routeUsage.body).toMatchObject({ ok: true, mount: '/' });
    const bad = await call('server_detail', { server: 'nope' });
    expect(bad.status).toBe('failed');
    expect(bad.message).toContain('There’s no server “nope”');
  });

  it('provisions one Servers connection when readiness checks race the first start', async () => {
    // The fixture has already exercised its connection. Start again from no row
    // to cover the same first-provision race as startHosts plus an explicit check.
    await t.services.pipeline.transactAccount((tx) =>
      tx.delete(catalogConnections).where(eq(catalogConnections.catalogId, 'whombat_servers')),
    );
    const ids = await Promise.all(Array.from({ length: 8 }, () => ensureServersConnection(t.services)));
    expect(ids[0]).toBeTruthy();
    expect(new Set(ids).size).toBe(1);
    const rows = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.catalogId, 'whombat_servers'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ids[0], handle: 'servers', signIn: 'none', status: 'active' });
    const tools = await t.services.db
      .select()
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, ids[0] as string));
    expect(tools.map((tool) => tool.name)).toContain('servers_overview');
  });
});

describe('agents that keep themselves up to date (agent-updates.md)', () => {
  const homeOf = (personId: string) => ({
    db: t.services.db,
    burrowId: t.burrowId,
    personId,
    now: new Date(),
    services: t.services,
  });
  const updatedOn = async (server: string) =>
    (await t.services.db.select().from(changes).where(eq(changes.kind, 'hosts.agent_updated'))).filter(
      (c) => c.subjectId === server,
    );
  const lastEvent = async () =>
    (
      await t.services.db
        .select()
        .from(events)
        .where(eq(events.type, 'hosts.change'))
        .orderBy(desc(events.seq))
        .limit(1)
    )[0];

  beforeAll(() => {
    fake.agents.serve = true;
    // Shale lets Whombat run commands as root (the last install, AU-07), whatever an earlier test switched.
    const shale = fake.details.shale as { server: { remote_control: Record<string, unknown> } };
    Object.assign(shale.server.remote_control, { host_shell: true, agent_host_shell: true });
    hostsFor(t.services).forget();
  });
  afterAll(() => {
    fake.agents.serve = false;
    hostsFor(t.services).forget();
  });

  it('reads and switches “Keep server agents up to date” for the person, signed', async () => {
    const read = await as('GET', '/agents/settings');
    expect(read).toMatchObject({ status: 200, body: { autoUpdate: true, halted: false } });
    const off = await as('PATCH', '/agents/settings', { autoUpdate: false });
    expect(off.body).toEqual({ autoUpdate: false, halted: false });
    expect(fake.agents.settings.auto_update).toBe(false);
    const call = fake.calls('PATCH', '/api/v1/agents/settings').at(-1);
    expect(call).toMatchObject({
      actor: 'prn_mara|Mara Okafor',
      role: 'admin',
      body: { auto_update: false },
    });
    expect((await lastEvent())?.text).toMatch(/Turned off Keep Whombat’s helper up to date/);
    await as('PATCH', '/agents/settings', { autoUpdate: true });
    expect(fake.agents.settings.auto_update).toBe(true);
  });

  it('carries the agent’s update on the server’s settings, and Worth a look says what needs a person', async () => {
    const shale = await as('GET', '/servers/shale/settings');
    expect((shale.body.agent as { update: unknown }).update).toMatchObject({
      reasonCode: 'no_key',
      canInstall: true,
      available: false,
    });
    const quartz = await as('GET', '/servers/quartz/settings');
    expect((quartz.body.agent as { update: unknown }).update).toMatchObject({
      reasonCode: 'no_key',
      canInstall: false,
    });
    const detail = await as('GET', '/servers/shale');
    expect((detail.body.hints as { kind: string }[]).map((h) => h.kind)).toContain('agent.needs_install');
    const watch = await hostsWatch(homeOf(IDS.mara));
    const agents = watch.filter((w) => w.id.includes(':agent.'));
    expect(agents.map((w) => w.serverId).sort()).toEqual(['quartz', 'shale']);
    expect(agents.find((w) => w.serverId === 'shale')?.body).toMatch(/Update it on the System tab/);
    expect(agents.find((w) => w.serverId === 'quartz')?.body).toMatch(/install command/);
  });

  it('Update now: a signed update, then Done recently on the server’s page as the person who pressed it', async () => {
    const res = await as('POST', '/servers/basalt/agent/update');
    expect(res).toMatchObject({ status: 202, body: { state: 'updating' } });
    expect(fake.calls('POST', '/api/v1/agents/update').at(-1)).toMatchObject({
      role: 'admin',
      body: { servers: ['basalt'] },
    });
    const [done] = await waitFor(async () => {
      const rows = await updatedOn('basalt');
      return rows.length ? rows : null;
    });
    expect(done).toMatchObject({
      title: 'Updated Whombat’s helper on basalt',
      actorId: IDS.mara,
      agentId: null,
    });
    // A person's own press stays off Home's Done recently (HR-05), on the server's page.
    const page = await listChanges(t.services.db, await principalRow(IDS.mara), {
      thing: 'server:basalt',
      now: new Date(),
    });
    expect(page.changes.map((c) => c.title)).toContain('Updated Whombat’s helper on basalt');
  });

  it('the last install where Whombat may run commands as root', async () => {
    const res = await as('POST', '/servers/shale/agent/update');
    expect(res).toMatchObject({ status: 202, body: { state: 'installing' } });
    await waitFor(async () => (await updatedOn('shale')).length > 0);
    hostsFor(t.services).forget('agents');
    const after = await as('GET', '/servers/shale/settings');
    expect((after.body.agent as { update: unknown }).update).toMatchObject({ reasonCode: 'up_to_date' });
  });

  it('an automatic update is Whombat’s on Home, signed once', async () => {
    fake.agents.finish('granite');
    fake.emit('agent.update', { server: 'granite', state: 'updated', from: 'x', to: fake.agents.build });
    fake.agents.finish('obsidian');
    await waitFor(async () => (await updatedOn('obsidian')).length > 0);
    const granite = await updatedOn('granite');
    expect(granite).toHaveLength(1);
    const signer = await principalRow(granite[0]?.actorId as string);
    expect(signer).toMatchObject({ name: 'Whombat', kind: 'system', system: 'servers' });
    expect(granite[0]?.agentId).toBe(signer.id);
    const home = await listChanges(t.services.db, await principalRow(IDS.mara), { now: new Date() });
    expect(home.changes.find((c) => c.title === 'Updated Whombat’s helper on granite')?.actor).toMatchObject({
      kind: 'whombat',
      name: 'Whombat',
    });
    // Nothing in any conversation.
    expect((await t.services.db.select().from(messages).where(eq(messages.authorId, signer.id))).length).toBe(
      0,
    );
  });

  it('refuses in words: one more install by hand, another update running, nothing to update, no such server', async () => {
    const quartz = await as('POST', '/servers/quartz/agent/update');
    expect(quartz.status).toBe(409);
    expect(quartz.body.error?.message).toMatch(/one more install/);
    fake.agents.autoFinish = false;
    try {
      expect((await as('POST', '/servers/flint/agent/update')).status).toBe(202);
      const busy = await as('POST', '/servers/onyx/agent/update');
      expect(busy.status).toBe(409);
      expect(busy.body.error?.message).toBe('Another update is already running. Try again in a few minutes.');
      fake.agents.finish('flint');
    } finally {
      fake.agents.autoFinish = true;
    }
    const again = await as('POST', '/servers/basalt/agent/update');
    expect(again.body.error?.message).toMatch(/already up to date/);
    const offline = await as('POST', '/servers/marble/agent/update');
    expect(offline.body.error?.message).toMatch(/isn’t connected/);
    const none = await as('POST', '/servers/nope/agent/update');
    expect(none.status).toBe(404);
  });

  it('a failed update is Worth a look and stops the round; Update now there clears it', async () => {
    fake.agents.fail('onyx', { halt: true });
    hostsFor(t.services).forget('agents');
    expect((await as('GET', '/agents/settings')).body).toEqual({ autoUpdate: true, halted: true });
    const watch = await hostsWatch(homeOf(IDS.mara));
    expect(watch.find((w) => w.serverId === 'onyx' && w.id.includes('agent.update_failed'))?.title).toMatch(
      /Whombat’s helper didn’t update/,
    );
    expect((await as('POST', '/servers/onyx/agent/update')).status).toBe(202);
    await waitFor(async () => (await updatedOn('onyx')).length > 0);
    expect(fake.agents.settings.halted_version).toBeNull();
  });
});

describe('quiet notices on servers (quiet-notices.md QN-21…QN-24)', () => {
  const thing = (server: string, suffix: string) =>
    `/api/v1/burrows/burrow-hq/things/${encodeURIComponent(`server:${server}`)}${suffix}`;
  async function quietCall(method: 'GET' | 'POST', url: string, body?: unknown) {
    const res = await t.api.inject({
      method,
      url,
      headers: {
        cookie: personCookie,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }
  const home = (personId: string) => ({
    db: t.services.db,
    burrowId: t.burrowId,
    personId,
    now: new Date(),
    services: t.services,
  });
  const serverOf = async (id: string) => {
    hostsFor(t.services).forget();
    return (await hostsThings(home(IDS.mara))).find((x) => x.id === `server:${id}`);
  };
  const wear = { check: 'host.disk.wear_high', subject: 'nvme1n1' };

  it('Ignore, Remind me tomorrow and Undo on an alert are the hosts service’s, and the dot follows (QN-23)', async () => {
    expect((await serverOf('basalt'))?.status).toBe('warn');
    const res = await quietCall('POST', thing('basalt', '/quiet'), { notice: wear, how: 'ignore' });
    expect(res.status).toBe(200);
    expect(res.body.quiet).toMatchObject({ state: 'ignored', by: { id: IDS.mara } });
    const al02 = () => fake.alerts.find((a) => a.id === 'al_02');
    expect(al02()?.acknowledged).toMatchObject({ until: null });
    expect(fake.calls('POST', '/api/v1/alerts/al_02/ack').at(-1)?.body).toEqual({});
    expect(await serverOf('basalt')).toMatchObject({ status: 'ok' });
    // The page marks it, the banner goes; the change is in the server's Activity, not in Done recently.
    const page = await as('GET', '/servers/basalt');
    const alerts = page.body.alerts as { id: string; quiet?: { state: string } }[];
    expect(alerts.find((a) => a.id === 'al_02')?.quiet?.state).toBe('ignored');
    expect(page.body.banner).toBeNull();
    expect((page.body.server as { status: string }).status).toBe('ok');
    const change = await lastChange('thing.control.quiet.ignore');
    expect(change).toMatchObject({ subjectKind: 'server', subjectId: 'basalt', actorId: IDS.mara });
    // Remind me tomorrow: until 09:00 in the burrow's zone.
    const snoozed = await quietCall('POST', thing('basalt', '/quiet'), {
      notice: wear,
      how: 'snooze',
    });
    expect(snoozed.body.quiet).toMatchObject({ state: 'snoozed' });
    const minutes = Number(
      (fake.calls('POST', '/api/v1/alerts/al_02/ack').at(-1)?.body as { minutes?: number } | undefined)
        ?.minutes,
    );
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(33 * 60);
    const undone = await quietCall('POST', thing('basalt', '/quiet'), { notice: wear, how: 'undo' });
    expect(undone).toMatchObject({ status: 200, body: { quiet: null } });
    expect(al02()?.acknowledged).toBeNull();
    expect((await serverOf('basalt'))?.status).toBe('warn');
    expect((await quietCall('POST', thing('basalt', '/quiet'), { notice: wear, how: 'undo' })).status).toBe(
      404,
    );
  });

  it('Needs you’s Ignore on a server alert is the hosts service’s (QN-21)', async () => {
    hostsFor(t.services).forget();
    expect((await hostsNeedsYou(home(IDS.mara))).some((n) => n.id === 'hosts.alert:al_01')).toBe(true);
    const ignore = async (ignored: boolean) =>
      quietCall('POST', '/api/v1/burrows/burrow-hq/needs-you/ignore', {
        ref: { kind: 'alert', id: 'al_01' },
        ignored,
      });
    expect((await ignore(true)).status).toBe(200);
    expect(fake.alerts.find((a) => a.id === 'al_01')?.acknowledged).toMatchObject({ until: null });
    hostsFor(t.services).forget();
    expect((await hostsNeedsYou(home(IDS.mara))).some((n) => n.id === 'hosts.alert:al_01')).toBe(false);
    // marble is offline and its “offline” alert ignored: it stays offline on its page, with no dot.
    expect(await serverOf('marble')).toMatchObject({ status: 'ok' });
    const watch = await hostsWatch(home(IDS.mara));
    expect(watch.find((w) => w.id === 'hosts.alert:al_01')?.state).toBe('acknowledged');
    expect((await ignore(false)).status).toBe(200);
    expect(fake.alerts.find((a) => a.id === 'al_01')?.acknowledged).toBeNull();
    expect((await serverOf('marble'))?.status).toBe('offline');
  });

  it('a hint is quieted in Whombat, lifts by itself once fixed, and can be switched off (QN-23, QN-S55, QN-S56)', async () => {
    fake.setHint('granite', 'guests.unhealthy', {
      server: 'granite',
      kind: 'guests.unhealthy',
      severity: 'warning',
      entity: 'host',
      title: '1 app not working',
      detail: 'web (unhealthy)',
      link: '#guests',
    });
    expect((await serverOf('granite'))?.status).toBe('warn');
    const notice = { check: 'host.hint.guests.unhealthy' };
    const res = await quietCall('POST', thing('granite', '/quiet'), { notice, how: 'ignore' });
    expect(res.body.quiet).toMatchObject({ state: 'ignored', words: 'until another one stops working' });
    expect((await serverOf('granite'))?.status).toBe('ok');
    const watch = await hostsWatch(home(IDS.mara));
    expect(watch.find((w) => w.id.startsWith('hosts.hint:granite:guests.unhealthy'))?.state).toBe(
      'acknowledged',
    );
    const listed = await quietCall('GET', thing('granite', '/watch'));
    const checks = listed.body.checks as { check: string; exceptions: { state: string }[] }[];
    expect(checks.find((c) => c.check === notice.check)?.exceptions.map((e) => e.state)).toEqual(['ignored']);
    expect(checks.some((c) => c.check.startsWith('host.check.'))).toBe(false);
    // Fixed: an hour of passes without it while the server is online ends the Ignore; it isn't recorded.
    fake.setHint('granite', 'guests.unhealthy', null);
    hostsFor(t.services).forget();
    for (let i = 1; i < FIXED_PASSES; i++) expect(await quietServerPass(t.services)).toBe(0);
    expect(await quietServerPass(t.services)).toBe(1);
    // Stop watching the check as a whole: its lines are on no page.
    fake.setHint('granite', 'guests.unhealthy', {
      server: 'granite',
      kind: 'guests.unhealthy',
      severity: 'warning',
      entity: 'host',
      title: '2 apps not working',
      detail: 'web (unhealthy), db (unhealthy)',
      link: '#guests',
    });
    const off = await quietCall('POST', thing('granite', '/watch'), {
      check: notice.check,
      watched: false,
    });
    expect(off.status).toBe(200);
    expect(
      (off.body.checks as { check: string; on: boolean }[]).find((c) => c.check === notice.check)?.on,
    ).toBe(false);
    const page = await as('GET', '/servers/granite');
    expect((page.body.hints as { kind: string }[]).map((h) => h.kind)).not.toContain('guests.unhealthy');
    expect((await serverOf('granite'))?.status).toBe('ok');
    expect((await lastChange('thing.control.watch.off'))?.subjectId).toBe('granite');
  });

  it('Watch’s Ignore on a hint is the shared one, Bring it back takes it back; a backup job asks the assistant to fix it (QN-25, QN-26)', async () => {
    fake.setHint('granite', 'guest.no_backup_job', {
      server: 'granite',
      kind: 'guest.no_backup_job',
      severity: 'info',
      entity: 'host',
      title: '2 guests in no backup job',
      detail: 'web, db',
      link: '#guests',
    });
    hostsFor(t.services).forget();
    const watchItem = async () =>
      (await hostsWatch(home(IDS.mara))).find((w) =>
        w.id.startsWith('hosts.hint:granite:guest.no_backup_job'),
      );
    const item = await watchItem();
    expect(item).toMatchObject({ nature: 'you', fixable: true, state: 'open' });
    const ref = item?.ref;
    const ignored = await quietCall('POST', '/api/v1/burrows/burrow-hq/needs-you/ignore', { ref });
    expect(ignored).toMatchObject({ status: 200, body: { ignored: true } });
    expect((await lastChange('thing.control.quiet.ignore'))?.subjectId).toBe('granite');
    hostsFor(t.services).forget();
    expect((await watchItem())?.state).toBe('acknowledged');
    const back = await quietCall('POST', '/api/v1/burrows/burrow-hq/watch/acknowledge', {
      ref,
      acknowledged: false,
    });
    expect(back.status).toBe(200);
    hostsFor(t.services).forget();
    expect((await watchItem())?.state).toBe('open');
    fake.setHint('granite', 'guest.no_backup_job', null);
  });

  it('switches the rules that start off off in the hosts service, until someone turns one on (watch-defaults.md)', async () => {
    hostsFor(t.services).forget();
    await quietServerPass(t.services);
    const puts = (rule: string) =>
      fake
        .calls('PUT', '/api/v1/servers/basalt/watch')
        .filter((c) => (c.body as { rule?: string } | undefined)?.rule === rule);
    expect(puts('disk.wear_high').at(-1)).toMatchObject({ body: { rule: 'disk.wear_high', off: true } });
    expect(puts('disk.space_high')).toEqual([]);
    // The hosts service resolved the worn disk's alert: it shows nowhere.
    expect(fake.alerts.some((a) => a.id === 'al_02')).toBe(false);
    const wear = (body: Record<string, unknown>) =>
      (body.checks as { check: string; on: boolean; off?: unknown }[]).find(
        (c) => c.check === 'host.disk.wear_high',
      );
    const listed = await quietCall('GET', thing('basalt', '/watch'));
    expect(wear(listed.body)).toMatchObject({ on: false });
    expect(wear(listed.body)?.off).toBeUndefined();
    // Turned on: the hosts service watches it again, signed, and the next pass leaves it on.
    const on = await quietCall('POST', thing('basalt', '/watch'), {
      check: 'host.disk.wear_high',
      watched: true,
    });
    expect(on.status).toBe(200);
    expect(wear(on.body)).toMatchObject({ on: true });
    expect(fake.watchOffs.get('basalt')?.some((o) => o.rule === 'disk.wear_high' && !o.entity)).toBe(false);
    expect((await lastChange('thing.control.watch.on'))?.subjectId).toBe('basalt');
    const before = puts('disk.wear_high').length;
    hostsFor(t.services).forget();
    await quietServerPass(t.services);
    expect(puts('disk.wear_high')).toHaveLength(before);
  });

  it('Stop watching a rule for one disk switches it off in the hosts service, and back on (QN-13)', async () => {
    // Worn disks start off (watch-defaults.md): the test before turned them on for basalt.
    fake.openAlert({
      id: 'al_02',
      server: 'basalt',
      severity: 'warning',
      title: 'Disk nvme1n1 is 78% worn out',
      rule: 'disk.wear_high',
      entity: 'nvme1n1',
    });
    hostsFor(t.services).forget();
    const off = await quietCall('POST', thing('basalt', '/watch'), {
      check: 'host.disk.wear_high',
      subject: { id: 'nvme1n1', name: 'nvme1n1' },
      watched: false,
    });
    expect(off.status).toBe(200);
    expect(fake.calls('PUT', '/api/v1/servers/basalt/watch').at(-1)).toMatchObject({
      role: 'operator',
      body: { rule: 'disk.wear_high', entity: 'nvme1n1', off: true },
    });
    const wear = (
      off.body.checks as { check: string; on: boolean; exceptions: Record<string, unknown>[] }[]
    ).find((c) => c.check === 'host.disk.wear_high');
    expect(wear?.on).toBe(true);
    expect(wear?.exceptions).toEqual([
      expect.objectContaining({
        subject: { id: 'nvme1n1', name: 'nvme1n1' },
        state: 'stopped',
        by: expect.anything(),
      }),
    ]);
    // The hosts service resolved its open alert: the server is fine.
    expect(fake.alerts.some((a) => a.id === 'al_02')).toBe(false);
    expect((await serverOf('basalt'))?.status).toBe('ok');
    expect((await lastChange('thing.control.watch.off'))?.title).toMatch(/nvme1n1/);
    const on = await quietCall('POST', thing('basalt', '/watch'), {
      check: 'host.disk.wear_high',
      subject: { id: 'nvme1n1', name: 'nvme1n1' },
      watched: true,
    });
    expect(on.status).toBe(200);
    expect(fake.watchOffs.get('basalt')?.some((o) => o.rule === 'disk.wear_high')).toBe(false);
    // The hub's own checks aren't a server's to switch off.
    expect(
      (
        await quietCall('POST', thing('basalt', '/watch'), {
          check: 'host.check.down',
          watched: false,
        })
      ).status,
    ).toBe(404);
  });

  it('the agent reads quiet lines marked (QN-24)', async () => {
    fake.openAlert({
      id: 'al_40',
      server: 'shale',
      severity: 'warning',
      title: 'Ran out of memory',
      rule: 'host.oom',
      entity: 'host',
    });
    fake.openAlert({
      id: 'al_41',
      server: 'shale',
      severity: 'warning',
      title: '/srv is 91% full',
      rule: 'disk.space_high',
      entity: 'fs:/srv',
    });
    hostsFor(t.services).forget();
    await quietCall('POST', thing('shale', '/quiet'), {
      notice: { check: 'host.host.oom' },
      how: 'ignore',
    });
    const res = await call('alerts_list', { server: 'shale' });
    const body = JSON.parse(res.content ?? '{}') as {
      alerts: { id: string; quiet?: string }[];
      quietNote?: string;
    };
    expect(body.alerts.find((a) => a.id === 'al_40')?.quiet).toMatch(/^Ignored by Mara/);
    expect(body.alerts.find((a) => a.id === 'al_41')).toBeDefined();
    expect(body.alerts.find((a) => a.id === 'al_41')?.quiet).toBeUndefined();
    expect(body.quietNote).toBeTruthy();
  });
});

describe('a Mac (macos-servers.md)', () => {
  /** One Servers tool through `connection_call`, with the MCP answer's parts (text and pictures). */
  async function callRaw(tool: string, args: Record<string, unknown>) {
    const mcp = await turn();
    const res = await mcp.client.callTool({
      name: 'connection_call',
      arguments: { connection: 'servers', tool, arguments: args },
    });
    await mcp.close();
    const parts = (res.content ?? []) as { type: string; data?: string; mimeType?: string; text?: string }[];
    const out = (res.structuredContent ?? {}) as { status: string; content?: string; isError?: boolean };
    return { out, parts, body: JSON.parse(out.content ?? '{}') as Record<string, unknown> };
  }

  beforeAll(async () => {
    await ensureServersConnection(t.services);
    fake.macos.addMac('studio');
    hostsFor(t.services).forget('fleet', 'agents');
  });

  it('reads as a Mac, with its own facts, its screen and its helper', async () => {
    const res = await as('GET', '/servers/studio');
    expect(res.status).toBe(200);
    const d = res.body as { server: Record<string, unknown>; macos: Record<string, unknown> };
    expect(d.server).toMatchObject({ platform: 'macos', osFamily: 'macos' });
    expect(d.macos).toMatchObject({
      modelName: 'Mac Studio',
      screen: { sharing: true, account: 'john', signInAt: null },
      helper: { running: true, ax: true },
    });
  });

  it('opens its screen as the host’s VNC console, signed in words', async () => {
    const res = await as('POST', '/servers/studio/consoles', {});
    expect(res.status).toBe(201);
    expect(res.body.protocol).toBe('vnc');
    const [signed] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'hosts.change'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(signed?.text).toBe('Opened the screen of studio');
  });

  it('gives the person a screenshot to read and steps on the screen, signed once the Mac did them', async () => {
    const look = await as('GET', '/servers/studio/screen?maxW=640&format=jpeg');
    expect(look.status).toBe(200);
    expect(look.body).toMatchObject({ ok: true, w: 640, screenW: 3840, format: 'jpeg' });
    expect(look.body.imageB64).toBeTruthy();
    // A screenshot is the person's whole desktop: an owner's, at admin.
    expect(fake.macos.steps.at(-1)).toMatchObject({ body: { op: 'look', max_w: 640 }, role: 'admin' });
    fake.macos.note = 'The Mac locks again when this screen session ends.';
    const unlock = await as('POST', '/servers/studio/screen', { op: 'unlock' });
    expect(unlock.status).toBe(200);
    expect(unlock.body).toMatchObject({ ok: true, status: { locked: false }, message: /locks again/ });
    expect((await lastChange('hosts.screen'))?.title).toBe('Unlocked studio’s screen');
    // A refused password is the Mac's answer, not an error; nothing is signed and nothing kept.
    const wrong = await as('POST', '/servers/studio/screen', {
      op: 'account.set',
      account: { user: 'john', password: 'not-it' },
    });
    expect(wrong.body).toMatchObject({ ok: false, code: 'sign_in_failed' });
    expect(fake.macos.steps.at(-1)?.body).toMatchObject({ account: { user: 'john', password: '•••' } });
  });

  it('says plainly that a server that isn’t a Mac has no screen', async () => {
    const res = await as('POST', '/servers/basalt/screen', { op: 'status' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error?.message).toContain('isn’t a Mac');
  });

  it('shows the assistant the screen as a picture, with its size and the scale', async () => {
    const { out, parts, body } = await callRaw('mac_screen', { server: 'studio', action: 'look' });
    expect(out.status).toBe('ok');
    expect(parts.map((p) => p.type)).toEqual(['text', 'image']);
    expect(parts[1]).toMatchObject({ mimeType: 'image/jpeg' });
    expect(body).toMatchObject({ screen_w: 3840, image_w: 1280, scale: 3 });
    expect(fake.macos.steps.at(-1)).toMatchObject({
      body: { op: 'look', max_w: 1280, format: 'jpeg' },
      role: 'admin',
      actor: `${whombat.agentId}|Dusty for Mara`,
    });
  });

  it('tells the assistant the Mac’s own word on a step, and to leave a prompt it can’t answer to the person', async () => {
    fake.macos.note = 'Pressed; the app is still busy.';
    const pressed = await callRaw('mac_ui', { server: 'studio', action: 'press', name: 'Allow' });
    expect(pressed.body).toMatchObject({ done: true, message: 'Pressed; the app is still busy.' });
    fake.macos.notAdmin = true;
    try {
      const refused = await callRaw('mac_screen', { server: 'studio', action: 'password' });
      expect(refused.out.isError).toBe(true);
      expect(refused.body).toMatchObject({ code: 'not_admin' });
      expect(String(refused.body.error)).toContain('Accessibility');
    } finally {
      fake.macos.notAdmin = false;
    }
  });

  it('clicks in the screen’s pixels and looks again; a click stays out of Done recently', async () => {
    const { out, parts, body } = await callRaw('mac_screen', {
      server: 'studio',
      action: 'click',
      x: 1800,
      y: 1100,
    });
    expect(out.status).toBe('ok');
    expect(body).toMatchObject({ action: 'click', done: true, scale: 3 });
    expect(parts.some((p) => p.type === 'image')).toBe(true);
    const [click, again] = fake.macos.steps.slice(-2);
    expect(click).toMatchObject({ body: { op: 'click', x: 1800, y: 1100 }, role: 'admin' });
    expect(again?.body).toMatchObject({ op: 'look' });
    expect((await lastChange('thing.control.hosts.mac_screen'))?.title).toBe('Clicked on studio’s screen');
  });

  it('presses a button by name, and says what to do when no name matches', async () => {
    const pressed = await callRaw('mac_ui', { server: 'studio', action: 'press', name: 'Allow' });
    expect(pressed.out.status).toBe('ok');
    expect(pressed.body).toMatchObject({ done: true, element: { title: 'Allow' } });
    expect((await lastChange('hosts.mac_ui'))?.title).toBe('Pressed “Allow” on studio');
    const missed = await callRaw('mac_ui', { server: 'studio', action: 'press', name: 'Nope' });
    expect(missed.out.isError).toBe(true);
    expect(missed.body).toMatchObject({ code: 'not_found' });
    expect(String(missed.body.next)).toContain('mac_ui list');
    const notMac = await callRaw('mac_ui', { server: 'basalt', action: 'apps' });
    expect(notMac.body).toMatchObject({ code: 'unsupported' });
  });

  it('reads Find My for the owner in memory, and never runs an action that removes something', async () => {
    const empty = await as('GET', '/servers/studio/find-my');
    expect(empty).toMatchObject({
      status: 200,
      body: { server: 'studio', reading: false, readAt: null, people: [] },
    });
    // The fake hub's Mac runs an agent from before Find My: its status doesn't say how long the Mac was left alone.
    expect((await as('POST', '/servers/studio/find-my/refresh', {})).status).toBe(200);
    const seen = await waitFor(async () => {
      const r = await as('GET', '/servers/studio/find-my');
      return r.body.reading === false && r.body.problem ? r.body : null;
    });
    expect(seen.problem).toMatchObject({ code: 'helper_old' });
    expect(fake.macos.steps.at(-1)).toMatchObject({ body: { op: 'status' }, role: 'operator' });
    expect((await as('GET', '/servers/studio/find-my/map?w=600&h=400')).status).toBe(409);
    expect((await as('GET', `/servers/studio/find-my/picture?person=${'0'.repeat(12)}`)).status).toBe(404);

    const steps = fake.macos.steps.length;
    const removed = await as('POST', '/servers/studio/screen', {
      op: 'ui.action',
      app: 'Find My',
      name: 'Mara Visser',
      action: 'Remove Friend',
    });
    expect(removed.status).toBe(403);
    expect(removed.body.error?.message).toContain('“Remove Friend”');
    const byAssistant = await callRaw('mac_ui', {
      server: 'studio',
      action: 'action',
      name: 'Mara Visser',
      perform: 'Remove Friend',
    });
    expect(byAssistant.out.isError).toBe(true);
    expect(byAssistant.body).toMatchObject({ code: 'destructive_action' });
    expect(fake.macos.steps).toHaveLength(steps);
  });

  it('asks before a step on the screen where the Mac asks first, never before a look', async () => {
    expect((await as('PATCH', '/servers/studio', { asksFirst: 'risky' })).status).toBe(200);
    try {
      expect((await callRaw('mac_screen', { server: 'studio', action: 'look' })).out.status).toBe('ok');
      expect((await callRaw('mac_ui', { server: 'studio', action: 'list' })).out.status).toBe('ok');
      const asked = await callRaw('mac_ui', { server: 'studio', action: 'press', name: 'Allow' });
      expect(asked.out.status).toBe('pending_approval');
      const [approval] = await t.services.db
        .select()
        .from(approvals)
        .orderBy(desc(approvals.number))
        .limit(1);
      expect(approval?.title).toContain('“Allow”');
    } finally {
      await as('PATCH', '/servers/studio', { asksFirst: 'never' });
    }
  });
});
