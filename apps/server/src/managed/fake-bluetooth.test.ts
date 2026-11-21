/**
 * The fake Bluetooth service (bluetooth-server.md BT-S09): what it lists while looking, each way a device pairs on a
 * stepped clock, the service's refusals, and every state within the contract.
 */
import {
  BLUETOOTH_PAIRING_S,
  BLUETOOTH_RESULT_KEEP_S,
  BLUETOOTH_SCAN_S,
  BluetoothState,
  bluetoothStateValid,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { BluetoothCallError } from './bluetooth-client';
import { FAKE_PASSKEY, FakeBluetooth } from './fake-bluetooth';

const STEP = 100;
const MOUSE = 'D4:3A:2C:91:7E:0B';
const MAGIC = '7C:C1:80:5D:44:E2';
const XBOX = '98:7A:14:2E:B5:61';
const OLD = '00:1A:7D:DA:71:13';
const PIXEL = '3C:28:6D:F0:12:AB';
const KEYCHRON = 'DC:2C:26:4A:11:03';
const SONY = '88:C9:E8:3B:20:5F';

function setup() {
  let now = Date.parse('2026-10-20T12:00:00.000Z');
  const fake = new FakeBluetooth(() => now, { stepMs: STEP });
  // Every state the fake answers is one the contract allows, schema and rules (`bluetoothStateValid`).
  const state = async () => {
    const s = BluetoothState.parse(await fake.state());
    expect(bluetoothStateValid(s), JSON.stringify(s)).toBe(true);
    return s;
  };
  return {
    fake,
    state,
    later: (ms: number) => {
      now += ms;
    },
    /** Looks long enough for every device to show. */
    found: async () => {
      await fake.scan();
      now += 5_000;
    },
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BluetoothCallError);
  return (err as BluetoothCallError).code;
}

describe('the fake Bluetooth service (BT-S09)', () => {
  it('has two paired devices, connected first, and lists what it finds strongest first without the phone', async () => {
    const t = setup();
    const before = await t.state();
    expect(before.adapter?.powered).toBe(true);
    expect(before.devices.map((d) => [d.name, d.kind, d.connected, d.battery])).toEqual([
      ['Keychron K3', 'keyboard', true, 80],
      ['WH-1000XM5', 'headphones', false, undefined],
    ]);
    expect(before.scan).toBeNull();

    const first = await t.fake.scan();
    expect(first.devices.map((d) => d.name)).toEqual(['MX Master 3S']);
    t.later(5_000);
    const { scan } = await t.state();
    expect(scan?.devices.map((d) => d.name)).toEqual([
      'MX Master 3S',
      'Magic Keyboard',
      'JBL Flip 6',
      'Xbox Wireless Controller',
      'Old Speaker',
    ]);
    expect(scan?.devices.map((d) => d.address)).not.toContain(PIXEL);
    expect(scan?.devices.every((d) => !d.connected && d.signal !== undefined)).toBe(true);
  });

  it('looks for a minute, and a minute more when asked again', async () => {
    const t = setup();
    const first = await t.fake.scan();
    t.later(50_000);
    const again = await t.fake.scan();
    expect(Date.parse(again.until) - Date.parse(first.until)).toBe(50_000);
    t.later(BLUETOOTH_SCAN_S * 1000);
    expect((await t.state()).scan).toBeNull();
  });

  it('pairs a mouse without a code: pairing, connecting, then done and paired, looking stopped', async () => {
    const t = setup();
    await t.found();
    const p = await t.fake.pair(MOUSE);
    expect(p).toMatchObject({ phase: 'pairing', name: 'MX Master 3S', kind: 'mouse' });
    expect(Date.parse(p.deadline) - Date.parse('2026-10-20T12:00:05.000Z')).toBe(BLUETOOTH_PAIRING_S * 1000);
    expect((await t.state()).scan).toBeNull();
    t.later(STEP);
    expect((await t.state()).pairing?.phase).toBe('connecting');
    t.later(STEP);
    const done = await t.state();
    expect(done.pairing?.phase).toBe('done');
    expect(done.devices.find((d) => d.address === MOUSE)).toMatchObject({ connected: true, kind: 'mouse' });
    t.later(BLUETOOTH_RESULT_KEEP_S * 1000);
    expect((await t.state()).pairing).toBeNull();
  });

  it('gives a keyboard the code and counts the digits typed, then connects', async () => {
    const t = setup();
    await t.found();
    await t.fake.pair(MAGIC);
    t.later(STEP);
    expect((await t.state()).pairing).toMatchObject({ phase: 'code', code: FAKE_PASSKEY, typed: 0 });
    t.later(3 * STEP);
    expect((await t.state()).pairing).toMatchObject({ phase: 'code', typed: 3 });
    t.later(3 * STEP);
    expect((await t.state()).pairing).toMatchObject({ phase: 'code', typed: 6 });
    t.later(STEP);
    const connecting = (await t.state()).pairing;
    expect(connecting?.phase).toBe('connecting');
    expect(connecting?.code).toBeUndefined();
    t.later(STEP);
    expect((await t.state()).pairing?.phase).toBe('done');
  });

  it('asks to confirm the controller’s number: yes pairs it, no ends it rejected', async () => {
    const t = setup();
    await t.found();
    const yes = await t.fake.pair(XBOX);
    t.later(STEP);
    expect((await t.state()).pairing).toMatchObject({ phase: 'confirm', code: FAKE_PASSKEY });
    expect((await t.fake.confirm(yes.id, true)).phase).toBe('connecting');
    t.later(STEP);
    expect((await t.state()).pairing?.phase).toBe('done');

    await t.fake.forget(XBOX);
    await t.found();
    const no = await t.fake.pair(XBOX);
    t.later(STEP);
    expect(await t.fake.confirm(no.id, false)).toMatchObject({ phase: 'failed', failure: 'rejected' });
    expect((await t.state()).devices.map((d) => d.address)).not.toContain(XBOX);
  });

  it('fails a device that refuses, one that never answers by the deadline, and a cancel', async () => {
    const t = setup();
    await t.found();
    await t.fake.pair(OLD);
    t.later(STEP);
    expect((await t.state()).pairing).toMatchObject({ phase: 'failed', failure: 'rejected' });

    await t.found();
    const ignored = await t.fake.pair(XBOX);
    t.later(BLUETOOTH_PAIRING_S * 1000);
    expect((await t.state()).pairing).toMatchObject({ id: ignored.id, phase: 'failed', failure: 'timeout' });

    await t.found();
    const canceled = await t.fake.cancel((await t.fake.pair(MOUSE)).id);
    expect(canceled).toMatchObject({ phase: 'failed', failure: 'canceled' });
  });

  it('refuses as the service does', async () => {
    const t = setup();
    expect(await codeOf(t.fake.pair(MOUSE))).toBe('not_found');
    await t.found();
    await t.fake.pair(MAGIC);
    expect(await codeOf(t.fake.pair(MOUSE))).toBe('busy');
    expect(await codeOf(t.fake.scan())).toBe('busy');
    expect(await codeOf(t.fake.confirm('p-nottheone1', true))).toBe('not_found');
    expect(await codeOf(t.fake.connect(PIXEL))).toBe('not_found');
    expect(await codeOf(t.fake.forget('11:22:33:44:55:66'))).toBe('not_found');
    t.fake.missing = 'disabled';
    expect(await codeOf(t.fake.scan())).toBe('no_bluetooth');
    expect((await t.state()).missing).toBe('disabled');
    t.fake.missing = 'no_adapter';
    expect(await t.state()).toMatchObject({ adapter: null, missing: 'no_adapter', devices: [] });
    t.fake.down = true;
    expect(await codeOf(t.fake.state())).toBe('unavailable');
  });

  it('connects, disconnects and removes paired devices; one found but not paired is not_paired', async () => {
    const t = setup();
    expect((await t.fake.connect(SONY)).connected).toBe(true);
    expect((await t.fake.disconnect(KEYCHRON)).connected).toBe(false);
    await t.fake.forget(SONY);
    expect((await t.state()).devices.map((d) => d.name)).toEqual(['Keychron K3']);
    await t.found();
    expect(await codeOf(t.fake.connect(MOUSE))).toBe('not_paired');
    expect(t.fake.calls).toContain(`forget ${SONY}`);
  });
});
