// Header of the guest page (docs/MANAGE.md, Header): the host link, name,
// state, platform and kind with the VMID, node and tags, a facts line, the
// console button, the power menu (the row menu's power items) and the
// lifecycle menu (GuestLifecycleMenu).

import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useGuestConfig } from '../../api/manage';
import type { Guest } from '../../api/types';
import { Chip } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { Menu } from '../../components/Menu';
import { DASH, formatDuration, formatMemPair } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { consolePath, hostPath } from '../../lib/urlState';
import { useGuestPower } from '../guests/GuestMenu';
import { guestStateInfo } from '../guests/guestActions';
import { parseTags } from './config';
import type { GuestTabProps } from './GuestPage';
import { GuestLifecycleMenu } from './GuestLifecycleMenu';
import { managed } from './tabs';

/** "QEMU VM 100", "LXC 200", "Incus container", "libvirt VM", "Docker container". */
export function kindText(g: Pick<Guest, 'platform' | 'kind' | 'vmid' | 'id'>): string {
  const vm = g.kind === 'vm';
  switch (g.platform) {
    case 'pve': {
      const id = g.vmid ?? g.id.split(':')[1] ?? '';
      return vm ? t('QEMU VM {id}', { id }) : t('LXC container {id}', { id });
    }
    case 'incus':
      return vm ? t('Incus VM') : t('Incus container');
    case 'libvirt':
      return t('libvirt VM');
    default:
      return t('Docker container');
  }
}

/** Tags of a guest: the loaded configuration's (fresh after an edit), else the report's. */
export function useGuestTags(serverId: string, guest: Guest, canManage: boolean): string[] {
  const cfg = useGuestConfig(serverId, guest.id, canManage && guest.platform === 'pve');
  return cfg.data ? parseTags(cfg.data.values.tags) : (guest.tags ?? []);
}

export function GuestHeader(props: GuestTabProps) {
  const { serverId, guest, rc } = props;
  const qc = useQueryClient();
  const state = guestStateInfo(guest.state);
  const tags = useGuestTags(serverId, guest, !!rc?.manage && managed(guest));
  const power = useGuestPower(serverId, guest, rc, () => void qc.invalidateQueries({ queryKey: ['guest', serverId, guest.id] }));
  const hasConsole = guest.console.available !== false && (guest.console.protocols?.length ?? 1) > 0 && !!rc?.console;
  const vm = guest.kind === 'vm';
  const running = guest.state !== 'stopped';
  return (
    <header className="host-head">
      <Link to={hostPath(serverId, { tab: 'guests' })} className="guest-crumb link">
        <Icon name="chevronLeft" size={14} />
        {serverId}
      </Link>
      <div className="host-head-row">
        <h1 className="host-title">{guest.name}</h1>
        <Chip dot={state.color}>{state.label}</Chip>
        <Chip>{kindText(guest)}</Chip>
        {guest.node && guest.node !== serverId && <Chip>{t('node {name}', { name: guest.node })}</Chip>}
        {tags.length > 0 && (
          <ul className="plain-list tag-list" aria-label={t('Tags')}>
            {tags.map((tag) => (
              <li key={tag}>
                <Chip className="chip-sm chip-solid">{tag}</Chip>
              </li>
            ))}
          </ul>
        )}
        <div className="host-head-right">
          {hasConsole && (
            <Link to={consolePath(serverId, guest.id)} className={`btn-ghost${running ? '' : ' is-dim'}`} aria-label={vm ? t('Open console for {name}', { name: guest.name }) : t('Open shell for {name}', { name: guest.name })}>
              <Icon name={vm ? 'monitor' : 'terminal'} size={15} />
              {vm ? t('Console') : t('Shell')}
            </Link>
          )}
          {power.items.length > 0 && (
            <Menu label={t('Power actions for {name}', { name: guest.name })} items={power.items} buttonClassName="btn-ghost" floating>
              {power.pending ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Icon name="power" size={15} />}
              {t('Power')}
              <Icon name="chevronDown" size={14} />
            </Menu>
          )}
          <GuestLifecycleMenu {...props} />
        </div>
      </div>
      <div className="host-facts">
        {guest.image && <span>{guest.image}</span>}
        {guest.vcpu != null && <span>{tx('{n} vCPU', { n: <b>{guest.vcpu}</b> })}</span>}
        {guest.memory_limit_mb != null && <span>{tx('Memory {value}', { value: <b>{formatMemPair(guest.memory_used_mb, guest.memory_limit_mb)}</b> })}</span>}
        <span>{running ? tx('Up {time}', { time: <b>{guest.uptime_s == null ? DASH : formatDuration(guest.uptime_s)}</b> }) : t('Not running')}</span>
        {guest.addresses?.slice(0, 2).map((a) => (
          <span key={a} className="mono">
            {a}
          </span>
        ))}
      </div>
      {power.dialog}
    </header>
  );
}
