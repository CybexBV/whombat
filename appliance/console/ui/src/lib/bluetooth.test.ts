import { describe, expect, it } from 'vitest';
import {
  BLUETOOTH_KINDS,
  BLUETOOTH_MISSING,
  BLUETOOTH_PAIRING_FAILURES,
  BLUETOOTH_PAIRING_PHASES,
  BLUETOOTH_POLL_MS,
  type BluetoothState,
  missingOf,
  pairingRunning,
  parseBluetoothAnswer,
  parseBluetoothSummary,
  parsePairing,
  pollMs,
  sortDevices,
  typedDigits,
} from './bluetooth';
import { bluetoothSource, constList } from './contractsSource';

const keyboard = {
  address: 'F4:7A:11:0B:32:C9',
  name: 'Keychron K3',
  kind: 'keyboard',
  connected: true,
  battery: 80,
};
const pairing = (p: Record<string, unknown>) => ({
  id: 'p-0123abcd',
  address: '7C:C3:A1:5D:9B:14',
  name: 'Magic Keyboard',
  kind: 'keyboard',
  phase: 'pairing',
  deadline: '2026-10-20T09:42:30Z',
  ...p,
});
const state = (p: Partial<BluetoothState>): BluetoothState => ({
  adapter: { name: 'hci0', powered: true },
  devices: [],
  scan: null,
  pairing: null,
  ...p,
});

describe('the copied shapes', () => {
  it('are the contracts’ 0.109.0 lists', () => {
    expect([...BLUETOOTH_KINDS]).toEqual(constList(bluetoothSource, 'BLUETOOTH_KINDS'));
    expect([...BLUETOOTH_PAIRING_PHASES]).toEqual(constList(bluetoothSource, 'BLUETOOTH_PAIRING_PHASES'));
    expect([...BLUETOOTH_PAIRING_FAILURES]).toEqual(constList(bluetoothSource, 'BLUETOOTH_PAIRING_FAILURES'));
    expect([...BLUETOOTH_MISSING]).toEqual(constList(bluetoothSource, 'BLUETOOTH_MISSING'));
    expect(BLUETOOTH_POLL_MS).toBe(1000);
    expect(bluetoothSource).toContain('BLUETOOTH_POLL_MS = 1_000;');
  });
});

describe('parsing', () => {
  it('reads the desk’s answer and leaves out what it can’t show', () => {
    const a = parseBluetoothAnswer({
      v: 1,
      mayChange: false,
      why: 'locked',
      bluetooth: {
        adapter: { name: 'hci0', powered: true },
        devices: [
          keyboard,
          { ...keyboard, address: 'f4:7a:11:0b:32:c9' },
          { ...keyboard, address: 'AC:80:0A:5E:21:4D', kind: 'phone' },
          { ...keyboard, address: 'AC:80:0A:5E:21:4E', battery: 101, signal: 9 },
        ],
        scan: { until: '2026-10-20T09:42:00Z', devices: [{ ...keyboard, connected: false, signal: 3 }] },
        pairing: null,
      },
    });
    expect(a?.mayChange).toBe(false);
    expect(a?.bluetooth.devices.map((d) => d.address)).toEqual(['F4:7A:11:0B:32:C9', 'AC:80:0A:5E:21:4E']);
    // A battery or signal out of range is left out, the device kept.
    expect(a?.bluetooth.devices[1]).not.toHaveProperty('battery');
    expect(a?.bluetooth.devices[1]).not.toHaveProperty('signal');
    expect(a?.bluetooth.scan?.devices[0]?.signal).toBe(3);
    expect(parseBluetoothAnswer({ v: 1, mayChange: true })).toBeNull();
  });

  it('reads a pairing’s phase with its code, its digits typed, its failure', () => {
    expect(parsePairing(pairing({ phase: 'code', code: '482913', typed: 2 }))).toMatchObject({
      code: '482913',
      typed: 2,
    });
    expect(parsePairing(pairing({ phase: 'confirm', code: '731264', typed: 2 }))).not.toHaveProperty('typed');
    // A code to type or compare without its digits can't be shown.
    expect(parsePairing(pairing({ phase: 'code' }))).toBeNull();
    expect(parsePairing(pairing({ phase: 'confirm', code: '12ab56' }))).toBeNull();
    expect(parsePairing(pairing({ phase: 'pairing', code: '482913' }))).not.toHaveProperty('code');
    expect(parsePairing(pairing({ phase: 'failed', failure: 'timeout' }))?.failure).toBe('timeout');
    expect(parsePairing(pairing({ phase: 'failed' }))?.failure).toBe('failed');
    expect(parsePairing(pairing({ phase: 'done', failure: 'timeout' }))).not.toHaveProperty('failure');
    for (const bad of [
      { id: 'x' },
      { address: 'nope' },
      { kind: 'phone' },
      { phase: 'waiting' },
      { name: '' },
    ])
      expect(parsePairing(pairing(bad))).toBeNull();
  });

  it('reads the chip’s summary', () => {
    expect(
      parseBluetoothSummary({
        connected: [
          { name: 'Keychron K3', kind: 'keyboard' },
          { name: 'Pixel 9', kind: 'phone' },
        ],
      }),
    ).toEqual({ missing: null, connected: [{ name: 'Keychron K3', kind: 'keyboard' }] });
    expect(parseBluetoothSummary({ missing: 'disabled', connected: [] })?.missing).toBe('disabled');
    expect(parseBluetoothSummary({ missing: 'no_adapter', connected: [] })?.missing).toBeNull();
    expect(parseBluetoothSummary(null)).toBeNull();
  });
});

describe('rules', () => {
  it('says why Bluetooth can’t be used', () => {
    expect(missingOf(state({}))).toBeNull();
    expect(missingOf(state({ adapter: null }))).toBe('no_adapter');
    expect(missingOf(state({ adapter: null, missing: 'no_driver' }))).toBe('no_driver');
    expect(missingOf(state({ adapter: { name: 'hci0', powered: false } }))).toBe('disabled');
  });

  it('knows a running pairing and asks every second while one runs or the box looks', () => {
    for (const phase of ['pairing', 'code', 'confirm', 'connecting'] as const)
      expect(pairingRunning({ phase })).toBe(true);
    for (const phase of ['done', 'failed'] as const) expect(pairingRunning({ phase })).toBe(false);
    expect(pollMs(state({}))).toBe(2000);
    expect(pollMs(state({ scan: { until: '2026-10-20T09:42:00Z', devices: [] } }))).toBe(BLUETOOTH_POLL_MS);
    const running = parsePairing(pairing({}));
    expect(pollMs(state({ pairing: running }))).toBe(BLUETOOTH_POLL_MS);
    expect(pollMs(null)).toBe(2000);
  });

  it('puts connected devices first, then by name', () => {
    const d = (name: string, connected: boolean) => ({
      ...keyboard,
      kind: 'keyboard' as const,
      name,
      connected,
    });
    expect(
      sortDevices([d('b', false), d('z', true), d('a', false), d('c', true)]).map((x) => x.name),
    ).toEqual(['c', 'z', 'a', 'b']);
  });

  it('counts typed digits within the code', () => {
    expect(typedDigits({ code: '4829', typed: 6 })).toBe(4);
    expect(typedDigits({ code: '482913' })).toBe(0);
  });
});
