import { useMemo } from 'react';
import styles from './ui.module.css';

/** The quiet zone around the code, in modules: the light margin a phone's camera needs to find it. */
const QUIET = 3;

/**
 * A QR code drawn from the server's module rows ('#' dark), dark on a fixed light square so every phone reads it,
 * whatever the theme. `size` is its width in layout px, quiet zone included.
 */
export function Qr({ rows, size, label }: { rows: string[]; size: number; label: string }) {
  const { d, n } = useMemo(() => {
    let d = '';
    rows.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) if (r[x] === '#') d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    });
    return { d, n: rows.length };
  }, [rows]);
  if (n === 0) return null;
  const box = n + 2 * QUIET;
  return (
    <svg
      className={styles.qr}
      viewBox={`0 0 ${box} ${box}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={box} height={box} className={styles.qrLight} />
      <path d={d} className={styles.qrDark} />
    </svg>
  );
}
