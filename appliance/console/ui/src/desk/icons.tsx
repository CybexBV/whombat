/**
 * The desk's line icons (24-unit box, stroked in the text colour, as in the mockups): the lock, power, the mic, the
 * home tiles' kinds. Always decorative: the words beside them say what they mean.
 */
import type { ReactElement } from 'react';
import type { TileIcon } from '../lib/desk';
import styles from './desk.module.css';

const PATHS = {
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </>
  ),
  plug: <path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8zM12 18v4" />,
  battery: (
    <>
      <rect x="2" y="7" width="17" height="10" rx="2" />
      <path d="M22 11v2" />
      <path d="M11 9l-2 3h3l-2 3" />
    </>
  ),
  mic: (
    <>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
    </>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
  phone: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="2.5" />
      <path d="M11 18h2" />
    </>
  ),
  back: <path d="M15 18l-6-6 6-6" />,
  /** Opens more (“+2 more”, DK-86). */
  chevron: <path d="M9 6l6 6-6 6" />,
  /** Close conversation (DK-64). */
  close: <path d="M6 6l12 12M18 6L6 18" />,
  /** New message: down to the newest (DK-63). */
  down: <path d="M12 5v14M5 12l7 7 7-7" />,
  /** The camera is on (the lock chip, DK-30). */
  camera: (
    <>
      <path d="M2 9a2 2 0 0 1 2-2h2.8l1.7-2.5h7L17.2 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13.5" r="3.8" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  temperature: <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />,
  heat: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  power: <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />,
  light: (
    <>
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z" />
    </>
  ),
  water: <path d="M12 2.7l5.7 5.7a8 8 0 1 1-11.4 0z" />,
  network: (
    <>
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <path d="M12 8v4M5 16v-4h14v4" />
    </>
  ),
  generic: <circle cx="12" cy="12" r="8" />,
  /** The network line on This Whombat: down and up. */
  updown: <path d="M7 4v16M7 20l-4-4M7 20l4-4M17 20V4M17 4l-4 4M17 4l4 4" />,
  /** Found on your network (DF-06): the panel's head (the mockup's radar). */
  radar: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <path d="M12 12l6-6" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </>
  ),
  /** The internet on the calm glance's top bar (CG-353): a globe. */
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" />
    </>
  ),
  /** Whombat updating itself (CG-353). */
  update: <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4.5h-4.5" />,
  /** Remote help is on (CG-295): a support headset. */
  headset: (
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="13" width="4" height="6" rx="1.5" />
      <rect x="17" y="13" width="4" height="6" rx="1.5" />
      <path d="M19 19v.5a2.5 2.5 0 0 1-2.5 2.5H13" />
    </>
  ),
  /** “Connect them on your computer” (DF-09): a laptop. */
  laptop: (
    <>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2 19h20" />
    </>
  ),
} as const satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

export const TILE_ICON: Record<TileIcon, IconName> = {
  temperature: 'temperature',
  heat: 'heat',
  sun: 'sun',
  power: 'power',
  lock: 'lock',
  light: 'light',
  water: 'water',
  network: 'network',
  generic: 'generic',
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
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
