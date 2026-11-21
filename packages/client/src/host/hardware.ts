/**
 * The machine's hardware in Settings (Whombat hardware-support.md HD-01, HD-03, HD-11; app hardware-support-web.md
 * AP-3213…AP-3220): what This Whombat → About → HARDWARE shows — the machine in one line, the devices that don't work
 * first (one line each, in words), then every device by group (Network · Sound · Graphics & screens · Storage · Power ·
 * Other) — and `hardwareReportText`, the text file **Download report** saves (the phone shares it) for support. From what
 * the machine reports, never a list of models (HD-01). Shared by the web and the phone. Pure.
 */
import { dayKey, formatBytes } from '@whombat/core/text';
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

/** What a device of each kind is called in a sentence: “This Wi-Fi card has no driver yet.” */
const NOUN: Record<HardwareKind, string> = {
  wired: 'network adapter',
  wifi: 'Wi-Fi card',
  bluetooth: 'Bluetooth adapter',
  sound: 'sound card',
  graphics: 'graphics card',
  display: 'screen connector',
  storage: 'disk',
  camera: 'camera',
  battery: 'battery',
  input: 'input device',
  usb: 'USB device',
  other: 'device',
};

export const HARDWARE_TEXT = {
  section: 'HARDWARE',
  groups: {
    network: 'Network',
    sound: 'Sound',
    graphics: 'Graphics & screens',
    storage: 'Storage',
    power: 'Power',
    other: 'Other',
  } as Record<HardwareGroup, string>,
  download: 'Download report',
  share: 'Share report',
  intro:
    'What this machine has and whether each part works. Send the report to support when something doesn’t.',
  unavailable: 'The hardware couldn’t be read right now.',
  tryAgain: 'Try again',
  allWork: 'Every part has a driver.',
  virtual: (hypervisor: string | undefined) =>
    hypervisor ? `Virtual machine (${hypervisor})` : 'Virtual machine',
  unknownMachine: 'This machine',
  cores: (cores: number, threads: number) =>
    threads > cores ? `${cores} cores, ${threads} threads` : `${cores} cores`,
  memory: (bytes: number) => `${formatBytes(bytes)} memory`,
  kernel: (kernel: string) => `Linux ${kernel}`,
  /** HD-11's words for the Wi-Fi card, the same for every kind. */
  status: {
    no_driver: (kind: HardwareKind) => `This ${NOUN[kind]} has no driver yet.`,
    no_firmware: (kind: HardwareKind) => `This ${NOUN[kind]} needs firmware that isn’t there.`,
    disabled: (kind: HardwareKind) => `This ${NOUN[kind]} is switched off.`,
  } as Record<Exclude<HardwareStatus, 'ok'>, (kind: HardwareKind) => string>,
  noDriver: 'No driver',
  connected: 'Connected',
  notConnected: 'Not connected',
  screenConnected: 'Screen connected',
  inputs: (n: number) => (n === 1 ? '1 input' : `${n} inputs`),
  outputs: (n: number) => (n === 1 ? '1 output' : `${n} outputs`),
} as const;

const T = HARDWARE_TEXT;

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
export function hardwareStatusText(d: Pick<HardwareDevice, 'kind' | 'status'>): string | null {
  return d.status === 'ok' ? null : T.status[d.status](d.kind);
}

/** Link speed as people read it: `100 Mbit/s`, `1 Gbit/s`, `2.5 Gbit/s`. */
export function formatLinkSpeed(mbps: number): string {
  if (mbps < 1000) return `${mbps} Mbit/s`;
  const g = mbps / 1000;
  return `${Number.isInteger(g) ? g : g.toFixed(1).replace(/\.0$/, '')} Gbit/s`;
}

/** What a device is and does, in a few words (its vendor first). */
function details(d: HardwareDevice): string[] {
  const out: string[] = [];
  switch (d.kind) {
    case 'wired':
      if (d.link) out.push(d.link === 'up' ? T.connected : T.notConnected);
      if (d.link === 'up' && d.speedMbps) out.push(formatLinkSpeed(d.speedMbps));
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
      if (d.sizeBytes) out.push(formatBytes(d.sizeBytes));
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
export function hardwareMachineName(h: Pick<HostHardware, 'machine'>): string {
  const m = h.machine;
  if (m.virtual) return T.virtual(m.hypervisor);
  const name = [m.vendor, m.model].filter(Boolean).join(' ');
  return name || T.unknownMachine;
}

/** What HARDWARE shows (AP-3214…AP-3216). */
export function hardwareSectionView(h: HostHardware): HardwareSectionView {
  // The contracts' order: Wi-Fi, wired, sound and graphics first (CT-562).
  const problems = hardwareProblems(h).map((d, i) => ({
    key: `${d.kind}:${d.name}:${i}`,
    kind: d.kind,
    title: d.name,
    meta: hardwareStatusText(d) as string,
    dot: dotOf(d.status) as Dot,
  }));
  const groups = HARDWARE_GROUPS.map((group) => ({
    group,
    label: T.groups[group],
    rows: h.devices
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => HARDWARE_GROUP_OF[d.kind] === group)
      .map(({ d, i }) => {
        const meta = [d.vendor ?? null, ...details(d)].filter(Boolean).join(' · ');
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
    machine: hardwareMachineName(h),
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
 * one `\n` per line; no serial numbers or MAC addresses (the report never has them).
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
