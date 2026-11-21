// Meta strip (S3), CPU and Memory charts (S4), Temperatures (S5).

import { useMemo, useState } from 'react';
import { isProxmoxDetail } from '../../api/client';
import type { Metrics, Range, Sensor, ServerDetail } from '../../api/types';
import { ViewAsTableToggle } from '../../components/common';
import { Dot } from '../../components/controls';
import { type ChartExtras, type ChartSeries, chartProps, TimeChart } from '../../components/TimeChart';
import {
  countWord,
  DASH,
  formatDateOnly,
  formatDuration,
  formatGbInt,
  formatNum,
  formatPct,
  formatPct1,
  formatTemp,
  formatTemp1,
  formatTempDense,
  formatTooltipTime,
} from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { seriesStats } from '../../lib/metrics';
import { levelDot, sensorLevel } from '../../lib/thresholds';

// ------------------------------------------------------------------ meta strip

function kernelLine(os: ServerDetail['server']['os']): string {
  const k = os.kernel.trim();
  if (/^\d/.test(k)) return t('Kernel {version}', { version: k });
  // "pve kernel (Debian 13)" -> "Debian 13 · pve kernel"
  const m = /^(.*?)\s*\((.*)\)$/.exec(k);
  return m ? `${m[2]} · ${m[1]}` : k;
}

export function MetaStrip({ detail }: { detail: ServerDetail }) {
  const s = detail.server;
  const fields: { k: string; v: string; sub: string | null; mono?: boolean }[] = [
    { k: t('Operating system'), v: `${s.os.name} ${s.os.version}`.trim(), sub: kernelLine(s.os) },
    { k: t('Processor'), v: s.cpu.model, sub: t('{cores} cores · {threads} threads', { cores: s.cpu.cores, threads: s.cpu.threads }) },
    { k: t('Memory'), v: formatGbInt(s.memory.total_gb), sub: s.memory.type },
    { k: t('Uptime'), v: s.uptime_s == null ? DASH : formatDuration(s.uptime_s), sub: s.last_boot ? t('Last boot {date}', { date: formatDateOnly(s.last_boot) }) : null },
    { k: t('Address'), v: s.address ?? DASH, sub: s.location, mono: true },
    {
      k: t('Agent'),
      v: `v${s.agent.version}`,
      sub: s.agent.connected === false ? t('Not connected') : s.agent.last_sync_s_ago == null ? null : t('Synced {n} s ago', { n: s.agent.last_sync_s_ago }),
    },
  ];
  return (
    <section aria-label={t('System')} className="card meta-strip">
      {fields.map((f) => (
        <div className="field" key={f.k}>
          <div className="lbl">{f.k}</div>
          <div className={f.mono ? 'v mono' : 'v'}>{f.v}</div>
          {f.sub && <div className="lbl s">{f.sub}</div>}
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------------ CPU / memory

const PCT_LABELS = ['100%', '75%', '50%', '25%', '0%'];

interface UsageProps {
  detail: ServerDetail;
  metrics: Metrics | undefined;
  range: Range;
  hover: number | null;
  onHover: (i: number | null) => void;
  /** Markers, zoom and the zoomed tick range (host page). */
  chart?: ChartExtras;
}

function UsageCard(props: {
  title: string;
  /** Series name (the title without "usage"). */
  label: string;
  now: number | null;
  nowSub: string;
  color: string;
  seriesKey: string;
  tooltipSub: (v: number) => string;
  facts: { k: string; v: string }[];
  usage: UsageProps;
}) {
  const { metrics, range, hover, onHover } = props.usage;
  const [table, setTable] = useState(false);
  const values = metrics?.series[props.seriesKey];
  const series = useMemo<ChartSeries[]>(
    () => [{ key: props.seriesKey, label: props.label, short: props.label, color: props.color, values: values ?? [] }],
    [props.seriesKey, props.label, props.color, values],
  );
  const sum = seriesStats(metrics, props.seriesKey);
  return (
    <div className="card usage-card">
      <div className="usage-head">
        <div>
          <h2 className="h2">{props.title}</h2>
          <div className="usage-now">
            <span className="big">{formatPct(props.now)}</span>
            <span className="lbl">{props.nowSub}</span>
          </div>
        </div>
        <div className="usage-stats">
          <div>
            {t('Average')} <b>{formatPct(sum.avg)}</b>
          </div>
          <div style={{ marginTop: 2 }}>
            {t('Peak')} <b>{formatPct(sum.max)}</b>
            {sum.at && <span className="lbl"> {t('at {time}', { time: formatTooltipTime(range, Date.parse(sum.at)) })}</span>}
          </div>
        </div>
      </div>
      <div className="card-corner">
        <ViewAsTableToggle showTable={table} onToggle={() => setTable((v) => !v)} chart={props.title} />
      </div>
      <TimeChart
        title={props.title}
        range={range}
        timestamps={metrics?.timestamps ?? []}
        series={series}
        yMin={0}
        yMax={100}
        yLabels={PCT_LABELS}
        height={220}
        area
        hover={hover}
        onHover={onHover}
        formatValue={formatPct1}
        tooltipSub={props.tooltipSub}
        showTable={table}
      />
      <div className="facts-row">
        {props.facts.map((f) => (
          <div key={f.k}>
            <div className="lbl">{f.k}</div>
            <div className="v">{f.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const pct1 = (v: number | null | undefined) => (v == null ? DASH : `${v.toFixed(1)}%`);
const gb = (v: number | null | undefined) => (v == null ? DASH : `${formatNum(v)} GB`);

export function UsageCharts(props: UsageProps) {
  const { detail } = props;
  const l = detail.live;
  const s = detail.server;
  const total = s.memory.total_gb;
  const pve = isProxmoxDetail(detail);
  const cache = l.zfs_arc_gb ?? l.mem_cache_gb;
  return (
    <section id="usage" tabIndex={-1} className="usage-row" aria-label={t('CPU and memory')}>
      <UsageCard
        title={t('CPU usage')}
        label={t('CPU')}
        now={l.cpu_pct}
        nowSub={t('{cores} cores · {threads} threads', { cores: s.cpu.cores, threads: s.cpu.threads })}
        color="var(--series-cpu)"
        seriesKey="cpu_pct"
        tooltipSub={() => t('of {n} threads', { n: s.cpu.threads })}
        facts={[
          { k: t('User'), v: pct1(l.cpu_user_pct) },
          { k: t('System'), v: pct1(l.cpu_system_pct) },
          { k: t('I/O wait'), v: pct1(l.cpu_iowait_pct) },
          { k: t('Load 1 / 5 / 15 min'), v: l.load_avg?.length ? l.load_avg.map((x) => x.toFixed(1)).join(' · ') : DASH },
        ]}
        usage={props}
      />
      <UsageCard
        title={t('Memory usage')}
        label={t('Memory')}
        now={l.mem_pct}
        nowSub={t('{used} of {total}', { used: l.mem_used_gb == null ? DASH : formatNum(l.mem_used_gb), total: formatGbInt(total) })}
        color="var(--series-memory)"
        seriesKey="mem_pct"
        tooltipSub={(v) => t('{used} of {total}', { used: Math.round((v / 100) * total), total: formatGbInt(total) })}
        facts={[
          { k: t('Used'), v: gb(l.mem_used_gb) },
          { k: pve || l.zfs_arc_gb != null ? 'ZFS ARC' : 'Cache', v: gb(cache) },
          { k: t('Free'), v: gb(l.mem_free_gb) },
          { k: 'Swap', v: l.swap_used_gb == null ? DASH : `${formatNum(l.swap_used_gb)} / ${gb(l.swap_total_gb)}` },
        ]}
        usage={props}
      />
    </section>
  );
}

// ------------------------------------------------------------------ temperatures

/** Fixed identity colors per sensor group (DESIGN-SYSTEM 2.2), never cycled. */
const SENSOR_STYLE: Record<string, { color: string; short: string }> = {
  cpu_package: { color: 'var(--series-cpu)', short: 'CPU' },
  board_vrm: { color: 'var(--series-orange)', short: 'VRM' },
  nvme_hottest: { color: 'var(--series-aqua)', short: 'NVMe' },
  dimm: { color: 'var(--series-yellow)', short: 'DIMM' },
  hdd_hottest: { color: 'var(--series-magenta)', short: 'HDD' },
  ssd_hottest: { color: 'var(--series-magenta)', short: 'SSD' },
};
const SENSOR_ORDER = ['cpu_package', 'board_vrm', 'nvme_hottest', 'dimm', 'hdd_hottest', 'ssd_hottest'];
const sensorRank = (id: string): number => {
  const i = SENSOR_ORDER.indexOf(id);
  return i === -1 ? SENSOR_ORDER.length : i;
};
const SPARE = ['var(--series-cpu)', 'var(--series-orange)', 'var(--series-aqua)', 'var(--series-yellow)', 'var(--series-magenta)'];

export function sensorStyle(sensors: Sensor[]): Map<string, { color: string; short: string }> {
  const used = new Set<string>();
  const out = new Map<string, { color: string; short: string }>();
  for (const s of sensors) {
    const st = SENSOR_STYLE[s.id];
    if (st) {
      out.set(s.id, st);
      used.add(st.color);
    }
  }
  for (const s of sensors) {
    if (out.has(s.id)) continue;
    const color = SPARE.find((c) => !used.has(c)) ?? 'var(--ink-3)';
    used.add(color);
    out.set(s.id, { color, short: s.label.split(/[ ,/]/)[0] ?? s.id });
  }
  return out;
}

const TEMP_LABELS = ['100°', '80°', '60°', '40°', '20°'];

export function Temperatures({ detail, metrics, range, hover, onHover, chart }: UsageProps) {
  const [table, setTable] = useState(false);
  const sensors = useMemo(
    () => [...detail.sensors].sort((a, b) => sensorRank(a.id) - sensorRank(b.id)),
    [detail.sensors],
  );
  const styles = useMemo(() => sensorStyle(sensors), [sensors]);
  const series = useMemo<ChartSeries[]>(
    () =>
      sensors.map((s) => ({
        key: s.id,
        label: s.label,
        short: styles.get(s.id)?.short ?? s.id,
        color: styles.get(s.id)?.color ?? 'var(--ink-3)',
        values: metrics?.series[`temp_${s.id}_c`] ?? [],
      })),
    [sensors, styles, metrics],
  );
  if (!sensors.length) return null;
  const hottest = sensors.reduce<Sensor | null>((h, s) => (s.now_c != null && (h?.now_c == null || s.now_c > h.now_c) ? s : h), null);
  const cpu = sensors.find((s) => s.id === 'cpu_package') ?? hottest;
  const limit = cpu?.limit_c != null ? { value: cpu.limit_c, label: t('{n} °C warning', { n: cpu.limit_c }) } : null;
  // Other sensors' own limits, only for those close to them (70% and up): one line per relevant limit.
  const limits = sensors
    .filter((s) => s !== cpu && s.limit_c != null && s.limit_c !== cpu?.limit_c && s.limit_c <= 100 && s.now_c != null && s.now_c >= s.limit_c * 0.7)
    .map((s) => ({ value: s.limit_c!, label: `${styles.get(s.id)?.short ?? s.label} ${s.limit_c} °C`, color: styles.get(s.id)?.color ?? 'var(--ink-3)' }));

  return (
    <section id="temps" tabIndex={-1} className="card temps-card" aria-labelledby="temps-title">
      <div className="temps-head">
        <div>
          <h2 className="h2" id="temps-title">
            {t('Temperatures')}
          </h2>
          <div className="lbl" style={{ marginTop: 4 }}>
            {t('{sensors} · hottest component per group · lines mark the warning limits', { sensors: countWord(sensors.length, 'sensor') })}
          </div>
        </div>
        <div className="temps-head-right">
          {hottest && (
            <div>
              {tx('Highest right now {temp}', {
                temp: (
                  <span className="strong">
                    {formatTemp(hottest.now_c)} ({hottest.label})
                  </span>
                ),
              })}
            </div>
          )}
          <ViewAsTableToggle showTable={table} onToggle={() => setTable((v) => !v)} chart={t('temperatures')} />
        </div>
      </div>
      <div className="temps-body">
        <div className="temps-chart">
          <TimeChart
            title={t('Temperatures')}
            range={range}
            timestamps={metrics?.timestamps ?? []}
            series={series}
            yMin={20}
            yMax={100}
            yLabels={TEMP_LABELS}
            height={300}
            limit={limit}
            limits={limits}
            endLabels
            hover={hover}
            onHover={onHover}
            formatValue={formatTemp1}
            tooltipPlacement="bottom"
            showTable={table}
            {...chartProps(chart)}
          />
        </div>
        <div className="sensor-table" role="table" aria-label={t('Sensors')}>
          <div className="sensor-row thead" role="row">
            <span className="c-key" role="presentation" />
            <span className="lbl c-name" role="columnheader">
              {t('Sensor')}
            </span>
            <span className="lbl num c-now" role="columnheader">
              {t('Now')}
            </span>
            <span className="lbl num c-max" role="columnheader">
              {t('Max')}
            </span>
            <span className="lbl num c-limit" role="columnheader">
              {t('Limit')}
            </span>
          </div>
          {sensors.map((s) => {
            const level = sensorLevel(s.now_c, s.limit_c);
            return (
              <div className="sensor-row" role="row" key={s.id}>
                <span className="key c-key" style={{ background: styles.get(s.id)?.color }} aria-hidden="true" />
                <div className="c-name" role="rowheader" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{s.label}</div>
                  <div className="lbl mono">{s.source}</div>
                </div>
                <span className="now c-now" role="cell">
                  <Dot color={levelDot(level)} />
                  {formatTempDense(s.now_c)}
                  {level && level !== 'good' && <span className="sr-only"> ({level === 'serious' ? t('at or above the limit') : t('near the limit')})</span>}
                </span>
                <span className="num ink-2 c-max" role="cell">
                  {formatTempDense(s.max_24h_c)}
                </span>
                <span className="num ink-2 c-limit" role="cell">
                  {formatTempDense(s.limit_c)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
