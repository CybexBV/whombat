// Hosts table of the overview (UI v2): one row per host with its status rail,
// 24 h CPU sparkline, memory, hottest sensor against its limit, storage and
// running guests. The whole row opens the host. Offline hosts show dashes and
// when the agent was last seen. Sorted by status (offline, warning, online),
// then name, so rows keep their place as values change.

import { useState } from 'react';
import { Link } from 'react-router';
import type { FleetServer, Range, SeriesPair } from '../../api/types';
import { Dot } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { Meter } from '../../components/controls';
import { Sparkline } from '../../components/Sparkline';
import { useNow } from '../../lib/clock';
import { DASH, formatClock, formatDuration, formatFull, formatGb, formatNetRate, formatPct, formatTemp } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { diskUsedLevel, levelBar, levelDot, sensorLevel, STATUS_DOT, STATUS_LABEL } from '../../lib/thresholds';
import { hostPath } from '../../lib/urlState';
import type { HostTally } from './guestStats';

/** Offline, or stale for 60 s or more relative to the snapshot (treated as offline, SCREENS 2.8). */
export function isEffectivelyOffline(s: FleetServer, asOf: string): boolean {
  if (s.status === 'offline' || s.current === null || !s.last_seen) return true;
  return Date.parse(asOf) - Date.parse(s.last_seen) >= 60_000;
}

const RANK: Record<FleetServer['status'], number> = { offline: 0, warning: 1, online: 2 };

export function sortHosts(servers: FleetServer[], asOf: string): FleetServer[] {
  const rank = (s: FleetServer) => (isEffectivelyOffline(s, asOf) ? 0 : RANK[s.status]);
  return [...servers].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

function GuestCounts({ s, tally }: { s: FleetServer; tally: HostTally | undefined }) {
  const items: { icon: 'box' | 'layers' | 'screen'; label: string; running: number; total: number }[] = [];
  if (tally) {
    if (tally.docker.total) items.push({ icon: 'box', label: 'Docker', running: tally.docker.running, total: tally.docker.total });
    if (tally.incus.total) items.push({ icon: 'layers', label: 'Incus', running: tally.incus.running, total: tally.incus.total });
    if (tally.pveVms.total) items.push({ icon: 'screen', label: t('VMs'), running: tally.pveVms.running, total: tally.pveVms.total });
    if (tally.pveCts.total) items.push({ icon: 'box', label: 'LXC', running: tally.pveCts.running, total: tally.pveCts.total });
    if (tally.libvirt.total) items.push({ icon: 'screen', label: 'libvirt', running: tally.libvirt.running, total: tally.libvirt.total });
  } else {
    // Before the guest list arrives: the fleet body's counts (no LXC).
    const w = s.workloads;
    const docker = w.docker.running + w.docker.stopped + w.docker.unhealthy;
    const incus = w.incus.containers_running + w.incus.vms_running + w.incus.stopped;
    const qemu = w.qemu.running + w.qemu.stopped;
    if (docker) items.push({ icon: 'box', label: 'Docker', running: w.docker.running + w.docker.unhealthy, total: docker });
    if (incus) items.push({ icon: 'layers', label: 'Incus', running: w.incus.containers_running + w.incus.vms_running, total: incus });
    if (qemu) items.push({ icon: 'screen', label: t('VMs'), running: w.qemu.running, total: qemu });
  }
  if (!items.length) return <span className="ink-3">{s.hypervisor?.kvm_enabled ? t('none · KVM ready') : t('none')}</span>;
  return (
    <>
      {items.map((it) => (
        <span key={it.label} className="gcount" title={t('{label}: {running} running of {total}', { label: it.label, running: it.running, total: it.total })}>
          <Icon name={it.icon} size={14} />
          <b>{it.running}</b>
          <span className="of">/{it.total}</span>
          <span className="sr-only">{t('{label} running of {total}', { label: it.label, total: it.total })}</span>
        </span>
      ))}
    </>
  );
}

/** The metric of the sparkline column: compares the hosts on one measure. */
export type BoardMetric = 'cpu' | 'memory' | 'network' | 'temperature';
const METRIC_LABEL: Record<BoardMetric, string> = { cpu: t('CPU'), memory: t('Memory'), network: t('Network'), temperature: t('Temperature') };
const METRIC_KEY = 'rackoon-board-metric';

function lastValue(v: (number | null)[] | undefined): number | null {
  if (!v) return null;
  for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i]!;
  return null;
}

/** Sparkline values, color and the current value text of a host for a metric. */
export function metricCell(m: BoardMetric, cur: FleetServer['current'], series: SeriesPair | undefined): { values: (number | null)[] | undefined; color: string; text: string } {
  switch (m) {
    case 'memory':
      return { values: series?.mem_pct, color: 'var(--series-memory)', text: cur ? formatPct(cur.mem_pct) : DASH };
    case 'network': {
      const v = cur ? lastValue(series?.net_mbps) : null;
      return { values: series?.net_mbps, color: 'var(--series-yellow)', text: v == null ? DASH : formatNetRate(v) };
    }
    case 'temperature':
      return { values: series?.temp_max_c, color: 'var(--series-orange)', text: cur && cur.temp_max_c != null ? formatTemp(cur.temp_max_c) : DASH };
    default:
      return { values: series?.cpu_pct, color: 'var(--series-cpu)', text: cur ? formatPct(cur.cpu_pct) : DASH };
  }
}

function initialMetric(): BoardMetric {
  try {
    const v = localStorage.getItem(METRIC_KEY);
    return v === 'memory' || v === 'network' || v === 'temperature' ? v : 'cpu';
  } catch {
    return 'cpu';
  }
}

interface RowProps {
  metric: BoardMetric;
  s: FleetServer;
  series: SeriesPair | undefined;
  range: Range;
  asOf: string;
  tally: HostTally | undefined;
  consoleOn: boolean;
}

function HostRow({ metric, s, series, range, asOf, tally, consoleOn }: RowProps) {
  const now = useNow();
  const offline = isEffectivelyOffline(s, asOf);
  const status = offline ? 'offline' : s.status;
  const cur = offline ? null : s.current;
  const cell = metricCell(metric, cur, series);
  const memUsed = cur?.mem_pct != null && s.memory_total_gb != null ? (s.memory_total_gb * cur.mem_pct) / 100 : null;
  const storeUsed = cur?.disk_used_pct != null && s.storage_capacity_tb != null ? (s.storage_capacity_tb * 1000 * cur.disk_used_pct) / 100 : null;
  const tempLevel = cur ? sensorLevel(cur.temp_max_c, cur.temp_limit_c) : null;
  const lastSeen = s.last_seen ? Date.parse(s.last_seen) : null;
  const statusText = `${STATUS_LABEL[status]}${s.status_note && !offline ? ` · ${s.status_note}` : ''}`;
  return (
    <tr className={`row${offline ? ' is-offline' : ''}`}>
      <td className="first">
        <div className="host-id">
          <span className="rail-bar" style={{ background: STATUS_DOT[status] }} aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <div className="host-name">
              <Link to={hostPath(s.id, { range })} className="row-link" aria-label={`${s.id}, ${statusText}`}>
                {s.id}
              </Link>
              {consoleOn && <Icon name="terminal" size={13} label={t('Console and power actions on')} />}
            </div>
            <div className="host-sub">
              {offline ? statusText : [s.os, s.cpu ? `${s.cpu.model} · ${s.cpu.cores}C/${s.cpu.threads}T` : null].filter(Boolean).join(' · ') || t('No report yet')}
            </div>
            {/* Phones: the other columns are hidden; this line carries their values. */}
            {!offline && cur && (
              <div className="host-mini" aria-hidden="true">
                <span>
                  {t('Mem')} <b>{formatPct(cur.mem_pct)}</b>
                </span>
                {cur.temp_max_c != null && (
                  <span>
                    <Dot color={levelDot(tempLevel)} /> <b>{formatTemp(cur.temp_max_c)}</b>
                  </span>
                )}
                <span>
                  {t('Disk')} <b>{formatPct(cur.disk_used_pct)}</b>
                </span>
                {tally && tally.all.total > 0 && (
                  <span>{tx('{running}/{total} guests', { running: <b>{tally.all.running + tally.all.unhealthy}</b>, total: tally.all.total })}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </td>
      <td>
        <div className="sparkcell">
          <Sparkline values={cell.values} color={cell.color} height={26} />
          <b className="num">{cell.text}</b>
        </div>
      </td>
      <td>
        <div className="cell2">
          <div className="t">
            <b>
              {memUsed == null ? DASH : Math.round(memUsed)} <span className="d">/ {s.memory_total_gb == null ? DASH : `${Math.round(s.memory_total_gb)} GB`}</span>
            </b>
            <span className="d num">{cur ? formatPct(cur.mem_pct) : DASH}</span>
          </div>
          <Meter pct={cur?.mem_pct ?? 0} color="var(--series-memory)" />
        </div>
      </td>
      <td className="temp">
        {cur && cur.temp_max_c != null ? (
          <>
            <Dot color={levelDot(tempLevel)} /> <b className="num">{formatTemp(cur.temp_max_c)}</b>{' '}
            <span className="lim num">/ {Math.round(cur.temp_limit_c ?? 85)}</span>
            {tempLevel && tempLevel !== 'good' && <span className="sr-only"> ({tempLevel === 'serious' ? t('at or above the limit') : t('near the limit')})</span>}
          </>
        ) : (
          <span className="ink-3">{DASH}</span>
        )}
      </td>
      <td>
        <div className="cell2" style={{ minWidth: 130 }}>
          <div className="t">
            <b>
              {storeUsed == null ? DASH : formatGb(storeUsed)} <span className="d">/ {s.storage_capacity_tb == null ? DASH : formatGb(s.storage_capacity_tb * 1000)}</span>
            </b>
            <span className="d num">{cur ? formatPct(cur.disk_used_pct) : DASH}</span>
          </div>
          <Meter pct={cur?.disk_used_pct ?? 0} color={levelBar(diskUsedLevel(cur?.disk_used_pct))} />
        </div>
      </td>
      <td className="last">
        {offline ? (
          <span className="offline-note">
            {lastSeen === null
              ? t('The agent has not connected yet.')
              : tx('Last seen {time} · {duration} ago', {
                  time: (
                    <time dateTime={s.last_seen ?? undefined} title={formatFull(lastSeen)}>
                      {formatClock(lastSeen, now)}
                    </time>
                  ),
                  duration: formatDuration((now - lastSeen) / 1000),
                })}
          </span>
        ) : (
          <GuestCounts s={s} tally={tally} />
        )}
      </td>
    </tr>
  );
}

interface BoardProps {
  servers: FleetServer[];
  series: Record<string, SeriesPair> | undefined;
  range: Range;
  asOf: string;
  tallies: Map<string, HostTally> | null;
  consoleHosts: Set<string>;
  footer?: string;
}

export function HostsBoard({ servers, series, range, asOf, tallies, consoleHosts, footer }: BoardProps) {
  const rows = sortHosts(servers, asOf);
  const [metric, setMetric] = useState<BoardMetric>(initialMetric);
  const pick = (m: BoardMetric) => {
    setMetric(m);
    try {
      localStorage.setItem(METRIC_KEY, m);
    } catch {
      // private mode: for this page only
    }
  };
  return (
    <section className="card board-card" aria-labelledby="hosts-title">
      <div className="card-head">
        <h2 className="h2" id="hosts-title">
          {t('Hosts')}
        </h2>
        <span className="sub">{t('Sorted by status, then name · a row opens the host')}</span>
      </div>
      <div className="board-scroll">
        <table className="board">
          <thead>
            <tr>
              <th className="first" scope="col">
                {t('Host')}
              </th>
              <th scope="col">
                <select className="col-pick" value={metric} onChange={(e) => pick(e.target.value as BoardMetric)} aria-label={t('Compare hosts by')}>
                  {(Object.keys(METRIC_LABEL) as BoardMetric[]).map((m) => (
                    <option key={m} value={m}>
                      {METRIC_LABEL[m]}
                    </option>
                  ))}
                </select>{' '}
                · {range}
              </th>
              <th scope="col">{t('Memory')}</th>
              <th scope="col">{t('Hottest sensor')}</th>
              <th scope="col">{t('Storage')}</th>
              <th className="last" scope="col">
                {t('Guests running')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <HostRow key={s.id} metric={metric} s={s} series={series?.[s.id]} range={range} asOf={asOf} tally={tallies?.get(s.id)} consoleOn={consoleHosts.has(s.id)} />
            ))}
          </tbody>
        </table>
      </div>
      {footer && <div className="lbl board-foot">{footer}</div>}
    </section>
  );
}
