/**
 * QEMU/KVM through libvirt (Whombat incus-unraid.md IU-13; app docs/decisions/incus-unraid-wq.md AP-1647…): a
 * `libvirt` server's tabs, a libvirt VM's tabs, its configuration in the Proxmox-like keys of contracts 0.84
 * (`disk<N>`, `cdrom<N>`, `net<N>`, `vcpus`, `memory_mb`, `cpu_mode`, `boot`, `on_*`) read and written item by item
 * (`props.ts`, so sub-keys Whombat has no field for survive), the words its rows say, the new-VM form with its OS
 * presets, pools, volumes, ISO images, networks with their leases and backups as rows. The same VM page serves a VM on
 * an Unraid server (its VM Manager folders instead of pools). Pure; the web and Android draw these.
 */
import {
  type HostBackupVolume,
  type HostChoices,
  type HostGuest,
  type HostGuestConfig,
  type HostHint,
  type HostLibvirtDetail,
  type HostLibvirtNetwork,
  type HostLibvirtPool,
  type HostManageReadResult,
  type HostOsVariant,
  type HostRemoteControl,
  type HostServerDetail,
  LIBVIRT_DOMAINS_FOLDER,
  LIBVIRT_ISOS_FOLDER,
  LIBVIRT_NAME_PATTERN,
} from '@whombat/core/domain';
import { currentValue, keyOrder, keysOf } from './config';
import { formatBytesBinary, plural } from './format';
import { isIncusServer } from './incus';
import { editProps, getProp, isOn, parseProps } from './props';
import { isUnraidServer } from './unraid';

type Cfg = HostGuestConfig | undefined;

/* Server and guest kinds ---------------------------------------------------------------------------- */

/** A server whose page is QEMU/KVM's (libvirt without Proxmox VE, Unraid or Incus; the hub decides). */
/**
 * A server whose page is QEMU/KVM's: the hub says so (libvirt without Proxmox VE, Unraid or Incus), or a standard host
 * with libvirt's parts and nothing else (an older hub). Shared with the phone (`libvirt-mobile.ts`).
 */
export function isLibvirtServer(
  d: Pick<HostServerDetail, 'server' | 'libvirt' | 'proxmox' | 'unraid' | 'incus'> | null | undefined,
): boolean {
  if (!d) return false;
  if (d.server.platform === 'libvirt') return true;
  return d.server.platform === 'standard' && !!d.libvirt && !d.proxmox && !d.unraid && !d.incus;
}

/** What the UI calls a libvirt server's kind. */
export const LIBVIRT_KIND_WORD = 'QEMU/KVM';

/** A guest libvirt runs (on a QEMU/KVM server, an Unraid server or any host with libvirt). */
export function isLibvirtGuest(g: Pick<HostGuest, 'platform'> | string): boolean {
  return typeof g === 'string' ? g.startsWith('libvirt:') : g.platform === 'libvirt';
}

export type LibvirtServerTab =
  | 'summary'
  | 'guests'
  | 'storage'
  | 'network'
  | 'backups'
  | 'sensors'
  | 'system';

/** A QEMU/KVM server's tabs: the Proxmox page's six with Network after Storage. */
export const LIBVIRT_SERVER_TABS: readonly LibvirtServerTab[] = [
  'summary',
  'guests',
  'storage',
  'network',
  'backups',
  'sensors',
  'system',
];

export const LIBVIRT_SERVER_TAB_WORDS: Record<LibvirtServerTab, string> = {
  summary: 'Summary',
  guests: 'Machines',
  storage: 'Storage',
  network: 'Network',
  backups: 'Backups',
  sensors: 'Sensors',
  system: 'System',
};

export function parseLibvirtServerTab(v: unknown): LibvirtServerTab {
  return typeof v === 'string' && (LIBVIRT_SERVER_TABS as readonly string[]).includes(v)
    ? (v as LibvirtServerTab)
    : 'summary';
}

export type LibvirtGuestTab = 'summary' | 'hardware' | 'options' | 'snapshots' | 'backups' | 'tasks' | 'log';

export const LIBVIRT_GUEST_TAB_WORDS: Record<LibvirtGuestTab, string> = {
  summary: 'Summary',
  hardware: 'Hardware',
  options: 'Options',
  snapshots: 'Snapshots',
  backups: 'Backups',
  tasks: 'Tasks',
  log: 'Log',
};

/**
 * A libvirt VM's tabs: Hardware, Options, Backups, Tasks and Log need Manage on both sides (and a runtime with
 * `hosts.libvirt`); Snapshots need the power switch, as on Proxmox.
 */
export function libvirtGuestTabs(
  rc: Pick<HostRemoteControl, 'power'> | undefined,
  o: { manage: boolean },
): LibvirtGuestTab[] {
  const tabs: LibvirtGuestTab[] = ['summary'];
  if (o.manage) tabs.push('hardware', 'options');
  if (rc?.power) tabs.push('snapshots');
  if (o.manage) tabs.push('backups', 'tasks', 'log');
  return tabs;
}

export function parseLibvirtGuestTab(v: unknown, allowed: readonly LibvirtGuestTab[]): LibvirtGuestTab {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as LibvirtGuestTab)
    : 'summary';
}

/** Where a locked setting is changed: Unraid's own VM page on an Unraid server, else virt-manager. */
export function libvirtLockPlace(serverPlatform: string | undefined): string {
  return serverPlatform === 'unraid' ? 'Unraid’s VM page' : 'virt-manager';
}

/** What a pending row says after its value (libvirt keeps a running VM as it is until it's started again). */
export const LIBVIRT_LATER = 'at the next start';

/* Keys ----------------------------------------------------------------------------------------------- */

export const LV_DISK_RE = /^disk\d+$/;
export const LV_CDROM_RE = /^cdrom\d+$/;
export const LV_NET_RE = /^net\d+$/;
export const LV_HOSTDEV_RE = /^hostdev\d+$/;
export const LV_GRAPHICS_RE = /^graphics\d+$/;

/** The keys the Hardware and Options tabs show as rows; everything else is under Other settings. */
const SHOWN = [
  /^(name|title|description|vcpus|vcpus_max|memory_mb|memory_max_mb|autostart|boot|cpu_mode)$/,
  /^on_(poweroff|reboot|crash)$/,
  /^(machine|firmware|secure_boot|tpm|video)$/,
  LV_DISK_RE,
  LV_CDROM_RE,
  LV_NET_RE,
  LV_HOSTDEV_RE,
  LV_GRAPHICS_RE,
];

/** Settings no row shows (watchdog, RNG, serial ports, channels …), read-only under Other settings. */
export function libvirtOtherKeys(cfg: Cfg): string[] {
  if (!cfg) return [];
  const all = new Set([...Object.keys(cfg.values), ...Object.keys(cfg.pending ?? {})]);
  return [...all].filter((k) => !SHOWN.some((re) => re.test(k))).sort(keyOrder);
}

/** The first free `disk<N>`, `cdrom<N>` or `net<N>` (pending ones count as taken). */
export function lvFreeKey(cfg: Cfg, prefix: 'disk' | 'cdrom' | 'net'): string {
  const taken = new Set([...Object.keys(cfg?.values ?? {}), ...Object.keys(cfg?.pending ?? {})]);
  for (let i = 0; i < 64; i++) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
  return `${prefix}64`;
}

/* Disks ---------------------------------------------------------------------------------------------- */

export const LV_DISK_BUSES: readonly { value: string; label: string }[] = [
  { value: 'virtio', label: 'VirtIO (fastest)' },
  { value: 'sata', label: 'SATA (Windows without drivers)' },
  { value: 'scsi', label: 'SCSI' },
];

const BUS_WORD: Record<string, string> = {
  virtio: 'VirtIO',
  sata: 'SATA',
  scsi: 'SCSI',
  ide: 'IDE',
  usb: 'USB',
};

export interface LvDisk {
  /** A path, `pool/volume`, or (a new disk) empty. */
  source: string;
  bus: string;
  format: string;
  target: string;
  sizeBytes: number | null;
  readonly: boolean;
  /** Made at the next save: `new=<size>` on `storage`. */
  newSize: string | null;
  storage: string | null;
}

export function readLvDisk(v: string | undefined): LvDisk {
  const p = parseProps(v ?? '');
  const size = Number(getProp(p, 'size'));
  return {
    source: getProp(p, 'source') ?? '',
    bus: getProp(p, 'bus') ?? 'virtio',
    format: getProp(p, 'format') ?? '',
    target: getProp(p, 'target') ?? '',
    sizeBytes: Number.isFinite(size) && size > 0 ? size : null,
    readonly: isOn(getProp(p, 'readonly')),
    newSize: getProp(p, 'new') ?? null,
    storage: getProp(p, 'storage') ?? null,
  };
}

/** “/mnt/user/domains/pbs/vdisk1.img” → “vdisk1.img”; “default/web.qcow2” → “web.qcow2”. */
export function lvFileName(source: string): string {
  return source.split('/').filter(Boolean).pop() ?? source;
}

/** Where a disk's file is: its pool (`default/web.qcow2` → “default”) or its folder. */
export function lvSourcePlace(source: string): string {
  if (!source) return '';
  if (source.startsWith('/')) return source.slice(0, source.lastIndexOf('/')) || '/';
  const i = source.indexOf('/');
  return i > 0 ? source.slice(0, i) : '';
}

/** A disk row's value: its size, else its file. */
export function lvDiskValue(v: string | undefined): string {
  const d = readLvDisk(v);
  if (d.newSize) return `New ${d.newSize.replace(/G$/, ' GiB')}`;
  return d.sizeBytes != null ? formatBytesBinary(d.sizeBytes) : lvFileName(d.source);
}

/** A disk row's second line: file · bus · format · read-only. */
export function lvDiskWords(v: string | undefined): string {
  const d = readLvDisk(v);
  if (d.newSize)
    return [`on ${storageWord(d.storage ?? '')}`, BUS_WORD[d.bus] ?? d.bus, d.format]
      .filter(Boolean)
      .join(' · ');
  return [d.source, BUS_WORD[d.bus] ?? d.bus, d.format, d.readonly ? 'read-only' : '']
    .filter(Boolean)
    .join(' · ');
}

/** “default” → “default”; `folder:domains` → “the VM folder”; `folder:isos` → “the ISO folder”. */
export function storageWord(id: string): string {
  if (id === LIBVIRT_DOMAINS_FOLDER) return 'the VM folder';
  if (id === LIBVIRT_ISOS_FOLDER) return 'the ISO folder';
  return id;
}

/** A new disk: `new=20G,storage=default,format=qcow2,bus=virtio`. */
export function newLvDiskValue(storage: string, sizeGb: string, bus: string, format: string): string {
  return `new=${sizeGb.trim()}G,storage=${storage},format=${format},bus=${bus}`;
}

/** An existing volume or file attached as a disk; the format follows its name unless given. */
export function existingLvDiskValue(source: string, bus: string, format?: string): string {
  const f = format || (/\.qcow2$/i.test(source) ? 'qcow2' : 'raw');
  return `source=${source.trim()},bus=${bus},format=${f}`;
}

/** Why a disk's file path can't be used (absolute, no `..`). */
export function lvPathError(path: string): string | null {
  const p = path.trim();
  if (!p) return 'Pick a volume or type the file’s path.';
  if (!p.startsWith('/') && !/^[^/\s]+\/[^/\s]+$/.test(p)) return 'A full path (/…) or pool/volume.';
  if (p.split('/').includes('..')) return 'No “..” in the path.';
  return null;
}

/**
 * A disk that can't take an internal snapshot (libvirt keeps them inside qcow2 files only): its file name, or null
 * when every disk can. CD/DVD drives don't count.
 */
export function snapshotBlocker(cfg: Cfg): string | null {
  for (const k of keysOf(cfg, LV_DISK_RE)) {
    const d = readLvDisk(currentValue(cfg, k));
    if (!d.newSize && d.format && d.format !== 'qcow2') return lvFileName(d.source) || k;
  }
  return null;
}

/* CD/DVD drives -------------------------------------------------------------------------------------- */

export const LV_EMPTY = 'empty';

export function lvCdromSource(v: string | undefined): string {
  const s = getProp(parseProps(v ?? ''), 'source') ?? '';
  return s === LV_EMPTY ? '' : s;
}

/** “No disc”, else the ISO's file name. */
export function lvCdromWords(v: string | undefined): string {
  const s = lvCdromSource(v);
  return s ? lvFileName(s) : 'No disc';
}

/** The drive with another disc in it (or none: `source=empty`), every other sub-key as it was. */
export function withLvCdrom(v: string | undefined, source: string): string {
  return editProps(v ?? '', { source: source || LV_EMPTY });
}

export function newLvCdrom(source: string, bus = 'sata'): string {
  return `source=${source || LV_EMPTY},bus=${bus}`;
}

/* Network cards -------------------------------------------------------------------------------------- */

export const LV_NIC_MODELS: readonly { value: string; label: string }[] = [
  { value: 'virtio', label: 'VirtIO (fastest)' },
  { value: 'e1000e', label: 'Intel E1000E (Windows without drivers)' },
  { value: 'rtl8139', label: 'Realtek RTL8139 (old systems)' },
];

const MODEL_WORD: Record<string, string> = {
  virtio: 'VirtIO',
  'virtio-net': 'VirtIO',
  e1000e: 'Intel E1000E',
  e1000: 'Intel E1000',
  rtl8139: 'Realtek RTL8139',
};

export interface LvNic {
  model: string;
  /** `network:<name>`, `bridge:<name>`, or what the card had that Whombat doesn't change (`direct:vhost0`). */
  link: string;
  mac: string;
  up: boolean;
}

export function readLvNic(v: string | undefined): LvNic {
  const p = parseProps(v ?? '');
  const network = getProp(p, 'network');
  const bridge = getProp(p, 'bridge');
  const direct = getProp(p, 'direct');
  return {
    model: getProp(p, 'model') ?? 'virtio',
    link: network ? `network:${network}` : bridge ? `bridge:${bridge}` : direct ? `direct:${direct}` : '',
    mac: getProp(p, 'mac') ?? '',
    up: getProp(p, 'link') !== 'down',
  };
}

/** “default” (a libvirt network), “bridge br0”, “macvtap on vhost0”. */
export function lvLinkWords(link: string): string {
  const [kind, name = ''] = link.split(/:(.*)/s);
  if (kind === 'network') return name;
  if (kind === 'bridge') return `bridge ${name}`;
  if (kind === 'direct') return `macvtap on ${name}`;
  return 'not connected';
}

/** A card's row value: “VirtIO on default”. */
export function lvNicWords(v: string | undefined): string {
  const n = readLvNic(v);
  return `${MODEL_WORD[n.model] ?? n.model} on ${lvLinkWords(n.link)}`;
}

/** A card's second line: MAC · “cable unplugged”. */
export function lvNicDetails(v: string | undefined): string {
  const n = readLvNic(v);
  return [n.mac, n.up ? '' : 'cable unplugged'].filter(Boolean).join(' · ');
}

/** The card with the fields changed; only what differs is written, everything else stays as it was. */
export function writeLvNic(v: string | undefined, n: LvNic, was: LvNic): string {
  const changes: Record<string, string | undefined> = {};
  if (n.model !== was.model) changes.model = n.model;
  if (n.link !== was.link) {
    const [kind, name] = n.link.split(/:(.*)/s);
    changes.network = kind === 'network' ? name : undefined;
    changes.bridge = kind === 'bridge' ? name : undefined;
    changes.direct = kind === 'direct' ? name : undefined;
  }
  if (n.mac.trim() !== was.mac) changes.mac = n.mac.trim() || undefined;
  if (n.up !== was.up) changes.link = n.up ? 'up' : 'down';
  return editProps(v ?? '', changes);
}

export function newLvNic(link: string, model = 'virtio'): LvNic {
  return { model, link, mac: '', up: true };
}

/** A new card's value (`model=virtio,network=default,link=up`). */
export function newLvNicValue(n: LvNic): string {
  const [kind, name = ''] = n.link.split(/:(.*)/s);
  return [
    `model=${n.model}`,
    kind ? `${kind}=${name}` : '',
    n.mac.trim() ? `mac=${n.mac.trim()}` : '',
    `link=${n.up ? 'up' : 'down'}`,
  ]
    .filter(Boolean)
    .join(',');
}

export function lvMacError(mac: string): string | null {
  const m = mac.trim();
  if (!m) return null;
  return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(m)
    ? null
    : 'Six pairs like 52:54:00:12:34:56, or empty for a new one.';
}

/** What a card can connect to: libvirt networks, then the host's bridges (and what it has now, kept). */
export function lvLinkOptions(
  choices: Pick<HostChoices, 'networks' | 'bridges'> | undefined,
  current = '',
): { value: string; label: string; group?: string }[] {
  const out: { value: string; label: string; group?: string }[] = [];
  for (const n of choices?.networks ?? [])
    out.push({ value: `network:${n}`, label: n, group: 'libvirt networks' });
  for (const b of choices?.bridges ?? [])
    out.push({ value: `bridge:${b}`, label: `Bridge ${b}`, group: 'Host bridges' });
  if (current && !out.some((o) => o.value === current))
    out.unshift({ value: current, label: lvLinkWords(current), group: 'Now' });
  return out;
}

/* Processors, memory, boot, power events, firmware --------------------------------------------------- */

export const CPU_MODES: readonly { value: string; label: string }[] = [
  { value: 'host-passthrough', label: 'Host passthrough (fastest)' },
  { value: 'host-model', label: 'Host model (like this CPU, movable)' },
  { value: 'maximum', label: 'Maximum (everything QEMU can offer)' },
  { value: 'custom', label: 'A CPU model…' },
];

/** “host-passthrough” → “Host passthrough”, `custom:Skylake-Client` → “Skylake-Client”. */
export function cpuModeWords(v: string | undefined): string {
  if (!v) return 'QEMU’s default';
  if (v.startsWith('custom:')) return v.slice(7);
  return CPU_MODES.find((m) => m.value === v)?.label.replace(/ \(.*\)$/, '') ?? v;
}

/** The Processors row: “4 vCPUs · Host passthrough”, “2 of 4 vCPUs · …”. */
export function lvCpuWords(v: Record<string, string>): string {
  const n = Number(v.vcpus ?? 1);
  const max = Number(v.vcpus_max ?? n);
  return [max > n ? `${n} of ${max} vCPUs` : plural(n, 'vCPU'), cpuModeWords(v.cpu_mode)].join(' · ');
}

/** The Memory row: “8 GiB”, “4 of 8 GiB”. */
export function lvMemoryWords(v: Record<string, string>): string {
  const now = Number(v.memory_mb ?? 0);
  const max = Number(v.memory_max_mb ?? now);
  const t = (mib: number) => (mib >= 1024 ? `${+(mib / 1024).toFixed(2)} GiB` : `${mib} MiB`);
  return max > now ? `${t(now)} of ${t(max)}` : t(now);
}

export const BOOT_DEVICES: readonly { value: string; label: string }[] = [
  { value: 'hd', label: 'Hard disk' },
  { value: 'cdrom', label: 'CD/DVD' },
  { value: 'network', label: 'Network (PXE)' },
];

export function lvBootOrder(v: string | undefined): string[] {
  return (v ?? '').split(',').filter((x) => BOOT_DEVICES.some((d) => d.value === x));
}

/** “Hard disk → CD/DVD”. */
export function lvBootWords(v: string | undefined): string {
  const order = lvBootOrder(v);
  return order.length
    ? order.map((x) => BOOT_DEVICES.find((d) => d.value === x)?.label ?? x).join(' → ')
    : 'The firmware’s default';
}

export const POWER_EVENT_ACTIONS: readonly { value: string; label: string }[] = [
  { value: 'destroy', label: 'Switch off' },
  { value: 'restart', label: 'Start again' },
  { value: 'preserve', label: 'Keep it paused as it is' },
  { value: 'rename-restart', label: 'Keep a copy, start again' },
];

export function powerEventWords(v: string | undefined, fallback: string): string {
  return POWER_EVENT_ACTIONS.find((a) => a.value === (v ?? fallback))?.label ?? v ?? fallback;
}

/** “UEFI with Secure Boot”, “UEFI”, “BIOS”. */
export function firmwareWords(v: Record<string, string>): string {
  if (v.firmware === 'uefi') return isOn(v.secure_boot) ? 'UEFI with Secure Boot' : 'UEFI';
  return 'BIOS (SeaBIOS)';
}

/** “TPM 2.0, emulated” from `emulator,2.0` or `model=tpm-crb,backend=emulator,version=2.0`. */
export function tpmWords(v: string | undefined): string {
  if (!v) return 'None';
  const p = parseProps(v);
  const version = getProp(p, 'version') ?? /\b(1\.2|2\.0)\b/.exec(v)?.[1] ?? '';
  const backend = getProp(p, 'backend') ?? /passthrough|emulator/.exec(v)?.[0] ?? '';
  return [`TPM${version ? ` ${version}` : ''}`, backend === 'passthrough' ? 'the host’s own' : 'emulated']
    .filter(Boolean)
    .join(', ');
}

/** “VNC · QXL video”, “SPICE”. */
export function displayWords(v: Record<string, string>): string {
  const gfx = Object.keys(v)
    .filter((k) => LV_GRAPHICS_RE.test(k))
    .sort(keyOrder)
    .map((k) => (getProp(parseProps(v[k] ?? '', 'type'), 'type') ?? '').toUpperCase());
  const model = v.video ? getProp(parseProps(v.video, 'model'), 'model') : undefined;
  return [...gfx, model ? `${model.toUpperCase()} video` : ''].filter(Boolean).join(' · ') || 'None';
}

/** A passed-through device: “PCI 0000:01:00.0 · NVIDIA …”. */
export function hostdevWords(v: string | undefined): string {
  const p = parseProps(v ?? '', 'type');
  const type = (getProp(p, 'type') ?? '').toUpperCase();
  const addr = getProp(p, 'address') ?? getProp(p, 'device') ?? '';
  const name = getProp(p, 'name') ?? '';
  return [[type, addr].filter(Boolean).join(' '), name].filter(Boolean).join(' · ') || (v ?? '');
}

/** A VM name libvirt takes (`LIBVIRT_NAME_PATTERN`). */
/**
 * What's wrong with a libvirt VM's new name (`LIBVIRT_NAME_PATTERN`), or null: empty, odd characters, its name now
 * (`current`), one another guest has (`taken`). Shared with the phone (`libvirt-mobile.ts`).
 */
export function libvirtNameError(
  name: string,
  taken: readonly string[] = [],
  current?: string,
): string | null {
  const v = name.trim();
  if (!v) return 'Fill this in.';
  if (!LIBVIRT_NAME_PATTERN.test(v)) return 'Letters, digits, dots, dashes and “_”.';
  if (current && v === current) return 'That’s its name now.';
  if (taken.includes(v)) return `There’s already a guest called ${v}.`;
  return null;
}

/* A new VM ------------------------------------------------------------------------------------------- */

export interface LibvirtCreateForm {
  name: string;
  osVariant: string;
  vcpus: string;
  memoryMb: string;
  storage: string;
  diskGb: string;
  iso: string;
  /** `network:<name>` or `bridge:<name>`. */
  link: string;
  autostart: boolean;
  start: boolean;
}

/** The OS types when the host sends none (the agent's fixed list). */
export const LIBVIRT_OS_VARIANTS: readonly HostOsVariant[] = [
  { id: 'debian13', label: 'Debian 13', firmware: 'uefi', tpm: false },
  { id: 'ubuntu24.04', label: 'Ubuntu 24.04', firmware: 'uefi', tpm: false },
  { id: 'fedora-unknown', label: 'Fedora', firmware: 'uefi', tpm: false },
  { id: 'archlinux', label: 'Arch Linux', firmware: 'uefi', tpm: false },
  { id: 'alpinelinux3.21', label: 'Alpine Linux', firmware: 'bios', tpm: false },
  { id: 'linux2024', label: 'Other Linux', firmware: 'bios', tpm: false },
  { id: 'win11', label: 'Windows 11', firmware: 'uefi', tpm: true },
  { id: 'win10', label: 'Windows 10', firmware: 'uefi', tpm: false },
  { id: 'win2k25', label: 'Windows Server 2025', firmware: 'uefi', tpm: true },
  { id: 'freebsd14.0', label: 'FreeBSD', firmware: 'bios', tpm: false },
  { id: 'generic', label: 'Other', firmware: 'bios', tpm: false },
];

export function osVariantsOf(c: Pick<HostChoices, 'osVariants'> | undefined): readonly HostOsVariant[] {
  return c?.osVariants?.length ? c.osVariants : LIBVIRT_OS_VARIANTS;
}

const isWindowsVariant = (id: string) => /^win/i.test(id);

/** Sizes a preset starts with: Windows 11 wants 4 GiB, 2 vCPUs and 64 GiB; Linux 2 GiB and 20 GiB. */
function presetSizes(id: string): Pick<LibvirtCreateForm, 'vcpus' | 'memoryMb' | 'diskGb'> {
  if (isWindowsVariant(id)) return { vcpus: '4', memoryMb: '8192', diskGb: '80' };
  if (/alpine|freebsd|generic/.test(id)) return { vcpus: '1', memoryMb: '1024', diskGb: '10' };
  return { vcpus: '2', memoryMb: '4096', diskGb: '32' };
}

/** A ready ISO for the preset (a Windows ISO for Windows, never the VirtIO driver disc; the distro's own name). */
export function preferredLibvirtIso(isos: readonly LibvirtIso[], id: string, current: string): string {
  const words: Record<string, RegExp> = {
    debian: /debian/i,
    ubuntu: /ubuntu/i,
    fedora: /fedora/i,
    arch: /arch/i,
    alpine: /alpine/i,
    win11: /win(dows)?[-_ ]?11/i,
    win10: /win(dows)?[-_ ]?10/i,
    win2k25: /server|2025/i,
    freebsd: /freebsd/i,
  };
  const key = Object.keys(words).find((k) => id.startsWith(k));
  const re = key ? words[key] : undefined;
  const hit = re ? isos.find((i) => re.test(i.name) && !/virtio/i.test(i.name)) : undefined;
  return hit?.volid ?? (isos.some((i) => i.volid === current) ? current : '');
}

/** The new-VM form's start: Debian 13, the first pool (or the VM folder), the first network, start after. */
export function libvirtDefaults(c: HostChoices | undefined): LibvirtCreateForm {
  const variants = osVariantsOf(c);
  const os = variants.find((v) => v.id.startsWith('debian')) ?? variants[0];
  const id = os?.id ?? 'generic';
  const isos = libvirtIsos(c?.isos);
  const link = c?.networks?.[0]
    ? `network:${c.networks[0]}`
    : c?.bridges?.[0]
      ? `bridge:${c.bridges[0]}`
      : '';
  return {
    name: '',
    osVariant: id,
    ...presetSizes(id),
    storage: c?.storages[0]?.id ?? '',
    iso: preferredLibvirtIso(isos, id, ''),
    link,
    autostart: false,
    start: true,
  };
}

/** Another OS type: its sizes and its ISO, unless the person changed them already. */
export function withOsVariant(
  f: LibvirtCreateForm,
  id: string,
  isos: readonly LibvirtIso[],
): LibvirtCreateForm {
  const was = presetSizes(f.osVariant);
  const next = presetSizes(id);
  return {
    ...f,
    osVariant: id,
    vcpus: f.vcpus === was.vcpus ? next.vcpus : f.vcpus,
    memoryMb: f.memoryMb === was.memoryMb ? next.memoryMb : f.memoryMb,
    diskGb: f.diskGb === was.diskGb ? next.diskGb : f.diskGb,
    iso: preferredLibvirtIso(isos, id, f.iso),
  };
}

/** What the preset sets up, and whether this host can (Windows 11 needs OVMF and swtpm). */
export function osVariantNote(
  v: HostOsVariant | undefined,
  firmware: HostLibvirtDetail['firmware'] | undefined,
): { text: string; blocked: boolean } | null {
  if (!v) return null;
  const parts = [
    v.firmware === 'uefi' ? 'UEFI' : 'BIOS',
    v.tpm ? 'a TPM 2.0' : '',
    isWindowsVariant(v.id) ? 'a SATA CD/DVD drive for the installer' : '',
  ].filter(Boolean);
  if (firmware && v.firmware === 'uefi' && !firmware.uefi)
    return {
      text: `${v.label} needs UEFI firmware (OVMF), and this server has none installed.`,
      blocked: v.tpm,
    };
  if (firmware && v.tpm && !firmware.tpm)
    return { text: `${v.label} needs a TPM, and this server has no swtpm installed.`, blocked: true };
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
  return { text: `Set up with ${list}.`, blocked: false };
}

export type LibvirtCreateErrors = Partial<Record<keyof LibvirtCreateForm, string>>;

const wholeIn = (s: string, min: number, max: number, unit: string): string | undefined => {
  const v = s.trim();
  if (!/^\d+$/.test(v)) return 'Use a whole number.';
  const n = Number(v);
  if (n < min) return `At least ${min}${unit}.`;
  if (n > max) return `At most ${max}${unit}.`;
  return undefined;
};

export function libvirtCreateErrors(f: LibvirtCreateForm): LibvirtCreateErrors {
  return {
    name: libvirtNameError(f.name) ?? undefined,
    vcpus: wholeIn(f.vcpus, 1, 512, ''),
    memoryMb: wholeIn(f.memoryMb, 128, 4_194_304, ' MiB'),
    diskGb: wholeIn(f.diskGb, 1, 65_536, ' GiB'),
    storage: f.storage ? undefined : 'Pick where its disk goes.',
    link: f.link ? undefined : 'Pick a network.',
  };
}

/** The service's field errors on the form's fields. */
export const LIBVIRT_CREATE_ERROR_FIELDS: Record<string, keyof LibvirtCreateForm> = {
  name: 'name',
  osVariant: 'osVariant',
  os_variant: 'osVariant',
  vcpus: 'vcpus',
  memory_mb: 'memoryMb',
  storage: 'storage',
  diskGb: 'diskGb',
  disk_gb: 'diskGb',
  iso: 'iso',
  network: 'link',
  bridge: 'link',
};

/** `guest.create` params (contracts 0.84: camelCase). */
export function libvirtCreateParams(f: LibvirtCreateForm) {
  const [kind, target = ''] = f.link.split(/:(.*)/s);
  return {
    platform: 'libvirt' as const,
    kind: 'vm' as const,
    name: f.name.trim(),
    osVariant: f.osVariant,
    set: {
      vcpus: f.vcpus.trim(),
      memory_mb: f.memoryMb.trim(),
      autostart: f.autostart ? '1' : '0',
    },
    storage: f.storage,
    diskGb: Number(f.diskGb),
    ...(f.iso ? { iso: f.iso } : {}),
    ...(kind === 'bridge' ? { bridge: target } : { network: target }),
    start: f.start,
  };
}

/* Pools, volumes, ISO images ------------------------------------------------------------------------- */

export interface PoolRow {
  pool: HostLibvirtPool;
  usedPct: number | null;
  /** “120 GiB of 450 GiB”. */
  usedText: string;
  /** “dir · /var/lib/libvirt/images”. */
  sub: string;
  state: 'ok' | 'warn' | 'mut';
  stateText: string;
}

export function poolRows(lv: HostLibvirtDetail | undefined): PoolRow[] {
  return (lv?.pools ?? []).map((p) => {
    const pct = p.totalBytes > 0 ? (p.usedBytes / p.totalBytes) * 100 : null;
    return {
      pool: p,
      usedPct: pct,
      usedText: `${formatBytesBinary(p.usedBytes)} of ${formatBytesBinary(p.totalBytes)}`,
      sub: [p.type, p.path].filter(Boolean).join(' · '),
      state: !p.active ? 'mut' : pct != null && pct >= 85 ? 'warn' : 'ok',
      stateText: !p.active ? 'Stopped' : p.autostart ? 'Running' : 'Running, not at boot',
    };
  });
}

export interface LibvirtIso {
  volid: string;
  name: string;
  /** Its pool, or the ISO folder. */
  place: string;
  sizeBytes: number | null;
}

/** `choices.isos` (`{volid, name, sizeBytes}` of every pool and the ISO folder) as rows, by place and name. */
export function libvirtIsos(items: readonly Record<string, unknown>[] | undefined): LibvirtIso[] {
  const out: LibvirtIso[] = [];
  for (const i of items ?? []) {
    const volid = String(i.volid ?? i.volume ?? '');
    if (!volid) continue;
    const size = i.sizeBytes ?? i.size;
    out.push({
      volid,
      name: String(i.name ?? lvFileName(volid)),
      place: String(i.storage ?? (volid.startsWith('/') ? 'ISO folder' : lvSourcePlace(volid))),
      sizeBytes: typeof size === 'number' ? size : null,
    });
  }
  return out.sort((a, b) => a.place.localeCompare(b.place) || a.name.localeCompare(b.name));
}

export interface LibvirtVolume {
  volid: string;
  name: string;
  sizeBytes: number | null;
  /** Space it takes on the pool (a thin qcow2 takes less than its size). */
  usedBytes: number | null;
  format: string;
  /** Guest ids of the VMs using it; deleting is refused while there are any. */
  usedBy: string[];
  created: string | null;
}

/** A pool's `content.list` (`platform: libvirt`, `storage: <pool>`) as rows, by name. */
export function libvirtVolumes(data: HostManageReadResult | undefined): LibvirtVolume[] {
  if (data?.op !== 'content.list') return [];
  const out: LibvirtVolume[] = [];
  for (const i of data.items as Record<string, unknown>[]) {
    const volid = String(i.volid ?? i.volume ?? '');
    if (!volid) continue;
    const num = (x: unknown) => (typeof x === 'number' ? x : null);
    out.push({
      volid,
      name: String(i.name ?? lvFileName(volid)),
      sizeBytes: num(i.sizeBytes ?? i.size),
      usedBytes: num(i.usedBytes ?? i.allocationBytes),
      format: String(i.format ?? ''),
      usedBy: Array.isArray(i.usedBy) ? i.usedBy.map(String) : [],
      created: typeof i.created === 'string' ? i.created : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const isIsoName = (name: string) => /\.(iso|img)$/i.test(name);

/** A volume's name libvirt takes (`web-data.qcow2`). */
export function volumeNameError(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Give it a name.';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(n)) return 'Letters, digits, “.”, “_” and “-”.';
  return undefined;
}

/** A downloaded image's file name: an ISO (or a raw or qcow2 cloud image). */
export function isoNameError(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Give the file a name.';
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(n)) return 'Letters, digits, “.”, “_” and “-” only.';
  if (!/\.(iso|img|qcow2)$/i.test(n)) return 'The name ends in .iso, .img or .qcow2.';
  return undefined;
}

/** Where downloaded images can go: pools, else Unraid's ISO folder. */
export function isoTargets(lv: HostLibvirtDetail | undefined): { value: string; label: string }[] {
  // An LVM pool holds block devices, not image files.
  const pools = (lv?.pools ?? []).filter((p) => p.active && p.type !== 'logical');
  const out = pools.map((p) => ({
    value: p.name,
    label: `${p.name} · ${formatBytesBinary(p.availBytes)} free`,
  }));
  if (lv?.folders?.isos) out.push({ value: LIBVIRT_ISOS_FOLDER, label: `ISO folder · ${lv.folders.isos}` });
  return out;
}

/* Networks and leases -------------------------------------------------------------------------------- */

/** “NAT”, “Routed”, “Bridge to br0”, “Isolated”. */
export function forwardWords(n: Pick<HostLibvirtNetwork, 'forward' | 'bridge'>): string {
  switch (n.forward) {
    case 'nat':
      return 'NAT to the host’s network';
    case 'route':
      return 'Routed';
    case 'bridge':
      return n.bridge ? `Bridged to ${n.bridge}` : 'Bridged';
    case 'open':
      return 'Open';
    case 'none':
    case null:
      return 'Isolated (only between VMs)';
    default:
      return n.forward ?? 'Isolated (only between VMs)';
  }
}

/* Backups -------------------------------------------------------------------------------------------- */

/** Whose backup a row is: its `guest` is the VM's name or its id. */
export function libvirtBackupOf(
  b: Pick<HostBackupVolume, 'guest'>,
  guests: readonly HostGuest[],
): HostGuest | undefined {
  const g = b.guest ?? '';
  return guests.find(
    (x) => x.platform === 'libvirt' && (x.id === g || x.name === g || x.id === `libvirt:${g}`),
  );
}

/** When a backup was made: `created`, else its folder's name (`20261016-020000`). */
export function libvirtBackupTime(b: Pick<HostBackupVolume, 'created' | 'volume'>): number | null {
  if (b.created) {
    const t = Date.parse(b.created);
    if (Number.isFinite(t)) return t;
  }
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(b.volume);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, se);
}

/** A name for a VM restored from a backup that isn't taken yet (`web-restored`, `web-restored-2`). */
export function restoredName(name: string, taken: readonly string[]): string {
  const base = `${name}-restored`;
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
  return base;
}

/* Hints ---------------------------------------------------------------------------------------------- */

/** The libvirt hints (IU-13) a server has about this VM (`libvirt.no_backup` names the VM). */
export function libvirtGuestHints(hints: readonly HostHint[], g: Pick<HostGuest, 'name' | 'id'>): HostHint[] {
  return hints.filter(
    (h) =>
      h.kind === 'libvirt.no_backup' &&
      (h.entity === g.id ||
        h.entity === g.name ||
        h.detail.split(', ').some((n) => n.replace(/\s*\(.*\)$/, '') === g.name)),
  );
}

/* Tasks ---------------------------------------------------------------------------------------------- */

const LV_TASK_WORDS: Record<string, string> = {
  backup: 'Backup',
  restore: 'Restore',
  clone: 'Clone',
  create: 'Create',
  delete: 'Delete',
  download: 'Download',
  copy: 'Disk copy',
  resize: 'Grow a disk',
};

/** A libvirt task's kind in words (`backup` → “Backup”). */
export function libvirtTaskWord(type: string): string {
  return LV_TASK_WORDS[type] ?? (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Task');
}

/**
 * Whether a server's page has a Network tab (Incus, QEMU/KVM): its own interfaces are listed there, so System leaves
 * them out. The same choice the server page makes: Incus first, then Unraid (no Network tab), then QEMU/KVM.
 */
export function serverHasNetworkTab(
  d: Pick<HostServerDetail, 'server' | 'libvirt' | 'proxmox' | 'unraid' | 'incus'>,
): boolean {
  return isIncusServer(d) || (!isUnraidServer(d) && isLibvirtServer(d));
}
