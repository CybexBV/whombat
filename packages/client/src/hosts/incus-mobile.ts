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
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_INCUS_WORDS } from '../i18n/messages/connectionsHosts/incus';
import { type ConfigDraft, currentValue, incusDraft, parseSize, reviewRows, trimDraft } from './config';
import { DASH, formatBytesBinary, formatRelativeDay } from './format';
import {
  backupExpiresAt,
  cpuWords,
  expiryText,
  expiryWords as incusExpiryWords,
  incusLockWords,
  incusNameError,
  isSelfGuest,
  memoryWords,
  SELF_GUEST_CHIP,
  SELF_GUEST_LINE,
  scheduleWords,
  selfGuestChip,
  selfGuestLine,
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
/** `THIS_WHOMBAT` and `SELF_LINE` in a locale (English when none is given). */
export const thisWhombatLabel = selfGuestChip;
export const selfLine = selfGuestLine;

const words = (locale?: string | null) => clientTree(locale, HOSTS_INCUS_WORDS);

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
  locale?: string | null,
): { label: string; value: string } | null {
  const self = selfGuestOf(guests);
  if (!hosts && !self) return null;
  const w = words(locale);
  return {
    label: selfGuestChip(locale),
    value: self ? interpolate(w.runsHereIn, { guest: self.name }) : w.runsHere,
  };
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
export function incusHeadLine(
  g: Pick<HostGuest, 'node' | 'serverId' | 'project'>,
  locale?: string | null,
): string {
  return [
    g.node ?? g.serverId,
    g.project && g.project !== 'default' ? interpolate(words(locale).project, { project: g.project }) : null,
  ]
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
export function autostartWords(v: string | undefined, locale?: string | null): string {
  const w = words(locale).autostart;
  if (isTrue(v)) return w.yes;
  if (isFalse(v)) return w.no;
  return w.ifRunning;
}

/** `snapshots.schedule` in the web's words (`scheduleWords`); unset “None”. */
export function scheduleWordsIncus(v: string | undefined, locale?: string | null): string {
  return scheduleWords(v, locale) || words(locale).none;
}

/** `snapshots.expiry` in the web's words with “kept” (“kept 2 weeks”); unset “kept until removed”. */
export function expiryWords(v: string | undefined, locale?: string | null): string {
  const w = words(locale);
  const expiry = incusExpiryWords(v, locale);
  return expiry ? interpolate(w.kept, { expiry }) : w.keptUntilRemoved;
}

/** How long snapshots are kept without the “kept” around it (“2 weeks”, “until removed”). */
function keptFor(v: string | undefined, locale?: string | null): string {
  return incusExpiryWords(v, locale) || words(locale).values.untilRemoved;
}

/** The snapshot schedule as one line: “Every day at 03:00 · kept 1 week”, or “No schedule”. */
export function incusScheduleLine(
  cfg: HostGuestConfig | undefined,
  locale?: string | null,
): { text: string; set: boolean } {
  const schedule = currentValue(cfg, 'snapshots.schedule')?.trim();
  if (!schedule) return { text: words(locale).noSchedule, set: false };
  return {
    text: `${scheduleWordsIncus(schedule, locale)} · ${expiryWords(currentValue(cfg, 'snapshots.expiry'), locale)}`,
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
export const INCUS_LOCKED = incusLockWords('en');
/** Under a key set in a profile rather than on the instance. */
export const FROM_PROFILE = words('en').fromProfile;
/** The line and link at the bottom of an Incus instance's Settings, in a locale (English when none is given). */
export function incusWebOnly(locale?: string | null): string {
  return words(locale).webOnly;
}
/** The line and link at the bottom of an Incus instance's Settings (IU-09). */
export const INCUS_WEB_ONLY = incusWebOnly('en');

/** An Incus key in words (“Memory”, “Snapshot schedule”); unknown keys as they are. */
export function incusKeyLabel(key: string, locale?: string | null): string {
  const keys = words(locale).keys;
  return Object.hasOwn(keys, key) ? keys[key as keyof typeof keys] : key;
}

/** An Incus value as the phone shows it. */
export function incusValueWords(key: string, v: string | undefined, locale?: string | null): string {
  const w = words(locale);
  switch (key) {
    case 'limits.memory':
      return memoryWords(v, locale) || w.values.noLimit;
    case 'limits.cpu':
      return cpuWords(v, locale) || w.values.noLimit;
    case 'boot.autostart':
      return autostartWords(v, locale);
    case 'security.protection.delete':
      return isTrue(v) ? w.values.protected : w.values.off;
    case 'security.nesting':
    case 'security.privileged':
      return isTrue(v) ? w.values.on : w.values.off;
    case 'snapshots.schedule':
      return scheduleWordsIncus(v, locale);
    case 'snapshots.expiry':
      return v?.trim() ? keptFor(v, locale) : w.values.untilRemoved;
    case 'description':
      return v?.trim() || w.none;
    default:
      return v?.trim() ? v : w.values.empty;
  }
}

function rootDisk(cfg: HostGuestConfig, locale?: string | null): string | null {
  const w = words(locale).settings;
  const disk = cfg.disks?.find((d) => d.key === 'root' || d.path === '/');
  const raw = cfg.values['device.root'];
  const pool = disk?.storage ?? /(?:^|,)pool=([^,]+)/.exec(raw ?? '')?.[1];
  const size = disk?.sizeBytes ?? parseSize(/(?:^|,)size=([^,]+)/.exec(raw ?? '')?.[1]);
  if (!pool && size == null) return null;
  return [size != null ? formatBytesBinary(size) : w.poolSize, pool ? interpolate(w.onPool, { pool }) : null]
    .filter(Boolean)
    .join(' ');
}

/**
 * An Incus instance's configuration in the phone's six groups (IU-09): Resources, Boot, Security, Snapshots, Notes,
 * Profiles — the everyday keys marked for their edit, keys only the `incus` command changes locked, keys from a
 * profile said so. Devices, `user.*` keys and the rest stay on the web.
 */
export function incusSettingGroups(cfg: HostGuestConfig, locale?: string | null): IncusSettingGroup[] {
  const all = words(locale);
  const w = all.settings;
  const fromProfile = all.fromProfile;
  const v = (k: string) => currentValue(cfg, k);
  const restricted = new Set(cfg.restricted ?? []);
  const inherited = new Set(cfg.inherited ?? []);
  const row = (id: string, key: string, edit?: IncusEditKind, extra: Partial<IncusSettingRow> = {}) => {
    const locked = restricted.has(key);
    const out: IncusSettingRow = {
      id,
      label: incusKeyLabel(key, locale),
      value: incusValueWords(key, v(key), locale),
      ...extra,
    };
    if (locked) {
      out.locked = true;
      out.sub = incusLockWords(locale);
    } else {
      if (edit) out.edit = edit;
      if (inherited.has(key) && !out.sub) out.sub = fromProfile;
    }
    return out;
  };

  const resources: IncusSettingRow[] = [
    row('memory', 'limits.memory', 'memory'),
    row('cpu', 'limits.cpu', 'cpu'),
  ];
  if (v('limits.memory.swap') !== undefined) resources.push(row('swap', 'limits.memory.swap'));
  if (v('limits.processes') !== undefined) resources.push(row('processes', 'limits.processes'));
  const root = rootDisk(cfg, locale);
  if (root) resources.push({ id: 'root', label: w.rootDisk, value: root });

  const boot: IncusSettingRow[] = [row('autostart', 'boot.autostart', 'autostart')];
  const priority = v('boot.autostart.priority');
  const delay = v('boot.autostart.delay');
  if (priority || delay)
    boot.push({
      id: 'order',
      label: w.startOrder,
      value: [
        priority ? interpolate(w.inTurn, { order: priority }) : null,
        delay ? interpolate(w.waits, { delay }) : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });

  const security: IncusSettingRow[] = [row('protection', 'security.protection.delete', 'protection')];
  if (cfg.kind === 'container') security.push(row('nesting', 'security.nesting'));
  if (v('security.privileged') !== undefined) security.push(row('privileged', 'security.privileged'));

  const schedule = row('schedule', 'snapshots.schedule', 'schedule');
  if (v('snapshots.schedule')?.trim() && !schedule.locked)
    schedule.sub = upperFirst(
      [expiryWords(v('snapshots.expiry'), locale), inherited.has('snapshots.schedule') ? fromProfile : null]
        .filter(Boolean)
        .join(' · '),
    );
  const snapshots: IncusSettingRow[] = [schedule];
  if (v('snapshots.pattern')) snapshots.push(row('pattern', 'snapshots.pattern', undefined, { mono: true }));

  const notes: IncusSettingRow[] = [row('description', 'description', 'description')];
  const profiles: IncusSettingRow[] = [
    {
      id: 'profiles',
      label: w.profiles,
      value: cfg.profiles?.length ? cfg.profiles.join(', ') : all.none,
      mono: true,
    },
  ];

  return [
    { id: 'resources', title: w.resources, rows: resources },
    { id: 'boot', title: w.boot, rows: boot },
    { id: 'security', title: w.security, rows: security },
    { id: 'snapshots', title: w.snapshots, rows: snapshots },
    { id: 'notes', title: w.notes, rows: notes },
    { id: 'profiles', title: w.profiles, rows: profiles },
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

export function incusEditSpec(kind: IncusEditKind, name: string, locale?: string | null): IncusEditSpec {
  const w = words(locale).edit;
  const title = (t: string) => interpolate(t, { name });
  switch (kind) {
    case 'memory':
      return { title: title(w.memoryTitle), field: w.memoryField, kind: 'number', hint: w.memoryHint };
    case 'cpu':
      return { title: title(w.cpuTitle), field: w.cpuField, kind: 'number', hint: w.noLimitHint };
    case 'autostart':
      return { title: title(w.autostartTitle), field: w.autostartField, kind: 'switch' };
    case 'protection':
      return { title: title(w.protectionTitle), field: w.protectionField, kind: 'switch' };
    case 'description':
      return { title: title(w.notesTitle), field: w.notesField, kind: 'multiline' };
    case 'schedule':
      return { title: title(w.scheduleTitle), field: w.scheduleField, kind: 'schedule' };
  }
}

/** The schedules the phone offers (Incus cron or its `@` words), in a locale (English when none is given). */
export function incusSchedules(locale?: string | null): readonly { value: string; label: string }[] {
  const w = words(locale).choices;
  return [
    { value: '', label: w.none },
    { value: '@hourly', label: w.hourly },
    { value: '0 */6 * * *', label: w.sixHours },
    { value: '0 3 * * *', label: w.daily },
    { value: '0 3 * * 0', label: w.sundays },
  ];
}

/** The schedules the phone offers (Incus cron or its `@` words). */
export const INCUS_SCHEDULES: readonly { value: string; label: string }[] = incusSchedules('en');

/** How long scheduled snapshots are kept, in a locale (English when none is given). */
export function incusExpiries(locale?: string | null): readonly { value: string; label: string }[] {
  const w = words(locale).choices;
  return [
    { value: '1d', label: w.day },
    { value: '1w', label: w.week },
    { value: '2w', label: w.twoWeeks },
    { value: '1m', label: w.month },
    { value: '', label: w.untilRemoved },
  ];
}

/** How long scheduled snapshots are kept. */
export const INCUS_EXPIRIES: readonly { value: string; label: string }[] = incusExpiries('en');

/**
 * The schedule choices for this instance: the phone's, its own schedule first when it is another one (so it can be
 * kept), and no “None” when the schedule comes from a profile (an empty value on the instance brings the profile's
 * back).
 */
export function scheduleChoices(
  cfg: HostGuestConfig,
  locale?: string | null,
): { value: string; label: string }[] {
  const now = currentValue(cfg, 'snapshots.schedule')?.trim() ?? '';
  const fromProfile = !!cfg.inherited?.includes('snapshots.schedule');
  const list = incusSchedules(locale).filter((c) => !(fromProfile && c.value === ''));
  return now && !list.some((c) => c.value === now)
    ? [{ value: now, label: scheduleWordsIncus(now, locale) }, ...list]
    : list;
}

export function expiryChoices(
  cfg: HostGuestConfig,
  locale?: string | null,
): { value: string; label: string }[] {
  const now = currentValue(cfg, 'snapshots.expiry')?.trim() ?? '';
  const list = incusExpiries(locale);
  return now && !list.some((c) => c.value === now)
    ? [{ value: now, label: keptFor(now, locale) }, ...list]
    : [...list];
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
  locale?: string | null,
): { draft: ConfigDraft | null; error: string | null } {
  const w = words(locale).edit;
  const done = (d: ConfigDraft) => ({ draft: incusDraft(trimDraft(cfg, d)), error: null });
  const text = input.text.trim();
  switch (kind) {
    case 'memory': {
      if (!text) return done({ delete: ['limits.memory'] });
      if (!/^\d+$/.test(text)) return { draft: null, error: w.wholeNumber };
      const n = Number(text);
      if (n < 64) return { draft: null, error: interpolate(w.atLeast, { n: 64 }) };
      const now = parseSize(currentValue(cfg, 'limits.memory'));
      if (now != null && now === n * MIB) return { draft: {}, error: null };
      return done({ set: { 'limits.memory': memoryValue(n) } });
    }
    case 'cpu': {
      if (!text) return done({ delete: ['limits.cpu'] });
      if (!/^\d+$/.test(text)) return { draft: null, error: w.wholeNumber };
      const n = Number(text);
      if (n < 1) return { draft: null, error: interpolate(w.atLeast, { n: 1 }) };
      if (n > 512) return { draft: null, error: interpolate(w.atMost, { n: 512 }) };
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
export function incusReviewLines(
  cfg: HostGuestConfig,
  draft: ConfigDraft,
  locale?: string | null,
): IncusReviewLine[] {
  return reviewRows(cfg, draft).map((r) => ({
    key: r.key,
    label: incusKeyLabel(r.key, locale),
    old: incusValueWords(r.key, r.old, locale),
    new: incusValueWords(r.key, r.op === 'delete' ? undefined : r.new, locale),
  }));
}

/** A running VM takes some changes at its next restart: the review says so. */
export function incusReviewNote(
  cfg: HostGuestConfig,
  draft: ConfigDraft,
  locale?: string | null,
): string | null {
  const touches = Object.keys(draft.set ?? {}).some((k) => k === 'limits.memory' || k === 'limits.cpu');
  return cfg.running && cfg.kind === 'vm' && touches ? words(locale).edit.reviewNote : null;
}

/* Names ------------------------------------------------------------------------------------------------------------ */

/** A new instance name (the web's `incusNameError`), not its own name now and not another guest's. */
export function incusNewNameError(
  name: string,
  taken: readonly string[] = [],
  current?: string,
  locale?: string | null,
): string | null {
  const w = words(locale).names;
  const v = name.trim();
  const bad = incusNameError(v, locale);
  if (bad) return bad;
  if (current && v === current) return w.same;
  if (taken.includes(v)) return interpolate(w.taken, { name: v });
  return null;
}

/** Whether a change that needs the instance stopped may go, and the sentence when it may not. */
export function stoppedCheck(g: Pick<HostGuest, 'name' | 'state'>, locale?: string | null): string | null {
  return g.state === 'stopped' ? null : interpolate(words(locale).names.shutDownFirst, { name: g.name });
}

/* Backups ---------------------------------------------------------------------------------------------------------- */

const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const upperFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

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
  locale?: string | null,
): IncusBackupRow[] {
  return [...items]
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
    .map((b) => {
      const when = b.created ? formatRelativeDay(Date.parse(b.created), now, timeZone, locale) : DASH;
      const who = nameOf?.(b) ?? null;
      const title = who ? `${who} · ${when}` : when;
      const expires = backupExpiresAt(b);
      const line = [
        b.sizeBytes != null ? formatBytesBinary(b.sizeBytes) : null,
        lower(expiryText(expires, now, locale)),
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

type TaskKey = keyof ReturnType<typeof words>['tasks'];

/** The new ops as task words (Incus and unRAID tasks the hub names by their op). */
const OP_TASK_WORDS: Record<string, TaskKey> = {
  'backup.create': 'backup',
  'backup.restore': 'restore',
  'backup.delete': 'removeBackup',
  'guest.create': 'create',
  'guest.clone': 'copy',
  'guest.delete': 'delete',
  'guest.rename': 'rename',
  'guest.move': 'move',
  'guest.publish': 'publish',
  'config.set': 'settings',
  'image.download': 'downloadImage',
  'image.refresh': 'refreshImage',
  'image.delete': 'deleteImage',
  'array.start': 'arrayStart',
  'array.stop': 'arrayStop',
  'parity.start': 'parityCheck',
  'parity.pause': 'parityPause',
  'parity.resume': 'parityResume',
  'parity.cancel': 'parityCancel',
  'disk.spin_up': 'spinUp',
  'disk.spin_down': 'spinDown',
  'mover.start': 'mover',
  'plugin.check': 'pluginCheck',
  'plugin.update': 'pluginUpdate',
  'container.update': 'containerUpdate',
  'containers.check': 'containersCheck',
};

/** An Incus operation's description read as a task word (the hub names them “Backing up instance” and the like). */
function describedTask(t: string): TaskKey | null {
  if (!/instance|snapshot|backup|image|container|volume|profile|operation/.test(t)) return null;
  if (/restor\w*\s+(a\s+|the\s+)?backup/.test(t)) return 'restore';
  if (/delet\w*\s+(a\s+|the\s+)?backup/.test(t)) return 'removeBackup';
  if (/backing up|backup/.test(t)) return 'backup';
  if (/restor\w*\s+(a\s+|the\s+)?snapshot/.test(t)) return 'backToSnapshot';
  if (/delet\w*\s+(a\s+|the\s+)?snapshot/.test(t)) return 'removeSnapshot';
  if (/snapshot/.test(t)) return 'snapshot';
  if (/renam/.test(t)) return 'rename';
  if (/migrat|moving/.test(t)) return 'move';
  if (/publish|creating image/.test(t)) return 'publish';
  if (/download\w*\s+image/.test(t)) return 'downloadImage';
  if (/cop(y|ying)/.test(t)) return 'copy';
  if (/restart/.test(t)) return 'restart';
  if (/start/.test(t)) return 'start';
  if (/stop/.test(t)) return 'stop';
  if (/freez/.test(t)) return 'pause';
  if (/creat/.test(t)) return 'create';
  if (/delet/.test(t)) return 'delete';
  if (/updat/.test(t)) return 'settings';
  return null;
}

/**
 * An Incus operation or a new op in words, or null when it isn't one: the hub names Incus operations by their
 * description (“Backing up instance”, “Restoring snapshot”) or by the op that started them.
 */
export function iuTaskWord(type: string, locale?: string | null): string | null {
  const key = Object.hasOwn(OP_TASK_WORDS, type) ? OP_TASK_WORDS[type] : describedTask(type.toLowerCase());
  return key ? words(locale).tasks[key] : null;
}

/* Started and finished (IU-07) ------------------------------------------------------------------------------------ */

export interface IuFollowWords {
  started: string;
  done: string;
  failed: string;
}

/**
 * What a change of the Incus and unRAID build says when it starts and when it ends (null for the rest): `name` is
 * the guest, plugin or server it is about, `extra` the new name or the disk.
 */
export function iuFollowWords(
  kind: string,
  name: string,
  extra = '',
  locale?: string | null,
): IuFollowWords | null {
  const w = words(locale).follow;
  // An Unraid command: the web's words (`unraidChangeWords`), `name` the server, `extra` the disk, plugin or guest.
  if ((UNRAID_TASK_OPS as readonly string[]).includes(kind)) {
    const u = unraidChangeWords(kind as UnraidOp, name, extra ? { target: extra } : {}, locale);
    return { started: u.started, done: u.finished, failed: interpolate(w.failed, { what: u.what }) };
  }
  const said =
    kind === 'guest.rename'
      ? w.rename
      : kind === 'guest.copy'
        ? w.copy
        : kind === 'backup.restore_new'
          ? w.restoreNew
          : null;
  if (!said) return null;
  const vars = { name, extra };
  return {
    started: interpolate(said.started, vars),
    done: interpolate(said.done, vars),
    failed: interpolate(said.failed, vars),
  };
}

/* An Incus server -------------------------------------------------------------------------------------------------- */

/** An Incus server's facts on its Summary: the version, projects, images, profiles and networks. */
export function incusFacts(d: HostIncusDetail, locale?: string | null): { label: string; value: string }[] {
  const all = words(locale);
  const w = all.facts;
  const out: { label: string; value: string }[] = [{ label: 'Incus', value: d.version }];
  if (d.projects.length) out.push({ label: w.projects, value: d.projects.map((p) => p.name).join(', ') });
  out.push({ label: w.images, value: d.images.length ? w.imageCount(d.images.length) : all.none });
  if (d.profiles.length) out.push({ label: w.profiles, value: d.profiles.map((p) => p.name).join(', ') });
  const managed = d.networks.filter((n) => n.managed);
  if (managed.length) out.push({ label: w.networks, value: managed.map((n) => n.name).join(', ') });
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

export function incusPoolRows(d: HostIncusDetail, locale?: string | null): PoolRowView[] {
  const w = words(locale).pools;
  return d.pools.map((p) => {
    const pct = p.usedBytes != null && p.totalBytes ? (p.usedBytes / p.totalBytes) * 100 : null;
    const usedText =
      p.usedBytes != null && p.totalBytes != null
        ? interpolate(w.used, {
            used: formatBytesBinary(p.usedBytes),
            total: formatBytesBinary(p.totalBytes),
          })
        : w.unknown;
    const line = [p.driver, w.volumes(p.volumes)].join(' · ');
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
export function incusHintWayOut(
  kind: string,
  locale?: string | null,
): { label: string; to: 'snapshots' } | null {
  return kind === 'incus.no_snapshots' ? { label: words(locale).setSchedule, to: 'snapshots' } : null;
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
