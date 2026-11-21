/**
 * A guest's lifecycle in words (stream WB, PX-01/PX-05/PX-07; ported from Rackoon's `taskLabels.ts`, `taskEvents.ts`,
 * `FirewallTab`'s rule summary and `ReplicationTab`'s schedule words): what a task is called and what its toasts say,
 * the Proxmox hints a guest has with their way out, a firewall rule in one line, a replication schedule. Pure, shared by
 * the web and Android.
 */
import type { HostBackupJob, HostFirewall, HostGuest, HostManageOp, HostTask } from '@whombat/core/domain';
import { plural } from './format';
import type { HostTone } from './thresholds';

/* Tasks --------------------------------------------------------------------------------------------- */

const TASK_TYPES: Record<string, string> = {
  qmstart: 'Start',
  vzstart: 'Start',
  qmstop: 'Stop',
  vzstop: 'Stop',
  qmshutdown: 'Shut down',
  vzshutdown: 'Shut down',
  qmreboot: 'Restart',
  vzreboot: 'Restart',
  qmreset: 'Reset',
  qmsuspend: 'Pause',
  vzsuspend: 'Pause',
  qmresume: 'Resume',
  vzresume: 'Resume',
  qmcreate: 'Create',
  vzcreate: 'Create',
  qmclone: 'Clone',
  vzclone: 'Clone',
  qmdestroy: 'Delete',
  vzdestroy: 'Delete',
  qmtemplate: 'Convert to template',
  vztemplate: 'Convert to template',
  qmrestore: 'Restore',
  vzrestore: 'Restore',
  qmconfig: 'Settings',
  vzconfig: 'Settings',
  qmresize: 'Grow a disk',
  resize: 'Grow a disk',
  qmmove: 'Move a disk',
  move_volume: 'Move a disk',
  imgcopy: 'Copy a disk',
  qmsnapshot: 'Snapshot',
  vzsnapshot: 'Snapshot',
  qmdelsnapshot: 'Remove a snapshot',
  vzdelsnapshot: 'Remove a snapshot',
  qmrollback: 'Back to a snapshot',
  vzrollback: 'Back to a snapshot',
  qmigrate: 'Move',
  vzmigrate: 'Move',
  vzdump: 'Backup',
  download: 'Download',
  aptupdate: 'Update package lists',
  vncproxy: 'Console',
  vncshell: 'Shell',
  create: 'Create',
  copy: 'Copy',
  delete: 'Delete',
};

/** “vzdump” → “Backup”; an unknown type reads as itself. */
export function taskTypeText(type: string): string {
  return TASK_TYPES[type] ?? type;
}

export const TASK_STATUS_WORDS: Record<HostTask['status'], string> = {
  running: 'Running',
  ok: 'Done',
  warning: 'Done, with warnings',
  error: 'Failed',
};

export function taskStatusTone(status: HostTask['status']): HostTone {
  return status === 'ok' ? 'ok' : status === 'running' ? 'mut' : status === 'warning' ? 'warn' : 'bad';
}

/** Seconds a task took; a running one up to now. */
export function taskSeconds(started: string, ended: string | null | undefined, now: number): number {
  const a = Date.parse(started);
  const b = ended ? Date.parse(ended) : now;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 1000) : 0;
}

/** What a change that runs as a task is called in its toasts (“Backup of web”, “Clone of web”). */
export function taskWhat(op: HostManageOp | string, name: string): string {
  switch (op) {
    case 'backup.create':
      return `Backup of ${name}`;
    case 'backup.restore':
      return `Restore of ${name}`;
    case 'backup.delete':
      return 'Deleting the backup';
    case 'guest.clone':
      return `Clone of ${name}`;
    case 'guest.create':
      return `Creating ${name}`;
    case 'guest.template':
      return `Turning ${name} into a template`;
    case 'guest.delete':
      return `Deleting ${name}`;
    case 'guest.migrate':
      return `Move of ${name}`;
    case 'disk.resize':
      return `Growing ${name}’s disk`;
    case 'disk.move':
      return `Moving ${name}’s disk`;
    case 'content.download':
    case 'appliance.download':
      return `Download of ${name}`;
    case 'content.delete':
      return `Deleting ${name}`;
    case 'config.set':
      return `Saving ${name}’s settings`;
    case 'backupjob.run':
      return `Backup job ${name}`;
    default:
      return name ? `The task for ${name}` : 'The task';
  }
}

/** “Backup of web started.” */
export function taskStartedText(what: string): string {
  return `${what} started.`;
}

/** Proxmox ends a task with warnings as “WARNINGS: 2”: the count, or null. */
export function taskWarnings(message: string | null | undefined): number | null {
  const m = /warnings?:\s*(\d+)/i.exec(message ?? '');
  return m ? Number(m[1]) : null;
}

/** A task's own words as the end of a sentence: one line, trimmed, with a full stop. */
function reason(message: string): string {
  const line =
    message
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  const short = line.length > 160 ? `${line.slice(0, 157).trimEnd()}…` : line;
  return /[.!?…]$/.test(short) ? short : `${short}.`;
}

/** The outcome toast: “Backup of web finished.”, “… finished with 2 warnings.”, “Clone of web failed: <reason>” */
export function taskOutcomeText(
  what: string,
  result: 'ok' | 'warning' | 'error',
  message?: string | null,
): string {
  if (result === 'ok') return `${what} finished.`;
  if (result === 'warning') {
    const n = taskWarnings(message);
    return n ? `${what} finished with ${plural(n, 'warning')}.` : `${what} finished with warnings.`;
  }
  const m = (message ?? '').trim();
  return m && m !== 'OK' ? `${what} failed: ${reason(m)}` : `${what} failed.`;
}

/* Proxmox hints for one guest (PX-07) ----------------------------------------------------------------- */

/** Thresholds of the hub's guest hints (`internal/hub/model/hints.go`). */
export const BACKUP_OLD_DAYS = 8;
export const SNAPSHOT_OLD_DAYS = 30;

/** What fixes a hint: add it to a backup job, back it up, restart it, its Snapshots tab, its guest agent row. */
export type GuestHintFix = 'backup_job' | 'backup_now' | 'restart' | 'snapshots' | 'agent';

export interface GuestHintView {
  kind: string;
  tone: HostTone;
  title: string;
  detail: string;
  fix: GuestHintFix;
  /** The fix's button. */
  action: string;
}

const DAY_MS = 86_400_000;
const days = (ms: number) => Math.max(1, Math.floor(ms / DAY_MS));

/**
 * The hub's Proxmox guest hints for one guest, worked out from the guest itself (the hub lists them per server):
 * no backup job, the last backup old or failed, changes waiting for a restart, an old snapshot, the guest agent down.
 */
export function guestHints(g: HostGuest, now: number): GuestHintView[] {
  if (g.platform !== 'pve') return [];
  const out: GuestHintView[] = [];
  if (g.backupJob === false)
    out.push({
      kind: 'guest.no_backup_job',
      tone: 'warn',
      title: `No backup plan covers ${g.name}`,
      detail: 'Proxmox doesn’t back it up on a schedule, so a broken disk loses it.',
      fix: 'backup_job',
      action: 'Add to a backup plan',
    });
  else if (g.backupJob && g.lastBackup) {
    const age = now - Date.parse(g.lastBackup.at);
    if (g.lastBackup.result === 'error')
      out.push({
        kind: 'guest.backup_old',
        tone: 'warn',
        title: 'Its last backup failed',
        detail: `The backup plan tried ${days(age) === 1 ? 'a day' : `${days(age)} days`} ago. The task log says why.`,
        fix: 'backup_now',
        action: 'Back up now',
      });
    else if (age > BACKUP_OLD_DAYS * DAY_MS)
      out.push({
        kind: 'guest.backup_old',
        tone: 'warn',
        title: `Last backup ${days(age)} days ago`,
        detail: 'Its backup plan covers it but hasn’t backed it up for over a week.',
        fix: 'backup_now',
        action: 'Back up now',
      });
  }
  if (g.pendingChanges && g.pendingChanges > 0)
    out.push({
      kind: 'guest.pending_changes',
      tone: 'mut',
      title:
        g.pendingChanges === 1
          ? 'A change waits for a restart'
          : `${g.pendingChanges} changes wait for a restart`,
      detail: 'They apply when it next starts.',
      fix: 'restart',
      action: 'Restart to apply',
    });
  if (g.oldestSnapshot) {
    const age = now - Date.parse(g.oldestSnapshot);
    if (age > SNAPSHOT_OLD_DAYS * DAY_MS)
      out.push({
        kind: 'guest.snapshot_old',
        tone: 'mut',
        title: `A snapshot is ${days(age)} days old`,
        detail: 'Old snapshots keep growing and slow the disk down. Remove the ones you don’t need.',
        fix: 'snapshots',
        action: 'Open Snapshots',
      });
  }
  if (g.kind === 'vm' && g.guestAgent === 'not_running' && (g.state === 'running' || g.state === 'unhealthy'))
    out.push({
      kind: 'guest.agent_down',
      tone: 'mut',
      title: 'It doesn’t report what’s inside',
      detail: `Proxmox’s helper isn’t running inside ${g.name}, so Proxmox can’t see its addresses or shut it down cleanly.`,
      fix: 'agent',
      action: 'What to do',
    });
  return out;
}

/* Firewall ------------------------------------------------------------------------------------------ */

export type FirewallRule = HostFirewall['rules'][number];

/** Proxmox's defaults for the options a guest hasn't set. */
export const FIREWALL_DEFAULTS: Record<string, string> = {
  enable: '0',
  dhcp: '1',
  ndp: '1',
  radv: '0',
  macfilter: '1',
  ipfilter: '0',
  policy_in: 'DROP',
  policy_out: 'ACCEPT',
  log_level_in: 'nolog',
  log_level_out: 'nolog',
};

export const FIREWALL_POLICIES = ['ACCEPT', 'DROP', 'REJECT'] as const;
export const FIREWALL_LOG_LEVELS = [
  'nolog',
  'emerg',
  'alert',
  'crit',
  'err',
  'warning',
  'notice',
  'info',
  'debug',
] as const;
export const FIREWALL_MACROS = [
  'SSH',
  'HTTP',
  'HTTPS',
  'Web',
  'DNS',
  'Ping',
  'NTP',
  'SMTP',
  'SMTPS',
  'IMAPS',
  'SMB',
  'NFS',
  'RDP',
  'VNC',
  'MySQL',
  'PostgreSQL',
  'Ceph',
  'DHCPfwd',
] as const;
export const FIREWALL_PROTOCOLS = ['tcp', 'udp', 'icmp', 'icmpv6', 'esp', 'gre', 'sctp'] as const;

/** An option as set, else Proxmox's default. */
export function firewallOption(fw: Pick<HostFirewall, 'options'>, key: string): string {
  return fw.options[key] ?? FIREWALL_DEFAULTS[key] ?? '';
}

/** “Allow”, “Drop”, “Refuse”; a security group's name as it is. */
export function firewallActionWord(action: string): string {
  return action === 'ACCEPT' ? 'Allow' : action === 'DROP' ? 'Drop' : action === 'REJECT' ? 'Refuse' : action;
}

/** What a rule matches in a line: “SSH from 10.100.0.0/16”, “tcp port 443”, “the rules of webservers”. */
export function ruleSummary(r: Omit<FirewallRule, 'pos'>): string {
  if (r.type === 'group') return `the rules of ${r.action}`;
  const parts: string[] = [r.macro || r.proto || 'anything'];
  if (r.dport) parts.push(`port ${r.dport}`);
  if (r.sport) parts.push(`from port ${r.sport}`);
  if (r.source) parts.push(`from ${r.source}`);
  if (r.dest) parts.push(`to ${r.dest}`);
  if (r.iface) parts.push(`on ${r.iface}`);
  return parts.join(' ');
}

/* Replication --------------------------------------------------------------------------------------- */

/** “*\/15” → “every 15 min”, “02:00” → “daily at 02:00”; other calendar events read as themselves. */
export function replicationScheduleText(s: string | undefined): string {
  const v = (s ?? '*/15').trim();
  const m = /^\*\/(\d+)$/.exec(v);
  if (m) return `every ${m[1]} min`;
  if (/^\d{1,2}:\d{2}$/.test(v)) return `daily at ${v}`;
  return v;
}

/* Backup jobs (PX-03) ------------------------------------------------------------------------------- */

/** The schedules the job dialog offers before “Custom” (Proxmox calendar events). */
export const BACKUP_SCHEDULE_PRESETS: readonly { value: string; label: string }[] = [
  { value: '02:00', label: 'Every day at 02:00' },
  { value: '21:00', label: 'Every day at 21:00' },
  { value: 'mon..fri 22:00', label: 'Weekdays at 22:00' },
  { value: 'sat 02:00', label: 'Saturdays at 02:00' },
  { value: 'sun 03:00', label: 'Sundays at 03:00' },
];

const WEEKDAYS: Record<string, string> = {
  mon: 'Mondays',
  tue: 'Tuesdays',
  wed: 'Wednesdays',
  thu: 'Thursdays',
  fri: 'Fridays',
  sat: 'Saturdays',
  sun: 'Sundays',
  'mon..fri': 'Weekdays',
  'sat,sun': 'Weekends',
  'sat..sun': 'Weekends',
};

/** “02:00” → “Every day at 02:00”, “sun 03:00” → “Sundays at 03:00”; other calendar events read as themselves. */
export function backupScheduleText(schedule: string): string {
  const s = schedule.trim();
  const preset = BACKUP_SCHEDULE_PRESETS.find((p) => p.value === s);
  if (preset) return preset.label;
  if (s === 'daily') return 'Every day at 00:00';
  if (s === 'weekly') return 'Mondays at 00:00';
  if (s === 'hourly') return 'Every hour';
  const time = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (time) return `Every day at ${time[1]?.padStart(2, '0')}:${time[2]}`;
  const day = /^([a-z.,]+)\s+(\d{1,2}):(\d{2})$/.exec(s);
  const days = day ? WEEKDAYS[day[1] ?? ''] : undefined;
  if (day && days) return `${days} at ${day[2]?.padStart(2, '0')}:${day[3]}`;
  return s;
}

/** What a job is called in a line and its toasts: its comment, else its schedule and storage. */
export function backupJobName(job: Pick<HostBackupJob, 'comment' | 'schedule' | 'storage'>): string {
  return job.comment?.trim() || `${backupScheduleText(job.schedule)} to ${job.storage}`;
}

/** Which guests a job backs up: “All guests”, “All guests but win11-test”, “web, db and 3 more”, “Pool prod”. */
export function backupJobCovers(
  job: Pick<HostBackupJob, 'selection' | 'guests' | 'exclude' | 'pool' | 'node'>,
  nameOf: (guestId: string) => string = (id) => id,
): string {
  const names = (ids: readonly string[] | undefined) => {
    const list = (ids ?? []).map(nameOf);
    return list.length <= 3 ? list.join(', ') : `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`;
  };
  const what =
    job.selection === 'pool'
      ? `Pool ${job.pool ?? ''}`.trim()
      : job.selection === 'guests'
        ? names(job.guests) || 'No guests'
        : job.exclude?.length
          ? `All guests but ${names(job.exclude)}`
          : 'All guests';
  return job.node ? `${what} on ${job.node}` : what;
}

/** “Last 7 · 14 daily · 8 weekly · 6 monthly”; null: the storage's own retention; every count 0: all of them. */
export function backupKeepText(keep: HostBackupJob['keep']): string {
  if (!keep) return 'The storage decides';
  const parts: string[] = [];
  if (keep.last) parts.push(`last ${keep.last}`);
  for (const k of ['hourly', 'daily', 'weekly', 'monthly', 'yearly'] as const)
    if (keep[k]) parts.push(`${keep[k]} ${k}`);
  const text = parts.join(' · ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Keep every backup';
}

/** Whether a job backs up a guest (`node`: the guest's, for jobs bound to one node). */
export function backupJobIncludes(
  job: Pick<HostBackupJob, 'selection' | 'guests' | 'exclude' | 'node' | 'enabled'>,
  guestId: string,
  node?: string,
): boolean {
  if (job.node && node && job.node !== node) return false;
  if (job.selection === 'all') return !(job.exclude ?? []).includes(guestId);
  if (job.selection === 'guests') return (job.guests ?? []).includes(guestId);
  return false;
}

/**
 * The change that puts a guest in a job: a job of chosen guests gets it added, a job of all guests leaves it out of
 * its exclude list; null when that can't be done here (a pool's job: the pool is Proxmox's; another node's job).
 */
export function addToBackupJobParams(
  job: Pick<HostBackupJob, 'id' | 'selection' | 'guests' | 'exclude' | 'node'>,
  guestId: string,
  node?: string,
): { jobId: string; guests?: string[]; exclude?: string[] } | null {
  if (job.node && node && job.node !== node) return null;
  if (job.selection === 'guests')
    return { jobId: job.id, guests: [...new Set([...(job.guests ?? []), guestId])] };
  if (job.selection === 'all')
    return { jobId: job.id, exclude: (job.exclude ?? []).filter((g) => g !== guestId) };
  return null;
}
