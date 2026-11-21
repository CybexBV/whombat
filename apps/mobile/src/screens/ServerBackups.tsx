/**
 * A Proxmox server's Backups on the phone (Whombat proxmox.md PX-03, PX-06; proxmox-mobile.md AP-1498, AP-1499):
 * the last run and the next (the server's page), its backup jobs — when it runs, where to, what it covers, its next
 * run — each with Run now and Pause or Resume (on Whombats with `hosts.backup_jobs`; making, changing and deleting a
 * job stay on the web), and the latest backups by guest. Running a job says when it starts and when it ends.
 */
import { formatRelativeDay } from '@whombat/client/hosts';
import { type BackupJobRowView, backupJobRows, latestBackups } from '@whombat/client/hosts/mobile';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostBackupJob, HostGuest, HostServerDetail } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Dot, OneCard, OneRow } from '../ui/assistant';
import { Facts } from '../ui/facts';
import { OneSheet } from '../ui/oneSheet';
import { ErrorState, SkeletonRows } from '../ui/primitives';
import { CardQuiet } from './guest/parts';
import { useManageChange } from './guest/useServerChange';

export function ServerBackups({
  slug,
  serverId,
  serverName,
  detail,
  guests,
  now,
  timeZone,
  canChange,
  jobs,
}: {
  slug: string;
  serverId: string;
  serverName: string;
  detail: HostServerDetail | null;
  guests: readonly HostGuest[];
  now: number;
  timeZone: string;
  canChange: boolean;
  /** This Whombat has backup jobs (`hosts.backup_jobs`). */
  jobs: boolean;
}) {
  const theme = useTheme();
  const list = useHostManageRead(
    { params: { burrow: slug, serverId }, query: { op: 'backup.list', platform: 'pve' } },
    { retry: false },
  );
  const jobsQ = useHostManageRead(
    jobs ? { params: { burrow: slug, serverId }, query: { op: 'backupjob.list', platform: 'pve' } } : null,
    { retry: false },
  );
  const [open, setOpen] = useState<BackupJobRowView<HostBackupJob> | null>(null);
  const b = detail?.proxmox?.backups ?? null;
  const facts: { label: string; value: string }[] = [];
  if (b?.lastJob)
    facts.push({
      label: 'Last run',
      value: `${formatRelativeDay(Date.parse(b.lastJob.at), now, timeZone)} · ${b.lastJob.guestsOk} of ${b.lastJob.guestsTotal} guests${b.lastJob.result === 'ok' ? ', went fine' : `, ${b.lastJob.result}`}`,
    });
  if (b?.nextRun)
    facts.push({ label: 'Next run', value: formatRelativeDay(Date.parse(b.nextRun), now, timeZone) });
  if (b?.target) facts.push({ label: 'Saves to', value: b.target });
  const items: HostBackupJob[] = jobsQ.data?.op === 'backupjob.list' ? jobsQ.data.items : [];
  const jobRows = backupJobRows(items, guests, now, timeZone);
  const latest = list.data?.op === 'backup.list' ? latestBackups(list.data.items, guests, now, timeZone) : [];
  return (
    <>
      {facts.length ? (
        <OneCard label="Backups">
          <View style={{ paddingHorizontal: 14, paddingBottom: 14, paddingTop: 2 }}>
            <Facts facts={facts} />
          </View>
        </OneCard>
      ) : null}
      {jobs ? (
        jobsQ.isPending ? (
          <SkeletonRows count={2} lines={2} label="Loading the backup plans" />
        ) : jobsQ.isError ? (
          <ErrorState text="The backup plans didn’t load." onRetry={() => void jobsQ.refetch()} />
        ) : (
          <OneCard label="Backup jobs">
            {jobRows.length ? (
              jobRows.map((r) => (
                <OneRow
                  key={r.id}
                  leading={<Dot tone={r.enabled ? 'ok' : null} />}
                  title={r.title}
                  line={r.line}
                  meta={r.next}
                  chevron={canChange}
                  label={r.label}
                  {...(canChange ? { hint: 'Run it now, or pause it', onPress: () => setOpen(r) } : {})}
                />
              ))
            ) : (
              <CardQuiet>{`No backup plan on ${serverName} yet. Ask your assistant to make one, or make one in Whombat on a computer.`}</CardQuiet>
            )}
          </OneCard>
        )
      ) : null}
      {list.isPending ? (
        <SkeletonRows count={4} lines={2} label="Loading the backups" />
      ) : list.isError ? (
        <ErrorState text="The backups didn’t load." onRetry={() => void list.refetch()} />
      ) : (
        <OneCard label="Latest backups">
          {latest.length ? (
            latest.map((r) => (
              <OneRow key={r.volume} title={r.title} line={r.notes || null} meta={r.line} label={r.label} />
            ))
          ) : (
            <CardQuiet>No backups yet.</CardQuiet>
          )}
        </OneCard>
      )}
      <Text size={13} lh={1.45} color={theme.colors.mut}>
        Making, changing and deleting backup plans: in Whombat on a computer.
      </Text>
      {open ? (
        <JobSheet serverId={serverId} serverName={serverName} row={open} onClose={() => setOpen(null)} />
      ) : null}
    </>
  );
}

/** A job's sheet: Run now (a task; it says when it ends) and Pause or Resume (with the job's digest). */
function JobSheet({
  serverId,
  serverName,
  row,
  onClose,
}: {
  serverId: string;
  serverName: string;
  row: BackupJobRowView<HostBackupJob>;
  onClose: () => void;
}) {
  const { send, busy } = useManageChange(serverId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = row.job;
  const go = (id: string, p: Promise<Awaited<ReturnType<typeof send>>>) => {
    setBusyId(id);
    void p.then((o) => {
      setBusyId(null);
      if (o.ok || o.waiting) onClose();
      else setError(o.message);
    });
  };
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={row.enabled ? row.next : 'Paused'}
      tone={row.enabled ? 'ok' : 'mut'}
      title={row.title}
      body={row.line}
      busy={busy ? busyId : null}
      buttons={[
        {
          id: 'run',
          label: 'Run now',
          variant: 'primary',
          onPress: () =>
            go('run', send({ op: 'backupjob.run', params: { jobId: job.id }, name: serverName })),
        },
        {
          id: 'toggle',
          label: row.enabled ? 'Pause it' : 'Resume it',
          variant: 'secondary',
          onPress: () =>
            go(
              'toggle',
              send({
                op: 'backupjob.update',
                params: { jobId: job.id, enabled: !row.enabled },
                ...(job.digest ? { digest: job.digest } : {}),
                name: serverName,
                done: row.enabled
                  ? 'The backup plan is paused.'
                  : 'The backup plan runs on its schedule again.',
              }),
            ),
        },
        { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    />
  );
}
