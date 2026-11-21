/**
 * A guest's backups (ported from Rackoon's `BackupsTab`; PX-01, PX-03): Back up now, a line when no backup job covers
 * it with Add to a backup job, and the list on every backup storage of the server, newest first, each restorable,
 * protectable, with notes and Delete (`manage/BackupTable.tsx`).
 */
import { formatRelativeDay, plural } from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostGuest } from '@whombat/core/domain';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { AddToJobDialog } from '../manage/BackupJobs';
import { BackupTable } from '../manage/BackupTable';
import { BackupNowDialog } from '../manage/GuestDialogs';
import { Card, Empty, ErrorLine } from '../parts';
import styles from '../Things.module.css';
import wb from '../wb.module.css';
import type { GuestTabProps } from './tabProps';

export function BackupsTab({
  burrow,
  serverId,
  guest,
  guests = [],
  timeZone,
}: GuestTabProps & { guests?: readonly HostGuest[] }) {
  const list = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'backup.list', guestId: guest.id, platform: 'pve' },
  });
  const [dialog, setDialog] = useState<'now' | 'job' | null>(null);
  const items =
    list.data?.op === 'backup.list'
      ? [...list.data.items].sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
      : [];
  const newest = items[0]?.created;
  return (
    <>
      {guest.backupJob === false ? (
        <div className={styles.notice}>
          <div className={wb.wbNote} style={{ flex: 1 }}>
            <Icon icon={Info} size={16} />
            <span>No backup plan covers {guest.name}: Proxmox only backs it up when someone asks.</span>
          </div>
          <Button size="sm" onClick={() => setDialog('job')}>
            Add to a backup job
          </Button>
        </div>
      ) : null}
      <Card
        title="Backups"
        meta={
          newest
            ? `${plural(items.length, 'backup')}, newest ${formatRelativeDay(Date.parse(newest), Date.now(), timeZone)}`
            : undefined
        }
        link={
          <Button size="sm" style={{ marginLeft: 'auto' }} onClick={() => setDialog('now')}>
            Back up now
          </Button>
        }
      >
        {list.error ? (
          <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length ? (
          <BackupTable
            burrow={burrow}
            serverId={serverId}
            items={items}
            guestOf={() => guest}
            timeZone={timeZone}
          />
        ) : (
          <Empty>{list.isLoading ? 'Looking…' : `No backups of ${guest.name} yet.`}</Empty>
        )}
      </Card>
      {dialog === 'now' ? (
        <BackupNowDialog burrow={burrow} serverId={serverId} guest={guest} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'job' ? (
        <AddToJobDialog
          burrow={burrow}
          serverId={serverId}
          guest={guest}
          guests={guests}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
