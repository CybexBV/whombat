/**
 * The machine's hardware in Settings (Whombat hardware-support.md HD-01, HD-03, HD-11; app hardware-support-web.md
 * AP-3213…AP-3220): what This Whombat → About → HARDWARE shows — the machine in one line, the devices that don't work
 * first (one line each, in words), then every device by group (Network · Sound · Graphics & screens · Storage · Power ·
 * Other) — and `hardwareReportText`, the text file **Download report** saves (the phone shares it) for support. From what
 * the machine reports, never a list of models (HD-01). Shared by the web and the phone. Pure.
 */
import { formatLocaleNumber, interpolate } from '@whombat/core/i18n';
import { dayKey, formatBytes } from '@whombat/core/text';
import { clientTree } from '../i18n/catalog';
import { HARDWARE_WORDS } from '../i18n/messages/hostManaged/hardware';
import { sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import {
  type HardwareDevice,
  type HardwareKind,
  type HardwareStatus,
  type HostHardware,
  type HostHardwareOutput,
  hardwareProblems,
} from './contract';

type Dot = 'ok' | 'warn' | 'bad' | 'mut';

/* The op ---------------------------------------------------------------------------------------------------------- */

/** `host.hardware` (the session op, or a fixture world's machine). */
export type HardwareLoader = () => Promise<HostHardwareOutput>;

/** `host.hardware` over this session. */
export function hardwareLoader(session: ApplianceSession): HardwareLoader {
  return () => sessionOps.hostHardware(session);
}

/* Words ----------------------------------------------------------------------------------------------------------- */

export type HardwareGroup = 'network' | 'sound' | 'graphics' | 'storage' | 'power' | 'other';

/** The groups in their order (AP-3215). */
export const HARDWARE_GROUPS: readonly HardwareGroup[] = [
  'network',
  'sound',
  'graphics',
  'storage',
  'power',
  'other',
];

/** Which group a kind is shown in. */
export const HARDWARE_GROUP_OF: Record<HardwareKind, HardwareGroup> = {
  wired: 'network',
  wifi: 'network',
  bluetooth: 'network',
  sound: 'sound',
  graphics: 'graphics',
  display: 'graphics',
  storage: 'storage',
  battery: 'power',
  camera: 'other',
  input: 'other',
  usb: 'other',
  other: 'other',
};

/** HARDWARE's words, in a locale (English when none is given). */
export function hardwareText(locale?: string | null) {
  const w = clientTree(locale, HARDWARE_WORDS);
  const part = (template: string) => (kind: HardwareKind) =>
    interpolate(template, { part: w.thisPart[kind] ?? w.thisPart.other });
  return {
    section: w.section,
    groups: w.groups as Record<HardwareGroup, string>,
    download: w.download,
    share: w.share,
    intro: w.intro,
    unavailable: w.unavailable,
    tryAgain: w.tryAgain,
    allWork: w.allWork,
    virtual: (hypervisor: string | undefined) =>
      hypervisor ? interpolate(w.virtualOn, { hypervisor }) : w.virtual,
    unknownMachine: w.unknownMachine,
    cores: (cores: number, threads: number) =>
      threads > cores ? interpolate(w.coresThreads, { cores, threads }) : interpolate(w.cores, { cores }),
    memory: (bytes: number) => interpolate(w.memory, { size: formatBytes(bytes, locale) }),
    kernel: (kernel: string) => interpolate(w.kernel, { kernel }),
    /** The same words for every kind: “This Wi-Fi card has no driver yet.” */
    status: {
      no_driver: part(w.status.no_driver),
      no_firmware: part(w.status.no_firmware),
      disabled: part(w.status.disabled),
    } as Record<Exclude<HardwareStatus, 'ok'>, (kind: HardwareKind) => string>,
    noDriver: w.noDriver,
    connected: w.connected,
    notConnected: w.notConnected,
    screenConnected: w.screenConnected,
    inputs: (n: number) => w.inputs(n),
    outputs: (n: number) => w.outputs(n),
    /** The machine's facts as tiles (`hardwareSpecs`). */
    specs: w.specs,
    disks: (n: number) => w.disks(n),
    /** The badge under the machine's name when every part works. */
    everyPartWorks: w.everyPartWorks,
    /** The card of the parts that don't work as they should. */
    problemsLabel: w.problemsLabel,
    /** The badge under the machine's name when a part doesn't work as it should. */
    needAttention: (n: number) => w.needAttention(n),
    /** How many parts a group has, after its name. */
    parts: (n: number) => w.parts(n),
  } as const;
}

export type HardwareText = ReturnType<typeof hardwareText>;

/** HARDWARE's words in English. */
export const HARDWARE_TEXT: HardwareText = hardwareText('en');

/* The section ----------------------------------------------------------------------------------------------------- */

/** One device as a compact row: its name, what it is and does, and its driver (or “No driver”). */
export interface HardwareRowView {
  key: string;
  kind: HardwareKind;
  title: string;
  meta: string | null;
  /** Its driver, “No driver” when it needs one it hasn't, or null (a part that needs none, such as a battery). */
  driver: string | null;
  /** The driver is missing (“No driver”, muted). */
  noDriver: boolean;
  /** Null when it works. */
  dot: Dot | null;
}

/** A device that doesn't work, in one line (HD-11's words). */
export interface HardwareProblemView {
  key: string;
  kind: HardwareKind;
  title: string;
  meta: string;
  dot: Dot;
}

export interface HardwareSectionView {
  /** “ASUSTeK ROG Flow Z13 GZ302EA”, “Virtual machine (KVM)”. */
  machine: string;
  /** “AMD Ryzen AI Max+ 395 · 16 cores, 32 threads · 32 GB memory · Linux 6.18.53”. */
  machineMeta: string;
  problems: HardwareProblemView[];
  groups: { group: HardwareGroup; label: string; rows: HardwareRowView[] }[];
}

/** A device's status in words, or null when it works. */
export function hardwareStatusText(
  d: Pick<HardwareDevice, 'kind' | 'status'>,
  locale?: string | null,
): string | null {
  return d.status === 'ok' ? null : hardwareText(locale).status[d.status](d.kind);
}

/** Link speed as people read it: `100 Mbit/s`, `1 Gbit/s`, `2.5 Gbit/s` (`2,5 Gbit/s` in Dutch). */
export function formatLinkSpeed(mbps: number, locale?: string | null): string {
  if (mbps < 1000) return `${mbps} Mbit/s`;
  const g = mbps / 1000;
  const shown = formatLocaleNumber(Number(g.toFixed(1)), locale, {
    maximumFractionDigits: 1,
    useGrouping: false,
  });
  return `${shown} Gbit/s`;
}

/** What a device is and does, in a few words (its vendor first). */
function details(d: HardwareDevice, T: HardwareText, locale?: string | null): string[] {
  const out: string[] = [];
  switch (d.kind) {
    case 'wired':
      if (d.link) out.push(d.link === 'up' ? T.connected : T.notConnected);
      if (d.link === 'up' && d.speedMbps) out.push(formatLinkSpeed(d.speedMbps, locale));
      break;
    case 'wifi':
      if (d.link === 'up') out.push(T.connected);
      break;
    case 'sound':
      if (d.playback) out.push(T.outputs(d.playback));
      if (d.capture) out.push(T.inputs(d.capture));
      break;
    case 'display':
      if (d.connected !== undefined) out.push(d.connected ? T.screenConnected : T.notConnected);
      break;
    case 'storage':
      if (d.sizeBytes) out.push(formatBytes(d.sizeBytes, locale));
      break;
    default:
      break;
  }
  return out;
}

const dotOf = (status: HardwareStatus): Dot | null =>
  status === 'ok' ? null : status === 'disabled' ? 'warn' : 'bad';

const keyOf = (d: HardwareDevice, i: number) => `${d.kind}:${d.interface ?? d.card ?? d.id ?? d.name}:${i}`;

/** The machine's name: vendor and model, or a virtual machine and its hypervisor. */
export function hardwareMachineName(h: Pick<HostHardware, 'machine'>, locale?: string | null): string {
  const T = hardwareText(locale);
  const m = h.machine;
  if (m.virtual) return T.virtual(m.hypervisor);
  const name = [m.vendor, m.model].filter(Boolean).join(' ');
  return name || T.unknownMachine;
}

/** What HARDWARE shows (AP-3214…AP-3216). */
export function hardwareSectionView(h: HostHardware, locale?: string | null): HardwareSectionView {
  const T = hardwareText(locale);
  // The contracts' order: Wi-Fi, wired, sound and graphics first (CT-562).
  const problems = hardwareProblems(h).map((d, i) => ({
    key: `${d.kind}:${d.name}:${i}`,
    kind: d.kind,
    title: d.name,
    meta: hardwareStatusText(d, locale) as string,
    dot: dotOf(d.status) as Dot,
  }));
  const groups = HARDWARE_GROUPS.map((group) => ({
    group,
    label: T.groups[group],
    rows: h.devices
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => HARDWARE_GROUP_OF[d.kind] === group)
      .map(({ d, i }) => {
        const meta = [d.vendor ?? null, ...details(d, T, locale)].filter(Boolean).join(' · ');
        return {
          key: keyOf(d, i),
          kind: d.kind,
          title: d.name,
          meta: meta || null,
          driver: d.driver ?? (d.status === 'no_driver' ? T.noDriver : null),
          noDriver: d.driver === null && d.status === 'no_driver',
          dot: dotOf(d.status),
        };
      }),
  })).filter((g) => g.rows.length > 0);
  return {
    machine: hardwareMachineName(h, locale),
    machineMeta: [
      h.cpu.model,
      T.cores(h.cpu.cores, h.cpu.threads),
      T.memory(h.memoryBytes),
      T.kernel(h.kernel),
    ]
      .filter(Boolean)
      .join(' · '),
    problems,
    groups,
  };
}

/** One of the machine's facts as a tile: what it is, its value, and a line under it. */
export interface HardwareSpec {
  key: 'cpu' | 'memory' | 'storage' | 'system';
  label: string;
  value: string;
  line: string | null;
}

/**
 * The machine's facts as tiles, in this order: the processor (its model over its cores), the memory, the storage (all
 * disks together, where they say their size) and the system (Linux and its version).
 */
export function hardwareSpecs(
  h: Pick<HostHardware, 'cpu' | 'memoryBytes' | 'kernel' | 'devices'>,
  locale?: string | null,
): HardwareSpec[] {
  const T = hardwareText(locale);
  const out: HardwareSpec[] = [];
  const cores = h.cpu.cores > 0 ? T.cores(h.cpu.cores, h.cpu.threads) : null;
  if (h.cpu.model || cores)
    out.push({
      key: 'cpu',
      label: T.specs.cpu,
      value: h.cpu.model || (cores as string),
      line: h.cpu.model ? cores : null,
    });
  if (h.memoryBytes > 0)
    out.push({ key: 'memory', label: T.specs.memory, value: formatBytes(h.memoryBytes, locale), line: null });
  const disks = h.devices.filter((d) => d.kind === 'storage' && d.sizeBytes);
  if (disks.length > 0)
    out.push({
      key: 'storage',
      label: T.specs.storage,
      value: formatBytes(
        disks.reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0),
        locale,
      ),
      line: T.disks(disks.length),
    });
  if (h.kernel) out.push({ key: 'system', label: T.specs.system, value: T.kernel(h.kernel), line: null });
  return out;
}

/* The report ----------------------------------------------------------------------------------------------------- */

/** `whombat-hardware-2026-10-20.txt`: the day it was collected, in the viewer's zone. */
export function hardwareReportFileName(h: Pick<HostHardware, 'collectedAt'>, timeZone = 'UTC'): string {
  return `whombat-hardware-${dayKey(h.collectedAt, timeZone)}.txt`;
}

const STATUS_WORD: Record<HardwareStatus, string> = {
  ok: 'ok',
  no_driver: 'NO DRIVER',
  no_firmware: 'NO FIRMWARE',
  disabled: 'switched off',
};

/** A column is as wide as its widest cell, up to this; longer cells run over. */
const MAX_COLUMN = 44;

/** Rows of cells as aligned lines (two spaces between columns, no trailing spaces). */
function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const r of rows)
    r.forEach((cell, i) => {
      widths[i] = Math.min(MAX_COLUMN, Math.max(widths[i] ?? 0, [...cell].length));
    });
  return rows.map((r) =>
    r
      .map((cell, i) =>
        i === r.length - 1 ? cell : cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - [...cell].length)),
      )
      .join('  ')
      .trimEnd(),
  );
}

/** “2026-10-20 09:22 UTC”. */
const utc = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** What a device does, for the report: interface and link, speed, inputs and outputs, card, screen, size. */
function reportDetails(d: HardwareDevice): string {
  const out: string[] = [];
  if (d.interface) out.push(d.link ? `${d.interface} ${d.link}` : d.interface);
  if (d.speedMbps) out.push(formatLinkSpeed(d.speedMbps));
  if (d.card) out.push(`card ${d.card}`);
  if (d.capture !== undefined) out.push(`capture ${d.capture}`);
  if (d.playback !== undefined) out.push(`playback ${d.playback}`);
  if (d.connected !== undefined) out.push(d.connected ? 'connected' : 'not connected');
  if (d.sizeBytes) out.push(formatBytes(d.sizeBytes));
  return out.join(', ');
}

/**
 * The hardware report as a text file (HD-03, AP-3217): a header (the Whombat, the app's version, when it was
 * collected), the machine, CPU, memory and kernel, the problems in words, one aligned line per device (kind, name,
 * vendor, bus, id, driver, status, details) grouped as the section shows them, and the kernel's lines. Plain UTF-8,
 * one `\n` per line; no serial numbers or MAC addresses (the report never has them). It stays in English whatever the
 * app's language: it is written for support, who read every report the same way.
 */
export function hardwareReportText(h: HostHardware, about: { burrow: string; version: string }): string {
  const m = h.machine;
  const head = table([
    ['Whombat', about.burrow],
    ['Version', about.version],
    ['Collected', utc(h.collectedAt)],
  ]);
  const machine = table(
    [
      ['Machine', hardwareMachineName(h)],
      ['Vendor', m.vendor ?? ''],
      ['Model', m.model ?? ''],
      ['Family', m.family ?? ''],
      ['Firmware', m.firmware ?? ''],
      ['Virtual', m.virtual ? `yes${m.hypervisor ? ` (${m.hypervisor})` : ''}` : 'no'],
      ['CPU', `${h.cpu.model} (${h.cpu.cores} cores, ${h.cpu.threads} threads)`],
      ['Memory', formatBytes(h.memoryBytes)],
      ['Kernel', h.kernel],
    ].filter(([label, value]) => value !== '' || label === 'Machine'),
  );
  const problems = hardwareProblems(h).map((d) => `- ${d.name}: ${hardwareStatusText(d)}`);
  const ordered = HARDWARE_GROUPS.flatMap((g) => h.devices.filter((d) => HARDWARE_GROUP_OF[d.kind] === g));
  const devices = table([
    ['KIND', 'NAME', 'VENDOR', 'BUS', 'ID', 'DRIVER', 'STATUS', 'DETAILS'],
    ...ordered.map((d) => [
      d.kind,
      d.name,
      d.vendor ?? '-',
      d.bus,
      d.id ?? '-',
      d.driver ?? '-',
      STATUS_WORD[d.status],
      reportDetails(d),
    ]),
  ]);
  const lines = [
    'Whombat hardware report',
    '',
    ...head,
    '',
    ...machine,
    '',
    `Problems (${problems.length})`,
    ...(problems.length ? problems : ['- none']),
    '',
    `Devices (${h.devices.length})`,
    ...devices,
    '',
    `Kernel messages (${h.log.length})`,
    ...(h.log.length ? h.log : ['- none']),
  ];
  return `${lines.join('\n')}\n`;
}
