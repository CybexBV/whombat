// Clone, convert to template and delete (admins; docs/MANAGE.md 1): one
// dialog each, used by the guest page's lifecycle menu and the host's
// templates list. Every change starts a task: the dialog closes and the
// task toast follows it; onStarted lets the caller act when it ends.

import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { type ManagePlatform, type ManageResult, manageApi, useChoices, useGuestConfig } from '../../api/manage';
import type { Guest } from '../../api/types';
import { SegmentedControl } from '../../components/controls';
import { InlineError, SelectField, TextField } from '../../components/forms';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { formatGb } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { announceTask } from '../guest/taskEvents';
import { nameError, storagesWith } from './createForm';
import { fieldErrors, manageErrorText } from './manageErrors';

/** What the dialogs need of a guest or template. */
export type GuestRef = Pick<Guest, 'id' | 'name' | 'kind' | 'state'> & { platform: ManagePlatform; vmid?: number };

interface DialogProps {
  serverId: string;
  guest: GuestRef;
  onClose: () => void;
  /** The change started a task (or finished at once: taskId null). */
  onStarted?: (taskId: string | null, result: ManageResult) => void;
}

/** After a 202: the task toast; a change done at once: a success toast. */
export function started(serverId: string, platform: ManagePlatform, r: ManageResult, label: string, done: string): string | null {
  if (r.task?.id) {
    announceTask(serverId, platform, r.task.id, label);
    return r.task.id;
  }
  toast(done, 'success');
  return null;
}

const running = (g: Pick<Guest, 'state'>) => g.state !== 'stopped';
const vmidOf = (g: GuestRef) => g.vmid ?? (g.platform === 'pve' ? Number(g.id.split(':')[1]) : undefined);

// ---------------------------------------------------------------- clone

export function CloneDialog({ serverId, guest, template = false, onClose, onStarted }: DialogProps & { template?: boolean }) {
  const pve = guest.platform === 'pve';
  const choices = useChoices(serverId, guest.platform);
  const nextId = choices.data?.next_id;
  const [vmid, setVmid] = useState('');
  const [name, setName] = useState(`${guest.name}-clone`);
  const [full, setFull] = useState(!template);
  const [storage, setStorage] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const disks = storagesWith(choices.data, guest.kind === 'vm' || !pve ? 'images' : 'rootdir');

  const save = useMutation({
    mutationFn: () =>
      manageApi.clone(serverId, guest.id, {
        ...(pve ? { new_id: vmid.trim() ? Number(vmid) : undefined, full } : {}),
        name: name.trim(),
        ...((full || !pve) && storage ? { storage } : {}),
      }),
    onSuccess: (r) => {
      const id = started(serverId, guest.platform, r, t('Clone {name}', { name: guest.name }), t('{name} cloned.', { name: guest.name }));
      onStarted?.(id, r);
      onClose();
    },
    onError: (err) => setErrors(fieldErrors(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = {
      name: nameError(name),
      new_id: vmid.trim() && !(/^\d+$/.test(vmid.trim()) && Number(vmid) >= 100) ? t('Use an ID from 100 to 999999999.') : undefined,
    };
    setErrors(errs);
    if (!Object.values(errs).some(Boolean)) save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      title={tx('Clone {name}', { name: <span className="mono">{guest.name}</span> })}
      description={template ? t('A linked clone shares the template’s disks and is made in seconds; a full clone copies them.') : t('The clone gets copies of all disks and new MAC addresses.')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="clone-form" className="btn-primary btn-sm" disabled={save.isPending}>
            {t('Clone')}
          </button>
        </>
      }
    >
      <form id="clone-form" className="form-stack" onSubmit={submit} noValidate>
        <div className="form-grid">
          {pve && (
            <TextField label={t('VM ID')} inputMode="numeric" mono value={vmid} placeholder={nextId ? String(nextId) : t('Next free')} error={errors.new_id} onChange={(e) => setVmid(e.target.value)} />
          )}
          <TextField label={t('Name')} mono value={name} autoFocus autoComplete="off" spellCheck={false} error={errors.name} onChange={(e) => setName(e.target.value)} />
        </div>
        {pve && template && (
          <SegmentedControl
            label={t('Clone mode')}
            value={full ? 'full' : 'linked'}
            onChange={(v) => setFull(v === 'full')}
            options={[
              { value: 'linked', label: t('Linked clone') },
              { value: 'full', label: t('Full clone') },
            ]}
          />
        )}
        {(full || !pve) && (
          <SelectField label={pve ? t('Target storage') : t('Storage pool')} value={storage} error={errors.storage} onChange={(e) => setStorage(e.target.value)}>
            <option value="">{t('Same as the source')}</option>
            {disks.map((s) => (
              <option key={s.id} value={s.id}>
                {s.avail_bytes != null ? t('{name} · {free} free', { name: s.id, free: formatGb(s.avail_bytes / 1e9) }) : s.id}
              </option>
            ))}
          </SelectField>
        )}
        {save.isError && <InlineError>{manageErrorText(save.error, ['name', 'new_id', 'storage'])}</InlineError>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- convert to template

export function ConvertTemplateDialog({ serverId, guest, onClose, onStarted }: DialogProps) {
  const busy = running(guest);
  const save = useMutation({
    mutationFn: () => manageApi.convertToTemplate(serverId, guest.id),
    onSuccess: (r) => {
      const id = started(serverId, guest.platform, r, t('Convert {name} to a template', { name: guest.name }), t('{name} is now a template.', { name: guest.name }));
      onStarted?.(id, r);
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      tone="serious"
      title={t('Convert {name} to a template?', { name: guest.name })}
      description={t('A template cannot be started or changed, only cloned. This cannot be undone.')}
      actions={
        <>
          <button type="button" className="btn-ghost" autoFocus onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn-primary btn-sm is-serious" aria-disabled={busy || save.isPending || undefined} onClick={() => !busy && !save.isPending && save.mutate()}>
            {t('Convert to template')}
          </button>
        </>
      }
    >
      {busy && <InlineError>{t('Shut {name} down first: only stopped guests can become templates.', { name: guest.name })}</InlineError>}
      {save.isError && <InlineError>{manageErrorText(save.error)}</InlineError>}
    </Modal>
  );
}

// ---------------------------------------------------------------- delete

export function DeleteGuestDialog({ serverId, guest, template = false, onClose, onStarted }: DialogProps & { template?: boolean }) {
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [purge, setPurge] = useState(true);
  const pve = guest.platform === 'pve';
  // Protection lives in the configuration (templates have none to read here).
  const config = useGuestConfig(serverId, guest.id, !template);
  const protectedOn = config.data?.values.protection === '1' || config.data?.values['security.protection.delete'] === 'true';
  const busy = !template && running(guest);
  const blocked = busy || protectedOn;
  const ready = typed.trim() === guest.name && !blocked;
  const vmid = vmidOf(guest);

  const save = useMutation({
    mutationFn: () => manageApi.deleteGuest(serverId, guest.id, guest.name, pve && purge),
    onSuccess: (r) => {
      const id = started(serverId, guest.platform, r, t('Delete {name}', { name: guest.name }), t('{name} deleted.', { name: guest.name }));
      onStarted?.(id, r);
      onClose();
    },
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (ready && !save.isPending) save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      tone="serious"
      title={t('Delete {name}?', { name: guest.name })}
      description={
        pve && vmid
            ? t('{name} (ID {id}) and all its disks are removed from {server}. This cannot be undone.', { name: guest.name, id: vmid, server: serverId })
            : t('{name} and all its disks are removed from {server}. This cannot be undone.', { name: guest.name, server: serverId })
      }
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn-primary btn-sm is-serious" aria-disabled={!ready || save.isPending || undefined} onClick={() => submit()}>
            {t('Delete {name}', { name: guest.name })}
          </button>
        </>
      }
    >
      {busy && <InlineError>{t('{name} is running: stop it first, running guests cannot be deleted.', { name: guest.name })}</InlineError>}
      {protectedOn && <InlineError>{t('Protection is on for {name}: turn it off in Options first.', { name: guest.name })}</InlineError>}
      <form className="form-stack" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor={inputId}>
            {tx('Type {name} to confirm', { name: <span className="mono">{guest.name}</span> })}
          </label>
          <input id={inputId} className="input mono" autoFocus autoComplete="off" spellCheck={false} disabled={blocked} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
        {pve && (
          <label className="check-row">
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} disabled={blocked} />
            {t('Also remove it from backup jobs, replication and HA')}
          </label>
        )}
      </form>
      {save.isError && <InlineError>{manageErrorText(save.error)}</InlineError>}
    </Modal>
  );
}
