/**
 * The Bluetooth sheet's line icons, in the desk's style (24-unit box, stroked in the text colour, as the Wi-Fi sheet's):
 * the Bluetooth mark and the mark switched off, a mark per kind of device, the signal as four rising bars (not the Wi-Fi
 * arcs: a device's signal is not a network's). Always decorative: the words beside them say what they mean.
 */
import type { ReactElement } from 'react';
import type { BluetoothKind, BluetoothSignal } from '../lib/bluetooth';
import wifiStyles from '../wifi/wifi.module.css';

const PATHS = {
  bluetooth: <path d="M7 7l10 10-5 5V2l5 5L7 17" />,
  bluetoothOff: <path d="M17 17l-5 5V12l-5 5M2 2l20 20M14.5 9.5L17 7l-5-5v4.5" />,
  keyboard: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  mouse: (
    <>
      <rect x="6" y="3" width="12" height="18" rx="6" />
      <path d="M12 7v4" />
    </>
  ),
  headphones: (
    <>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
    </>
  ),
  headset: (
    <>
      <path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5zm0 0a9 9 0 0 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z" />
      <path d="M21 16v2a4 4 0 0 1-4 4h-5" />
    </>
  ),
  speaker: (
    <>
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <circle cx="12" cy="14" r="4" />
      <path d="M12 6h.01" />
    </>
  ),
  gamepad: (
    <>
      <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01" />
      <path d="M17.3 5H6.7a4 4 0 0 0-4 3.6C2.6 9.4 2 14.5 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.4-1.4A2 2 0 0 1 9.8 16h4.4a2 2 0 0 1 1.4.6L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.5-.6-6.6-.7-7.3A4 4 0 0 0 17.3 5z" />
    </>
  ),
} as const satisfies Record<string, ReactElement>;

export type BluetoothIconName = keyof typeof PATHS;

/** A kind's mark; a device the box can't name the kind of has the Bluetooth mark. */
export const KIND_ICON: Record<BluetoothKind, BluetoothIconName> = {
  keyboard: 'keyboard',
  mouse: 'mouse',
  headphones: 'headphones',
  headset: 'headset',
  speaker: 'speaker',
  gamepad: 'gamepad',
  other: 'bluetooth',
};

export function Icon({ name, className }: { name: BluetoothIconName; className?: string }) {
  return (
    <svg
      className={[wifiStyles.icon, className].filter(Boolean).join(' ')}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The signal as four rising bars, lit up to the signal (0: none lit). */
export function SignalBars({ signal, className }: { signal: BluetoothSignal; className?: string }) {
  const bars = ['M4 20v-2', 'M9.33 20v-5', 'M14.67 20v-8', 'M20 20V9'];
  return (
    <svg
      className={[wifiStyles.icon, className].filter(Boolean).join(' ')}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      data-signal={signal}
    >
      {bars.map((d, i) => (
        <path key={d} d={d} strokeWidth={2.6} data-on={signal >= i + 1 || undefined} />
      ))}
    </svg>
  );
}
