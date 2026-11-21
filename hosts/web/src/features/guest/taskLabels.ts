// Friendly names of platform task types (Proxmox UPID types, Incus
// operations) and task states for the Tasks tab and the task dialog. An
// unknown type reads as itself.

import type { TaskState } from '../../api/manage';
import { t } from '../../lib/i18n';

const TYPES: Record<string, () => string> = {
  // Proxmox VE: VMs (qm*) and containers (vz*)
  qmstart: () => t('Start'),
  vzstart: () => t('Start'),
  qmstop: () => t('Stop'),
  vzstop: () => t('Stop'),
  qmshutdown: () => t('Shut down'),
  vzshutdown: () => t('Shut down'),
  qmreboot: () => t('Reboot'),
  vzreboot: () => t('Reboot'),
  qmreset: () => t('Reset'),
  qmsuspend: () => t('Pause'),
  vzsuspend: () => t('Pause'),
  qmresume: () => t('Resume'),
  vzresume: () => t('Resume'),
  qmcreate: () => t('Create'),
  vzcreate: () => t('Create'),
  qmclone: () => t('Clone'),
  vzclone: () => t('Clone'),
  qmdestroy: () => t('Delete'),
  vzdestroy: () => t('Delete'),
  qmtemplate: () => t('Convert to template'),
  vztemplate: () => t('Convert to template'),
  qmrestore: () => t('Restore'),
  vzrestore: () => t('Restore'),
  qmconfig: () => t('Change configuration'),
  qmresize: () => t('Resize disk'),
  resize: () => t('Resize disk'),
  qmmove: () => t('Move disk'),
  move_volume: () => t('Move volume'),
  imgcopy: () => t('Copy disk'),
  qmsnapshot: () => t('Take snapshot'),
  vzsnapshot: () => t('Take snapshot'),
  qmdelsnapshot: () => t('Delete snapshot'),
  vzdelsnapshot: () => t('Delete snapshot'),
  qmrollback: () => t('Roll back'),
  vzrollback: () => t('Roll back'),
  qmigrate: () => t('Migrate'),
  vzmigrate: () => t('Migrate'),
  vzdump: () => t('Back up'),
  download: () => t('Download'),
  aptupdate: () => t('Update package lists'),
  vncproxy: () => t('Console'),
  vncshell: () => t('Shell'),
  // Incus operations
  create: () => t('Create'),
  copy: () => t('Copy'),
  delete: () => t('Delete'),
};

/** "vzdump" -> "Back up"; unknown types stay as they are. */
export function taskTypeLabel(type: string): string {
  return TYPES[type]?.() ?? type;
}

export const TASK_STATE: Record<TaskState, { label: string; color: string }> = {
  running: { label: t('Running'), color: 'var(--series-cpu)' },
  ok: { label: t('OK'), color: 'var(--good)' },
  warning: { label: t('Warnings'), color: 'var(--warning)' },
  error: { label: t('Failed'), color: 'var(--critical)' },
};

/** Duration of a task in seconds (running ones up to now). */
export function taskSeconds(started: string, ended: string | null | undefined, now: number): number {
  const a = Date.parse(started);
  const b = ended ? Date.parse(ended) : now;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 1000) : 0;
}
