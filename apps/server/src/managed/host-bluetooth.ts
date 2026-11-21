/**
 * The box's Bluetooth (docs/decisions/bluetooth.md BT-02…BT-08; bluetooth-server.md BT-S…): the Bluetooth service
 * (`bluetooth-client.ts`) finds devices, pairs one at a time and connects, disconnects and removes paired ones. The
 * runtime asks it for the person (`host.bluetooth*`) and for the box's screen (`desk/bluetooth.ts`), and records each pairing
 * that ends `done` and each removal as one signed event in the appliance's audit chain (BT-08) — names and kinds, never
 * an address (BT-10).
 *
 * Reads never throw: a service that doesn't answer or answers what the contract doesn't allow is `unavailable`, logged
 * at most once a minute. Changes throw `HostBluetoothError`.
 */

import {
  BLUETOOTH_ERROR_STATUS,
  BLUETOOTH_ERRORS,
  BLUETOOTH_POLL_MS,
  BLUETOOTH_RESULT_KEEP_S,
  type BluetoothAuditPayload,
  type BluetoothDevice,
  type BluetoothErrorCode,
  type BluetoothPairing,
  type BluetoothState,
  bluetoothPairingDone,
  type HostBluetoothCancelInput,
  type HostBluetoothConfirmInput,
  type HostBluetoothDeviceInput,
  type HostBluetoothOutput,
  type HostBluetoothScanOutput,
} from '@whombat/protocol/session';
import { externalEffect, outsideCommandScope } from '../commit/scope';
import type { Config } from '../config';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { appendApplianceEvent } from './audit';
import {
  BluetoothCallError,
  type BluetoothPort,
  BluetoothSocketClient,
  bluetoothRefused,
} from './bluetooth-client';
import { FakeBluetooth } from './fake-bluetooth';
import type { NetworkActor } from './host-network';
import { SessionOpError } from './session-error';
import type { SessionPrincipal } from './trust';

/** Who pairs or removes a device: the person in the app (their account and device), or someone at the box's screen. */
export type BluetoothActor = NetworkActor;

/** Fallback words for a refusal; the app and the console make their own from the code (BT-11). */
const REFUSALS: Readonly<Record<BluetoothErrorCode, string>> = {
  no_bluetooth: 'This Whombat has no Bluetooth it can use.',
  busy: 'Another device is pairing. Try again when it’s done.',
  not_found: 'That device isn’t there any more.',
  not_paired: 'That device isn’t paired.',
  unavailable: 'Bluetooth isn’t answering just now. Try again in a moment.',
};

/** A change the service refused or didn't answer: the session op and the desk socket answer with `code`. */
export class HostBluetoothError extends Error {
  constructor(
    readonly code: BluetoothErrorCode,
    message = REFUSALS[code],
  ) {
    super(message);
    this.name = 'HostBluetoothError';
  }
}

const isKnownCode = (code: string): code is BluetoothErrorCode =>
  (BLUETOOTH_ERRORS as readonly string[]).includes(code);

/** The service's refusal as the session sees it: its own code, else `unavailable`. */
function refusalOf(err: unknown): HostBluetoothError {
  if (err instanceof HostBluetoothError) return err;
  if (err instanceof BluetoothCallError && isKnownCode(err.code)) return new HostBluetoothError(err.code);
  return new HostBluetoothError('unavailable');
}

/** A device paired or removed, as the audit chain records it (`bluetooth.device_paired` / `.device_removed`). */
export interface BluetoothRecord {
  kind: 'paired' | 'removed';
  actorAccountId: string | null;
  endpointId: string | null;
  payload: BluetoothAuditPayload;
  at: Date;
}

/** Appends the record to the appliance's audit chain, in its own transaction (BT-08, as HD-S06). */
export function applianceBluetoothRecorder(services: Services): (record: BluetoothRecord) => Promise<void> {
  return (record) =>
    services.pipeline.transactAccount(async (tx) => {
      await appendApplianceEvent(tx, services.custody, {
        type: record.kind === 'paired' ? 'bluetooth.device_paired' : 'bluetooth.device_removed',
        actorAccountId: record.actorAccountId,
        endpointId: record.endpointId,
        payload: record.payload,
        at: record.at,
      });
    });
}

/** A removed device whose name the runtime couldn't read first is recorded as this (BT-S05). */
const UNKNOWN_DEVICE = { name: 'Bluetooth device', kind: 'other' } as const;

/** One warning a minute per kind of call; only the status and the code (the service's words may hold an address). */
class BluetoothWarnings {
  #warnedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly services: Services,
    private readonly what: string,
  ) {}

  warn(err: unknown): void {
    const now = this.services.clock().getTime();
    if (now - this.#warnedAt < 60_000) return;
    this.#warnedAt = now;
    const call = err instanceof BluetoothCallError ? err : null;
    this.services.log.warn(
      { status: call?.status ?? null, code: call?.code ?? (err instanceof Error ? err.name : 'error') },
      `${this.what}: the Bluetooth service didn’t answer`,
    );
  }
}

/**
 * A pairing this runtime started and hasn't seen end: who started it, until when the service keeps its result, and the
 * count of pairings started when it was (an answer to a read sent before that can't tell about it).
 */
interface Started {
  by: BluetoothActor;
  until: number;
  since: number;
}

export interface HostBluetoothOptions {
  /** Where a pairing or a removal is recorded (the appliance chain; tests look). */
  record?: (record: BluetoothRecord) => Promise<void>;
  /** Runs `fn` in `ms`; returns what cancels it (tests: a fake clock's). */
  after?: (ms: number, fn: () => void) => () => void;
}

const timer = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export class HostBluetoothService {
  readonly #record: (record: BluetoothRecord) => Promise<void>;
  readonly #after: (ms: number, fn: () => void) => () => void;
  readonly #stateWarnings: BluetoothWarnings;
  readonly #scanWarnings: BluetoothWarnings;
  readonly #changeWarnings: BluetoothWarnings;
  /** Pairings this runtime started, by id, until it saw them end (BT-S04). */
  readonly #started = new Map<string, Started>();
  /** Pairings started so far (`Started.since`). */
  #count = 0;
  #watch: (() => void) | null = null;
  #closed = false;

  constructor(
    private readonly services: Services,
    private readonly port: BluetoothPort,
    options: HostBluetoothOptions = {},
  ) {
    this.#record = options.record ?? applianceBluetoothRecorder(services);
    this.#after = options.after ?? timer;
    this.#stateWarnings = new BluetoothWarnings(services, 'bluetooth state');
    this.#scanWarnings = new BluetoothWarnings(services, 'bluetooth scan');
    this.#changeWarnings = new BluetoothWarnings(services, 'bluetooth change');
  }

  /** Whether a pairing this runtime started is still followed (tests). */
  get following(): boolean {
    return this.#started.size > 0;
  }

  /** The adapter, the paired devices, the look and the pairing now, or null when the service doesn't tell. */
  async state(): Promise<BluetoothState | null> {
    const asked = this.#count;
    try {
      const state = await this.port.state();
      this.#seen(state.pairing, asked);
      return state;
    } catch (err) {
      this.#stateWarnings.warn(err);
      return null;
    }
  }

  async read(): Promise<HostBluetoothOutput> {
    const bluetooth = await this.state();
    return bluetooth ? { bluetooth } : { bluetooth: null, reason: 'unavailable' };
  }

  /**
   * Starts looking for devices, or keeps it on a minute more (BT-07); `no_bluetooth` without an adapter that's on. The
   * one refusal: `busy` while a pairing runs (BT-S03).
   */
  async scan(): Promise<HostBluetoothScanOutput> {
    try {
      return { scan: await this.port.scan() };
    } catch (err) {
      if (err instanceof BluetoothCallError && err.code === 'no_bluetooth')
        return { scan: null, reason: 'no_bluetooth' };
      if (err instanceof BluetoothCallError && err.code === 'busy') throw new HostBluetoothError('busy');
      this.#scanWarnings.warn(err);
      return { scan: null, reason: 'unavailable' };
    }
  }

  /** Pairs a device the look found (BT-03): answers once it started; the runtime follows it to its end (BT-S04). */
  async pair(address: string, by: BluetoothActor): Promise<BluetoothPairing> {
    // A pairing of ours not seen to end yet is read first: the new one takes its place in the service's state.
    if (this.#started.size > 0) await this.state();
    const asked = this.#count;
    const pairing = await this.#change('pair', () => this.port.pair(address));
    this.#started.set(pairing.id, {
      by,
      until: Date.parse(pairing.deadline) + BLUETOOTH_RESULT_KEEP_S * 1000,
      since: ++this.#count,
    });
    this.services.log.info(
      { kind: pairing.kind, via: by.via, pairingId: pairing.id },
      'bluetooth: pairing started',
    );
    this.#seen(pairing, asked);
    this.#follow();
    return pairing;
  }

  /** The person's answer to “Does {name} show {code}?” (BT-04). */
  async confirm(pairingId: string, accept: boolean): Promise<BluetoothPairing> {
    const asked = this.#count;
    const pairing = await this.#change('confirm', () => this.port.confirm(pairingId, accept));
    this.#seen(pairing, asked);
    return pairing;
  }

  async cancel(pairingId: string): Promise<BluetoothPairing> {
    const asked = this.#count;
    const pairing = await this.#change('cancel', () => this.port.cancel(pairingId));
    this.#seen(pairing, asked);
    return pairing;
  }

  async connect(address: string, by: BluetoothActor): Promise<BluetoothDevice> {
    const device = await this.#change('connect', () => this.port.connect(address));
    this.services.log.info({ kind: device.kind, via: by.via }, 'bluetooth: device connected');
    return device;
  }

  async disconnect(address: string, by: BluetoothActor): Promise<BluetoothDevice> {
    const device = await this.#change('disconnect', () => this.port.disconnect(address));
    this.services.log.info({ kind: device.kind, via: by.via }, 'bluetooth: device disconnected');
    return device;
  }

  /** Removes a paired device (BT-05): it has to be paired again. One `bluetooth.device_removed` in the chain. */
  async forget(address: string, by: BluetoothActor): Promise<void> {
    // The answer has no device: its name and kind for the record come from the paired list first.
    const known = (await this.state())?.devices.find((d) => d.address === address);
    await this.#change('forget', () => this.port.forget(address));
    const { name, kind } = known ?? UNKNOWN_DEVICE;
    this.services.log.info({ kind, via: by.via }, 'bluetooth: device removed');
    await this.#audit('removed', by, { name, kind, via: by.via });
  }

  close(): void {
    this.#closed = true;
    this.#watch?.();
    this.#watch = null;
  }

  async #change<T>(label: string, call: () => Promise<T>): Promise<T> {
    try {
      // The service changes what the box is paired or connected with (command-safety.md CS-01): not idempotent; a
      // refusal or a socket nobody listens on did nothing.
      return await externalEffect(`bluetooth.${label}`, call, { refused: bluetoothRefused });
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal.code === 'unavailable') this.#changeWarnings.warn(err);
      throw refusal;
    }
  }

  /**
   * The pairing the service answered with, to a call sent when `asked` pairings had started (BT-S04): one of ours that
   * ended is let go — at once, so it is recorded once however many reads see it — and recorded when it paired; one the
   * service no longer shows is let go unrecorded. Ours started after the call was sent are left for a later answer.
   */
  #seen(pairing: BluetoothPairing | null, asked: number): void {
    for (const [id, started] of this.#started) {
      if (started.since > asked) continue;
      if (pairing?.id === id && !bluetoothPairingDone(pairing.phase)) continue;
      this.#started.delete(id);
      if (pairing?.id !== id) {
        this.services.log.info({ pairingId: id }, 'bluetooth: a pairing ended unseen');
        continue;
      }
      this.services.log.info(
        {
          kind: pairing.kind,
          via: started.by.via,
          pairingId: id,
          phase: pairing.phase,
          failure: pairing.failure,
        },
        pairing.phase === 'done' ? 'bluetooth: device paired' : 'bluetooth: pairing failed',
      );
      // Noticed by whichever read saw it: written on its own, never part of that request's receipt (MR-57's way).
      const payload = { name: pairing.name, kind: pairing.kind, via: started.by.via };
      if (pairing.phase === 'done')
        outsideCommandScope(() => void this.#audit('paired', started.by, payload));
    }
  }

  /** While a pairing of ours runs, its state is read every second, so it is recorded even when nobody looks. */
  #follow(): void {
    if (this.#watch || this.#closed || this.#started.size === 0) return;
    this.#watch = outsideCommandScope(() =>
      this.#after(BLUETOOTH_POLL_MS, () => {
        this.#watch = null;
        void this.#tick();
      }),
    );
  }

  async #tick(): Promise<void> {
    if (this.#closed) return;
    await this.state();
    // A service that stopped answering (or never ends one): ours go once it would have forgotten their result anyway.
    const now = this.services.clock().getTime();
    for (const [id, started] of this.#started)
      if (now >= started.until) {
        this.#started.delete(id);
        this.services.log.info({ pairingId: id }, 'bluetooth: a pairing ended unseen');
      }
    this.#follow();
  }

  /** One signed event in the appliance chain; a lost entry is logged, not answered as a failed change. */
  async #audit(
    kind: BluetoothRecord['kind'],
    by: BluetoothActor,
    payload: BluetoothAuditPayload,
  ): Promise<void> {
    try {
      await this.#record({
        kind,
        actorAccountId: by.via === 'app' ? by.accountId : null,
        endpointId: by.via === 'app' ? by.endpointId : null,
        payload,
        at: this.services.clock(),
      });
    } catch (err) {
      this.services.log.error(
        { err: String(err).slice(0, 200), kind },
        'bluetooth: the change wasn’t recorded in the audit log',
      );
    }
  }
}

/* Per process ----------------------------------------------------------------------------------------------------- */

type BluetoothConfig = Pick<Config, 'WHOMBAT_BLUETOOTH' | 'WHOMBAT_BLUETOOTH_SOCKET'>;
type BluetoothServices = { config: BluetoothConfig; clock?: () => Date };

const ports = new WeakMap<object, BluetoothPort | null>();

/**
 * The process's Bluetooth service (one per `Services`): the fake (on the services' clock), the socket's client, or none
 * (no socket: this box has no Bluetooth, BT-S02).
 */
export function bluetoothFor(services: BluetoothServices): BluetoothPort | null {
  if (ports.has(services)) return ports.get(services) ?? null;
  const { WHOMBAT_BLUETOOTH: mode, WHOMBAT_BLUETOOTH_SOCKET: socket } = services.config;
  const clock = services.clock;
  const port =
    mode === 'off'
      ? null
      : mode === 'fake'
        ? new FakeBluetooth(clock ? () => clock().getTime() : Date.now)
        : socket
          ? new BluetoothSocketClient(socket)
          : null;
  ports.set(services, port);
  return port;
}

/* The session ops (§2.2): the person's devices only ---------------------------------------------------------------- */

interface HostBluetoothOpContext {
  principal: SessionPrincipal;
  bluetooth: HostBluetoothService | undefined;
}

function appActorOf(c: HostBluetoothOpContext): BluetoothActor & { via: 'app' } {
  if (!c.principal.account) throw new ApiError('unauthorized', 'Enroll this device first.');
  return { via: 'app', accountId: c.principal.account.id, endpointId: c.principal.endpoint?.id ?? null };
}

/** A refusal as a session error: the generic code, Bluetooth's own in `details.code` (as `host.wifi.*`'s). */
function sessionRefusal(err: unknown): unknown {
  if (!(err instanceof HostBluetoothError)) return err;
  if (err.code === 'unavailable') return new SessionOpError('unavailable', err.message);
  return new SessionOpError(BLUETOOTH_ERROR_STATUS[err.code], err.message, { code: err.code });
}

/** The person's change: refused `no_bluetooth` on a runtime without a Bluetooth service (BT-S03). */
async function change<T>(
  c: HostBluetoothOpContext,
  run: (bluetooth: HostBluetoothService, by: BluetoothActor) => Promise<T>,
): Promise<T> {
  const by = appActorOf(c);
  try {
    if (!c.bluetooth) throw new HostBluetoothError('no_bluetooth');
    return await run(c.bluetooth, by);
  } catch (err) {
    throw sessionRefusal(err);
  }
}

export async function hostBluetoothOp(c: HostBluetoothOpContext): Promise<HostBluetoothOutput> {
  appActorOf(c);
  if (!c.bluetooth) return { bluetooth: null, reason: 'not_managed' };
  return c.bluetooth.read();
}

export async function hostBluetoothScanOp(c: HostBluetoothOpContext): Promise<HostBluetoothScanOutput> {
  appActorOf(c);
  if (!c.bluetooth) return { scan: null, reason: 'not_managed' };
  try {
    return await c.bluetooth.scan();
  } catch (err) {
    throw sessionRefusal(err);
  }
}

export function hostBluetoothPairOp(
  c: HostBluetoothOpContext,
  input: HostBluetoothDeviceInput,
): Promise<{ pairing: BluetoothPairing }> {
  return change(c, async (b, by) => ({ pairing: await b.pair(input.address, by) }));
}

export function hostBluetoothConfirmOp(
  c: HostBluetoothOpContext,
  input: HostBluetoothConfirmInput,
): Promise<{ pairing: BluetoothPairing }> {
  return change(c, async (b) => ({ pairing: await b.confirm(input.pairingId, input.accept) }));
}

export function hostBluetoothCancelOp(
  c: HostBluetoothOpContext,
  input: HostBluetoothCancelInput,
): Promise<{ pairing: BluetoothPairing }> {
  return change(c, async (b) => ({ pairing: await b.cancel(input.pairingId) }));
}

export function hostBluetoothConnectOp(
  c: HostBluetoothOpContext,
  input: HostBluetoothDeviceInput,
): Promise<{ device: BluetoothDevice }> {
  return change(c, async (b, by) => ({ device: await b.connect(input.address, by) }));
}

export function hostBluetoothDisconnectOp(
  c: HostBluetoothOpContext,
  input: HostBluetoothDeviceInput,
): Promise<{ device: BluetoothDevice }> {
  return change(c, async (b, by) => ({ device: await b.disconnect(input.address, by) }));
}

export function hostBluetoothForgetOp(
  c: HostBluetoothOpContext,
  input: HostBluetoothDeviceInput,
): Promise<{ ok: true }> {
  return change(c, async (b, by) => {
    await b.forget(input.address, by);
    return { ok: true } as const;
  });
}
