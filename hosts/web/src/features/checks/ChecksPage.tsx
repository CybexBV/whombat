// Settings › Checks: availability checks run by the hub or an agent (HTTP,
// TCP, ping, DNS) and heartbeats that a cron job pings. Everyone sees the
// list with its 24 h uptime and latency; admins add, edit, pause and delete.
// A failing check opens a hub-level alert that links here.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { qk, useAuthState, useChecks } from '../../api/queries';
import type { Check } from '../../api/types';
import { Skeleton } from '../../components/common';
import { Dot } from '../../components/controls';
import { errorText, Switch } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Menu } from '../../components/Menu';
import { Modal } from '../../components/Modal';
import { Sparkline } from '../../components/Sparkline';
import { toast } from '../../components/Toast';
import { useNow } from '../../lib/clock';
import { DASH, formatAgoIso, formatFull, plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useTitle } from '../../lib/useTitle';
import { CheckDialog } from './CheckDialog';
import { formatUptime, KIND_LABEL, sortChecks, STATUS, targetText } from './checkForm';

/** Last result in a few words: "200 · 84 ms", the error, "pinged 3 h ago". */
export function lastText(c: Check, now: number): string {
  if (c.status === 'disabled') return t('Paused');
  if (c.kind === 'heartbeat') {
    if (c.status === 'down') return c.last?.error || t('No ping');
    return c.last_ping ? t('Pinged {time}', { time: formatAgoIso(c.last_ping, now) }) : t('No ping yet');
  }
  const l = c.last;
  if (!l) return t('Waiting for the first result');
  if (!l.ok) return l.error || t('Failed');
  const parts = [l.status_code ? String(l.status_code) : null, l.latency_ms != null ? `${Math.round(l.latency_ms)} ms` : null].filter(Boolean);
  return parts.join(' · ') || 'OK';
}

export function StatusDot({ c }: { c: Check }) {
  const s = STATUS[c.status];
  return (
    <span title={s.label}>
      <Dot color={s.color} />
      <span className="sr-only">{s.label}</span>
    </span>
  );
}

function DeleteDialog({ c, onClose }: { c: Check; onClose: () => void }) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deleteCheck(c.id),
    onSuccess: () => {
      toast(t('Deleted {name}.', { name: c.name }), 'success');
      onClose();
    },
    onError: (err) => toast(errorText(err), 'error'),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.checks }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={del.isPending}
      tone="serious"
      title={t('Delete {name}?', { name: c.name })}
      description={c.kind === 'heartbeat' ? t('Its history goes too, and its ping URL stops working.') : t('Its history goes too; its open alert resolves.')}
      actions={
        <>
          <button type="button" className="btn-ghost" autoFocus onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn-primary btn-sm is-serious" disabled={del.isPending} onClick={() => del.mutate()}>
            {t('Delete check')}
          </button>
        </>
      }
    />
  );
}

function Row({ c, admin, onEdit, onDelete }: { c: Check; admin: boolean; onEdit: () => void; onDelete: () => void }) {
  const qc = useQueryClient();
  const now = useNow();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patchCheck(c.id, { enabled }),
    onError: (err) => toast(errorText(err), 'error'),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.checks }),
  });
  const down = c.status === 'down';
  return (
    <tr className={c.status === 'disabled' ? 'is-stopped' : undefined}>
      <td className="first">
        <StatusDot c={c} />
      </td>
      <td>
        <div className="n">
          {c.name}
          <small>
            {KIND_LABEL[c.kind]} · {targetText(c)}
          </small>
        </div>
      </td>
      <td className="host hide-phone">{c.kind === 'heartbeat' ? DASH : c.runner === 'hub' ? t('Hub') : c.runner}</td>
      <td className="num">{formatUptime(c.uptime_24h)}</td>
      <td>
        {c.latency_24h.some((v) => v != null) ? (
          <span className="sparkcell">
            <Sparkline values={c.latency_24h} color="var(--series-cpu)" height={20} />
          </span>
        ) : (
          <span className="ink-3">{DASH}</span>
        )}
      </td>
      <td className={down ? 'check-last is-down' : 'check-last ink-2'} title={c.last ? formatFull(Date.parse(c.last.at)) : undefined}>
        {lastText(c, now)}
      </td>
      {admin && (
        <td className="last">
          <span className="row-tools">
            <Switch checked={c.enabled} busy={toggle.isPending} onChange={(v) => toggle.mutate(v)} label={<span className="sr-only">{t('{name} enabled', { name: c.name })}</span>} />
            <Menu
              label={t('More for {name}', { name: c.name })}
              buttonClassName="btn-ghost btn-icon row-action"
              floating
              items={[
                { label: t('Edit…'), icon: 'edit', onSelect: onEdit },
                { label: t('Delete…'), icon: 'trash', danger: true, onSelect: onDelete },
              ]}
            />
          </span>
        </td>
      )}
    </tr>
  );
}

export function ChecksPage() {
  useTitle(t('Checks'));
  const auth = useAuthState();
  const admin = auth.data?.user?.role === 'admin';
  const checks = useChecks();
  const [editing, setEditing] = useState<Check | null | 'new'>(null);
  const [deleting, setDeleting] = useState<Check | null>(null);
  const list = sortChecks(checks.data ?? []);
  const down = list.filter((c) => c.status === 'down').length;
  const up = list.filter((c) => c.status === 'up').length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('Checks')}</h1>
          <p className="page-sub">
            {checks.data && list.length
              ? `${plural(list.length, 'check')} · ${t('{up} up', { up })}${down ? ` · ${t('{down} down', { down })}` : ''} · ${t('a check is down after two failures in a row')}`
              : t('Websites, ports, hosts and DNS names checked from the hub or an agent, and heartbeats from cron jobs.')}
          </p>
        </div>
        {admin && (
          <div className="page-controls">
            <button type="button" className="btn-ghost" onClick={() => setEditing('new')}>
              <Icon name="plus" size={15} />
              {t('New check')}
            </button>
          </div>
        )}
      </header>
      <section className="card guests-card" aria-label={t('Checks')}>
        {checks.isError && !checks.data ? (
          <div className="card-body">
            <InlineRetry title={t('Could not load the checks')} error={checks.error} onRetry={() => void checks.refetch()} />
          </div>
        ) : !checks.data ? (
          <div className="card-body form-stack-sm" aria-busy="true" aria-label={t('Loading checks')}>
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        ) : list.length === 0 ? (
          <div className="guests-empty">{admin ? t('No checks yet. Add one with “New check”.') : t('No checks yet.')}</div>
        ) : (
          <div className="gt-scroll">
            <table className="gt checks-table">
              <thead>
                <tr>
                  <th className="first" scope="col">
                    <span className="sr-only">{t('Status')}</span>
                  </th>
                  <th scope="col">{t('Check')}</th>
                  <th scope="col" className="hide-phone">
                    {t('Runs from')}
                  </th>
                  <th scope="col">{t('Uptime 24 h')}</th>
                  <th scope="col">{t('Latency 24 h')}</th>
                  <th scope="col">{t('Last result')}</th>
                  {admin && (
                    <th className="last" scope="col">
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <Row key={c.id} c={c} admin={admin} onEdit={() => setEditing(c)} onDelete={() => setDeleting(c)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing !== null && <CheckDialog check={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteDialog c={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}
