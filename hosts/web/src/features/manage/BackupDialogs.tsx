// Backups of a Proxmox guest (docs/MANAGE.md, Backups tab): Back up now
// (storage, mode, compression unless PBS, notes, protected) and Restore…
// (as a new guest, or over this guest when it is stopped). Both start a
// task; the dialog closes and the task toast follows it.

import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { type BackupInput, type BackupVolume, manageApi, useChoices } from '../../api/manage';
import { SegmentedControl } from '../../components/controls';
import { InlineError, SelectField, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { formatDayTime, formatGb } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { storagesWith } from './createForm';
import { type GuestRef, started } from './LifecycleDialogs';
import { fieldErrors, manageErrorText } from './manageErrors';

const MODES: { value: NonNullable<BackupInput['mode']>; label: string; hint: string }[] = [
  { value: 'snapshot', label: t('Snapshot'), hint: t('The guest keeps running; the backup reads a consistent point in time.') },
  { value: 'suspend', label: t('Suspend'), hint: t('The guest is paused while the backup starts, then resumes.') },
  { value: 'stop', label: t('Stop'), hint: t('The guest is shut down for the backup and started again afterwards.') },
];

const COMPRESS: NonNullable<BackupInput['compress']>[] = ['zstd', 'lzo', 'gzip', 'none'];

interface Props {
  serverId: string;
  guest: GuestRef;
  onClose: () => void;
}

export function BackupNowDialog({ serverId, guest, onClose }: Props) {
  const choices = useChoices(serverId, 'pve');
  const targets = storagesWith(choices.data, 'backup');
  const [storage, setStorage] = useState('');
  const [mode, setMode] = useState<NonNullable<BackupInput['mode']>>('snapshot');
  const [compress, setCompress] = useState<NonNullable<BackupInput['compress']>>('zstd');
  const [notes, setNotes] = useState('{{guestname}}');
  const [prot, setProt] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // A Proxmox Backup Server first (deduplicated, verified), else the first backup storage.
  const chosen = storage || (targets.find((s) => s.type === 'pbs') ?? targets[0])?.id || '';
  const pbs = targets.find((s) => s.id === chosen)?.type === 'pbs';

  const save = useMutation({
    mutationFn: () => manageApi.backup(serverId, guest.id, { storage: chosen, mode, ...(pbs ? {} : { compress }), notes: notes.trim() || undefined, protected: prot || undefined }),
    onSuccess: (r) => {
      started(serverId, 'pve', r, t('Back up {name}', { name: guest.name }), t('{name} backed up.', { name: guest.name }));
      onClose();
    },
    onError: (err) => setErrors(fieldErrors(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (chosen && !save.isPending) save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      title={tx('Back up {name}', { name: <span className="mono">{guest.name}</span> })}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="backup-form" className="btn-primary btn-sm" disabled={!chosen || save.isPending}>
            {t('Back up now')}
          </button>
        </>
      }
    >
      <form id="backup-form" className="form-stack" onSubmit={submit} noValidate>
        <SelectField label={t('Storage')} value={chosen} error={errors.storage} disabled={!targets.length} onChange={(e) => setStorage(e.target.value)} autoFocus>
          {!targets.length && <option value="">{choices.isPending ? t('Loading…') : t('No backup storage on this host')}</option>}
          {targets.map((s) => (
            <option key={s.id} value={s.id}>
              {[s.id, s.type === 'pbs' ? 'Proxmox Backup Server' : s.type, s.avail_bytes != null ? t('{free} free', { free: formatGb(s.avail_bytes / 1e9) }) : ''].filter(Boolean).join(' · ')}
            </option>
          ))}
        </SelectField>
        <div className="field">
          <span className="field-label">{t('Mode')}</span>
          <SegmentedControl label={t('Mode')} value={mode} onChange={setMode} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
          <span className="field-hint">{MODES.find((m) => m.value === mode)?.hint}</span>
        </div>
        {!pbs && (
          <SelectField label={t('Compression')} value={compress} onChange={(e) => setCompress(e.target.value as typeof compress)}>
            {COMPRESS.map((c) => (
              <option key={c} value={c}>
                {c === 'zstd' ? t('ZSTD (fast and good)') : c === 'none' ? t('None') : c.toUpperCase()}
              </option>
            ))}
          </SelectField>
        )}
        <TextField label={t('Notes')} value={notes} maxLength={500} hint={t('{{guestname}}, {{vmid}} and {{node}} are filled in.')} error={errors.notes} onChange={(e) => setNotes(e.target.value)} />
        <label className="check-row">
          <input type="checkbox" checked={prot} onChange={(e) => setProt(e.target.checked)} />
          {t('Protect it (pruning and deleting skip protected backups)')}
        </label>
        {save.isError && <InlineError>{manageErrorText(save.error, ['storage', 'notes'])}</InlineError>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- restore

export function RestoreDialog({ serverId, guest, backup, onClose }: Props & { backup: BackupVolume }) {
  const choices = useChoices(serverId, 'pve');
  const disks = storagesWith(choices.data, guest.kind === 'vm' ? 'images' : 'rootdir');
  const [target, setTarget] = useState<'new' | 'over'>('new');
  const [vmid, setVmid] = useState('');
  const [storage, setStorage] = useState('');
  const [start, setStart] = useState(false);
  const [unique, setUnique] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const runningNow = guest.state !== 'stopped';
  const over = target === 'over';
  const when = backup.created ? formatDayTime(Date.parse(backup.created)) : backup.volume;

  const save = useMutation({
    mutationFn: () =>
      manageApi.restore(serverId, {
        platform: 'pve',
        volume: backup.volume,
        ...(over ? { guest: guest.id, confirm: true } : { new_id: vmid.trim() ? Number(vmid) : undefined, unique }),
        ...(storage ? { storage } : {}),
        start: start || undefined,
      }),
    onSuccess: (r) => {
      started(serverId, 'pve', r, over ? t('Restore {name}', { name: guest.name }) : t('Restore {name} as a new guest', { name: guest.name }), t('{name} restored.', { name: guest.name }));
      onClose();
    },
    onError: (err) => setErrors(fieldErrors(err)),
  });
  const blocked = over && runningNow;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const idErr = !over && vmid.trim() && !(/^\d+$/.test(vmid.trim()) && Number(vmid) >= 100) ? t('Use an ID from 100 to 999999999.') : undefined;
    setErrors(idErr ? { new_id: idErr } : {});
    if (!idErr && !blocked && !save.isPending) save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      tone={over ? 'serious' : 'default'}
      title={t('Restore the backup of {time}', { time: when })}
      description={tx('From {volume} on {storage}.', { volume: <span className="mono">{backup.volume.split('/').pop()}</span>, storage: <span className="mono">{backup.storage}</span> })}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className={`btn-primary btn-sm${over ? ' is-serious' : ''}`} aria-disabled={blocked || save.isPending || undefined} onClick={() => submit()}>
            {over ? t('Replace the disks of {name}', { name: guest.name }) : t('Restore as a new guest')}
          </button>
        </>
      }
    >
      <form className="form-stack" onSubmit={submit} noValidate>
        <SegmentedControl
          label={t('Restore to')}
          value={target}
          onChange={setTarget}
          options={[
            { value: 'new', label: t('A new guest') },
            { value: 'over', label: t('Over {name}', { name: guest.name }) },
          ]}
        />
        {over ? (
          blocked ? (
            <InlineError>{t('{name} is running: shut it down first, a restore replaces its disks.', { name: guest.name })}</InlineError>
          ) : (
            <p className="warn-line">
              <span className="warn-ic">
                <Icon name="warning" size={16} />
              </span>
              <span>{t('The disks and settings of {name} are replaced with the backup. Changes made since {time} are lost.', { name: guest.name, time: when })}</span>
            </p>
          )
        ) : (
          <TextField label={t('VM ID')} inputMode="numeric" mono value={vmid} placeholder={choices.data?.next_id ? String(choices.data.next_id) : t('Next free')} error={errors.new_id} onChange={(e) => setVmid(e.target.value)} />
        )}
        <SelectField label={t('Target storage')} value={storage} error={errors.storage} onChange={(e) => setStorage(e.target.value)}>
          <option value="">{t('As in the backup')}</option>
          {disks.map((s) => (
            <option key={s.id} value={s.id}>
              {s.avail_bytes != null ? t('{name} · {free} free', { name: s.id, free: formatGb(s.avail_bytes / 1e9) }) : s.id}
            </option>
          ))}
        </SelectField>
        {!over && (
          <label className="check-row">
            <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
            {t('New MAC addresses (unique), so it can run next to the original')}
          </label>
        )}
        <label className="check-row">
          <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
          {t('Start after the restore')}
        </label>
        {save.isError && <InlineError>{manageErrorText(save.error, ['new_id', 'storage'])}</InlineError>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- notes

export function BackupNotesDialog({ serverId, backup, onClose, onSaved }: { serverId: string; backup: BackupVolume; onClose: () => void; onSaved: () => void }) {
  const [notes, setNotes] = useState(backup.notes ?? '');
  const save = useMutation({
    mutationFn: () => manageApi.updateBackup(serverId, 'pve', backup.volume, { notes: notes.trim() }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      title={t('Notes of the backup of {time}', { time: backup.created ? formatDayTime(Date.parse(backup.created)) : backup.volume })}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="notes-form" className="btn-primary btn-sm" disabled={save.isPending}>
            {t('Save')}
          </button>
        </>
      }
    >
      <form
        id="notes-form"
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField label={t('Notes')} value={notes} maxLength={500} autoFocus onChange={(e) => setNotes(e.target.value)} />
        {save.isError && <InlineError>{manageErrorText(save.error)}</InlineError>}
      </form>
    </Modal>
  );
}
