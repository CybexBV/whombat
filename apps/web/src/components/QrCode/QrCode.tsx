import { useMemo } from 'react';
import { encode } from 'uqr';
import { cx } from '../cx';
import styles from './QrCode.module.css';

export interface QrCodeProps {
  /** What the code encodes (a link). */
  value: string;
  /** The largest the code may be, in CSS px (the quiet zone included); modules snap to whole pixels below it. */
  size: number;
  /** Accessible name: what scanning it does (the code itself is never read out). */
  label: string;
  className?: string;
}

/** Quiet zone around the modules, in modules (ISO/IEC 18004 asks for 4). */
const QUIET = 4;

/**
 * A QR code as crisp SVG (AP-523): error correction M, a four-module quiet zone, dark modules on a light plate in
 * both themes (scanners read dark-on-light best; the plate's colors are fixed tokens, see `QrCode.module.css`).
 * Every module is a whole number of CSS pixels at `size`, so edges stay sharp at 1×; a narrower container scales the
 * whole code down (`max-width: 100%`).
 */
export function QrCode({ value, size, label, className }: QrCodeProps) {
  const { path, count } = useMemo(() => qrPath(value), [value]);
  const total = count + QUIET * 2;
  const px = Math.max(1, Math.floor(size / total)) * total;
  return (
    <svg
      className={cx(styles.qr, className)}
      viewBox={`0 0 ${total} ${total}`}
      width={px}
      height={px}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-modules={count}
    >
      <rect className={styles.plate} width={total} height={total} />
      <path className={styles.modules} d={path} transform={`translate(${QUIET} ${QUIET})`} />
    </svg>
  );
}

/** The dark modules as one path of horizontal runs (`M x y h n v1 h -n z`), and the code's width in modules. */
export function qrPath(value: string): { path: string; count: number } {
  const qr = encode(value, { ecc: 'M', border: 0 });
  let path = '';
  qr.data.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      path += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return { path, count: qr.size };
}
