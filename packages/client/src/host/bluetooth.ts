/**
 * The box's Bluetooth in Settings (Whombat bluetooth.md BT-01…BT-11; app bluetooth-web.md AP-3700…AP-3716): what This
 * Whombat → Overview → BLUETOOTH shows — the paired devices (“Connected · Battery 80 %”, “Not connected”) with Connect,
 * Disconnect and Remove, why there is no Bluetooth, a pairing that runs — the Add a device dialog's list and its
 * pairing in words (the code with the digits typed so far, the Yes/No question, ready, the failures), the refusals'
 * words, and `createBluetoothPoller`, which asks `host.bluetooth` every second while the box looks or pairs. Shared by
 * the web and the phone. Pure, apart from the poller's timers (injectable) and `bluetoothApi`'s session.
 */

import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import {
  BLUETOOTH_ERRORS,
  BLUETOOTH_POLL_MS,
  type BluetoothDevice,
  type BluetoothErrorCode,
  type BluetoothKind,
  type BluetoothMissing,
  type BluetoothPairing,
  type BluetoothPairingFailure,
  type BluetoothPairingPhase,
  type BluetoothScan,
  type BluetoothSignal,
  type BluetoothState,
  bluetoothPairingDone,
  type HostBluetoothOutput,
  type HostBluetoothScanOutput,
} from './contract';

type Dot = 'ok' | 'warn' | 'bad' | 'mut';

/** The Bluetooth refusals (`BLUETOOTH_ERRORS`, in `error.details.code`) and a plain refusal. */
export type BluetoothRefusal = BluetoothErrorCode | 'forbidden';

/* The ops --------------------------------------------------------------------------------------------------------- */

/** Bluetooth's session ops as one object: the managed session's, or a fixture world's (`createFakeBluetooth`). */
export interface BluetoothApi {
  state(): Promise<HostBluetoothOutput>;
  /** Starts looking, or keeps looking `BLUETOOTH_SCAN_S` more. */
  scan(): Promise<HostBluetoothScanOutput>;
  /** Stops looking and pairs in the background: follow it with `state` (the poller). */
  pair(address: string): Promise<BluetoothPairing>;
  /** The answer to “Does {name} show {code}?”. */
  confirm(pairingId: string, accept: boolean): Promise<BluetoothPairing>;
  cancel(pairingId: string): Promise<BluetoothPairing>;
  connect(address: string): Promise<BluetoothDevice>;
  disconnect(address: string): Promise<BluetoothDevice>;
  forget(address: string): Promise<void>;
}

/** Bluetooth over this session. */
export function bluetoothApi(session: ApplianceSession): BluetoothApi {
  return {
    state: () => sessionOps.hostBluetooth(session),
    scan: () => sessionOps.hostBluetoothScan(session),
    pair: async (address) => (await sessionOps.hostBluetoothPair(session, address)).pairing,
    confirm: async (pairingId, accept) =>
      (await sessionOps.hostBluetoothConfirm(session, { pairingId, accept })).pairing,
    cancel: async (pairingId) => (await sessionOps.hostBluetoothCancel(session, pairingId)).pairing,
    connect: async (address) => (await sessionOps.hostBluetoothConnect(session, address)).device,
    disconnect: async (address) => (await sessionOps.hostBluetoothDisconnect(session, address)).device,
    forget: async (address) => {
      await sessionOps.hostBluetoothForget(session, address);
    },
  };
}

/* Words ----------------------------------------------------------------------------------------------------------- */

/** Every word of BLUETOOTH and its dialogs (BT-11's where it has them). `name` is a device's name. */
export const BLUETOOTH_TEXT = {
  section: 'BLUETOOTH',
  kinds: {
    keyboard: 'Keyboard',
    mouse: 'Mouse',
    headphones: 'Headphones',
    headset: 'Headset',
    speaker: 'Speaker',
    gamepad: 'Game controller',
    other: 'Device',
  } as Record<BluetoothKind, string>,
  connected: 'Connected',
  notConnected: 'Not connected',
  battery: (pct: number) => `Battery ${pct} %`,
  connecting: 'Connecting…',
  disconnecting: 'Disconnecting…',
  connect: 'Connect',
  disconnect: 'Disconnect',
  remove: 'Remove',
  add: 'Add a device',
  /** Nothing paired yet: the row Add a device sits on. */
  none: 'No devices yet',
  noneMeta: 'Keyboards, mice, speakers and headphones work with this Whombat.',
  /** The ⋯ button's name. */
  actions: (name: string) => `Actions for ${name}`,
  unavailable: 'Bluetooth couldn’t be read right now.',
  tryAgain: 'Try again',
  missing: {
    no_driver: 'This Bluetooth adapter has no driver yet.',
    disabled: 'Bluetooth is switched off.',
  } as Record<Exclude<BluetoothMissing, 'no_adapter'>, string>,
  /** The adapter is in the hardware report (About → HARDWARE). */
  seeHardware: 'See hardware',
  /** Connect answered, but the device didn't come. */
  didNotConnect: (name: string) => `${name} didn’t connect. Check that it’s switched on and nearby.`,
  removeDialog: {
    title: (name: string) => `Remove ${name}?`,
    lead: 'You’ll need to pair it again to use it.',
    submit: 'Remove',
    busy: 'Removing…',
    cancel: 'Cancel',
  },
  dialog: {
    title: 'Add a device',
    hint: 'Put your device in pairing mode. Keyboards and mice often have a button for it; speakers and headphones usually need the power button held.',
    looking: 'Looking for devices…',
    nearby: 'Devices nearby',
    none: 'No devices nearby.',
    again: 'Look again',
    couldNotLook: 'Couldn’t look for devices. Try again.',
    pairing: (name: string) => `Pairing with ${name}…`,
    code: (code: string, name: string) => `Type ${code} on ${name}, then press Enter.`,
    confirm: (name: string, code: string) => `Does ${name} show ${code}?`,
    yes: 'Yes',
    no: 'No',
    ready: (name: string) => `${name} is ready.`,
    tryAgain: 'Try again',
    cancel: 'Cancel',
    close: 'Close',
    done: 'Done',
  },
  failures: {
    rejected: (name: string) => `${name} didn’t accept the pairing. Put it in pairing mode and try again.`,
    timeout: (name: string) => `${name} didn’t answer in time. Put it in pairing mode and try again.`,
    not_found: (name: string) => `${name} isn’t nearby any more.`,
    canceled: (name: string) => `Pairing with ${name} stopped. Try again.`,
    failed: (name: string) => `Pairing with ${name} didn’t work. Try again.`,
  } as Record<BluetoothPairingFailure, (name: string) => string>,
  errors: {
    no_bluetooth: () => 'Bluetooth is switched off.',
    busy: () => 'Another device is pairing. Try again in a moment.',
    not_found: (name: string) => `${name} isn’t nearby any more.`,
    not_paired: (name: string) => `${name} isn’t paired any more.`,
    unavailable: () => 'Bluetooth isn’t answering right now. Try again.',
    forbidden: () => 'Bluetooth can’t be changed from here.',
  } as Record<BluetoothRefusal, (name: string) => string>,
  failed: 'That didn’t work. Try again.',
  signal: (signal: BluetoothSignal) =>
    signal >= 4 ? 'Strong signal' : signal >= 2 ? 'Good signal' : 'Weak signal',
} as const;

const T = BLUETOOTH_TEXT;

/**
 * Each kind's icon by its Lucide name, the same on the web (`lucide-react`) and the phone (`lucide-react-native`):
 * `other` is the Bluetooth mark.
 */
export const BLUETOOTH_KIND_ICONS = {
  keyboard: 'keyboard',
  mouse: 'mouse',
  headphones: 'headphones',
  headset: 'headset',
  speaker: 'speaker',
  gamepad: 'gamepad-2',
  other: 'bluetooth',
} as const satisfies Record<BluetoothKind, string>;
export type BluetoothIcon = (typeof BLUETOOTH_KIND_ICONS)[BluetoothKind];

/** “Keyboard”, “Game controller”, “Device”. */
export function bluetoothKindText(kind: BluetoothKind): string {
  return T.kinds[kind] ?? T.kinds.other;
}

/** “Connected · Battery 80 %”, “Connected”, “Not connected” (a battery only while connected: it is read then). */
export function bluetoothDeviceMeta(device: Pick<BluetoothDevice, 'connected' | 'battery'>): string {
  if (!device.connected) return T.notConnected;
  return device.battery === undefined ? T.connected : `${T.connected} · ${T.battery(device.battery)}`;
}

/* The section ----------------------------------------------------------------------------------------------------- */

/** A paired device's row. */
export interface BluetoothDeviceRow {
  address: string;
  name: string;
  kind: BluetoothKind;
  kindText: string;
  icon: BluetoothIcon;
  connected: boolean;
  /** “Connected · Battery 80 %”, “Not connected”. */
  meta: string;
  /** What a screen reader hears: “Keychron K3, keyboard, connected, battery 80 %”. */
  label: string;
  /** The menu's first item: Connect when it isn't connected, Disconnect when it is (Remove always follows). */
  toggle: 'connect' | 'disconnect';
}

/** A pairing in words: what runs, the code to type or confirm, or how it ended. */
export interface BluetoothPairingView {
  id: string;
  address: string;
  name: string;
  kind: BluetoothKind;
  phase: BluetoothPairingPhase;
  /** “Pairing with MX Master 3S…”, “Type 482913 on Magic Keyboard, then press Enter.”, “Does … show 482913?”, … */
  text: string;
  /** The code's digits, the ones typed so far marked (phase `code`; all unmarked in `confirm`); null without a code. */
  digits: { digit: string; typed: boolean }[] | null;
  /** “Does {name} show {code}?”: Yes or No. */
  asks: boolean;
  running: boolean;
  failure: BluetoothPairingFailure | null;
  dot: Dot;
}

export interface BluetoothSectionView {
  /** Why the box can't use Bluetooth (no driver, switched off); the hardware report shows the adapter. */
  missing: { text: string; dot: Dot } | null;
  devices: BluetoothDeviceRow[];
  /** A pairing that runs (started here or at the box's screen). */
  pairing: BluetoothPairingView | null;
  /** The adapter works and no pairing runs. */
  canAdd: boolean;
  /** The adapter works: Connect, Disconnect and Remove may be asked. */
  canChange: boolean;
}

/** Why there is no Bluetooth, if there is none: no adapter, its driver, or it is off. */
export function bluetoothMissing(
  state: Pick<BluetoothState, 'adapter' | 'missing'>,
): BluetoothMissing | null {
  if (state.adapter === null) return state.missing ?? 'no_adapter';
  if (!state.adapter.powered) return state.missing === 'no_driver' ? 'no_driver' : 'disabled';
  return null;
}

/** Whether BLUETOOTH shows at all: not on a machine without an adapter (a VM, a PC without the radio; AP-3703). */
export function bluetoothShown(state: Pick<BluetoothState, 'adapter' | 'missing'>): boolean {
  return bluetoothMissing(state) !== 'no_adapter';
}

/** Whether a pairing still runs (the app asks again every second while it does). */
export function bluetoothPairingRunning(
  pairing: { phase: BluetoothPairingPhase } | null | undefined,
): boolean {
  return pairing ? !bluetoothPairingDone(pairing.phase) : false;
}

/** Whether the box still looks (its `until` is ahead). */
export function bluetoothScanRunning(
  scan: Pick<BluetoothScan, 'until'> | null | undefined,
  now: number = Date.now(),
): boolean {
  return scan ? Date.parse(scan.until) > now : false;
}

/** Paired devices as BLUETOOTH lists them: connected first, then by name (§2.1's order, kept whatever arrives). */
export function bluetoothDeviceRows(devices: readonly BluetoothDevice[]): BluetoothDeviceRow[] {
  return [...devices]
    .sort((a, b) => Number(b.connected) - Number(a.connected) || byName(a.name, b.name))
    .map((d) => {
      const meta = bluetoothDeviceMeta(d);
      return {
        address: d.address,
        name: d.name,
        kind: d.kind,
        kindText: bluetoothKindText(d.kind),
        icon: BLUETOOTH_KIND_ICONS[d.kind] ?? BLUETOOTH_KIND_ICONS.other,
        connected: d.connected,
        meta,
        label: [
          d.name,
          ...[bluetoothKindText(d.kind), ...meta.split(' · ')].map((s) => s.toLowerCase()),
        ].join(', '),
        toggle: d.connected ? 'disconnect' : 'connect',
      };
    });
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/**
 * What BLUETOOTH shows (AP-3702…AP-3705): why there is no Bluetooth (no driver, switched off), the paired devices in
 * their order, a pairing that runs, and whether Add a device and the device menus may be used.
 */
export function bluetoothSectionView(state: BluetoothState): BluetoothSectionView {
  const missing = bluetoothMissing(state);
  const usable = missing === null;
  const running = bluetoothPairingRunning(state.pairing);
  return {
    missing:
      missing === null || missing === 'no_adapter'
        ? null
        : { text: T.missing[missing], dot: missing === 'no_driver' ? 'bad' : 'warn' },
    devices: bluetoothDeviceRows(state.devices),
    pairing: running && state.pairing ? bluetoothPairingView(state.pairing) : null,
    canAdd: usable && !running,
    canChange: usable,
  };
}

/* The Add a device dialog ----------------------------------------------------------------------------------------- */

/** A device the box found. */
export interface BluetoothFoundRow {
  address: string;
  name: string;
  kind: BluetoothKind;
  kindText: string;
  icon: BluetoothIcon;
  signal: BluetoothSignal | null;
  /** What a screen reader hears: “MX Master 3S, mouse, strong signal”. */
  label: string;
}

/**
 * The dialog's list: strongest first (devices that don't say last), each address once, none that is paired already.
 */
export function bluetoothFoundRows(
  scan: Pick<BluetoothScan, 'devices'>,
  paired: readonly Pick<BluetoothDevice, 'address'>[] = [],
): BluetoothFoundRow[] {
  const skip = new Set(paired.map((d) => d.address));
  const rows: BluetoothFoundRow[] = [];
  const signalOf = (d: BluetoothDevice) => (d.signal ?? -1) as number;
  for (const d of [...scan.devices].sort((a, b) => signalOf(b) - signalOf(a))) {
    if (skip.has(d.address)) continue;
    skip.add(d.address);
    const signal = (d.signal ?? null) as BluetoothSignal | null;
    rows.push({
      address: d.address,
      name: d.name,
      kind: d.kind,
      kindText: bluetoothKindText(d.kind),
      icon: BLUETOOTH_KIND_ICONS[d.kind] ?? BLUETOOTH_KIND_ICONS.other,
      signal,
      label: [
        d.name,
        bluetoothKindText(d.kind).toLowerCase(),
        signal === null ? null : T.signal(signal).toLowerCase(),
      ]
        .filter(Boolean)
        .join(', '),
    });
  }
  return rows;
}

/** A pairing failure in words (BT-11). */
export function bluetoothFailureText(failure: BluetoothPairingFailure | undefined, name: string): string {
  return (T.failures[failure ?? 'failed'] ?? T.failures.failed)(name);
}

/**
 * A pairing in words (BT-04, BT-11): “Pairing with {name}…” while it pairs and connects, the code to type with the
 * digits typed so far, “Does {name} show {code}?”, “{name} is ready.”, or the failure's sentence.
 */
export function bluetoothPairingView(pairing: BluetoothPairing): BluetoothPairingView {
  const { name, code } = pairing;
  const base = {
    id: pairing.id,
    address: pairing.address,
    name,
    kind: pairing.kind,
    phase: pairing.phase,
    running: bluetoothPairingRunning(pairing),
    failure: null,
    digits: null,
    asks: false,
  };
  const digits = (typed: number) => [...(code ?? '')].map((digit, i) => ({ digit, typed: i < typed }));
  switch (pairing.phase) {
    case 'code':
      return code
        ? { ...base, text: T.dialog.code(code, name), digits: digits(pairing.typed ?? 0), dot: 'mut' }
        : { ...base, text: T.dialog.pairing(name), dot: 'mut' };
    case 'confirm':
      return code
        ? { ...base, text: T.dialog.confirm(name, code), digits: digits(0), asks: true, dot: 'mut' }
        : { ...base, text: T.dialog.pairing(name), dot: 'mut' };
    case 'done':
      return { ...base, text: T.dialog.ready(name), dot: 'ok' };
    case 'failed':
      return {
        ...base,
        text: bluetoothFailureText(pairing.failure, name),
        failure: pairing.failure ?? 'failed',
        dot: 'bad',
      };
    default:
      // `pairing` and `connecting`: one line for the person (the difference is the box's).
      return { ...base, text: T.dialog.pairing(name), dot: 'mut' };
  }
}

/** The refusal's code: Bluetooth's code in `details` before the error's own (as the Wi-Fi's, AP-3211). */
export function bluetoothErrorCode(error: unknown): BluetoothRefusal | null {
  if (!(error instanceof OperationError)) return null;
  const detail = (error.details as { code?: unknown } | undefined)?.code;
  const known = (c: unknown): c is BluetoothRefusal =>
    typeof c === 'string' && (c === 'forbidden' || (BLUETOOTH_ERRORS as readonly string[]).includes(c));
  return known(detail) ? detail : known(error.code) ? error.code : null;
}

/**
 * A `host.bluetooth.*` refusal in words. `name` is the device's; `paired` for Connect, Disconnect and Remove, whose
 * `not_found` means the device was removed meanwhile (not that it went away).
 */
export function bluetoothErrorText(error: unknown, name: string, { paired = false } = {}): string {
  const code = bluetoothErrorCode(error);
  if (!code) return T.failed;
  return T.errors[paired && code === 'not_found' ? 'not_paired' : code](name);
}

/* Following the box ----------------------------------------------------------------------------------------------- */

/** A scan or pairing past its time by this much is no longer followed (the box should have said it ended). */
const OVERDUE_MS = 5_000;

export interface BluetoothPollState {
  bluetooth: BluetoothState | null;
  /** `not_managed`: no Bluetooth service; `unavailable`: it couldn't be read (and nothing was shown before). */
  reason: HostBluetoothOutput['reason'] | null;
  loading: boolean;
}

export interface BluetoothPoller {
  getState(): BluetoothPollState;
  subscribe(listener: () => void): () => void;
  /** Ask now (on open, after a refusal). */
  refresh(): void;
  /** A scan the app just started or kept on: shown at once, then followed while it runs. */
  scanned(scan: BluetoothScan): void;
  /** A pairing the app just started, answered or cancelled: shown at once, then followed while it runs. */
  pairing(pairing: BluetoothPairing): void;
  /** A device the app connected or disconnected: its row at once. */
  device(device: BluetoothDevice): void;
  /** A device the app removed: its row goes at once. */
  removed(address: string): void;
  /** On screen and visible, or not (stop asking). */
  setActive(active: boolean): void;
  dispose(): void;
}

export interface BluetoothPollerOptions {
  api: BluetoothApi | null;
  pollMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * BLUETOOTH, live while the box looks or pairs (AP-3706): `host.bluetooth` once when it becomes active, then every
 * `BLUETOOTH_POLL_MS` while the answer has a scan whose `until` is ahead or a pairing that runs, and no more after (a
 * scan or pairing well past its time isn't followed for ever). What the app did itself (`scanned`, `pairing`, `device`,
 * `removed`) shows at once, and an answer asked for before it is dropped. While following, a failed answer is ignored
 * and asked again; without anything shown it says the state couldn't be read. UI-free: the web wraps it in a hook,
 * Android in its screen; state is replaced on every change (`useSyncExternalStore`).
 */
export function createBluetoothPoller(options: BluetoothPollerOptions): BluetoothPoller {
  const api = options.api;
  const pollMs = options.pollMs ?? BLUETOOTH_POLL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let state: BluetoothPollState = {
    bluetooth: null,
    reason: api ? null : 'not_managed',
    loading: api !== null,
  };
  const listeners = new Set<() => void>();
  let active = false;
  let disposed = false;
  let asking = false;
  let again = false;
  let timer: unknown = null;
  /** Bumped by everything the app did here: an answer asked for before it is dropped (it can't know of it). */
  let generation = 0;

  const set = (patch: Partial<BluetoothPollState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  /** Whether the box looks or pairs (and isn't long overdue saying it stopped). */
  const following = () => {
    const b = state.bluetooth;
    if (!b) return false;
    const t = now();
    if (b.scan && Date.parse(b.scan.until) + OVERDUE_MS > t) return true;
    return bluetoothPairingRunning(b.pairing) && Date.parse(b.pairing?.deadline ?? '') + OVERDUE_MS > t;
  };
  const schedule = () => {
    stop();
    if (active && !disposed && following()) timer = setTimer(ask, pollMs);
  };

  function ask() {
    timer = null;
    if (!api || disposed) return;
    if (asking) {
      again = true;
      return;
    }
    asking = true;
    const mine = generation;
    api.state().then(
      (out) => {
        asking = false;
        if (disposed) return;
        if (mine !== generation) again = true;
        else if (out.bluetooth) set({ bluetooth: out.bluetooth, reason: null, loading: false });
        else if (!following()) set({ bluetooth: null, reason: out.reason ?? 'unavailable', loading: false });
        after();
      },
      () => {
        asking = false;
        if (disposed) return;
        if (mine !== generation) again = true;
        // While the box looks or pairs the last answer stays (one lost answer isn't news); otherwise what was shown.
        if (!following() && !state.bluetooth) set({ reason: 'unavailable', loading: false });
        after();
      },
    );
  }

  const after = () => {
    if (again) {
      again = false;
      ask();
    } else schedule();
  };

  /** Shows what the app did and follows on from it. */
  const local = (patch: (b: BluetoothState) => BluetoothState) => {
    if (disposed) return;
    generation += 1;
    const b = state.bluetooth;
    if (b) set({ bluetooth: patch(b) });
    stop();
    if (active) ask();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh() {
      if (disposed || !api) return;
      stop();
      ask();
    },
    scanned: (scan) => local((b) => ({ ...b, scan })),
    // A pairing stops the looking (BT-07).
    pairing: (pairing) =>
      local((b) => ({ ...b, pairing, scan: bluetoothPairingRunning(pairing) ? null : b.scan })),
    device: (device) =>
      local((b) => ({ ...b, devices: b.devices.map((d) => (d.address === device.address ? device : d)) })),
    removed: (address) => local((b) => ({ ...b, devices: b.devices.filter((d) => d.address !== address) })),
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      if (active) ask();
      else stop();
    },
    dispose() {
      disposed = true;
      active = false;
      stop();
      listeners.clear();
    },
  };
}
