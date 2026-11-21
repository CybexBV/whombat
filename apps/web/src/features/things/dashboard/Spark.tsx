/**
 * A small line of a figure over the page's range (Whombat dashboards.md DS-07; dashboards-web.md AP-2050…): as wide as
 * its cell, scaled between its own lowest and highest value with a little room (the mock's), a wash under it, gaps kept.
 * Named for screen readers by what it shows (“CPU over the last 24 hours: between 2.1 and 63”).
 */
import { litSegments, seriesPaths, TILE_SEGMENTS } from '@whombat/client/hosts';
import { cx } from '../../../components/cx';
import { formatFigure } from './chartModel';
import styles from './Dashboard.module.css';

/** The viewBox's width: the line stretches to its cell, its stroke doesn't (`vector-effect`). */
const W = 100;

export function sparkDomain(values: readonly (number | null)[]): [number, number] | null {
  const pts = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!pts.length) return null;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const pad = (hi - lo) * 0.15 || Math.max(1, Math.abs(hi) * 0.1);
  return [lo - pad, hi + pad];
}

export function Spark({
  values,
  color,
  height = 30,
  label,
  className,
}: {
  values: readonly (number | null)[];
  /** A token. */
  color: string;
  height?: number;
  /** What it is a line of, and over when (“CPU over the last 24 hours”); none: decorative. */
  label?: string;
  className?: string;
}) {
  const dom = sparkDomain(values);
  const p = dom ? seriesPaths(values, dom[0], dom[1], W, height) : { line: '', area: '' };
  const pts = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const decimals = pts.some((v) => Math.abs(v - Math.round(v)) > 1e-9);
  const words =
    label && pts.length
      ? `${label}: between ${formatFigure(Math.min(...pts), decimals)} and ${formatFigure(Math.max(...pts), decimals)}`
      : label;
  const marks = (
    <>
      {p.area ? <path d={p.area} className={styles.sparkWash} style={{ fill: color }} /> : null}
      {p.line ? <path d={p.line} className={styles.sparkLine} style={{ stroke: color }} /> : null}
    </>
  );
  const box = {
    className: className ?? styles.spark,
    width: '100%',
    height,
    viewBox: `0 0 ${W} ${height}`,
    preserveAspectRatio: 'none',
    focusable: 'false' as const,
  };
  return words ? (
    <svg {...box} role="img" aria-label={words}>
      {marks}
    </svg>
  ) : (
    <svg {...box} aria-hidden="true">
      {marks}
    </svg>
  );
}

/** How full something is, as a thin bar (guests running, a disk); named by its share. */
export function Meter({
  value,
  color,
  label,
  className,
}: {
  /** 0…1. */
  value: number;
  /** A token. */
  color: string;
  label: string;
  className?: string;
}) {
  const share = Math.max(0, Math.min(1, value));
  return (
    <div
      className={className ?? styles.meter}
      role="img"
      aria-label={`${label}: ${Math.round(share * 100)} %`}
    >
      <i style={{ width: `${share * 100}%`, background: color }} />
    </div>
  );
}

/**
 * A server figure's block bar, the same 20 segments as its Overview card (`litSegments`): lit in the chart colour, amber
 * when the figure is; the number beside it says the same, so the bar is hidden from a screen reader.
 */
export function Blocks({ share, warn = false }: { share: number; warn?: boolean }) {
  const lit = litSegments(share, TILE_SEGMENTS);
  return (
    <span className={cx(styles.blocks, warn && styles.blocksWarn)} aria-hidden="true">
      {Array.from({ length: TILE_SEGMENTS }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the segments in order
        <i key={i} className={i < lit ? styles.lit : undefined} />
      ))}
    </span>
  );
}
