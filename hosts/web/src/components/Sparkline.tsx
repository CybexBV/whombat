// Sparkline: viewBox 200 x 36, preserveAspectRatio none, non-scaling 1.5 px
// stroke (2 px on allocation cards), area at 12%. Decorative (aria-hidden):
// the value beside it carries the meaning. Gaps stay gaps.

import type { SeriesValues } from '../api/types';
import { seriesPaths, sparkDomain } from '../lib/chart';

interface Props {
  values: SeriesValues | undefined;
  color: string;
  strokeWidth?: number;
  height?: number;
}

export function Sparkline({ values, color, strokeWidth = 1.5, height = 36 }: Props) {
  const dom = values ? sparkDomain(values) : null;
  const p = values && dom ? seriesPaths(values, dom[0], dom[1], 200, 36) : { line: '', area: '' };
  return (
    <svg className="spark" viewBox="0 0 200 36" preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ height }}>
      {p.area && <path d={p.area} style={{ fill: color, fillOpacity: 0.12, stroke: 'none' }} />}
      {p.line && <path className="ln" d={p.line} style={{ stroke: color, strokeWidth }} />}
    </svg>
  );
}
