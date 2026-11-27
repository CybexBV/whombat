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
  type BackupMode,
  backupJobRows,
  backupModes,
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
import { mobileTranslator, useI18n, useMobileT } from '../../i18n';
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
  const { t: tMobile } = useMobileT();
  const { send, busy } = useGuestAction(serverId, guest);
  const [error, setError] = useState<string | null>(null);
  const question =
    action.question ??
    (action.action === 'pause'
      ? tMobile('screens2.guest.pauseAsk', { name: guest.name })
      : tMobile('screens2.guest.actionAsk', { action: action.label, name: guest.name }));
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
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    />
  );
}

export type MoreChoice = 'backup' | 'snapshot' | 'clone' | 'rename' | 'delete';

function moreWords(locale?: string | null): Record<MoreChoice, string> {
  const tr = mobileTranslator(locale);
  return {
    backup: tr.t('screens2.common.backUpNow'),
    snapshot: tr.t('screens2.guest.takeSnapshot'),
    clone: tr.t('screens2.common.clone'),
    rename: tr.t('screens2.common.rename'),
    delete: tr.t('screens2.common.delete'),
  };
}

/**
 * More: what changes the guest as a whole, in this order — Proxmox: Back up now, Take a snapshot, Clone, Delete;
 * Incus (incus-unraid-mobile.md AP-1623): Back up now, Take a snapshot, Copy, Rename, Delete; this Whombat itself only
 * what stays allowed on it.
 */
export function MoreSheet({
  guest,
  choices,
  cloneWord: givenCloneWord,
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
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const cloneWord = givenCloneWord ?? tMobile('screens2.common.clone');
  return (
    <OneSheet
      visible
      onClose={onClose}
      title={guest.name}
      buttons={[
        ...choices.map((c) => ({
          id: c,
          label: c === 'clone' ? cloneWord : moreWords(rawLocale)[c],
          variant: 'secondary' as const,
          onPress: () => onPick(c),
        })),
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
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
  const { rawLocale } = useI18n();
  const backupModesHere = backupModes(rawLocale);
  const { t: tMobile } = useMobileT();
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
      title={tMobile('screens2.guest.backUpNowName', { name: guest.name })}
      body={tMobile('screens.the-backup-runs-on-the-server-you-can')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: tMobile('screens2.common.backUp'),
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
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error ?? (none ? tMobile('screens2.guest.noBackupStorage') : null)}
    >
      <View style={{ gap: 16, marginTop: 16 }}>
        {stores.ids.length ? (
          <Choices
            label={tMobile('screens.save-it-on')}
            options={stores.ids.map((id) => ({ value: id, label: id }))}
            value={target}
            onChange={setStorage}
          />
        ) : null}
        <Choices label={tMobile('screens.how')} options={backupModesHere} value={mode} onChange={setMode} />
      </View>
    </OneSheet>
  );
}

/** Take a snapshot: a name, a note, and for a running VM whether what's in memory comes too. */
export function SnapshotSheet({ serverId, guest, onClose }: SheetBase) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const { clock } = useBurrowBase();
  const [name, setName] = useState(() => defaultSnapshotName(clock().getTime()));
  const [note, setNote] = useState('');
  const [memory, setMemory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useGuestAction(serverId, guest);
  const bad = snapshotNameError(name.trim(), rawLocale);
  // Memory in a snapshot is Proxmox's; Incus needs stateful snapshots set up (the web's).
  const vmOn = guest.platform === 'pve' && guest.kind === 'vm' && guest.state === 'running';
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={tMobile('screens2.guest.snapshotOf', { name: guest.name })}
      body={tMobile('screens.you-can-go-back-to-it-later-it')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: tMobile('screens2.common.takeIt'),
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
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    >
      <View style={{ gap: 14, marginTop: 16 }}>
        <FormField
          label={tMobile('screens.name')}
          value={name}
          onChangeText={setName}
          error={name.trim() ? bad : null}
          mono
          autoCapitalize="none"
          autoCorrect={false}
        />
        <FormField
          label={tMobile('screens.note')}
          value={note}
          onChangeText={setNote}
          hint={tMobile('screens.optional')}
        />
        {vmOn ? (
          <SwitchLine
            label={tMobile('screens.include-whats-in-memory-it-resumes-exactly-where')}
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
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const { choices } = useChoices(serverId);
  const [name, setName] = useState(`${guest.name}-copy`);
  const [id, setId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const nameError = cloneNameError(name, rawLocale);
  const idCheck = newIdCheck(id, choices?.nextId, rawLocale);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={tMobile('screens2.guest.cloneName', { name: guest.name })}
      body={tMobile('screens.a-full-copy-with-its-own-disks-the')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: tMobile('screens2.common.clone'),
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
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    >
      <View style={{ gap: 14, marginTop: 16 }}>
        <FormField
          label={tMobile('screens.name')}
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
          hint={choices?.nextId ? tMobile('screens2.guest.nextFree', { id: choices.nextId }) : null}
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
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const check = deleteCheck(guest, typed, rawLocale);
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
      title={tMobile('screens2.guest.deleteAsk', { name: guest.name })}
      body={
        incus
          ? tMobile('screens2.guest.deleteIncus', { name: guest.name })
          : libvirt
            ? purge
              ? tMobile('screens2.guest.deleteWithDisks', { name: guest.name })
              : tMobile('screens2.guest.deleteKeepDisks', { name: guest.name })
            : tMobile('screens2.guest.deleteWithDisks', { name: guest.name })
      }
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: tMobile('screens2.common.delete'),
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
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error ?? check.reason}
    >
      <View style={{ marginTop: 16, gap: 8 }}>
        {libvirt ? (
          <SwitchLine
            label={tMobile('screens.delete-its-disks-and-nvram-too')}
            value={purge}
            onChange={setPurge}
          />
        ) : null}
        <FormField
          label={tMobile('screens2.guest.typeToConfirm', { name: guest.name })}
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
  const { t: tMobile } = useMobileT();
  const { send, busy } = useGuestAction(serverId, guest);
  const [error, setError] = useState<string | null>(null);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={`${guest.name} · ${serverName}`}
      tone="warn"
      title={tMobile('screens2.guest.restartAsk', { name: guest.name })}
      body={tMobile('screens.its-down-for-a-moment-while-it-restarts')}
      busy={busy}
      buttons={[
        {
          id: 'reboot',
          label: tMobile('screens2.common.restartNow'),
          variant: 'primary',
          onPress: () =>
            void send({ action: 'reboot', confirm: true }).then((o) => settle(o, onClose, setError)),
        },
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    />
  );
}

/** Add to a backup job (PX-03, PX-07): the server's jobs; picking one adds the guest to it (its digest sent along). */
export function AddToJobSheet({ serverId, guest, onClose }: SheetBase) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
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
  const rows = backupJobRows(
    jobs,
    all.data?.guests ?? [guest],
    clock().getTime(),
    timeZone,
    rawLocale,
  ).filter((r) => !jobCovers(r.job, guest.id));
  const add = (job: HostBackupJob) => {
    if (busy) return;
    const params = addToJobParams(job, guest.id);
    if (!params)
      return setError(tMobile('screens2.guest.poolJob', { pool: job.pool ?? '', name: guest.name }));
    void send({
      op: 'backupjob.update',
      params,
      ...(job.digest ? { digest: job.digest } : {}),
      name: guest.name,
      done: tMobile('screens2.guest.inPlan', { name: guest.name }),
    }).then((o) => settle(o, onClose, setError));
  };
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={tMobile('screens2.guest.addToPlan', { name: guest.name })}
      body={tMobile('screens.its-backed-up-with-the-others-at-the')}
      busy={null}
      buttons={[
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    >
      <View style={{ marginTop: 16 }}>
        {q.isPending ? (
          <QuietText>{tMobile('screens.looking')}</QuietText>
        ) : !rows.length ? (
          <OneCard>
            <CardQuiet>
              {jobs.length
                ? tMobile('screens.every-job-already-backs-it-up')
                : tMobile('screens.this-server-has-no-backup-plans-yet-ask')}
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
                hint={tMobile('screens2.guest.addsToIt', { name: guest.name })}
                onPress={() => add(r.job)}
              />
            ))}
          </OneCard>
        )}
      </View>
    </OneSheet>
  );
}
