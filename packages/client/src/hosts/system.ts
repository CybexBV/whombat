/**
 * A server's System tab rules (ported from Rackoon's `ProxmoxActivity`; Whombat proxmox.md PX-04): Proxmox's failed and
 * running tasks of the last 48 hours, and the one command that switches on what the server itself blocks
 * (`whombat-agent allow <switch>`), with the agent updated first when it may be older than the command. Pure.
 */
import type { HostRemoteToggles, HostServerDetail, HostTask } from '@whombat/core/domain';

/* Proxmox activity ----------------------------------------------------------------------------------- */

export const ACTIVITY_WINDOW_MS = 48 * 3600_000;

/** Failed (or warned) tasks that ended in the last 48 hours and tasks still running, newest first. */
export function pveActivity(d: Pick<HostServerDetail, 'health'>, now: number): HostTask[] {
  return (d.health?.tasks ?? [])
    .filter((t) => {
      if (t.status === 'running') return true;
      if (t.status !== 'error' && t.status !== 'warning') return false;
      const at = Date.parse(t.ended ?? t.started);
      return Number.isFinite(at) && now - at <= ACTIVITY_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(b.ended ?? b.started) - Date.parse(a.ended ?? a.started));
}

const TASK_WORDS: Record<string, string> = {
  vzdump: 'Backup',
  qmstart: 'Start',
  qmstop: 'Stop',
  qmshutdown: 'Shutdown',
  qmreboot: 'Restart',
  qmigrate: 'Move',
  qmclone: 'Clone',
  qmcreate: 'Create',
  qmdestroy: 'Delete',
  qmrestore: 'Restore',
  qmsnapshot: 'Snapshot',
  qmrollback: 'Back to a snapshot',
  vzstart: 'Start',
  vzstop: 'Stop',
  vzshutdown: 'Shutdown',
  vzreboot: 'Restart',
  vzmigrate: 'Move',
  vzcreate: 'Create',
  vzdestroy: 'Delete',
  vzrestore: 'Restore',
  vzsnapshot: 'Snapshot',
  vzrollback: 'Back to a snapshot',
  download: 'Download',
  aptupdate: 'Update check',
  imgdel: 'Delete a file',
};

/** “Backup”, “Move”; a type Whombat doesn't know as it is. */
export function taskWord(type: string): string {
  return TASK_WORDS[type] ?? type;
}

/* The agent command (PX-04) --------------------------------------------------------------------------- */

const SWITCH_NAMES: Record<keyof HostRemoteToggles, string> = {
  console: 'console',
  power: 'power',
  hostShell: 'host_shell',
  hostPower: 'host_power',
  manage: 'manage',
  diagnose: 'diagnose',
};

/**
 * The command that switches a blocked switch on on the server itself (no sudo on Unraid, which runs as root; on a
 * Windows PC a PowerShell line, as administrator, since the agent isn't on its PATH).
 */
export function allowCommand(key: keyof HostRemoteToggles, install?: string | null): string {
  if (install === 'windows')
    return `& "$env:ProgramFiles\\Whombat\\whombat-agent.exe" allow ${SWITCH_NAMES[key]}`;
  return `${install === 'unraid' ? '' : 'sudo '}whombat-agent allow ${SWITCH_NAMES[key]}`;
}

/** Versions compared part by part (“0.16.0” < “0.17.0”, “0.9” < “0.10”); null when either can't be read. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const parse = (v: string | null | undefined) => {
    const m = /^v?(\d+(?:\.\d+)*)/.exec((v ?? '').trim());
    return m ? (m[1] as string).split('.').map(Number) : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether the agent has to be updated before `allow` works: `yes` when an update is waiting or it is older than the
 * hosts service, `no` when it is as new, `maybe` when Whombat can't tell (then the screen shows both steps).
 */
export function agentUpdateNeed(a: {
  agentVersion?: string | null;
  serviceVersion?: string | null;
  updateAvailable?: boolean;
}): 'yes' | 'no' | 'maybe' {
  if (a.updateAvailable) return 'yes';
  const c = compareVersions(a.agentVersion, a.serviceVersion);
  return c === null ? 'maybe' : c < 0 ? 'yes' : 'no';
}

/**
 * The install command as an update: the same line without its one-time enrollment (`--token …`, `--enroll …`), which
 * the installer reads as “update the agent in place”, and without the enrollment's control level (`--control full`,
 * since contracts 0.85), which the installer would otherwise write over what the server itself allows
 * (agent-updates-app.md AP-2994). Unraid runs as root, without sudo.
 */
export function updateCommand(installCommand: string, install?: string | null): string {
  const cmd = installCommand
    .trim()
    .replace(/\s+--(token|enroll|control)(=|\s+)\S+/g, '')
    .replace(/\s+-s\s+--\s*$/, '');
  return install === 'unraid' ? cmd.replace(/\|\s*sudo\s+/g, '| ') : cmd;
}

/* The agent's switches, folded (less-is-more.md AP-1767) --------------------------------------------- */

/** “A”, “A and B”, “A, B and C”. */
export function andWords(words: readonly string[]): string {
  if (words.length < 2) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The one line the agent's switches fold behind (AP-1767): what is blocked on the server itself first (that needs the
 * person, so the switches open by themselves), else how many are allowed and, when it is one or two, which are off.
 */
export function agentSwitchesLine(
  switches: readonly { label: string; on: boolean; blocked: boolean }[],
  host: string,
): { text: string; attention: boolean } {
  const blocked = switches.filter((s) => s.blocked).map((s) => s.label);
  if (blocked.length)
    return {
      text: `${andWords(blocked)} ${blocked.length > 1 ? 'are' : 'is'} switched off on ${host} itself`,
      attention: true,
    };
  const off = switches.filter((s) => !s.on).map((s) => s.label);
  const n = switches.length;
  if (!off.length) return { text: `All ${n} allowed`, attention: false };
  if (off.length === n) return { text: 'Nothing allowed: Whombat only watches', attention: false };
  return {
    text: `${n - off.length} of ${n} allowed${off.length <= 2 ? ` · ${andWords(off)} off` : ''}`,
    attention: false,
  };
}
