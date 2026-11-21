// SVG path helpers for the hand-rolled charts (DESIGN-SYSTEM.md 6).
// `null` samples break the line (never interpolated, never drawn as zero).

import type { Annotation, SeriesValues } from '../api/types';

export interface Paths {
  line: string;
  area: string;
}

/**
 * Line and area paths in a W x H viewBox, x by index, y scaled from [lo, hi].
 * Each run of non-null samples becomes its own sub-path; a lone sample gets a
 * zero-length segment so the round cap shows it as a dot.
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
    if (!run.length) return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
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

/**
 * Sparkline y-range (same rule as the mockup): min/max of the data, widened to
 * at least 20 units around the middle, plus 12% padding.
 */
export function sparkDomain(values: SeriesValues): [number, number] | null {
  const pts = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (pts.length < 1) return null;
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  if (hi - lo < 20) {
    const c = (hi + lo) / 2;
    lo = c - 10;
    hi = c + 10;
  }
  const pad = (hi - lo) * 0.12;
  return [lo - pad, hi + pad];
}

/** Horizontal hairlines: `rows` intervals in a W x H viewBox. */
export function gridPath(W: number, H: number, rows: number): string {
  let d = '';
  for (let k = 0; k <= rows; k++) {
    const y = ((k / rows) * H).toFixed(1);
    d += `M0 ${y}L${W} ${y}`;
  }
  return d;
}

/**
 * Index of the default crosshair position: about 72% of the range, or the
 * newest sample when there is no data there (a host enrolled minutes ago).
 */
export function restIndex(n: number, hasValue?: (i: number) => boolean): number {
  const i = Math.max(0, Math.round((n - 1) * 0.72));
  if (!hasValue || hasValue(i)) return i;
  for (let j = n - 1; j >= 0; j--) if (hasValue(j)) return j;
  return i;
}

/** Mean of the non-null samples (fallback when the API sends no summary). */
export function meanOf(values: SeriesValues): number | null {
  const pts = values.filter((v): v is number => v != null && Number.isFinite(v));
  return pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : null;
}

/** Index of the largest non-null sample (fallback when the API sends no summary). */
export function argMax(values: SeriesValues): number | null {
  let best: number | null = null;
  values.forEach((v, i) => {
    if (v != null && (best === null || v > (values[best] ?? -Infinity))) best = i;
  });
  return best;
}

/**
 * Spread end labels vertically so they do not overlap.
 * `tops` are pixel positions; returns adjusted positions at least `gap` apart,
 * kept inside [0, height].
 */
export function spreadLabels(tops: number[], gap: number, height: number): number[] {
  const order = tops.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1]!;
    const cur = order[k]!;
    if (cur.t - prev.t < gap) cur.t = prev.t + gap;
  }
  const overflow = (order[order.length - 1]?.t ?? 0) - height;
  if (overflow > 0) {
    for (let k = order.length - 1; k >= 0; k--) {
      const cur = order[k]!;
      const next = order[k + 1];
      cur.t = Math.min(cur.t, next ? next.t - gap : height);
    }
  }
  const out = new Array<number>(tops.length);
  for (const o of order) out[o.i] = Math.max(0, o.t);
  return out;
}

const MARK_COLOR: Record<Annotation['kind'], string> = {
  alert: 'var(--warning)',
  reboot: 'var(--ink-3)',
  action: 'var(--series-cpu)',
  agent: 'var(--ink-3)',
};

/** Places annotations on the bucket grid (bucket end times): each in the first bucket ending at or after it. */
export function marksFor(annotations: Annotation[] | undefined, timestamps: string[]): { i: number; color: string; text: string }[] {
  const n = timestamps.length;
  if (!annotations?.length || n < 2) return [];
  const ends = timestamps.map((t) => Date.parse(t));
  const step = (ends[n - 1]! - ends[0]!) / (n - 1);
  const start = ends[0]! - step;
  const out: { i: number; color: string; text: string }[] = [];
  for (const a of annotations) {
    const t = Date.parse(a.at);
    if (!(t > start) || t > ends[n - 1]!) continue;
    let i = 0;
    while (i < n - 1 && ends[i]! < t) i++;
    const color = a.kind === 'alert' && a.severity === 'critical' ? 'var(--critical)' : MARK_COLOR[a.kind] ?? 'var(--ink-3)';
    out.push({ i, color, text: a.text });
  }
  return out;
}
