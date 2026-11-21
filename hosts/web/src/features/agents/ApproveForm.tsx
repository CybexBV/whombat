// Approval of a pending agent (CONTRACT 3): the request's details and a form
// for the server name and group. Used by the enrollment dialog and by the
// Approve dialog on the Agents page.

import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { useGroups } from '../../api/queries';
import type { PendingEnrollment } from '../../api/types';
import { errorText, InlineError, SelectField, TextField } from '../../components/forms';
import { useNow } from '../../lib/clock';
import { DASH, formatAgoIso, formatFull } from '../../lib/format';
import { t } from '../../lib/i18n';
import { groupError, serverNameError, slugify } from './slug';

const NEW_GROUP = '__new__';

/** Queries that change when a server is added, edited or removed. */
export function invalidateServerQueries(qc: ReturnType<typeof useQueryClient>, id?: string): void {
  for (const queryKey of [['agents'], ['servers'], ['fleet'], ['fleetSeries'], ['groups'], ['enrollments'], ...(id ? [['server', id], ['settings', id]] : [])]) {
    void qc.invalidateQueries({ queryKey });
  }
}

/** "v0.14.2" (the hub sends the bare version). */
export function formatVersion(v: string | null | undefined): string {
  return v ? `v${v.replace(/^v/, '')}` : DASH;
}

export function PendingDetails({ p }: { p: PendingEnrollment }) {
  const now = useNow();
  const items: { k: string; v: ReactNode; mono?: boolean }[] = [
    { k: t('Host name'), v: p.hostname ?? DASH, mono: true },
    { k: t('Operating system'), v: p.os ?? DASH },
    { k: t('Address'), v: p.address ?? DASH, mono: true },
    { k: t('Agent version'), v: formatVersion(p.agent_version) },
    {
      k: t('Requested'),
      v: p.requested_at ? (
        <time dateTime={p.requested_at} title={formatFull(Date.parse(p.requested_at))}>
          {formatAgoIso(p.requested_at, now)}
        </time>
      ) : (
        DASH
      ),
    },
  ];
  return (
    <dl className="kv-grid">
      {items.map((it) => (
        <div key={it.k}>
          <dt className="lbl">{it.k}</dt>
          <dd className={it.mono ? 'mono' : undefined}>{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Group select of the labels in use plus "New group…", which reveals a text field. */
export function GroupPicker({
  value,
  onChange,
  error,
  disabled,
  current,
}: {
  value: { mode: 'existing' | 'new'; existing: string; created: string };
  onChange: (v: { mode: 'existing' | 'new'; existing: string; created: string }) => void;
  error?: string;
  disabled?: boolean;
  /** Group of the server being edited (listed even if /groups lacks it). */
  current?: string;
}) {
  const groups = useGroups();
  const list = [...new Set([...(groups.data ?? []), ...(current ? [current] : [])])].filter((g) => g.toLowerCase() !== 'all');

  // Pick a default once the list arrives; with no groups at all, start a new one.
  useEffect(() => {
    if (value.mode === 'existing' && !value.existing && groups.data) {
      if (list.length) onChange({ ...value, existing: list[0]! });
      else onChange({ ...value, mode: 'new' });
    }
  }, [groups.data]);

  return (
    <>
      <SelectField
        label={t('Group')}
        value={value.mode === 'new' ? NEW_GROUP : value.existing}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === NEW_GROUP ? { ...value, mode: 'new' } : { ...value, mode: 'existing', existing: v });
        }}
        error={value.mode === 'existing' ? error : undefined}
        disabled={disabled}
        hint={groups.isError ? t('Could not load the groups; create one by name.') : undefined}
      >
        {value.mode === 'existing' && !value.existing && <option value="">{groups.isPending ? t('Loading…') : t('Choose a group')}</option>}
        {list.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
        <option value={NEW_GROUP}>{t('New group…')}</option>
      </SelectField>
      {value.mode === 'new' && (
        <TextField
          label={t('New group name')}
          value={value.created}
          onChange={(e) => onChange({ ...value, created: e.target.value })}
          placeholder={t('e.g. Lab')}
          maxLength={64}
          error={error}
          disabled={disabled}
          autoFocus
        />
      )}
    </>
  );
}

export function pickedGroup(v: { mode: 'existing' | 'new'; existing: string; created: string }): string {
  return (v.mode === 'new' ? v.created : v.existing).trim();
}

interface ApproveFormProps {
  pending: PendingEnrollment;
  /** Name suggestion (e.g. the Proxmox node the dialog was opened for). */
  initialName?: string | null;
  onApproved: (serverId: string, group: string) => void;
  /** Buttons left of Approve (Cancel / Reject). */
  secondary?: (busy: boolean) => ReactNode;
  onBusyChange?: (busy: boolean) => void;
  autoFocusName?: boolean;
}

export function ApproveForm({ pending, initialName, onApproved, secondary, onBusyChange, autoFocusName }: ApproveFormProps) {
  const qc = useQueryClient();
  const formId = useId();
  const [name, setName] = useState(() => slugify(initialName || pending.hostname || ''));
  const [group, setGroup] = useState<{ mode: 'existing' | 'new'; existing: string; created: string }>({ mode: 'existing', existing: '', created: '' });
  const [errors, setErrors] = useState<{ name?: string; group?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const g = pickedGroup(group);
    const errs = { name: serverNameError(name) ?? undefined, group: groupError(g) ?? undefined };
    setErrors(errs);
    if (errs.name || errs.group) return;
    setBusy(true);
    try {
      const res = await api.approveEnrollment(pending.id, g, name.trim().toLowerCase());
      invalidateServerQueries(qc, res?.server_id);
      setBusy(false);
      onApproved(res?.server_id || name.trim().toLowerCase(), g);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError) {
        if (err.code === 'server_exists' || err.code === 'invalid_name') return setErrors({ name: err.message });
        if (err.code === 'invalid_group') return setErrors({ group: err.message });
        if (err.code === 'not_pending') {
          void qc.invalidateQueries({ queryKey: ['enrollments'] });
          return setErrors({ form: t('This request is no longer pending: it was approved, rejected or has expired.') });
        }
        if (err.status === 403) return setErrors({ form: t('Approving servers requires admin access.') });
      }
      setErrors({ form: errorText(err) });
    }
  };

  return (
    <form id={formId} className="form-stack" onSubmit={(e) => void submit(e)} noValidate>
      {errors.form && <InlineError>{errors.form}</InlineError>}
      <div className="form-grid">
        <TextField
          label={t('Server name')}
          mono
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={63}
          hint={t('Letters, digits and dashes. Used in addresses (/servers/name).')}
          error={errors.name}
          disabled={busy}
          autoFocus={autoFocusName}
        />
        <div className="form-stack">
          <GroupPicker value={group} onChange={setGroup} error={errors.group} disabled={busy} />
        </div>
      </div>
      <div className="modal-actions">
        {secondary?.(busy)}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy && <span className="spinner on-primary" aria-hidden="true" />}
          {busy ? t('Approving…') : t('Approve')}
        </button>
      </div>
    </form>
  );
}
