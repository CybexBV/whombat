/**
 * A chart whose points carry their own words (Whombat service-slots.md SLT-06; app service-slots-web.md; mock's This
 * week): a service's Trend. The card's head like any card's (title, meta, its Ask), the figure large with the stats
 * beside it, then a bar per point with its word under it (“Thu” … “Today”, the last one set in the ink) on a few
 * gridlines; a bar's value shows over it on hover, and a screen reader hears each bar's day and value. Its words
 * aren't times, so it keeps out of the page's range. A line chart with words draws on the one chart engine with those
 * words under its points.
 */
import { type CSSProperties, useMemo } from 'react';
import { cx } from '../../../components/cx';
import things from '../Things.module.css';
import { ChartFoot, ChartPlot } from './ChartCard';
import { axisOver, type ChartPanel, chartModel, seriesColor, tickWords } from './chartModel';
import { LineParts } from './LineParts';
import { type DashboardContext, PanelHead } from './Panels';
import styles from './Slots.module.css';
import { labelledBarWords } from './slots';

/** The bars' least height (the mock's 128px); a taller row gives them more. */
const PLOT_LEAST = 128;

export function TrendCard({ panel, ctx }: { panel: ChartPanel; ctx: DashboardContext }) {
  const model = useMemo(() => chartModel(panel, ctx.timeZone), [panel, ctx.timeZone]);
  const titleId = `chart-${panel.id}`;
  const bars = panel.style === 'bars';
  return (
    <section className={cx(things.card, styles.trend)} aria-labelledby={titleId}>
      <header className={things.cardHead}>
        <h2 id={titleId}>{panel.title}</h2>
        {panel.meta ? <span className={things.meta}>{panel.meta}</span> : null}
        <PanelHead panel={panel} ctx={ctx} />
      </header>
      <div className={styles.trendBody}>
        {panel.figure || panel.stats?.length ? (
          <p className={styles.trendFigure}>
            {panel.figure ? (
              <>
                <b>{panel.figure.value}</b>
                {panel.figure.rest ? <span>{panel.figure.rest}</span> : null}
              </>
            ) : null}
            {panel.stats?.map((line) => (
              <em key={line.map((p) => p.text).join('')}>
                <LineParts line={line} />
              </em>
            ))}
          </p>
        ) : null}
        {bars ? (
          <LabelledBars panel={panel} />
        ) : (
          <ChartPlot panel={panel} model={model} rangeWords="this time" least={PLOT_LEAST} />
        )}
        <ChartFoot panel={panel} />
      </div>
    </section>
  );
}

/** The bars, stacked when there are several series, each with its word under it and its value on hover. */
export function LabelledBars({ panel }: { panel: ChartPanel }) {
  const labels = panel.labels ?? [];
  const n = Math.max(labels.length, ...panel.series.map((s) => s.values.length));
  const totals = Array.from({ length: n }, (_, i) =>
    panel.series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0),
  );
  const unit = panel.axis?.unit ?? panel.series[0]?.unit ?? null;
  const axis = axisOver(totals, unit, { min: panel.axis?.min, max: panel.axis?.max }, 3);
  const tick = tickWords(unit);
  const span = axis.max - axis.min || 1;
  const pct = (v: number) => `${Math.max(0, Math.min(100, ((v - axis.min) / span) * 100))}%`;
  const first = panel.series[0];
  const valueWords = (i: number) => {
    if (panel.series.length === 1 && first) {
      const v = first.values[i];
      return v == null ? 'none' : `${v}${first.unit ? ` ${first.unit}` : ''}`;
    }
    return panel.series.map((s) => `${s.label} ${s.values[i] ?? 'none'}`).join(', ');
  };
  const words = (i: number) =>
    labelledBarWords(
      labels[i] ?? '',
      valueWords(i),
      panel.series.length === 1 ? (first?.label ?? '') : '',
      unit,
    );
  return (
    <div className={styles.lchart} style={{ '--lc': seriesColor(first?.color, 0) } as CSSProperties}>
      <div className={styles.lplot} style={{ '--lplot-least': `${PLOT_LEAST}px` } as CSSProperties}>
        <div className={styles.lyax} aria-hidden="true">
          {axis.ticks.map((t) => (
            <span key={t} style={{ bottom: pct(t) }}>
              {tick(t)}
            </span>
          ))}
        </div>
        <div className={styles.lbarsBox}>
          {axis.ticks.slice(1).map((t) => (
            <span key={t} className={styles.lgrid} style={{ bottom: pct(t) }} aria-hidden="true" />
          ))}
          <ul className={styles.lbars} style={{ '--lbars': n } as CSSProperties} aria-label={panel.title}>
            {Array.from({ length: n }, (_, i) => {
              const said = words(i);
              const last = i === n - 1;
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: one bar per point, in order
                  key={i}
                  className={cx(styles.lcol, i === 0 && styles.lcolFirst, last && styles.lcolLast)}
                  style={{ '--h': pct(totals[i] ?? 0) } as CSSProperties}
                  aria-label={said}
                >
                  <span className={styles.lstack} aria-hidden="true">
                    {panel.series.map((s, j) => {
                      const v = Math.max(0, s.values[i] ?? 0);
                      if (!v) return null;
                      return (
                        <i
                          key={s.key}
                          style={{
                            flexGrow: v,
                            ...(j > 0 ? { opacity: 0.55 } : {}),
                          }}
                        />
                      );
                    })}
                  </span>
                  <span className={styles.ltip} aria-hidden="true">
                    {said}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <div className={styles.lxax} style={{ '--lbars': n } as CSSProperties} aria-hidden="true">
        {Array.from({ length: n }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one word per point, in order
          <span key={i} className={i === n - 1 ? styles.lxLast : undefined}>
            {labels[i] ?? ''}
          </span>
        ))}
      </div>
    </div>
  );
}
