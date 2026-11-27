/**
 * How the box is doing (0.78, CT-334; Whombat docs/decisions/box-status.md BS-01…BS-12): the words of Settings → This
 * Whombat → “How it’s doing”, its number formats and the disk alerts. Sizes are decimal (1 GB is
 * 1,000,000,000 bytes), as people read them on a phone or a disk's box; a number and its unit are joined by a no-break
 * space. Times are the burrow's clock, 24-hour (`formatClock`).
 */
import { formatTokenCount } from '../domain/spend.js';
import { coreTranslator } from '../i18n/catalog.js';
import { formatLocaleNumber } from '../i18n/format.js';
import { type DateInput, formatClock } from './time.js';
import { formatUsagePct, NBSP } from './usage.js';

/** The chart ranges (`HostMetricsRange` of `@whombat/protocol/session`), shortest first. */
export type HostRange = 'hour' | 'day' | 'week' | 'month';
const HOST_RANGES: readonly HostRange[] = ['hour', 'day', 'week', 'month'];

/** The chart range labels in a locale. */
export function hostRangeLabels(locale?: string | null): Readonly<Record<HostRange, string>> {
  const tr = coreTranslator(locale);
  return Object.fromEntries(HOST_RANGES.map((r) => [r, tr.t(`host.range.${r}`)])) as Record<
    HostRange,
    string
  >;
}
export const HOST_RANGE_LABELS: Readonly<Record<HostRange, string>> = hostRangeLabels('en');

/** What the data disk holds (`HostDiskPartKey`): a legend row's label and the same words inside a sentence. */
export type HostDiskPart = 'containers' | 'whombat' | 'work' | 'database';
const HOST_DISK_PARTS: readonly HostDiskPart[] = ['containers', 'whombat', 'work', 'database'];

/** The disk legend's labels in a locale. */
export function hostDiskPartLabels(locale?: string | null): Readonly<Record<HostDiskPart, string>> {
  const tr = coreTranslator(locale);
  return Object.fromEntries(HOST_DISK_PARTS.map((p) => [p, tr.t(`host.part.${p}`)])) as Record<
    HostDiskPart,
    string
  >;
}
export const HOST_DISK_PART_LABELS: Readonly<Record<HostDiskPart, string>> = hostDiskPartLabels('en');

/** Days in the Data per day and Tokens columns. */
export const HOST_CHART_DAYS = 14;

const trim1 = (n: number, locale?: string | null) =>
  formatLocaleNumber(Number(n.toFixed(1)), locale, { maximumFractionDigits: 1, useGrouping: false });

/**
 * Bytes as people read them: `0 B`, `850 KB`, `41 MB`, `2.2 GB`, `22.9 GB`, `87 GB`, `140 GB`, `1.2 TB`. One decimal below
 * 100 GB (none when it's .0), whole numbers for KB and MB.
 */
export function formatBytes(bytes: number, locale?: string | null): string {
  const b = Math.max(0, Math.round(bytes));
  if (b < 1_000) return `${b}${NBSP}B`;
  if (b < 999_500) return `${Math.round(b / 1_000)}${NBSP}KB`;
  if (b < 999_500_000) return `${Math.round(b / 1_000_000)}${NBSP}MB`;
  if (b < 99_950_000_000) return `${trim1(b / 1_000_000_000, locale)}${NBSP}GB`;
  if (b < 999_500_000_000) return `${Math.round(b / 1_000_000_000)}${NBSP}GB`;
  return `${trim1(b / 1_000_000_000_000, locale)}${NBSP}TB`;
}

/** A speed in megabits per second, the chart's unit: `0`, `0.4`, `3.2`, `48` (no unit; one decimal below 10). */
export function formatMbits(bitsPerSecond: number, locale?: string | null): string {
  const m = Math.max(0, bitsPerSecond) / 1_000_000;
  if (m === 0) return '0';
  if (m < 0.05) return `<${trim1(0.1, locale)}`;
  return m < 10 ? trim1(m, locale) : String(Math.round(m));
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

/** Settings → This Whombat → “How it’s doing” in a locale. */
export function hostStatusCopy(locale?: string | null) {
  const tr = coreTranslator(locale);
  const bytes = (n: number) => formatBytes(n, locale);
  return {
    title: tr.t('host.title'),
    live: tr.t('host.live'),
    rangeGroup: tr.t('host.rangeGroup'),
    processor: tr.t('host.processor'),
    processorHint: (cores: number) => tr.tp('host.processorHint', cores),
    memory: tr.t('host.memory'),
    memoryOf: (total: string) => tr.t('host.of', { total }),
    /** What the agent's containers hold, in words a non-developer knows: the apps and sites it runs. */
    memoryContainers: (n: number) => tr.t('host.memoryContainers', { size: bytes(n) }),
    disk: tr.t('host.disk'),
    diskOf: (total: string) => tr.t('host.of', { total }),
    diskFree: (n: number) => tr.t('host.diskFree', { size: bytes(n) }),
    diskUsedOf: (used: number, total: number) =>
      tr.t('host.diskUsedOf', { used: bytes(used), total: bytes(total) }),
    systemDisk: (used: number, total: number) =>
      tr.t('host.systemDisk', { used: bytes(used), total: bytes(total) }),
    backupDisk: (used: number, total: number) =>
      tr.t('host.backupDisk', { used: bytes(used), total: bytes(total) }),
    free: tr.t('host.free'),
    other: tr.t('host.other'),
    today: tr.t('host.today'),
    todayIn: tr.t('host.todayIn'),
    todayOut: (n: number) => tr.t('host.todayOut', { size: bytes(n) }),
    networkSpeed: tr.t('host.networkSpeed'),
    networkHint: tr.t('host.networkHint'),
    download: tr.t('host.download'),
    upload: tr.t('host.upload'),
    /** Tooltip rows of the speed chart: `12 Mbit/s down`. */
    speedDown: (bitsPerS: number) => tr.t('host.speedDown', { speed: formatMbits(bitsPerS, locale) }),
    speedUp: (bitsPerS: number) => tr.t('host.speedUp', { speed: formatMbits(bitsPerS, locale) }),
    busy: (pct: number) => tr.t('host.busy', { pct: formatUsagePct(pct) }),
    perDay: tr.t('host.perDay'),
    perDayHint: tr.t('host.perDayHint', { days: HOST_CHART_DAYS }),
    received: tr.t('host.received'),
    sent: tr.t('host.sent'),
    receivedValue: (n: number) => tr.t('host.receivedValue', { size: bytes(n) }),
    sentValue: (n: number) => tr.t('host.sentValue', { size: bytes(n) }),
    todaySoFar: tr.t('host.todaySoFar'),
    tokens: tr.t('host.tokens'),
    /** `3.4M today · 94 % read from cache`; without the cache part when nothing was read from it. */
    tokensToday: (tokens: number, cachePct: number | null) =>
      cachePct === null || cachePct < 1
        ? tr.t('host.tokensToday', { tokens: formatTokenCount(tokens) })
        : tr.t('host.tokensTodayCache', { tokens: formatTokenCount(tokens), pct: formatUsagePct(cachePct) }),
    tokensValue: (tokens: number) => tr.t('host.tokensValue', { tokens: formatTokenCount(tokens) }),
    moreInAi: tr.t('host.moreInAi'),
    noAgentWorkToday: tr.t('host.noAgentWorkToday'),
    /** The tile's line under the processor's number: `Peak 86 % at 14:25`. */
    peak: (pct: number, at: DateInput, timeZone: string) =>
      tr.t('host.peak', { pct: formatUsagePct(pct), time: formatClock(at, timeZone) }),
    unavailable: tr.t('host.unavailable'),
    /** While less than the range has been measured. */
    measuringSince: (at: DateInput, timeZone: string) =>
      tr.t('host.measuringSince', { time: formatClock(at, timeZone) }),
    showTable: tr.t('host.showTable'),
    showChart: tr.t('host.showChart'),
  };
}

export type HostStatusCopy = ReturnType<typeof hostStatusCopy>;

export const HOST_STATUS_COPY: HostStatusCopy = hostStatusCopy('en');

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
  locale?: string | null;
}): string {
  const tr = coreTranslator(input.locale);
  const most = input.biggest
    ? tr.t('host.alertMost', {
        part: tr.t(`host.phrase.${input.biggest.key}`),
        size: formatBytes(input.biggest.bytes, input.locale),
      })
    : '';
  const free = formatBytes(input.freeBytes, input.locale);
  if (input.level === 95) return tr.t('host.alertFull', { free, most });
  return tr.t('host.alert', { pct: formatUsagePct(input.usedPct), free, most });
}
