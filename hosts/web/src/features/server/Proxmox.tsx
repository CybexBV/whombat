// Proxmox-only sections: Cluster (S10) and Backups (S11).

import { Link, useLocation } from 'react-router';
import type { Backups, Cluster, ProxmoxStorage } from '../../api/types';
import { Chip, Dot, Meter } from '../../components/controls';
import { useNow } from '../../lib/clock';
import { DASH, formatFull, formatGb, formatIn, formatRelativeDay, plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { hostPath } from '../../lib/urlState';
import { ENROLL_STATE, enrollTo } from '../agents/enrollLink';

export function ClusterSection({ cluster }: { cluster: Cluster }) {
  const loc = useLocation();
  const quorate = cluster.quorate;
  return (
    <section id="cluster" tabIndex={-1} className="card cluster-card" aria-labelledby="cluster-title">
      <div className="cluster-head">
        <div>
          <h2 className="h2" id="cluster-title">
            {t('Cluster: {name}', { name: cluster.name })}
          </h2>
          <div className="lbl" style={{ marginTop: 4 }}>
            {t('Reported by the Proxmox API on this node')}
          </div>
        </div>
        <div className="cluster-chips">
          <Chip dot={quorate ? 'var(--good)' : 'var(--critical)'}>
            {quorate ? t('Quorate') : t('Not quorate')} · {t('{have} of {expected} votes', { have: cluster.votes.have, expected: cluster.votes.expected })}
          </Chip>
          <Chip dot="var(--good)">{t('HA · {resources} started', { resources: plural(cluster.ha.resources_started, 'resource') })}</Chip>
        </div>
      </div>
      <div className="table-scroll">
        <div className="cluster-table" role="table" aria-label={t('Cluster nodes')}>
          <div className="cluster-row thead" role="row">
            {[t('Node'), t('Status'), t('CPU'), t('Memory'), t('Guests'), t('Agent')].map((h) => (
              <span key={h} className="lbl" role="columnheader">
                {h}
              </span>
            ))}
          </div>
          {cluster.nodes.map((n) => {
            const online = n.status === 'online';
            return (
              <div className="cluster-row" role="row" key={n.name}>
                <div role="rowheader" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  {n.server_id && !n.this_node ? (
                    <Link to={hostPath(n.server_id)} className="mono link" style={{ fontWeight: 500 }}>
                      {n.name}
                    </Link>
                  ) : (
                    <span className="mono" style={{ fontWeight: 500 }}>
                      {n.name}
                    </span>
                  )}
                  {n.this_node && <Chip className="chip-sm">{t('This node')}</Chip>}
                </div>
                <span className="state" role="cell">
                  <Dot color={online ? 'var(--good)' : 'var(--critical)'} />
                  {online ? t('Online') : n.status === 'offline' ? t('Offline') : n.status.charAt(0).toUpperCase() + n.status.slice(1)}
                </span>
                <span className="bar-cell" role="cell">
                  <Meter pct={n.cpu_pct ?? 0} color="var(--series-cpu)" />
                  {n.cpu_pct == null ? DASH : `${Math.round(n.cpu_pct)}%`}
                </span>
                <span className="bar-cell" role="cell">
                  <Meter pct={n.mem_pct ?? 0} color="var(--series-memory)" />
                  {n.mem_pct == null ? DASH : `${Math.round(n.mem_pct)}%`}
                </span>
                <span className="ink-2" style={{ fontSize: 13 }} role="cell">
                  {t('{vms} VMs · {containers} CTs', { vms: n.vms, containers: n.containers })}
                </span>
                <div role="cell">
                  {n.agent === 'connected' ? (
                    <span className="state">
                      <Dot color="var(--good)" />
                      {t('Connected')}
                    </span>
                  ) : n.agent === 'offline' ? (
                    <span className="state">
                      <Dot color="var(--muted)" />
                      {t('Agent offline')}
                    </span>
                  ) : (
                    <Link to={enrollTo(loc, n.name)} state={ENROLL_STATE} className="enroll-btn" aria-label={t('Enroll agent on {name}', { name: n.name })}>
                      {t('Enroll agent')}
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {cluster.note && <div className="lbl">{cluster.note}</div>}
    </section>
  );
}

const STORAGE_KIND: Record<string, string> = { pbs: 'Proxmox Backup Server', dir: t('Directory'), zfspool: t('ZFS pool'), nfs: 'NFS', cifs: 'SMB/CIFS', lvmthin: 'LVM-thin', rbd: 'Ceph RBD' };

export function BackupsSection({ backups, storages }: { backups: Backups; storages: ProxmoxStorage[] }) {
  const now = useNow(60_000);
  const j = backups.last_job;
  const target = storages.find((s) => s.id === backups.target);
  const ok = j?.result === 'ok';
  const chip = !j
    ? { text: t('No backup job yet'), dot: 'var(--muted)' }
    : ok && !j.warnings
      ? { text: t('Last run succeeded'), dot: 'var(--good)' }
      : ok
        ? { text: t('Last run had warnings'), dot: 'var(--warning)' }
        : { text: t('Last run failed'), dot: 'var(--critical)' };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const next = backups.next_run ? Date.parse(backups.next_run) : null;
  const fields: { k: string; v: string; s: string | null; title?: string }[] = [
    {
      k: t('Last job'),
      v: j ? formatRelativeDay(Date.parse(j.at), now) : DASH,
      s: j ? t('{schedule} · vzdump {mode} mode', { schedule: cap(j.schedule), mode: j.mode }) : null,
      title: j ? formatFull(Date.parse(j.at)) : undefined,
    },
    { k: t('Result'), v: j ? t('{ok} of {total} guests OK', { ok: j.guests_ok, total: j.guests_total }) : DASH, s: j ? (j.warnings ? plural(j.warnings, 'warning') : t('No warnings')) : null },
    { k: t('Data written'), v: j ? formatGb(j.written_gb) : DASH, s: j?.dedup_ratio != null ? t('Deduplication {ratio} : 1', { ratio: j.dedup_ratio }) : null },
    { k: t('Duration'), v: j ? `${j.duration_min} min` : DASH, s: j?.avg_duration_min_week != null ? t('Average {min} min this week', { min: j.avg_duration_min_week }) : null },
    { k: t('Next run'), v: next ? formatRelativeDay(next, now) : DASH, s: next ? formatIn((next - now) / 1000) : null, title: next ? formatFull(next) : undefined },
    {
      k: t('Target'),
      v: backups.target ?? DASH,
      s: target
        ? t('{kind} · {pct}% full', { kind: STORAGE_KIND[target.type] ?? target.type, pct: target.capacity_gb ? Math.round((target.used_gb / target.capacity_gb) * 100) : 0 })
        : null,
    },
  ];
  return (
    <section id="backups" tabIndex={-1} className="section" aria-labelledby="backups-title">
      <div className="section-head">
        <h2 className="h2" id="backups-title">
          {t('Backups')}
        </h2>
        <Chip dot={chip.dot}>{chip.text}</Chip>
      </div>
      <div className="card fact-grid">
        {fields.map((f) => (
          <div className="field" key={f.k}>
            <div className="lbl">{f.k}</div>
            <div className="v" title={f.title}>
              {f.v}
            </div>
            {f.s && <div className="lbl s">{f.s}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
