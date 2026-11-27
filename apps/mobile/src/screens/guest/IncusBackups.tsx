/**
 * An Incus instance's or a libvirt VM's Backups on the phone (Whombat incus-unraid.md IU-04, IU-09, IU-13;
 * incus-unraid-mobile.md AP-1625, AP-1644): Back up now and the list, newest first, with size (and for Incus its format
 * and how long it is kept). A backup opens its sheet: Restore as a new instance or VM (a name, `<name>-restored` first;
 * start it or not — neither platform restores over a guest here) or Remove it (asked). The same sheet serves a
 * server's Backups segment.
 */

import { formatRelativeDay } from '@whombat/client/hosts';
import {
  incusBackupRows,
  incusNewNameError,
  libvirtBackupRows,
  libvirtNameError,
  restoredName,
} from '@whombat/client/hosts/mobile';
import { useHostGuests, useHostManageRead } from '@whombat/client/hosts/react';
import type { HostBackupVolume, HostGuestDetail } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useI18n, useMobileT } from '../../i18n';
import { BigButton, OneCard, OneRow } from '../../ui/assistant';
import { FormField } from '../../ui/formField';
import { OneSheet } from '../../ui/oneSheet';
import { ErrorState, SkeletonRows } from '../../ui/primitives';
import { CardQuiet, SwitchLine } from './parts';
import { useManageChange } from './useServerChange';

type Platform = 'incus' | 'libvirt';

export function IncusBackups({
  slug,
  serverId,
  guest,
  platform = 'incus',
  now,
  timeZone,
  canChange,
  onBackUp,
}: {
  slug: string;
  serverId: string;
  guest: HostGuestDetail;
  platform?: Platform;
  now: number;
  timeZone: string;
  canChange: boolean;
  onBackUp: () => void;
}) {
  const { t: tMobile } = useMobileT();
  const q = useHostManageRead(
    {
      params: { burrow: slug, serverId },
      query: { op: 'backup.list', guestId: guest.id, platform },
    },
    { retry: false },
  );
  const [open, setOpen] = useState<HostBackupVolume | null>(null);
  const items = q.data?.op === 'backup.list' ? q.data.items : [];
  const rows =
    platform === 'libvirt'
      ? libvirtBackupRows(items, now, timeZone).map((r) => ({ ...r, name: r.line, line: null }))
      : incusBackupRows(items, now, timeZone);
  return (
    <>
      {canChange ? (
        <BigButton label={tMobile('screens.back-up-now')} variant="secondary" onPress={onBackUp} />
      ) : null}
      {q.isPending ? (
        <SkeletonRows count={3} lines={2} label={tMobile('screens.loading-the-backups')} />
      ) : q.isError ? (
        <ErrorState text={tMobile('screens.the-backups-didnt-load')} onRetry={() => void q.refetch()} />
      ) : (
        <OneCard label={tMobile('screens.backups')}>
          {rows.length ? (
            rows.map((r) => (
              <OneRow
                key={r.volume}
                title={r.title}
                line={r.name}
                meta={r.line}
                chevron={canChange}
                label={r.label}
                {...(canChange ? { hint: 'Restore it or remove it', onPress: () => setOpen(r.backup) } : {})}
              />
            ))
          ) : (
            <CardQuiet>{`No backups of this ${platform === 'libvirt' ? 'VM' : 'instance'} yet.`}</CardQuiet>
          )}
        </OneCard>
      )}
      {open ? (
        <IncusBackupSheet
          serverId={serverId}
          platform={platform}
          guestId={guest.id}
          guestName={guest.name}
          backup={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

/** A backup's sheet: Restore as a new instance or VM, or Remove it (asked first). */
export function IncusBackupSheet({
  serverId,
  platform = 'incus',
  guestId,
  guestName,
  backup: b,
  onClose,
}: {
  serverId: string;
  platform?: Platform;
  guestId: string;
  guestName: string;
  backup: HostBackupVolume;
  onClose: () => void;
}) {
  const { rawLocale } = useI18n();

  const { t: tMobile } = useMobileT();
  const { slug, clock, timeZone } = useBurrowBase();
  const [step, setStep] = useState<'choose' | 'restore' | 'remove'>('choose');
  const [name, setName] = useState(restoredName(guestName));
  const [start, setStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const guests = useHostGuests(
    step === 'restore' ? { params: { burrow: slug }, query: { server: serverId, limit: 200 } } : null,
    { retry: false },
  );
  const when = b.created
    ? formatRelativeDay(Date.parse(b.created), clock().getTime(), timeZone, rawLocale)
    : 'this backup';
  const word = platform === 'libvirt' ? 'VM' : 'instance';
  const done = (o: Awaited<ReturnType<typeof send>>) => {
    if (o.ok || o.waiting) onClose();
    else setError(o.message);
  };

  if (step === 'choose')
    return (
      <OneSheet
        visible
        onClose={onClose}
        badge={guestName}
        title={`The backup from ${when}`}
        body={b.volume}
        buttons={[
          {
            id: 'restore',
            label: `Restore as a new ${word}`,
            variant: 'secondary',
            onPress: () => setStep('restore'),
          },
          { id: 'remove', label: 'Remove it', variant: 'secondary', onPress: () => setStep('remove') },
          { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
        ]}
      />
    );

  if (step === 'remove')
    return (
      <OneSheet
        visible
        onClose={() => !busy && onClose()}
        badge={guestName}
        tone="bad"
        title={`Remove the backup from ${when}?`}
        body={`It’s gone for good. ${guestName} stays as it is.`}
        busy={busy ? 'go' : null}
        buttons={[
          {
            id: 'go',
            label: 'Remove',
            variant: 'primary',
            onPress: () =>
              void send({
                op: 'backup.delete',
                platform,
                params: { guest: guestId, volume: b.volume },
                confirm: true,
                name: guestName,
              }).then(done),
          },
          { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
        ]}
        note={error}
      />
    );

  const nameError = (platform === 'libvirt' ? libvirtNameError : incusNewNameError)(
    name,
    (guests.data?.guests ?? []).map((g) => g.name),
  );
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={`Restore ${guestName} from ${when}`}
      body={
        platform === 'libvirt'
          ? `A new VM is made from the backup, with its own network addresses; ${guestName} stays as it is.`
          : `A new instance is made from the backup; ${guestName} stays as it is.`
      }
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: 'Restore',
          variant: 'primary',
          disabled: !!nameError,
          onPress: () =>
            void send({
              op: 'backup.restore',
              platform,
              params: { guest: guestId, volume: b.volume, name: name.trim(), start },
              confirm: true,
              name: guestName,
              follow: { kind: 'backup.restore_new', extra: name.trim() },
            }).then(done),
        },
        { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    >
      <View style={{ gap: 14, marginTop: 16 }}>
        <FormField
          label={`Name of the new ${word}`}
          value={name}
          onChangeText={setName}
          error={name.trim() ? nameError : null}
          mono
          autoCapitalize="none"
          autoCorrect={false}
        />
        <SwitchLine label={tMobile('screens.start-it-afterwards')} value={start} onChange={setStart} />
      </View>
    </OneSheet>
  );
}
