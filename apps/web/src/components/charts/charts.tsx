/**
 * The box status's charts (Whombat box-status.md BS-11; app docs/decisions/box-status.md AP-1138…AP-1140): the app's own
 * SVG, no chart library, drawn as the approved mock draws them — 2px lines with an area wash (`--chartWash`), columns
 * with 4px rounded tops (≤ 18px wide, 2px between stacked parts), hairline gridlines in `--line`, axis words in DM Mono
 * 11px `--mut`, a crosshair and one tooltip listing every series with the values first. The hit area is the whole plot
 * (a column's whole band); a keyboard reaches it once, focus shows the latest point and the arrow keys walk the rest.
 * Colours are tokens only (`--chart1`…`--chart3`); the tooltip is plain React text.
 */
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cx } from '../cx';
import styles from './charts.module.css';
import { fitTimeTicks } from './fitTimeTicks';

/** The plot's width, followed as the card resizes (0 until measured). */
function useWidth<E extends HTMLElement>(): [RefObject<E | null>, number] {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** One line of a tooltip: a swatch, the value in bold, then what it is (`12 Mbit/s` down). */
export interface TipLine {
  color?: string;
  value: string;
  rest?: string;
  /** A plain line (the computers' share): no swatch, no bold. */
  plain?: boolean;
}

export interface Tip {
  title: string;
  lines: TipLine[];
}

/**
 * The tooltip, beside the pointer and kept inside the card: placed in the card's frame as the mock places it (54px from
 * its top over lines, 40px over columns), 14px right of the point, 8px clear of the card's sides.
 */
function Tooltip({
  tip,
  x,
  top,
  plot,
}: {
  tip: Tip;
  x: number;
  top: number;
  plot: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ own: 0, offset: 0, card: 0 });
  useLayoutEffect(() => {
    const el = plot.current;
    const next = {
      own: ref.current?.offsetWidth ?? 0,
      offset: el?.offsetLeft ?? 0,
      card: (el?.offsetParent as HTMLElement | null)?.clientWidth ?? 0,
    };
    if (next.own !== frame.own || next.offset !== frame.offset || next.card !== frame.card) setFrame(next);
  });
  const left = Math.max(8, Math.min(frame.card - frame.own - 8, frame.offset + x + 14));
  return (
    <div ref={ref} className={styles.tip} style={{ left, top }} aria-live="polite">
      <div className={styles.tipTitle}>{tip.title}</div>
      {tip.lines.map((l) =>
        l.plain ? (
          <div key={`${l.value}${l.rest ?? ''}`} className={styles.tipPlain}>
            {l.value}
          </div>
        ) : (
          <div key={`${l.value}${l.rest ?? ''}`} className={styles.tipRow}>
            <i style={{ background: l.color }} aria-hidden="true" />
            <b>{l.value}</b>
            {l.rest ? `\u00a0${l.rest}` : null}
          </div>
        ),
      )}
    </div>
  );
}

/** Pointer and keyboard over a plot of `count` items: which one is shown, and the handlers. */
function useInspect(count: number, indexAt: (x: number) => number) {
  const [index, setIndex] = useState<number | null>(null);
  const clamp = useCallback((i: number) => Math.max(0, Math.min(count - 1, i)), [count]);
  return {
    index: index === null ? null : clamp(index),
    handlers: {
      onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
        const box = e.currentTarget.getBoundingClientRect();
        setIndex(clamp(indexAt(e.clientX - box.left)));
      },
      onPointerLeave: () => setIndex(null),
      onFocus: () => setIndex(count - 1),
      onBlur: () => setIndex(null),
      onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
        const moves: Record<string, (i: number) => number> = {
          ArrowLeft: (i) => i - 1,
          ArrowRight: (i) => i + 1,
          Home: () => 0,
          End: () => count - 1,
        };
        const move = moves[e.key];
        if (!move) return;
        e.preventDefault();
        setIndex((i) => clamp(move(i ?? count - 1)));
      },
    },
  };
}

const f1 = (n: number) => n.toFixed(1);

/** The index of the last non-null value, or -1. */
function lastIndexOf(values: readonly (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null && values[i] !== undefined) return i;
  return -1;
}

/** `M…L…` paths of the runs between gaps (null values). */
function runs(values: readonly (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  const out: { d: string; first: number; last: number }[] = [];
  let d = '';
  let first = -1;
  values.forEach((v, i) => {
    if (v === null) {
      if (d) out.push({ d, first, last: i - 1 });
      d = '';
      return;
    }
    if (!d) first = i;
    d += `${d ? 'L' : 'M'}${f1(x(i))} ${f1(y(v))}`;
  });
  if (d) out.push({ d, first, last: values.length - 1 });
  return out;
}

export interface LineSeries {
  key: string;
  /** A token, `var(--chart1)`. */
  color: string;
  values: readonly (number | null)[];
  area?: boolean;
  /** The tooltip's line for a value (`4 % busy`), split where the value ends. */
  line: (value: number) => { value: string; rest: string };
}

export interface LineChartProps {
  label: string;
  describedBy?: string;
  height: number;
  series: LineSeries[];
  /** The value axis: its top and three gridlines, and their words. */
  max: number;
  ticks: readonly number[];
  tickLabel: (v: number) => string;
  /** The time axis's words at point indexes. */
  timeTicks: readonly { index: number; label: string }[];
  /** A point's moment, the tooltip's first line. */
  pointLabel: (index: number) => string;
  /** The value axis's bottom (default 0): below zero for an outside temperature. */
  min?: number;
  /** The plot's margins for the axis words (default 34 · 6 · 6 · 20; Home's widgets 40 · 10 · 8 · 22). */
  frame?: { left: number; right: number; top: number; bottom: number };
  /**
   * `widget`: Home's pinned widgets (one-whombat-shell.md AP-1268) — gridlines in `--line2`, 1.8px lines and a dot at each
   * line's latest point, as mock 1 draws them.
   */
  look?: 'default' | 'widget';
}

const LINE = { left: 34, right: 6, top: 6, bottom: 20 } as const;

/** Lines (an area under the first when asked) with a crosshair, over a range's points. */
export function LineChart({
  label,
  describedBy,
  height,
  series,
  max,
  ticks,
  tickLabel,
  timeTicks,
  pointLabel,
  min = 0,
  frame = LINE,
  look = 'default',
}: LineChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = series[0]?.values.length ?? 0;
  const plotW = Math.max(1, width - frame.left - frame.right);
  const x = useCallback(
    (i: number) => frame.left + (n > 1 ? (i / (n - 1)) * plotW : 0),
    [n, plotW, frame.left],
  );
  const y = useCallback(
    (v: number) =>
      frame.top +
      (1 - (Math.max(min, Math.min(v, max)) - min) / (max - min || 1)) * (height - frame.top - frame.bottom),
    [min, max, height, frame.top, frame.bottom],
  );
  const widget = look === 'widget';
  const inspect = useInspect(n, (px) => Math.round(((px - frame.left) / plotW) * (n - 1)));

  // The marks don't change while the pointer moves: drawn once per answer and width.
  const marks = useMemo(
    () =>
      width === 0 ? null : (
        <>
          {ticks.map((v) => (
            <g key={v}>
              <line
                className={widget ? styles.gridStrong : styles.grid}
                x1={frame.left}
                x2={width - frame.right}
                y1={y(v)}
                y2={y(v)}
              />
              <text x={frame.left - (widget ? 8 : 6)} y={y(v) + (widget ? 4 : 3.5)} textAnchor="end">
                {tickLabel(v)}
              </text>
            </g>
          ))}
          {fitTimeTicks(timeTicks, x).map((t) => (
            <text
              key={t.index}
              x={x(t.index)}
              y={height - (widget ? 4 : 5)}
              textAnchor={t.index === 0 ? 'start' : t.index === n - 1 ? 'end' : 'middle'}
            >
              {t.label}
            </text>
          ))}
          {series.map((s) =>
            runs(s.values, x, y).map((r) => (
              <g key={`${s.key}${r.first}`}>
                {s.area ? (
                  <path
                    d={`${r.d}L${f1(x(r.last))} ${f1(y(0))}L${f1(x(r.first))} ${f1(y(0))}Z`}
                    style={{ fill: s.color, fillOpacity: 'var(--chartWash)' }}
                  />
                ) : null}
                <path
                  className={widget ? styles.lineThin : styles.line}
                  d={r.d}
                  style={{ stroke: s.color }}
                />
              </g>
            )),
          )}
          {widget &&
            series.map((s) => {
              const last = lastIndexOf(s.values);
              const v = last < 0 ? null : s.values[last];
              return v === null || v === undefined ? null : (
                <circle key={`${s.key}-end`} cx={x(last)} cy={y(v)} r={3.5} style={{ fill: s.color }} />
              );
            })}
        </>
      ),
    [width, ticks, tickLabel, timeTicks, series, x, y, height, n, frame, widget],
  );

  const i = inspect.index;
  const tip: Tip | null =
    i === null
      ? null
      : {
          title: pointLabel(i),
          lines: series.flatMap((s) => {
            const v = s.values[i];
            return v === null || v === undefined ? [] : [{ color: s.color, ...s.line(v) }];
          }),
        };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a chart read with the keyboard, not a set of form fields
    <div
      ref={ref}
      className={styles.plot}
      style={{ height }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart is read point by point with the arrow keys
      tabIndex={0}
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      {...inspect.handlers}
    >
      <svg width="100%" height={height} aria-hidden="true" className={styles.svg}>
        {marks}
        {i !== null ? (
          <g>
            <line className={styles.cross} x1={x(i)} x2={x(i)} y1={frame.top} y2={height - frame.bottom} />
            {series.map((s) => {
              const v = s.values[i];
              return v === null || v === undefined ? null : (
                <circle
                  key={s.key}
                  className={styles.dot}
                  cx={x(i)}
                  cy={y(v)}
                  r={4}
                  style={{ fill: s.color }}
                />
              );
            })}
          </g>
        ) : null}
      </svg>
      {tip && tip.lines.length > 0 ? <Tooltip tip={tip} x={x(i ?? 0)} top={54} plot={ref} /> : null}
    </div>
  );
}

export interface ColumnPart<R> {
  key: string;
  color: string;
  value: (row: R) => number;
}

export interface ColumnChartProps<R> {
  label: string;
  describedBy?: string;
  height: number;
  rows: readonly R[];
  rowKey: (row: R) => string;
  /** Bottom first. */
  parts: ColumnPart<R>[];
  max: number;
  /** The value axis (none: the columns fill the frame, as the Tokens card's). */
  axis?: { ticks: readonly number[]; label: (v: number) => string };
  /** Under each column (often empty). */
  columnLabel?: (row: R) => string;
  tip: (row: R) => Tip;
}

/** A column with a rounded top (`r`, 0: square), from `bottom` up to `top`. */
function columnPath(cx: number, w: number, top: number, bottom: number, r: number): string {
  const h = Math.max(1, bottom - top);
  const rr = Math.min(r, h / 2, w / 2);
  const l = cx - w / 2;
  return `M${f1(l)} ${f1(top + h)}V${f1(top + rr)}q0 ${f1(-rr)} ${f1(rr)} ${f1(-rr)}H${f1(l + w - rr)}q${f1(rr)} 0 ${f1(rr)} ${f1(rr)}V${f1(top + h)}Z`;
}

/** Columns per day, single or stacked, with one tooltip for the column under the pointer. */
export function ColumnChart<R>({
  label,
  describedBy,
  height,
  rows,
  rowKey,
  parts,
  max,
  axis,
  columnLabel,
  tip,
}: ColumnChartProps<R>) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const left = axis ? 34 : 2;
  const right = 2;
  const top = 4;
  const bottom = axis ? 20 : 4;
  const n = rows.length;
  const band = Math.max(1, (width - left - right) / Math.max(1, n));
  const bw = Math.min(18, band * 0.62);
  const y = (v: number) => top + (1 - Math.min(v, max) / max) * (height - top - bottom);
  const center = (i: number) => left + band * i + band / 2;
  const inspect = useInspect(n, (px) => Math.floor((px - left) / band));
  const i = inspect.index;
  const row = i === null ? undefined : rows[i];

  return (
    // biome-ignore lint/a11y/useSemanticElements: a chart read with the keyboard, not a set of form fields
    <div
      ref={ref}
      className={styles.plot}
      style={{ height }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart is read column by column with the arrow keys
      tabIndex={0}
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      {...inspect.handlers}
    >
      {width > 0 ? (
        <svg width="100%" height={height} aria-hidden="true" className={styles.svg}>
          {axis?.ticks.map((v) => (
            <g key={v}>
              <line className={styles.grid} x1={left} x2={width - right} y1={y(v)} y2={y(v)} />
              <text x={left - 6} y={y(v) + 3.5} textAnchor="end">
                {axis.label(v)}
              </text>
            </g>
          ))}
          {rows.map((r, k) => {
            const cx = center(k);
            const values = parts.map((p) => p.value(r));
            const topmost = values.reduce((last, v, j) => (v > 0 ? j : last), -1);
            let acc = 0;
            return (
              <g key={rowKey(r)} className={k === i ? styles.hot : undefined}>
                {parts.map((p, j) => {
                  const v = values[j] ?? 0;
                  if (v <= 0) return null;
                  const y0 = y(acc);
                  const y1 = y(acc + v);
                  acc += v;
                  // A part above another starts 2px higher: the surface shows between them.
                  const b = j > 0 && acc - v > 0 ? y0 - 2 : y0;
                  return (
                    <path
                      key={p.key}
                      d={columnPath(cx, bw, Math.min(y1, b - 1), b, j === topmost ? 4 : 0)}
                      style={{ fill: p.color }}
                    />
                  );
                })}
              </g>
            );
          })}
          {axis && columnLabel
            ? rows.map((r, k) => {
                const words = columnLabel(r);
                if (!words) return null;
                const last = k === n - 1;
                return (
                  <text
                    key={rowKey(r)}
                    x={last ? center(k) + bw / 2 + 2 : center(k)}
                    y={height - 5}
                    textAnchor={last ? 'end' : 'middle'}
                  >
                    {words}
                  </text>
                );
              })
            : null}
        </svg>
      ) : null}
      {row !== undefined && i !== null ? <Tooltip tip={tip(row)} x={center(i)} top={40} plot={ref} /> : null}
    </div>
  );
}

/** A tile's sparkline (every third point, the last one dotted), muted, scaled to its own top. */
export function Sparkline({ values, color }: { values: readonly (number | null)[]; color: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const H = 26;
  // Every third point, counted back from the latest so it is always drawn.
  const picked = values.filter((_, i) => (values.length - 1 - i) % 3 === 0);
  const top = Math.max(0, ...picked.map((v) => v ?? 0));
  const x = (i: number) => (picked.length > 1 ? (i / (picked.length - 1)) * (width - 4) + 2 : width - 2);
  const y = (v: number) => H - 3 - (top > 0 ? v / top : 0) * (H - 6);
  const lastIndex = picked.length - 1;
  const last = picked[lastIndex];
  return (
    <div ref={ref} className={styles.spark} aria-hidden="true">
      {width > 0 ? (
        <svg width="100%" height={H} aria-hidden="true">
          {runs(picked, x, y).map((r) => (
            <path key={r.first} className={styles.sparkLine} d={r.d} />
          ))}
          {last !== null && last !== undefined ? (
            <circle
              className={styles.sparkDot}
              cx={x(lastIndex)}
              cy={y(last)}
              r={3}
              style={{ fill: color }}
            />
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}

/** A tile's meter: the share used, in the first chart colour. */
export function Meter({ pct }: { pct: number }) {
  return (
    <div className={styles.meter} aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

/** The disk's bar: its parts side by side by size, 2px apart, rounded at both ends. */
export function StackBar({ parts }: { parts: readonly { key: string; bytes: number; color: string }[] }) {
  return (
    <div className={styles.stack} aria-hidden="true">
      {parts.map((p) => (
        <i key={p.key} style={{ flex: p.bytes, background: p.color } as CSSProperties} />
      ))}
    </div>
  );
}

/** A chart as a table (“Show as a table”): a caption for screen readers, the rows in a box as tall as the chart. */
export function ChartTable({
  caption,
  head,
  rows,
  height,
}: {
  caption: string;
  head: readonly string[];
  rows: readonly { key: string; cells: readonly ReactNode[] }[];
  height: number;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region is reached with the keyboard to scroll it
    <section className={styles.tableBox} style={{ height }} tabIndex={0} aria-label={caption}>
      <table className={styles.table}>
        <caption className={styles.srOnly}>{caption}</caption>
        <thead>
          <tr>
            {head.map((h, k) => (
              <th key={h} scope="col" className={cx(k > 0 && styles.num)}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((c, k) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells, in column order
                <td key={k} className={cx(k > 0 && styles.num)}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
