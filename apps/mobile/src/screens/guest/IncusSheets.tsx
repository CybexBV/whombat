/**
 * The sheets of an Incus instance's More (Whombat incus-unraid.md IU-04, IU-09; incus-unraid-mobile.md AP-1623,
 * AP-1624): Back up now (a name, how long it is kept, with or without its snapshots), Copy (a name, a pool, with or
 * without its snapshots; the copy starts switched off) and Rename (only while it is switched off; the screen follows
 * it to its new name). Delete is the shared `DeleteSheet`. Each says in plain words what happens; what runs as an
 * Incus task says when it starts and when it ends.
 */

import { BACKUP_KEEP_DAYS, backupNameError, incusBackupName, incusBackupParams } from '@whombat/client/hosts';
import { incusNewNameError, libvirtNameError, stoppedCheck } from '@whombat/client/hosts/mobile';
import { useHostGuests, useHostManageRead } from '@whombat/client/hosts/react';
import { useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useI18n, useMobileT } from '../../i18n';
import { FormField } from '../../ui/formField';
import { OneSheet } from '../../ui/oneSheet';
import type { SheetBase } from './GuestSheets';
import { Choices, SwitchLine } from './parts';
import { type ChangeOutcome, useManageChange } from './useServerChange';

function settle(out: ChangeOutcome, onClose: () => void, setError: (s: string) => void) {
  if (out.ok || out.waiting) onClose();
  else setError(out.message);
}

/** The other guests' names on the server, so a new name isn't taken. */
function useTakenNames(serverId: string): string[] {
  const { slug } = useBurrowBase();
  const q = useHostGuests(
    { params: { burrow: slug }, query: { server: serverId, limit: 200 } },
    { retry: false },
  );
  return (q.data?.guests ?? []).map((g) => g.name);
}

/** Back up now: a name, how long it is kept, and whether its snapshots come too. */
export function IncusBackupNowSheet({ serverId, guest, onClose }: SheetBase) {
  const { t: tMobile } = useMobileT();
  const { clock } = useBurrowBase();
  const [name, setName] = useState(() => incusBackupName(clock().getTime()));
  const [keep, setKeep] = useState('7');
  const [withSnapshots, setWithSnapshots] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const bad = backupNameError(name);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={tMobile('screens2.guest.backUpNowName', { name: guest.name })}
      body={tMobile('screens.the-backup-stays-on-the-server-it-runs')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: tMobile('screens2.common.backUp'),
          variant: 'primary',
          disabled: !!bad,
          onPress: () =>
            void send({
              op: 'backup.create',
              guestId: guest.id,
              platform: 'incus',
              params: incusBackupParams({
                name,
                days: Number(keep),
                instanceOnly: !withSnapshots,
                optimized: false,
                compression: 'zstd',
                now: clock().getTime(),
              }),
              name: guest.name,
            }).then((o) => settle(o, onClose, setError)),
        },
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    >
      <View style={{ gap: 16, marginTop: 16 }}>
        <FormField
          label={tMobile('screens.name')}
          value={name}
          onChangeText={setName}
          error={name.trim() ? bad : null}
          mono
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Choices
          label={tMobile('screens.keep-it-for')}
          options={BACKUP_KEEP_DAYS.map((o) => ({
            value: o.value,
            label: tMobile('screens2.guest.keepDays', { count: Number(o.value) }),
          }))}
          value={keep}
          onChange={setKeep}
        />
        <SwitchLine
          label={tMobile('screens.with-its-snapshots')}
          value={withSnapshots}
          onChange={setWithSnapshots}
        />
      </View>
    </OneSheet>
  );
}

/** Copy: a full copy under a new name, on a pool; it starts switched off. */
export function CopySheet({ serverId, guest, onClose }: SheetBase) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const { slug } = useBurrowBase();
  const taken = useTakenNames(serverId);
  const choices = useHostManageRead(
    { params: { burrow: slug, serverId }, query: { op: 'choices', platform: 'incus' } },
    { retry: false },
  );
  const pools = choices.data?.op === 'choices' ? choices.data.choices.storages.map((s) => s.id) : [];
  const [name, setName] = useState(`${guest.name}-copy`);
  const [pool, setPool] = useState('');
  const [withSnapshots, setWithSnapshots] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const nameError = incusNewNameError(name, taken, undefined, rawLocale);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={tMobile('screens2.guest.copyName', { name: guest.name })}
      body={tMobile('screens.a-full-copy-with-its-own-disks-in')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: tMobile('screens2.common.copy'),
          variant: 'primary',
          disabled: !!nameError,
          onPress: () =>
            void send({
              op: 'guest.clone',
              guestId: guest.id,
              platform: 'incus',
              params: {
                name: name.trim(),
                ...(pool ? { storage: pool } : {}),
                ...(withSnapshots ? {} : { instanceOnly: true }),
              },
              name: guest.name,
              follow: { kind: 'guest.copy' },
            }).then((o) => settle(o, onClose, setError)),
        },
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    >
      <View style={{ gap: 16, marginTop: 16 }}>
        <FormField
          label={tMobile('screens.name')}
          value={name}
          onChangeText={setName}
          error={name.trim() ? nameError : null}
          mono
          autoCapitalize="none"
          autoCorrect={false}
        />
        {pools.length ? (
          <Choices
            label={tMobile('screens.on-the-pool')}
            options={[
              { value: '', label: tMobile('screens2.guest.sameAsNow') },
              ...pools.map((p) => ({ value: p, label: p })),
            ]}
            value={pool}
            onChange={setPool}
          />
        ) : null}
        <SwitchLine
          label={tMobile('screens.with-its-snapshots')}
          value={withSnapshots}
          onChange={setWithSnapshots}
        />
      </View>
    </OneSheet>
  );
}

/**
 * Rename an Incus instance or a libvirt VM (IU-13): only while it is switched off; `onRenamed` gets the new id so the
 * screen follows it.
 */
export function RenameSheet({
  serverId,
  guest,
  platform = 'incus',
  onClose,
  onRenamed,
}: SheetBase & { platform?: 'incus' | 'libvirt'; onRenamed: (id: string, name: string) => void }) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const taken = useTakenNames(serverId);
  const [name, setName] = useState(guest.name);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const running = stoppedCheck(guest, rawLocale);
  const nameError = (platform === 'libvirt' ? libvirtNameError : incusNewNameError)(
    name,
    taken,
    guest.name,
    rawLocale,
  );
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={tMobile('screens2.guest.renameName', { name: guest.name })}
      body={tMobile('screens.its-snapshots-and-backups-go-with-it')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: tMobile('screens2.common.rename'),
          variant: 'primary',
          disabled: !!nameError || !!running,
          onPress: () =>
            void send({
              op: 'guest.rename',
              guestId: guest.id,
              platform,
              params: { name: name.trim() },
              name: guest.name,
              follow: { kind: 'guest.rename', extra: name.trim() },
            }).then((o) => {
              if (o.ok && o.result?.newId) onRenamed(o.result.newId, name.trim());
              settle(o, onClose, setError);
            }),
        },
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error ?? running}
    >
      <View style={{ marginTop: 16 }}>
        <FormField
          label={tMobile('screens.new-name')}
          value={name}
          onChangeText={setName}
          error={name.trim() && name.trim() !== guest.name ? nameError : null}
          mono
          autoCapitalize="none"
          autoCorrect={false}
          editable={!running}
        />
      </View>
    </OneSheet>
  );
}
