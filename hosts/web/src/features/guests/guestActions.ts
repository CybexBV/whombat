// What a guest row offers: its state as text and dot color, and the power
// actions its platform and state allow (the hub's rules: containers have no
// force stop, Proxmox containers cannot be paused, Docker has no snapshots).

import type { Guest, GuestState, PowerAction } from '../../api/types';
import { t } from '../../lib/i18n';

export const GUEST_STATE: Record<GuestState, { label: string; color: string }> = {
  running: { label: t('Running'), color: 'var(--good)' },
  stopped: { label: t('Stopped'), color: 'var(--muted)' },
  unhealthy: { label: t('Unhealthy'), color: 'var(--serious)' },
  paused: { label: t('Paused'), color: 'var(--warning)' },
};

/** Label and dot color of a guest state (an unknown state reads as itself, muted). */
export function guestStateInfo(state: string): { label: string; color: string } {
  return GUEST_STATE[state as GuestState] ?? { label: state ? state[0]!.toUpperCase() + state.slice(1) : t('Unknown'), color: 'var(--muted)' };
}

type GuestLike = Pick<Guest, 'platform' | 'kind' | 'state'>;

/** Power actions for the row menu, in menu order (the last ones are the hard stops). */
export function guestPowerActions(g: GuestLike): PowerAction[] {
  const vm = g.kind === 'vm';
  switch (g.state) {
    case 'stopped':
      return ['start'];
    case 'paused':
      return vm ? ['resume', 'force_stop'] : ['resume', 'stop'];
    default: {
      const pause: PowerAction[] = g.platform === 'pve' && !vm ? [] : ['pause'];
      return vm ? ['shutdown', 'reboot', ...pause, 'force_stop'] : ['restart', ...pause, 'stop'];
    }
  }
}

/** Actions the hub only runs with `confirm: true`: the menu asks first. */
export function needsConfirm(a: PowerAction): boolean {
  return a === 'shutdown' || a === 'reboot' || a === 'restart' || a === 'stop' || a === 'force_stop';
}

/** Snapshots: Incus, libvirt and Proxmox guests (not Docker). */
export function hasSnapshots(g: Pick<Guest, 'platform'>): boolean {
  return g.platform !== 'docker';
}

/** Snapshot names the hub accepts (Proxmox: starting with a letter). "" is fine for create (the hub names it). */
export function snapshotNameError(name: string, platform: string): string | null {
  const n = name.trim();
  if (!n) return null;
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,39}$/.test(n)) return t('Use 1 to 40 letters, digits, “.”, “_” or “-”, not starting with “-”.');
  if (platform === 'pve' && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(n)) return t('Proxmox snapshot names start with a letter and use letters, digits, “_” and “-”.');
  return null;
}

/** Whether a snapshot of this guest can include the memory state (Proxmox and libvirt VMs). */
export function snapshotMemory(g: Pick<Guest, 'platform' | 'kind'>): boolean {
  return g.kind === 'vm' && (g.platform === 'pve' || g.platform === 'libvirt');
}
