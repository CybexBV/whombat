/**
 * A fake Bluetooth service (bluetooth-server.md BT-S09), for tests and the dev world (`WHOMBAT_BLUETOOTH=fake`): an
 * adapter, two paired devices (a Keychron K3 keyboard, connected with its battery at 80 %, and WH-1000XM5 headphones,
 * not connected) and, while looking, devices in pairing mode nearby — an MX Master 3S mouse that pairs without a code, a
 * Magic Keyboard that is given a code and types it, a JBL Flip 6 speaker, an Xbox controller that shows a number to
 * confirm (No ends it `rejected`), a speaker that refuses, and a Pixel 9 phone that is never listed (BT-01). Everything moves on the clock it is
 * given whenever it is asked, so a test steps time instead of waiting. Refusals are the service's: `BluetoothCallError`
 * with its statuses and codes (409 `no_bluetooth`, `busy` — a pair or a scan while a pairing runs —, `not_paired`; 404 `not_found`; 503 `unavailable`).
 */

import { BLUETOOTH_PATHS } from '@whombat/control-contracts/local';
import {
  BLUETOOTH_PAIRING_S,
  BLUETOOTH_RESULT_KEEP_S,
  BLUETOOTH_SCAN_S,
  type BluetoothDevice,
  type BluetoothKind,
  type BluetoothPairing,
  type BluetoothPairingFailure,
  type BluetoothScan,
  type BluetoothState,
} from '@whombat/protocol/session';
import { BluetoothCallError, type BluetoothPort } from './bluetooth-client';

/** How a fake device pairs: without a code, typing the box's code, confirming a number, refusing, or not answering. */
export type FakePairing = 'just_works' | 'code' | 'confirm' | 'reject' | 'silent';

export interface FakeBluetoothDevice {
  address: string;
  name: string;
  /** `phone` and `computer` are what the service leaves out of every list (BT-01). */
  kind: BluetoothKind | 'phone' | 'computer';
  /** Bars while it is found. */
  signal: number;
  battery?: number;
  pairing: FakePairing;
  /** Found this long after looking started. */
  foundAfterMs?: number;
}

/** How long the fake's steps take. */
export interface FakeBluetoothTimings {
  /** Each step of a pairing: to the code or the question, each digit typed, connecting, done. */
  stepMs: number;
}

export const FAKE_BLUETOOTH_TIMINGS: FakeBluetoothTimings = { stepMs: 1_500 };

/** The code the fake box makes for a keyboard, and the number its controller shows. */
export const FAKE_PASSKEY = '480516';

/** The paired devices: the keyboard on, the headphones off. */
export function fakePairedDevices(): BluetoothDevice[] {
  return [
    { address: 'DC:2C:26:4A:11:03', name: 'Keychron K3', kind: 'keyboard', connected: true, battery: 80 },
    { address: '88:C9:E8:3B:20:5F', name: 'WH-1000XM5', kind: 'headphones', connected: false },
  ];
}

/** The devices in pairing mode nearby. */
export function fakeNearbyDevices(): FakeBluetoothDevice[] {
  return [
    { address: 'D4:3A:2C:91:7E:0B', name: 'MX Master 3S', kind: 'mouse', signal: 4, pairing: 'just_works' },
    {
      address: '7C:C1:80:5D:44:E2',
      name: 'Magic Keyboard',
      kind: 'keyboard',
      signal: 3,
      pairing: 'code',
      foundAfterMs: 1_000,
    },
    {
      address: 'F8:DF:15:A6:03:9C',
      name: 'JBL Flip 6',
      kind: 'speaker',
      signal: 2,
      pairing: 'just_works',
      foundAfterMs: 2_000,
    },
    {
      address: '98:7A:14:2E:B5:61',
      name: 'Xbox Wireless Controller',
      kind: 'gamepad',
      signal: 2,
      pairing: 'confirm',
      foundAfterMs: 3_000,
    },
    {
      address: '00:1A:7D:DA:71:13',
      name: 'Old Speaker',
      kind: 'speaker',
      signal: 1,
      pairing: 'reject',
      foundAfterMs: 4_000,
    },
    { address: '3C:28:6D:F0:12:AB', name: 'Pixel 9', kind: 'phone', signal: 4, pairing: 'just_works' },
  ];
}

const listed = (d: FakeBluetoothDevice): d is FakeBluetoothDevice & { kind: BluetoothKind } =>
  d.kind !== 'phone' && d.kind !== 'computer';

interface Running {
  pairing: BluetoothPairing;
  device: FakeBluetoothDevice;
  startedAt: number;
  /** When the code or the question appeared (phase `code` / `confirm`). */
  askedAt: number | null;
  /** The person's yes to the number, and when. */
  confirmedAt: number | null;
  /** When it ended, for keeping the result 60 s. */
  endedAt: number | null;
}

export class FakeBluetooth implements BluetoothPort {
  /** No adapter (`no_adapter`), a driver missing (`no_driver`), or the adapter off (`disabled`). */
  missing: 'no_adapter' | 'no_driver' | 'disabled' | null = null;
  /** The service doesn't answer (503). */
  down = false;
  readonly paired: BluetoothDevice[];
  readonly nearby: FakeBluetoothDevice[];
  /** What was asked, in order (`scan`, `pair DC:…`): tests look. */
  readonly calls: string[] = [];
  #scanFrom: number | null = null;
  #scanUntil = 0;
  #running: Running | null = null;
  #pairings = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly timings: FakeBluetoothTimings = FAKE_BLUETOOTH_TIMINGS,
    devices: { paired?: BluetoothDevice[]; nearby?: FakeBluetoothDevice[] } = {},
  ) {
    this.paired = devices.paired ?? fakePairedDevices();
    this.nearby = devices.nearby ?? fakeNearbyDevices();
  }

  async state(): Promise<BluetoothState> {
    this.#check('state');
    const now = this.now();
    this.#advance(now);
    if (this.missing === 'no_adapter' || this.missing === 'no_driver')
      return { adapter: null, missing: this.missing, devices: [], scan: null, pairing: null };
    const devices = [...this.paired].sort(
      (a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name),
    );
    if (this.missing === 'disabled')
      return {
        adapter: { name: 'whombat', powered: false },
        missing: 'disabled',
        devices: devices.map((d) => ({ ...d, connected: false })),
        scan: null,
        pairing: null,
      };
    return {
      adapter: { name: 'whombat', powered: true },
      devices,
      scan: this.#scan(now),
      pairing: this.#running ? { ...this.#running.pairing } : null,
    };
  }

  async scan(): Promise<BluetoothScan> {
    this.#check('scan');
    this.#powered(BLUETOOTH_PATHS.scan);
    const now = this.now();
    this.#advance(now);
    // A pairing that runs has stopped looking; looking again waits for it (BT-07).
    if (this.#running && this.#running.endedAt === null) throw refused(BLUETOOTH_PATHS.scan, 409, 'busy');
    if (this.#scanFrom === null || now >= this.#scanUntil) this.#scanFrom = now;
    this.#scanUntil = now + BLUETOOTH_SCAN_S * 1000;
    return this.#scan(now) as BluetoothScan;
  }

  async pair(address: string): Promise<BluetoothPairing> {
    this.#check(`pair ${address}`);
    this.#powered(BLUETOOTH_PATHS.pair);
    const now = this.now();
    this.#advance(now);
    if (this.#running && this.#running.endedAt === null) throw refused(BLUETOOTH_PATHS.pair, 409, 'busy');
    const device = this.#found(now).find((d) => d.address === address);
    if (!device) throw refused(BLUETOOTH_PATHS.pair, 404, 'not_found');
    // Pairing stops looking (BT-07).
    this.#scanFrom = null;
    this.#pairings++;
    this.#running = {
      pairing: {
        id: `p-fake${String(this.#pairings).padStart(8, '0')}`,
        address,
        name: device.name,
        kind: device.kind,
        phase: 'pairing',
        deadline: new Date(now + BLUETOOTH_PAIRING_S * 1000).toISOString(),
      },
      device,
      startedAt: now,
      askedAt: null,
      confirmedAt: null,
      endedAt: null,
    };
    return { ...this.#running.pairing };
  }

  async confirm(pairingId: string, accept: boolean): Promise<BluetoothPairing> {
    this.#check(`confirm ${pairingId} ${accept}`);
    const now = this.now();
    const run = this.#current(pairingId, BLUETOOTH_PATHS.confirm, now);
    if (run.pairing.phase === 'confirm') {
      if (accept) run.confirmedAt = now;
      else this.#end(run, now, 'rejected');
      this.#advance(now);
    }
    return { ...run.pairing };
  }

  async cancel(pairingId: string): Promise<BluetoothPairing> {
    this.#check(`cancel ${pairingId}`);
    const now = this.now();
    const run = this.#current(pairingId, BLUETOOTH_PATHS.cancel, now);
    if (run.endedAt === null) this.#end(run, now, 'canceled');
    return { ...run.pairing };
  }

  async connect(address: string): Promise<BluetoothDevice> {
    this.#check(`connect ${address}`);
    this.#powered(BLUETOOTH_PATHS.connect);
    const device = this.#paired(address, BLUETOOTH_PATHS.connect);
    device.connected = true;
    return { ...device };
  }

  async disconnect(address: string): Promise<BluetoothDevice> {
    this.#check(`disconnect ${address}`);
    this.#powered(BLUETOOTH_PATHS.disconnect);
    const device = this.#paired(address, BLUETOOTH_PATHS.disconnect);
    device.connected = false;
    return { ...device };
  }

  async forget(address: string): Promise<void> {
    this.#check(`forget ${address}`);
    this.#paired(address, BLUETOOTH_PATHS.forget);
    this.paired.splice(
      this.paired.findIndex((d) => d.address === address),
      1,
    );
  }

  #check(call: string): void {
    this.calls.push(call);
    if (this.down) throw refused(call.split(' ')[0] ?? call, 503, 'unavailable');
  }

  #powered(path: string): void {
    if (this.missing) throw refused(path, 409, 'no_bluetooth');
  }

  /** The devices found so far while looking: named, not paired, no phones or computers, strongest first. */
  #found(now: number): (FakeBluetoothDevice & { kind: BluetoothKind })[] {
    if (this.#scanFrom === null || now >= this.#scanUntil) return [];
    const since = now - this.#scanFrom;
    return this.nearby
      .filter(listed)
      .filter((d) => (d.foundAfterMs ?? 0) <= since && !this.paired.some((p) => p.address === d.address))
      .sort((a, b) => b.signal - a.signal || a.name.localeCompare(b.name));
  }

  #scan(now: number): BluetoothScan | null {
    if (this.#scanFrom === null || now >= this.#scanUntil) return null;
    return {
      until: new Date(this.#scanUntil).toISOString(),
      devices: this.#found(now).map((d) => ({
        address: d.address,
        name: d.name,
        kind: d.kind,
        connected: false,
        signal: d.signal,
      })),
    };
  }

  #paired(address: string, path: string): BluetoothDevice {
    const device = this.paired.find((d) => d.address === address);
    if (device) return device;
    if (this.#found(this.now()).some((d) => d.address === address)) throw refused(path, 409, 'not_paired');
    throw refused(path, 404, 'not_found');
  }

  #current(pairingId: string, path: string, now: number): Running {
    this.#advance(now);
    const run = this.#running;
    if (!run || run.pairing.id !== pairingId) throw refused(path, 404, 'not_found');
    return run;
  }

  #end(run: Running, at: number, failure?: BluetoothPairingFailure): void {
    run.endedAt = at;
    const { code: _code, typed: _typed, ...rest } = run.pairing;
    run.pairing = failure ? { ...rest, phase: 'failed', failure } : { ...rest, phase: 'done' };
  }

  /** Moves the running pairing on to `now`, and lets an ended one go after 60 s. */
  #advance(now: number): void {
    const run = this.#running;
    if (!run) return;
    if (run.endedAt !== null) {
      if (now - run.endedAt >= BLUETOOTH_RESULT_KEEP_S * 1000) this.#running = null;
      return;
    }
    const step = this.timings.stepMs;
    const deadline = Date.parse(run.pairing.deadline);
    const p = run.pairing;
    const kind = run.device.pairing;
    const at = (n: number) => run.startedAt + n * step;
    if (kind === 'reject' && now >= at(1)) {
      this.#end(run, at(1), 'rejected');
      return;
    }
    if ((kind === 'code' || kind === 'confirm') && run.askedAt === null && now >= at(1)) {
      run.askedAt = at(1);
      run.pairing = {
        ...p,
        phase: kind,
        code: FAKE_PASSKEY,
        ...(kind === 'code' ? { typed: 0 } : {}),
      };
    }
    // A keyboard types a digit a step, then Enter: connecting a step after the sixth.
    let connectingAt: number | null = kind === 'just_works' ? at(1) : null;
    if (kind === 'code' && run.askedAt !== null) {
      const typed = Math.min(6, Math.floor((now - run.askedAt) / step));
      if (run.pairing.phase === 'code') run.pairing = { ...run.pairing, typed };
      connectingAt = run.askedAt + 7 * step;
    }
    if (kind === 'confirm' && run.confirmedAt !== null) connectingAt = run.confirmedAt;
    if (connectingAt !== null && now >= connectingAt && connectingAt < deadline) {
      if (now >= connectingAt + step) {
        this.#end(run, connectingAt + step);
        this.paired.push({
          address: run.device.address,
          name: run.device.name,
          kind: run.pairing.kind,
          connected: true,
          ...(run.device.battery !== undefined ? { battery: run.device.battery } : {}),
        });
        return;
      }
      const { code: _code, typed: _typed, ...rest } = run.pairing;
      run.pairing = { ...rest, phase: 'connecting' };
      return;
    }
    if (now >= deadline) this.#end(run, deadline, 'timeout');
  }
}

function refused(path: string, status: number, code: string): BluetoothCallError {
  return new BluetoothCallError(path, status, code, `bluetooth ${path}: ${status} ${code}`);
}
