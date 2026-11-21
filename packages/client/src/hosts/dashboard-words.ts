/**
 * The words of a server's Summary (Whombat dashboards.md DS-06, DS-08, DS-15; app dashboards-client.md AP-2006…):
 * averages and peaks with one decimal under 10 and none above, the peak's time in the person's time zone, sizes in GB
 * and TB, network in Mb/s, and where a volume is heading (“Full in about 5 months”, “Full about 18 Dec”). Pure; the
 * Summary's builders (`dashboard.ts`) and the screens use them.
 */
import { meanOf, type SeriesValues } from './chart';
import { DASH, formatInt, formatWeekdayTime } from './format';

export const NBSP = ' ';
const DAY_MS = 86_400_000;

/** Words cut to a contract's length, with “…” when they were longer. */
export function cut(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}

/** An average or a peak: one decimal under 10, none above (“2.4”, “63”, “1,240”). */
export function dashboardNumber(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  if (Math.abs(v) < 10) return v.toFixed(1).replace(/\.0$/, '');
  return formatInt(Math.round(v));
}

/** A number with its unit after a space (“2.4 %”, “63 °C”), or a dash. */
export function withUnit(v: number | null | undefined, unit: string): string {
  return v == null || !Number.isFinite(v) ? DASH : `${dashboardNumber(v)}${NBSP}${unit}`;
}

const dayMonth = new Map<string, Intl.DateTimeFormat>();

/** “6 Oct”, “18 Dec” in the person's time zone. */
export function formatDayMonth(t: number, timeZone?: string): string {
  const key = timeZone ?? '';
  let f = dayMonth.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(timeZone ? { timeZone } : {}),
    });
    dayMonth.set(key, f);
  }
  return f.format(t);
}

/** When a peak was: “Now” (the newest point), “Sun 03:10” within six days, else “6 Oct”. */
export function peakWhen(at: string | number, now: number, timeZone?: string, last = false): string {
  if (last) return 'Now';
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) return DASH;
  return now - t < 6 * DAY_MS ? formatWeekdayTime(t, timeZone) : formatDayMonth(t, timeZone);
}

export interface SeriesStats {
  avg: number | null;
  peak: number | null;
  /** When the peak was (ISO), null without one. */
  peakAt: string | null;
  /** The peak's time in words (“Sun 03:10”, “Now”), null without one. */
  peakWhen: string | null;
}

/**
 * Average and peak of a range's points with the peak's time in words (DS-06, DS-15). `summary` is the hosts service's
 * own (over its raw samples, `HostSeries.summary[key]`), used when given; `now` defaults to the newest point.
 */
export function seriesStats(
  values: SeriesValues | undefined,
  timestamps: readonly string[] | undefined,
  opts: {
    timeZone?: string;
    now?: number;
    summary?: { avg: number | null; max: number | null; maxAt: string | null } | null;
  } = {},
): SeriesStats {
  const vals = values ?? [];
  const ts = timestamps ?? [];
  let peakI = -1;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v != null && Number.isFinite(v) && (peakI < 0 || v > (vals[peakI] as number))) peakI = i;
  }
  const s = opts.summary;
  const avg = s && s.avg != null ? s.avg : meanOf(vals);
  const fromSummary = !!s && s.max != null;
  const peak = fromSummary ? (s?.max ?? null) : peakI < 0 ? null : (vals[peakI] ?? null);
  const peakAt = fromSummary ? (s?.maxAt ?? null) : peakI < 0 ? null : (ts[peakI] ?? null);
  const lastAt = ts[ts.length - 1];
  const now = opts.now ?? (lastAt ? Date.parse(lastAt) : Date.now());
  const newest = peakAt != null && (peakAt === lastAt || (!fromSummary && peakI === vals.length - 1));
  return {
    avg,
    peak,
    peakAt,
    peakWhen: peakAt == null ? null : peakWhen(peakAt, now, opts.timeZone, newest),
  };
}

/* Sizes and rates ----------------------------------------------------------------------------------------- */

/** A size's number and unit from GB (DS-15): “480 MB”, “4.5 GB”, “930 GB”, “7.2 TB”, “24 TB”. */
export function sizeParts(gb: number): { n: string; unit: 'MB' | 'GB' | 'TB' } {
  if (gb < 1) return { n: String(Math.round(gb * 1000)), unit: 'MB' };
  if (gb < 1000) return { n: dashboardNumber(gb), unit: 'GB' };
  return { n: dashboardNumber(gb / 1000), unit: 'TB' };
}

/** A size from GB: “4.5 GB”, “7.2 TB”. */
export function sizeWords(gb: number | null | undefined): string {
  if (gb == null || !Number.isFinite(gb)) return DASH;
  const p = sizeParts(gb);
  return `${p.n}${NBSP}${p.unit}`;
}

/**
 * Used and total as a figure's number and what it is out of, in one unit: the total's, but GB for both while less than a
 * terabyte is used (“310” of “1,000 GB”, “2.1” of “7.2 TB”, “4.2” of “8 GB”).
 */
export function sizeFigure(
  usedGb: number,
  totalGb: number,
): { value: string; unit: 'MB' | 'GB' | 'TB'; of: string } {
  const t = sizeParts(totalGb);
  if (t.unit === 'TB' && usedGb < 1000)
    return { value: dashboardNumber(usedGb), unit: 'GB', of: `${dashboardNumber(totalGb)}${NBSP}GB` };
  const scale = t.unit === 'TB' ? 1000 : t.unit === 'MB' ? 0.001 : 1;
  return { value: dashboardNumber(usedGb / scale), unit: t.unit, of: `${t.n}${NBSP}${t.unit}` };
}

/** Used and total in one unit: “660 of 930 GB”, “2.1 of 7.2 TB”, “310 of 1,000 GB” (`sizeFigure`). */
export function sizePair(
  usedGb: number | null | undefined,
  totalGb: number | null | undefined,
  sep = 'of',
): string {
  if (totalGb == null || !Number.isFinite(totalGb)) return sizeWords(usedGb);
  if (usedGb == null || !Number.isFinite(usedGb)) return `${DASH} ${sep} ${sizeWords(totalGb)}`;
  const f = sizeFigure(usedGb, totalGb);
  return `${f.value} ${sep} ${f.of}`;
}

/** A network rate from Mb/s: “84 Mb/s”, “2.4 Mb/s”, “1.2 Gb/s”. */
export function rateWords(mbps: number | null | undefined): string {
  if (mbps == null || !Number.isFinite(mbps)) return DASH;
  const p = rateParts(mbps);
  return `${p.n}${NBSP}${p.unit}`;
}

export function rateParts(mbps: number): { n: string; unit: 'Mb/s' | 'Gb/s' } {
  return Math.abs(mbps) >= 1000
    ? { n: dashboardNumber(mbps / 1000), unit: 'Gb/s' }
    : { n: dashboardNumber(mbps), unit: 'Mb/s' };
}

/** A disk rate: “12 MB/s”. */
export function diskRateWords(mbs: number | null | undefined): string {
  return withUnit(mbs, 'MB/s');
}

/** The data a rate series moved over its points, in GB (Mb/s × step ÷ 8 ÷ 1000), null without points. */
export function movedGb(values: SeriesValues | undefined, stepSeconds: number, bits = true): number | null {
  let sum = 0;
  let any = false;
  for (const v of values ?? []) {
    if (v == null || !Number.isFinite(v)) continue;
    sum += v;
    any = true;
  }
  return any ? (sum * stepSeconds) / (bits ? 8 : 1) / 1000 : null;
}

/* Forecasts (DS-08) ---------------------------------------------------------------------------------------------- */

export interface VolumeForecast {
  /** Days until full, null when it isn't filling up (or full is more than a year away). */
  fullInDays: number | null;
  /** When it is full (ISO), for a chart's `forecast`. */
  fullAt: string | null;
  /** How fast it grows, in percentage points a day (the fitted line), null without a fit. */
  perDay: number | null;
  /** “Full in about 5 months”, “Full about 18 Dec” (within 60 days); null when it isn't filling up. */
  words: string | null;
  /** “growing 0.5 % a week”, null when it isn't growing. */
  growth: string | null;
}

/** Days under which a forecast is a date and worth a warning (DS-15). */
export const FORECAST_DATE_DAYS = 60;

/**
 * Where a volume is heading (DS-08, DS-15): the hosts service's own forecast (`HostVolume.fullInDays`, from its last 7
 * days) when it gave one, else a straight line through the range's `vol_pct:*` points (at least 12 points over a day,
 * growing, full within a year — the hub's `rules.Forecast`). Nothing when it isn't filling up.
 */
export function volumeForecast(input: {
  values?: SeriesValues;
  timestamps?: readonly string[];
  fullInDays?: number | null;
  now: number;
  timeZone?: string;
}): VolumeForecast {
  const fit = fitLine(input.values ?? [], input.timestamps ?? []);
  let days = input.fullInDays ?? null;
  if (days == null && fit && fit.perDay >= 0.01) {
    const d = (100 - fit.now) / fit.perDay;
    days = d > 365 ? null : Math.max(0, d);
  }
  const growth = fit && fit.perDay >= 0.01 ? growthWords(fit.perDay) : null;
  if (days == null || days > 365)
    return { fullInDays: null, fullAt: null, perDay: fit?.perDay ?? null, words: null, growth };
  const fullAt = input.now + days * DAY_MS;
  return {
    fullInDays: days,
    fullAt: new Date(fullAt).toISOString(),
    perDay: fit?.perDay ?? null,
    words: fullWords(days, fullAt, input.timeZone),
    growth,
  };
}

/** “Full about 18 Dec” within 60 days, else “Full in about 5 months”. */
function fullWords(days: number, at: number, timeZone?: string): string {
  if (days < FORECAST_DATE_DAYS) return `Full about ${formatDayMonth(at, timeZone)}`;
  const months = Math.round(days / 30.4);
  return months >= 12 ? 'Full in about a year' : `Full in about ${months} months`;
}

/** “growing 0.5 % a week” (a day when it grows a point a day or more). */
function growthWords(perDay: number): string {
  return perDay >= 1
    ? `growing ${dashboardNumber(perDay)}${NBSP}% a day`
    : `growing ${dashboardNumber(perDay * 7)}${NBSP}% a week`;
}

/** A least-squares line through a series (the hub's `rules.Forecast`): % a day and the fitted value now. */
function fitLine(
  values: SeriesValues,
  timestamps: readonly string[],
): { perDay: number; now: number } | null {
  const pts: [number, number][] = [];
  values.forEach((v, i) => {
    const t = Date.parse(timestamps[i] ?? '');
    if (v != null && Number.isFinite(v) && Number.isFinite(t)) pts.push([t, v]);
  });
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length < 12 || !first || !last || last[0] - first[0] < DAY_MS) return null;
  const n = pts.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [t, v] of pts) {
    const x = (t - first[0]) / DAY_MS;
    sx += x;
    sy += v;
    sxx += x * x;
    sxy += x * v;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const perDay = (n * sxy - sx * sy) / den;
  const intercept = (sy - perDay * sx) / n;
  const now = Math.max(last[1], intercept + (perDay * (last[0] - first[0])) / DAY_MS);
  return { perDay, now };
}
