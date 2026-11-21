/**
 * The box's Bluetooth over a session and in the appliance's audit chain (bluetooth-server.md BT-S03…BT-S05): why this
 * file needs Postgres — the ops run through the runtime's dispatcher for the person's devices (receipts, the contract's
 * outputs), and each pairing that's done and each removal is one signed `bluetooth.device_paired` /
 * `bluetooth.device_removed` in `appliance_events`, linked into the chain, the person's account and device as actor (none
 * from the box's screen), never a device's address. A refused change writes nothing.
 */
import type { HostBluetoothOutput } from '@whombat/protocol/session';
import { asc, inArray } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applianceEvents } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { verifyApplianceChain } from './audit';
import { FakeBluetooth } from './fake-bluetooth';
import { HostBluetoothService } from './host-bluetooth';

const m = useManagedRuntime({ seed: true });
const MOUSE = 'D4:3A:2C:91:7E:0B';
const SONY = '88:C9:E8:3B:20:5F';
const ADDRESS = /[0-9A-F]{2}(:[0-9A-F]{2}){5}/;
let owner: Awaited<ReturnType<typeof m.enroll>>;
let now = Date.parse('2026-10-20T12:00:00.000Z');

type Out = { t: string; output?: HostBluetoothOutput };

beforeAll(async () => {
  owner = await m.enroll(IDS.mara);
});

/** The runtime's Bluetooth: the fake on a clock the test steps, or none. */
function useBluetooth(present = true): HostBluetoothService | null {
  const bluetooth = present
    ? new HostBluetoothService(m.t.services, new FakeBluetooth(() => now, { stepMs: 10 }), {
        after: () => () => {},
      })
    : null;
  m.runtime.dispatcher.bluetooth = bluetooth ?? undefined;
  return bluetooth;
}

afterEach(() => {
  m.runtime.dispatcher.bluetooth?.close();
  m.runtime.dispatcher.bluetooth = undefined;
});

async function bluetoothEvents() {
  return m.t.services.db
    .select()
    .from(applianceEvents)
    .where(inArray(applianceEvents.type, ['bluetooth.device_paired', 'bluetooth.device_removed']))
    .orderBy(asc(applianceEvents.seq));
}

describe('Bluetooth over a session (BT-S03)', () => {
  it('lets the person look, pair, see it done and remove a device, recorded once each in the chain', async () => {
    useBluetooth();
    const c = await m.client(owner);
    const first = (await c.request('host.bluetooth', {})) as Out;
    expect(first.t).toBe('result');
    expect(first.output?.bluetooth?.devices.map((d) => d.name)).toEqual(['Keychron K3', 'WH-1000XM5']);
    expect(await c.request('host.bluetooth.scan', {})).toMatchObject({ t: 'result', output: { scan: {} } });
    now += 5_000;
    expect(await c.request('host.bluetooth.pair', { address: MOUSE })).toMatchObject({
      t: 'result',
      output: { pairing: { phase: 'pairing', kind: 'mouse' } },
    });
    expect(await c.request('host.bluetooth.scan', {})).toMatchObject({
      t: 'error',
      code: 'conflict',
      details: { code: 'busy' },
    });
    now += 100;
    for (let i = 0; i < 2; i++)
      expect(await c.request('host.bluetooth', {})).toMatchObject({
        output: { bluetooth: { pairing: { phase: 'done' } } },
      });
    expect(await c.request('host.bluetooth.forget', { address: SONY })).toMatchObject({
      t: 'result',
      output: { ok: true },
    });
    // Gone from the list and not nearby: no such device.
    expect(await c.request('host.bluetooth.forget', { address: SONY })).toMatchObject({
      t: 'error',
      code: 'not_found',
      details: { code: 'not_found' },
    });

    await vi.waitFor(async () => expect(await bluetoothEvents()).toHaveLength(2));
    const rows = await bluetoothEvents();
    expect(rows.map((r) => [r.type, r.actorAccountId, r.endpointId, r.payload])).toEqual([
      [
        'bluetooth.device_paired',
        owner.accountId,
        owner.endpointId,
        { name: 'MX Master 3S', kind: 'mouse', via: 'app' },
      ],
      [
        'bluetooth.device_removed',
        owner.accountId,
        owner.endpointId,
        { name: 'WH-1000XM5', kind: 'headphones', via: 'app' },
      ],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(ADDRESS);
    expect(await verifyApplianceChain(m.t.services.db)).toMatchObject({ ok: true });
    c.close();
  });

  it('says not_managed without a Bluetooth service', async () => {
    useBluetooth(false);
    const o = await m.client(owner);
    expect(await o.request('host.bluetooth', {})).toMatchObject({
      t: 'result',
      output: { bluetooth: null, reason: 'not_managed' },
    });
    expect(await o.request('host.bluetooth.connect', { address: SONY })).toMatchObject({
      t: 'error',
      code: 'not_allowed',
      details: { code: 'no_bluetooth' },
    });
    o.close();
  });

  it('records a pairing from the screen with no actor', async () => {
    const bluetooth = useBluetooth() as HostBluetoothService;
    const before = (await bluetoothEvents()).length;
    await bluetooth.scan();
    now += 5_000;
    await bluetooth.pair(MOUSE, { via: 'screen' });
    now += 100;
    await bluetooth.state();
    // Written on its own, after the read that saw it (BT-S04).
    await vi.waitFor(async () => expect((await bluetoothEvents()).length).toBe(before + 1));
    const rows = (await bluetoothEvents()).slice(before);
    expect(rows.map((r) => [r.type, r.actorAccountId, r.endpointId, r.payload])).toEqual([
      ['bluetooth.device_paired', null, null, { name: 'MX Master 3S', kind: 'mouse', via: 'screen' }],
    ]);
  });
});
