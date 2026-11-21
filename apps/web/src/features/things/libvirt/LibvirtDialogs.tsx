/**
 * What changes a libvirt VM as a whole (Whombat incus-unraid.md IU-13; AP-1653, AP-1654): Back up now (libvirt's own
 * backup job, running or stopped, into the backups folder with the VM's XML), Restore a backup as a new VM (a new
 * UUID and new MAC addresses), Delete a backup, Clone (stopped; disks copied), Rename (stopped) and Delete (stopped;
 * type its name; its disks and UEFI settings too, ticked by default). Each says in plain words what happens; the long
 * ones start a task the tracker follows (`tasks/HostTasks.tsx`).
 */
import {
  formatBytesBinary,
  formatDayTime,
  libvirtBackupTime,
  libvirtNameError,
  restoredName,
  storageWord,
} from '@whombat/client/hosts';
import type { HostBackupVolume, HostGuest } from '@whombat/core/domain';
import { useState } from 'react';
import { Check, FormDialog, SelectField, TextField } from '../manage/fields';
import { useLibvirtChoices, useLibvirtManage } from './useLibvirt';

export type LvGuestRef = Pick<HostGuest, 'id' | 'name' | 'state'>;

interface Base {
  burrow: string;
  serverId: string;
  guest: LvGuestRef;
  onClose: () => void;
}

/** The change started (its task's id), or was done at once (null). */
type Started = (taskId: string | null, newId?: string) => void;

/** “Oct 16, 02:00” for a backup. */
export function lvBackupWhen(b: HostBackupVolume, timeZone?: string): string {
  const t = libvirtBackupTime(b);
  return t != null ? formatDayTime(t, timeZone) : b.volume;
}

/* Back up now ------------------------------------------------------------------------------------- */

export function LvBackupNowDialog({
  burrow,
  serverId,
  guest,
  backupsDir,
  onClose,
}: Base & { backupsDir?: string | null }) {
  const [compress, setCompress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useLibvirtManage(burrow, serverId);
  const stopped = guest.state === 'stopped';
  return (
    <FormDialog
      title={`Back up ${guest.name} now`}
      description={`${
        stopped
          ? 'It’s switched off, so its disks are copied as they are.'
          : 'libvirt backs it up while it keeps running: the backup holds one moment in time.'
      } It goes to ${backupsDir ? `${backupsDir}/${guest.name}` : 'the backups folder'} with its settings. You can leave this page.`}
      action={busy ? 'Starting…' : 'Back up now'}
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'backup.create',
            guestId: guest.id,
            params: compress ? { compress: true } : {},
            name: guest.name,
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    >
      <Check label="Compress it (smaller, takes longer)" checked={compress} onChange={setCompress} />
    </FormDialog>
  );
}

/* Restore as a new VM ------------------------------------------------------------------------------ */

export function LvRestoreDialog({
  burrow,
  serverId,
  backup,
  taken,
  timeZone,
  onClose,
}: {
  burrow: string;
  serverId: string;
  backup: HostBackupVolume;
  /** Names already taken on the server. */
  taken: readonly string[];
  timeZone?: string;
  onClose: () => void;
}) {
  const choices = useLibvirtChoices(burrow, serverId);
  const source = (backup.guest ?? '').replace(/^libvirt:/, '');
  const [name, setName] = useState(() => restoredName(source || 'vm', taken));
  const [storage, setStorage] = useState('');
  const [start, setStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useLibvirtManage(burrow, serverId);
  const when = lvBackupWhen(backup, timeZone);
  const bad = libvirtNameError(name, taken);
  return (
    <FormDialog
      title={`Restore the backup of ${when}`}
      description={`A new VM is made from ${source}’s backup, with a new UUID and new MAC addresses, so it can run next to ${source}. ${source} stays as it is.`}
      action={busy ? 'Starting…' : 'Restore as a new VM'}
      busy={busy}
      disabled={!!bad}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'backup.restore',
            params: {
              guest: backup.guest ?? '',
              volume: backup.volume,
              name: name.trim(),
              ...(storage ? { storage } : {}),
              ...(start ? { start: true } : {}),
            },
            name: source,
            what: `Restore of ${source} as ${name.trim()}`,
          });
          if (out.ok) onClose();
          else {
            setFields(out.fields);
            setError(Object.keys(out.fields).length ? null : out.message);
          }
        })()
      }
    >
      <TextField
        label="New VM’s name"
        mono
        value={name}
        autoFocus
        error={bad ?? fields.name}
        onChange={(e) => setName(e.target.value)}
      />
      <SelectField
        label="Its disks on"
        options={[
          { value: '', label: 'As in the backup' },
          ...(choices?.storages ?? []).map((s) => ({
            value: s.id,
            label: `${storageWord(s.id)}${s.availBytes != null ? ` · ${formatBytesBinary(s.availBytes)} free` : ''}`,
          })),
        ]}
        value={storage}
        error={fields.storage}
        onChange={(e) => setStorage(e.target.value)}
      />
      <Check label="Start it after the restore" checked={start} onChange={setStart} />
    </FormDialog>
  );
}

export function LvDeleteBackupDialog({
  burrow,
  serverId,
  backup,
  backupsDir,
  timeZone,
  onClose,
}: {
  burrow: string;
  serverId: string;
  backup: HostBackupVolume;
  backupsDir?: string | null;
  timeZone?: string;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useLibvirtManage(burrow, serverId);
  const when = lvBackupWhen(backup, timeZone);
  const vm = (backup.guest ?? '').replace(/^libvirt:/, '');
  return (
    <FormDialog
      title={`Delete ${vm}’s backup of ${when}?`}
      description={`It’s removed from ${backupsDir ? `${backupsDir}/${vm}` : 'the backups folder'} for good.`}
      action={busy ? 'Deleting…' : 'Delete backup'}
      serious
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'backup.delete',
            params: { guest: backup.guest ?? '', volume: backup.volume },
            confirm: true,
            name: 'the backup',
            done: `Deleted ${vm}’s backup of ${when}.`,
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}

/* Clone, rename, delete ---------------------------------------------------------------------------- */

/** The shared name check (`libvirtNameError`), quiet while the field is empty or still says `own`. */
const nameCheck = (name: string, taken: readonly string[], own?: string) => {
  const n = name.trim();
  return !n || n === own ? null : libvirtNameError(n, taken);
};

export function LvCloneDialog({
  burrow,
  serverId,
  guest,
  taken,
  onClose,
}: Base & { taken: readonly string[] }) {
  const choices = useLibvirtChoices(burrow, serverId);
  const [name, setName] = useState(`${guest.name}-copy`);
  const [storage, setStorage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useLibvirtManage(burrow, serverId);
  const running = guest.state !== 'stopped';
  const bad = nameCheck(name, taken);
  return (
    <FormDialog
      title={`Clone ${guest.name}`}
      description="A full copy with its own disks, a new UUID and new MAC addresses. The copy starts switched off."
      action={busy ? 'Starting…' : 'Clone'}
      busy={busy}
      disabled={running || !name.trim() || !!bad}
      error={
        error ??
        (running
          ? `Shut ${guest.name} down first: libvirt copies a VM’s disks only while it’s stopped.`
          : null)
      }
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'guest.clone',
            guestId: guest.id,
            params: { name: name.trim(), ...(storage ? { storage } : {}) },
            name: guest.name,
          });
          if (out.ok) onClose();
          else {
            setFields(out.fields);
            setError(Object.keys(out.fields).length ? null : out.message);
          }
        })()
      }
    >
      <TextField
        label="Name"
        mono
        value={name}
        autoFocus
        disabled={running}
        error={bad ?? fields.name}
        onChange={(e) => setName(e.target.value)}
      />
      <SelectField
        label="Its disks on"
        options={[
          { value: '', label: 'Same as the original' },
          ...(choices?.storages ?? []).map((s) => ({
            value: s.id,
            label: `${storageWord(s.id)}${s.availBytes != null ? ` · ${formatBytesBinary(s.availBytes)} free` : ''}`,
          })),
        ]}
        value={storage}
        disabled={running}
        error={fields.storage}
        onChange={(e) => setStorage(e.target.value)}
      />
    </FormDialog>
  );
}

export function LvRenameDialog({
  burrow,
  serverId,
  guest,
  taken,
  onClose,
  onRenamed,
}: Base & { taken: readonly string[]; onRenamed: (newId: string) => void }) {
  const [name, setName] = useState(guest.name);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useLibvirtManage(burrow, serverId);
  const running = guest.state !== 'stopped';
  const bad = nameCheck(name, taken, guest.name);
  return (
    <FormDialog
      title={`Rename ${guest.name}`}
      description="Its disks, backups and snapshots stay with it."
      action={busy ? 'Renaming…' : 'Rename'}
      busy={busy}
      disabled={running || !name.trim() || name.trim() === guest.name || !!bad}
      error={
        error ??
        (running ? `Shut ${guest.name} down first: libvirt renames a VM only while it’s stopped.` : null)
      }
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const next = name.trim();
          const out = await send({
            op: 'guest.rename',
            guestId: guest.id,
            params: { name: next },
            name: guest.name,
            done: `${guest.name} is ${next} now.`,
          });
          if (out.ok) {
            onRenamed(out.result.newId ?? `libvirt:${next}`);
            onClose();
          } else {
            setFields(out.fields);
            setError(Object.keys(out.fields).length ? null : out.message);
          }
        })()
      }
    >
      <TextField
        label="New name"
        mono
        value={name}
        autoFocus
        disabled={running}
        error={bad ?? fields.name}
        onChange={(e) => setName(e.target.value)}
      />
    </FormDialog>
  );
}

export function LvDeleteDialog({
  burrow,
  serverId,
  guest,
  disks,
  onClose,
  onStarted,
}: Base & { disks: readonly string[]; onStarted?: Started }) {
  const [typed, setTyped] = useState('');
  const [purge, setPurge] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useLibvirtManage(burrow, serverId);
  const running = guest.state !== 'stopped';
  return (
    <FormDialog
      title={`Delete ${guest.name}?`}
      description={`${guest.name} is removed from ${serverId}${purge ? ` with its disks${disks.length ? ` (${disks.join(', ')})` : ''} and its UEFI settings` : '; its disks stay where they are'}. Its backups stay.`}
      action={busy ? 'Deleting…' : `Delete ${guest.name}`}
      serious
      busy={busy}
      disabled={typed.trim() !== guest.name || running}
      error={error ?? (running ? `${guest.name} is running: shut it down first.` : null)}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'guest.delete',
            guestId: guest.id,
            params: { purge },
            confirm: true,
            confirmName: guest.name,
            name: guest.name,
          });
          if (out.ok) {
            onStarted?.(out.result.task?.id ?? null);
            onClose();
          } else setError(out.message);
        })()
      }
    >
      <TextField
        label={`Type ${guest.name} to confirm`}
        mono
        value={typed}
        autoFocus
        disabled={running}
        onChange={(e) => setTyped(e.target.value)}
      />
      <Check
        label="Also delete its disks and UEFI settings"
        checked={purge}
        disabled={running}
        onChange={setPurge}
      />
    </FormDialog>
  );
}
