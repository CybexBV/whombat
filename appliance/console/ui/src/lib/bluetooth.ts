/**
 * The box's Bluetooth on its screen (Whombat bluetooth.md BT-01…BT-11; appliance CG-200…): the shapes the console
 * server passes through (`/api/state`'s `bluetooth`, `/api/bluetooth`, `/api/bluetooth/*`), read the way `parseState`
 * reads (a piece the page doesn't understand is left out), and the pure rules the Bluetooth sheet and the chip follow.
 *
 * The shapes copy contracts 0.109.0 (`@whombat/protocol/session` bluetooth.ts, `@whombat/control-contracts/local`
 * desk.ts: `BluetoothState`, `BluetoothDevice`, `BluetoothPairing`, `DeskBluetoothAnswer`, …): the page can't import
 * the contracts (CG-40), so it keeps copies with the same names and members.
 */

export const BLUETOOTH_KINDS = [
  'keyboard',
  'mouse',
  'headphones',
  'headset',
  'speaker',
  'gamepad',
  'other',
] as const;
export type BluetoothKind = (typeof BLUETOOTH_KINDS)[number];
export type BluetoothSignal = 0 | 1 | 2 | 3 | 4;
export const BLUETOOTH_MISSING = ['no_adapter', 'no_driver', 'disabled'] as const;
export type BluetoothMissing = (typeof BLUETOOTH_MISSING)[number];
export const BLUETOOTH_PAIRING_PHASES = [
  'pairing',
  'code',
  'confirm',
  'connecting',
  'done',
  'failed',
] as const;
export type BluetoothPairingPhase = (typeof BLUETOOTH_PAIRING_PHASES)[number];
export const BLUETOOTH_PAIRING_FAILURES = ['rejected', 'timeout', 'not_found', 'canceled', 'failed'] as const;
export type BluetoothPairingFailure = (typeof BLUETOOTH_PAIRING_FAILURES)[number];

export interface BluetoothDevice {
  /** The device's handle (BT-10): sent back as it came. */
  address: string;
  name: string;
  kind: BluetoothKind;
  connected: boolean;
  battery?: number;
  signal?: BluetoothSignal;
}

export interface BluetoothScan {
  until: string;
  devices: BluetoothDevice[];
}

export interface BluetoothPairing {
  id: string;
  address: string;
  name: string;
  kind: BluetoothKind;
  phase: BluetoothPairingPhase;
  deadline: string;
  /** Phases `code` and `confirm`: the digits the box made (BT-04). */
  code?: string;
  /** Phase `code`: the digits typed on the keyboard so far, when it says. */
  typed?: number;
  failure?: BluetoothPairingFailure;
}

export interface BluetoothState {
  adapter: { name: string; powered: boolean } | null;
  missing?: BluetoothMissing;
  /** Paired, connected first, then by name. */
  devices: BluetoothDevice[];
  scan: BluetoothScan | null;
  pairing: BluetoothPairing | null;
}

/** `GET /api/bluetooth` (DeskBluetoothAnswer): `mayChange` false, the screen shows Bluetooth read-only (BT-02). */
export interface BluetoothAnswer {
  bluetooth: BluetoothState;
  mayChange: boolean;
}

/** `/api/state`'s `bluetooth` (CG-201): what the chip shows. */
export interface BluetoothSummary {
  /** Why the adapter can't be used (null: it can). */
  missing: 'no_driver' | 'disabled' | null;
  connected: { name: string; kind: BluetoothKind }[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null =>
  values.includes(v as T) ? (v as T) : null;
const int = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

/** A device's address as the contract writes it (`BluetoothAddress`). */
export const addressValid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(s);

/** A name the page shows: one line, at most 80 characters (the console server cleaned it). */
const name = (s: unknown): string | null =>
  typeof s === 'string' && s.trim() !== '' && [...s].length <= 80 ? s : null;

export function parseDevice(v: unknown): BluetoothDevice | null {
  if (!isObj(v) || !addressValid(v.address)) return null;
  const n = name(v.name);
  const kind = oneOf(v.kind, BLUETOOTH_KINDS);
  if (!n || !kind) return null;
  const battery = int(v.battery, 0, 100);
  const signal = int(v.signal, 0, 4) as BluetoothSignal | null;
  return {
    address: v.address,
    name: n,
    kind,
    connected: v.connected === true,
    ...(battery !== null ? { battery } : {}),
    ...(signal !== null ? { signal } : {}),
  };
}

const devices = (v: unknown): BluetoothDevice[] =>
  (Array.isArray(v) ? v : []).flatMap((d) => {
    const p = parseDevice(d);
    return p ? [p] : [];
  });

export function parseScan(v: unknown): BluetoothScan | null {
  if (!isObj(v) || typeof v.until !== 'string') return null;
  return { until: v.until, devices: devices(v.devices) };
}

export function parsePairing(v: unknown): BluetoothPairing | null {
  if (!isObj(v) || typeof v.id !== 'string' || !/^p-[a-z0-9]{8,32}$/.test(v.id) || !addressValid(v.address))
    return null;
  const n = name(v.name);
  const kind = oneOf(v.kind, BLUETOOTH_KINDS);
  const phase = oneOf(v.phase, BLUETOOTH_PAIRING_PHASES);
  if (!n || !kind || !phase) return null;
  const shows = phase === 'code' || phase === 'confirm';
  const code = shows && typeof v.code === 'string' && /^[0-9]{4,6}$/.test(v.code) ? v.code : null;
  // A code to type or to compare without its digits is no pairing the page can show.
  if (shows && !code) return null;
  const typed = phase === 'code' ? int(v.typed, 0, 6) : null;
  const failure = phase === 'failed' ? (oneOf(v.failure, BLUETOOTH_PAIRING_FAILURES) ?? 'failed') : null;
  return {
    id: v.id,
    address: v.address,
    name: n,
    kind,
    phase,
    deadline: typeof v.deadline === 'string' ? v.deadline : '',
    ...(code ? { code } : {}),
    ...(typed !== null ? { typed } : {}),
    ...(failure ? { failure } : {}),
  };
}

export function parseBluetooth(v: unknown): BluetoothState | null {
  if (!isObj(v)) return null;
  const a = isObj(v.adapter) && typeof v.adapter.name === 'string' ? v.adapter : null;
  const missing = oneOf(v.missing, BLUETOOTH_MISSING);
  return {
    adapter: a ? { name: a.name as string, powered: a.powered === true } : null,
    ...(missing ? { missing } : {}),
    devices: devices(v.devices),
    scan: parseScan(v.scan),
    pairing: parsePairing(v.pairing),
  };
}

export function parseBluetoothAnswer(v: unknown): BluetoothAnswer | null {
  if (!isObj(v)) return null;
  const bluetooth = parseBluetooth(v.bluetooth);
  return bluetooth ? { bluetooth, mayChange: v.mayChange === true } : null;
}

export function parseBluetoothSummary(v: unknown): BluetoothSummary | null {
  if (!isObj(v)) return null;
  const connected = (Array.isArray(v.connected) ? v.connected : []).flatMap((d) => {
    const n = isObj(d) ? name(d.name) : null;
    const kind = isObj(d) ? oneOf(d.kind, BLUETOOTH_KINDS) : null;
    return n && kind ? [{ name: n, kind }] : [];
  });
  return { missing: oneOf(v.missing, ['no_driver', 'disabled'] as const), connected };
}

/* Rules ------------------------------------------------------------------------------------------------------------- */

/** Why the adapter can't be used now (null: it can). */
export function missingOf(s: BluetoothState): BluetoothMissing | null {
  if (!s.adapter) return s.missing ?? 'no_adapter';
  return s.adapter.powered ? null : (s.missing ?? 'disabled');
}

/** A pairing still runs (the sheet asks every second while it does). */
export const pairingRunning = (p: Pick<BluetoothPairing, 'phase'> | null | undefined) =>
  !!p && p.phase !== 'done' && p.phase !== 'failed';

/** The paired list: connected first, then by name (the runtime sends it so; the page keeps it so). */
export function sortDevices(list: readonly BluetoothDevice[]): BluetoothDevice[] {
  return [...list].sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
}

/** How many of the code's digits are typed (0 when the keyboard doesn't say). */
export const typedDigits = (p: Pick<BluetoothPairing, 'code' | 'typed'>) =>
  Math.min(p.typed ?? 0, p.code?.length ?? 0);

/** How often the sheet asks again: every second while it looks or pairs (BLUETOOTH_POLL_MS), else every 2 s. */
export function pollMs(s: BluetoothState | null | undefined): number {
  return s && (s.scan || pairingRunning(s.pairing)) ? BLUETOOTH_POLL_MS : BLUETOOTH_IDLE_POLL_MS;
}

/** BLUETOOTH_POLL_MS (§2.1). */
export const BLUETOOTH_POLL_MS = 1000;
/** While nothing runs, the console server's 2 s (CG-201). */
export const BLUETOOTH_IDLE_POLL_MS = 2000;
/** The sheet idles shut after this long without a touch or a key, unless a pairing runs (CG-108's). */
export const SHEET_IDLE_MS = 2 * 60_000;
