/**
 * The Wi-Fi sheet's line icons, in the desk's style (24-unit box, stroked in the text colour, desk/icons.tsx): the
 * signal bars, a cable, no network, the lock of a secured network, show/hide, backspace, shift, look again. Always
 * decorative: the words beside them say what they mean.
 */
import type { WifiSignal } from '../lib/network';
import styles from './wifi.module.css';

const PATHS = {
  cable: (
    <>
      <rect x="7" y="3" width="10" height="9" rx="1.5" />
      <path d="M10 6v2M14 6v2M12 12v4M9 21v-2a3 3 0 0 1 6 0v2" />
    </>
  ),
  none: (
    <>
      <path d="M2 8.8a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0" opacity="0.35" />
      <path d="M3 3l18 18" />
    </>
  ),
  lock: (
    <>
      <rect x="6" y="11" width="12" height="9" rx="2" />
      <path d="M9 11V8a3 3 0 0 1 6 0v3" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.5M6.6 6.6C3.7 8.5 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.4" />
      <path d="M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  backspace: (
    <>
      <path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z" />
      <path d="M17 9l-6 6M11 9l6 6" />
    </>
  ),
  shift: <path d="M12 3l9 9h-5v8H8v-8H3z" />,
  shiftLock: (
    <>
      <path d="M12 3l9 8h-5v6H8v-6H3z" />
      <path d="M8 21h8" />
    </>
  ),
  again: (
    <>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
  alert: (
    <>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v5M12 18h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
} as const;

export type WifiIconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: WifiIconName; className?: string }) {
  return (
    <svg
      className={[styles.icon, className].filter(Boolean).join(' ')}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The signal as four bars, the dot and three arcs, lit up to the signal (0: none lit). */
export function Bars({ signal, className }: { signal: WifiSignal; className?: string }) {
  const arcs = ['M9 16a5 5 0 0 1 6 0', 'M5.5 12.5a10 10 0 0 1 13 0', 'M2 8.8a15 15 0 0 1 20 0'];
  return (
    <svg
      className={[styles.icon, className].filter(Boolean).join(' ')}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      data-signal={signal}
    >
      <circle cx="12" cy="19.5" r="1.4" className={styles.barDot} data-on={signal >= 1 || undefined} />
      {arcs.map((d, i) => (
        <path key={d} d={d} data-on={signal >= i + 2 || undefined} />
      ))}
    </svg>
  );
}
