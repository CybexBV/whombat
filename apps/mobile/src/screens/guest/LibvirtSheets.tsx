/**
 * The sheets of a libvirt VM's More (Whombat incus-unraid.md IU-13; incus-unraid-mobile.md AP-1644): Back up now
 * (libvirt's own backup into the server's backups folder, while it runs or not) and Clone (only while it is switched
 * off: a name and where its disks go; the copy gets its own network addresses). Rename and Delete are the shared
 * sheets. What runs as a libvirt task says when it starts and when it ends.
 */

import { libvirtNameError, stoppedCheck } from '@whombat/client/hosts/mobile';
import { useHostGuests, useHostManageRead } from '@whombat/client/hosts/react';
import { useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useI18n, useMobileT } from '../../i18n';
import { FormField } from '../../ui/formField';
import { OneSheet } from '../../ui/oneSheet';
import type { SheetBase } from './GuestSheets';
import { Choices } from './parts';
import { type ChangeOutcome, useManageChange } from './useServerChange';

function settle(out: ChangeOutcome, onClose: () => void, setError: (s: string) => void) {
  if (out.ok || out.waiting) onClose();
  else setError(out.message);
}

/** Back up now: libvirt's backup job into the server's backups folder. */
export function LibvirtBackupNowSheet({ serverId, guest, onClose }: SheetBase) {
  const { t: tMobile } = useMobileT();
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={tMobile('screens2.guest.backUpNowName', { name: guest.name })}
      body={tMobile(
        guest.state === 'running' ? 'screens2.guest.libvirtBackupRunning' : 'screens2.guest.libvirtBackup',
      )}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: tMobile('screens2.common.backUp'),
          variant: 'primary',
          onPress: () =>
            void send({
              op: 'backup.create',
              guestId: guest.id,
              platform: 'libvirt',
              params: {},
              name: guest.name,
            }).then((o) => settle(o, onClose, setError)),
        },
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    />
  );
}

/** Clone: a full copy with its own disks and network addresses, while it is switched off. */
export function LibvirtCloneSheet({ serverId, guest, onClose }: SheetBase) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const { slug } = useBurrowBase();
  const guests = useHostGuests(
    { params: { burrow: slug }, query: { server: serverId, limit: 200 } },
    { retry: false },
  );
  const choices = useHostManageRead(
    { params: { burrow: slug, serverId }, query: { op: 'choices', platform: 'libvirt' } },
    { retry: false },
  );
  const stores = choices.data?.op === 'choices' ? choices.data.choices.storages.map((s) => s.id) : [];
  const [name, setName] = useState(`${guest.name}-copy`);
  const [storage, setStorage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const running = stoppedCheck(guest, rawLocale);
  const nameError = libvirtNameError(
    name,
    (guests.data?.guests ?? []).map((g) => g.name),
    undefined,
    rawLocale,
  );
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={tMobile('screens2.guest.cloneName', { name: guest.name })}
      body={tMobile('screens.a-full-copy-with-its-own-disks-and')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: tMobile('screens2.common.clone'),
          variant: 'primary',
          disabled: !!nameError || !!running,
          onPress: () =>
            void send({
              op: 'guest.clone',
              guestId: guest.id,
              platform: 'libvirt',
              params: { name: name.trim(), ...(storage ? { storage } : {}) },
              name: guest.name,
            }).then((o) => settle(o, onClose, setError)),
        },
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error ?? running}
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
          editable={!running}
        />
        {stores.length > 1 ? (
          <Choices
            label={tMobile('screens.its-disks-go-to')}
            options={[
              { value: '', label: tMobile('screens2.guest.whereNow') },
              ...stores.map((s) => ({
                value: s,
                label: s === 'folder:domains' ? tMobile('screens2.guest.vmFolder') : s,
              })),
            ]}
            value={storage}
            onChange={setStorage}
          />
        ) : null}
      </View>
    </OneSheet>
  );
}
