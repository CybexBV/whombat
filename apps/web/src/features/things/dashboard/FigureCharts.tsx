/**
 * The charts a figure opens (Whombat connections-page.md CN-05, CN-06; app connections-page.md AP-2510; mock
 * `#server-open`): inside the figures' card, under the figures, each chart with its title and its average and peak, the
 * range (1h…90d) and a close button at the right end (beside a single chart's head, above two), the plot on the chart
 * cards' own parts (`ChartPlot`), and its small facts under it in a row. Network and the disks' traffic sit side by side
 * by their spans, as a chart row does, their plots level whatever their heads hold; a narrow card stacks them. Escape
 * closes it too.
 */
import { type HostSeriesRange, thingPanelSpan } from '@whombat/core';
import { X } from 'lucide-react';
import { type CSSProperties, Fragment, useMemo } from 'react';
import { Icon } from '../../../components/Icon';
import { ChartFoot, ChartLegend, ChartPlot } from './ChartCard';
import { type ChartPanel, chartModel } from './chartModel';
import styles from './Dashboard.module.css';
import { LineParts } from './LineParts';
import { chartRowColumns } from './layout';
import { RangeSeg } from './RangePicker';

/** Where a part sits: its grid column and row on a wide card, its place in the stack on a narrow one. */
function at(col: string, row: number, order: number): CSSProperties {
  return { '--col': col, '--row': row, '--order': order } as CSSProperties;
}

export function OpenCharts({
  id,
  charts,
  timeZone,
  rangeWords,
  range,
  ranges,
  onRange,
  onClose,
}: {
  /** The region's id, the figures' `aria-controls`. */
  id: string;
  /** The open figure's charts; null: closed (the region is there, hidden). */
  charts: readonly ChartPanel[] | null;
  timeZone: string;
  /** “the last 24 hours”. */
  rangeWords: string;
  range: HostSeriesRange;
  /** The page's ranges; none or one: no picker. */
  ranges: readonly HostSeriesRange[];
  onRange: (range: HostSeriesRange) => void;
  onClose: () => void;
}) {
  const models = useMemo(() => (charts ?? []).map((c) => chartModel(c, timeZone)), [charts, timeZone]);
  if (!charts?.length) return <div id={id} hidden />;
  const n = charts.length;
  // One chart: its head and the tools share the first row, the plot spans both (the mock). Two or three: the tools take
  // a row of their own above the heads, so every chart keeps the width its span gives it.
  const one = n === 1;
  const head = one ? 1 : 2;
  const least = one ? 200 : 180;
  return (
    <section
      id={id}
      aria-labelledby={charts.map((c) => `${id}-${c.id}`).join(' ')}
      className={styles.open}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className={styles.openGrid}
        style={{
          gridTemplateColumns: `${chartRowColumns(charts.map((c) => thingPanelSpan(c)))}${one ? ' auto' : ''}`,
        }}
      >
        {charts.map((c, i) => {
          const model = models[i];
          return (
            <div
              key={`${c.id}-head`}
              className={styles.ocHead}
              style={at(`${i + 1}`, head, i === 0 ? 0 : i * 2 + 1)}
            >
              <div className={styles.ocTitleLine}>
                <h3 id={`${id}-${c.id}`} className={styles.ocTitle}>
                  {c.title}
                </h3>
                {c.stats?.length ? (
                  <p className={styles.ocStats}>
                    {c.stats.map((line, k) => (
                      <Fragment key={line.map((p) => p.text).join('')}>
                        {k ? ' · ' : null}
                        <LineParts line={line} />
                      </Fragment>
                    ))}
                  </p>
                ) : null}
              </div>
              {model && model.lines.length > 1 ? <ChartLegend model={model} /> : null}
            </div>
          );
        })}
        <div className={styles.ocTools} style={at(one ? '2' : '1 / -1', 1, 1)}>
          <RangeSeg ranges={ranges} value={range} onChange={onRange} />
          <button type="button" className={styles.ocClose} aria-label="Close" title="Close" onClick={onClose}>
            <Icon icon={X} size={15} />
          </button>
        </div>
        {charts.map((c, i) => {
          const model = models[i];
          if (!model) return null;
          return (
            <div key={`${c.id}-plot`} style={at(one ? '1 / -1' : `${i + 1}`, head + 1, i * 2 + 2)}>
              <ChartPlot
                panel={c}
                model={model}
                rangeWords={rangeWords}
                least={least}
                className={styles.ocPlot}
              />
              <ChartFoot panel={c} className={styles.ocFoot} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
