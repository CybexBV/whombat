/**
 * A QEMU/KVM server's Backups segment on the phone (Whombat incus-unraid.md IU-13; incus-unraid-mobile.md AP-1646):
 * every VM's backups, newest first, each opening Restore as a new VM or Remove it, and the VMs without a recent backup,
 * each opening its Backups. What libvirt is and its storage pools are on the Summary (`serverDashboard`,
 * dashboards-mobile.md AP-2130).
 */

import { backupGuestName, libvirtBackupRows, noBackupGuests } from '@whombat/client/hosts/mobile';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostBackupVolume, HostGuest, HostHint } from '@whombat/core';
import { useState } from 'react';
import { useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Dot, OneCard, OneRow } from '../../ui/assistant';
import { ErrorState, SkeletonRows } from '../../ui/primitives';
import { IncusBackupSheet } from '../guest/IncusBackups';
import { CardQuiet } from '../guest/parts';

export function LibvirtServerBackups({
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
  onOpenGuest: (g: HostGuest, tab: 'backups') => void;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const list = useHostManageRead(
    { params: { burrow: slug, serverId }, query: { op: 'backup.list', platform: 'libvirt' } },
    { retry: false },
  );
  const [open, setOpen] = useState<HostBackupVolume | null>(null);
  const vms = guests.filter((g) => g.platform === 'libvirt');
  const rows =
    list.data?.op === 'backup.list'
      ? libvirtBackupRows(list.data.items, now, timeZone, (b) => backupGuestName(b, vms))
      : [];
  const without = noBackupGuests(hints, serverId, vms);
  const owner = open ? vms.find((g) => g.id === open.guest || g.name === open.guest) : undefined;
  return (
    <>
      {without.length ? (
        <OneCard label={tMobile('screens.no-recent-backup')}>
          {without.map((g, i) => (
            <OneRow
              key={g.id}
              first={i === 0}
              leading={<Dot tone={null} />}
              title={g.name}
              titleMono
              line="No backup or snapshot in 30 days"
              chevron
              label={`${g.name}: no backup or snapshot in 30 days`}
              hint={tMobile('screens.opens-its-backups')}
              onPress={() => onOpenGuest(g, 'backups')}
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
                line={r.line || null}
                chevron={canChange}
                label={r.label}
                {...(canChange ? { hint: 'Restore it or remove it', onPress: () => setOpen(r.backup) } : {})}
              />
            ))
          ) : (
            <CardQuiet>{tMobile('screens.no-backups-yet')}</CardQuiet>
          )}
        </OneCard>
      )}
      <Text size={13} lh={1.45} color={theme.colors.mut}>
        {tMobile('screens.back-up-a-vm-from-its-own-page')}
      </Text>
      {open ? (
        <IncusBackupSheet
          serverId={serverId}
          platform="libvirt"
          guestId={owner?.id ?? open.guest ?? ''}
          guestName={owner?.name ?? backupGuestName(open, vms) ?? 'the VM'}
          backup={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
