/**
 * How the box is doing (Whombat box-status.md BS-01…BS-12; contracts 0.78.0, CT-334; app docs/decisions/box-status.md
 * AP-1135…): what Settings → This Whombat → “How it’s doing” on the web and Android's This Whombat screen show, from
 * `host.metrics`, `spend.daily` and `spend.overview` — the four tiles, a live poll's points merged into the range, the
 * charts' points, scales, ticks and tooltip lines, the disk's parts, 14 days of traffic and of tokens, and today's
 * agents. Every visible word is the contracts' (`text/host.ts`), the two axis words the mock's. Pure: no clock (times
 * come from the answers), no I/O beyond `hostMetricsLoader`'s session.
 */
import { type SpendDaily, type SpendOverview, spendTokens } from '@whombat/core/domain';
import {
  bitsPerSecond,
  cacheReadPct,
  formatBytes,
  formatClock,
  formatDate,
  formatShortWeekday,
  formatUsagePct,
  HOST_CHART_DAYS,
  HOST_DISK_PART_LABELS,
  HOST_STATUS_COPY,
  hostDiskUsedPct,
  NBSP,
} from '@whombat/core/text';
import {
  HOST_METRICS_POINTS,
  type HostDay,
  type HostDiskPartKey,
  type HostDisks,
  type HostMetrics,
  type HostMetricsInput,
  type HostMetricsOutput,
  type HostMetricsRange,
  type HostPoint,
  type HostSeries,
} from '@whombat/protocol/session';
import { sessionOps } from '../session/managed-ops';
import type { ApplianceSession, CallOptions } from '../session/types';

/** Asks `host.metrics` (the session op, or a fixture world's stand-in). */
export type HostMetricsLoader = (
  input: HostMetricsInput,
  options?: CallOptions,
) => Promise<HostMetricsOutput>;

/** `host.metrics` over this session. */
export function hostMetricsLoader(session: ApplianceSession): HostMetricsLoader {
  return (input, o) => sessionOps.hostMetrics(session, input, o);
}

/** The words on the charts that the contracts leave to the mock: the time axis's last tick, the days' last column. */
export const HOST_CHART_WORDS = { now: 'now', today: 'today' } as const;

/** “Other” on the disk is shown from half a gigabyte (smaller rests go unmentioned). */
const OTHER_MIN_BYTES = 500_000_000;

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

/* Series ----------------------------------------------------------------------------------------------------------- */

/** Where point `i` of a series starts (ms). */
export function hostPointStart(series: Pick<HostSeries, 'start' | 'stepS'>, i: number): number {
  return at(series.start) + i * series.stepS * 1000;
}

/** A live poll's `since`: where the step after the last one the view has starts. */
export function hostSince(series: HostSeries): string {
  return iso(hostPointStart(series, series.points.length));
}

/**
 * A poll's points (`since`) added to the range on screen: a point the view has is replaced, a gap between the two is
 * left null, and what falls out of the range's length (`HOST_METRICS_POINTS`) at the old end is dropped. Another range
 * or step replaces the series.
 */
export function mergeHostSeries(current: HostSeries, next: HostSeries): HostSeries {
  if (next.range !== current.range || next.stepS !== current.stepS) return next;
  const keep = HOST_METRICS_POINTS[current.range];
  const step = current.stepS * 1000;
  const start = at(current.start);
  const offset = Math.round((at(next.start) - start) / step);
  // Away longer than the range: nothing of what the view had is still in it.
  if (offset - current.points.length >= keep) return next;
  const points = [...current.points];
  next.points.forEach((p, i) => {
    const index = offset + i;
    if (index < 0) return;
    while (points.length < index) points.push(null);
    points[index] = p;
  });
  const drop = Math.max(0, points.length - keep);
  return { ...current, start: iso(start + drop * step), points: points.slice(drop) };
}

/** A poll's answer on top of what is shown: its latest sample, disks and days, the points merged (`mergeHostSeries`). */
export function mergeHostMetrics(current: HostMetrics, next: HostMetrics): HostMetrics {
  return { ...next, series: mergeHostSeries(current.series, next.series) };
}

/** One point as the charts draw it; null values where nothing was measured. */
export interface HostChartPoint {
  /** The point's start (ms). */
  at: number;
  /** Busy share of all cores, 0–100 (the step's average). */
  cpuPct: number | null;
  /** The busiest sample in the step, 0–100. */
  cpuPeakPct: number | null;
  /** Received on the uplink, bits per second. */
  downBps: number | null;
  /** Sent on the uplink, bits per second. */
  upBps: number | null;
}

/**
 * The range's points for the charts, always the range's full length (`HOST_METRICS_POINTS`): a series that is shorter
 * (a box measuring for less than the range) is padded with gaps at the old end, so the x axis is the same at every
 * moment of a range.
 */
export function hostChartPoints(series: HostSeries): HostChartPoint[] {
  const length = Math.max(HOST_METRICS_POINTS[series.range], series.points.length);
  const pad = length - series.points.length;
  return Array.from({ length }, (_, k) => {
    const i = k - pad;
    const p: HostPoint | null = i >= 0 ? (series.points[i] ?? null) : null;
    return {
      at: hostPointStart(series, i),
      cpuPct: p ? p.cpuPermille / 10 : null,
      cpuPeakPct: p ? p.cpuPeakPermille / 10 : null,
      downBps: p ? bitsPerSecond(p.inBytes, series.stepS) : null,
      upBps: p ? bitsPerSecond(p.outBytes, series.stepS) : null,
    };
  });
}

/** The busiest moment of the range (`cpuPeakPermille`), or null before anything was measured. */
export function hostPeak(series: HostSeries): { pct: number; at: number } | null {
  let best: { pct: number; at: number } | null = null;
  series.points.forEach((p, i) => {
    if (p && (!best || p.cpuPeakPermille / 10 > best.pct))
      best = { pct: p.cpuPeakPermille / 10, at: hostPointStart(series, i) };
  });
  return best;
}

/**
 * `Measuring since 14:02. The charts fill in as time goes on.` while the range reaches back before the first
 * measurement (by more than one step); null once the range is measured all the way.
 */
export function hostMeasuringNote(metrics: HostMetrics): string | null {
  const { series } = metrics;
  const rangeStart = hostPointStart(series, series.points.length - HOST_METRICS_POINTS[series.range]);
  return at(metrics.measuringSince) > rangeStart + series.stepS * 1000
    ? HOST_STATUS_COPY.measuringSince(metrics.measuringSince, metrics.timeZone)
    : null;
}

/* Tiles ------------------------------------------------------------------------------------------------------------ */

/** A tile: the big value, the smaller words after it, the line under it; a meter's share or a sparkline's values. */
export interface HostTiles {
  processor: { value: string; line: string | null; spark: (number | null)[] };
  memory: { value: string; unit: string; line: string | null; pct: number };
  disk: { value: string; unit: string; line: string; pct: number };
  today: { value: string; unit: string; line: string; spark: (number | null)[] };
}

/** `1.8` with `of 16 GB` when both are in the same unit; else `850 MB` with `of 16 GB`. */
function usedOf(used: number, total: number, of: (total: string) => string): { value: string; unit: string } {
  const u = formatBytes(used);
  const t = formatBytes(total);
  const [uNumber, uUnit] = u.split(NBSP);
  const tUnit = t.split(NBSP)[1];
  return { value: uUnit === tUnit ? (uNumber ?? u) : u, unit: of(t) };
}

/**
 * The four tiles (BS-10): Processor now with the range's peak and its time; Memory used of total with a meter and the
 * agent's containers' share (OP-16); Disk used of total with a meter (as `df` counts it) and what's free; Today received with sent. The
 * sparklines are the range's processor and download (null: a gap).
 */
export function hostTiles(metrics: HostMetrics): HostTiles {
  const { now, disks, series, timeZone } = metrics;
  const peak = hostPeak(series);
  const today = metrics.days.at(-1);
  const memory = usedOf(now.memoryUsedBytes, now.memoryTotalBytes, HOST_STATUS_COPY.memoryOf);
  const disk = usedOf(disks.data.usedBytes, disks.data.totalBytes, HOST_STATUS_COPY.diskOf);
  return {
    processor: {
      value: formatUsagePct(now.cpuPermille / 10),
      line: peak ? HOST_STATUS_COPY.peak(peak.pct, iso(peak.at), timeZone) : null,
      spark: series.points.map((p) => (p ? p.cpuPermille / 10 : null)),
    },
    memory: {
      ...memory,
      line:
        now.containersMemoryBytes === null
          ? null
          : HOST_STATUS_COPY.memoryContainers(now.containersMemoryBytes),
      pct: now.memoryTotalBytes > 0 ? (now.memoryUsedBytes / now.memoryTotalBytes) * 100 : 0,
    },
    disk: {
      ...disk,
      line: HOST_STATUS_COPY.diskFree(disks.data.freeBytes),
      pct: hostDiskUsedPct(disks.data),
    },
    today: {
      value: formatBytes(today?.inBytes ?? 0),
      unit: HOST_STATUS_COPY.todayIn,
      line: HOST_STATUS_COPY.todayOut(today?.outBytes ?? 0),
      spark: series.points.map((p) => (p ? bitsPerSecond(p.inBytes, series.stepS) : null)),
    },
  };
}

/* Charts ----------------------------------------------------------------------------------------------------------- */

/** A tick on the time axis: the chart point's index and its words. */
export interface HostTick {
  index: number;
  label: string;
}

/** A moment on the axis: `14:25` within a day's ranges, `Mon` across a week, `3 Oct` across a month. */
function axisLabel(ms: number, range: HostMetricsRange, timeZone: string): string {
  if (range === 'week') return formatShortWeekday(ms, timeZone);
  if (range === 'month') return formatDate(ms, timeZone, { year: 'never' });
  return formatClock(ms, timeZone);
}

/** Five ticks over the chart's points (start, the quarters, the end), the last one `now`, as the mock draws them. */
export function hostTimeTicks(
  points: readonly HostChartPoint[],
  range: HostMetricsRange,
  timeZone: string,
): HostTick[] {
  const n = points.length;
  if (n < 2) return [];
  const indexes = [0, 1, 2, 3].map((q) => Math.round(((n - 1) * q) / 4));
  return [
    ...indexes.map((index) => ({ index, label: axisLabel(points[index]?.at ?? 0, range, timeZone) })),
    { index: n - 1, label: HOST_CHART_WORDS.now },
  ];
}

/** A point's moment at the top of its tooltip: `14:25`, or `Sat 10 Oct · 14:30` in the week's and month's ranges. */
export function hostPointLabel(ms: number, range: HostMetricsRange, timeZone: string): string {
  const clock = formatClock(ms, timeZone);
  return range === 'hour' || range === 'day'
    ? clock
    : `${formatShortWeekday(ms, timeZone)} ${formatDate(ms, timeZone, { year: 'never' })} · ${clock}`;
}

/** A value scale's top and its three gridlines (0, half, top). */
export interface HostScale {
  max: number;
  ticks: [number, number, number];
}

/** The smallest of 1, 2, 4, 5, 8 × 10ⁿ at or above `value` (so half of it is a round number too), at least `floor`. */
export function niceCeiling(value: number, floor: number): number {
  const v = Math.max(value, floor);
  const magnitude = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 4, 5, 8, 10].find((m) => m * magnitude >= v * (1 - 1e-9)) ?? 10;
  return step * magnitude;
}

const scale = (max: number): HostScale => ({ max, ticks: [0, max / 2, max] });

/** The processor chart's scale: always 0–100 %. */
export const HOST_CPU_SCALE: HostScale = scale(100);

/** The speed chart's scale in bits per second: the busiest point rounded up, at least 1 Mbit/s. */
export function hostSpeedScale(points: readonly HostChartPoint[]): HostScale {
  const top = Math.max(0, ...points.map((p) => Math.max(p.downBps ?? 0, p.upBps ?? 0)));
  return scale(niceCeiling(top / 1_000_000, 1) * 1_000_000);
}

/** The speed axis's numbers (no unit, the hint says it): `0`, `40`, `2.5`. */
export function hostSpeedTick(bitsPerS: number): string {
  const m = bitsPerS / 1_000_000;
  return String(Number(m.toFixed(1)));
}

/** A tooltip line split where its value ends (`12 Mbit/s` · `down`, `2.2 GB` · `received`): values lead, in bold. */
export function splitLead(line: string): { value: string; rest: string } {
  const space = line.indexOf(' ');
  return space < 0 ? { value: line, rest: '' } : { value: line.slice(0, space), rest: line.slice(space + 1) };
}

/* Days ------------------------------------------------------------------------------------------------------------- */

/** A calendar day (`YYYY-MM-DD`) at noon UTC, so its weekday and date read the same in every zone. */
const noonOf = (date: string) => `${date}T12:00:00Z`;

/** `Sat 10 Oct`; `Today so far` for today. */
function dayTitle(date: string, today: boolean): string {
  return today
    ? HOST_STATUS_COPY.todaySoFar
    : `${formatShortWeekday(noonOf(date), 'UTC')} ${formatDate(noonOf(date), 'UTC', { year: 'never' })}`;
}

/** Under the 14 columns: `today` under the last, a weekday under every third (the second, fifth, …), as the mock. */
function dayAxis(date: string, i: number, today: boolean): string {
  if (today) return HOST_CHART_WORDS.today;
  return i % 3 === 1 ? formatShortWeekday(noonOf(date), 'UTC') : '';
}

/** One column of Data per day. */
export interface HostDayRow {
  date: string;
  /** Under the column (often empty). */
  axis: string;
  /** The tooltip's and the table's first line. */
  title: string;
  today: boolean;
  inBytes: number;
  outBytes: number;
}

/** The last `HOST_CHART_DAYS` days of traffic, oldest first, today last (BS-05). */
export function hostDayRows(days: readonly HostDay[]): HostDayRow[] {
  const last = days.slice(-HOST_CHART_DAYS);
  return last.map((d, i) => {
    const today = i === last.length - 1;
    return {
      date: d.date,
      axis: dayAxis(d.date, i, today),
      title: dayTitle(d.date, today),
      today,
      inBytes: d.inBytes,
      outBytes: d.outBytes,
    };
  });
}

/** A day's tooltip lines: received and sent. */
export function hostDayLines(row: HostDayRow): { received: string; sent: string } {
  return {
    received: HOST_STATUS_COPY.receivedValue(row.inBytes),
    sent: HOST_STATUS_COPY.sentValue(row.outBytes),
  };
}

/** Data per day's scale in bytes (received and sent stacked), at least 1 MB. */
export function hostDayScale(rows: readonly HostDayRow[]): HostScale {
  const top = Math.max(0, ...rows.map((r) => r.inBytes + r.outBytes));
  return top >= 1_000_000_000
    ? scale(niceCeiling(top / 1_000_000_000, 1) * 1_000_000_000)
    : scale(niceCeiling(top / 1_000_000, 1) * 1_000_000);
}

/** The days axis's numbers in the scale's unit, without it (the mock's `0`, `2.5`, `5` for gigabytes). */
export function hostDayTick(bytes: number, max: number): string {
  const unit = max >= 1_000_000_000 ? 1_000_000_000 : 1_000_000;
  return String(Number((bytes / unit).toFixed(1)));
}

/* Disk ------------------------------------------------------------------------------------------------------------- */

export type HostDiskRowKey = HostDiskPartKey | 'other' | 'free';

/** A row of the disk's legend and a part of its bar. */
export interface HostDiskRow {
  key: HostDiskRowKey;
  label: string;
  bytes: number;
  /** `22.9 GB` */
  value: string;
}

/**
 * The data disk's parts, largest first, then `Other` (used minus the parts, from half a gigabyte) and `Free` (BS-10).
 * While the quota numbers are recounted (`parts` null) only Free: the card's line says what is used.
 */
export function hostDiskRows(disk: HostDisks['data']): HostDiskRow[] {
  const parts = (disk.parts ?? []).filter((p) => p.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  const rows: HostDiskRow[] = parts.map((p) => ({
    key: p.key,
    label: HOST_DISK_PART_LABELS[p.key],
    bytes: p.bytes,
    value: formatBytes(p.bytes),
  }));
  const rest = disk.usedBytes - parts.reduce((sum, p) => sum + p.bytes, 0);
  if (disk.parts && rest >= OTHER_MIN_BYTES)
    rows.push({ key: 'other', label: HOST_STATUS_COPY.other, bytes: rest, value: formatBytes(rest) });
  rows.push({
    key: 'free',
    label: HOST_STATUS_COPY.free,
    bytes: disk.freeBytes,
    value: formatBytes(disk.freeBytes),
  });
  return rows;
}

/** The Disk card's line (`40 GB used of 87 GB`) and the system and backup disks' lines under the legend. */
export function hostDiskText(disks: HostDisks): { used: string; others: string[] } {
  const others = [HOST_STATUS_COPY.systemDisk(disks.system.usedBytes, disks.system.totalBytes)];
  if (disks.backup) others.push(HOST_STATUS_COPY.backupDisk(disks.backup.usedBytes, disks.backup.totalBytes));
  return { used: HOST_STATUS_COPY.diskUsedOf(disks.data.usedBytes, disks.data.totalBytes), others };
}

/** The bar's parts: the used ones (one segment for all of it while there are no parts) and Free, in the legend's order. */
export function hostDiskBar(disk: HostDisks['data'], rows: readonly HostDiskRow[]): HostDiskRow[] {
  if (disk.parts) return rows.filter((r) => r.bytes > 0);
  const used: HostDiskRow = {
    key: 'other',
    label: HOST_STATUS_COPY.other,
    bytes: disk.usedBytes,
    value: formatBytes(disk.usedBytes),
  };
  return [used, ...rows].filter((r) => r.bytes > 0);
}

/* Tokens ----------------------------------------------------------------------------------------------------------- */

/** One column of the Tokens card. */
export interface HostTokenDay {
  date: string;
  title: string;
  today: boolean;
  /** As billed (`spendTokens`: cache reads at a tenth), like Settings → AI → Spend. */
  tokens: number;
  /** `3.4M tokens` */
  line: string;
}

export interface HostTokens {
  /** `3.4M today · 94 % read from cache`. */
  summary: string;
  days: HostTokenDay[];
}

/**
 * The Tokens card (BS-07, BS-10): today's total and cache share and 14 days of columns from `spend.daily` (today from
 * `spend.overview` while the days aren't there). One agent: no list of agents under it (one-agent.md AP-4951).
 */
export function hostTokens(daily: SpendDaily | null, overview: SpendOverview | null): HostTokens {
  const days = (daily?.days ?? []).slice(-HOST_CHART_DAYS);
  const todayUsage = days.at(-1) ?? overview?.totals.today ?? null;
  const tokens = todayUsage ? spendTokens(todayUsage) : 0;
  const cache = todayUsage ? cacheReadPct(todayUsage) : null;
  return {
    summary: HOST_STATUS_COPY.tokensToday(tokens, cache),
    days: days.map((d, i) => {
      const today = i === days.length - 1;
      const t = spendTokens(d);
      return {
        date: d.date,
        title: dayTitle(d.date, today),
        today,
        tokens: t,
        line: HOST_STATUS_COPY.tokensValue(t),
      };
    }),
  };
}
