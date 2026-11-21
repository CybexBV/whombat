/**
 * The desk socket's Bluetooth routes (docs/decisions/bluetooth.md BT-02; bluetooth-server.md BT-S06): the box's screen
 * shows the paired devices and may add, connect, disconnect and remove them when that is safe — the box isn't claimed
 * yet, or the screen is unlocked (the desk PIN or the phone, DK-04). They work on an unpaired screen too. The console
 * server has no Bluetooth access (BT-09): it asks here, and the runtime decides again.
 *
 *   GET  /v1/desk/bluetooth             → {v, bluetooth, mayChange, why?: 'locked'}
 *   POST /v1/desk/bluetooth/scan        {v} → {v, scan}
 *   POST /v1/desk/bluetooth/pair        {v, address} → {v, pairing}
 *   POST /v1/desk/bluetooth/confirm     {v, pairingId, accept} → {v, pairing}
 *   POST /v1/desk/bluetooth/cancel      {v, pairingId} → {v, pairing}
 *   POST /v1/desk/bluetooth/connect     {v, address} → {v, device}
 *   POST /v1/desk/bluetooth/disconnect  {v, address} → {v, device}
 *   POST /v1/desk/bluetooth/forget      {v, address} → {v}
 *
 * Every POST while the screen may not change it is 409 `locked`; without a Bluetooth service 409 `no_bluetooth` (the
 * GET answers `adapter: null, missing: 'no_adapter'`). The service's refusals pass through: `no_bluetooth`, `busy` (a
 * pair or a scan while a pairing runs), `not_paired` 409, `not_found` 404, `unavailable` 503. A pairing or a removal is recorded in the appliance's audit
 * chain as the screen's, and every change keeps an unlocked screen unlocked (a touch, as a decision is).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DESK_PATHS,
  type DeskBluetoothAnswer,
  DeskBluetoothCancelRequest,
  DeskBluetoothConfirmRequest,
  DeskBluetoothDeviceRequest,
  DeskRequest,
} from '@whombat/control-contracts/local';
import type { BluetoothErrorCode, BluetoothState } from '@whombat/protocol/session';
import type { z } from 'zod';
import { HostBluetoothError, type HostBluetoothService } from '../managed/host-bluetooth';
import { DESK_MAX_BODY, type DeskRoutes, NOT_JSON, readJson, send, TOO_LARGE } from './socket';

/**
 * Whether the screen may change the box's Bluetooth now (BT-02): before the box is claimed, or while the screen is
 * unlocked; otherwise it shows the paired devices and says to unlock or use the app.
 */
export function deskMayChangeBluetooth(facts: { claimed: boolean; unlocked: boolean }): {
  mayChange: boolean;
  why?: 'locked';
} {
  if (facts.unlocked || !facts.claimed) return { mayChange: true };
  return { mayChange: false, why: 'locked' };
}

/** What the routes ask of the runtime: the Bluetooth service (none on a box without one), the claim, the lock. */
export interface DeskBluetoothHost {
  bluetooth: Pick<
    HostBluetoothService,
    'state' | 'scan' | 'pair' | 'confirm' | 'cancel' | 'connect' | 'disconnect' | 'forget'
  > | null;
  /** The runtime's own claim state (`TrustService.isClaimed`). */
  claimed(): Promise<boolean>;
  /** Whether the screen is unlocked now (`DeskLock`). */
  unlocked(): boolean;
  /** Keeps an unlocked screen unlocked. */
  touch(): void;
}

/** A box without a Bluetooth service, as the screen is told. */
export const NO_BLUETOOTH: BluetoothState = {
  adapter: null,
  missing: 'no_adapter',
  devices: [],
  scan: null,
  pairing: null,
};

const REFUSAL_STATUS: Readonly<Record<BluetoothErrorCode, number>> = {
  no_bluetooth: 409,
  busy: 409,
  not_paired: 409,
  not_found: 404,
  unavailable: 503,
};

const NOT_FOUND = { error: { code: 'not_found', message: 'No such endpoint.' } };
const UNAVAILABLE = { error: { code: 'unavailable', message: 'Bluetooth can’t be read right now.' } };
const LOCKED = {
  error: { code: 'locked', message: 'Unlock the screen to add or remove devices, or use the app.' },
};

export class DeskBluetoothRoutes implements DeskRoutes {
  readonly #paths: ReadonlySet<string> = new Set([
    DESK_PATHS.bluetooth,
    DESK_PATHS.bluetoothScan,
    DESK_PATHS.bluetoothPair,
    DESK_PATHS.bluetoothConfirm,
    DESK_PATHS.bluetoothCancel,
    DESK_PATHS.bluetoothConnect,
    DESK_PATHS.bluetoothDisconnect,
    DESK_PATHS.bluetoothForget,
  ]);

  constructor(private readonly host: DeskBluetoothHost) {}

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!this.#paths.has(path)) return false;
    if (path === DESK_PATHS.bluetooth) {
      if (req.method !== 'GET') send(res, 404, NOT_FOUND);
      else await this.#state(res);
      return true;
    }
    if (req.method !== 'POST') {
      send(res, 404, NOT_FOUND);
      return true;
    }
    const body = await readJson(req, DESK_MAX_BODY);
    if (body === TOO_LARGE) {
      send(res, 413, { error: { code: 'too_large', message: 'The request is too large.' } });
      return true;
    }
    if (body === NOT_JSON) {
      send(res, 400, { error: { code: 'bad_request', message: 'The body must be JSON.' } });
      return true;
    }
    switch (path) {
      case DESK_PATHS.bluetoothScan:
        if (parse(res, DeskRequest, body))
          await this.#change(res, async (b) => {
            const { scan, reason } = await b.scan();
            if (!scan)
              throw new HostBluetoothError(reason === 'no_bluetooth' ? 'no_bluetooth' : 'unavailable');
            return { scan };
          });
        break;
      case DESK_PATHS.bluetoothPair: {
        const input = parse(res, DeskBluetoothDeviceRequest, body);
        if (input)
          await this.#change(res, async (b) => ({
            pairing: await b.pair(input.address, { via: 'screen' }),
          }));
        break;
      }
      case DESK_PATHS.bluetoothConfirm: {
        const input = parse(res, DeskBluetoothConfirmRequest, body);
        if (input)
          await this.#change(res, async (b) => ({ pairing: await b.confirm(input.pairingId, input.accept) }));
        break;
      }
      case DESK_PATHS.bluetoothCancel: {
        const input = parse(res, DeskBluetoothCancelRequest, body);
        if (input) await this.#change(res, async (b) => ({ pairing: await b.cancel(input.pairingId) }));
        break;
      }
      case DESK_PATHS.bluetoothConnect: {
        const input = parse(res, DeskBluetoothDeviceRequest, body);
        if (input)
          await this.#change(res, async (b) => ({
            device: await b.connect(input.address, { via: 'screen' }),
          }));
        break;
      }
      case DESK_PATHS.bluetoothDisconnect: {
        const input = parse(res, DeskBluetoothDeviceRequest, body);
        if (input)
          await this.#change(res, async (b) => ({
            device: await b.disconnect(input.address, { via: 'screen' }),
          }));
        break;
      }
      case DESK_PATHS.bluetoothForget: {
        const input = parse(res, DeskBluetoothDeviceRequest, body);
        if (input)
          await this.#change(res, async (b) => {
            await b.forget(input.address, { via: 'screen' });
            return {};
          });
        break;
      }
    }
    return true;
  }

  async #mayChange(): Promise<{ mayChange: boolean; why?: 'locked' }> {
    const unlocked = this.host.unlocked();
    return deskMayChangeBluetooth({ unlocked, claimed: unlocked ? true : await this.host.claimed() });
  }

  async #state(res: ServerResponse): Promise<void> {
    const bluetooth = this.host.bluetooth ? await this.host.bluetooth.state() : NO_BLUETOOTH;
    if (!bluetooth) {
      send(res, 503, UNAVAILABLE);
      return;
    }
    const answer: DeskBluetoothAnswer = { v: 1, bluetooth, ...(await this.#mayChange()) };
    send(res, 200, answer);
  }

  /** A change: decided again here (BT-02), then the service's; the screen stays unlocked after it. */
  async #change(
    res: ServerResponse,
    run: (bluetooth: NonNullable<DeskBluetoothHost['bluetooth']>) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    if (!(await this.#mayChange()).mayChange) {
      send(res, 409, LOCKED);
      return;
    }
    try {
      if (!this.host.bluetooth) throw new HostBluetoothError('no_bluetooth');
      const answer = await run(this.host.bluetooth);
      this.host.touch();
      send(res, 200, { v: 1, ...answer });
    } catch (err) {
      if (!(err instanceof HostBluetoothError)) throw err;
      send(res, REFUSAL_STATUS[err.code], { error: { code: err.code, message: err.message } });
    }
  }
}

/** The body as `schema` says, or a 400 `bad_request` answered. */
function parse<S extends z.ZodType>(res: ServerResponse, schema: S, body: unknown): z.output<S> | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  send(res, 400, { error: { code: 'bad_request', message: 'The request isn’t valid.' } });
  return null;
}
