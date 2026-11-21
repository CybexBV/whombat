// Console wording per platform (PRODUCT-SPEC C3, SCREENS 5): connection-type
// labels, the type chip, the hint line and the power actions of the toolbar.

import type { ConsoleProtocol, Guest, GuestAction, PowerAction } from '../../api/types';
import { formatUptimeShort } from '../../lib/format';
import { t } from '../../lib/i18n';

/** Label of a connection type for this guest ("VGA (SPICE)" on Incus VMs, "noVNC" on Proxmox, ...). */
export function protocolLabel(guest: Pick<Guest, 'platform' | 'kind'>, p: ConsoleProtocol | string): string {
  const pve = guest.platform === 'pve';
  switch (p) {
    case 'vnc':
      return pve ? 'noVNC' : 'VNC';
    case 'spice':
      return guest.platform === 'incus' ? 'VGA (SPICE)' : 'SPICE';
    case 'serial':
      return t('Serial');
    case 'shell':
      return pve ? 'xterm.js' : t('Shell');
    case 'tty':
      return t('Console');
    case 'logs':
      return t('Logs');
    default:
      return p;
  }
}

/** Text protocols run in xterm.js; vnc and spice are graphical. */
export function isTextProtocol(p: ConsoleProtocol | string | null | undefined): boolean {
  return p === 'shell' || p === 'tty' || p === 'serial' || p === 'logs';
}

/** Type chip: "Incus VM · nixos/26.05", "libvirt VM · q35 · OVMF", "QEMU VM 105 · FreeBSD · OVMF", "LXC 202 · debian 13". */
export function typeChip(g: Guest): string {
  switch (g.platform) {
    case 'incus':
      return g.kind === 'vm' ? t('Incus VM · {image}', { image: g.image }) : t('Incus container · {image}', { image: g.image });
    case 'libvirt':
      return t('libvirt VM · {image}', { image: g.image });
    case 'pve': {
      const id = g.vmid ?? g.id.split(':')[1] ?? '';
      return g.kind === 'vm' ? t('QEMU VM {id} · {image}', { id, image: g.image }) : `LXC ${id} · ${g.image}`;
    }
    default:
      return g.image;
  }
}

export function uptimeChip(g: Guest): string {
  return g.state === 'stopped' || g.uptime_s == null ? t('Not running') : t('Up {time}', { time: formatUptimeShort(g.uptime_s) });
}

export function hintFor(g: Guest, protocol: string | null): string {
  if (protocol === 'logs') return t('The last 500 lines, then new ones as they come · read-only');
  if (g.state === 'stopped') return t('Start the guest to open its console');
  if (g.kind === 'container') return t('Type in the terminal · Ctrl+D to log out');
  if (protocol === 'serial') return t('Click the screen to type · press Ctrl+Alt to release');
  return t('Click the screen to capture keyboard and mouse · press Ctrl+Alt to release');
}

export interface ActionSpec {
  action: PowerAction;
  label: string;
  /** The action as a menu item ("Shut down"). */
  verb: string;
  /** Title of the confirmation ("Shut down web-01?"). */
  confirmTitle: (name: string) => string;
  /** Primary button of the confirmation ("Shut down web-01"). */
  confirmButton: (name: string) => string;
  /** Pending chip ("Shutting down…"). */
  pending: string;
  /** Result chip ("Shut down"). */
  done: string;
  icon: 'power' | 'refresh' | 'square' | 'play' | 'pause';
  /** Hard power-off: --serious color and an extra confirmation step. */
  serious: boolean;
  /** Confirmation body. */
  explain: (name: string) => string;
}

export const ACTIONS: Record<PowerAction, ActionSpec> = {
  start: {
    action: 'start',
    label: t('Start'),
    verb: t('Start'),
    confirmTitle: (name) => t('Start {name}?', { name }),
    confirmButton: (name) => t('Start {name}', { name }),
    pending: t('Starting…'),
    done: t('Started'),
    icon: 'play',
    serious: false,
    explain: (name) => t('{name} will be powered on.', { name }),
  },
  shutdown: {
    action: 'shutdown',
    label: t('Shutdown'),
    verb: t('Shut down'),
    confirmTitle: (name) => t('Shut down {name}?', { name }),
    confirmButton: (name) => t('Shut down {name}', { name }),
    pending: t('Shutting down…'),
    done: t('Shut down|done'),
    icon: 'power',
    serious: false,
    explain: (name) => t('{name} gets an ACPI shutdown request and powers off when its operating system has stopped. Open consoles close.', { name }),
  },
  reboot: {
    action: 'reboot',
    label: t('Reboot'),
    verb: t('Reboot'),
    confirmTitle: (name) => t('Reboot {name}?', { name }),
    confirmButton: (name) => t('Reboot {name}', { name }),
    pending: t('Rebooting…'),
    done: t('Rebooted'),
    icon: 'refresh',
    serious: false,
    explain: (name) => t('{name} restarts its operating system. Running programs are stopped and users are disconnected.', { name }),
  },
  force_stop: {
    action: 'force_stop',
    label: t('Force stop'),
    verb: t('Force stop'),
    confirmTitle: (name) => t('Force stop {name}?', { name }),
    confirmButton: (name) => t('Force stop {name}', { name }),
    pending: t('Stopping…'),
    done: t('Stopped'),
    icon: 'square',
    serious: true,
    explain: (name) => t('{name} is powered off immediately, like pulling the plug. Unsaved data in the guest may be lost.', { name }),
  },
  restart: {
    action: 'restart',
    label: t('Restart'),
    verb: t('Restart'),
    confirmTitle: (name) => t('Restart {name}?', { name }),
    confirmButton: (name) => t('Restart {name}', { name }),
    pending: t('Restarting…'),
    done: t('Restarted'),
    icon: 'refresh',
    serious: false,
    explain: (name) => t('{name} is stopped and started again. Its processes are terminated and shells close.', { name }),
  },
  stop: {
    action: 'stop',
    label: t('Stop'),
    verb: t('Stop'),
    confirmTitle: (name) => t('Stop {name}?', { name }),
    confirmButton: (name) => t('Stop {name}', { name }),
    pending: t('Stopping…'),
    done: t('Stopped'),
    icon: 'power',
    serious: true,
    explain: (name) => t('{name} is stopped. Its processes are terminated and unsaved data may be lost.', { name }),
  },
  pause: {
    action: 'pause',
    label: t('Pause'),
    verb: t('Pause'),
    confirmTitle: (name) => t('Pause {name}?', { name }),
    confirmButton: (name) => t('Pause {name}', { name }),
    pending: t('Pausing…'),
    done: t('Paused'),
    icon: 'pause',
    serious: false,
    explain: (name) => t('{name} is frozen in memory until it is resumed.', { name }),
  },
  resume: {
    action: 'resume',
    label: t('Resume'),
    verb: t('Resume'),
    confirmTitle: (name) => t('Resume {name}?', { name }),
    confirmButton: (name) => t('Resume {name}', { name }),
    pending: t('Resuming…'),
    done: t('Resumed'),
    icon: 'play',
    serious: false,
    explain: (name) => t('{name} continues where it was paused.', { name }),
  },
};

const OTHER_TEXT: Record<Exclude<GuestAction, PowerAction>, { label: string; pending: string; done: string }> = {
  snapshot_create: { label: t('Create snapshot'), pending: t('Creating snapshot…'), done: t('Snapshot created') },
  snapshot_restore: { label: t('Roll back'), pending: t('Rolling back…'), done: t('Rolled back') },
  snapshot_delete: { label: t('Delete snapshot'), pending: t('Deleting snapshot…'), done: t('Snapshot deleted') },
  host_reboot: { label: t('Reboot'), pending: t('Rebooting…'), done: t('Rebooting') },
  host_shutdown: { label: t('Shut down'), pending: t('Shutting down…'), done: t('Shutting down') },
};

/** Label, pending and result text of any action (power, snapshot, host). */
export function actionText(a: GuestAction): { label: string; pending: string; done: string } {
  return a in ACTIONS ? ACTIONS[a as PowerAction] : OTHER_TEXT[a as Exclude<GuestAction, PowerAction>];
}

export function toolbarActions(g: Guest): ActionSpec[] {
  return g.kind === 'vm' ? [ACTIONS.shutdown, ACTIONS.reboot, ACTIONS.force_stop] : [ACTIONS.restart, ACTIONS.stop];
}
