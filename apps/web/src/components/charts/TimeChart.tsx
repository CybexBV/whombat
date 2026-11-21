/**
 * The one chart of history over time (servers' temperatures, load, memory, every Summary's chart cards; ported from
 * Rackoon's `components/TimeChart.tsx`, grown for the dashboards, dashboards-web.md AP-2050…): value words on the left
 * in DM Mono 11px `--mut`, gridlines in `--line2` (`--line` when `soft`), 1.8px lines with an optional area wash or
 * stacked bars per point (`bars`), a dot on the newest point, dashed limit lines with their own colour and words, a
 * dashed line to where the last value is heading (`forecast`, the time axis running on to it), and the time axis's
 * words that fit. A null sample is a gap. The plot is read point by point: the pointer moves a crosshair with one
 * tooltip listing every series in its own words; the keyboard reaches it once and walks it with the arrow keys (focus
 * shows the newest point). Colours are tokens only (AP-1305).
 */
import { seriesPaths } from '@whombat/client/hosts';
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cx } from '../cx';
import { fitTimeTicks } from './fitTimeTicks';
import styles from './TimeChart.module.css';

export interface TimeSeries {
  key: string;
  /** What the tooltip calls it (“CPU package”). */
  label: string;
  /** A token: `var(--chart2)`. */
  color: string;
  values: readonly (number | null)[];
  /** An area wash under the line. */
  area?: boolean;
  /** Its values in words for the tooltip (else the chart's `formatValue`). */
  format?: (v: number) => string;
}

export interface TimeLine {
  value: number;
  /** A token: `var(--warn)`. */
  color: string;
  /** Written over the line (nothing when absent): at its right end, or its start (`labelAt`). */
  label?: string;
  labelAt?: 'start' | 'end';
}

/** Where the last value is heading: a dashed line from the newest point to `value` at the domain's end. */
export interface TimeForecast {
  value: number;
  /** A token. */
  color: string;
  /** Written left of its end (“full ~18 Dec”). */
  label?: string;
}

export interface TimeChartProps {
  /** The plot's accessible name (“CPU temperature, last 24 hours”). */
  label: string;
  height: number;
  series: readonly TimeSeries[];
  min: number;
  max: number;
  /** Values with a gridline and a word. */
  ticks: readonly number[];
  tickLabel: (v: number) => string;
  /** The time axis's words at point indexes. */
  timeTicks: readonly { index: number; label: string }[];
  /** A point's moment, the tooltip's first line. */
  pointLabel: (index: number) => string;
  formatValue: (v: number) => string;
  /** Dashed lines (a warm line, a limit). */
  lines?: readonly TimeLine[];
  /** A dot on each series' newest point (default true). */
  endDots?: boolean;
  /** Stacked bars per point instead of lines (counts: errors an hour). */
  bars?: boolean;
  /** Point indexes the time axis runs on past the newest point (a forecast's). */
  extend?: number;
  forecast?: TimeForecast;
  /** The room around the plot for its words. */
  pad?: { left: number; right: number; top: number; bottom: number };
  /** Fainter gridlines (`--line`), as a Summary's chart cards draw them. */
  soft?: boolean;
}

const DEFAULT_PAD = { left: 40, right: 10, top: 8, bottom: 22 } as const;

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

function lastIndex(values: readonly (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
  return -1;
}

export function TimeChart({
  label,
  height,
  series,
  min,
  max,
  ticks,
  tickLabel,
  timeTicks,
  pointLabel,
  formatValue,
  lines,
  endDots = true,
  bars = false,
  extend = 0,
  forecast,
  pad = DEFAULT_PAD,
  soft = false,
}: TimeChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  /** The time axis's length in point steps: the points', and a forecast's past them. */
  const domain = Math.max(0, n - 1) + Math.max(0, extend);
  /** Bars: a band per point. */
  const band = n ? plotW / n : plotW;
  const x = useCallback(
    (i: number) =>
      bars ? pad.left + (i + 0.5) * band : pad.left + (domain > 0 ? (i / domain) * plotW : plotW / 2),
    [bars, band, domain, plotW, pad.left],
  );
  const y = useCallback(
    (v: number) => pad.top + plotH - ((Math.max(min, Math.min(max, v)) - min) / (max - min || 1)) * plotH,
    [min, max, plotH, pad.top],
  );
  const [index, setIndex] = useState<number | null>(null);
  const clamp = useCallback((i: number) => Math.max(0, Math.min(n - 1, i)), [n]);

  // The marks don't change while the pointer moves: drawn once per answer and width.
  const marks = useMemo(() => {
    if (width === 0 || n === 0) return null;
    // A line's x runs over its points; the domain may run on past them (a forecast).
    const lineW = n > 1 && domain > 0 ? (plotW * (n - 1)) / domain : plotW;
    return (
      <>
        {ticks.map((v) => (
          <g key={v}>
            <line className={styles.grid} x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} />
            <text x={pad.left - 8} y={y(v) + 4} textAnchor="end">
              {tickLabel(v)}
            </text>
          </g>
        ))}
        {fitTimeTicks(timeTicks, x).map((t, k, shown) => (
          <text
            key={t.index}
            x={x(t.index)}
            y={height - 4}
            textAnchor={k === 0 ? 'start' : k === shown.length - 1 ? 'end' : 'middle'}
          >
            {t.label}
          </text>
        ))}
        {lines?.map((l) => (
          <g key={`${l.value}${l.color}`}>
            <line
              className={styles.limit}
              x1={pad.left}
              x2={width - pad.right}
              y1={y(l.value)}
              y2={y(l.value)}
              style={{ stroke: l.color }}
            />
            {l.label ? (
              <text
                x={l.labelAt === 'start' ? pad.left + 6 : width - pad.right - 4}
                y={y(l.value) - 6}
                textAnchor={l.labelAt === 'start' ? 'start' : 'end'}
                style={{ fill: l.color }}
              >
                {l.label}
              </text>
            ) : null}
          </g>
        ))}
        {bars
          ? Array.from({ length: n }, (_, i) => {
              let acc = 0;
              const w = Math.max(1, band - Math.min(4, band * 0.25));
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: one stack per point, in time order
                <g key={i}>
                  {series.map((s, j) => {
                    const v = s.values[i];
                    if (v == null || v <= 0) return null;
                    const y0 = y(acc);
                    acc += v;
                    const y1 = y(acc);
                    return (
                      <rect
                        key={s.key}
                        x={x(i) - w / 2}
                        y={y1}
                        width={w}
                        height={Math.max(0, y0 - y1)}
                        rx={Math.min(2, w / 3)}
                        style={{ fill: s.color, opacity: j === 0 ? 0.9 : 0.55 }}
                      />
                    );
                  })}
                </g>
              );
            })
          : series.map((s) => {
              const p = seriesPaths(s.values, min, max, lineW, plotH);
              const last = lastIndex(s.values);
              const lv = last >= 0 ? s.values[last] : null;
              return (
                <g key={s.key} transform={`translate(${pad.left} ${pad.top})`}>
                  {s.area && p.area ? (
                    <path className={styles.area} d={p.area} style={{ fill: s.color }} />
                  ) : null}
                  {p.line ? <path className={styles.line} d={p.line} style={{ stroke: s.color }} /> : null}
                  {endDots && lv != null ? (
                    <circle cx={x(last) - pad.left} cy={y(lv) - pad.top} r={3.5} style={{ fill: s.color }} />
                  ) : null}
                </g>
              );
            })}
        {forecast && !bars
          ? (() => {
              const from = series[0] ? lastIndex(series[0].values) : -1;
              const fv = from >= 0 ? series[0]?.values[from] : null;
              if (fv == null) return null;
              const ex = x(domain);
              const ey = y(forecast.value);
              return (
                <g>
                  <line
                    className={styles.forecast}
                    x1={x(from)}
                    y1={y(fv)}
                    x2={ex}
                    y2={ey}
                    style={{ stroke: forecast.color }}
                  />
                  <circle cx={ex} cy={ey} r={3.5} style={{ fill: forecast.color }} />
                  {forecast.label ? (
                    <text x={ex - 9} y={ey + 4} textAnchor="end" style={{ fill: forecast.color }}>
                      {forecast.label}
                    </text>
                  ) : null}
                </g>
              );
            })()
          : null}
      </>
    );
  }, [
    width,
    n,
    domain,
    ticks,
    tickLabel,
    timeTicks,
    lines,
    series,
    min,
    max,
    plotW,
    plotH,
    x,
    y,
    height,
    endDots,
    bars,
    band,
    forecast,
    pad,
  ]);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left - pad.left;
    setIndex(clamp(bars ? Math.floor(px / band) : Math.round((px / plotW) * domain)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = Math.max(1, Math.round(n / 12));
    const moves: Record<string, (i: number) => number> = {
      ArrowLeft: (i) => i - 1,
      ArrowRight: (i) => i + 1,
      PageDown: (i) => i - step,
      PageUp: (i) => i + step,
      Home: () => 0,
      End: () => n - 1,
    };
    if (e.key === 'Escape') return setIndex(null);
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    setIndex((i) => clamp(move(i ?? n - 1)));
  };

  const i = index;
  const rows =
    i === null
      ? []
      : series.flatMap((s) => {
          const v = s.values[i];
          return v == null
            ? []
            : [{ key: s.key, color: s.color, label: s.label, value: (s.format ?? formatValue)(v) }];
        });
  const tipLeft = i === null ? 0 : x(i) > width * 0.6 ? x(i) - 14 : x(i) + 14;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a chart read with the keyboard, not a set of form fields
    <div
      ref={ref}
      className={styles.plot}
      style={{ height }}
      tabIndex={n ? 0 : -1}
      role="group"
      aria-label={label}
      onPointerMove={n ? onPointerMove : undefined}
      onPointerLeave={() => setIndex(null)}
      onFocus={() => setIndex(n - 1)}
      onBlur={() => setIndex(null)}
      onKeyDown={onKeyDown}
    >
      <svg width="100%" height={height} aria-hidden="true" className={cx(styles.svg, soft && styles.soft)}>
        {marks}
        {i !== null ? (
          <g>
            <line className={styles.cross} x1={x(i)} x2={x(i)} y1={pad.top} y2={height - pad.bottom} />
            {series.map((s) => {
              const v = s.values[i];
              return v == null || bars ? null : (
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
      {i !== null && rows.length ? (
        <div
          className={styles.tip}
          style={{ left: tipLeft, top: 4, transform: x(i) > width * 0.6 ? 'translateX(-100%)' : undefined }}
          aria-live="polite"
        >
          <div className={styles.tipTitle}>{pointLabel(i)}</div>
          {rows.map((r) => (
            <div key={r.key} className={styles.tipRow}>
              <i style={{ background: r.color }} aria-hidden="true" />
              <b>{r.value}</b>
              {series.length > 1 ? ` ${r.label}` : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
