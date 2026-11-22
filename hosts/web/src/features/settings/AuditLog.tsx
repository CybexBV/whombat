// Settings › Audit log (REMOTE-CONSOLE 8, CONTRACT 3 + 7.3): newest first,
// cursor paginated ("Load more"), filtered by event (exact name or a category
// prefix like "console.") and server, exportable as CSV. Admin only.

import { useMemo } from 'react';
import { auditExportUrl } from '../../api/client';
import { useAuditLog, useServers } from '../../api/queries';
import type { AuditRecord } from '../../api/types';
import { Dot } from '../../components/controls';
import { SelectField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { currentTime } from '../../lib/clock';
import { DASH, formatAgoIso, formatDuration, formatFull } from '../../lib/format';
import { LOCALE, t, tn } from '../../lib/i18n';
import { useParamSetter } from '../../lib/urlState';
import { useTitle } from '../../lib/useTitle';
import { RequireAdmin } from './SettingsLayout';

interface EventGroup {
  label: string;
  /** Category filter (prefix ending in "."), when the hub supports it. */
  prefix?: string;
  /** The category filter's option text. */
  all?: string;
  events: string[];
}

export const AUDIT_EVENT_GROUPS: EventGroup[] = [
  { label: t('Console'), prefix: 'console.', all: t('All console events'), events: ['console.requested', 'console.denied', 'console.opened', 'console.closed', 'console.switched', 'console.screenshot'] },
  { label: t('Screens'), events: ['screens.viewed'] },
  { label: t('System views'), prefix: 'inspect.', all: t('All system views events'), events: ['inspect.viewed'] },
  { label: t('Power actions'), prefix: 'action.', all: t('All power actions events'), events: ['action.requested', 'action.finished'] },
  { label: t('Guest management'), prefix: 'manage.', all: t('All guest management events'), events: ['manage.requested', 'manage.finished', 'manage.viewed', 'manage.denied'] },
  { label: t('Remote control'), prefix: 'remote_control.', all: t('All remote control events'), events: ['remote_control.enabled', 'remote_control.disabled'] },
  { label: t('Alerts'), prefix: 'alert.', all: t('All alerts events'), events: ['alert.acknowledged', 'alert.unacknowledged'] },
  { label: t('Maintenance'), prefix: 'maintenance.', all: t('All maintenance events'), events: ['maintenance.created', 'maintenance.deleted'] },
  { label: t('Checks'), prefix: 'check.', all: t('All checks events'), events: ['check.created', 'check.updated', 'check.deleted'] },
  {
    label: t('Notifications'),
    prefix: 'notification.',
    all: t('All notifications events'),
    events: ['notification.channel_created', 'notification.channel_updated', 'notification.channel_deleted', 'notification.heartbeat_updated'],
  },
  { label: t('Sign-in and account'), prefix: 'auth.', all: t('All sign-in and account events'), events: ['auth.setup', 'auth.login', 'auth.logout', 'auth.reauth', 'auth.password_changed', 'auth.passkey_added', 'auth.passkey_removed'] },
  { label: t('Users'), prefix: 'user.', all: t('All users events'), events: ['user.created', 'user.role_changed', 'user.password_reset', 'user.signed_out', 'user.oidc_linked', 'user.deleted'] },
  { label: t('API tokens and kiosk links'), prefix: 'token.', all: t('All api tokens and kiosk links events'), events: ['token.created', 'token.deleted'] },
  { label: t('Enrollment'), prefix: 'enrollment.', all: t('All enrollment events'), events: ['enrollment.created', 'enrollment.requested', 'enrollment.approved', 'enrollment.rejected'] },
  { label: t('Servers'), prefix: 'server.', all: t('All servers events'), events: ['server.updated', 'server.deleted', 'server.watch_changed'] },
  {
    label: t('Agents'),
    prefix: 'agent.',
    all: t('All agents events'),
    events: [
      'agent.policy_changed',
      'agent.update_started',
      'agent.updated',
      'agent.update_halted',
      'agent.helper_updated',
      'agent.helper_update_halted',
      'agent.settings_changed',
      'agent.certificate_renewed',
      'agent.certificate_adopted',
      'agent.machine_id_mismatch',
    ],
  },
  {
    label: t('Assistant'),
    prefix: 'assistant.',
    all: t('All assistant events'),
    events: [
      'assistant.settings_updated',
      'assistant.installed',
      'assistant.uninstalled',
      'assistant.sign_in_started',
      'assistant.signed_in',
      'assistant.signed_out',
      'assistant.started',
      'assistant.stopped',
      'assistant.approved',
      'assistant.declined',
      'assistant.command',
      'assistant.action',
      'assistant.deleted',
    ],
  },
  { label: t('Diagnostics'), events: ['diagnose.ran', 'disk_usage.ran', 'exec.requested', 'exec.finished'] },
  {
    label: t('Hub'),
    prefix: 'hub.',
    all: t('All hub events'),
    events: ['hub.backup_downloaded', 'hub.address_changed', 'hub.restore_staged', 'hub.restored', 'hub.restore_failed', 'hub.reconnecting', 'hub.agents_moved'],
  },
  { label: t('Audit log'), events: ['audit.exported'] },
];

const KNOWN = new Set(AUDIT_EVENT_GROUPS.flatMap((g) => g.events));

const timeFmt = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** "Oct 11, 13:59:12" in the viewer's time zone. */
export function formatAuditTime(iso: string): string {
  return timeFmt.format(new Date(iso)).replace(' at ', ', ');
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}

const OUTCOME_DOT: Record<string, string> = { ok: 'var(--good)', denied: 'var(--warning)', error: 'var(--critical)' };
const OUTCOME_LABEL: Record<string, string> = { ok: t('ok'), denied: t('denied'), error: t('error') };
const ROLE_WORD: Record<string, string> = { admin: t('admin'), operator: t('operator'), viewer: t('viewer') };

function detailsText(r: AuditRecord): string {
  const parts: string[] = [];
  if (r.duration_s != null) parts.push(formatDuration(r.duration_s));
  if (r.bytes_in != null || r.bytes_out != null) parts.push(t('{in} in · {out} out', { in: formatBytes(r.bytes_in), out: formatBytes(r.bytes_out) }));
  for (const [k, v] of Object.entries(r.details ?? {})) {
    // Correlation ids (session_id, action_id, …) stay in the CSV export.
    if (v !== '' && !/(^|_)id$/.test(k)) parts.push(`${k.replace(/_/g, ' ')}: ${v}`);
  }
  return parts.join(' · ');
}

function AuditRow({ r, now }: { r: AuditRecord; now: number }) {
  const target = [r.server, r.guest].filter(Boolean).join(' / ');
  const det = detailsText(r);
  return (
    <tr>
      <td className="nowrap">
        <time dateTime={r.at} title={`${formatAgoIso(r.at, now)} · ${formatFull(Date.parse(r.at))}`}>
          {formatAuditTime(r.at)}
        </time>
      </td>
      <td title={[r.role && (ROLE_WORD[r.role] ?? r.role), r.client_ip].filter(Boolean).join(' · ') || undefined}>{r.user ?? <span className="ink-3">{DASH}</span>}</td>
      <td className="mono nowrap">{r.event}</td>
      <td className="mono nowrap">{target || <span className="ink-3">{DASH}</span>}</td>
      <td>{r.protocol ?? <span className="ink-3">{DASH}</span>}</td>
      <td className="nowrap">
        <span className="state">
          <Dot color={OUTCOME_DOT[r.outcome] ?? 'var(--muted)'} />
          {OUTCOME_LABEL[r.outcome] ?? r.outcome}
        </span>
        {r.code && <div className="lbl mono audit-code">{r.code}</div>}
      </td>
      <td className="ink-2 audit-details">{det || <span className="ink-3">{DASH}</span>}</td>
    </tr>
  );
}

export function AuditPage() {
  useTitle(t('Audit log'));
  return (
    <RequireAdmin title={t('Audit log')} text={t('Only administrators can read and export the audit log.')}>
      <AuditLog />
    </RequireAdmin>
  );
}

function AuditLog() {
  const [params, setParam] = useParamSetter();
  const event = params.get('event') ?? '';
  const server = params.get('server') ?? '';
  const log = useAuditLog(event, server);
  const servers = useServers();
  // Relative times only feed the titles: no 1 s re-render of the whole table.
  const now = currentTime();
  const items = useMemo(() => log.data?.pages.flatMap((p) => p.items) ?? [], [log.data]);

  const extraEvents = useMemo(() => [...new Set(items.map((r) => r.event))].filter((e) => !KNOWN.has(e)).sort(), [items]);
  const serverOptions = useMemo(() => {
    const ids = new Set((servers.data ?? []).map((s) => s.id));
    for (const r of items) if (r.server) ids.add(r.server);
    if (server) ids.add(server);
    return [...ids].sort();
  }, [servers.data, items, server]);
  const eventKnown = !event || KNOWN.has(event) || extraEvents.includes(event) || AUDIT_EVENT_GROUPS.some((g) => g.prefix === event);

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title" id="audit-title">
            {t('Audit log')}
          </h1>
          <p className="page-sub">{t('Sign-ins, enrollment, settings, consoles and power actions. Times in your time zone.')}</p>
        </div>
        <div className="page-controls">
          <a className="btn-ghost" href={auditExportUrl({ event: event || null, server: server || null })} download>
            <Icon name="download" size={16} />
            {t('Export CSV')}
          </a>
        </div>
      </header>
      <section className="card list-card" aria-label={t('Audit records')}>
        <div className="audit-filters">
          <SelectField label={t('Event')} value={event} onChange={(e) => setParam('event', e.target.value || null)}>
            <option value="">{t('All events')}</option>
            {AUDIT_EVENT_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.prefix && <option value={g.prefix}>{g.all}</option>}
                {g.events.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </optgroup>
            ))}
            {(extraEvents.length > 0 || !eventKnown) && (
              <optgroup label={t('Other')}>
                {!eventKnown && <option value={event}>{event}</option>}
                {extraEvents.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </optgroup>
            )}
          </SelectField>
          <SelectField label={t('Server')} value={server} onChange={(e) => setParam('server', e.target.value || null)}>
            <option value="">{t('All servers')}</option>
            {serverOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </SelectField>
        </div>

        {log.isError && !log.data ? (
          <InlineRetry title={t('Could not load the audit log')} error={log.error} onRetry={() => void log.refetch()} />
        ) : !log.data ? (
          <div className="enroll-status" aria-busy="true">
            <span className="spinner" aria-hidden="true" />
            <span>{t('Loading the audit log…')}</span>
          </div>
        ) : items.length === 0 ? (
          <div className="alert-empty">{event || server ? t('No audit records match these filters.') : t('No audit records yet.')}</div>
        ) : (
          <>
            <div className="table-scroll audit-scroll" tabIndex={0} role="region" aria-label={t('Audit records (scrolls sideways)')}>
              <table className="data-table audit-table" aria-labelledby="audit-title">
                <thead>
                  <tr>
                    <th scope="col">{t('Time')}</th>
                    <th scope="col">{t('User')}</th>
                    <th scope="col">{t('Event')}</th>
                    <th scope="col">{t('Server / guest')}</th>
                    <th scope="col">{t('Protocol')}</th>
                    <th scope="col">{t('Outcome')}</th>
                    <th scope="col">{t('Details')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <AuditRow key={r.id} r={r} now={now} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="audit-more">
              <span className="lbl" role="status">
                {tn(items.length, '{n} record shown', '{n} records shown')}
                {log.hasNextPage ? '' : ` · ${t('end of the log')}`}
              </span>
              {log.hasNextPage && (
                <button type="button" className="btn-ghost" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
                  {log.isFetchingNextPage && <span className="spinner" aria-hidden="true" />}
                  {log.isFetchingNextPage ? t('Loading…') : t('Load more')}
                </button>
              )}
            </div>
            {log.isFetchNextPageError && <InlineRetry title={t('Could not load more records')} error={log.error} onRetry={() => void log.fetchNextPage()} />}
          </>
        )}
      </section>
    </>
  );
}
