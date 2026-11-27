/**
 * What changes an Incus instance as a whole (Whombat incus-unraid.md IU-04, IU-06, IU-07; AP-1569…AP-1572): Back up now
 * (a name, how long Incus keeps it, with or without its snapshots, optimized for the pool, compression), Restore a
 * backup (always as a new instance), delete a backup, Copy (to a project and a pool, with or without its snapshots),
 * Rename and Move (to another pool or project; both only while it's stopped), Make an image (from it stopped, or from a
 * snapshot) and Delete (type its name). Each says in plain words what happens; the long ones are Incus operations the
 * task tracker follows (toast with Show progress), and `onStarted` gets the task to act when it ends.
 */
import {
  BACKUP_COMPRESSION,
  BACKUP_KEEP_DAYS,
  backupNameError,
  formatBytesBinary,
  formatDayTime,
  incusBackupName,
  incusBackupParams,
  incusDoneText,
  incusNameError,
  incusObjectNameError,
  incusProjects,
  incusRef,
  incusTaskWhat,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostBackupVolume, HostChoices, HostGuest } from '@whombat/core/domain';
import { useState } from 'react';
import { currentLocale } from '../../../i18n/provider';
import { Check, FormDialog, SelectField, TextField } from '../manage/fields';
import { useManage } from '../manage/useManage';
import styles from '../Things.module.css';

export type IncusGuestRef = Pick<HostGuest, 'id' | 'name' | 'kind' | 'state' | 'self'>;

interface Base {
  burrow: string;
  serverId: string;
  guest: IncusGuestRef;
  onClose: () => void;
}

/** The change started (its task and the instance's new id), or was done at once (null task). */
export type IncusStarted = (taskId: string | null, newId?: string) => void;

/** The Incus host's pools, networks, profiles, images and projects (`choices`, of a project). */
export function useIncusChoices(burrow: string, serverId: string, project?: string): HostChoices | undefined {
  const r = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'choices', platform: 'incus', ...(project && project !== 'default' ? { project } : {}) },
  });
  return r.data?.op === 'choices' ? r.data.choices : undefined;
}

const poolLabel = (s: HostChoices['storages'][number]) =>
  [s.id, s.type, s.availBytes != null ? `${formatBytesBinary(s.availBytes)} free` : '']
    .filter(Boolean)
    .join(' · ');

/** “Oct 16, 03:00” for a backup's dialogs. */
export function incusBackupWhen(b: HostBackupVolume, timeZone?: string): string {
  return b.created ? formatDayTime(Date.parse(b.created), timeZone, currentLocale()) : b.volume;
}

/* Back up now ------------------------------------------------------------------------------------------- */

export function IncusBackupDialog({ burrow, serverId, guest, onClose }: Base) {
  const [name, setName] = useState(() => incusBackupName(Date.now()));
  const [days, setDays] = useState('7');
  const [snapshots, setSnapshots] = useState(true);
  const [optimized, setOptimized] = useState(false);
  const [compression, setCompression] = useState('zstd');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(burrow, serverId);
  const bad = backupNameError(name);
  return (
    <FormDialog
      title={`Back up ${guest.name} now`}
      description="Incus makes the backup on the server and deletes it when it expires. You can leave this page."
      action={busy ? 'Starting…' : 'Back up now'}
      busy={busy}
      disabled={!!bad}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'backup.create',
            guestId: guest.id,
            params: incusBackupParams({
              name,
              days: Number(days),
              instanceOnly: !snapshots,
              optimized,
              compression,
              now: Date.now(),
            }),
            name: guest.name,
            what: incusTaskWhat('backup.create', guest.name),
          });
          if (out.ok) onClose();
          else {
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
          error={bad ?? fields.name}
          onChange={(e) => setName(e.target.value)}
        />
        <SelectField
          label="Keep it for"
          options={BACKUP_KEEP_DAYS}
          value={days}
          error={fields.expiresAt ?? fields.expires_at}
          onChange={(e) => setDays(e.target.value)}
        />
      </div>
      <SelectField
        label="Compression"
        options={BACKUP_COMPRESSION}
        value={compression}
        onChange={(e) => setCompression(e.target.value)}
      />
      <Check label="Include its snapshots" checked={snapshots} onChange={setSnapshots} />
      <Check
        label="Optimized for this storage pool"
        hint="Faster, but it only restores to a pool of the same kind."
        checked={optimized}
        onChange={setOptimized}
      />
    </FormDialog>
  );
}

/* Restore and delete a backup ------------------------------------------------------------------------------ */

export function IncusRestoreDialog({
  burrow,
  serverId,
  guest,
  backup,
  timeZone,
  onClose,
  onStarted,
}: Base & { backup: HostBackupVolume; timeZone?: string; onStarted?: IncusStarted }) {
  const choices = useIncusChoices(burrow, serverId, incusRef(guest.id).project);
  const [name, setName] = useState(`${guest.name}-restored`);
  const [pool, setPool] = useState('');
  const [start, setStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(burrow, serverId);
  const bad = incusNameError(name);
  const when = incusBackupWhen(backup, timeZone);
  return (
    <FormDialog
      title={`Restore the backup of ${when}`}
      description={`Incus restores it as a new instance next to ${guest.name}, which stays as it is.`}
      action={busy ? 'Starting…' : 'Restore'}
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
              platform: 'incus',
              guest: guest.id,
              volume: backup.volume,
              name: name.trim(),
              ...(pool ? { storage: pool } : {}),
              ...(start ? { start: true } : {}),
            },
            confirm: true,
            name: name.trim(),
            what: `Restore of ${guest.name} as ${name.trim()}`,
          });
          if (out.ok) {
            onStarted?.(out.result.task?.id ?? null, out.result.newId);
            onClose();
          } else {
            setFields(out.fields);
            setError(Object.keys(out.fields).length ? null : out.message);
          }
        })()
      }
    >
      <TextField
        label="New instance’s name"
        mono
        value={name}
        autoFocus
        error={bad ?? fields.name}
        onChange={(e) => setName(e.target.value)}
      />
      <SelectField
        label="Storage pool"
        options={[
          { value: '', label: 'As in the backup' },
          ...(choices?.storages ?? []).map((s) => ({ value: s.id, label: poolLabel(s) })),
        ]}
        value={pool}
        error={fields.storage}
        onChange={(e) => setPool(e.target.value)}
      />
      <Check label="Start it once it’s restored" checked={start} onChange={setStart} />
    </FormDialog>
  );
}

export function IncusDeleteBackupDialog({
  burrow,
  serverId,
  guest,
  backup,
  timeZone,
  onClose,
}: Base & { backup: HostBackupVolume; timeZone?: string }) {
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const when = incusBackupWhen(backup, timeZone);
  return (
    <FormDialog
      title={`Delete the backup of ${when}?`}
      description={`“${backup.volume}” of ${guest.name} is removed from the server for good.`}
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
            params: { platform: 'incus', guest: guest.id, volume: backup.volume },
            confirm: true,
            name: 'the backup',
            done: incusDoneText('backup.delete', ''),
            what: `Deleting the backup of ${when}`,
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}

/* Copy ------------------------------------------------------------------------------------------------ */

export function IncusCopyDialog({
  burrow,
  serverId,
  guest,
  onClose,
  onStarted,
}: Base & { onStarted?: IncusStarted }) {
  const from = incusRef(guest.id).project;
  const [project, setProject] = useState(from);
  const choices = useIncusChoices(burrow, serverId, project);
  const [name, setName] = useState(`${guest.name}-copy`);
  const [pool, setPool] = useState('');
  const [snapshots, setSnapshots] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(burrow, serverId);
  const bad = incusNameError(name);
  const projects = incusProjects(choices);
  return (
    <FormDialog
      title={`Copy ${guest.name}`}
      description={
        guest.state === 'stopped'
          ? 'A copy with its own disk and new network addresses. It starts switched off.'
          : 'A copy of it as it is at this moment, with its own disk and new network addresses. It starts switched off.'
      }
      action={busy ? 'Starting…' : 'Copy'}
      busy={busy}
      disabled={!!bad}
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
              name: name.trim(),
              ...(pool ? { storage: pool } : {}),
              ...(project !== from ? { project } : {}),
              instanceOnly: !snapshots,
            },
            name: guest.name,
            what: incusTaskWhat('guest.clone', guest.name),
          });
          if (out.ok) {
            onStarted?.(out.result.task?.id ?? null, out.result.newId);
            onClose();
          } else {
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
        error={bad ?? fields.name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className={styles.formRow}>
        <SelectField
          label="Project"
          options={projects.map((p) => ({ value: p, label: p }))}
          value={project}
          error={fields.project}
          onChange={(e) => setProject(e.target.value)}
        />
        <SelectField
          label="Storage pool"
          options={[
            { value: '', label: 'Same as the original' },
            ...(choices?.storages ?? []).map((s) => ({ value: s.id, label: poolLabel(s) })),
          ]}
          value={pool}
          error={fields.storage}
          onChange={(e) => setPool(e.target.value)}
        />
      </div>
      <Check label="Copy its snapshots too" checked={snapshots} onChange={setSnapshots} />
    </FormDialog>
  );
}

/* Rename and move --------------------------------------------------------------------------------------- */

const stopFirst = (g: IncusGuestRef, verb: string) =>
  g.state !== 'stopped' ? `Stop ${g.name} first: Incus ${verb} only a stopped instance.` : null;

export function IncusRenameDialog({
  burrow,
  serverId,
  guest,
  onClose,
  onStarted,
}: Base & { onStarted?: IncusStarted }) {
  const [name, setName] = useState(guest.name);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(burrow, serverId);
  const running = stopFirst(guest, 'renames');
  const bad = incusNameError(name);
  const same = name.trim() === guest.name;
  return (
    <FormDialog
      title={`Rename ${guest.name}`}
      description="Its disks, snapshots and backups keep going with it under the new name."
      action={busy ? 'Starting…' : 'Rename'}
      busy={busy}
      disabled={!!running || !!bad || same}
      error={error ?? running}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'guest.rename',
            guestId: guest.id,
            params: { name: name.trim() },
            name: guest.name,
            what: incusTaskWhat('guest.rename', guest.name),
            done: incusDoneText('guest.rename', name.trim()),
          });
          if (out.ok) {
            onStarted?.(out.result.task?.id ?? null, out.result.newId);
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
        disabled={!!running}
        error={same ? null : (bad ?? fields.name)}
        onChange={(e) => setName(e.target.value)}
      />
    </FormDialog>
  );
}

export function IncusMoveDialog({
  burrow,
  serverId,
  guest,
  pool: currentPool,
  onClose,
  onStarted,
}: Base & { pool?: string; onStarted?: IncusStarted }) {
  const from = incusRef(guest.id).project;
  const [project, setProject] = useState(from);
  const choices = useIncusChoices(burrow, serverId, project);
  const [pool, setPool] = useState(currentPool ?? '');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const running = stopFirst(guest, 'moves');
  const changed = (pool && pool !== currentPool) || project !== from;
  const projects = incusProjects(choices);
  return (
    <FormDialog
      title={`Move ${guest.name}`}
      description="Its disk and snapshots move with it; that takes a while for a big disk."
      action={busy ? 'Starting…' : 'Move it'}
      serious
      busy={busy}
      disabled={!!running || !changed}
      error={error ?? running}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'guest.move',
            guestId: guest.id,
            params: {
              ...(pool && pool !== currentPool ? { pool } : {}),
              ...(project !== from ? { project } : {}),
            },
            confirm: true,
            name: guest.name,
            what: incusTaskWhat('guest.move', guest.name),
          });
          if (out.ok) {
            onStarted?.(out.result.task?.id ?? null, out.result.newId);
            onClose();
          } else setError(out.message);
        })()
      }
    >
      <div className={styles.formRow}>
        <SelectField
          label="Storage pool"
          options={(choices?.storages ?? []).map((s) => ({
            value: s.id,
            label: s.id === currentPool ? `${s.id} (where it is now)` : poolLabel(s),
          }))}
          value={pool}
          disabled={!!running}
          onChange={(e) => setPool(e.target.value)}
        />
        <SelectField
          label="Project"
          options={projects.map((p) => ({ value: p, label: p === from ? `${p} (where it is now)` : p }))}
          value={project}
          disabled={!!running}
          onChange={(e) => setProject(e.target.value)}
        />
      </div>
    </FormDialog>
  );
}

/* Make an image -------------------------------------------------------------------------------------------- */

export function IncusPublishDialog({ burrow, serverId, guest, onClose }: Base) {
  const snaps = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'snapshot.list', guestId: guest.id, platform: 'incus' },
  });
  const list = snaps.data?.op === 'snapshot.list' ? snaps.data.items.filter((s) => !s.current) : [];
  const stopped = guest.state === 'stopped';
  const [snapshot, setSnapshot] = useState('');
  const [alias, setAlias] = useState(`${guest.name}/${new Date().toISOString().slice(0, 10)}`);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(burrow, serverId);
  const from = snapshot || (stopped ? '' : (list[list.length - 1]?.name ?? ''));
  const blocked =
    !stopped && !from ? `Stop ${guest.name} first, or take a snapshot to make the image from.` : null;
  const bad = alias.trim() ? incusObjectNameError(alias, { slash: true }) : null;
  return (
    <FormDialog
      title={`Make an image of ${guest.name}`}
      description="New instances can start from the image. It goes into this server’s images."
      action={busy ? 'Starting…' : 'Make the image'}
      busy={busy}
      disabled={!!blocked || !!bad}
      error={error ?? blocked}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'guest.publish',
            guestId: guest.id,
            params: {
              ...(alias.trim() ? { alias: alias.trim() } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
              ...(from ? { snapshot: from } : {}),
            },
            name: guest.name,
            what: incusTaskWhat('guest.publish', guest.name),
          });
          if (out.ok) onClose();
          else {
            setFields(out.fields);
            setError(Object.keys(out.fields).length ? null : out.message);
          }
        })()
      }
    >
      <SelectField
        label="From"
        options={[
          ...(stopped ? [{ value: '', label: `${guest.name} as it is now` }] : []),
          ...list.map((s) => ({ value: s.name, label: `The snapshot ${s.name}` })),
          ...(!stopped && !list.length ? [{ value: '', label: 'No snapshot yet' }] : []),
        ]}
        value={from}
        disabled={!stopped && !list.length}
        onChange={(e) => setSnapshot(e.target.value)}
      />
      <TextField
        label="Name (alias)"
        mono
        value={alias}
        error={bad ?? fields.alias}
        hint="Leave it empty to find it by its fingerprint only."
        onChange={(e) => setAlias(e.target.value)}
      />
      <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
    </FormDialog>
  );
}

/* Delete ------------------------------------------------------------------------------------------------- */

export function IncusDeleteDialog({
  burrow,
  serverId,
  guest,
  protectedOn = false,
  onClose,
  onStarted,
}: Base & { protectedOn?: boolean; onStarted?: IncusStarted }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const running = guest.state !== 'stopped';
  const blocked = running
    ? `${guest.name} is running: stop it first.`
    : protectedOn
      ? `Protection is on for ${guest.name}: turn it off in Configuration first.`
      : null;
  return (
    <FormDialog
      title={`Delete ${guest.name}?`}
      description={`${guest.name}, its disk and its snapshots are removed from ${serverId} for good. Its backups go with it.`}
      action={busy ? 'Deleting…' : `Delete ${guest.name}`}
      serious
      busy={busy}
      disabled={typed.trim() !== guest.name || !!blocked}
      error={error ?? blocked}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'guest.delete',
            guestId: guest.id,
            confirm: true,
            confirmName: guest.name,
            name: guest.name,
            what: incusTaskWhat('guest.delete', guest.name),
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
        disabled={!!blocked}
        onChange={(e) => setTyped(e.target.value)}
      />
    </FormDialog>
  );
}
