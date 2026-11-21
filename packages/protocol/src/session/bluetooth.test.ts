/** Contracts 0.109.0: the box's Bluetooth over the session (CT-670…CT-678; Whombat bluetooth.md BT-01…BT-11). */

import { describe, expect, it } from 'vitest';
import {
  BLUETOOTH_ERROR_STATUS,
  BLUETOOTH_ERRORS,
  BLUETOOTH_KINDS,
  BLUETOOTH_PAIRING_PHASES,
  BLUETOOTH_PAIRING_S,
  BLUETOOTH_POLL_MS,
  BLUETOOTH_RESULT_KEEP_S,
  BLUETOOTH_SCAN_S,
  BluetoothAuditPayload,
  BluetoothDevice,
  type BluetoothPairing,
  BluetoothState,
  bluetoothPairingDone,
  bluetoothPairingValid,
  bluetoothSignalFromDbm,
  bluetoothStateValid,
  HostBluetoothOutput,
  HostBluetoothScanOutput,
} from './bluetooth.js';
import { APP_ERROR_CODES, SessionErrorCode } from './errors.js';
import { operationSafety, resendAfterNotFound } from './operation-safety.js';
import { createOperationAllowlist, SESSION_OPERATIONS } from './operations.js';
import { APPLIANCE_EVENT_TYPES, ApplianceEventType } from './providers.js';
import { decodeTolerant } from './tolerant.js';

const READS = ['host.bluetooth', 'host.bluetooth.scan'];
const CHANGES = [
  'host.bluetooth.pair',
  'host.bluetooth.confirm',
  'host.bluetooth.cancel',
  'host.bluetooth.connect',
  'host.bluetooth.disconnect',
  'host.bluetooth.forget',
];

const keyboard: BluetoothDevice = {
  address: 'DC:2C:26:01:02:03',
  name: 'Keychron K3',
  kind: 'keyboard',
  connected: true,
  battery: 80,
};
const headphones: BluetoothDevice = {
  address: '88:C9:E8:11:22:33',
  name: 'WH-1000XM5',
  kind: 'headphones',
  connected: false,
};
const mouse: BluetoothDevice = {
  address: 'F0:1D:BC:44:55:66',
  name: 'MX Master 3S',
  kind: 'mouse',
  connected: false,
  signal: 3,
};
const pairing: BluetoothPairing = {
  id: 'p-k3q9xv2m',
  address: '00:1E:52:77:88:99',
  name: 'Magic Keyboard',
  kind: 'keyboard',
  phase: 'code',
  deadline: '2026-10-20T21:01:30Z',
  code: '123456',
  typed: 2,
};
const state: BluetoothState = {
  adapter: { name: 'wb-7tq3-k2pd-m418', powered: true },
  devices: [keyboard, headphones],
  scan: { until: '2026-10-20T21:01:00Z', devices: [mouse] },
  pairing,
};

describe('the box’s Bluetooth over the session (CT-676, CT-678)', () => {
  it('has eight session-native app ops, none secret', () => {
    const allow = createOperationAllowlist();
    for (const op of [...READS, ...CHANGES]) {
      const spec = SESSION_OPERATIONS.get(op);
      expect(spec?.source, op).toBe('session');
      expect(spec?.channel, op).toBe('app');
      expect(allow.resolve(op, { enrolled: false }), op).toEqual({ ok: false, code: 'enrollment_required' });
      expect(spec?.secret, op).toBe(false);
      expect(spec?.mutating, op).toBe(!READS.includes(op));
      expect(spec?.ephemeral, op).toBe(false);
    }
  });

  it('reads safely and never resends a change by itself', () => {
    for (const op of READS) expect(operationSafety(op), op).toEqual({ destructive: false, retry: 'safe' });
    const removals = ['host.bluetooth.disconnect', 'host.bluetooth.forget'];
    for (const op of CHANGES) {
      expect(operationSafety(op), op).toEqual({ destructive: removals.includes(op), retry: 'never' });
      expect(resendAfterNotFound(op), op).toBe(false);
    }
  });

  it('takes an upper-case address, a pairing id and a yes or no, strictly', () => {
    const pair = SESSION_OPERATIONS.get('host.bluetooth.pair')?.input;
    expect(pair?.safeParse({ address: 'F0:1D:BC:44:55:66' }).success).toBe(true);
    expect(pair?.safeParse({ address: 'f0:1d:bc:44:55:66' }).success).toBe(false);
    expect(pair?.safeParse({ address: 'F0-1D-BC-44-55-66' }).success).toBe(false);
    expect(pair?.safeParse({ address: 'F0:1D:BC:44:55:66', pin: '0000' }).success).toBe(false);
    const confirm = SESSION_OPERATIONS.get('host.bluetooth.confirm')?.input;
    expect(confirm?.safeParse({ pairingId: 'p-k3q9xv2m', accept: true }).success).toBe(true);
    expect(confirm?.safeParse({ pairingId: 'p-k3q9xv2m', accept: 'yes' }).success).toBe(false);
    expect(confirm?.safeParse({ pairingId: 'k3q9xv2m', accept: true }).success).toBe(false);
    const cancel = SESSION_OPERATIONS.get('host.bluetooth.cancel')?.input;
    expect(cancel?.safeParse({ pairingId: 'p-k3q9xv2m' }).success).toBe(true);
    for (const op of ['host.bluetooth.connect', 'host.bluetooth.disconnect', 'host.bluetooth.forget'])
      expect(SESSION_OPERATIONS.get(op)?.input.safeParse({ address: keyboard.address }).success, op).toBe(
        true,
      );
    for (const op of READS) {
      expect(SESSION_OPERATIONS.get(op)?.input.safeParse({}).success, op).toBe(true);
      expect(SESSION_OPERATIONS.get(op)?.input.safeParse({ seconds: 120 }).success, op).toBe(false);
    }
    expect(SESSION_OPERATIONS.get('host.bluetooth.forget')?.output.parse({ ok: true })).toEqual({ ok: true });
  });

  it('answers null with a reason where there is nothing to read', () => {
    expect(HostBluetoothOutput.parse({ bluetooth: null, reason: 'not_managed' }).reason).toBe('not_managed');
    expect(HostBluetoothOutput.parse({ bluetooth: state }).bluetooth?.devices).toHaveLength(2);
    expect(HostBluetoothOutput.safeParse({ bluetooth: null, reason: 'no_bluetooth' }).success).toBe(false);
    expect(HostBluetoothScanOutput.parse({ scan: null, reason: 'no_bluetooth' }).reason).toBe('no_bluetooth');
    expect(HostBluetoothScanOutput.safeParse({ scan: null, reason: 'offline' }).success).toBe(false);
  });

  it('refuses with codes that have a description and a status', () => {
    for (const code of BLUETOOTH_ERRORS) {
      const status = BLUETOOTH_ERROR_STATUS[code];
      expect(SessionErrorCode.safeParse(status).success, code).toBe(true);
      // Its own description, or the generic code of the same name it rides on.
      if (status !== code) expect(APP_ERROR_CODES, code).toHaveProperty(code);
    }
    expect(BLUETOOTH_ERROR_STATUS).toEqual({
      no_bluetooth: 'not_allowed',
      busy: 'conflict',
      not_found: 'not_found',
      not_paired: 'conflict',
      unavailable: 'unavailable',
    });
  });

  it('lets an older app read a newer kind, phase or reason without failing the answer', () => {
    const r = decodeTolerant(BluetoothState, {
      ...state,
      devices: [...state.devices, { ...mouse, address: '11:22:33:44:55:66', kind: 'pen' }],
      pairing: { ...pairing, phase: 'waiting' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.devices).toHaveLength(2);
      expect(r.data.pairing).toBeNull();
    }
    const m = decodeTolerant(BluetoothState, { ...state, adapter: null, missing: 'unplugged' });
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.data.missing).toBeUndefined();
  });
});

describe('devices, looking and bars (CT-670, CT-671)', () => {
  it('knows the kinds the box pairs, and no phone or computer', () => {
    expect(BLUETOOTH_KINDS).toEqual([
      'keyboard',
      'mouse',
      'headphones',
      'headset',
      'speaker',
      'gamepad',
      'other',
    ]);
    expect(BluetoothDevice.safeParse({ ...mouse, kind: 'phone' }).success).toBe(false);
    expect(BluetoothDevice.safeParse({ ...mouse, kind: 'computer' }).success).toBe(false);
  });

  it('carries a name of one line and a battery in percent', () => {
    expect(BluetoothDevice.safeParse({ ...keyboard, name: 'Keychron\nK3' }).success).toBe(false);
    expect(BluetoothDevice.safeParse({ ...keyboard, name: 'x'.repeat(81) }).success).toBe(false);
    expect(BluetoothDevice.safeParse({ ...keyboard, name: 'Clavier “sans fil” 無線 ⌨' }).success).toBe(true);
    expect(BluetoothDevice.safeParse({ ...keyboard, battery: 101 }).success).toBe(false);
    expect(BluetoothDevice.safeParse({ ...keyboard, battery: 79.5 }).success).toBe(false);
  });

  it('gives bars for a strength', () => {
    expect([-40, -60, -61, -70, -71, -80, -81, -90, -91].map(bluetoothSignalFromDbm)).toEqual([
      4, 4, 3, 3, 2, 2, 1, 1, 0,
    ]);
  });

  it('times looking and pairing as BT-07 says', () => {
    expect([BLUETOOTH_SCAN_S, BLUETOOTH_PAIRING_S, BLUETOOTH_RESULT_KEEP_S]).toEqual([60, 90, 60]);
    expect(BLUETOOTH_POLL_MS).toBe(1_000);
  });
});

describe('a pairing and the state (CT-672, CT-673)', () => {
  it('knows when a pairing is over', () => {
    expect(BLUETOOTH_PAIRING_PHASES.filter(bluetoothPairingDone)).toEqual(['done', 'failed']);
  });

  it('shows a code exactly while there is one to type or compare, and a failure exactly when it failed', () => {
    expect(bluetoothPairingValid(pairing)).toBe(true);
    expect(bluetoothPairingValid({ ...pairing, phase: 'confirm', typed: undefined })).toBe(true);
    expect(bluetoothPairingValid({ ...pairing, phase: 'confirm' })).toBe(false);
    expect(bluetoothPairingValid({ ...pairing, code: undefined, typed: undefined })).toBe(false);
    expect(bluetoothPairingValid({ ...pairing, code: '1234', typed: 5 })).toBe(false);
    expect(bluetoothPairingValid({ phase: 'pairing' })).toBe(true);
    expect(bluetoothPairingValid({ phase: 'pairing', code: '123456' })).toBe(false);
    expect(bluetoothPairingValid({ phase: 'failed', failure: 'rejected' })).toBe(true);
    expect(bluetoothPairingValid({ phase: 'failed' })).toBe(false);
    expect(bluetoothPairingValid({ phase: 'done', failure: 'timeout' })).toBe(false);
  });

  it('says why exactly when Bluetooth can’t be used, and lists each device once', () => {
    expect(bluetoothStateValid({ ...state, pairing: null })).toBe(true);
    // A pairing stops looking; after it ended, looking again is fine.
    expect(bluetoothStateValid(state)).toBe(false);
    expect(bluetoothStateValid({ ...state, scan: null })).toBe(true);
    expect(
      bluetoothStateValid({
        ...state,
        pairing: { ...pairing, phase: 'done', code: undefined, typed: undefined },
      }),
    ).toBe(true);
    const none: BluetoothState = {
      adapter: null,
      missing: 'no_adapter',
      devices: [],
      scan: null,
      pairing: null,
    };
    expect(bluetoothStateValid(none)).toBe(true);
    expect(bluetoothStateValid({ ...none, missing: undefined })).toBe(false);
    const off = { ...state, adapter: { name: 'hci0', powered: false }, scan: null };
    expect(bluetoothStateValid({ ...off, missing: 'disabled' })).toBe(true);
    expect(bluetoothStateValid(off)).toBe(false);
    expect(bluetoothStateValid({ ...state, missing: 'disabled' })).toBe(false);
    const looking = { ...state, pairing: null };
    expect(bluetoothStateValid({ ...looking, devices: [keyboard, keyboard] })).toBe(false);
    expect(
      bluetoothStateValid({ ...looking, scan: { until: '2026-10-20T21:01:00Z', devices: [mouse, mouse] } }),
    ).toBe(false);
    expect(
      bluetoothStateValid({ ...looking, scan: { until: '2026-10-20T21:01:00Z', devices: [keyboard] } }),
    ).toBe(false);
    expect(bluetoothStateValid({ ...state, scan: null, pairing: { ...pairing, typed: 7 } })).toBe(false);
  });
});

describe('Bluetooth in the audit log (CT-677)', () => {
  it('records pairings and removals by name and kind, and where they came from', () => {
    expect(APPLIANCE_EVENT_TYPES).toContain('bluetooth.device_paired');
    expect(ApplianceEventType.parse('bluetooth.device_removed')).toBe('bluetooth.device_removed');
    const p = { name: 'Keychron K3', kind: 'keyboard', via: 'screen' };
    expect(BluetoothAuditPayload.parse(p)).toEqual(p);
    expect(BluetoothAuditPayload.safeParse({ ...p, via: 'console' }).success).toBe(false);
  });

  it('never keeps an address: parsing before writing strips it', () => {
    const parsed = BluetoothAuditPayload.parse({
      name: 'Keychron K3',
      kind: 'keyboard',
      via: 'app',
      address: keyboard.address,
    });
    expect(parsed).not.toHaveProperty('address');
    expect(JSON.stringify(parsed)).not.toContain('DC:2C');
  });
});
