/**
 * The figures that open their charts on the web (Whombat connections-page.md CN-05, CN-06; app connections-page.md
 * AP-2510): which charts a figure opens is `figureCharts` (`@whombat/client`, shared with the phone); this says where the
 * range picker sits and how a figure's value is set. Pure.
 */
import { figureCharts } from '@whombat/client';
import type { ThingPagePanel } from '@whombat/core';

/**
 * Whether the page's range picker stays in the tab row: while a chart card is left that no figure opens (an older
 * server, a connection whose figures don't name their charts), or no figure opens any chart but a figure draws its
 * small line over the range (nothing else offers the range then). A page with neither has no picker (a Seerr page),
 * and neither has one whose only charts carry their own words.
 * When every chart sits behind a figure the picker is beside the open charts only.
 */
export function rangeInTabRow(panels: readonly ThingPagePanel[]): boolean {
  const { open, panels: left } = figureCharts(panels);
  // A chart with its own words under its bars (a week's plays) isn't over the range (service-slots.md SLT-06).
  if (left.some((p) => p.kind === 'chart' && !p.labels?.length)) return true;
  // No figure opens a chart: the range only matters to the figures' small lines; without any, nothing uses it (AP-4573).
  return (
    Object.keys(open).length === 0 &&
    panels.some((p) => p.kind === 'kpis' && p.items.some((k) => (k.spark?.length ?? 0) > 0))
  );
}

/**
 * A figure's value with a short unit after it set apart, as the mock draws “10 %” and “75 °C”: the number, then the
 * unit (with the space before it, so the words read the same) in the small face. A value without one (“76”, “—”,
 * “valid”) is all number.
 */
export function splitFigureValue(value: string): { number: string; unit: string | null } {
  const m = /^(.*\d)(\s+[^\d\s]{1,5})$/.exec(value);
  return m ? { number: m[1] as string, unit: m[2] as string } : { number: value, unit: null };
}
