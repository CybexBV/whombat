/**
 * The Bluetooth sheet's and chip's words (Whombat bluetooth.md BT-11; CG-210). BT-11's words are the words; the few
 * the sheet needs besides them say the same things in the same voice (concise-replies), with “Whombat” for the box as
 * the Wi-Fi sheet has it. Kinds, phases and failures come from the server; the words are made here.
 */
import { english, localized, type Translate } from '../i18n/translate';
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

export const btCopy = localized(
  (t) =>
    ({
      kicker: t('bluetooth.kicker'),
      title: 'Bluetooth',
      yourDevices: t('bluetooth.yourDevices'),
      add: t('bluetooth.add'),
      looking: t('bluetooth.looking'),
      hint: t('bluetooth.hint'),
      pairingWith: (name: string) => t('bluetooth.pairingWith', { name }),
      typeCode: (code: string, name: string) => t('bluetooth.typeCode', { code, name }),
      showsCode: (name: string, code: string) => t('bluetooth.showsCode', { name, code }),
      yes: t('bluetooth.yes'),
      no: t('bluetooth.no'),
      ready: (name: string) => t('bluetooth.ready', { name }),
      connected: t('bluetooth.connected'),
      battery: (n: number) => t('bluetooth.battery', { value: percent(n) }),
      notConnected: t('bluetooth.notConnected'),
      connect: t('bluetooth.connect'),
      disconnect: t('bluetooth.disconnect'),
      remove: t('bluetooth.remove'),
      removeTitle: (name: string) => t('bluetooth.removeTitle', { name }),
      removeLead: t('bluetooth.removeLead'),
      /** BT-02: the screen may not change Bluetooth now. */
      readOnly: t('bluetooth.readOnly'),
      missing: {
        no_adapter: t('bluetooth.missing.no_adapter'),
        no_driver: t('bluetooth.missing.no_driver'),
        disabled: t('bluetooth.missing.disabled'),
      } satisfies Record<BluetoothMissing, string>,
      kinds: {
        keyboard: t('bluetooth.kinds.keyboard'),
        mouse: t('bluetooth.kinds.mouse'),
        headphones: t('bluetooth.kinds.headphones'),
        headset: t('bluetooth.kinds.headset'),
        speaker: t('bluetooth.kinds.speaker'),
        gamepad: t('bluetooth.kinds.gamepad'),
        other: t('bluetooth.kinds.other'),
      } satisfies Record<BluetoothKind, string>,
      // The sheet's own (CG-210).
      none: t('bluetooth.none'),
      nothingFound: t('bluetooth.nothingFound'),
      again: t('bluetooth.again'),
      close: t('bluetooth.close'),
      done: t('bluetooth.done'),
      cancel: t('bluetooth.cancel'),
      back: t('bluetooth.back'),
      tryAgain: t('bluetooth.tryAgain'),
      connecting: t('bluetooth.connecting'),
      disconnecting: t('bluetooth.disconnecting'),
      removing: t('bluetooth.removing'),
      unreadable: t('bluetooth.unreadable'),
      connectFailed: (name: string) => t('bluetooth.connectFailed', { name }),
      devices: (n: number) => t('bluetooth.devices', { n }),
      errors: {
        busy: t('bluetooth.errors.busy'),
        no_bluetooth: t('bluetooth.missing.disabled'),
        not_paired: t('bluetooth.errors.not_paired'),
        not_found: t('bluetooth.errors.not_found'),
        unavailable: t('bluetooth.errors.unavailable'),
      } as Record<string, string>,
      failed: t('bluetooth.failed'),
    }) as const,
);
export const BT = btCopy();

/** A paired device's second line: “Connected · Battery 80 %”, “Connected”, “Not connected”. */
export function deviceLine(
  d: Pick<BluetoothDevice, 'connected' | 'battery'>,
  t: Translate = english,
): string {
  const BT = btCopy(t);

  if (!d.connected) return BT.notConnected;
  return d.battery === undefined ? BT.connected : `${BT.connected} · ${BT.battery(d.battery)}`;
}

/** What a screen reader hears for a device found nearby: “MX Master 3S, mouse, strong signal”. */
export function foundLabel(d: BluetoothDevice, t: Translate = english): string {
  const BT = btCopy(t);

  return [
    d.name,
    BT.kinds[d.kind].toLowerCase(),
    d.signal === undefined ? null : signalText(d.signal, t).toLowerCase(),
  ]
    .filter(Boolean)
    .join(', ');
}

/** How a pairing ended badly, as a title and the line under it (BT-11's sentences, split after the first). */
const failurewordsCopy = localized(
  (t): Record<BluetoothPairingFailure, (name: string) => [string, string | null]> => ({
    rejected: (name) => [
      t('bluetooth.failure.rejected.nameDidntAccept', { name }),
      t('bluetooth.failure.rejected.putItInHint'),
    ],
    timeout: (name) => [
      t('bluetooth.failure.timeout.nameDidntAnswer', { name }),
      t('bluetooth.failure.rejected.putItInHint'),
    ],
    not_found: (name) => [t('bluetooth.failure.not_found.nameIsntNearby', { name }), null],
    canceled: (name) => [
      t('bluetooth.failure.canceled.pairingWithName', { name }),
      t('bluetooth.failure.canceled.tryAgainHint'),
    ],
    failed: (name) => [
      t('bluetooth.failure.failed.pairingWithName', { name }),
      t('bluetooth.failure.canceled.tryAgainHint'),
    ],
  }),
);

/** A pairing on the sheet in words: running, ready, or how it ended. `tone` colours the mark. */
export interface PairingView {
  running: boolean;
  title: string;
  line: string | null;
  tone: 'mut' | 'ok' | 'bad';
}

export function pairingView(p: BluetoothPairing, t: Translate = english): PairingView {
  const BT = btCopy(t);
  const failureWords = failurewordsCopy(t);

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
export function chipView(
  s: BluetoothSummary,
  t: Translate = english,
): { off: boolean; text: string | null; label: string } {
  const BT = btCopy(t);

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
export function refusalText(code: string | null, t: Translate = english): string {
  const BT = btCopy(t);

  if (code === 'locked') return BT.readOnly;
  return (code && BT.errors[code]) || BT.failed;
}
