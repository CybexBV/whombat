/**
 * libvirt VMs' backups (Whombat incus-unraid.md IU-13; AP-1654, AP-1660): a VM's Backups tab and a server's — when each
 * was made, its size and format, Restore… (always as a new VM) and Delete… (asked) — with Back up now, where the backups
 * go, and on the server the VMs nothing has backed up yet. libvirt keeps them in the backups folder
 * (`HostLibvirtDetail.backupsDir`), one folder per VM and backup with the VM's XML.
 */
import {
  DASH,
  formatBytesBinary,
  formatDayTime,
  formatRelativeDay,
  libvirtBackupOf,
  libvirtBackupTime,
  plural,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostBackupVolume, HostGuest, HostServerDetail } from '@whombat/core/domain';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { currentLocale } from '../../../i18n/provider';
import { Card, Empty, ErrorLine } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import wb from '../wb.module.css';
import { LvBackupNowDialog, LvDeleteBackupDialog, LvRestoreDialog, lvBackupWhen } from './LibvirtDialogs';

const newest = (items: readonly HostBackupVolume[]) =>
  [...items].sort((a, b) => (libvirtBackupTime(b) ?? 0) - (libvirtBackupTime(a) ?? 0));

/** The libvirt guests of a server's page. */
export function libvirtGuests(d: HostServerDetail): HostGuest[] {
  return d.workloads?.libvirt?.guests ?? [];
}

type Dialog = { kind: 'restore' | 'delete'; backup: HostBackupVolume } | null;

export function LvBackupTable({
  burrow,
  detail,
  items,
  showGuest,
  canChange,
  timeZone,
}: {
  burrow: string;
  detail: HostServerDetail;
  items: readonly HostBackupVolume[];
  showGuest?: boolean;
  canChange: boolean;
  timeZone?: string;
}) {
  const [, set] = useThingSearch();
  const [dialog, setDialog] = useState<Dialog>(null);
  const serverId = detail.server.id;
  const guests = libvirtGuests(detail);
  const now = Date.parse(detail.asOf);
  return (
    <>
      <table className={styles.table}>
        <thead>
          <tr>
            {showGuest ? <th scope="col">VM</th> : null}
            <th scope="col">Made</th>
            <th scope="col">Size</th>
            <th scope="col">Format</th>
            <th scope="col">Folder</th>
            <th scope="col">
              <span className={styles.srOnly}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((b) => {
            const g = libvirtBackupOf(b, guests);
            const t = libvirtBackupTime(b);
            const when = lvBackupWhen(b, timeZone);
            return (
              <tr key={`${b.guest}/${b.volume}`}>
                {showGuest ? (
                  <td>
                    {g ? (
                      <button
                        type="button"
                        className={styles.name}
                        onClick={() => set({ guest: g.id, gtab: 'backups' })}
                      >
                        {g.name}
                      </button>
                    ) : (
                      <span className={styles.mono}>{(b.guest ?? DASH).replace(/^libvirt:/, '')}</span>
                    )}{' '}
                    {g ? null : <span className={styles.kind}>removed</span>}
                  </td>
                ) : null}
                <td className={styles.num}>
                  <span title={t != null ? formatDayTime(t, timeZone, currentLocale()) : undefined}>
                    {t != null ? formatRelativeDay(t, now, timeZone, currentLocale()) : DASH}
                  </span>
                </td>
                <td className={styles.num}>{b.sizeBytes != null ? formatBytesBinary(b.sizeBytes) : DASH}</td>
                <td className={styles.kind}>{b.format ?? DASH}</td>
                <td className={`${styles.mono} ${styles.muted}`} style={{ fontSize: 12.5 }}>
                  {b.volume}
                </td>
                <td>
                  {canChange ? (
                    <span className={wb.wbTools}>
                      <button
                        type="button"
                        className={styles.cardLink}
                        onClick={() => setDialog({ kind: 'restore', backup: b })}
                      >
                        Restore…<span className={styles.srOnly}> the backup of {when}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        aria-label={`Delete the backup of ${when}`}
                        title="Delete"
                        onClick={() => setDialog({ kind: 'delete', backup: b })}
                      >
                        <Icon icon={Trash2} size={14} />
                      </button>
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {dialog?.kind === 'restore' ? (
        <LvRestoreDialog
          burrow={burrow}
          serverId={serverId}
          backup={dialog.backup}
          taken={guests.map((g) => g.name)}
          timeZone={timeZone}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <LvDeleteBackupDialog
          burrow={burrow}
          serverId={serverId}
          backup={dialog.backup}
          backupsDir={detail.libvirt?.backupsDir}
          timeZone={timeZone}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

/** A VM's Backups tab. */
export function LvGuestBackups({
  burrow,
  detail,
  guest,
  canChange,
  timeZone,
}: {
  burrow: string;
  detail: HostServerDetail;
  guest: HostGuest;
  canChange: boolean;
  timeZone?: string;
}) {
  const serverId = detail.server.id;
  const list = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'backup.list', guestId: guest.id, platform: 'libvirt' },
  });
  const [now, setNow] = useState(false);
  const items = list.data?.op === 'backup.list' ? newest(list.data.items) : [];
  const first = items[0];
  const t = first ? libvirtBackupTime(first) : null;
  const dir = detail.libvirt?.backupsDir;
  return (
    <>
      <Card
        title="Backups"
        meta={
          t != null
            ? `${plural(items.length, 'backup')}, newest ${formatRelativeDay(t, Date.parse(detail.asOf), timeZone, currentLocale())}`
            : undefined
        }
        link={
          canChange ? (
            <Button size="sm" style={{ marginLeft: 'auto' }} onClick={() => setNow(true)}>
              Back up now
            </Button>
          ) : undefined
        }
      >
        {list.error ? (
          <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length ? (
          <LvBackupTable
            burrow={burrow}
            detail={detail}
            items={items}
            canChange={canChange}
            timeZone={timeZone}
          />
        ) : (
          <Empty>{list.isLoading ? 'Looking…' : `No backups of ${guest.name} yet.`}</Empty>
        )}
        {dir ? (
          <div className={styles.cardNote}>
            Backups go to <span className={styles.mono}>{`${dir}/${guest.name}`}</span> on {serverId}, each
            with the VM’s settings. A restore always makes a new VM.
          </div>
        ) : null}
      </Card>
      {now ? (
        <LvBackupNowDialog
          burrow={burrow}
          serverId={serverId}
          guest={guest}
          backupsDir={dir}
          onClose={() => setNow(false)}
        />
      ) : null}
    </>
  );
}

/** A QEMU/KVM server's Backups tab: every VM's backups, and the VMs without one. */
export function LvServerBackups({
  burrow,
  detail,
  canChange,
  timeZone,
}: {
  burrow: string;
  detail: HostServerDetail;
  canChange: boolean;
  timeZone?: string;
}) {
  const serverId = detail.server.id;
  const manage = detail.server.remoteControl.manage === true;
  const list = useHostManageRead(
    manage ? { params: { burrow, serverId }, query: { op: 'backup.list', platform: 'libvirt' } } : null,
  );
  const [backup, setBackup] = useState<HostGuest | null>(null);
  const items = list.data?.op === 'backup.list' ? newest(list.data.items) : [];
  const guests = libvirtGuests(detail);
  const bare = guests.filter((g) => !items.some((b) => libvirtBackupOf(b, [g])));
  const dir = detail.libvirt?.backupsDir;
  return (
    <>
      {manage && list.data && bare.length ? (
        <Card title="Not backed up yet" meta={plural(bare.length, 'VM')}>
          <div className={styles.rows}>
            {bare.map((g) => (
              <div key={g.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <b className={styles.mono} style={{ fontWeight: 400 }}>
                    {g.name}
                  </b>
                  <small>
                    {g.state === 'stopped' ? 'Switched off' : 'Running'} · no backup in the backups folder
                  </small>
                </div>
                {canChange ? (
                  <Button size="sm" onClick={() => setBackup(g)}>
                    Back up now
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      <Card
        title="Backups"
        meta={items.length ? `${plural(items.length, 'backup')} in the backups folder` : undefined}
      >
        {!manage ? (
          <Empty>Changing guests is switched off for this server, so its backups aren’t listed.</Empty>
        ) : list.error ? (
          <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length ? (
          <LvBackupTable
            burrow={burrow}
            detail={detail}
            items={items}
            showGuest
            canChange={canChange}
            timeZone={timeZone}
          />
        ) : (
          <Empty>{list.isLoading ? 'Looking…' : 'No VM backups on this server yet.'}</Empty>
        )}
        {dir ? (
          <div className={styles.cardNote}>
            Backups go to <span className={styles.mono}>{dir}</span>, one folder per VM with its settings.
          </div>
        ) : null}
      </Card>
      {backup ? (
        <LvBackupNowDialog
          burrow={burrow}
          serverId={serverId}
          guest={backup}
          backupsDir={dir}
          onClose={() => setBackup(null)}
        />
      ) : null}
    </>
  );
}
