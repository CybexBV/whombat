/**
 * The sheets a guest's screen opens from its header and its Summary (proxmox-mobile.md AP-1486…AP-1489): a power
 * action's question (stop, shut down, restart and pause ask first, then go with `confirm`), More (Back up now, Take a
 * snapshot, Clone, Delete), Back up now (where and how), Take a snapshot (with memory for a running VM), Clone (a
 * name; a full copy), Delete (type the name; its disks go too), Restart to apply, and Add to a backup job. Each says
 * in plain words what happens; what runs as a task says when it starts and when it ends (`useServerChange`).
 */
import { isDestructiveAction, type PowerActionView, storagesFor } from '@whombat/client/hosts';
import {
  addToJobParams,
  BACKUP_MODES,
  type BackupMode,
  backupJobRows,
  backupStorages,
  cloneNameError,
  defaultSnapshotName,
  deleteCheck,
  jobCovers,
  newIdCheck,
  snapshotNameError,
} from '@whombat/client/hosts/mobile';
import { useHostGuests, useHostManageRead } from '@whombat/client/hosts/react';
import type { HostBackupJob, HostGuestDetail } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { Dot, OneCard, OneRow } from '../../ui/assistant';
import { FormField } from '../../ui/formField';
import { OneSheet } from '../../ui/oneSheet';
import { QuietText } from '../../ui/primitives';
import { CardQuiet, Choices, SwitchLine } from './parts';
import { type ChangeOutcome, useGuestAction, useManageChange } from './useServerChange';

export interface SheetBase {
  serverId: string;
  serverName: string;
  guest: HostGuestDetail;
  onClose: () => void;
}

const CANCEL = 'Cancel';

/** What a sheet does with a change's outcome: close when it went (or waits for someone), else show why. */
function settle(out: ChangeOutcome, onClose: () => void, setError: (s: string) => void) {
  if (out.ok || out.waiting) onClose();
  else setError(out.message);
}

/** A power action's question; Pause asks too on the phone (PX-06). */
export function PowerSheet({
  serverId,
  serverName,
  guest,
  action,
  onClose,
}: SheetBase & { action: PowerActionView }) {
  const { send, busy } = useGuestAction(serverId, guest);
  const [error, setError] = useState<string | null>(null);
  const question =
    action.question ??
    (action.action === 'pause'
      ? `Pause ${guest.name}? It stops where it is until you resume it.`
      : `${action.label} ${guest.name}?`);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={`${guest.name} · ${serverName}`}
      tone={action.serious ? 'bad' : 'warn'}
      title={question}
      busy={busy}
      buttons={[
        {
          id: action.action,
          label: action.label,
          variant: 'primary',
          onPress: () =>
            void send({
              action: action.action,
              ...(isDestructiveAction(action.action) ? { confirm: true } : {}),
            }).then((o) => settle(o, onClose, setError)),
        },
        { id: 'cancel', label: CANCEL, variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    />
  );
}

export type MoreChoice = 'backup' | 'snapshot' | 'clone' | 'rename' | 'delete';

const MORE_WORDS: Record<MoreChoice, string> = {
  backup: 'Back up now',
  snapshot: 'Take a snapshot',
  clone: 'Clone',
  rename: 'Rename',
  delete: 'Delete',
};

/**
 * More: what changes the guest as a whole, in this order — Proxmox: Back up now, Take a snapshot, Clone, Delete;
 * Incus (incus-unraid-mobile.md AP-1623): Back up now, Take a snapshot, Copy, Rename, Delete; this Whombat itself only
 * what stays allowed on it.
 */
export function MoreSheet({
  guest,
  choices,
  cloneWord = 'Clone',
  onPick,
  onClose,
}: {
  guest: HostGuestDetail;
  choices: readonly MoreChoice[];
  /** “Copy” on Incus. */
  cloneWord?: string;
  onPick: (c: MoreChoice) => void;
  onClose: () => void;
}) {
  return (
    <OneSheet
      visible
      onClose={onClose}
      title={guest.name}
      buttons={[
        ...choices.map((c) => ({
          id: c,
          label: c === 'clone' ? cloneWord : MORE_WORDS[c],
          variant: 'secondary' as const,
          onPress: () => onPick(c),
        })),
        { id: 'cancel', label: CANCEL, variant: 'quiet', onPress: onClose },
      ]}
    />
  );
}

function useChoices(serverId: string) {
  const { slug } = useBurrowBase();
  const r = useHostManageRead(
    { params: { burrow: slug, serverId }, query: { op: 'choices', platform: 'pve' } },
    { retry: false },
  );
  return { choices: r.data?.op === 'choices' ? r.data.choices : undefined, loading: r.isPending };
}

/** Back up now: on which storage, and how (while it runs, paused, stopped). */
export function BackupNowSheet({ serverId, guest, onClose }: SheetBase) {
  const { choices, loading } = useChoices(serverId);
  const stores = backupStorages(storagesFor(choices, 'backup'));
  const [storage, setStorage] = useState('');
  const [mode, setMode] = useState<BackupMode>('snapshot');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const target = storage || stores.first;
  const none = !loading && !stores.ids.length;
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={`Back up ${guest.name} now`}
      body="The backup runs on the server; you can leave this screen."
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: 'Back up',
          variant: 'primary',
          disabled: !target,
          onPress: () =>
            void send({
              op: 'backup.create',
              guestId: guest.id,
              params: { storage: target, mode },
              name: guest.name,
            }).then((o) => settle(o, onClose, setError)),
        },
        { id: 'cancel', label: CANCEL, variant: 'quiet', onPress: onClose },
      ]}
      note={error ?? (none ? 'This server has no storage for backups.' : null)}
    >
      <View style={{ gap: 16, marginTop: 16 }}>
        {stores.ids.length ? (
          <Choices
            label="Save it on"
            options={stores.ids.map((id) => ({ value: id, label: id }))}
            value={target}
            onChange={setStorage}
          />
        ) : null}
        <Choices label="How" options={BACKUP_MODES} value={mode} onChange={setMode} />
      </View>
    </OneSheet>
  );
}

/** Take a snapshot: a name, a note, and for a running VM whether what's in memory comes too. */
export function SnapshotSheet({ serverId, guest, onClose }: SheetBase) {
  const { clock } = useBurrowBase();
  const [name, setName] = useState(() => defaultSnapshotName(clock().getTime()));
  const [note, setNote] = useState('');
  const [memory, setMemory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useGuestAction(serverId, guest);
  const bad = snapshotNameError(name.trim());
  // Memory in a snapshot is Proxmox's; Incus needs stateful snapshots set up (the web's).
  const vmOn = guest.platform === 'pve' && guest.kind === 'vm' && guest.state === 'running';
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={`Take a snapshot of ${guest.name}`}
      body="You can go back to it later. It takes a few seconds."
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: 'Take it',
          variant: 'primary',
          disabled: !!bad,
          onPress: () =>
            void send({
              action: 'snapshot_create',
              snapshot: name.trim(),
              ...(note.trim() ? { description: note.trim() } : {}),
              ...(memory && vmOn ? { memory: true } : {}),
            }).then((o) => settle(o, onClose, setError)),
        },
        { id: 'cancel', label: CANCEL, variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    >
      <View style={{ gap: 14, marginTop: 16 }}>
        <FormField
          label="Name"
          value={name}
          onChangeText={setName}
          error={name.trim() ? bad : null}
          mono
          autoCapitalize="none"
          autoCorrect={false}
        />
        <FormField label="Note" value={note} onChangeText={setNote} hint="Optional." />
        {vmOn ? (
          <SwitchLine
            label="Include what’s in memory (it resumes exactly where it was)"
            value={memory}
            onChange={setMemory}
          />
        ) : null}
      </View>
    </OneSheet>
  );
}

/** Clone: a full copy with its own disks, under a new name and id; it starts switched off. */
export function CloneSheet({ serverId, guest, onClose }: SheetBase) {
  const { choices } = useChoices(serverId);
  const [name, setName] = useState(`${guest.name}-copy`);
  const [id, setId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const nameError = cloneNameError(name);
  const idCheck = newIdCheck(id, choices?.nextId);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={`Clone ${guest.name}`}
      body="A full copy with its own disks. The copy starts switched off."
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: 'Clone',
          variant: 'primary',
          disabled: !!nameError || idCheck.id == null,
          onPress: () =>
            void send({
              op: 'guest.clone',
              guestId: guest.id,
              params: { newId: idCheck.id, name: name.trim(), full: true },
              name: guest.name,
            }).then((o) => settle(o, onClose, setError)),
        },
        { id: 'cancel', label: CANCEL, variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    >
      <View style={{ gap: 14, marginTop: 16 }}>
        <FormField
          label="Name"
          value={name}
          onChangeText={setName}
          error={nameError}
          mono
          autoCapitalize="none"
          autoCorrect={false}
        />
        <FormField
          label="ID"
          value={id}
          onChangeText={setId}
          placeholder={choices?.nextId ? String(choices.nextId) : undefined}
          hint={choices?.nextId ? `Empty: ${choices.nextId}, the next free one.` : null}
          error={id.trim() ? idCheck.error : null}
          mono
          keyboardType="number-pad"
        />
      </View>
    </OneSheet>
  );
}

/**
 * Delete: type the name; only when it is switched off. Proxmox: it and its disks go for good (purged), its backups
 * stay. Incus: its snapshots and backups go with it (they live with the instance).
 */
export function DeleteSheet({ serverId, guest, onClose, onDeleted }: SheetBase & { onDeleted: () => void }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const check = deleteCheck(guest, typed);
  const incus = guest.platform === 'incus';
  // A libvirt VM (IU-13): its disks and NVRAM only when asked; its backups stay.
  const libvirt = guest.platform === 'libvirt';
  const [purge, setPurge] = useState(false);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={guest.name}
      tone="bad"
      title={`Delete ${guest.name}?`}
      body={
        incus
          ? `${guest.name} is removed for good, with its snapshots and backups.`
          : libvirt
            ? purge
              ? `${guest.name} and its disks are removed for good. Its backups stay.`
              : `${guest.name} is removed; its disks stay on the server, and so do its backups.`
            : `${guest.name} and its disks are removed for good. Its backups stay.`
      }
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: 'Delete',
          variant: 'primary',
          disabled: !check.ok,
          onPress: () =>
            void send({
              op: 'guest.delete',
              guestId: guest.id,
              ...(incus ? { platform: 'incus' as const } : libvirt ? { platform: 'libvirt' as const } : {}),
              params: incus ? {} : libvirt ? { purge } : { purge: true },
              confirm: true,
              confirmName: guest.name,
              name: guest.name,
            }).then((o) => {
              if (o.ok) onDeleted();
              else settle(o, onClose, setError);
            }),
        },
        { id: 'cancel', label: CANCEL, variant: 'quiet', onPress: onClose },
      ]}
      note={error ?? check.reason}
    >
      <View style={{ marginTop: 16, gap: 8 }}>
        {libvirt ? (
          <SwitchLine label="Delete its disks and NVRAM too" value={purge} onChange={setPurge} />
        ) : null}
        <FormField
          label={`Type ${guest.name} to confirm`}
          value={typed}
          onChangeText={setTyped}
          mono
          autoCapitalize="none"
          autoCorrect={false}
          editable={guest.state === 'stopped'}
        />
      </View>
    </OneSheet>
  );
}

/** Restart to apply what waits for a restart (asked, as every restart is). */
export function RestartSheet({ serverId, serverName, guest, onClose }: SheetBase) {
  const { send, busy } = useGuestAction(serverId, guest);
  const [error, setError] = useState<string | null>(null);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={`${guest.name} · ${serverName}`}
      tone="warn"
      title={`Restart ${guest.name} now?`}
      body="It’s down for a moment while it restarts, then runs with the new settings."
      busy={busy}
      buttons={[
        {
          id: 'reboot',
          label: 'Restart now',
          variant: 'primary',
          onPress: () =>
            void send({ action: 'reboot', confirm: true }).then((o) => settle(o, onClose, setError)),
        },
        { id: 'cancel', label: CANCEL, variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    />
  );
}

/** Add to a backup job (PX-03, PX-07): the server's jobs; picking one adds the guest to it (its digest sent along). */
export function AddToJobSheet({ serverId, guest, onClose }: SheetBase) {
  const { slug, clock, timeZone } = useBurrowBase();
  const q = useHostManageRead(
    { params: { burrow: slug, serverId }, query: { op: 'backupjob.list', platform: 'pve' } },
    { retry: false },
  );
  const jobs: HostBackupJob[] = q.data?.op === 'backupjob.list' ? q.data.items : [];
  const { send, busy } = useManageChange(serverId);
  const [error, setError] = useState<string | null>(null);
  // The others' names for what a job covers (“Every guest but win11-test”).
  const all = useHostGuests(
    { params: { burrow: slug }, query: { server: serverId, limit: 200 } },
    { retry: false },
  );
  const rows = backupJobRows(jobs, all.data?.guests ?? [guest], clock().getTime(), timeZone).filter(
    (r) => !jobCovers(r.job, guest.id),
  );
  const add = (job: HostBackupJob) => {
    if (busy) return;
    const params = addToJobParams(job, guest.id);
    if (!params)
      return setError(
        `That job backs up the pool ${job.pool ?? ''}. Add ${guest.name} to the pool in Proxmox.`,
      );
    void send({
      op: 'backupjob.update',
      params,
      ...(job.digest ? { digest: job.digest } : {}),
      name: guest.name,
      done: `${guest.name} is in the backup plan now.`,
    }).then((o) => settle(o, onClose, setError));
  };
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={`Add ${guest.name} to a backup plan`}
      body="It’s backed up with the others at the job’s next run."
      busy={null}
      buttons={[{ id: 'cancel', label: CANCEL, variant: 'quiet', onPress: onClose }]}
      note={error}
    >
      <View style={{ marginTop: 16 }}>
        {q.isPending ? (
          <QuietText>Looking…</QuietText>
        ) : !rows.length ? (
          <OneCard>
            <CardQuiet>
              {jobs.length
                ? 'Every job already backs it up.'
                : 'This server has no backup plans yet. Ask your assistant to make one, or make one in Whombat on a computer.'}
            </CardQuiet>
          </OneCard>
        ) : (
          <OneCard>
            {rows.map((r, i) => (
              <OneRow
                key={r.id}
                first={i === 0}
                leading={<Dot tone={r.enabled ? 'ok' : null} />}
                title={r.title}
                line={r.line}
                meta={r.next}
                chevron
                label={r.label}
                hint={`Adds ${guest.name} to it`}
                onPress={() => add(r.job)}
              />
            ))}
          </OneCard>
        )}
      </View>
    </OneSheet>
  );
}
