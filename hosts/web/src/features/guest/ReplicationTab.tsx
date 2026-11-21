// Storage replication of a Proxmox guest in a cluster (docs/MANAGE.md,
// Replication tab): its jobs (target node, schedule, rate limit, last sync,
// error) with add and delete.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { manageApi, manageKeys, type ReplicationJob, useChoices, useGuestConfig } from '../../api/manage';
import { Skeleton } from '../../components/common';
import { Dot } from '../../components/controls';
import { InlineError, SelectField, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { useNow } from '../../lib/clock';
import { formatAgoIso, formatFull } from '../../lib/format';
import { t } from '../../lib/i18n';
import { fieldErrors, manageErrorText } from '../manage/manageErrors';
import type { GuestTabProps } from './GuestPage';

/** "*\/15" -> "every 15 min"; other calendar events read as themselves. */
export function scheduleText(s: string | undefined): string {
  const v = (s ?? '*/15').trim();
  const m = /^\*\/(\d+)$/.exec(v);
  if (m) return t('every {n} min', { n: m[1]! });
  if (/^\d{1,2}:\d{2}$/.test(v)) return t('daily at {time}', { time: v });
  return v;
}

export function ReplicationTab({ serverId, guest }: GuestTabProps) {
  const qc = useQueryClient();
  const config = useGuestConfig(serverId, guest.id);
  const now = useNow(60_000);
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'delete'; job: ReplicationJob } | null>(null);
  const reload = () => void qc.invalidateQueries({ queryKey: manageKeys.config(serverId, guest.id) });
  const del = useMutation({
    mutationFn: (job: ReplicationJob) => manageApi.deleteReplication(serverId, guest.id, job.id),
    onSuccess: (_r, job) => {
      toast(t('Replication job {id} deleted.', { id: job.id }), 'success');
      setDialog(null);
      reload();
    },
  });
  const jobs = config.data?.replication ?? [];

  return (
    <section className="card" aria-labelledby="repl-title">
      <div className="card-head">
        <h2 className="h2" id="repl-title">
          {t('Replication')}
        </h2>
        <span className="lc-head-tools">
          <span className="sub">{t('Copies the disks to another node on a schedule (ZFS)')}</span>
          <button type="button" className="btn-ghost" onClick={() => setDialog({ kind: 'add' })}>
            <Icon name="plus" size={15} />
            {t('Add job')}
          </button>
        </span>
      </div>
      {config.isError ? (
        <div className="card-body">
          <InlineRetry title={t('Could not load the replication jobs')} error={config.error} onRetry={() => void config.refetch()} />
        </div>
      ) : !config.data ? (
        <div className="card-body">
          <Skeleton height={64} />
        </div>
      ) : jobs.length === 0 ? (
        <div className="guests-empty">{t('No replication jobs for {name}.', { name: guest.name })}</div>
      ) : (
        <div className="gt-scroll">
          <table className="lc-table">
            <thead>
              <tr>
                <th scope="col">{t('Job')}</th>
                <th scope="col">{t('Target')}</th>
                <th scope="col">{t('Schedule')}</th>
                <th scope="col" className="hide-phone">
                  {t('Rate limit')}
                </th>
                <th scope="col">{t('Last sync')}</th>
                <th scope="col">
                  <span className="sr-only">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className={j.disabled ? 'is-stopped' : undefined}>
                  <td className="mono">{j.id}</td>
                  <td className="mono">{j.target}</td>
                  <td className="ink-2">{scheduleText(j.schedule)}</td>
                  <td className="ink-2 hide-phone">{j.rate ? t('{n} MB/s', { n: j.rate }) : t('none')}</td>
                  <td>
                    {j.error ? (
                      <span className="state" title={j.error}>
                        <Dot color="var(--critical)" />
                        <span className="ellipsis">{j.error}</span>
                      </span>
                    ) : j.last_sync ? (
                      <span className="state" title={formatFull(Date.parse(j.last_sync))}>
                        <Dot color="var(--good)" />
                        {formatAgoIso(j.last_sync, now)}
                      </span>
                    ) : (
                      <span className="ink-3">{j.disabled ? t('Disabled') : t('Not yet')}</span>
                    )}
                    {j.comment && <span className="lbl"> · {j.comment}</span>}
                  </td>
                  <td className="last">
                    <button type="button" className="btn-ghost btn-icon row-action is-serious" aria-label={t('Delete job {id}', { id: j.id })} title={t('Delete')} onClick={() => setDialog({ kind: 'delete', job: j })}>
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === 'add' && <AddJobDialog serverId={serverId} guestId={guest.id} name={guest.name} taken={jobs.map((j) => j.target)} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog?.kind === 'delete' && (
        <Modal
          open
          onClose={() => setDialog(null)}
          busy={del.isPending}
          tone="serious"
          title={t('Delete replication job {id}?', { id: dialog.job.id })}
          description={t('The copy on {node} is removed with the job.', { node: dialog.job.target })}
          actions={
            <>
              <button type="button" className="btn-ghost" autoFocus onClick={() => setDialog(null)}>
                {t('Cancel')}
              </button>
              <button type="button" className="btn-primary btn-sm is-serious" disabled={del.isPending} onClick={() => del.mutate(dialog.job)}>
                {t('Delete job')}
              </button>
            </>
          }
        >
          {del.isError && <InlineError>{manageErrorText(del.error)}</InlineError>}
        </Modal>
      )}
    </section>
  );
}

function AddJobDialog({ serverId, guestId, name, taken, onClose, onDone }: { serverId: string; guestId: string; name: string; taken: string[]; onClose: () => void; onDone: () => void }) {
  const choices = useChoices(serverId, 'pve');
  const nodes = (choices.data?.nodes ?? []).filter((n) => !taken.includes(n));
  const [target, setTarget] = useState('');
  const [schedule, setSchedule] = useState('*/15');
  const [rate, setRate] = useState('');
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const chosen = target || nodes[0] || '';
  const save = useMutation({
    mutationFn: () => manageApi.addReplication(serverId, guestId, { target: chosen, schedule: schedule.trim() || undefined, rate: rate.trim() || undefined, comment: comment.trim() || undefined }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setErrors(fieldErrors(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const rateErr = rate.trim() && !/^\d+(\.\d+)?$/.test(rate.trim()) ? t('MB/s as a number, or empty for no limit.') : undefined;
    setErrors(rateErr ? { rate: rateErr } : {});
    if (!rateErr && chosen) save.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      title={t('Replicate {name}', { name })}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="repl-form" className="btn-primary btn-sm" disabled={!chosen || save.isPending}>
            {t('Add job')}
          </button>
        </>
      }
    >
      <form id="repl-form" className="form-stack" onSubmit={submit} noValidate>
        <SelectField label={t('Target node')} value={chosen} autoFocus disabled={!nodes.length} error={errors.target} onChange={(e) => setTarget(e.target.value)}>
          {!nodes.length && <option value="">{choices.isPending ? t('Loading…') : t('No other node without a job')}</option>}
          {nodes.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </SelectField>
        <div className="form-grid">
          <TextField label={t('Schedule')} mono value={schedule} hint={t('*/15 = every 15 minutes, 02:00 = daily at 02:00')} error={errors.schedule} onChange={(e) => setSchedule(e.target.value)} />
          <TextField label={t('Rate limit (MB/s)')} inputMode="decimal" value={rate} placeholder={t('none')} error={errors.rate} onChange={(e) => setRate(e.target.value)} />
        </div>
        <TextField label={t('Comment')} value={comment} maxLength={200} onChange={(e) => setComment(e.target.value)} />
        {save.isError && <InlineError>{manageErrorText(save.error, ['target', 'schedule', 'rate'])}</InlineError>}
      </form>
    </Modal>
  );
}
