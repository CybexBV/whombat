// Watch panel (UI v2): open alerts first, then hints (conditions near a
// limit that are not alerts yet, CONTRACT 1). Each row links to its host;
// a hint's link opens the host's tab for that section.

import { Link } from 'react-router';
import type { Alert, Hint, Range } from '../../api/types';
import { needsAttention } from '../../api/types';
import { SeverityIcon } from '../../components/common';
import { Dot } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { useNow } from '../../lib/clock';
import { formatFull } from '../../lib/format';
import { t, tn } from '../../lib/i18n';
import { type HostTab, hostPath } from '../../lib/urlState';
import { alertStateText, hubAlertLink } from '../alerts/AlertRow';
import { InvestigateButton } from '../assistant/AskDialog';
import { alertWhen } from '../alerts/alertTime';

/** Section link of a hint or alert ("#temps") -> host tab. */
export function tabForLink(link: string | null | undefined): HostTab {
  switch (link) {
    case '#temps':
      return 'sensors';
    case '#storage':
      return 'storage';
    case '#virtualization':
    case '#cluster':
      return 'virtualization';
    case '#guests':
      return 'guests';
    case '#agent':
      return 'agent';
    default:
      return 'summary';
  }
}

/** Host page of a hint or alert link: its tab, and for "#system" the System card of the summary. */
export function linkPath(server: string, link: string | null | undefined, range: Range): string {
  return hostPath(server, { tab: tabForLink(link), range, section: link === '#system' ? 'system' : null });
}

/** Routine hints (maintenance, not limits): on the overview, one row per kind when several hosts have them. */
const ROUTINE: Record<string, (n: number) => string> = {
  'system.updates': (n) => t('Updates on {n} hosts', { n }),
  'system.reboot': (n) => t('Reboot required on {n} hosts', { n }),
  'docker.image_updates': (n) => t('Container image updates on {n} hosts', { n }),
  'agent.outdated': (n) => t('{n} agents differ from the hub', { n }),
  'disk.counters': (n) => t('SMART counters on {n} hosts', { n }),
  'pool.scrub': (n) => t('Scrubs due on {n} hosts', { n }),
};

export interface HintGroup {
  kind: string;
  title: string;
  /** Extra text before the host list ("2 with security updates"). */
  note: string | null;
  hints: Hint[];
}

/** Splits hints into single rows and routine groups (kinds with 2+ hosts), keeping the server's order. */
export function groupHints(hints: Hint[]): { rows: Hint[]; groups: HintGroup[] } {
  const byKind = new Map<string, Hint[]>();
  for (const h of hints) if (ROUTINE[h.kind]) byKind.set(h.kind, [...(byKind.get(h.kind) ?? []), h]);
  const grouped = new Set([...byKind].filter(([, l]) => l.length > 1).map(([k]) => k));
  const groups: HintGroup[] = [...grouped].map((kind) => {
    const list = byKind.get(kind) ?? [];
    const sec = kind === 'system.updates' ? list.filter((h) => /security/.test(h.detail)).length : 0;
    return { kind, title: ROUTINE[kind]!(list.length), note: sec ? t('{n} with security updates', { n: sec }) : null, hints: list };
  });
  return { rows: hints.filter((h) => !grouped.has(h.kind)), groups };
}

const HOSTS_SHOWN = 4;

function HintGroupRow({ g, range }: { g: HintGroup; range: Range }) {
  const shown = g.hints.slice(0, HOSTS_SHOWN);
  return (
    <li className="watch-item">
      <span className="sev is-info">
        <Icon name="info" size={16} label={t('Information')} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="ti">{g.title}</div>
        <div className="de">
          {g.note && `${g.note} · `}
          {shown.map((h, i) => (
            <span key={h.server}>
              {i > 0 && ', '}
              <Link to={linkPath(h.server, h.link, range)} title={`${h.title} · ${h.detail}`}>
                {h.server}
              </Link>
            </span>
          ))}
          {g.hints.length > HOSTS_SHOWN && `, +${g.hints.length - HOSTS_SHOWN}`}
        </div>
      </div>
      <span className="when" />
    </li>
  );
}

export function HintRow({ h, range }: { h: Hint; range: Range }) {
  return (
    <li className="watch-item">
      <span className={`sev ${h.severity === 'warning' ? '' : 'is-info'}`}>
        {h.severity === 'warning' ? <SeverityIcon severity="warning" size={16} /> : <Icon name="info" size={16} label={t('Information')} />}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="ti">{h.title}</div>
        <div className="de">
          <Link to={linkPath(h.server, h.link, range)}>{h.server}</Link> · {h.detail}
        </div>
      </div>
      <span className="when">{h.severity === 'warning' ? t('now') : ''}</span>
    </li>
  );
}

function HubSubject({ a }: { a: Alert }) {
  const l = hubAlertLink(a);
  return l ? <Link to={l.to}>{l.text}</Link> : <span className="mono">Rackoon</span>;
}

export function AlertItem({ a, range }: { a: Alert; range: Range }) {
  const now = useNow();
  const t = Date.parse(a.opened_at);
  const state = alertStateText(a, now);
  return (
    <li className={needsAttention(a) ? 'watch-item' : 'watch-item is-quiet'}>
      <span className="sev">
        <SeverityIcon severity={a.severity} size={16} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="ti">{a.title}</div>
        <div className="de">
          {a.server ? <Link to={linkPath(a.server, a.link, range)}>{a.server}</Link> : <HubSubject a={a} />} · {a.detail}
        </div>
        {state && <div className="de st">{state}</div>}
        <InvestigateButton alert={a} className="btn-ghost row-action watch-inv" />
      </div>
      <time className="when" dateTime={a.opened_at} title={formatFull(t)}>
        {alertWhen(a, now)}
      </time>
    </li>
  );
}

export function WatchPanel({ alerts, hints, range }: { alerts: Alert[]; hints: Hint[]; range: Range }) {
  const { rows, groups } = groupHints(hints);
  return (
    <section className="card watch-card" aria-labelledby="watch-title">
      <div className="card-head">
        <h2 className="h2" id="watch-title">
          {t('Watch')}
        </h2>
        <span className="sub">{t('Open alerts, then conditions near a limit')}</span>
      </div>
      <ul className="plain-list" aria-label={t('Open alerts and hints')}>
        {alerts.length === 0 && (
          <li className="watch-item">
            <span className="sev is-good">
              <Dot color="var(--good)" />
            </span>
            <div>
              <div className="ti">{t('No open alerts')}</div>
              <div className="de">{t('Every host is within its thresholds.')}</div>
            </div>
            <span />
          </li>
        )}
        {alerts.map((a) => (
          <AlertItem key={a.id} a={a} range={range} />
        ))}
        {rows.map((h) => (
          <HintRow key={`${h.server}/${h.kind}/${h.entity}`} h={h} range={range} />
        ))}
        {groups.map((g) => (
          <HintGroupRow key={g.kind} g={g} range={range} />
        ))}
      </ul>
      <div className="watch-foot">
        {hints.length
          ? tn(hints.length, '{n} hint: conditions from 70% of a limit and routine maintenance.', '{n} hints: conditions from 70% of a limit and routine maintenance.')
          : t('Hints appear here from 70% of a limit.')}{' '}
        <Link to="/alerts">{t('All alerts')}</Link>
      </div>
    </section>
  );
}
