// Backups of a Proxmox guest (docs/MANAGE.md, Backups tab): Back up now and
// the archives on every backup storage of the node, newest first, with
// Restore… (admins), protection, notes and Delete (admins, not protected).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type BackupVolume, manageApi, manageKeys, useBackups } from '../../api/manage';
import { Skeleton } from '../../components/common';
import { Chip } from '../../components/controls';
import { InlineError } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Menu, type MenuItem } from '../../components/Menu';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { useNow } from '../../lib/clock';
import { DASH, formatAgoIso, formatDayTime, formatFull, formatGb } from '../../lib/format';
import { t, tn } from '../../lib/i18n';
import { BackupNotesDialog, BackupNowDialog, RestoreDialog } from '../manage/BackupDialogs';
import { type GuestRef, started } from '../manage/LifecycleDialogs';
import { manageErrorText } from '../manage/manageErrors';
import type { GuestTabProps } from './GuestPage';

type Dialog = { kind: 'backup' } | { kind: 'restore' | 'notes' | 'delete'; b: BackupVolume } | null;

const when = (b: BackupVolume) => (b.created ? formatDayTime(Date.parse(b.created)) : b.volume.split('/').pop() ?? b.volume);

export function BackupsTab({ serverId, guest, isAdmin }: GuestTabProps) {
  const qc = useQueryClient();
  const list = useBackups(serverId, guest.id);
  const now = useNow(60_000);
  const [dialog, setDialog] = useState<Dialog>(null);
  const ref: GuestRef = { id: guest.id, name: guest.name, kind: guest.kind, state: guest.state, platform: 'pve', vmid: guest.vmid };
  const refresh = () => void qc.invalidateQueries({ queryKey: manageKeys.backups(serverId, guest.id) });

  const protect = useMutation({
    mutationFn: (b: BackupVolume) => manageApi.updateBackup(serverId, 'pve', b.volume, { protected: !b.protected }),
    onSuccess: refresh,
    onError: (err) => toast(t('Could not change the protection: {error}', { error: manageErrorText(err) }), 'error'),
  });
  const del = useMutation({
    mutationFn: (b: BackupVolume) => manageApi.deleteBackup(serverId, 'pve', b.volume),
    onSuccess: (r, b) => {
      started(serverId, 'pve', r, t('Delete the backup of {time}', { time: when(b) }), t('Backup of {time} deleted.', { time: when(b) }));
      setDialog(null);
      refresh();
    },
  });

  const items = list.data ?? [];
  const latest = items[0];
  return (
    <section className="card" aria-labelledby="backups-title">
      <div className="card-head">
        <h2 className="h2" id="backups-title">
          {t('Backups')}
        </h2>
        <span className="lc-head-tools">
          {latest?.created && <span className="sub">{tn(items.length, '{n} backup, newest {time}', '{n} backups, newest {time}', { time: formatAgoIso(latest.created, now) })}</span>}
          <button type="button" className="btn-ghost" onClick={() => setDialog({ kind: 'backup' })}>
            <Icon name="plus" size={15} />
            {t('Back up now')}
          </button>
        </span>
      </div>
      {list.isError ? (
        <div className="card-body">
          <InlineRetry title={t('Could not list the backups')} error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : !list.data ? (
        <div className="card-body">
          <Skeleton height={96} />
        </div>
      ) : items.length === 0 ? (
        <div className="guests-empty">{t('No backups of {name} yet.', { name: guest.name })}</div>
      ) : (
        <div className="gt-scroll">
          <table className="lc-table">
            <thead>
              <tr>
                <th scope="col">{t('Date')}</th>
                <th scope="col">{t('Storage')}</th>
                <th scope="col" className="num hide-phone">
                  {t('Size')}
                </th>
                <th scope="col" className="hide-phone">
                  {t('Format')}
                </th>
                <th scope="col" className="hide-phone">
                  {t('Notes')}
                </th>
                <th scope="col">
                  <span className="sr-only">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => {
                const menu: MenuItem[] = [
                  { label: b.protected ? t('Remove protection') : t('Protect'), icon: 'shield', onSelect: () => protect.mutate(b) },
                  { label: t('Edit notes…'), icon: 'edit', onSelect: () => setDialog({ kind: 'notes', b }) },
                  isAdmin && {
                    label: t('Delete…'),
                    icon: 'trash',
                    danger: true,
                    disabled: b.protected,
                    title: b.protected ? t('Protected backups cannot be deleted') : undefined,
                    onSelect: () => setDialog({ kind: 'delete', b }),
                  },
                ].filter(Boolean) as MenuItem[];
                return (
                  <tr key={b.volume}>
                    <td className="nowrap">
                      <span title={b.created ? formatFull(Date.parse(b.created)) : undefined}>{when(b)}</span>
                      {b.protected && (
                        <span className="lc-lock" title={t('Protected')}>
                          <Icon name="shield" size={13} label={t('Protected')} />
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="mono">{b.storage}</span>
                      {b.verified === 'ok' && (
                        <Chip className="chip-sm lc-chip" dot="var(--good)" title={t('Verified by Proxmox Backup Server')}>
                          {t('verified')}
                        </Chip>
                      )}
                      {b.verified === 'failed' && (
                        <Chip className="chip-sm lc-chip" dot="var(--critical)">
                          {t('verification failed')}
                        </Chip>
                      )}
                    </td>
                    <td className="num ink-2 hide-phone">{b.size_bytes != null ? formatGb(b.size_bytes / 1e9) : DASH}</td>
                    <td className="ink-2 hide-phone">{b.format ?? DASH}</td>
                    <td className="lc-notes hide-phone">
                      {b.encrypted && <span className="sr-only">{t('Encrypted')}</span>}
                      <span className="ellipsis ink-2">{b.notes || DASH}</span>
                    </td>
                    <td className="last">
                      <span className="row-tools">
                        {isAdmin && (
                          <button type="button" className="btn-ghost row-action" onClick={() => setDialog({ kind: 'restore', b })}>
                            {t('Restore…')}
                            <span className="sr-only"> {t('the backup of {time}', { time: when(b) })}</span>
                          </button>
                        )}
                        <Menu label={t('More for the backup of {time}', { time: when(b) })} items={menu} buttonClassName="btn-ghost btn-icon row-action" floating />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === 'backup' && <BackupNowDialog serverId={serverId} guest={ref} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'restore' && <RestoreDialog serverId={serverId} guest={ref} backup={dialog.b} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'notes' && <BackupNotesDialog serverId={serverId} backup={dialog.b} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog?.kind === 'delete' && (
        <Modal
          open
          onClose={() => setDialog(null)}
          busy={del.isPending}
          tone="serious"
          title={t('Delete the backup of {time}?', { time: when(dialog.b) })}
          description={t('The archive is removed from {storage}. This cannot be undone.', { storage: dialog.b.storage })}
          actions={
            <>
              <button type="button" className="btn-ghost" autoFocus onClick={() => setDialog(null)}>
                {t('Cancel')}
              </button>
              <button type="button" className="btn-primary btn-sm is-serious" disabled={del.isPending} onClick={() => del.mutate(dialog.b)}>
                {t('Delete backup')}
              </button>
            </>
          }
        >
          {del.isError && <InlineError>{manageErrorText(del.error)}</InlineError>}
        </Modal>
      )}
    </section>
  );
}
