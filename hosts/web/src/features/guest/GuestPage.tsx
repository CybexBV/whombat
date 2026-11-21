// Guest page (docs/MANAGE.md, UI): /servers/:id/guests/:guestId with tabs in
// the `tab` parameter. Every platform gets the Summary; Proxmox VE and Incus
// guests get their configuration, backups, firewall, replication and tasks
// when the host's Manage switch is on (and the user is an operator).

import { Link, useParams } from 'react-router';
import { ApiError, isProxmoxDetail } from '../../api/client';
import { useGuest, useGuestConfig } from '../../api/manage';
import { useAuthState, useServer } from '../../api/queries';
import type { Guest, RemoteControl, ServerDetail } from '../../api/types';
import { ErrorCard, Skeleton } from '../../components/common';
import { t, tx } from '../../lib/i18n';
import { DEFAULT_RANGE, guestPath, hostPath, parseGuestTab, useParamSetter } from '../../lib/urlState';
import { useTitle } from '../../lib/useTitle';
import { BackupsTab } from './BackupsTab';
import { CloudInitTab } from './CloudInitTab';
import { ConfigTab } from './ConfigTab';
import { FirewallTab } from './FirewallTab';
import { GuestHeader } from './GuestHeader';
import { HardwareTab } from './HardwareTab';
import { OptionsTab } from './OptionsTab';
import { ReplicationTab } from './ReplicationTab';
import { SnapshotsTab } from './SnapshotsTab';
import { SummaryTab } from './SummaryTab';
import { guestTabs, managed } from './tabs';
import { TasksTab } from './TasksTab';

/** What every tab receives. */
export interface GuestTabProps {
  serverId: string;
  guest: Guest;
  /** The user's permissions on the host. */
  rc: RemoteControl | undefined;
  detail: ServerDetail;
  isAdmin: boolean;
}

export function GuestPage() {
  const { id = '', guestId = '' } = useParams();
  const [params] = useParamSetter();
  const detail = useServer(id, DEFAULT_RANGE);
  const guest = useGuest(id, guestId);
  const auth = useAuthState();
  const isAdmin = auth.data?.user?.role === 'admin';
  const d = detail.data;
  const g = guest.data;
  const rc = d?.server.remote_control;
  const canManage = !!rc?.manage && !!g && managed(g);
  // The configuration tells whether a VM has a cloud-init drive.
  const config = useGuestConfig(id, guestId, canManage && g?.platform === 'pve' && g.kind === 'vm');
  useTitle(g ? `${g.name} · ${id}` : id);

  if (!d || !g) {
    const err = guest.error ?? detail.error;
    if (err) {
      const notFound = err instanceof ApiError && err.status === 404;
      return notFound ? (
        <div className="card empty-card" role="alert">
          <h1 className="h2">{t('Guest not found')}</h1>
          <p className="ink-2">{tx('{id} has no guest {guest}.', { id: <span className="mono ink">{id}</span>, guest: <span className="mono ink">{guestId}</span> })}</p>
          <Link to={hostPath(id, { tab: 'guests' })} className="btn-ghost">
            {t('Back to {name}', { name: id })}
          </Link>
        </div>
      ) : (
        <ErrorCard title={t('Could not load {name}', { name: guestId })} error={err} onRetry={() => void (guest.refetch(), detail.refetch())} />
      );
    }
    return (
      <div aria-busy="true" aria-label={t('Loading {name}', { name: guestId })} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Skeleton height={64} />
        <Skeleton height={40} />
        <Skeleton height={320} />
      </div>
    );
  }

  const cluster = isProxmoxDetail(d) && !!d.cluster;
  const cloudInit = Object.values(config.data?.values ?? {}).some((v) => v.includes('cloudinit'));
  const tabs = guestTabs(g, rc, { cluster, cloudInit });
  const want = parseGuestTab(params.get('tab'));
  const active = tabs.some((x) => x.key === want) ? want : 'summary';
  const props: GuestTabProps = { serverId: id, guest: g, rc, detail: d, isAdmin };

  let body;
  switch (active) {
    case 'hardware':
      body = <HardwareTab {...props} />;
      break;
    case 'options':
      body = <OptionsTab {...props} />;
      break;
    case 'cloudinit':
      body = <CloudInitTab {...props} />;
      break;
    case 'config':
      body = <ConfigTab {...props} />;
      break;
    case 'snapshots':
      body = <SnapshotsTab {...props} />;
      break;
    case 'backups':
      body = <BackupsTab {...props} />;
      break;
    case 'firewall':
      body = <FirewallTab {...props} />;
      break;
    case 'replication':
      body = <ReplicationTab {...props} />;
      break;
    case 'tasks':
      body = <TasksTab {...props} />;
      break;
    default:
      body = <SummaryTab {...props} />;
  }

  return (
    <div className="guest-page">
      <GuestHeader {...props} />
      <nav className="host-tabs" aria-label={t('Guest sections')}>
        {tabs.map((tab) => (
          <Link key={tab.key} to={guestPath(id, g.id, { tab: tab.key })} aria-current={tab.key === active ? 'page' : undefined}>
            {tab.label}
          </Link>
        ))}
      </nav>
      {body}
    </div>
  );
}
