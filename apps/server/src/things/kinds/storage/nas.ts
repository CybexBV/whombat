/**
 * What the NAS kinds' pages share in slots (docs/decisions/service-slots.md, the storage group): the space over the week
 * from Whombat's own readings — TrueNAS, Synology and QNAP keep no history of their used space that Whombat can read
 * cheaply, so the health pass stores the used space of all their pools or volumes as a point every pass
 * (`nas_used_gb`), and the page turns the last of each day into what was added that day —, the Disks line of
 * Inventory, and the NAS as its own machine. Pure, but for reading the points.
 */

import type { ThingPageItem } from '@whombat/core';
import type { Services } from '../../../services';
import type { MachineNow } from '../../machine';
import { readPoints } from '../../points';
import type { RawPoint } from '../../series';
import { fullWords } from '../../series';
import { bytes, clip } from '../../words';
import { countLine, daysWith, lastDays, pointsByDay, type TrendPanel, trend, weekChange } from '../slots';
import type { KindView } from '../types';

/** The used space of every pool or volume together, in GB (decimal). */
export const NAS_USED_KEY = 'nas_used_gb';
/** Two weeks and today: this week's days, the day before them, and the week before for its change. */
const DAYS = 15;
const DAY = 86_400_000;

/** The pass's point: used space in GB, or none when the pools or volumes couldn't be read. */
export function usedPoint(usedBytes: number | null | undefined): Record<string, number> {
  return usedBytes != null && Number.isFinite(usedBytes) && usedBytes >= 0
    ? { [NAS_USED_KEY]: Math.round(usedBytes / 1e7) / 100 }
    : {};
}

/** The points of the last 15 days, oldest first; none when they can't be read (the Trend is left out). */
export async function readSpace(services: Services, rowId: string, now: Date): Promise<RawPoint[]> {
  const got = await readPoints(services.db, rowId, [NAS_USED_KEY], now, DAYS * DAY).catch(() => null);
  return got?.get(NAS_USED_KEY) ?? [];
}

/** “+184 GB”, “−40 GB”, “+1.2 TB”, “0 GB”. */
export function signedSize(gb: number): string {
  if (Math.abs(gb) < 0.05) return '0 GB';
  return `${gb > 0 ? '+' : '−'}${bytes(Math.abs(gb) * 1e9)}`;
}

/** What was added each day: the day's last reading less the day before's; null when either has none. */
function addedPerDay(levels: readonly (number | null)[]): (number | null)[] {
  return levels.slice(1).map((v, i) => {
    const before = levels[i];
    return v === null || before === null || before === undefined ? null : Math.round((v - before) * 10) / 10;
  });
}

const sum = (xs: readonly (number | null)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);

/**
 * Trend “Space used”: violet bars of the GB added each day this week (a day that freed space draws none), the week's
 * net as its figure (“+184 GB”, “−40 GB”), the change on the week before when both weeks grew and Whombat has both, and
 * when it is full at this week's pace. Left out with fewer than two days to draw.
 */
export function spaceWeek(p: {
  points: readonly RawPoint[];
  now: Date;
  timeZone: string;
  /** Free space left on all of them, for “Full in about 5 months”. */
  freeBytes?: number | null;
  /** What is counted, for the line over it: “All pools”, “All volumes”. */
  what: string;
}): TrendPanel | null {
  const days = lastDays(p.now, p.timeZone, DAYS);
  const added = addedPerDay(pointsByDay(p.points, days.keys, p.timeZone, 'last'));
  const week = added.slice(-7);
  if (daysWith(week) < 2) return null;
  const before = added.slice(0, 7);
  const net = Math.round(sum(week) * 10) / 10;
  const was = sum(before);
  const change = net > 0 && daysWith(before) >= 6 ? weekChange(net, was) : null;
  // At this week's pace, over the days Whombat has.
  const perDay = net / daysWith(week);
  const full =
    perDay > 0.05 && p.freeBytes != null && p.freeBytes > 0
      ? new Date(p.now.getTime() + (p.freeBytes / (perDay * 1e9)) * DAY)
      : null;
  const meta =
    full && full.getTime() - p.now.getTime() < 3 * 365 * DAY ? fullWords(full, p.now, p.timeZone) : p.what;
  return trend({
    id: 'week',
    title: 'Space used',
    meta,
    days: { at: days.at.slice(-7), labels: days.labels.slice(-7) },
    // Bars start at zero: a day that freed space draws none; the figure says the week's net.
    values: week.map((v) => (v === null ? null : Math.max(0, v))),
    label: 'Added',
    unit: 'GB',
    color: 'violet',
    figure: { value: signedSize(net), rest: 'this week' },
    change,
  });
}

/**
 * A NAS is its own machine: with its own figures (processor, memory), the page draws “The machine” under its name
 * without a link when Whombat watches no machine it runs on. Never its pools in the card's Disk: they are Inventory's.
 */
export function withOwn(
  slotted: Pick<KindView, 'panels' | 'slots'>,
  own: MachineNow | null,
  name: string,
): Pick<KindView, 'panels' | 'slots'> {
  return {
    panels: slotted.panels,
    slots: {
      machine: slotted.slots?.machine ?? [],
      ...(own
        ? { own: { figures: { ...own, diskUsedGb: null, diskTotalGb: null }, name: clip(name, 120) } }
        : {}),
    },
  };
}

/** A disk as the Disks line counts it: its health as a tone, and how warm it is. */
export interface DiskState {
  health: 'ok' | 'warn' | 'bad';
  tempC: number | null;
  /** Its temperature as a tone (`tempTone`). */
  warm: 'warn' | 'bad' | undefined;
}

/**
 * Inventory's Disks line: how many, and the worst of them in a few words — failing (red), too hot (red), needing a look
 * (amber), warm (amber) — else “All fine” with the warmest.
 */
export function disksLine(
  disks: readonly DiskState[],
  url: string,
  failing = 'needs replacing',
): ThingPageItem {
  const n = (f: (d: DiskState) => boolean) => disks.filter(f).length;
  const words = (k: number, one: string, many: string) => (k === 1 ? `1 ${one}` : `${k} ${many}`);
  const bad = n((d) => d.health === 'bad');
  const hot = n((d) => d.warm === 'bad');
  const look = n((d) => d.health === 'warn');
  const warm = n((d) => d.warm === 'warn');
  const temps = disks.map((d) => d.tempC).filter((t): t is number => t !== null);
  const [note, tone]: [string, 'warn' | 'bad' | undefined] = bad
    ? [words(bad, failing, failing.replace(/^needs /, 'need ').replace(/^is /, 'are ')), 'bad']
    : hot
      ? [words(hot, 'runs too hot', 'run too hot'), 'bad']
      : look
        ? [words(look, 'needs a look', 'need a look'), 'warn']
        : warm
          ? [words(warm, 'runs warm', 'run warm'), 'warn']
          : [
              temps.length ? `All fine · warmest ${Math.round(Math.max(...temps))} °C` : 'All fine',
              undefined,
            ];
  return countLine({
    id: 'disks',
    title: 'Disks',
    icon: 'disk',
    ...(tone ? { tone } : {}),
    value: String(disks.length),
    note,
    ...(tone ? { noteTone: tone } : {}),
    url,
  });
}
