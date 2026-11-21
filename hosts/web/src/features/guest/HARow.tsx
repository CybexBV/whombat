// High availability of a Proxmox guest in a cluster (the Options tab's HA
// row, docs/MANAGE.md): its state, restart / relocate limits and comment;
// admins add, edit and remove it (ha-manager as root on the node).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isProxmoxDetail } from '../../api/client';
import { type HASettings, manageApi, manageKeys, useGuestConfig } from '../../api/manage';
import { InlineError, SelectField, TextField } from '../../components/forms';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { t, tn } from '../../lib/i18n';
import { manageErrorText } from '../manage/manageErrors';
import type { GuestTabProps } from './GuestPage';

const STATES: { value: HASettings['state']; label: string; hint: string }[] = [
  { value: 'started', label: t('Started'), hint: t('HA keeps it running and restarts or moves it when its node fails.') },
  { value: 'stopped', label: t('Stopped'), hint: t('HA keeps it stopped (it can still move to another node).') },
  { value: 'disabled', label: t('Disabled'), hint: t('HA stops it and does not move it.') },
  { value: 'ignored', label: t('Ignored'), hint: t('HA leaves it alone, as if it were not an HA resource.') },
];
const stateLabel = (s: string) => STATES.find((x) => x.value === s)?.label ?? s;

export function HARow({ serverId, guest, detail, isAdmin, rc }: GuestTabProps) {
  const qc = useQueryClient();
  const cluster = isProxmoxDetail(detail) && !!detail.cluster;
  const enabled = cluster && guest.platform === 'pve' && !!rc?.manage;
  const config = useGuestConfig(serverId, guest.id, enabled);
  const [dialog, setDialog] = useState<'edit' | 'remove' | null>(null);
  const reload = () => void qc.invalidateQueries({ queryKey: manageKeys.config(serverId, guest.id) });
  const remove = useMutation({
    mutationFn: () => manageApi.removeHA(serverId, guest.id),
    onSuccess: () => {
      toast(t('{name} is no longer an HA resource.', { name: guest.name }), 'success');
      setDialog(null);
      reload();
    },
  });
  if (!enabled || !config.data) return null;
  const ha = config.data.ha;

  return (
    <section className="card" aria-labelledby="ha-title">
      <div className="card-head">
        <h2 className="h2" id="ha-title">
          {t('High availability')}
        </h2>
        {isAdmin && (
          <span className="lc-head-tools">
            <button type="button" className="btn-ghost" onClick={() => setDialog('edit')}>
              {ha ? t('Edit…') : t('Add to HA…')}
            </button>
            {ha && (
              <button type="button" className="btn-ghost is-serious" onClick={() => setDialog('remove')}>
                {t('Remove…')}
              </button>
            )}
          </span>
        )}
      </div>
      <div className="card-body">
        {ha ? (
          <dl className="lc-kv">
            <div>
              <dt className="lbl">{t('Requested state')}</dt>
              <dd>{stateLabel(ha.state)}</dd>
            </div>
            {ha.status && (
              <div>
                <dt className="lbl">{t('Current state')}</dt>
                <dd>{ha.status}</dd>
              </div>
            )}
            <div>
              <dt className="lbl">{t('On failure')}</dt>
              <dd>
                {tn(ha.max_restart ?? 1, '{n} restart', '{n} restarts')}, {tn(ha.max_relocate ?? 1, '{n} move to another node', '{n} moves to another node')}
              </dd>
            </div>
            {ha.comment && (
              <div>
                <dt className="lbl">{t('Comment')}</dt>
                <dd>{ha.comment}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="ink-2" style={{ margin: 0 }}>
            {t('Not an HA resource: when its node fails, {name} stays down until the node is back.', { name: guest.name })}
          </p>
        )}
      </div>
      {dialog === 'edit' && <HADialog serverId={serverId} guestId={guest.id} name={guest.name} current={ha ?? null} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'remove' && (
        <Modal
          open
          onClose={() => setDialog(null)}
          busy={remove.isPending}
          tone="serious"
          title={t('Remove {name} from HA?', { name: guest.name })}
          description={t('The guest keeps its current state; nothing restarts or moves it when its node fails.')}
          actions={
            <>
              <button type="button" className="btn-ghost" autoFocus onClick={() => setDialog(null)}>
                {t('Cancel')}
              </button>
              <button type="button" className="btn-primary btn-sm is-serious" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {t('Remove from HA')}
              </button>
            </>
          }
        >
          {remove.isError && <InlineError>{manageErrorText(remove.error)}</InlineError>}
        </Modal>
      )}
    </section>
  );
}

function HADialog({ serverId, guestId, name, current, onClose, onDone }: { serverId: string; guestId: string; name: string; current: HASettings | null; onClose: () => void; onDone: () => void }) {
  const [state, setState] = useState<HASettings['state']>(current?.state ?? 'started');
  const [restart, setRestart] = useState(String(current?.max_restart ?? 1));
  const [relocate, setRelocate] = useState(String(current?.max_relocate ?? 1));
  const [comment, setComment] = useState(current?.comment ?? '');
  const num = (v: string) => (/^\d+$/.test(v.trim()) && Number(v) <= 10 ? undefined : t('Use 0 to 10.'));
  const errors = { restart: num(restart), relocate: num(relocate) };
  const save = useMutation({
    mutationFn: () => manageApi.setHA(serverId, guestId, { state, max_restart: Number(restart), max_relocate: Number(relocate), ...(comment.trim() ? { comment: comment.trim() } : {}) }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      title={current ? t('HA for {name}', { name }) : t('Add {name} to HA', { name })}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="ha-form" className="btn-primary btn-sm" disabled={save.isPending || !!errors.restart || !!errors.relocate}>
            {t('Save')}
          </button>
        </>
      }
    >
      <form
        id="ha-form"
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!errors.restart && !errors.relocate) save.mutate();
        }}
      >
        <SelectField label={t('Requested state')} value={state} autoFocus hint={STATES.find((s) => s.value === state)?.hint} onChange={(e) => setState(e.target.value as HASettings['state'])}>
          {STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </SelectField>
        <div className="form-grid">
          <TextField label={t('Restarts on the same node')} inputMode="numeric" value={restart} error={errors.restart} onChange={(e) => setRestart(e.target.value)} />
          <TextField label={t('Moves to another node')} inputMode="numeric" value={relocate} error={errors.relocate} onChange={(e) => setRelocate(e.target.value)} />
        </div>
        <TextField label={t('Comment')} value={comment} maxLength={200} onChange={(e) => setComment(e.target.value)} />
        {save.isError && <InlineError>{manageErrorText(save.error)}</InlineError>}
      </form>
    </Modal>
  );
}
