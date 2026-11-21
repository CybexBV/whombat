// Display formats, SCREENS.md section 7. Every date/time function renders in
// the viewer's time zone unless a `timeZone` is passed (tests pass one).
// Unit tested in format.test.ts with the vectors from ACCEPTANCE.md section 7.

import type { Range } from '../api/types';
import { LANG, LOCALE, t } from './i18n';

// formatRelativeDay shadows t with a timestamp.
const tr = t;

export const DASH = '—';

// ------------------------------------------------------------ plurals, words

/** "1 server", "3 servers", "0 servers" (the words are translated). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${t(n === 1 ? one : many)}`;
}

const WORDS =
  LANG === 'nl'
    ? ['Geen', 'Eén', 'Twee', 'Drie', 'Vier', 'Vijf', 'Zes', 'Zeven', 'Acht', 'Negen', 'Tien']
    : ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** Capitalized number word for small counts ("Five sensors"), digits above ten. */
export function countWord(n: number, one: string, many = `${one}s`): string {
  const w = WORDS[n] ?? String(n);
  return `${w} ${t(n === 1 ? one : many)}`;
}

/** Lower-case number word for small counts ("all six disks"). */
export function numberWord(n: number): string {
  const w = WORDS[n];
  return w ? w.toLowerCase() : String(n);
}

// ------------------------------------------------------------ numbers

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Thousands separators: 14210 -> "14,210". */
export function formatInt(v: number): string {
  return intFmt.format(v);
}

/** Trim trailing zeros of a fixed-point string: "1.40" -> "1.4", "35.00" -> "35". */
function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * Compact number for rates and table cells: 0 -> "0", below 10 up to one
 * decimal ("0.4", "1.2", "1"), from 10 an integer ("42", "412").
 */
export function formatNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  if (v === 0) return '0';
  if (Math.abs(v) < 10) return trimZeros(v.toFixed(1));
  return formatInt(Math.round(v));
}

/** Integer percent for cards and KPIs: "34%". */
export function formatPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${Math.round(v)}%`;
}

/** One-decimal percent for tooltips and tables: "44.0%". */
export function formatPct1(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(1)}%`;
}

/** Overcommit ratio: "0.46 : 1". */
export function formatRatio(v: number): string {
  return `${v.toFixed(2)} : 1`;
}

// ------------------------------------------------------------ sizes and rates

/**
 * Storage size from GB (decimal units): below 1 GB in MB ("128 MB"), GB below
 * 1000 ("440 GB"), TB with two decimals below 10 TB ("1.42 TB") and one
 * decimal from 10 TB ("10.2 TB"), trailing zeros trimmed ("1 TB", "100 TB").
 */
export function formatGb(gb: number | null | undefined): string {
  if (gb == null || !Number.isFinite(gb)) return DASH;
  if (gb < 1) return `${Math.round(gb * 1000)} MB`;
  if (gb < 10) return `${trimZeros(gb.toFixed(1))} GB`;
  if (gb < 1000) return `${Math.round(gb)} GB`;
  const tb = gb / 1000;
  return `${trimZeros(tb >= 10 ? tb.toFixed(1) : tb.toFixed(2))} TB`;
}

/** Storage size from TB: 62.2 -> "62.2 TB", 100 -> "100 TB". */
export function formatTb(tb: number | null | undefined): string {
  return tb == null ? DASH : formatGb(tb * 1000);
}

/** Integer GB as on the fleet and meta strip ("256 GB"). */
export function formatGbInt(gb: number | null | undefined): string {
  if (gb == null || !Number.isFinite(gb)) return DASH;
  return `${formatInt(Math.round(gb))} GB`;
}

const MIB_PER_GIB = 1024;

function memPart(mb: number, withUnit: boolean, decimalsForGb: 'used' | 'limit'): string {
  if (mb < MIB_PER_GIB) return `${Math.round(mb)} MB`;
  const gb = mb / MIB_PER_GIB;
  const s = decimalsForGb === 'used' ? gb.toFixed(1) : trimZeros(gb.toFixed(1));
  return withUnit ? `${s} GB` : s;
}

/**
 * Guest memory "used / limit" from MB (binary units): "2.1 / 4 GB",
 * "380 MB / 1 GB", "96 MB / 512 MB", "128 MB" (no limit), "—" (stopped).
 */
export function formatMemPair(usedMb: number | null | undefined, limitMb: number | null | undefined): string {
  if (usedMb == null || !Number.isFinite(usedMb)) return DASH;
  if (limitMb == null || !Number.isFinite(limitMb)) return memPart(usedMb, true, 'used');
  const bothGb = usedMb >= MIB_PER_GIB && limitMb >= MIB_PER_GIB;
  return `${memPart(usedMb, !bothGb, 'used')} / ${memPart(limitMb, true, 'limit')}`;
}

/** Disk throughput: "42 MB/s". */
export function formatDiskRate(mbs: number | null | undefined): string {
  return mbs == null ? DASH : `${formatNum(mbs)} MB/s`;
}

/** Network rate value + unit, Gb/s from 1000 Mb/s: {value: "1.9", unit: "Gb/s"}. */
export function netRateParts(mbps: number): { value: string; unit: 'Mb/s' | 'Gb/s'; scale: number } {
  if (Math.abs(mbps) >= 1000) return { value: trimZeros((mbps / 1000).toFixed(1)), unit: 'Gb/s', scale: 1000 };
  return { value: formatNum(mbps), unit: 'Mb/s', scale: 1 };
}

/** Network rate: "412 Mb/s", "1.2 Gb/s". */
export function formatNetRate(mbps: number | null | undefined): string {
  if (mbps == null || !Number.isFinite(mbps)) return DASH;
  const p = netRateParts(mbps);
  return `${p.value} ${p.unit}`;
}

// ------------------------------------------------------------ temperatures

/** "64 °C" in running text. */
export function formatTemp(c: number | null | undefined): string {
  return c == null || !Number.isFinite(c) ? DASH : `${Math.round(c)} °C`;
}

/** "65.5 °C" in tooltips. */
export function formatTemp1(c: number | null | undefined): string {
  return c == null || !Number.isFinite(c) ? DASH : `${c.toFixed(1)} °C`;
}

/** "64°" in dense tables. */
export function formatTempDense(c: number | null | undefined): string {
  return c == null || !Number.isFinite(c) ? DASH : `${Math.round(c)}°`;
}

// ------------------------------------------------------------ durations

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

/** Relative time: "8 s ago", "14 min ago", "5 h ago", "2 d ago". */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const ago = (v: string) => t('{time} ago', { time: v });
  if (s < MIN) return ago(`${s} s`);
  if (s < HOUR) return ago(`${Math.floor(s / MIN)} min`);
  if (s < DAY) return ago(`${Math.floor(s / HOUR)} ${t('h')}`);
  return ago(`${Math.floor(s / DAY)} d`);
}

/** Relative time between an ISO timestamp and `now`. */
export function formatAgoIso(iso: string, now: number): string {
  return formatAgo((now - Date.parse(iso)) / 1000);
}

/** Future relative time: "In 12 h", "In 14 min", "In 2 d". */
export function formatIn(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const inT = (v: string) => t('In {time}', { time: v });
  if (s < MIN) return inT(`${s} s`);
  if (s < HOUR) return inT(`${Math.round(s / MIN)} min`);
  if (s < DAY) return inT(`${Math.round(s / HOUR)} ${t('h')}`);
  return inT(`${Math.round(s / DAY)} d`);
}

/** Two-unit duration: "11 h 47 m", "41 d 7 h", "14 min", "45 s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < MIN) return `${s} s`;
  if (s < HOUR) return `${Math.floor(s / MIN)} min`;
  if (s < DAY) return `${Math.floor(s / HOUR)} ${t('h')} ${Math.floor((s % HOUR) / MIN)} m`;
  return `${Math.floor(s / DAY)} d ${Math.floor((s % DAY) / HOUR)} ${t('h')}`;
}

/** Single-unit uptime for tables: "41 d", "7 h", "12 min". */
export function formatUptimeShort(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return DASH;
  const s = Math.max(0, Math.floor(seconds));
  if (s < MIN) return `${s} s`;
  if (s < HOUR) return `${Math.floor(s / MIN)} min`;
  if (s < DAY) return `${Math.floor(s / HOUR)} ${t('h')}`;
  return `${Math.floor(s / DAY)} d`;
}

// ------------------------------------------------------------ dates (viewer time zone)

interface Parts {
  weekday: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  year: string;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function parts(date: Date | number, timeZone?: string): Parts {
  const key = timeZone ?? '';
  let f = partsCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    });
    partsCache.set(key, f);
  }
  const out: Parts = { weekday: '', month: '', day: '', hour: '', minute: '', year: '' };
  for (const p of f.formatToParts(date)) {
    if (p.type in out) out[p.type as keyof Parts] = p.value;
  }
  if (out.hour === '24') out.hour = '00';
  return out;
}

/** "14:00" */
export function formatTime(date: Date | number, timeZone?: string): string {
  const p = parts(date, timeZone);
  return `${p.hour}:${p.minute}`;
}

/** "Oct 6" (Dutch: "6 okt.") */
export function formatDay(date: Date | number, timeZone?: string): string {
  const p = parts(date, timeZone);
  return LANG === 'nl' ? `${p.day} ${p.month}` : `${p.month} ${p.day}`;
}

/** "Sat 20:11" */
export function formatWeekdayTime(date: Date | number, timeZone?: string): string {
  const p = parts(date, timeZone);
  return `${p.weekday} ${p.hour}:${p.minute}`;
}

/** "Oct 6, 14:00" (Dutch: "6 okt. 14:00") */
export function formatDayTime(date: Date | number, timeZone?: string): string {
  const p = parts(date, timeZone);
  return LANG === 'nl' ? `${p.day} ${p.month} ${p.hour}:${p.minute}` : `${p.month} ${p.day}, ${p.hour}:${p.minute}`;
}

/** Full timestamp for `title` attributes: "Sun Oct 11 2026, 14:00". */
export function formatFull(date: Date | number, timeZone?: string): string {
  const p = parts(date, timeZone);
  return LANG === 'nl' ? `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}` : `${p.weekday} ${p.month} ${p.day} ${p.year}, ${p.hour}:${p.minute}`;
}

/** Axis tick label per range (SCREENS 7.3): 1h/6h "13:15", 24h "Sat 20:11", 7d/30d/90d "Oct 6". */
export function formatTick(range: Range, date: Date | number, timeZone?: string): string {
  if (range === '7d' || range === '30d' || range === '90d') return formatDay(date, timeZone);
  if (range === '24h') return formatWeekdayTime(date, timeZone);
  return formatTime(date, timeZone);
}

/** Tooltip time per range: 7d/30d/90d "Oct 6, 14:00", 24h "Sat 14:00", else "14:00". */
export function formatTooltipTime(range: Range, date: Date | number, timeZone?: string): string {
  if (range === '7d' || range === '30d' || range === '90d') return formatDayTime(date, timeZone);
  if (range === '24h') return formatWeekdayTime(date, timeZone);
  return formatTime(date, timeZone);
}

function sameDay(a: Date | number, b: Date | number, timeZone?: string): boolean {
  const pa = parts(a, timeZone);
  const pb = parts(b, timeZone);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/** Clock time today ("02:14"), else "Oct 9, 02:14". */
export function formatClock(date: Date | number, now: Date | number, timeZone?: string): string {
  return sameDay(date, now, timeZone) ? formatTime(date, timeZone) : formatDayTime(date, timeZone);
}

/** "since 02:14" for a start time today, else "since Oct 9". */
export function formatSince(date: Date | number, now: Date | number, timeZone?: string): string {
  return t('since {time}', { time: sameDay(date, now, timeZone) ? formatTime(date, timeZone) : formatDay(date, timeZone) });
}

/** "Today 02:00", "Yesterday 02:00", "Mon 02:00" (within six days), else "Oct 4, 02:00". */
export function formatRelativeDay(date: Date | number, now: Date | number, timeZone?: string): string {
  const t = typeof date === 'number' ? date : date.getTime();
  const n = typeof now === 'number' ? now : now.getTime();
  const time = formatTime(t, timeZone);
  if (sameDay(t, n, timeZone)) return `${tr('Today')} ${time}`;
  if (sameDay(t, n - DAY * 1000, timeZone)) return `${tr('Yesterday')} ${time}`;
  if (Math.abs(t - n) < 6 * DAY * 1000) return formatWeekdayTime(t, timeZone);
  return formatDayTime(t, timeZone);
}

/** A calendar date without time ("2026-08-31") -> "Aug 31" (no zone shift). */
export function formatDateOnly(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  return formatDay(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12), 'UTC');
}

/** Cell size of the heatmap: 75 s, 7.5 min, 30 min, 3.5 h, 15 h, 1 d. */
export function formatCellSize(seconds: number): string {
  if (seconds < 120) return `${trimZeros(seconds.toFixed(1))} s`;
  if (seconds < HOUR) return `${trimZeros((seconds / MIN).toFixed(1))} min`;
  if (seconds < DAY) return `${trimZeros((seconds / HOUR).toFixed(1))} ${t('h')}`;
  const d = seconds / DAY;
  return d === 1 ? plural(1, 'day') : `${trimZeros(d.toFixed(1))} ${t('days')}`;
}

export const RANGE_LABEL: Record<Range, string> = {
  '1h': t('Last hour'),
  '6h': t('Last 6 hours'),
  '24h': t('Last 24 hours'),
  '7d': t('Last 7 days'),
  '30d': t('Last 30 days'),
  '90d': t('Last 90 days'),
};

export const RANGE_SECONDS: Record<Range, number> = {
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
  '7d': 604800,
  '30d': 2592000,
  '90d': 7776000,
};

/** The preset whose labels suit a window of this length (zoomed charts). */
export function rangeForSpan(seconds: number): Range {
  if (seconds <= 6 * 3600) return '6h';
  if (seconds <= 2 * 86400) return '24h';
  return '7d';
}
