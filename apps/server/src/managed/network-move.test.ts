/**
 * Moving a Whombat to Wi-Fi, the pure part (network-move.md NM-05…NM-10; network-move-server.md): the box's address,
 * where agents are asked to go and how far they got, the hub's hold, the cable that stopped, the backup, an address
 * change and the connections that stopped after it.
 */
import type { CableChange, HostNetwork } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import type { ConnectionGlance } from '../home/types';
import { holdCovers, reconnectingOf, toHubInfo } from '../hosts/hub';
import { FakeHost } from './fake-host';
import {
  addressChangeOf,
  agentPortOf,
  agentUrlAt,
  backupChangeOf,
  boxAddress,
  cableAfter,
  connectionHealth,
  currentMove,
  MOVE_KEEP_MS,
  moveProgress,
  stoppedAfterChange,
} from './network-move';

const T0 = Date.parse('2026-11-03T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms);

/** Home on its cable at 10.100.1.81, Wi-Fi beside it at 10.100.1.97. */
function network(over: Partial<HostNetwork> = {}): HostNetwork {
  return {
    online: true,
    checkedAt: at(0).toISOString(),
    wired: [{ interface: 'enp0s13f0u1', connected: true, address: '10.100.1.81', plugged: true }],
    wifi: { interface: 'wlan0', state: 'connected', ssid: 'Home', address: '10.100.1.97', saved: [] },
    change: null,
    wifiOnly: false,
    ...over,
  };
}
const wifiOf = (n: HostNetwork) => n.wifi as NonNullable<HostNetwork['wifi']>;
const cable = (over: Partial<CableChange> = {}): CableChange => ({
  id: 'c-00000007',
  use: 'wifi',
  by: 'person',
  phase: 'applying',
  deadline: at(120_000).toISOString(),
  ...over,
});

/** The fake box's network now (a cable on 10.100.1.42, Wi-Fi on Office at 192.168.1.57). */
function networkOf(host: FakeHost): HostNetwork {
  return host.networkState().network;
}

describe('the box’s address', () => {
  it('is the cable’s while one is in use, else the Wi-Fi’s, else none', () => {
    const host = new FakeHost(() => T0);
    expect(boxAddress(networkOf(host))).toBe('10.100.1.42');
    host.wifiOnly = true;
    host.cable.connected = false;
    expect(boxAddress(networkOf(host))).toBe('192.168.1.57');
    host.connected = null;
    expect(boxAddress(networkOf(host))).toBeNull();
  });

  it('builds the agents’ URL with the hub’s port, IPv6 in brackets', () => {
    expect(agentUrlAt('10.100.1.97', agentPortOf('wss://10.100.1.81:9443'))).toBe('wss://10.100.1.97:9443');
    expect(agentUrlAt('fd00::5', agentPortOf(null))).toBe('wss://[fd00::5]:8443');
  });
});

describe('the servers’ move', () => {
  const cards = [
    { id: 'a', agent_connected: true, via: '10.100.1.97' },
    { id: 'b', agent_connected: true, via: '10.100.1.81' },
    // Dropped around the move: still to come.
    { id: 'c', agent_connected: false, last_seen: at(-30_000).toISOString() },
    // Connected without an address the hub can tell (a forward), and over the tailnet: they reach the box another way.
    { id: 'd', agent_connected: true },
    { id: 'e', agent_connected: true, via: '100.64.107.126' },
    // Switched off a day ago, and never connected: not waited for.
    { id: 'f', agent_connected: false, last_seen: at(-24 * 3_600_000).toISOString() },
    { id: 'g', agent_connected: false },
  ];

  it('counts the servers that move with the box and those connected through the new address', () => {
    expect(
      moveProgress({ from: '10.100.1.81', to: '10.100.1.97', since: at(0).toISOString() }, cards),
    ).toEqual({
      from: '10.100.1.81',
      to: '10.100.1.97',
      since: at(0).toISOString(),
      total: 3,
      found: 1,
    });
    // The old address unknown: any other address may be it.
    expect(moveProgress({ to: '10.100.1.97', since: at(0).toISOString() }, cards)).toMatchObject({
      total: 4,
      found: 1,
    });
  });

  it('shows a recorded move for 24 hours, else the hosts service’s agents’ address change in that time', () => {
    const recorded = { from: '10.100.1.81', to: '10.100.1.97', since: at(0).toISOString() };
    const hub = toHubInfo({
      agent_url: 'wss://10.100.1.98:8443',
      agent_url_previous: 'wss://10.100.1.97:8443',
      agent_url_changed_at: at(1_000).toISOString(),
    });
    expect(currentMove(recorded, hub, at(60_000))).toBe(recorded);
    expect(currentMove(recorded, hub, at(MOVE_KEEP_MS + 500))).toEqual({
      from: '10.100.1.97',
      to: '10.100.1.98',
      since: at(1_000).toISOString(),
    });
    expect(currentMove(recorded, hub, at(MOVE_KEEP_MS + 2_000))).toBeNull();
    // An address by name isn't an IP the contract carries.
    const named = toHubInfo({ agent_url: 'wss://box.lan:8443', agent_url_changed_at: at(0).toISOString() });
    expect(currentMove(null, named, at(1_000))).toBeNull();
  });

  it('doesn’t take the hosts service naming the box’s IPv6 address and then its IPv4 one for a move', () => {
    const flip = toHubInfo({
      agent_url: 'wss://10.100.1.81:8443',
      agent_url_previous: 'wss://[2001:db8:8355:0:0:ff:fe00:22c]:8443',
      agent_url_changed_at: at(0).toISOString(),
    });
    expect(currentMove(null, flip, at(1_000))).toBeNull();
  });

  it('follows the box once its cable change is over, and ends when the box is back at its old address', () => {
    const recorded = { from: '10.100.1.81', to: '10.100.1.97', since: at(0).toISOString() };
    const now = at(60_000);
    const onWifi = network({
      wifiOnly: true,
      wired: [{ interface: 'enp0s13f0u1', connected: false, plugged: true }],
    });
    expect(currentMove(recorded, null, now, onWifi)).toEqual(recorded);
    // While the switch runs the box is still on the cable: the move shows as asked.
    const switching = network({ cableChange: cable({ phase: 'confirming' }) });
    expect(currentMove(recorded, null, now, switching)).toEqual(recorded);
    // Undone (back on the cable), or the router gave the Wi-Fi card the old address: nothing moved.
    expect(
      currentMove(
        recorded,
        null,
        now,
        network({ cableChange: cable({ phase: 'reverted', failure: 'no_internet' }) }),
      ),
    ).toBeNull();
    const oldOnWifi = network({
      wifiOnly: true,
      wired: [],
      wifi: { ...wifiOf(network()), address: '10.100.1.81' },
    });
    expect(currentMove(recorded, null, now, oldOnWifi)).toBeNull();
    // A new address on Wi-Fi: the servers have to find that one.
    const newOnWifi = network({
      wifiOnly: true,
      wired: [],
      wifi: { ...wifiOf(network()), address: '10.100.1.99' },
    });
    expect(currentMove(recorded, null, now, newOnWifi)).toEqual({ ...recorded, to: '10.100.1.99' });
  });
});

describe('the hub’s hold (NM-06)', () => {
  const hold = reconnectingOf({
    since: at(0).toISOString(),
    until: at(300_000).toISOString(),
    reason: 'move',
    waiting: 3,
  });

  it('reads `reconnecting`, and nothing from an older hub', () => {
    expect(hold).toMatchObject({ reason: 'move', waiting: 3 });
    expect(reconnectingOf(undefined)).toBeNull();
    expect(reconnectingOf({ since: 'soon' })).toBeNull();
    expect(toHubInfo({}).reconnecting).toBeNull();
  });

  it('covers a server that dropped around or after it began, not one offline long before or after it ends', () => {
    const now = at(60_000);
    expect(holdCovers(hold, { agentConnected: false, lastSeen: at(-10_000).toISOString() }, now)).toBe(true);
    expect(holdCovers(hold, { agentConnected: false, lastSeen: at(-3_600_000).toISOString() }, now)).toBe(
      false,
    );
    expect(holdCovers(hold, { agentConnected: true, lastSeen: at(0).toISOString() }, now)).toBe(false);
    expect(holdCovers(hold, { agentConnected: false, lastSeen: at(0).toISOString() }, at(300_000))).toBe(
      false,
    );
    expect(holdCovers(null, { agentConnected: false, lastSeen: at(0).toISOString() }, now)).toBe(false);
  });
});

describe('the cable (NM-09)', () => {
  it('stopped while Wi-Fi carries the box: once, until a cable is in use again', () => {
    const host = new FakeHost(() => T0);
    let memory = cableAfter({}, networkOf(host), at(0));
    expect(memory).toMatchObject({ cable: { interface: 'enp198s0f4u1' } });
    expect(memory.lost).toBeUndefined();
    host.cable.plugged = false;
    host.cable.connected = false;
    memory = cableAfter(memory, networkOf(host), at(60_000));
    expect(memory.lost).toEqual({ interface: 'enp198s0f4u1', at: at(60_000).toISOString() });
    // The same event a minute later: no new one.
    expect(cableAfter(memory, networkOf(host), at(120_000)).lost?.at).toBe(at(60_000).toISOString());
    host.cable.plugged = true;
    host.cable.connected = true;
    expect(cableAfter(memory, networkOf(host), at(180_000)).lost).toBeUndefined();
  });

  it('says nothing when Wi-Fi only is chosen, while a cable change runs, or when Wi-Fi doesn’t carry the box', () => {
    const host = new FakeHost(() => T0, { applyMs: 1_000, confirmMs: 1_000, keepMs: 60_000 });
    const seen = cableAfter({}, networkOf(host), at(0));
    host.cableSet({ use: 'wifi', confirmTimeoutSec: 120 });
    // Applying: the cable is still in use; the change runs.
    host.cable.connected = false;
    expect(cableAfter(seen, networkOf(host), at(500)).lost).toBeUndefined();
    host.wifiOnly = true;
    expect(cableAfter(seen, networkOf(host), at(60_000))).toEqual({});
    const offline = new FakeHost(() => T0);
    const before = cableAfter({}, networkOf(offline), at(0));
    offline.cable.connected = false;
    offline.controlReachable = false;
    expect(cableAfter(before, networkOf(offline), at(60_000)).lost).toBeUndefined();
  });

  it('finds the box’s own switch back to its cable (NM-03)', () => {
    const host = new FakeHost(() => T0);
    expect(backupChangeOf(networkOf(host))).toBeNull();
    const change = host.backupToCable();
    expect(backupChangeOf(networkOf(host))).toBe(change.id);
  });
});

describe('an address change and the connections after it (NM-10)', () => {
  it('is a change only between two known, different addresses', () => {
    expect(addressChangeOf('10.100.1.81', '10.100.1.97', at(0))).toEqual({
      from: '10.100.1.81',
      to: '10.100.1.97',
      at: at(0).toISOString(),
    });
    expect(addressChangeOf('10.100.1.81', '10.100.1.81', at(0))).toBeNull();
    expect(addressChangeOf('10.100.1.81', null, at(0))).toBeNull();
    expect(addressChangeOf(undefined, '10.100.1.97', at(0))).toBeNull();
  });

  it('reads a connection’s health and picks those that worked before and are refused or unreachable after', () => {
    const glance = (g: Partial<ConnectionGlance>): ConnectionGlance => ({ status: 'ok', facts: [], ...g });
    expect(connectionHealth({ status: 'active', glance: glance({}) })).toBe('working');
    expect(connectionHealth({ status: 'active', glance: glance({ status: 'warn' }) })).toBe('working');
    expect(connectionHealth({ status: 'needs_reauth', glance: glance({}) })).toBe('refused');
    expect(
      connectionHealth({
        status: 'active',
        glance: glance({
          status: 'bad',
          lines: [{ check: 'conn.signin', tone: 'bad', nature: 'you', title: 'x' }],
        }),
      }),
    ).toBe('refused');
    expect(connectionHealth({ status: 'active', glance: glance({ outcome: 'offline' }) })).toBe(
      'unreachable',
    );
    expect(connectionHealth({ status: 'active', glance: null })).toBe('unknown');
    const after = new Map([
      ['ha', 'refused'],
      ['unifi', 'working'],
      ['plex', 'unreachable'],
      ['nas', 'unreachable'],
    ] as const);
    expect(stoppedAfterChange(new Set(['ha', 'unifi', 'plex', 'never']), after)).toEqual(['ha', 'plex']);
  });
});
