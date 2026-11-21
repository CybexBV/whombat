/**
 * A chart card (Whombat dashboards.md DS-06; contracts 0.89 CT-395; dashboards-web.md AP-2050…; mock server.png): the
 * title, the figure now (“18 %” · “of 16 threads”) or, for two or more lines without one, a legend with each line's
 * latest figure; on the right the server's average and peak; then the plot on the one chart engine (`TimeChart`): an
 * area or plain lines, stacked bars for counts, a dashed limit with its words, a dashed forecast to where the last value
 * is heading, a second unit's words on the right (a 0.88 card); hover or the keyboard reads every line's value. Up to
 * four small facts under it. The plot grows to the card's height, so the cards of a row end together. The legend, the
 * plot and the facts are their own parts (`ChartLegend`, `ChartPlot`, `ChartFoot`): a figure that opens its charts
 * draws them with the same parts (connections-page.md AP-2510).
 */
import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TimeChart } from '../../../components/charts';
import { AXIS_CHAR_WIDTH } from '../../../components/charts/fitTimeTicks';
import { cx } from '../../../components/cx';
import things from '../Things.module.css';
import { type ChartModel, type ChartPanel, chartModel } from './chartModel';
import styles from './Dashboard.module.css';
import { LineParts } from './LineParts';

/** The mock's room for the axes' words: about 38px on the left (more for a longer word like `400 ms`), 22px under. */
const PAD = { left: 40, right: 8, top: 8, bottom: 22 } as const;

/** The left axis's room: its longest word in 11px DM Mono, and the 8px gap before the plot. */
function leftRoom(words: readonly string[]): number {
  return Math.max(PAD.left, Math.ceil(Math.max(0, ...words.map((w) => w.length)) * AXIS_CHAR_WIDTH) + 12);
}

/** The plot's height: what the card leaves it, at least the mock's 150px in a third, 140px wider. */
function usePlotHeight(least: number): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(least);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => setHeight(Math.max(least, Math.floor(el.clientHeight)));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [least]);
  return [ref, height];
}

const TONES = { ok: undefined, warn: styles.warn, bad: styles.bad } as const;

/** A chart's foot facts as their tone's class (`ok` none). */
export function toneClass(tone: keyof typeof TONES | undefined): string | undefined {
  return tone ? TONES[tone] : undefined;
}

/** The lines with each one's colour and its latest figure (two or more lines without a figure). */
export function ChartLegend({ model }: { model: ChartModel }) {
  return (
    <dl className={styles.legend}>
      {model.lines.map((l) => (
        <div key={l.key}>
          <dt>
            <i style={{ background: l.color }} aria-hidden="true" />
            {l.label}
          </dt>
          {l.latest ? <dd>{l.latest}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/**
 * The plot on the one chart engine (`TimeChart`), growing to what its box leaves it (at least `least` px): an area or
 * plain lines, stacked bars, a dashed limit, a forecast, a second unit's words on the right. Shared by a chart card and
 * the charts a figure opens (connections-page.md AP-2510).
 */
export function ChartPlot({
  panel,
  model,
  rangeWords,
  least,
  className,
}: {
  panel: ChartPanel;
  model: ChartModel;
  /** “the last 24 hours”: what an empty chart says it has nothing of. */
  rangeWords: string;
  /** The plot's least height. */
  least: number;
  /** The box's own class: its least height and margins. */
  className?: string;
}) {
  const [boxRef, height] = usePlotHeight(least);
  const pad = useMemo(
    () => ({
      ...PAD,
      left: leftRoom(model.left.ticks.map(model.left.label)),
      right: model.right ? 44 : PAD.right,
    }),
    [model],
  );
  const series = useMemo(
    () =>
      model.drawn.map((l) => ({
        key: l.key,
        label: l.label,
        color: l.color,
        values: l.plotted,
        area: l.fill,
        format: l.formatPlotted,
      })),
    [model],
  );
  const first = model.lines[0];
  const y = (v: number) =>
    pad.top +
    (1 - (v - model.left.min) / (model.left.max - model.left.min || 1)) * (height - pad.top - pad.bottom);
  return (
    <div ref={boxRef} className={cx(styles.plotBox, className)}>
      <div className={styles.plotFill}>
        {model.empty ? (
          <p className={styles.plotEmpty}>Nothing read in {rangeWords} yet.</p>
        ) : (
          <>
            <TimeChart
              label={`${panel.title}: ${model.lines.map((l) => `${l.label} ${l.latest ?? 'none'}`).join(', ')}`}
              height={height}
              series={series}
              min={model.left.min}
              max={model.left.max}
              ticks={model.left.ticks}
              tickLabel={model.left.label}
              timeTicks={model.ticks}
              pointLabel={model.pointLabel}
              formatValue={first?.format ?? String}
              bars={model.bars}
              extend={model.forecast?.extend ?? 0}
              {...(model.forecast
                ? {
                    forecast: {
                      value: model.forecast.value,
                      label: model.forecast.label,
                      color: first?.color ?? 'var(--warn)',
                    },
                  }
                : {})}
              {...(model.limit
                ? {
                    lines: [
                      {
                        value: model.limit.value,
                        color: 'var(--warn)',
                        labelAt: 'start' as const,
                        ...(model.limit.label ? { label: model.limit.label } : {}),
                      },
                    ],
                  }
                : {})}
              pad={pad}
              soft
            />
            {model.right ? (
              <div className={styles.rightAxis} aria-hidden="true">
                {model.right.ticks.map((t, k) => (
                  <span key={t} style={{ top: y(model.left.ticks[k] ?? 0) }}>
                    {model.right?.label(t)}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Up to four small facts under a chart (“User 11.4 %”). */
export function ChartFoot({ panel, className }: { panel: ChartPanel; className?: string }) {
  if (!panel.foot?.length) return null;
  return (
    <dl
      className={className ?? styles.foot}
      style={className ? undefined : { gridTemplateColumns: `repeat(${panel.foot.length}, minmax(0, 1fr))` }}
    >
      {panel.foot.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd className={toneClass(f.tone)}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ChartCard({
  panel,
  timeZone,
  rangeWords,
  wide,
}: {
  panel: ChartPanel;
  timeZone: string;
  /** “the last 24 hours”: what an empty chart says it has nothing of. */
  rangeWords: string;
  /** Two or three columns wide: a lower plot. */
  wide: boolean;
}) {
  const model = useMemo(() => chartModel(panel, timeZone), [panel, timeZone]);
  const titleId = `chart-${panel.id}`;
  const legend = model.lines.length > 1 && !panel.figure;
  return (
    <section className={cx(things.card, styles.cc)} aria-labelledby={titleId}>
      <div className={styles.ccTop}>
        <div className={styles.ccMain}>
          <h2 id={titleId} className={styles.ccTitle}>
            {panel.title}
            {panel.meta && !panel.figure ? <span className={styles.ccMeta}>{panel.meta}</span> : null}
          </h2>
          {panel.figure ? (
            <p className={cx(styles.big, toneClass(panel.figure.tone))}>
              {panel.figure.value}
              {panel.figure.rest ? <small className={styles.bigRest}>{panel.figure.rest}</small> : null}
            </p>
          ) : null}
          {legend ? <ChartLegend model={model} /> : null}
        </div>
        {panel.stats?.length ? (
          <div className={styles.stats}>
            {panel.stats.map((line) => (
              <div key={line.map((p) => p.text).join('')}>
                <LineParts line={line} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <ChartPlot
        panel={panel}
        model={model}
        rangeWords={rangeWords}
        least={wide ? 140 : 150}
        className={wide ? styles.plotBoxWide : undefined}
      />
      <ChartFoot panel={panel} />
    </section>
  );
}
