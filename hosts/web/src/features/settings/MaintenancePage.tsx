// Settings › Maintenance: windows in which hosts' alerts are muted (still
// shown, but no notifications and no badge). One-off windows come from a
// host's "Mute alerts" menu or this page; weekly ones (patch nights) only
// from here. Operators and admins.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { qk, useAuthState, useGroups, useMaintenance, useServers } from '../../api/queries';
import type { Maintenance, MaintenanceCreate } from '../../api/types';
import { Skeleton } from '../../components/common';
import { Chip, SegmentedControl } from '../../components/controls';
import { errorText, InlineError, SelectField, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { toast } from '../../components/Toast';
import { useNow } from '../../lib/clock';
import { formatClock, formatDayTime, plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useTitle } from '../../lib/useTitle';

const DAYS = [t('Sun'), t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat')];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function scopeText(m: Pick<Maintenance, 'scope' | 'target'>): string {
  if (m.scope === 'all') return t('All hosts');
  if (m.scope === 'group') return t('Group {name}', { name: m.target });
  return m.target;
}

function scheduleText(m: Maintenance): string {
  if (m.weekdays.length) {
    const days = m.weekdays.length === 7 ? t('Every day') : DAY_ORDER.filter((d) => m.weekdays.includes(d)).map((d) => DAYS[d]).join(', ');
    const h = m.duration_min / 60;
    return t('{days} at {time} for {duration} ({tz})', { days, time: m.start_time, duration: h >= 1 && Number.isInteger(h) ? plural(h, 'hour') : plural(m.duration_min, 'minute'), tz: m.tz });
  }
  return t('{start} to {end}', { start: formatDayTime(Date.parse(m.starts_at)), end: m.ends_at ? formatClock(Date.parse(m.ends_at), Date.parse(m.starts_at)) : '?' });
}

function WindowRow({ m, canEdit }: { m: Maintenance; canEdit: boolean }) {
  const now = useNow();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deleteMaintenance(m.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.maintenance });
      void qc.invalidateQueries({ queryKey: ['fleet'] });
      void qc.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (err) => toast(t('Could not delete the window: {error}', { error: errorText(err) }), 'error'),
  });
  return (
    <li className="mw-row">
      <div className="mw-main">
        <div className="mw-line1">
          <span className="strong">{scopeText(m)}</span>
          {m.active ? <Chip dot="var(--warning)">{t('Active until {time}', { time: formatClock(Date.parse(m.active_until!), now) })}</Chip> : null}
        </div>
        <div className="lbl">
          {scheduleText(m)}
          {m.note ? ` · ${m.note}` : ''} · {t('by {name}', { name: m.created_by })}
        </div>
      </div>
      {canEdit && (
        <button type="button" className="btn-ghost btn-icon" aria-label={t('Delete the window for {scope}', { scope: scopeText(m) })} title={t('Delete')} onClick={() => del.mutate()} disabled={del.isPending}>
          <Icon name="trash" size={15} />
        </button>
      )}
    </li>
  );
}

function AddWindow({ onDone }: { onDone: () => void }) {
  const servers = useServers();
  const groups = useGroups();
  const qc = useQueryClient();
  const [scope, setScope] = useState<'server' | 'group' | 'all'>('server');
  const [target, setTarget] = useState('');
  const [repeat, setRepeat] = useState<'once' | 'weekly'>('weekly');
  const [days, setDays] = useState<number[]>([2]);
  const [time, setTime] = useState('23:00');
  const [start, setStart] = useState('');
  const [hours, setHours] = useState('2');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const create = useMutation({
    mutationFn: (m: MaintenanceCreate) => api.createMaintenance(m),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.maintenance });
      void qc.invalidateQueries({ queryKey: ['fleet'] });
      toast(t('Maintenance window added.'), 'success');
      onDone();
    },
    onError: (err) => setError(errorText(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const minutes = Math.round(Number(hours) * 60);
    if (!(minutes > 0)) return setError(t('Give a duration.'));
    if (scope !== 'all' && !target) return setError(scope === 'server' ? t('Pick a host.') : t('Pick a group.'));
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    if (repeat === 'weekly') {
      if (!days.length) return setError(t('Pick at least one day.'));
      create.mutate({ scope, target, weekdays: days, start_time: time, duration_min: minutes, tz, note });
    } else {
      const s = start ? new Date(start) : new Date();
      if (Number.isNaN(s.getTime())) return setError(t('Give a start time.'));
      create.mutate({ scope, target, starts_at: s.toISOString(), duration_min: minutes, tz, note });
    }
  };
  return (
    <form className="card settings-card form-stack" onSubmit={submit} aria-labelledby="mw-add-title">
      <h2 className="h2" id="mw-add-title">
        {t('New window')}
      </h2>
      <SegmentedControl
        label={t('Applies to')}
        options={[
          { value: 'server', label: t('A host') },
          { value: 'group', label: t('A group') },
          { value: 'all', label: t('All hosts') },
        ]}
        value={scope}
        onChange={(v) => {
          setScope(v);
          setTarget('');
        }}
      />
      {scope === 'server' && (
        <SelectField label={t('Host')} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">{t('Choose…')}</option>
          {(servers.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
            </option>
          ))}
        </SelectField>
      )}
      {scope === 'group' && (
        <SelectField label={t('Group')} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">{t('Choose…')}</option>
          {(groups.data ?? []).map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </SelectField>
      )}
      <SegmentedControl
        label={t('Repeat')}
        options={[
          { value: 'weekly', label: t('Weekly') },
          { value: 'once', label: t('Once') },
        ]}
        value={repeat}
        onChange={setRepeat}
      />
      {repeat === 'weekly' ? (
        <>
          <div className="mw-days" role="group" aria-label={t('Days')}>
            {DAY_ORDER.map((d) => (
              <button key={d} type="button" className="gp-chip" aria-pressed={days.includes(d)} onClick={() => setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]))}>
                {DAYS[d]}
              </button>
            ))}
          </div>
          <TextField label={t('Starts at')} type="time" value={time} onChange={(e) => setTime(e.target.value)} hint={t("In this browser's time zone")} />
        </>
      ) : (
        <TextField label={t('Starts')} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} hint={t('Empty: now')} />
      )}
      <TextField label={t('Duration (hours)')} type="number" min="0.25" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} />
      <TextField label={t('Note')} placeholder={t('Patch night')} maxLength={256} value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <InlineError>{error}</InlineError>}
      <div className="form-actions">
        <button type="button" className="btn-ghost" onClick={onDone}>
          {t('Cancel')}
        </button>
        <button type="submit" className="btn-primary" disabled={create.isPending}>
          {t('Add window')}
        </button>
      </div>
    </form>
  );
}

export function MaintenancePage() {
  useTitle(t('Maintenance'));
  const role = useAuthState().data?.user?.role;
  const canEdit = role === 'admin' || role === 'operator';
  const list = useMaintenance();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('Maintenance')}</h1>
          <p className="page-sub">{t('Muted hosts keep their alerts on screen but send no notifications.')}</p>
        </div>
        {canEdit && !adding && (
          <div className="page-controls">
            <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
              <Icon name="plus" size={15} />
              {t('New window')}
            </button>
          </div>
        )}
      </header>
      {adding && <AddWindow onDone={() => setAdding(false)} />}
      <section className="card list-card" aria-label={t('Maintenance windows')}>
        {list.isError && !list.data ? (
          <InlineRetry title={t('Could not load the windows')} error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data ? (
          <Skeleton height={80} />
        ) : list.data.length === 0 ? (
          <div className="alert-empty">{t('No windows. Mute a host from its page (the ⋯ menu), or add a weekly window for patch nights.')}</div>
        ) : (
          <ul className="plain-list">
            {list.data.map((m) => (
              <WindowRow key={m.id} m={m} canEdit={canEdit} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
