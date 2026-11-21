/**
 * The fake hosts service's libvirt side (QEMU/KVM; incus-unraid.md IU-13, the build brief §2.6): kvm-lab's pools and
 * their volumes, networks with DHCP leases and ISO images, and the VMs of every server that runs libvirt (kvm-lab's,
 * basalt's, blackbox's `pbs`): their settings with Proxmox-like keys (changes a running VM takes at once, the rest
 * `pending` until it starts; machine, firmware and passed-through devices locked; new disks on a pool or in unRAID's
 * domains folder), growing a disk, create with an OS type, clone, rename, delete, backups into the backups folder and
 * restores as new VMs, the QEMU log, snapshots and tasks; unRAID's VM Manager folders (`folder:domains`,
 * `folder:isos`) on blackbox. Its long work runs as agent tasks `libvirt:<16 hex>`.
 *
 * Its state lives on the server's detail (`detail.libvirt`): a pool's volume count and space and a network's users
 * follow the volumes and VMs and are read whenever the detail is. What the detail doesn't carry — pool volumes, a VM's
 * settings beyond its summary, pending changes, backups — is kept here (settings in the fake's guest configurations,
 * `configOf`). A server whose detail has no `libvirt` part but runs libvirt VMs (basalt) gets a stand-in kept here.
 * Routes for other guests and platforms answer `null`, so the other sides get them (the Incus side passes a libvirt
 * VM's `rename` and `log` on to this one).
 */
import { createHash, randomBytes } from 'node:crypto';
import { LIBVIRT_DOMAINS_FOLDER, LIBVIRT_ISOS_FOLDER, LIBVIRT_NAME_PATTERN } from '@whombat/core';
import { type FakeAnswer, type FakeHandler, type FakeRequest, type Json, ok, problem } from './fake-http';
import type { FakeManage, GuestConfigState, ManageHost } from './fake-manage';

type Role = 'operator' | 'admin';
type Values = Record<string, string>;
type Format = 'qcow2' | 'raw' | 'iso';
type Route = { method: string; path: string; handler: FakeHandler };

interface Volume {
  name: string;
  capacity: number;
  allocation: number;
  format: Format;
  created: string;
}

interface LibvirtPart extends Json {
  version: string;
  qemu: string | null;
  pools: Json[];
  networks: Json[];
  folders: { domains: string | null; isos: string | null } | null;
  firmware: { uefi: boolean; secure_boot: boolean; tpm: boolean };
  backups_dir: string | null;
}

/** A server's libvirt: the detail's part (or a stand-in kept here), its storages' volumes, the host's bridges. */
interface Env {
  server: string;
  lv: LibvirtPart;
  volumes: Map<string, Volume[]>;
  bridges: string[];
}

/** Where a disk or an ISO image can be: a pool, or one of unRAID's VM folders. */
interface Storage {
  id: string;
  type: string;
  path: string;
  pool: Json | null;
  holds: ('images' | 'iso')[];
}

interface Backup {
  volume: string;
  guest: string;
  vm: string;
  created: string;
  size: number;
  values: Values;
}

interface Pending {
  set: Values;
  del: string[];
}

/** A VM's settings as the seeds and new VMs give them (`values` puts them in the order a config read shows). */
interface VmSpec {
  title?: string;
  description?: string;
  vcpus: number;
  vcpusMax?: number;
  memoryMb: number;
  memoryMaxMb?: number;
  boot?: string;
  cpuMode?: string;
  onCrash?: string;
  disks: string[];
  cdroms: string[];
  nets: string[];
  firmware: 'bios' | 'uefi';
  secureBoot?: boolean;
  tpm?: boolean;
  graphics: string;
  video: string;
  hostdevs?: string[];
}

const SELF = 'That’s this Whombat itself.';
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const DAY = 86_400_000;
const NAME_HINT =
  'Letters, digits, dots, dashes and underscores, starting with a letter or digit (at most 64).';
const VOLUME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE_RE = /^[A-Za-z0-9._-]{1,200}$/;
const SIZE_RE = /^(\+)?(\d+(?:\.\d+)?)\s*([kKMGTP]?)(i?B)?$/;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const DEVICE_KEY = /^(disk|cdrom|net)(\d{1,2})$/;
const RESTRICTED = /^(machine|firmware|secure_boot|tpm|video|hostdev\d+|graphics\d+)$/;
const SCALARS = new Set([
  'name',
  'title',
  'description',
  'vcpus',
  'vcpus_max',
  'memory_mb',
  'memory_max_mb',
  'autostart',
  'boot',
  'cpu_mode',
  'on_poweroff',
  'on_reboot',
  'on_crash',
]);
const LIFECYCLE = ['destroy', 'restart', 'preserve', 'rename-restart'];
const DISK_BUSES = ['virtio', 'sata', 'scsi', 'ide'];
const CDROM_BUSES = ['sata', 'ide'];
const NIC_MODELS = ['virtio', 'e1000e', 'rtl8139'];
const DISK_ORDER = ['source', 'bus', 'format', 'target', 'size'];
const CDROM_ORDER = ['source', 'bus'];
const NET_ORDER = ['model', 'network', 'bridge', 'mac', 'link'];
/** The size of a new, empty qcow2 file. */
const QCOW2_EMPTY = 196_624;
/** What a downloaded ISO image weighs in the fake. */
const DOWNLOAD_BYTES = 640 * MiB;

/** The OS types a new VM starts from (a fixed list in the agent): Windows 11 needs UEFI and a TPM. */
const OS_VARIANTS: { id: string; label: string; firmware: 'bios' | 'uefi'; tpm: boolean }[] = [
  { id: 'debian13', label: 'Debian 13', firmware: 'uefi', tpm: false },
  { id: 'ubuntu2404', label: 'Ubuntu 24.04', firmware: 'uefi', tpm: false },
  { id: 'fedora', label: 'Fedora', firmware: 'uefi', tpm: false },
  { id: 'archlinux', label: 'Arch Linux', firmware: 'uefi', tpm: false },
  { id: 'alpine', label: 'Alpine Linux', firmware: 'bios', tpm: false },
  { id: 'linux', label: 'Other Linux', firmware: 'bios', tpm: false },
  { id: 'win11', label: 'Windows 11', firmware: 'uefi', tpm: true },
  { id: 'win10', label: 'Windows 10', firmware: 'uefi', tpm: false },
  { id: 'win2k25', label: 'Windows Server 2025', firmware: 'uefi', tpm: false },
  { id: 'freebsd', label: 'FreeBSD', firmware: 'bios', tpm: false },
  { id: 'other', label: 'Other', firmware: 'bios', tpm: false },
];

const disk = (source: string, format: 'qcow2' | 'raw', target: string, gib: number) =>
  `source=${source},bus=virtio,format=${format},target=${target},size=${gib * GiB}`;
const VNC = 'type=vnc,listen=127.0.0.1';
const NO_CD = 'source=empty,bus=sata';

/** The VMs' settings (what their domain XML holds); other libvirt VMs get theirs from their summary. */
const SEED_VMS: Record<string, VmSpec> = {
  'kvm-lab/debian-web': {
    title: 'Web server',
    description: 'nginx and PHP for the blog and the wiki.',
    vcpus: 4,
    vcpusMax: 8,
    memoryMb: 8192,
    memoryMaxMb: 12288,
    boot: 'hd,cdrom',
    onCrash: 'restart',
    disks: [disk('default/debian-web.qcow2', 'qcow2', 'vda', 40)],
    cdroms: [NO_CD],
    nets: ['model=virtio,network=default,mac=52:54:00:3a:1f:07,link=up'],
    firmware: 'bios',
    graphics: VNC,
    video: 'model=virtio,heads=1',
  },
  'kvm-lab/win11': {
    title: 'Windows 11 desktop',
    description: 'For Office and the odd game.',
    vcpus: 8,
    vcpusMax: 8,
    memoryMb: 16384,
    memoryMaxMb: 16384,
    boot: 'hd,cdrom',
    disks: [disk('fast/win11', 'raw', 'vda', 256), disk('fast/win11-games', 'raw', 'vdb', 350)],
    cdroms: ['source=isos/virtio-win-0.1.271.iso,bus=sata'],
    nets: ['model=e1000e,network=default,mac=52:54:00:9c:41:d2,link=up'],
    firmware: 'uefi',
    secureBoot: true,
    tpm: true,
    graphics: 'type=spice,listen=127.0.0.1',
    video: 'model=qxl,vram=65536,heads=1',
  },
  'kvm-lab/pfsense': {
    title: 'pfSense firewall',
    description: 'Firewall for the lab VLANs. The second Intel port is its WAN.',
    vcpus: 2,
    vcpusMax: 4,
    memoryMb: 4096,
    memoryMaxMb: 4096,
    boot: 'hd',
    cpuMode: 'host-model',
    onCrash: 'restart',
    disks: [disk('fast/pfsense', 'raw', 'vda', 16)],
    cdroms: [NO_CD],
    nets: [
      'model=virtio,network=lan,mac=52:54:00:51:0e:aa,link=up',
      'model=virtio,network=default,mac=52:54:00:51:0e:ab,link=up',
    ],
    firmware: 'bios',
    graphics: VNC,
    video: 'model=vga,heads=1',
    hostdevs: ['type=pci,address=0000:05:00.1,managed=yes'],
  },
  'kvm-lab/alpine-test': {
    vcpus: 1,
    vcpusMax: 2,
    memoryMb: 512,
    memoryMaxMb: 1024,
    boot: 'cdrom,hd',
    cpuMode: 'host-model',
    disks: [disk('default/alpine-test.qcow2', 'qcow2', 'vda', 2)],
    cdroms: ['source=isos/alpine-virt-3.22.2-x86_64.iso,bus=sata'],
    nets: ['model=virtio,network=default,mac=52:54:00:c4:77:10,link=up'],
    firmware: 'bios',
    graphics: VNC,
    video: 'model=virtio,heads=1',
  },
  'kvm-lab/nixos-build': {
    title: 'NixOS builder',
    description: 'Remote builder for the flake. CI starts it when it needs it.',
    vcpus: 8,
    vcpusMax: 16,
    memoryMb: 16384,
    memoryMaxMb: 32768,
    boot: 'hd',
    disks: [
      disk('default/nixos-build.qcow2', 'qcow2', 'vda', 100),
      disk('fast/nixos-build-store', 'raw', 'vdb', 200),
    ],
    cdroms: [NO_CD],
    nets: ['model=virtio,network=default,mac=52:54:00:e2:0b:5c,link=up'],
    firmware: 'uefi',
    graphics: VNC,
    video: 'model=virtio,heads=1',
  },
  'blackbox/pbs': {
    title: 'Proxmox Backup Server',
    description: 'Backs up the Proxmox cluster to the array.',
    vcpus: 4,
    memoryMb: 8192,
    boot: 'hd',
    disks: [disk('/mnt/user/domains/pbs/vdisk1.img', 'raw', 'vda', 64)],
    cdroms: [NO_CD],
    nets: ['model=virtio,bridge=br0,mac=52:54:00:7f:30:01,link=up'],
    firmware: 'uefi',
    graphics: VNC,
    video: 'model=qxl,heads=1',
  },
};

type SeedVolume = [name: string, capacity: number, allocation: number, format: Format];
const iso = (name: string, size: number): SeedVolume => [name, size, size, 'iso'];
const lv = (name: string, gib: number): SeedVolume => [name, gib * GiB, gib * GiB, 'raw'];

/** The volumes in the storages (what `vol-list` shows; the hub's detail has only their count). */
const SEED_VOLUMES: Record<string, Record<string, SeedVolume[]>> = {
  'kvm-lab': {
    default: [
      ['debian-web.qcow2', 40 * GiB, 12_025_908_224, 'qcow2'],
      ['alpine-test.qcow2', 2 * GiB, 398_458_880, 'qcow2'],
      ['nixos-build.qcow2', 100 * GiB, 65_498_251_264, 'qcow2'],
      ['debian-13-genericcloud-amd64.qcow2', 3 * GiB, 432_013_312, 'qcow2'],
    ],
    isos: [
      iso('debian-13.1.0-amd64-netinst.iso', 754_974_720),
      iso('ubuntu-24.04.3-live-server-amd64.iso', 3_213_064_192),
      iso('virtio-win-0.1.271.iso', 739_016_704),
      iso('alpine-virt-3.22.2-x86_64.iso', 68_157_440),
      iso('Win11_25H2_English_x64.iso', 7_838_695_424),
      iso('nixos-minimal-25.05-x86_64-linux.iso', 1_178_599_424),
    ],
    fast: [lv('win11', 256), lv('win11-games', 350), lv('pfsense', 16), lv('nixos-build-store', 200)],
  },
  blackbox: {
    [LIBVIRT_DOMAINS_FOLDER]: [['pbs/vdisk1.img', 64 * GiB, 22_548_578_304, 'raw']],
    [LIBVIRT_ISOS_FOLDER]: [
      iso('proxmox-backup-server_4.0-1.iso', 1_405_091_840),
      iso('virtio-win-0.1.271.iso', 739_016_704),
    ],
  },
};

/** The backups already in kvm-lab's backups folder (`<vm>/<yyyymmdd-hhmmss>/`). */
const SEED_BACKUPS: { server: string; vm: string; volume: string; size: number }[] = [
  { server: 'kvm-lab', vm: 'debian-web', volume: '20261009-031500', size: 11_811_160_064 },
  { server: 'kvm-lab', vm: 'win11', volume: '20261005-221000', size: 96_636_764_160 },
];

const audit = () => `au_${randomBytes(6).toString('hex')}`;
const isAnswer = (x: unknown): x is FakeAnswer =>
  !!x && typeof x === 'object' && typeof (x as FakeAnswer).status === 'number';
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');
const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');
const pairs = (hex: string) => hex.match(/../g)?.join(':') ?? '00:00:00';
const randomMac = () => `52:54:00:${pairs(randomBytes(3).toString('hex'))}`;
const gib = (n: number) => (n % GiB === 0 ? `${n / GiB} GiB` : `${(n / GiB).toFixed(1)} GiB`);
const gb = (n: number) => `${Math.round(n / 1e9)} GB`;
const stampOf = (ms: number) =>
  new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const isoOfStamp = (s: string) =>
  `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;

function parseSize(s: unknown): { bytes: number; relative: boolean } | null {
  if (typeof s === 'number') return Number.isInteger(s) && s > 0 ? { bytes: s, relative: false } : null;
  if (typeof s !== 'string') return null;
  const m = SIZE_RE.exec(s.trim());
  if (!m || (m[3] === '' && m[4] === 'iB')) return null;
  const exp = m[3] ? 'KMGTP'.indexOf((m[3] as string).toUpperCase()) + 1 : 0;
  const bytes = Number(m[2]) * (m[4] === 'B' ? 1000 : 1024) ** exp;
  return bytes >= 1 ? { bytes: Math.round(bytes), relative: m[1] === '+' } : null;
}

/** `source=…,bus=virtio` as a map. */
function parseDevice(s: string | undefined): Values {
  const out: Values = {};
  for (const part of (s ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const deviceString = (order: string[], d: Values) =>
  order
    .filter((k) => d[k] !== undefined && d[k] !== '')
    .map((k) => `${k}=${d[k]}`)
    .join(',');

/** A spec's settings in the order a config read shows them. */
function values(name: string, machine: string, autostart: boolean, s: VmSpec): Values {
  const v: Values = {
    name,
    title: s.title ?? '',
    description: s.description ?? '',
    vcpus: String(s.vcpus),
    vcpus_max: String(s.vcpusMax ?? s.vcpus),
    memory_mb: String(s.memoryMb),
    memory_max_mb: String(s.memoryMaxMb ?? s.memoryMb),
    autostart: autostart ? '1' : '0',
    boot: s.boot ?? 'hd',
    cpu_mode: s.cpuMode ?? 'host-passthrough',
    on_poweroff: 'destroy',
    on_reboot: 'restart',
    on_crash: s.onCrash ?? 'destroy',
  };
  const devices: [string, string[]][] = [
    ['disk', s.disks],
    ['cdrom', s.cdroms],
    ['net', s.nets],
  ];
  for (const [kind, list] of devices) for (const [i, d] of list.entries()) v[`${kind}${i}`] = d;
  v.machine = machine;
  v.firmware = s.firmware;
  v.secure_boot = s.secureBoot ? '1' : '0';
  v.tpm = s.tpm ? '1' : '0';
  v.graphics0 = s.graphics;
  v.video = s.video;
  for (const [i, d] of (s.hostdevs ?? []).entries()) v[`hostdev${i}`] = d;
  return v;
}

/** The device keys of some settings, in order (`disk0`, `disk1`, …). */
function deviceKeys(v: Values, kind: 'disk' | 'cdrom' | 'net'): string[] {
  return Object.keys(v)
    .filter((k) => DEVICE_KEY.exec(k)?.[1] === kind)
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
}

export class FakeLibvirt {
  readonly #envs = new Map<string, Env>();
  readonly #pending = new Map<string, Pending>();
  readonly #backups = new Map<string, Backup[]>();

  constructor(
    readonly host: ManageHost,
    readonly manage: FakeManage,
  ) {}

  /** The fixture world's libvirt state (after the fake filled in its data). */
  init(): void {
    for (const server of ['kvm-lab', 'blackbox', 'basalt', 'shale']) {
      const env = this.#env(server);
      if (!env) continue;
      for (const g of this.#vms(server)) {
        if (typeof g.autostart !== 'boolean') g.autostart = g.state === 'running';
        this.#cfg(server, g);
      }
    }
    for (const b of SEED_BACKUPS) {
      const g = this.host.guest(b.server, `libvirt:${b.vm}`);
      if (!g) continue;
      this.#backupsOf(b.server).push({
        volume: b.volume,
        guest: String(g.id),
        vm: b.vm,
        created: isoOfStamp(b.volume),
        size: b.size,
        values: { ...this.#cfg(b.server, g).values },
      });
    }
    if (this.host.guest('kvm-lab', 'libvirt:debian-web'))
      this.manage.snapshots.set('kvm-lab/libvirt:debian-web', [
        { Name: 'before-php84', Created: '2026-09-28T19:12:00Z', Description: 'Before the PHP 8.4 upgrade' },
      ]);
    if (this.#envs.has('kvm-lab')) {
      this.manage.pastTask('kvm-lab', 'backup.create', 'backup', 'libvirt:debian-web', 'libvirt', 'ok');
      this.#hints('kvm-lab');
    }
  }

  routes(): Route[] {
    const S = '/api/v1/servers/*';
    const G = `${S}/guests/*`;
    const L = `${S}/libvirt`;
    const s = (p: string[]) => p[0] as string;
    const n = (p: string[], i: number) => p[i] as string;
    return [
      // The VMs (shared routes answer only for libvirt guests, wherever they run).
      { method: 'GET', path: `${G}/config`, handler: (r, p) => this.#getConfig(r, s(p), n(p, 1)) },
      { method: 'PUT', path: `${G}/config`, handler: (r, p) => this.#setConfig(r, s(p), n(p, 1)) },
      {
        method: 'POST',
        path: `${G}/disks/*/resize`,
        handler: (r, p) => this.#resize(r, s(p), n(p, 1), n(p, 2)),
      },
      { method: 'POST', path: `${G}/clone`, handler: (r, p) => this.#clone(r, s(p), n(p, 1)) },
      { method: 'POST', path: `${G}/rename`, handler: (r, p) => this.#rename(r, s(p), n(p, 1)) },
      { method: 'DELETE', path: G, handler: (r, p) => this.#delete(r, s(p), n(p, 1)) },
      { method: 'GET', path: `${G}/log`, handler: (r, p) => this.#log(r, s(p), n(p, 1)) },
      { method: 'GET', path: `${G}/snapshots`, handler: (r, p) => this.#snapshots(r, s(p), n(p, 1)) },
      { method: 'GET', path: `${G}/tasks`, handler: (r, p) => this.#guestTasks(r, s(p), n(p, 1)) },
      { method: 'GET', path: `${G}/backups`, handler: (r, p) => this.#listBackups(r, s(p), n(p, 1)) },
      { method: 'POST', path: `${G}/backups`, handler: (r, p) => this.#backup(r, s(p), n(p, 1)) },
      // Host routes with `platform: libvirt` (or on a QEMU/KVM server).
      { method: 'POST', path: `${S}/guests`, handler: (r, p) => this.#create(r, s(p)) },
      { method: 'GET', path: `${S}/manage/choices`, handler: (r, p) => this.#choices(r, s(p)) },
      { method: 'POST', path: `${S}/backups/restore`, handler: (r, p) => this.#restore(r, s(p)) },
      { method: 'PATCH', path: `${S}/backups`, handler: (r, p) => this.#updateBackup(r, s(p)) },
      { method: 'DELETE', path: `${S}/backups`, handler: (r, p) => this.#deleteBackup(r, s(p)) },
      { method: 'GET', path: `${S}/storage/*/content`, handler: (r, p) => this.#content(r, s(p), n(p, 1)) },
      {
        method: 'POST',
        path: `${S}/storage/*/download`,
        handler: (r, p) => this.#download(r, s(p), n(p, 1)),
      },
      { method: 'DELETE', path: `${S}/storage/content`, handler: (r, p) => this.#deleteContent(r, s(p)) },
      // The host's libvirt: pool volumes and network leases.
      {
        method: 'POST',
        path: `${L}/pools/*/volumes`,
        handler: (r, p) => this.#createVolume(r, s(p), n(p, 1)),
      },
      {
        method: 'POST',
        path: `${L}/pools/*/volumes/*/resize`,
        handler: (r, p) => this.#resizeVolume(r, s(p), n(p, 1), n(p, 2)),
      },
      {
        method: 'DELETE',
        path: `${L}/pools/*/volumes/*`,
        handler: (r, p) => this.#deleteVolume(r, s(p), n(p, 1), n(p, 2)),
      },
      { method: 'GET', path: `${L}/networks/*/leases`, handler: (r, p) => this.#leases(r, s(p), n(p, 1)) },
    ];
  }

  /* State ----------------------------------------------------------------------------------------------------------- */

  #kind(server: string): string {
    return String((this.host.detailOf(server)?.server as Json | undefined)?.detail_view ?? '');
  }

  #vms(server: string): Json[] {
    return this.host.guestsOf(server).filter((g) => g.platform === 'libvirt');
  }

  #key(server: string, guestId: string): string {
    return `${server}/${guestId}`;
  }

  /** The server's libvirt: its detail's part, a stand-in for a server that runs libvirt VMs without one, or null. */
  #env(server: string): Env | null {
    const known = this.#envs.get(server);
    if (known) return known;
    const detail = this.host.detailOf(server);
    if (!detail) return null;
    const part = detail.libvirt;
    let lvPart: LibvirtPart;
    if (part && typeof part === 'object' && !Array.isArray(part)) lvPart = part as LibvirtPart;
    else if (this.#vms(server).length > 0) lvPart = this.#standIn();
    else return null;
    const env: Env = { server, lv: lvPart, volumes: new Map(), bridges: ['br0'] };
    for (const [storage, list] of Object.entries(SEED_VOLUMES[server] ?? {}))
      env.volumes.set(
        storage,
        list.map(([name, capacity, allocation, format]) => ({
          name,
          capacity,
          allocation,
          format,
          created: '2026-09-02T10:12:00Z',
        })),
      );
    this.#envs.set(server, env);
    this.#liven(env);
    return env;
  }

  /** What a host whose agent reports no libvirt part would have: one pool, the NAT network, every firmware. */
  #standIn(): LibvirtPart {
    return {
      version: '11.10.0',
      qemu: '10.0.3',
      pools: [
        {
          name: 'default',
          type: 'dir',
          active: true,
          autostart: true,
          path: '/var/lib/libvirt/images',
          used_bytes: 300_000_000_000,
          total_bytes: 1_000_000_000_000,
          avail_bytes: 700_000_000_000,
          volumes: 0,
        },
      ],
      networks: [
        {
          name: 'default',
          active: true,
          autostart: true,
          bridge: 'virbr0',
          forward: 'nat',
          ipv4: '192.168.122.1/24',
          dhcp: true,
          used_by: 0,
        },
      ],
      folders: null,
      firmware: { uefi: true, secure_boot: true, tpm: true },
      backups_dir: '/var/lib/libvirt/images/.whombat-backups',
    };
  }

  /** The counts that follow from the volumes and VMs, read whenever the detail is. */
  #liven(env: Env): void {
    const live = (e: Json, key: string, get: () => unknown) =>
      Object.defineProperty(e, key, { get, enumerable: true, configurable: true });
    for (const p of env.lv.pools) {
      const name = String(p.name);
      const total = Number(p.total_bytes ?? 0);
      const tracked = () => this.#vols(env, name).reduce((sum, v) => sum + v.allocation, 0);
      const other = Math.max(0, Number(p.used_bytes ?? 0) - tracked());
      live(p, 'used_bytes', () => other + tracked());
      live(p, 'avail_bytes', () => Math.max(0, total - other - tracked()));
      live(p, 'volumes', () => this.#vols(env, name).length);
    }
    for (const net of env.lv.networks)
      live(net, 'used_by', () => this.#networkUsers(env.server, String(net.name)).length);
  }

  #vols(env: Env, storage: string): Volume[] {
    let list = env.volumes.get(storage);
    if (!list) {
      list = [];
      env.volumes.set(storage, list);
    }
    return list;
  }

  #storages(env: Env): Storage[] {
    const out: Storage[] = env.lv.pools.map((p) => ({
      id: String(p.name),
      type: String(p.type ?? 'dir'),
      path: String(p.path ?? ''),
      pool: p,
      holds: ['dir', 'fs', 'netfs'].includes(String(p.type)) ? ['images', 'iso'] : ['images'],
    }));
    const f = env.lv.folders;
    if (f?.domains)
      out.push({ id: LIBVIRT_DOMAINS_FOLDER, type: 'dir', path: f.domains, pool: null, holds: ['images'] });
    if (f?.isos) out.push({ id: LIBVIRT_ISOS_FOLDER, type: 'dir', path: f.isos, pool: null, holds: ['iso'] });
    return out;
  }

  #storage(env: Env, id: unknown): Storage | null {
    return this.#storages(env).find((st) => st.id === id) ?? null;
  }

  /** Where new disks go when nobody says: the first pool for images (a directory first), or the domains folder. */
  #defaultStorage(env: Env): Storage | null {
    const all = this.#storages(env).filter((st) => st.holds.includes('images') && st.pool?.active !== false);
    return all.find((st) => st.type === 'dir') ?? all[0] ?? null;
  }

  /** How the settings name a volume: `pool/volume`, or the file's path in unRAID's folders. */
  #ref(st: Storage, name: string): string {
    return st.pool ? `${st.id}/${name}` : `${st.path}/${name}`;
  }

  /** A volume from what a setting or a request names: `pool/volume`, `folder:isos/file`, or a path. */
  #resolve(env: Env, source: string | undefined): { storage: Storage; volume: Volume } | null {
    if (!source || source === 'empty') return null;
    for (const st of this.#storages(env)) {
      let name: string | null = null;
      if (source.startsWith('/')) {
        if (st.path && source.startsWith(`${st.path}/`)) name = source.slice(st.path.length + 1);
      } else if (source.startsWith(`${st.id}/`)) name = source.slice(st.id.length + 1);
      if (name === null) continue;
      const volume = this.#vols(env, st.id).find((v) => v.name === name);
      if (volume) return { storage: st, volume };
    }
    return null;
  }

  /** The disks and drives of the server's VMs that use a volume (their settings, pending ones too). */
  #users(env: Env, storage: string, name: string): { guest: string; name: string; key: string }[] {
    const out: { guest: string; name: string; key: string }[] = [];
    for (const g of this.#vms(env.server)) {
      const c = this.#cfg(env.server, g);
      const p = this.#pendingOf(env.server, String(g.id));
      for (const v of [c.values, p.set])
        for (const key of [...deviceKeys(v, 'disk'), ...deviceKeys(v, 'cdrom')]) {
          const found = this.#resolve(env, parseDevice(v[key]).source);
          if (found && found.storage.id === storage && found.volume.name === name)
            if (!out.some((u) => u.guest === g.id && u.key === key))
              out.push({ guest: String(g.id), name: String(g.name), key });
        }
    }
    return out;
  }

  #networkUsers(server: string, network: string): Json[] {
    return this.#vms(server).filter((g) => {
      const v = this.#cfg(server, g).values;
      return deviceKeys(v, 'net').some((k) => parseDevice(v[k]).network === network);
    });
  }

  #pendingOf(server: string, guestId: string): Pending {
    const key = this.#key(server, guestId);
    let p = this.#pending.get(key);
    if (!p) {
      p = { set: {}, del: [] };
      this.#pending.set(key, p);
    }
    return p;
  }

  #backupsOf(server: string): Backup[] {
    let list = this.#backups.get(server);
    if (!list) {
      list = [];
      this.#backups.set(server, list);
    }
    return list;
  }

  #machine(env: Env): string {
    const [major, minor] = String(env.lv.qemu ?? '9.2').split('.');
    return `pc-q35-${major ?? '9'}.${minor ?? '2'}`;
  }

  /** A VM's settings: the fake's guest configuration, seeded on first use; a stopped VM has taken its pending ones. */
  #cfg(server: string, guest: Json): GuestConfigState {
    const id = String(guest.id);
    const c = this.host.configOf(server, id);
    if (!('vcpus' in c.values)) c.values = this.#seed(server, guest);
    c.running = guest.state === 'running';
    // The name and autostart are the guest's (`guest.autostart` is set elsewhere too).
    c.values.name = String(guest.name);
    c.values.autostart = guest.autostart === true ? '1' : '0';
    if (!c.running) {
      const p = this.#pending.get(this.#key(server, id));
      if (p && (Object.keys(p.set).length || p.del.length)) {
        Object.assign(c.values, p.set);
        for (const k of p.del) delete c.values[k];
        this.#pending.delete(this.#key(server, id));
        this.#sync(guest, c);
      }
    }
    return c;
  }

  #seed(server: string, guest: Json): Values {
    const env = this.#env(server);
    const name = String(guest.name ?? String(guest.id).replace(/^libvirt:/, ''));
    const machine = env ? this.#machine(env) : 'pc-q35-9.2';
    const spec = SEED_VMS[`${server}/${name}`] ?? this.#derived(env, guest, name);
    const v = values(name, machine, guest.autostart === true, spec);
    // The volumes it uses are in their storages.
    if (env)
      for (const k of deviceKeys(v, 'disk')) {
        const d = parseDevice(v[k]);
        if (!d.source || this.#resolve(env, d.source)) continue;
        const st = this.#storages(env).find((x) => d.source?.startsWith(x.pool ? `${x.id}/` : `${x.path}/`));
        if (!st) continue;
        const size = Number(d.size) || 32 * GiB;
        this.#vols(env, st.id).push({
          name: (d.source as string).slice((st.pool ? st.id : st.path).length + 1),
          capacity: size,
          allocation: d.format === 'raw' ? size : Math.round(size * 0.4),
          format: d.format === 'raw' ? 'raw' : 'qcow2',
          created: '2026-09-02T10:12:00Z',
        });
      }
    return v;
  }

  /** The settings of a VM the seeds don't know, from its summary. */
  #derived(env: Env | null, guest: Json, name: string): VmSpec {
    const image = String(guest.image ?? '');
    const st = env ? this.#defaultStorage(env) : null;
    const memory = Number(guest.memory_limit_mb ?? 0) || 4096;
    const vcpus = Number(guest.vcpu ?? 0) || 2;
    const mac = `52:54:00:${pairs(hashOf(`${env?.server}/${name}`).slice(0, 6))}`;
    const network = env?.lv.networks[0]?.name;
    return {
      vcpus,
      memoryMb: memory,
      disks: [disk(st ? this.#ref(st, `${name}.qcow2`) : `default/${name}.qcow2`, 'qcow2', 'vda', 32)],
      cdroms: [NO_CD],
      nets: [`model=virtio,${network ? `network=${network}` : 'bridge=br0'},mac=${mac},link=up`],
      firmware: /OVMF/.test(image) ? 'uefi' : 'bios',
      tpm: /TPM/.test(image),
      graphics: VNC,
      video: 'model=virtio,heads=1',
    };
  }

  /** The summary follows the settings a VM runs with. */
  #sync(guest: Json, c: GuestConfigState): void {
    guest.vcpu = Number(c.values.vcpus) || guest.vcpu;
    if (guest.state === 'running')
      guest.memory_limit_mb = Number(c.values.memory_mb) || guest.memory_limit_mb;
    guest.autostart = c.values.autostart === '1';
  }

  /** The libvirt group of a server's detail counts its VMs. */
  #recount(server: string): void {
    const d = this.host.detailOf(server);
    const group = ((d?.workloads ?? d?.guests ?? {}) as Record<string, Json>).libvirt;
    if (!group) return;
    const vms = this.#vms(server);
    group.total = vms.length;
    group.running = vms.filter((g) => g.state === 'running').length;
  }

  /* Checks and tasks ------------------------------------------------------------------------------------------------ */

  /** A guest route: the libvirt VM when the checks pass; null when it isn't one (the other sides answer). */
  #guestRoute(
    r: FakeRequest,
    server: string,
    guestId: string,
    role: Role,
  ): { guest: Json; env: Env } | FakeAnswer | null {
    const guest = this.host.guest(server, guestId);
    if (guest?.platform !== 'libvirt') return null;
    const refused = this.manage.check(r, server, role);
    if (refused) return refused;
    const env = this.#env(server);
    if (!env) return problem(501, 'unsupported', 'This server doesn’t run libvirt.');
    return { guest, env };
  }

  /** Whether a host route is about the server's libvirt: `platform: libvirt`, or none on a QEMU/KVM server. */
  #mine(server: string, platform: unknown): boolean {
    if (platform === 'libvirt') return true;
    if (platform !== undefined && platform !== null && platform !== '') return false;
    return this.#kind(server) === 'libvirt';
  }

  /** A host route of the server's libvirt: its checks, then the libvirt (501 when the server has none). */
  #hostRoute(r: FakeRequest, server: string, role: Role): Env | FakeAnswer {
    const refused = this.manage.check(r, server, role);
    if (refused) return refused;
    return this.#env(server) ?? problem(501, 'unsupported', 'This server doesn’t run libvirt.');
  }

  #fields(r: FakeRequest, allowed: readonly string[]): Json | FakeAnswer {
    const bc = this.manage.body(r, allowed);
    return 'fields' in bc ? bc.fields : bc;
  }

  /** A DELETE route's query: only the keys it takes. */
  #query(r: FakeRequest, allowed: readonly string[]): FakeAnswer | null {
    for (const k of r.query.keys())
      if (!allowed.includes(k)) return problem(400, 'bad_request', `Unknown query parameter "${k}"`);
    return null;
  }

  /** Fields of a shared body that another platform takes but libvirt doesn't: refused when they are set. */
  #notForLibvirt(b: Json, fields: readonly string[]): FakeAnswer | null {
    const errors: Record<string, string> = {};
    for (const f of fields) if (b[f] !== undefined && b[f] !== null) errors[f] = 'Not for a libvirt VM.';
    return Object.keys(errors).length ? this.manage.invalid(errors) : null;
  }

  /** A running libvirt task on the guest (one job at a time). */
  #busy(server: string, guestId: string, what: string): FakeAnswer | null {
    for (const t of this.manage.tasks.values())
      if (t.server === server && t.guest === guestId && t.status === 'running' && t.id.startsWith('libvirt:'))
        return problem(409, 'busy', `${what} is busy with another job: wait until it ends.`);
    return null;
  }

  /** Starts an agent task `libvirt:<16 hex>`; the counts and hints follow when it ends. */
  #task(
    r: FakeRequest,
    server: string,
    op: string,
    t: {
      type: string;
      guest: string | null;
      plan: string[];
      apply: ((good: boolean) => void) | null;
      answer?: Json;
      cancellable?: boolean;
    },
  ): FakeAnswer {
    return this.manage.startTask(r, server, op, {
      type: t.type,
      guest: t.guest,
      plan: t.plan,
      idKind: 'libvirt',
      cancellable: t.cancellable ?? false,
      ...(t.answer ? { answer: t.answer } : {}),
      apply: (good) => {
        t.apply?.(good);
        this.#recount(server);
        this.#hints(server);
      },
    });
  }

  #name(raw: unknown): string | FakeAnswer {
    return typeof raw === 'string' && LIBVIRT_NAME_PATTERN.test(raw)
      ? raw
      : this.manage.invalid({ name: NAME_HINT });
  }

  /* Settings -------------------------------------------------------------------------------------------------------- */

  #getConfig(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#guestRoute(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    const { guest, env } = gc;
    const c = this.#cfg(server, guest);
    const p = this.#pendingOf(server, guestId);
    const v = c.values;
    const restricted = [
      ...['machine', 'firmware', 'secure_boot', 'tpm'].filter((k) => k in v),
      ...Object.keys(v).filter(
        (k) => RESTRICTED.test(k) && !['machine', 'firmware', 'secure_boot', 'tpm'].includes(k),
      ),
    ];
    return ok({
      platform: 'libvirt',
      kind: 'vm',
      digest: `x${c.digest}`,
      running: guest.state === 'running',
      values: { ...v },
      pending: { ...p.set },
      ...(p.del.length ? { pending_delete: [...p.del] } : {}),
      restricted,
      disks: this.#disks(env, v),
    });
  }

  #disks(env: Env, v: Values): Json[] {
    const boot = (v.boot ?? '').split(',')[0];
    const out: Json[] = [];
    for (const key of deviceKeys(v, 'disk')) {
      const d = parseDevice(v[key]);
      const found = this.#resolve(env, d.source);
      out.push({
        key,
        ...(found ? { storage: found.storage.id, volume: found.volume.name } : {}),
        size_bytes: Number(d.size) || found?.volume.capacity || 0,
        media: 'disk',
        ...(found
          ? { path: `${found.storage.path}/${found.volume.name}` }
          : d.source
            ? { path: d.source }
            : {}),
        ...(key === 'disk0' && boot === 'hd' ? { boot: true } : {}),
      });
    }
    for (const key of deviceKeys(v, 'cdrom')) {
      const d = parseDevice(v[key]);
      const found = this.#resolve(env, d.source);
      out.push({
        key,
        media: 'cdrom',
        ...(found
          ? {
              storage: found.storage.id,
              volume: `${found.storage.id}/${found.volume.name}`,
              size_bytes: found.volume.capacity,
              path: `${found.storage.path}/${found.volume.name}`,
            }
          : {}),
        ...(key === 'cdrom0' && boot === 'cdrom' ? { boot: true } : {}),
      });
    }
    return out;
  }

  #setConfig(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#guestRoute(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    const { guest, env } = gc;
    if (guest.self === true) return problem(409, 'self_guest', SELF);
    const b = this.#fields(r, ['digest', 'set', 'delete', 'revert', 'confirm']);
    if (isAnswer(b)) return b;
    const c = this.#cfg(server, guest);
    if (b.digest !== undefined && b.digest !== `x${c.digest}`)
      return problem(409, 'digest_mismatch', 'The settings changed meanwhile: read them again.');
    const set = (b.set ?? {}) as Json;
    if (!set || typeof set !== 'object' || Array.isArray(set))
      return this.manage.invalid({ set: 'An object of settings.' });
    const del = b.delete ?? [];
    const revert = b.revert ?? [];
    if (!strings(del)) return this.manage.invalid({ delete: 'A list of settings.' });
    if (!strings(revert)) return this.manage.invalid({ revert: 'A list of settings.' });
    for (const k of [...Object.keys(set), ...del]) {
      if (RESTRICTED.test(k))
        return problem(403, 'not_allowed', `${k} is shown but not changed through Whombat.`, {
          field_errors: { [k]: 'Locked.' },
        });
      if (!SCALARS.has(k) && !DEVICE_KEY.test(k))
        return problem(403, 'not_allowed', `${k} isn’t a setting Whombat changes.`, {
          field_errors: { [k]: 'Not changed here.' },
        });
    }
    const p = this.#pendingOf(server, guestId);
    const running = guest.state === 'running';
    const errors: Record<string, string> = {};
    const next: Values = {};
    const created: { storage: string; volume: Volume }[] = [];
    for (const [k, raw] of Object.entries(set)) {
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        errors[k] = 'A text value.';
        continue;
      }
      if (del.includes(k)) {
        errors[k] = 'Set it or remove it, not both.';
        continue;
      }
      const res = DEVICE_KEY.test(k)
        ? this.#device(env, guest, c.values, p, k, String(raw).trim())
        : this.#scalar(server, k, String(raw).trim(), set, c.values, p);
      if ('error' in res) errors[k] = res.error;
      else {
        next[k] = res.value;
        if (res.volume) created.push(res.volume);
      }
    }
    for (const k of del) {
      if (k !== 'title' && k !== 'description' && !DEVICE_KEY.test(k)) errors[k] = 'This can’t be removed.';
      else if (c.values[k] === undefined && p.set[k] === undefined) errors[k] = `There’s no ${k}.`;
    }
    if (Object.keys(errors).length) return this.manage.invalid(errors);

    const changes: Json[] = [];
    for (const k of revert) {
      if (k in p.set) {
        changes.push({ key: k, old: p.set[k], new: c.values[k] ?? null, pending: false });
        delete p.set[k];
      }
      p.del = p.del.filter((x) => x !== k);
    }
    for (const [k, v] of Object.entries(next)) {
      const old = c.values[k] ?? null;
      if (!running || this.#live(k, v, c.values)) {
        if (old === v && !(k in p.set)) continue;
        c.values[k] = v;
        delete p.set[k];
        changes.push({ key: k, old, new: v, pending: false });
      } else if (old === v) {
        if (k in p.set) {
          changes.push({ key: k, old: p.set[k], new: v, pending: false });
          delete p.set[k];
        }
      } else {
        p.set[k] = v;
        p.del = p.del.filter((x) => x !== k);
        changes.push({ key: k, old, new: v, pending: true });
      }
    }
    for (const k of del) {
      const old = c.values[k] ?? p.set[k] ?? null;
      if (!running || k === 'title' || k === 'description' || !(k in c.values)) {
        delete c.values[k];
        delete p.set[k];
        changes.push({ key: k, old, new: null, pending: false });
      } else {
        delete p.set[k];
        if (!p.del.includes(k)) p.del.push(k);
        changes.push({ key: k, old, new: null, pending: true });
      }
    }
    for (const x of created) this.#vols(env, x.storage).push(x.volume);
    if (changes.length) c.digest += 1;
    this.#sync(guest, c);
    this.#hints(server);
    return ok({ ok: true, changes, audit_id: audit() });
  }

  /** What a running VM takes at once: notes, autostart, memory and vCPUs up to their maximum, media, link state. */
  #live(key: string, value: string, v: Values): boolean {
    if (key === 'title' || key === 'description' || key === 'autostart') return true;
    if (key === 'memory_mb') return Number(value) <= Number(v.memory_max_mb);
    if (key === 'vcpus') return Number(value) <= Number(v.vcpus_max);
    const kind = DEVICE_KEY.exec(key)?.[1];
    if (!v[key] || (kind !== 'cdrom' && kind !== 'net')) return false;
    const a = parseDevice(v[key]);
    const b = parseDevice(value);
    const same = kind === 'cdrom' ? ['bus'] : ['model', 'network', 'bridge', 'mac'];
    return same.every((k) => (a[k] ?? '') === (b[k] ?? ''));
  }

  #scalar(
    server: string,
    key: string,
    value: string,
    set: Json,
    v: Values,
    p: Pending,
  ): { value: string; volume?: undefined } | { error: string } {
    const cur = (k: string) => String(set[k] ?? p.set[k] ?? v[k] ?? '');
    const info = (this.host.detailOf(server)?.server ?? {}) as Json;
    const threads = Number((info.cpu as Json | undefined)?.threads ?? 64) || 64;
    const hostMb = (Number((info.memory as Json | undefined)?.total_gb ?? 64) || 64) * 1024;
    const int = (lo: number, hi: number) =>
      /^\d{1,7}$/.test(value) && Number(value) >= lo && Number(value) <= hi;
    switch (key) {
      case 'name':
        return value === v.name ? { value } : { error: 'Rename the VM instead (it has to be stopped).' };
      case 'title':
        return /^[^\n\r]{0,200}$/.test(value) ? { value } : { error: 'One line of at most 200 characters.' };
      case 'description':
        return value.length <= 8192 ? { value } : { error: 'At most 8,192 characters.' };
      case 'autostart':
        return value === '1' || value === '0' ? { value } : { error: '1 or 0.' };
      case 'vcpus':
        if (!int(1, threads)) return { error: `A number of vCPUs from 1 to ${threads}.` };
        return Number(value) <= Number(cur('vcpus_max'))
          ? { value }
          : { error: `At most vcpus_max (${cur('vcpus_max')}).` };
      case 'vcpus_max':
        if (!int(1, threads)) return { error: `A number of vCPUs from 1 to ${threads}.` };
        return Number(value) >= Number(cur('vcpus'))
          ? { value }
          : { error: `At least vcpus (${cur('vcpus')}).` };
      case 'memory_mb':
        if (!int(64, hostMb)) return { error: `Megabytes from 64 to ${hostMb}.` };
        return Number(value) <= Number(cur('memory_max_mb'))
          ? { value }
          : { error: `At most memory_max_mb (${cur('memory_max_mb')}).` };
      case 'memory_max_mb':
        if (!int(64, hostMb)) return { error: `Megabytes from 64 to ${hostMb}.` };
        return Number(value) >= Number(cur('memory_mb'))
          ? { value }
          : { error: `At least memory_mb (${cur('memory_mb')}).` };
      case 'boot': {
        const order = value.split(',').map((x) => x.trim());
        const good =
          order.length > 0 &&
          order.every((x) => ['hd', 'cdrom', 'network'].includes(x)) &&
          new Set(order).size === order.length;
        return good
          ? { value: order.join(',') }
          : { error: 'hd, cdrom and network in the order to try them.' };
      }
      case 'cpu_mode':
        return /^(host-passthrough|host-model|maximum|custom:[A-Za-z0-9_.-]{1,64})$/.test(value)
          ? { value }
          : { error: 'host-passthrough, host-model, maximum or custom:<model>.' };
      default:
        return LIFECYCLE.includes(value)
          ? { value }
          : { error: 'destroy, restart, preserve or rename-restart.' };
    }
  }

  /** A device setting: a disk (an existing volume or file, or `new=`), a CD/DVD drive, a network card. */
  #device(
    env: Env,
    guest: Json,
    v: Values,
    p: Pending,
    key: string,
    value: string,
  ): { value: string; volume?: { storage: string; volume: Volume } } | { error: string } {
    const kind = DEVICE_KEY.exec(key)?.[1] as 'disk' | 'cdrom' | 'net';
    const d = parseDevice(value);
    const oldRaw = p.set[key] ?? v[key];
    const old = oldRaw ? parseDevice(oldRaw) : null;
    const allowed = {
      disk: ['source', 'bus', 'format', 'target', 'size', 'new', 'storage'],
      cdrom: ['source', 'bus'],
      net: ['model', 'network', 'bridge', 'mac', 'link'],
    }[kind];
    const unknown = Object.keys(d).find((k) => !allowed.includes(k));
    if (unknown) return { error: `${kind === 'net' ? 'A network card' : 'A drive'} has no “${unknown}”.` };
    if (!Object.keys(d).length && !(kind === 'cdrom' && value === 'empty'))
      return { error: 'Settings such as source=…,bus=….' };

    if (kind === 'cdrom') {
      const bus = d.bus ?? old?.bus ?? 'sata';
      if (!CDROM_BUSES.includes(bus)) return { error: 'bus: sata or ide.' };
      const source = d.source ?? (value === 'empty' ? 'empty' : (old?.source ?? 'empty'));
      if (source === 'empty') return { value: deviceString(CDROM_ORDER, { source, bus }) };
      const found = this.#resolve(env, source);
      if (found?.volume.format !== 'iso') return { error: 'No such ISO image.' };
      return {
        value: deviceString(CDROM_ORDER, { source: this.#ref(found.storage, found.volume.name), bus }),
      };
    }

    if (kind === 'net') {
      const model = d.model ?? old?.model ?? 'virtio';
      if (!NIC_MODELS.includes(model)) return { error: 'model: virtio, e1000e or rtl8139.' };
      if (d.network && d.bridge) return { error: 'A network or a bridge, not both.' };
      let network = d.network;
      let bridge = d.bridge;
      if (!network && !bridge) {
        network = old?.network;
        bridge = old?.bridge;
      }
      if (!network && !bridge) network = env.lv.networks[0] ? String(env.lv.networks[0].name) : undefined;
      if (network && !env.lv.networks.some((n) => n.name === network))
        return { error: `There’s no libvirt network ${network}.` };
      if (bridge && !env.bridges.includes(bridge))
        return { error: `There’s no bridge ${bridge} on this host.` };
      if (!network && !bridge) return { error: 'A network or a bridge.' };
      const mac = (d.mac ?? old?.mac ?? randomMac()).toLowerCase();
      if (!MAC_RE.test(mac)) return { error: 'mac: six pairs of hex digits.' };
      const taken = this.#vms(env.server).some((g) => {
        const gv = { ...this.#cfg(env.server, g).values, ...this.#pendingOf(env.server, String(g.id)).set };
        return deviceKeys(gv, 'net').some(
          (k) => !(g.id === guest.id && k === key) && parseDevice(gv[k]).mac?.toLowerCase() === mac,
        );
      });
      if (taken) return { error: 'Another network card has this MAC address.' };
      const link = d.link ?? old?.link ?? 'up';
      if (link !== 'up' && link !== 'down') return { error: 'link: up or down.' };
      return {
        value: deviceString(NET_ORDER, { model, network: network ?? '', bridge: bridge ?? '', mac, link }),
      };
    }

    const bus = d.bus ?? old?.bus ?? 'virtio';
    if (!DISK_BUSES.includes(bus)) return { error: 'bus: virtio, sata, scsi or ide.' };
    if (d.new !== undefined) {
      if (d.source) return { error: 'A new disk has a size and a storage, not a source.' };
      const size = parseSize(d.new);
      if (!size || size.relative) return { error: 'new: a size such as 32G.' };
      const st = d.storage ? this.#storage(env, d.storage) : this.#defaultStorage(env);
      if (!st?.holds.includes('images'))
        return { error: `storage: ${env.lv.folders ? 'folder:domains' : 'a storage pool for disks'}.` };
      const format = d.format ?? (st.type === 'logical' ? 'raw' : 'qcow2');
      if (format !== 'qcow2' && format !== 'raw') return { error: 'format: qcow2 or raw.' };
      if (st.type === 'logical' && format !== 'raw') return { error: 'An LVM pool holds raw volumes only.' };
      const full = format === 'raw' ? size.bytes : QCOW2_EMPTY;
      if (st.pool && full > Number(st.pool.avail_bytes))
        return { error: `Pool ${st.id} has ${gib(Number(st.pool.avail_bytes))} free.` };
      const n = Number(key.slice(4));
      const name = this.#freeName(env, st, String(guest.name), n, format);
      return {
        value: deviceString(DISK_ORDER, {
          source: this.#ref(st, name),
          bus,
          format,
          target: this.#target(v, p, key, bus),
          size: String(size.bytes),
        }),
        volume: {
          storage: st.id,
          volume: { name, capacity: size.bytes, allocation: full, format, created: new Date().toISOString() },
        },
      };
    }
    const source = d.source ?? old?.source;
    if (!source) return { error: 'A source (pool/volume or a path), or new=<size>,storage=<pool>.' };
    const found = this.#resolve(env, source);
    if (!found || found.volume.format === 'iso') return { error: 'No such volume.' };
    const users = this.#users(env, found.storage.id, found.volume.name).filter(
      (u) => !(u.guest === guest.id && u.key === key),
    );
    if (users[0])
      return {
        error:
          users[0].guest === guest.id
            ? `It’s ${users[0].key} already.`
            : `${users[0].name} uses this volume.`,
      };
    const format = d.format ?? found.volume.format;
    if (format !== found.volume.format) return { error: `It’s a ${found.volume.format} volume.` };
    const target = old && old.bus === bus && old.target ? old.target : this.#target(v, p, key, bus);
    return {
      value: deviceString(DISK_ORDER, {
        source: this.#ref(found.storage, found.volume.name),
        bus,
        format,
        target,
        size: String(found.volume.capacity),
      }),
    };
  }

  /** The next free device name on a bus (`vdb`, `sdc`). */
  #target(v: Values, p: Pending, key: string, bus: string): string {
    const prefix = bus === 'virtio' ? 'vd' : bus === 'ide' ? 'hd' : 'sd';
    const used = new Set(
      [...deviceKeys(v, 'disk'), ...deviceKeys(p.set, 'disk')]
        .filter((k) => k !== key)
        .map((k) => parseDevice(p.set[k] ?? v[k]).target),
    );
    for (const c of 'abcdefghijklmnopqrstuvwxyz') if (!used.has(`${prefix}${c}`)) return `${prefix}${c}`;
    return `${prefix}z`;
  }

  /** A new volume's name for a VM's disk N in a storage (`web.qcow2`, `web-disk1.qcow2`, `web` on LVM, `web/vdisk1.img`). */
  #freeName(
    env: Env,
    st: Storage,
    vm: string,
    n: number,
    format: string,
    taken: Set<string> = new Set(),
  ): string {
    const ext = st.type === 'logical' ? '' : format === 'raw' ? '.img' : '.qcow2';
    const base = st.pool ? (n === 0 ? vm : `${vm}-disk${n}`) : `${vm}/vdisk${n + 1}`;
    const exists = (name: string) => taken.has(name) || this.#vols(env, st.id).some((x) => x.name === name);
    let name = `${base}${ext}`;
    for (let i = 2; exists(name); i++) name = `${base}-${i}${ext}`;
    return name;
  }

  #resize(r: FakeRequest, server: string, guestId: string, diskKey: string): FakeAnswer | null {
    const gc = this.#guestRoute(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    const { guest, env } = gc;
    if (guest.self === true) return problem(409, 'self_guest', SELF);
    const b = this.#fields(r, ['size']);
    if (isAnswer(b)) return b;
    const c = this.#cfg(server, guest);
    if (/^cdrom\d+$/.test(diskKey)) return this.manage.invalid({ disk: 'A CD/DVD drive has no size.' });
    if (!/^disk\d+$/.test(diskKey) || !c.values[diskKey])
      return problem(404, 'not_found', `The VM has no disk ${diskKey}.`, {
        field_errors: { disk: 'No such disk.' },
      });
    const want = parseSize(b.size);
    if (!want) return this.manage.invalid({ size: 'A size such as +8G or 64G.' });
    const d = parseDevice(c.values[diskKey]);
    const found = this.#resolve(env, d.source);
    const cur = Number(d.size) || found?.volume.capacity || 0;
    const next = want.relative ? cur + want.bytes : want.bytes;
    if (next < cur) return this.manage.invalid({ size: `Disks only grow: this one has ${gib(cur)}.` });
    if (next === cur) return ok({ ok: true, changes: [], audit_id: audit() });
    const raw = found?.volume.format === 'raw';
    if (found?.storage.pool && raw && next - cur > Number(found.storage.pool.avail_bytes))
      return this.manage.invalid({
        size: `Pool ${found.storage.id} has ${gib(Number(found.storage.pool.avail_bytes))} free.`,
      });
    if (found) {
      found.volume.capacity = next;
      if (raw) found.volume.allocation = next;
    }
    const old = c.values[diskKey] as string;
    c.values[diskKey] = deviceString(DISK_ORDER, { ...d, size: String(next) });
    const p = this.#pendingOf(server, guestId);
    if (p.set[diskKey] && parseDevice(p.set[diskKey]).source === d.source)
      p.set[diskKey] = deviceString(DISK_ORDER, { ...parseDevice(p.set[diskKey]), size: String(next) });
    c.digest += 1;
    this.#hints(server);
    return ok({
      ok: true,
      changes: [{ key: diskKey, old, new: c.values[diskKey], pending: false }],
      audit_id: audit(),
    });
  }

  /* Choices --------------------------------------------------------------------------------------------------------- */

  #isos(env: Env): { storage: Storage; volume: Volume }[] {
    return this.#storages(env).flatMap((st) =>
      this.#vols(env, st.id)
        .filter((v) => v.format === 'iso')
        .map((volume) => ({ storage: st, volume })),
    );
  }

  #choices(r: FakeRequest, server: string): FakeAnswer | null {
    if (!this.#mine(server, r.query.get('platform') ?? undefined)) return null;
    const env = this.#hostRoute(r, server, 'operator');
    if (isAnswer(env)) return env;
    const fw = env.lv.firmware;
    return ok({
      platform: 'libvirt',
      storages: this.#storages(env)
        .filter((st) => st.pool?.active !== false)
        .map((st) => ({
          id: st.id,
          type: st.type,
          content: st.holds,
          ...(st.pool
            ? { avail_bytes: Number(st.pool.avail_bytes), total_bytes: Number(st.pool.total_bytes) }
            : {}),
        })),
      bridges: [...env.bridges],
      networks: env.lv.networks.filter((n) => n.active !== false).map((n) => String(n.name)),
      isos: this.#isos(env).map(({ storage, volume }) => ({
        volid: `${storage.id}/${volume.name}`,
        name: volume.name,
        size_bytes: volume.capacity,
      })),
      os_variants: OS_VARIANTS.map((o) => ({ ...o })),
      firmware: { uefi: fw.uefi === true, secure_boot: fw.secure_boot === true, tpm: fw.tpm === true },
    });
  }

  /* Create, clone, rename, delete ----------------------------------------------------------------------------------- */

  /** A new VM's summary as the hub reports libvirt guests. */
  #summary(id: string, v: Values, state: string): Json {
    const running = state === 'running';
    const windows = v.graphics0?.startsWith('type=spice') === true;
    const memory = Number(v.memory_mb) || 2048;
    return {
      id,
      name: v.name,
      platform: 'libvirt',
      kind: 'vm',
      image: `q35 · ${v.firmware === 'uefi' ? 'OVMF' : 'SeaBIOS'}${v.tpm === '1' ? ' · TPM' : ''}`,
      state,
      vcpu: Number(v.vcpus) || 1,
      cpu_pct: running ? 0.4 : null,
      memory_used_mb: running ? Math.round(memory * 0.12) : null,
      memory_limit_mb: running ? memory : null,
      disk_read_mbs: running ? 0 : null,
      disk_write_mbs: running ? 0 : null,
      net_rx_mbps: running ? 0 : null,
      net_tx_mbps: running ? 0 : null,
      snapshots: 0,
      uptime_s: running ? 1 : null,
      console: {
        available: true,
        protocols: windows ? ['spice', 'vnc'] : ['vnc', 'serial'],
        default_protocol: windows ? 'spice' : 'vnc',
        resolution: running ? '1024x768' : null,
      },
      autostart: v.autostart === '1',
    };
  }

  /** Puts a new VM in the server's detail with its settings. */
  #addVm(server: string, id: string, v: Values, state: string): void {
    const g = this.#summary(id, v, state);
    this.host.addGuest(server, g);
    const c = this.host.configOf(server, id);
    c.values = { ...v };
    c.digest = 1;
    c.running = state === 'running';
    this.#pending.delete(this.#key(server, id));
    this.host.emit('guest.state_changed', { server, id, state });
  }

  #create(r: FakeRequest, server: string): FakeAnswer | null {
    const raw = (r.body && typeof r.body === 'object' ? r.body : {}) as Json;
    if (!this.#mine(server, raw.platform)) return null;
    const env = this.#hostRoute(r, server, 'admin');
    if (isAnswer(env)) return env;
    const b = this.#fields(r, [
      'platform',
      'kind',
      'new_id',
      'name',
      'set',
      'start',
      'image',
      'profiles',
      'project',
      'pool',
      'network',
      'cloud_init',
      'os_variant',
      'iso',
      'storage',
      'disk_gb',
      'bridge',
    ]);
    if (isAnswer(b)) return b;
    if (b.kind !== 'vm') return this.manage.invalid({ kind: 'libvirt runs VMs: kind is vm.' });
    const name = this.#name(b.name);
    if (isAnswer(name)) return name;
    const id = `libvirt:${name}`;
    if (b.new_id !== undefined && b.new_id !== null && b.new_id !== id)
      return this.manage.invalid({ new_id: `A libvirt VM’s id follows its name: ${id}.` });
    const refused = this.#notForLibvirt(b, ['image', 'profiles', 'project', 'pool', 'cloud_init']);
    if (refused) return refused;
    const variant = OS_VARIANTS.find((o) => o.id === (b.os_variant ?? 'linux'));
    if (!variant) return this.manage.invalid({ os_variant: 'Not an OS type this host offers.' });
    const fw = env.lv.firmware;
    if (variant.tpm && !(fw.uefi && fw.tpm))
      return this.manage.invalid({
        os_variant: `${variant.label} needs UEFI and a TPM, and this host has no ${fw.uefi ? 'TPM (swtpm)' : 'UEFI (OVMF)'}.`,
      });
    const uefi = variant.firmware === 'uefi' && fw.uefi;
    let isoRef: string | null = null;
    if (b.iso !== undefined && b.iso !== null && b.iso !== '') {
      const found = typeof b.iso === 'string' ? this.#resolve(env, b.iso) : null;
      if (found?.volume.format !== 'iso') return this.manage.invalid({ iso: 'No such ISO image.' });
      isoRef = this.#ref(found.storage, found.volume.name);
    }
    const st = b.storage === undefined ? this.#defaultStorage(env) : this.#storage(env, b.storage);
    if (!st?.holds.includes('images') || st.pool?.active === false)
      return this.manage.invalid({
        storage: env.lv.folders
          ? 'folder:domains, the VM Manager’s domains folder.'
          : 'A storage pool for disks.',
      });
    const windows = variant.id.startsWith('win');
    const diskGb = b.disk_gb ?? (windows ? 64 : 32);
    if (typeof diskGb !== 'number' || !Number.isInteger(diskGb) || diskGb < 1 || diskGb > 65_536)
      return this.manage.invalid({ disk_gb: 'Gigabytes from 1 to 65536.' });
    if (b.network != null && b.bridge != null)
      return this.manage.invalid({ network: 'A network or a bridge, not both.' });
    let nic: string;
    if (b.bridge != null) {
      if (typeof b.bridge !== 'string') return this.manage.invalid({ bridge: 'A bridge’s name.' });
      if (!env.bridges.includes(b.bridge))
        return this.manage.invalid({ bridge: `There’s no bridge ${b.bridge} on this host.` });
      nic = `bridge=${b.bridge}`;
    } else {
      const network = b.network ?? env.lv.networks[0]?.name;
      if (typeof network !== 'string' || !env.lv.networks.some((x) => x.name === network))
        return this.manage.invalid({ network: 'Not a libvirt network of this host.' });
      nic = `network=${network}`;
    }
    if (b.start !== undefined && typeof b.start !== 'boolean')
      return this.manage.invalid({ start: 'true or false.' });
    const set = (b.set ?? {}) as Json;
    if (!set || typeof set !== 'object' || Array.isArray(set))
      return this.manage.invalid({ set: 'An object of settings.' });
    const format = st.type === 'logical' ? 'raw' : 'qcow2';
    const size = diskGb * GiB;
    if (st.pool && format === 'raw' && size > Number(st.pool.avail_bytes))
      return this.manage.invalid({ disk_gb: `Pool ${st.id} has ${gib(Number(st.pool.avail_bytes))} free.` });
    const volName = this.#freeName(env, st, name, 0, format);
    const memory = windows ? 8192 : variant.id === 'alpine' ? 1024 : 2048;
    const v = values(name, this.#machine(env), false, {
      vcpus: windows ? 4 : 2,
      memoryMb: memory,
      boot: isoRef ? 'hd,cdrom' : 'hd',
      disks: [
        deviceString(DISK_ORDER, {
          source: this.#ref(st, volName),
          bus: windows ? 'sata' : 'virtio',
          format,
          target: windows ? 'sda' : 'vda',
          size: String(size),
        }),
      ],
      cdroms: [deviceString(CDROM_ORDER, { source: isoRef ?? 'empty', bus: 'sata' })],
      nets: [`model=${windows ? 'e1000e' : 'virtio'},${nic},mac=${randomMac()},link=up`],
      firmware: uefi ? 'uefi' : 'bios',
      secureBoot: uefi && windows && fw.secure_boot,
      tpm: variant.tpm,
      graphics: windows ? 'type=spice,listen=127.0.0.1' : VNC,
      video: windows ? 'model=qxl,vram=65536,heads=1' : 'model=virtio,heads=1',
    });
    // A new VM's maximum follows what it is given.
    if (set.memory_mb !== undefined && set.memory_max_mb === undefined)
      v.memory_max_mb = String(Math.max(Number(set.memory_mb) || 0, Number(v.memory_max_mb)));
    if (set.vcpus !== undefined && set.vcpus_max === undefined)
      v.vcpus_max = String(Math.max(Number(set.vcpus) || 0, Number(v.vcpus_max)));
    const p: Pending = { set: {}, del: [] };
    const errors: Record<string, string> = {};
    for (const [k, value] of Object.entries(set)) {
      if (RESTRICTED.test(k)) return problem(403, 'not_allowed', `${k} is chosen from the OS type.`);
      if (!SCALARS.has(k) || k === 'name') {
        errors[`set.${k}`] = DEVICE_KEY.test(k)
          ? 'Disks and network cards come from storage, disk_gb, iso, network or bridge.'
          : 'Not a setting a new VM takes.';
        continue;
      }
      const res =
        typeof value === 'string' || typeof value === 'number'
          ? this.#scalar(server, k, String(value).trim(), set, v, p)
          : { error: 'A text value.' };
      if ('error' in res) errors[`set.${k}`] = res.error;
      else v[k] = res.value;
    }
    if (Object.keys(errors).length) return this.manage.invalid(errors);
    if (this.host.guest(server, id) || this.#busy(server, id, name))
      return problem(409, 'exists', `${id} already exists.`);
    const start = b.start === true;
    const firmwareWords = uefi
      ? `UEFI${v.secure_boot === '1' ? ' with Secure Boot' : ''}${variant.tpm ? ' and a TPM' : ''}`
      : 'BIOS';
    return this.#task(r, server, 'guest.create', {
      type: 'create',
      guest: id,
      answer: { new_id: id },
      plan: [
        `Creating volume ${this.#ref(st, volName)} (${gib(size)})`,
        ...(isoRef ? [`Putting ${isoRef.split('/').pop()} in the CD/DVD drive`] : []),
        `Defining ${name} (${variant.label}, ${firmwareWords})`,
        ...(start ? [`Starting ${name}`] : []),
        `${name} is ready`,
      ],
      apply: (good) => {
        if (!good) return;
        this.#vols(env, st.id).push({
          name: volName,
          capacity: size,
          allocation: format === 'raw' ? size : QCOW2_EMPTY,
          format,
          created: new Date().toISOString(),
        });
        this.#addVm(server, id, v, start ? 'running' : 'stopped');
      },
    });
  }

  /**
   * A VM's disks copied for a new VM (`name`): new volumes in `storage` (or each disk's own storage), new MAC
   * addresses; the CD/DVD drives keep their media.
   */
  #copy(
    env: Env,
    from: Values,
    name: string,
    storage: unknown,
  ): { values: Values; volumes: { storage: string; volume: Volume }[]; lines: string[] } | FakeAnswer {
    const target = storage === undefined || storage === null ? null : this.#storage(env, storage);
    if (target === null && storage !== undefined && storage !== null)
      return this.manage.invalid({ storage: 'Not a storage pool of this host.' });
    if (target && (!target.holds.includes('images') || target.pool?.active === false))
      return this.manage.invalid({ storage: 'That storage doesn’t hold disks.' });
    const v: Values = { ...from, name, autostart: '0' };
    const volumes: { storage: string; volume: Volume }[] = [];
    const lines: string[] = [];
    const need = new Map<string, number>();
    const taken = new Map<string, Set<string>>();
    for (const key of deviceKeys(from, 'disk')) {
      const d = parseDevice(from[key]);
      const src = this.#resolve(env, d.source);
      const st = target ?? src?.storage ?? this.#defaultStorage(env);
      if (!st) return this.manage.invalid({ storage: 'Name a storage for the disks.' });
      const capacity = Number(d.size) || src?.volume.capacity || 32 * GiB;
      const format: 'qcow2' | 'raw' =
        st.type === 'logical' ? 'raw' : (src?.volume.format ?? d.format) === 'raw' ? 'raw' : 'qcow2';
      const allocation = format === 'raw' ? capacity : (src?.volume.allocation ?? Math.round(capacity * 0.3));
      const names = taken.get(st.id) ?? new Set<string>();
      taken.set(st.id, names);
      const volName = this.#freeName(env, st, name, Number(key.slice(4)), format, names);
      names.add(volName);
      if (st.pool) need.set(st.id, (need.get(st.id) ?? 0) + allocation);
      volumes.push({
        storage: st.id,
        volume: { name: volName, capacity, allocation, format, created: new Date().toISOString() },
      });
      v[key] = deviceString(DISK_ORDER, {
        ...d,
        source: this.#ref(st, volName),
        format,
        size: String(capacity),
      });
      const t = d.target ?? key;
      lines.push(`Copying disk ${t}: 41 %`, `Copying disk ${t}: 100 %`);
    }
    for (const [id, bytes] of need) {
      const pool = this.#storage(env, id)?.pool;
      if (pool && bytes > Number(pool.avail_bytes))
        return this.manage.invalid({
          storage: `Pool ${id} has ${gib(Number(pool.avail_bytes))} free and the disks need ${gib(bytes)}.`,
        });
    }
    for (const key of deviceKeys(from, 'net'))
      v[key] = deviceString(NET_ORDER, { ...parseDevice(from[key]), mac: randomMac() });
    return { values: v, volumes, lines };
  }

  #clone(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#guestRoute(r, server, guestId, 'admin');
    if (!gc || isAnswer(gc)) return gc;
    const { guest, env } = gc;
    const b = this.#fields(r, ['new_id', 'name', 'full', 'storage', 'project', 'instance_only']);
    if (isAnswer(b)) return b;
    const name = this.#name(b.name);
    if (isAnswer(name)) return name;
    const id = `libvirt:${name}`;
    if (b.new_id !== undefined && b.new_id !== null && b.new_id !== id)
      return this.manage.invalid({ new_id: `A libvirt VM’s id follows its name: ${id}.` });
    const refused = this.#notForLibvirt(b, ['full', 'project', 'instance_only']);
    if (refused) return refused;
    if (guest.state !== 'stopped') return problem(409, 'guest_running', 'The VM has to be stopped first.');
    const busy = this.#busy(server, guestId, String(guest.name));
    if (busy) return busy;
    if (this.host.guest(server, id) || this.#busy(server, id, name))
      return problem(409, 'exists', `${id} already exists.`);
    const copy = this.#copy(env, this.#cfg(server, guest).values, name, b.storage);
    if (isAnswer(copy)) return copy;
    return this.#task(r, server, 'guest.clone', {
      type: 'clone',
      guest: guestId,
      answer: { new_id: id },
      cancellable: true,
      plan: [
        `Cloning ${String(guest.name)} to ${name}`,
        ...copy.lines,
        `Defined ${name} with a new UUID and new MAC addresses`,
      ],
      apply: (good) => {
        if (!good) return;
        for (const x of copy.volumes) this.#vols(env, x.storage).push(x.volume);
        this.#addVm(server, id, copy.values, 'stopped');
      },
    });
  }

  #rename(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#guestRoute(r, server, guestId, 'admin');
    if (!gc || isAnswer(gc)) return gc;
    const { guest } = gc;
    if (guest.self === true) return problem(409, 'self_guest', SELF);
    const b = this.#fields(r, ['name']);
    if (isAnswer(b)) return b;
    const name = this.#name(b.name);
    if (isAnswer(name)) return name;
    if (guest.state !== 'stopped') return problem(409, 'guest_running', 'The VM has to be stopped first.');
    const id = `libvirt:${name}`;
    if (id === guestId) return this.manage.invalid({ name: 'That’s its name already.' });
    if (this.host.guest(server, id)) return problem(409, 'exists', `${id} already exists.`);
    const busy = this.#busy(server, guestId, String(guest.name));
    if (busy) return busy;
    const c = this.#cfg(server, guest);
    const pending = this.#pending.get(this.#key(server, guestId));
    this.host.removeGuest(server, guestId);
    this.host.addGuest(server, { ...guest, id, name });
    const nc = this.host.configOf(server, id);
    nc.values = { ...c.values, name };
    nc.digest = c.digest + 1;
    nc.running = false;
    this.#pending.delete(this.#key(server, guestId));
    if (pending) this.#pending.set(this.#key(server, id), pending);
    const snaps = this.manage.snapshots.get(this.#key(server, guestId));
    if (snaps) {
      this.manage.snapshots.set(this.#key(server, id), snaps);
      this.manage.snapshots.delete(this.#key(server, guestId));
    }
    for (const x of this.#backupsOf(server)) if (x.guest === guestId) x.guest = id;
    this.#hints(server);
    return ok({ ok: true, new_id: id, audit_id: audit() });
  }

  #delete(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#guestRoute(r, server, guestId, 'admin');
    if (!gc || isAnswer(gc)) return gc;
    const { guest, env } = gc;
    if (guest.self === true) return problem(409, 'self_guest', SELF);
    const bad = this.#query(r, ['confirm_name', 'purge']);
    if (bad) return bad;
    const name = String(guest.name);
    if (r.query.get('confirm_name') !== name)
      return problem(400, 'confirm_required', 'Type the VM’s name to delete it.');
    if (guest.state !== 'stopped') return problem(409, 'guest_running', 'The VM has to be stopped first.');
    const busy = this.#busy(server, guestId, name);
    if (busy) return busy;
    const purge = r.query.get('purge') === '1' || r.query.get('purge') === 'true';
    const v = this.#cfg(server, guest).values;
    // Its disks go with it when they're its own (an ISO image in the drive stays).
    const own = purge
      ? deviceKeys(v, 'disk')
          .map((k) => this.#resolve(env, parseDevice(v[k]).source))
          .filter((x): x is { storage: Storage; volume: Volume } => !!x)
          .filter((x) => this.#users(env, x.storage.id, x.volume.name).every((u) => u.guest === guestId))
      : [];
    const extras = [v.firmware === 'uefi' ? 'its NVRAM' : '', v.tpm === '1' ? 'its TPM state' : ''].filter(
      Boolean,
    );
    return this.#task(r, server, 'guest.delete', {
      type: 'delete',
      guest: guestId,
      plan: [
        `Undefining ${name}${extras.length ? ` with ${extras.join(' and ')}` : ''}`,
        ...own.map((x) => `Deleted volume ${this.#ref(x.storage, x.volume.name)}`),
        `${name} is deleted`,
      ],
      apply: (good) => {
        if (!good) return;
        for (const x of own) {
          const list = this.#vols(env, x.storage.id);
          const i = list.indexOf(x.volume);
          if (i >= 0) list.splice(i, 1);
        }
        this.host.removeGuest(server, guestId);
        this.#pending.delete(this.#key(server, guestId));
        this.manage.snapshots.delete(this.#key(server, guestId));
        this.host.emit('guest.state_changed', { server, id: guestId, state: 'stopped' });
      },
    });
  }

  /* Reads: log, snapshots, tasks ------------------------------------------------------------------------------------ */

  #log(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#guestRoute(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    const { guest, env } = gc;
    const raw = r.query.get('lines');
    const lines = raw === null ? 500 : /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(lines >= 1 && lines <= 2000))
      return this.manage.invalid({ lines: 'A number of lines from 1 to 2000.' });
    const v = this.#cfg(server, guest).values;
    const name = String(guest.name);
    const at = Date.parse(this.host.asOf());
    const os = ((this.host.detailOf(server)?.server as Json | undefined)?.os ?? {}) as Json;
    const qemu = String(env.lv.qemu ?? '9.2.0');
    const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+0000');
    const h = hashOf(name);
    const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    const disk0 = this.#resolve(env, parseDevice(v.disk0).source);
    const memKiB = (Number(v.memory_mb) || 1024) * 1024;
    const running = guest.state === 'running';
    const last = running ? at - (Number(guest.uptime_s) || 3600) * 1000 : at - 2 * DAY;
    const all: string[] = [];
    for (let i = 0; i < 5; i++) {
      const start = last - (4 - i) * 6 * DAY;
      const domain = 11 + i;
      all.push(
        `${ts(start)}: starting up libvirt version: ${env.lv.version}, qemu version: ${qemu}, kernel: ${String(os.kernel ?? '')}, hostname: ${server}`,
        'LC_ALL=C \\',
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin \\',
        `HOME=/var/lib/libvirt/qemu/domain-${domain}-${name} \\`,
        '/usr/bin/qemu-system-x86_64 \\',
        `-name guest=${name},debug-threads=on \\`,
        '-S \\',
        `-machine ${v.machine ?? 'q35'},usb=off,vmport=off,dump-guest-core=off,memory-backend=pc.ram,hpet=off,acpi=on \\`,
        '-accel kvm \\',
        `-cpu ${v.cpu_mode === 'host-passthrough' ? 'host,migratable=on' : v.cpu_mode === 'host-model' ? 'EPYC-Genoa' : 'max'} \\`,
        `-m size=${memKiB}k \\`,
        `-smp ${v.vcpus},maxcpus=${v.vcpus_max},sockets=${v.vcpus_max},dies=1,cores=1,threads=1 \\`,
        `-uuid ${uuid} \\`,
        ...(disk0
          ? [
              `-blockdev {"driver":"file","filename":"${disk0.storage.path}/${disk0.volume.name}","node-name":"libvirt-1-storage","auto-read-only":true,"discard":"unmap"} \\`,
            ]
          : []),
        '-msg timestamp=on',
        `char device redirected to /dev/pts/${2 + i} (label charserial0)`,
      );
      if (v.tpm === '1') all.push(`${ts(start + 3_000)}: swtpm: started TPM 2.0 emulator for ${name}`);
      if (i < 4 || !running) {
        const end = i < 4 ? start + 5 * DAY : start + DAY;
        if (i === 2)
          all.push(
            `${ts(end - 1)}: qemu-system-x86_64: terminating on signal 15 from pid 1187 (/usr/sbin/virtqemud)`,
          );
        all.push(`${ts(end)}: shutting down, reason=${i === 2 ? 'destroyed' : 'shutdown'}`);
      }
    }
    return ok({ file: `${name}.log`, lines: all.slice(-lines) });
  }

  #snapshots(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const guest = this.host.guest(server, guestId);
    if (guest?.platform !== 'libvirt') return null;
    void r;
    return ok({
      kind: 'snapshots',
      as_of: this.host.asOf(),
      truncated: false,
      items: this.manage.snapshots.get(this.#key(server, guestId)) ?? [],
    });
  }

  #guestTasks(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#guestRoute(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    const platform = r.query.get('platform');
    const kindOf = (id: string) => /^(incus|unraid|libvirt):/.exec(id)?.[1] ?? 'pve';
    const items = [...this.manage.tasks.values()]
      .filter((t) => t.server === server && t.guest === guestId && (!platform || kindOf(t.id) === platform))
      .sort((a, b) => b.started.localeCompare(a.started))
      .slice(0, 50)
      .map((t) => ({
        id: t.id,
        type: t.type,
        guest: t.guest,
        node: t.node,
        user: t.user,
        started: t.started,
        ...(t.ended ? { ended: t.ended } : {}),
        status: t.status,
        ...(t.message ? { message: t.message } : {}),
        ...(t.cancellable !== undefined ? { cancellable: t.cancellable && t.status === 'running' } : {}),
      }));
    return ok({ items });
  }

  /* Backups --------------------------------------------------------------------------------------------------------- */

  #backupJson(b: Backup): Json {
    return {
      volume: b.volume,
      storage: 'libvirt',
      guest: b.guest,
      kind: 'vm',
      size_bytes: b.size,
      created: b.created,
    };
  }

  #listBackups(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#guestRoute(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    return ok({
      items: this.#backupsOf(server)
        .filter((b) => b.guest === guestId)
        .map((b) => this.#backupJson(b)),
    });
  }

  #backup(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#guestRoute(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    const { guest, env } = gc;
    const b = this.#fields(r, [
      'storage',
      'mode',
      'compress',
      'notes',
      'protected',
      'name',
      'expires_at',
      'instance_only',
      'optimized',
      'compression',
    ]);
    if (isAnswer(b)) return b;
    const refused = this.#notForLibvirt(b.storage === 'libvirt' ? { ...b, storage: undefined } : b, [
      'storage',
      'mode',
      'notes',
      'protected',
      'name',
      'expires_at',
      'instance_only',
      'optimized',
      'compression',
    ]);
    if (refused) return refused;
    if (b.compress !== undefined && typeof b.compress !== 'boolean' && typeof b.compress !== 'string')
      return this.manage.invalid({ compress: 'true or false.' });
    const compress =
      b.compress === true || (typeof b.compress === 'string' && !['', '0', 'none'].includes(b.compress));
    if (!env.lv.backups_dir)
      return problem(501, 'unsupported', 'This host has no backups folder for its VMs.');
    const name = String(guest.name);
    const busy = this.#busy(server, guestId, name);
    if (busy) return busy;
    const list = this.#backupsOf(server);
    let t = Date.now();
    while (list.some((x) => x.guest === guestId && x.volume === stampOf(t))) t += 1000;
    const volume = stampOf(t);
    const v = { ...this.#cfg(server, guest).values };
    const disks = deviceKeys(v, 'disk').map((k) => ({
      target: parseDevice(v[k]).target ?? k,
      found: this.#resolve(env, parseDevice(v[k]).source),
    }));
    const size = Math.round(
      disks.reduce((sum, d) => sum + (d.found?.volume.allocation ?? 0), 0) * (compress ? 0.55 : 1),
    );
    const running = guest.state === 'running';
    const targets = disks.map((d) => d.target);
    return this.#task(r, server, 'backup.create', {
      type: 'backup',
      guest: guestId,
      cancellable: true,
      plan: [
        `Backing up ${name} into ${env.lv.backups_dir}/${name}/${volume}`,
        'Saved domain.xml',
        running
          ? `Backup job started (push mode, disks ${targets.join(', ')}${compress ? ', compressed' : ''})`
          : `${name} is off: copying its disks${compress ? ', compressed' : ''}`,
        ...targets.flatMap((d) => [`Copying disk ${d}: 41 %`, `Copying disk ${d}: 100 %`]),
        running ? 'Backup job finished' : 'Copy finished',
      ],
      apply: (good) => {
        if (!good) return;
        const at = new Date(t).toISOString();
        list.push({ volume, guest: guestId, vm: name, created: at.replace(/\.\d+Z$/, 'Z'), size, values: v });
        const g = this.host.guest(server, guestId);
        if (g) g.last_backup = { result: 'ok', at };
      },
    });
  }

  /** A backup body or query about libvirt: `platform: libvirt`, or none and a libvirt guest. */
  #backupMine(server: string, platform: unknown, guest: unknown): boolean {
    if (platform === 'libvirt') return true;
    if (platform !== undefined && platform !== null && platform !== '') return false;
    return typeof guest === 'string' ? guest.startsWith('libvirt:') : this.#kind(server) === 'libvirt';
  }

  #restore(r: FakeRequest, server: string): FakeAnswer | null {
    const raw = (r.body && typeof r.body === 'object' ? r.body : {}) as Json;
    if (!this.#backupMine(server, raw.platform, raw.guest)) return null;
    const env = this.#hostRoute(r, server, 'admin');
    if (isAnswer(env)) return env;
    const b = this.#fields(r, [
      'platform',
      'volume',
      'new_id',
      'guest',
      'name',
      'storage',
      'start',
      'unique',
      'confirm',
    ]);
    if (isAnswer(b)) return b;
    if (typeof b.guest !== 'string' || !b.guest) return this.manage.invalid({ guest: 'Whose backup?' });
    if (typeof b.volume !== 'string' || !b.volume) return this.manage.invalid({ volume: 'Which backup?' });
    const backup = this.#backupsOf(server).find((x) => x.guest === b.guest && x.volume === b.volume);
    if (!backup) return problem(404, 'not_found', 'No such backup.');
    const name = this.#name(b.name ?? `${backup.vm}-restored`);
    if (isAnswer(name)) return name;
    const id = `libvirt:${name}`;
    if (b.new_id !== undefined && b.new_id !== null && b.new_id !== id)
      return this.manage.invalid({ new_id: `A libvirt VM’s id follows its name: ${id}.` });
    const refused = this.#notForLibvirt(b, ['unique']);
    if (refused) return refused;
    if (b.start !== undefined && typeof b.start !== 'boolean')
      return this.manage.invalid({ start: 'true or false.' });
    if (this.host.guest(server, id) || this.#busy(server, id, name))
      return problem(409, 'exists', `${id} already exists: restore under another name.`);
    const copy = this.#copy(env, backup.values, name, b.storage);
    if (isAnswer(copy)) return copy;
    const start = b.start === true;
    return this.#task(r, server, 'backup.restore', {
      type: 'restore',
      guest: id,
      answer: { new_id: id },
      cancellable: true,
      plan: [
        `Reading ${env.lv.backups_dir}/${backup.vm}/${backup.volume}/domain.xml`,
        ...copy.lines,
        `Defined ${name} with a new UUID and new MAC addresses`,
        ...(start ? [`Started ${name}`] : []),
      ],
      apply: (good) => {
        if (!good) return;
        for (const x of copy.volumes) this.#vols(env, x.storage).push(x.volume);
        this.#addVm(server, id, copy.values, start ? 'running' : 'stopped');
      },
    });
  }

  #updateBackup(r: FakeRequest, server: string): FakeAnswer | null {
    const raw = (r.body && typeof r.body === 'object' ? r.body : {}) as Json;
    if (raw.platform !== 'libvirt') return null;
    const env = this.#hostRoute(r, server, 'operator');
    if (isAnswer(env)) return env;
    return problem(501, 'unsupported', 'A libvirt VM’s backups have no notes or protection.');
  }

  #deleteBackup(r: FakeRequest, server: string): FakeAnswer | null {
    if (!this.#backupMine(server, r.query.get('platform') ?? undefined, r.query.get('guest') ?? undefined))
      return null;
    const env = this.#hostRoute(r, server, 'admin');
    if (isAnswer(env)) return env;
    const bad = this.#query(r, ['platform', 'guest', 'volume']);
    if (bad) return bad;
    const guestId = r.query.get('guest');
    if (!guestId) return this.manage.invalid({ guest: 'Whose backup?' });
    const list = this.#backupsOf(server);
    const i = list.findIndex((x) => x.guest === guestId && x.volume === r.query.get('volume'));
    if (i < 0) return problem(404, 'not_found', 'No such backup.');
    list.splice(i, 1);
    this.#hints(server);
    return ok({ ok: true, audit_id: audit() });
  }

  /* ISO images ------------------------------------------------------------------------------------------------------ */

  #content(r: FakeRequest, server: string, storage: string): FakeAnswer | null {
    if (!this.#mine(server, r.query.get('platform') ?? undefined)) return null;
    const env = this.#hostRoute(r, server, 'operator');
    if (isAnswer(env)) return env;
    const st = this.#storage(env, storage);
    if (!st) return problem(404, 'not_found', 'No such storage.');
    const content = r.query.get('content');
    const items = this.#vols(env, st.id)
      .map((v) => ({ v, content: v.format === 'iso' ? 'iso' : 'images' }))
      .filter((x) => !content || x.content === content)
      .map(({ v, content: kind }) => ({
        volume: `${st.id}/${v.name}`,
        storage: st.id,
        content: kind,
        name: v.name,
        size_bytes: v.capacity,
        ...(kind === 'images' ? { used_bytes: v.allocation, format: v.format } : {}),
        created: v.created,
      }));
    return ok({ items });
  }

  #download(r: FakeRequest, server: string, storage: string): FakeAnswer | null {
    const raw = (r.body && typeof r.body === 'object' ? r.body : {}) as Json;
    if (!this.#mine(server, raw.platform)) return null;
    const env = this.#hostRoute(r, server, 'admin');
    if (isAnswer(env)) return env;
    const b = this.#fields(r, ['platform', 'content', 'url', 'filename', 'checksum', 'checksum_algorithm']);
    if (isAnswer(b)) return b;
    if ((b.content ?? 'iso') !== 'iso')
      return this.manage.invalid({ content: 'libvirt downloads ISO images: iso.' });
    const st = this.#storage(env, storage);
    if (!st?.holds.includes('iso'))
      return this.manage.invalid({ storage: 'That storage doesn’t hold ISO images.' });
    if (typeof b.url !== 'string' || !/^https?:\/\/[^/@\s]+/.test(b.url))
      return this.manage.invalid({ url: 'An http(s) address without a user name or password.' });
    if (typeof b.filename !== 'string' || !FILE_RE.test(b.filename) || !/\.(iso|img)$/i.test(b.filename))
      return this.manage.invalid({ filename: 'A file name ending in .iso or .img.' });
    if ((b.checksum === undefined) !== (b.checksum_algorithm === undefined))
      return this.manage.invalid({ checksum: 'A checksum and its algorithm, or neither.' });
    const filename = b.filename;
    if (this.#vols(env, st.id).some((v) => v.name === filename))
      return problem(409, 'exists', `${filename} is there already.`);
    const path = `${st.path}/${filename}`;
    return this.#task(r, server, 'content.download', {
      type: 'download',
      guest: null,
      cancellable: true,
      plan: [
        `Downloading ${b.url}`,
        `to ${path}`,
        '41% (262.1 MiB of 640.0 MiB)',
        '100% (640.0 MiB of 640.0 MiB)',
        ...(b.checksum ? [`The ${String(b.checksum_algorithm)} checksum matches`] : []),
        `Saved ${path}`,
      ],
      apply: (good) => {
        if (good)
          this.#vols(env, st.id).push({
            name: filename,
            capacity: DOWNLOAD_BYTES,
            allocation: DOWNLOAD_BYTES,
            format: 'iso',
            created: new Date().toISOString(),
          });
      },
    });
  }

  #deleteContent(r: FakeRequest, server: string): FakeAnswer | null {
    if (!this.#mine(server, r.query.get('platform') ?? undefined)) return null;
    const env = this.#hostRoute(r, server, 'admin');
    if (isAnswer(env)) return env;
    const bad = this.#query(r, ['platform', 'volume']);
    if (bad) return bad;
    const found = this.#resolve(env, r.query.get('volume') ?? '');
    if (!found) return problem(404, 'not_found', 'No such ISO image.');
    if (found.volume.format !== 'iso')
      return this.manage.invalid({ volume: 'Not an ISO image: delete disk volumes from their pool.' });
    const users = this.#users(env, found.storage.id, found.volume.name);
    if (users[0])
      return problem(409, 'in_use', `${users[0].name} has it in its CD/DVD drive.`, {
        used_by: users.map((u) => u.guest),
      });
    const list = this.#vols(env, found.storage.id);
    list.splice(list.indexOf(found.volume), 1);
    return ok({ ok: true, audit_id: audit() });
  }

  /* Pool volumes and networks --------------------------------------------------------------------------------------- */

  /** A pool route: the checks, then the pool (501 on unRAID, which has folders instead; 404 for an unknown one). */
  #pool(r: FakeRequest, server: string, pool: string, role: Role): { env: Env; st: Storage } | FakeAnswer {
    const env = this.#hostRoute(r, server, role);
    if (isAnswer(env)) return env;
    if (!env.lv.pools.length)
      return problem(
        501,
        'unsupported',
        'This host’s libvirt has no storage pools: its VM disks are files in the domains folder.',
      );
    const st = this.#storage(env, pool);
    if (!st?.pool) return problem(404, 'not_found', 'No such storage pool.');
    if (st.pool.active === false) return problem(409, 'busy', `Pool ${pool} isn’t active.`);
    return { env, st };
  }

  #createVolume(r: FakeRequest, server: string, pool: string): FakeAnswer {
    const pc = this.#pool(r, server, pool, 'admin');
    if (isAnswer(pc)) return pc;
    const { env, st } = pc;
    const b = this.#fields(r, ['name', 'size', 'content_type', 'format', 'project', 'description']);
    if (isAnswer(b)) return b;
    const refused = this.#notForLibvirt(b, ['content_type', 'project', 'description']);
    if (refused) return refused;
    if (typeof b.name !== 'string' || !VOLUME_RE.test(b.name))
      return this.manage.invalid({ name: 'Letters, digits, dots, dashes and underscores (at most 128).' });
    const size = parseSize(b.size);
    if (!size || size.relative) return this.manage.invalid({ size: 'A size such as 20GiB.' });
    const format = b.format ?? (st.type === 'logical' ? 'raw' : 'qcow2');
    if (format !== 'qcow2' && format !== 'raw') return this.manage.invalid({ format: 'qcow2 or raw.' });
    if (st.type === 'logical' && format !== 'raw')
      return this.manage.invalid({ format: 'An LVM pool holds raw volumes only.' });
    const name = b.name;
    if (this.#vols(env, st.id).some((v) => v.name === name))
      return problem(409, 'exists', `Pool ${pool} has a volume ${name} already.`);
    const allocation = format === 'raw' ? size.bytes : QCOW2_EMPTY;
    if (allocation > Number(st.pool?.avail_bytes ?? 0))
      return this.manage.invalid({
        size: `Pool ${pool} has ${gib(Number(st.pool?.avail_bytes ?? 0))} free.`,
      });
    this.#vols(env, st.id).push({
      name,
      capacity: size.bytes,
      allocation,
      format,
      created: new Date().toISOString(),
    });
    this.#hints(server);
    return ok({ ok: true, audit_id: audit() });
  }

  #resizeVolume(r: FakeRequest, server: string, pool: string, volume: string): FakeAnswer {
    const pc = this.#pool(r, server, pool, 'operator');
    if (isAnswer(pc)) return pc;
    const { env, st } = pc;
    const b = this.#fields(r, ['size', 'project']);
    if (isAnswer(b)) return b;
    const refused = this.#notForLibvirt(b, ['project']);
    if (refused) return refused;
    const vol = this.#vols(env, st.id).find((v) => v.name === volume);
    if (!vol) return problem(404, 'not_found', 'No such volume.');
    const want = parseSize(b.size);
    if (!want) return this.manage.invalid({ size: 'A size such as +8GiB or 40GiB.' });
    const next = want.relative ? vol.capacity + want.bytes : want.bytes;
    if (next < vol.capacity)
      return this.manage.invalid({ size: `Volumes only grow: this one has ${gib(vol.capacity)}.` });
    if (next === vol.capacity) return ok({ ok: true, audit_id: audit() });
    const users = this.#users(env, st.id, vol.name);
    const runningUser = users.find((u) => this.host.guest(server, u.guest)?.state === 'running');
    if (runningUser)
      return problem(
        409,
        'in_use',
        `${runningUser.name} is running with this volume: grow its ${runningUser.key} instead.`,
      );
    if (vol.format === 'raw' && next - vol.capacity > Number(st.pool?.avail_bytes ?? 0))
      return this.manage.invalid({
        size: `Pool ${pool} has ${gib(Number(st.pool?.avail_bytes ?? 0))} free.`,
      });
    vol.capacity = next;
    if (vol.format === 'raw') vol.allocation = next;
    // A stopped VM's disk shows the new size.
    for (const u of users) {
      const g = this.host.guest(server, u.guest);
      if (!g) continue;
      const c = this.#cfg(server, g);
      if (c.values[u.key]?.startsWith('source=') && u.key.startsWith('disk')) {
        c.values[u.key] = deviceString(DISK_ORDER, { ...parseDevice(c.values[u.key]), size: String(next) });
        c.digest += 1;
      }
    }
    this.#hints(server);
    return ok({ ok: true, audit_id: audit() });
  }

  #deleteVolume(r: FakeRequest, server: string, pool: string, volume: string): FakeAnswer {
    const pc = this.#pool(r, server, pool, 'admin');
    if (isAnswer(pc)) return pc;
    const { env, st } = pc;
    const bad = this.#query(r, ['project', 'confirm']);
    if (bad) return bad;
    if (r.query.get('project')) return this.manage.invalid({ project: 'Not for a libvirt pool.' });
    if (r.query.get('confirm') !== '1' && r.query.get('confirm') !== 'true')
      return problem(400, 'confirm_required', 'Deleting a volume destroys its data: send confirm=1.');
    const list = this.#vols(env, st.id);
    const vol = list.find((v) => v.name === volume);
    if (!vol) return problem(404, 'not_found', 'No such volume.');
    const users = this.#users(env, st.id, vol.name);
    if (users[0])
      return problem(409, 'in_use', `${users[0].name} uses this volume (${users[0].key}).`, {
        used_by: users.map((u) => u.guest),
      });
    list.splice(list.indexOf(vol), 1);
    this.#hints(server);
    return ok({ ok: true, audit_id: audit() });
  }

  #leases(r: FakeRequest, server: string, network: string): FakeAnswer {
    const env = this.#hostRoute(r, server, 'operator');
    if (isAnswer(env)) return env;
    const net = env.lv.networks.find((x) => x.name === network);
    if (!net) return problem(404, 'not_found', 'No such network.');
    if (net.dhcp !== true || net.active === false) return ok({ items: [] });
    const prefix = String(net.ipv4 ?? '192.168.122.1/24').replace(/\.\d+\/\d+$/, '.');
    const items: Json[] = [];
    for (const g of this.#vms(server)) {
      if (g.state !== 'running') continue;
      const v = this.#cfg(server, g).values;
      for (const k of deviceKeys(v, 'net')) {
        const d = parseDevice(v[k]);
        if (d.network !== network || !d.mac) continue;
        const last = Number.parseInt(d.mac.slice(-2), 16) || 0;
        items.push({
          hostname: g.name,
          address: `${prefix}${100 + (last % 150)}`,
          hwaddr: d.mac,
          type: 'dynamic',
          guest: g.id,
        });
      }
    }
    if (this.#kind(server) === 'libvirt' && network === 'default')
      items.push({
        hostname: 'ubuntu-test',
        address: `${prefix}214`,
        hwaddr: '52:54:00:1d:88:02',
        type: 'dynamic',
        guest: null,
      });
    return ok({ items });
  }

  /* Hints (the build brief §2.6) ------------------------------------------------------------------------------------ */

  /** The libvirt hints of a QEMU/KVM server as the hub's rules would raise them now. */
  #hints(server: string): void {
    const env = this.#envs.get(server);
    if (!env || this.#kind(server) !== 'libvirt') return;
    const hint = (kind: string, h: Json | null) =>
      this.host.setHint(server, kind, h ? { server, kind, ...h } : null);
    const ratio = (p: Json) => Number(p.used_bytes) / Number(p.total_bytes);
    const full = env.lv.pools
      .filter((p) => Number(p.total_bytes) > 0 && ratio(p) >= 0.85)
      .sort((a, b) => ratio(b) - ratio(a))[0];
    hint(
      'libvirt.pool_full',
      full
        ? {
            severity: 'warning',
            entity: `pool:${String(full.name)}`,
            title: `Storage “${String(full.name)}” ${Math.round(ratio(full) * 100)}% full`,
            detail: `${gb(Number(full.used_bytes))} of ${gb(Number(full.total_bytes))} used`,
            link: '#storage',
          }
        : null,
    );
    const since = Date.parse(this.host.asOf()) - 30 * DAY;
    const backups = this.#backupsOf(server);
    const bare = this.#vms(server).filter((g) => {
      if (g.state !== 'running') return false;
      if (backups.some((b) => b.guest === g.id && Date.parse(b.created) >= since)) return false;
      const snaps = this.manage.snapshots.get(this.#key(server, String(g.id))) ?? [];
      return !snaps.some((s) => Date.parse(String(s.Created ?? '')) >= since);
    });
    const names = bare.map((g) => String(g.name));
    hint(
      'libvirt.no_backup',
      bare.length
        ? {
            severity: 'info',
            entity: bare.length === 1 ? String(bare[0]?.id) : 'libvirt',
            title: bare.length === 1 ? 'A VM without a backup' : `${bare.length} VMs without a backup`,
            detail: names.length > 5 ? `${names.slice(0, 5).join(', ')}, …` : names.join(', '),
            link: '#guests',
          }
        : null,
    );
  }
}
