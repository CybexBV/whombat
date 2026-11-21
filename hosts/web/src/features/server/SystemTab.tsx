// Host page › System: live views of the host asked from its agent and never
// stored (GET /servers/{id}/inspect/*): processes (refreshed every 5 s while
// shown), services, listening ports and pending package updates; the
// journal; and, for admins with the host shell switched on, a root shell.
// The sub-view is the `view` search parameter.

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useInspect } from '../../api/queries';
import type { HostPort, HostProcess, HostService, InspectKind, PackageUpdate, RemoteControl } from '../../api/types';
import { Skeleton } from '../../components/common';
import { Chip, Dot, Meter, SegmentedControl } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { useNow } from '../../lib/clock';
import { DASH, formatAgoIso, formatFull, formatMemPair, formatPct1, formatTime, plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { agentPath } from '../../lib/urlState';
import { HostTerminal } from './HostTerminal';
import {
  byText,
  matchesFilter,
  mergePorts,
  nextSort,
  portScope,
  portText,
  processText,
  serviceRank,
  serviceState,
  serviceText,
  serviceTone,
  type SortDir,
  type SortState,
  sortRows,
  updatesSummary,
  updateText,
} from './systemViews';

export type SystemView = 'processes' | 'services' | 'ports' | 'logs' | 'updates' | 'terminal';
const VIEWS: SystemView[] = ['processes', 'services', 'ports', 'logs', 'updates', 'terminal'];
const LABEL: Record<SystemView, string> = { processes: t('Processes'), services: t('Services'), ports: t('Ports'), logs: t('Logs'), updates: t('Updates'), terminal: t('Terminal') };
const PROCESS_REFRESH_MS = 5_000;

export function parseSystemView(v: string | null): SystemView {
  return VIEWS.includes(v as SystemView) ? (v as SystemView) : 'processes';
}

/**
 * The tab is there for whoever may see the host's internals: the console
 * permission (operators and admins, both switches on). Over plain HTTP the
 * console is refused but the lists still work.
 */
export function systemAllowed(rc: RemoteControl | undefined): boolean {
  return !!rc && (rc.console || /HTTPS/.test(rc.console_reason ?? ''));
}

interface Props {
  serverId: string;
  rc: RemoteControl | undefined;
  isAdmin: boolean;
  view: SystemView;
  onView: (v: SystemView) => void;
}

export function SystemTab({ serverId, rc, isAdmin, view, onView }: Props) {
  const shell = !!rc?.host_shell;
  const views = VIEWS.filter((v) => v !== 'terminal' || shell || isAdmin);
  const current = views.includes(view) ? view : 'processes';
  const [filter, setFilter] = useState('');
  useEffect(() => setFilter(''), [current]);
  const table = current === 'processes' || current === 'services' || current === 'ports' || current === 'updates';

  let body: ReactNode;
  switch (current) {
    case 'processes':
      body = <Processes serverId={serverId} filter={filter} />;
      break;
    case 'services':
      body = <Services serverId={serverId} filter={filter} />;
      break;
    case 'ports':
      body = <Ports serverId={serverId} filter={filter} />;
      break;
    case 'updates':
      body = <Updates serverId={serverId} filter={filter} />;
      break;
    case 'logs':
      body = rc?.console ? <HostTerminal key="logs" serverId={serverId} protocol="logs" /> : <p className="lbl">{rc?.console_reason ?? t('Remote control is turned off for this server')}.</p>;
      break;
    case 'terminal':
      body = shell ? (
        <HostTerminal key="shell" serverId={serverId} protocol="shell" />
      ) : (
        <p className="lbl">
          {rc?.host_shell_reason ?? t('The host shell is turned off for this server')}.{' '}
          <Link to={agentPath(serverId)} className="link">
            {t('Server settings')}
          </Link>
        </p>
      );
      break;
  }

  return (
    <section className="section" aria-label={t('System')}>
      <div className="guests-tools">
        <SegmentedControl label={t('System view')} value={current} onChange={onView} options={views.map((v) => ({ value: v, label: LABEL[v] }))} />
        {table && (
          <div className="input-search">
            <Icon name="search" size={15} />
            <input type="search" aria-label={t('Filter {list}', { list: LABEL[current].toLowerCase() })} placeholder={t('Filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        )}
      </div>
      {body}
    </section>
  );
}

// ---------------------------------------------------------------- table

interface Col<T> {
  key: string;
  head: string;
  cell: (r: T) => ReactNode;
  /** Ascending comparison; the column sorts when set. */
  cmp?: (a: T, b: T) => number;
  natural?: SortDir;
  className?: string;
}

function SortTable<T>({ label, rows, cols, sort, onSort, rowKey }: { label: string; rows: T[]; cols: Col<T>[]; sort: SortState; onSort: (s: SortState) => void; rowKey: (r: T) => string }) {
  return (
    <div className="gt-scroll">
      <table className="gt sys-table" aria-label={label}>
        <thead>
          <tr>
            {cols.map((c) => {
              const on = sort.key === c.key;
              return (
                <th key={c.key} scope="col" className={c.className} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.cmp ? (
                    <button type="button" className="th-sort" onClick={() => onSort(nextSort(sort, c.key, c.natural ?? 'asc'))}>
                      {c.head}
                      {on && <Icon name={sort.dir === 'asc' ? 'chevronUp' : 'chevronDown'} size={12} />}
                    </button>
                  ) : (
                    c.head
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {cols.map((c) => (
                <td key={c.key} className={c.className}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Card with the view's title, counts, time of the data and a refresh button; the table or its states inside. */
function InspectCard<T>({
  serverId,
  kind,
  title,
  refreshMs,
  filter,
  text,
  summary,
  children,
}: {
  serverId: string;
  kind: InspectKind;
  title: string;
  refreshMs?: number;
  filter: string;
  text: (r: T) => string;
  summary?: (items: T[]) => string;
  children: (rows: T[]) => ReactNode;
}) {
  const q = useInspect<T>(serverId, kind, refreshMs);
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const rows = useMemo(() => items.filter((r) => matchesFilter(text(r), filter)), [items, filter, text]);
  const asOf = q.data ? Date.parse(q.data.as_of) : null;
  return (
    <div className="card guests-card">
      <div className="card-head">
        <h2 className="h2">{title}</h2>
        <span className="sub sys-sub">
          <span title={asOf != null ? formatFull(asOf) : undefined}>
            {q.data && (summary ? summary(items) : plural(items.length, 'row'))}
            {asOf != null && ` · ${refreshMs ? t('live, every {n} s', { n: refreshMs / 1000 }) : t('as of {time}', { time: formatTime(asOf) })}`}
          </span>
          <button type="button" className="btn-ghost btn-icon row-action" aria-label={t('Refresh {list}', { list: title.toLowerCase() })} title={t('Refresh')} disabled={q.isFetching} onClick={() => void q.refetch()}>
            <Icon name="refresh" size={14} />
          </button>
        </span>
      </div>
      {q.isError && !q.data ? (
        <div className="card-body">
          <InlineRetry title={t('Could not load the {list}', { list: title.toLowerCase() })} error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : !q.data ? (
        <div className="card-body form-stack-sm" aria-busy="true" aria-label={t('Loading {name}', { name: title.toLowerCase() })}>
          <Skeleton height={28} />
          <Skeleton height={28} />
          <Skeleton height={28} />
        </div>
      ) : rows.length === 0 ? (
        <div className="guests-empty">{filter.trim() ? t('Nothing matches “{query}”.', { query: filter.trim() }) : t('Nothing to show.')}</div>
      ) : (
        <>
          {children(rows)}
          {(q.data.truncated || filter.trim()) && (
            <div className="lbl guests-foot">
              {filter.trim() ? t('{shown} of {total} shown', { shown: rows.length, total: items.length }) : ''}
              {filter.trim() && q.data.truncated ? ' · ' : ''}
              {q.data.truncated ? t('The agent sent the first part of a longer list') : ''}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- views

const MIB = 1024 * 1024;

function Processes({ serverId, filter }: { serverId: string; filter: string }) {
  const [sort, setSort] = useState<SortState>({ key: 'cpu', dir: 'desc' });
  const cols: Col<HostProcess>[] = [
    {
      key: 'name',
      head: t('Process'),
      cmp: (a, b) => byText(a.name, b.name),
      cell: (p) => (
        <div className="n" title={p.command}>
          {p.name}
          <small>
            {p.container ? `${p.container} · ` : ''}
            {p.command || DASH}
          </small>
        </div>
      ),
    },
    { key: 'pid', head: 'PID', className: 'hide-phone', cmp: (a, b) => a.pid - b.pid, cell: (p) => <span className="num ink-2">{p.pid}</span> },
    { key: 'user', head: t('User'), className: 'hide-phone', cmp: (a, b) => byText(a.user, b.user), cell: (p) => <span className="ink-2">{p.user}</span> },
    {
      key: 'cpu',
      head: t('CPU'),
      natural: 'desc',
      cmp: (a, b) => a.cpu_pct - b.cpu_pct,
      cell: (p) => (
        <span className="cpu-cell">
          <Meter pct={Math.min(100, p.cpu_pct)} color="var(--series-cpu)" />
          <span className="val">{formatPct1(p.cpu_pct)}</span>
        </span>
      ),
    },
    { key: 'mem', head: t('Memory'), natural: 'desc', cmp: (a, b) => a.rss_bytes - b.rss_bytes, cell: (p) => <span className="mem">{formatMemPair(p.rss_bytes / MIB, null)}</span> },
  ];
  return (
    <InspectCard<HostProcess> serverId={serverId} kind="processes" title={t('Processes')} refreshMs={PROCESS_REFRESH_MS} filter={filter} text={processText} summary={(l) => plural(l.length, 'process', 'processes')}>
      {(rows) => <SortTable label={t('Processes')} rows={sorted(rows, cols, sort)} cols={cols} sort={sort} onSort={setSort} rowKey={(p) => String(p.pid)} />}
    </InspectCard>
  );
}

function Services({ serverId, filter }: { serverId: string; filter: string }) {
  const [sort, setSort] = useState<SortState>({ key: 'state', dir: 'asc' });
  const now = useNow();
  const cols: Col<HostService>[] = [
    {
      key: 'name',
      head: t('Service'),
      cmp: (a, b) => byText(a.name, b.name),
      cell: (s) => (
        <div className="n">
          {s.name}
          {s.description && <small>{s.description}</small>}
        </div>
      ),
    },
    {
      key: 'state',
      head: t('State'),
      cmp: (a, b) => serviceRank(a) - serviceRank(b) || byText(a.name, b.name),
      cell: (s) => (
        <span className="state">
          <Dot color={serviceTone(s)} />
          {serviceState(s)}
        </span>
      ),
    },
    { key: 'enabled', head: t('Enabled'), className: 'hide-phone', cmp: (a, b) => byText(a.enabled ?? '', b.enabled ?? ''), cell: (s) => <span className="ink-2">{s.enabled || DASH}</span> },
    {
      key: 'since',
      head: t('Since'),
      className: 'hide-phone',
      natural: 'desc',
      cmp: (a, b) => Date.parse(a.since ?? '0') - Date.parse(b.since ?? '0'),
      cell: (s) =>
        s.since ? (
          <time className="ink-2" dateTime={s.since} title={formatFull(Date.parse(s.since))}>
            {formatAgoIso(s.since, now)}
          </time>
        ) : (
          <span className="ink-3">{DASH}</span>
        ),
    },
  ];
  const summary = (l: HostService[]) => {
    const failed = l.filter((s) => s.active === 'failed').length;
    return `${plural(l.length, 'unit')}${failed ? ` · ${t('{n} failed', { n: failed })}` : ''}`;
  };
  return (
    <InspectCard<HostService> serverId={serverId} kind="services" title={t('Services')} filter={filter} text={serviceText} summary={summary}>
      {(rows) => <SortTable label={t('Services')} rows={sorted(rows, cols, sort)} cols={cols} sort={sort} onSort={setSort} rowKey={(s) => s.name} />}
    </InspectCard>
  );
}

function Ports({ serverId, filter }: { serverId: string; filter: string }) {
  const [sort, setSort] = useState<SortState>({ key: 'port', dir: 'asc' });
  const cols: Col<HostPort>[] = [
    { key: 'port', head: t('Port'), cmp: (a, b) => a.port - b.port || byText(a.proto, b.proto), cell: (p) => <span className="num mono">{p.port}</span> },
    { key: 'proto', head: t('Protocol'), className: 'hide-phone', cmp: (a, b) => byText(a.proto, b.proto), cell: (p) => <span className="ink-2">{p.proto}</span> },
    {
      key: 'address',
      head: t('Address'),
      cmp: (a, b) => byText(a.address, b.address),
      cell: (p) => <span className="mono ink-2">{portScope(p) === 'all' ? t('any') : p.address}</span>,
    },
    {
      key: 'process',
      head: t('Process'),
      cmp: (a, b) => byText(a.process ?? '', b.process ?? ''),
      cell: (p) => (
        <span className="mono">
          {p.process || DASH}
          {p.pid ? <span className="ink-3"> · {p.pid}</span> : null}
        </span>
      ),
    },
  ];
  return (
    <InspectCard<HostPort> serverId={serverId} kind="ports" title={t('Listening ports')} filter={filter} text={portText} summary={(l) => plural(mergePorts(l).length, 'socket')}>
      {(rows) => (
        <SortTable label={t('Listening ports')} rows={sorted(mergePorts(rows), cols, sort)} cols={cols} sort={sort} onSort={setSort} rowKey={(p) => `${p.proto}|${p.address}|${p.port}|${p.pid ?? ''}`} />
      )}
    </InspectCard>
  );
}

function Updates({ serverId, filter }: { serverId: string; filter: string }) {
  const [sort, setSort] = useState<SortState>({ key: 'security', dir: 'asc' });
  const cols: Col<PackageUpdate>[] = [
    {
      key: 'name',
      head: t('Package'),
      cmp: (a, b) => byText(a.name, b.name),
      cell: (u) => (
        <div className="n">
          {u.name}
          {u.source && <small>{u.source}</small>}
        </div>
      ),
    },
    {
      key: 'version',
      head: t('Version'),
      cell: (u) => (
        <span className="mono ink-2">
          {u.current ? `${u.current} → ` : ''}
          <span className="ink">{u.new}</span>
        </span>
      ),
    },
    {
      key: 'security',
      head: t('Type'),
      cmp: (a, b) => Number(!!b.security) - Number(!!a.security) || byText(a.name, b.name),
      cell: (u) => (u.security ? <Chip className="chip-sm" dot="var(--warning)">{t('Security')}</Chip> : <span className="ink-3">{t('Regular')}</span>),
    },
  ];
  return (
    <InspectCard<PackageUpdate> serverId={serverId} kind="updates" title={t('Pending updates')} filter={filter} text={updateText} summary={updatesSummary}>
      {(rows) => <SortTable label={t('Pending updates')} rows={sorted(rows, cols, sort)} cols={cols} sort={sort} onSort={setSort} rowKey={(u) => u.name} />}
    </InspectCard>
  );
}

function sorted<T>(rows: T[], cols: Col<T>[], sort: SortState): T[] {
  const c = cols.find((x) => x.key === sort.key)?.cmp;
  return c ? sortRows(rows, c, sort.dir) : rows;
}
