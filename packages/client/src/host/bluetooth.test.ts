/**
 * The box's Bluetooth (bluetooth-web.md AP-3700…AP-3717): BLUETOOTH's rows and why there is none, the dialog's list,
 * a pairing in words, the refusals' words, the poller that follows looking and pairing, and the fake's phases on an
 * injected clock.
 */
import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import {
  type BluetoothApi,
  bluetoothDeviceMeta,
  bluetoothDeviceRows,
  bluetoothErrorCode,
  bluetoothErrorText,
  bluetoothFoundRows,
  bluetoothKindText,
  bluetoothMissing,
  bluetoothPairingView,
  bluetoothScanRunning,
  bluetoothSectionView,
  bluetoothShown,
  createBluetoothPoller,
} from './bluetooth';
import {
  createFakeBluetooth,
  FAKE_BLUETOOTH_CODE,
  FAKE_BLUETOOTH_NEARBY,
  type FakeBluetooth,
  fakeBluetoothApi,
} from './bluetooth-fake';
import {
  BLUETOOTH_KINDS,
  type BluetoothDevice,
  type BluetoothPairing,
  BluetoothState,
  bluetoothStateValid,
  HostBluetoothOutput,
  HostBluetoothPairingOutput,
  HostBluetoothScanOutput,
} from './contract';

const NOW = Date.parse('2026-10-20T09:22:00Z');
const at = (name: string) => FAKE_BLUETOOTH_NEARBY.find((d) => d.name === name)?.address as string;
const K3 = at('Keychron K3');
const XM5 = at('WH-1000XM5');
const MX = at('MX Master 3S');
const MAGIC = at('Magic Keyboard');
const PEBBLE = at('Pebble Keys 2');
const XBOX = at('Xbox Wireless Controller');
const PIXEL = at('Pixel 9');

function device(over: Partial<BluetoothDevice> = {}): BluetoothDevice {
  return { address: 'AA:BB:CC:DD:EE:01', name: 'Keychron K3', kind: 'keyboard', connected: true, ...over };
}

function state(over: Partial<BluetoothState> = {}): BluetoothState {
  return {
    adapter: { name: 'Burrow HQ', powered: true },
    devices: [
      device({ battery: 80 }),
      device({ address: 'AA:BB:CC:DD:EE:02', name: 'WH-1000XM5', kind: 'headphones', connected: false }),
    ],
    scan: null,
    pairing: null,
    ...over,
  };
}

function pairing(over: Partial<BluetoothPairing> = {}): BluetoothPairing {
  return {
    id: 'p-00000001',
    address: 'AA:BB:CC:DD:EE:03',
    name: 'Magic Keyboard',
    kind: 'keyboard',
    phase: 'pairing',
    deadline: new Date(NOW + 90_000).toISOString(),
    ...over,
  };
}

describe('BLUETOOTH', () => {
  it('names every kind and says connected with the battery', () => {
    expect(BLUETOOTH_KINDS.map(bluetoothKindText)).toEqual([
      'Keyboard',
      'Mouse',
      'Headphones',
      'Headset',
      'Speaker',
      'Game controller',
      'Device',
    ]);
    expect(bluetoothDeviceMeta({ connected: true, battery: 80 })).toBe('Connected · Battery 80 %');
    expect(bluetoothDeviceMeta({ connected: true })).toBe('Connected');
    expect(bluetoothDeviceMeta({ connected: false, battery: 80 })).toBe('Not connected');
  });

  it('lists connected devices first, then by name, with the menu’s first item', () => {
    const rows = bluetoothDeviceRows([
      device({ address: 'AA:BB:CC:DD:EE:05', name: 'zebra pad', kind: 'mouse', connected: false }),
      device({ address: 'AA:BB:CC:DD:EE:04', name: 'Apple', kind: 'speaker', connected: false }),
      device({ battery: 80 }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Keychron K3', 'Apple', 'zebra pad']);
    expect(rows.map((r) => r.toggle)).toEqual(['disconnect', 'connect', 'connect']);
    expect(rows.map((r) => r.icon)).toEqual(['keyboard', 'speaker', 'mouse']);
    expect(rows[0]?.label).toBe('Keychron K3, keyboard, connected, battery 80 %');
  });

  it('is hidden without an adapter and says why when it can’t be used', () => {
    expect(bluetoothShown(state({ adapter: null, missing: 'no_adapter', devices: [] }))).toBe(false);
    expect(bluetoothShown(state({ adapter: null, devices: [] }))).toBe(false);
    expect(bluetoothMissing(state())).toBeNull();

    const noDriver = bluetoothSectionView(state({ adapter: null, missing: 'no_driver' }));
    expect(noDriver.missing?.text).toContain('no driver');
    expect(noDriver.missing?.dot).toBe('bad');
    expect(noDriver.canAdd).toBe(false);
    expect(noDriver.canChange).toBe(false);

    const off = bluetoothSectionView(state({ adapter: { name: 'Burrow HQ', powered: false } }));
    expect(off.missing?.text).toContain('switched off');
    expect(off.missing?.dot).toBe('warn');
    expect(off.devices).toHaveLength(2);
  });

  it('shows a pairing while it runs, and Add a device waits for it', () => {
    const v = bluetoothSectionView(state({ pairing: pairing() }));
    expect(v.pairing?.text).toContain('Magic Keyboard');
    expect(v.canAdd).toBe(false);
    expect(v.canChange).toBe(true);
    const ended = bluetoothSectionView(state({ pairing: pairing({ phase: 'done' }) }));
    expect(ended.pairing).toBeNull();
    expect(ended.canAdd).toBe(true);
  });
});

describe('Add a device', () => {
  it('lists what was found strongest first, once each, without paired devices', () => {
    const rows = bluetoothFoundRows(
      {
        devices: [
          device({
            address: 'AA:BB:CC:DD:EE:10',
            name: 'JBL Flip 6',
            kind: 'speaker',
            connected: false,
            signal: 2,
          }),
          device({ address: 'AA:BB:CC:DD:EE:11', name: 'No bars', kind: 'other', connected: false }),
          device({
            address: 'AA:BB:CC:DD:EE:12',
            name: 'MX Master 3S',
            kind: 'mouse',
            connected: false,
            signal: 4,
          }),
          device({
            address: 'AA:BB:CC:DD:EE:12',
            name: 'MX Master 3S',
            kind: 'mouse',
            connected: false,
            signal: 4,
          }),
          device({ connected: false, signal: 4 }),
        ],
      },
      [device()],
    );
    expect(rows.map((r) => r.name)).toEqual(['MX Master 3S', 'JBL Flip 6', 'No bars']);
    expect(rows[0]?.label).toBe('MX Master 3S, mouse, strong signal');
    expect(rows[2]?.signal).toBeNull();
    expect(rows[2]?.icon).toBe('bluetooth');
  });

  it('knows whether the box still looks', () => {
    expect(bluetoothScanRunning({ until: new Date(NOW + 1_000).toISOString() }, NOW)).toBe(true);
    expect(bluetoothScanRunning({ until: new Date(NOW).toISOString() }, NOW)).toBe(false);
    expect(bluetoothScanRunning(null, NOW)).toBe(false);
  });

  it('says every phase: pairing, the code with the digits typed, the question, ready', () => {
    expect(bluetoothPairingView(pairing()).text).toBe('Pairing with Magic Keyboard…');
    expect(bluetoothPairingView(pairing({ phase: 'connecting' })).text).toBe('Pairing with Magic Keyboard…');

    const code = bluetoothPairingView(pairing({ phase: 'code', code: '482913', typed: 2 }));
    expect(code.text).toContain('482913');
    expect(code.text).toContain('Enter');
    expect(code.digits?.map((d) => d.digit).join('')).toBe('482913');
    expect(code.digits?.map((d) => d.typed)).toEqual([true, true, false, false, false, false]);
    expect(code.asks).toBe(false);
    expect(code.running).toBe(true);

    const ask = bluetoothPairingView(pairing({ phase: 'confirm', code: '482913', name: 'Pebble Keys 2' }));
    expect(ask.text).toBe('Does Pebble Keys 2 show 482913?');
    expect(ask.asks).toBe(true);
    expect(ask.digits?.every((d) => !d.typed)).toBe(true);

    const done = bluetoothPairingView(pairing({ phase: 'done' }));
    expect(done.text).toBe('Magic Keyboard is ready.');
    expect(done.running).toBe(false);
    expect(done.dot).toBe('ok');
  });

  it('says why a pairing failed', () => {
    const why = (failure: BluetoothPairing['failure']) =>
      bluetoothPairingView(pairing({ phase: 'failed', failure, name: 'JBL Flip 6' }));
    expect(why('rejected').text).toContain('didn’t accept');
    expect(why('timeout').text).toContain('in time');
    expect(why('not_found').text).toContain('isn’t nearby');
    expect(why('failed').text).toContain('didn’t work');
    expect(why('canceled').failure).toBe('canceled');
    expect(why(undefined).failure).toBe('failed');
    for (const f of ['rejected', 'timeout', 'not_found', 'canceled', 'failed'] as const)
      expect(why(f).text).toContain('JBL Flip 6');
  });

  it('reads the refusal from details before the error’s own code', () => {
    const busy = new OperationError('host.bluetooth.pair', 409, 'conflict', 'Busy.', { code: 'busy' });
    expect(bluetoothErrorCode(busy)).toBe('busy');
    expect(bluetoothErrorText(busy, 'MX Master 3S')).toContain('Another device');
    const gone = new OperationError('host.bluetooth.connect', 404, 'not_found', 'No.', { code: 'not_found' });
    expect(bluetoothErrorText(gone, 'WH-1000XM5')).toContain('isn’t nearby');
    expect(bluetoothErrorText(gone, 'WH-1000XM5', { paired: true })).toContain('isn’t paired');
    const refused = new OperationError('host.bluetooth.forget', 403, 'forbidden', 'No.');
    expect(bluetoothErrorCode(refused)).toBe('forbidden');
    expect(bluetoothErrorCode(new Error('x'))).toBeNull();
    expect(bluetoothErrorText(new Error('x'), 'X')).toBe('That didn’t work. Try again.');
  });
});

function clock() {
  let t = NOW;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { at: t + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (h: unknown) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    pending: () => timers.length,
    async advance(ms: number) {
      t += ms;
      for (const timer of [...timers].filter((x) => x.at <= t)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
      await new Promise((r) => setTimeout(r, 0));
    },
    /** Time passes without any timer firing (the fake's own clock). */
    skip(ms: number) {
      t += ms;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** The fake on the test's clock; every state it tells is checked against the contracts' rules (`bluetoothStateValid`). */
function fakeOn(c: ReturnType<typeof clock>, machine: 'z13' | 'vm' | 'nodriver' = 'z13') {
  const fake = createFakeBluetooth({ machine, now: c.now, pairMs: 1_000, typeMs: 500, connectMs: 1_000 });
  const api = fakeBluetoothApi(fake);
  const state = async () => {
    const out = await api.state();
    if (!out.bluetooth || !bluetoothStateValid(out.bluetooth))
      throw new Error(`invalid ${JSON.stringify(out)}`);
    return out;
  };
  return { fake, api: { ...api, state } };
}

describe('the poller', () => {
  it('asks once, then every second while the box looks, and stops when it stopped', async () => {
    const c = clock();
    const { api } = fakeOn(c);
    let asks = 0;
    const counted: BluetoothApi = {
      ...api,
      state: () => {
        asks++;
        return api.state();
      },
    };
    const p = createBluetoothPoller({
      api: counted,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
    });
    p.setActive(true);
    await settle();
    expect(asks).toBe(1);
    expect(p.getState().bluetooth?.devices.map((d) => d.name)).toEqual(['Keychron K3', 'WH-1000XM5']);
    expect(c.pending()).toBe(0);

    const scan = (await api.scan()).scan;
    if (!scan) throw new Error('no scan');
    p.scanned(scan);
    await settle();
    await c.advance(1_000);
    await c.advance(1_000);
    expect(p.getState().bluetooth?.scan?.devices.map((d) => d.name)).toContain('MX Master 3S');
    for (let i = 0; i < 60; i++) await c.advance(1_000);
    expect(p.getState().bluetooth?.scan).toBeNull();
    expect(c.pending()).toBe(0);
  });

  it('follows a pairing to its end and shows the device', async () => {
    const c = clock();
    const { api } = fakeOn(c);
    const p = createBluetoothPoller({ api, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    p.setActive(true);
    await settle();
    await api.scan();
    c.skip(1_000);
    p.pairing(await api.pair(MX));
    await settle();
    expect(p.getState().bluetooth?.pairing?.phase).toBe('pairing');
    expect(p.getState().bluetooth?.scan).toBeNull();
    await c.advance(1_000);
    expect(p.getState().bluetooth?.pairing?.phase).toBe('connecting');
    await c.advance(1_000);
    expect(p.getState().bluetooth?.pairing?.phase).toBe('done');
    expect(p.getState().bluetooth?.devices.find((d) => d.address === MX)?.connected).toBe(true);
    expect(c.pending()).toBe(0);
  });

  it('keeps what it showed while following when an answer fails, and says so when there was nothing', async () => {
    const c = clock();
    const { api } = fakeOn(c);
    let fail = false;
    const flaky: BluetoothApi = {
      ...api,
      state: () => (fail ? Promise.reject(new Error('gone')) : api.state()),
    };
    const p = createBluetoothPoller({
      api: flaky,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
    });
    p.setActive(true);
    await settle();
    const scan = (await api.scan()).scan;
    if (scan) p.scanned(scan);
    await settle();
    fail = true;
    await c.advance(1_000);
    expect(p.getState().reason).toBeNull();
    expect(p.getState().bluetooth?.scan).not.toBeNull();
    expect(c.pending()).toBe(1);

    const broken = createBluetoothPoller({
      api: { ...api, state: () => Promise.reject(new Error('gone')) },
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
    });
    broken.setActive(true);
    await settle();
    expect(broken.getState().reason).toBe('unavailable');
    expect(broken.getState().loading).toBe(false);
  });

  it('drops an answer asked for before something the app did', async () => {
    const c = clock();
    const { api } = fakeOn(c);
    let release: (() => void) | null = null;
    const slow: BluetoothApi = {
      ...api,
      state: async () => {
        const out = await api.state();
        await new Promise<void>((r) => {
          release = r;
        });
        return out;
      },
    };
    const p = createBluetoothPoller({
      api: slow,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
    });
    p.setActive(true);
    await settle();
    // The first answer is under way when the app forgets a device: it must not bring it back.
    await api.forget(K3);
    p.removed(K3);
    (release as (() => void) | null)?.();
    await settle();
    expect(p.getState().bluetooth?.devices.some((d) => d.address === K3) ?? false).toBe(false);
  });

  it('says not_managed without the ops', () => {
    const p = createBluetoothPoller({ api: null });
    expect(p.getState().reason).toBe('not_managed');
    expect(p.getState().loading).toBe(false);
  });
});

describe('the fake', () => {
  const run = (fake: FakeBluetooth, op: string, input: unknown = {}) => fake.call(op, input);

  it('answers in the shapes of the wire', () => {
    const c = clock();
    const { fake } = fakeOn(c);
    expect(HostBluetoothOutput.safeParse(run(fake, 'host.bluetooth').body).success).toBe(true);
    const scan = run(fake, 'host.bluetooth.scan');
    expect(HostBluetoothScanOutput.safeParse(scan.body).success).toBe(true);
    c.skip(5_000);
    const s = (run(fake, 'host.bluetooth').body as { bluetooth: BluetoothState }).bluetooth;
    expect(BluetoothState.safeParse(s).success).toBe(true);
    const paired = run(fake, 'host.bluetooth.pair', { address: MAGIC });
    expect(paired.status).toBe(202);
    expect(HostBluetoothPairingOutput.safeParse(paired.body).success).toBe(true);
    expect(run(fake, 'host.bluetooth.forget', { address: K3 }).body).toEqual({ ok: true });
  });

  it('finds devices one after another for a minute, never the phone, never what is paired', () => {
    const c = clock();
    const { fake } = fakeOn(c);
    const scanned = () =>
      ((run(fake, 'host.bluetooth').body as { bluetooth: BluetoothState }).bluetooth.scan?.devices ?? []).map(
        (d) => d.address,
      );
    run(fake, 'host.bluetooth.scan');
    expect(scanned()).toEqual([]);
    c.skip(700);
    expect(scanned()).toEqual([MX]);
    c.skip(5_000);
    expect(scanned()).toHaveLength(5);
    expect(scanned()).not.toContain(PIXEL);
    expect(scanned()).not.toContain(K3);
    c.skip(60_000);
    expect((run(fake, 'host.bluetooth').body as { bluetooth: BluetoothState }).bluetooth.scan).toBeNull();
  });

  it('pairs a keyboard with a code, its digits typed one by one', async () => {
    const c = clock();
    const { api } = fakeOn(c);
    await api.scan();
    c.skip(2_000);
    await api.pair(MAGIC);
    const phase = async () => (await api.state()).bluetooth?.pairing;
    c.skip(1_000);
    expect((await phase())?.phase).toBe('code');
    expect((await phase())?.code).toBe(FAKE_BLUETOOTH_CODE);
    expect((await phase())?.typed).toBe(0);
    c.skip(1_000);
    expect((await phase())?.typed).toBe(2);
    c.skip(2_500);
    expect((await phase())?.phase).toBe('connecting');
    expect((await phase())?.code).toBeUndefined();
    c.skip(1_000);
    expect((await phase())?.phase).toBe('done');
    expect((await api.state()).bluetooth?.devices.some((d) => d.address === MAGIC)).toBe(true);
  });

  it('asks about a number and goes on or stops with the answer', async () => {
    const c = clock();
    const { api } = fakeOn(c);
    await api.scan();
    c.skip(3_000);
    const p = await api.pair(PEBBLE);
    c.skip(1_000);
    expect((await api.state()).bluetooth?.pairing?.phase).toBe('confirm');
    expect((await api.confirm(p.id, true)).phase).toBe('connecting');
    c.skip(1_000);
    expect((await api.state()).bluetooth?.pairing?.phase).toBe('done');

    await api.forget(PEBBLE);
    await api.scan();
    c.skip(3_000);
    const again = await api.pair(PEBBLE);
    c.skip(1_000);
    const no = await api.confirm(again.id, false);
    expect(no.phase).toBe('failed');
    expect(no.failure).toBe('canceled');
  });

  it('refuses a pairing while one runs, says rejected, and cancels', async () => {
    const c = clock();
    const { api } = fakeOn(c);
    await api.scan();
    c.skip(4_000);
    const x = await api.pair(XBOX);
    await expect(api.pair(MX)).rejects.toMatchObject({ details: { code: 'busy' } });
    await expect(api.scan()).rejects.toMatchObject({ details: { code: 'busy' } });
    c.skip(1_000);
    const failed = (await api.state()).bluetooth?.pairing;
    expect(failed?.phase).toBe('failed');
    expect(failed?.failure).toBe('rejected');
    // The ended pairing stays a minute, then goes.
    c.skip(61_000);
    expect((await api.state()).bluetooth?.pairing).toBeNull();
    await expect(api.cancel(x.id)).rejects.toMatchObject({ details: { code: 'not_found' } });

    await api.scan();
    c.skip(1_000);
    const mx = await api.pair(MX);
    expect((await api.cancel(mx.id)).failure).toBe('canceled');
  });

  it('connects, disconnects and removes', async () => {
    const c = clock();
    const { api } = fakeOn(c);
    expect((await api.connect(XM5)).connected).toBe(true);
    expect((await api.disconnect(K3)).connected).toBe(false);
    await api.forget(K3);
    expect((await api.state()).bluetooth?.devices.map((d) => d.name)).toEqual(['WH-1000XM5']);
    await expect(api.connect(K3)).rejects.toMatchObject({ details: { code: 'not_found' } });
    await expect(api.pair(PIXEL)).rejects.toMatchObject({ details: { code: 'not_found' } });
  });

  it('has no adapter on the VM and Bluetooth switched off on the PC', async () => {
    const c = clock();
    const vm = (await fakeOn(c, 'vm').api.state()).bluetooth;
    expect(vm?.adapter).toBeNull();
    expect(vm?.missing).toBe('no_adapter');
    const pc = fakeOn(c, 'nodriver').api;
    const off = (await pc.state()).bluetooth;
    expect(off?.adapter?.powered).toBe(false);
    expect(off?.missing).toBe('disabled');
    expect((await pc.scan()).reason).toBe('no_bluetooth');
    await expect(pc.connect(K3)).rejects.toMatchObject({ details: { code: 'no_bluetooth' } });
  });
});
