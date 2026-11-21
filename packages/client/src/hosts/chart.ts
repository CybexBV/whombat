/**
 * Chart arithmetic for servers' history (ported from Rackoon's `web/src/lib/chart.ts`): paths in a viewBox with gaps
 * kept as gaps (a null sample is never drawn as zero), scales that end on round numbers, the time axis's five words,
 * and the facts under a chart (average, peak, how long a value has stayed above a line). Pure; the web's `TimeChart`
 * and `AreaSparkline` and Android's charts draw from these.
 */
import type { HostSeries, HostSeriesRange } from '@whombat/core/domain';
import { formatTick } from './format';

export type SeriesValues = readonly (number | null)[];

export interface Paths {
  line: string;
  area: string;
}

/**
 * Line and area paths in a W × H box, x by index, y from [lo, hi]. Each run of samples is its own sub-path; a lone
 * sample gets a tiny segment so a round cap shows it as a dot.
 */
export function seriesPaths(values: SeriesValues, lo: number, hi: number, W: number, H: number): Paths {
  const n = values.length;
  if (n === 0 || hi === lo) return { line: '', area: '' };
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * H;
  let line = '';
  let area = '';
  let run: [number, number][] = [];
  const flush = () => {
    const first = run[0];
    const last = run[run.length - 1];
    if (!first || !last) return;
    let seg = run.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
    if (run.length === 1) seg += `L${(first[0] + 0.01).toFixed(2)} ${first[1].toFixed(1)}`;
    line += seg;
    area += `${seg}L${last[0].toFixed(1)} ${H}L${first[0].toFixed(1)} ${H}Z`;
    run = [];
  };
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) flush();
    else run.push([x(i), y(v)]);
  });
  flush();
  return { line, area };
}

/** The last sample that is a number, or null. */
export function lastValue(values: SeriesValues | undefined): number | null {
  if (!values) return null;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Mean of the samples that are numbers. */
export function meanOf(values: SeriesValues): number | null {
  const pts = values.filter((v): v is number => v != null && Number.isFinite(v));
  return pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : null;
}

/** A percent scale's top: a round number just above the peak (10 … 100). */
export function niceCeiling(peak: number | null): number {
  const p = Math.max(10, (peak ?? 0) * 1.25);
  for (const c of [10, 20, 25, 50, 75, 100]) if (p <= c) return c;
  return 100;
}

/** A rate scale's top: 1, 2 or 5 times a power of ten just above the peak. */
export function niceRate(peak: number | null): number {
  const p = Math.max(1, (peak ?? 0) * 1.15);
  const e = 10 ** Math.floor(Math.log10(p));
  for (const m of [1, 2, 5, 10]) if (p <= m * e) return m * e;
  return 10 * e;
}

/**
 * A temperature scale (the server page's CPU temperature, mock 2: 40°, 60°, 80° under a top of 90°): ticks every 20°
 * from below the data, the top 6° above its peak (and above the line shown) rounded up to ten.
 */
export function tempScale(
  values: SeriesValues,
  line?: number | null,
): { min: number; max: number; ticks: number[] } {
  const pts = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (line != null) pts.push(line);
  if (!pts.length) return { min: 20, max: 90, ticks: [20, 40, 60, 80] };
  const step = 20;
  const min = Math.max(0, Math.floor((Math.min(...pts) - 2) / step) * step);
  const max = Math.max(min + 2 * step, Math.ceil((Math.max(...pts) + 6) / 10) * 10);
  const ticks: number[] = [];
  for (let t = min; t <= max; t += step) ticks.push(t);
  return { min, max, ticks };
}

/** The time axis's five words over a series' timestamps; the last says “Now” (or `endWord`). */
export function timeTicks(
  timestamps: readonly string[],
  range: HostSeriesRange | 'custom',
  timeZone?: string,
  endWord = 'Now',
): { index: number; label: string }[] {
  const n = timestamps.length;
  if (n < 2) return [];
  return [0, 1, 2, 3, 4].map((k) => {
    const index = Math.round(((n - 1) * k) / 4);
    return {
      index,
      label: k === 4 ? endWord : formatTick(range, Date.parse(timestamps[index] ?? ''), timeZone),
    };
  });
}

/** How long (seconds) the newest samples have stayed at or above `line`, counted back from the end; 0 when not. */
export function secondsAbove(series: HostSeries | undefined, key: string, line: number): number {
  const values = series?.series[key];
  if (!series || !values?.length) return 0;
  let i = values.length - 1;
  while (i >= 0 && values[i] == null) i--;
  if (i < 0 || (values[i] ?? Number.NEGATIVE_INFINITY) < line) return 0;
  let j = i;
  while (j > 0) {
    const v = values[j - 1];
    if (v == null || v < line) break;
    j--;
  }
  return (i - j + 1) * series.stepSeconds;
}
