/**
 * “How it’s doing” on the phone (Whombat box-status.md BS-12; app docs/decisions/box-status-android.md AP-1150…): what
 * Android's This Whombat screen adds to the shared status model (`@whombat/client` `host/`) — which of the section's
 * parts a poll state shows, the chart switcher, the readout row above a chart (the web's tooltip, for a finger), what
 * TalkBack reads for each chart, the disk's colours, and the charts' SVG paths. Every word is the contracts'
 * (`HOST_STATUS_COPY`, `HOST_RANGE_LABELS`) or the shared model's. Pure.
 */
import {
  type HostChartPoint,
  type HostDayRow,
  type HostDiskRowKey,
  type HostPollState,
  hostDayLines,
  hostPointLabel,
  splitLead,
  type ThingSeriesToken,
} from '@whombat/client';
import { hostRangeLabels, hostStatusCopy } from '@whombat/core/text';
import { HOST_METRICS_RANGES, type HostMetricsRange } from '@whombat/protocol/session';

/* The section ------------------------------------------------------------------------------------------------------ */

/**
 * What the section shows for a poll state (BS-01, BS-06): the box (tiles, range, the four charts), the sentence that
 * the measurements can't be read (`unavailable`), nothing at all without a manager (`none`, `not_managed`), or a quiet
 * frame before the first answer. What the AI used is Spend's, in Settings → Advanced: the phone shows it in one place.
 */
export type HostSectionKind = 'loading' | 'box' | 'unavailable' | 'none';

export function hostSectionKind(state: Pick<HostPollState, 'metrics' | 'reason'>): HostSectionKind {
  if (state.reason === 'not_managed') return 'none';
  if (state.reason === 'unavailable') return 'unavailable';
  return state.metrics ? 'box' : 'loading';
}

/** The charts, one at a time (BS-12), in the web's order, named by the contracts' titles. */
export type HostChartKey = 'processor' | 'network' | 'days' | 'disk';

export function hostCharts(locale?: string): readonly { value: HostChartKey; label: string }[] {
  const copy = hostStatusCopy(locale);
  return [
    { value: 'processor', label: copy.processor },
    { value: 'network', label: copy.networkSpeed },
    { value: 'days', label: copy.perDay },
    { value: 'disk', label: copy.disk },
  ];
}

export const HOST_CHARTS: readonly { value: HostChartKey; label: string }[] = hostCharts();

/** The range control's options, shortest first. */
export function hostRangeOptions(locale?: string): readonly { value: HostMetricsRange; label: string }[] {
  const labels = hostRangeLabels(locale);
  return HOST_METRICS_RANGES.map((value) => ({ value, label: labels[value] }));
}

export const HOST_RANGE_OPTIONS: readonly { value: HostMetricsRange; label: string }[] = hostRangeOptions();

/* Readouts --------------------------------------------------------------------------------------------------------- */

/**
 * A chart series' colour: the four chart colours (`theme.chart`), or the warning, serious or muted colour — a Summary's
 * series name them (`ThingSeriesColor` → `thingSeriesToken`, dashboards-mobile.md AP-2121).
 */
export type ChartSwatch = ThingSeriesToken;

/** A readout line's or legend's colour, or none for a line that belongs to no series. */
export type HostSwatch = ChartSwatch | null;

/** One line of a readout: the value in bold, then its words (`4 %` · `busy`). */
export interface HostReadoutLine {
  swatch: HostSwatch;
  value: string;
  rest: string;
}

/** The row above a chart: the point's moment or day, then a line per series (the web's tooltip). */
export interface HostReadout {
  title: string;
  lines: HostReadoutLine[];
}

const lead = (swatch: HostSwatch, line: string): HostReadoutLine => ({ swatch, ...splitLead(line) });

/** The measured point nearest to `index` (a gap shows the closest moment that has values), or null with none. */
export function nearestMeasured(
  points: readonly HostChartPoint[],
  index: number,
  measured: (p: HostChartPoint) => boolean,
): number | null {
  const at = Math.max(0, Math.min(points.length - 1, Math.round(index)));
  for (let d = 0; d < points.length; d++) {
    const before = points[at - d];
    if (before && measured(before)) return at - d;
    const after = points[at + d];
    if (after && measured(after)) return at + d;
  }
  return null;
}

/**
 * TalkBack's swipe along a chart: `step` points on from `from` in the direction of `delta` (1 later, −1 earlier), on to
 * the next measured point past a gap; `from` again at either end.
 */
export function stepMeasured(
  points: readonly HostChartPoint[],
  from: number,
  delta: number,
  step: number,
  measured: (p: HostChartPoint) => boolean,
): number {
  for (let i = from + delta * step; i >= 0 && i < points.length; i += delta) {
    const p = points[i];
    if (p && measured(p)) return i;
  }
  const end = delta > 0 ? points.length - 1 : 0;
  return end !== from && points[end] && measured(points[end] as HostChartPoint) ? end : from;
}

export const cpuMeasured = (p: HostChartPoint) => p.cpuPct !== null;
export const speedMeasured = (p: HostChartPoint) => p.downBps !== null || p.upBps !== null;

/** `14:25` · `4 % busy`. */
export function processorReadout(
  p: HostChartPoint,
  range: HostMetricsRange,
  timeZone: string,
  locale?: string,
): HostReadout {
  return {
    title: hostPointLabel(p.at, range, timeZone, locale),
    lines: [lead('chart1', hostStatusCopy(locale).busy(p.cpuPct ?? 0))],
  };
}

/** `14:25` · `12 Mbit/s down` · `0.4 Mbit/s up`. */
export function networkReadout(
  p: HostChartPoint,
  range: HostMetricsRange,
  timeZone: string,
  locale?: string,
): HostReadout {
  const copy = hostStatusCopy(locale);
  return {
    title: hostPointLabel(p.at, range, timeZone, locale),
    lines: [lead('chart1', copy.speedDown(p.downBps ?? 0)), lead('chart2', copy.speedUp(p.upBps ?? 0))],
  };
}

/** `Today so far` · `2.2 GB received` · `41 MB sent`. */
export function dayReadout(row: HostDayRow, locale?: string): HostReadout {
  const t = hostDayLines(row, locale);
  return { title: row.title, lines: [lead('chart1', t.received), lead('chart2', t.sent)] };
}

/** A readout as TalkBack reads it: `14:25, 4 % busy`. */
export function readoutText(r: HostReadout): string {
  return [r.title, ...r.lines.map((l) => [l.value, l.rest].filter(Boolean).join(' '))].join(', ');
}

/** A chart's name for TalkBack: its title with what it covers (`Processor, 24 hours, Peak 86 % at 14:25`). */
export function chartLabel(title: string, scope: string, extra?: string | null): string {
  return [title, scope, extra].filter(Boolean).join(', ');
}

/* The disk --------------------------------------------------------------------------------------------------------- */

/**
 * A disk part's colour (BS-10, the mock's): the agent's containers, the Whombat's own data and the work folders take the
 * three chart colours, the database the meta colour, Other the input border, Free the track. While the parts are being
 * recounted the bar's one used part is Other, drawn in the first chart colour (it is all of “used”).
 */
export type HostDiskTone = 'chart1' | 'chart2' | 'chart3' | 'mut' | 'line2' | 'free';

export function hostDiskTone(key: HostDiskRowKey, partsKnown: boolean): HostDiskTone {
  switch (key) {
    case 'containers':
      return 'chart1';
    case 'whombat':
      return 'chart2';
    case 'work':
      return 'chart3';
    case 'database':
      return 'mut';
    case 'other':
      return partsKnown ? 'line2' : 'chart1';
    default:
      return 'free';
  }
}

/* Geometry --------------------------------------------------------------------------------------------------------- */

const f = (n: number) => n.toFixed(1);

/** An SVG path through the values, broken where a value is null (a gap, never a dip to zero). */
export function linePath(
  values: readonly (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  let d = '';
  let open = false;
  values.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    d += `${open ? 'L' : 'M'}${f(x(i))} ${f(y(v))}`;
    open = true;
  });
  return d;
}

/** The wash under a line: one closed shape per unbroken run of values, down to `base`. */
export function areaPath(
  values: readonly (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
  base: number,
): string {
  let d = '';
  let run: number[] = [];
  const close = () => {
    const first = run[0];
    const last = run.at(-1);
    if (first !== undefined && last !== undefined && run.length > 1)
      d += `${run.map((i, k) => `${k ? 'L' : 'M'}${f(x(i))} ${f(y(values[i] as number))}`).join('')}L${f(x(last))} ${f(base)}L${f(x(first))} ${f(base)}Z`;
    run = [];
  };
  values.forEach((v, i) => {
    if (v === null) close();
    else run.push(i);
  });
  close();
  return d;
}

/** A column `width` wide centred on `cx`, from `top` down `height`, its top corners rounded by `radius` (the mock's). */
export function columnPath(cx: number, width: number, top: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, height / 2, width / 2));
  const left = cx - width / 2;
  const bottom = top + height;
  return `M${f(left)} ${f(bottom)}V${f(top + r)}q0 -${f(r)} ${f(r)} -${f(r)}H${f(left + width - r)}q${f(r)} 0 ${f(r)} ${f(r)}V${f(bottom)}Z`;
}

/** One part of a stacked column: which value, where it starts and how tall it is, and its top corners' radius. */
export interface ColumnPart {
  index: number;
  top: number;
  height: number;
  radius: number;
}

/**
 * A stacked column (BS-11): the values bottom up, each part `gap` above the one under it, only the topmost part's
 * corners rounded (4). Empty values take no part; a part is at least 1 high so a small day still shows.
 */
export function columnStack(
  values: readonly number[],
  y: (v: number) => number,
  { gap = 2, radius = 4 }: { gap?: number; radius?: number } = {},
): ColumnPart[] {
  const parts: ColumnPart[] = [];
  const topmost = values.reduce((last, v, i) => (v > 0 ? i : last), -1);
  let sum = 0;
  values.forEach((v, index) => {
    if (v <= 0) return;
    const y0 = y(sum);
    const y1 = y(sum + v);
    sum += v;
    const height = Math.max(1, y0 - y1 - (parts.length ? gap : 0));
    parts.push({ index, top: y1, height, radius: index === topmost ? Math.min(radius, height / 2) : 0 });
  });
  return parts;
}

/** The index a finger at `x` points at, among `count` points spread over `[left, left + width]`. */
export function indexAtX(x: number, left: number, width: number, count: number): number {
  if (count <= 1 || width <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(((x - left) / width) * (count - 1))));
}

/** The column a finger at `x` is over, among `count` equal bands over `[left, left + width]`. */
export function bandAtX(x: number, left: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor(((x - left) / width) * count)));
}

/**
 * A tile's sparkline (the mock's): at most `max` values (every n-th, the latest always last), scaled to the busiest of
 * them, `width` × `height` with 2 px of room left and right and 3 at the top and bottom; null values break the line.
 * The latest measured value gets the dot.
 */
export function sparkline(
  values: readonly (number | null)[],
  width: number,
  height: number,
  max = 96,
): { path: string; dot: { x: number; y: number } | null } {
  const every = Math.max(1, Math.ceil(values.length / max));
  const picked = values.filter((_, i) => (values.length - 1 - i) % every === 0);
  const top = Math.max(0, ...picked.map((v) => v ?? 0));
  if (picked.length < 2 || width <= 4) return { path: '', dot: null };
  const x = (i: number) => (i / (picked.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 3 - (top > 0 ? v / top : 0) * (height - 6);
  const last = picked.reduce<number | null>((found, v, i) => (v === null ? found : i), null);
  const lastValue = last === null ? null : picked[last];
  return {
    path: linePath(picked, x, y),
    dot: last === null || lastValue == null ? null : { x: x(last), y: y(lastValue) },
  };
}
