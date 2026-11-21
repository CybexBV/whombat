/**
 * The box's hardware report (0.102, CT-560…CT-563; Whombat docs/decisions/hardware-support.md HD-01, HD-03): what the
 * machine has — PCI and USB devices with their drivers, network interfaces, sound cards with their capture and playback
 * devices, graphics and screens, storage, batteries, Bluetooth, cameras — and the kernel's firmware and driver errors.
 * The appliance's manager collects it from sysfs and procfs when asked (`POST /v1/host/hardware` of
 * `@whombat/control-contracts/local`, Go `protocol.HostHardware`); the runtime hands the same shape to owners through
 * the session op `host.hardware` (Settings → This Whombat → About → Hardware, and its Download report).
 *
 * Everything comes from what the machine reports, never from a list of known models (HD-01). No serial numbers and no
 * MAC addresses. No words either: kinds and statuses cross the wire, the app and the console make the words (HD-11).
 *
 * Display strings — device names, vendors, models, interface names, the kernel's lines — may be any script on one line
 * (`HOST_TEXT_RES`, the desk's form, CT-529): producers clean them (`hostText`) rather than fail.
 */
import { displayTextRe as textRe } from '@whombat/core/domain';
import { z } from 'zod';
import { Rfc3339 } from './backup.js';

/* Display text (CT-560) ------------------------------------------------------------------------------------------ */

/**
 * The lengths the hardware report's and the network's display strings take, `[min, max]` code points; since 0.120
 * (CT-931) also remote help's names (40) and command lines (500).
 */
const HOST_TEXT_LENGTHS: readonly (readonly [number, number])[] = [
  [1, 15],
  [1, 32],
  [1, 40],
  [1, 64],
  [1, 80],
  [0, 120],
  [1, 120],
  [1, 240],
  [1, 500],
];

/**
 * The display text patterns of the hardware report and the network (CT-560): any script, one line — no control, format
 * or surrogate code point and no separator but U+0020 (`ConsoleDisplayText`'s categories, the desk's form) — with the
 * length in code points in the pattern (`u` flag). Unicode patterns the cross-language subset admits by name
 * (docs/contracts/cross-language.md).
 */
export const HOST_TEXT_RES: readonly RegExp[] = HOST_TEXT_LENGTHS.map(([min, max]) => textRe(min, max));

/** A display string of `min`…`max` code points (one of `HOST_TEXT_LENGTHS`). */
export function hostTextSchema(max: number, min = 1) {
  const source = textRe(min, max).source;
  const re = HOST_TEXT_RES.find((r) => r.source === source);
  if (!re) throw new Error(`no host text pattern for ${min}…${max}`);
  return z.string().regex(re);
}
const text = hostTextSchema;

/**
 * Any string as display text of at most `max` code points (CT-560; Go `local.HostText`): runs of separators and
 * white space become one space, control, format and surrogate code points go, the ends are trimmed, and a longer
 * string is cut to `max − 1` code points and `…`. The result may be empty: a producer leaves out an optional member
 * whose text came out empty.
 */
export function hostText(input: string, max: number): string {
  const clean = input
    .replace(/[\p{Z}\s]+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
    .trim();
  const points = [...clean];
  if (points.length <= max) return clean;
  return `${points
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`;
}

/** A network interface's name as the kernel has it (`wlp1s0`, `enx00e04c680001`): at most 15 code points. */
export const InterfaceName = text(15);

/* The report ---------------------------------------------------------------------------------------------------- */

/** What a device is, for grouping (HD-03): network (`wired`, `wifi`, `bluetooth`), sound, graphics and screens, … */
export const HARDWARE_KINDS = [
  'wired',
  'wifi',
  'bluetooth',
  'sound',
  'graphics',
  'display',
  'storage',
  'camera',
  'battery',
  'input',
  'usb',
  'other',
] as const;
export const HardwareKind = z.enum(HARDWARE_KINDS);
export type HardwareKind = z.infer<typeof HardwareKind>;

/**
 * Whether a device works as far as the machine says: `ok`; `no_driver` (a device that needs one has none bound);
 * `no_firmware` (its driver failed to load a firmware file the kernel's log names); `disabled` (rfkill-blocked or
 * switched off).
 */
export const HARDWARE_STATUSES = ['ok', 'no_driver', 'no_firmware', 'disabled'] as const;
export const HardwareStatus = z.enum(HARDWARE_STATUSES);
export type HardwareStatus = z.infer<typeof HardwareStatus>;

/** Where the device sits: a PCI or USB device, a platform device (ACPI, the SoC), or a virtual one. */
export const HARDWARE_BUSES = ['pci', 'usb', 'platform', 'virtual'] as const;
export const HardwareBus = z.enum(HARDWARE_BUSES);
export type HardwareBus = z.infer<typeof HardwareBus>;

/** A network interface's link (its carrier). */
export const HARDWARE_LINKS = ['up', 'down'] as const;
export const HardwareLink = z.enum(HARDWARE_LINKS);
export type HardwareLink = z.infer<typeof HardwareLink>;

const Bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** PCM devices of a sound card. */
const PcmCount = z.number().int().min(0).max(64);

/**
 * One device (HD-03). `name` from the hwdata database (`pci.ids`, `usb.ids`) or the device's own strings; `id` the
 * vendor and device ids (`14c3:7925`); `driver` the bound driver (null: none). By kind: `interface`, `link` and
 * `speedMbps` for network interfaces; `capture` and `playback` (PCM devices) and `card` (the ALSA card id) for sound
 * cards; `connected` for a screen's connector; `sizeBytes` for storage. Never a serial number or a MAC address.
 */
export const HardwareDevice = z.object({
  kind: HardwareKind,
  name: text(120),
  vendor: text(80).optional(),
  bus: HardwareBus,
  id: z
    .string()
    .regex(/^[0-9a-f]{4}:[0-9a-f]{4}$/)
    .optional(),
  driver: text(64).nullable(),
  status: HardwareStatus,
  interface: InterfaceName.optional(),
  link: HardwareLink.optional(),
  speedMbps: z.number().int().min(0).max(10_000_000).optional(),
  capture: PcmCount.optional(),
  playback: PcmCount.optional(),
  card: text(32).optional(),
  connected: z.boolean().optional(),
  sizeBytes: Bytes.optional(),
});
export type HardwareDevice = z.infer<typeof HardwareDevice>;

/**
 * The machine from DMI (`/sys/class/dmi/id`: `sys_vendor`, `product_name`, `product_family`, `bios_version`; never a
 * serial), and whether it is a virtual machine (`hypervisor`: `kvm`, `qemu`, `microsoft`, … as systemd names them).
 * A member the machine doesn't say is left out.
 */
export const HardwareMachine = z.object({
  vendor: text(80).optional(),
  model: text(120).optional(),
  family: text(80).optional(),
  firmware: text(80).optional(),
  virtual: z.boolean(),
  hypervisor: text(32).optional(),
});
export type HardwareMachine = z.infer<typeof HardwareMachine>;

/** The processor: its model (empty when the machine doesn't say), cores and threads. */
export const HardwareCpu = z.object({
  model: text(120, 0),
  cores: z.number().int().min(1).max(4_096),
  threads: z.number().int().min(1).max(4_096),
});
export type HardwareCpu = z.infer<typeof HardwareCpu>;

/** At most this many devices, and kernel lines of at most `HOST_HARDWARE_LOG_LINE_MAX` code points. */
export const HOST_HARDWARE_DEVICES_MAX = 256;
export const HOST_HARDWARE_LOG_MAX = 40;
export const HOST_HARDWARE_LOG_LINE_MAX = 240;

/**
 * The hardware report (HD-03): when it was collected, the running kernel (`uname -r`), the machine, the processor, the
 * memory (`MemTotal`), the devices, and the kernel's firmware and driver error lines (filtered, oldest first; a read-only
 * helper op collects them).
 */
export const HostHardware = z.object({
  collectedAt: Rfc3339,
  kernel: text(64),
  machine: HardwareMachine,
  cpu: HardwareCpu,
  memoryBytes: Bytes,
  devices: z.array(HardwareDevice).max(HOST_HARDWARE_DEVICES_MAX),
  log: z.array(text(HOST_HARDWARE_LOG_LINE_MAX)).max(HOST_HARDWARE_LOG_MAX),
});
export type HostHardware = z.infer<typeof HostHardware>;

/** The kinds whose problems the app lists first, in this order (CT-562). */
export const HARDWARE_PROBLEM_KINDS: readonly HardwareKind[] = ['wifi', 'wired', 'sound', 'graphics'];

/** A device that doesn't work as it should (CT-562). */
export interface HardwareProblem {
  kind: HardwareKind;
  name: string;
  status: Exclude<HardwareStatus, 'ok'>;
}

/**
 * The devices whose status isn't `ok` (CT-562): Wi-Fi, wired, sound and graphics first (in that order), then the rest;
 * within a kind in the report's order. The words are the app's (HD-11).
 */
export function hardwareProblems(h: Pick<HostHardware, 'devices'>): HardwareProblem[] {
  const rank = (k: HardwareKind) => {
    const i = HARDWARE_PROBLEM_KINDS.indexOf(k);
    return i < 0 ? HARDWARE_PROBLEM_KINDS.length : i;
  };
  return h.devices
    .filter((d) => d.status !== 'ok')
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d.kind) - rank(b.d.kind) || a.i - b.i)
    .map(({ d }) => ({ kind: d.kind, name: d.name, status: d.status as HardwareProblem['status'] }));
}

/* The session op `host.hardware` ------------------------------------------------------------------------ */

export const HostHardwareInput = z.strictObject({});

/**
 * `hardware` null with a `reason`: `not_managed` — a self-hosted server, no manager to ask; `unavailable` — the
 * manager didn't answer or is too old.
 */
export const HostHardwareOutput = z.object({
  hardware: HostHardware.nullable(),
  reason: z.enum(['not_managed', 'unavailable']).optional(),
});
export type HostHardwareOutput = z.infer<typeof HostHardwareOutput>;
