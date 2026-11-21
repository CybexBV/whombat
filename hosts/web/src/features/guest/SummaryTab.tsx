// Summary of the guest page (every platform): facts from the report and,
// with Manage, from the configuration (disks, lock, pending changes, HA),
// the notes (Proxmox description, plain text) and the history charts. When
// Manage is missing, a short note says why (docs/MANAGE.md, UI).

import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useGuestConfig } from '../../api/manage';
import type { Range } from '../../api/types';
import { Dot } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { useNow } from '../../lib/clock';
import { DASH, formatAgoIso, formatDuration, formatFull, formatMemPair } from '../../lib/format';
import { t, tn } from '../../lib/i18n';
import { agentPath, guestPath } from '../../lib/urlState';
import { GuestHistoryCharts, GuestHistoryRange } from '../guests/GuestHistory';
import { diskFile, formatSize, keyOrder, pendingKeys } from './config';
import { TextDialog } from './dialogs';
import type { GuestTabProps } from './GuestPage';
import { managed } from './tabs';

interface Fact {
  k: string;
  v: ReactNode;
  s?: string | null;
  title?: string;
  /** Status dot before the value (the text keeps its color). */
  dot?: string;
}

export function SummaryTab(props: GuestTabProps) {
  const { serverId, guest: g, rc, isAdmin } = props;
  const now = useNow(60_000);
  const [range, setRange] = useState<Range>('24h');
  const [editNotes, setEditNotes] = useState(false);
  const canManage = !!rc?.manage && managed(g);
  const config = useGuestConfig(serverId, g.id, canManage);
  const cfg = config.data;
  const running = g.state !== 'stopped';

  const facts: Fact[] = [];
  if (g.image) facts.push({ k: g.platform === 'docker' ? t('Image') : t('Operating system'), v: g.image });
  if (g.vcpu != null) facts.push({ k: 'vCPU', v: String(g.vcpu) });
  if (g.memory_limit_mb != null || g.memory_used_mb != null) facts.push({ k: t('Memory'), v: formatMemPair(g.memory_used_mb, g.memory_limit_mb), s: t('used / assigned') });
  const disks = (cfg?.disks ?? []).filter((d) => d.media !== 'cdrom' && !d.unused).sort((a, b) => keyOrder(a.key, b.key));
  if (disks.length) {
    facts.push({
      k: disks.length === 1 ? t('Disk') : t('Disks'),
      v: disks.map((d) => `${d.key} ${d.size_bytes ? formatSize(d.size_bytes) : ''}`.trim()).join(' · '),
      s: [...new Set(disks.map((d) => d.storage ?? volumeOf(d.volume)).filter(Boolean))].join(', ') || null,
    });
  }
  if (g.addresses?.length) facts.push({ k: tn(g.addresses.length, 'Address', 'Addresses'), v: <span className="mono">{g.addresses.join(', ')}</span> });
  facts.push({ k: t('Uptime'), v: running && g.uptime_s != null ? formatDuration(g.uptime_s) : running ? DASH : t('Not running') });
  if (g.last_backup) {
    const ok = g.last_backup.result === 'ok';
    facts.push({
      k: t('Last backup'),
      v: ok ? t('OK {time}', { time: formatAgoIso(g.last_backup.at, now) }) : t('Failed {time}', { time: formatAgoIso(g.last_backup.at, now) }),
      dot: ok ? 'var(--good)' : 'var(--critical)',
      title: formatFull(Date.parse(g.last_backup.at)),
      s: g.backup_job === false ? t('No backup job covers this guest') : null,
    });
  } else if (g.backup_job === false) facts.push({ k: t('Last backup'), v: t('None'), s: t('No backup job covers this guest'), dot: WARN });
  if (g.snapshots != null) facts.push({ k: t('Snapshots'), v: String(g.snapshots), s: g.oldest_snapshot ? t('Oldest {time}', { time: formatAgoIso(g.oldest_snapshot, now) }) : null });
  const lock = cfg?.lock ?? g.lock;
  if (lock) facts.push({ k: t('Lock'), v: lock, s: t('Proxmox locked the guest while a task runs'), dot: WARN });
  const ha = cfg?.ha?.state ?? g.ha_state;
  if (ha) facts.push({ k: t('High availability'), v: ha, s: cfg?.ha?.status ?? null });
  const pending = cfg ? pendingKeys(cfg).length : (g.pending_changes ?? 0);
  if (pending > 0) {
    facts.push({
      k: t('Pending changes'),
      v: canManage ? <Link to={guestPath(serverId, g.id, { tab: g.platform === 'pve' ? 'hardware' : 'config' })}>{tn(pending, '{n} change', '{n} changes')}</Link> : tn(pending, '{n} change', '{n} changes'),
      s: t('Apply at the next restart'),
      dot: WARN,
    });
  }
  if (g.guest_agent) facts.push({ k: t('Guest agent'), v: g.guest_agent === 'running' ? t('Running') : t('Not running'), dot: g.guest_agent === 'running' ? 'var(--good)' : WARN, s: 'QEMU guest agent' });
  else if (g.platform === 'pve' && g.kind === 'vm' && cfg) facts.push({ k: t('Guest agent'), v: /^(1|enabled=1)/.test(cfg.values.agent ?? '') ? t('Enabled') : t('Off') });

  const notes = cfg?.values.description ?? '';
  const reason = managed(g) && !rc?.manage ? (rc?.manage_reason ?? t('Managing guests is turned off for this host.')) : null;

  return (
    <div className="section guest-tab">
      {reason && (
        <p className="rc-note ink-2">
          <Icon name="info" size={16} />
          <span>
            {t('Configuration, backups and tasks are not available: {reason}.', { reason: reason.replace(/\.$/, '') })}
            {isAdmin && (
              <>
                {' '}
                <Link className="link" to={agentPath(serverId)}>
                  {t('Agent settings')}
                </Link>
              </>
            )}
          </span>
        </p>
      )}
      <section className="card fact-grid guest-facts" aria-label={t('Facts')}>
        {facts.map((f) => (
          <div className="field" key={f.k}>
            <div className="lbl">{f.k}</div>
            <div className={f.dot ? 'v with-dot' : 'v'} title={f.title}>
              {f.dot && <Dot color={f.dot} />}
              {f.v}
            </div>
            {f.s && <div className="lbl s">{f.s}</div>}
          </div>
        ))}
      </section>
      {notes && (
        <section className="card cfg-card" aria-labelledby="guest-notes">
          <div className="card-head">
            <h2 className="h2" id="guest-notes">
              {t('Notes')}
            </h2>
            {cfg && (
              <button type="button" className="btn-ghost row-action" onClick={() => setEditNotes(true)}>
                {t('Edit')}
                <span className="sr-only"> {t('notes')}</span>
              </button>
            )}
          </div>
          <p className="card-body guest-notes">{notes}</p>
        </section>
      )}
      <section className="card cfg-card" aria-labelledby="guest-history">
        <div className="card-head">
          <h2 className="h2" id="guest-history">
            {t('History')}
          </h2>
          <GuestHistoryRange value={range} onChange={setRange} />
        </div>
        <div className="card-body">
          <GuestHistoryCharts serverId={serverId} guest={g} range={range} inCard />
        </div>
      </section>
      {editNotes && cfg && (
        <TextDialog
          ctx={{ serverId, guest: g, config: cfg }}
          onClose={() => setEditNotes(false)}
          cfgKey="description"
          title={t('Edit notes')}
          label={t('Notes of {name}', { name: g.name })}
          fieldLabel={t('Notes')}
          hint={g.platform === 'pve' ? t('Plain text; Proxmox shows it on the guest’s summary too.') : undefined}
          multiline
        />
      )}
    </div>
  );
}

const WARN = 'var(--warning)';
const volumeOf = (v: string | undefined) => (v ? diskFile(v).split(':')[0] : '');
