// Alerts: the open alerts (those asking for attention first, then the
// acknowledged, muted and suppressed ones) and the history, filtered by
// host, severity and text, paged newest first.

import { useMemo, useState } from 'react';
import { useAlertHistory, useAlerts, useServers } from '../../api/queries';
import type { Alert } from '../../api/types';
import { needsAttention } from '../../api/types';
import { Skeleton } from '../../components/common';
import { SegmentedControl } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { useDebounced } from '../../components/popover';
import { useNow } from '../../lib/clock';
import { formatAgoIso, formatDayTime, formatDuration, formatFull, plural } from '../../lib/format';
import { t, tn, tx } from '../../lib/i18n';
import { useTitle } from '../../lib/useTitle';
import { alertWhen } from './alertTime';
import { AlertRow } from './AlertRow';

const SEVERITY_LABEL = { critical: t('Critical'), warning: t('Warning') };

function OpenAlerts({ alerts }: { alerts: Alert[] }) {
  const now = useNow();
  if (alerts.length === 0) return <div className="alert-empty">{t('No open alerts. Every host is within its thresholds.')}</div>;
  return (
    <ul className="plain-list" aria-labelledby="open-alerts-title">
      {alerts.map((a) => (
        <AlertRow key={a.id} alert={a} whenText={alertWhen(a, now)} />
      ))}
    </ul>
  );
}

function ResolvedRow({ a }: { a: Alert }) {
  const now = useNow();
  const opened = Date.parse(a.opened_at);
  const resolved = a.resolved_at ? Date.parse(a.resolved_at) : NaN;
  const has = Number.isFinite(resolved);
  return (
    <AlertRow
      alert={a}
      whenIso={has ? a.resolved_at! : a.opened_at}
      whenText={has ? t('Resolved {time}', { time: formatAgoIso(a.resolved_at!, now) }) : t('Resolved')}
      icon={
        <span className="resolved-icon">
          <Icon name="check" size={16} label={t('Resolved')} />
        </span>
      }
      extra={
        <>
          {SEVERITY_LABEL[a.severity]}
          {has && <> · {t('open for {duration}', { duration: formatDuration((resolved - opened) / 1000) })}</>} ·{' '}
          {tx('opened {time}', {
            time: (
              <time dateTime={a.opened_at} title={formatFull(opened)}>
                {formatDayTime(opened)}
              </time>
            ),
          })}
        </>
      }
    />
  );
}

function History() {
  const servers = useServers();
  const [q, setQ] = useState('');
  const [server, setServer] = useState('');
  const [severity, setSeverity] = useState<'' | 'critical' | 'warning'>('');
  const text = useDebounced(q.trim(), 300);
  const hist = useAlertHistory({ server, severity, q: text });
  const items = useMemo(() => hist.data?.pages.flatMap((p) => p.items) ?? [], [hist.data]);
  return (
    <section className="card list-card" aria-labelledby="resolved-alerts-title">
      <div className="list-card-head">
        <h2 className="h2" id="resolved-alerts-title">
          {t('History')}
        </h2>
        <div className="alert-filters">
          <div className="input-search">
            <Icon name="search" size={15} />
            <input type="search" placeholder={t('Search alerts')} aria-label={t('Search alerts')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <label className="gp-select">
            <span className="lbl">{t('Host')}</span>
            <select aria-label={t('Host')} value={server} onChange={(e) => setServer(e.target.value)}>
              <option value="">{t('all')}</option>
              {(servers.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
              <option value="hub">{t('Rackoon (no host)')}</option>
            </select>
          </label>
          <SegmentedControl
            label={t('Severity')}
            options={[
              { value: '', label: t('All') },
              { value: 'critical', label: t('Critical') },
              { value: 'warning', label: t('Warning') },
            ]}
            value={severity}
            onChange={setSeverity}
          />
        </div>
      </div>
      {hist.isError && !hist.data ? (
        <InlineRetry title={t('Could not load the history')} error={hist.error} onRetry={() => void hist.refetch()} />
      ) : !hist.data ? (
        <Skeleton height={160} />
      ) : items.length === 0 ? (
        <div className="alert-empty">{server || severity || text ? t('No resolved alerts match.') : t('No alerts were resolved yet.')}</div>
      ) : (
        <>
          <ul className="plain-list" aria-labelledby="resolved-alerts-title">
            {items.map((a) => (
              <ResolvedRow key={a.id} a={a} />
            ))}
          </ul>
          {hist.hasNextPage && (
            <div className="list-more">
              <button type="button" className="btn-ghost" onClick={() => void hist.fetchNextPage()} disabled={hist.isFetchingNextPage}>
                {hist.isFetchingNextPage ? t('Loading…') : t('Load older alerts')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function AlertsPage() {
  useTitle(t('Alerts'));
  const open = useAlerts();
  const list = useMemo(() => {
    const l = [...(open.data ?? [])];
    // Asking for attention first; the API's severity / age order within.
    return l.sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
  }, [open.data]);
  const attention = list.filter(needsAttention).length;
  const quiet = list.length - attention;

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('Alerts')}</h1>
          <p className="page-sub">
            {open.data
              ? list.length
                ? [tn(attention, '{n} alert needs attention', '{n} alerts need attention'), quiet ? t('{n} acknowledged or muted', { n: quiet }) : null].filter(Boolean).join(' · ')
                : t('All clear: no open alerts')
              : ' '}
          </p>
        </div>
      </header>

      <section className="card list-card" aria-labelledby="open-alerts-title">
        <div className="list-card-head">
          <h2 className="h2" id="open-alerts-title">
            {t('Open')}
          </h2>
          {open.data && <span className="lbl">{plural(list.length, 'alert')}</span>}
        </div>
        {open.isError && !open.data ? (
          <InlineRetry title={t('Could not load the alerts')} error={open.error} onRetry={() => void open.refetch()} />
        ) : !open.data ? (
          <Skeleton height={160} />
        ) : (
          <OpenAlerts alerts={list} />
        )}
      </section>

      <History />
    </>
  );
}
