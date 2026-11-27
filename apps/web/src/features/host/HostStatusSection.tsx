import {
  HOST_CPU_SCALE,
  type HostDayRow,
  type HostDiskRowKey,
  hostChartPoints,
  hostDayLines,
  hostDayRows,
  hostDayScale,
  hostDayTick,
  hostDiskBar,
  hostDiskRows,
  hostDiskText,
  hostMeasuringNote,
  hostPointLabel,
  hostPowerLine,
  hostPowerOf,
  hostSpeedScale,
  hostSpeedTick,
  hostTiles,
  hostTimeTicks,
  splitLead,
} from '@whombat/client';
import {
  formatBytes,
  formatMbits,
  formatUsagePct,
  HOST_RANGE_LABELS,
  hostStatusCopy,
  NBSP,
} from '@whombat/core/text';
import { HOST_METRICS_RANGES, type HostMetrics } from '@whombat/protocol/session';
import { BatteryLow, BatteryMedium, Plug } from 'lucide-react';
import { type ReactNode, useCallback, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import {
  ChartTable,
  ColumnChart,
  LineChart,
  Meter,
  Sparkline,
  StackBar,
  type Tip,
} from '../../components/charts';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import { THIS_WHOMBAT_TEXT } from '../../i18n/clientWords';
import { currentLocale, useWebI18n } from '../../i18n/provider';
import { useLocaleWords } from '../../i18n/words';
import styles from './HostStatus.module.css';
import { useHostStatus } from './useHostStatus';

/** The tables' first column (not in the mock; AP-1141). */
export const HOST_TABLE_WORDS = { time: 'Time', day: 'Day' } as const;

const C1 = 'var(--chart1)';
const C2 = 'var(--chart2)';
const C3 = 'var(--chart3)';

/** The disk's colours follow the part, never its size (AP-1143). */
const DISK_COLORS: Record<HostDiskRowKey, string> = {
  containers: C1,
  whombat: C2,
  work: C3,
  database: 'var(--mut)',
  other: 'var(--line2)',
  free: 'var(--sf2)',
};

const RANGE_OPTIONS = HOST_METRICS_RANGES.map((r) => ({ value: r, label: HOST_RANGE_LABELS[r] }));

/** How the box is doing (BS-01): the person's, there is nobody else to keep it from (one-person.md AP-5694). */
export function HostStatusSection({ burrow }: { burrow: string }) {
  const HOST_STATUS_COPY = useLocaleWords(hostStatusCopy);
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const { state, setRange } = useHostStatus(burrow, ref);
  const [charts, toggleCharts] = useChartsOpen();
  const box = state.reason === null;
  const metrics = state.metrics;
  const measuring = metrics && metrics.series.range === state.range ? hostMeasuringNote(metrics) : null;
  // A Whombat without a manager has no machine to show; one whose manager doesn't answer says so.
  if (state.reason === 'not_managed') return null;
  return (
    <section ref={ref} className={styles.section} aria-labelledby={id} data-host-status="">
      <div className={cx(styles.head, !box && styles.headAlone)}>
        <SectionLabel as="h2" id={id}>
          {HOST_STATUS_COPY.title}
        </SectionLabel>
        {box ? (
          <SegmentedControl
            variant="soft"
            className={styles.range}
            label={HOST_STATUS_COPY.rangeGroup}
            options={RANGE_OPTIONS}
            value={state.range}
            onChange={setRange}
          />
        ) : null}
      </div>
      {box ? <LiveLine power={metrics ? hostPowerLine(hostPowerOf(metrics.now)) : null} /> : null}
      {measuring ? <p className={styles.measuring}>{measuring}</p> : null}
      {state.reason === 'unavailable' ? (
        <p className={styles.quietCard}>{HOST_STATUS_COPY.unavailable}</p>
      ) : null}
      {box && metrics ? (
        <div className={cx(styles.frame, state.loading && styles.dim)} aria-busy={state.loading || undefined}>
          <Tiles metrics={metrics} />
          {charts ? (
            <div>
              <ProcessorCard metrics={metrics} />
              <div className={styles.grid2} style={{ marginTop: 10 }}>
                <NetworkCard metrics={metrics} />
                <DaysCard metrics={metrics} />
              </div>
            </div>
          ) : null}
        </div>
      ) : box ? (
        <div className={cx(styles.card, styles.full)} aria-busy="true">
          <SkeletonRows count={4} lines={1} />
        </div>
      ) : null}
      {/* The disk behind Show charts (this-whombat-sections.md AP-1227). What the AI used is Spend's, in Settings →
          Advanced: one place for it. */}
      {box && metrics ? (
        <>
          {charts ? <DiskCard metrics={metrics} /> : null}
          <Button
            variant="link"
            className={styles.chartsToggle}
            aria-expanded={charts}
            onClick={() => toggleCharts(!charts)}
          >
            {charts ? THIS_WHOMBAT_TEXT.hideCharts : THIS_WHOMBAT_TEXT.showCharts}
          </Button>
        </>
      ) : null}
    </section>
  );
}

/**
 * “Live · checked every 10 seconds”, and on a machine with a battery its power on the right (desk-display-web.md
 * AP-3020): plugged in with the plug, on battery with an amber (from 15 %, red) dot, as the desk screen's power chip.
 */
function LiveLine({ power }: { power: ReturnType<typeof hostPowerLine> }) {
  const HOST_STATUS_COPY = useLocaleWords(hostStatusCopy);
  const live = (
    <p className={styles.sub}>
      <span className={styles.live} aria-hidden="true" />
      {HOST_STATUS_COPY.live}
    </p>
  );
  if (!power) return live;
  const glyph = power.source === 'ac' ? Plug : power.tone === 'bad' ? BatteryLow : BatteryMedium;
  return (
    <div className={styles.subRow}>
      {live}
      <p className={styles.power} data-power={power.source} data-tone={power.tone}>
        {power.tone === 'ok' ? null : <StatusDot tone={power.tone} size={7} label={null} />}
        <Icon icon={glyph} size={15} />
        {power.text}
      </p>
    </div>
  );
}

/** Whether the charts are open (AP-1227): kept for the visit, so coming back to the Overview shows them as left. */
const CHARTS_KEY = 'whombat.thisWhombat.charts';

function useChartsOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return window.sessionStorage.getItem(CHARTS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.sessionStorage.setItem(CHARTS_KEY, next ? '1' : '0');
    } catch {
      // Storage refused (private mode): open for this view only.
    }
  }, []);
  return [open, set];
}

/* Tiles ------------------------------------------------------------------------------------------------------------ */

function Tile({
  name,
  value,
  unit,
  line,
  children,
  lineFirst,
}: {
  name: string;
  value: string;
  unit?: string;
  line: string | null;
  children?: ReactNode;
  /** The line before the meter or sparkline (Processor, Today) or after it (Memory, Disk). */
  lineFirst: boolean;
}) {
  const lineEl = line ? <span className={styles.tileLine}>{line}</span> : null;
  return (
    <div className={cx(styles.card, styles.tile)}>
      <span className={styles.tileKey}>{name}</span>
      <span className={styles.tileValue}>
        {value}
        {unit ? <span className={styles.tileUnit}>{` ${unit}`}</span> : null}
      </span>
      {lineFirst ? lineEl : null}
      {children}
      {lineFirst ? null : lineEl}
    </div>
  );
}

function Tiles({ metrics }: { metrics: HostMetrics }) {
  const HOST_STATUS_COPY = useLocaleWords(hostStatusCopy);
  const t = useMemo(() => hostTiles(metrics), [metrics]);
  return (
    <div className={styles.tiles}>
      <Tile name={HOST_STATUS_COPY.processor} value={t.processor.value} line={t.processor.line} lineFirst>
        <Sparkline values={t.processor.spark} color={C1} />
      </Tile>
      <Tile
        name={HOST_STATUS_COPY.memory}
        value={t.memory.value}
        unit={t.memory.unit}
        line={t.memory.line}
        lineFirst={false}
      >
        <Meter pct={t.memory.pct} />
      </Tile>
      <Tile
        name={HOST_STATUS_COPY.disk}
        value={t.disk.value}
        unit={t.disk.unit}
        line={t.disk.line}
        lineFirst={false}
      >
        <Meter pct={t.disk.pct} />
      </Tile>
      <Tile
        name={HOST_STATUS_COPY.today}
        value={t.today.value}
        unit={t.today.unit}
        line={t.today.line}
        lineFirst
      >
        <Sparkline values={t.today.spark} color={C1} />
      </Tile>
    </div>
  );
}

/* Chart cards ------------------------------------------------------------------------------------------------------ */

/** A chart's card: its title (and what goes beside it), the hint with “Show as a table”, then the chart or the table. */
function ChartCard({
  title,
  aside,
  hint,
  hintId,
  legend,
  chart,
  table,
  after,
}: {
  title: string;
  aside?: ReactNode;
  hint: string;
  hintId: string;
  legend?: ReactNode;
  chart: ReactNode;
  table: () => ReactNode;
  /** Under the chart or its table either way (today's agents). */
  after?: ReactNode;
}) {
  const HOST_STATUS_COPY = useLocaleWords(hostStatusCopy);
  const [asTable, setAsTable] = useState(false);
  return (
    <div className={cx(styles.card, styles.chart)}>
      <div className={styles.chartHead}>
        <h3 className={styles.chartTitle}>{title}</h3>
        {aside}
      </div>
      <div className={styles.hintRow}>
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? HOST_STATUS_COPY.showChart : HOST_STATUS_COPY.showTable}
        </button>
      </div>
      {asTable ? (
        table()
      ) : (
        <>
          {legend}
          {chart}
        </>
      )}
      {after}
    </div>
  );
}

function Legend({ items, box }: { items: readonly { name: string; color: string }[]; box?: boolean }) {
  return (
    <ul className={styles.legend}>
      {items.map((it) => (
        <li key={it.name}>
          <i className={box ? styles.box : undefined} style={{ background: it.color }} aria-hidden="true" />
          {it.name}
        </li>
      ))}
    </ul>
  );
}

/** Newest first: the table opens on what just happened. */
const newestFirst = <T,>(rows: readonly T[]) => [...rows].reverse();

function ProcessorCard({ metrics }: { metrics: HostMetrics }) {
  const HOST_STATUS_COPY = useLocaleWords(hostStatusCopy);
  const hintId = useId();
  const { series, timeZone } = metrics;
  const points = useMemo(() => hostChartPoints(series), [series]);
  const ticks = useMemo(
    () => hostTimeTicks(points, series.range, timeZone),
    [points, series.range, timeZone],
  );
  const lines = useMemo(
    () => [
      {
        key: 'cpu',
        color: C1,
        area: true,
        values: points.map((p) => p.cpuPct),
        line: (v: number) => splitLead(HOST_STATUS_COPY.busy(v)),
      },
    ],
    [points, HOST_STATUS_COPY.busy],
  );
  return (
    <ChartCard
      title={HOST_STATUS_COPY.processor}
      hint={HOST_STATUS_COPY.processorHint(metrics.now.cores)}
      hintId={hintId}
      chart={
        <LineChart
          label={HOST_STATUS_COPY.processor}
          describedBy={hintId}
          height={150}
          series={lines}
          max={HOST_CPU_SCALE.max}
          ticks={HOST_CPU_SCALE.ticks}
          tickLabel={(v) => String(v)}
          timeTicks={ticks}
          pointLabel={(i) => hostPointLabel(points[i]?.at ?? 0, series.range, timeZone)}
        />
      }
      table={() => (
        <ChartTable
          caption={HOST_STATUS_COPY.processor}
          head={[HOST_TABLE_WORDS.time, HOST_STATUS_COPY.processor]}
          height={150}
          rows={newestFirst(points.filter((p) => p.cpuPct !== null)).map((p) => ({
            key: String(p.at),
            cells: [hostPointLabel(p.at, series.range, timeZone), formatUsagePct(p.cpuPct)],
          }))}
        />
      )}
    />
  );
}

const mbits = (bps: number | null) => `${formatMbits(bps ?? 0, currentLocale())}${NBSP}Mbit/s`;

function NetworkCard({ metrics }: { metrics: HostMetrics }) {
  const HOST_STATUS_COPY = useLocaleWords(hostStatusCopy);
  const hintId = useId();
  const { series, timeZone } = metrics;
  const points = useMemo(() => hostChartPoints(series), [series]);
  const ticks = useMemo(
    () => hostTimeTicks(points, series.range, timeZone),
    [points, series.range, timeZone],
  );
  const scale = useMemo(() => hostSpeedScale(points), [points]);
  const lines = useMemo(
    () => [
      {
        key: 'down',
        color: C1,
        values: points.map((p) => p.downBps),
        line: (v: number) => splitLead(HOST_STATUS_COPY.speedDown(v)),
      },
      {
        key: 'up',
        color: C2,
        values: points.map((p) => p.upBps),
        line: (v: number) => splitLead(HOST_STATUS_COPY.speedUp(v)),
      },
    ],
    [points, HOST_STATUS_COPY.speedUp, HOST_STATUS_COPY.speedDown],
  );
  return (
    <ChartCard
      title={HOST_STATUS_COPY.networkSpeed}
      hint={HOST_STATUS_COPY.networkHint}
      hintId={hintId}
      legend={
        <Legend
          items={[
            { name: HOST_STATUS_COPY.download, color: C1 },
            { name: HOST_STATUS_COPY.upload, color: C2 },
          ]}
        />
      }
      chart={
        <LineChart
          label={HOST_STATUS_COPY.networkSpeed}
          describedBy={hintId}
          height={140}
          series={lines}
          max={scale.max}
          ticks={scale.ticks}
          tickLabel={hostSpeedTick}
          timeTicks={ticks}
          pointLabel={(i) => hostPointLabel(points[i]?.at ?? 0, series.range, timeZone)}
        />
      }
      table={() => (
        <ChartTable
          caption={HOST_STATUS_COPY.networkSpeed}
          head={[HOST_TABLE_WORDS.time, HOST_STATUS_COPY.download, HOST_STATUS_COPY.upload]}
          height={160}
          rows={newestFirst(points.filter((p) => p.downBps !== null)).map((p) => ({
            key: String(p.at),
            cells: [hostPointLabel(p.at, series.range, timeZone), mbits(p.downBps), mbits(p.upBps)],
          }))}
        />
      )}
    />
  );
}

/** A tooltip line from a copy line (`2.2 GB received`): the value bold, then the rest. */
const tipLine = (color: string, words: string) => ({ color, ...splitLead(words) });

function DaysCard({ metrics }: { metrics: HostMetrics }) {
  const HOST_STATUS_COPY = useLocaleWords(hostStatusCopy);
  const { tag: uiLocale } = useWebI18n();
  const hintId = useId();
  const rows = useMemo(() => hostDayRows(metrics.days), [metrics.days]);
  const scale = useMemo(() => hostDayScale(rows), [rows]);
  const tip = (r: HostDayRow): Tip => {
    const l = hostDayLines(r);
    return {
      title: r.title,
      lines: [tipLine(C1, l.received), tipLine(C2, l.sent)],
    };
  };
  return (
    <ChartCard
      title={HOST_STATUS_COPY.perDay}
      hint={HOST_STATUS_COPY.perDayHint}
      hintId={hintId}
      legend={
        <Legend
          box
          items={[
            { name: HOST_STATUS_COPY.received, color: C1 },
            { name: HOST_STATUS_COPY.sent, color: C2 },
          ]}
        />
      }
      chart={
        <ColumnChart
          label={HOST_STATUS_COPY.perDay}
          describedBy={hintId}
          height={140}
          rows={rows}
          rowKey={(r) => r.date}
          parts={[
            { key: 'in', color: C1, value: (r) => r.inBytes },
            { key: 'out', color: C2, value: (r) => r.outBytes },
          ]}
          max={scale.max}
          axis={{ ticks: scale.ticks, label: (v) => hostDayTick(v, scale.max) }}
          columnLabel={(r) => r.axis}
          tip={tip}
        />
      }
      table={() => (
        <ChartTable
          caption={HOST_STATUS_COPY.perDay}
          head={[HOST_TABLE_WORDS.day, HOST_STATUS_COPY.received, HOST_STATUS_COPY.sent]}
          height={160}
          rows={newestFirst(rows).map((r) => ({
            key: r.date,
            cells: [r.title, formatBytes(r.inBytes, uiLocale), formatBytes(r.outBytes, uiLocale)],
          }))}
        />
      )}
    />
  );
}

/* Disk -------------------------------------------------------------------------------------------------------- */

function DiskCard({ metrics }: { metrics: HostMetrics }) {
  const HOST_STATUS_COPY = useLocaleWords(hostStatusCopy);
  const data = metrics.disks.data;
  const rows = useMemo(() => hostDiskRows(data), [data]);
  const text = hostDiskText(metrics.disks);
  // While the parts are recounted the bar's used part is one, in the first colour.
  const bar = hostDiskBar(data, rows).map((r) => ({
    key: r.key,
    bytes: r.bytes,
    color: data.parts === null && r.key === 'other' ? C1 : DISK_COLORS[r.key],
  }));
  return (
    <div className={cx(styles.card, styles.disk)}>
      <h3 className={styles.chartTitle}>{HOST_STATUS_COPY.disk}</h3>
      <p className={styles.diskHint}>{text.used}</p>
      <StackBar parts={bar} />
      <dl className={styles.legendRows}>
        {rows.map((r) => (
          <DiskRow
            key={r.key}
            color={DISK_COLORS[r.key]}
            free={r.key === 'free'}
            label={r.label}
            value={r.value}
          />
        ))}
      </dl>
      {text.others.map((line) => (
        <p key={line} className={styles.note}>
          {line}
        </p>
      ))}
    </div>
  );
}

function DiskRow({
  color,
  free,
  label,
  value,
}: {
  color: string;
  free: boolean;
  label: string;
  value: string;
}) {
  return (
    <>
      <span
        className={cx(styles.swatch, free && styles.freeSwatch)}
        style={{ background: color }}
        aria-hidden="true"
      />
      <dt className={free ? styles.freeName : undefined}>{label}</dt>
      <dd className={styles.size}>{value}</dd>
    </>
  );
}
