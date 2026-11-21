// Storage: disk cards on a standard host (S6), Proxmox storages + Disks and
// wear on a Proxmox node (S6p). With Manage on, Proxmox storages that hold
// ISO images, container templates or import files get "Contents…".

import { useState } from 'react';
import { type ChoiceStorage, useChoices } from '../../api/manage';
import type { Disk, ProxmoxDisk, ProxmoxStorage, RaidArray, RemoteControl, Volume } from '../../api/types';
import { Chip, Meter } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { DASH, formatGb, formatInt, formatTemp, numberWord, plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { diskUsedLevel, displayWear, levelBar, levelDot, wearLabel, wearLevel } from '../../lib/thresholds';
import { hasContents, StorageContentDialog } from '../manage/StorageContentDialog';
import { ArraysCard, SmartDetail, VolumesCard } from './Health';

const TYPE_LABEL: Record<Disk['type'], string> = { nvme: 'NVMe', hdd: 'HDD', ssd: 'SSD' };

function healthChip(d: Disk): { text: string; dot: string } {
  if (d.health === 'failing' || d.smart?.passed === false) return { text: t('Failing'), dot: 'var(--critical)' };
  if (d.type !== 'hdd' && d.wear_pct != null) {
    const high = wearLabel(d.wear_pct) === 'Wear high';
    return { text: high ? t('Wear high') : t('Healthy'), dot: high ? levelDot(wearLevel(d.wear_pct)) : 'var(--good)' };
  }
  return d.health === 'wear_high' ? { text: t('Wear high'), dot: 'var(--warning)' } : { text: t('Healthy'), dot: 'var(--good)' };
}

const smartText = (passed: boolean | null | undefined) => (passed == null ? DASH : passed ? t('Passed') : t('Failed'));
const count = (v: number | null | undefined) => (v == null ? DASH : formatInt(v));

function DiskCard({ d }: { d: Disk }) {
  const pct = d.capacity_gb ? Math.round((d.used_gb / d.capacity_gb) * 100) : 0;
  const health = healthChip(d);
  const ssd = d.type !== 'hdd';
  const wear = d.wear_pct == null ? null : displayWear(d.wear_pct);
  return (
    <article className="card disk-card" aria-labelledby={`disk-${d.device}`}>
      <div className="disk-head">
        <div className="disk-id">
          <span className="disk-icon">
            <Icon name="drive" size={22} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="disk-dev">
              <h3 className="mono" id={`disk-${d.device}`} style={{ margin: 0, fontSize: 17, fontWeight: 500 }}>
                {d.device}
              </h3>
              <Chip className="chip-sm">{TYPE_LABEL[d.type]}</Chip>
            </div>
            <div className="ink-2" style={{ marginTop: 2 }}>
              {d.model}
            </div>
            <div className="lbl" style={{ marginTop: 2 }}>
              {d.role}
            </div>
          </div>
        </div>
        <Chip dot={health.dot} title={d.health_reason ?? undefined}>
          {health.text}
        </Chip>
      </div>
      {d.health_reason && <div className="tone-bad disk-more">{d.health_reason}</div>}
      <div>
        <div className="bar-head">
          <span className="lbl">{t('Space used')}</span>
          <span className="r">
            <b>{formatGb(d.used_gb)}</b>{' '}
            <span className="ink-3">{t('of {total} · {pct}%', { total: formatGb(d.capacity_gb), pct })}</span>
          </span>
        </div>
        <Meter pct={pct} color={levelBar(diskUsedLevel(pct))} style={{ marginTop: 10 }} />
      </div>
      {ssd ? (
        <div>
          <div className="bar-head">
            <span className="lbl">{t('Wear (endurance used)')}</span>
            <span className="r">
              <b>{wear == null ? DASH : `${wear}%`}</b>
              {d.written_tb != null && d.rated_tbw != null && (
                <span className="ink-3">
                  {' '}
                  · {t('{written} of {rated} TBW', { written: formatInt(d.written_tb), rated: formatInt(d.rated_tbw) })}
                </span>
              )}
            </span>
          </div>
          <Meter pct={wear ?? 0} color={levelBar(wearLevel(d.wear_pct))} style={{ marginTop: 10 }} />
        </div>
      ) : (
        <div>
          <div className="bar-head">
            <span className="lbl">{t('Wear')}</span>
            <span className="ink-3" style={{ fontSize: 13 }}>
              {t('Not applicable (spinning disk)')}
            </span>
          </div>
          <div className="smart-counters">
            <span>
              {t('Reallocated sectors')} <b>{count(d.smart?.reallocated)}</b>
            </span>
            <span>
              {t('Pending|sectors')} <b>{count(d.smart?.pending)}</b>
            </span>
            <span>
              {t('Uncorrectable')} <b>{count(d.smart?.uncorrectable)}</b>
            </span>
          </div>
        </div>
      )}
      <div className="disk-foot">
        <div>
          <div className="lbl">{t('Temperature')}</div>
          <div className="v">{formatTemp(d.temp_c)}</div>
        </div>
        <div>
          <div className="lbl">{t('Power-on')}</div>
          <div className="v">{d.power_on_hours == null ? DASH : `${formatInt(d.power_on_hours)} ${t('h')}`}</div>
        </div>
        <div>
          <div className="lbl">SMART</div>
          <div className="v">{smartText(d.smart?.passed)}</div>
        </div>
      </div>
      {d.smart && <SmartDetail smart={d.smart} io={d.io} />}
    </article>
  );
}

export function StorageStandard({ disks, volumes = [], arrays = [] }: { disks: Disk[]; volumes?: Volume[]; arrays?: RaidArray[] }) {
  const used = disks.reduce((a, d) => a + d.used_gb, 0);
  const cap = disks.reduce((a, d) => a + d.capacity_gb, 0);
  return (
    <section id="storage" tabIndex={-1} className="section" aria-labelledby="storage-title">
      <div className="section-head">
        <h2 className="h2" id="storage-title">
          {t('Storage')}
        </h2>
        <span className="ink-2" style={{ fontSize: 13 }}>
          {plural(disks.length, 'disk')} · {t('{used} used of {total}', { used: formatGb(used), total: formatGb(cap) })}
        </span>
      </div>
      <VolumesCard volumes={volumes} />
      <ArraysCard arrays={arrays} />
      {disks.length === 0 ? (
        <div className="card empty-card ink-2">{t('No disks reported.')}</div>
      ) : (
        <div className="disk-grid">
          {disks.map((d) => (
            <DiskCard key={d.device} d={d} />
          ))}
        </div>
      )}
    </section>
  );
}

export function StorageProxmox({
  storages,
  disks,
  volumes = [],
  arrays = [],
  serverId = '',
  rc,
  isAdmin = false,
}: {
  storages: ProxmoxStorage[];
  disks: ProxmoxDisk[];
  volumes?: Volume[];
  arrays?: RaidArray[];
  /** Contents… needs the host and the user's Manage permission. */
  serverId?: string;
  rc?: RemoteControl;
  isAdmin?: boolean;
}) {
  const choices = useChoices(serverId, 'pve', !!serverId && !!rc?.manage);
  const [contents, setContents] = useState<ChoiceStorage | null>(null);
  const pools = new Set(disks.map((d) => d.pool)).size;
  const raw = disks.every((d) => d.capacity_gb != null) && disks.length ? disks.reduce((a, d) => a + (d.capacity_gb ?? 0), 0) : null;
  const fullest = storages
    .map((s) => ({ id: s.id, pct: s.capacity_gb ? Math.round((s.used_gb / s.capacity_gb) * 100) : 0 }))
    .sort((a, b) => b.pct - a.pct)[0];
  const summary = [
    plural(disks.length, 'disk'),
    raw != null ? t('{size} raw', { size: formatGb(raw) }) : null,
    plural(pools, 'pool'),
    fullest && fullest.pct >= 80 ? t('{id} is {pct}% full', { id: fullest.id, pct: fullest.pct }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const allPass = disks.length > 0 && disks.every((d) => d.smart?.passed === true);

  return (
    <section id="storage" tabIndex={-1} className="section" aria-labelledby="storage-title">
      <div className="section-head">
        <h2 className="h2" id="storage-title">
          {t('Storage')}
        </h2>
        <span className="ink-2" style={{ fontSize: 13 }}>
          {summary}
        </span>
      </div>
      <div className="pve-storage-row">
        <div className="card pve-stores">
          <h3 className="title" style={{ margin: 0, fontSize: 14 }}>
            {t('Proxmox storages')}
          </h3>
          {storages.map((s) => {
            const pct = s.capacity_gb ? Math.round((s.used_gb / s.capacity_gb) * 100) : 0;
            const choice = choices.data?.storages.find((c) => c.id === s.id && hasContents(c));
            return (
              <div className="store-item" key={s.id}>
                <div className="store-line">
                  <div className="store-name">
                    <span className="mono" style={{ fontWeight: 500 }}>
                      {s.id}
                    </span>
                    <Chip className="chip-sm">{s.type}</Chip>
                  </div>
                  <span style={{ fontSize: 13 }}>
                    <b style={{ fontWeight: 600 }}>{formatGb(s.used_gb)}</b>{' '}
                    <span className="ink-3">{t('of {total} · {pct}%', { total: formatGb(s.capacity_gb), pct })}</span>
                    {choice && (
                      <button type="button" className="btn-ghost row-action store-contents" onClick={() => setContents(choice)}>
                        {t('Contents…')}
                        <span className="sr-only"> {t('of {name}', { name: s.id })}</span>
                      </button>
                    )}
                  </span>
                </div>
                <div className="lbl" style={{ marginTop: 2 }}>
                  {s.content}
                </div>
                <Meter pct={pct} color={levelBar(diskUsedLevel(pct))} style={{ marginTop: 12 }} />
              </div>
            );
          })}
        </div>
        <div className="card pve-disks">
          <h3 className="title" style={{ margin: 0, fontSize: 14 }}>
            {t('Disks and wear')}
          </h3>
          <div className="table-scroll">
            <div className="table-inner" role="table" aria-label={t('Disks and wear')}>
              <div className="pve-disk-row thead" role="row">
                {[t('Disk'), t('Model'), t('Pool'), t('Wear'), t('Temp')].map((h) => (
                  <span key={h} className="lbl" role="columnheader">
                    {h}
                  </span>
                ))}
              </div>
              {disks.map((d) => (
                <div className="pve-disk-row" role="row" key={d.device}>
                  <span className="mono" role="cell" title={d.health_reason ?? undefined}>
                    {d.device}
                    {d.health === 'failing' && <span className="tone-bad"> · {t('failing')}</span>}
                  </span>
                  <span className="ink-2 ellipsis" role="cell" title={d.model}>
                    {d.model}
                  </span>
                  <span className="mono ink-2" style={{ fontSize: 12 }} role="cell">
                    {d.pool}
                  </span>
                  <span className="wear-cell" role="cell">
                    <Meter pct={d.wear_pct == null ? 0 : displayWear(d.wear_pct)} color={levelBar(wearLevel(d.wear_pct))} />
                    <span style={{ fontWeight: 500 }}>{d.wear_pct == null ? DASH : `${displayWear(d.wear_pct)}%`}</span>
                  </span>
                  <span className="ink-2" role="cell">
                    {formatTemp(d.temp_c)}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="lbl foot">
            {t('Wear is the endurance used reported by SMART.')}
            {allPass && ` ${t('All {n} disks pass SMART.', { n: numberWord(disks.length) })}`}
          </div>
        </div>
      </div>
      {/* Proxmox storages have their own card above: filesystems and pools here. */}
      <VolumesCard volumes={volumes.filter((v) => v.kind !== 'storage')} title={t('Filesystems and pools')} />
      <ArraysCard arrays={arrays} />
      {contents && <StorageContentDialog serverId={serverId} storage={contents} isAdmin={isAdmin} download={!!choices.data?.download} onClose={() => setContents(null)} />}
    </section>
  );
}
