/**
 * The machine in the demo world (hardware-support-android.md AP-3262): every state answers `host.network` and
 * `host.hardware` in the contract's shape and shows what it is for, joins and forgets run through the guard's phases
 * on the injected clock, and starting over tells NETWORK and HARDWARE. Its Bluetooth (bluetooth-android.md AP-3759): the
 * paired two on the Z13, none on the VM, switched off on the PC without a driver, a scan, a pairing with a code typed on
 * the clock, a refused one, and a fresh Bluetooth after starting over.
 */
import {
  BluetoothState,
  bluetoothFoundRows,
  bluetoothSectionView,
  HostHardware,
  HostNetwork,
  hardwareReportFileName,
  hardwareReportText,
  hardwareSectionView,
  networkErrorCode,
  networkSectionView,
  wifiRows,
} from '@whombat/client';
import { FAKE_BLUETOOTH_CODE, FAKE_WIFI_PASSWORDS } from '@whombat/client/host/fake';
import { describe, expect, it } from 'vitest';
import { bluetoothCardKind } from '../managed/bluetooth';
import { createDemoMachine, isMachineDemoState, MACHINE_DEMO_STATES, type MachineDemoState } from './machine';

const NOW = Date.parse('2026-10-20T09:22:00Z');
const NAME = 'Burrow HQ';

function world(state: MachineDemoState = 'z13') {
  let now = NOW;
  const machine = createDemoMachine({
    state,
    now: () => now,
    scanMs: 0,
    applyMs: 1_000,
    confirmMs: 2_000,
    pairMs: 1_000,
    typeMs: 500,
    connectMs: 1_000,
  });
  return {
    machine,
    advance: (ms: number) => {
      now += ms;
    },
    view: async () => {
      const out = await machine.network.state();
      return networkSectionView(out.network as HostNetwork, { name: NAME, now });
    },
  };
}

describe('Wi-Fi only on the demo machine', () => {
  it('switches the cable off and the servers find the new address over time', async () => {
    const { machine, advance } = world('z13');
    const change = await machine.network.setCable('wifi');
    expect(change).toMatchObject({ use: 'wifi', phase: 'applying' });
    advance(3_000);
    const out = await machine.network.state();
    expect(out.network?.wifiOnly).toBe(true);
    expect(out.network?.cableChange?.phase).toBe('committed');
    expect(out.move).toMatchObject({ total: 6 });
    advance(60_000);
    expect((await machine.network.state()).move?.found).toBe(6);
    await expect(machine.network.setCable('wifi')).rejects.toMatchObject({ details: { code: 'unchanged' } });
  });
});

describe('the demo machine’s states', () => {
  it.each(MACHINE_DEMO_STATES)('%s answers in the contract’s shapes', async (state) => {
    const { machine } = world(state);
    const network = await machine.network.state();
    expect(HostNetwork.safeParse(network.network).success).toBe(true);
    const hardware = await machine.hardware();
    expect(HostHardware.safeParse(hardware.hardware).success).toBe(true);
  });

  it('knows its states', () => {
    expect(isMachineDemoState('nodriver')).toBe(true);
    expect(isMachineDemoState('toaster')).toBe(false);
  });

  it('shows what each state is for', async () => {
    const kinds = async (state: MachineDemoState) => (await world(state).view()).rows.map((r) => r.kind);
    expect(await kinds('z13')).toEqual(['cable', 'wifi']);
    expect(await kinds('wifi')).toEqual(['wifi']);
    const wifiOnly = await world('wifionly').view();
    expect(wifiOnly.rows.map((r) => [r.kind, r.action])).toEqual([
      ['cable', 'cable'],
      ['wifi', null],
    ]);
    expect((await world('z13').view()).rows.find((r) => r.kind === 'wifi')?.action).toBe('wifiOnly');
    expect(await kinds('offline')).toEqual(['offline', 'wifi']);
    expect(await kinds('vm')).toEqual(['cable', 'missing']);
    const nodriver = await world('nodriver').view();
    expect(nodriver.rows.find((r) => r.kind === 'missing')?.hardware).toBe(true);
    expect(nodriver.canJoin).toBe(false);
  });

  it('reports the driverless Wi-Fi card first, and every part of the Z13 working', async () => {
    const nodriver = (await world('nodriver').machine.hardware()).hardware as HostHardware;
    const v = hardwareSectionView(nodriver);
    expect(v.problems[0]?.kind).toBe('wifi');
    expect(v.problems.map((p) => p.kind)).toContain('bluetooth');
    const text = hardwareReportText(nodriver, { burrow: NAME, version: 'Android app 0.105.0' });
    expect(text).toContain('8086:272b');
    expect(text).toContain('NO DRIVER');
    expect(hardwareReportFileName(nodriver, 'Europe/Amsterdam')).toBe('whombat-hardware-2026-10-20.txt');
    const z13 = (await world('z13').machine.hardware()).hardware as HostHardware;
    expect(hardwareSectionView(z13).problems).toEqual([]);
    expect(hardwareSectionView(z13).machine).toContain('Flow Z13');
  });
});

describe('Wi-Fi in the demo world', () => {
  it('lists the networks nearby without the hidden one', async () => {
    const scan = await world().machine.network.scan();
    const rows = wifiRows(scan.scan as NonNullable<typeof scan.scan>);
    expect(rows[0]).toMatchObject({ ssid: 'Home', connected: true });
    expect(rows.map((r) => r.ssid)).not.toContain('Attic');
    expect(rows.find((r) => r.ssid === 'Lumio Corp')?.joinable).toBe(false);
  });

  it('fails a wrong password at once and keeps nothing', async () => {
    const { machine, advance } = world();
    const started = await machine.network.join({ ssid: 'Neighbours', passphrase: 'not the one' });
    advance(1_000);
    const out = await machine.network.state();
    expect(out.network?.change).toMatchObject({ id: started.id, phase: 'failed', failure: 'wrong_password' });
    expect(out.network?.wifi?.ssid).toBe('Home');
  });

  it('joins with the right password through the guard’s check', async () => {
    const { machine, advance } = world();
    await machine.network.join({ ssid: 'Neighbours', passphrase: FAKE_WIFI_PASSWORDS.Neighbours as string });
    advance(1_000);
    expect((await machine.network.state()).network?.change?.phase).toBe('confirming');
    advance(2_000);
    const out = await machine.network.state();
    expect(out.network?.change?.phase).toBe('committed');
    expect(out.network?.wifi?.saved.map((s) => s.ssid)).toContain('Neighbours');
  });

  it('goes back from a network without internet when only the Wi-Fi carries the box', async () => {
    const { machine, advance } = world('wifi');
    await machine.network.join({ ssid: 'Café Wombat' });
    advance(1_000 + 2 * 2_000);
    const out = await machine.network.state();
    expect(out.network?.change).toMatchObject({
      phase: 'reverted',
      failure: 'no_internet',
      previous: 'Home',
    });
    expect(out.network?.wifi?.ssid).toBe('Home');
  });

  it('refuses to forget the only working network, and forgets another', async () => {
    const { machine, advance } = world('wifi');
    const refused = await machine.network.forget('Home').catch((e: unknown) => e);
    expect(networkErrorCode(refused)).toBe('in_use');
    await machine.network.forget('Office');
    advance(5_000);
    const out = await machine.network.state();
    expect(out.network?.wifi?.saved.map((s) => s.ssid)).toEqual(['Home']);
  });

  it('starts over as another machine and says so', async () => {
    const { machine } = world();
    let told = 0;
    const off = machine.onChange(() => {
      told += 1;
    });
    machine.reset('vm');
    off();
    expect(told).toBe(1);
    expect(machine.state()).toBe('vm');
    expect((await machine.network.state()).network?.wifiMissing).toBe('no_adapter');
    expect((await machine.hardware()).hardware?.machine.virtual).toBe(true);
  });
});

describe('Bluetooth in the demo world', () => {
  it.each(MACHINE_DEMO_STATES)('%s answers in the contract’s shape', async (state) => {
    const { machine } = world(state);
    expect(BluetoothState.safeParse((await machine.bluetooth.state()).bluetooth).success).toBe(true);
  });

  it('pairs two on the Z13, has none on the VM and is switched off on the PC without a driver', async () => {
    const card = async (state: MachineDemoState) => {
      const { machine } = world(state);
      const out = await machine.bluetooth.state();
      return { kind: bluetoothCardKind(machine.bluetooth, { bluetooth: out.bluetooth, reason: null }), out };
    };
    const z13 = await card('z13');
    expect(z13.kind).toBe('rows');
    const view = bluetoothSectionView(z13.out.bluetooth as BluetoothState);
    expect(view.devices.map((d) => [d.name, d.toggle])).toEqual([
      ['Keychron K3', 'disconnect'],
      ['WH-1000XM5', 'connect'],
    ]);
    expect(view.canAdd).toBe(true);
    expect((await card('vm')).kind).toBe('none');
    const nodriver = await card('nodriver');
    expect(nodriver.kind).toBe('rows');
    expect(bluetoothSectionView(nodriver.out.bluetooth as BluetoothState).canAdd).toBe(false);
  });

  it('finds devices while it looks, never the phone', async () => {
    const { machine, advance } = world();
    await machine.bluetooth.scan();
    advance(4_000);
    const out = await machine.bluetooth.state();
    const rows = bluetoothFoundRows(out.bluetooth?.scan ?? { devices: [] }, out.bluetooth?.devices);
    expect(rows.map((r) => r.name)).toContain('Magic Keyboard');
    expect(rows.map((r) => r.name)).not.toContain('Pixel 9');
  });

  it('pairs a keyboard with a code typed digit by digit, then lists it', async () => {
    const { machine, advance } = world();
    await machine.bluetooth.scan();
    advance(2_000);
    const keyboard = (await machine.bluetooth.state()).bluetooth?.scan?.devices.find(
      (d) => d.name === 'Magic Keyboard',
    );
    const pairing = await machine.bluetooth.pair(keyboard?.address ?? '');
    advance(2_100);
    const typing = (await machine.bluetooth.state()).bluetooth?.pairing;
    expect(typing).toMatchObject({ id: pairing.id, phase: 'code', code: FAKE_BLUETOOTH_CODE, typed: 2 });
    advance(10_000);
    const out = (await machine.bluetooth.state()).bluetooth;
    expect(out?.pairing?.phase).toBe('done');
    expect(out?.devices.find((d) => d.name === 'Magic Keyboard')?.connected).toBe(true);
  });

  it('stops a pairing cancelled while its code is typed, and keeps nothing', async () => {
    const { machine, advance } = world();
    await machine.bluetooth.scan();
    advance(2_000);
    const keyboard = (await machine.bluetooth.state()).bluetooth?.scan?.devices.find(
      (d) => d.name === 'Magic Keyboard',
    );
    const pairing = await machine.bluetooth.pair(keyboard?.address ?? '');
    advance(2_100);
    expect((await machine.bluetooth.state()).bluetooth?.pairing?.phase).toBe('code');
    expect(await machine.bluetooth.cancel(pairing.id)).toMatchObject({
      phase: 'failed',
      failure: 'canceled',
    });
    advance(10_000);
    const out = (await machine.bluetooth.state()).bluetooth;
    expect(out?.pairing).toMatchObject({ phase: 'failed', failure: 'canceled' });
    expect(out?.devices.map((d) => d.name)).not.toContain('Magic Keyboard');
  });

  it('starts over with a fresh Bluetooth', async () => {
    const { machine } = world();
    await machine.bluetooth.forget('DC:2C:26:4B:1A:07');
    expect((await machine.bluetooth.state()).bluetooth?.devices).toHaveLength(1);
    machine.reset('z13');
    expect((await machine.bluetooth.state()).bluetooth?.devices).toHaveLength(2);
  });
});
