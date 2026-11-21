// Line chart for the detail pages (DESIGN-SYSTEM.md 6, SCREENS.md 3.3/3.4):
// one y-axis, 2 px lines, optional 10% area, hairline grid with 4 intervals,
// five x labels, crosshair + dot(s) + tooltip on hover resting at ~72% of the
// range, arrow-key navigation on the focused plot (role="slider"), optional
// solid limit line with label, optional direct end labels, `null` = gap.
// "View as table" is rendered by the parent card (prop `showTable`).

import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Range, SeriesValues } from '../api/types';
import { gridPath, restIndex, seriesPaths, spreadLabels } from '../lib/chart';
import { formatTick, formatTooltipTime } from '../lib/format';
import { t } from '../lib/i18n';

/** Optional chart behaviour shared by a page's charts: markers, drag-to-zoom, and the tick range and end label of a zoomed window. */
export interface ChartExtras {
  marks?: ChartMark[];
  onZoom?: (i0: number, i1: number) => void;
  endTick?: string;
  range?: Range;
}

/** TimeChart props from ChartExtras (spread after `range` so a zoomed window's tick range wins). */
export function chartProps(c: ChartExtras | undefined): Partial<Pick<Props, 'marks' | 'onZoom' | 'endTick' | 'range'>> {
  if (!c) return {};
  return { marks: c.marks, onZoom: c.onZoom, ...(c.endTick ? { endTick: c.endTick } : {}), ...(c.range ? { range: c.range } : {}) };
}

/** A marker at a bucket (an alert, a reboot, an action). */
export interface ChartMark {
  i: number;
  color: string;
  text: string;
}

export interface ChartSeries {
  key: string;
  /** Full name for the table header and screen readers ("CPU package"). */
  label: string;
  /** Short name for the tooltip and end label ("CPU"). */
  short: string;
  color: string;
  values: SeriesValues;
}

interface Props {
  /** Accessible name of the plot ("CPU usage"). */
  title: string;
  range: Range;
  timestamps: string[];
  series: ChartSeries[];
  yMin: number;
  yMax: number;
  /** Tick labels top to bottom (5 for 4 intervals). */
  yLabels: string[];
  height: number;
  area?: boolean;
  limit?: { value: number; label: string } | null;
  /** More limit lines (dashed, in their series' color), e.g. other sensors near their own limit. */
  limits?: { value: number; label: string; color: string }[];
  endLabels?: boolean;
  /** Shared hover index (null = resting position). */
  hover: number | null;
  onHover: (i: number | null) => void;
  formatValue: (v: number) => string;
  /** Second tooltip line for single-series charts ("of 48 threads"). */
  tooltipSub?: (v: number) => string | null;
  tooltipPlacement?: 'top' | 'bottom';
  showTable?: boolean;
  /** 'hover': the tooltip shows only while the pointer or keyboard moves the crosshair (compact charts); default always. */
  tooltip?: 'always' | 'hover';
  /** Drag across the plot (mouse) to zoom: first and last bucket index of the selection. */
  onZoom?: (i0: number, i1: number) => void;
  /** Markers drawn as faint vertical lines and listed in the tooltip. */
  marks?: ChartMark[];
  /** Label of the last x tick (default "Now"; zoomed windows end earlier). */
  endTick?: string;
}

const VB_W = 1000;
const END_LABEL_W = 64;

export function TimeChart({
  title,
  range,
  timestamps,
  series,
  yMin,
  yMax,
  yLabels,
  height,
  area = false,
  limit = null,
  limits,
  endLabels = false,
  hover,
  onHover,
  formatValue,
  tooltipSub,
  tooltipPlacement = 'top',
  showTable = false,
  tooltip = 'always',
  onZoom,
  marks,
  endTick = t('Now'),
}: Props) {
  const n = timestamps.length;
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const rest = useMemo(() => restIndex(n, (i) => series.some((s) => s.values[i] != null)), [n, series]);
  const idx = n ? Math.min(hover ?? rest, n - 1) : 0;
  const xPct = n > 1 ? (idx / (n - 1)) * 100 : 50;
  const topPct = (v: number) => (1 - (Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * 100;

  const paths = useMemo(
    () => series.map((s) => ({ key: s.key, color: s.color, ...seriesPaths(s.values, yMin, yMax, VB_W, height) })),
    [series, yMin, yMax, height],
  );
  const grid = useMemo(() => gridPath(VB_W, height, 4), [height]);

  const ticks = useMemo(() => {
    if (n < 2) return [];
    const t0 = Date.parse(timestamps[0] ?? '');
    const t1 = Date.parse(timestamps[n - 1] ?? '');
    return [0, 1, 2, 3, 4].map((k) => (k === 4 ? endTick : formatTick(range, t0 + ((t1 - t0) * k) / 4)));
  }, [timestamps, n, range, endTick]);

  const endTops = useMemo(() => {
    if (!endLabels) return [];
    const raw = series.map((s) => {
      let last: number | null = null;
      for (let i = s.values.length - 1; i >= 0; i--) {
        const v = s.values[i];
        if (v != null) {
          last = v;
          break;
        }
      }
      return last == null ? -1 : (topPct(last) / 100) * height;
    });
    const shown = raw.filter((t) => t >= 0);
    const spread = spreadLabels(shown, 15, height);
    let k = 0;
    return raw.map((t) => (t < 0 ? null : spread[k++] ?? t));
  }, [series, endLabels, height, yMin, yMax]);

  // Place the tooltip beside the crosshair (flipping left past 58% of the
  // width) and keep it inside the chart block on narrow screens.
  const placeTip = useRef<() => void>(() => {});
  placeTip.current = () => {
    const plot = plotRef.current;
    const tip = tipRef.current;
    if (!plot || !tip) return;
    const W = plot.clientWidth;
    const tw = tip.offsetWidth;
    const x = (xPct / 100) * W;
    const desired = xPct > 58 ? x - tw - 16 : x + 16;
    const minLeft = -44;
    const maxLeft = Math.max(minLeft, W + (endLabels ? END_LABEL_W : 0) - tw);
    tip.style.left = `${Math.min(maxLeft, Math.max(minLeft, desired))}px`;
  };
  useLayoutEffect(() => placeTip.current());
  useLayoutEffect(() => {
    const plot = plotRef.current;
    if (!plot || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => placeTip.current());
    ro.observe(plot);
    return () => ro.disconnect();
  }, [showTable]);

  const time = n ? formatTooltipTime(range, Date.parse(timestamps[idx] ?? '')) : '';
  const valueAt = (s: ChartSeries): number | null => s.values[idx] ?? null;
  const valueText = series
    .map((s) => {
      const v = valueAt(s);
      return `${s.short} ${v == null ? t('no data') : formatValue(v)}`;
    })
    .join(', ');

  const indexFromEvent = (e: PointerEvent<HTMLDivElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / Math.max(1, r.width);
    return Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    const step = Math.max(1, Math.round(n / 10));
    const cur = hover ?? rest;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + 1;
    else if (e.key === 'PageDown') next = cur - step;
    else if (e.key === 'PageUp') next = cur + step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      onHover(null);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      onHover(Math.max(0, Math.min(n - 1, next)));
    }
  };

  if (showTable) {
    return (
      <div className="chart-table-wrap" style={{ maxHeight: height + 32 }}>
        <table className="chart-table">
          <caption className="sr-only">{t('{title}, values over the selected range', { title })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('Time')}</th>
              {series.map((s) => (
                <th scope="col" key={s.key}>
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {timestamps.map((ts, i) => (
              <tr key={ts}>
                <th scope="row">{formatTooltipTime(range, Date.parse(ts))}</th>
                {series.map((s) => {
                  const v = s.values[i];
                  return <td key={s.key}>{v == null ? t('no data') : formatValue(v)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const single = series.length === 1 ? series[0] : undefined;
  const singleV = single ? valueAt(single) : null;
  const marksHere = (marks ?? []).filter((m) => m.i === idx).slice(0, 3);

  return (
    <div className="tchart">
      <div className="tchart-row">
        <div className="tchart-y" style={{ height }} aria-hidden="true">
          {yLabels.map((l, k) => (
            <span key={k} className="yt" style={{ top: `${(k / (yLabels.length - 1)) * 100}%` }}>
              {l}
            </span>
          ))}
        </div>
        <div
          ref={plotRef}
          className="tchart-plot"
          style={{ height }}
          tabIndex={n ? 0 : -1}
          role="slider"
          aria-label={t('{title} chart. Use the arrow keys to read values.', { title })}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, n - 1)}
          aria-valuenow={idx}
          aria-valuetext={n ? `${time}: ${valueText}` : t('No data')}
          aria-orientation="horizontal"
          onPointerMove={(e) => {
            if (!n) return;
            const i = indexFromEvent(e);
            onHover(i);
            if (sel) setSel({ a: sel.a, b: i });
          }}
          onPointerDown={(e) => {
            if (!n) return;
            const i = indexFromEvent(e);
            onHover(i);
            if (onZoom && e.pointerType === 'mouse' && e.button === 0) {
              e.currentTarget.setPointerCapture(e.pointerId);
              setSel({ a: i, b: i });
            }
          }}
          onPointerUp={() => {
            if (sel && onZoom && Math.abs(sel.b - sel.a) >= 2) onZoom(Math.min(sel.a, sel.b), Math.max(sel.a, sel.b));
            setSel(null);
          }}
          onPointerCancel={() => setSel(null)}
          onPointerLeave={() => {
            if (!sel) onHover(null);
          }}
          onKeyDown={onKey}
          onBlur={() => onHover(null)}
        >
          <svg viewBox={`0 0 ${VB_W} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <path className="hair" d={grid} style={{ stroke: 'var(--line)' }} />
            {limit && (
              <path
                className="hair"
                d={`M0 ${((topPct(limit.value) / 100) * height).toFixed(1)}L${VB_W} ${((topPct(limit.value) / 100) * height).toFixed(1)}`}
                style={{ stroke: 'var(--warning)', strokeOpacity: 0.7 }}
              />
            )}
            {limits?.map((l) => (
              <path
                key={`lim-${l.label}`}
                className="hair"
                d={`M0 ${((topPct(l.value) / 100) * height).toFixed(1)}L${VB_W} ${((topPct(l.value) / 100) * height).toFixed(1)}`}
                style={{ stroke: l.color, strokeOpacity: 0.6, strokeDasharray: '6 5' }}
              />
            ))}
            {area && paths.map((p) => p.area && <path key={`a-${p.key}`} d={p.area} style={{ fill: p.color, fillOpacity: 0.1, stroke: 'none' }} />)}
            {[...paths].reverse().map((p) => p.line && <path key={`l-${p.key}`} className="ln ln-2" d={p.line} style={{ stroke: p.color }} />)}
          </svg>
          {limit && (
            <span className="lbl tchart-limit" style={{ top: `${topPct(limit.value)}%` }} aria-hidden="true">
              {limit.label}
            </span>
          )}
          {limits?.map((l) => (
            <span key={`liml-${l.label}`} className="lbl tchart-limit is-right" style={{ top: `${topPct(l.value)}%`, color: l.color }} aria-hidden="true">
              {l.label}
            </span>
          ))}
          {n > 1 &&
            marks?.map((m, k) => <div key={k} className="tchart-mark" style={{ left: `${(m.i / (n - 1)) * 100}%`, background: m.color }} aria-hidden="true" />)}
          {sel && sel.a !== sel.b && n > 1 && (
            <div
              className="tchart-sel"
              style={{ left: `${(Math.min(sel.a, sel.b) / (n - 1)) * 100}%`, width: `${(Math.abs(sel.b - sel.a) / (n - 1)) * 100}%` }}
              aria-hidden="true"
            />
          )}
          {n > 0 && (
            <>
              <div className="tchart-cross" style={{ left: `${xPct}%` }} aria-hidden="true" />
              {series.map((s) => {
                const v = valueAt(s);
                return v == null ? null : (
                  <div key={s.key} className="tchart-dot" style={{ left: `${xPct}%`, top: `${topPct(v)}%`, background: s.color }} aria-hidden="true" />
                );
              })}
              <div
                ref={tipRef}
                className={`tchart-tip ${tooltipPlacement === 'bottom' ? 'is-bottom' : ''} ${single ? '' : 'is-multi'}`}
                aria-hidden="true"
                style={tooltip === 'hover' && hover === null ? { display: 'none' } : undefined}
              >
                <div className="lbl">{time}</div>
                {marksHere.map((m, k) => (
                  <div key={k} className="tip-mark">
                    <span className="key" style={{ background: m.color }} />
                    {m.text}
                  </div>
                ))}
                {single ? (
                  <>
                    <div className="tip-main">
                      <span className="key" style={{ background: single.color }} />
                      <span className="tip-value">{singleV == null ? t('No data') : formatValue(singleV)}</span>
                    </div>
                    {singleV != null && tooltipSub && tooltipSub(singleV) && <div className="lbl tip-sub">{tooltipSub(singleV)}</div>}
                  </>
                ) : (
                  <div className="tip-rows">
                    {series.map((s) => {
                      const v = valueAt(s);
                      return (
                        <div key={s.key} className="tip-row">
                          <span className="key" style={{ background: s.color }} />
                          <span className="ink-2">{s.short}</span>
                          <span className="tip-row-v">{v == null ? t('no data') : formatValue(v)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        {endLabels && (
          <div className="tchart-end" style={{ height, width: END_LABEL_W }} aria-hidden="true">
            {series.map((s, i) => {
              const t = endTops[i];
              return t == null ? null : (
                <span key={s.key} style={{ top: t }}>
                  {s.short}
                </span>
              );
            })}
          </div>
        )}
      </div>
      <div className="tchart-x" style={{ marginRight: endLabels ? END_LABEL_W : 0 }} aria-hidden="true">
        {ticks.map((t, k) => (
          <span key={k}>{t}</span>
        ))}
      </div>
    </div>
  );
}
