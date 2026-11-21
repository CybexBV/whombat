/**
 * What uses a server's space (Whombat service-settings.md SST-11): from what the hosts data reports today — each
 * machine's and app's own disk (`diskUsedGb`), biggest first, and, on a server with one volume, the rest of its used
 * space as “Everything else”. Temporary machines are left out (server-pages.md SPG-04). Pure; web and phone share it.
 */
import type { HostDisk, HostGuest, HostServerDetail, HostVolume } from '@whombat/core/domain';
import { FORECAST_DATE_DAYS, volumeForecast } from './dashboard-words';
import { formatPct } from './format';
import { storageTotals } from './model';
import { isTemporaryGuest } from './temporary';
import { diskUsedLevel, hostTone, wearLevel } from './thresholds';
import { spaceWords } from './tiles';

export interface SpacePart {
  id: string;
  label: string;
  gb: number;
  /** A machine (a VM or a system container), an app (a Docker container), or the rest. */
  kind: 'machine' | 'app' | 'rest';
  /** The machine's or app's id, for its page. */
  guestId: string | null;
  /** Its share of what the list adds up to, 0…1. */
  share: number;
}

export interface SpaceUse {
  parts: SpacePart[];
  /** What the list adds up to, in GB. */
  totalGb: number;
}

/** How many machines and apps the list names before “N more”. */
export const SPACE_PARTS = 8;

const kindOf = (g: Pick<HostGuest, 'platform'>): 'machine' | 'app' =>
  g.platform === 'docker' ? 'app' : 'machine';

/** What uses the space, biggest first; null when nothing reports its disk. */
export function spaceUse(input: {
  guests: readonly HostGuest[];
  volumes: readonly HostVolume[];
  most?: number;
}): SpaceUse | null {
  const most = input.most ?? SPACE_PARTS;
  const sized = input.guests
    .filter((g) => !isTemporaryGuest(g) && (g.diskUsedGb ?? 0) >= 0.05)
    .sort((a, b) => (b.diskUsedGb ?? 0) - (a.diskUsedGb ?? 0));
  if (!sized.length) return null;
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
  // With one volume the rest of its used space is known; with several, which disk is where isn't.
  const only = input.volumes.length === 1 ? input.volumes[0] : undefined;
  if (only) {
    const known = parts.reduce((s, p) => s + p.gb, 0);
    const rest = only.usedGb - known;
    if (rest >= 1)
      parts.push({ id: 'rest', label: 'Everything else', gb: rest, kind: 'rest', guestId: null });
  }
  const totalGb = parts.reduce((s, p) => s + p.gb, 0);
  return { parts: parts.map((p) => ({ ...p, share: totalGb > 0 ? p.gb / totalGb : 0 })), totalGb };
}

/* The Storage tab's tiles (SST-11) ------------------------------------------------------------------------------- */

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
 * The Storage tab's tiles in words (SST-11): how full (the Summary's own words and warning bands), when it fills up (the
 * hosts service's forecast, the Summary's words), and the disks to watch. Growth over a range needs the volumes' history,
 * which the tab doesn't read: no tile for it. A tile with nothing to go on is left out.
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
