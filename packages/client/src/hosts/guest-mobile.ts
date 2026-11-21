/**
 * A guest's screen on the phone and a server's Backups there (app docs/decisions/proxmox-mobile.md AP-1485…; Whombat
 * proxmox.md PX-03, PX-05…PX-07): the phone's five tabs out of the web's eight, the header, the Summary's figures,
 * backup line, waiting changes and hints with their way out, the Settings tab's read-only groups and its everyday
 * edits (each a `ConfigDraft` through the shared review), growing a disk, the snapshot, backup and task rows, the
 * words a followed task says when it starts and when it ends, and the backup jobs' rows. Pure: times and the time
 * zone come in as arguments. The web keeps its own tabs (`guestTabs`); this file only reads the shared rules.
 */
import type {
  HostBackupJob,
  HostBackupVolume,
  HostGuest,
  HostGuestConfig,
  HostGuestDetail,
  HostSeries,
  HostSnapshot,
  HostTask,
} from '@whombat/core/domain';
import {
  type ConfigDraft,
  CT_DISK_RE,
  checkNumber,
  currentValue,
  DISK_RE,
  diskFile,
  diskSize,
  draftOf,
  flagValue,
  formatTags,
  getProp,
  isCdrom,
  isOn,
  keysOf,
  NET_RE,
  nicModel,
  parseProps,
  parseTags,
  pendingKeys,
  reviewRows,
  SECRET_KEYS,
  shownValue,
  tagError,
  trimDraft,
} from './config';
import {
  DASH,
  formatBytesBinary,
  formatDuration,
  formatMemPair,
  formatNetRate,
  formatPct,
  formatPct1,
  formatRelativeDay,
  mibText,
  plural,
} from './format';
import { iuFollowWords, iuTaskWord } from './incus-mobile';
import {
  GUEST_TAB_WORDS,
  type GuestKindView,
  guestKind,
  guestStateTone,
  guestTabs,
  manageablePlatform,
} from './model';
import type { HostTone } from './thresholds';
import { UPDATES_WORDS } from './updates';

// An Incus instance, an Incus server and an Unraid server on the phone (incus-unraid-mobile.md AP-1617…).
export * from './incus-mobile';
export * from './libvirt-mobile';
export * from './unraid-mobile';

const DAY_MS = 86_400_000;
/** The hub's thresholds for a covered guest's backup and a snapshot (hosts `model/hints.go`). */
export const BACKUP_OLD_DAYS = 8;
export const SNAPSHOT_OLD_DAYS = 30;

const isRunning = (g: Pick<HostGuest, 'state'>) => g.state === 'running' || g.state === 'unhealthy';

/* Tabs --------------------------------------------------------------------------------------------- */

export type PhoneGuestTab = 'summary' | 'settings' | 'snapshots' | 'backups' | 'tasks';

export const PHONE_GUEST_TAB_WORDS: Record<PhoneGuestTab, string> = {
  summary: GUEST_TAB_WORDS.summary,
  settings: 'Settings',
  snapshots: GUEST_TAB_WORDS.snapshots,
  backups: GUEST_TAB_WORDS.backups,
  tasks: GUEST_TAB_WORDS.tasks,
};

/**
 * The phone's tabs (PX-06): the web's (`guestTabs`) folded — Hardware and Options are one Settings, Cloud-Init and
 * Firewall stay on the web — and only while Manage is on (`manageable`); without it the Summary says why.
 */
export function phoneGuestTabs(
  g: Pick<HostGuestDetail, 'platform' | 'kind' | 'manageable' | 'remoteControl'>,
): PhoneGuestTab[] {
  if (!g.manageable) return ['summary'];
  const web = new Set(guestTabs(g, g.remoteControl, { manageable: true }));
  const out: PhoneGuestTab[] = ['summary'];
  if (web.has('hardware') || web.has('options')) out.push('settings');
  if (web.has('snapshots')) out.push('snapshots');
  if (web.has('backups')) out.push('backups');
  if (web.has('tasks')) out.push('tasks');
  return out;
}

/** Why a Proxmox or Incus guest can't be changed from here (the server's Manage switch), or null. */
export function manageOffText(
  g: Pick<HostGuestDetail, 'platform' | 'manageable' | 'remoteControl'>,
  serverName: string,
): string | null {
  if (g.manageable || !manageablePlatform(g)) return null;
  return g.remoteControl.manageReason?.trim() || `Changing guests is switched off for ${serverName}.`;
}

/* Header ------------------------------------------------------------------------------------------- */

export interface GuestHeadView {
  name: string;
  /** Its kind as a mark before the name, the words for TalkBack, Proxmox's number muted after it (AP-1755, AP-1810). */
  kind: GuestKindView;
  stateText: string;
  tone: HostTone;
  /** “pve-02”: where it runs; the kind is the mark, not words (less-is-more.md AP-1810). */
  line: string;
  tags: string[];
  /** What TalkBack reads for the header. */
  label: string;
}

export const GUEST_STATE_SPOKEN: Record<HostGuest['state'], string> = {
  running: 'Running',
  stopped: 'Stopped',
  unhealthy: 'Unhealthy',
  paused: 'Paused',
};

export function guestHead(
  g: Pick<HostGuest, 'name' | 'state' | 'platform' | 'kind' | 'vmid' | 'node' | 'serverId' | 'tags'>,
): GuestHeadView {
  const stateText = GUEST_STATE_SPOKEN[g.state];
  const kind = guestKind(g);
  const line = g.node ?? g.serverId;
  const tags = g.tags ?? [];
  return {
    name: g.name,
    kind,
    stateText,
    tone: guestStateTone(g.state),
    line,
    tags,
    label: [g.name, kind.label, stateText, line, tags.length ? `tags ${tags.join(', ')}` : null]
      .filter(Boolean)
      .join(', '),
  };
}

/* Summary ------------------------------------------------------------------------------------------ */

export interface GuestTile {
  key: 'cpu' | 'memory' | 'network' | 'up';
  label: string;
  value: string;
  note: string;
}

/** The Summary's four figures (the web's): CPU, memory, network and up time; a dash while it is off. */
export function guestTiles(g: HostGuest): GuestTile[] {
  const on = isRunning(g);
  return [
    {
      key: 'cpu',
      label: 'CPU',
      value: on ? formatPct1(g.cpuPct) : DASH,
      note: g.vcpu ? plural(g.vcpu, 'core') : DASH,
    },
    {
      key: 'memory',
      label: 'Memory',
      value: on ? formatMemPair(g.memoryUsedMb, g.memoryLimitMb) : DASH,
      note:
        on && g.memoryUsedMb != null && g.memoryLimitMb
          ? `${formatPct((g.memoryUsedMb / g.memoryLimitMb) * 100)} used`
          : g.memoryLimitMb
            ? `${mibText(g.memoryLimitMb)} given`
            : DASH,
    },
    {
      key: 'network',
      label: 'Network',
      value: on ? formatNetRate((g.netRxMbps ?? 0) + (g.netTxMbps ?? 0)) : DASH,
      note: on ? 'in and out' : DASH,
    },
    {
      key: 'up',
      label: 'Up',
      value: on && g.uptimeS != null ? formatDuration(g.uptimeS) : DASH,
      note: on ? 'since its last start' : (g.lastExit ?? 'switched off'),
    },
  ];
}

export interface GuestCharts {
  timestamps: readonly string[];
  cpu: (number | null)[];
  /** Memory used as a share of what it was given (0–100); null without a limit. */
  memPct: (number | null)[];
  cpuMax: number;
  cpuTicks: number[];
}

/** CPU and memory over the range for the Summary's charts (the series `cpu_pct` and `mem_mb`). */
export function guestCharts(
  series: HostSeries | undefined,
  limitMb: number | null | undefined,
): GuestCharts | null {
  if (!series || series.timestamps.length < 2) return null;
  const cpu = (series.series.cpu_pct ?? []).map((v) => (v == null ? null : v));
  const mem = series.series.mem_mb ?? [];
  const memPct = mem.map((v) => (v == null || !limitMb ? null : Math.min(100, (v / limitMb) * 100)));
  const peak = Math.max(0, ...cpu.map((v) => v ?? 0));
  const cpuMax = [10, 20, 25, 50, 75, 100].find((c) => Math.max(10, peak * 1.25) <= c) ?? 100;
  return {
    timestamps: series.timestamps,
    cpu,
    memPct,
    cpuMax,
    cpuTicks: Number.isInteger(cpuMax / 2) ? [0, cpuMax / 2, cpuMax] : [0, cpuMax],
  };
}

export interface GuestBackupLine {
  /** “Today 02:00 · went fine”, “None yet”. */
  last: string;
  lastTone: HostTone;
  /** “In a backup job”, “In no backup job”; null when the server doesn't say. */
  job: string | null;
  inJob: boolean | null;
}

export function guestBackupLine(
  g: Pick<HostGuest, 'lastBackup' | 'backupJob'>,
  now: number,
  timeZone?: string,
): GuestBackupLine {
  const lb = g.lastBackup;
  const ok = lb?.result === 'ok';
  return {
    last: lb
      ? `${formatRelativeDay(Date.parse(lb.at), now, timeZone)} · ${ok ? 'went fine' : lb.result === 'error' ? 'failed' : lb.result}`
      : 'None yet',
    lastTone: !lb ? 'mut' : ok ? 'ok' : 'bad',
    job: g.backupJob == null ? null : g.backupJob ? 'In a backup plan' : 'In no backup plan',
    inJob: g.backupJob ?? null,
  };
}

/** A guest's facts on its Summary: addresses, image, the node, the guest agent, snapshots, HA. */
export function guestSummaryFacts(g: HostGuest, serverName: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  out.push({ label: 'Addresses', value: g.addresses?.join(', ') || DASH });
  if (g.image) out.push({ label: 'Image', value: g.image });
  out.push({ label: 'Runs on', value: g.node ?? serverName });
  if (g.kind === 'vm' && g.platform === 'pve')
    out.push({
      label: 'Guest agent',
      value: g.guestAgent === 'running' ? 'Running' : g.guestAgent === 'not_running' ? 'Not running' : 'Off',
    });
  if (g.snapshots != null) out.push({ label: 'Snapshots', value: String(g.snapshots) });
  if (g.haState) out.push({ label: 'High availability', value: g.haState });
  return out;
}

/** What a guest's change waits for: `key`, its value now and after the restart (or “removed”). */
export interface PendingLine {
  key: string;
  label: string;
  now: string;
  after: string;
}

export function pendingLines(cfg: HostGuestConfig | undefined): PendingLine[] {
  if (!cfg) return [];
  return pendingKeys(cfg).map((k) => ({
    key: k,
    label: keyLabel(k, cfg.kind),
    now: valueText(k, cfg.values[k]),
    after: k in (cfg.pending ?? {}) ? valueText(k, cfg.pending?.[k]) : 'removed',
  }));
}

/* Hints with their way out (PX-07) ----------------------------------------------------------------- */

export type GuestWayOut = 'add_to_job' | 'back_up' | 'restart' | 'snapshots';

export interface GuestHintRow {
  id: string;
  tone: 'warn' | 'info';
  title: string;
  detail: string;
  action: { label: string; to: GuestWayOut } | null;
}

const daysSince = (iso: string, now: number) => Math.floor((now - Date.parse(iso)) / DAY_MS);

/**
 * The Proxmox hints of this one guest, each with its way out: no backup job → Add to a backup job (Back up now
 * while this Whombat has no backup jobs), no recent backup → Back up now, changes waiting → Restart to apply, an old
 * snapshot → Snapshots. A guest agent that doesn't run is said; the fix is inside the guest.
 */
export function guestHints(
  g: HostGuest,
  now: number,
  opts: { jobs?: boolean; pending?: number } = {},
): GuestHintRow[] {
  if (g.platform !== 'pve') return [];
  const out: GuestHintRow[] = [];
  if (g.backupJob === false)
    out.push({
      id: 'no_backup_job',
      tone: 'info',
      title: 'In no backup plan',
      detail: 'Proxmox doesn’t back it up on a schedule.',
      action: opts.jobs
        ? { label: 'Add to a backup plan', to: 'add_to_job' }
        : { label: 'Back up now', to: 'back_up' },
    });
  else if (g.backupJob) {
    const lb = g.lastBackup;
    const failed = lb?.result === 'error';
    const days = lb ? daysSince(lb.at, now) : null;
    if (failed || (days != null && days >= BACKUP_OLD_DAYS))
      out.push({
        id: 'backup_old',
        tone: 'warn',
        title: 'No recent backup',
        detail: failed ? 'The last backup failed.' : `The last one is ${plural(days ?? 0, 'day')} old.`,
        action: { label: 'Back up now', to: 'back_up' },
      });
  }
  const pending = opts.pending ?? g.pendingChanges ?? 0;
  if (pending > 0)
    out.push({
      id: 'pending_changes',
      tone: 'info',
      title: pending === 1 ? '1 change waits for a restart' : `${pending} changes wait for a restart`,
      detail: 'It takes them when it restarts.',
      action: { label: 'Restart to apply', to: 'restart' },
    });
  if (g.oldestSnapshot && daysSince(g.oldestSnapshot, now) >= SNAPSHOT_OLD_DAYS)
    out.push({
      id: 'snapshot_old',
      tone: 'info',
      title: 'An old snapshot',
      detail: `The oldest is ${plural(daysSince(g.oldestSnapshot, now), 'day')} old. Old snapshots take space.`,
      action: { label: 'Snapshots', to: 'snapshots' },
    });
  if (g.kind === 'vm' && g.guestAgent === 'not_running' && isRunning(g))
    out.push({
      id: 'agent_down',
      tone: 'info',
      title: 'It doesn’t report what’s inside',
      detail:
        'Proxmox’s helper isn’t running inside it, so Proxmox can’t shut it down cleanly or see its addresses. Install qemu-guest-agent inside it.',
      action: null,
    });
  return out;
}

/** Where a server's Proxmox hint is fixed on the phone (PX-07): its Backups or its Guests; Storage is the web's. */
export function serverHintWayOut(kind: string): { label: string; to: 'backups' | 'guests' } | null {
  switch (kind) {
    case 'guest.no_backup_job':
      return { label: 'Backups', to: 'backups' };
    case 'guest.backup_old':
    case 'guest.pending_changes':
    case 'guest.snapshot_old':
    case 'guest.agent_down':
      return { label: 'Guests', to: 'guests' };
    default:
      return null;
  }
}

/* Settings (read) ---------------------------------------------------------------------------------- */

export type GuestEditKind = 'name' | 'memory' | 'cores' | 'onboot' | 'protection' | 'description' | 'tags';

export interface SettingRow {
  id: string;
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  /** The everyday edit this row opens. */
  edit?: GuestEditKind;
  /** A disk that can grow (its key). */
  grow?: string;
  /** Proxmox keeps this key to itself for Whombat's token (“Change this in Proxmox”). */
  locked?: boolean;
}

export interface SettingGroup {
  id: 'processors' | 'memory' | 'disks' | 'network' | 'options';
  title: string;
  rows: SettingRow[];
}

const KEY_WORDS: Record<string, string> = {
  name: 'Name',
  hostname: 'Name',
  memory: 'Memory',
  balloon: 'Can shrink to',
  swap: 'Swap',
  cores: 'Cores',
  sockets: 'Sockets',
  cpu: 'Processor type',
  cpulimit: 'CPU limit',
  onboot: 'Start with the server',
  protection: 'Protection',
  description: 'Notes',
  tags: 'Tags',
  agent: 'Guest agent',
};

/** A config key in words (“Memory”, “scsi0”). */
export function keyLabel(key: string, kind: 'vm' | 'container' = 'vm'): string {
  if (key === 'rootfs') return 'Root disk';
  if (kind === 'container' && key === 'cpulimit') return 'CPU limit';
  return KEY_WORDS[key] ?? key;
}

/** A config value as the phone shows it: memory in MiB/GiB, flags Yes/No, tags with spaces, secrets “(set)”. */
export function valueText(key: string, v: string | undefined): string {
  if (key === 'memory' || key === 'balloon' || key === 'swap')
    return v === undefined || v === '' ? '(none)' : /^\d+$/.test(v) ? mibText(Number(v)) : v;
  if (key === 'onboot') return isOn(v) ? 'Yes' : 'No';
  if (key === 'protection') return isOn(v) ? 'Can’t be deleted' : 'Off';
  if (key === 'tags') return parseTags(v).join(' ') || '(none)';
  return shownValue(key, v);
}

/**
 * A Proxmox guest's configuration in the phone's five groups (PX-06): processors, memory, disks, network and
 * options, read as they are (a change waiting for a restart after an arrow), with the everyday edits marked and the
 * keys Proxmox keeps to itself locked.
 */
export function guestSettingGroups(cfg: HostGuestConfig, fallbackName: string): SettingGroup[] {
  const vm = cfg.kind === 'vm';
  const v = (k: string) => currentValue(cfg, k);
  const restricted = new Set(cfg.restricted ?? []);
  const later = (k: string) =>
    cfg.pending && k in cfg.pending ? ` → ${valueText(k, cfg.pending[k])} after a restart` : '';
  const editable = (k: string, edit: GuestEditKind): Pick<SettingRow, 'edit' | 'locked'> =>
    restricted.has(k) ? { locked: true } : { edit };

  const processors: SettingRow[] = [
    {
      id: 'cores',
      label: 'Cores',
      value: `${cfg.values.cores ?? '1'}${later('cores')}`,
      ...editable('cores', 'cores'),
    },
  ];
  if (vm) {
    if (Number(v('sockets') ?? 1) > 1)
      processors.push({ id: 'sockets', label: 'Sockets', value: v('sockets') ?? '1' });
    processors.push({ id: 'cpu', label: 'Processor type', value: v('cpu') ?? 'kvm64', mono: true });
  } else
    processors.push({
      id: 'cpulimit',
      label: 'CPU limit',
      value: v('cpulimit') ? (v('cpulimit') ?? '') : 'No limit',
    });

  const memory: SettingRow[] = [
    {
      id: 'memory',
      label: 'Memory',
      value: `${valueText('memory', cfg.values.memory ?? '0')}${later('memory')}`,
      ...editable('memory', 'memory'),
    },
    vm
      ? {
          id: 'balloon',
          label: 'Can shrink to',
          value: v('balloon') && v('balloon') !== '0' ? valueText('balloon', v('balloon')) : 'Fixed',
        }
      : { id: 'swap', label: 'Swap', value: valueText('swap', v('swap') ?? '0') },
  ];

  const disks: SettingRow[] = (vm ? keysOf(cfg, DISK_RE) : keysOf(cfg, CT_DISK_RE)).map((k) => {
    const val = v(k);
    if (isCdrom(val))
      return {
        id: k,
        label: `CD drive (${k})`,
        value: /cloudinit/.test(val ?? '')
          ? 'Cloud-init settings'
          : diskFile(val) === 'none'
            ? 'Empty'
            : (diskFile(val).split('/').pop() ?? ''),
        mono: true,
      };
    const size = diskSize(val);
    return {
      id: k,
      label: keyLabel(k),
      value: size != null ? formatBytesBinary(size) : (val ?? ''),
      sub: diskFile(val),
      mono: true,
      ...(restricted.has(k) ? { locked: true } : { grow: k }),
    };
  });
  for (const d of cfg.disks ?? [])
    if (d.unused) disks.push({ id: d.key, label: `Unused (${d.key})`, value: d.volume ?? '', mono: true });

  const network: SettingRow[] = keysOf(cfg, NET_RE).map((k) => {
    const items = parseProps(v(k) ?? '');
    const m = nicModel(v(k));
    return {
      id: k,
      label: k,
      value: `${getProp(items, 'bridge') ?? DASH}${getProp(items, 'tag') ? ` · VLAN ${getProp(items, 'tag')}` : ''}`,
      sub: [
        vm ? m.model : getProp(items, 'name'),
        m.mac,
        getProp(items, 'ip'),
        getProp(items, 'firewall') === '1' ? 'firewall on' : null,
      ]
        .filter(Boolean)
        .join(' · '),
      mono: true,
    };
  });

  const nameKey = vm ? 'name' : 'hostname';
  const startup = parseProps(v('startup') ?? '');
  const options: SettingRow[] = [
    {
      id: 'name',
      label: 'Name',
      value: v(nameKey) ?? fallbackName,
      mono: true,
      ...editable(nameKey, 'name'),
    },
    {
      id: 'onboot',
      label: 'Start with the server',
      value: isOn(v('onboot')) ? 'Yes' : 'No',
      ...(getProp(startup, 'order') ? { sub: `In turn ${getProp(startup, 'order')}` } : {}),
      ...editable('onboot', 'onboot'),
    },
    {
      id: 'protection',
      label: 'Protection',
      value: valueText('protection', v('protection')),
      ...editable('protection', 'protection'),
    },
    {
      id: 'tags',
      label: 'Tags',
      value: parseTags(v('tags')).join(' ') || 'None',
      ...editable('tags', 'tags'),
    },
    {
      id: 'description',
      label: 'Notes',
      value: v('description')?.trim() || 'None',
      ...editable('description', 'description'),
    },
  ];
  if (vm) {
    options.push({
      id: 'agent',
      label: 'Guest agent',
      value: isOn(getProp(parseProps(v('agent') ?? ''), 'enabled') ?? v('agent')) ? 'On' : 'Off',
    });
    if (v('bios') || v('machine'))
      options.push({
        id: 'firmware',
        label: 'Firmware',
        value: v('bios') === 'ovmf' ? 'UEFI' : 'BIOS',
        sub: `Machine ${v('machine') ?? 'i440fx'}`,
      });
  }
  if (v('ostype')) options.push({ id: 'ostype', label: 'System', value: v('ostype') ?? '', mono: true });

  return [
    { id: 'processors', title: 'Processors', rows: processors },
    { id: 'memory', title: 'Memory', rows: memory },
    { id: 'disks', title: 'Disks', rows: disks },
    {
      id: 'network',
      title: 'Network',
      rows: network.length ? network : [{ id: 'none', label: 'No network card', value: '' }],
    },
    { id: 'options', title: 'Options', rows: options },
  ];
}

/* Settings (edits) --------------------------------------------------------------------------------- */

export interface EditInput {
  text: string;
  on: boolean;
}

export interface EditSpec {
  /** The sheet's title: “Memory of web”. */
  title: string;
  /** The field's label, or the switch's. */
  field: string;
  kind: 'text' | 'number' | 'multiline' | 'switch';
  hint?: string;
}

const NAME_OK = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

export function editSpec(kind: GuestEditKind, name: string): EditSpec {
  switch (kind) {
    case 'name':
      return { title: `Name of ${name}`, field: 'Name', kind: 'text' };
    case 'memory':
      return {
        title: `Memory of ${name}`,
        field: 'Memory (MiB)',
        kind: 'number',
        hint: '1024 MiB is 1 GiB.',
      };
    case 'cores':
      return { title: `Cores of ${name}`, field: 'Cores', kind: 'number' };
    case 'onboot':
      return {
        title: `Start ${name} with the server`,
        field: 'Start it when the server starts',
        kind: 'switch',
      };
    case 'protection':
      return { title: `Protect ${name}?`, field: 'Protect it from being deleted', kind: 'switch' };
    case 'description':
      return { title: `Notes of ${name}`, field: 'Notes', kind: 'multiline' };
    case 'tags':
      return { title: `Tags of ${name}`, field: 'Tags', kind: 'text', hint: 'Separate them with spaces.' };
  }
}

function editKey(cfg: HostGuestConfig, kind: GuestEditKind): string {
  if (kind === 'name') return cfg.kind === 'vm' ? 'name' : 'hostname';
  return kind;
}

/** The value an edit starts from (the pending one first, as Proxmox's dialogs do). */
export function editStart(cfg: HostGuestConfig, kind: GuestEditKind): EditInput {
  const v = currentValue(cfg, editKey(cfg, kind));
  if (kind === 'onboot' || kind === 'protection') return { text: '', on: isOn(v) };
  if (kind === 'tags') return { text: parseTags(v).join(' '), on: false };
  return { text: v ?? '', on: false };
}

/** The change an edit's fields describe (null with what is wrong), trimmed to what differs. */
export function editDraft(
  cfg: HostGuestConfig,
  kind: GuestEditKind,
  input: EditInput,
): { draft: ConfigDraft | null; error: string | null } {
  const key = editKey(cfg, kind);
  const text = input.text.trim();
  const trimmed = (d: ConfigDraft) => ({ draft: trimDraft(cfg, d), error: null });
  switch (kind) {
    case 'name':
      if (!text) return { draft: null, error: 'Fill this in.' };
      if (!NAME_OK.test(text)) return { draft: null, error: 'Letters, digits, dots and dashes.' };
      return trimmed({ set: { [key]: text } });
    case 'memory': {
      const n = checkNumber(input.text, { min: 16 });
      return n.error ? { draft: null, error: n.error } : trimmed({ set: { memory: String(n.n) } });
    }
    case 'cores': {
      const n = checkNumber(input.text, { min: 1, max: 512 });
      return n.error ? { draft: null, error: n.error } : trimmed({ set: { cores: String(n.n) } });
    }
    case 'onboot':
    case 'protection':
      return trimmed(draftOf({ [key]: flagValue(input.on) }));
    case 'description':
      return trimmed(input.text.trim() ? { set: { description: input.text } } : { delete: ['description'] });
    case 'tags': {
      const tags = parseTags(input.text);
      const bad = tags.map(tagError).find(Boolean);
      if (bad) return { draft: null, error: bad };
      return trimmed(tags.length ? { set: { tags: formatTags(tags) } } : { delete: ['tags'] });
    }
  }
}

export interface ReviewLine {
  key: string;
  label: string;
  old: string;
  new: string;
}

/** The review's lines, “Memory  4 GiB → 8 GiB”, against the configuration as it is now. */
export function reviewLines(cfg: HostGuestConfig, draft: ConfigDraft): ReviewLine[] {
  return reviewRows(cfg, draft).map((r) => ({
    key: r.key,
    label: keyLabel(r.key, cfg.kind),
    old: valueText(r.key, r.old),
    new: r.op === 'delete' ? 'removed' : SECRET_KEYS.has(r.key) ? '(new value)' : valueText(r.key, r.new),
  }));
}

/** A running Proxmox guest takes some changes at its next restart: the review says so. */
export function reviewRestartNote(cfg: HostGuestConfig): string | null {
  return cfg.platform === 'pve' && cfg.running
    ? 'It’s running: what it can’t take live applies at the next restart.'
    : null;
}

/* Growing a disk ----------------------------------------------------------------------------------- */

export interface GrowView {
  error: string | null;
  /** Its size now and after, in bytes. */
  now: number | undefined;
  after: number | undefined;
  line: ReviewLine | null;
  params: { disk: string; size: string } | null;
}

/** Growing `key` by `addText` GB (`disk.resize` with `+NG`): disks only grow. */
export function growDisk(cfg: HostGuestConfig, key: string, addText: string): GrowView {
  const a = checkNumber(addText, { min: 1, max: 65_536 });
  const now = diskSize(currentValue(cfg, key));
  if (a.error || a.n == null) return { error: a.error, now, after: undefined, line: null, params: null };
  const after = now != null ? now + a.n * 1024 ** 3 : undefined;
  return {
    error: null,
    now,
    after,
    line: {
      key,
      label: keyLabel(key),
      old: formatBytesBinary(now),
      new: after != null ? formatBytesBinary(after) : `+${a.n} GiB`,
    },
    params: { disk: key, size: `+${a.n}G` },
  };
}

/* Snapshots ---------------------------------------------------------------------------------------- */

export interface SnapshotRowView {
  name: string;
  /** “Taken Today 02:00 · with memory”. */
  line: string;
  note: string;
  label: string;
}

/** The snapshots to go back to (not “current”), newest first. */
export function snapshotRows(
  items: readonly HostSnapshot[],
  now: number,
  timeZone?: string,
): SnapshotRowView[] {
  return items
    .filter((s) => !s.current)
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
    .map((s) => {
      const line = [
        s.created ? `Taken ${formatRelativeDay(Date.parse(s.created), now, timeZone)}` : null,
        s.memory ? 'with memory' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        name: s.name,
        line,
        note: s.description ?? '',
        label: [s.name, line, s.description].filter(Boolean).join(', '),
      };
    });
}

/** Proxmox's snapshot names: a letter first, then letters, digits, “-” and “_”, at most 40. */
export function snapshotNameError(name: string): string | null {
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name)
    ? null
    : 'Starts with a letter; letters, digits, “-” and “_”.';
}

export function defaultSnapshotName(now: number): string {
  return `before-${new Date(now).toISOString().slice(0, 10)}`;
}

/* Backups ------------------------------------------------------------------------------------------ */

export interface BackupRowView {
  volume: string;
  /** “Today 02:00”. */
  title: string;
  /** “12 GiB · pbs · kept”. */
  line: string;
  notes: string;
  kept: boolean;
  label: string;
  backup: HostBackupVolume;
}

export function backupRows(
  items: readonly HostBackupVolume[],
  now: number,
  timeZone?: string,
  nameOf?: (b: HostBackupVolume) => string | null,
): BackupRowView[] {
  return [...items]
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
    .map((b) => {
      const when = b.created ? formatRelativeDay(Date.parse(b.created), now, timeZone) : DASH;
      const who = nameOf?.(b) ?? null;
      const title = who ? `${who} · ${when}` : when;
      const line = [
        formatBytesBinary(b.sizeBytes),
        b.storage,
        b.protected ? 'kept' : null,
        b.verified === 'failed' ? 'check failed' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        volume: b.volume,
        title,
        line,
        notes: b.notes ?? '',
        kept: !!b.protected,
        label: [title, line, b.notes].filter(Boolean).join(', '),
        backup: b,
      };
    });
}

/** The latest backups of a server (its Backups segment), each named by its guest. */
export function latestBackups(
  items: readonly HostBackupVolume[],
  guests: readonly Pick<HostGuest, 'vmid' | 'name'>[],
  now: number,
  timeZone?: string,
  n = 8,
): BackupRowView[] {
  const byId = new Map(guests.filter((g) => g.vmid != null).map((g) => [String(g.vmid), g.name]));
  return backupRows(items, now, timeZone, (b) =>
    b.guest ? (byId.get(b.guest) ?? `Guest ${b.guest}`) : null,
  ).slice(0, n);
}

/** The storages a backup can go to, and the one picked first (PBS before a local disk). */
export function backupStorages(stores: readonly { id: string; type: string }[]): {
  ids: string[];
  first: string;
} {
  const ids = stores.map((s) => s.id);
  return { ids, first: stores.find((s) => s.type === 'pbs')?.id ?? ids[0] ?? '' };
}

export const BACKUP_MODES = [
  { value: 'snapshot', label: 'While it runs' },
  { value: 'suspend', label: 'Paused' },
  { value: 'stop', label: 'Stopped' },
] as const;

export type BackupMode = (typeof BACKUP_MODES)[number]['value'];

/* Tasks -------------------------------------------------------------------------------------------- */

const TASK_WORDS: Record<string, string> = {
  // A server's own package tasks (server-updates-app.md AP-2884).
  'packages.install': 'Install updates',
  'packages.check': 'Update check',
  vzdump: 'Backup',
  qmstart: 'Start',
  qmstop: 'Stop',
  qmshutdown: 'Shut down',
  qmreboot: 'Restart',
  qmsuspend: 'Pause',
  qmresume: 'Resume',
  qmigrate: 'Move',
  vzstart: 'Start',
  vzstop: 'Stop',
  vzshutdown: 'Shut down',
  vzreboot: 'Restart',
  vzmigrate: 'Move',
  qmclone: 'Clone',
  vzclone: 'Clone',
  qmcreate: 'Create',
  vzcreate: 'Create',
  qmdestroy: 'Delete',
  vzdestroy: 'Delete',
  qmrestore: 'Restore',
  vzrestore: 'Restore',
  qmsnapshot: 'Snapshot',
  vzsnapshot: 'Snapshot',
  qmdelsnapshot: 'Remove a snapshot',
  vzdelsnapshot: 'Remove a snapshot',
  qmrollback: 'Back to a snapshot',
  vzrollback: 'Back to a snapshot',
  qmconfig: 'Settings',
  resize: 'Grow a disk',
  download: 'Download',
};

export function taskWord(type: string): string {
  return TASK_WORDS[type] ?? iuTaskWord(type) ?? type;
}

export function taskStatus(t: Pick<HostTask, 'status'>): { text: string; tone: HostTone } {
  switch (t.status) {
    case 'ok':
      return { text: 'Done', tone: 'ok' };
    case 'running':
      return { text: 'Running', tone: 'mut' };
    case 'warning':
      return { text: 'Done, with warnings', tone: 'warn' };
    default:
      return { text: 'Failed', tone: 'bad' };
  }
}

export interface TaskRowView {
  id: string;
  title: string;
  /** “Today 02:00 · took 45 s · whombat@pve”. */
  line: string;
  status: { text: string; tone: HostTone };
  running: boolean;
  label: string;
  task: HostTask;
}

export function taskRows(items: readonly HostTask[], now: number, timeZone?: string): TaskRowView[] {
  return [...items]
    .sort((a, b) => b.started.localeCompare(a.started))
    .map((t) => {
      const status = taskStatus(t);
      const line = [
        formatRelativeDay(Date.parse(t.started), now, timeZone),
        t.ended ? `took ${formatDuration((Date.parse(t.ended) - Date.parse(t.started)) / 1000)}` : null,
        t.user ?? null,
      ]
        .filter(Boolean)
        .join(' · ');
      const title = taskWord(t.type);
      return {
        id: t.id,
        title,
        line,
        status,
        running: t.status === 'running',
        label: `${title}, ${status.text}, ${line}`,
        task: t,
      };
    });
}

/** What a task's sheet says over its log. */
export function taskSheetLine(t: Pick<HostTask, 'status' | 'message'>): string {
  if (t.message) return t.message;
  return t.status === 'running' ? 'Still running.' : t.status === 'ok' ? 'Done.' : 'It didn’t finish.';
}

/* Started and finished (PX-05) --------------------------------------------------------------------- */

export interface FollowWords {
  started: string;
  done: string;
  failed: string;
}

/**
 * What a change that runs as a task says when it starts and when it ends (“The backup of web started.”, “The backup
 * of web is done.”), by its `hosts.manage` op or snapshot action.
 */
export function followWords(kind: string, name: string, extra?: string): FollowWords {
  const s = extra ?? '';
  switch (kind) {
    case 'backup.create':
      return {
        started: `The backup of ${name} started.`,
        done: `The backup of ${name} is done.`,
        failed: `The backup of ${name} didn’t work.`,
      };
    case 'backup.restore':
      return {
        started: `Restoring ${name} started.`,
        done: `${name} is restored.`,
        failed: `Restoring ${name} didn’t work.`,
      };
    case 'backup.delete':
      return {
        started: 'Removing the backup started.',
        done: 'The backup is removed.',
        failed: 'Removing the backup didn’t work.',
      };
    case 'guest.clone':
      return {
        started: `The clone of ${name} started.`,
        done: `The clone of ${name} is ready.`,
        failed: `The clone of ${name} didn’t work.`,
      };
    case 'guest.delete':
      return {
        started: `Deleting ${name} started.`,
        done: `${name} is deleted.`,
        failed: `Deleting ${name} didn’t work.`,
      };
    case 'disk.resize':
      return {
        started: `Growing ${name}’s disk started.`,
        done: `${name}’s disk is bigger now.`,
        failed: `Growing ${name}’s disk didn’t work.`,
      };
    case 'config.set':
      return {
        started: `Saving ${name}’s settings started.`,
        done: `${name}’s settings are saved.`,
        failed: `Saving ${name}’s settings didn’t work.`,
      };
    case 'backupjob.run':
      return {
        started: `The backup plan on ${name} started.`,
        done: `The backup plan on ${name} is done.`,
        failed: `The backup plan on ${name} didn’t work.`,
      };
    case 'snapshot_create':
      return {
        started: `The snapshot of ${name} started.`,
        done: `The snapshot of ${name} is taken.`,
        failed: `The snapshot of ${name} didn’t work.`,
      };
    case 'snapshot_restore':
      return {
        started: `Going back to “${s}” started.`,
        done: `${name} is back at “${s}”.`,
        failed: `Going back to “${s}” didn’t work.`,
      };
    case 'snapshot_delete':
      return {
        started: `Removing “${s}” started.`,
        done: `“${s}” is removed.`,
        failed: `Removing “${s}” didn’t work.`,
      };
    // A server's updates (Whombat server-updates.md SWU-12): `name` is the server's.
    case 'packages.install':
    case 'packages.check': {
      const op = kind === 'packages.install' ? 'install' : 'check';
      return {
        started: UPDATES_WORDS.started(op, name),
        done: UPDATES_WORDS.finished(op, name),
        failed: UPDATES_WORDS.failed(op, name),
      };
    }
    default:
      return (
        iuFollowWords(kind, name, s) ?? {
          started: 'It started.',
          done: 'It’s done.',
          failed: 'It didn’t work.',
        }
      );
  }
}

/** The note when a followed task ended: done, done with warnings, or what went wrong in the service's words. */
export function followEndText(
  w: FollowWords,
  result: 'ok' | 'warning' | 'error',
  message?: string | null,
): string {
  if (result === 'ok') return w.done;
  if (result === 'warning') return `${w.done.replace(/\.$/, '')}, with warnings.`;
  const m = message?.trim();
  if (!m || m.length > 160) return w.failed;
  return `${w.failed} ${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? '' : '.'}`;
}

/** A task's end from its read: null while it runs. */
export function taskResult(t: Pick<HostTask, 'status'> | undefined): 'ok' | 'warning' | 'error' | null {
  if (!t || t.status === 'running') return null;
  return t.status;
}

/* Lifecycle checks --------------------------------------------------------------------------------- */

/** Whether Delete may go: the name typed exactly and the guest switched off. */
export function deleteCheck(
  g: Pick<HostGuest, 'name' | 'state'>,
  typed: string,
): { ok: boolean; reason: string | null } {
  if (g.state !== 'stopped') return { ok: false, reason: `Shut ${g.name} down first.` };
  return { ok: typed.trim() === g.name, reason: null };
}

/** A new guest's id: a number from 100, or the next free one when left empty. */
export function newIdCheck(
  text: string,
  next: number | undefined,
): { id: number | null; error: string | null } {
  if (!text.trim()) return next ? { id: next, error: null } : { id: null, error: 'Fill this in.' };
  const n = checkNumber(text, { min: 100, max: 999_999_999 });
  return n.error ? { id: null, error: 'Use a number from 100.' } : { id: n.n, error: null };
}

export function cloneNameError(name: string): string | null {
  const v = name.trim();
  if (!v) return 'Fill this in.';
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
    v,
  )
    ? null
    : 'Letters, digits, dots and dashes.';
}

/* Backup jobs (PX-03) ------------------------------------------------------------------------------ */

/** A Proxmox backup job as the phone needs it (contracts 0.81 `HostBackupJob`). */
export type BackupJobLike = Pick<
  HostBackupJob,
  'id' | 'enabled' | 'schedule' | 'storage' | 'node' | 'selection' | 'guests' | 'exclude' | 'pool' | 'nextRun'
>;

const WEEKDAYS: Record<string, string> = {
  mon: 'Mondays',
  tue: 'Tuesdays',
  wed: 'Wednesdays',
  thu: 'Thursdays',
  fri: 'Fridays',
  sat: 'Saturdays',
  sun: 'Sundays',
};

/** Proxmox's calendar events in words: “04:00” → “Every day at 04:00”, “sat 02:00” → “Saturdays at 02:00”. */
export function scheduleWords(schedule: string): string {
  const s = schedule.trim().toLowerCase();
  const time = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (time) return `Every day at ${time[1]?.padStart(2, '0')}:${time[2]}`;
  const day = /^(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/.exec(s);
  if (day) return `${WEEKDAYS[day[1] ?? '']} at ${day[2]?.padStart(2, '0')}:${day[3]}`;
  const work = /^mon\.\.fri\s+(\d{1,2}):(\d{2})$/.exec(s);
  if (work) return `Weekdays at ${work[1]?.padStart(2, '0')}:${work[2]}`;
  if (s === 'daily') return 'Every day at 00:00';
  if (s === 'weekly') return 'Mondays at 00:00';
  if (s === 'hourly') return 'Every hour';
  return schedule;
}

/** What a job backs up: “Every guest”, “Every guest but 2”, “web, db and 1 more”, “The pool prod”. */
export function jobCoverage(job: BackupJobLike, guests: readonly Pick<HostGuest, 'id' | 'name'>[]): string {
  const name = (id: string) => guests.find((g) => g.id === id)?.name ?? id.replace(/^pve:/, '');
  if (job.selection === 'pool') return job.pool ? `The pool ${job.pool}` : 'A pool';
  if (job.selection === 'all') {
    const left = job.exclude?.length ?? 0;
    return left ? `Every guest but ${left === 1 ? name(job.exclude?.[0] ?? '') : left}` : 'Every guest';
  }
  const list = (job.guests ?? []).map(name);
  if (!list.length) return 'No guests';
  if (list.length <= 2) return list.join(' and ');
  return `${list.slice(0, 2).join(', ')} and ${plural(list.length - 2, 'more', 'more')}`;
}

/** Whether a job backs up this guest. */
export function jobCovers(job: BackupJobLike, guestId: string): boolean {
  if (job.selection === 'all') return !(job.exclude ?? []).includes(guestId);
  if (job.selection === 'guests') return (job.guests ?? []).includes(guestId);
  return false;
}

/**
 * The `backupjob.update` params that add a guest to a job: onto its list, or off its exclusions; null for a pool's
 * job (Proxmox adds a guest to a pool, not to its job).
 */
export function addToJobParams(job: BackupJobLike, guestId: string): Record<string, unknown> | null {
  if (job.selection === 'guests')
    return { jobId: job.id, guests: [...new Set([...(job.guests ?? []), guestId])] };
  if (job.selection === 'all')
    return { jobId: job.id, exclude: (job.exclude ?? []).filter((x) => x !== guestId) };
  return null;
}

export interface BackupJobRowView<J extends BackupJobLike = BackupJobLike> {
  id: string;
  enabled: boolean;
  /** “Every day at 04:00”. */
  title: string;
  /** “PBS-BlackBox · Every guest but 2”. */
  line: string;
  /** “Next Tomorrow 04:00”, “Paused”. */
  next: string;
  label: string;
  job: J;
}

export function backupJobRows<J extends BackupJobLike>(
  jobs: readonly J[],
  guests: readonly Pick<HostGuest, 'id' | 'name'>[],
  now: number,
  timeZone?: string,
): BackupJobRowView<J>[] {
  return [...jobs]
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRun ?? '').localeCompare(b.nextRun ?? ''))
    .map((j) => {
      const title = scheduleWords(j.schedule);
      const line = [j.storage, jobCoverage(j, guests), j.node ? `on ${j.node}` : null]
        .filter(Boolean)
        .join(' · ');
      const next = !j.enabled
        ? 'Paused'
        : j.nextRun
          ? `Next ${formatRelativeDay(Date.parse(j.nextRun), now, timeZone)}`
          : 'Next run not known';
      return { id: j.id, enabled: j.enabled, title, line, next, label: `${title}, ${line}, ${next}`, job: j };
    });
}
