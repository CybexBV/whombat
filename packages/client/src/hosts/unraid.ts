/**
 * An Unraid server as its page shows it (stream WU, Whombat incus-unraid.md IU-03, IU-05, IU-07, IU-08; app
 * docs/decisions/incus-unraid-wu.md AP-1587…): its tabs, the array with parity and disks the way Unraid's own Main page
 * lists them, pools, shares, plugins, its notifications, Docker the Unraid way (update from the template, autostart,
 * the web page) and libvirt's autostart, the hints with their way out, and the words of every change and its task.
 * Pure, shared by the web and Android; times come in as arguments.
 */
import type {
  HostGuest,
  HostHint,
  HostManageOp,
  HostServerDetail,
  HostUnraidArray,
  HostUnraidDetail,
  HostUnraidDisk,
  HostUnraidNotification,
  HostUnraidParity,
  HostUnraidParityRun,
  HostUnraidPlugin,
  HostUnraidPool,
  HostUnraidShare,
} from '@whombat/core/domain';
import {
  DASH,
  formatAgoIso,
  formatDayTime,
  formatDuration,
  formatGb,
  formatPct,
  formatTemp,
  plural,
} from './format';
import { hintGuests } from './hints';
import { compareVersions } from './system';
import type { HostTone } from './thresholds';

/** The Unraid parts of a server's page (absent on other servers and on older hubs). */
export function unraidDetail(d: Pick<HostServerDetail, 'unraid'>): HostUnraidDetail | null {
  return d.unraid ?? null;
}

/** An Unraid server gets the Unraid page (IU-03): its kind says so, or the hub sent Unraid's parts. */
export function isUnraidServer(d: Pick<HostServerDetail, 'server' | 'unraid'>): boolean {
  return d.server.platform === 'unraid' || !!d.unraid;
}

/* Tabs (AP-1587) ------------------------------------------------------------------------------------------ */

export type UnraidTab = 'summary' | 'array' | 'shares' | 'guests' | 'plugins' | 'sensors' | 'system';

export const UNRAID_TAB_WORDS: Record<UnraidTab, string> = {
  summary: 'Summary',
  array: 'Array',
  shares: 'Shares',
  guests: 'Apps',
  plugins: 'Plugins',
  sensors: 'Sensors',
  system: 'System',
};

/** An Unraid server's tabs: Summary · Array · Shares · Guests · Plugins · Sensors · System. */
export const UNRAID_TABS: readonly UnraidTab[] = [
  'summary',
  'array',
  'shares',
  'guests',
  'plugins',
  'sensors',
  'system',
];

export function parseUnraidTab(v: unknown): UnraidTab {
  return typeof v === 'string' && (UNRAID_TABS as readonly string[]).includes(v)
    ? (v as UnraidTab)
    : 'summary';
}

/* Sizes and words ------------------------------------------------------------------------------------------- */

/** Bytes in Unraid's own decimal units: “2 TB”, “13.6 GB”, “—”. */
export function unraidSize(bytes: number | null | undefined): string {
  return bytes == null || !Number.isFinite(bytes) ? DASH : formatGb(bytes / 1e9);
}

/** Used of a size, in percent (null without a size). */
export function usedPct(used: number | null | undefined, size: number | null | undefined): number | null {
  return used == null || !size ? null : Math.max(0, Math.min(100, (used / size) * 100));
}

/** Unraid's own name for a slot (its `my_disk`): “parity2” → “Parity 2”, “disk1” → “Disk 1”, “apps3” → “Apps 3”. */
export function unraidDiskName(name: string): string {
  const spaced = name.replace(/(\d+)$/, ' $1');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A file system in words: “luks:btrfs” → “btrfs, encrypted”. */
export function fsWords(fs: string | null | undefined): string {
  if (!fs || fs === 'auto' || fs === '-') return DASH;
  const [a, b] = fs.split(':');
  return b && a === 'luks' ? `${b}, encrypted` : fs;
}

/** What a disk's status says (Unraid's ball and its tooltip, in Whombat's words). */
export function unraidDiskStatus(d: Pick<HostUnraidDisk, 'status' | 'statusRaw' | 'device'>): {
  text: string;
  tone: HostTone;
} {
  switch (d.status) {
    case 'ok':
      return { text: 'Normal', tone: 'ok' };
    case 'disabled':
      return { text: d.device ? 'Disabled' : 'Disabled, no disk', tone: 'bad' };
    case 'emulated':
      return { text: 'Emulated', tone: 'bad' };
    case 'missing':
      return { text: 'Missing', tone: 'bad' };
    case 'new':
      return { text: 'New', tone: 'warn' };
    case 'invalid':
      return { text: 'Invalid', tone: 'bad' };
    case 'wrong':
      return { text: 'Wrong disk', tone: 'bad' };
    default:
      return { text: 'Not installed', tone: 'mut' };
  }
}

/** A disk's temperature level as Unraid colours it: hard drives warm from 45 °C, hot from 55; SSDs 60 and 70. */
export function unraidTempTone(d: Pick<HostUnraidDisk, 'tempC' | 'rotational'>): HostTone | null {
  if (d.tempC == null) return null;
  const [warm, hot] = d.rotational === false ? [60, 70] : [45, 55];
  return d.tempC >= hot ? 'bad' : d.tempC >= warm ? 'warn' : null;
}

/** Whether a disk can be spun up or down: an installed hard drive in the array or a pool. */
export function canSpin(d: Pick<HostUnraidDisk, 'slot' | 'device' | 'rotational' | 'status'>): boolean {
  return d.slot !== 'flash' && !!d.device && d.rotational !== false && d.status !== 'empty';
}

/** The spin column: “Spun down”, “Spinning”, “SSD”, or nothing (no disk, the flash drive). */
export function spinWords(
  d: Pick<HostUnraidDisk, 'slot' | 'device' | 'rotational' | 'spunDown' | 'status'>,
): string {
  if (d.slot === 'flash' || !d.device || d.status === 'empty') return '';
  if (d.rotational === false) return 'SSD';
  return d.spunDown ? 'Spun down' : 'Spinning';
}

export interface UnraidDiskRow {
  name: string;
  label: string;
  device: string;
  model: string;
  status: { text: string; tone: HostTone };
  tempText: string;
  tempTone: HostTone | null;
  errors: number;
  fsText: string;
  sizeText: string;
  usedText: string;
  freeText: string;
  usedPct: number | null;
  spin: string;
  canSpin: boolean;
  spunDown: boolean;
}

/** One row of an Array table (Unraid's Main: Device, Identification, Temp., Errors, FS, Size, Used, Free). */
export function unraidDiskRow(d: HostUnraidDisk): UnraidDiskRow {
  const present = !!d.device && d.status !== 'empty';
  return {
    name: d.name,
    label: unraidDiskName(d.name),
    device: d.device ?? '',
    model: d.model ?? (present ? '' : 'Not installed'),
    status: unraidDiskStatus(d),
    tempText: formatTemp(d.tempC),
    tempTone: unraidTempTone(d),
    errors: d.errors,
    fsText: present ? fsWords(d.fsType) : DASH,
    sizeText: present ? unraidSize(d.sizeBytes) : DASH,
    usedText: present ? unraidSize(d.usedBytes) : DASH,
    freeText: present ? unraidSize(d.freeBytes) : DASH,
    usedPct: present ? usedPct(d.usedBytes, (d.usedBytes ?? 0) + (d.freeBytes ?? 0) || null) : null,
    spin: spinWords(d),
    canSpin: canSpin(d),
    spunDown: d.spunDown,
  };
}

/** The array's parity disks and its data disks, as Unraid's Main splits them. */
export function arrayGroups(a: Pick<HostUnraidArray, 'disks'>): {
  parity: HostUnraidDisk[];
  data: HostUnraidDisk[];
} {
  return {
    parity: a.disks.filter((d) => d.slot === 'parity'),
    // Unraid lists every free data slot; Whombat lists the ones with a disk and the ones that lost theirs.
    data: a.disks.filter((d) => d.slot === 'data' && (d.status !== 'empty' || d.device)),
  };
}

/** Every disk of the server that spins (array and pools), for Spin up all / Spin down all. */
export function spinningDisks(u: Pick<HostUnraidDetail, 'array' | 'pools'>): HostUnraidDisk[] {
  return [...u.array.disks, ...u.pools.flatMap((p) => p.disks)].filter(canSpin);
}

/* The array (AP-1589, AP-1590) ----------------------------------------------------------------------------- */

const ARRAY_STATE_WORDS: Record<HostUnraidArray['state'], string> = {
  started: 'Started',
  stopped: 'Stopped',
  starting: 'Starting…',
  stopping: 'Stopping…',
  invalid: 'Can’t start',
};

export interface UnraidArrayView {
  stateText: string;
  tone: HostTone;
  /** “13.6 GB used of 2 TB · 1.94 TB free”. */
  useText: string;
  usedPct: number | null;
  /** Why the array is degraded (“2 disks disabled”), or null. */
  trouble: string | null;
}

export function unraidArrayView(a: HostUnraidArray): UnraidArrayView {
  const trouble = [
    a.disabled ? `${plural(a.disabled, 'disk')} disabled` : null,
    a.missing ? `${plural(a.missing, 'disk')} missing` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // Started reads as started; disabled disks have their own lines (parity, Disks).
  const tone: HostTone =
    a.state === 'invalid' || a.missing > 0
      ? 'bad'
      : a.state === 'stopped'
        ? 'warn'
        : a.state === 'started'
          ? 'ok'
          : 'mut';
  return {
    stateText: ARRAY_STATE_WORDS[a.state],
    tone,
    useText: a.sizeBytes
      ? `${unraidSize(a.usedBytes)} used of ${unraidSize(a.sizeBytes)} · ${unraidSize(a.freeBytes)} free`
      : 'No data disks',
    usedPct: usedPct(a.usedBytes, a.sizeBytes),
    trouble: trouble || null,
  };
}

const PARITY_ACTION_WORDS: Record<NonNullable<HostUnraidParity['action']>, string> = {
  check: 'Parity check',
  correct: 'Parity check with corrections',
  rebuild: 'Rebuilding a disk',
  clear: 'Clearing a disk',
};

/** Whether the array has parity that works: at least one parity disk, none of them disabled or missing. */
export function parityState(a: Pick<HostUnraidArray, 'disks'>): 'none' | 'ok' | 'broken' {
  const ps = a.disks.filter((d) => d.slot === 'parity' && (d.status !== 'empty' || d.device));
  if (!ps.length) return 'none';
  return ps.some((d) => d.status !== 'ok') ? 'broken' : 'ok';
}

export interface ParityView {
  /** “Parity check · 42 %”, “Last checked 3 months ago”, “Parity is disabled”. */
  title: string;
  /** “1 h 10 min left · 182 MB/s · no errors so far”, “No errors”, “Nothing protects the array if a disk fails.” */
  detail: string;
  tone: HostTone;
  running: boolean;
  paused: boolean;
  pct: number | null;
}

function runResult(r: HostUnraidParityRun): string {
  switch (r.result) {
    case 'ok':
      return 'no errors';
    case 'errors':
      return `${plural(r.errors, 'error')} found`;
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

/** The parity line of the array card: a check that runs (with its progress), the last one, or why there is none. */
export function parityView(a: HostUnraidArray, now: number): ParityView {
  const p = a.parity;
  if (p.state !== 'idle') {
    const what = PARITY_ACTION_WORDS[p.action ?? 'check'];
    const parts = [
      p.state === 'paused' ? 'Paused' : p.etaS != null ? `${formatDuration(p.etaS)} left` : null,
      p.state === 'running' && p.speedMbs != null ? `${Math.round(p.speedMbs)} MB/s` : null,
      p.errors ? `${plural(p.errors, 'error')} so far` : 'no errors so far',
    ].filter(Boolean);
    return {
      title: p.pct != null ? `${what} · ${formatPct(p.pct)}` : what,
      detail: parts.join(' · '),
      tone: p.errors ? 'warn' : 'mut',
      running: p.state === 'running',
      paused: p.state === 'paused',
      pct: p.pct,
    };
  }
  const state = parityState(a);
  if (state === 'none')
    return {
      title: 'No parity disk',
      detail: 'Nothing protects the array if a disk fails.',
      tone: 'warn',
      running: false,
      paused: false,
      pct: null,
    };
  if (state === 'broken')
    return {
      title: 'Parity is disabled',
      detail: 'Nothing protects the array if a disk fails. Replace or reassign the parity disk in Unraid.',
      tone: 'bad',
      running: false,
      paused: false,
      pct: null,
    };
  const last = p.last ?? p.history[0] ?? null;
  if (!last)
    return {
      title: 'Parity never checked',
      detail: 'A check reads every disk and compares it with parity.',
      tone: 'warn',
      running: false,
      paused: false,
      pct: null,
    };
  const old = now - Date.parse(last.at) > PARITY_OLD_DAYS * 86_400_000;
  return {
    title: `Last checked ${formatAgoIso(last.at, now).replace(/ ago$/, '')} ago`,
    detail: `${runResult(last).replace(/^./, (c) => c.toUpperCase())}${last.durationS != null ? ` · took ${formatDuration(last.durationS)}` : ''}`,
    tone:
      last.result === 'ok' && !old
        ? 'ok'
        : last.result === 'errors' || last.result === 'failed'
          ? 'bad'
          : 'warn',
    running: false,
    paused: false,
    pct: null,
  };
}

/** A check older than this many days is worth a look (IU-08). */
export const PARITY_OLD_DAYS = 35;

/** One parity run of the history: “Oct 1 · Check · took 5 h 12 min · 182 MB/s · no errors”. */
export function parityRunWords(r: HostUnraidParityRun): { action: string; result: string; tone: HostTone } {
  const action = (r.action ?? 'check')
    .replace(/^check P Q$|^check P$|^check$/i, 'Check')
    .replace(/^correct.*$/i, 'Check with corrections')
    .replace(/^recon.*$/i, 'Rebuild')
    .replace(/^clear.*$/i, 'Clear');
  return {
    action: action.charAt(0).toUpperCase() + action.slice(1),
    result: runResult(r).replace(/^./, (c) => c.toUpperCase()),
    tone: r.result === 'ok' ? 'ok' : r.result === 'cancelled' ? 'mut' : 'bad',
  };
}

/** When a parity check ran: “1 Oct, 00:30” this year, “10 Jul 2024” before. */
export function parityRunWhen(iso: string, now: number, timeZone?: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  const tz = timeZone ? { timeZone } : {};
  const year = (d: number) => new Intl.DateTimeFormat('en-US', { year: 'numeric', ...tz }).format(d);
  return year(t) === year(now)
    ? formatDayTime(t, timeZone)
    : new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric', year: 'numeric', ...tz }).format(t);
}

/** What may be done to the array now (the buttons that show; the rest say why). */
export interface UnraidAbilities {
  start: boolean;
  stop: boolean;
  checkParity: boolean;
  /** Why Check parity isn't offered (no parity, the array stopped, a check runs). */
  checkReason: string | null;
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  mover: boolean;
  moverReason: string | null;
  spin: boolean;
}

export function unraidAbilities(u: Pick<HostUnraidDetail, 'array' | 'pools' | 'shares'>): UnraidAbilities {
  const a = u.array;
  const started = a.state === 'started';
  const idle = a.parity.state === 'idle';
  const parity = parityState(a);
  const moverWork = u.shares.some((s) => s.moverAction !== null);
  return {
    start: a.state === 'stopped',
    stop: started,
    checkParity: started && idle && parity === 'ok',
    checkReason: !started
      ? 'Start the array first.'
      : !idle
        ? null
        : parity === 'none'
          ? 'There’s no parity disk to check.'
          : parity === 'broken'
            ? 'Parity is disabled, so there’s nothing to check.'
            : null,
    pause: a.parity.state === 'running',
    resume: a.parity.state === 'paused',
    cancel: a.parity.state !== 'idle',
    mover: started && !a.moverRunning,
    moverReason: a.moverRunning
      ? 'The mover is running.'
      : !started
        ? 'Start the array first.'
        : moverWork
          ? null
          : 'No share moves files between a pool and the array.',
    spin: started && spinningDisks(u).length > 0,
  };
}

/** What stopping the array stops too, for the question (“Docker and its 12 containers, the 1 VM, the shares”). */
export function arrayStopWords(
  u: Pick<HostUnraidDetail, 'docker' | 'vms' | 'array' | 'shares'>,
  guests: readonly HostGuest[],
  serverName: string,
): string {
  const running = (p: HostGuest['platform']) =>
    guests.filter((g) => g.platform === p && (g.state === 'running' || g.state === 'unhealthy')).length;
  const docker = running('docker');
  const vms = running('libvirt');
  const parts = [
    u.docker.enabled && docker ? `${plural(docker, 'running container')}` : null,
    u.vms.enabled && vms ? `${plural(vms, 'running VM')}` : null,
    u.shares.length ? 'the shares' : null,
  ].filter(Boolean) as string[];
  const stops = parts.length
    ? `${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]} stop too`
    : 'Nothing else stops';
  const extra = [
    u.array.parity.state !== 'idle' ? 'The parity check is cancelled.' : null,
    u.array.moverRunning ? 'The mover stops halfway.' : null,
  ].filter(Boolean);
  return [`${stops} until the array is started again on ${serverName}.`, ...extra].join(' ');
}

/* Pools and shares ------------------------------------------------------------------------------------------ */

/** “btrfs raid10, encrypted · 4 disks”. */
export function poolWords(p: HostUnraidPool): string {
  const fs = fsWords(p.fsType);
  const [base, enc] = fs.split(', ');
  return [
    [base, p.profile && p.profile !== 'single' ? p.profile : null].filter(Boolean).join(' ') +
      (enc ? `, ${enc}` : ''),
    plural(p.disks.length, 'disk'),
  ].join(' · ');
}

/** A pool over this much is worth a look (IU-08). */
export const UNRAID_POOL_FULL_PCT = 90;

/** Where a share keeps its files: “data”, “Array”, “cache → array” (the mover's way). */
export function shareWhere(s: Pick<HostUnraidShare, 'primary' | 'secondary' | 'moverAction'>): string {
  const word = (w: string) => (w === 'array' ? 'Array' : w);
  if (!s.secondary) return word(s.primary);
  return s.moverAction === 'to_pool'
    ? `${word(s.secondary)} → ${word(s.primary)}`
    : `${word(s.primary)} → ${word(s.secondary)}`;
}

/** How a share is shared over SMB: “Private”, “Public”, “Secure”, “Not shared”. */
export function shareSmbWords(smb: string | null): string {
  if (!smb) return 'Not shared';
  return smb.charAt(0).toUpperCase() + smb.slice(1);
}

/* Plugins and the Unraid version (AP-1595) -------------------------------------------------------------------- */

/** Unraid's own plugin (the OS): never listed with the plugins, never updated from Whombat (IU-10). */
export const UNRAID_OS_PLUGIN = 'unRAIDServer.plg';

/** The plugins as the Plugins tab lists them: the ones with an update first, then by name; never the OS. */
export function pluginRows(u: Pick<HostUnraidDetail, 'plugins'>): HostUnraidPlugin[] {
  return u.plugins
    .filter((p) => p.file !== UNRAID_OS_PLUGIN)
    .sort((a, b) => Number(!!b.update) - Number(!!a.update) || a.name.localeCompare(b.name));
}

export function pluginUpdates(u: Pick<HostUnraidDetail, 'plugins'>): HostUnraidPlugin[] {
  return pluginRows(u).filter((p) => !!p.update);
}

/** The Unraid version line: “Unraid 7.3.1 · Pro”, and the newer one when there is one. */
export function unraidVersionView(u: Pick<HostUnraidDetail, 'version' | 'license' | 'osUpdate'>): {
  text: string;
  update: string | null;
} {
  const newer =
    u.osUpdate && (compareVersions(u.osUpdate.version, u.version) ?? 1) > 0 ? u.osUpdate.version : null;
  return {
    text: [`Unraid ${u.version}`, u.license].filter(Boolean).join(' · '),
    update: newer ? `Unraid ${newer} is available — update it in Unraid.` : null,
  };
}

/**
 * A page of the server's own Unraid web page (`Main`, `Shares`, `Tools/Update`, `Plugins`, `Docker`) when its address
 * is known: plain http, which Unraid sends on to https itself when it uses it. Null without an address.
 */
export function unraidPageUrl(d: Pick<HostServerDetail, 'server'>, page: string): string | null {
  const a = (d.server.address ?? '').trim().replace(/\/\d+$/, '');
  if (!a || !/^[A-Za-z0-9.:[\]-]+$/.test(a)) return null;
  const host = a.includes(':') && !a.startsWith('[') ? `[${a}]` : a;
  return `http://${host}/${page.replace(/^\//, '')}`;
}

/* Notifications (AP-1597) ---------------------------------------------------------------------------------- */

export function notificationTone(n: Pick<HostUnraidNotification, 'importance'>): HostTone {
  return n.importance === 'alert' ? 'bad' : n.importance === 'warning' ? 'warn' : 'mut';
}

/** A notification's subject without Unraid's “Alert [BLACKBOX] - ” in front (its dot says how important it is). */
export function notificationTitle(n: Pick<HostUnraidNotification, 'subject' | 'event'>): string {
  const s = n.subject.replace(/^(Alert|Warning|Notice)\s*\[[^\]]*\]\s*-\s*/i, '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : n.event;
}

export const NOTIFICATION_WORDS: Record<HostUnraidNotification['importance'], string> = {
  alert: 'Alert',
  warning: 'Warning',
  normal: 'Notice',
};

/* Docker the Unraid way and libvirt's autostart (AP-1593) ----------------------------------------------------- */

/** Whether a guest has an autostart switch on this server: Docker on Unraid (dockerMan's list) and libvirt VMs. */
export function hasAutostart(g: HostGuest, onUnraid: boolean): boolean {
  if (g.platform === 'libvirt') return true;
  return g.platform === 'docker' && onUnraid && g.autostart !== undefined;
}

/** Update from the template works for a Docker container on Unraid with an update and a template. */
export function canUpdateContainer(g: HostGuest, onUnraid: boolean): boolean {
  return onUnraid && g.platform === 'docker' && g.updateAvailable === true && g.template === true;
}

/** A container's web page as a link Whombat opens (http or https only), else null. */
export function guestWebUi(g: HostGuest): string | null {
  const raw = g.webUi?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/* Hints with their way out (IU-08, AP-1598) -------------------------------------------------------------------- */

export type UnraidHintFix =
  | { kind: 'tab'; tab: UnraidTab; label: string }
  | { kind: 'start_array'; label: string }
  | { kind: 'check_parity'; label: string }
  | { kind: 'update_plugins'; label: string }
  | { kind: 'archive'; id: string; label: string }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'update_container'; guestId: string; label: string }
  | { kind: 'guest'; guestId: string; label: string };

function unraidTabOf(section: string | null | undefined): UnraidTab | null {
  const s = (section ?? '').replace(/^#/, '');
  if ((UNRAID_TABS as readonly string[]).includes(s)) return s as UnraidTab;
  // Sections of other pages that live elsewhere here: disks and pools are on Array.
  if (s === 'storage' || s === 'disks') return 'array';
  return null;
}

/** What an Unraid server's hint (or alert, by its section) offers as its way out. */
export function unraidHintFixes(
  h: Pick<HostHint, 'kind' | 'entity' | 'detail' | 'section'>,
  ctx: { guests: readonly HostGuest[]; updateUrl: string | null; canManage: boolean },
): UnraidHintFix[] {
  const m = ctx.canManage;
  switch (h.kind) {
    case 'unraid.array_stopped':
      return m
        ? [{ kind: 'start_array', label: 'Start the array' }]
        : [{ kind: 'tab', tab: 'array', label: 'Open Array' }];
    case 'unraid.parity_errors':
    case 'unraid.parity_old':
      return m
        ? [{ kind: 'check_parity', label: 'Check parity' }]
        : [{ kind: 'tab', tab: 'array', label: 'Open Array' }];
    case 'unraid.disk_errors':
    case 'unraid.pool_full':
      return [{ kind: 'tab', tab: 'array', label: 'Open Array' }];
    case 'unraid.plugin_updates':
      return m
        ? [
            { kind: 'update_plugins', label: 'Update all' },
            { kind: 'tab', tab: 'plugins', label: 'Open Plugins' },
          ]
        : [{ kind: 'tab', tab: 'plugins', label: 'Open Plugins' }];
    case 'unraid.notification':
      return m ? [{ kind: 'archive', id: h.entity, label: 'Archive' }] : [];
    case 'unraid.os_update':
      return ctx.updateUrl ? [{ kind: 'link', href: ctx.updateUrl, label: 'Update in Unraid' }] : [];
    case 'docker.update_available': {
      const named = hintGuests(h, ctx.guests);
      const list = named.length
        ? named
        : ctx.guests.filter((g) => g.platform === 'docker' && g.updateAvailable === true);
      return list
        .slice(0, 3)
        .map((g) =>
          m && canUpdateContainer(g, true)
            ? { kind: 'update_container' as const, guestId: g.id, label: `Update ${g.name}` }
            : { kind: 'guest' as const, guestId: g.id, label: `Open ${g.name}` },
        );
    }
    default: {
      const tab = unraidTabOf(h.section);
      return tab && tab !== 'summary' ? [{ kind: 'tab', tab, label: `Open ${UNRAID_TAB_WORDS[tab]}` }] : [];
    }
  }
}

/* Changes and their words (IU-06, IU-07; AP-1591, AP-1592) ---------------------------------------------------- */

export type UnraidOp = Extract<
  HostManageOp,
  | 'array.start'
  | 'array.stop'
  | 'parity.start'
  | 'parity.pause'
  | 'parity.resume'
  | 'parity.cancel'
  | 'disk.spin_up'
  | 'disk.spin_down'
  | 'mover.start'
  | 'plugin.check'
  | 'plugin.update'
  | 'notification.archive'
  | 'container.update'
  | 'containers.check'
  | 'guest.autostart'
>;

export interface UnraidChangeWords {
  /** The toast when the command started (“Starting the array on BlackBox.”). */
  started: string;
  /** What the task is called when it failed or is shown (“Starting the array on BlackBox”). */
  what: string;
  /** The toast when it went well (“The array on BlackBox is started.”). */
  finished: string;
}

/**
 * The words of an Unraid change, by op: `server` is the server's name, `target` the disk's, plugin's or guest's name
 * (“Disk 1”, “Fix Common Problems”, “plex”) or `all`, `on` the autostart switch.
 */
export function unraidChangeWords(
  op: UnraidOp,
  server: string,
  opts: { target?: string; on?: boolean; correct?: boolean } = {},
): UnraidChangeWords {
  const t = opts.target ?? 'all';
  const w = (what: string, started: string, finished: string) => ({ what, started, finished });
  switch (op) {
    case 'array.start':
      return w(
        `Starting the array on ${server}`,
        `Starting the array on ${server}.`,
        `The array on ${server} is started.`,
      );
    case 'array.stop':
      return w(
        `Stopping the array on ${server}`,
        `Stopping the array on ${server}.`,
        `The array on ${server} is stopped.`,
      );
    case 'parity.start':
      return w(
        `Starting the parity check on ${server}`,
        opts.correct
          ? `Starting a parity check with corrections on ${server}.`
          : `Starting a parity check on ${server}.`,
        `The parity check on ${server} is running.`,
      );
    case 'parity.pause':
      return w(
        `Pausing the parity check on ${server}`,
        `Pausing the parity check on ${server}.`,
        `The parity check on ${server} is paused.`,
      );
    case 'parity.resume':
      return w(
        `Resuming the parity check on ${server}`,
        `Resuming the parity check on ${server}.`,
        `The parity check on ${server} is running again.`,
      );
    case 'parity.cancel':
      return w(
        `Cancelling the parity check on ${server}`,
        `Cancelling the parity check on ${server}.`,
        `The parity check on ${server} is cancelled.`,
      );
    case 'disk.spin_up':
      return t === 'all'
        ? w(
            `Spinning up the disks on ${server}`,
            `Spinning up the disks on ${server}.`,
            `The disks on ${server} are spinning.`,
          )
        : w(`Spinning up ${t}`, `Spinning up ${t}.`, `${t} is spinning.`);
    case 'disk.spin_down':
      return t === 'all'
        ? w(
            `Spinning down the disks on ${server}`,
            `Spinning down the disks on ${server}.`,
            `The disks on ${server} are spun down.`,
          )
        : w(`Spinning down ${t}`, `Spinning down ${t}.`, `${t} is spun down.`);
    case 'mover.start':
      return w(
        `The mover on ${server}`,
        `The mover on ${server} started.`,
        `The mover on ${server} is done.`,
      );
    case 'plugin.check':
      return w(
        `Checking ${server}’s plugins for updates`,
        `Checking ${server}’s plugins for updates.`,
        `Checked ${server}’s plugins for updates.`,
      );
    case 'plugin.update':
      return t === 'all'
        ? w(
            `Updating ${server}’s plugins`,
            `Updating ${server}’s plugins.`,
            `${server}’s plugins are up to date now.`,
          )
        : w(`Updating ${t}`, `Updating ${t} on ${server}.`, `${t} is up to date now.`);
    case 'container.update':
      return w(`Updating ${t}`, `Updating ${t} on ${server}.`, `${t} on ${server} is up to date now.`);
    case 'containers.check':
      return w(
        `Checking ${server}’s containers for updates`,
        `Checking ${server}’s containers for updates.`,
        `Checked ${server}’s containers for updates.`,
      );
    case 'notification.archive':
      return w(
        'Archiving',
        '',
        t === 'all' ? `Archived ${server}’s notifications.` : 'Archived the notification.',
      );
    case 'guest.autostart':
      return w(
        `Autostart of ${t}`,
        '',
        opts.on ? `${t} starts with ${server} now.` : `${t} no longer starts with ${server}.`,
      );
  }
}
