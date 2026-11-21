// Which tabs the guest page shows for a guest: the platform decides what
// exists, the user's permissions on the host decide what is listed
// (docs/MANAGE.md, UI). Tabs that read the configuration need Manage.

import type { Guest, RemoteControl } from '../../api/types';
import { t } from '../../lib/i18n';
import type { GuestTab } from '../../lib/urlState';

export interface GuestTabSpec {
  key: GuestTab;
  label: string;
}

/** Proxmox VE and Incus guests can be managed (edited, cloned, deleted, ...). */
export function managed(g: Pick<Guest, 'platform'>): boolean {
  return g.platform === 'pve' || g.platform === 'incus';
}

export function guestTabs(g: Pick<Guest, 'platform' | 'kind'>, rc: RemoteControl | undefined, opts: { cluster?: boolean; cloudInit?: boolean } = {}): GuestTabSpec[] {
  const manage = !!rc?.manage && managed(g);
  const tabs: GuestTabSpec[] = [{ key: 'summary', label: t('Summary') }];
  if (g.platform === 'pve' && manage) {
    tabs.push({ key: 'hardware', label: g.kind === 'vm' ? t('Hardware') : t('Resources') }, { key: 'options', label: t('Options') });
    if (g.kind === 'vm' && opts.cloudInit) tabs.push({ key: 'cloudinit', label: t('Cloud-Init') });
  }
  if (g.platform === 'incus' && manage) tabs.push({ key: 'config', label: t('Configuration') });
  if (g.platform !== 'docker' && rc?.power) tabs.push({ key: 'snapshots', label: t('Snapshots') });
  if (g.platform === 'pve' && manage) {
    tabs.push({ key: 'backups', label: t('Backups') }, { key: 'firewall', label: t('Firewall') });
    if (opts.cluster) tabs.push({ key: 'replication', label: t('Replication') });
    tabs.push({ key: 'tasks', label: t('Tasks') });
  }
  return tabs;
}
