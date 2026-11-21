/** The Bluetooth socket and Bluetooth on the desk socket (0.109, CT-680…CT-684; Whombat bluetooth.md BT-02…BT-10). */
import { utf8ByteLength } from '@whombat/protocol';
import {
  BLUETOOTH_DEVICES_MAX,
  BLUETOOTH_ERRORS,
  BLUETOOTH_NAME_MAX,
  BLUETOOTH_SCAN_MAX,
  type BluetoothDevice,
  type BluetoothState,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import {
  BLUETOOTH_ANSWER_MAX_BYTES,
  BLUETOOTH_PATHS,
  BLUETOOTH_REQUEST_MAX_BYTES,
  BLUETOOTH_SOCKET_DEFAULT,
  BLUETOOTH_SOCKET_ENV,
  BLUETOOTH_SOCKET_ERROR_STATUS,
  BLUETOOTH_SOCKET_ERRORS,
  BluetoothAck,
  BluetoothConfirmRequest,
  BluetoothDeviceRequest,
  BluetoothScanRequest,
  BluetoothStateAnswer,
  DESK_PATHS,
  DESK_SOCKET_ERRORS,
  DeskBluetoothAnswer,
  DeskBluetoothDeviceRequest,
} from './index.js';

const device = (i: number, patch: Partial<BluetoothDevice> = {}): BluetoothDevice => ({
  address:
    `AA:BB:CC:DD:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`.toUpperCase(),
  name: `Device ${i}`,
  kind: 'speaker',
  connected: false,
  ...patch,
});
const state: BluetoothState = {
  adapter: { name: 'wb-7tq3-k2pd-m418', powered: true },
  devices: [device(1, { kind: 'keyboard', connected: true, battery: 80 })],
  scan: null,
  pairing: null,
};

describe('the Bluetooth socket (CT-680)', () => {
  it('lives in its own service’s directory, its paths under /v1/bluetooth', () => {
    expect(BLUETOOTH_SOCKET_ENV).toBe('WHOMBAT_BLUETOOTH_SOCKET');
    expect(BLUETOOTH_SOCKET_DEFAULT).toBe('/run/whombat-bluetooth/bluetooth.sock');
    for (const path of Object.values(BLUETOOTH_PATHS)) expect(path).toMatch(/^\/v1\/bluetooth\//);
    expect(Object.keys(BLUETOOTH_PATHS)).toEqual([
      'state',
      'scan',
      'pair',
      'confirm',
      'cancel',
      'connect',
      'disconnect',
      'forget',
    ]);
    expect(BLUETOOTH_REQUEST_MAX_BYTES).toBe(1_024);
  });

  it('answers the session’s codes and its own, each at its HTTP status (CT-682)', () => {
    expect(BLUETOOTH_SOCKET_ERRORS).toEqual(['bad_request', 'too_large', ...BLUETOOTH_ERRORS]);
    expect(Object.keys(BLUETOOTH_SOCKET_ERROR_STATUS).sort()).toEqual([...BLUETOOTH_SOCKET_ERRORS].sort());
    expect(BLUETOOTH_SOCKET_ERROR_STATUS.not_found).toBe(404);
    expect(BLUETOOTH_SOCKET_ERROR_STATUS.unavailable).toBe(503);
    expect(
      ['no_bluetooth', 'busy', 'not_paired'].map((c) => BLUETOOTH_SOCKET_ERROR_STATUS[c as 'busy']),
    ).toEqual([409, 409, 409]);
  });

  it('fits the widest state in an answer (CT-683)', () => {
    const name = '🎉'.repeat(BLUETOOTH_NAME_MAX);
    const widest: BluetoothState = {
      adapter: { name, powered: true },
      devices: Array.from({ length: BLUETOOTH_DEVICES_MAX }, (_, i) =>
        device(i, { name, kind: 'headphones', battery: 100, signal: 4 }),
      ),
      scan: {
        until: '2026-10-20T21:01:00Z',
        devices: Array.from({ length: BLUETOOTH_SCAN_MAX }, (_, i) =>
          device(100 + i, { name, kind: 'headphones', signal: 4 }),
        ),
      },
      pairing: {
        id: `p-${'x'.repeat(32)}`,
        address: device(999).address,
        name,
        kind: 'headphones',
        phase: 'code',
        deadline: '2026-10-20T21:01:30Z',
        code: '123456',
        typed: 6,
      },
    };
    const answer = { v: 1, bluetooth: widest };
    expect(BluetoothStateAnswer.safeParse(answer).success).toBe(true);
    const bytes = utf8ByteLength(JSON.stringify(answer));
    expect(bytes).toBeLessThan(BLUETOOTH_ANSWER_MAX_BYTES);
    // The desk's answer carries the same state and two members more.
    const desk = { v: 1, bluetooth: widest, mayChange: false, why: 'locked' };
    expect(utf8ByteLength(JSON.stringify(desk))).toBeLessThan(BLUETOOTH_ANSWER_MAX_BYTES);
  });
});

describe('what the Bluetooth service takes and says (CT-681)', () => {
  it('takes an address, a pairing id and a yes or no, strictly', () => {
    expect(BluetoothScanRequest.safeParse({ v: 1 }).success).toBe(true);
    expect(BluetoothScanRequest.safeParse({ v: 1, seconds: 300 }).success).toBe(false);
    expect(BluetoothDeviceRequest.safeParse({ v: 1, address: 'F0:1D:BC:44:55:66' }).success).toBe(true);
    expect(BluetoothDeviceRequest.safeParse({ v: 1, address: 'f0:1d:bc:44:55:66' }).success).toBe(false);
    expect(BluetoothDeviceRequest.safeParse({ v: 2, address: 'F0:1D:BC:44:55:66' }).success).toBe(false);
    expect(
      BluetoothDeviceRequest.safeParse({ v: 1, address: 'F0:1D:BC:44:55:66', pin: '0000' }).success,
    ).toBe(false);
    expect(BluetoothConfirmRequest.safeParse({ v: 1, pairingId: 'p-k3q9xv2m', accept: false }).success).toBe(
      true,
    );
    expect(BluetoothConfirmRequest.safeParse({ v: 1, pairingId: 'p-k3q9xv2m' }).success).toBe(false);
  });

  it('reads its state, ignoring what a newer service adds', () => {
    expect(BluetoothStateAnswer.parse({ v: 1, bluetooth: { ...state, discoverable: false } })).toEqual({
      v: 1,
      bluetooth: state,
    });
    expect(BluetoothAck.parse({ v: 1, ok: true })).toEqual({ v: 1 });
  });
});

describe('Bluetooth on the desk socket (CT-684)', () => {
  it('has its paths under /v1/desk/bluetooth and the one new code', () => {
    const paths = Object.entries(DESK_PATHS).filter(([k]) => k.startsWith('bluetooth'));
    expect(paths.map(([k]) => k)).toEqual([
      'bluetooth',
      'bluetoothScan',
      'bluetoothPair',
      'bluetoothConfirm',
      'bluetoothCancel',
      'bluetoothConnect',
      'bluetoothDisconnect',
      'bluetoothForget',
    ]);
    for (const [, path] of paths) expect(path).toMatch(/^\/v1\/desk\/bluetooth(\/|$)/);
    for (const code of ['locked', ...BLUETOOTH_ERRORS]) expect(DESK_SOCKET_ERRORS, code).toContain(code);
  });

  it('says whether the screen may change it, and why not', () => {
    expect(DeskBluetoothAnswer.safeParse({ v: 1, bluetooth: state, mayChange: true }).success).toBe(true);
    expect(
      DeskBluetoothAnswer.safeParse({ v: 1, bluetooth: state, mayChange: false, why: 'locked' }).success,
    ).toBe(true);
    expect(
      DeskBluetoothAnswer.safeParse({ v: 1, bluetooth: state, mayChange: false, why: 'away' }).success,
    ).toBe(false);
    expect(DeskBluetoothAnswer.safeParse({ v: 1, bluetooth: state }).success).toBe(false);
    expect(DeskBluetoothDeviceRequest.safeParse({ v: 1, address: 'DC:2C:26:01:02:03' }).success).toBe(true);
    expect(
      DeskBluetoothDeviceRequest.safeParse({ v: 1, address: 'DC:2C:26:01:02:03', via: 'app' }).success,
    ).toBe(false);
  });
});
