// One alert row of the Alerts page: severity icon, title and time; the host
// (linking to the page section the alert concerns) and the evidence; the
// acknowledgement, maintenance or parent state; Investigate (the assistant)
// and the acknowledge control.

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Alert, Range } from '../../api/types';
import { needsAttention } from '../../api/types';
import { SeverityIcon } from '../../components/common';
import { useNow } from '../../lib/clock';
import { formatClock, formatFull } from '../../lib/format';
import { t } from '../../lib/i18n';
import { DEFAULT_RANGE } from '../../lib/urlState';
import { InvestigateButton } from '../assistant/AskDialog';
import { linkPath } from '../fleet/WatchPanel';
import { AlertActions } from './alertActions';

interface AlertRowProps {
  alert: Alert;
  /** Text of the time element (e.g. "14 min ago"). */
  whenText: string;
  /** ISO time shown by the time element; defaults to `opened_at`. */
  whenIso?: string;
  range?: Range;
  /** Replaces the severity icon. */
  icon?: ReactNode;
  /** Third line (resolved alerts: severity and duration). */
  extra?: ReactNode;
}

/** "Acknowledged by john until 18:00 · replacing friday", "Muted until 18:00", … (null: needs attention). */
export function alertStateText(a: Alert, now: number): string | null {
  if (a.state === 'resolved') return a.acknowledged ? t('Acknowledged by {name}', { name: a.acknowledged.by }) : null;
  if (a.suppressed_by) return t('{host} is offline: this host runs on it', { host: a.suppressed_by });
  if (a.acknowledged) {
    const k = a.acknowledged;
    const by = k.until ? t('Snoozed by {name} until {time}', { name: k.by, time: formatClock(Date.parse(k.until), now) }) : t('Acknowledged by {name}', { name: k.by });
    return `${by}${k.note ? ` · ${k.note}` : ''}`;
  }
  if (a.muted) return t('Muted: the host is in maintenance');
  return null;
}

/** Hub-level alerts belong to no host; a check alert links to its page ("/settings/checks"). */
export function hubAlertLink(a: Pick<Alert, 'link'>): { to: string; text: string } | null {
  if (!a.link?.startsWith('/')) return null;
  return { to: a.link, text: a.link.startsWith('/settings/checks') ? t('Checks') : 'Rackoon' };
}

/** Host link of an alert; hub-level alerts belong to no host. */
export function AlertSubject({ a, range }: { a: Alert; range: Range }) {
  if (!a.server) {
    const l = hubAlertLink(a);
    return l ? (
      <Link className="ink" to={l.to}>
        {l.text}
      </Link>
    ) : (
      <span className="mono ink">Rackoon</span>
    );
  }
  return (
    <Link className="mono ink" to={linkPath(a.server, a.link, range)}>
      {a.server}
    </Link>
  );
}

export function AlertRow({ alert: a, whenText, whenIso, range = DEFAULT_RANGE, icon, extra }: AlertRowProps) {
  const now = useNow();
  const iso = whenIso ?? a.opened_at;
  const state = alertStateText(a, now);
  const quiet = a.state !== 'resolved' && !needsAttention(a);
  return (
    <li className={quiet ? 'alert-row is-quiet' : 'alert-row'}>
      <div className="sev">{icon ?? <SeverityIcon severity={a.severity} size={16} />}</div>
      <div className="body">
        <div className="line1">
          <span className="title">{a.title}</span>
          <time className="lbl when" dateTime={iso} title={formatFull(Date.parse(iso))}>
            {whenText}
          </time>
        </div>
        <div className="line2">
          <AlertSubject a={a} range={range} /> · {a.detail}
        </div>
        {(state || extra) && (
          <div className="line3 lbl">
            {extra}
            {extra && state ? ' · ' : ''}
            {state}
          </div>
        )}
      </div>
      <div className="act">
        <InvestigateButton alert={a} />
        <AlertActions a={a} />
      </div>
    </li>
  );
}
