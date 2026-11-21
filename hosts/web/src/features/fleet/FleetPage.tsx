// Overview (UI v2, NOTES.md): one screen that answers "is anything wrong?".
// Header with the range control, a strip of fleet totals, the hosts table
// beside the Watch panel (alerts and hints), then Workloads and Capacity.
// Numbers come from GET /fleet (per group), sparklines from GET /fleet/series,
// guest counts from GET /guests (the full list).

import { useMemo } from 'react';
import { useAuthState, useFleet, useFleetSeries, useGuestList } from '../../api/queries';
import { ErrorCard, RangeControl, Skeleton } from '../../components/common';
import { Dot, SegmentedControl } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { Sparkline } from '../../components/Sparkline';
import { useNow } from '../../lib/clock';
import { formatAgo, formatFull, formatGb, formatPct } from '../../lib/format';
import { t, tn } from '../../lib/i18n';
import { useTitle } from '../../lib/useTitle';
import { useGroup, useRange } from '../../lib/urlState';
import { useOpenEnroll } from '../agents/enrollLink';
import { ChecksCard } from '../checks/ChecksCard';
import { Capacity } from './Capacity';
import { guestStats } from './guestStats';
import { HostsBoard, isEffectivelyOffline } from './HostsBoard';
import { WatchPanel } from './WatchPanel';
import { Workloads } from './Workloads';

const GUEST_PAGE = 500;

function Updated({ asOf }: { asOf: string }) {
  const now = useNow();
  const ts = Date.parse(asOf);
  return <span title={formatFull(ts)}>{t('updated {time}', { time: formatAgo((now - ts) / 1000) })}</span>;
}

export function FleetPage() {
  const [range, setRange] = useRange();
  const [group, setGroup] = useGroup();
  const openEnroll = useOpenEnroll();
  const auth = useAuthState();
  const isAdmin = auth.data?.user?.role === 'admin';
  useTitle(t('Overview'));
  const fleet = useFleet(group, range);
  const series = useFleetSeries(group, range);
  // Counts only (tallies per host and platform): every 30 s is plenty, the
  // hosts table itself is live through the event stream.
  const guests = useGuestList({ limit: GUEST_PAGE }, true, 30_000);
  const f = fleet.data;

  const groupIds = useMemo(() => new Set((f?.servers ?? []).map((s) => s.id)), [f]);
  const groupStats = useMemo(() => {
    if (!guests.data) return null;
    const inGroup = guests.data.guests.filter((g) => groupIds.has(g.server));
    return guestStats(inGroup, inGroup.length + (guests.data.total - guests.data.guests.length));
  }, [guests.data, groupIds]);
  const consoleHosts = useMemo(() => new Set((f?.servers ?? []).filter((s) => s.console_on).map((s) => s.id)), [f]);

  const groups = f?.groups ?? [];
  const total = f?.groups.find((g) => g.name === 'All')?.count ?? f?.servers.length ?? 0;
  const online = f ? f.servers.filter((s) => !isEffectivelyOffline(s, f.as_of)) : [];
  const offline = f ? f.servers.length - online.length : 0;
  const warnings = f ? f.servers.filter((s) => s.status === 'warning').length : 0;
  const hints = f?.hints ?? [];
  const k = f?.kpis;

  const summary = f
    ? [
        offline === 0 ? tn(f.servers.length, '{n} host, all online', '{n} hosts, all online') : tn(f.servers.length, '{n} host · {offline} offline', '{n} hosts · {offline} offline', { offline }),
        groupStats ? t('{n} of {total} guests running', { n: groupStats.all.running + groupStats.all.unhealthy, total: `${groupStats.all.total}${groupStats.truncated ? '+' : ''}` }) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('Overview')}</h1>
          <p className="page-sub">
            {summary}
            {f && (
              <>
                {' · '}
                <Updated asOf={f.as_of} />
              </>
            )}
          </p>
        </div>
        <div className="page-controls">
          {groups.length > 2 && (
            <SegmentedControl label={t('Server group')} value={group} onChange={setGroup} options={groups.map((g) => ({ value: g.name, label: g.name === 'All' ? t('All') : g.name, count: g.count }))} />
          )}
          <RangeControl value={range} onChange={setRange} />
          {isAdmin && (
            <button type="button" className="btn-primary" onClick={() => openEnroll()}>
              <Icon name="plus" size={15} />
              {t('Add server')}
            </button>
          )}
        </div>
      </header>

      {fleet.isError && !f ? (
        <ErrorCard title={t('Could not load the overview')} error={fleet.error} onRetry={() => void fleet.refetch()} />
      ) : !f || !k ? (
        <div aria-busy="true" aria-label={t('Loading overview')} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Skeleton height={34} style={{ width: 'min(900px, 100%)' }} />
          <div className="ov-grid">
            <Skeleton height={320} />
            <Skeleton height={320} />
          </div>
        </div>
      ) : total === 0 ? (
        <div className="card empty-card">
          <h2 className="h2">{t('No hosts yet')}</h2>
          <p className="ink-2">{t('Install the agent on a host and approve it here to start monitoring.')}</p>
          {isAdmin && (
            <button type="button" className="btn-primary" onClick={() => openEnroll()}>
              <Icon name="plus" size={15} />
              {t('Enroll a server')}
            </button>
          )}
        </div>
      ) : (
        <>
          <section className="kpi-strip" aria-label={t('Fleet totals')}>
            <span className="kpi">
              <Dot color={offline ? 'var(--critical)' : warnings ? 'var(--warning)' : 'var(--good)'} />
              <span className="v">
                {k.servers_online} / {k.servers_total}
              </span>
              <span className="k">
                {t('hosts online')}
                {warnings ? ` · ${t('{n} with warnings', { n: warnings })}` : ''}
              </span>
            </span>
            <span className="kpi">
              <span className="v">{formatPct(k.cpu_avg_pct)}</span>
              <span className="k">{t('CPU, fleet')}</span>
              <Sparkline values={series.data?.kpi.cpu_pct} color="var(--series-cpu)" height={20} />
            </span>
            <span className="kpi">
              <span className="v">{formatGb(k.memory_used_gb)}</span>
              <span className="k">{t('memory used of {total} · {pct}', { total: formatGb(k.memory_total_gb), pct: formatPct(k.memory_pct) })}</span>
            </span>
            <span className="kpi">
              <span className="v">{formatGb(k.storage_used_tb * 1000)}</span>
              <span className="k">
                {t('storage used of {total}', { total: formatGb(k.storage_total_tb * 1000) })}
                {k.disks_over_75_wear ? ` · ${tn(k.disks_over_75_wear, '{n} disk over 75% wear', '{n} disks over 75% wear')}` : ''}
              </span>
            </span>
            {groupStats && (
              <span className="kpi">
                <span className="v">{groupStats.all.running + groupStats.all.unhealthy}</span>
                <span className="k">{t('guests running of {total}', { total: `${groupStats.all.total}${groupStats.truncated ? '+' : ''}` })}</span>
              </span>
            )}
            <span className="kpi">
              <span className={k.open_alerts ? 'v is-warning' : 'v'}>{k.open_alerts}</span>
              <span className="k">{tn(k.open_alerts, 'open alert', 'open alerts')}</span>
              {hints.length > 0 && (
                <>
                  <span className="k">·</span>
                  <span className="v">{hints.length}</span>
                  <span className="k">{t('to watch')}</span>
                </>
              )}
            </span>
          </section>

          <div className="ov-grid">
            <HostsBoard
              servers={f.servers}
              series={series.data?.servers}
              range={range}
              asOf={f.as_of}
              tallies={groupStats?.byHost ?? null}
              consoleHosts={consoleHosts}
              footer={f.servers.length > 12 ? t('{n} of {total} hosts shown', { n: f.servers.length, total }) : undefined}
            />
            <div className="ov-side">
              <WatchPanel alerts={f.alerts} hints={hints} range={range} />
              <ChecksCard />
            </div>
          </div>

          <Workloads fleet={f} stats={groupStats} range={range} />
          <Capacity servers={online} range={range} />
        </>
      )}
    </>
  );
}
