// Summary tab of a host (UI v2): compact charts (CPU, memory, network,
// temperatures) with their facts, the busiest guests, and a column with
// Watch (this host's alerts and hints), System, Storage, Virtualization
// and, on Proxmox nodes, Cluster and Backups. Everything deeper is one tab
// away.

import { memo, useMemo } from 'react';
import { Link } from 'react-router';
import { isProxmoxDetail } from '../../api/client';
import type { Alert, Disk, Guest, Hint, Metrics, ProxmoxDetail, Range, ServerDetail } from '../../api/types';
import { Chip, Dot, Meter } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { type ChartExtras, type ChartSeries, chartProps, TimeChart } from '../../components/TimeChart';
import { useNow } from '../../lib/clock';
import { DASH, formatGb, formatIn, formatMemPair, formatNetRate, formatNum, formatPct, formatPct1, formatRelativeDay, formatTemp, formatTemp1, formatTooltipTime, plural } from '../../lib/format';
import { t, tn } from '../../lib/i18n';
import { seriesStats } from '../../lib/metrics';
import { diskUsedLevel, levelBar, levelDot, memoryAssignedLevel, overcommitLevel, sensorLevel, VCPU_TICK_PCT, vcpuMeterWidth, wearLevel } from '../../lib/thresholds';
import { consolePath, hostPath } from '../../lib/urlState';
import { AlertItem, HintRow } from '../fleet/WatchPanel';
import { SystemCard } from './Health';
import { sensorStyle } from './Overview';
import { platformTabs, sortByCpu } from './platforms';

/** Y ceiling of a compact percent chart: a round number just above the peak (never below 10, never above 100). */
export function niceCeiling(peak: number | null): number {
  const p = Math.max(10, (peak ?? 0) * 1.25);
  for (const c of [10, 20, 25, 50, 75, 100]) if (p <= c) return c;
  return 100;
}

/** Y ceiling of a rate chart: 1, 2 or 5 times a power of ten just above the peak. */
export function niceRate(peak: number | null): number {
  const p = Math.max(1, (peak ?? 0) * 1.15);
  const e = 10 ** Math.floor(Math.log10(p));
  for (const m of [1, 2, 5, 10]) if (p <= m * e) return m * e;
  return 10 * e;
}

function rateLabels(max: number): string[] {
  return [1, 0.75, 0.5, 0.25, 0].map((f) => formatNetRate(max * f).replace(' ', '\u00a0'));
}

function pctLabels(max: number): string[] {
  return [1, 0.75, 0.5, 0.25, 0].map((f) => `${Math.round(max * f)}%`);
}

interface ChartCardProps {
  title: string;
  now: string;
  nowSub: string;
  stats: { avg: string; peak: string; peakAt: string | null };
  series: ChartSeries[];
  timestamps: string[];
  range: Range;
  yMin: number;
  yMax: number;
  yLabels: string[];
  limit?: { value: number; label: string } | null;
  formatValue: (v: number) => string;
  tooltipSub?: (v: number) => string | null;
  facts: { k: string; v: string; warn?: boolean }[];
  hover: number | null;
  onHover: (i: number | null) => void;
  chart?: ChartExtras;
}

function ChartCard(p: ChartCardProps) {
  return (
    <div className="card sum-chart">
      <div className="sum-chart-head">
        <div>
          <div className="nm">{p.title}</div>
          <div className="now">
            {p.now}
            <small>{p.nowSub}</small>
          </div>
        </div>
        <div className="stats">
          <span>
            {t('Avg')} <b>{p.stats.avg}</b>
          </span>
          <span>
            {t('Peak')} <b>{p.stats.peak}</b>
            {p.stats.peakAt ? ` ${p.stats.peakAt}` : ''}
          </span>
        </div>
      </div>
      <TimeChart
        title={p.title}
        range={p.range}
        timestamps={p.timestamps}
        series={p.series}
        yMin={p.yMin}
        yMax={p.yMax}
        yLabels={p.yLabels}
        height={110}
        area={p.series.length === 1}
        limit={p.limit ?? null}
        hover={p.hover}
        onHover={p.onHover}
        formatValue={p.formatValue}
        tooltipSub={p.tooltipSub}
        tooltip="hover"
        {...chartProps(p.chart)}
      />
      <div className="facts-row">
        {p.facts.map((f) => (
          <div key={f.k}>
            <div className="lbl">{f.k}</div>
            <div className={f.warn ? 'v is-warning' : 'v'}>{f.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const pct1 = (v: number | null | undefined) => (v == null ? DASH : `${v.toFixed(1)}%`);
const gb = (v: number | null | undefined) => (v == null ? DASH : `${formatNum(v)} GB`);

interface Props {
  detail: ServerDetail;
  metrics: Metrics | undefined;
  range: Range;
  hover: number | null;
  onHover: (i: number | null) => void;
  alerts: Alert[];
  hints: Hint[];
  chart?: ChartExtras;
}

function allGuests(d: ServerDetail): Guest[] {
  if (isProxmoxDetail(d)) return [...(d.guests.vm?.guests ?? []), ...(d.guests.container?.guests ?? [])];
  const w = d.workloads;
  return [...(w?.docker?.guests ?? []), ...(w?.incus?.guests ?? []), ...(w?.libvirt?.guests ?? [])];
}

function guestKindText(g: Guest): string {
  switch (g.platform) {
    case 'docker':
      return 'Docker';
    case 'incus':
      return g.kind === 'vm' ? 'Incus VM' : 'Incus CT';
    case 'libvirt':
      return 'libvirt VM';
    default:
      return g.kind === 'vm' ? `VM ${g.vmid ?? ''}`.trim() : `LXC ${g.vmid ?? ''}`.trim();
  }
}

// Memoized: the charts' hover state re-renders the tab on every mouse move.
const GuestsCard = memo(function GuestsCard({ detail, range }: { detail: ServerDetail; range: Range }) {
  const tabs = platformTabs(detail);
  const total = tabs.reduce((a, tab) => a + tab.workload.total, 0);
  const running = tabs.reduce((a, tab) => a + tab.workload.running, 0);
  const guests = useMemo(() => sortByCpu(allGuests(detail)).filter((g) => g.state !== 'stopped').slice(0, 8), [detail]);
  const rc = detail.server.remote_control;
  const consoleOk = rc?.console ?? true;
  const id = detail.server.id;
  if (!tabs.length) return null;
  const caption = tabs.map((tab) => `${tab.name} ${tab.workload.running} / ${tab.workload.total}`).join(' · ');
  return (
    <section className="card sum-guests" aria-labelledby="sum-guests-title">
      <div className="card-head">
        <h2 className="h2" id="sum-guests-title">
          {t('Guests')}
        </h2>
        <span className="sub">
          {caption} · <Link className="link" to={hostPath(id, { tab: 'guests', range })}>{t('All {n} →', { n: total })}</Link>
        </span>
      </div>
      {guests.length === 0 ? (
        <div className="guests-empty">{total ? t('None of the {guests} is running.', { guests: plural(total, 'guest') }) : t('No guests on this host.')}</div>
      ) : (
        <div className="grows">
          {guests.map((g) => {
            const con = g.console.available !== false && (g.console.protocols?.length ?? 0) > 0;
            return (
              <div className="grow" key={g.id}>
                <Dot color={g.state === 'unhealthy' ? 'var(--serious)' : 'var(--good)'} />
                <span className="n" title={`${guestKindText(g)}${g.image ? ` · ${g.image}` : ''}`}>
                  {g.name}
                </span>
                <span className="cpu-cell">
                  <Meter pct={Math.min(100, g.cpu_pct ?? 0)} color="var(--series-cpu)" />
                  <span className="val">{formatPct1(g.cpu_pct)}</span>
                </span>
                <span className="mem">{formatMemPair(g.memory_used_mb, g.memory_limit_mb)}</span>
                <span className="act">
                  {con ? (
                    <Link
                      to={consolePath(id, g.id, { range })}
                      className="btn-ghost row-action"
                      aria-label={g.kind === 'vm' ? t('Open console for {name}', { name: g.name }) : t('Open shell for {name}', { name: g.name })}
                      aria-disabled={consoleOk ? undefined : true}
                      title={consoleOk ? undefined : (rc?.console_reason ?? t('Remote control is turned off for this server'))}
                      onClick={(e) => !consoleOk && e.preventDefault()}
                    >
                      <Icon name={g.kind === 'vm' ? 'monitor' : 'terminal'} size={14} />
                      {g.kind === 'vm' ? t('Console') : t('Shell')}
                    </Link>
                  ) : (
                    <span className="lbl">{t('no console')}</span>
                  )}
                </span>
              </div>
            );
          })}
          {running > guests.length && <div className="lbl guests-foot">{t('{n} more running · sorted by CPU', { n: running - guests.length })}</div>}
        </div>
      )}
    </section>
  );
});

// Memoized: the charts' hover state re-renders the tab on every mouse move.
const StorageMini = memo(function StorageMini({ detail, range }: { detail: ServerDetail; range: Range }) {
  const id = detail.server.id;
  if (isProxmoxDetail(detail)) {
    const stores = detail.storages.slice(0, 6);
    return (
      <section className="card" aria-labelledby="sum-storage-title">
        <div className="card-head">
          <h2 className="h2" id="sum-storage-title">
            {t('Storage')}
          </h2>
          <span className="sub">
            {plural(detail.storages.length, 'storage')} · {plural(detail.disks.length, 'disk')} · <Link className="link" to={hostPath(id, { tab: 'storage', range })}>{t('Details →')}</Link>
          </span>
        </div>
        {stores.map((s) => {
          const pct = s.capacity_gb ? Math.round((s.used_gb / s.capacity_gb) * 100) : 0;
          return (
            <div className="mini-row" key={s.id}>
              <span className="n">
                {s.id}
                <small>{s.type}</small>
              </span>
              <span className="d">{t('{used} of {total}', { used: formatGb(s.used_gb), total: formatGb(s.capacity_gb) })}</span>
              <Meter pct={pct} color={levelBar(diskUsedLevel(pct))} />
            </div>
          );
        })}
      </section>
    );
  }
  const disks: Disk[] = detail.disks;
  const used = disks.reduce((a, d) => a + d.used_gb, 0);
  const cap = disks.reduce((a, d) => a + d.capacity_gb, 0);
  const worst = disks.reduce<number | null>((m, d) => (d.wear_pct != null && (m == null || d.wear_pct > m) ? d.wear_pct : m), null);
  return (
    <section className="card" aria-labelledby="sum-storage-title">
      <div className="card-head">
        <h2 className="h2" id="sum-storage-title">
          {t('Storage')}
        </h2>
        <span className="sub">
          {plural(disks.length, 'disk')} · {t('{used} of {total}', { used: formatGb(used), total: formatGb(cap) })}
          {worst != null ? ` · ${t('wear ≤ {pct}%', { pct: Math.round(worst) })}` : ''} · <Link className="link" to={hostPath(id, { tab: 'storage', range })}>{t('Details →')}</Link>
        </span>
      </div>
      {disks.slice(0, 6).map((d) => {
        const pct = d.capacity_gb ? Math.round((d.used_gb / d.capacity_gb) * 100) : 0;
        return (
          <div className="mini-row" key={d.device}>
            <span className="n">
              {d.device}
              <small>
                {d.type.toUpperCase()}
                {d.wear_pct != null ? ` · ${t('wear {pct}%', { pct: Math.round(d.wear_pct) })}` : ''}
                {d.role ? ` · ${d.role}` : ''}
              </small>
            </span>
            <span className="d">{t('{used} of {total}', { used: formatGb(d.used_gb), total: formatGb(d.capacity_gb) })}</span>
            <Meter pct={pct} color={levelBar(diskUsedLevel(pct) ?? wearLevel(d.wear_pct))} />
          </div>
        );
      })}
      {disks.length > 6 && <div className="lbl guests-foot">{tn(disks.length - 6, '{n} more disk', '{n} more disks')}</div>}
    </section>
  );
});

// Memoized: the charts' hover state re-renders the tab on every mouse move.
const VirtMini = memo(function VirtMini({ detail, range }: { detail: ServerDetail; range: Range }) {
  const v = detail.virtualization;
  if (!v) return null;
  const a = v.allocation;
  const c = v.capabilities;
  const ratio = a.host_threads ? a.vcpu_allocated / a.host_threads : a.vcpu_overcommit_ratio;
  const memPct = a.host_memory_gb ? (a.guest_memory_assigned_gb / a.host_memory_gb) * 100 : 0;
  return (
    <section className="card" aria-labelledby="sum-virt-title">
      <div className="card-head">
        <h2 className="h2" id="sum-virt-title">
          {t('Virtualization')}
        </h2>
        <span className="sub">
          {[c.cpu_virtualization.type, c.iommu.enabled && c.iommu.groups != null ? t('IOMMU {n} groups', { n: c.iommu.groups }) : null, c.nested.enabled ? t('nested on') : null].filter(Boolean).join(' · ')} ·{' '}
          <Link className="link" to={hostPath(detail.server.id, { tab: 'virtualization', range })}>
            {t('Details →')}
          </Link>
        </span>
      </div>
      <div className="mini-alloc">
        <div>
          <div className="v">
            <b>
              {a.vcpu_allocated} / {a.host_threads} <span>vCPU · {ratio.toFixed(2)} : 1</span>
            </b>
          </div>
          <Meter pct={vcpuMeterWidth(ratio)} color={levelBar(overcommitLevel(ratio))} tick={VCPU_TICK_PCT} />
        </div>
        <div>
          <div className="v">
            <b>
              {Math.round(a.guest_memory_assigned_gb)} / {Math.round(a.host_memory_gb)} GB <span>· {Math.round(memPct)}%</span>
            </b>
          </div>
          <Meter pct={memPct} color={levelBar(memoryAssignedLevel(memPct), 'var(--series-memory)')} />
        </div>
      </div>
    </section>
  );
});

// Memoized: the charts' hover state re-renders the tab on every mouse move.
const ProxmoxMini = memo(function ProxmoxMini({ detail, range }: { detail: ProxmoxDetail; range: Range }) {
  const now = useNow(60_000);
  const c = detail.cluster;
  const b = detail.backups;
  const j = b?.last_job;
  const next = b?.next_run ? Date.parse(b.next_run) : null;
  const online = c ? c.nodes.filter((n) => n.status === 'online').length : 0;
  return (
    <section className="card" aria-labelledby="sum-pve-title">
      <div className="card-head">
        <h2 className="h2" id="sum-pve-title">
          Proxmox VE
        </h2>
        <span className="sub">
          <Link className="link" to={hostPath(detail.server.id, { tab: 'virtualization', range })}>
            {t('Cluster →')}
          </Link>{' '}
          ·{' '}
          <Link className="link" to={hostPath(detail.server.id, { tab: 'storage', range })}>
            {t('Backups →')}
          </Link>
        </span>
      </div>
      <div className="mini-row">
        <span className="n">
          {c ? c.name : t('Standalone node')}
          <small>{c ? t('{online} of {total} nodes online', { online, total: c.nodes.length }) : t('no cluster')}</small>
        </span>
        <span className="d">{c ? <Chip className="chip-sm" dot={c.quorate ? 'var(--good)' : 'var(--critical)'}>{c.quorate ? t('Quorate') : t('Not quorate')}</Chip> : null}</span>
      </div>
      <div className="mini-row">
        <span className="n">
          {t('Backups')}
          <small>{j ? t('{ok} of {total} guests OK · {time}', { ok: j.guests_ok, total: j.guests_total, time: formatRelativeDay(Date.parse(j.at), now) }) : t('no job yet')}</small>
        </span>
        <span className="d">
          {j && <Chip className="chip-sm" dot={j.result === 'ok' ? (j.warnings ? 'var(--warning)' : 'var(--good)') : 'var(--critical)'}>{j.result === 'ok' ? (j.warnings ? t('Warnings') : 'OK') : t('Failed')}</Chip>}
          {next ? ` · ${formatIn((next - now) / 1000).toLowerCase()}` : ''}
        </span>
      </div>
    </section>
  );
});

// The host's alerts and hints (memoized like the cards: hover re-renders the tab).
const WatchCard = memo(function WatchCard({ alerts, hints, range }: { alerts: Alert[]; hints: Hint[]; range: Range }) {
  return (
    <section className="card watch-card" aria-labelledby="sum-watch-title">
      <div className="card-head">
        <h2 className="h2" id="sum-watch-title">
          {t('Watch')}
        </h2>
        <span className="sub">{alerts.length || hints.length ? `${plural(alerts.length, 'alert')} · ${plural(hints.length, 'hint')}` : t('Nothing near a limit')}</span>
      </div>
      <ul className="plain-list" aria-label={t('Alerts and hints for this host')}>
        {alerts.length === 0 && hints.length === 0 && (
          <li className="watch-item">
            <span className="sev is-good">
              <Dot color="var(--good)" />
            </span>
            <div>
              <div className="ti">{t('All clear')}</div>
              <div className="de">{t('Every sensor, disk and allocation is within its thresholds.')}</div>
            </div>
            <span />
          </li>
        )}
        {alerts.map((a) => (
          <AlertItem key={a.id} a={a} range={range} />
        ))}
        {hints.map((h) => (
          <HintRow key={`${h.kind}/${h.entity}`} h={h} range={range} />
        ))}
      </ul>
    </section>
  );
});

export function SummaryTab({ detail, metrics, range, hover, onHover, alerts, hints, chart }: Props) {
  const l = detail.live;
  const s = detail.server;
  const pve = isProxmoxDetail(detail);
  const ts = metrics?.timestamps ?? [];
  const cpuStats = seriesStats(metrics, 'cpu_pct');
  const memStats = seriesStats(metrics, 'mem_pct');
  const cpuMax = niceCeiling(cpuStats.max ?? l.cpu_pct);
  const sensors = useMemo(() => [...detail.sensors].sort((a, b) => (b.now_c ?? -1) - (a.now_c ?? -1)), [detail.sensors]);
  const styles = useMemo(() => sensorStyle(detail.sensors), [detail.sensors]);
  const tempSeries = useMemo<ChartSeries[]>(
    () =>
      detail.sensors.map((x) => ({
        key: x.id,
        label: x.label,
        short: styles.get(x.id)?.short ?? x.id,
        color: styles.get(x.id)?.color ?? 'var(--ink-3)',
        values: metrics?.series[`temp_${x.id}_c`] ?? [],
      })),
    [detail.sensors, styles, metrics],
  );
  const cpuSensor = detail.sensors.find((x) => x.id === 'cpu_package') ?? sensors[0];
  const hottest = sensors[0];
  const tStats = cpuSensor ? seriesStats(metrics, `temp_${cpuSensor.id}_c`) : { avg: null, max: null, at: null };
  const swapPct = l.swap_total_gb && l.swap_used_gb != null ? (l.swap_used_gb / l.swap_total_gb) * 100 : 0;
  const peakAt = (at: string | null) => (at ? formatTooltipTime(range, Date.parse(at)) : null);
  const cache = l.zfs_arc_gb ?? l.mem_cache_gb;
  // Network: host interfaces (agents that report them).
  const nets = detail.network ?? [];
  const rxStats = seriesStats(metrics, 'net_rx_mbps');
  const txStats = seriesStats(metrics, 'net_tx_mbps');
  const showNet = nets.length > 0 || rxStats.max != null;
  const rxNow = nets.filter((n) => !n.master).reduce((a, n) => a + n.rx_mbps, 0);
  const txNow = nets.filter((n) => !n.master).reduce((a, n) => a + n.tx_mbps, 0);
  const netTotal = useMemo(() => {
    const rx = metrics?.series.net_rx_mbps ?? [];
    const tx = metrics?.series.net_tx_mbps ?? [];
    let sum = 0, n = 0, peak: number | null = null, peakAt = -1;
    rx.forEach((v, i) => {
      if (v == null) return;
      const t = v + (tx[i] ?? 0);
      sum += t;
      n++;
      if (peak == null || t > peak) [peak, peakAt] = [t, i];
    });
    return { avg: n ? sum / n : null, peak, at: peakAt >= 0 ? (metrics?.timestamps[peakAt] ?? null) : null };
  }, [metrics]);
  const netMax = niceRate(Math.max(rxStats.max ?? 0, txStats.max ?? 0, rxNow, txNow));
  const uplink = nets.find((n) => n.addresses.length > 0 && n.carrier) ?? nets.find((n) => n.carrier);
  const netErrors = nets.reduce((a, n) => a + n.errors, 0);
  const netDrops = nets.reduce((a, n) => a + n.drops, 0);
  const charts = 2 + (sensors.length > 0 ? 1 : 0) + (showNet ? 1 : 0);

  return (
    <>
      <div className={charts === 4 ? 'sum-charts n4' : 'sum-charts'}>
        <ChartCard
          title={t('CPU')}
          now={formatPct(l.cpu_pct)}
          nowSub={t('of {n} threads', { n: s.cpu.threads })}
          stats={{ avg: formatPct1(cpuStats.avg), peak: formatPct1(cpuStats.max), peakAt: peakAt(cpuStats.at) }}
          series={[{ key: 'cpu_pct', label: 'CPU', short: 'CPU', color: 'var(--series-cpu)', values: metrics?.series.cpu_pct ?? [] }]}
          timestamps={ts}
          range={range}
          yMin={0}
          yMax={cpuMax}
          yLabels={pctLabels(cpuMax)}
          formatValue={formatPct1}
          tooltipSub={() => t('of {n} threads', { n: s.cpu.threads })}
          facts={[
            { k: t('User'), v: pct1(l.cpu_user_pct) },
            { k: t('System'), v: pct1(l.cpu_system_pct) },
            { k: t('I/O wait'), v: pct1(l.cpu_iowait_pct) },
            { k: t('Load 1 / 5 / 15'), v: l.load_avg?.length ? l.load_avg.map((x) => x.toFixed(1)).join(' · ') : DASH },
          ]}
          hover={hover}
          onHover={onHover}
          chart={chart}
        />
        <ChartCard
          title={t('Memory')}
          now={formatPct(l.mem_pct)}
          nowSub={t('{used} of {total} GB', { used: l.mem_used_gb == null ? DASH : formatNum(l.mem_used_gb), total: Math.round(s.memory.total_gb) })}
          stats={{ avg: formatPct(memStats.avg), peak: formatPct(memStats.max), peakAt: peakAt(memStats.at) }}
          series={[{ key: 'mem_pct', label: t('Memory'), short: t('Memory'), color: 'var(--series-memory)', values: metrics?.series.mem_pct ?? [] }]}
          timestamps={ts}
          range={range}
          yMin={0}
          yMax={100}
          yLabels={pctLabels(100)}
          formatValue={formatPct1}
          tooltipSub={(v) => t('{used} of {total} GB', { used: Math.round((v / 100) * s.memory.total_gb), total: Math.round(s.memory.total_gb) })}
          facts={[
            { k: t('Used'), v: gb(l.mem_used_gb) },
            { k: pve || l.zfs_arc_gb != null ? 'ZFS ARC' : 'Cache', v: gb(cache) },
            { k: t('Free'), v: gb(l.mem_free_gb) },
            { k: 'Swap', v: l.swap_used_gb == null ? DASH : `${formatNum(l.swap_used_gb)} / ${gb(l.swap_total_gb)}`, warn: swapPct >= 80 },
          ]}
          hover={hover}
          onHover={onHover}
          chart={chart}
        />
        {showNet && (
          <ChartCard
            title={t('Network')}
            now={formatNetRate(rxNow + txNow)}
            nowSub={uplink ? `${uplink.name}${uplink.speed_mbps ? ` · ${t('{speed} link', { speed: formatNetRate(uplink.speed_mbps) })}` : ''}` : t('all interfaces')}
            stats={{ avg: formatNetRate(netTotal.avg), peak: formatNetRate(netTotal.peak), peakAt: peakAt(netTotal.at) }}
            series={[
              { key: 'net_rx_mbps', label: t('In'), short: t('In'), color: 'var(--series-yellow)', values: metrics?.series.net_rx_mbps ?? [] },
              { key: 'net_tx_mbps', label: t('Out'), short: t('Out'), color: 'var(--series-aqua)', values: metrics?.series.net_tx_mbps ?? [] },
            ]}
            timestamps={ts}
            range={range}
            yMin={0}
            yMax={netMax}
            yLabels={rateLabels(netMax)}
            formatValue={formatNetRate}
            facts={[
              { k: t('In'), v: formatNetRate(rxNow) },
              { k: t('Out'), v: formatNetRate(txNow) },
              { k: t('Interfaces'), v: t('{n} up', { n: nets.filter((n) => n.carrier && !n.master).length }) },
              { k: t('Errors · drops'), v: `${formatNum(netErrors)} · ${formatNum(netDrops)}`, warn: netErrors > 0 },
            ]}
            hover={hover}
            onHover={onHover}
            chart={chart}
          />
        )}
        {sensors.length > 0 && (
          <ChartCard
            title={t('Temperatures')}
            now={formatTemp(hottest?.now_c)}
            nowSub={hottest ? `${hottest.label}${hottest.limit_c != null ? ` · ${t('limit {n} °C', { n: Math.round(hottest.limit_c) })}` : ''}` : ''}
            stats={{ avg: formatTemp(tStats.avg), peak: formatTemp(tStats.max), peakAt: peakAt(tStats.at) }}
            series={tempSeries}
            timestamps={ts}
            range={range}
            yMin={20}
            yMax={100}
            yLabels={['100°', '80°', '60°', '40°', '20°']}
            limit={cpuSensor?.limit_c != null ? { value: cpuSensor.limit_c, label: t('{n} °C limit', { n: Math.round(cpuSensor.limit_c) }) } : null}
            formatValue={formatTemp1}
            facts={sensors.slice(0, 4).map((x) => ({
              k: x.label,
              v: `${formatTemp(x.now_c)}${x.limit_c != null ? ` / ${Math.round(x.limit_c)}` : ''}`,
              warn: sensorLevel(x.now_c, x.limit_c) !== 'good' && sensorLevel(x.now_c, x.limit_c) !== null,
            }))}
            hover={hover}
            onHover={onHover}
            chart={chart}
          />
        )}
      </div>

      <div className="sum-grid">
        <GuestsCard detail={detail} range={range} />
        <div className="sum-col">
          <WatchCard alerts={alerts} hints={hints} range={range} />
          <SystemCard detail={detail} />
          {pve && <ProxmoxMini detail={detail} range={range} />}
          <StorageMini detail={detail} range={range} />
          <VirtMini detail={detail} range={range} />
        </div>
      </div>
      {hottest && hottest.now_c != null && <span className="sr-only">{t('Hottest sensor: {name} at {temp}; level {level}', { name: hottest.label, temp: formatTemp(hottest.now_c), level: levelDot(sensorLevel(hottest.now_c, hottest.limit_c)) === 'var(--good)' ? t('good') : t('near the limit') })}</span>}
    </>
  );
}
