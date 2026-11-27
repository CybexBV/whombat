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
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_GUEST_WORDS } from '../i18n/messages/connectionsHosts/guestMobile';
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
} from './format';
import { iuFollowWords, iuTaskWord } from './incus-mobile';
import {
  type GuestKindView,
  guestKind,
  guestStateTone,
  guestStateWords,
  guestTabs,
  guestTabWords,
  manageablePlatform,
} from './model';
import type { HostTone } from './thresholds';
import { updatesWords } from './updates';

const words = (locale?: string | null) => clientTree(locale, HOSTS_GUEST_WORDS);

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

/** The phone's guest tabs' names, in a locale (English when none is given). */
export function phoneGuestTabWords(locale?: string | null): Record<PhoneGuestTab, string> {
  const web = guestTabWords(locale);
  return {
    summary: web.summary,
    settings: words(locale).tabs.settings,
    snapshots: web.snapshots,
    backups: web.backups,
    tasks: web.tasks,
  };
}

export const PHONE_GUEST_TAB_WORDS: Record<PhoneGuestTab, string> = phoneGuestTabWords('en');

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
  locale?: string | null,
): string | null {
  if (g.manageable || !manageablePlatform(g)) return null;
  return g.remoteControl.manageReason?.trim() || interpolate(words(locale).manageOff, { server: serverName });
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

export const GUEST_STATE_SPOKEN: Record<HostGuest['state'], string> = guestStateWords('en');

export function guestHead(
  g: Pick<HostGuest, 'name' | 'state' | 'platform' | 'kind' | 'vmid' | 'node' | 'serverId' | 'tags'>,
  locale?: string | null,
): GuestHeadView {
  const stateText = guestStateWords(locale)[g.state];
  const kind = guestKind(g, locale);
  const line = g.node ?? g.serverId;
  const tags = g.tags ?? [];
  return {
    name: g.name,
    kind,
    stateText,
    tone: guestStateTone(g.state),
    line,
    tags,
    label: [
      g.name,
      kind.label,
      stateText,
      line,
      tags.length ? interpolate(words(locale).head.tags, { tags: tags.join(', ') }) : null,
    ]
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
export function guestTiles(g: HostGuest, locale?: string | null): GuestTile[] {
  const w = words(locale).tiles;
  const on = isRunning(g);
  return [
    {
      key: 'cpu',
      label: w.cpu,
      value: on ? formatPct1(g.cpuPct) : DASH,
      note: g.vcpu ? w.cores(g.vcpu) : DASH,
    },
    {
      key: 'memory',
      label: w.memory,
      value: on ? formatMemPair(g.memoryUsedMb, g.memoryLimitMb) : DASH,
      note:
        on && g.memoryUsedMb != null && g.memoryLimitMb
          ? interpolate(w.used, { pct: formatPct((g.memoryUsedMb / g.memoryLimitMb) * 100) })
          : g.memoryLimitMb
            ? interpolate(w.given, { size: mibText(g.memoryLimitMb) })
            : DASH,
    },
    {
      key: 'network',
      label: w.network,
      value: on ? formatNetRate((g.netRxMbps ?? 0) + (g.netTxMbps ?? 0)) : DASH,
      note: on ? w.inOut : DASH,
    },
    {
      key: 'up',
      label: w.up,
      value: on && g.uptimeS != null ? formatDuration(g.uptimeS, locale) : DASH,
      note: on ? w.sinceStart : (g.lastExit ?? w.off),
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
  locale?: string | null,
): GuestBackupLine {
  const w = words(locale).backupLine;
  const lb = g.lastBackup;
  const ok = lb?.result === 'ok';
  return {
    last: lb
      ? `${formatRelativeDay(Date.parse(lb.at), now, timeZone, locale)} · ${ok ? w.fine : lb.result === 'error' ? w.failed : lb.result}`
      : w.none,
    lastTone: !lb ? 'mut' : ok ? 'ok' : 'bad',
    job: g.backupJob == null ? null : g.backupJob ? w.inPlan : w.noPlan,
    inJob: g.backupJob ?? null,
  };
}

/** A guest's facts on its Summary: addresses, image, the node, the guest agent, snapshots, HA. */
export function guestSummaryFacts(
  g: HostGuest,
  serverName: string,
  locale?: string | null,
): { label: string; value: string }[] {
  const w = words(locale).facts;
  const out: { label: string; value: string }[] = [];
  out.push({ label: w.addresses, value: g.addresses?.join(', ') || DASH });
  if (g.image) out.push({ label: w.image, value: g.image });
  out.push({ label: w.runsOn, value: g.node ?? serverName });
  if (g.kind === 'vm' && g.platform === 'pve')
    out.push({
      label: w.guestAgent,
      value: g.guestAgent === 'running' ? w.running : g.guestAgent === 'not_running' ? w.notRunning : w.off,
    });
  if (g.snapshots != null) out.push({ label: w.snapshots, value: String(g.snapshots) });
  if (g.haState) out.push({ label: w.ha, value: g.haState });
  return out;
}

/** What a guest's change waits for: `key`, its value now and after the restart (or “removed”). */
export interface PendingLine {
  key: string;
  label: string;
  now: string;
  after: string;
}

export function pendingLines(cfg: HostGuestConfig | undefined, locale?: string | null): PendingLine[] {
  if (!cfg) return [];
  return pendingKeys(cfg).map((k) => ({
    key: k,
    label: keyLabel(k, cfg.kind, locale),
    now: valueText(k, cfg.values[k], locale),
    after: k in (cfg.pending ?? {}) ? valueText(k, cfg.pending?.[k], locale) : words(locale).removed,
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
  locale?: string | null,
): GuestHintRow[] {
  if (g.platform !== 'pve') return [];
  const w = words(locale).hints;
  const out: GuestHintRow[] = [];
  if (g.backupJob === false)
    out.push({
      id: 'no_backup_job',
      tone: 'info',
      title: w.noPlanTitle,
      detail: w.noPlanDetail,
      action: opts.jobs ? { label: w.addToPlan, to: 'add_to_job' } : { label: w.backUpNow, to: 'back_up' },
    });
  else if (g.backupJob) {
    const lb = g.lastBackup;
    const failed = lb?.result === 'error';
    const days = lb ? daysSince(lb.at, now) : null;
    if (failed || (days != null && days >= BACKUP_OLD_DAYS))
      out.push({
        id: 'backup_old',
        tone: 'warn',
        title: w.oldTitle,
        detail: failed ? w.lastFailed : w.lastOld(days ?? 0),
        action: { label: w.backUpNow, to: 'back_up' },
      });
  }
  const pending = opts.pending ?? g.pendingChanges ?? 0;
  if (pending > 0)
    out.push({
      id: 'pending_changes',
      tone: 'info',
      title: w.pendingTitle(pending),
      detail: w.pendingDetail,
      action: { label: w.restart, to: 'restart' },
    });
  if (g.oldestSnapshot && daysSince(g.oldestSnapshot, now) >= SNAPSHOT_OLD_DAYS)
    out.push({
      id: 'snapshot_old',
      tone: 'info',
      title: w.snapshotTitle,
      detail: w.snapshotDetail(daysSince(g.oldestSnapshot, now)),
      action: { label: w.snapshots, to: 'snapshots' },
    });
  if (g.kind === 'vm' && g.guestAgent === 'not_running' && isRunning(g))
    out.push({
      id: 'agent_down',
      tone: 'info',
      title: w.agentTitle,
      detail: w.agentDetail,
      action: null,
    });
  return out;
}

/** Where a server's Proxmox hint is fixed on the phone (PX-07): its Backups or its Guests; Storage is the web's. */
export function serverHintWayOut(
  kind: string,
  locale?: string | null,
): { label: string; to: 'backups' | 'guests' } | null {
  const w = words(locale).hints;
  switch (kind) {
    case 'guest.no_backup_job':
      return { label: w.backups, to: 'backups' };
    case 'guest.backup_old':
    case 'guest.pending_changes':
    case 'guest.snapshot_old':
    case 'guest.agent_down':
      return { label: w.guests, to: 'guests' };
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

type KeyWord = keyof ReturnType<typeof words>['keys'];
const KEY_WORDS: Record<string, KeyWord> = {
  name: 'name',
  hostname: 'name',
  memory: 'memory',
  balloon: 'balloon',
  swap: 'swap',
  cores: 'cores',
  sockets: 'sockets',
  cpu: 'cpu',
  cpulimit: 'cpulimit',
  onboot: 'onboot',
  protection: 'protection',
  description: 'description',
  tags: 'tags',
  agent: 'agent',
  rootfs: 'rootfs',
};

/** A config key in words (“Memory”, “scsi0”). */
export function keyLabel(key: string, _kind: 'vm' | 'container' = 'vm', locale?: string | null): string {
  const word = KEY_WORDS[key];
  return word ? words(locale).keys[word] : key;
}

/** A config value as the phone shows it: memory in MiB/GiB, flags Yes/No, tags with spaces, secrets “(set)”. */
export function valueText(key: string, v: string | undefined, locale?: string | null): string {
  const w = words(locale).values;
  if (key === 'memory' || key === 'balloon' || key === 'swap')
    return v === undefined || v === '' ? w.none : /^\d+$/.test(v) ? mibText(Number(v)) : v;
  if (key === 'onboot') return isOn(v) ? w.yes : w.no;
  if (key === 'protection') return isOn(v) ? w.protected : w.off;
  if (key === 'tags') return parseTags(v).join(' ') || w.none;
  return shownValue(key, v);
}

/**
 * A Proxmox guest's configuration in the phone's five groups (PX-06): processors, memory, disks, network and
 * options, read as they are (a change waiting for a restart after an arrow), with the everyday edits marked and the
 * keys Proxmox keeps to itself locked.
 */
export function guestSettingGroups(
  cfg: HostGuestConfig,
  fallbackName: string,
  locale?: string | null,
): SettingGroup[] {
  const all = words(locale);
  const w = all.settings;
  const keys = all.keys;
  const vm = cfg.kind === 'vm';
  const v = (k: string) => currentValue(cfg, k);
  const restricted = new Set(cfg.restricted ?? []);
  const later = (k: string) =>
    cfg.pending && k in cfg.pending
      ? interpolate(w.later, { value: valueText(k, cfg.pending[k], locale) })
      : '';
  const editable = (k: string, edit: GuestEditKind): Pick<SettingRow, 'edit' | 'locked'> =>
    restricted.has(k) ? { locked: true } : { edit };

  const processors: SettingRow[] = [
    {
      id: 'cores',
      label: keys.cores,
      value: `${cfg.values.cores ?? '1'}${later('cores')}`,
      ...editable('cores', 'cores'),
    },
  ];
  if (vm) {
    if (Number(v('sockets') ?? 1) > 1)
      processors.push({ id: 'sockets', label: keys.sockets, value: v('sockets') ?? '1' });
    processors.push({ id: 'cpu', label: keys.cpu, value: v('cpu') ?? 'kvm64', mono: true });
  } else
    processors.push({
      id: 'cpulimit',
      label: keys.cpulimit,
      value: v('cpulimit') ? (v('cpulimit') ?? '') : w.noLimit,
    });

  const memory: SettingRow[] = [
    {
      id: 'memory',
      label: keys.memory,
      value: `${valueText('memory', cfg.values.memory ?? '0', locale)}${later('memory')}`,
      ...editable('memory', 'memory'),
    },
    vm
      ? {
          id: 'balloon',
          label: keys.balloon,
          value: v('balloon') && v('balloon') !== '0' ? valueText('balloon', v('balloon'), locale) : w.fixed,
        }
      : { id: 'swap', label: keys.swap, value: valueText('swap', v('swap') ?? '0', locale) },
  ];

  const disks: SettingRow[] = (vm ? keysOf(cfg, DISK_RE) : keysOf(cfg, CT_DISK_RE)).map((k) => {
    const val = v(k);
    if (isCdrom(val))
      return {
        id: k,
        label: interpolate(w.cdDrive, { key: k }),
        value: /cloudinit/.test(val ?? '')
          ? w.cloudInit
          : diskFile(val) === 'none'
            ? w.empty
            : (diskFile(val).split('/').pop() ?? ''),
        mono: true,
      };
    const size = diskSize(val);
    return {
      id: k,
      label: keyLabel(k, 'vm', locale),
      value: size != null ? formatBytesBinary(size) : (val ?? ''),
      sub: diskFile(val),
      mono: true,
      ...(restricted.has(k) ? { locked: true } : { grow: k }),
    };
  });
  for (const d of cfg.disks ?? [])
    if (d.unused)
      disks.push({
        id: d.key,
        label: interpolate(w.unused, { key: d.key }),
        value: d.volume ?? '',
        mono: true,
      });

  const network: SettingRow[] = keysOf(cfg, NET_RE).map((k) => {
    const items = parseProps(v(k) ?? '');
    const m = nicModel(v(k));
    return {
      id: k,
      label: k,
      value: `${getProp(items, 'bridge') ?? DASH}${getProp(items, 'tag') ? interpolate(w.vlan, { tag: getProp(items, 'tag') ?? '' }) : ''}`,
      sub: [
        vm ? m.model : getProp(items, 'name'),
        m.mac,
        getProp(items, 'ip'),
        getProp(items, 'firewall') === '1' ? w.firewallOn : null,
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
      label: keys.name,
      value: v(nameKey) ?? fallbackName,
      mono: true,
      ...editable(nameKey, 'name'),
    },
    {
      id: 'onboot',
      label: keys.onboot,
      value: isOn(v('onboot')) ? all.values.yes : all.values.no,
      ...(getProp(startup, 'order')
        ? { sub: interpolate(w.inTurn, { order: getProp(startup, 'order') ?? '' }) }
        : {}),
      ...editable('onboot', 'onboot'),
    },
    {
      id: 'protection',
      label: keys.protection,
      value: valueText('protection', v('protection'), locale),
      ...editable('protection', 'protection'),
    },
    {
      id: 'tags',
      label: keys.tags,
      value: parseTags(v('tags')).join(' ') || w.none,
      ...editable('tags', 'tags'),
    },
    {
      id: 'description',
      label: keys.description,
      value: v('description')?.trim() || w.none,
      ...editable('description', 'description'),
    },
  ];
  if (vm) {
    options.push({
      id: 'agent',
      label: keys.agent,
      value: isOn(getProp(parseProps(v('agent') ?? ''), 'enabled') ?? v('agent'))
        ? all.values.on
        : all.values.off,
    });
    if (v('bios') || v('machine'))
      options.push({
        id: 'firmware',
        label: w.firmware,
        value: v('bios') === 'ovmf' ? 'UEFI' : 'BIOS',
        sub: interpolate(w.machine, { machine: v('machine') ?? 'i440fx' }),
      });
  }
  if (v('ostype')) options.push({ id: 'ostype', label: w.system, value: v('ostype') ?? '', mono: true });

  return [
    { id: 'processors', title: w.processors, rows: processors },
    { id: 'memory', title: keys.memory, rows: memory },
    { id: 'disks', title: w.disks, rows: disks },
    {
      id: 'network',
      title: w.network,
      rows: network.length ? network : [{ id: 'none', label: w.noNic, value: '' }],
    },
    { id: 'options', title: w.options, rows: options },
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

export function editSpec(kind: GuestEditKind, name: string, locale?: string | null): EditSpec {
  const { edit: w, keys } = words(locale);
  const title = (t: string) => interpolate(t, { name });
  switch (kind) {
    case 'name':
      return { title: title(w.nameTitle), field: keys.name, kind: 'text' };
    case 'memory':
      return { title: title(w.memoryTitle), field: w.memoryField, kind: 'number', hint: w.memoryHint };
    case 'cores':
      return { title: title(w.coresTitle), field: keys.cores, kind: 'number' };
    case 'onboot':
      return { title: title(w.onbootTitle), field: w.onbootField, kind: 'switch' };
    case 'protection':
      return { title: title(w.protectionTitle), field: w.protectionField, kind: 'switch' };
    case 'description':
      return { title: title(w.notesTitle), field: keys.description, kind: 'multiline' };
    case 'tags':
      return { title: title(w.tagsTitle), field: keys.tags, kind: 'text', hint: w.tagsHint };
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
  locale?: string | null,
): { draft: ConfigDraft | null; error: string | null } {
  const w = words(locale).edit;
  const key = editKey(cfg, kind);
  const text = input.text.trim();
  const trimmed = (d: ConfigDraft) => ({ draft: trimDraft(cfg, d), error: null });
  switch (kind) {
    case 'name':
      if (!text) return { draft: null, error: w.fillIn };
      if (!NAME_OK.test(text)) return { draft: null, error: w.nameChars };
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
export function reviewLines(cfg: HostGuestConfig, draft: ConfigDraft, locale?: string | null): ReviewLine[] {
  const w = words(locale);
  return reviewRows(cfg, draft).map((r) => ({
    key: r.key,
    label: keyLabel(r.key, cfg.kind, locale),
    old: valueText(r.key, r.old, locale),
    new:
      r.op === 'delete'
        ? w.removed
        : SECRET_KEYS.has(r.key)
          ? w.edit.newValue
          : valueText(r.key, r.new, locale),
  }));
}

/** A running Proxmox guest takes some changes at its next restart: the review says so. */
export function reviewRestartNote(cfg: HostGuestConfig, locale?: string | null): string | null {
  return cfg.platform === 'pve' && cfg.running ? words(locale).edit.restartNote : null;
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
export function growDisk(
  cfg: HostGuestConfig,
  key: string,
  addText: string,
  locale?: string | null,
): GrowView {
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
      label: keyLabel(key, 'vm', locale),
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
  locale?: string | null,
): SnapshotRowView[] {
  const w = words(locale).snapshots;
  return items
    .filter((s) => !s.current)
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
    .map((s) => {
      const line = [
        s.created
          ? interpolate(w.taken, { when: formatRelativeDay(Date.parse(s.created), now, timeZone, locale) })
          : null,
        s.memory ? w.withMemory : null,
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
export function snapshotNameError(name: string, locale?: string | null): string | null {
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name) ? null : words(locale).snapshots.nameError;
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
  locale?: string | null,
): BackupRowView[] {
  const w = words(locale).backups;
  return [...items]
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
    .map((b) => {
      const when = b.created ? formatRelativeDay(Date.parse(b.created), now, timeZone, locale) : DASH;
      const who = nameOf?.(b) ?? null;
      const title = who ? `${who} · ${when}` : when;
      const line = [
        formatBytesBinary(b.sizeBytes),
        b.storage,
        b.protected ? w.kept : null,
        b.verified === 'failed' ? w.checkFailed : null,
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
  locale?: string | null,
): BackupRowView[] {
  const byId = new Map(guests.filter((g) => g.vmid != null).map((g) => [String(g.vmid), g.name]));
  const guest = words(locale).backups.guest;
  return backupRows(
    items,
    now,
    timeZone,
    (b) => (b.guest ? (byId.get(b.guest) ?? interpolate(guest, { id: b.guest })) : null),
    locale,
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

export type BackupMode = 'snapshot' | 'suspend' | 'stop';

/** How a backup treats the running guest, in a locale (English when none is given). */
export function backupModes(locale?: string | null): readonly { value: BackupMode; label: string }[] {
  const w = words(locale).backups;
  return [
    { value: 'snapshot', label: w.whileRunning },
    { value: 'suspend', label: w.paused },
    { value: 'stop', label: w.stopped },
  ];
}

export const BACKUP_MODES = backupModes('en');

/* Tasks -------------------------------------------------------------------------------------------- */

type TaskKey = keyof ReturnType<typeof words>['tasks'];
const TASK_WORDS: Record<string, TaskKey> = {
  // A server's own package tasks (server-updates-app.md AP-2884).
  'packages.install': 'packages.install',
  'packages.check': 'packages.check',
  vzdump: 'vzdump',
  qmstart: 'start',
  qmstop: 'stop',
  qmshutdown: 'shutdown',
  qmreboot: 'reboot',
  qmsuspend: 'suspend',
  qmresume: 'resume',
  qmigrate: 'migrate',
  vzstart: 'start',
  vzstop: 'stop',
  vzshutdown: 'shutdown',
  vzreboot: 'reboot',
  vzmigrate: 'migrate',
  qmclone: 'clone',
  vzclone: 'clone',
  qmcreate: 'create',
  vzcreate: 'create',
  qmdestroy: 'destroy',
  vzdestroy: 'destroy',
  qmrestore: 'restore',
  vzrestore: 'restore',
  qmsnapshot: 'snapshot',
  vzsnapshot: 'snapshot',
  qmdelsnapshot: 'delsnapshot',
  vzdelsnapshot: 'delsnapshot',
  qmrollback: 'rollback',
  vzrollback: 'rollback',
  qmconfig: 'config',
  resize: 'resize',
  download: 'download',
};

export function taskWord(type: string, locale?: string | null): string {
  const key = Object.hasOwn(TASK_WORDS, type) ? TASK_WORDS[type] : undefined;
  return key ? words(locale).tasks[key] : (iuTaskWord(type, locale) ?? type);
}

export function taskStatus(
  t: Pick<HostTask, 'status'>,
  locale?: string | null,
): { text: string; tone: HostTone } {
  const w = words(locale).tasks;
  switch (t.status) {
    case 'ok':
      return { text: w.done, tone: 'ok' };
    case 'running':
      return { text: w.running, tone: 'mut' };
    case 'warning':
      return { text: w.warnings, tone: 'warn' };
    default:
      return { text: w.failed, tone: 'bad' };
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

export function taskRows(
  items: readonly HostTask[],
  now: number,
  timeZone?: string,
  locale?: string | null,
): TaskRowView[] {
  const took = words(locale).tasks.took;
  return [...items]
    .sort((a, b) => b.started.localeCompare(a.started))
    .map((t) => {
      const status = taskStatus(t, locale);
      const line = [
        formatRelativeDay(Date.parse(t.started), now, timeZone, locale),
        t.ended
          ? interpolate(took, {
              duration: formatDuration((Date.parse(t.ended) - Date.parse(t.started)) / 1000, locale),
            })
          : null,
        t.user ?? null,
      ]
        .filter(Boolean)
        .join(' · ');
      const title = taskWord(t.type, locale);
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
export function taskSheetLine(t: Pick<HostTask, 'status' | 'message'>, locale?: string | null): string {
  if (t.message) return t.message;
  const w = words(locale).tasks;
  return t.status === 'running' ? w.stillRunning : t.status === 'ok' ? w.doneLine : w.notFinished;
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
type FollowKey = Exclude<keyof ReturnType<typeof words>['follow'], 'withWarnings'>;
const FOLLOW_KEYS: Record<string, FollowKey> = {
  'backup.create': 'backupCreate',
  'backup.restore': 'backupRestore',
  'backup.delete': 'backupDelete',
  'guest.clone': 'clone',
  'guest.delete': 'delete',
  'disk.resize': 'resize',
  'config.set': 'config',
  'backupjob.run': 'backupJob',
  snapshot_create: 'snapshotCreate',
  snapshot_restore: 'snapshotRestore',
  snapshot_delete: 'snapshotDelete',
};

export function followWords(kind: string, name: string, extra?: string, locale?: string | null): FollowWords {
  const s = extra ?? '';
  const key = Object.hasOwn(FOLLOW_KEYS, kind) ? FOLLOW_KEYS[kind] : undefined;
  if (key) {
    const w = words(locale).follow[key];
    const vars = { name, snapshot: s };
    return {
      started: interpolate(w.started, vars),
      done: interpolate(w.done, vars),
      failed: interpolate(w.failed, vars),
    };
  }
  // A server's updates (Whombat server-updates.md SWU-12): `name` is the server's.
  if (kind === 'packages.install' || kind === 'packages.check') {
    const op = kind === 'packages.install' ? 'install' : 'check';
    const u = updatesWords(locale);
    return { started: u.started(op, name), done: u.finished(op, name), failed: u.failed(op, name) };
  }
  return iuFollowWords(kind, name, s, locale) ?? { ...words(locale).follow.other };
}

/** The note when a followed task ended: done, done with warnings, or what went wrong in the service's words. */
export function followEndText(
  w: FollowWords,
  result: 'ok' | 'warning' | 'error',
  message?: string | null,
  locale?: string | null,
): string {
  if (result === 'ok') return w.done;
  if (result === 'warning')
    return interpolate(words(locale).follow.withWarnings, { done: w.done.replace(/\.$/, '') });
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
  locale?: string | null,
): { ok: boolean; reason: string | null } {
  if (g.state !== 'stopped')
    return { ok: false, reason: interpolate(words(locale).lifecycle.shutDownFirst, { name: g.name }) };
  return { ok: typed.trim() === g.name, reason: null };
}

/** A new guest's id: a number from 100, or the next free one when left empty. */
export function newIdCheck(
  text: string,
  next: number | undefined,
  locale?: string | null,
): { id: number | null; error: string | null } {
  const w = words(locale).lifecycle;
  if (!text.trim()) return next ? { id: next, error: null } : { id: null, error: w.fillIn };
  const n = checkNumber(text, { min: 100, max: 999_999_999 });
  return n.error ? { id: null, error: w.from100 } : { id: n.n, error: null };
}

export function cloneNameError(name: string, locale?: string | null): string | null {
  const w = words(locale).lifecycle;
  const v = name.trim();
  if (!v) return w.fillIn;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
    v,
  )
    ? null
    : w.nameChars;
}

/* Backup jobs (PX-03) ------------------------------------------------------------------------------ */

/** A Proxmox backup job as the phone needs it (contracts 0.81 `HostBackupJob`). */
export type BackupJobLike = Pick<
  HostBackupJob,
  'id' | 'enabled' | 'schedule' | 'storage' | 'node' | 'selection' | 'guests' | 'exclude' | 'pool' | 'nextRun'
>;

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Proxmox's calendar events in words: “04:00” → “Every day at 04:00”, “sat 02:00” → “Saturdays at 02:00”. */
export function scheduleWords(schedule: string, locale?: string | null): string {
  const w = words(locale).plans;
  const s = schedule.trim().toLowerCase();
  const at = (h: string | undefined, m: string | undefined) => `${h?.padStart(2, '0')}:${m}`;
  const time = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (time) return interpolate(w.everyDayAt, { time: at(time[1], time[2]) });
  const day = /^(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/.exec(s);
  const weekday = WEEKDAYS.find((d) => d === day?.[1]);
  if (day && weekday) return interpolate(w.dayAt, { day: w.days[weekday], time: at(day[2], day[3]) });
  const work = /^mon\.\.fri\s+(\d{1,2}):(\d{2})$/.exec(s);
  if (work) return interpolate(w.weekdaysAt, { time: at(work[1], work[2]) });
  if (s === 'daily') return interpolate(w.everyDayAt, { time: '00:00' });
  if (s === 'weekly') return interpolate(w.dayAt, { day: w.days.mon, time: '00:00' });
  if (s === 'hourly') return w.everyHour;
  return schedule;
}

/** What a job backs up: “Every guest”, “Every guest but 2”, “web, db and 1 more”, “The pool prod”. */
export function jobCoverage(
  job: BackupJobLike,
  guests: readonly Pick<HostGuest, 'id' | 'name'>[],
  locale?: string | null,
): string {
  const w = words(locale).plans;
  const name = (id: string) => guests.find((g) => g.id === id)?.name ?? id.replace(/^pve:/, '');
  if (job.selection === 'pool') return job.pool ? interpolate(w.pool, { pool: job.pool }) : w.aPool;
  if (job.selection === 'all') {
    const left = job.exclude?.length ?? 0;
    return left
      ? interpolate(w.allBut, { but: left === 1 ? name(job.exclude?.[0] ?? '') : String(left) })
      : w.all;
  }
  const list = (job.guests ?? []).map(name);
  if (!list.length) return w.noGuests;
  if (list.length === 1) return list[0] ?? '';
  if (list.length === 2) return interpolate(w.two, { first: list[0] ?? '', second: list[1] ?? '' });
  return w.more(list.length - 2, { list: list.slice(0, 2).join(', ') });
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
  locale?: string | null,
): BackupJobRowView<J>[] {
  const w = words(locale).plans;
  return [...jobs]
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRun ?? '').localeCompare(b.nextRun ?? ''))
    .map((j) => {
      const title = scheduleWords(j.schedule, locale);
      const line = [
        j.storage,
        jobCoverage(j, guests, locale),
        j.node ? interpolate(w.on, { node: j.node }) : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const next = !j.enabled
        ? w.paused
        : j.nextRun
          ? interpolate(w.next, { when: formatRelativeDay(Date.parse(j.nextRun), now, timeZone, locale) })
          : w.nextUnknown;
      return { id: j.id, enabled: j.enabled, title, line, next, label: `${title}, ${line}, ${next}`, job: j };
    });
}
