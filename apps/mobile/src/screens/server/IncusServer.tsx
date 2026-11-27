/**
 * An Incus server's Backups segment on the phone (Whombat incus-unraid.md IU-04, IU-08, IU-09; incus-unraid-mobile.md
 * AP-1632, AP-1633): every instance's backups, newest first, each opening Restore as a new instance or Remove it, and
 * the instances without a snapshot schedule, each opening its Snapshots. What Incus is and its storage pools are on the
 * Summary (`serverDashboard`, dashboards-mobile.md AP-2130).
 */

import { backupGuestName, incusBackupRows, noScheduleGuests } from '@whombat/client/hosts/mobile';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostBackupVolume, HostGuest, HostHint } from '@whombat/core';
import { useState } from 'react';
import { useI18n, useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Dot, OneCard, OneRow } from '../../ui/assistant';
import { ErrorState, SkeletonRows } from '../../ui/primitives';
import { IncusBackupSheet } from '../guest/IncusBackups';
import { CardQuiet } from '../guest/parts';

export function IncusServerBackups({
  slug,
  serverId,
  hints,
  guests,
  now,
  timeZone,
  canChange,
  onOpenGuest,
}: {
  slug: string;
  serverId: string;
  hints: readonly HostHint[];
  guests: readonly HostGuest[];
  now: number;
  timeZone: string;
  canChange: boolean;
  onOpenGuest: (g: HostGuest, tab: 'snapshots' | 'backups') => void;
}) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const list = useHostManageRead(
    { params: { burrow: slug, serverId }, query: { op: 'backup.list', platform: 'incus' } },
    { retry: false },
  );
  const [open, setOpen] = useState<HostBackupVolume | null>(null);
  const incus = guests.filter((g) => g.platform === 'incus');
  const rows =
    list.data?.op === 'backup.list'
      ? incusBackupRows(list.data.items, now, timeZone, (b) => backupGuestName(b, incus), rawLocale)
      : [];
  const unscheduled = noScheduleGuests(hints, serverId, incus);
  const owner = open ? incus.find((g) => g.id === open.guest || g.name === open.guest) : undefined;
  return (
    <>
      {unscheduled.length ? (
        <OneCard label={tMobile('screens.no-snapshot-schedule')}>
          {unscheduled.map((g, i) => (
            <OneRow
              key={g.id}
              first={i === 0}
              leading={<Dot tone={null} />}
              title={g.name}
              titleMono
              line={tMobile('screens2.server.incusNoBackup')}
              chevron
              label={tMobile('screens2.server.incusNoBackupName', { name: g.name })}
              hint={tMobile('screens.opens-its-snapshots-to-set-a-schedule')}
              onPress={() => onOpenGuest(g, 'snapshots')}
            />
          ))}
        </OneCard>
      ) : null}
      {list.isPending ? (
        <SkeletonRows count={4} lines={2} label={tMobile('screens.loading-the-backups')} />
      ) : list.isError ? (
        <ErrorState text={tMobile('screens.the-backups-didnt-load')} onRetry={() => void list.refetch()} />
      ) : (
        <OneCard label={tMobile('screens.latest-backups')}>
          {rows.length ? (
            rows.map((r) => (
              <OneRow
                key={`${r.backup.guest}/${r.volume}`}
                title={r.title}
                line={r.name}
                meta={r.line}
                chevron={canChange}
                label={r.label}
                {...(canChange
                  ? { hint: tMobile('screens2.backups.restoreOrRemove'), onPress: () => setOpen(r.backup) }
                  : {})}
              />
            ))
          ) : (
            <CardQuiet>{tMobile('screens.no-backups-yet')}</CardQuiet>
          )}
        </OneCard>
      )}
      <Text size={13} lh={1.45} color={theme.colors.mut}>
        {tMobile('screens.back-up-an-instance-from-its-own-page')}
      </Text>
      {open ? (
        <IncusBackupSheet
          serverId={serverId}
          guestId={owner?.id ?? open.guest ?? ''}
          guestName={owner?.name ?? backupGuestName(open, incus) ?? tMobile('screens2.server.theInstance')}
          backup={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
