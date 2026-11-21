// Average and peak of a metrics series. Peak comes from the hub's stored
// maximum (`summary.max`, CONTRACT), never from the plotted averages; the
// plotted values are only a fallback when the API sends no summary at all.

import type { Metrics } from '../api/types';
import { argMax, meanOf } from './chart';

export interface SeriesStats {
  avg: number | null;
  max: number | null;
  /** ISO timestamp of the peak. */
  at: string | null;
}

export function seriesStats(metrics: Metrics | undefined, key: string): SeriesStats {
  const vals = metrics?.series[key] ?? [];
  const summary = metrics?.summary;
  if (summary && key in summary) {
    const s = summary[key];
    return { avg: s?.avg ?? null, max: s?.max ?? null, at: s?.max_at ?? null };
  }
  const i = argMax(vals);
  return { avg: meanOf(vals), max: i === null ? null : (vals[i] ?? null), at: i === null ? null : (metrics?.timestamps[i] ?? null) };
}
