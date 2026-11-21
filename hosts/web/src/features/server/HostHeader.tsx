// Host page header (UI v2): name, status, group and platform chips, the live
// indicator, range control and (admins) Ask assistant and the settings
// shortcut; a facts line with OS, processor, memory, uptime, address and agent.

import { useState } from 'react';
import { Link } from 'react-router';
import { HOST_GUEST_ID, isProxmoxDetail } from '../../api/client';
import { useAuthState } from '../../api/queries';
import type { Banner, HostAction, Range, ServerDetail } from '../../api/types';
import { RangeControl, SeverityIcon } from '../../components/common';
import { Chip, Dot } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { Menu, type MenuItem } from '../../components/Menu';
import { useNow } from '../../lib/clock';
import { MutedChip, MuteDialog, muteItems, useMute } from './MuteControl';
import { DASH, formatDateOnly, formatDuration, formatGbInt, plural } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { STATUS_DOT, STATUS_LABEL } from '../../lib/thresholds';
import { agentPath } from '../../lib/urlState';
import { AskAssistantButton } from '../assistant/AskDialog';
import { linkPath } from '../fleet/WatchPanel';
import { actionText } from '../console/labels';
import { useActionState } from '../console/powerActions';
import { HostPowerDialog } from './HostPowerDialog';

function kernelText(os: ServerDetail['server']['os']): string {
  const k = os.kernel.trim();
  if (/^\d/.test(k)) return k;
  const m = /^(.*?)\s*\((.*)\)$/.exec(k);
  return m ? `${m[2]} · ${m[1]}` : k;
}

export function HostHeader({ detail, alertCount, range, onRange }: { detail: ServerDetail; alertCount: number; range: Range; onRange: (r: Range) => void }) {
  const s = detail.server;
  const pve = isProxmoxDetail(detail);
  const kvm = s.roles.includes('kvm-host') || !!detail.virtualization?.capabilities.kvm.enabled;
  const rc = s.remote_control;
  const rcText = rc ? (rc.console && rc.power ? t('Console + power on') : rc.console ? t('Console on') : rc.power ? t('Power on') : null) : null;
  const role = useAuthState().data?.user?.role;
  const admin = role === 'admin';
  const canAct = role === 'admin' || role === 'operator';
  const offline = s.status === 'offline';
  const now = useNow(60_000);
  const mute = useMute(s.id);
  const [muteDialog, setMuteDialog] = useState(false);
  const [power, setPower] = useState<HostAction | null>(null);
  const hostAction = useActionState(s.id, HOST_GUEST_ID);
  const powerBusy = hostAction.pending ? t('{action} is in progress', { action: actionText(hostAction.pending.action).pending.replace('…', '') }) : undefined;
  const muteMenu = canAct && !s.maintenance ? muteItems(mute, now, () => setMuteDialog(true)) : [];
  const menu: MenuItem[] = [
    ...muteMenu,
    ...(rc?.host_power && !offline
      ? [
          ...(muteMenu.length ? [{ heading: true, label: t('Power') }] : []),
          { label: t('Reboot host…'), icon: 'refresh' as const, danger: true, disabled: !!powerBusy, title: powerBusy, onSelect: () => setPower('host_reboot') },
          { label: t('Shut down host…'), icon: 'power' as const, danger: true, disabled: !!powerBusy, title: powerBusy, onSelect: () => setPower('host_shutdown') },
        ]
      : []),
  ];
  return (
    <header className="host-head">
      <div className="host-head-row">
        <h1 className="host-title">{s.id}</h1>
        <Chip dot={STATUS_DOT[s.status]}>
          {STATUS_LABEL[s.status]}
          {alertCount ? ` · ${plural(alertCount, 'alert')}` : ''}
        </Chip>
        <Chip>{s.group}</Chip>
        {pve && (
          <Chip>
            {s.os.name} {s.os.version}
          </Chip>
        )}
        {kvm && !pve && <Chip>{t('KVM host')}</Chip>}
        {rcText && <Chip title={t("Remote control: the hub switch and the agent's policy both allow it")}>{rcText}</Chip>}
        {s.parent && <Chip title={t('{id} runs on {parent}: its alerts are suppressed while {parent} is offline', { id: s.id, parent: s.parent })}>{t('on {parent}', { parent: s.parent })}</Chip>}
        {s.maintenance && <MutedChip maint={s.maintenance} canUnmute={canAct} m={mute} />}
        <div className="host-head-right">
          <span className="lbl live">
            <Dot color={offline ? 'var(--muted)' : 'var(--good)'} />
            {offline ? t('Agent unreachable') : t('Live · every {n} s', { n: detail.live.refresh_interval_s })}
          </span>
          <RangeControl value={range} onChange={onRange} />
          <AskAssistantButton server={s.id} />
          {admin && (
            <Link to={agentPath(s.id)} className="btn-ghost btn-icon" aria-label={t('Settings for {name}', { name: s.id })} title={t('Agent and server settings')}>
              <Icon name="settings" size={16} />
            </Link>
          )}
          {menu.length > 0 && (
            <Menu label={t('More for {name}', { name: s.id })} items={menu} floating>
              {hostAction.pending ? <span className="spinner spinner-sm" aria-hidden="true" /> : undefined}
            </Menu>
          )}
        </div>
        <MuteDialog serverId={s.id} open={muteDialog} onClose={() => setMuteDialog(false)} m={mute} />
        <HostPowerDialog serverId={s.id} action={power} onClose={() => setPower(null)} />
      </div>
      <div className="host-facts" aria-label={t('System')}>
        <span>
          <b>
            {s.os.name} {s.os.version}
          </b>{' '}
          · {kernelText(s.os)}
        </span>
        <span>
          <b>{s.cpu.model}</b> · {t('{cores} cores / {threads} threads', { cores: s.cpu.cores, threads: s.cpu.threads })}
        </span>
        <span>
          <b>{formatGbInt(s.memory.total_gb)}</b>
          {s.memory.type ? ` ${s.memory.type}` : ''}
        </span>
        <span>
          {tx('Up {time}', { time: <b>{s.uptime_s == null ? DASH : formatDuration(s.uptime_s)}</b> })}
          {s.last_boot ? ` · ${t('since {time}', { time: formatDateOnly(s.last_boot) })}` : ''}
        </span>
        {s.address && <span className="mono">{s.address}</span>}
        {s.location && <span>{s.location}</span>}
        <span>
          {tx('Agent {version}', { version: <b>{s.agent.version}</b> })}
          {s.agent.connected === false ? ` · ${t('not connected')}` : s.agent.last_sync_s_ago == null ? '' : ` · ${t('synced {n} s ago', { n: s.agent.last_sync_s_ago })}`}
        </span>
      </div>
    </header>
  );
}

const LINK_TEXT: Record<string, string> = { '#storage': t('View storage'), '#temps': t('View sensors'), '#virtualization': t('View virtualization'), '#cluster': t('View cluster'), '#guests': t('View guests'), '#agent': t('View agent'), '#system': t('View system') };

export function HostBanner({ banner, serverId, range }: { banner: Banner; serverId: string; range: Range }) {
  const href = banner.link ?? null;
  return (
    <div className={`card banner ${banner.severity === 'critical' ? 'is-critical' : 'is-warning'}`} role="region" aria-label={t('Active alert')}>
      <SeverityIcon severity={banner.severity} size={16} />
      <span className="t">{banner.title}</span>
      <span className="d">{banner.detail}</span>
      {href && <Link to={linkPath(serverId, href, range)}>{LINK_TEXT[href] ?? t('View details')}</Link>}
    </div>
  );
}
