/**
 * BLUETOOTH and its Add a device sheet, the pure part (Whombat bluetooth.md BT-02…BT-07; bluetooth-android.md
 * AP-3750…AP-3760): what the card is, the sheet's step, its list of devices nearby, the pairing it follows and the code's
 * digits for TalkBack. The rows, a pairing in words and every word of BT-11 are the shared model's (`@whombat/client`
 * `host/bluetooth.ts`, bluetooth-web.md AP-3701); the phone adds two of its own (`BLUETOOTH_MOBILE_TEXT`). Tested in
 * `bluetooth.test.ts`.
 */
import {
  BLUETOOTH_TEXT,
  type BluetoothFoundRow,
  type BluetoothPairing,
  type BluetoothPairingView,
  type BluetoothPollState,
  type BluetoothScan,
  type BluetoothState,
  bluetoothFoundRows,
  bluetoothScanRunning,
  bluetoothShown,
} from '@whombat/client';

const D = BLUETOOTH_TEXT.dialog;

/** The phone's own words, in BT-11's voice (AP-3758). */
export const BLUETOOTH_MOBILE_TEXT = {
  /** The code for TalkBack while it is typed: “4 8 2 9 1 3, 2 of 6 typed”. */
  typed: (typed: number, total: number) => `${typed} of ${total} typed`,
  /** What TalkBack calls a device's action sheet. */
  deviceActions: 'Device actions',
} as const;

/* The card -------------------------------------------------------------------------------------------------------- */

/**
 * What BLUETOOTH is (AP-3751): nothing where there is no Bluetooth service or the machine has no adapter (a VM), a skeleton while the first answer comes, “Bluetooth couldn’t be read right now.” with Try again
 * when it didn't, else the rows.
 */
export function bluetoothCardKind(
  api: unknown,
  state: Pick<BluetoothPollState, 'bluetooth' | 'reason'>,
): 'none' | 'loading' | 'unavailable' | 'rows' {
  if (!api || state.reason === 'not_managed') return 'none';
  if (state.bluetooth) return bluetoothShown(state.bluetooth) ? 'rows' : 'none';
  return state.reason === 'unavailable' ? 'unavailable' : 'loading';
}

/* The sheet ------------------------------------------------------------------------------------------------------- */

/**
 * The sheet's step: the devices nearby, or the pairing it started (the newest the phone knows of it; `declined`: the
 * person answered No, so the sheet goes back to the list once it ended).
 */
export type BluetoothStep = { at: 'list' } | { at: 'pairing'; pairing: BluetoothPairing; declined?: boolean };

/** Asking the box to look: the request out, answered, or why it couldn't look. */
export type BluetoothLook = { at: 'asking' } | { at: 'asked' } | { at: 'failed'; note: string };

export interface BluetoothListView {
  /** “Looking for devices…” with a spinner at the end of the list. */
  looking: boolean;
  rows: BluetoothFoundRow[];
  /** “No devices nearby.” when the box stopped looking without finding any, or why it couldn't look. */
  note: string | null;
  /** Look again: once the box stopped looking. */
  canLookAgain: boolean;
}

/**
 * The list (AP-3754): the devices in the last scan the sheet saw — while the box looks its answer every second, after
 * that what it found (BlueZ keeps a device it found for a while; one that went is refused with “… isn’t nearby any more.”)
 * — strongest first, none that is paired and none the box said went; “Looking for devices…” while the box looks; “No
 * devices nearby.” when it stopped with none; why it couldn't look.
 */
export function bluetoothListView(
  look: BluetoothLook,
  state: Pick<BluetoothState, 'scan' | 'devices'> | null,
  seen: Pick<BluetoothScan, 'devices'> | null,
  now: number = Date.now(),
  /** Devices the box said aren't nearby any more (refused `not_found`): they leave the list until it looks again. */
  gone: readonly string[] = [],
): BluetoothListView {
  const looking = look.at === 'asking' || bluetoothScanRunning(state?.scan, now);
  const rows = seen
    ? bluetoothFoundRows(seen, state?.devices ?? []).filter((r) => !gone.includes(r.address))
    : [];
  const note =
    look.at === 'failed' ? look.note : !looking && rows.length === 0 && look.at === 'asked' ? D.none : null;
  return { looking, rows, note, canLookAgain: !looking };
}

/**
 * The pairing the sheet follows (AP-3755): the box's newest word on the one it started (the poller's), else the last it
 * had — the box forgets an ended pairing after a minute, and the sheet keeps saying how it ended.
 */
export function bluetoothFollowed(
  started: BluetoothPairing,
  current: BluetoothPairing | null | undefined,
): BluetoothPairing {
  return current && current.id === started.id ? current : started;
}

/** The code's digits as TalkBack reads them (AP-3756): “4 8 2 9 1 3”, and while it is typed how many are. */
export function bluetoothDigitsLabel(view: Pick<BluetoothPairingView, 'digits' | 'phase'>): string | null {
  if (!view.digits) return null;
  const spoken = view.digits.map((d) => d.digit).join(' ');
  if (view.phase !== 'code') return spoken;
  const typed = view.digits.filter((d) => d.typed).length;
  return `${spoken}, ${BLUETOOTH_MOBILE_TEXT.typed(typed, view.digits.length)}`;
}

/** Whether the sheet goes back to the list (AP-3757): the person answered No and that pairing ended. */
export function bluetoothBackToList(step: BluetoothStep, current: BluetoothPairing | null): boolean {
  if (step.at !== 'pairing' || !step.declined) return false;
  const p = bluetoothFollowed(step.pairing, current);
  return p.phase === 'done' || p.phase === 'failed';
}

/** What closing the sheet does (AP-3757): a pairing it started that still runs is cancelled first. */
export function bluetoothCancelOnClose(step: BluetoothStep, current: BluetoothPairing | null): string | null {
  if (step.at !== 'pairing') return null;
  const p = bluetoothFollowed(step.pairing, current);
  return p.phase === 'done' || p.phase === 'failed' ? null : p.id;
}
