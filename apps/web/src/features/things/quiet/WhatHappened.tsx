/**
 * What happened (Whombat; `things.history`, session minor 9): at the end of a
 * thing's or server's Summary, its outages and problems over the last 30 days (or 90), newest first — what it was, when
 * and how long, and what took it down — and what changed on it (a version, a restart, settings; outside-changes.md),
 * said once with who made it, under its uptime over the period; for a server its own alerts fold under them,
 * under “From the server”, without the outages the incidents already list. Drawn as Worth a look's rows: one still going
 * in its tone, the past ones grey. Nothing on an older Whombat.
 */
import { HISTORY_WORDS, type HistoryRow, historyView } from '@whombat/client';
import { useThingHistory } from '@whombat/client/react';
import { AlertTriangle, History, Power } from 'lucide-react';
import { useId, useState } from 'react';
import { LoadErrorNote } from '../../../app/runtime';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SkeletonRows } from '../../../components/ListState';
import { useBurrowContext, useNow } from '../../messaging/useRoom';
import dash from '../dashboard/Dashboard.module.css';
import { Card } from '../parts';
import things from '../Things.module.css';
import quiet from './Quiet.module.css';

/** How many rows show before “Show N more”. */
const SHOWN = 5;

export function WhatHappened({ burrow, thing }: { burrow: string; thing: string }) {
  const { timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const [days, setDays] = useState<30 | 90>(30);
  const [open, setOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const ids = useId();
  const q = useThingHistory(burrow, thing, days);
  if (!q.supported) return null;
  const view = q.data ? historyView(q.data, now, timeZone) : null;
  const shown = view ? (open ? view.rows : view.rows.slice(0, SHOWN)) : [];
  const more = view ? view.rows.length - SHOWN : 0;
  return (
    <Card
      id="what-happened"
      title={HISTORY_WORDS.title}
      meta={view?.uptime ?? undefined}
      link={
        <button
          type="button"
          className={things.cardLink}
          aria-pressed={days === 90}
          onClick={() => {
            setDays((d) => (d === 30 ? 90 : 30));
            setOpen(false);
          }}
        >
          {days === 30 ? 'Show 90 days' : 'Show 30 days'}
        </button>
      }
    >
      {q.error && !q.data ? (
        <div className={dash.quiet}>
          <LoadErrorNote error={q.error} message={HISTORY_WORDS.failed} onRetry={() => void q.refetch()} />
        </div>
      ) : !view ? (
        <SkeletonRows count={2} />
      ) : (
        <div aria-busy={q.isFetching || undefined}>
          {view.empty ? <p className={dash.quiet}>{view.empty}</p> : null}
          {shown.map((r) => (
            <Row key={r.id} row={r} />
          ))}
          {more > 0 ? (
            <button
              type="button"
              className={dash.more}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? HISTORY_WORDS.fewer : `Show ${more} more`}
            </button>
          ) : null}
          {/* A server's own alerts fold under its incidents, under their own small heading once open (so “Show N more”
              above stays with the incidents); open, they come before the row that folds them again. */}
          {alertsOpen && view.alerts.length ? (
            <section aria-labelledby={`${ids}-from-server`}>
              <h3 id={`${ids}-from-server`} className={quiet.historyGroup}>
                {HISTORY_WORDS.fromServer}
              </h3>
              {view.alerts.map((r) => (
                <Row key={r.id} row={r} alert />
              ))}
            </section>
          ) : null}
          {view.alerts.length ? (
            <button
              type="button"
              className={dash.more}
              aria-expanded={alertsOpen}
              onClick={() => setAlertsOpen((o) => !o)}
            >
              {alertsOpen ? HISTORY_WORDS.hideAlerts : HISTORY_WORDS.alerts(view.alerts.length)}
            </button>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/**
 * One row: still going in its tone, a past one grey; what it was, then when, how long and its cause. A change is always
 * grey, with its own mark, and says who made it.
 */
function Row({ row, alert = false }: { row: HistoryRow; alert?: boolean }) {
  const tone =
    !row.open || row.tone === 'change' ? quiet.quietIcon : row.tone === 'bad' ? dash.wiBad : dash.wiWarn;
  const icon = row.tone === 'change' ? History : row.tone === 'bad' && !alert ? Power : AlertTriangle;
  return (
    <div
      className={dash.watch}
      data-history={row.id}
      data-open={row.open || undefined}
      data-change={row.tone === 'change' || undefined}
    >
      <span className={cx(dash.wi, tone)} aria-hidden="true">
        <Icon icon={icon} size={15} />
      </span>
      <div className={dash.watchText}>
        <b>
          {row.open ? <span className={things.srOnly}>Still going: </span> : null}
          {row.words}
        </b>
        <small>{[row.when, row.cause].filter(Boolean).join(' · ')}</small>
      </div>
    </div>
  );
}
