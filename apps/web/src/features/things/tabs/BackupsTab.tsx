/**
 * A server's Backups (ported from Rackoon's `Proxmox.tsx` BackupsSection and `BackupsTab`; PX-01, PX-03): its backup
 * jobs (create, edit, pause, run, delete), how the last job run went and when
 * the next is, then the backups on its storages, newest first, each restorable, protectable, with notes and Delete.
 * Servers without Proxmox backups say so.
 */
import { DASH, detailGuests, formatGb, formatNum, formatRelativeDay } from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostBackupVolume } from '@whombat/core/domain';
import { BackupJobsCard } from '../manage/BackupJobs';
import { BackupTable } from '../manage/BackupTable';
import { Card, Empty, ErrorLine, StateCell } from '../parts';
import styles from '../Things.module.css';
import type { TabProps } from './tabProps';

export function BackupsTab({ burrow, serverId, detail, timeZone }: TabProps) {
  const backups = detail.proxmox?.backups ?? null;
  const pve = detail.server.platform === 'proxmox';
  const manage = detail.server.remoteControl.manage === true;
  const list = useHostManageRead(
    pve && manage ? { params: { burrow, serverId }, query: { op: 'backup.list', platform: 'pve' } } : null,
  );
  const now = Date.parse(detail.asOf);
  if (!pve)
    return (
      <Card title="Backups">
        <Empty>Whombat backs up Proxmox guests; this server’s own backups aren’t visible here.</Empty>
      </Card>
    );
  const job = backups?.lastJob ?? null;
  const guests = detailGuests(detail);
  const guestOf = (b: HostBackupVolume) => guests.find((x) => String(x.vmid) === b.guest);
  const items =
    list.data?.op === 'backup.list'
      ? [...list.data.items].sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
      : [];
  return (
    <>
      {manage ? (
        <BackupJobsCard burrow={burrow} serverId={serverId} detail={detail} timeZone={timeZone} />
      ) : null}
      <Card title={manage ? 'Last job run' : 'Backup job'} meta={job ? job.schedule : undefined}>
        {job ? (
          <div className={styles.facts2}>
            <Fact label="Last run" value={formatRelativeDay(Date.parse(job.at), now, timeZone)}>
              <StateCell
                tone={job.result === 'ok' ? 'ok' : job.result === 'warning' ? 'warn' : 'bad'}
                text={job.result === 'ok' ? 'went fine' : job.result}
              />
            </Fact>
            <Fact
              label="Guests"
              value={`${job.guestsOk} of ${job.guestsTotal}`}
              note={job.warnings ? `${job.warnings} warnings` : 'backed up'}
            />
            <Fact
              label="Written"
              value={formatGb(job.writtenGb)}
              note={job.dedupRatio != null ? `${formatNum(job.dedupRatio)}× smaller` : undefined}
            />
            <Fact
              label="Took"
              value={`${job.durationMin} min`}
              note={job.avgDurationMinWeek != null ? `usually ${job.avgDurationMinWeek} min` : undefined}
            />
            <Fact
              label="Next run"
              value={backups?.nextRun ? formatRelativeDay(Date.parse(backups.nextRun), now, timeZone) : DASH}
            />
            <Fact label="Saved on" value={backups?.target ?? DASH} />
          </div>
        ) : (
          <Empty>No backup plan has run on this server.</Empty>
        )}
      </Card>
      <Card title="Backups" meta={items.length ? `${items.length} on its storages` : undefined}>
        {!manage ? (
          <Empty>Changing guests is switched off for this server, so its backups aren’t listed.</Empty>
        ) : list.error ? (
          <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length ? (
          <BackupTable
            burrow={burrow}
            serverId={serverId}
            items={items.slice(0, 60)}
            guestOf={guestOf}
            showGuest
            timeZone={timeZone}
          />
        ) : (
          <Empty>{list.isLoading ? 'Looking…' : 'No backups on this server’s storages.'}</Empty>
        )}
      </Card>
    </>
  );
}

function Fact({
  label,
  value,
  note,
  children,
}: {
  label: string;
  value: string;
  note?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={styles.fact}>
      <span className={styles.lbl}>{label}</span>
      <b>{value}</b>
      {children ?? (note ? <span>{note}</span> : null)}
    </div>
  );
}
