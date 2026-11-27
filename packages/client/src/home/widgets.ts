/**
 * A pinned widget as Home draws it (mock 1; one-whombat.md ONE-09; app one-whombat-shell.md AP-1268): the latest
 * values over the chart (“Room 21.0 °C”), the lines on a value axis with round steps (0°…50°), the hours along the
 * bottom (`00:00 … 5 min ago · 14:00`: the last point says its own time, never “Now”) and the line under it that says it
 * refreshes without the AI. Pure; web and phone share it.
 */
import type { Widget } from '@whombat/core';
import { formatAgo, formatClock, toDate, zonedParts } from '@whombat/core/text';
import { clientTranslator } from '../i18n/catalog';

export interface WidgetLine {
  key: string;
  label: string;
  unit: string | null;
  /** 1, 2 or 3: `--chart1`… */
  color: 1 | 2 | 3;
  /** One value per point, oldest first (null: no reading then). */
  values: (number | null)[];
  /** The latest value as shown (`21.0`, `34`), null when there is none. */
  latest: string | null;
}

export interface WidgetChartModel {
  lines: WidgetLine[];
  /** Point times (ms), oldest first. */
  times: number[];
  min: number;
  max: number;
  ticks: number[];
  /** `50°` when every line is in °C/°F, else the bare number. */
  tickLabel: (v: number) => string;
  timeTicks: { index: number; label: string }[];
  /** When the newest point was read (ms), null without points: a failed refresh says its readings are from then. */
  lastAt: number | null;
  /** The tooltip's first line for a point: its clock. */
  pointLabel: (index: number) => string;
  /** “You pinned this from a conversation. It updates every minute without asking the AI.” */
  footer: string;
  empty: boolean;
}

/** How many decimals a line's numbers carry (0 or 1): its latest is shown the same way (`21.0`, `34`). */
function decimalsOf(values: readonly (number | null)[]): 0 | 1 {
  return values.some((v) => v !== null && Math.abs(v - Math.round(v)) > 1e-9) ? 1 : 0;
}

/** A value as the widget shows it, with `decimals` (0 or 1). */
export function formatWidgetValue(value: number, decimals: 0 | 1): string {
  return decimals ? value.toFixed(1) : String(Math.round(value));
}

/** The step of a round axis from 0 (or below) to `top` with at most `count` gaps: 1, 2, 5, 10, 20, 25, 50… */
function niceStep(range: number, count: number): number {
  const raw = range / count;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/** The value axis: from 0 (or the lowest round step under a negative) to the round step over the top. */
export function valueAxis(values: readonly number[]): { min: number; max: number; ticks: number[] } {
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const step = niceStep(Math.max(1, hi - lo) * 1.1, 5);
  const min = Math.floor(lo / step) * step;
  const max = Math.max(step, Math.ceil((hi * 1.1) / step) * step);
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 1000; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { min, max, ticks };
}

/** “every minute”, “every 5 minutes”, “every hour”, “every 2 hours”, “every day”. */
export function refreshPhrase(seconds: number, locale?: string | null): string {
  const tr = clientTranslator(locale);
  if (seconds >= 86_400 && seconds % 86_400 === 0) {
    return tr.tp('widget.refresh.day', seconds / 86_400);
  }
  if (seconds >= 3600 && seconds % 3600 === 0) {
    return tr.tp('widget.refresh.hour', seconds / 3600);
  }
  return tr.tp('widget.refresh.minute', Math.max(1, Math.round(seconds / 60)));
}

/** The line under a widget: where it came from and that it refreshes without the AI (ONE-09). */
export function widgetFooter(
  widget: Pick<Widget, 'fromConversationId' | 'refreshSec'>,
  locale?: string | null,
): string {
  const tr = clientTranslator(locale);
  const every = refreshPhrase(widget.refreshSec, locale);
  return tr.t(widget.fromConversationId ? 'widget.footerFromChat' : 'widget.footer', { every });
}

/**
 * The last point's own time: “5 min ago · 14:00”, “just now · 14:00”, or the clock alone without `now`. Never “Now”:
 * a point read five minutes ago isn't now, and after a failed refresh it gets older.
 */
export function lastPointLabel(
  t: number,
  timeZone: string,
  now?: Date | number,
  locale?: string | null,
): string {
  const clock = formatClock(t, timeZone);
  if (now === undefined) return clock;
  if (!locale) return `${formatAgo(t, now, timeZone)} · ${clock}`;
  const tr = clientTranslator(locale);
  const sec = Math.max(0, Math.round((toDate(now).getTime() - t) / 1000));
  const ago =
    sec < 60
      ? tr.t('managed.ago.justNow')
      : sec < 3600
        ? tr.t('hosts.ago.min', { n: Math.floor(sec / 60) })
        : sec < 86_400
          ? tr.t('hosts.ago.h', { n: Math.floor(sec / 3600) })
          : tr.t('hosts.ago.d', { n: Math.floor(sec / 86_400) });
  return `${ago} · ${clock}`;
}

/**
 * The hours along the bottom: every 4 hours on the clock inside the points' span (`00:00`, `04:00`, …) at the nearest
 * point, and the last point's own time under it (`lastPointLabel`); an hour label too close to it (under a sixth of
 * the span) is left out.
 */
export function widgetTimeTicks(
  times: readonly number[],
  timeZone: string,
  now?: Date | number,
  locale?: string | null,
): { index: number; label: string }[] {
  if (times.length < 2)
    return times.length
      ? [{ index: 0, label: lastPointLabel(times[0] as number, timeZone, now, locale) }]
      : [];
  const first = times[0] as number;
  const last = times[times.length - 1] as number;
  const span = last - first;
  const hours = span > 2 * 86_400_000 ? 24 : span > 8 * 3_600_000 ? 4 : 1;
  const out: { index: number; label: string }[] = [];
  // Walk the whole hours from the first point; label those on the grid.
  const start = Math.ceil(first / 3_600_000) * 3_600_000;
  for (let t = start; t <= last; t += 3_600_000) {
    const { hour, minute } = zonedParts(t, timeZone);
    if (minute !== 0 || hour % hours !== 0) continue;
    // The last label is wide (“5 min ago · 14:00”): an hour within a sixth of the span of it would run into it.
    if (last - t < span / 6) continue;
    out.push({ index: nearestIndex(times, t), label: formatClock(t, timeZone) });
  }
  out.push({ index: times.length - 1, label: lastPointLabel(last, timeZone, now, locale) });
  return out;
}

function nearestIndex(times: readonly number[], t: number): number {
  let best = 0;
  for (let i = 1; i < times.length; i++)
    if (Math.abs((times[i] as number) - t) < Math.abs((times[best] as number) - t)) best = i;
  return best;
}

const DEGREES = /^°[CF]?$/;

/** The model of a line widget for its card; `now` lets the last point say how old it is (“5 min ago · 14:00”). */
export function widgetChart(
  widget: Widget,
  timeZone: string,
  now?: Date | number,
  locale?: string | null,
): WidgetChartModel {
  const times = widget.points.map((p) => toDate(p.t).getTime());
  const lines: WidgetLine[] = widget.series.map((s) => {
    const values = widget.points.map((p) => {
      const v = p.values[s.key];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    });
    const latest = widget.latest.find((l) => l.key === s.key)?.value ?? lastValue(values);
    return {
      key: s.key,
      label: s.label,
      unit: s.unit ?? widget.latest.find((l) => l.key === s.key)?.unit ?? null,
      color: s.color,
      values,
      latest: latest === null ? null : formatWidgetValue(latest, decimalsOf(values)),
    };
  });
  const all = lines.flatMap((l) => l.values.filter((v): v is number => v !== null));
  const axis = valueAxis(all);
  const degrees = lines.length > 0 && lines.every((l) => l.unit !== null && DEGREES.test(l.unit));
  return {
    lines,
    times,
    ...axis,
    tickLabel: (v) => (degrees ? `${v}°` : String(v)),
    timeTicks: widgetTimeTicks(times, timeZone, now, locale),
    lastAt: times.length ? (times[times.length - 1] as number) : null,
    pointLabel: (i) => (times[i] === undefined ? '' : formatClock(times[i] as number, timeZone)),
    footer: widgetFooter(widget, locale),
    empty: all.length === 0,
  };
}

function lastValue(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i] as number;
  return null;
}

/** The widgets after moving `id` to `position` (0 = first): what `widgets.move` answers, applied at once. */
export function movedWidgets<W extends { id: string }>(
  widgets: readonly W[],
  id: string,
  position: number,
): W[] {
  const from = widgets.findIndex((w) => w.id === id);
  if (from < 0) return [...widgets];
  const next = widgets.filter((w) => w.id !== id);
  next.splice(Math.max(0, Math.min(next.length, position)), 0, widgets[from] as W);
  return next;
}
