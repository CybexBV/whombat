/**
 * The box's Bluetooth service as the runtime sees it (docs/decisions/bluetooth.md BT-03, BT-09; bluetooth-server.md
 * BT-S02): `whombat-bluetooth`, the only process that talks to BlueZ, answers a small JSON API on its unix socket
 * (`WHOMBAT_BLUETOOTH_SOCKET`, `/run/whombat-bluetooth/bluetooth.sock` on a box; build brief §2.3):
 *
 *   GET  /v1/bluetooth/state             → {v, bluetooth}
 *   POST /v1/bluetooth/scan              {v} → {v, scan}            (starts looking, or keeps it on 60 s more)
 *   POST /v1/bluetooth/pair              {v, address} → 202 {v, pairing}   (stops looking; runs in the background)
 *   POST /v1/bluetooth/pairing/confirm   {v, pairingId, accept} → {v, pairing}
 *   POST /v1/bluetooth/pairing/cancel    {v, pairingId} → {v, pairing}
 *   POST /v1/bluetooth/connect           {v, address} → {v, device}  (waits ≤ 15 s)
 *   POST /v1/bluetooth/disconnect        {v, address} → {v, device}
 *   POST /v1/bluetooth/forget            {v, address} → {v}
 *
 * Errors are `LocalError`s: `no_bluetooth`, `busy`, `not_paired` 409, `not_found` 404, `unavailable` 503, `bad_request`
 * 400, `too_large` 413. `WHOMBAT_BLUETOOTH=fake` puts the fake (`fake-bluetooth.ts`) in its place for development and
 * tests (`host-bluetooth.ts` `bluetoothFor`). Only the status and the code of an error are kept: the service's words may name a device's address (BT-10).
 */
import {
  BLUETOOTH_ANSWER_MAX_BYTES,
  BLUETOOTH_PATHS,
  BluetoothAck,
  BluetoothCancelRequest,
  BluetoothConfirmRequest,
  BluetoothDeviceAnswer,
  BluetoothDeviceRequest,
  BluetoothPairingAnswer,
  BluetoothScanAnswer,
  BluetoothScanRequest,
  BluetoothStateAnswer,
} from '@whombat/control-contracts/local';
import { requestUnixHttp, UnixHttpError } from '@whombat/node-io/http';
import {
  BLUETOOTH_CONNECT_S,
  type BluetoothDevice,
  type BluetoothPairing,
  type BluetoothScan,
  type BluetoothState,
} from '@whombat/protocol/session';
import type { z } from 'zod';

/** The Bluetooth service: the socket's client, or the fake. Refusals are `BluetoothCallError`s. */
export interface BluetoothPort {
  state(): Promise<BluetoothState>;
  scan(): Promise<BluetoothScan>;
  pair(address: string): Promise<BluetoothPairing>;
  confirm(pairingId: string, accept: boolean): Promise<BluetoothPairing>;
  cancel(pairingId: string): Promise<BluetoothPairing>;
  connect(address: string): Promise<BluetoothDevice>;
  disconnect(address: string): Promise<BluetoothDevice>;
  forget(address: string): Promise<void>;
}

/**
 * A call the service refused (its status and `LocalError` code), or one it didn't answer (status 0, `unreachable`), or
 * an answer outside the contract (`invalid_answer`).
 */
export class BluetoothCallError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BluetoothCallError';
  }
}

/** The service refused it, or nobody listens on its socket: nothing happened (command-safety.md CS-01). */
export function bluetoothRefused(err: unknown): boolean {
  if (!(err instanceof BluetoothCallError)) return false;
  if (err.status >= 400 && err.status < 500) return true;
  return err.status === 0 && /ENOENT|ECONNREFUSED/.test(err.message);
}

/**
 * How long each call may take, the whole call (BT-S02): the service answers state, scans and the pairing's steps from
 * memory; a pair answers once it started (202). A connect waits up to 15 s for the device, a disconnect and a forget for
 * BlueZ to drop the link.
 */
export const BLUETOOTH_CALL_MS = 2_000;
export const BLUETOOTH_CONNECT_MS = BLUETOOTH_CONNECT_S * 1000 + 1_000;
export const BLUETOOTH_DROP_MS = 5_000;

export interface BluetoothDeadlines {
  call: number;
  connect: number;
  drop: number;
}

const DEADLINES: BluetoothDeadlines = {
  call: BLUETOOTH_CALL_MS,
  connect: BLUETOOTH_CONNECT_MS,
  drop: BLUETOOTH_DROP_MS,
};

export class BluetoothSocketClient implements BluetoothPort {
  constructor(
    private readonly socketPath: string,
    private readonly deadlines: BluetoothDeadlines = DEADLINES,
  ) {}

  private async call<S extends z.ZodType>(
    path: string,
    body: unknown,
    answer: S,
    deadlineMs = this.deadlines.call,
  ): Promise<z.output<S>> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let response: Awaited<ReturnType<typeof requestUnixHttp>>;
    try {
      response = await requestUnixHttp({
        socketPath: this.socketPath,
        path,
        method: payload === undefined ? 'GET' : 'POST',
        headers:
          payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        ...(payload === undefined ? {} : { body: payload }),
        deadlineMs,
        maxResponseBytes: BLUETOOTH_ANSWER_MAX_BYTES,
      });
    } catch (err) {
      const why = err instanceof UnixHttpError ? err.kind : String(err).slice(0, 120);
      throw new BluetoothCallError(path, 0, 'unreachable', `bluetooth ${path}: ${why}`);
    }
    const status = response.status || 500;
    const text = response.body.toString('utf8');
    if (status >= 300) {
      const code = localErrorCode(text);
      throw new BluetoothCallError(path, status, code, `bluetooth ${path}: ${status} ${code}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BluetoothCallError(path, status, 'invalid_answer', `bluetooth ${path}: not JSON`);
    }
    const parsed = answer.safeParse(json);
    if (!parsed.success)
      throw new BluetoothCallError(path, status, 'invalid_answer', `bluetooth ${path}: not the contract`);
    return parsed.data;
  }

  async state(): Promise<BluetoothState> {
    return (await this.call(BLUETOOTH_PATHS.state, undefined, BluetoothStateAnswer)).bluetooth;
  }

  async scan(): Promise<BluetoothScan> {
    const body = BluetoothScanRequest.parse({ v: 1 });
    return (await this.call(BLUETOOTH_PATHS.scan, body, BluetoothScanAnswer)).scan;
  }

  async pair(address: string): Promise<BluetoothPairing> {
    const body = BluetoothDeviceRequest.parse({ v: 1, address });
    return (await this.call(BLUETOOTH_PATHS.pair, body, BluetoothPairingAnswer)).pairing;
  }

  async confirm(pairingId: string, accept: boolean): Promise<BluetoothPairing> {
    const body = BluetoothConfirmRequest.parse({ v: 1, pairingId, accept });
    return (await this.call(BLUETOOTH_PATHS.confirm, body, BluetoothPairingAnswer)).pairing;
  }

  async cancel(pairingId: string): Promise<BluetoothPairing> {
    const body = BluetoothCancelRequest.parse({ v: 1, pairingId });
    return (await this.call(BLUETOOTH_PATHS.cancel, body, BluetoothPairingAnswer)).pairing;
  }

  async connect(address: string): Promise<BluetoothDevice> {
    const body = BluetoothDeviceRequest.parse({ v: 1, address });
    return (await this.call(BLUETOOTH_PATHS.connect, body, BluetoothDeviceAnswer, this.deadlines.connect))
      .device;
  }

  async disconnect(address: string): Promise<BluetoothDevice> {
    const body = BluetoothDeviceRequest.parse({ v: 1, address });
    return (await this.call(BLUETOOTH_PATHS.disconnect, body, BluetoothDeviceAnswer, this.deadlines.drop))
      .device;
  }

  async forget(address: string): Promise<void> {
    const body = BluetoothDeviceRequest.parse({ v: 1, address });
    await this.call(BLUETOOTH_PATHS.forget, body, BluetoothAck, this.deadlines.drop);
  }
}

/** A `LocalError`'s code (at most 64 characters), else `error`. Never the message: it may hold an address. */
function localErrorCode(text: string): string {
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
    if (typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)) return code;
  } catch {
    /* not a LocalError */
  }
  return 'error';
}
