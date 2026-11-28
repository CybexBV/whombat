/**
 * Restore tests of Proxmox machines, the decisions without I/O (docs/decisions/backup-trust.md): which machines can be
 * tested and whose turn it is, when a test is due, where the copy goes and under which number, what the copy's settings
 * become before it starts (its network cables pulled, its name, no start at boot), whether a machine uses parts of the
 * server itself, and whether a running copy counts as started.
 */
import {
  type ChangeWindow,
  changeWindowMinutes,
  clockMinutes,
  inChangeWindow,
  isRestoreTestCopy,
  isTemporaryGuest,
  RESTORE_TEST_FIRST_ID,
  RESTORE_TEST_LAST_ID,
  RESTORE_TEST_TAG,
  type RestoreTestReason,
  zonedInstant,
  zonedParts,
} from '@whombat/core';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const GIB = 1024 ** 3;

/** A test a week: six days after the last one started, so one that started late in the quiet hours doesn't skip a week. */
export const TEST_EVERY_MS = 6 * DAY;
/** A test that hasn't come to an outcome in an hour failed. */
export const TEST_MAX_MS = 60 * MIN;
/** A copy whose guest agent was expected may take this long from running to answering. */
export const BOOT_WAIT_MS = 10 * MIN;
/** Without a guest agent to ask, a copy that keeps running this long started (a VM; a container sooner). */
export const VM_SETTLE_MS = 2 * MIN;
export const CT_SETTLE_MS = MIN;
/** A copy asked to start that isn't running after this long didn't start. */
export const START_WAIT_MS = 5 * MIN;
/** A test starts only while at least this much of the quiet hours is left. */
export const START_MARGIN_MIN = 30;

/** A machine whose backups can be tested. */
export interface Candidate {
  id: string;
  name: string;
  kind: 'vm' | 'container';
  /** When its newest backup was made, as the report says; null when none is known. */
  lastBackupAt: string | null;
  /** Its guest agent answered in the last report. */
  agent: boolean;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * The Proxmox VMs and containers of a server that can be tested, from the hosts service's guest list: no templates, no
 * temporary machines or earlier copies, and never the machine this Whombat runs in.
 */
export function eligibleGuests(raw: readonly unknown[]): Candidate[] {
  const out: Candidate[] = [];
  for (const r of raw) {
    const g = obj(r);
    const id = str(g.id);
    const name = str(g.name) ?? id;
    if (!id || !name || g.platform !== 'pve' || !id.startsWith('pve:')) continue;
    if (g.kind !== 'vm' && g.kind !== 'container') continue;
    if (g.template === true || g.self === true) continue;
    const tags = Array.isArray(g.tags) ? g.tags.filter((t): t is string => typeof t === 'string') : [];
    if (isRestoreTestCopy({ id, name, tags }) || isTemporaryGuest({ id, name, platform: 'pve', tags }))
      continue;
    const backup = obj(g.last_backup);
    out.push({
      id,
      name,
      kind: g.kind,
      lastBackupAt: str(backup.at),
      agent: g.guest_agent === 'running',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The machines the person chose (none chosen: all of them). */
export function chosenGuests(eligible: readonly Candidate[], chosen: readonly string[]): Candidate[] {
  return chosen.length ? eligible.filter((g) => chosen.includes(g.id)) : [...eligible];
}

/**
 * Whose turn it is: a machine with a backup before one without, then one never tested, then the one tested longest
 * ago, so every machine comes round in turn.
 */
export function nextGuest(
  candidates: readonly Candidate[],
  lastTested: ReadonlyMap<string, Date>,
): Candidate | null {
  const ranked = [...candidates].sort((a, b) => {
    const backup = Number(!!b.lastBackupAt) - Number(!!a.lastBackupAt);
    if (backup) return backup;
    const at = (lastTested.get(a.id)?.getTime() ?? -1) - (lastTested.get(b.id)?.getTime() ?? -1);
    return at || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
  return ranked[0] ?? null;
}

/** How many minutes of the quiet hours are left at a wall-clock time (0 outside them). */
function minutesLeft(time: string, w: ChangeWindow): number {
  if (!inChangeWindow(time, w)) return 0;
  return (clockMinutes(w.end) - clockMinutes(time) + 1440) % 1440 || 1440;
}

/** The margin a test needs: half of a short window, else half an hour. */
const marginOf = (w: ChangeWindow) => Math.min(START_MARGIN_MIN, Math.floor(changeWindowMinutes(w) / 2));

/** Whether a server's weekly test starts now: inside the quiet hours with time left, a week after the last one. */
export function testDue(now: Date, w: ChangeWindow, timeZone: string, lastStartedAt: Date | null): boolean {
  if (lastStartedAt && now.getTime() - lastStartedAt.getTime() < TEST_EVERY_MS) return false;
  const p = zonedParts(now, timeZone);
  const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  return minutesLeft(time, w) >= Math.max(1, marginOf(w));
}

/** When the next weekly test starts: the first moment of the quiet hours a week after the last test (or now). */
export function nextTestAt(
  now: Date,
  w: ChangeWindow,
  timeZone: string,
  lastStartedAt: Date | null,
): Date | null {
  const earliest = new Date(Math.max(now.getTime(), (lastStartedAt?.getTime() ?? 0) + TEST_EVERY_MS));
  const p = zonedParts(earliest, timeZone);
  const usable = (changeWindowMinutes(w) - Math.max(1, marginOf(w))) * MIN;
  for (let d = -1; d <= 8; d++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + d));
    const start = zonedInstant(
      { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() },
      w.start,
      timeZone,
    );
    if (start.getTime() + usable >= earliest.getTime())
      return new Date(Math.max(start.getTime(), earliest.getTime()));
  }
  return null;
}

/** The first number in the copies' range that no machine on the server has. */
export function freeCopyId(used: Iterable<number>, after = RESTORE_TEST_FIRST_ID - 1): number | null {
  const taken = new Set(used);
  for (let id = Math.max(after + 1, RESTORE_TEST_FIRST_ID); id <= RESTORE_TEST_LAST_ID; id++)
    if (!taken.has(id)) return id;
  return null;
}

/** The Proxmox numbers of a server's guests (`pve:101` is 101). */
export function guestNumbers(raw: readonly unknown[]): number[] {
  return raw.flatMap((r) => {
    const g = obj(r);
    const n = typeof g.vmid === 'number' ? g.vmid : Number(String(g.id ?? '').replace(/^pve:/, ''));
    return Number.isInteger(n) && n > 0 ? [n] : [];
  });
}

/* Settings that touch the server itself ------------------------------------------------------------------------ */

/**
 * Settings that hand a machine parts of the server itself: passed-through PCI and USB devices, parallel ports, shared
 * folders, hook scripts, raw container settings and device nodes. A copy started with them would share them with the
 * real machine.
 */
const HOST_KEYS = /^(hostpci\d+|usb\d+|parallel\d+|virtiofs\d+|dev\d+|hookscript|lxc\..*)$/;
/** Keys that hold a disk, a CD drive or a mount point. */
const DISK_KEYS = /^(ide|sata|scsi|virtio|mp)\d+$|^(rootfs|efidisk0|tpmstate0)$/;

/** The volume a disk value names (`local-lvm:vm-101-disk-0,size=32G`, `file=…`, `volume=…`). */
function volumeOf(value: string): string {
  const parts = value.split(',');
  const named = parts.find((p) => p.startsWith('file=') || p.startsWith('volume='));
  return (named ? named.slice(named.indexOf('=') + 1) : (parts[0] ?? '')).trim();
}

const isCdrom = (value: string) => /(^|,)media=cdrom(,|$)/.test(value);

/** Whether a machine's settings use parts of the server itself (then it isn't tested). */
export function usesHostParts(config: {
  values: Record<string, string>;
  restricted?: readonly string[];
}): boolean {
  const keys = [...Object.keys(config.values), ...(config.restricted ?? [])];
  if (keys.some((k) => HOST_KEYS.test(k))) return true;
  for (const [k, v] of Object.entries(config.values)) {
    if (/^serial\d+$/.test(k) && v !== 'socket') return true;
    if (!DISK_KEYS.test(k)) continue;
    const volume = volumeOf(v);
    // A host path or device, or the server's own CD drive.
    if (volume.startsWith('/') || (volume === 'cdrom' && isCdrom(v))) return true;
  }
  return false;
}

/**
 * Whether a restored copy's disks are all its own: every disk and mount point names a volume made for the copy's number
 * (`vm-990001-disk-0`, `subvol-990001-disk-0`), apart from CD images and empty drives. Anything else would be the real
 * machine's disk.
 */
export function copyOwnsDisks(values: Record<string, string>, copyId: number): boolean {
  const own = new RegExp(`(^|[/:-])(vm|subvol|base)-${copyId}-`);
  for (const [k, v] of Object.entries(values)) {
    if (!DISK_KEYS.test(k)) continue;
    const volume = volumeOf(v);
    if (isCdrom(v) || volume === 'none' || volume === '') continue;
    if (volume.startsWith('/') || !own.test(volume)) return false;
  }
  return true;
}

/* The copy's settings ----------------------------------------------------------------------------------------------- */

const NET_KEY = /^net\d+$/;
const LINK_DOWN = /(^|,)link_down=1(,|$)/;

/** A network card's value with its cable pulled. */
export function linkDown(value: string): string {
  if (LINK_DOWN.test(value)) return value;
  const kept = value
    .split(',')
    .filter((p) => p && !p.startsWith('link_down='))
    .join(',');
  return `${kept},link_down=1`;
}

/** Whether every network card of a machine has its cable pulled. */
export function networkDown(values: Record<string, string>): boolean {
  return Object.entries(values).every(([k, v]) => !NET_KEY.test(k) || LINK_DOWN.test(v));
}

/**
 * What a copy's settings become before it starts: every network card's cable pulled, its name saying what it is, the
 * restore tests' tag, never starting with the server, and not protected from deletion.
 */
export function copySettings(
  kind: 'vm' | 'container',
  values: Record<string, string>,
  copyName: string,
): Record<string, string> {
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(values))
    if (NET_KEY.test(k) && !LINK_DOWN.test(v)) set[k] = linkDown(v);
  const nameKey = kind === 'vm' ? 'name' : 'hostname';
  if (values[nameKey] !== copyName) set[nameKey] = copyName;
  const tags = (values.tags ?? '').split(/[;, ]+/).filter(Boolean);
  if (!tags.includes(RESTORE_TEST_TAG)) set.tags = [...tags, RESTORE_TEST_TAG].join(';');
  if (values.onboot && values.onboot !== '0') set.onboot = '0';
  if (values.protection && values.protection !== '0') set.protection = '0';
  return set;
}

/* Where the copy goes ------------------------------------------------------------------------------------------------- */

export interface StorageFacts {
  id: string;
  content: readonly string[];
  availBytes?: number;
  totalBytes?: number;
}

/**
 * How much room a copy needs: the size of the machine's disks, else a generous multiple of the backup (it is
 * compressed), else nothing known.
 */
export function roomNeeded(diskBytes: number, backupBytes: number | null): number | null {
  if (diskBytes > 0) return diskBytes;
  if (backupBytes && backupBytes > 0) return backupBytes * 3;
  return null;
}

/**
 * The storage the copy goes to: one that holds disks of the kind, with room for the copy and a tenth to spare, which
 * stays under nine tenths full after it; the machine's own storage first, else the one with the most room.
 */
export function storageFor(
  kind: 'vm' | 'container',
  storages: readonly StorageFacts[],
  preferred: readonly string[],
  needBytes: number | null,
): string | null {
  const content = kind === 'vm' ? 'images' : 'rootdir';
  const need = needBytes ?? 20 * GIB;
  const fits = storages.filter((s) => {
    if (!s.content.includes(content) || typeof s.availBytes !== 'number') return false;
    if (s.availBytes < need * 1.1 + GIB) return false;
    if (s.totalBytes && s.totalBytes > 0 && (s.totalBytes - s.availBytes + need) / s.totalBytes > 0.9)
      return false;
    return true;
  });
  for (const id of preferred) if (fits.some((s) => s.id === id)) return id;
  return [...fits].sort((a, b) => (b.availBytes ?? 0) - (a.availBytes ?? 0))[0]?.id ?? null;
}

/** The storages a machine's disks are on, in the order of its settings. */
export function storagesOf(values: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (!DISK_KEYS.test(k) || isCdrom(v)) continue;
    const volume = volumeOf(v);
    const at = volume.indexOf(':');
    if (at > 0 && !volume.startsWith('/')) {
      const id = volume.slice(0, at);
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/* Whether the copy started -------------------------------------------------------------------------------------------- */

export type BootVerdict =
  | { verdict: 'wait'; runningAt: Date | null }
  | { verdict: 'worked'; booted: boolean }
  | { verdict: 'failed'; reason: RestoreTestReason };

/**
 * What a copy's state says about the test: running long enough (and, when the real machine has a guest agent, that
 * agent answering inside the copy) worked; stopping after it ran, not starting, or never answering failed.
 */
export function bootVerdict(input: {
  kind: 'vm' | 'container';
  agentExpected: boolean;
  /** The copy's state in the newest report; null when it is gone. */
  state: string | null;
  guestAgent: boolean;
  /** When it was first seen running. */
  runningAt: Date | null;
  /** When it was asked to start. */
  askedAt: Date;
  now: Date;
}): BootVerdict {
  const { now } = input;
  if (input.state !== 'running') {
    if (input.runningAt) return { verdict: 'failed', reason: 'stopped_by_itself' };
    if (now.getTime() - input.askedAt.getTime() >= START_WAIT_MS)
      return { verdict: 'failed', reason: 'start_failed' };
    return { verdict: 'wait', runningAt: null };
  }
  const since = input.runningAt ?? now;
  const ran = now.getTime() - since.getTime();
  if (input.kind === 'vm' && input.agentExpected) {
    if (input.guestAgent) return { verdict: 'worked', booted: true };
    if (ran >= BOOT_WAIT_MS) return { verdict: 'failed', reason: 'no_boot' };
    return { verdict: 'wait', runningAt: since };
  }
  if (ran >= (input.kind === 'vm' ? VM_SETTLE_MS : CT_SETTLE_MS))
    return { verdict: 'worked', booted: input.kind === 'container' || input.guestAgent };
  return { verdict: 'wait', runningAt: since };
}
