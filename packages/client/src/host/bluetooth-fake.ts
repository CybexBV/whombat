/**
 * Bluetooth without a box (Whombat bluetooth.md BT-01…BT-07; app bluetooth-web.md AP-3717): the adapter, the paired
 * devices, what a scan finds and the pairings, as the runtime answers `host.bluetooth*`, in memory, for the web's
 * fixture mode and managed fake world, the phone's demo world and tests. The same devices as the server's fake:
 *
 * - paired: “Keychron K3” (keyboard, connected, battery 80 %) and “WH-1000XM5” (headphones, not connected);
 * - found while looking (one after another, strongest first): “MX Master 3S” (mouse, pairs without a code), “Magic
 *   Keyboard” (keyboard: a code, its digits typed one by one, then ready), “JBL Flip 6” (speaker, no code), “Pebble
 *   Keys 2” (keyboard with a screen: “Does … show …?”) and “Xbox Wireless Controller” (refuses the pairing); a “Pixel 9”
 *   phone is nearby too but never listed (BT-01).
 *
 * Machines as the hardware fake's (`FakeMachine`): `z13` has the adapter, `vm` none (BLUETOOTH isn't shown) and
 * `nodriver` has it switched off. Phases run on an injectable clock, pure in time like the network's, so a reload in
 * between changes nothing.
 */
import { OperationError } from '../session/managed-ops';
import type { BluetoothApi } from './bluetooth';
import {
  BLUETOOTH_ERROR_STATUS,
  BLUETOOTH_PAIRING_S,
  BLUETOOTH_RESULT_KEEP_S,
  BLUETOOTH_SCAN_S,
  type BluetoothDevice,
  type BluetoothErrorCode,
  type BluetoothKind,
  type BluetoothPairing,
  type BluetoothPairingFailure,
  type BluetoothScan,
  type BluetoothSignal,
  type BluetoothState,
} from './contract';
import type { FakeMachine } from './fake';

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** How a device nearby pairs: without a code, with a code to type, with a number to confirm, or not at all. */
type Pairs = 'plain' | 'code' | 'confirm' | 'rejected';

/** A device near the fixture machines: what a scan shows, and what the fake knows about it. */
interface Nearby {
  address: string;
  name: string;
  /** `phone` never crosses the wire (BT-01). */
  kind: BluetoothKind | 'phone';
  signal: BluetoothSignal;
  pairs: Pairs;
  /** When a scan finds it (ms after looking started). */
  foundAfterMs: number;
  /** Paired and connected: its battery. */
  battery?: number;
}

/** The devices around the fixture machines (the paired two included: after Remove they can be found again). */
export const FAKE_BLUETOOTH_NEARBY: readonly Nearby[] = [
  {
    address: 'DC:2C:26:4B:1A:07',
    name: 'Keychron K3',
    kind: 'keyboard',
    signal: 4,
    pairs: 'plain',
    foundAfterMs: 400,
    battery: 80,
  },
  {
    address: '14:3F:A6:88:2E:51',
    name: 'WH-1000XM5',
    kind: 'headphones',
    signal: 3,
    pairs: 'plain',
    foundAfterMs: 900,
    battery: 60,
  },
  {
    address: 'E4:C2:0A:3D:71:9B',
    name: 'MX Master 3S',
    kind: 'mouse',
    signal: 4,
    pairs: 'plain',
    foundAfterMs: 600,
    battery: 95,
  },
  {
    address: '28:6A:B8:F0:13:C4',
    name: 'Magic Keyboard',
    kind: 'keyboard',
    signal: 3,
    pairs: 'code',
    foundAfterMs: 1_200,
    battery: 70,
  },
  {
    address: 'B8:F6:53:0E:94:2D',
    name: 'JBL Flip 6',
    kind: 'speaker',
    signal: 2,
    pairs: 'plain',
    foundAfterMs: 1_800,
  },
  {
    address: 'F2:41:7C:D9:06:E8',
    name: 'Pebble Keys 2',
    kind: 'keyboard',
    signal: 2,
    pairs: 'confirm',
    foundAfterMs: 2_400,
  },
  {
    address: '98:7B:F3:52:C1:0A',
    name: 'Xbox Wireless Controller',
    kind: 'gamepad',
    signal: 1,
    pairs: 'rejected',
    foundAfterMs: 3_000,
  },
  {
    address: '5C:17:CF:A2:48:B3',
    name: 'Pixel 9',
    kind: 'phone',
    signal: 4,
    pairs: 'plain',
    foundAfterMs: 300,
  },
];

/** The code a device that needs one gets (the box makes it; fixed here so journeys and shots see the same digits). */
export const FAKE_BLUETOOTH_CODE = '482913';

/** What survives a reload: the paired devices (the box keeps them, BT-08). */
export interface FakeBluetoothSnapshot {
  machine: FakeMachine;
  devices: BluetoothDevice[];
}

export interface FakeBluetoothOptions {
  machine?: FakeMachine;
  now?: () => number;
  initial?: FakeBluetoothSnapshot | null;
  /** How long pairing takes before a code, a question or the end (ms). */
  pairMs?: number;
  /** How long between two digits typed on a keyboard (ms). */
  typeMs?: number;
  /** How long connecting takes after the pairing (ms). */
  connectMs?: number;
  /** When looking finds every device (ms after it started); without it, one after another (`foundAfterMs`). */
  findAfterMs?: number;
}

export interface FakeBluetooth {
  /** One `host.bluetooth*` op as the runtime answers it. */
  call(op: string, input: unknown): { status: number; body: unknown };
  snapshot(): FakeBluetoothSnapshot;
  onChange(listener: () => void): () => void;
}

/** The machine's Bluetooth as it starts: the two paired devices where there is an adapter. */
export function fakeBluetoothSeed(machine: FakeMachine): FakeBluetoothSnapshot {
  if (machine === 'vm') return { machine, devices: [] };
  const paired = (address: string, connected: boolean): BluetoothDevice => {
    const n = FAKE_BLUETOOTH_NEARBY.find((d) => d.address === address) as Nearby;
    return {
      address,
      name: n.name,
      kind: n.kind as BluetoothKind,
      connected,
      ...(connected && n.battery !== undefined ? { battery: n.battery } : {}),
    };
  };
  return {
    machine,
    devices: [paired('DC:2C:26:4B:1A:07', machine === 'z13'), paired('14:3F:A6:88:2E:51', false)],
  };
}

const ok = (body: unknown) => ({ status: 200, body });
const accepted = (body: unknown) => ({ status: 202, body });
const err = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  body: { error: { code, message, ...(details ? { details } : {}) } },
});
const STATUS: Record<string, number> = { not_allowed: 403, conflict: 409, not_found: 404, unavailable: 503 };
/** A Bluetooth refusal as the runtime sends it: the generic code and its status, Bluetooth's code in `details`. */
const refuse = (code: BluetoothErrorCode, message: string) => {
  const generic = BLUETOOTH_ERROR_STATUS[code];
  return err(STATUS[generic] ?? 400, generic, message, { code });
};

/** A pairing and where it goes (the fake's own plan, unknown to the app). */
interface Running {
  pairing: BluetoothPairing;
  startedAt: number;
  device: Nearby;
  /** The answer to the question (phase `confirm`), and when it came. */
  answer: { accept: boolean; at: number } | null;
  /** Cancelled at. */
  canceledAt: number | null;
  /** When it ended (kept `BLUETOOTH_RESULT_KEEP_S` after). */
  endedAt: number | null;
}

export function createFakeBluetooth(options: FakeBluetoothOptions = {}): FakeBluetooth {
  const now = options.now ?? Date.now;
  const pairMs = options.pairMs ?? 1_500;
  const typeMs = options.typeMs ?? 700;
  const connectMs = options.connectMs ?? 1_000;
  const foundAfter = (n: Nearby) => options.findAfterMs ?? n.foundAfterMs;
  let snap: FakeBluetoothSnapshot = options.initial ?? fakeBluetoothSeed(options.machine ?? 'z13');
  let scanStarted: number | null = null;
  let scanUntil: number | null = null;
  let running: Running | null = null;
  let pairings = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  const adapter = () =>
    snap.machine === 'vm' ? null : { name: 'Burrow HQ', powered: snap.machine === 'z13' };
  const usable = () => adapter()?.powered === true;
  const nearby = (address: string) => FAKE_BLUETOOTH_NEARBY.find((d) => d.address === address);
  const isPaired = (address: string) => snap.devices.some((d) => d.address === address);
  const asDevice = (n: Nearby, connected: boolean): BluetoothDevice => ({
    address: n.address,
    name: n.name,
    kind: n.kind as BluetoothKind,
    connected,
    ...(connected && n.battery !== undefined ? { battery: n.battery } : {}),
  });

  /** Moves the pairing along by the clock. */
  function advance() {
    const r = running;
    if (!r) return;
    const t = now();
    const elapsed = t - r.startedAt;
    const deadline = r.startedAt + BLUETOOTH_PAIRING_S * 1000;
    const before = r.pairing;
    const end = (phase: 'done' | 'failed', failure?: BluetoothPairingFailure) => {
      if (r.endedAt === null) r.endedAt = t;
      const { code: _c, typed: _t, ...rest } = r.pairing;
      r.pairing = { ...rest, phase, ...(failure ? { failure } : {}) };
    };
    if (r.pairing.phase === 'done' || r.pairing.phase === 'failed') {
      // Kept for a minute after it ended, then gone.
      if (r.endedAt !== null && t - r.endedAt > BLUETOOTH_RESULT_KEEP_S * 1000) running = null;
    } else if (r.canceledAt !== null) end('failed', 'canceled');
    else if (elapsed < pairMs) r.pairing = { ...r.pairing, phase: 'pairing' };
    else if (r.device.pairs === 'rejected') end('failed', 'rejected');
    else {
      // How long the device's own step took: a code typed digit by digit, an answer, or nothing.
      let step = 0;
      let waiting = false;
      if (r.device.pairs === 'code') {
        step = typeMs * (FAKE_BLUETOOTH_CODE.length + 1);
        if (elapsed < pairMs + step) {
          const typed = Math.min(FAKE_BLUETOOTH_CODE.length, Math.floor((elapsed - pairMs) / typeMs));
          r.pairing = { ...r.pairing, phase: 'code', code: FAKE_BLUETOOTH_CODE, typed };
          waiting = true;
        }
      } else if (r.device.pairs === 'confirm') {
        if (!r.answer) {
          if (t >= deadline) end('failed', 'timeout');
          else r.pairing = { ...r.pairing, phase: 'confirm', code: FAKE_BLUETOOTH_CODE };
          waiting = true;
        } else if (!r.answer.accept) {
          end('failed', 'canceled');
          waiting = true;
        } else step = r.answer.at - r.startedAt - pairMs;
      }
      if (!waiting) {
        const { code: _c, typed: _t, ...rest } = r.pairing;
        if (elapsed < pairMs + step + connectMs) r.pairing = { ...rest, phase: 'connecting' };
        else {
          end('done');
          if (!isPaired(r.device.address))
            snap = { ...snap, devices: [...snap.devices, asDevice(r.device, true)] };
        }
      }
    }
    if (running && before !== r.pairing && JSON.stringify(before) !== JSON.stringify(r.pairing)) changed();
  }

  function scan(): BluetoothScan | null {
    if (scanStarted === null || scanUntil === null) return null;
    const t = now();
    if (t >= scanUntil) {
      scanStarted = null;
      scanUntil = null;
      return null;
    }
    const devices = FAKE_BLUETOOTH_NEARBY.filter(
      (n) => n.kind !== 'phone' && !isPaired(n.address) && t - (scanStarted as number) >= foundAfter(n),
    )
      .map((n) => ({ ...asDevice(n, false), signal: n.signal }))
      .sort((a, b) => b.signal - a.signal);
    return { until: iso(scanUntil), devices };
  }

  function state(): BluetoothState {
    advance();
    const a = adapter();
    const devices = [...snap.devices].sort(
      (x, y) => Number(y.connected) - Number(x.connected) || x.name.localeCompare(y.name),
    );
    return {
      adapter: a,
      ...(a === null
        ? { missing: 'no_adapter' as const }
        : a.powered
          ? {}
          : { missing: 'disabled' as const }),
      devices: a ? devices : [],
      scan: scan(),
      pairing: running?.pairing ?? null,
    };
  }

  const pairingRuns = () => {
    advance();
    return running !== null && running.pairing.phase !== 'done' && running.pairing.phase !== 'failed';
  };
  const current = (id: string) => (running?.pairing.id === id ? running : null);

  const setConnected = (address: string, connected: boolean): BluetoothDevice | null => {
    const known = snap.devices.find((d) => d.address === address);
    const n = nearby(address);
    if (!known || !n) return null;
    const next = asDevice(n, connected);
    snap = { ...snap, devices: snap.devices.map((d) => (d.address === address ? next : d)) };
    changed();
    return next;
  };

  return {
    call(op, raw) {
      const input = (raw ?? {}) as { address?: string; pairingId?: string; accept?: boolean };
      if (op === 'host.bluetooth') return ok({ bluetooth: state() });
      if (!usable()) {
        if (op === 'host.bluetooth.scan') return ok({ scan: null, reason: 'no_bluetooth' });
        return refuse('no_bluetooth', 'This Whombat has no Bluetooth it can use.');
      }
      const address = String(input.address ?? '');
      switch (op) {
        case 'host.bluetooth.scan': {
          // No looking while a pairing runs (it would slow the pairing down, BT-07).
          if (pairingRuns()) return refuse('busy', 'A pairing is running.');
          const t = now();
          if (scanStarted === null || scanUntil === null || t >= scanUntil) scanStarted = t;
          scanUntil = t + BLUETOOTH_SCAN_S * 1000;
          changed();
          return ok({ scan: scan() });
        }
        case 'host.bluetooth.pair': {
          if (pairingRuns()) return refuse('busy', 'A pairing is running.');
          const found = scan()?.devices.some((d) => d.address === address) ?? false;
          const n = nearby(address);
          if (!n || n.kind === 'phone' || (!found && !isPaired(address)))
            return refuse('not_found', 'Not found.');
          // Pairing stops the looking (BT-07).
          scanStarted = null;
          scanUntil = null;
          pairings += 1;
          const t = now();
          running = {
            pairing: {
              id: `p-${String(pairings).padStart(8, '0')}`,
              address,
              name: n.name,
              kind: n.kind as BluetoothKind,
              phase: 'pairing',
              deadline: iso(t + BLUETOOTH_PAIRING_S * 1000),
            },
            startedAt: t,
            device: n,
            answer: null,
            canceledAt: null,
            endedAt: null,
          };
          changed();
          return accepted({ pairing: running.pairing });
        }
        case 'host.bluetooth.confirm': {
          advance();
          const r = current(String(input.pairingId ?? ''));
          if (!r) return refuse('not_found', 'Not the current pairing.');
          if (r.pairing.phase === 'confirm') r.answer = { accept: input.accept === true, at: now() };
          advance();
          changed();
          return ok({ pairing: r.pairing });
        }
        case 'host.bluetooth.cancel': {
          advance();
          const r = current(String(input.pairingId ?? ''));
          if (!r) return refuse('not_found', 'Not the current pairing.');
          if (r.pairing.phase !== 'done' && r.pairing.phase !== 'failed') r.canceledAt = now();
          advance();
          changed();
          return ok({ pairing: r.pairing });
        }
        case 'host.bluetooth.connect':
        case 'host.bluetooth.disconnect': {
          const device = setConnected(address, op === 'host.bluetooth.connect');
          return device ? ok({ device }) : refuse('not_found', 'Not paired.');
        }
        case 'host.bluetooth.forget': {
          if (!isPaired(address)) return refuse('not_found', 'Not paired.');
          snap = { ...snap, devices: snap.devices.filter((d) => d.address !== address) };
          changed();
          return ok({ ok: true });
        }
        default:
          return err(404, 'unknown_op', `No operation ${op}`);
      }
    },
    snapshot: () => ({ ...snap, devices: [...snap.devices] }),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A fake Bluetooth as the app's `BluetoothApi` (refusals thrown as the session would). */
export function fakeBluetoothApi(fake: FakeBluetooth): BluetoothApi {
  const answer = async <T>(op: string, input: unknown): Promise<T> => {
    const r = fake.call(op, input);
    if (r.status >= 200 && r.status < 300) return r.body as T;
    const e = (r.body as { error: { code: string; message: string; details?: unknown } }).error;
    throw new OperationError(op, r.status, e.code, e.message, e.details);
  };
  type P = { pairing: BluetoothPairing };
  type D = { device: BluetoothDevice };
  return {
    state: () => answer('host.bluetooth', {}),
    scan: () => answer('host.bluetooth.scan', {}),
    pair: async (address) => (await answer<P>('host.bluetooth.pair', { address })).pairing,
    confirm: async (pairingId, accept) =>
      (await answer<P>('host.bluetooth.confirm', { pairingId, accept })).pairing,
    cancel: async (pairingId) => (await answer<P>('host.bluetooth.cancel', { pairingId })).pairing,
    connect: async (address) => (await answer<D>('host.bluetooth.connect', { address })).device,
    disconnect: async (address) => (await answer<D>('host.bluetooth.disconnect', { address })).device,
    forget: async (address) => {
      await answer('host.bluetooth.forget', { address });
    },
  };
}
