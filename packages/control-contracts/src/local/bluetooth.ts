/**
 * The Bluetooth socket (0.109, CT-680…CT-683; Whombat docs/decisions/bluetooth.md BT-03, BT-04, BT-09): the runtime →
 * the appliance's Bluetooth service `whombat-bluetooth`, HTTP/1.1 JSON over a unix socket at `WHOMBAT_BLUETOOTH_SOCKET`
 * (`BLUETOOTH_SOCKET_DEFAULT`; unset: no Bluetooth, the runtime answers `not_managed`). Only the service talks to BlueZ
 * (BT-09). It is never discoverable and registers its pairing agent only while a pairing runs (BT-03).
 *
 * | Path | Request | Answer |
 * |---|---|---|
 * | `GET /v1/bluetooth/state` | — | `BluetoothStateAnswer {v, bluetooth}` |
 * | `POST /v1/bluetooth/scan` | `BluetoothScanRequest {v}` | `BluetoothScanAnswer {v, scan}`; 409 `no_bluetooth`, `busy` |
 * | `POST /v1/bluetooth/pair` | `BluetoothDeviceRequest {v, address}` | 202 `BluetoothPairingAnswer {v, pairing}`; 409 `no_bluetooth`, `busy`, 404 `not_found` |
 * | `POST /v1/bluetooth/pairing/confirm` | `BluetoothConfirmRequest {v, pairingId, accept}` | `BluetoothPairingAnswer`; 404 `not_found` |
 * | `POST /v1/bluetooth/pairing/cancel` | `BluetoothCancelRequest {v, pairingId}` | `BluetoothPairingAnswer`; 404 `not_found` |
 * | `POST /v1/bluetooth/connect` | `BluetoothDeviceRequest` | `BluetoothDeviceAnswer {v, device}`; 409 `no_bluetooth`, `not_paired`, 404 `not_found` |
 * | `POST /v1/bluetooth/disconnect` | `BluetoothDeviceRequest` | `BluetoothDeviceAnswer`; 409 `no_bluetooth`, `not_paired`, 404 `not_found` |
 * | `POST /v1/bluetooth/forget` | `BluetoothDeviceRequest` | `BluetoothAck {v}`; 409 `no_bluetooth`, `not_paired`, 404 `not_found` |
 *
 * A pair answers 202 at once and runs in the background (it stops looking); the runtime follows it through `state`.
 * Looking while a pairing runs is refused `busy` (it slows pairing down, BT-07).
 * A connect waits at most `BLUETOOTH_CONNECT_S` for the device. Errors are `LocalError` with the codes of
 * `BLUETOOTH_SOCKET_ERRORS` at `BLUETOOTH_SOCKET_ERROR_STATUS`'s HTTP status. Requests are strict and at most
 * `BLUETOOTH_REQUEST_MAX_BYTES`, answers tolerant and at most `BLUETOOTH_ANSWER_MAX_BYTES`. Logs name devices, never
 * addresses (BT-10).
 */
import {
  BLUETOOTH_ERRORS,
  BluetoothAddress,
  BluetoothDevice,
  BluetoothPairing,
  BluetoothPairingId,
  BluetoothScan,
  BluetoothState,
} from '@whombat/protocol/session';
import { z } from 'zod';

const V = z.literal(1);

export const BLUETOOTH_SOCKET_ENV = 'WHOMBAT_BLUETOOTH_SOCKET';
export const BLUETOOTH_SOCKET_DEFAULT = '/run/whombat-bluetooth/bluetooth.sock';

export const BLUETOOTH_PATHS = {
  /** GET: the adapter, the paired devices, the scan while looking, the pairing. */
  state: '/v1/bluetooth/state',
  /** Starts looking, or keeps looking `BLUETOOTH_SCAN_S` more. */
  scan: '/v1/bluetooth/scan',
  /** Pairs with a device the scan found: 202, it runs in the background. */
  pair: '/v1/bluetooth/pair',
  /** Answers the running pairing's question (`confirm` phase). */
  confirm: '/v1/bluetooth/pairing/confirm',
  /** Stops the running pairing. */
  cancel: '/v1/bluetooth/pairing/cancel',
  connect: '/v1/bluetooth/connect',
  disconnect: '/v1/bluetooth/disconnect',
  /** Removes a paired device (it has to be paired again). */
  forget: '/v1/bluetooth/forget',
} as const;

/** The largest request body. */
export const BLUETOOTH_REQUEST_MAX_BYTES = 1_024;
/** The largest answer the runtime reads (the widest state, every name of four-byte characters, is about 41 KiB). */
export const BLUETOOTH_ANSWER_MAX_BYTES = 65_536;

/**
 * The `LocalError` codes of the Bluetooth socket: `bad_request` (schema), `too_large` (body), and the session's
 * `BLUETOOTH_ERRORS` — `no_bluetooth`, `busy`, `not_found`, `not_paired`, `unavailable` (BlueZ didn't answer).
 */
export const BLUETOOTH_SOCKET_ERRORS = ['bad_request', 'too_large', ...BLUETOOTH_ERRORS] as const;
export type BluetoothSocketError = (typeof BLUETOOTH_SOCKET_ERRORS)[number];

/** The HTTP status each code is answered with (Go `local.BluetoothSocketErrorStatus`). */
export const BLUETOOTH_SOCKET_ERROR_STATUS: Readonly<Record<BluetoothSocketError, number>> = {
  bad_request: 400,
  too_large: 413,
  no_bluetooth: 409,
  busy: 409,
  not_found: 404,
  not_paired: 409,
  unavailable: 503,
};

/** `GET /v1/bluetooth/state`. */
export const BluetoothStateAnswer = z.object({ v: V, bluetooth: BluetoothState });
export type BluetoothStateAnswer = z.infer<typeof BluetoothStateAnswer>;

/** Start looking, or keep looking. */
export const BluetoothScanRequest = z.strictObject({ v: V });
export type BluetoothScanRequest = z.infer<typeof BluetoothScanRequest>;
/** The scan as it is now (`until` moved on). */
export const BluetoothScanAnswer = z.object({ v: V, scan: BluetoothScan });
export type BluetoothScanAnswer = z.infer<typeof BluetoothScanAnswer>;

/** Pair, connect, disconnect or forget the device with this address. */
export const BluetoothDeviceRequest = z.strictObject({ v: V, address: BluetoothAddress });
export type BluetoothDeviceRequest = z.infer<typeof BluetoothDeviceRequest>;

/** **Yes** (`accept` true) or **No** to “Does {name} show {code}?”. */
export const BluetoothConfirmRequest = z.strictObject({
  v: V,
  pairingId: BluetoothPairingId,
  accept: z.boolean(),
});
export type BluetoothConfirmRequest = z.infer<typeof BluetoothConfirmRequest>;

export const BluetoothCancelRequest = z.strictObject({ v: V, pairingId: BluetoothPairingId });
export type BluetoothCancelRequest = z.infer<typeof BluetoothCancelRequest>;

/** The pairing as it is now. */
export const BluetoothPairingAnswer = z.object({ v: V, pairing: BluetoothPairing });
export type BluetoothPairingAnswer = z.infer<typeof BluetoothPairingAnswer>;

/** The paired device after a connect or a disconnect. */
export const BluetoothDeviceAnswer = z.object({ v: V, device: BluetoothDevice });
export type BluetoothDeviceAnswer = z.infer<typeof BluetoothDeviceAnswer>;

/** `forget` answers only the version. */
export const BluetoothAck = z.object({ v: V });
export type BluetoothAck = z.infer<typeof BluetoothAck>;
