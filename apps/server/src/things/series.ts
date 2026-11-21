/**
 * Figures over a page's range (dashboards.md DS-03, DS-06…DS-08, DS-11, DS-15; dashboards-server.md DS-S01…): the
 * ranges a connection's page offers and their steps, points on the range's grid, a counter that restarts turned into
 * bars, small lines cut to 60 points, the average and the peak with its time, and where a growing figure is heading
 * (“Full in about 2 months”). Pure; times in the caller's zone.
 */
import type { HostSeriesRange, ThingLine } from '@whombat/core';
import { dayMonth, figure1, line } from './words';

/** The ranges a connection's or device's page offers (DS-03), shortest first. */
export const PAGE_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
export type PageRange = (typeof PAGE_RANGES)[number];
export const DEFAULT_RANGE: PageRange = '24h';

/** The range asked for, or the default when the page doesn't offer it (90 days is the servers'). */
export function pageRange(asked: HostSeriesRange | undefined): PageRange {
  return (PAGE_RANGES as readonly string[]).includes(asked ?? '') ? (asked as PageRange) : DEFAULT_RANGE;
}

const H = 3600_000;
const DAY = 24 * H;

export const RANGE_MS: Record<PageRange, number> = {
  '1h': H,
  '6h': 6 * H,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
};

/** The grid of Whombat's own points (5-minute points, hourly after two days; DS-11). */
export const POINT_STEP_MS: Record<PageRange, number> = {
  '1h': 5 * 60_000,
  '6h': 5 * 60_000,
  '24h': 15 * 60_000,
  '7d': 2 * H,
  '30d': 6 * H,
};

/** The hosts service's steps (and Hetzner's, read at the same): 60, 72, 96, 84 and 120 points. */
export const SERVICE_STEP_MS: Record<PageRange, number> = {
  '1h': 60_000,
  '6h': 5 * 60_000,
  '24h': 15 * 60_000,
  '7d': 2 * H,
  '30d': 6 * H,
};

/** “24 h”, “7 days”: a range in a figure's line or a column's head. */
export const RANGE_LABEL: Record<PageRange, string> = {
  '1h': '1 h',
  '6h': '6 h',
  '24h': '24 h',
  '7d': '7 days',
  '30d': '30 days',
};

/** One series' raw points, oldest first. */
export interface RawPoint {
  at: Date;
  value: number | null;
}

/**
 * The ends of a range's buckets, oldest first: on multiples of `stepMs`, the last one `now` when it isn't on one (the
 * current, partial bucket), as the hosts service does.
 */
export function gridTimes(range: PageRange, now: Date, stepMs = POINT_STEP_MS[range]): Date[] {
  const n = Math.max(1, Math.round(RANGE_MS[range] / stepMs));
  const t = now.getTime();
  const b = Math.floor(t / stepMs) * stepMs;
  const ends: number[] = [];
  if (b === t) for (let i = n - 1; i >= 0; i--) ends.push(b - i * stepMs);
  else {
    for (let i = n - 2; i >= 0; i--) ends.push(b - i * stepMs);
    ends.push(t);
  }
  return ends.map((e) => new Date(e));
}

/** The bucket a moment falls in (`(end − step, end]`), or −1 before the first. */
function bucketOf(ends: readonly Date[], stepMs: number, at: number): number {
  const first = (ends[0] as Date).getTime() - stepMs;
  if (at <= first) return -1;
  return Math.min(ends.length - 1, Math.ceil((at - first) / stepMs) - 1);
}

/**
 * Points on the range's grid (DS-11): each bucket the mean of its points, null where nothing was read — a gap, also
 * before a new connection's history starts (the chart shows the whole range).
 */
export function onRange(
  series: readonly (readonly RawPoint[])[],
  range: PageRange,
  now: Date,
  stepMs = POINT_STEP_MS[range],
): { timestamps: string[]; values: (number | null)[][] } {
  const ends = gridTimes(range, now, stepMs);
  const values = series.map((points) => {
    const sums = new Array<number>(ends.length).fill(0);
    const counts = new Array<number>(ends.length).fill(0);
    for (const p of points) {
      if (p.value === null || !Number.isFinite(p.value)) continue;
      const i = bucketOf(ends, stepMs, p.at.getTime());
      if (i < 0 || p.at.getTime() > now.getTime()) continue;
      sums[i] = (sums[i] as number) + p.value;
      counts[i] = (counts[i] as number) + 1;
    }
    return sums.map((s, i) => ((counts[i] as number) > 0 ? s / (counts[i] as number) : null));
  });
  return { timestamps: ends.map((d) => d.toISOString()), values };
}

/**
 * A running count (errors since a restart) as how much it grew per bucket. A drop to under half of the count before
 * is a restart and counts again from the new count; a smaller drop (an old entry left the log) adds nothing. The first
 * point has nothing before it and adds nothing. Buckets without a point are null.
 */
export function counterSteps(
  points: readonly RawPoint[],
  range: PageRange,
  now: Date,
  stepMs: number,
): { timestamps: string[]; values: (number | null)[] } {
  const ends = gridTimes(range, now, stepMs);
  const values: (number | null)[] = new Array(ends.length).fill(null);
  let prev: number | null = null;
  for (const p of points) {
    if (p.value === null || !Number.isFinite(p.value)) continue;
    let grew = 0;
    if (prev !== null) grew = p.value >= prev ? p.value - prev : p.value < prev / 2 ? p.value : 0;
    prev = p.value;
    const i = bucketOf(ends, stepMs, p.at.getTime());
    if (i < 0 || p.at.getTime() > now.getTime()) continue;
    values[i] = (values[i] ?? 0) + grew;
  }
  return { timestamps: ends.map((d) => d.toISOString()), values };
}

/** A small line of at most `max` points (the mean of each group, null when the group read nothing). */
export function downsample(values: readonly (number | null)[], max = 60): (number | null)[] {
  if (values.length <= max) return [...values];
  const out: (number | null)[] = [];
  for (let g = 0; g < max; g++) {
    const from = Math.floor((g * values.length) / max);
    const to = Math.floor(((g + 1) * values.length) / max);
    const xs = values.slice(from, to).filter((v): v is number => v !== null);
    out.push(xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  }
  return out;
}

/** The newest value read, or null. */
export function lastValue(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i] as number;
  return null;
}

/** Whether a series has at least `n` values to draw. */
export function drawable(values: readonly (number | null)[], n = 2): boolean {
  let count = 0;
  for (const v of values) if (v !== null && ++count >= n) return true;
  return false;
}

export interface SeriesStats {
  avg: number;
  peak: number;
  peakAt: Date;
  /** The peak is the newest value. */
  peakIsLast: boolean;
}

/** The average and the peak (the first time it was reached) over a range; null without a value. */
export function seriesStats(
  values: readonly (number | null)[],
  timestamps: readonly string[],
): SeriesStats | null {
  let sum = 0;
  let count = 0;
  let peak = -Infinity;
  let peakI = -1;
  let lastI = -1;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    sum += v;
    count++;
    lastI = i;
    if (v > peak) {
      peak = v;
      peakI = i;
    }
  });
  if (!count || peakI < 0 || !timestamps[peakI]) return null;
  return {
    avg: sum / count,
    peak,
    peakAt: new Date(timestamps[peakI] as string),
    peakIsLast: peakI === lastI,
  };
}

/** DS-15: one decimal under 10, none above (“2.4”, “63”); nought is “0”. */
export function statFigure(n: number): string {
  return n === 0 ? '0' : figure1(n);
}

/** A weekday and a time within the last six days (“Sun 03:10”), else the date and the time (“12 Oct 03:10”). */
export function momentWords(at: Date, now: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  if (now.getTime() - at.getTime() < 6 * DAY) {
    const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(at);
    return `${day} ${time}`;
  }
  return `${dayMonth(at, timeZone)} ${time}`;
}

/**
 * The chart card's lines on the right (DS-06, DS-15): “Avg **14.2 %**”, “Peak **63 %** Sun 03:10” (“Now” when the
 * peak is the newest value). `fmt` gives the figure with its unit.
 */
export function avgPeakLines(
  stats: SeriesStats | null,
  fmt: (n: number) => string,
  now: Date,
  timeZone: string,
): ThingLine[] {
  if (!stats) return [];
  const when = stats.peakIsLast ? 'Now' : momentWords(stats.peakAt, now, timeZone);
  return [line(`Avg **${fmt(stats.avg)}**`), line(`Peak **${fmt(stats.peak)}** ${when}`)];
}

/** A chart card's `stats`, left out when there are none. */
export function statsOf(lines: ThingLine[]): { stats?: ThingLine[] } {
  return lines.length ? { stats: lines.slice(0, 2) } : {};
}

/** A percentage with DS-15's decimals: “2.4 %”, “63 %”. */
export const pctStat = (n: number) => `${statFigure(n)} %`;

/* Where it is heading ----------------------------------------------------------------------------------------------- */

/** A least-squares line through the points (value per millisecond), with how much time they cover. */
export interface Trend {
  slopePerMs: number;
  /** The line's value at `now`. */
  valueNow: number;
  spanMs: number;
}

/** The trend over the points of the last `windowMs` (30 days); null with fewer than two values. */
export function trendOf(points: readonly RawPoint[], now: Date, windowMs = 30 * DAY): Trend | null {
  const from = now.getTime() - windowMs;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    const t = p.at.getTime();
    if (p.value === null || !Number.isFinite(p.value) || t < from || t > now.getTime()) continue;
    xs.push(t - now.getTime());
    ys.push(p.value);
  }
  if (xs.length < 2) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    den += ((xs[i] as number) - mx) ** 2;
  }
  if (den === 0) return null;
  const slopePerMs = num / den;
  return {
    slopePerMs,
    valueNow: my - slopePerMs * mx,
    spanMs: Math.max(...xs) - Math.min(...xs),
  };
}

/**
 * When a growing figure reaches `limit` (DS-08): the least-squares line over up to 30 days of points, with at least two
 * days of history, only while it grows and only when that is within a year; null otherwise (and when it is there).
 */
export function forecastFull(points: readonly RawPoint[], limit: number, now: Date): Date | null {
  const trend = trendOf(points, now);
  if (!trend || trend.spanMs < 2 * DAY || trend.slopePerMs <= 0) return null;
  const last = lastValue(points.map((p) => p.value));
  if (last === null || last >= limit) return null;
  const ms = (limit - trend.valueNow) / trend.slopePerMs;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 365 * DAY) return null;
  return new Date(now.getTime() + ms);
}

/** “in about 5 days”, “in about 3 weeks”, “in about 2 months”. */
export function inAbout(at: Date, now: Date): string {
  const days = Math.max(1, Math.round((at.getTime() - now.getTime()) / DAY));
  if (days < 14) return `in about ${days === 1 ? 'a day' : `${days} days`}`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `in about ${weeks} weeks`;
  const months = Math.round(days / 30);
  return months <= 1 ? 'in about a month' : `in about ${months} months`;
}

/** “about 18 Dec”. */
export function aboutDay(at: Date, timeZone: string): string {
  return `about ${dayMonth(at, timeZone)}`;
}

/** DS-15: “Full about 18 Dec” within 60 days, else “Full in about 5 months”. */
export function fullWords(at: Date, now: Date, timeZone: string): string {
  return at.getTime() - now.getTime() <= 60 * DAY
    ? `Full ${aboutDay(at, timeZone)}`
    : `Full ${inAbout(at, now)}`;
}

/** A size growing per day: “+ 110 MB a day”, “+ 1.2 GB a day”; null when it doesn't grow. */
export function perDay(mbPerDay: number): string | null {
  if (!(mbPerDay >= 1)) return null;
  return mbPerDay >= 1000 ? `+ ${figure1(mbPerDay / 1000)} GB a day` : `+ ${Math.round(mbPerDay)} MB a day`;
}

/** Megabytes a day from a trend in MB per millisecond, when it covers at least a day. */
export function mbPerDay(trend: Trend | null): number | null {
  if (!trend || trend.spanMs < DAY) return null;
  return trend.slopePerMs * DAY;
}
