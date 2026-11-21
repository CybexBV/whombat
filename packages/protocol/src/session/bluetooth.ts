/**
 * The box's Bluetooth (0.109, CT-670…CT-679; Whombat docs/decisions/bluetooth.md BT-01…BT-11): the keyboards, mice,
 * speakers, headphones, headsets and game controllers paired with the box, the devices it finds while it looks, and the
 * one pairing that runs. The appliance's Bluetooth service answers it (`GET /v1/bluetooth/state` and the other
 * `BLUETOOTH_PATHS` of `@whombat/control-contracts/local`, Go `protocol.BluetoothState`, …); the runtime hands the same
 * shapes to owners through the session ops `host.bluetooth` and `host.bluetooth.*` (Settings → This Whombat → Overview
 * → Bluetooth), and to the box's screen through the desk socket.
 *
 * The box finds the device, never the other way round (BT-03): it looks for `BLUETOOTH_SCAN_S`, someone chooses a
 * device, and it pairs for at most `BLUETOOTH_PAIRING_S`. A code is shown, never typed into the box (BT-04). Phones and
 * computers never cross the wire (BT-01). Kinds, phases and failures cross the wire, never words (BT-11). A device's
 * address is its handle for owners and the screen; it is never in the hardware report, a log or the audit log (BT-10).
 *
 * Display strings — device and adapter names — may be any script on one line (`HOST_TEXT_RES`, the hardware report's
 * form, CT-560): producers clean them (`hostText`) rather than fail.
 */
import type { ErrorCode } from '@whombat/core/contracts';
import { z } from 'zod';
import { Rfc3339 } from './backup.js';
import { hostTextSchema } from './hardware.js';

/* Addresses, names and bars (CT-670) ----------------------------------------------------------------------------- */

/** A device's Bluetooth address, upper case (`AA:BB:CC:DD:EE:FF`); producers upper-case what BlueZ gives. */
export const BLUETOOTH_ADDRESS_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
export const BluetoothAddress = z.string().regex(BLUETOOTH_ADDRESS_RE);
export type BluetoothAddress = z.infer<typeof BluetoothAddress>;

/** The most code points in a device's or the adapter's name. */
export const BLUETOOTH_NAME_MAX = 80;

/** A device's or the adapter's name as people read it: display text of 1…80 code points (`hostText` cleans it). */
export const BluetoothName = hostTextSchema(BLUETOOTH_NAME_MAX);

/**
 * What a device is (BT-01): `keyboard`, `mouse` (trackpads and pens too), `headphones`, `headset` (with a microphone),
 * `speaker`, `gamepad`, `other` (a kind the box pairs but has no word for: “Device”). Phones and computers are left out
 * of every list.
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
export const BluetoothKind = z.enum(BLUETOOTH_KINDS);
export type BluetoothKind = z.infer<typeof BluetoothKind>;

/** Signal bars, 0…4 (`bluetoothSignalFromDbm`). */
export const BluetoothSignal = z.number().int().min(0).max(4);
export type BluetoothSignal = z.infer<typeof BluetoothSignal>;

/**
 * The bars for a signal strength (RSSI) in dBm (CT-670; Go `local.BluetoothSignalFromDBm`): ≥ −60 → 4, ≥ −70 → 3,
 * ≥ −80 → 2, ≥ −90 → 1, else 0.
 */
export function bluetoothSignalFromDbm(dbm: number): BluetoothSignal {
  return dbm >= -60 ? 4 : dbm >= -70 ? 3 : dbm >= -80 ? 2 : dbm >= -90 ? 1 : 0;
}

/* Devices and looking (CT-671) ----------------------------------------------------------------------------------- */

/**
 * A device: paired (in `BluetoothState.devices`) or found while looking (in `BluetoothScan.devices`). `connected`: in
 * use now (always false in a scan). `battery`: its charge in percent, when it says. `signal`: the bars, while looking
 * (a paired device's when BlueZ has a strength for it).
 */
export const BluetoothDevice = z.object({
  address: BluetoothAddress,
  name: BluetoothName,
  kind: BluetoothKind,
  connected: z.boolean(),
  battery: z.number().int().min(0).max(100).optional(),
  signal: BluetoothSignal.optional(),
});
export type BluetoothDevice = z.infer<typeof BluetoothDevice>;

export const BLUETOOTH_SCAN_MAX = 64;
export const BLUETOOTH_DEVICES_MAX = 32;

/**
 * The box is looking for devices until `until` (BT-07). `devices`: what it found that isn't paired and has a name,
 * strongest first, at most `BLUETOOTH_SCAN_MAX`.
 */
export const BluetoothScan = z.object({
  until: Rfc3339,
  devices: z.array(BluetoothDevice).max(BLUETOOTH_SCAN_MAX),
});
export type BluetoothScan = z.infer<typeof BluetoothScan>;

/* A pairing (CT-672) --------------------------------------------------------------------------------------------- */

/** A pairing's id (`p-` and 8…32 lower-case letters and digits). */
export const BluetoothPairingId = z.string().regex(/^p-[a-z0-9]{8,32}$/);

/** The code a pairing shows: 4…6 ASCII digits. */
export const BluetoothCode = z.string().regex(/^[0-9]{4,6}$/);

/**
 * Where a pairing is (BT-04): `pairing` (asking the device); `code` (type `code` on the keyboard, then Enter; `typed`
 * digits so far, when the keyboard says); `confirm` (does the device show `code`? `host.bluetooth.confirm` answers);
 * `connecting` (paired and trusted, connecting); `done`; `failed` (`failure` says why).
 */
export const BLUETOOTH_PAIRING_PHASES = [
  'pairing',
  'code',
  'confirm',
  'connecting',
  'done',
  'failed',
] as const;
export const BluetoothPairingPhase = z.enum(BLUETOOTH_PAIRING_PHASES);
export type BluetoothPairingPhase = z.infer<typeof BluetoothPairingPhase>;

/** A pairing's phase is final: nothing more happens to it (Go `local.BluetoothPairingDone`). */
export function bluetoothPairingDone(phase: BluetoothPairingPhase): boolean {
  return phase === 'done' || phase === 'failed';
}

/**
 * Why a pairing failed: `rejected` (the device said no, a wrong code, or **No** to the question); `timeout` (it didn't
 * answer before `deadline`); `not_found` (it isn't nearby any more); `canceled` (`host.bluetooth.cancel`, or the dialog
 * closed); `failed` (anything else, including a device that wants a code typed into the box, BT-04).
 */
export const BLUETOOTH_PAIRING_FAILURES = ['rejected', 'timeout', 'not_found', 'canceled', 'failed'] as const;
export const BluetoothPairingFailure = z.enum(BLUETOOTH_PAIRING_FAILURES);
export type BluetoothPairingFailure = z.infer<typeof BluetoothPairingFailure>;

/**
 * One pairing and where it is. `deadline`: when it gives up (`BLUETOOTH_PAIRING_S` after it started). `code` exactly in
 * `code` and `confirm`; `typed` (0…6, at most the code's length) only in `code`; `failure` exactly in `failed`
 * (`bluetoothPairingValid`).
 */
export const BluetoothPairing = z.object({
  id: BluetoothPairingId,
  address: BluetoothAddress,
  name: BluetoothName,
  kind: BluetoothKind,
  phase: BluetoothPairingPhase,
  deadline: Rfc3339,
  code: BluetoothCode.optional(),
  typed: z.number().int().min(0).max(6).optional(),
  failure: BluetoothPairingFailure.optional(),
});
export type BluetoothPairing = z.infer<typeof BluetoothPairing>;

/**
 * What the schema can't say (CT-672; Go `local.BluetoothPairingValid`): `code` exactly in `code` and `confirm`, `typed`
 * only in `code` and at most the code's length, `failure` exactly in `failed`.
 */
export function bluetoothPairingValid(p: {
  phase: string;
  code?: string;
  typed?: number;
  failure?: string;
}): boolean {
  const showsCode = p.phase === 'code' || p.phase === 'confirm';
  if (showsCode !== (p.code !== undefined)) return false;
  if (p.typed !== undefined && (p.phase !== 'code' || p.typed > (p.code?.length ?? 0))) return false;
  return (p.phase === 'failed') === (p.failure !== undefined);
}

/* The state (CT-673) --------------------------------------------------------------------------------------------- */

/** The box's Bluetooth adapter: BlueZ's name for it and whether it is switched on. */
export const BluetoothAdapter = z.object({ name: BluetoothName, powered: z.boolean() });
export type BluetoothAdapter = z.infer<typeof BluetoothAdapter>;

/**
 * Why Bluetooth can't be used: `no_adapter` (the machine has none: the app hides the section), `no_driver` (it has one
 * without a driver or its firmware), `disabled` (rfkill-blocked or switched off).
 */
export const BLUETOOTH_MISSING = ['no_adapter', 'no_driver', 'disabled'] as const;
export const BluetoothMissing = z.enum(BLUETOOTH_MISSING);
export type BluetoothMissing = z.infer<typeof BluetoothMissing>;

/**
 * The box's Bluetooth (BT-02…BT-07). `adapter`: null without one; `missing` exactly when `adapter` is null or not
 * powered. `devices`: the paired ones, connected first then by name, at most `BLUETOOTH_DEVICES_MAX`. `scan`: while the
 * box looks (null otherwise). `pairing`: the running one, or the last one for `BLUETOOTH_RESULT_KEEP_S` after it ended
 * (null otherwise). See `bluetoothStateValid`.
 */
export const BluetoothState = z.object({
  adapter: BluetoothAdapter.nullable(),
  missing: BluetoothMissing.optional(),
  devices: z.array(BluetoothDevice).max(BLUETOOTH_DEVICES_MAX),
  scan: BluetoothScan.nullable(),
  pairing: BluetoothPairing.nullable(),
});
export type BluetoothState = z.infer<typeof BluetoothState>;

/**
 * What the schema can't say (CT-673; Go `local.BluetoothStateValid`): `missing` exactly when there is no adapter or it
 * is off; every address once among the paired devices and once in the scan, and no paired device in the scan; no scan
 * while a pairing runs (a pairing stops looking, BT-07); a consistent pairing.
 */
export function bluetoothStateValid(s: BluetoothState): boolean {
  const usable = s.adapter?.powered === true;
  if (usable === (s.missing !== undefined)) return false;
  const paired = new Set(s.devices.map((d) => d.address));
  if (paired.size !== s.devices.length) return false;
  if (s.scan) {
    const found = new Set(s.scan.devices.map((d) => d.address));
    if (found.size !== s.scan.devices.length) return false;
    if ([...found].some((a) => paired.has(a))) return false;
    if (s.pairing && !bluetoothPairingDone(s.pairing.phase)) return false;
  }
  return s.pairing === null || bluetoothPairingValid(s.pairing);
}

/* Timing (CT-674) ------------------------------------------------------------------------------------------------ */

/** Looking runs this long; asked again, it runs on this long from then (BT-07). */
export const BLUETOOTH_SCAN_S = 60;
/** A pairing gives up this long after it started (BT-07). */
export const BLUETOOTH_PAIRING_S = 90;
/** A connect waits at most this long for the device. */
export const BLUETOOTH_CONNECT_S = 15;
/** Clients read the state this often while the box looks or a pairing runs (no realtime event). */
export const BLUETOOTH_POLL_MS = 1_000;
/** An ended pairing stays in the state this long, so the app and the screen can show how it ended. */
export const BLUETOOTH_RESULT_KEEP_S = 60;

/* Refusals (CT-675) ---------------------------------------------------------------------------------------------- */

/**
 * Why a Bluetooth op refused, in `error.details.code` of a session error and as `LocalError.code` from the Bluetooth
 * service and the desk socket:
 * - `no_bluetooth`: no adapter, or it is off (`BluetoothState.missing` says why);
 * - `busy`: a pairing runs: wait for it to end, or cancel it;
 * - `not_found`: no device with that address among the paired devices or in the scan, or a pairing id that isn't the
 *   current one;
 * - `not_paired`: connecting, disconnecting or forgetting a device the box isn't paired with;
 * - `unavailable`: the Bluetooth service (or BlueZ) didn't answer.
 */
export const BLUETOOTH_ERRORS = ['no_bluetooth', 'busy', 'not_found', 'not_paired', 'unavailable'] as const;
export const BluetoothErrorCode = z.enum(BLUETOOTH_ERRORS);
export type BluetoothErrorCode = z.infer<typeof BluetoothErrorCode>;

/** The generic session `ErrorCode` each refusal rides on (`not_found` and `unavailable` on their namesakes). */
export const BLUETOOTH_ERROR_STATUS: Readonly<Record<BluetoothErrorCode, z.infer<typeof ErrorCode>>> = {
  no_bluetooth: 'not_allowed',
  busy: 'conflict',
  not_found: 'not_found',
  not_paired: 'conflict',
  unavailable: 'unavailable',
};

/** `error.details` of a Bluetooth refusal. */
export const BluetoothErrorDetails = z.object({ code: BluetoothErrorCode });
export type BluetoothErrorDetails = z.infer<typeof BluetoothErrorDetails>;

/* The session ops (CT-676) ------------------------------------------------------------------------------- */

export const HostBluetoothInput = z.strictObject({});
/** `bluetooth` null with a `reason`: `not_managed` (no Bluetooth service to ask) or `unavailable` (it didn't answer). */
export const HostBluetoothOutput = z.object({
  bluetooth: BluetoothState.nullable(),
  reason: z.enum(['not_managed', 'unavailable']).optional(),
});
export type HostBluetoothOutput = z.infer<typeof HostBluetoothOutput>;

/** Start looking, or keep looking `BLUETOOTH_SCAN_S` more. */
export const HostBluetoothScanInput = z.strictObject({});
/** `scan` null with a `reason`: as `host.bluetooth`, or `no_bluetooth`. */
export const HostBluetoothScanOutput = z.object({
  scan: BluetoothScan.nullable(),
  reason: z.enum(['not_managed', 'unavailable', 'no_bluetooth']).optional(),
});
export type HostBluetoothScanOutput = z.infer<typeof HostBluetoothScanOutput>;

/**
 * Pair with a device the scan found (it stops looking); `connect`, `disconnect` and `forget` take a paired one. A forget
 * answers `OkOutput`: the device is gone from `devices`.
 */
export const HostBluetoothDeviceInput = z.strictObject({ address: BluetoothAddress });
export type HostBluetoothDeviceInput = z.infer<typeof HostBluetoothDeviceInput>;

/** Answer the running pairing's question (“Does {name} show {code}?”): `accept` true for **Yes**. */
export const HostBluetoothConfirmInput = z.strictObject({
  pairingId: BluetoothPairingId,
  accept: z.boolean(),
});
export type HostBluetoothConfirmInput = z.infer<typeof HostBluetoothConfirmInput>;

/** Stop the running pairing (it ends `failed` with `canceled`). */
export const HostBluetoothCancelInput = z.strictObject({ pairingId: BluetoothPairingId });
export type HostBluetoothCancelInput = z.infer<typeof HostBluetoothCancelInput>;

/** The pairing as it is now: poll `host.bluetooth` every `BLUETOOTH_POLL_MS` while it runs. */
export const HostBluetoothPairingOutput = z.object({ pairing: BluetoothPairing });
export type HostBluetoothPairingOutput = z.infer<typeof HostBluetoothPairingOutput>;

/** The paired device after a connect or a disconnect. */
export const HostBluetoothDeviceOutput = z.object({ device: BluetoothDevice });
export type HostBluetoothDeviceOutput = z.infer<typeof HostBluetoothDeviceOutput>;

/* Audit (signed appliance log; CT-677) --------------------------------------------------------------------------- */

/** Where a device was paired or removed: an owner in the app, or someone at the box's screen. */
export const BLUETOOTH_AUDIT_VIA = ['app', 'screen'] as const;

/**
 * Payload of `bluetooth.device_paired` / `bluetooth.device_removed` (BT-08): the device's name and kind and where the
 * change came from. Never its address (BT-10; parsing strips anything else).
 */
export const BluetoothAuditPayload = z.object({
  name: BluetoothName,
  kind: BluetoothKind,
  via: z.enum(BLUETOOTH_AUDIT_VIA),
});
export type BluetoothAuditPayload = z.infer<typeof BluetoothAuditPayload>;
