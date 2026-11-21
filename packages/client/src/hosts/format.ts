/**
 * How servers' numbers read (one Whombat, app docs/decisions/one-whombat-things.md AP-1302), ported from Rackoon's
 * `web/src/lib/format.ts` in English only and in the mock's spelling: a space before `%` and `°C` (“10 %”, “75 °C”),
 * memory as “76 / 118 GB”, an em dash for no data. Pure and shared by the web and Android; dates take an optional time
 * zone (tests pass one) and otherwise read in the viewer's.
 */
import type { HostSeriesRange } from '@whombat/core/domain';

export const DASH = '—';
const NBSP = ' ';

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

/** “1 server”, “3 servers”. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Thousands separators: 14210 → “14,210”. */
export function formatInt(v: number): string {
  return intFmt.format(v);
}

/** Below 10 one decimal (“1.2”, “0.4”, “1”), from 10 a whole number (“42”). */
export function formatNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  if (v === 0) return '0';
  if (Math.abs(v) < 10) return trimZeros(v.toFixed(1));
  return formatInt(Math.round(v));
}

/** A whole percent: “10 %”. */
export function formatPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${Math.round(v)}${NBSP}%`;
}

/** A percent with one decimal: “13.6 %”. */
export function formatPct1(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(1)}${NBSP}%`;
}

/**
 * A size from GB (decimal): “128 MB”, “4.5 GB”, “871 GB”, “1.42 TB”, “2 TB”, “10.2 TB”.
 */
export function formatGb(gb: number | null | undefined): string {
  if (gb == null || !Number.isFinite(gb)) return DASH;
  if (gb < 1) return `${Math.round(gb * 1000)}${NBSP}MB`;
  if (gb < 10) return `${trimZeros(gb.toFixed(1))}${NBSP}GB`;
  if (gb < 1000) return `${Math.round(gb)}${NBSP}GB`;
  const tb = gb / 1000;
  return `${trimZeros(tb >= 10 ? tb.toFixed(1) : tb.toFixed(2))}${NBSP}TB`;
}

/** Bytes as “64 GiB”, “512 MiB”, “1.5 TiB” (the platforms' binary sizes). */
export function formatBytesBinary(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return DASH;
  const fmt = (v: number) => trimZeros(v.toFixed(1));
  if (bytes >= 1024 ** 4) return `${fmt(bytes / 1024 ** 4)}${NBSP}TiB`;
  if (bytes >= 1024 ** 3) return `${fmt(bytes / 1024 ** 3)}${NBSP}GiB`;
  if (bytes >= 1024 ** 2) return `${fmt(bytes / 1024 ** 2)}${NBSP}MiB`;
  if (bytes >= 1024) return `${fmt(bytes / 1024)}${NBSP}KiB`;
  return `${Math.round(bytes)}${NBSP}B`;
}

/** A pair of GB values with one unit: “76 / 118 GB” (the servers table, the Memory figure). */
export function formatGbPair(used: number | null | undefined, total: number | null | undefined): string {
  if (total == null || !Number.isFinite(total)) return formatGb(used);
  if (used == null || !Number.isFinite(used)) return `${DASH} / ${formatGb(total)}`;
  const [t, unit] = formatGb(total).split(NBSP) as [string, string];
  const u = unit === 'GB' && used >= 1 ? formatNum(used) : formatGb(used);
  return `${u} / ${t}${NBSP}${unit}`;
}

const MIB_PER_GIB = 1024;

function memPart(mb: number, withUnit: boolean, used: boolean): string {
  if (mb < MIB_PER_GIB) return `${Math.round(mb)}${NBSP}MB`;
  const gb = mb / MIB_PER_GIB;
  const s = used ? gb.toFixed(1) : trimZeros(gb.toFixed(1));
  return withUnit ? `${s}${NBSP}GB` : s;
}

/** A guest's memory “used / limit” from MB: “3.1 / 4 GB”, “380 MB / 1 GB”, “128 MB”, “—” (stopped). */
export function formatMemPair(usedMb: number | null | undefined, limitMb: number | null | undefined): string {
  if (usedMb == null || !Number.isFinite(usedMb)) return DASH;
  if (limitMb == null || !Number.isFinite(limitMb) || limitMb <= 0) return memPart(usedMb, true, true);
  const bothGb = usedMb >= MIB_PER_GIB && limitMb >= MIB_PER_GIB;
  return `${memPart(usedMb, !bothGb, true)} / ${memPart(limitMb, true, false)}`;
}

/** MiB as “16 GiB” or “512 MiB” (memory fields). */
export function mibText(mib: number): string {
  if (!Number.isFinite(mib)) return '';
  if (mib < 1024) return `${mib}${NBSP}MiB`;
  const g = mib / 1024;
  return `${Number.isInteger(g) ? g : trimZeros(g.toFixed(2))}${NBSP}GiB`;
}

/** “42 MB/s”. */
export function formatDiskRate(mbs: number | null | undefined): string {
  return mbs == null ? DASH : `${formatNum(mbs)}${NBSP}MB/s`;
}

/** “412 Mbit/s”, “1.2 Gbit/s”. */
export function formatNetRate(mbps: number | null | undefined): string {
  if (mbps == null || !Number.isFinite(mbps)) return DASH;
  if (Math.abs(mbps) >= 1000) return `${trimZeros((mbps / 1000).toFixed(1))}${NBSP}Gbit/s`;
  return `${formatNum(mbps)}${NBSP}Mbit/s`;
}

/** “75 °C”. */
export function formatTemp(c: number | null | undefined): string {
  return c == null || !Number.isFinite(c) ? DASH : `${Math.round(c)}${NBSP}°C`;
}

/** “65.5 °C” (tooltips). */
export function formatTemp1(c: number | null | undefined): string {
  return c == null || !Number.isFinite(c) ? DASH : `${c.toFixed(1)}${NBSP}°C`;
}

/** “75°” (chart axes). */
export function formatTempDense(c: number | null | undefined): string {
  return c == null || !Number.isFinite(c) ? DASH : `${Math.round(c)}°`;
}

/** “8 s ago”, “14 min ago”, “5 h ago”, “2 d ago”. */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < MIN) return `${s}${NBSP}s ago`;
  if (s < HOUR) return `${Math.floor(s / MIN)}${NBSP}min ago`;
  if (s < DAY) return `${Math.floor(s / HOUR)}${NBSP}h ago`;
  return `${Math.floor(s / DAY)}${NBSP}d ago`;
}

/** Relative time from an ISO time to `now` (ms). */
export function formatAgoIso(iso: string, now: number): string {
  return formatAgo((now - Date.parse(iso)) / 1000);
}

/** “in 12 h”, “in 14 min”. */
export function formatIn(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < MIN) return `in ${s}${NBSP}s`;
  if (s < HOUR) return `in ${Math.round(s / MIN)}${NBSP}min`;
  if (s < DAY) return `in ${Math.round(s / HOUR)}${NBSP}h`;
  return `in ${Math.round(s / DAY)}${NBSP}d`;
}

/** Two units: “11 h 47 min”, “41 d 7 h”, “14 min”, “45 s”. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < MIN) return `${s}${NBSP}s`;
  if (s < HOUR) return `${Math.floor(s / MIN)}${NBSP}min`;
  if (s < DAY) return `${Math.floor(s / HOUR)}${NBSP}h ${Math.floor((s % HOUR) / MIN)}${NBSP}min`;
  return `${Math.floor(s / DAY)}${NBSP}d ${Math.floor((s % DAY) / HOUR)}${NBSP}h`;
}

/** One unit, short: “41 d”, “7 h”, “12 min” (tables). */
export function formatUptimeShort(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return DASH;
  const s = Math.max(0, Math.floor(seconds));
  if (s < MIN) return `${s}${NBSP}s`;
  if (s < HOUR) return `${Math.floor(s / MIN)}${NBSP}min`;
  if (s < DAY) return `${Math.floor(s / HOUR)}${NBSP}h`;
  return `${Math.floor(s / DAY)}${NBSP}d`;
}

/** One unit, in words: “23 days”, “5 hours”, “12 minutes” (the server's “Up 23 days”). */
export function formatUptimeWords(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return DASH;
  const s = Math.max(0, Math.floor(seconds));
  if (s < HOUR) return plural(Math.max(1, Math.floor(s / MIN)), 'minute');
  if (s < DAY) return plural(Math.floor(s / HOUR), 'hour');
  return plural(Math.floor(s / DAY), 'day');
}

/* Dates in the viewer's time zone ------------------------------------------------------------------ */

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
    f = new Intl.DateTimeFormat('en-GB', {
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
  for (const p of f.formatToParts(date)) if (p.type in out) out[p.type as keyof Parts] = p.value;
  if (out.hour === '24') out.hour = '00';
  return out;
}

/** “14:00”. */
export function formatTime(date: Date | number, timeZone?: string): string {
  const p = parts(date, timeZone);
  return `${p.hour}:${p.minute}`;
}

/** “6 Oct” (the day first, as people here write it). */
export function formatDay(date: Date | number, timeZone?: string): string {
  const p = parts(date, timeZone);
  return `${p.day} ${p.month}`;
}

/** “Sat 20:11”. */
export function formatWeekdayTime(date: Date | number, timeZone?: string): string {
  const p = parts(date, timeZone);
  return `${p.weekday} ${p.hour}:${p.minute}`;
}

/** “6 Oct, 14:00”. */
export function formatDayTime(date: Date | number, timeZone?: string): string {
  const p = parts(date, timeZone);
  return `${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

function sameDay(a: Date | number, b: Date | number, timeZone?: string): boolean {
  const pa = parts(a, timeZone);
  const pb = parts(b, timeZone);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/** “Today 02:00”, “Yesterday 02:00”, “Mon 02:00” within six days, else “4 Oct, 02:00”. */
export function formatRelativeDay(date: Date | number, now: Date | number, timeZone?: string): string {
  const t = typeof date === 'number' ? date : date.getTime();
  const n = typeof now === 'number' ? now : now.getTime();
  const time = formatTime(t, timeZone);
  if (sameDay(t, n, timeZone)) return `Today ${time}`;
  if (sameDay(t, n - DAY * 1000, timeZone)) return `Yesterday ${time}`;
  if (Math.abs(t - n) < 6 * DAY * 1000) return formatWeekdayTime(t, timeZone);
  return formatDayTime(t, timeZone);
}

/** A chart's axis word per range: 1h/6h “13:15”, 24h “Fri 14:00”, longer “Oct 6”. */
export function formatTick(
  range: HostSeriesRange | 'custom',
  date: Date | number,
  timeZone?: string,
): string {
  if (range === '7d' || range === '30d' || range === '90d') return formatDay(date, timeZone);
  if (range === '24h' || range === 'custom') return formatWeekdayTime(date, timeZone);
  return formatTime(date, timeZone);
}

/** A chart's tooltip time per range. */
export function formatTooltipTime(
  range: HostSeriesRange | 'custom',
  date: Date | number,
  timeZone?: string,
): string {
  if (range === '7d' || range === '30d' || range === '90d') return formatDayTime(date, timeZone);
  if (range === '24h' || range === 'custom') return formatWeekdayTime(date, timeZone);
  return formatTime(date, timeZone);
}

/** The ranges' words (the range picker). */
export const HOST_RANGE_WORDS: Record<HostSeriesRange, string> = {
  '1h': 'Last hour',
  '6h': 'Last 6 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};
