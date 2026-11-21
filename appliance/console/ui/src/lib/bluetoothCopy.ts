/**
 * The Bluetooth sheet's and chip's words (Whombat bluetooth.md BT-11; CG-210). BT-11's words are the words; the few
 * the sheet needs besides them say the same things in the same voice (concise-replies), with “Whombat” for the box as
 * the Wi-Fi sheet has it. Kinds, phases and failures come from the server; the words are made here.
 */
import type {
  BluetoothDevice,
  BluetoothKind,
  BluetoothMissing,
  BluetoothPairing,
  BluetoothPairingFailure,
  BluetoothSummary,
} from './bluetooth';
import { percent } from './deskCopy';
import { signalText } from './wifiCopy';

export const BT = {
  kicker: 'BLUETOOTH',
  title: 'Bluetooth',
  yourDevices: 'Your devices',
  add: 'Add a device',
  looking: 'Looking for devices…',
  hint: 'Put your device in pairing mode. Keyboards and mice often have a button for it; speakers and headphones usually need the power button held.',
  pairingWith: (name: string) => `Pairing with ${name}…`,
  typeCode: (code: string, name: string) => `Type ${code} on ${name}, then press Enter.`,
  showsCode: (name: string, code: string) => `Does ${name} show ${code}?`,
  yes: 'Yes',
  no: 'No',
  ready: (name: string) => `${name} is ready.`,
  connected: 'Connected',
  battery: (n: number) => `Battery ${percent(n)}`,
  notConnected: 'Not connected',
  connect: 'Connect',
  disconnect: 'Disconnect',
  remove: 'Remove',
  removeTitle: (name: string) => `Remove ${name}?`,
  removeLead: 'You’ll need to pair it again to use it.',
  /** BT-02: the screen may not change Bluetooth now. */
  readOnly: 'Unlock the screen to add or remove devices, or use the app.',
  missing: {
    no_adapter: 'This Whombat has no Bluetooth.',
    no_driver: 'This Bluetooth adapter has no driver yet.',
    disabled: 'Bluetooth is switched off.',
  } satisfies Record<BluetoothMissing, string>,
  kinds: {
    keyboard: 'Keyboard',
    mouse: 'Mouse',
    headphones: 'Headphones',
    headset: 'Headset',
    speaker: 'Speaker',
    gamepad: 'Game controller',
    other: 'Device',
  } satisfies Record<BluetoothKind, string>,
  // The sheet's own (CG-210).
  none: 'No devices paired yet.',
  nothingFound: 'No devices found.',
  again: 'Look again',
  close: 'Close',
  done: 'Done',
  cancel: 'Cancel',
  back: 'Back',
  tryAgain: 'Try again',
  connecting: 'Connecting…',
  disconnecting: 'Disconnecting…',
  removing: 'Removing…',
  unreadable: 'Bluetooth couldn’t be read right now.',
  connectFailed: (name: string) => `Couldn’t connect to ${name}. Switch it on and try again.`,
  devices: (n: number) => `${n} devices`,
  errors: {
    busy: 'Another device is pairing. Try again in a moment.',
    no_bluetooth: 'Bluetooth is switched off.',
    not_paired: 'That device isn’t paired any more.',
    not_found: 'That device isn’t nearby any more.',
    unavailable: 'Bluetooth isn’t answering right now. Try again in a moment.',
  } as Record<string, string>,
  failed: 'That didn’t work. Try again.',
} as const;

/** A paired device's second line: “Connected · Battery 80 %”, “Connected”, “Not connected”. */
export function deviceLine(d: Pick<BluetoothDevice, 'connected' | 'battery'>): string {
  if (!d.connected) return BT.notConnected;
  return d.battery === undefined ? BT.connected : `${BT.connected} · ${BT.battery(d.battery)}`;
}

/** What a screen reader hears for a device found nearby: “MX Master 3S, mouse, strong signal”. */
export function foundLabel(d: BluetoothDevice): string {
  return [
    d.name,
    BT.kinds[d.kind].toLowerCase(),
    d.signal === undefined ? null : signalText(d.signal).toLowerCase(),
  ]
    .filter(Boolean)
    .join(', ');
}

/** How a pairing ended badly, as a title and the line under it (BT-11's sentences, split after the first). */
const failureWords: Record<BluetoothPairingFailure, (name: string) => [string, string | null]> = {
  rejected: (name) => [`${name} didn’t accept the pairing.`, 'Put it in pairing mode and try again.'],
  timeout: (name) => [`${name} didn’t answer in time.`, 'Put it in pairing mode and try again.'],
  not_found: (name) => [`${name} isn’t nearby any more.`, null],
  canceled: (name) => [`Pairing with ${name} stopped.`, 'Try again.'],
  failed: (name) => [`Pairing with ${name} didn’t work.`, 'Try again.'],
};

/** A pairing on the sheet in words: running, ready, or how it ended. `tone` colours the mark. */
export interface PairingView {
  running: boolean;
  title: string;
  line: string | null;
  tone: 'mut' | 'ok' | 'bad';
}

export function pairingView(p: BluetoothPairing): PairingView {
  switch (p.phase) {
    case 'pairing':
    case 'connecting':
      return { running: true, title: BT.pairingWith(p.name), line: null, tone: 'mut' };
    case 'code':
      return { running: true, title: BT.typeCode(p.code ?? '', p.name), line: null, tone: 'mut' };
    case 'confirm':
      return { running: true, title: BT.showsCode(p.name, p.code ?? ''), line: null, tone: 'mut' };
    case 'done':
      return { running: false, title: BT.ready(p.name), line: null, tone: 'ok' };
    default: {
      const [title, line] = failureWords[p.failure ?? 'failed'](p.name);
      return { running: false, title, line, tone: 'bad' };
    }
  }
}

/** The chip (CG-202): the mark, and the connected device's name or how many are connected; off when it can't be used. */
export function chipView(s: BluetoothSummary): { off: boolean; text: string | null; label: string } {
  if (s.missing) return { off: true, text: null, label: `${BT.title} · ${BT.missing[s.missing]}` };
  const [one] = s.connected;
  if (!one) return { off: false, text: null, label: BT.title };
  if (s.connected.length === 1)
    return { off: false, text: one.name, label: `${BT.title} · ${one.name} · ${BT.connected}` };
  return {
    off: false,
    text: BT.devices(s.connected.length),
    label: `${BT.title} · ${s.connected.map((d) => d.name).join(', ')} · ${BT.connected}`,
  };
}

/** A refusal (`{"message": code}`) in words; `locked` is the read-only line. */
export function refusalText(code: string | null): string {
  if (code === 'locked') return BT.readOnly;
  return (code && BT.errors[code]) || BT.failed;
}
