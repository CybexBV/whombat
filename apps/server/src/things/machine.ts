/**
 * The machine a connection runs on, on its Summary (dashboards.md DS-10; dashboards-server.md DS-S05): figures CPU and
 * Memory with a small line of the range, Disk with a bar and where it is heading, and chart cards CPU (blue, a wash)
 * and Memory (violet, a wash) before the kind's own. Any connection with a `runsOn` gets them; Home Assistant passes its
 * Supervisor's figures when Whombat doesn't watch its machine. Pure.
 */
import type { ThingPageBar, ThingPageKpi, ThingPagePanel } from '@whombat/core';
import { DAY_MS } from './backup-rhythm';
import type { ChartPanel } from './kinds/types';
import type { KindNotice } from './quiet/types';
import type { MachineFigures } from './runs-on';
import {
  avgPeakLines,
  downsample,
  drawable,
  inAbout,
  lastValue,
  pctStat,
  seriesStats,
  statFigure,
  statsOf,
} from './series';
import { clip, figure, figure1, pct, plural, span } from './words';

/** What the machine's panels need: its figures now and its CPU and memory over the range. */
export type MachineNow = Pick<
  MachineFigures,
  'cpuPct' | 'cores' | 'memoryUsedGb' | 'memoryTotalGb' | 'diskUsedGb' | 'diskTotalGb' | 'series'
>;

/** Small facts under a chart: a guest's own processes (“homeassistant 1.6 %”). */
export type ChartFoot = NonNullable<ChartPanel['foot']>;

/** Amber from 75 %, red from 90 % (CP-S10). */
export const diskTone = (p: number) => (p >= 90 ? ('bad' as const) : p >= 75 ? ('warn' as const) : undefined);

/** The disk now, used and in all, when both are known. */
export function diskNow(m: MachineNow | null): { used: number; total: number } | null {
  return m?.diskUsedGb != null && m.diskTotalGb ? { used: m.diskUsedGb, total: m.diskTotalGb } : null;
}

const coresWords = (m: MachineNow) => (m.cores ? `of ${plural(m.cores, 'core')}` : undefined);
const gbTotal = (n: number) => figure(Math.round(n * 10) / 10);

/** Figures CPU, Memory and Disk (each when known); `full` is when the disk is full at this pace. */
export function machineKpis(m: MachineNow, full: Date | null, now: Date): ThingPageKpi[] {
  const out: ThingPageKpi[] = [];
  const cpuLine = m.series?.cpu ?? [];
  const memLine = m.series?.memoryGb ?? [];
  const cpu = m.cpuPct ?? lastValue(cpuLine);
  if (cpu !== null) {
    const of = coresWords(m);
    out.push({
      key: 'cpu',
      label: 'CPU',
      value: pct(cpu),
      ...(of ? { sub: of } : {}),
      ...(drawable(cpuLine) ? { spark: downsample(cpuLine), color: 'blue' as const } : {}),
    });
  }
  const used = m.memoryUsedGb ?? lastValue(memLine);
  if (used !== null)
    out.push({
      key: 'memory',
      label: 'Memory',
      value: figure1(used),
      rest: m.memoryTotalGb ? `/ ${gbTotal(m.memoryTotalGb)} GB` : 'GB',
      ...(m.memoryTotalGb ? { sub: `${pct((used / m.memoryTotalGb) * 100)} used` } : {}),
      ...(drawable(memLine) ? { spark: downsample(memLine), color: 'violet' as const } : {}),
    });
  const disk = diskNow(m);
  if (disk) {
    const p = (disk.used / disk.total) * 100;
    const tone = diskTone(p);
    out.push({
      key: 'disk',
      label: 'Disk',
      value: figure(Math.round(disk.used)),
      rest: `/ ${figure(Math.round(disk.total))} GB`,
      sub: full ? `${pct(p)} · full ${inAbout(full, now)}` : `${pct(p)} used`,
      meter: Math.min(1, Math.max(0, disk.used / disk.total)),
      ...(tone ? { tone } : { color: 'blue' as const }),
    });
  }
  return out;
}

/** Chart cards CPU and Memory over the range (each when it has a line to draw). */
export function machineCharts(
  m: MachineNow,
  ctx: { now: Date; timeZone: string; foot?: { cpu?: ChartFoot; memory?: ChartFoot } },
): ChartPanel[] {
  const series = m.series;
  if (!series || series.timestamps.length < 2) return [];
  const out: ChartPanel[] = [];
  const timestamps = series.timestamps.slice(-600);
  const cpuLine = series.cpu.slice(-600);
  if (drawable(cpuLine)) {
    const now = m.cpuPct ?? lastValue(cpuLine);
    const of = coresWords(m);
    out.push({
      kind: 'chart',
      id: 'cpu',
      place: 'chart',
      span: 1,
      title: 'CPU',
      timestamps,
      series: [
        {
          key: 'cpu',
          label: 'CPU',
          unit: '%',
          values: cpuLine,
          color: 'blue',
          fill: true,
          ...(now !== null ? { latest: pct(now) } : {}),
        },
      ],
      ...(now !== null ? { figure: { value: pct(now), ...(of ? { rest: of } : {}) } } : {}),
      ...statsOf(avgPeakLines(seriesStats(cpuLine, timestamps), pctStat, ctx.now, ctx.timeZone)),
      axis: { min: 0, unit: '%' },
      ...(ctx.foot?.cpu?.length ? { foot: ctx.foot.cpu.slice(0, 4) } : {}),
    });
  }
  const memLine = series.memoryGb.slice(-600);
  if (drawable(memLine)) {
    const now = m.memoryUsedGb ?? lastValue(memLine);
    const gb = (n: number) => `${statFigure(n)} GB`;
    out.push({
      kind: 'chart',
      id: 'memory',
      place: 'chart',
      span: 1,
      title: 'Memory',
      timestamps,
      series: [
        {
          key: 'memory',
          label: 'Memory',
          unit: 'GB',
          values: memLine,
          color: 'violet',
          fill: true,
          ...(now !== null ? { latest: `${figure1(now)} GB` } : {}),
        },
      ],
      ...(now !== null
        ? {
            figure: {
              value: `${figure1(now)} GB`,
              ...(m.memoryTotalGb ? { rest: `of ${gbTotal(m.memoryTotalGb)} GB` } : {}),
            },
          }
        : {}),
      ...statsOf(avgPeakLines(seriesStats(memLine, timestamps), gb, ctx.now, ctx.timeZone)),
      axis: {
        min: 0,
        ...(m.memoryTotalGb ? { max: Math.round(m.memoryTotalGb * 10) / 10 } : {}),
        unit: 'GB',
      },
      ...(ctx.foot?.memory?.length ? { foot: ctx.foot.memory.slice(0, 4) } : {}),
    });
  }
  return out;
}

/** A forecast this near is a problem; further off it is a heads-up (quiet-notices.md QN-04; QN-S11). */
export const DISK_SOON_DAYS = 7;
/** The forecast's bands: within 60, 30 and 7 days (a nearer band is worse). */
function forecastBand(days: number): number {
  return days <= DISK_SOON_DAYS ? 3 : days <= 30 ? 2 : 1;
}

/**
 * “Disk 80 % full” (a grey heads-up from 75 %, red from 90 %) or “Disk full in about 3 weeks” when it is full within 60 days at
 * this pace; null otherwise. `where` names the machine in the detail; `detail` replaces it.
 *
 * Its kind of line (QN-01, QN-04, QN-S11): from 90 % a problem (`machine.disk`, band 90), at 75–89 % a heads-up (band
 * 75: the hub calls 80 % a hint too), a forecast within a week a problem and further off a heads-up
 * (`machine.disk_forecast`, bands 1…3 for 60, 30 and 7 days). An Ignore lasts until it gets fuller (a higher band) or
 * there is room again.
 */
export function diskNotice(
  m: MachineNow | null,
  full: Date | null,
  ctx: { now: Date; timeZone: string; where?: string; detail?: string; question: string },
): KindNotice | null {
  const disk = diskNow(m);
  if (!disk) return null;
  const p = (disk.used / disk.total) * 100;
  const tone = diskTone(p);
  const days = full !== null ? (full.getTime() - ctx.now.getTime()) / 86_400_000 : null;
  const soon = days !== null && days <= 60;
  if (!tone && !soon) return null;
  const detail = (
    ctx.detail ??
    `${figure(Math.round(disk.used))} GB of ${figure(Math.round(disk.total))} GB used${ctx.where ? ` on ${ctx.where}` : ''}`
  ).slice(0, 200);
  const link = { kind: 'ask' as const, label: 'Look into it', question: ctx.question.slice(0, 300) };
  if (soon && full && days !== null) {
    const near = days <= DISK_SOON_DAYS;
    return {
      id: 'disk',
      tone: tone ?? (near ? 'warn' : 'info'),
      icon: 'disk',
      title: `Disk full ${inAbout(full, ctx.now)}`,
      detail,
      ...(near || tone ? { link } : {}),
      nature: near || tone === 'bad' ? 'problem' : 'fyi',
      check: 'machine.disk_forecast',
      band: forecastBand(days),
      ignore: { lifts: 'fixed', words: 'Until it’s nearer.' },
    };
  }
  const high = tone === 'bad';
  // 75–89 % with no fill-up in sight is a heads-up the person needn't act on this week: grey, not amber.
  return {
    id: 'disk',
    tone: high ? 'bad' : 'info',
    icon: 'disk',
    title: `Disk ${pct(p)} full`,
    detail,
    ...(high ? { link } : {}),
    nature: high ? 'problem' : 'fyi',
    check: 'machine.disk',
    band: high ? 90 : 75,
    ignore: high
      ? { lifts: 'fixed', words: 'Until there’s room again.' }
      : { lifts: 'fixed', words: 'Until it gets fuller.' },
  };
}

type MachineBackup = Pick<MachineFigures, 'lastBackup' | 'backupJob' | 'backupRhythmMs' | 'name'>;

function backupAge(backup: MachineBackup | null, now: Date): number | null {
  const age = now.getTime() - Date.parse(backup?.lastBackup?.at ?? '');
  return Number.isFinite(age) && age >= 0 ? age : null;
}

const ageWords = (age: number) => (age < 60_000 ? 'just now' : `${span(age)} ago`);

function backupWords(backup: MachineBackup | null, now: Date): string | null {
  const age = backupAge(backup, now);
  if (age !== null)
    return backup?.lastBackup?.result === 'error'
      ? `Backup failed ${ageWords(age)}`
      : `Backed up ${ageWords(age)}`;
  if (backup?.backupJob === false) return 'Nothing backs this up';
  return backup?.backupJob ? 'No backup seen yet' : null;
}

/** A machine covered by a job whose last backup is more than two runs old (eight days when its schedule is unknown). */
export function backupNotice(backup: MachineBackup | null, now: Date): KindNotice | null {
  if (!backup?.backupJob) return null;
  const age = backupAge(backup, now);
  const limit = backup.backupRhythmMs ? 2 * backup.backupRhythmMs : 8 * DAY_MS;
  if (age === null || age <= limit) return null;
  const words = backupWords(backup, now);
  return {
    id: 'backup-old',
    tone: 'warn',
    icon: 'backup',
    title: 'The machine’s backup is overdue',
    ...(words ? { detail: clip(`${backup.name} · ${words}`, 200) } : {}),
    check: 'machine.backup_old',
    nature: 'problem',
    link: {
      kind: 'ask',
      label: 'Look into it',
      question: clip(`Why is the backup of ${backup.name} overdue?`, 300),
    },
    ignore: { lifts: 'fixed', words: 'Until it’s backed up again.' },
  };
}

/** Gigabytes as a size: “870 GB”, “7.1 TB” from a thousand up. */
function size(gb: number): string {
  return gb >= 1000 ? `${figure1(gb / 1000)} TB` : `${figure(Math.round(gb))} GB`;
}

/** Used of all in one unit: “5.2 of 16 GB”, “7.1 of 12 TB”. */
function sizeOf(used: number, total: number): string {
  if (total >= 1000) return `${figure1(used / 1000)} of ${figure(Math.round(total / 1000))} TB`;
  return `${figure1(used)} of ${figure(Math.round(total))} GB`;
}

/**
 * “The machine” card of a service in slots (docs/decisions/service-slots.md): its processor, memory and disk with how
 * full each is, and the service's own lines after them (Plex's version); linked to the machine's page. Null without
 * one figure to show.
 */
export function machineCard(
  m: MachineNow,
  /** What it runs on; without `href` (a machine Whombat doesn't know) the card has no link. */
  at: { name: string; href?: string },
  full: Date | null,
  now: Date,
  own: readonly ThingPageBar[] = [],
  backup: MachineBackup | null = null,
): Extract<ThingPagePanel, { kind: 'bars' }> | null {
  const items: ThingPageBar[] = [];
  const cpu = m.cpuPct ?? lastValue(m.series?.cpu ?? []);
  if (cpu !== null)
    items.push({
      id: 'cpu',
      label: 'Processor',
      ...(m.cores ? { note: `of ${plural(m.cores, 'core')}` } : {}),
      value: pct(cpu),
      pct: Math.min(1, Math.max(0, cpu / 100)),
    });
  const used = m.memoryUsedGb ?? lastValue(m.series?.memoryGb ?? []);
  if (used !== null)
    items.push({
      id: 'memory',
      label: 'Memory',
      value: m.memoryTotalGb ? sizeOf(used, m.memoryTotalGb) : size(used),
      pct: m.memoryTotalGb ? Math.min(1, Math.max(0, used / m.memoryTotalGb)) : null,
    });
  const disk = diskNow(m);
  if (disk) {
    const tone = diskTone((disk.used / disk.total) * 100);
    items.push({
      id: 'disk',
      label: 'Disk',
      value: sizeOf(disk.used, disk.total),
      pct: Math.min(1, Math.max(0, disk.used / disk.total)),
      ...(tone ? { tone } : {}),
      ...(full ? { sub: `Full ${inAbout(full, now)}`, ...(tone ? { subTone: tone } : {}) } : {}),
    });
  }
  const backedUp = backupWords(backup, now);
  if (backedUp) items.push({ id: 'backup', label: backedUp });
  if (!items.length) return null;
  return {
    kind: 'bars',
    id: 'machine',
    place: 'chart',
    span: 1,
    title: 'The machine',
    meta: clip(at.name, 120),
    ...(at.href ? { link: { kind: 'href' as const, label: clip(`See ${at.name}`, 30), href: at.href } } : {}),
    items: [...items, ...own].slice(0, 40),
  };
}

/**
 * The card of a service in slots when Whombat knows no machine it runs on and the service gives no figures of its own:
 * “Protect itself” with only the kind's lines (its version, “Up to date”). Null without a line.
 */
export function itselfCard(
  name: string,
  own: readonly ThingPageBar[],
): Extract<ThingPagePanel, { kind: 'bars' }> | null {
  if (!own.length) return null;
  return {
    kind: 'bars',
    id: 'machine',
    place: 'chart',
    span: 1,
    title: clip(`${name} itself`, 60),
    items: own.slice(0, 40),
  };
}
