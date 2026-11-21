/**
 * What owners hear about the box's network, pure (network-move.md NM-09, NM-10; network-move-server.md): the kept
 * state after a pass — the cable, the backup, an address change with the connections that worked before, those refused
 * after it — and the Inbox items it makes (facts, not sentences).
 */
import type { HostNetwork } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../connections/types';
import type { ConnectionGlance } from '../home/types';
import { checkStartsOn } from '../things/quiet/defaults';
import { FakeHost } from './fake-host';
import { boxNetworkStateOf } from './network-move-store';
import {
  BOX_NETWORK_CHECKS,
  boxNetworkItems,
  NETWORK_HREF,
  nextState,
  type PassInput,
} from './network-watch';

const T0 = Date.parse('2026-11-03T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms);
const empty = () => boxNetworkStateOf({});

function conn(
  id: string,
  glance: Partial<ConnectionGlance> | null,
  checkedAt: number,
  status = 'active',
): { row: CatalogConnectionRow } {
  return {
    row: {
      id,
      burrowId: 'b1',
      label: id === 'ha' ? 'Home Assistant' : id,
      status,
      glance: glance ? { status: 'ok', facts: [], ...glance } : null,
      checkedAt: new Date(T0 + checkedAt),
    } as unknown as CatalogConnectionRow,
  };
}

function pass(network: HostNetwork | null, over: Partial<PassInput> = {}): PassInput {
  return { network, hubChange: null, connections: [], seen: new Map(), recheck: null, now: at(0), ...over };
}

describe('the kept state after a pass', () => {
  it('remembers the box’s address and, when it changes, the connections that worked before it', () => {
    const host = new FakeHost(() => T0);
    const first = nextState(empty(), pass(host.networkState().network));
    expect(first.address).toBe('10.100.1.42');
    expect(first.change).toBeUndefined();
    host.wifiOnly = true;
    host.cable.connected = false;
    const connections = [
      conn('ha', {}, -60_000),
      conn('plex', { outcome: 'offline' }, -60_000),
      conn('late', {}, 15_000),
    ];
    const changed = nextState(first, pass(host.networkState().network, { connections, now: at(10_000) }));
    expect(changed.address).toBe('192.168.1.57');
    expect(changed.change).toMatchObject({
      from: '10.100.1.42',
      to: '192.168.1.57',
      at: at(10_000).toISOString(),
      before: ['ha'],
      checked: false,
    });
  });

  it('takes the pass before’s look at a connection already checked again after the change', () => {
    const host = new FakeHost(() => T0);
    const first = nextState(empty(), pass(host.networkState().network));
    host.wifiOnly = true;
    host.cable.connected = false;
    const seen = new Map([['ha', { health: 'working' as const, checkedAt: T0 - 120_000 }]]);
    const changed = nextState(
      first,
      pass(host.networkState().network, {
        connections: [conn('ha', { outcome: 'error' }, 15_000)],
        seen,
        now: at(10_000),
      }),
    );
    expect(changed.change?.before).toEqual(['ha']);
  });

  it('keeps the connections refused after the change until they work again', () => {
    const s = {
      ...empty(),
      address: '192.168.1.57',
      change: {
        from: '10.100.1.42',
        to: '192.168.1.57',
        at: at(0).toISOString(),
        before: ['ha'],
        checked: false,
      },
    };
    const refused = {
      connectionId: 'ha',
      burrowId: 'b1',
      name: 'Home Assistant',
      from: '10.100.1.42',
      to: '192.168.1.57',
      at: at(60_000).toISOString(),
    };
    const host = new FakeHost(() => T0);
    host.wifiOnly = true;
    host.cable.connected = false;
    const n = host.networkState().network;
    const checked = nextState(
      s,
      pass(n, {
        connections: [conn('ha', { outcome: 'error' }, 60_000)],
        recheck: [refused],
        now: at(60_000),
      }),
    );
    expect(checked.change?.checked).toBe(true);
    expect(checked.refused.map((r) => r.connectionId)).toEqual(['ha']);
    // Checked again later and still refused: kept; working again: gone.
    expect(
      nextState(
        checked,
        pass(n, { connections: [conn('ha', { outcome: 'error' }, 400_000)], now: at(400_000) }),
      ).refused,
    ).toHaveLength(1);
    expect(
      nextState(checked, pass(n, { connections: [conn('ha', {}, 400_000)], now: at(400_000) })).refused,
    ).toHaveLength(0);
  });

  it('undoes a change that went back before it was checked, and uses the hosts service’s change without a manager', () => {
    const host = new FakeHost(() => T0);
    const first = nextState(empty(), pass(host.networkState().network));
    host.wifiOnly = true;
    host.cable.connected = false;
    const moved = nextState(first, pass(host.networkState().network, { now: at(5_000) }));
    host.wifiOnly = false;
    host.cable.connected = true;
    expect(nextState(moved, pass(host.networkState().network, { now: at(20_000) })).change).toBeUndefined();
    const hubChange = { from: '10.100.1.81', to: '10.100.1.97', at: at(-30_000).toISOString() };
    const viaHub = nextState(empty(), pass(null, { hubChange }));
    expect(viaHub.change).toMatchObject({ from: '10.100.1.81', to: '10.100.1.97' });
    expect(viaHub.hubChangedAt).toBe(hubChange.at);
    // Seen once: the next pass doesn't start it again.
    expect(
      nextState({ ...viaHub, change: undefined }, pass(null, { hubChange, now: at(60_000) })).change,
    ).toBeUndefined();
  });

  it('keeps the backup’s event once, until Wi-Fi only is chosen again or three days went by', () => {
    const host = new FakeHost(() => T0);
    host.wifiOnly = true;
    host.cable.connected = false;
    const change = host.backupToCable();
    const s = nextState(empty(), pass(host.networkState().network));
    expect(s.backup).toEqual({ changeId: change.id, at: at(0).toISOString() });
    expect(nextState(s, pass(host.networkState().network, { now: at(60_000) })).backup?.at).toBe(
      at(0).toISOString(),
    );
    expect(nextState(s, pass(null, { now: at(3 * 24 * 3600_000) })).backup).toBeUndefined();
    host.wifiOnly = true;
    expect(nextState(s, pass(host.networkState().network, { now: at(120_000) })).backup).toBeUndefined();
  });
});

describe('the Inbox items', () => {
  const state = {
    ...empty(),
    cableLost: { interface: 'enp198s0f4u1', at: at(0).toISOString() },
    backup: { changeId: 'c-fake000001', at: at(1_000).toISOString() },
    refused: [
      {
        connectionId: 'ha',
        burrowId: 'b1',
        name: 'Home Assistant',
        from: '10.100.1.81',
        to: '10.100.1.97',
        at: at(2_000).toISOString(),
      },
      {
        connectionId: 'other',
        burrowId: 'b2',
        name: 'Elsewhere',
        from: '10.100.1.81',
        to: '10.100.1.97',
        at: at(2_000).toISOString(),
      },
    ],
  };

  it('names the Whombat and the connection, links where it is fixed, and is the burrow’s own', () => {
    const items = boxNetworkItems(state, { name: 'Home', burrowId: 'b1', now: at(3_000) });
    expect(items.map((i) => i.ref.kind)).toEqual(['box_network', 'box_network', 'address_refused']);
    const [cable, backup, refused] = items;
    expect(cable?.title).toContain('Home');
    expect(cable?.title).toContain('Wi-Fi');
    expect(cable?.actions[0]).toMatchObject({ kind: 'open', href: NETWORK_HREF });
    expect(backup?.title).toContain('Home');
    expect(backup?.ref.id).toContain('c-fake000001');
    expect(refused?.title).toContain('Home Assistant');
    expect(refused?.title).toContain('10.100.1.81');
    expect(refused?.body).toContain('10.100.1.97');
    expect(refused?.subject).toEqual({ kind: 'connection', id: 'ha', name: 'Home Assistant' });
    expect(items.every((i) => i.nature === 'you')).toBe(true);
    // Without a name: the Whombat is “Your Whombat”.
    expect(boxNetworkItems(state, { name: null, burrowId: 'b2', now: at(3_000) })[0]?.title).toContain(
      'Your Whombat',
    );
  });

  it('starts on: all three checks are watched from the start', () => {
    for (const c of BOX_NETWORK_CHECKS) expect(checkStartsOn(c.check)).toBe(true);
  });
});
