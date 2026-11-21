/**
 * How the box is doing (0.78, CT-334; Whombat docs/decisions/box-status.md BS-01…BS-12): the words of Settings → This
 * Whombat → “How it’s doing”, its number formats and the disk alerts. Sizes are decimal (1 GB is
 * 1,000,000,000 bytes), as people read them on a phone or a disk's box; a number and its unit are joined by a no-break
 * space. Times are the burrow's clock, 24-hour (`formatClock`).
 */
import { formatTokenCount } from '../domain/spend.js';
import { type DateInput, formatClock } from './time.js';
import { formatUsagePct, NBSP } from './usage.js';

/** The chart ranges (`HostMetricsRange` of `@whombat/protocol/session`), shortest first. */
export type HostRange = 'hour' | 'day' | 'week' | 'month';
export const HOST_RANGE_LABELS: Readonly<Record<HostRange, string>> = {
  hour: 'Last hour',
  day: '24 hours',
  week: '7 days',
  month: '30 days',
};

/** What the data disk holds (`HostDiskPartKey`): a legend row's label and the same words inside a sentence. */
export type HostDiskPart = 'containers' | 'whombat' | 'work' | 'database';
export const HOST_DISK_PART_LABELS: Readonly<Record<HostDiskPart, string>> = {
  containers: 'The agent’s containers',
  whombat: 'Whombat’s own data',
  work: 'Work folders',
  database: 'Conversations and history',
};
const HOST_DISK_PART_PHRASES: Readonly<Record<HostDiskPart, string>> = {
  containers: 'the agent’s containers',
  whombat: 'the Whombat’s own data',
  work: 'work folders',
  database: 'conversations and history',
};

/** Days in the Data per day and Tokens columns. */
export const HOST_CHART_DAYS = 14;

const trim1 = (n: number) => String(Number(n.toFixed(1)));

/**
 * Bytes as people read them: `0 B`, `850 KB`, `41 MB`, `2.2 GB`, `22.9 GB`, `87 GB`, `140 GB`, `1.2 TB`. One decimal below
 * 100 GB (none when it's .0), whole numbers for KB and MB.
 */
export function formatBytes(bytes: number): string {
  const b = Math.max(0, Math.round(bytes));
  if (b < 1_000) return `${b}${NBSP}B`;
  if (b < 999_500) return `${Math.round(b / 1_000)}${NBSP}KB`;
  if (b < 999_500_000) return `${Math.round(b / 1_000_000)}${NBSP}MB`;
  if (b < 99_950_000_000) return `${trim1(b / 1_000_000_000)}${NBSP}GB`;
  if (b < 999_500_000_000) return `${Math.round(b / 1_000_000_000)}${NBSP}GB`;
  return `${trim1(b / 1_000_000_000_000)}${NBSP}TB`;
}

/** A speed in megabits per second, the chart's unit: `0`, `0.4`, `3.2`, `48` (no unit; one decimal below 10). */
export function formatMbits(bitsPerSecond: number): string {
  const m = Math.max(0, bitsPerSecond) / 1_000_000;
  if (m === 0) return '0';
  if (m < 0.05) return '<0.1';
  return m < 10 ? trim1(m) : String(Math.round(m));
}

/** Megabits per second of `bytes` moved in `stepS` seconds. */
export function bitsPerSecond(bytes: number, stepS: number): number {
  return stepS > 0 ? (bytes * 8) / stepS : 0;
}

/** Used share of a filesystem as `df` counts it: used ÷ (used + free), 0–100. */
export function hostDiskUsedPct(disk: { usedBytes: number; freeBytes: number }): number {
  const room = disk.usedBytes + disk.freeBytes;
  return room > 0 ? (disk.usedBytes / room) * 100 : 0;
}

/** Read from the prompt cache, as a share of input: `94 %`; null when nothing was read in. */
export function cacheReadPct(input: {
  inputTokens: number;
  cacheReadTokens?: number | undefined;
}): number | null {
  if (input.inputTokens <= 0) return null;
  return (Math.min(input.cacheReadTokens ?? 0, input.inputTokens) / input.inputTokens) * 100;
}

export const HOST_STATUS_COPY = {
  title: 'How it’s doing',
  live: 'Live · checked every 10 seconds',
  rangeGroup: 'Time range',
  processor: 'Processor',
  processorHint: (cores: number) =>
    cores === 1
      ? 'How busy the Whombat was, in percent of its processor'
      : `How busy the Whombat was, in percent of all ${cores} cores`,
  memory: 'Memory',
  memoryOf: (total: string) => `of ${total}`,
  /** What the agent's containers hold, in words a non-developer knows: the apps and sites it runs (OP-19). */
  memoryContainers: (bytes: number) => `Apps and sites ${formatBytes(bytes)}`,
  disk: 'Disk',
  diskOf: (total: string) => `of ${total}`,
  diskFree: (bytes: number) => `${formatBytes(bytes)} free`,
  diskUsedOf: (used: number, total: number) => `${formatBytes(used)} used of ${formatBytes(total)}`,
  systemDisk: (used: number, total: number) => `System ${formatBytes(used)} of ${formatBytes(total)}`,
  backupDisk: (used: number, total: number) => `Backup disk ${formatBytes(used)} of ${formatBytes(total)}`,
  free: 'Free',
  other: 'Other',
  today: 'Today',
  todayIn: 'in',
  todayOut: (bytes: number) => `${formatBytes(bytes)} out`,
  networkSpeed: 'Network speed',
  networkHint: 'Megabits per second',
  download: 'Download',
  upload: 'Upload',
  /** Tooltip rows of the speed chart: `12 Mbit/s down`. */
  speedDown: (bitsPerS: number) => `${formatMbits(bitsPerS)}${NBSP}Mbit/s down`,
  speedUp: (bitsPerS: number) => `${formatMbits(bitsPerS)}${NBSP}Mbit/s up`,
  busy: (pct: number) => `${formatUsagePct(pct)} busy`,
  perDay: 'Data per day',
  perDayHint: `Last ${HOST_CHART_DAYS} days`,
  received: 'Received',
  sent: 'Sent',
  receivedValue: (bytes: number) => `${formatBytes(bytes)} received`,
  sentValue: (bytes: number) => `${formatBytes(bytes)} sent`,
  todaySoFar: 'Today so far',
  tokens: 'Tokens',
  /** `3.4M today · 94 % read from cache`; without the cache part when nothing was read from it. */
  tokensToday: (tokens: number, cachePct: number | null) =>
    cachePct === null || cachePct < 1
      ? `${formatTokenCount(tokens)} today`
      : `${formatTokenCount(tokens)} today · ${formatUsagePct(cachePct)} read from cache`,
  tokensValue: (tokens: number) => `${formatTokenCount(tokens)} tokens`,
  moreInAi: 'More in AI',
  noAgentWorkToday: 'No agent work yet today.',
  /** The tile's line under the processor's number: `Peak 86 % at 14:25`. */
  peak: (pct: number, at: DateInput, timeZone: string) =>
    `Peak ${formatUsagePct(pct)} at ${formatClock(at, timeZone)}`,
  unavailable: 'The Whombat can’t read its measurements right now.',
  /** While less than the range has been measured. */
  measuringSince: (at: DateInput, timeZone: string) =>
    `Measuring since ${formatClock(at, timeZone)}. The charts fill in as time goes on.`,
  showTable: 'Show as a table',
  showChart: 'Show as a chart',
} as const;

/* Disk alerts (BS-09) --------------------------------------------------------------------------------------------- */

/** The levels the person hears about, in percent used; a level re-arms once the disk is 5 points below it. */
export const HOST_DISK_ALERT_LEVELS = [85, 95] as const;
export type HostDiskAlertLevel = (typeof HOST_DISK_ALERT_LEVELS)[number];
const REARM_POINTS = 5;

/**
 * The disk alert state machine: given how full the disk is now and the level last alerted (0: none), the level to
 * alert now (null: none) and the level to keep. 85 % then 95 % alert once each; a level is kept while the disk stays
 * within 5 points below it, so a disk going 86 → 84 → 86 % says nothing new, but 86 → 79 → 86 % says it again.
 */
export function hostDiskAlertDue(
  usedPct: number,
  last: 0 | HostDiskAlertLevel,
): { alert: HostDiskAlertLevel | null; keep: 0 | HostDiskAlertLevel } {
  let keep: 0 | HostDiskAlertLevel = 0;
  for (const level of HOST_DISK_ALERT_LEVELS) {
    if (level <= last && usedPct >= level - REARM_POINTS) keep = level;
  }
  let target: HostDiskAlertLevel | null = null;
  for (const level of HOST_DISK_ALERT_LEVELS) if (usedPct >= level) target = level;
  if (target !== null && target > keep) return { alert: target, keep: target };
  return { alert: null, keep };
}

/**
 * What the agent tells the person (BS-09), one to three plain sentences:
 * - `The Whombat’s disk is 86 % full, with 12 GB left. Most space goes to the agent’s containers (22.9 GB).`
 * - `The Whombat’s disk is almost full: 4.1 GB left. When it runs out, the agent can’t work. Most space goes to the
 *   agent’s containers (22.9 GB).`
 */
export function hostDiskAlertText(input: {
  level: HostDiskAlertLevel;
  usedPct: number;
  freeBytes: number;
  /** The largest part, when the parts are known. */
  biggest?: { key: HostDiskPart; bytes: number } | null | undefined;
}): string {
  const most = input.biggest
    ? ` Most space goes to ${HOST_DISK_PART_PHRASES[input.biggest.key]} (${formatBytes(input.biggest.bytes)}).`
    : '';
  const free = formatBytes(input.freeBytes);
  if (input.level === 95) {
    return `The Whombat’s disk is almost full: ${free} left. When it runs out, the agent can’t work.${most}`;
  }
  return `The Whombat’s disk is ${formatUsagePct(input.usedPct)} full, with ${free} left.${most}`;
}
