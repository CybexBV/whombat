/**
 * A chart card as the web draws it (Whombat dashboards.md DS-06; contracts 0.89 CT-395; dashboards-web.md AP-2050…):
 * the colours by name (blue, orange, green, violet in order when a line has none), the left axis's three gridlines from
 * the card's fixed ends and unit (`axis`) or round numbers over what is drawn, a second unit mapped onto the left's
 * scale (a 0.88 card), stacked bars for counts, the dashed line where it gets serious, where the last value is heading
 * (`forecast`, the time axis running on to it), every value in words with its unit (DS-15: one decimal under 10, none
 * above, thousands separated), and the time axis's words from the timestamps' own span. Pure.
 */
import { thingSeriesToken } from '@whombat/client';
import { formatTick, formatTooltipTime } from '@whombat/client/hosts';
import type { HostSeriesRange, ThingPagePanel, ThingSeriesColor } from '@whombat/core';
import { toDate } from '@whombat/core/text';

export type ChartPanel = Extract<ThingPagePanel, { kind: 'chart' }>;

/**
 * A colour by its contract name as a CSS token (`thingSeriesToken`, shared with the phone; DS-18: violet is `chart4`);
 * without one, blue, orange, green, violet in order.
 */
export function seriesColor(color: ThingSeriesColor | null | undefined, index = 0): string {
  return `var(--${thingSeriesToken(color, index)})`;
}

export interface ChartAxis {
  min: number;
  max: number;
  ticks: number[];
  label: (v: number) => string;
}

export interface ChartLine {
  key: string;
  label: string;
  unit: string | null;
  axis: 'left' | 'right';
  /** A token. */
  color: string;
  /** A soft wash under it. */
  fill: boolean;
  values: (number | null)[];
  /** On the left axis's scale: a right-axis line mapped onto it. */
  plotted: (number | null)[];
  /** The legend's figure: the server's, else the last value in words. */
  latest: string | null;
  /** A value in words (“18 %”, “3.0 GB”, “11,280”). */
  format: (v: number) => string;
  /** A plotted value (left scale) in this line's own words: the tooltip's. */
  formatPlotted: (v: number) => string;
}

export interface ChartModel {
  /** In the panel's order: the legend's. */
  lines: ChartLine[];
  /** In drawing order: a right axis's lines behind the left's. */
  drawn: ChartLine[];
  left: ChartAxis;
  right: ChartAxis | null;
  bars: boolean;
  limit: { value: number; label: string | null } | null;
  /** Where the last value is heading, `extend` steps after the last point. */
  forecast: { value: number; label: string; extend: number } | null;
  /** The time axis's words at point indexes (fractional past the end for a forecast). */
  ticks: { index: number; label: string }[];
  /** A point's moment in words, the tooltip's first line. */
  pointLabel: (index: number) => string;
  /** Nothing read yet. */
  empty: boolean;
}

const NBSP = ' ';
const NICE = [1, 2, 2.5, 5, 10];
const HOUR = 3_600_000;

function niceAtLeast(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw > 0 ? raw : 1));
  for (const m of NICE) if (m * pow >= raw - 1e-12) return m * pow;
  return 10 * pow;
}

/** A number in DS-15's words: one decimal under 10 when the values have them, none above, thousands separated. */
export function formatFigure(v: number, decimals: boolean): string {
  const abs = Math.abs(v);
  if (decimals && abs < 10) return v.toFixed(1);
  return Math.round(v).toLocaleString('en-GB');
}

/** An axis word, dense as the mock writes them: `50%`, `60°`, `8 GB`, or the bare number (`500`). */
export function tickWords(unit: string | null): (v: number) => string {
  const n = (v: number) => String(Math.round(v * 100) / 100);
  if (unit === '%') return (v) => `${n(v)}%`;
  if (unit?.startsWith('°')) return (v) => `${n(v)}°`;
  if (unit && unit.length <= 2) return (v) => `${n(v)}${NBSP}${unit}`;
  return n;
}

/**
 * Three gridlines (two gaps) over `values`: the card's fixed ends where it gives them, else from 0 (or below a negative)
 * to a round number 7 % over the top — a percentage at most 100 — and readings that stay far from 0 (a pool's pH) get
 * an axis around them.
 */
export function axisOver(
  values: readonly number[],
  unit: string | null,
  fixed: { min?: number | undefined; max?: number | undefined } = {},
  gaps = 2,
): Omit<ChartAxis, 'label'> {
  const { min: lowest, max: highest } = fixed;
  if (lowest !== undefined && highest !== undefined && highest > lowest) {
    const step = (highest - lowest) / gaps;
    return {
      min: lowest,
      max: highest,
      ticks: Array.from({ length: gaps + 1 }, (_, k) => Math.round((lowest + k * step) * 1000) / 1000),
    };
  }
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const least = values.length ? Math.min(...values) : 0;
  const near = fixed.min === undefined && unit !== '%' && least > 0 && least > hi / 2;
  const span = hi - least || Math.abs(hi) || 1;
  const bottom = fixed.min ?? (near ? least - span * 0.1 : lo);
  const top =
    fixed.max ??
    (near
      ? hi + span * 0.07
      : Math.max(unit === '%' && hi <= 100 ? Math.min(100, hi * 1.07) : hi * 1.07, bottom + 1e-9));
  let step = niceAtLeast((top - bottom) / gaps || 1);
  let min = fixed.min ?? Math.floor(bottom / step) * step;
  while (min + step * gaps < top - 1e-9) {
    step = niceAtLeast(step * 1.01);
    min = fixed.min ?? Math.floor(bottom / step) * step;
  }
  const ticks = Array.from({ length: gaps + 1 }, (_, k) => Math.round((min + k * step) * 1000) / 1000);
  return { min, max: min + step * gaps, ticks };
}

/** The range whose words fit the timestamps' span (a 30-day disk chart on a 24-hour page speaks in days). */
export function spanRange(times: readonly number[]): HostSeriesRange {
  const span = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
  if (span <= 1.5 * HOUR) return '1h';
  if (span <= 7 * HOUR) return '6h';
  if (span <= 30 * HOUR) return '24h';
  return '7d';
}

/** A zone's offset from UTC at `t`, in ms (“GMT+02:00” → 7 200 000). */
function zoneOffset(t: number, timeZone?: string): number {
  if (!timeZone) return -new Date(t).getTimezoneOffset() * 60_000;
  const name = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(t)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /([+-])(\d{2}):?(\d{2})?/.exec(name ?? '');
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000;
}

/** How far apart the time axis's words sit for a span: quarter hours, hours, six hours, days, weeks. */
const TICK_EVERY: Record<HostSeriesRange, number> = {
  '1h': HOUR / 4,
  '6h': HOUR,
  '24h': 6 * HOUR,
  '7d': 24 * HOUR,
  '30d': 7 * 24 * HOUR,
  '90d': 14 * 24 * HOUR,
};

/**
 * The time axis's words on round times in the person's zone (“Sat 18:00”, “Sun 00:00”, the mock's), the last point
 * “Now”; a point index each, or a band's for bars. `fitTimeTicks` leaves out what doesn't fit.
 */
export function roundTimeTicks(
  times: readonly number[],
  range: HostSeriesRange,
  timeZone?: string,
): { index: number; label: string }[] {
  const n = times.length;
  if (n < 2) return [];
  const span = (times[n - 1] as number) - (times[0] as number);
  const every = span > 20 * 24 * HOUR ? TICK_EVERY['30d'] : TICK_EVERY[range];
  const offset = zoneOffset(times[n - 1] as number, timeZone);
  const slot = (t: number) => Math.floor((t + offset) / every);
  const out: { index: number; label: string }[] = [];
  for (let i = 1; i < n - 1; i++)
    if (slot(times[i] as number) > slot(times[i - 1] as number))
      out.push({ index: i, label: formatTick(range, times[i] as number, timeZone) });
  // Too many words: every second or third.
  const keep = Math.ceil(out.length / 6);
  const ticks = out.filter((_, k) => k % keep === 0);
  ticks.push({ index: n - 1, label: 'Now' });
  return ticks;
}

function hasDecimals(values: readonly (number | null)[]): boolean {
  return values.some((v) => v !== null && Math.abs(v - Math.round(v)) > 1e-9);
}

function lastOf(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i] as number;
  return null;
}

/** Every number of a chart that its axis must hold: the lines, or the stacked bars' tops. */
function stackTops(series: readonly (number | null)[][]): number[] {
  const n = Math.max(0, ...series.map((s) => s.length));
  return Array.from({ length: n }, (_, i) => series.reduce((sum, s) => sum + (s[i] ?? 0), 0));
}

export function chartModel(panel: ChartPanel, timeZone?: string): ChartModel {
  const bars = panel.style === 'bars';
  const clean = (vs: readonly (number | null)[]) =>
    vs.map((v) => (v !== null && Number.isFinite(v) ? v : null));
  const leftSeries = panel.series.filter((s) => bars || (s.axis ?? 'left') === 'left');
  const rightSeries = bars ? [] : panel.series.filter((s) => s.axis === 'right');
  // A chart whose every line is on the right is a one-axis chart.
  const twoAxes = leftSeries.length > 0 && rightSeries.length > 0;
  const onLeft = twoAxes ? leftSeries : panel.series;
  const leftUnit = panel.axis?.unit ?? onLeft[0]?.unit ?? null;
  const numbers = (list: typeof panel.series) =>
    list.flatMap((s) => clean(s.values).filter((v): v is number => v !== null));
  const leftNumbers = bars ? stackTops(onLeft.map((s) => clean(s.values))) : numbers(onLeft);
  if (panel.line) leftNumbers.push(panel.line.value);
  if (panel.forecast) leftNumbers.push(panel.forecast.value);
  const left = axisOver(leftNumbers, leftUnit, { min: panel.axis?.min, max: panel.axis?.max });
  const rightUnit = twoAxes ? (rightSeries[0]?.unit ?? null) : null;
  const right = twoAxes ? axisOver(numbers(rightSeries), rightUnit) : null;
  const toLeft = (v: number) =>
    right ? left.min + ((v - right.min) / (right.max - right.min || 1)) * (left.max - left.min) : v;
  const fromLeft = (v: number) =>
    right ? right.min + ((v - left.min) / (left.max - left.min || 1)) * (right.max - right.min) : v;
  // A 0.88 card (no place) has no `fill`: the wash goes under its first line, or the right axis's.
  const legacy = panel.place === undefined && panel.series.every((s) => s.fill === undefined);
  const lines = panel.series.map((s, i): ChartLine => {
    const axis = twoAxes && s.axis === 'right' ? 'right' : 'left';
    const unit = s.unit ?? null;
    const values = clean(s.values);
    const decimals = hasDecimals(values);
    const format = (v: number) => {
      const n = formatFigure(v, decimals);
      return unit ? `${n}${NBSP}${unit}` : n;
    };
    const last = lastOf(values);
    return {
      key: s.key,
      label: s.label,
      unit,
      axis,
      color: seriesColor(s.color, i),
      fill: !bars && (legacy ? (twoAxes ? s === rightSeries[0] : i === 0) : !!s.fill),
      values,
      plotted: axis === 'right' ? values.map((v) => (v === null ? null : toLeft(v))) : values,
      latest: s.latest ?? (last === null ? null : format(last)),
      format,
      formatPlotted: axis === 'right' ? (v) => format(fromLeft(v)) : format,
    };
  });

  const times = panel.timestamps.map((t) => toDate(t).getTime());
  const n = times.length;
  const range = spanRange(times);
  const step = n > 1 ? ((times[n - 1] as number) - (times[0] as number)) / (n - 1) : 0;
  const lastTime = times[n - 1] ?? 0;
  const at = panel.forecast ? toDate(panel.forecast.at).getTime() : 0;
  const extend = panel.forecast && step > 0 && at > lastTime ? (at - lastTime) / step : 0;
  // Words of its own under each point (“Thu” … “Today”) instead of times (service-slots.md SLT-06).
  const labels = panel.labels?.length ? panel.labels : null;
  const ticks = labels
    ? labels.slice(0, n).map((label, index) => ({ index, label }))
    : roundTimeTicks(times, range, timeZone);
  if (extend > 0)
    for (const k of [0.5, 1])
      ticks.push({
        index: n - 1 + extend * k,
        label: formatTick('30d', lastTime + extend * k * step, timeZone),
      });
  const pointLabel = (i: number) =>
    labels?.[i] ?? formatTooltipTime(range, (times[0] ?? 0) + i * step, timeZone);

  return {
    lines,
    drawn: [...lines.filter((l) => l.axis === 'right'), ...lines.filter((l) => l.axis === 'left')],
    left: { ...left, label: tickWords(leftUnit) },
    right: right ? { ...right, label: tickWords(rightUnit) } : null,
    bars,
    limit: panel.line ? { value: panel.line.value, label: panel.line.label ?? null } : null,
    forecast:
      panel.forecast && extend > 0
        ? { value: panel.forecast.value, label: panel.forecast.label, extend }
        : null,
    ticks,
    pointLabel,
    empty: lines.every((l) => l.values.every((v) => v === null)),
  };
}
