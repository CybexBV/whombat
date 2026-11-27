/**
 * An Unraid server on the phone (Whombat incus-unraid.md IU-03, IU-05…IU-09; app docs/decisions/
 * incus-unraid-mobile.md AP-1634…AP-1638): the phone's rows over the web's Unraid words (`unraid.ts`, stream WU) —
 * a disk as one row and its sheet's facts, the disks grouped as Unraid's Main page groups them (Parity, Data, each
 * pool, Flash), the pools' use, the parity history, the plugins, the updates (Unraid itself, plugins, containers),
 * the unread notifications, the server's facts, and a Docker or libvirt guest's Update, autostart and web page.
 * Sizes are decimal (“16 TB”), as Unraid writes them. Pure: times and the time zone come in as arguments.
 */
import type { HostGuest, HostUnraidDetail, HostUnraidDisk, HostUnraidParityRun } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_UNRAID_WORDS } from '../i18n/messages/connectionsHosts/unraid';
import { DASH, formatDuration, formatPct, formatRelativeDay, formatTemp } from './format';
import type { HostTone } from './thresholds';
import {
  arrayGroups,
  canUpdateContainer,
  fsWords,
  guestWebUi,
  hasAutostart,
  notificationTitle,
  notificationTone,
  notificationWords,
  parityRunWhen,
  parityRunWords,
  pluginRows,
  pluginUpdates,
  poolWords,
  spinningDisks,
  UNRAID_POOL_FULL_PCT,
  unraidDiskRowFor,
  unraidDiskStatus,
  unraidSize,
  unraidVersionView,
} from './unraid';

const phone = (locale?: string | null) => clientTree(locale, HOSTS_UNRAID_WORDS).phone;

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
  return diskRowFor(d);
}

/** {@link diskRow} in a locale (English when none is given); `diskRow` stays one-argument for `map`. */
export function diskRowFor(d: HostUnraidDisk, locale?: string | null): DiskRowView {
  const w = phone(locale);
  const r = unraidDiskRowFor(d, locale);
  const present = !!d.device && d.status !== 'empty';
  const tempText = !present ? DASH : d.spunDown && d.rotational !== false ? w.spunDown : r.tempText;
  const line = [r.model, r.device].filter(Boolean).join(' · ') || r.status.text;
  const meta = present
    ? [
        r.sizeText,
        d.usedBytes != null && d.slot !== 'parity' ? interpolate(w.used, { used: r.usedText }) : null,
        r.fsText !== DASH ? r.fsText : null,
        d.errors ? w.errors(d.errors) : null,
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
export function diskSections(u: HostUnraidDetail, locale?: string | null): DiskSection[] {
  const w = phone(locale);
  const row = (d: HostUnraidDisk) => diskRowFor(d, locale);
  const { parity, data } = arrayGroups(u.array);
  const out: DiskSection[] = [];
  if (parity.length) out.push({ id: 'parity', title: w.parity, sub: null, rows: parity.map(row) });
  if (data.length) out.push({ id: 'data', title: w.data, sub: null, rows: data.map(row) });
  for (const p of u.pools)
    out.push({
      id: `pool:${p.name}`,
      title: interpolate(w.pool, { name: p.name }),
      sub: poolWords(p, locale),
      rows: p.disks.map(row),
    });
  if (u.flash) out.push({ id: 'flash', title: w.flash, sub: null, rows: [row(u.flash)] });
  return out;
}

/** A disk's sheet: everything Unraid's Main row shows, in words. */
export function diskFacts(d: HostUnraidDisk, locale?: string | null): { label: string; value: string }[] {
  const w = phone(locale);
  const present = !!d.device && d.status !== 'empty';
  const out: { label: string; value: string }[] = [
    { label: w.state, value: unraidDiskStatus(d, locale).text },
  ];
  if (d.device) out.push({ label: w.device, value: d.device });
  if (d.model) out.push({ label: w.model, value: d.model });
  if (d.serial) out.push({ label: w.serial, value: d.serial });
  if (present) out.push({ label: w.size, value: unraidSize(d.sizeBytes) });
  if (d.usedBytes != null) out.push({ label: w.usedLabel, value: unraidSize(d.usedBytes) });
  if (d.freeBytes != null) out.push({ label: w.free, value: unraidSize(d.freeBytes) });
  if (d.fsType) out.push({ label: w.fileSystem, value: fsWords(d.fsType, locale) });
  if (present)
    out.push({
      label: w.temperature,
      value: d.spunDown && d.rotational !== false ? w.spunDown : d.tempC != null ? formatTemp(d.tempC) : DASH,
    });
  out.push({ label: w.errorsLabel, value: d.errors ? String(d.errors) : w.none });
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
export function unraidPoolRows(u: Pick<HostUnraidDetail, 'pools'>, locale?: string | null): UnraidPoolRow[] {
  const w = phone(locale);
  return u.pools.map((p) => {
    const pct = p.sizeBytes > 0 ? (p.usedBytes / p.sizeBytes) * 100 : null;
    const line = poolWords(p, locale);
    const usedText = interpolate(w.poolUsed, {
      used: unraidSize(p.usedBytes),
      size: unraidSize(p.sizeBytes),
    });
    const tone = pct == null ? null : pct >= 97 ? 'bad' : pct >= UNRAID_POOL_FULL_PCT ? 'warn' : null;
    const title = interpolate(w.pool, { name: p.name });
    return { name: p.name, line, usedText, pct, tone, label: `${title}, ${line}, ${usedText}` };
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
  locale?: string | null,
): ParityRunRow[] {
  const took = phone(locale).took;
  return [...runs]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((r) => {
      const w = parityRunWords(r, locale);
      const title = parityRunWhen(r.at, now, timeZone, locale);
      const line = [
        w.action,
        r.durationS != null ? interpolate(took, { duration: formatDuration(r.durationS, locale) }) : null,
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
export function pluginPhoneRows(u: Pick<HostUnraidDetail, 'plugins'>, locale?: string | null): PluginRow[] {
  const w = phone(locale);
  return pluginRows(u).map((p) => {
    const line = p.update
      ? interpolate(w.versionUpdate, { version: p.version, update: p.update })
      : interpolate(w.version, { version: p.version });
    return {
      file: p.file,
      name: p.name,
      line,
      author: p.author,
      update: p.update,
      label: [p.name, line, p.update ? w.updateReady : null].filter(Boolean).join(', '),
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
  locale?: string | null,
): UpdateLine[] {
  const w = phone(locale);
  const plugins = pluginUpdates(u).length;
  const containers = guests.filter((g) => g.platform === 'docker' && g.updateAvailable).length;
  const os = unraidVersionView(u, locale);
  return [
    {
      id: 'os',
      title: 'Unraid',
      value:
        os.update && u.osUpdate
          ? `${u.version} → ${u.osUpdate.version}`
          : interpolate(w.upToDate, { version: u.version }),
      tone: os.update ? 'warn' : 'ok',
    },
    {
      id: 'plugins',
      title: w.plugins,
      value: plugins ? w.updatesReady(plugins) : w.allUpToDate,
      tone: plugins ? 'warn' : 'ok',
    },
    {
      id: 'containers',
      title: w.containers,
      value: containers ? w.updatesReady(containers) : w.allUpToDate,
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
  locale?: string | null,
): NotificationRow[] {
  const importance = notificationWords(locale);
  return [...u.notifications]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((n) => {
      const t = notificationTone(n);
      const title = notificationTitle(n);
      const meta = [formatRelativeDay(Date.parse(n.at), now, timeZone, locale), n.event]
        .filter(Boolean)
        .join(' · ');
      return {
        id: n.id,
        tone: t === 'bad' || t === 'warn' ? t : null,
        title,
        line: n.description,
        meta,
        label: `${importance[n.importance]}: ${title}. ${n.description} ${meta}`,
      };
    });
}

/* The server's facts ----------------------------------------------------------------------------------------------- */

export function unraidFacts(u: HostUnraidDetail, locale?: string | null): { label: string; value: string }[] {
  const w = phone(locale);
  const out: { label: string; value: string }[] = [{ label: 'Unraid', value: u.version }];
  if (u.license) out.push({ label: w.licence, value: u.license });
  out.push({ label: w.array, value: u.array.startOnBoot ? w.startsWithServer : w.byHand });
  out.push({
    label: 'Docker',
    value: !u.docker.enabled
      ? w.off
      : u.docker.imageUsedPct != null
        ? interpolate(w.dockerImage, { pct: formatPct(u.docker.imageUsedPct) })
        : w.on,
  });
  out.push({ label: w.vms, value: u.vms.enabled ? w.on : w.off });
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
export function containerView(g: HostGuest, onUnraid: boolean, locale?: string | null): ContainerView | null {
  const w = phone(locale);
  const docker = g.platform === 'docker';
  if (!(docker && onUnraid) && g.platform !== 'libvirt') return null;
  const update = docker
    ? g.updateAvailable
      ? { text: w.updateIsReady, tone: 'warn' as const }
      : g.updateAvailable === false
        ? { text: w.upToDateShort, tone: 'ok' as const }
        : null
    : null;
  return {
    canUpdate: canUpdateContainer(g, onUnraid),
    updateText: update?.text ?? null,
    updateTone: update?.tone ?? 'mut',
    autostart: hasAutostart(g, onUnraid) ? !!g.autostart : null,
    autostartLabel: onUnraid ? w.withArray : w.withServer,
    webUi: docker ? guestWebUi(g) : null,
  };
}
