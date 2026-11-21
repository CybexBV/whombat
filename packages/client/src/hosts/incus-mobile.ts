/**
 * An Incus instance and an Incus server on the phone (Whombat incus-unraid.md IU-02, IU-04, IU-07…IU-09; app
 * docs/decisions/incus-unraid-mobile.md AP-1617…): the guest this Whombat runs in and what stays allowed on it, the
 * instance's five tabs, its header line, its Settings read in six groups with the everyday edits (memory, processors,
 * start with the server, protection, notes, the snapshot schedule) and their review, the backup rows with their
 * expiry, Back up now / Copy / Rename / Restore as a new instance and their checks, Incus operations and the new ops in
 * words, what a followed change says when it starts and ends, and an Incus server's facts, pools and hints. Pure:
 * times and the time zone come in as arguments. Shared by nothing on the web (stream WI has `incus.ts`).
 */
import type {
  HostBackupVolume,
  HostGuest,
  HostGuestConfig,
  HostGuestDetail,
  HostHint,
  HostIncusDetail,
} from '@whombat/core/domain';
import { type ConfigDraft, currentValue, incusDraft, parseSize, reviewRows, trimDraft } from './config';
import { DASH, formatBytesBinary, formatRelativeDay, plural } from './format';
import {
  backupExpiresAt,
  cpuWords,
  expiryText,
  INCUS_LOCK_WORDS,
  expiryWords as incusExpiryWords,
  incusNameError,
  isSelfGuest,
  memoryWords,
  SELF_GUEST_CHIP,
  SELF_GUEST_LINE,
  scheduleWords,
} from './incus';
import { type UnraidOp, unraidChangeWords } from './unraid';

/** The Unraid ops that run as a task (`notification.archive` and `guest.autostart` are done at once). */
const UNRAID_TASK_OPS: readonly UnraidOp[] = [
  'array.start',
  'array.stop',
  'parity.start',
  'parity.pause',
  'parity.resume',
  'parity.cancel',
  'disk.spin_up',
  'disk.spin_down',
  'mover.start',
  'plugin.check',
  'plugin.update',
  'container.update',
  'containers.check',
];

/* The guest this Whombat runs in (IU-02) -------------------------------------------------------------------------- */

/** The chip on its row and its screen, and the line where its changing actions would be (the web's, `incus.ts`). */
export const THIS_WHOMBAT = SELF_GUEST_CHIP;
export const SELF_LINE = SELF_GUEST_LINE;
/** The self guest's rules are the web's (`HOST_SELF_GUEST_ALLOWED`). */
export { isSelfGuest, selfAllowsAction, selfAllowsOp } from './incus';

/** The guest this Whombat runs in, among a server's guests. */
export function selfGuestOf<G extends Pick<HostGuest, 'self'>>(guests: readonly G[]): G | null {
  return guests.find((g) => isSelfGuest(g)) ?? null;
}

/** A server's fact that this Whombat runs on it (`hostsThisWhombat`), naming its guest when known. */
export function thisWhombatFact(
  hosts: boolean | undefined,
  guests: readonly Pick<HostGuest, 'self' | 'name'>[],
): { label: string; value: string } | null {
  const self = selfGuestOf(guests);
  if (!hosts && !self) return null;
  return { label: THIS_WHOMBAT, value: self ? `Runs here, in ${self.name}` : 'Runs here' };
}

/* Tasks: which platform reads them ------------------------------------------------------------------------------- */

/** A task's platform by its id: `incus:<uuid>`, `unraid:<id>`, `libvirt:<id>`, `pkg:<id>`, else a Proxmox UPID. */
export function taskPlatform(taskId: string): 'pve' | 'incus' | 'unraid' | 'libvirt' | 'host' {
  if (taskId.startsWith('incus:')) return 'incus';
  // A package task on the server itself (contracts 0.98.0; server-updates-app.md AP-2884).
  if (taskId.startsWith('pkg:')) return 'host';
  if (taskId.startsWith('unraid:')) return 'unraid';
  if (taskId.startsWith('libvirt:')) return 'libvirt';
  return 'pve';
}

/* Tabs and header ------------------------------------------------------------------------------------------------- */

export type IncusPhoneTab = 'summary' | 'settings' | 'snapshots' | 'backups' | 'tasks';

/** An Incus instance's tabs on the phone (IU-09): all five while Manage is on, else the Summary saying why. */
export function phoneIncusTabs(g: Pick<HostGuestDetail, 'manageable'>): IncusPhoneTab[] {
  return g.manageable ? ['summary', 'settings', 'snapshots', 'backups', 'tasks'] : ['summary'];
}

/** “thetitan”, “thetitan · project ci-platform”: the kind is the mark before the name (less-is-more.md AP-1810). */
export function incusHeadLine(g: Pick<HostGuest, 'node' | 'serverId' | 'project'>): string {
  return [g.node ?? g.serverId, g.project && g.project !== 'default' ? `project ${g.project}` : null]
    .filter(Boolean)
    .join(' · ');
}

/** The instance's own name as Incus knows it (`incus:ci-platform/runner` → `runner`). */
export function incusName(guestId: string): string {
  return guestId.replace(/^incus:/, '').replace(/^.*\//, '');
}

/* Values in words ------------------------------------------------------------------------------------------------- */

const isTrue = (v: string | undefined) => /^(true|1|yes|on)$/i.test(v?.trim() ?? '');
const isFalse = (v: string | undefined) => /^(false|0|no|off)$/i.test(v?.trim() ?? '');
const _NBSP = ' ';

/** `boot.autostart`: unset means “as it was when the server stopped”. */
export function autostartWords(v: string | undefined): string {
  if (isTrue(v)) return 'Yes';
  if (isFalse(v)) return 'No';
  return 'If it was running';
}

/** `snapshots.schedule` in the web's words (`scheduleWords`); unset “None”. */
export function scheduleWordsIncus(v: string | undefined): string {
  return scheduleWords(v) || 'None';
}

/** `snapshots.expiry` in the web's words with “kept” (“kept 2 weeks”); unset “kept until removed”. */
export function expiryWords(v: string | undefined): string {
  const w = incusExpiryWords(v);
  return w ? `kept ${w}` : 'kept until removed';
}

/** The snapshot schedule as one line: “Every day at 03:00 · kept 1 week”, or “No schedule”. */
export function incusScheduleLine(cfg: HostGuestConfig | undefined): { text: string; set: boolean } {
  const schedule = currentValue(cfg, 'snapshots.schedule')?.trim();
  if (!schedule) return { text: 'No schedule', set: false };
  return {
    text: `${scheduleWordsIncus(schedule)} · ${expiryWords(currentValue(cfg, 'snapshots.expiry'))}`,
    set: true,
  };
}

/* Settings (read) ------------------------------------------------------------------------------------------------- */

export type IncusEditKind = 'memory' | 'cpu' | 'autostart' | 'protection' | 'description' | 'schedule';

export interface IncusSettingRow {
  id: string;
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  /** The everyday edit this row opens. */
  edit?: IncusEditKind;
  /** Only the `incus` command changes this key (“Change this with the incus command”). */
  locked?: boolean;
}

export interface IncusSettingGroup {
  id: 'resources' | 'boot' | 'security' | 'snapshots' | 'notes' | 'profiles';
  title: string;
  rows: IncusSettingRow[];
}

/** Under a locked key, on the phone and the web. */
export const INCUS_LOCKED = INCUS_LOCK_WORDS;
/** Under a key set in a profile rather than on the instance. */
export const FROM_PROFILE = 'From a profile';
/** The line and link at the bottom of an Incus instance's Settings (IU-09). */
export const INCUS_WEB_ONLY =
  'Devices, profiles, images, volumes, networks and moving: on whombat on the web.';

const KEY_LABELS: Record<string, string> = {
  'limits.memory': 'Memory',
  'limits.cpu': 'Processors',
  'limits.memory.swap': 'Swap',
  'limits.processes': 'Processes',
  'boot.autostart': 'Start with the server',
  'boot.autostart.priority': 'Start order',
  'boot.autostart.delay': 'Wait after starting',
  'security.protection.delete': 'Protection',
  'security.nesting': 'Containers inside',
  'security.privileged': 'Privileged',
  'snapshots.schedule': 'Snapshot schedule',
  'snapshots.expiry': 'Keep snapshots',
  'snapshots.pattern': 'Snapshot names',
  description: 'Notes',
};

/** An Incus key in words (“Memory”, “Snapshot schedule”); unknown keys as they are. */
export function incusKeyLabel(key: string): string {
  return KEY_LABELS[key] ?? key;
}

/** An Incus value as the phone shows it. */
export function incusValueWords(key: string, v: string | undefined): string {
  switch (key) {
    case 'limits.memory':
      return memoryWords(v) || 'No limit';
    case 'limits.cpu':
      return cpuWords(v) || 'No limit';
    case 'boot.autostart':
      return autostartWords(v);
    case 'security.protection.delete':
      return isTrue(v) ? 'Can’t be deleted' : 'Off';
    case 'security.nesting':
    case 'security.privileged':
      return isTrue(v) ? 'On' : 'Off';
    case 'snapshots.schedule':
      return scheduleWordsIncus(v);
    case 'snapshots.expiry':
      return v?.trim() ? expiryWords(v).replace(/^kept /, '') : 'Until removed';
    case 'description':
      return v?.trim() || 'None';
    default:
      return v?.trim() ? v : '(none)';
  }
}

function rootDisk(cfg: HostGuestConfig): string | null {
  const disk = cfg.disks?.find((d) => d.key === 'root' || d.path === '/');
  const raw = cfg.values['device.root'];
  const pool = disk?.storage ?? /(?:^|,)pool=([^,]+)/.exec(raw ?? '')?.[1];
  const size = disk?.sizeBytes ?? parseSize(/(?:^|,)size=([^,]+)/.exec(raw ?? '')?.[1]);
  if (!pool && size == null) return null;
  return [size != null ? formatBytesBinary(size) : 'Pool’s size', pool ? `on ${pool}` : null]
    .filter(Boolean)
    .join(' ');
}

/**
 * An Incus instance's configuration in the phone's six groups (IU-09): Resources, Boot, Security, Snapshots, Notes,
 * Profiles — the everyday keys marked for their edit, keys only the `incus` command changes locked, keys from a
 * profile said so. Devices, `user.*` keys and the rest stay on the web.
 */
export function incusSettingGroups(cfg: HostGuestConfig): IncusSettingGroup[] {
  const v = (k: string) => currentValue(cfg, k);
  const restricted = new Set(cfg.restricted ?? []);
  const inherited = new Set(cfg.inherited ?? []);
  const row = (id: string, key: string, edit?: IncusEditKind, extra: Partial<IncusSettingRow> = {}) => {
    const locked = restricted.has(key);
    const out: IncusSettingRow = {
      id,
      label: incusKeyLabel(key),
      value: incusValueWords(key, v(key)),
      ...extra,
    };
    if (locked) {
      out.locked = true;
      out.sub = INCUS_LOCKED;
    } else {
      if (edit) out.edit = edit;
      if (inherited.has(key) && !out.sub) out.sub = FROM_PROFILE;
    }
    return out;
  };

  const resources: IncusSettingRow[] = [
    row('memory', 'limits.memory', 'memory'),
    row('cpu', 'limits.cpu', 'cpu'),
  ];
  if (v('limits.memory.swap') !== undefined) resources.push(row('swap', 'limits.memory.swap'));
  if (v('limits.processes') !== undefined) resources.push(row('processes', 'limits.processes'));
  const root = rootDisk(cfg);
  if (root) resources.push({ id: 'root', label: 'Root disk', value: root });

  const boot: IncusSettingRow[] = [row('autostart', 'boot.autostart', 'autostart')];
  const priority = v('boot.autostart.priority');
  const delay = v('boot.autostart.delay');
  if (priority || delay)
    boot.push({
      id: 'order',
      label: 'Start order',
      value: [priority ? `In turn ${priority}` : null, delay ? `waits ${delay} s` : null]
        .filter(Boolean)
        .join(' · '),
    });

  const security: IncusSettingRow[] = [row('protection', 'security.protection.delete', 'protection')];
  if (cfg.kind === 'container') security.push(row('nesting', 'security.nesting'));
  if (v('security.privileged') !== undefined) security.push(row('privileged', 'security.privileged'));

  const schedule = row('schedule', 'snapshots.schedule', 'schedule');
  if (v('snapshots.schedule')?.trim() && !schedule.locked)
    schedule.sub = [
      expiryWords(v('snapshots.expiry')),
      inherited.has('snapshots.schedule') ? FROM_PROFILE : null,
    ]
      .filter(Boolean)
      .join(' · ')
      .replace(/^k/, 'K');
  const snapshots: IncusSettingRow[] = [schedule];
  if (v('snapshots.pattern')) snapshots.push(row('pattern', 'snapshots.pattern', undefined, { mono: true }));

  const notes: IncusSettingRow[] = [row('description', 'description', 'description')];
  const profiles: IncusSettingRow[] = [
    {
      id: 'profiles',
      label: 'Profiles',
      value: cfg.profiles?.length ? cfg.profiles.join(', ') : 'None',
      mono: true,
    },
  ];

  return [
    { id: 'resources', title: 'Resources', rows: resources },
    { id: 'boot', title: 'Boot', rows: boot },
    { id: 'security', title: 'Security', rows: security },
    { id: 'snapshots', title: 'Snapshots', rows: snapshots },
    { id: 'notes', title: 'Notes', rows: notes },
    { id: 'profiles', title: 'Profiles', rows: profiles },
  ];
}

/* Settings (edits) ------------------------------------------------------------------------------------------------ */

export interface IncusEditInput {
  text: string;
  on: boolean;
  /** The schedule's `snapshots.schedule` value (“” for none). */
  schedule: string;
  /** Its `snapshots.expiry` (“” keeps them until removed). */
  expiry: string;
}

export interface IncusEditSpec {
  title: string;
  field: string;
  kind: 'number' | 'multiline' | 'switch' | 'schedule';
  hint?: string;
}

export function incusEditSpec(kind: IncusEditKind, name: string): IncusEditSpec {
  switch (kind) {
    case 'memory':
      return {
        title: `Memory of ${name}`,
        field: 'Memory (MiB)',
        kind: 'number',
        hint: '1024 MiB is 1 GiB. Empty: no limit.',
      };
    case 'cpu':
      return { title: `Processors of ${name}`, field: 'Cores', kind: 'number', hint: 'Empty: no limit.' };
    case 'autostart':
      return {
        title: `Start ${name} with the server`,
        field: 'Always start it when the server starts',
        kind: 'switch',
      };
    case 'protection':
      return { title: `Protect ${name}?`, field: 'Protect it from being deleted', kind: 'switch' };
    case 'description':
      return { title: `Notes of ${name}`, field: 'Notes', kind: 'multiline' };
    case 'schedule':
      return { title: `Snapshots of ${name}`, field: 'Take a snapshot', kind: 'schedule' };
  }
}

/** The schedules the phone offers (Incus cron or its `@` words). */
export const INCUS_SCHEDULES: readonly { value: string; label: string }[] = [
  { value: '', label: 'None' },
  { value: '@hourly', label: 'Every hour' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 3 * * *', label: 'Every day at 03:00' },
  { value: '0 3 * * 0', label: 'Sundays at 03:00' },
];

/** How long scheduled snapshots are kept. */
export const INCUS_EXPIRIES: readonly { value: string; label: string }[] = [
  { value: '1d', label: '1 day' },
  { value: '1w', label: '1 week' },
  { value: '2w', label: '2 weeks' },
  { value: '1m', label: '1 month' },
  { value: '', label: 'Until I remove them' },
];

/**
 * The schedule choices for this instance: the phone's, its own schedule first when it is another one (so it can be
 * kept), and no “None” when the schedule comes from a profile (an empty value on the instance brings the profile's
 * back).
 */
export function scheduleChoices(cfg: HostGuestConfig): { value: string; label: string }[] {
  const now = currentValue(cfg, 'snapshots.schedule')?.trim() ?? '';
  const fromProfile = !!cfg.inherited?.includes('snapshots.schedule');
  const list = INCUS_SCHEDULES.filter((c) => !(fromProfile && c.value === ''));
  return now && !list.some((c) => c.value === now)
    ? [{ value: now, label: scheduleWordsIncus(now) }, ...list]
    : list;
}

export function expiryChoices(cfg: HostGuestConfig): { value: string; label: string }[] {
  const now = currentValue(cfg, 'snapshots.expiry')?.trim() ?? '';
  return now && !INCUS_EXPIRIES.some((c) => c.value === now)
    ? [{ value: now, label: expiryWords(now).replace(/^kept /, '') }, ...INCUS_EXPIRIES]
    : [...INCUS_EXPIRIES];
}

const MIB = 1024 ** 2;

/** The value an edit starts from. */
export function incusEditStart(cfg: HostGuestConfig, kind: IncusEditKind): IncusEditInput {
  const base: IncusEditInput = { text: '', on: false, schedule: '', expiry: '' };
  switch (kind) {
    case 'memory': {
      const bytes = parseSize(currentValue(cfg, 'limits.memory'));
      return { ...base, text: bytes != null ? String(Math.round(bytes / MIB)) : '' };
    }
    case 'cpu': {
      const c = currentValue(cfg, 'limits.cpu')?.trim() ?? '';
      return { ...base, text: /^\d+$/.test(c) ? c : '' };
    }
    case 'autostart':
      return { ...base, on: isTrue(currentValue(cfg, 'boot.autostart')) };
    case 'protection':
      return { ...base, on: isTrue(currentValue(cfg, 'security.protection.delete')) };
    case 'description':
      return { ...base, text: currentValue(cfg, 'description') ?? '' };
    case 'schedule':
      return {
        ...base,
        schedule: currentValue(cfg, 'snapshots.schedule')?.trim() ?? '',
        expiry: currentValue(cfg, 'snapshots.expiry')?.trim() ?? '',
      };
  }
}

/** A memory limit in MiB as Incus writes it: whole GiB as “4GiB”, else “1536MiB”. */
export function memoryValue(mib: number): string {
  return mib % 1024 === 0 ? `${mib / 1024}GiB` : `${mib}MiB`;
}

/**
 * The change an edit's fields describe, trimmed to what differs (null with what is wrong). A memory that means the
 * same (“4GiB” and 4096) is no change; removals are sent as “” (Incus has no pending values, `incusDraft`).
 */
export function incusEditDraft(
  cfg: HostGuestConfig,
  kind: IncusEditKind,
  input: IncusEditInput,
): { draft: ConfigDraft | null; error: string | null } {
  const done = (d: ConfigDraft) => ({ draft: incusDraft(trimDraft(cfg, d)), error: null });
  const text = input.text.trim();
  switch (kind) {
    case 'memory': {
      if (!text) return done({ delete: ['limits.memory'] });
      if (!/^\d+$/.test(text)) return { draft: null, error: 'Use a whole number.' };
      const n = Number(text);
      if (n < 64) return { draft: null, error: 'At least 64.' };
      const now = parseSize(currentValue(cfg, 'limits.memory'));
      if (now != null && now === n * MIB) return { draft: {}, error: null };
      return done({ set: { 'limits.memory': memoryValue(n) } });
    }
    case 'cpu': {
      if (!text) return done({ delete: ['limits.cpu'] });
      if (!/^\d+$/.test(text)) return { draft: null, error: 'Use a whole number.' };
      const n = Number(text);
      if (n < 1) return { draft: null, error: 'At least 1.' };
      if (n > 512) return { draft: null, error: 'At most 512.' };
      return done({ set: { 'limits.cpu': String(n) } });
    }
    case 'autostart': {
      const now = isTrue(currentValue(cfg, 'boot.autostart'));
      if (input.on === now) return { draft: {}, error: null };
      return done({ set: { 'boot.autostart': input.on ? 'true' : 'false' } });
    }
    case 'protection':
      return done(
        input.on
          ? { set: { 'security.protection.delete': 'true' } }
          : { delete: ['security.protection.delete'] },
      );
    case 'description':
      return done(input.text.trim() ? { set: { description: input.text } } : { delete: ['description'] });
    case 'schedule': {
      if (!input.schedule) return done({ delete: ['snapshots.schedule'] });
      return done(
        input.expiry
          ? { set: { 'snapshots.schedule': input.schedule, 'snapshots.expiry': input.expiry } }
          : { set: { 'snapshots.schedule': input.schedule }, delete: ['snapshots.expiry'] },
      );
    }
  }
}

export interface IncusReviewLine {
  key: string;
  label: string;
  old: string;
  new: string;
}

/** The review's lines in Incus words (“Memory  4 GiB → 8 GiB”); a key set to “” reads as its empty words. */
export function incusReviewLines(cfg: HostGuestConfig, draft: ConfigDraft): IncusReviewLine[] {
  return reviewRows(cfg, draft).map((r) => ({
    key: r.key,
    label: incusKeyLabel(r.key),
    old: incusValueWords(r.key, r.old),
    new: incusValueWords(r.key, r.op === 'delete' ? undefined : r.new),
  }));
}

/** A running VM takes some changes at its next restart: the review says so. */
export function incusReviewNote(cfg: HostGuestConfig, draft: ConfigDraft): string | null {
  const touches = Object.keys(draft.set ?? {}).some((k) => k === 'limits.memory' || k === 'limits.cpu');
  return cfg.running && cfg.kind === 'vm' && touches
    ? 'It’s running: Incus applies what it can now, the rest at its next restart.'
    : null;
}

/* Names ------------------------------------------------------------------------------------------------------------ */

/** A new instance name (the web's `incusNameError`), not its own name now and not another guest's. */
export function incusNewNameError(
  name: string,
  taken: readonly string[] = [],
  current?: string,
): string | null {
  const v = name.trim();
  const bad = incusNameError(v);
  if (bad) return bad;
  if (current && v === current) return 'That’s its name now.';
  if (taken.includes(v)) return `There’s already a guest called ${v}.`;
  return null;
}

/** Whether a change that needs the instance stopped may go, and the sentence when it may not. */
export function stoppedCheck(g: Pick<HostGuest, 'name' | 'state'>): string | null {
  return g.state === 'stopped' ? null : `Shut ${g.name} down first.`;
}

/* Backups ---------------------------------------------------------------------------------------------------------- */

const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

export interface IncusBackupRow {
  volume: string;
  /** “Today 02:00”, or “web · Today 02:00” in a server's list. */
  title: string;
  /** The backup's name. */
  name: string;
  /** “1.2 GiB · expires in 5 days” (its format stays on the web: the line fits a phone). */
  line: string;
  label: string;
  backup: HostBackupVolume;
}

/** Incus backups newest first, with their size, format and how long they are kept. */
export function incusBackupRows(
  items: readonly HostBackupVolume[],
  now: number,
  timeZone?: string,
  nameOf?: (b: HostBackupVolume) => string | null,
): IncusBackupRow[] {
  return [...items]
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
    .map((b) => {
      const when = b.created ? formatRelativeDay(Date.parse(b.created), now, timeZone) : DASH;
      const who = nameOf?.(b) ?? null;
      const title = who ? `${who} · ${when}` : when;
      const expires = backupExpiresAt(b);
      const line = [
        b.sizeBytes != null ? formatBytesBinary(b.sizeBytes) : null,
        lower(expiryText(expires, now)),
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        volume: b.volume,
        title,
        name: b.volume,
        line,
        label: [title, b.volume, line].join(', '),
        backup: b,
      };
    });
}

/** The guest a server-wide Incus backup belongs to (its `guest` is a guest id or an instance name). */
export function backupGuestName(
  b: Pick<HostBackupVolume, 'guest'>,
  guests: readonly Pick<HostGuest, 'id' | 'name'>[],
): string | null {
  if (!b.guest) return null;
  return (
    guests.find((g) => g.id === b.guest || g.name === b.guest || incusName(g.id) === b.guest)?.name ??
    incusName(b.guest)
  );
}

/** A restored instance's name by default. */
export function restoredName(name: string): string {
  return `${name}-restored`;
}

/* Tasks ------------------------------------------------------------------------------------------------------------ */

/** The new ops as task words (Incus and unRAID tasks the hub names by their op). */
const OP_TASK_WORDS: Record<string, string> = {
  'backup.create': 'Backup',
  'backup.restore': 'Restore',
  'backup.delete': 'Remove a backup',
  'guest.create': 'Create',
  'guest.clone': 'Copy',
  'guest.delete': 'Delete',
  'guest.rename': 'Rename',
  'guest.move': 'Move',
  'guest.publish': 'Make an image',
  'config.set': 'Settings',
  'image.download': 'Download an image',
  'image.refresh': 'Refresh an image',
  'image.delete': 'Delete an image',
  'array.start': 'Start the array',
  'array.stop': 'Stop the array',
  'parity.start': 'Parity check',
  'parity.pause': 'Pause the parity check',
  'parity.resume': 'Resume the parity check',
  'parity.cancel': 'Cancel the parity check',
  'disk.spin_up': 'Spin up',
  'disk.spin_down': 'Spin down',
  'mover.start': 'Mover',
  'plugin.check': 'Check plugins',
  'plugin.update': 'Plugin update',
  'container.update': 'Container update',
  'containers.check': 'Check containers',
};

/**
 * An Incus operation or a new op in words, or null when it isn't one: the hub names Incus operations by their
 * description (“Backing up instance”, “Restoring snapshot”) or by the op that started them.
 */
export function iuTaskWord(type: string): string | null {
  const op = OP_TASK_WORDS[type];
  if (op) return op;
  const t = type.toLowerCase();
  if (!/instance|snapshot|backup|image|container|volume|profile|operation/.test(t)) return null;
  if (/restor\w*\s+(a\s+|the\s+)?backup/.test(t)) return 'Restore';
  if (/delet\w*\s+(a\s+|the\s+)?backup/.test(t)) return 'Remove a backup';
  if (/backing up|backup/.test(t)) return 'Backup';
  if (/restor\w*\s+(a\s+|the\s+)?snapshot/.test(t)) return 'Back to a snapshot';
  if (/delet\w*\s+(a\s+|the\s+)?snapshot/.test(t)) return 'Remove a snapshot';
  if (/snapshot/.test(t)) return 'Snapshot';
  if (/renam/.test(t)) return 'Rename';
  if (/migrat|moving/.test(t)) return 'Move';
  if (/publish|creating image/.test(t)) return 'Make an image';
  if (/download\w*\s+image/.test(t)) return 'Download an image';
  if (/cop(y|ying)/.test(t)) return 'Copy';
  if (/restart/.test(t)) return 'Restart';
  if (/start/.test(t)) return 'Start';
  if (/stop/.test(t)) return 'Stop';
  if (/freez/.test(t)) return 'Pause';
  if (/creat/.test(t)) return 'Create';
  if (/delet/.test(t)) return 'Delete';
  if (/updat/.test(t)) return 'Settings';
  return null;
}

/* Started and finished (IU-07) ------------------------------------------------------------------------------------ */

export interface IuFollowWords {
  started: string;
  done: string;
  failed: string;
}

const w = (started: string, done: string, failed: string): IuFollowWords => ({ started, done, failed });

/**
 * What a change of the Incus and unRAID build says when it starts and when it ends (null for the rest): `name` is
 * the guest, plugin or server it is about, `extra` the new name or the disk.
 */
export function iuFollowWords(kind: string, name: string, extra = ''): IuFollowWords | null {
  // An Unraid command: the web's words (`unraidChangeWords`), `name` the server, `extra` the disk, plugin or guest.
  if ((UNRAID_TASK_OPS as readonly string[]).includes(kind)) {
    const u = unraidChangeWords(kind as UnraidOp, name, extra ? { target: extra } : {});
    return { started: u.started, done: u.finished, failed: `${u.what} didn’t work.` };
  }
  switch (kind) {
    case 'guest.rename':
      return w(
        `Renaming ${name} started.`,
        `${name} is called ${extra} now.`,
        `Renaming ${name} didn’t work.`,
      );
    case 'guest.copy':
      return w(
        `The copy of ${name} started.`,
        `The copy of ${name} is ready.`,
        `The copy of ${name} didn’t work.`,
      );
    case 'backup.restore_new':
      return w(
        `Restoring ${name} as ${extra} started.`,
        `${extra} is ready.`,
        `Restoring ${name} didn’t work.`,
      );
    default:
      return null;
  }
}

/* An Incus server -------------------------------------------------------------------------------------------------- */

/** An Incus server's facts on its Summary: the version, projects, images, profiles and networks. */
export function incusFacts(d: HostIncusDetail): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [{ label: 'Incus', value: d.version }];
  if (d.projects.length) out.push({ label: 'Projects', value: d.projects.map((p) => p.name).join(', ') });
  out.push({ label: 'Images', value: d.images.length ? plural(d.images.length, 'image') : 'None' });
  if (d.profiles.length) out.push({ label: 'Profiles', value: d.profiles.map((p) => p.name).join(', ') });
  const managed = d.networks.filter((n) => n.managed);
  if (managed.length) out.push({ label: 'Networks', value: managed.map((n) => n.name).join(', ') });
  return out;
}

export interface PoolRowView {
  name: string;
  /** “zfs · 17 volumes”. */
  line: string;
  /** “84 GiB of 1.5 TiB used”. */
  usedText: string;
  pct: number | null;
  tone: 'warn' | 'bad' | null;
  label: string;
}

/** A pool's tone: Incus warns at 85 % (IU-08), 95 % is a problem. */
export function poolTone(pct: number | null, warn = 85): 'warn' | 'bad' | null {
  if (pct == null) return null;
  return pct >= 95 ? 'bad' : pct >= warn ? 'warn' : null;
}

export function incusPoolRows(d: HostIncusDetail): PoolRowView[] {
  return d.pools.map((p) => {
    const pct = p.usedBytes != null && p.totalBytes ? (p.usedBytes / p.totalBytes) * 100 : null;
    const usedText =
      p.usedBytes != null && p.totalBytes != null
        ? `${formatBytesBinary(p.usedBytes)} of ${formatBytesBinary(p.totalBytes)} used`
        : 'Use not known';
    const line = [p.driver, plural(p.volumes, 'volume')].join(' · ');
    return {
      name: p.name,
      line,
      usedText,
      pct,
      tone: poolTone(pct),
      label: `${p.name}, ${line}, ${usedText}`,
    };
  });
}

/** Where an Incus hint is fixed on the phone (IU-08): no schedule → the guest's Snapshots. */
export function incusHintWayOut(kind: string): { label: string; to: 'snapshots' } | null {
  return kind === 'incus.no_snapshots' ? { label: 'Set a schedule', to: 'snapshots' } : null;
}

/** The guest a hint is about (its entity is the guest id or the instance name). */
export function hintGuest<G extends Pick<HostGuest, 'id' | 'name'>>(
  h: Pick<HostHint, 'entity'>,
  guests: readonly G[],
): G | null {
  return guests.find((g) => g.id === h.entity || g.name === h.entity || incusName(g.id) === h.entity) ?? null;
}

/** The instances a server's “no snapshot schedule” hints name, for its Backups segment. */
export function noScheduleGuests<G extends Pick<HostGuest, 'id' | 'name'>>(
  hints: readonly HostHint[],
  serverId: string,
  guests: readonly G[],
): G[] {
  const out: G[] = [];
  for (const h of hints) {
    if (h.serverId !== serverId || h.kind !== 'incus.no_snapshots') continue;
    const g = hintGuest(h, guests);
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}
