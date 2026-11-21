/**
 * Moving a Whombat to Wi-Fi without losing its servers (network-move.md NM-01…NM-10; network-move-server.md): why this
 * file needs Postgres — `host.cable.set` runs through the runtime's dispatcher for the person's device and is one signed
 * `network.cable_set` in `appliance_events`; the servers' move is kept in `box_network` through the pipeline and shown
 * by `host.network`; the network watch keeps its events there and the Inbox reads them; a connection's check after an
 * address change is read back from `catalog_connections`.
 */
import type { HostNetworkOutput } from '@whombat/protocol/session';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applianceEvents, catalogConnections } from '../db/schema/index';
import { HostsService, setHostsFor } from '../hosts/service';
import { FakeHostsService } from '../hosts/testing/fake';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { insertConnection } from '../test/connections';
import { useManagedRuntime } from '../test/managed';
import { verifyApplianceChain } from './audit';
import { FakeHost } from './fake-host';
import { loadBoxNetwork } from './network-move-store';
import { BoxNetworkWatch, boxNetworkNeedsYou, RECHECK_AFTER_MS } from './network-watch';

const m = useManagedRuntime({ seed: true });
const hub = new FakeHostsService();
let owner: Awaited<ReturnType<typeof m.enroll>>;
let now = Date.parse('2026-11-03T12:00:00.000Z');

type Out = { t: string; output?: HostNetworkOutput; code?: string; details?: unknown };

beforeAll(async () => {
  await hub.start();
  setHostsFor(
    m.t.services,
    new HostsService({
      config: { WHOMBAT_HOSTS_SOCKET: hub.socket, WHOMBAT_HOSTS_TOKEN_FILE: hub.tokenFile },
      db: m.t.services.db,
      log: () => m.t.services.log,
      clock: () => m.t.services.clock(),
    }),
  );
  owner = await m.enroll(IDS.mara);
});
afterAll(() => hub.stop());

/** A Z13 on a cable at 10.100.1.81 with Wi-Fi at 10.100.1.97 (one network), on a clock the test steps. */
function useBox(): FakeHost {
  const host = new FakeHost(() => now, { applyMs: 10, confirmMs: 10, keepMs: 60_000 });
  host.cable.address = '10.100.1.81';
  host.wifiAddress = '10.100.1.97';
  m.manager.host = host;
  m.runtime.network.moves.followMs = 5;
  return host;
}

async function cableEvents() {
  return m.t.services.db
    .select()
    .from(applianceEvents)
    .where(inArray(applianceEvents.type, ['network.cable_set']))
    .orderBy(asc(applianceEvents.seq));
}

describe('Wi-Fi only and the cable again over a session (NM-01, NM-05, NM-07)', () => {
  it('moves the servers to the Wi-Fi first, records the change and the move, and shows the servers found', async () => {
    const host = useBox();
    const servers = hub.fleet.servers as Record<string, unknown>[];
    for (const s of servers) Object.assign(s, { agent_connected: true, via: '10.100.1.81' });
    (servers[0] as Record<string, unknown>).via = '10.100.1.97';
    const c = await m.client(owner);
    const set = (await c.request('host.cable.set', { use: 'wifi' })) as Out & {
      output?: { change: { id: string; use: string } };
    };
    expect(set).toMatchObject({ t: 'result', output: { change: { use: 'wifi', phase: 'applying' } } });
    expect(hub.moves).toEqual(['wss://10.100.1.97:8443']);
    expect(host.cableSets).toEqual([{ use: 'wifi', confirmTimeoutSec: 120 }]);

    const rows = await cableEvents();
    expect(rows.map((r) => [r.actorAccountId, r.endpointId, r.payload])).toEqual([
      [
        owner.accountId,
        owner.endpointId,
        { use: 'wifi', by: 'person', via: 'app', changeId: set.output?.change.id },
      ],
    ]);
    expect(await verifyApplianceChain(m.t.services.db)).toMatchObject({ ok: true });
    expect((await loadBoxNetwork(m.t.services.db)).move).toMatchObject({
      from: '10.100.1.81',
      to: '10.100.1.97',
    });

    now += 100;
    const read = (await c.request('host.network', {})) as Out;
    expect(read.output?.network).toMatchObject({ wifiOnly: true });
    expect(read.output?.move).toMatchObject({
      from: '10.100.1.81',
      to: '10.100.1.97',
      total: servers.length,
      found: 1,
    });
    // Asked again while Wi-Fi only is on: the manager refuses, and the servers aren't moved for nothing.
    hub.moves.length = 0;
    expect(await c.request('host.cable.set', { use: 'wifi' })).toMatchObject({
      t: 'error',
      details: { code: 'unchanged' },
    });
    expect(hub.moves).toEqual([]);

    // The cable again: followed until it is done and the cable has its address (its network takes a moment to give
    // one), then the servers are asked back to the cable's address.
    let leased = false;
    let readsAfterCommit = 0;
    const real = host.networkState.bind(host);
    const spy = vi.spyOn(host, 'networkState').mockImplementation(() => {
      const out = real();
      if (leased) return out;
      if (out.network.cableChange?.phase === 'committed') readsAfterCommit++;
      const wired = out.network.wired.map(({ address: _a, prefixLength: _p, ...w }) => ({
        ...w,
        connected: false,
      }));
      return { ...out, network: { ...out.network, wired } };
    });
    expect(await c.request('host.cable.set', { use: 'cable' })).toMatchObject({ t: 'result' });
    now += 100;
    await vi.waitFor(() => expect(readsAfterCommit).toBeGreaterThan(3));
    expect(hub.moves).toEqual([]);
    leased = true;
    await vi.waitFor(() => expect(hub.moves).toEqual(['wss://10.100.1.81:8443']));
    spy.mockRestore();
    await vi.waitFor(async () =>
      expect((await loadBoxNetwork(m.t.services.db)).move).toMatchObject({
        from: '10.100.1.97',
        to: '10.100.1.81',
      }),
    );
    expect(await c.request('host.cable.set', { use: 'cable' })).toMatchObject({
      t: 'error',
      code: 'conflict',
      details: { code: 'unchanged' },
    });
    c.close();
  });

  it('switches even when the hosts service can’t move its agents (an older one)', async () => {
    useBox();
    hub.moveRoute = false;
    const c = await m.client(owner);
    expect(await c.request('host.cable.set', { use: 'wifi' })).toMatchObject({ t: 'result' });
    hub.moveRoute = true;
    c.close();
  });
});

describe('what owners hear about the box’s network (NM-09, NM-10)', () => {
  it('a cable that stopped, a connection that stopped letting Whombat in after the address changed, and their end', async () => {
    const host = useBox();
    const services = m.t.services;
    const connectionId = await insertConnection(services, {
      catalogId: 'todoist',
      burrowId: TEST_BURROW_ID,
      label: 'Home Assistant',
      secret: 'tok',
    });
    const glance = (g: Record<string, unknown>, at: number) =>
      services.db
        .update(catalogConnections)
        .set({ glance: { status: 'ok', facts: [], ...g }, glanceAt: new Date(at), checkedAt: new Date(at) })
        .where(eq(catalogConnections.id, connectionId));
    await glance({}, now - 60_000);
    // After the change, the stand-in check finds it refusing Whombat.
    let answers = false;
    const watch = new BoxNetworkWatch(services, m.runtime.network, {
      checkConnection: async (row, at) => {
        if (row.id === connectionId) await glance(answers ? {} : { outcome: 'error' }, at.getTime());
      },
    });
    const ctx = () => ({
      db: services.db,
      burrowId: TEST_BURROW_ID,
      personId: IDS.mara,
      now: new Date(now),
      services,
    });

    await watch.check(new Date(now));
    expect((await loadBoxNetwork(services.db)).address).toBe('10.100.1.81');

    // The cable stops while Wi-Fi carries the box.
    host.cable.plugged = false;
    host.cable.connected = false;
    now += 60_000;
    await watch.check(new Date(now));
    let items = await boxNetworkNeedsYou(ctx());
    expect(items.map((i) => i.ref.kind)).toEqual(['box_network']);
    expect((await loadBoxNetwork(services.db)).change).toMatchObject({
      from: '10.100.1.81',
      to: '10.100.1.97',
      before: [connectionId],
    });

    // A minute later its connections are checked again: it refuses Whombat now.
    now += RECHECK_AFTER_MS + 15_000;
    await watch.check(new Date(now));
    items = await boxNetworkNeedsYou(ctx());
    const refused = items.find((i) => i.ref.kind === 'address_refused');
    expect(refused?.title).toContain('Home Assistant');
    expect(refused?.title).toContain('10.100.1.81');
    expect(refused?.subject).toMatchObject({ kind: 'connection', id: connectionId });

    // The cable back and the connection working again: both go.
    host.cable.plugged = true;
    host.cable.connected = true;
    answers = true;
    now += 60_000;
    await glance({}, now - 1_000);
    await watch.check(new Date(now));
    items = await boxNetworkNeedsYou(ctx());
    expect(items).toEqual([]);
    watch.close();
  });

  it('doesn’t check the connections again while Wi-Fi only is still being checked, and not at all once it went back', async () => {
    const services = m.t.services;
    const host = new FakeHost(() => now, { applyMs: 1_000, confirmMs: 150_000, keepMs: 600_000 });
    host.cable.address = '10.100.1.81';
    host.wifiAddress = '10.100.1.97';
    m.manager.host = host;
    const connectionId = await insertConnection(services, {
      catalogId: 'todoist',
      burrowId: TEST_BURROW_ID,
      label: 'Google Calendar',
      handle: 'todoist-2',
      secret: 'tok',
    });
    const glance = (g: Record<string, unknown>, at: number) =>
      services.db
        .update(catalogConnections)
        .set({ glance: { status: 'ok', facts: [], ...g }, glanceAt: new Date(at), checkedAt: new Date(at) })
        .where(eq(catalogConnections.id, connectionId));
    await glance({}, now - 60_000);
    // Wi-Fi has no internet: every connection fails while the box is on it.
    let checks = 0;
    const watch = new BoxNetworkWatch(services, m.runtime.network, {
      checkConnection: async (row, at) => {
        if (row.id !== connectionId) return;
        checks++;
        await glance({ outcome: 'error' }, at.getTime());
      },
    });
    // A pass settles what the test before left (its address change, checked again now).
    now += 120_000;
    await watch.check(new Date(now));
    expect((await loadBoxNetwork(services.db)).change?.checked ?? true).toBe(true);
    host.cableSet({ use: 'wifi', confirmTimeoutSec: 120 });
    const office = host.networks.find((n) => n.ssid === 'Office');
    if (office) office.internet = false;
    now += 60_000;
    await watch.check(new Date(now));
    expect((await loadBoxNetwork(services.db)).change).toMatchObject({
      from: '10.100.1.81',
      to: '10.100.1.97',
    });
    // Past the recheck's wait, still being checked: nothing is checked again.
    now += RECHECK_AFTER_MS + 15_000;
    await watch.check(new Date(now));
    expect(checks).toBe(0);
    // It went back to the cable: the change is over, nothing to tell.
    now += 200_000;
    await watch.check(new Date(now));
    now += 60_000;
    await watch.check(new Date(now));
    expect(checks).toBe(0);
    expect((await loadBoxNetwork(services.db)).change).toBeUndefined();
    const items = await boxNetworkNeedsYou({
      db: services.db,
      burrowId: TEST_BURROW_ID,
      personId: IDS.mara,
      now: new Date(now),
      services,
    });
    expect(items.filter((i) => i.ref.kind === 'address_refused')).toEqual([]);
    if (office) office.internet = undefined;
    watch.close();
  });
});
