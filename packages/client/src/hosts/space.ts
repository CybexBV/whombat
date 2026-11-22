/**
 * What uses a server's space: each machine's and app's own disk (`diskUsedGb`), biggest first, and — on a server with
 * one volume — the rest of its used space as “Everything else”. When a recent on-request disk breakdown exists, it
 * replaces “Everything else” with what was measured (container images, build cache, volumes, logs, system journal,
 * package caches, VM disks/snapshots and largest folders) together with when it was measured. Temporary machines are
 * left out. Pure; web and phone share it.
 */
import type { HostDisk, HostDiskUsage, HostGuest, HostServerDetail, HostVolume } from '@whombat/core/domain';
import { FORECAST_DATE_DAYS, volumeForecast } from './dashboard-words';
import { formatGb, formatPct } from './format';
import { storageTotals } from './model';
import { isTemporaryGuest } from './temporary';
import { diskUsedLevel, hostTone, wearLevel } from './thresholds';
import { spaceWords } from './tiles';

export interface SpacePart {
  id: string;
  label: string;
  gb: number;
  /** A machine, an app, a measured storage category, a large folder, or the rest. */
  kind: 'machine' | 'app' | 'category' | 'folder' | 'rest';
  /** The machine's or app's id, for its page. */
  guestId: string | null;
  /** Short plain note when helpful (e.g. “6 GB reclaimable” or “apt”). */
  detail?: string;
  /** Its share of what the list adds up to, 0…1. */
  share: number;
}

export interface SpaceUse {
  parts: SpacePart[];
  /** What the list adds up to, in GB. */
  totalGb: number;
  /** ISO timestamp of the recent on-request breakdown shown here, if any. */
  measuredAt?: string;
  /** Mount point of the shown breakdown (useful when a server has several volumes). */
  measuredMount?: string;
  /** True when the on-request scan stopped early at its time, depth or entry limit. */
  partial?: boolean;
}

/** How many machines and apps the list names before “N more”. */
export const SPACE_PARTS = 8;

/** How long an on-request disk breakdown counts as recent (matches the hub's 24 h window). */
export const DISK_USAGE_RECENT_MS = 24 * 60 * 60 * 1000;

/** Maximum number of measured category and folder rows shown together. */
const BREAKDOWN_PARTS = 8;

const GB_BYTES = 1e9;

const kindOf = (g: Pick<HostGuest, 'platform'>): 'machine' | 'app' =>
  g.platform === 'docker' ? 'app' : 'machine';

/** Directories already covered by recognised categories so folder rows don't repeat them. */
function folderOverlapsCategories(
  path: string,
  categoryKeys: ReadonlySet<string>,
  hasSizedMachines: boolean,
): boolean {
  const match = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  const hasDocker =
    categoryKeys.has('container_images') ||
    categoryKeys.has('container_build_cache') ||
    categoryKeys.has('container_volumes') ||
    categoryKeys.has('container_logs');
  if (hasDocker && (match('/var/lib/docker') || match('/var/lib/containers') || match('/var/log/pods')))
    return true;
  if (categoryKeys.has('journal') && (match('/var/log/journal') || match('/run/log/journal'))) return true;
  if (
    categoryKeys.has('package_cache') &&
    (match('/var/cache/apt') ||
      match('/var/cache/dnf') ||
      match('/var/cache/libdnf5') ||
      match('/var/cache/yum') ||
      match('/var/cache/pacman') ||
      match('/var/cache/zypp') ||
      match('/var/cache/apk') ||
      match('/var/cache/xbps') ||
      match('/Library/Caches/Homebrew') ||
      match('/opt/homebrew/Caches'))
  )
    return true;
  if (
    (categoryKeys.has('vm_disks') || hasSizedMachines) &&
    (match('/var/lib/libvirt/images') ||
      match('/var/lib/vz/images') ||
      match('/var/lib/vz/private') ||
      match('/var/lib/incus/storage-pools'))
  )
    return true;
  if (
    categoryKeys.has('vm_snapshots') &&
    (match('/var/lib/libvirt/qemu/snapshot') || match('/var/lib/libvirt/qemu/save'))
  )
    return true;
  return false;
}

/** Plain-English note when an on-request disk usage scan skipped without measuring; null when it ran. */
export function diskUsageSkipNote(
  usage: Pick<HostDiskUsage, 'ok' | 'code' | 'message' | 'skippedSpunDown'>,
): string | null {
  if (usage.ok !== false && !usage.code) return null;
  const msg = usage.message?.trim();
  if (msg) return msg;
  if (usage.code === 'spun_down') {
    const disks = usage.skippedSpunDown ?? [];
    if (disks.length === 1) return `Skipped because ${disks[0]} is asleep; sleeping disks aren’t woken.`;
    if (disks.length > 1)
      return `Skipped because ${disks.slice(0, -1).join(', ')} and ${disks.at(-1)} are asleep; sleeping disks aren’t woken.`;
    return 'Skipped because a backing disk is asleep; sleeping disks aren’t woken.';
  }
  if (usage.code === 'standby_unknown') {
    return 'Skipped because Whombat can’t tell whether the disk is asleep; sleeping disks aren’t woken.';
  }
  return 'Could not check what fills this disk.';
}

/** Pick the freshest recent breakdown (preferring the matching mount when there is one volume). */
export function recentDiskUsage(
  list: readonly HostDiskUsage[] | undefined,
  volumes: readonly HostVolume[],
  now?: number,
): HostDiskUsage | null {
  if (!list?.length) return null;
  const recent = list
    .filter((u) => {
      if (u.ok === false || u.code || !u.mount) return false;
      const t = Date.parse(u.measuredAt);
      if (!Number.isFinite(t)) return false;
      if (now !== undefined) {
        const age = now - t;
        if (age > DISK_USAGE_RECENT_MS || age < -60 * 60 * 1000) return false;
      }
      return u.categories.length > 0 || u.folders.length > 0;
    })
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt));
  if (!recent.length) return null;
  if (volumes.length === 1) {
    const only = volumes[0];
    const exact = only
      ? recent.find((u) => u.mount === only.label || `fs:${u.mount}` === only.entity)
      : undefined;
    if (exact) return exact;
  }
  return recent[0] ?? null;
}

/** What uses the space, biggest first; null when neither guests nor a recent breakdown report space. */
export function spaceUse(input: {
  guests: readonly HostGuest[];
  volumes: readonly HostVolume[];
  diskUsage?: readonly HostDiskUsage[];
  now?: number;
  most?: number;
}): SpaceUse | null {
  const most = input.most ?? SPACE_PARTS;
  const sized = input.guests
    .filter((g) => !isTemporaryGuest(g) && (g.diskUsedGb ?? 0) >= 0.05)
    .sort((a, b) => (b.diskUsedGb ?? 0) - (a.diskUsedGb ?? 0));
  const breakdown = recentDiskUsage(input.diskUsage, input.volumes, input.now);

  if (!sized.length && !breakdown) return null;

  const parts: Omit<SpacePart, 'share'>[] = sized.slice(0, most).map((g) => ({
    id: `guest:${g.id}`,
    label: g.name,
    gb: g.diskUsedGb ?? 0,
    kind: kindOf(g),
    guestId: g.id,
  }));
  const more = sized.slice(most);
  if (more.length) {
    const apps = more.every((g) => kindOf(g) === 'app');
    const machines = more.every((g) => kindOf(g) === 'machine');
    const word = apps
      ? more.length === 1
        ? 'app'
        : 'apps'
      : machines
        ? more.length === 1
          ? 'machine'
          : 'machines'
        : 'more';
    parts.push({
      id: 'more',
      label: apps || machines ? `${more.length} more ${word}` : `${more.length} more`,
      gb: more.reduce((s, g) => s + (g.diskUsedGb ?? 0), 0),
      kind: apps ? 'app' : 'machine',
      guestId: null,
    });
  }

  const only = input.volumes.length === 1 ? input.volumes[0] : undefined;
  const hasSizedMachines = sized.some((g) => kindOf(g) === 'machine');

  if (breakdown) {
    const categoryKeys = new Set<string>();
    const measuredParts: Omit<SpacePart, 'share'>[] = [];

    for (const c of breakdown.categories) {
      const gb = c.bytes / GB_BYTES;
      if (gb < 0.05) continue;
      // Avoid double-counting VM disks when individual VMs are already listed above.
      if (c.key === 'vm_disks' && hasSizedMachines) continue;
      categoryKeys.add(c.key);
      const reclaimGb = (c.reclaimableBytes ?? 0) / GB_BYTES;
      const detail = reclaimGb >= 0.1 ? `${formatGb(reclaimGb)} reclaimable` : c.detail || undefined;
      measuredParts.push({
        id: `cat:${c.key}`,
        label: c.label,
        gb,
        kind: 'category',
        guestId: null,
        ...(detail ? { detail } : {}),
      });
    }

    for (const f of breakdown.folders) {
      const gb = f.bytes / GB_BYTES;
      if (gb < 0.05) continue;
      if (folderOverlapsCategories(f.path, categoryKeys, hasSizedMachines)) continue;
      measuredParts.push({
        id: `folder:${f.path}`,
        label: f.path,
        gb,
        kind: 'folder',
        guestId: null,
      });
    }

    measuredParts.sort((a, b) => b.gb - a.gb);
    const shownMeasured = measuredParts.slice(0, BREAKDOWN_PARTS);
    parts.push(...shownMeasured);

    // Show any remaining unaccounted space on the measured volume (or single volume).
    const usedGb = breakdown.usedBytes > 0 ? breakdown.usedBytes / GB_BYTES : only ? only.usedGb : 0;
    const accounted = parts.reduce((s, p) => s + p.gb, 0);
    const rest = usedGb - accounted;
    if (rest >= 1) {
      parts.push({
        id: 'rest',
        label: shownMeasured.length ? 'Other' : 'Everything else',
        gb: rest,
        kind: 'rest',
        guestId: null,
      });
    }

    if (!parts.length) return null;
    const totalGb = parts.reduce((s, p) => s + p.gb, 0);
    return {
      parts: parts.map((p) => ({ ...p, share: totalGb > 0 ? p.gb / totalGb : 0 })),
      totalGb,
      measuredAt: breakdown.measuredAt,
      measuredMount: breakdown.mount,
      ...(breakdown.partial ? { partial: true } : {}),
    };
  }

  // Without a recent breakdown: on a single volume, show the remainder as “Everything else”.
  if (only) {
    const known = parts.reduce((s, p) => s + p.gb, 0);
    const rest = only.usedGb - known;
    if (rest >= 1)
      parts.push({ id: 'rest', label: 'Everything else', gb: rest, kind: 'rest', guestId: null });
  }
  const totalGb = parts.reduce((s, p) => s + p.gb, 0);
  return { parts: parts.map((p) => ({ ...p, share: totalGb > 0 ? p.gb / totalGb : 0 })), totalGb };
}

/* The Storage tab's tiles ---------------------------------------------------------------------------------------- */

/** How a disk is doing in a word: failing (SMART or the hub says so), wear high (the wear warning), else healthy. */
export function diskHealth(d: HostDisk): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  if (d.health === 'failing' || d.smart?.passed === false) return { tone: 'bad', text: 'Failing' };
  const wear = hostTone(wearLevel(d.wearPct));
  if (d.health === 'wear_high' || wear === 'warn' || wear === 'bad')
    return { tone: wear === 'bad' ? 'bad' : 'warn', text: 'Wear high' };
  return { tone: 'ok', text: 'Healthy' };
}

export interface SpaceTile {
  key: 'space' | 'full' | 'disks';
  label: string;
  /** In words: “Filling up”, “About 5 months”, “1 to watch”. */
  value: string;
  sub: string | null;
  tone: 'warn' | 'bad' | null;
}

/** The volumes a person thinks of as the server's space: writable, at least a GB. */
export function spaceVolumes(volumes: readonly HostVolume[]): HostVolume[] {
  return volumes.filter((v) => v.totalGb >= 1 && !v.readOnly && !v.remote);
}

const quoted = (label: string) => `‘${label}’`;

/**
 * The Storage tab's tiles in words: how full (the Summary's own words and warning bands), when it fills up (the hosts
 * service's forecast, the Summary's words), and the disks to watch. A tile with nothing to go on is left out.
 */
export function spaceTiles(input: { detail: HostServerDetail; now: number; timeZone?: string }): SpaceTile[] {
  const { detail } = input;
  const tiles: SpaceTile[] = [];
  const volumes = spaceVolumes(detail.health?.volumes ?? []);
  const totals = storageTotals(detail);
  if (totals?.totalGb) {
    const pct = (totals.usedGb / totals.totalGb) * 100;
    const tone = hostTone(diskUsedLevel(pct));
    const fullest = [...volumes].sort((a, b) => b.usedPct - a.usedPct)[0];
    tiles.push({
      key: 'space',
      label: 'Space',
      value: spaceWords(pct),
      sub: fullest
        ? `${quoted(fullest.label)} is ${formatPct(fullest.usedPct)} full`
        : `${formatPct(100 - pct)} free`,
      tone: tone === 'warn' || tone === 'bad' ? tone : null,
    });
  }
  if (volumes.length) {
    let soonest: { days: number; words: string; label: string } | null = null;
    for (const v of volumes) {
      const f = volumeForecast({
        fullInDays: v.fullInDays,
        now: input.now,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      });
      if (f.fullInDays != null && f.words && (!soonest || f.fullInDays < soonest.days))
        soonest = { days: f.fullInDays, words: f.words, label: v.label };
    }
    if (soonest) {
      // “Full in about 5 months” → Full in · About 5 months; “Full about 18 Dec” → Full by · About 18 Dec.
      const dated = !soonest.words.startsWith('Full in ');
      const rest = soonest.words.replace(/^Full (in )?/, '');
      tiles.push({
        key: 'full',
        label: dated ? 'Full by' : 'Full in',
        value: rest.charAt(0).toUpperCase() + rest.slice(1),
        sub: volumes.length > 1 ? `${quoted(soonest.label)} first` : quoted(soonest.label),
        tone: soonest.days < FORECAST_DATE_DAYS ? 'warn' : null,
      });
    } else tiles.push({ key: 'full', label: 'Full in', value: 'Not filling up', sub: null, tone: null });
  }
  if (detail.disks.length) {
    const health = detail.disks.map(diskHealth);
    const failing = health.filter((h) => h.tone === 'bad').length;
    const watch = health.filter((h) => h.tone !== 'ok').length;
    const healthy = health.length - watch;
    tiles.push({
      key: 'disks',
      label: 'Disks',
      value: failing ? `${failing} failing` : watch ? `${watch} to watch` : 'All healthy',
      sub: watch ? `${healthy} healthy` : `${health.length} ${health.length === 1 ? 'disk' : 'disks'}`,
      tone: failing ? 'bad' : watch ? 'warn' : null,
    });
  }
  return tiles;
}
