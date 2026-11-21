/**
 * What changes a guest as a whole (ported from Rackoon's `LifecycleDialogs` and `BackupDialogs`; PX-01): Back up now
 * (storage, how, compression unless it's a Proxmox Backup Server, notes, protected), Restore a backup (over this guest
 * or as a new one, to a storage, new MAC addresses, start after), the backup's notes and Delete, Clone (full, or linked
 * from a template, to a storage), Convert to template, Move to another node (ONE-12: always asked) and Delete (type
 * its name, also out of backup jobs, replication and HA). Each says in plain words what happens; most start a task,
 * which the task tracker follows (`tasks/HostTasks.tsx`): `onStarted` gets its id to act when it ends.
 */
import { formatBytesBinary, formatDayTime, formatRelativeDay, storagesFor } from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostBackupVolume, HostChoices, HostGuest } from '@whombat/core/domain';
import { useState } from 'react';
import { SegmentedControl } from '../../../components/SegmentedControl';
import styles from '../Things.module.css';
import { Check, FormDialog, SelectField, TextField } from './fields';
import { useManage } from './useManage';

export type GuestRef = Pick<HostGuest, 'id' | 'name' | 'kind' | 'state' | 'vmid'>;

interface Base {
  burrow: string;
  serverId: string;
  guest: GuestRef;
  onClose: () => void;
}

/** The change started (its task's id), or was done at once (null). */
type Started = (taskId: string | null) => void;

function useChoices(burrow: string, serverId: string) {
  const r = useHostManageRead({ params: { burrow, serverId }, query: { op: 'choices', platform: 'pve' } });
  return r.data?.op === 'choices' ? r.data.choices : undefined;
}

type Store = HostChoices['storages'][number];

/** “pbs · Proxmox Backup Server · 2.7 TiB free”. */
export function storageLabel(s: Store): string {
  return [
    s.id,
    s.type === 'pbs' ? 'Proxmox Backup Server' : s.type,
    s.availBytes != null ? `${formatBytesBinary(s.availBytes)} free` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const idError = (v: string) =>
  v.trim() && !(/^\d+$/.test(v.trim()) && Number(v) >= 100 && Number(v) <= 999_999_999)
    ? 'Use a number from 100.'
    : null;

/** When a backup was made, for its dialogs (“Oct 16, 02:00”). */
export function backupWhen(b: HostBackupVolume, timeZone?: string): string {
  return b.created ? formatDayTime(Date.parse(b.created), timeZone) : (b.volume.split('/').pop() ?? b.volume);
}

/* Back up now --------------------------------------------------------------------------------------- */

const MODES = [
  {
    value: 'snapshot',
    label: 'While it runs',
    hint: 'It keeps running; the backup reads one moment in time.',
  },
  { value: 'suspend', label: 'Paused', hint: 'It pauses while the backup starts, then carries on.' },
  { value: 'stop', label: 'Stopped', hint: 'It shuts down for the backup and starts again after.' },
] as const;
type Mode = (typeof MODES)[number]['value'];

const COMPRESS = [
  { value: 'zstd', label: 'ZSTD (fast and small)' },
  { value: 'lzo', label: 'LZO (fastest)' },
  { value: 'gzip', label: 'GZIP (smallest, slow)' },
  { value: 'none', label: 'None' },
] as const;
type Compress = (typeof COMPRESS)[number]['value'];

export function BackupNowDialog({ burrow, serverId, guest, onClose }: Base) {
  const choices = useChoices(burrow, serverId);
  const stores = storagesFor(choices, 'backup');
  const [storage, setStorage] = useState('');
  const [mode, setMode] = useState<Mode>('snapshot');
  const [compress, setCompress] = useState<Compress>('zstd');
  const [notes, setNotes] = useState('{{guestname}}');
  const [keep, setKeep] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  // A Proxmox Backup Server first (it dedups and verifies), else the first storage for backups.
  const target = storage || (stores.find((s) => s.type === 'pbs') ?? stores[0])?.id || '';
  const pbs = stores.find((s) => s.id === target)?.type === 'pbs';
  return (
    <FormDialog
      title={`Back up ${guest.name} now`}
      description="The backup runs on the server; you can leave this page."
      action={busy ? 'Starting…' : 'Back up now'}
      busy={busy}
      disabled={!target}
      error={error ?? (choices && !stores.length ? 'This server has no storage for backups.' : null)}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'backup.create',
            guestId: guest.id,
            params: {
              storage: target,
              mode,
              ...(pbs ? {} : { compress }),
              ...(notes.trim() ? { notes: notes.trim() } : {}),
              ...(keep ? { protected: true } : {}),
            },
            name: guest.name,
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    >
      <SelectField
        label="Save it on"
        options={stores.map((s) => ({ value: s.id, label: storageLabel(s) }))}
        value={target}
        onChange={(e) => setStorage(e.target.value)}
      />
      <div className={styles.field}>
        <span>How</span>
        <SegmentedControl
          options={MODES.map((m) => ({ value: m.value, label: m.label }))}
          value={mode}
          onChange={setMode}
          label="How"
          variant="soft"
        />
        <small>{MODES.find((m) => m.value === mode)?.hint}</small>
      </div>
      {pbs ? null : (
        <SelectField
          label="Compression"
          options={COMPRESS}
          value={compress}
          onChange={(e) => setCompress(e.target.value as Compress)}
        />
      )}
      <TextField
        label="Notes"
        value={notes}
        maxLength={1024}
        hint="Shown with the backup. {{guestname}}, {{vmid}} and {{node}} are filled in."
        onChange={(e) => setNotes(e.target.value)}
      />
      <Check label="Protect it (pruning and deleting leave it alone)" checked={keep} onChange={setKeep} />
    </FormDialog>
  );
}

/* Restore ------------------------------------------------------------------------------------------- */

export function RestoreDialog({
  burrow,
  serverId,
  guest,
  backup,
  newOnly = false,
  timeZone,
  onClose,
}: Base & {
  backup: HostBackupVolume;
  /** The guest is gone: only as a new one. */
  newOnly?: boolean;
  timeZone?: string;
}) {
  const choices = useChoices(burrow, serverId);
  const disks = storagesFor(choices, guest.kind === 'vm' ? 'images' : 'rootdir');
  const [mode, setMode] = useState<'new' | 'over'>('new');
  const [newId, setNewId] = useState('');
  const [storage, setStorage] = useState('');
  const [unique, setUnique] = useState(true);
  const [start, setStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const when = backupWhen(backup, timeZone);
  const over = mode === 'over';
  const running = guest.state !== 'stopped';
  const bad = over ? null : idError(newId);
  return (
    <FormDialog
      title={`Restore the backup of ${when}`}
      description={
        over
          ? `${guest.name}’s disks and settings are replaced with the backup. What changed since ${when} is lost.`
          : `A new guest is made from the backup of ${guest.name}; ${guest.name} stays as it is.`
      }
      action={busy ? 'Starting…' : over ? `Replace ${guest.name}` : 'Restore as a new guest'}
      serious={over}
      busy={busy}
      disabled={(over && running) || !!bad}
      error={
        error ??
        (over && running
          ? `${guest.name} is running: shut it down first, a restore replaces its disks.`
          : null)
      }
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'backup.restore',
            // PX-08: an over-restore names its guest on the request too.
            ...(over ? { guestId: guest.id } : {}),
            params: {
              platform: 'pve',
              volume: backup.volume,
              ...(over ? { guest: guest.id } : { ...(newId.trim() ? { newId: Number(newId) } : {}), unique }),
              ...(storage ? { storage } : {}),
              ...(start ? { start: true } : {}),
            },
            ...(over ? { confirm: true } : {}),
            name: guest.name,
            what: over ? `Restore of ${guest.name}` : `Restore of ${guest.name} as a new guest`,
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    >
      {newOnly ? null : (
        <SegmentedControl
          options={[
            { value: 'new', label: 'As a new guest' },
            { value: 'over', label: `Over ${guest.name}` },
          ]}
          value={mode}
          onChange={setMode}
          label="Restore"
          variant="soft"
        />
      )}
      {over ? null : (
        <TextField
          label="New ID"
          mono
          inputMode="numeric"
          value={newId}
          placeholder={choices?.nextId ? String(choices.nextId) : 'Next free'}
          error={bad}
          onChange={(e) => setNewId(e.target.value)}
        />
      )}
      <SelectField
        label="To storage"
        options={[
          { value: '', label: 'As in the backup' },
          ...disks.map((s) => ({ value: s.id, label: storageLabel(s) })),
        ]}
        value={storage}
        onChange={(e) => setStorage(e.target.value)}
      />
      {over ? null : (
        <Check
          label="New MAC addresses, so it can run next to the original"
          checked={unique}
          onChange={setUnique}
        />
      )}
      <Check label="Start it after the restore" checked={start} onChange={setStart} />
    </FormDialog>
  );
}

/* A backup's notes and Delete ---------------------------------------------------------------------- */

export function BackupNotesDialog({
  burrow,
  serverId,
  backup,
  timeZone,
  onClose,
}: {
  burrow: string;
  serverId: string;
  backup: HostBackupVolume;
  timeZone?: string;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState(backup.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  return (
    <FormDialog
      title={`Notes of the backup of ${backupWhen(backup, timeZone)}`}
      action={busy ? 'Saving…' : 'Save'}
      busy={busy}
      disabled={notes.trim() === (backup.notes ?? '').trim()}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'backup.update',
            params: { platform: 'pve', volume: backup.volume, notes: notes.trim() },
            name: 'the backup',
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    >
      <TextField
        label="Notes"
        value={notes}
        maxLength={1024}
        autoFocus
        onChange={(e) => setNotes(e.target.value)}
      />
    </FormDialog>
  );
}

export function DeleteBackupDialog({
  burrow,
  serverId,
  backup,
  timeZone,
  onClose,
}: {
  burrow: string;
  serverId: string;
  backup: HostBackupVolume;
  timeZone?: string;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const when = backupWhen(backup, timeZone);
  return (
    <FormDialog
      title={`Delete the backup of ${when}?`}
      description={
        backup.protected
          ? 'It’s protected, so Proxmox keeps it. Remove the protection first if you want it gone.'
          : `It’s removed from ${backup.storage} for good.`
      }
      action={busy ? 'Deleting…' : 'Delete backup'}
      serious
      busy={busy}
      disabled={!!backup.protected}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'backup.delete',
            params: { platform: 'pve', volume: backup.volume },
            confirm: true,
            name: 'the backup',
            what: `Deleting the backup of ${when}`,
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}

/* Clone --------------------------------------------------------------------------------------------- */

export function CloneDialog({
  burrow,
  serverId,
  guest,
  template = false,
  onClose,
  onStarted,
}: Base & { template?: boolean; onStarted?: Started }) {
  const choices = useChoices(burrow, serverId);
  const disks = storagesFor(choices, guest.kind === 'vm' ? 'images' : 'rootdir');
  const [name, setName] = useState(`${guest.name}-${template ? 'new' : 'copy'}`);
  const [newId, setNewId] = useState('');
  const [full, setFull] = useState(!template);
  const [storage, setStorage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(burrow, serverId);
  const nameBad =
    /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,61}[a-zA-Z0-9])?$/.test(name.trim()) || !name.trim()
      ? null
      : 'Letters, digits, dots and dashes.';
  const bad = idError(newId);
  return (
    <FormDialog
      title={`Clone ${guest.name}`}
      description={
        template
          ? 'A linked clone shares the template’s disks and is ready in seconds; a full clone copies them.'
          : 'A full copy with its own disks and new MAC addresses. The copy starts switched off.'
      }
      action={busy ? 'Starting…' : 'Clone'}
      busy={busy}
      disabled={!name.trim() || !!nameBad || !!bad}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'guest.clone',
            guestId: guest.id,
            params: {
              ...(newId.trim() ? { newId: Number(newId) } : {}),
              name: name.trim(),
              full,
              ...(full && storage ? { storage } : {}),
            },
            name: guest.name,
          });
          if (out.ok) {
            onStarted?.(out.result.task?.id ?? null);
            onClose();
          } else {
            setFields(out.fields);
            setError(Object.keys(out.fields).length ? null : out.message);
          }
        })()
      }
    >
      <div className={styles.formRow}>
        <TextField
          label="Name"
          mono
          value={name}
          autoFocus
          error={nameBad ?? fields.name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="ID"
          mono
          inputMode="numeric"
          value={newId}
          placeholder={choices?.nextId ? String(choices.nextId) : 'Next free'}
          error={bad ?? fields.new_id ?? fields.newId}
          onChange={(e) => setNewId(e.target.value)}
        />
      </div>
      {template ? (
        <SegmentedControl
          options={[
            { value: 'linked', label: 'Linked clone' },
            { value: 'full', label: 'Full clone' },
          ]}
          value={full ? 'full' : 'linked'}
          onChange={(v) => setFull(v === 'full')}
          label="Clone mode"
          variant="soft"
        />
      ) : null}
      {full ? (
        <SelectField
          label="To storage"
          options={[
            { value: '', label: 'Same as the original' },
            ...disks.map((s) => ({ value: s.id, label: storageLabel(s) })),
          ]}
          value={storage}
          error={fields.storage}
          onChange={(e) => setStorage(e.target.value)}
        />
      ) : null}
    </FormDialog>
  );
}

/* Convert to template ------------------------------------------------------------------------------ */

export function TemplateDialog({
  burrow,
  serverId,
  guest,
  onClose,
  onStarted,
}: Base & { onStarted?: Started }) {
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const running = guest.state !== 'stopped';
  return (
    <FormDialog
      title={`Convert ${guest.name} to a template?`}
      description="A template can’t be started or changed, only cloned. This can’t be undone."
      action={busy ? 'Converting…' : 'Convert to template'}
      serious
      busy={busy}
      disabled={running}
      error={
        error ??
        (running ? `Shut ${guest.name} down first: only a stopped guest can become a template.` : null)
      }
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'guest.template',
            guestId: guest.id,
            confirm: true,
            name: guest.name,
          });
          if (out.ok) {
            onStarted?.(out.result.task?.id ?? null);
            onClose();
          } else setError(out.message);
        })()
      }
    />
  );
}

/* Move to another node ----------------------------------------------------------------------------- */

export function MigrateDialog({ burrow, serverId, guest, onClose }: Base) {
  const choices = useChoices(burrow, serverId);
  const nodes = choices?.nodes ?? [];
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const to = target || nodes[0] || '';
  const running = guest.state !== 'stopped';
  const how =
    guest.kind === 'vm'
      ? running
        ? 'A live move: it keeps running, about a minute.'
        : 'It’s switched off, so it moves as it is.'
      : running
        ? 'Containers restart to move: it’s down for a moment.'
        : 'It’s switched off, so it moves as it is.';
  return (
    <FormDialog
      title={`Move ${guest.name} to another server`}
      description={`${how} Its backups move with it.`}
      action={busy ? 'Starting…' : 'Move it'}
      busy={busy}
      disabled={!to}
      error={
        error ??
        (choices && !nodes.length ? 'This server isn’t in a cluster, so there is nowhere to move to.' : null)
      }
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'guest.migrate',
            guestId: guest.id,
            params: { target: to },
            confirm: true,
            name: guest.name,
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    >
      <SelectField
        label="To"
        options={nodes.map((n) => ({ value: n, label: n }))}
        value={to}
        onChange={(e) => setTarget(e.target.value)}
      />
    </FormDialog>
  );
}

/* Delete -------------------------------------------------------------------------------------------- */

export function DeleteDialog({
  burrow,
  serverId,
  guest,
  protectedOn = false,
  onClose,
  onStarted,
}: Base & { protectedOn?: boolean; onStarted?: Started }) {
  const [typed, setTyped] = useState('');
  const [purge, setPurge] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const running = guest.state !== 'stopped';
  const blocked = running || protectedOn;
  return (
    <FormDialog
      title={`Delete ${guest.name}?`}
      description={`${guest.name}${guest.vmid ? ` (ID ${guest.vmid})` : ''} and all its disks are removed from ${serverId} for good. Its backups stay.`}
      action={busy ? 'Deleting…' : `Delete ${guest.name}`}
      serious
      busy={busy}
      disabled={typed.trim() !== guest.name || blocked}
      error={
        error ??
        (running
          ? `${guest.name} is running: shut it down first.`
          : protectedOn
            ? `Protection is on for ${guest.name}: turn it off in Options first.`
            : null)
      }
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'guest.delete',
            guestId: guest.id,
            params: purge ? { purge: true } : {},
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
        disabled={blocked}
        onChange={(e) => setTyped(e.target.value)}
      />
      <Check
        label="Also remove it from backup plans, replication and HA"
        checked={purge}
        disabled={blocked}
        onChange={setPurge}
      />
    </FormDialog>
  );
}

/** “Today 02:00” for a backup row. */
export function backupMade(b: HostBackupVolume, now: number, timeZone?: string): string {
  return b.created ? formatRelativeDay(Date.parse(b.created), now, timeZone) : '';
}
