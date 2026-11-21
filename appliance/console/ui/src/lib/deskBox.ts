/**
 * This Whombat's panel (Whombat DK-22, appliance CG-57…): the last-hour chart's scale and lines, the storage bar's
 * parts and the temperature's segments. Pure; the panel (`desk/Box.tsx`) draws what these return.
 */
import type { DeskBox } from './desk';

/** The chart's tops (%): the smallest that holds the hour (CG-58). */
export const CHART_TOPS = [25, 50, 100] as const;
export type ChartTop = (typeof CHART_TOPS)[number];

/** The chart's drawing box (SVG units; stretched to the chart's size, the lines keep their width). */
export const CHART_W = 600;
export const CHART_H = 160;

/** The temperature's bar: 30 segments from 0° to 95° (the mockup's). */
export const TEMP_SEGMENTS = 30;
export const TEMP_MAX = 95;

/** The smallest top that holds every value (the points and the figures now; nulls are gaps). */
export function topOf(values: readonly (number | null | undefined)[]): ChartTop {
  const max = Math.max(0, ...values.filter((v): v is number => typeof v === 'number'));
  return CHART_TOPS.find((t) => max <= t) ?? 100;
}

/** The smallest top that holds every point of the hour and the figures now. */
export function chartTop(box: Pick<DeskBox, 'cpu' | 'memory' | 'history'>): ChartTop {
  return topOf([box.cpu.percent, box.memory.percent, ...box.history.cpu, ...box.history.memory]);
}

/**
 * Where point i of n lies across the chart (0 = `spanS` ago, an hour by default; 1 = now): the last point is now, each
 * one step before the next, so a box measured for ten minutes fills the right sixth of its hour.
 */
export function pointX(i: number, n: number, stepS: number, spanS = 3600): number {
  const span = Math.max(n - 1, Math.round(spanS / Math.max(1, stepS)) - 1);
  return span === 0 ? 1 : 1 - (n - 1 - i) / span;
}

export interface ChartLine {
  /** The line, one subpath per run of measured points (a gap breaks it; a lone point is a dot). */
  line: string;
  /** The area under each run of two or more points, for the fade. */
  area: string;
}

const f = (v: number) => (Math.round(v * 10) / 10).toString();
const path = (run: { x: number; y: number }[]) =>
  run.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`).join('');

/** A series as SVG paths in the CHART_W × CHART_H box, against `top`, over `spanS` ending now. */
export function chartLine(points: (number | null)[], stepS: number, top: number, spanS = 3600): ChartLine {
  const runs: { x: number; y: number }[][] = [[]];
  points.forEach((p, i) => {
    if (p === null) runs.push([]);
    else
      runs.at(-1)?.push({
        x: pointX(i, points.length, stepS, spanS) * CHART_W,
        y: CHART_H - (Math.min(top, Math.max(0, p)) / top) * CHART_H,
      });
  });
  let line = '';
  let area = '';
  for (const run of runs) {
    const first = run[0];
    const last = run.at(-1);
    if (!first || !last) continue;
    if (run.length === 1) {
      line += `M${f(first.x)} ${f(first.y)}h0`;
      continue;
    }
    line += path(run);
    area += `${path(run)}L${f(last.x)} ${CHART_H}L${f(first.x)} ${CHART_H}Z`;
  }
  return { line, area };
}

/** The storage bar: the measured parts, then the rest of what is used (the app's “Other”), each a share of the disk. */
export function storageBar(s: DeskBox['storage']): { key: 'whombat' | 'agent' | 'other'; percent: number }[] {
  const parts = s.parts.map((p) => ({ key: p.key, percent: p.percent }));
  const rest = s.percent - parts.reduce((sum, p) => sum + p.percent, 0);
  return rest >= 1 ? [...parts, { key: 'other', percent: rest }] : parts;
}

/** How many of the temperature's segments are lit. */
export function tempLit(c: number): number {
  return Math.round((Math.min(TEMP_MAX, Math.max(0, c)) / TEMP_MAX) * TEMP_SEGMENTS);
}
