// Settings › Agents dialogs: edit a server's group and location, delete a
// server (typed confirmation), approve or reject a pending enrollment.

import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { useServerSettings } from '../../api/queries';
import type { PendingEnrollment, ServerSettings } from '../../api/types';
import { errorText, InlineError, TextField } from '../../components/forms';
import { InlineRetry } from '../../components/InlineRetry';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { t, tx } from '../../lib/i18n';
import { PRODUCT_NAME } from '../../lib/product';
import { ApproveForm, GroupPicker, invalidateServerQueries, PendingDetails, pickedGroup } from './ApproveForm';
import { groupError } from './slug';

// ------------------------------------------------------------------ edit

function EditForm({ settings, onDone, onBusy }: { settings: ServerSettings; onDone: () => void; onBusy: (b: boolean) => void }) {
  const qc = useQueryClient();
  const [group, setGroup] = useState<{ mode: 'existing' | 'new'; existing: string; created: string }>({ mode: 'existing', existing: settings.group, created: '' });
  const [location, setLocation] = useState(settings.location ?? '');
  const [errors, setErrors] = useState<{ group?: string; location?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const g = pickedGroup(group);
    const ge = groupError(g);
    if (ge) return setErrors({ group: ge });
    setErrors({});
    setBusy(true);
    onBusy(true);
    try {
      const next = await api.patchServer(settings.id, { group: g, location: location.trim() });
      if (next && typeof next === 'object') qc.setQueryData(['settings', settings.id], next);
      invalidateServerQueries(qc, settings.id);
      toast(t('Saved {name}', { name: settings.id }), 'success');
      onBusy(false);
      onDone();
    } catch (err) {
      setBusy(false);
      onBusy(false);
      if (err instanceof ApiError && err.code === 'invalid_group') return setErrors({ group: err.message });
      setErrors({ form: err instanceof ApiError && err.status === 403 ? t('Editing servers requires admin access.') : errorText(err) });
    }
  };

  return (
    <form className="form-stack" onSubmit={(e) => void submit(e)} noValidate>
      {errors.form && <InlineError>{errors.form}</InlineError>}
      <GroupPicker value={group} onChange={setGroup} current={settings.group} error={errors.group} disabled={busy} />
      <TextField
        label={t('Location')}
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        placeholder={t('e.g. Rack A, unit 4')}
        maxLength={128}
        hint={t('Optional. Shown on the server page.')}
        disabled={busy}
      />
      <div className="modal-actions">
        <button type="button" className="btn-ghost" onClick={onDone} disabled={busy}>
          {t('Cancel')}
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy && <span className="spinner on-primary" aria-hidden="true" />}
          {busy ? t('Saving…') : t('Save')}
        </button>
      </div>
    </form>
  );
}

export function EditServerDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const settings = useServerSettings(id);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} busy={busy} title={tx('Edit {name}', { name: <span className="mono">{id}</span> })}>
      {settings.isError ? (
        <InlineRetry title={t('Could not load the settings')} error={settings.error} onRetry={() => void settings.refetch()} />
      ) : !settings.data ? (
        <div className="enroll-status" aria-busy="true">
          <span className="spinner" aria-hidden="true" />
          <span>{t('Loading…')}</span>
        </div>
      ) : (
        <EditForm settings={settings.data} onDone={onClose} onBusy={setBusy} />
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ delete

/** `onDeleted` runs instead of `onClose` after a successful delete (e.g. to leave the server's page). */
export function DeleteServerDialog({ id, onClose, onDeleted }: { id: string; onClose: () => void; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const match = typed.trim() === id;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!match || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteServer(id);
      qc.removeQueries({ queryKey: ['server', id] });
      qc.removeQueries({ queryKey: ['settings', id] });
      invalidateServerQueries(qc);
      toast(t('{name} was deleted', { name: id }), 'success');
      (onDeleted ?? onClose)();
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiError && err.status === 403 ? t('Deleting servers requires admin access.') : errorText(err));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      tone="serious"
      title={tx('Delete {name}?', { name: <span className="mono">{id}</span> })}
      description={tx(
        'This removes {name} from {product}: its agent certificate is revoked, live console sessions on it are closed, and its metrics and alerts are deleted. The audit log is kept. To monitor the host again, enroll it again.',
        { name: <span className="mono ink">{id}</span>, product: PRODUCT_NAME },
      )}
    >
      <form className="form-stack" onSubmit={(e) => void submit(e)} noValidate>
        {error && <InlineError>{error}</InlineError>}
        <TextField
          label={tx('Type {name} to confirm', { name: <span className="mono">{id}</span> })}
          mono
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          disabled={busy}
        />
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn-primary is-serious" disabled={!match || busy}>
            {busy && <span className="spinner on-primary" aria-hidden="true" />}
            {busy ? t('Deleting…') : t('Delete server')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ pending enrollments

export function ApproveDialog({ pending, onClose }: { pending: PendingEnrollment; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      wide
      title={tx('Approve {name}', { name: <span className="mono">{pending.hostname ?? pending.id}</span> })}
      description={t('The server is added with remote control off. Choose its name and group.')}
    >
      <PendingDetails p={pending} />
      <ApproveForm
        pending={pending}
        autoFocusName
        onBusyChange={setBusy}
        onApproved={(serverId, group) => {
          toast(t('{server} was added to {group}. Remote control is off until you enable it.', { server: serverId, group }), 'success');
          onClose();
        }}
        secondary={(approving) => (
          <button type="button" className="btn-ghost" onClick={onClose} disabled={approving}>
            {t('Cancel')}
          </button>
        )}
      />
    </Modal>
  );
}

export function RejectDialog({ pending, onClose }: { pending: PendingEnrollment; onClose: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const host = pending.hostname ?? pending.id;
  const reject = async () => {
    setBusy(true);
    setError('');
    try {
      await api.rejectEnrollment(pending.id);
      void qc.invalidateQueries({ queryKey: ['enrollments'] });
      toast(t('Rejected the request from {host}', { host }), 'success');
      onClose();
    } catch (err) {
      setBusy(false);
      setError(errorText(err));
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      tone="serious"
      title={tx('Reject {name}?', { name: <span className="mono">{host}</span> })}
      description={t('The agent’s request is discarded and the host is not added. To enroll it later, create a new install command.')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn-primary is-serious" onClick={() => void reject()} disabled={busy}>
            {busy && <span className="spinner on-primary" aria-hidden="true" />}
            {busy ? t('Rejecting…') : t('Reject')}
          </button>
        </>
      }
    >
      {error && <InlineError>{error}</InlineError>}
    </Modal>
  );
}
