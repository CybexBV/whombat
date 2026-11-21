// Host page (UI v2, NOTES.md): /servers/:id with tabs (Summary, Guests,
// Storage, Sensors, Virtualization, Agent) in the `tab` parameter. The
// console route /servers/:id/guests/:guestId/console opens the console
// beside the guests table (Guests tab). URL state: ?tab, ?range, ?platform,
// ?view, ?protocol, ?q (guest name filter).

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { ApiError, isProxmoxDetail } from '../../api/client';
import { useAlerts, useAnnotations, useAuthState, useMetrics, useServer } from '../../api/queries';
import type { Range, Zoom } from '../../api/types';
import type { ChartExtras } from '../../components/TimeChart';
import { marksFor } from '../../lib/chart';
import { formatTooltipTime, rangeForSpan } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { ErrorCard, Skeleton } from '../../components/common';
import { consolePath, DEFAULT_RANGE, DEFAULT_TAB, type HostTab, hostPath, parseTab, useParamSetter, useRange } from '../../lib/urlState';
import { useTitle } from '../../lib/useTitle';
import { AgentDetail } from '../agents/AgentPage';
import { GuestsTab } from './Guests';
import { FansCard, ProxmoxActivity } from './Health';
import { HostBanner, HostHeader } from './HostHeader';
import { HostTabs, type TabSpec } from './HostTabs';
import { Temperatures } from './Overview';
import { defaultTab, type PlatformKey, platformTabs, tabForGuest } from './platforms';
import { BackupsSection, ClusterSection } from './Proxmox';
import { StorageProxmox, StorageStandard } from './Storage';
import { SummaryTab } from './SummaryTab';
import { parseSystemView, systemAllowed, SystemTab } from './SystemTab';
import { Virtualization } from './Virtualization';

export function ServerPage() {
  const { id = '', guestId } = useParams();
  const [range] = useRange();
  const [params, setParam] = useParamSetter();
  const navigate = useNavigate();
  const detail = useServer(id, range);
  // Zoom: a from/to window dragged on a chart (history; Back returns).
  const zoomFrom = params.get('from');
  const zoomTo = params.get('to');
  const zoom = useMemo<Zoom | null>(() => (zoomFrom && zoomTo ? { from: zoomFrom, to: zoomTo } : null), [zoomFrom, zoomTo]);
  const metrics = useMetrics(id, range, zoom);
  const annotations = useAnnotations(id, range, zoom);
  const alerts = useAlerts();
  const auth = useAuthState();
  const isAdmin = auth.data?.user?.role === 'admin';
  const [hover, setHover] = useState<number | null>(null);
  // Stable between renders (the charts' hover re-renders the page often).
  const hostAlerts = useMemo(() => (alerts.data ?? []).filter((a) => a.server === id), [alerts.data, id]);
  useTitle(id);

  // Range change or another host: the crosshair returns to its resting position.
  useEffect(() => setHover(null), [range, id, zoom]);

  // A link to a card (#system, from a banner or a Watch row): scroll to it once
  // it is rendered, focus it and ring it briefly. Every click is a new location
  // key, so a second click on the same link scrolls again.
  const loc = useLocation();
  const loaded = !!detail.data;
  useEffect(() => {
    const el = loaded && loc.hash.length > 1 ? document.getElementById(decodeURIComponent(loc.hash.slice(1))) : null;
    if (!el) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
    el.classList.remove('is-target');
    void el.offsetWidth; // restart the animation
    el.classList.add('is-target');
    const done = () => el.classList.remove('is-target');
    el.addEventListener('animationend', done, { once: true });
    return () => el.removeEventListener('animationend', done);
  }, [loc.key, loc.hash, loaded]);

  const chart = useMemo<ChartExtras>(() => {
    const m = metrics.data;
    const ts = m?.timestamps ?? [];
    const span = zoom ? (Date.parse(zoom.to) - Date.parse(zoom.from)) / 1000 : 0;
    const tickRange = zoom ? rangeForSpan(span) : undefined;
    return {
      marks: marksFor(annotations.data, ts),
      range: tickRange,
      endTick: zoom && tickRange ? formatTooltipTime(tickRange, Date.parse(zoom.to)) : undefined,
      onZoom: (i0: number, i1: number) => {
        const a = ts[i0];
        const b = ts[i1];
        if (!m || !a || !b) return;
        const from = new Date(Date.parse(a) - m.step_seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
        const to = new Date(Date.parse(b)).toISOString().replace(/\.\d+Z$/, 'Z');
        const next = new URLSearchParams(params);
        next.set('from', from);
        next.set('to', to);
        navigate({ search: next.toString() });
      },
    };
  }, [metrics.data, annotations.data, zoom, params, navigate]);
  const resetZoom = () => setParam('from', null, { drop: ['to'] });

  const d = detail.data;
  const tabs = d ? platformTabs(d) : [];
  const consoleTab = guestId ? tabForGuest(tabs, guestId) : undefined;
  const tab = consoleTab ?? tabs.find((t) => t.key === params.get('platform')) ?? defaultTab(tabs);
  const view: 'list' | 'screens' = params.get('view') === 'screens' ? 'screens' : 'list';
  // The console route and the old ?platform= / ?view= addresses imply the Guests tab.
  const active: HostTab = guestId ? 'guests' : params.get('tab') ? parseTab(params.get('tab')) : params.get('platform') || params.get('view') ? 'guests' : DEFAULT_TAB;
  const query = params.get('q') ?? '';
  const rangeParam = range === DEFAULT_RANGE ? undefined : range;
  const platformParam = (key: PlatformKey | undefined) => (key && key !== defaultTab(tabs)?.key ? key : null);
  const guestsPath = (opts: { platform?: PlatformKey; view?: 'list' | 'screens'; q?: string }) =>
    hostPath(id, { tab: 'guests', range: rangeParam, platform: platformParam(opts.platform ?? tab?.key), view: opts.view ?? view, q: opts.q ?? query });

  const onSelectTab = (key: PlatformKey) => navigate(guestsPath({ platform: key, q: '' }), { replace: !guestId });
  const onView = (v: 'list' | 'screens') => navigate(guestsPath({ view: v }), { replace: !guestId });
  const onQuery = (q: string) => setParam('q', q || null);
  const onOpenConsole = (gid: string) => navigate(consolePath(id, gid, { range: rangeParam, platform: platformParam(tab?.key) }));
  const onCloseConsole = () => navigate(guestsPath({}));

  if (!d) {
    if (detail.isError) {
      const notFound = detail.error instanceof ApiError && detail.error.status === 404;
      return notFound ? (
        <div className="card empty-card" role="alert">
          <h1 className="h2">{t('Host not found')}</h1>
          <p className="ink-2">{tx('There is no host called {id}.', { id: <span className="mono ink">{id}</span> })}</p>
          <Link to="/" className="btn-ghost">
            {t('Back to the overview')}
          </Link>
        </div>
      ) : (
        <ErrorCard title={t('Could not load {name}', { name: id })} error={detail.error} onRetry={() => void detail.refetch()} />
      );
    }
    return (
      <div aria-busy="true" aria-label={t('Loading {name}', { name: id })} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Skeleton height={64} />
        <Skeleton height={40} />
        <div className="sum-charts">
          <Skeleton height={240} />
          <Skeleton height={240} />
          <Skeleton height={240} />
        </div>
      </div>
    );
  }

  const pve = isProxmoxDetail(d);

  const alertCount = alerts.data ? hostAlerts.length : d.banner ? 1 : 0;
  const hints = d.hints ?? [];
  const failing = (d.server.collectors ?? []).filter((c) => !c.ok);
  const guestsTotal = tabs.reduce((a, t) => a + t.workload.total, 0);
  const tabSpecs: TabSpec[] = [
    { key: 'summary', label: t('Summary') },
    ...(tabs.length ? [{ key: 'guests' as const, label: t('Guests'), count: guestsTotal }] : []),
    { key: 'storage', label: t('Storage'), count: pve ? d.storages.length : d.disks.length },
    ...(d.sensors.length || d.fans?.length ? [{ key: 'sensors' as const, label: t('Sensors'), count: d.sensors.length }] : []),
    ...(d.virtualization || (pve && d.cluster) || d.tasks?.length ? [{ key: 'virtualization' as const, label: t('Virtualization') }] : []),
    ...(systemAllowed(d.server.remote_control) ? [{ key: 'system' as const, label: t('System') }] : []),
    ...(isAdmin ? [{ key: 'agent' as const, label: t('Agent') }] : []),
  ];
  const current = tabSpecs.some((t) => t.key === active) ? active : DEFAULT_TAB;
  const usage = { detail: d, metrics: metrics.data, range, hover, onHover: setHover, chart };
  const zoomBar = zoom && (
    <div className="zoom-bar">
      <span className="ink-2">{t('Zoomed to {from} – {to}', { from: formatTooltipTime('7d', Date.parse(zoom.from)), to: formatTooltipTime('7d', Date.parse(zoom.to)) })}</span>
      <button type="button" className="btn-text" onClick={resetZoom}>
        {t('Back to {range}', { range })}
      </button>
    </div>
  );

  let body;
  switch (current) {
    case 'guests':
      body =
        tab && tabs.length ? (
          <GuestsTab
            serverId={id}
            detail={d}
            tabs={tabs}
            tab={tab}
            onSelectTab={onSelectTab}
            view={view}
            onView={onView}
            query={query}
            onQuery={onQuery}
            consoleGuestId={guestId ?? null}
            protocol={params.get('protocol')}
            onProtocolChange={(p) => setParam('protocol', p)}
            onOpenConsole={onOpenConsole}
            onCloseConsole={onCloseConsole}
          />
        ) : (
          <div className="card empty-card ink-2">{t('No guests on this host.')}</div>
        );
      break;
    case 'storage':
      body = pve ? (
        <>
          <StorageProxmox storages={d.storages} disks={d.disks} volumes={d.volumes} arrays={d.arrays} serverId={id} rc={d.server.remote_control} isAdmin={isAdmin} />
          {d.backups && <BackupsSection backups={d.backups} storages={d.storages} />}
        </>
      ) : (
        <StorageStandard disks={d.disks} volumes={d.volumes} arrays={d.arrays} />
      );
      break;
    case 'sensors':
      body = (
        <>
          {zoomBar}
          {metrics.isError && !metrics.data && <ErrorCard title={t('Could not load the charts')} error={metrics.error} onRetry={() => void metrics.refetch()} />}
          <Temperatures {...usage} />
          <FansCard fans={d.fans ?? []} />
        </>
      );
      break;
    case 'virtualization':
      body = (
        <>
          {pve && d.cluster && <ClusterSection cluster={d.cluster} />}
          <ProxmoxActivity tasks={d.tasks ?? []} replication={d.pve_replication ?? []} ceph={d.ceph ?? null} />
          {d.virtualization ? <Virtualization v={d.virtualization} proxmox={pve} metrics={metrics.data} /> : <div className="card empty-card ink-2">{t('This host has no KVM capabilities.')}</div>}
        </>
      );
      break;
    case 'agent':
      body = <AgentDetail id={id} embedded />;
      break;
    case 'system':
      body = (
        <SystemTab
          serverId={id}
          rc={d.server.remote_control}
          isAdmin={isAdmin}
          view={parseSystemView(params.get('view'))}
          onView={(v) => setParam('view', v === 'processes' ? null : v)}
        />
      );
      break;
    default:
      body = (
        <>
          {zoomBar}
          {metrics.isError && !metrics.data && <ErrorCard title={t('Could not load the charts')} error={metrics.error} onRetry={() => void metrics.refetch()} />}
          <SummaryTab {...usage} alerts={hostAlerts} hints={hints} />
        </>
      );
  }

  return (
    <div className="server-page" style={{ display: 'contents' }}>
      <HostHeader detail={d} alertCount={alertCount} range={range} onRange={(r: Range) => setParam('range', r === DEFAULT_RANGE ? null : r, { drop: ['from', 'to'] })} />
      <HostTabs serverId={id} tabs={tabSpecs} active={current} range={range} />
      {d.banner && <HostBanner banner={d.banner} serverId={id} range={range} />}
      {failing.length > 0 && (
        <div className="card banner is-warning" role="status">
          <span className="t">{t('Not reporting:')}</span>
          <span className="d">{failing.map((c) => `${c.name}${c.error ? ` (${c.error})` : ''}`).join(', ')}</span>
          {isAdmin && <Link to={hostPath(id, { tab: 'agent', range: rangeParam })}>{t('View agent')}</Link>}
        </div>
      )}
      {body}
    </div>
  );
}
