// Workloads strip (UI v2): one card per platform present in the fleet
// (Docker, Incus, Proxmox VE, libvirt) with running / total, a state bar,
// the hosts that run it and the three busiest guests. Counts come from the
// fleet-wide guest list (guestStats); the fleet body is the fallback before
// it loads.

import { Link } from 'react-router';
import type { Fleet, FleetGuest, Platform, Range } from '../../api/types';
import { Dot, Meter, StateBar } from '../../components/controls';
import { Icon, type IconName } from '../../components/Icon';
import { formatPct1, plural } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { consolePath, guestListPath, guestsPagePath } from '../../lib/urlState';
import { opensConsole } from '../../components/CommandPalette';
import type { GuestStats, Tally } from './guestStats';

interface CardProps {
  platform: Platform;
  icon: IconName;
  name: string;
  where: string;
  tally: Tally;
  split?: string;
  top: FleetGuest[];
  range: Range;
}

function WorkloadCard({ platform, icon, name, where, tally, split, top, range }: CardProps) {
  const segs = [
    { n: tally.running, label: t('Running'), color: 'var(--good)' },
    { n: tally.stopped, label: t('Stopped'), color: 'var(--muted)' },
    { n: tally.unhealthy, label: t('Unhealthy'), color: 'var(--serious)' },
  ].filter((s) => s.n > 0);
  return (
    <div className="card wl-card">
      <div className="wl-head">
        <span className="icon-square">
          <Icon name={icon} size={16} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h3 className="wl-name">
            <Link to={guestsPagePath({ platform })}>{name}</Link>
          </h3>
          <div className="wl-where" title={where}>
            {where}
          </div>
        </div>
      </div>
      <div className="count-row">
        <span className="big">{tally.running + tally.unhealthy}</span>
        <span className="of">{t('running of {total}', { total: tally.total })}</span>
      </div>
      <div>
        <StateBar segments={segs} />
        <div className="legend-row">
          {segs.map((s) => (
            <span key={s.label}>
              <Dot color={s.color} />
              {s.label} <b>{s.n}</b>
            </span>
          ))}
          {split && <span className="ink-3">{split}</span>}
        </div>
      </div>
      <div className="top-list">
        {top.length === 0 ? (
          <div className="top-empty">{t('No running guests')}</div>
        ) : (
          top.map((g) => (
            <div className="top-row" key={`${g.server}/${g.id}`}>
              <span className="n">
                <Link to={opensConsole(g) ? consolePath(g.server, g.id, { range }) : guestListPath(g.server, g.platform, g.kind, g.name, range)} title={t('{name} on {server}', { name: g.name, server: g.server })}>
                  {g.name}
                </Link>
                <small>{g.server}</small>
              </span>
              <Meter pct={Math.min(100, g.cpu_pct ?? 0)} color="var(--series-cpu)" />
              <span className="p">{formatPct1(g.cpu_pct)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const hostsText = (hosts: string[], stats: GuestStats, platform: Platform) =>
  hosts.length <= 3
    ? hosts.map((h) => `${h} ${(stats.byHost.get(h)?.[platform === 'pve' ? 'all' : platform === 'docker' ? 'docker' : platform === 'incus' ? 'incus' : 'libvirt'].running ?? 0)}`).join(' · ')
    : plural(hosts.length, 'host');

export function Workloads({ fleet, stats, range }: { fleet: Fleet; stats: GuestStats | null; range: Range }) {
  if (!stats) {
    // Fallback before the guest list loads: the fleet body's platform summary.
    const p = fleet.platform_summary;
    const docker: Tally = { running: p.docker.running, stopped: p.docker.stopped, unhealthy: p.docker.unhealthy, total: p.docker.running + p.docker.stopped + p.docker.unhealthy };
    const incus: Tally = { running: p.incus.containers_running + p.incus.vms_running, stopped: p.incus.stopped, unhealthy: 0, total: p.incus.containers_running + p.incus.vms_running + p.incus.stopped };
    const qemu: Tally = { running: p.qemu.running, stopped: p.qemu.stopped, unhealthy: 0, total: p.qemu.running + p.qemu.stopped };
    const cards = [
      docker.total ? <WorkloadCard key="docker" platform="docker" icon="box" name="Docker" where={t('Containers')} tally={docker} top={[]} range={range} /> : null,
      incus.total ? <WorkloadCard key="incus" platform="incus" icon="layers" name="Incus" where={t('Containers and VMs')} tally={incus} top={[]} range={range} /> : null,
      qemu.total ? <WorkloadCard key="qemu" platform="pve" icon="screen" name="QEMU / KVM" where={t('Proxmox VE and libvirt VMs')} tally={qemu} top={[]} range={range} /> : null,
    ].filter(Boolean);
    if (!cards.length) return null;
    return (
      <section className="section" aria-labelledby="wl-title">
        <div className="section-head">
          <h2 className="h2" id="wl-title">
            {t('Workloads')}
          </h2>
          <span className="lbl">{t('Loading the guest list…')}</span>
        </div>
        <div className="wl-grid">{cards}</div>
      </section>
    );
  }

  const bp = stats.byPlatform;
  const top3 = (platform: Platform) => stats.top.filter((g) => g.platform === platform).slice(0, 3);
  const pveVms = { running: 0, total: 0 };
  const pveCts = { running: 0, total: 0 };
  const incusVms = { running: 0, total: 0 };
  for (const h of stats.byHost.values()) {
    pveVms.running += h.pveVms.running;
    pveVms.total += h.pveVms.total;
    pveCts.running += h.pveCts.running;
    pveCts.total += h.pveCts.total;
    incusVms.running += h.incusVms.running;
    incusVms.total += h.incusVms.total;
  }
  const cards = [
    bp.docker.total ? <WorkloadCard key="docker" platform="docker" icon="box" name="Docker" where={hostsText(stats.hostsOf.docker, stats, 'docker')} tally={bp.docker} top={top3('docker')} range={range} /> : null,
    bp.incus.total ? (
      <WorkloadCard
        key="incus"
        platform="incus"
        icon="layers"
        name="Incus"
        where={hostsText(stats.hostsOf.incus, stats, 'incus')}
        tally={bp.incus}
        split={t('{vm} of {vmTotal} VMs · {ct} of {ctTotal} containers', { vm: incusVms.running, vmTotal: incusVms.total, ct: bp.incus.running + bp.incus.unhealthy - incusVms.running, ctTotal: bp.incus.total - incusVms.total })}
        top={top3('incus')}
        range={range}
      />
    ) : null,
    bp.pve.total ? (
      <WorkloadCard
        key="pve"
        platform="pve"
        icon="servers"
        name="Proxmox VE"
        where={hostsText(stats.hostsOf.pve, stats, 'pve')}
        tally={bp.pve}
        split={t('{vm} of {vmTotal} VMs · {ct} of {ctTotal} LXC', { vm: pveVms.running, vmTotal: pveVms.total, ct: pveCts.running, ctTotal: pveCts.total })}
        top={top3('pve')}
        range={range}
      />
    ) : null,
    bp.libvirt.total ? <WorkloadCard key="libvirt" platform="libvirt" icon="screen" name="libvirt / QEMU" where={hostsText(stats.hostsOf.libvirt, stats, 'libvirt')} tally={bp.libvirt} top={top3('libvirt')} range={range} /> : null,
  ].filter(Boolean);
  if (!cards.length) return null;
  const hosts = stats.byHost.size;
  return (
    <section className="section" aria-labelledby="wl-title">
      <div className="section-head">
        <h2 className="h2" id="wl-title">
          {t('Workloads')}
        </h2>
        <span className="lbl">
          {tx('{running} running of {total} across {hosts} · busiest guests by CPU · {link}', {
            running: stats.all.running + stats.all.unhealthy,
            total: `${stats.all.total}${stats.truncated ? '+' : ''}`,
            hosts: plural(hosts, 'host'),
            link: (
              <Link className="link" to="/guests">
                {t('All guests')}
              </Link>
            ),
          })}
        </span>
      </div>
      <div className="wl-grid">{cards}</div>
    </section>
  );
}
