/**
 * A guest's Backups on the phone (proxmox-mobile.md AP-1496): Back up now and the list, newest first, with its size,
 * where it is and whether it is kept. A backup opens its sheet: Restore as a new guest (a new id, start it or not),
 * Restore over this guest (asked; only while it is switched off), and Keep it until I remove it / Stop keeping it.
 */

import { formatRelativeDay } from '@whombat/client/hosts';
import { backupRows, newIdCheck } from '@whombat/client/hosts/mobile';
import { useHostManageRead } from '@whombat/client/hosts/react';
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

type Open = { backup: HostBackupVolume; step: 'choose' | 'new' | 'over' };

export function GuestBackups({
  slug,
  serverId,
  guest,
  now,
  timeZone,
  canChange,
  onBackUp,
}: {
  slug: string;
  serverId: string;
  guest: HostGuestDetail;
  now: number;
  timeZone: string;
  canChange: boolean;
  onBackUp: () => void;
}) {
  const { t: tMobile } = useMobileT();
  const q = useHostManageRead(
    { params: { burrow: slug, serverId }, query: { op: 'backup.list', guestId: guest.id, platform: 'pve' } },
    { retry: false },
  );
  const [open, setOpen] = useState<Open | null>(null);
  const rows = q.data?.op === 'backup.list' ? backupRows(q.data.items, now, timeZone) : [];
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
                line={r.notes || null}
                meta={r.line}
                chevron={canChange}
                label={r.label}
                {...(canChange
                  ? {
                      hint: 'Restore it or keep it',
                      onPress: () => setOpen({ backup: r.backup, step: 'choose' }),
                    }
                  : {})}
              />
            ))
          ) : (
            <CardQuiet>{tMobile('screens.no-backups-of-this-guest-yet')}</CardQuiet>
          )}
        </OneCard>
      )}
      {open ? (
        <BackupSheet
          serverId={serverId}
          guest={guest}
          open={open}
          onOpen={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

function BackupSheet({
  serverId,
  guest,
  open,
  onOpen,
  onClose,
}: {
  serverId: string;
  guest: HostGuestDetail;
  open: Open;
  onOpen: (o: Open) => void;
  onClose: () => void;
}) {
  const { rawLocale } = useI18n();

  const { t: tMobile } = useMobileT();
  const { slug, clock, timeZone } = useBurrowBase();
  const b = open.backup;
  const when = b.created
    ? formatRelativeDay(Date.parse(b.created), clock().getTime(), timeZone, rawLocale)
    : 'this backup';
  const { send, busy } = useManageChange(serverId);
  const [error, setError] = useState<string | null>(null);
  const [newId, setNewId] = useState('');
  const [start, setStart] = useState(false);
  const choices = useHostManageRead(
    open.step === 'new'
      ? { params: { burrow: slug, serverId }, query: { op: 'choices', platform: 'pve' } }
      : null,
    { retry: false },
  );
  const next = choices.data?.op === 'choices' ? choices.data.choices.nextId : undefined;
  const done = (o: Awaited<ReturnType<typeof send>>) => {
    if (o.ok || o.waiting) onClose();
    else setError(o.message);
  };

  if (open.step === 'choose')
    return (
      <OneSheet
        visible
        onClose={() => !busy && onClose()}
        badge={`${b.storage}${b.protected ? ' · kept' : ''}`}
        title={`The backup from ${when}`}
        busy={busy ? 'keep' : null}
        buttons={[
          {
            id: 'new',
            label: 'Restore as a new guest',
            variant: 'secondary',
            onPress: () => onOpen({ ...open, step: 'new' }),
          },
          {
            id: 'over',
            label: `Restore over ${guest.name}`,
            variant: 'secondary',
            onPress: () => onOpen({ ...open, step: 'over' }),
          },
          {
            id: 'keep',
            label: b.protected ? 'Stop keeping it' : 'Keep it until I remove it',
            variant: 'secondary',
            onPress: () =>
              void send({
                op: 'backup.update',
                params: { platform: 'pve', volume: b.volume, protected: !b.protected },
                name: guest.name,
                done: b.protected
                  ? 'The backup is no longer kept.'
                  : 'The backup is kept until you remove it.',
              }).then(done),
          },
          { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
        ]}
        note={error}
      />
    );

  if (open.step === 'over') {
    const running = guest.state !== 'stopped';
    return (
      <OneSheet
        visible
        onClose={() => !busy && onClose()}
        badge={guest.name}
        tone="bad"
        title={`Restore ${guest.name} from ${when}?`}
        body={`${guest.name} goes back to how it was then. What changed since is lost.`}
        busy={busy ? 'go' : null}
        buttons={[
          {
            id: 'go',
            label: 'Restore',
            variant: 'primary',
            disabled: running,
            onPress: () =>
              void send({
                op: 'backup.restore',
                guestId: guest.id,
                params: { platform: 'pve', volume: b.volume, guest: guest.id, start: false },
                confirm: true,
                name: guest.name,
              }).then(done),
          },
          { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
        ]}
        note={error ?? (running ? `Shut ${guest.name} down first.` : null)}
      />
    );
  }

  const id = newIdCheck(newId, next);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={`Restore ${guest.name} from ${when}`}
      body={tMobile('screens.a-new-guest-is-made-from-the-backup')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: 'Restore',
          variant: 'primary',
          disabled: id.id == null,
          onPress: () =>
            void send({
              op: 'backup.restore',
              params: { platform: 'pve', volume: b.volume, newId: id.id, unique: true, start },
              confirm: true,
              name: guest.name,
            }).then(done),
        },
        { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    >
      <View style={{ gap: 14, marginTop: 16 }}>
        <FormField
          label={tMobile('screens.new-id')}
          value={newId}
          onChangeText={setNewId}
          placeholder={next ? String(next) : undefined}
          hint={next ? `Empty: ${next}, the next free one.` : null}
          error={newId.trim() ? id.error : null}
          mono
          keyboardType="number-pad"
        />
        <SwitchLine label={tMobile('screens.start-it-afterwards')} value={start} onChange={setStart} />
      </View>
    </OneSheet>
  );
}
