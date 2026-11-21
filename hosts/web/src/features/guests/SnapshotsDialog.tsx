// Snapshots of a guest: the list from the agent, a create form (name,
// optional description, memory state for Proxmox and libvirt VMs), and roll
// back / delete with a confirmation step inside the same dialog. Actions run
// through the shared action runner (toast with the outcome, list refreshed).
// The guest page's Snapshots tab shows the same pieces inline.

import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useSnapshots } from '../../api/queries';
import type { Guest, Snapshot, SnapshotAction, SnapshotArgs } from '../../api/types';
import { Chip } from '../../components/controls';
import { errorText, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Modal } from '../../components/Modal';
import { Skeleton } from '../../components/common';
import { useNow } from '../../lib/clock';
import { formatAgoIso, formatFull, formatGb } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { actionText } from '../console/labels';
import { refreshAfterAction, runPowerAction, useActionState } from '../console/powerActions';
import { snapshotMemory, snapshotNameError } from './guestActions';
import { toastResult } from './GuestMenu';

interface Props {
  serverId: string;
  guest: Pick<Guest, 'id' | 'name' | 'platform' | 'kind' | 'state'>;
  onClose: () => void;
}

type Pending = { action: 'snapshot_restore' | 'snapshot_delete'; snap: Snapshot } | null;

/**
 * The snapshot list with its create form and the roll back / delete
 * confirmation, as pieces: the dialog swaps itself for the confirmation,
 * the guest page's Snapshots tab shows it over the page.
 */
export function useSnapshotsPanel(serverId: string, guest: Props['guest']) {
  const qc = useQueryClient();
  const list = useSnapshots(serverId, guest.id);
  const state = useActionState(serverId, guest.id);
  const now = useNow();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memory, setMemory] = useState(false);
  const [confirm, setConfirm] = useState<Pending>(null);
  const nameError = snapshotNameError(name, guest.platform);
  const busy = state.pending ? actionText(state.pending.action).pending : null;

  const run = (action: SnapshotAction, args: SnapshotArgs) =>
    void runPowerAction(serverId, guest.id, action, { args, onDone: () => refreshAfterAction(qc, serverId, guest.id) }).then((r) => {
      toastResult(guest.name, r);
      if (r?.ok && action === 'snapshot_create') {
        setName('');
        setDescription('');
      }
    });

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (nameError || busy) return;
    run('snapshot_create', { snapshot: name.trim() || undefined, description: description.trim() || undefined, memory: memory || undefined });
  };

  let confirmDialog: ReactNode = null;
  if (confirm) {
    const restore = confirm.action === 'snapshot_restore';
    const snap = confirm.snap.name;
    confirmDialog = (
      <Modal
        open
        onClose={() => setConfirm(null)}
        tone="serious"
        title={restore ? t('Roll back {name} to {snapshot}?', { name: guest.name, snapshot: snap }) : t('Delete snapshot {snapshot}?', { snapshot: snap })}
        description={
          restore
            ? guest.state === 'stopped'
              ? t('{name} returns to the state of {snapshot}. Changes made since then are lost.', { name: guest.name, snapshot: snap })
              : t('{name} returns to the state of {snapshot}. Changes made since then are lost and the guest may restart.', { name: guest.name, snapshot: snap })
            : t('The snapshot {snapshot} of {name} is removed. This cannot be undone.', { name: guest.name, snapshot: snap })
        }
        actions={
          <>
            <button type="button" className="btn-ghost" autoFocus onClick={() => setConfirm(null)}>
              {t('Cancel')}
            </button>
            <button
              type="button"
              className="btn-primary btn-sm is-serious"
              onClick={() => {
                setConfirm(null);
                run(confirm.action, { snapshot: snap });
              }}
            >
              {restore ? t('Roll back') : t('Delete')}
            </button>
          </>
        }
      />
    );
  }

  const form = (
    <form className="form-stack" onSubmit={create}>
      <div className="form-grid">
        <TextField
          label={t('Name')}
          mono
          value={name}
          maxLength={40}
          placeholder={t('Automatic (rackoon-date-time)')}
          autoComplete="off"
          spellCheck={false}
          error={nameError ?? undefined}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField label={t('Description (optional)')} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {snapshotMemory(guest) && guest.state !== 'stopped' && (
        <label className="check-row">
          <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} />
          {t('Include memory (the running state, not only the disks)')}
        </label>
      )}
      <div className="form-actions is-start">
        <button type="submit" className="btn-primary" disabled={!!nameError || !!busy}>
          <Icon name="plus" size={15} />
          {t('Create snapshot')}
        </button>
        {busy && (
          <span className="state lbl" role="status">
            <span className="spinner spinner-sm" aria-hidden="true" /> {busy}
          </span>
        )}
      </div>
    </form>
  );

  const items = list.data?.items ?? [];
  const listNode = list.isError ? (
    <InlineRetry title={t('Could not list the snapshots')} error={errorText(list.error)} onRetry={() => void list.refetch()} />
  ) : !list.data ? (
    <Skeleton height={72} />
  ) : items.length === 0 ? (
    <p className="lbl">{t('No snapshots yet.')}</p>
  ) : (
    <ul className="plain-list" aria-label={t('Snapshots of {name}', { name: guest.name })}>
      {[...items].reverse().map((s) => (
        <li key={s.name} className="ch-row">
          <div className="ch-main">
            <div className="ch-line1">
              <span className="mono strong">{s.name}</span>
              {s.current && <Chip className="chip-sm">{t('current')}</Chip>}
              {s.memory && <Chip className="chip-sm">{t('with memory')}</Chip>}
            </div>
            <div className="lbl">
              {s.created ? (
                <time dateTime={s.created} title={formatFull(Date.parse(s.created))}>
                  {formatAgoIso(s.created, now)}
                </time>
              ) : (
                t('Time unknown')
              )}
              {s.size_bytes != null ? ` · ${formatGb(s.size_bytes / 1e9)}` : ''}
              {s.description ? ` · ${s.description}` : ''}
            </div>
          </div>
          <button type="button" className="btn-ghost row-action" disabled={!!busy} onClick={() => setConfirm({ action: 'snapshot_restore', snap: s })}>
            {t('Roll back')}
            <span className="sr-only"> {t('to {name}', { name: s.name })}</span>
          </button>
          <button
            type="button"
            className="btn-ghost btn-icon row-action is-serious"
            aria-label={t('Delete {name}', { name: s.name })}
            title={t('Delete')}
            disabled={!!busy}
            onClick={() => setConfirm({ action: 'snapshot_delete', snap: s })}
          >
            <Icon name="trash" size={14} />
          </button>
        </li>
      ))}
    </ul>
  );

  return { form, list: listNode, count: list.data ? items.length : null, confirmDialog };
}

export function SnapshotsDialog({ serverId, guest, onClose }: Props) {
  const p = useSnapshotsPanel(serverId, guest);
  if (p.confirmDialog) return p.confirmDialog;
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={tx('Snapshots of {name}', { name: <span className="mono">{guest.name}</span> })}
      actions={
        <button type="button" className="btn-ghost" onClick={onClose}>
          {t('Close')}
        </button>
      }
    >
      {p.form}
      {p.list}
    </Modal>
  );
}
