/**
 * What an Incus instance's or a libvirt VM's Summary adds on the phone (Whombat incus-unraid.md IU-08, IU-09, IU-13;
 * incus-unraid-mobile.md AP-1620, AP-1643): NEEDS A LOOK with its hint and the way out (Incus: no snapshot schedule
 * and no recent backup → Set a schedule; libvirt: no recent backup → Back it up), SNAPSHOTS with an Incus schedule in
 * words and Change, and BACKUPS with the last one and Back up now.
 */
import { formatRelativeDay } from '@whombat/client/hosts';
import {
  hintGuest,
  incusBackupRows,
  incusHintWayOut,
  incusScheduleLine,
  libvirtBackupRows,
  libvirtHintWayOut,
} from '@whombat/client/hosts/mobile';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostGuestConfig, HostGuestDetail, HostHint } from '@whombat/core';
import { View } from 'react-native';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { BigButton, Dot, OneCard } from '../../ui/assistant';
import { RowAction, SettingLine } from './parts';

export type IncusWayOut = 'schedule' | 'back_up';

export function IncusSummary({
  slug,
  serverId,
  platform = 'incus',
  guest: g,
  config,
  hints,
  now,
  timeZone,
  canChange,
  canBackUp,
  onWayOut,
}: {
  slug: string;
  serverId: string;
  platform?: 'incus' | 'libvirt';
  guest: HostGuestDetail;
  config: HostGuestConfig | undefined;
  /** The server's hints (its page's). */
  hints: readonly HostHint[];
  now: number;
  timeZone: string;
  /** May change its settings (Manage on, not this Whombat itself). */
  canChange: boolean;
  /** May back it up (this Whombat's own too). */
  canBackUp: boolean;
  onWayOut: (to: IncusWayOut) => void;
}) {
  const theme = useTheme();
  const list = useHostManageRead(
    g.manageable
      ? { params: { burrow: slug, serverId }, query: { op: 'backup.list', guestId: g.id, platform } }
      : null,
    { retry: false },
  );
  const wayOutOf = (kind: string) =>
    platform === 'libvirt'
      ? libvirtHintWayOut(kind) && { label: 'Back up now', to: 'back_up' as const }
      : incusHintWayOut(kind) && { label: 'Set a schedule', to: 'schedule' as const };
  const mine = hints.filter((h) => h.serverId === serverId && hintGuest(h, [g]) && wayOutOf(h.kind));
  const schedule = incusScheduleLine(config);
  const items = list.data?.op === 'backup.list' ? list.data.items : [];
  const last = (
    platform === 'libvirt' ? libvirtBackupRows(items, now, timeZone) : incusBackupRows(items, now, timeZone)
  )[0];
  return (
    <>
      {mine.length ? (
        <OneCard label="Needs a look">
          {mine.map((h, i) => {
            const out = wayOutOf(h.kind);
            return (
              <View
                key={`${h.kind}:${h.entity}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingVertical: 11,
                  paddingHorizontal: 14,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: theme.colors.line,
                }}
              >
                <View
                  accessible
                  accessibilityLabel={`${h.title}. ${h.detail}`}
                  style={{ flex: 1, flexDirection: 'row', gap: 12 }}
                >
                  <View style={{ paddingTop: 6 }}>
                    <Dot tone={h.severity === 'warning' ? 'warn' : null} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text size={15} weight={600}>
                      {h.title}
                    </Text>
                    <Text size={13} lh={1.4} color={theme.colors.mut}>
                      {h.detail}
                    </Text>
                  </View>
                </View>
                {out && canChange ? (
                  <RowAction label={out.label} spoken={out.label} onPress={() => onWayOut(out.to)} />
                ) : null}
              </View>
            );
          })}
        </OneCard>
      ) : null}
      {config && platform === 'incus' ? (
        <OneCard label="Snapshots">
          <SettingLine
            first
            label="Schedule"
            value={schedule.text}
            action={
              canChange ? (
                <RowAction
                  label="Change"
                  spoken="Change the snapshot schedule"
                  onPress={() => onWayOut('schedule')}
                />
              ) : null
            }
          />
        </OneCard>
      ) : null}
      {g.manageable ? (
        <OneCard label="Backups">
          <SettingLine
            first
            label="Last backup"
            value={
              last
                ? last.title
                : list.isPending
                  ? '…'
                  : g.lastBackup
                    ? formatRelativeDay(Date.parse(g.lastBackup.at), now, timeZone)
                    : 'None yet'
            }
            sub={last?.line ?? null}
          />
          {canBackUp ? (
            <View style={{ padding: 14, paddingTop: 4 }}>
              <BigButton label="Back up now" variant="secondary" onPress={() => onWayOut('back_up')} />
            </View>
          ) : null}
        </OneCard>
      ) : null}
    </>
  );
}
