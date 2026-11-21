/**
 * An Unraid server on the phone (Whombat incus-unraid.md IU-03, IU-05…IU-09; app docs/decisions/
 * incus-unraid-mobile.md AP-1634…AP-1638): the phone's rows over the web's Unraid words (`unraid.ts`, stream WU) —
 * a disk as one row and its sheet's facts, the disks grouped as Unraid's Main page groups them (Parity, Data, each
 * pool, Flash), the pools' use, the parity history, the plugins, the updates (Unraid itself, plugins, containers),
 * the unread notifications, the server's facts, and a Docker or libvirt guest's Update, autostart and web page.
 * Sizes are decimal (“16 TB”), as Unraid writes them. Pure: times and the time zone come in as arguments.
 */
import type { HostGuest, HostUnraidDetail, HostUnraidDisk, HostUnraidParityRun } from '@whombat/core/domain';
import { DASH, formatDuration, formatPct, formatRelativeDay, formatTemp, plural } from './format';
import type { HostTone } from './thresholds';
import {
  arrayGroups,
  canUpdateContainer,
  fsWords,
  guestWebUi,
  hasAutostart,
  NOTIFICATION_WORDS,
  notificationTitle,
  notificationTone,
  parityRunWhen,
  parityRunWords,
  pluginRows,
  pluginUpdates,
  poolWords,
  spinningDisks,
  UNRAID_POOL_FULL_PCT,
  unraidDiskRow,
  unraidDiskStatus,
  unraidSize,
  unraidVersionView,
} from './unraid';

/* Disks ------------------------------------------------------------------------------------------------------------ */

export interface DiskRowView {
  name: string;
  /** “Parity”, “Disk 1”, “Apps 2”, “Flash”. */
  title: string;
  /** Model and device: “WDC WD161KFGX · sdb”. */
  line: string;
  /** “16 TB · 11.2 TB used · xfs · 2 errors”. */
  meta: string;
  status: { text: string; tone: HostTone };
  /** “34 °C”, “Spun down”, “—”. */
  tempText: string;
  tempTone: HostTone | null;
  spunDown: boolean;
  canSpin: boolean;
  label: string;
  disk: HostUnraidDisk;
}

/** A disk as one phone row (the web's Array table row, `unraidDiskRow`, folded into two lines). */
export function diskRow(d: HostUnraidDisk): DiskRowView {
  const r = unraidDiskRow(d);
  const present = !!d.device && d.status !== 'empty';
  const tempText = !present ? DASH : d.spunDown && d.rotational !== false ? 'Spun down' : r.tempText;
  const line = [r.model, r.device].filter(Boolean).join(' · ') || r.status.text;
  const meta = present
    ? [
        r.sizeText,
        d.usedBytes != null && d.slot !== 'parity' ? `${r.usedText} used` : null,
        r.fsText !== DASH ? r.fsText : null,
        d.errors ? plural(d.errors, 'error') : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  return {
    name: d.name,
    title: r.label,
    line,
    meta,
    status: r.status,
    tempText,
    tempTone: r.tempTone,
    spunDown: d.spunDown,
    canSpin: r.canSpin,
    label: [r.label, r.status.text, line, tempText !== DASH ? tempText : null, meta]
      .filter(Boolean)
      .join(', '),
    disk: d,
  };
}

export interface DiskSection {
  id: string;
  title: string;
  /** A pool's file system, layout and disks: “zfs mirror · 2 disks”. */
  sub: string | null;
  rows: DiskRowView[];
}

/** The disks as Unraid's Main page groups them: Parity, Data, each pool, Flash (empty groups left out). */
export function diskSections(u: HostUnraidDetail): DiskSection[] {
  const { parity, data } = arrayGroups(u.array);
  const out: DiskSection[] = [];
  if (parity.length) out.push({ id: 'parity', title: 'Parity', sub: null, rows: parity.map(diskRow) });
  if (data.length) out.push({ id: 'data', title: 'Data', sub: null, rows: data.map(diskRow) });
  for (const p of u.pools)
    out.push({
      id: `pool:${p.name}`,
      title: `Pool ${p.name}`,
      sub: poolWords(p),
      rows: p.disks.map(diskRow),
    });
  if (u.flash) out.push({ id: 'flash', title: 'Flash', sub: null, rows: [diskRow(u.flash)] });
  return out;
}

/** A disk's sheet: everything Unraid's Main row shows, in words. */
export function diskFacts(d: HostUnraidDisk): { label: string; value: string }[] {
  const present = !!d.device && d.status !== 'empty';
  const out: { label: string; value: string }[] = [{ label: 'State', value: unraidDiskStatus(d).text }];
  if (d.device) out.push({ label: 'Device', value: d.device });
  if (d.model) out.push({ label: 'Model', value: d.model });
  if (d.serial) out.push({ label: 'Serial', value: d.serial });
  if (present) out.push({ label: 'Size', value: unraidSize(d.sizeBytes) });
  if (d.usedBytes != null) out.push({ label: 'Used', value: unraidSize(d.usedBytes) });
  if (d.freeBytes != null) out.push({ label: 'Free', value: unraidSize(d.freeBytes) });
  if (d.fsType) out.push({ label: 'File system', value: fsWords(d.fsType) });
  if (present)
    out.push({
      label: 'Temperature',
      value:
        d.spunDown && d.rotational !== false ? 'Spun down' : d.tempC != null ? formatTemp(d.tempC) : DASH,
    });
  out.push({ label: 'Errors', value: d.errors ? String(d.errors) : 'None' });
  return out;
}

/** Whether Spin up all and Spin down all have something to do. */
export function spinnable(u: Pick<HostUnraidDetail, 'array' | 'pools'>): { up: boolean; down: boolean } {
  const all = spinningDisks(u);
  return { up: all.some((d) => d.spunDown), down: all.some((d) => !d.spunDown) };
}

/* Pools ------------------------------------------------------------------------------------------------------------ */

export interface UnraidPoolRow {
  name: string;
  /** “zfs mirror · 2 disks”. */
  line: string;
  /** “412 GB of 1 TB used”. */
  usedText: string;
  pct: number | null;
  tone: 'warn' | 'bad' | null;
  label: string;
}

/** The pools with their use: warn from 90 % (IU-08), a problem from 97 %. */
export function unraidPoolRows(u: Pick<HostUnraidDetail, 'pools'>): UnraidPoolRow[] {
  return u.pools.map((p) => {
    const pct = p.sizeBytes > 0 ? (p.usedBytes / p.sizeBytes) * 100 : null;
    const line = poolWords(p);
    const usedText = `${unraidSize(p.usedBytes)} of ${unraidSize(p.sizeBytes)} used`;
    const tone = pct == null ? null : pct >= 97 ? 'bad' : pct >= UNRAID_POOL_FULL_PCT ? 'warn' : null;
    return { name: p.name, line, usedText, pct, tone, label: `Pool ${p.name}, ${line}, ${usedText}` };
  });
}

/* Parity history --------------------------------------------------------------------------------------------------- */

export interface ParityRunRow {
  title: string;
  /** “Check · took 9 h 12 min · 182 MB/s · No errors”. */
  line: string;
  tone: HostTone;
  label: string;
}

/** The parity history, newest first, in the web's words. */
export function parityHistoryRows(
  runs: readonly HostUnraidParityRun[],
  now: number,
  timeZone?: string,
): ParityRunRow[] {
  return [...runs]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((r) => {
      const w = parityRunWords(r);
      const title = parityRunWhen(r.at, now, timeZone);
      const line = [
        w.action,
        r.durationS != null ? `took ${formatDuration(r.durationS)}` : null,
        r.speedMbs != null ? `${Math.round(r.speedMbs)} MB/s` : null,
        w.result,
      ]
        .filter(Boolean)
        .join(' · ');
      return { title, line, tone: w.tone, label: `${title}, ${line}` };
    });
}

/* Plugins and updates ---------------------------------------------------------------------------------------------- */

export interface PluginRow {
  file: string;
  name: string;
  /** “Version 2026.09.01 → 2026.10.15”. */
  line: string;
  author: string | null;
  update: string | null;
  label: string;
}

/** The installed plugins as phone rows (the web's order: with an update first; never Unraid's own). */
export function pluginPhoneRows(u: Pick<HostUnraidDetail, 'plugins'>): PluginRow[] {
  return pluginRows(u).map((p) => {
    const line = p.update ? `Version ${p.version} → ${p.update}` : `Version ${p.version}`;
    return {
      file: p.file,
      name: p.name,
      line,
      author: p.author,
      update: p.update,
      label: [p.name, line, p.update ? 'update ready' : null].filter(Boolean).join(', '),
    };
  });
}

export interface UpdateLine {
  id: 'os' | 'plugins' | 'containers';
  title: string;
  value: string;
  tone: HostTone;
}

/** The Summary's UPDATES: Unraid itself (updated in Unraid, IU-10), its plugins and its containers. */
export function unraidUpdates(
  u: Pick<HostUnraidDetail, 'version' | 'license' | 'osUpdate' | 'plugins'>,
  guests: readonly Pick<HostGuest, 'platform' | 'updateAvailable'>[],
): UpdateLine[] {
  const plugins = pluginUpdates(u).length;
  const containers = guests.filter((g) => g.platform === 'docker' && g.updateAvailable).length;
  const os = unraidVersionView(u);
  return [
    {
      id: 'os',
      title: 'Unraid',
      value: os.update && u.osUpdate ? `${u.version} → ${u.osUpdate.version}` : `${u.version}, up to date`,
      tone: os.update ? 'warn' : 'ok',
    },
    {
      id: 'plugins',
      title: 'Plugins',
      value: plugins ? `${plural(plugins, 'update')} ready` : 'All up to date',
      tone: plugins ? 'warn' : 'ok',
    },
    {
      id: 'containers',
      title: 'Containers',
      value: containers ? `${plural(containers, 'update')} ready` : 'All up to date',
      tone: containers ? 'warn' : 'ok',
    },
  ];
}

/* Notifications ---------------------------------------------------------------------------------------------------- */

export interface NotificationRow {
  id: string;
  tone: 'bad' | 'warn' | null;
  title: string;
  line: string;
  /** “Today 02:00 · Unraid Parity disk error”. */
  meta: string;
  label: string;
}

/** unRAID's unread notifications, newest first: alerts red, warnings amber. */
export function notificationRows(
  u: Pick<HostUnraidDetail, 'notifications'>,
  now: number,
  timeZone?: string,
): NotificationRow[] {
  return [...u.notifications]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((n) => {
      const t = notificationTone(n);
      const title = notificationTitle(n);
      const meta = [formatRelativeDay(Date.parse(n.at), now, timeZone), n.event].filter(Boolean).join(' · ');
      return {
        id: n.id,
        tone: t === 'bad' || t === 'warn' ? t : null,
        title,
        line: n.description,
        meta,
        label: `${NOTIFICATION_WORDS[n.importance]}: ${title}. ${n.description} ${meta}`,
      };
    });
}

/* The server's facts ----------------------------------------------------------------------------------------------- */

export function unraidFacts(u: HostUnraidDetail): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [{ label: 'Unraid', value: u.version }];
  if (u.license) out.push({ label: 'Licence', value: u.license });
  out.push({ label: 'Array', value: u.array.startOnBoot ? 'Starts with the server' : 'Started by hand' });
  out.push({
    label: 'Docker',
    value: !u.docker.enabled
      ? 'Off'
      : u.docker.imageUsedPct != null
        ? `On · image ${formatPct(u.docker.imageUsedPct)} full`
        : 'On',
  });
  out.push({ label: 'VMs', value: u.vms.enabled ? 'On' : 'Off' });
  return out;
}

/* A Docker or libvirt guest (IU-05) -------------------------------------------------------------------------------- */

export interface ContainerView {
  /** An update can be installed from here (Docker on Unraid, an update and a template). */
  canUpdate: boolean;
  /** “An update is ready”, “Up to date”. */
  updateText: string | null;
  updateTone: HostTone;
  /** Its autostart switch, or null where it has none. */
  autostart: boolean | null;
  autostartLabel: string;
  webUi: string | null;
}

/**
 * What a Docker guest of an Unraid server and a libvirt guest anywhere get on their screen (the web's rules:
 * `canUpdateContainer`, `hasAutostart`, `guestWebUi`): Update, the autostart switch, the web page link.
 */
export function containerView(g: HostGuest, onUnraid: boolean): ContainerView | null {
  const docker = g.platform === 'docker';
  if (!(docker && onUnraid) && g.platform !== 'libvirt') return null;
  const update = docker
    ? g.updateAvailable
      ? { text: 'An update is ready', tone: 'warn' as const }
      : g.updateAvailable === false
        ? { text: 'Up to date', tone: 'ok' as const }
        : null
    : null;
  return {
    canUpdate: canUpdateContainer(g, onUnraid),
    updateText: update?.text ?? null,
    updateTone: update?.tone ?? 'mut',
    autostart: hasAutostart(g, onUnraid) ? !!g.autostart : null,
    autostartLabel: onUnraid ? 'Start it when the array starts' : 'Start it when the server starts',
    webUi: docker ? guestWebUi(g) : null,
  };
}
