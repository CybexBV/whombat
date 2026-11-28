/**
 * QNAP's page (service-dashboards.md SD-53, SD-S17): its volumes and how full they are, its disks with their health
 * and temperature, and how warm the box is. QTS answers CGI calls in XML only; read as python-qnapstats does, signed in
 * as the connection's user (its session, `sid`): `management/manaRequest.cgi?subfunc=sysinfo` (model, firmware,
 * temperatures, uptime) and `…&sysHealth=1`, `disk/qsmart.cgi?func=all_hd_data` (each disk's health and temperature)
 * and `management/chartReq.cgi?chart_func=disk_usage` (each volume's size and free space). QTS has no volume state
 * in these reads: a volume is worth a look when it is nearly full. Read only.
 */
import type {
  ThingLine,
  ThingPageBar,
  ThingPageItem,
  ThingPageKpi,
  ThingPagePanel,
  ThingPageRow,
} from '@whombat/core';
import { xmlElementText } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import type { MachineNow } from '../../machine';
import type { KindCheck } from '../../quiet/types';
import type { RawPoint } from '../../series';
import { bytes, clip, line, num, pct, plural, span } from '../../words';
import { cachedRead, KIND_DEADLINE_MS, latestRead, problemOf, ReadProblem, withDeadline } from '../read';
import type { KindModule } from '../registry';
import { countLine, inventory, slotPanels } from '../slots';
import type { KindCtx, KindView } from '../types';
import { fixed, fullness, itemLines, type KindNotice, lookInto, UNTIL, worstOf } from './lines';
import { disksLine, readSpace, spaceWeek, usedPoint, withOwn } from './nas';
import { optional, readText } from './net';
import {
  cardOf,
  celsius,
  fullTone,
  seenOf,
  serviceUrl,
  statusOf,
  tempTone,
  unreadView,
  usedKpi,
  usedOf,
  worstFirst,
} from './shared';

const NAME = 'QNAP';
/** The box is too warm: amber from 60 °C, red from 70 °C (its board); its CPU from 85 °C and 95 °C (SD-S17). */
export const SYSTEM_WARM_C = 60;
export const SYSTEM_HOT_C = 70;
export const CPU_WARM_C = 85;
export const CPU_HOT_C = 95;
const DISKS_MAX = 40;

/* Reading ------------------------------------------------------------------------------------------------------------ */

/** The inner XML of every `<tag>…</tag>` (not nested in one another). */
export function xmlBlocks(xml: string, tag: string): string[] {
  const name = tag.replace(/[.\\-]/g, '\\$&');
  const out: string[] = [];
  for (const m of xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'g')))
    out.push(m[1] ?? '');
  return out;
}

/** A child's text, or null when it is missing or empty. */
const text = (xml: string, tag: string) => {
  const t = xmlElementText(xml, tag);
  return t ? t : null;
};

/** QTS answers `authPassed` 0 to a session it doesn't know (the sign-in renews it first). */
function checked(xml: string): string {
  if (!/<QDocRoot[\s>]/.test(xml)) throw new ReadProblem('QNAP answered with something Whombat can’t read.');
  return xml;
}

export interface QnapSystem {
  name: string | null;
  model: string | null;
  firmware: string | null;
  systemC: number | null;
  cpuC: number | null;
  uptimeS: number | null;
  /** The processor now (`cpu_usage`, “7.1 %”). */
  cpuPct?: number | null;
  /** Memory in all and free, in MB (`total_memory`, `free_memory`). */
  memoryTotalMb?: number | null;
  memoryFreeMb?: number | null;
}

/** `manaRequest.cgi?subfunc=sysinfo&hd=no&multicpu=1`. */
export function parseSystem(xml: string): QnapSystem {
  const model = xmlBlocks(xml, 'model')[0] ?? '';
  const firmware = xmlBlocks(xml, 'firmware')[0] ?? '';
  const root = xmlBlocks(xml, 'root')[0] ?? xml;
  const n = (tag: string) => num(text(root, tag)?.replace(/[^\d.-]/g, ''));
  const [d, h, m, s] = [n('uptime_day'), n('uptime_hour'), n('uptime_min'), n('uptime_sec')];
  const version = text(firmware, 'version');
  return {
    name: text(root, 'server_name'),
    model: text(model, 'displayModelName') ?? text(model, 'modelName'),
    firmware: version ? `${version}${text(firmware, 'build') ? ` (${text(firmware, 'build')})` : ''}` : null,
    systemC: n('sys_tempc'),
    cpuC: n('cpu_tempc'),
    uptimeS: d !== null || h !== null ? (d ?? 0) * 86400 + (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0) : null,
    cpuPct: n('cpu_usage'),
    memoryTotalMb: n('total_memory'),
    memoryFreeMb: n('free_memory'),
  };
}

/** `manaRequest.cgi?subfunc=sysinfo&sysHealth=1`: “good”, or QTS's word for what isn't. */
export function parseHealth(xml: string): string | null {
  const block = xmlBlocks(xml, 'sysHealth')[0];
  return block ? text(block, 'status') : null;
}

export interface QnapDisk {
  /** The bay (`HDNo`): a new disk in the same bay has the same one, so lines key on `serial` when QTS gives it. */
  id: string;
  serial: string | null;
  label: string;
  model: string | null;
  health: string;
  tempC: number | null;
  capacity: string | null;
  ssd: boolean;
}

/** `qsmart.cgi?func=all_hd_data`: the bays with a disk in them. */
export function parseDisks(xml: string): QnapDisk[] {
  const info = xmlBlocks(xml, 'Disk_Info')[0] ?? '';
  return xmlBlocks(info, 'entry').flatMap((e) => {
    const model = text(e, 'Model');
    const no = text(e, 'HDNo') ?? text(e, 'Disk_Alias');
    if (!model || !no || model === '--') return [];
    const temp = xmlBlocks(e, 'Temperature')[0];
    const alias = text(e, 'Disk_Alias');
    return [
      {
        id: clip(no, 40),
        serial:
          text(e, 'Serial') && text(e, 'Serial') !== '--' ? clip(text(e, 'Serial') as string, 80) : null,
        label: clip(alias ?? (/^\d+$/.test(no) ? `Disk ${no}` : no), 40),
        model: clip(model, 60),
        health: text(e, 'Health') ?? 'Unknown',
        tempC: num(temp ? text(temp, 'oC') : null),
        capacity: text(e, 'Capacity'),
        ssd: num(text(e, 'hd_is_ssd')) === 1,
      },
    ];
  });
}

export interface QnapVolume {
  id: string;
  label: string;
  total: number;
  free: number;
}

/** `chartReq.cgi?chart_func=disk_usage`: volumes (`volumeList`) with their sizes (`volumeUseList`). */
export function parseVolumes(xml: string): QnapVolume[] {
  const labels = new Map<string, string>();
  for (const v of xmlBlocks(xmlBlocks(xml, 'volumeList')[0] ?? '', 'volume')) {
    const id = text(v, 'volumeValue');
    if (id) labels.set(id, text(v, 'volumeLabel') ?? `Volume ${id}`);
  }
  return xmlBlocks(xmlBlocks(xml, 'volumeUseList')[0] ?? '', 'volumeUse').flatMap((u) => {
    const id = text(u, 'volumeValue');
    const total = num(text(u, 'total_size'));
    const free = num(text(u, 'free_size'));
    // Volumes QTS keeps for itself aren't in `volumeList`.
    if (!id || !labels.has(id) || total === null || free === null || total <= 0) return [];
    return [{ id, label: clip(labels.get(id) as string, 60), total, free }];
  });
}

export interface QnapSnapshot {
  readAt: Date;
  system: QnapSystem | null;
  health: string | null;
  disks: QnapDisk[] | null;
  volumes: QnapVolume[] | null;
}

export async function readQnap(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<QnapSnapshot> {
  const get = async (path: string, query: Record<string, string>) =>
    checked(await readText(services, row, NAME, { path, query }));
  const [system, health, disks, volumes] = await Promise.all([
    optional(get('/cgi-bin/management/manaRequest.cgi', { subfunc: 'sysinfo', hd: 'no', multicpu: '1' })),
    optional(get('/cgi-bin/management/manaRequest.cgi', { subfunc: 'sysinfo', sysHealth: '1' })),
    optional(get('/cgi-bin/disk/qsmart.cgi', { func: 'all_hd_data' })),
    optional(
      get('/cgi-bin/management/chartReq.cgi', {
        chart_func: 'disk_usage',
        disk_select: 'all',
        include: 'all',
      }),
    ),
  ]);
  if (system === null && disks === null && volumes === null)
    // Every part failed: say why the first did.
    await get('/cgi-bin/management/manaRequest.cgi', { subfunc: 'sysinfo', hd: 'no', multicpu: '1' });
  return {
    readAt: now,
    system: system ? parseSystem(system) : null,
    health: health ? parseHealth(health) : null,
    disks: disks ? parseDisks(disks) : null,
    volumes: volumes ? parseVolumes(volumes) : null,
  };
}

function load(services: Services, row: CatalogConnectionRow, now: Date) {
  return async () => {
    try {
      return await withDeadline(
        readQnap(services, row, now),
        KIND_DEADLINE_MS,
        `${NAME} didn’t answer in time.`,
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

export function qnapLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, `qnap:${row.id}`, row, load(services, row, now));
}

export function qnapSnapshot(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return cachedRead(services, `qnap:${row.id}`, row, load(services, row, now));
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

/** A disk's health as a tone: “OK”/“Good” fine, “Warning” amber, anything else red. */
export function diskHealth(h: string): 'ok' | 'warn' | 'bad' {
  const s = h.toLowerCase();
  if (s === 'ok' || s === 'good' || s === 'normal') return 'ok';
  if (s === 'warning' || s === 'unknown' || s === '--') return 'warn';
  return 'bad';
}

/** The box's temperature as a tone. */
export function warmth(sys: QnapSystem): 'warn' | 'bad' | undefined {
  const t = (c: number | null, warn: number, hot: number) =>
    c === null ? undefined : c >= hot ? ('bad' as const) : c >= warn ? ('warn' as const) : undefined;
  const a = t(sys.systemC, SYSTEM_WARM_C, SYSTEM_HOT_C);
  const b = t(sys.cpuC, CPU_WARM_C, CPU_HOT_C);
  return a === 'bad' || b === 'bad' ? 'bad' : (a ?? b);
}

export interface QnapInput {
  snapshot: QnapSnapshot;
  url: string;
  /** For the week's space (absent: no Trend). */
  now?: Date;
  timeZone?: string;
  /** Whombat's readings of the used space, the last 15 days. */
  space?: readonly RawPoint[];
}

/** Used and in all over every volume, in bytes; null without volumes. */
export function qnapSpace(s: QnapSnapshot): { used: number; total: number } | null {
  if (!s.volumes?.length) return null;
  return {
    used: s.volumes.reduce((a, v) => a + (v.total - v.free), 0),
    total: s.volumes.reduce((a, v) => a + v.total, 0),
  };
}

function figures(s: QnapSnapshot): ThingPageKpi[] {
  const out: ThingPageKpi[] = [];
  if (s.volumes?.length) {
    const fullest = [...s.volumes].sort((a, b) => a.free / a.total - b.free / b.total)[0];
    const fp = fullest ? ((fullest.total - fullest.free) / fullest.total) * 100 : 0;
    const tone = fullTone(fp);
    out.push({
      key: 'volumes',
      label: 'Volumes',
      value: String(s.volumes.length),
      sub: s.volumes.length > 1 ? `Fullest ${Math.round(fp)} %` : `${Math.round(fp)} % full`,
      ...(tone ? { tone } : {}),
    });
    const total = s.volumes.reduce((a, v) => a + v.total, 0);
    const used = s.volumes.reduce((a, v) => a + (v.total - v.free), 0);
    out.push(usedKpi('used', 'Used', used, total));
  }
  if (s.disks?.length) {
    const healthy = s.disks.filter((d) => diskHealth(d.health) === 'ok').length;
    const bad = s.disks.some((d) => diskHealth(d.health) === 'bad');
    out.push({
      key: 'disks',
      label: 'Disks',
      value: healthy === s.disks.length ? `${healthy} healthy` : `${healthy} of ${s.disks.length}`,
      ...(healthy < s.disks.length
        ? { sub: 'healthy', tone: bad ? ('bad' as const) : ('warn' as const) }
        : {}),
    });
  }
  if (s.system?.systemC != null) {
    const tone = warmth(s.system);
    out.push({
      key: 'temperature',
      label: 'Temperature',
      value: celsius(s.system.systemC),
      ...(s.system.cpuC !== null ? { sub: `CPU ${celsius(s.system.cpuC)}` } : {}),
      ...(tone ? { tone } : {}),
    });
  }
  return out;
}

/* Worth a look (quiet-notices.md QN-01…QN-04, QN-S4x) ------------------------------------------------------------------ */

/** Every check QNAP's page can raise (QN-15). */
export const QNAP_CHECKS: readonly KindCheck[] = [
  {
    check: 'qnap.health',
    name: 'QNAP’s own system health',
    nature: 'problem',
    perItem: false,
    startsOn: false,
  },
  { check: 'qnap.volume_full', name: 'Volumes filling up', nature: 'problem', perItem: true, startsOn: true },
  { check: 'qnap.disk', name: 'Disk health', nature: 'you', perItem: true, startsOn: true },
  { check: 'qnap.disk_temp', name: 'Disks running hot', nature: 'you', perItem: true, startsOn: false },
  { check: 'qnap.warm', name: 'The QNAP running warm', nature: 'you', perItem: false, startsOn: false },
];

/** The checks this read couldn't see (QN-11): their part didn't answer. */
export function qnapSkipped(s: QnapSnapshot): string[] {
  return [
    ...(s.health === null ? ['qnap.health'] : []),
    ...(s.volumes === null ? ['qnap.volume_full'] : []),
    ...(s.disks === null ? ['qnap.disk', 'qnap.disk_temp'] : []),
    ...(s.system === null ? ['qnap.warm'] : []),
  ];
}

/** QTS can't read the disk's health (USB enclosures, some NVMe say so for ever): a heads-up (QN-04). */
export const unknownHealth = (h: string) => ['unknown', '--'].includes(h.toLowerCase());

/** A disk's subject: its serial when QTS gave one, else its bay (QN-S4x). */
export const diskSubject = (d: QnapDisk) => ({
  id: clip(`disk:${d.serial ?? `bay${d.id}`}`, 160),
  name: clip(d.label, 80),
});

function diskLines(input: QnapInput, d: QnapDisk): KindNotice[] {
  const { url } = input;
  const out: KindNotice[] = [];
  const open = { kind: 'url' as const, label: 'Open QTS', url };
  const h = diskHealth(d.health);
  if (h !== 'ok') {
    const unknown = unknownHealth(d.health);
    out.push({
      id: `disk-${d.id}`.slice(0, 120),
      tone: unknown ? 'info' : h,
      icon: 'disk',
      title: clip(
        unknown ? `QTS can’t read the health of ${d.label}` : `${d.label} says ${d.health.toLowerCase()}`,
        120,
      ),
      ...(d.model
        ? { detail: clip(`${d.model}. Look at its SMART details in Storage & Snapshots.`, 200) }
        : {}),
      link: open,
      nature: unknown ? 'fyi' : 'you',
      check: 'qnap.disk',
      subject: diskSubject(d),
      ignore: fixed(unknown ? 'Until QTS can read it.' : UNTIL.replaced),
      episode: d.health.toLowerCase(),
    });
  }
  const tone = d.tempC !== null ? tempTone(d.tempC, d.ssd) : undefined;
  if (d.tempC !== null && tone)
    out.push({
      id: `hot-${d.id}`.slice(0, 120),
      tone,
      icon: 'disk',
      title: clip(`${d.label} is at ${celsius(d.tempC)}`, 120),
      detail: 'Disks wear faster when they run hot. Check the airflow and the fans.',
      // Warm is a heads-up; hot is only you: the airflow and the fans (QN-S4x).
      ...(tone === 'bad' ? { link: open } : {}),
      nature: tone === 'bad' ? 'you' : 'fyi',
      check: 'qnap.disk_temp',
      subject: diskSubject(d),
      ignore: fixed(UNTIL.cooler),
      confirm: 2,
    });
  return out;
}

function notices(input: QnapInput): KindNotice[] {
  const { snapshot: s, url } = input;
  const out: KindNotice[] = [];
  for (const v of s.volumes ?? []) {
    const p = ((v.total - v.free) / v.total) * 100;
    const full = fullness(p, v.free);
    if (full)
      out.push({
        id: `full-${v.id}`.slice(0, 120),
        ...full,
        icon: 'disk',
        title: clip(`${v.label} is ${Math.round(p)} % full`, 120),
        detail: `${usedOf(v.total - v.free, v.total)} used.`,
        ...(full.nature === 'problem'
          ? { link: lookInto(`What is taking the space on ${v.label} on the QNAP?`) }
          : {}),
        check: 'qnap.volume_full',
        subject: { id: clip(`volume:${v.id}`, 160), name: clip(v.label, 80) },
        ignore: fixed(UNTIL.fuller),
      });
  }
  const disks = (s.disks ?? []).flatMap((d) => diskLines(input, d));
  out.push(
    ...itemLines(
      worstFirst(disks),
      (l) => l,
      (l) => `${l.check}/${l.subject?.id ?? l.id}`,
      (rest) => ({
        id: 'disk-more',
        ...worstOf(rest),
        icon: 'disk',
        title: `${plural(rest.length, 'more line')} about disks`,
        check: rest[0]?.check ?? 'qnap.disk',
      }),
    ),
  );
  if (s.system) {
    const tone = warmth(s.system);
    if (tone)
      out.push({
        id: 'warm',
        tone,
        icon: 'warn',
        title: `The QNAP is running warm: ${celsius(s.system.systemC ?? s.system.cpuC ?? 0)}`,
        detail: clip(
          `${[
            s.system.systemC !== null ? `System ${celsius(s.system.systemC)}` : null,
            s.system.cpuC !== null ? `CPU ${celsius(s.system.cpuC)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}. Check the fans and where it stands.`,
          200,
        ),
        ...(tone === 'bad' ? { link: { kind: 'url' as const, label: 'Open QTS', url } } : {}),
        // Warm under load is a heads-up; hot is only you (QN-S4x). A CPU spike flaps: two passes (QN-04).
        nature: tone === 'bad' ? 'you' : 'fyi',
        check: 'qnap.warm',
        ignore: fixed(UNTIL.cooler),
        confirm: 2,
      });
  }
  // QTS's own health word mostly repeats a disk or the warmth: it gives way to those lines (QN-04).
  const explained = out.some(
    (n) => n.check === 'qnap.disk' || n.check === 'qnap.disk_temp' || n.check === 'qnap.warm',
  );
  if (s.health && s.health.toLowerCase() !== 'good' && !explained) {
    const title = clip(`QNAP says its system health is “${s.health.toLowerCase()}”`, 120);
    out.push({
      id: 'health',
      tone: 'warn',
      icon: 'warn',
      title,
      link: { kind: 'url', label: 'Open QTS', url },
      nature: 'problem',
      check: 'qnap.health',
      ignore: fixed('Until it’s good again.'),
      episode: s.health.toLowerCase().slice(0, 60),
      badge: clip(`System health: ${s.health.toLowerCase()}`, 40),
    });
  }
  return worstFirst(out);
}

/** Inventory “Storage”: each volume, how full and what is free, then the disks. */
function storageLines(input: QnapInput): ThingPageItem[] {
  const { snapshot: s, url } = input;
  const out: ThingPageItem[] = (s.volumes ?? []).map((v) => {
    const used = v.total - v.free;
    const tone = fullTone((used / v.total) * 100);
    return countLine({
      id: `volume-${v.id}`,
      title: v.label,
      icon: 'disk',
      detail: usedOf(used, v.total),
      ...(tone ? { tone } : {}),
      value: pct((used / v.total) * 100),
      note: `${bytes(v.free)} free`,
      ...(tone ? { noteTone: tone } : {}),
      url,
    });
  });
  if (s.disks?.length)
    out.push(
      disksLine(
        s.disks.map((d) => ({
          health: diskHealth(d.health),
          tempC: d.tempC,
          warm: d.tempC !== null ? tempTone(d.tempC, d.ssd) : undefined,
        })),
        url,
      ),
    );
  return out;
}

/** The box's own figures for the machine card: QTS's processor and memory now. */
export function qnapMachine(sys: QnapSystem | null): MachineNow | null {
  if (!sys) return null;
  const total = sys.memoryTotalMb ?? null;
  const free = sys.memoryFreeMb ?? null;
  const figures: MachineNow = {
    cpuPct: sys.cpuPct ?? null,
    cores: null,
    memoryUsedGb: total !== null && free !== null ? Math.max(0, total - free) / 1024 : null,
    memoryTotalGb: total !== null ? total / 1024 : null,
    // The volumes are Inventory's; the card's Disk would say again what their lines say.
    diskUsedGb: null,
    diskTotalGb: null,
    series: null,
  };
  return figures.cpuPct === null && figures.memoryUsedGb === null ? null : figures;
}

/** QNAP's own lines in the machine card: QTS's version, how warm it is, its own health word, how long it's been up. */
function machineLines(s: QnapSnapshot): ThingPageBar[] {
  const sys = s.system;
  const out: ThingPageBar[] = [];
  if (sys?.firmware) {
    const [version, build] = [sys.firmware.replace(/ \(.*\)$/, ''), /\((.*)\)$/.exec(sys.firmware)?.[1]];
    out.push({
      id: 'qts',
      label: 'QTS',
      value: clip(version, 40),
      pct: null,
      ...(build ? { sub: `Build ${build}` } : {}),
    });
  }
  if (sys && (sys.systemC !== null || sys.cpuC !== null)) {
    const tone = warmth(sys);
    out.push({
      id: 'temperature',
      label: 'Temperature',
      value: celsius(sys.systemC ?? sys.cpuC ?? 0),
      pct: null,
      ...(tone ? { tone } : {}),
      ...(sys.systemC !== null && sys.cpuC !== null
        ? { sub: `Processor ${celsius(sys.cpuC)}`, ...(tone ? { subTone: tone } : {}) }
        : {}),
    });
  }
  if (s.health) {
    const good = s.health.toLowerCase() === 'good';
    out.push({
      id: 'health',
      label: 'System health',
      value: clip(s.health.charAt(0).toUpperCase() + s.health.slice(1), 40),
      pct: null,
      ...(good ? {} : { tone: 'warn' as const }),
    });
  }
  if (sys?.uptimeS != null) out.push({ id: 'up', label: 'Up', value: span(sys.uptimeS * 1000), pct: null });
  return out;
}

function diskRows(s: QnapSnapshot): ThingPageRow[] {
  return (s.disks ?? []).slice(0, DISKS_MAX).map((d) => {
    const h = diskHealth(d.health);
    const tone = d.tempC !== null ? tempTone(d.tempC, d.ssd) : undefined;
    return {
      id: d.id,
      cells: {
        disk: { text: d.label, ...(d.model ? { note: d.model } : {}) },
        health: { text: d.health, dot: h, ...(h === 'bad' ? { tone: 'bad' as const } : {}) },
        size: d.capacity ? { text: d.capacity, mono: true } : { text: '—', tone: 'muted' as const },
        temp:
          d.tempC !== null
            ? { text: celsius(d.tempC), mono: true, ...(tone ? { tone } : {}) }
            : { text: '—', tone: 'muted' as const },
      },
    };
  });
}

/**
 * The page's QNAP part (SD-53), in slots: Inventory “Storage” (each volume, then the disks), the Trend of space added a
 * day from Whombat's readings, the box's own figures and lines in the machine card, the disks below. QTS tells nothing
 * that happens now (no scrub, rebuild or backup in these reads), so there is no Live. Pure.
 */
export function qnapView(input: QnapInput): KindView {
  const { snapshot: s, url } = input;
  const lines = storageLines(input);
  const space = qnapSpace(s);
  const more: ThingPagePanel[] = [];
  const disks = diskRows(s);
  if (disks.length)
    more.push({
      kind: 'table',
      id: 'disks',
      title: 'Disks',
      meta: plural(disks.length, 'disk'),
      columns: [
        { key: 'disk', label: 'Disk' },
        { key: 'health', label: 'Health' },
        { key: 'size', label: 'Size', numeric: true },
        { key: 'temp', label: 'Temperature', numeric: true },
      ],
      rows: disks,
    });
  const sys = s.system;
  const own = qnapMachine(sys);
  const slotted = slotPanels({
    // The volumes keep the id the desk's widgets name.
    inventory: lines.length
      ? inventory({
          id: 'volumes',
          title: 'Storage',
          ...(space ? { meta: usedOf(space.used, space.total) } : {}),
          items: lines,
        })
      : null,
    trend:
      input.now && input.timeZone
        ? spaceWeek({
            points: input.space ?? [],
            now: input.now,
            timeZone: input.timeZone,
            freeBytes: space ? space.total - space.used : null,
            what: s.volumes && s.volumes.length > 1 ? 'All volumes' : 'Added per day',
          })
        : null,
    more,
    machine: machineLines(s),
  });

  const facts: ThingLine[] = [];
  if (sys?.model || sys?.firmware)
    facts.push(
      line(
        [
          sys.model ? `**${sys.model}**` : null,
          sys.firmware ? `QTS **${sys.firmware.replace(/ \(.*\)$/, '')}**` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
  if (sys?.name) facts.push(line(`**${clip(sys.name, 60)}**`));
  const shown = notices(input);
  return {
    ...withOwn(slotted, own, sys?.name ?? sys?.model ?? NAME),
    kpis: [],
    charts: [],
    notices: shown,
    tabs: [],
    facts,
    status: statusOf(shown, s.disks?.length ? `${plural(s.disks.length, 'disk')} healthy` : 'Running fine'),
    open: { label: 'Open QTS', url },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Biggest shared folders', 'Disk temperatures this week', 'Snapshots per volume'],
  };
}

/* The page ----------------------------------------------------------------------------------------------------------- */

export async function qnapPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = serviceUrl(row);
  const [read, space] = await Promise.all([qnapLatest(services, row, now), readSpace(services, row.id, now)]);
  if (!read.ok) return unreadView('QTS', url, problemOf(read.error, NAME).message, read.refreshing);
  return {
    ...qnapView({ snapshot: read.value, url, now, timeZone: ctx.timeZone, space }),
    refreshing: read.refreshing,
  };
}

export const QNAP_KIND: KindModule = {
  page: qnapPage,
  prefetch: (services, row, now) => qnapLatest(services, row, now),
  async seen(services, row, now) {
    const s = await qnapSnapshot(services, row, now);
    const view = qnapView({ snapshot: s, url: serviceUrl(row) });
    const fw = s.system?.firmware?.replace(/ \(.*\)$/, '');
    // The card keeps its figures: the page has none of its own in slots.
    return {
      ...seenOf(
        cardOf(
          { kpis: figures(s), notices: view.notices },
          ['volumes', 'disks'],
          fw ? `NAS · QTS ${fw}` : 'NAS',
        ),
        view.notices as KindNotice[],
        qnapSkipped(s),
      ),
      points: usedPoint(qnapSpace(s)?.used),
      tracked: { version: fw ?? null },
    };
  },
  checks: QNAP_CHECKS,
};
