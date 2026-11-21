/**
 * The Summary on the phone (Whombat dashboards.md DS-01…DS-17; dashboards-mobile.md AP-2120…AP-2199): what the one
 * stacked renderer draws from `ThingPagePanel`s (contracts 0.89.0, CT-394…CT-398), the same for a connection's or
 * device's page (`things.page`) and a server's Summary (`serverDashboard`, built in `@whombat/client/hosts`): figures
 * with their small line or meter, a chart card's figure, average and peak, its lines (or stacked bars) with the limit
 * and the forecast on one scale and its facts under it, bar lists, table rows with a small bar, a small line and a
 * button, Worth a look folded at five, and the range control's options. The builders word and format everything; this
 * only arranges it for a narrow screen and says it for TalkBack. Pure; the renderer is `screens/thing/Panels.tsx`.
 */
import {
  figureCharts,
  type PlacedChart,
  placePanels,
  THING_SERIES_TOKENS,
  thingSeriesToken,
} from '@whombat/client';
import {
  DASHBOARD_RANGE_WORDS,
  formatTick,
  formatTooltipTime,
  HOST_RANGE_WORDS,
  timeTicks,
} from '@whombat/client/hosts';
import type {
  HostSeriesRange,
  ThingLine,
  ThingPageButton,
  ThingPageCell,
  ThingPageKpi,
  ThingPagePanel,
  ThingSeriesColor,
  ThingTone,
} from '@whombat/core';
import { toDate } from '@whombat/core/text';
import type { ChartSwatch, HostReadout } from './hostStatus';
import { personInitial } from './serviceSlots';
import { type LinkRun, linkRun, type PhoneThingTab } from './thingPage';

export const DASHBOARD_COPY = {
  /** Worth a look's fold (DS-05). */
  showMore: (n: number) => `Show ${n} more`,
  showFewer: 'Show fewer',
  nothing: 'Nothing needs a look.',
  /** The range control's name for TalkBack. */
  range: 'What the charts show',
} as const;

/** The range a page without one shows (DS-03). */
export const DEFAULT_RANGE: HostSeriesRange = '24h';

/** Worth a look shows this many before “Show N more” (DS-05). */
export const NOTICES_FIRST = 5;

/* Colours --------------------------------------------------------------------------------------------------------- */

/** A figure's, bar's or meter's colour: a `warn` or `bad` tone wins, then its own colour, then blue. */
export function toneSwatch(
  tone: ThingTone | null | undefined,
  color: ThingSeriesColor | undefined,
  fallback: ChartSwatch = 'chart1',
): ChartSwatch {
  if (tone === 'bad') return 'bad';
  if (tone === 'warn') return 'warn';
  return color ? THING_SERIES_TOKENS[color] : fallback;
}

/* Small lines ------------------------------------------------------------------------------------------------------ */

const numbers = (values: readonly (number | null)[]) =>
  values.filter((v): v is number => v !== null && Number.isFinite(v));
const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

/** Whether a small line has anything to draw (two values read at least). */
export function hasLine(values: readonly (number | null)[] | undefined | null): values is (number | null)[] {
  return !!values && numbers(values).length >= 2;
}

/**
 * What a small line shows, in words for TalkBack (“steady, with a peak”, “rising”): the last quarter against the first,
 * and a peak over twice the average. Null with fewer than four values.
 */
export function trendWords(values: readonly (number | null)[]): string | null {
  const v = numbers(values);
  if (v.length < 4) return null;
  const q = Math.max(1, Math.floor(v.length / 4));
  const shift = mean(v.slice(-q)) - mean(v.slice(0, q));
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const spread = hi - lo;
  const way = spread === 0 || Math.abs(shift) < spread * 0.25 ? 'steady' : shift > 0 ? 'rising' : 'falling';
  const avg = mean(v);
  const peak = hi > avg * 2 && hi - avg > spread * 0.5;
  return peak ? `${way}, with a peak` : way;
}

/** A figure's small line said with its range: “Last 24 hours: steady, with a peak”. */
export function rangeTrend(values: readonly (number | null)[], range: HostSeriesRange): string | null {
  const words = trendWords(values);
  return words ? `${HOST_RANGE_WORDS[range]}: ${words}` : null;
}

/* The range control ----------------------------------------------------------------------------------------------- */

export interface RangeOption {
  value: HostSeriesRange;
  /** “24h”, as on the web's control. */
  label: string;
  /** “Last 24 hours”. */
  spoken: string;
}

/**
 * The control's options, shortest first; none when there is nothing to choose (absent or one range, DS-03). A server's
 * are `SERVER_DASHBOARD_PHONE_RANGES` (90 days left out: no room, little use on a phone).
 */
export function rangeOptions(ranges: readonly HostSeriesRange[] | null | undefined): RangeOption[] {
  if (!ranges || ranges.length < 2) return [];
  return ranges.map((value) => ({
    value,
    label: DASHBOARD_RANGE_WORDS[value],
    spoken: HOST_RANGE_WORDS[value],
  }));
}

/* Figures (kpis) -------------------------------------------------------------------------------------------------- */

export interface FigureTile {
  key: string;
  label: string;
  value: string;
  rest: string | null;
  sub: string | null;
  tone: ThingTone | null;
  /** Its small line over the page's range (drawn first), or a meter, or neither. */
  spark: (number | null)[] | null;
  meter: number | null;
  swatch: ChartSwatch;
  /** “CPU: 18 % of 16 threads, load 2.9. Last 24 hours: steady, with a peak”. */
  spoken: string;
}

export function figureTiles(items: readonly ThingPageKpi[], range: HostSeriesRange): FigureTile[] {
  return items.map((k) => {
    const spark = hasLine(k.spark) ? k.spark : null;
    const meter = !spark && typeof k.meter === 'number' ? Math.max(0, Math.min(1, k.meter)) : null;
    const value = k.rest?.trim() ? `${k.value} ${k.rest.trim()}` : k.value;
    const trend = spark ? rangeTrend(spark, range) : null;
    return {
      key: k.key,
      label: k.label,
      value: k.value,
      rest: k.rest?.trim() || null,
      sub: k.sub?.trim() || null,
      tone: k.tone ?? null,
      spark,
      meter,
      swatch: toneSwatch(k.tone, k.color),
      spoken: `${k.label}: ${value}${k.sub?.trim() ? `, ${k.sub.trim()}` : ''}${trend ? `. ${trend}` : ''}`,
    };
  });
}

/* A figure opens its charts (CN-05) ------------------------------------------------------------------------------ */

type ChartPanel = Extract<ThingPagePanel, { kind: 'chart' }>;

/**
 * A Summary as the phone lays it out (Whombat connections-page.md CN-05; connections-page.md AP-2558, AP-2560): the
 * charts each figure opens (the shared `figureCharts`), the panels left to stack, and whether the range control stays
 * at the top — while a chart card is still there, or when no figure opens anything; else it is in the opened figure.
 */
export interface SummaryLayout {
  open: Record<string, ChartPanel[]>;
  panels: ThingPagePanel[];
  rangeOnTop: boolean;
}

export function summaryLayout(panels: readonly ThingPagePanel[]): SummaryLayout {
  const { open, panels: rest } = figureCharts(panels);
  const behind = Object.keys(open).length > 0;
  return { open, panels: rest, rangeOnTop: !behind || rest.some((p) => p.kind === 'chart') };
}

/**
 * Where the range control stands when it isn't in an opened figure (docs/app/decisions/phone-refresh-status.md): right
 * above the first chart card it controls, else above the figures whose small lines it sets; null: at the top, where it
 * was (nothing it controls is there to stand by).
 */
export function rangePlace(panels: readonly ThingPagePanel[]): string | null {
  return (panels.find((p) => p.kind === 'chart') ?? panels.find((p) => p.kind === 'kpis'))?.id ?? null;
}

/* A wide page (iphone-duo.md AP-6741) ----------------------------------------------------------------------------- */

/**
 * A page's panels where they sit when it is wide (the list hidden on an open Duo or foldable): what the web puts across
 * the width stays across it, chart cards two to a line (a wide one, or one left alone, takes the line), then the main
 * and side columns side by side, then the bottom. Where each panel goes is the web's `placePanels`; the lines are the
 * web's narrower page, which is as wide as an open phone. A settings tab's two columns are as wide as each other.
 */
export interface WideLayout {
  top: ThingPagePanel[];
  chartLines: ThingPagePanel[][];
  main: ThingPagePanel[];
  side: ThingPagePanel[];
  bottom: ThingPagePanel[];
  /** The main column's share beside the side column's 1 (the web's ≈ 65 % · 35 %; settings 1 · 1). */
  mainFlex: number;
}

export function wideLayout(panels: readonly ThingPagePanel[]): WideLayout {
  const placed = placePanels(panels);
  const settings = panels.some((p) => p.kind === 'settings');
  return {
    top: placed.top,
    chartLines: placed.chart.flatMap(chartLines),
    main: placed.main,
    side: placed.side,
    bottom: placed.bottom,
    mainFlex: settings ? 1 : 1.85,
  };
}

/** A chart row's cards two to a line: a wide card, and a card left alone, take a line of their own. */
function chartLines(row: readonly PlacedChart[]): ThingPagePanel[][] {
  const lines: ThingPagePanel[][] = [];
  for (let i = 0; i < row.length; i++) {
    const a = row[i] as PlacedChart;
    const b = row[i + 1];
    if (a.span < 2 && b && b.span < 2) {
      lines.push([a.panel, b.panel]);
      i++;
    } else lines.push([a.panel]);
  }
  return lines;
}

/** What tapping a figure does: open (or close) its charts, follow its link (a tab here), or nothing. */
export type FigurePress =
  | { kind: 'charts'; charts: ChartPanel[] }
  | { kind: 'link'; label: string; run: LinkRun };

export function figurePress(
  kpi: Pick<ThingPageKpi, 'key' | 'link'>,
  open: Readonly<Record<string, ChartPanel[]>> | null,
  tabs: readonly PhoneThingTab[],
): FigurePress | null {
  const charts = open?.[kpi.key];
  if (charts?.length) return { kind: 'charts', charts };
  const link = linkRun(kpi.link, tabs);
  return link ? { kind: 'link', ...link } : null;
}

/** One figure open at a time: tapping the open one closes it, another opens instead. */
export function toggleFigure(opened: string | null, key: string): string | null {
  return opened === key ? null : key;
}

/* Chart cards ----------------------------------------------------------------------------------------------------- */

export interface ChartLineView {
  key: string;
  label: string;
  swatch: ChartSwatch;
  /** A wash under the line (CPU, memory); bars ignore it. */
  fill: boolean;
  /** On the chart's one scale (a right-axis line is scaled onto it). */
  values: (number | null)[];
  /** As read. */
  raw: (number | null)[];
  /** The legend's figure: the builder's `latest`, else the last value read (“5 %”). */
  latest: string | null;
}

export interface ChartCardView {
  title: string;
  meta: string | null;
  figure: { value: string; rest: string | null; tone: ThingTone | null } | null;
  /** “Avg **14.2 %**”, “Peak **63 %** Sun 03:10”. */
  stats: ThingLine[];
  /** Up to four small facts under the chart, two by two on the phone. */
  foot: { label: string; value: string; tone: ThingTone | null }[];
  bars: boolean;
  lines: ChartLineView[];
  /** The legend under the figure: two lines or more. */
  legend: { key: string; swatch: ChartSwatch; label: string; latest: string | null }[];
  min: number;
  max: number;
  /** Three gridlines: the bottom, the middle, the top. */
  ticks: number[];
  tickLabel: (v: number) => string;
  /** The points read. */
  count: number;
  /** Places along the bottom: the points, then the forecast's room. */
  slots: number;
  /** The words along the bottom, the first and the last always shown; the chart drops those that don't fit. */
  timeTicks: { index: number; label: string }[];
  /**
   * The words under each point instead of times (“Thu” … “Today”, service-slots.md SLT-06), one per point; null for a
   * chart over the page's range. The last one is drawn stronger: it is now.
   */
  labels: string[] | null;
  /** The dashed line where it gets serious, on the chart's scale. */
  mark: { value: number; label: string | null } | null;
  /** Where the last value is heading (“full ~18 Dec”), from the last point to the end of the room. */
  forecast: {
    from: { index: number; value: number };
    to: { index: number; value: number };
    label: string;
  } | null;
  /** Stacked bars (`style: 'bars'`): each point's values, bottom up, in the lines' order. */
  columns: number[][];
  /** The readout for a point (the web's tooltip). */
  readout: (index: number) => HostReadout;
  /** Without a finger: the latest figures. */
  latest: HostReadout;
  /** TalkBack's name for it: “CPU, 18 % of 16 threads, Avg 14.2 %, Peak 63 % Sun 03:10”. */
  spoken: string;
}

/** A line of words as read (“Peak 63 % Sun 03:10”). */
export function lineWords(line: ThingLine): string {
  return line
    .map((p) => p.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastIndex(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return null;
}

/** The top of a three-line scale: a round number whose half is round too (1, 2, 4, 6, 8, 10 × a power of ten). */
export function niceTop(value: number): number {
  if (!(value > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 4, 6, 8, 10]) if (m * pow >= value - 1e-9) return m * pow;
  return 10 * pow;
}

/** An axis number in at most four characters: `8`, `0.5`, `250`, `1.5k`, `12k`. */
function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 10_000) return `${Math.round(v / 1000)}k`;
  if (a >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(v * 10) / 10);
}

/** An axis word with its unit (“100%”, “60°”, “8 GB”); a long unit is left to the legend. */
export function axisWord(v: number, unit: string | null | undefined): string {
  const n = compact(v);
  if (!unit) return n;
  if (unit === '%') return `${n}%`;
  if (unit.startsWith('°')) return `${n}°`;
  return unit.length <= 3 ? `${n} ${unit}` : n;
}

/** A figure in a readout: one decimal under 10 unless the line counts whole things, none above (DS-15). */
function valueWords(v: number, unit: string | undefined, whole: boolean): string {
  const n = whole || Math.abs(v) >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1);
  return unit ? `${n} ${unit}` : n;
}

/**
 * A chart card on the phone (CT-395): its figure, stats and facts as given; its lines on one scale — the axis's fixed
 * ends when it has them, else 0 (or below) to a round top over the lines, the limit and the forecast; a right-axis line
 * (memory in GB beside CPU in %) is scaled onto the left one and the readout says its own figure —; the words along the
 * bottom from the range (the forecast's day at the far end); bars stacked per point. Null when nothing was read.
 */
export function chartCard(panel: ChartPanel, range: HostSeriesRange, timeZone: string): ChartCardView | null {
  const count = Math.min(panel.timestamps.length, ...panel.series.map((s) => s.values.length));
  const series = panel.series.map((s) => ({ ...s, values: s.values.slice(-count) }));
  if (count < 1 || !series.some((s) => s.values.some((v) => v !== null))) return null;
  const bars = panel.style === 'bars';
  const times = panel.timestamps.slice(-count).map((t) => toDate(t).getTime());
  const left = series.filter((s) => s.axis !== 'right');
  const right = series.filter((s) => s.axis === 'right');
  const base = left.length ? left : right;
  const read = (list: typeof series) => list.flatMap((s) => numbers(s.values));
  const columns = bars
    ? Array.from({ length: count }, (_, i) => series.map((s) => Math.max(0, s.values[i] ?? 0)))
    : [];
  const peaks = bars ? columns.map((c) => c.reduce((a, b) => a + b, 0)) : read(base);
  const extra = [panel.line?.value, panel.forecast?.value].filter((v): v is number => typeof v === 'number');
  const hiData = Math.max(0, ...peaks, ...extra);
  const loData = Math.min(0, ...peaks);
  const max = panel.axis?.max ?? niceTop(hiData * 1.1);
  const min = panel.axis?.min ?? (loData < 0 ? -niceTop(-loData * 1.1) : 0);
  const other = !bars && left.length && right.length ? niceTop(Math.max(0, ...read(right)) * 1.1) : null;
  const unit = panel.axis?.unit ?? base[0]?.unit;
  const whole = series.map((s) => numbers(s.values).every((v) => Number.isInteger(v)));
  const lines: ChartLineView[] = series.map((s, i) => {
    const scale = other && s.axis === 'right' ? max / other : 1;
    const last = lastIndex(s.values);
    const lastValue = last === null ? null : (s.values[last] as number);
    return {
      key: s.key,
      label: s.label,
      swatch: thingSeriesToken(s.color, i),
      fill: !!s.fill && !bars,
      values: s.values.map((v) => (v === null ? null : v * scale)),
      raw: s.values,
      latest:
        s.latest?.trim() || (lastValue === null ? null : valueWords(lastValue, s.unit, whole[i] ?? false)),
    };
  });

  // The forecast's room after the last point: its days, at most a little more than the points' own width (a forecast
  // months away still reaches its value at the far end, under its day: the axis says only “Now” and that day there).
  let slots = count;
  let forecast: ChartCardView['forecast'] = null;
  const head =
    lines[
      Math.max(
        0,
        series.findIndex((s) => s.axis !== 'right'),
      )
    ];
  const from = head ? lastIndex(head.values) : null;
  if (panel.forecast && head && from !== null && count > 1) {
    const step = ((times[count - 1] as number) - (times[0] as number)) / (count - 1);
    const at = toDate(panel.forecast.at).getTime();
    const want = step > 0 ? Math.ceil((at - (times[count - 1] as number)) / step) : 0;
    if (want > 0) {
      const room = Math.min(want, Math.ceil((count - 1) * 1.25));
      slots = count + room;
      forecast = {
        from: { index: from, value: head.values[from] as number },
        to: { index: slots - 1, value: panel.forecast.value },
        label: panel.forecast.label,
      };
    }
  }

  // Words under the points keep the chart out of the page's range: no times along the bottom or in the readout.
  const labels =
    panel.labels && panel.labels.length >= count ? panel.labels.slice(-count).map((l) => l.trim()) : null;
  const ticks = labels
    ? labels.map((label, index) => ({ index, label }))
    : timeTicks(panel.timestamps.slice(-count), range, timeZone);
  const forecastDay =
    forecast && panel.forecast
      ? [{ index: slots - 1, label: formatTick('30d', toDate(panel.forecast.at).getTime(), timeZone) }]
      : [];
  const when = (index: number): string =>
    labels
      ? (labels[index] ?? '')
      : times[index] === undefined
        ? ''
        : formatTooltipTime(range, times[index] as number, timeZone);
  const readout = (index: number): HostReadout => ({
    title: when(index),
    lines: series.map((s, i) => {
      const v = s.values[index];
      return {
        swatch: thingSeriesToken(s.color, i),
        value: v === null || v === undefined ? '—' : valueWords(v, s.unit, whole[i] ?? false),
        rest: s.label,
      };
    }),
  });
  const figure = panel.figure
    ? { value: panel.figure.value, rest: panel.figure.rest?.trim() || null, tone: panel.figure.tone ?? null }
    : null;
  const stats = (panel.stats ?? []).filter((l) => lineWords(l));
  return {
    title: panel.title,
    meta: panel.meta?.trim() || null,
    figure,
    stats,
    foot: (panel.foot ?? []).map((f) => ({ label: f.label, value: f.value, tone: f.tone ?? null })),
    bars,
    lines,
    legend:
      lines.length > 1
        ? lines.map((l) => ({ key: l.key, swatch: l.swatch, label: l.label, latest: l.latest }))
        : [],
    min,
    max,
    ticks: [min, (min + max) / 2, max],
    tickLabel: (v) => axisWord(v, unit),
    count,
    slots,
    timeTicks: [...ticks, ...forecastDay],
    labels,
    mark: panel.line ? { value: panel.line.value, label: panel.line.label?.trim() || null } : null,
    forecast,
    columns,
    readout,
    latest: {
      title: times.length ? when(times.length - 1) : '',
      lines: lines.map((l) => ({ swatch: l.swatch, value: l.latest ?? '—', rest: l.label })),
    },
    spoken: [
      panel.title,
      figure ? [figure.value, figure.rest].filter(Boolean).join(' ') : null,
      ...stats.map(lineWords),
      ...(lines.length > 1 || !figure
        ? lines.map((l) => (l.latest ? `${l.label} ${l.latest}` : l.label))
        : []),
      panel.forecast?.label ?? null,
    ]
      .filter(Boolean)
      .join(', '),
  };
}

/**
 * The words along the bottom that fit a chart `width` wide (the web's `fitTimeTicks`, AP-1867): the first and the last
 * always, the ones between only where they keep a gap to their neighbours. A word is 6.6 wide a letter (11 DM Mono).
 */
export function fitTicks<T extends { index: number; label: string }>(
  ticks: readonly T[],
  x: (index: number) => number,
  charWidth = 6.6,
  gap = 10,
): T[] {
  if (ticks.length <= 2) return [...ticks];
  const width = (t: T) => t.label.length * charWidth;
  const first = ticks[0] as T;
  const last = ticks[ticks.length - 1] as T;
  const lastLeft = x(last.index) - width(last);
  const kept: T[] = [first];
  let right = x(first.index) + width(first);
  for (const t of ticks.slice(1, -1)) {
    const w = width(t);
    const at = x(t.index) - w / 2;
    if (at >= right + gap && at + w + gap <= lastLeft) {
      kept.push(t);
      right = at + w;
    }
  }
  kept.push(last);
  return kept;
}

/* Bar lists ------------------------------------------------------------------------------------------------------- */

export interface BarRowView {
  id: string;
  label: string;
  mono: boolean;
  note: string | null;
  value: string | null;
  /** How full, 0…1; null: no bar (a parity disk). */
  pct: number | null;
  swatch: ChartSwatch;
  tone: ThingTone | null;
  sub: string | null;
  subTone: ThingTone | null;
  href: string | null;
  /** The label is a person's name (service-slots.md SLT-05): their initial, drawn round before it. */
  initial: string | null;
  /** “Disk 1, WD Red 8 TB · spun down: 7.1 of 8 TB. 89 % · new files go to disks 2 and 3”. */
  spoken: string;
}

export function barRows(panel: Extract<ThingPagePanel, { kind: 'bars' }>): BarRowView[] {
  return panel.items.map((b) => {
    const note = b.note?.trim() || null;
    const sub = b.sub?.trim() || null;
    const value = b.value?.trim() || null;
    const name = note ? `${b.label}, ${note}` : b.label;
    return {
      id: b.id,
      label: b.label,
      mono: !!b.mono,
      note,
      value,
      pct: typeof b.pct === 'number' ? Math.max(0, Math.min(1, b.pct)) : null,
      swatch: toneSwatch(b.tone, undefined),
      tone: b.tone ?? null,
      sub,
      subTone: b.subTone ?? null,
      href: b.href ?? null,
      initial: b.person ? personInitial(b.label) : null,
      spoken: [value ? `${name}: ${value}` : name, sub].filter(Boolean).join('. '),
    };
  });
}

/* Worth a look ---------------------------------------------------------------------------------------------------- */

/** The first five, the rest behind “Show N more” (open in place) — `more` is how many are folded. */
export function foldNotices<T>(rows: readonly T[], open: boolean): { shown: readonly T[]; more: number } {
  if (open || rows.length <= NOTICES_FIRST) return { shown: rows, more: 0 };
  return { shown: rows.slice(0, NOTICES_FIRST), more: rows.length - NOTICES_FIRST };
}

/* Tables ---------------------------------------------------------------------------------------------------------- */

export interface CellPart {
  text: string;
  mono: boolean;
  tone: ThingPageCell['tone'] | null;
  /** A small bar before the text (a guest's CPU), 0…1. */
  meter: number | null;
}

export interface TableRowView {
  id: string;
  title: string;
  titleMono: boolean;
  /** Grey words after the title (“CT 131”). */
  note: string | null;
  /** The other words, joined with “ · ”. */
  line: CellPart[];
  /** The figures, on the right (CP-19). */
  right: CellPart[];
  /** A small line under the title (a guest's day), from the first column that has one. */
  spark: (number | null)[] | null;
  /** A small button (“Open”) where it goes somewhere the row itself doesn't. */
  button: { label: string; href: string } | null;
  /** Buttons in its cells (0.121, CT-1002): Scan on a library, Retry on a failed download. */
  actions: ThingPageButton[];
  dot: NonNullable<ThingPageCell['dot']> | null;
  href: string | null;
  /** The service's own page for the row (0.121, CT-1013), opened in the browser when the row has no `href`. */
  url: string | null;
  spoken: string;
}

const cellWords = (c: ThingPageCell) => (c.note ? `${c.text} (${c.note})` : c.text);

/** A dot's words for TalkBack; a fine one says nothing (the usual case). */
const DOT_WORDS: Record<NonNullable<ThingPageCell['dot']>, string | null> = {
  ok: null,
  warn: 'Needs a look',
  bad: 'Problem',
  off: 'Off',
};

/** A console stays on the web (the phone has none): its button is left out. */
export const isConsoleHref = (href: string) => /[?&]console=/.test(href);

/**
 * A table on the phone: each row's first column is its title (with its note after it), the numeric columns stand on
 * the right (a small bar before a CPU's figure), every other column joins the line under the title, a small line goes
 * under it; the first state dot leads the row; a button shows when it goes somewhere the row doesn't (not a console).
 * A cell's `action` (0.121) is a button of the row instead of its words; a cell's `url` opens the row in the browser
 * when it has no page of the app (the title's first, `href` wins; service-dashboards.md AP-4644).
 */
export function tableRows(panel: Extract<ThingPagePanel, { kind: 'table' }>): TableRowView[] {
  const [first, ...rest] = panel.columns;
  return panel.rows.map((r) => {
    const head = first ? r.cells[first.key] : undefined;
    const href = head?.href ?? null;
    const others = rest.map((c) => ({ column: c, cell: r.cells[c.key] }));
    const sparkCell = others.find((o) => hasLine(o.cell?.spark));
    const buttonCell = others.find(
      (o) =>
        o.cell?.button &&
        o.cell.href &&
        o.cell.text.trim() &&
        !isConsoleHref(o.cell.href) &&
        o.cell.href !== href,
    );
    const filled = others.filter(
      (o): o is { column: typeof o.column; cell: ThingPageCell } =>
        !!o.cell?.text.trim() && !o.cell.button && !o.cell.spark && !o.cell.action,
    );
    const actions = [head, ...others.map((o) => o.cell)].flatMap((c) => (c?.action ? [c.action] : []));
    const url = href
      ? null
      : (head?.url ?? others.find((o) => o.cell?.url && !o.cell.action)?.cell?.url ?? null);
    const part = (c: ThingPageCell): CellPart => ({
      text: cellWords(c),
      mono: !!c.mono || !!c.tag,
      tone: c.tone ?? null,
      meter: typeof c.meter === 'number' ? Math.max(0, Math.min(1, c.meter)) : null,
    });
    const dot = head?.dot ?? others.find((o) => o.cell?.dot)?.cell?.dot ?? null;
    const title = head?.text.trim() || '—';
    const spark = sparkCell?.cell?.spark ?? null;
    const trend = spark ? trendWords(spark) : null;
    return {
      id: r.id,
      title,
      titleMono: !!head?.mono,
      note: head?.note?.trim() || null,
      line: filled.filter((o) => !o.column.numeric).map((o) => part(o.cell)),
      right: filled.filter((o) => o.column.numeric).map((o) => part(o.cell)),
      spark,
      button:
        buttonCell?.cell?.href && buttonCell.cell.text
          ? { label: buttonCell.cell.text.trim(), href: buttonCell.cell.href }
          : null,
      actions,
      dot,
      href,
      url,
      spoken: [
        head?.note ? `${title}, ${head.note}` : title,
        dot ? DOT_WORDS[dot] : null,
        ...filled.map((o) =>
          o.column.label ? `${o.column.label}: ${cellWords(o.cell)}` : cellWords(o.cell),
        ),
        trend && sparkCell ? `${sparkCell.column.label || 'Trend'}: ${trend}` : null,
      ]
        .filter(Boolean)
        .join('. '),
    };
  });
}
