/**
 * Stream WQ's part of the servers' fixture world (Whombat incus-unraid.md IU-13; app incus-unraid-wq.md AP-1647…): a
 * QEMU/KVM server `kvm-lab` in line with the Whombat server's fake (Debian 13 with libvirt 12.2: pools `default`, `isos`
 * and `fast` — LVM, 88 % full —, the NAT network `default` with its leases and `lan` bridged to br0, ISO images, five
 * VMs — debian-web with a change waiting for its next start and two backups, win11 with UEFI, Secure Boot and a TPM on a
 * raw LVM volume (no snapshots), pfsense with a network card passed through, alpine-test and nixos-build switched off —
 * and the two libvirt hints) and BlackBox's real `pbs` VM (`virsh -r dumpxml pbs` on 2026-10-17: BIOS, q35, a qcow2
 * system disk, a raw datastore, a read-only seed image, macvtap on vhost0) with Unraid's VM Manager folders
 * (`/boot/config/domain.cfg`). `withWq(handle, ctx)` wraps `createHostsFixtures`' handler: it adds kvm-lab to the world,
 * answers every libvirt read and change the way contracts 0.84 describe them (config with digests and changes waiting
 * for the next start, CD/DVD media live, disks, network cards, create, clone, rename, delete, backups, pool volumes, ISO
 * downloads, leases, the QEMU log, tasks) and passes the rest on. Tasks grow their log a few lines per read and end
 * after a set number of reads.
 */
import type {
  HostBackupVolume,
  HostChoices,
  HostGuest,
  HostGuestConfig,
  HostHint,
  HostLibvirtDetail,
  HostNetworkLease,
  HostPlatformWorkload,
  HostServer,
  HostServerDetail,
  HostSnapshot,
  HostTask,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest, HostsFixtureWorld } from './fixtures';
import { LIBVIRT_OS_VARIANTS, lvFileName, readLvDisk } from './libvirt';
import { editProps, getProp, parseProps } from './props';

const H = 3_600_000;
const DAY = 24 * H;
const GiB = 1024 ** 3;

export const WQ_SERVER = 'kvm-lab';
const BB = 'blackbox';

export interface WqFixtureContext {
  world: HostsFixtureWorld;
  now: number;
  /** Rebuilds a server's page after its guests changed (kvm-lab's is rebuilt here, on every read). */
  refreshServer: (serverId: string) => void;
  /** The wall clock for tasks (tests pass a fixed one). */
  clock?: () => number;
  /**
   * kvm-lab in the fleet's list (Home, the servers table, the sidebar). Default: `localStorage['whombat.fixtures.qemu']`
   * is `1` (the review shots set it), so the mock's five servers stay as drawn; its pages answer either way.
   */
  listed?: boolean;
}

function listedFromStorage(): boolean {
  try {
    return globalThis.localStorage?.getItem('whombat.fixtures.qemu') === '1';
  } catch {
    return false;
  }
}

type Handle = (req: HostsFixtureRequest) => HostsFixtureAnswer | null;

interface LvConfig {
  values: Record<string, string>;
  pending: Record<string, string>;
  pendingDelete: string[];
  restricted: string[];
  rev: number;
}

interface Vol {
  pool: string;
  name: string;
  sizeBytes: number;
  usedBytes: number;
  format: string;
  created: string;
}

interface FakeTask {
  id: string;
  serverId: string;
  guestId?: string;
  type: string;
  started: number;
  reads: number;
  steps: number;
  lines: string[];
  result: 'ok' | 'warning' | 'error';
  message: string;
  ended?: number;
  onDone?: () => void;
}

function problem(status: number, code: string, message: string, fields?: Record<string, string>) {
  return {
    status,
    body: {
      error: {
        code:
          status === 404
            ? 'not_found'
            : status === 400
              ? 'bad_request'
              : status === 403
                ? 'forbidden'
                : 'conflict',
        message,
        details: { code, ...(fields ? { fields } : {}) },
      },
    },
  };
}

const ok = (body: Record<string, unknown> = {}): HostsFixtureAnswer => ({
  status: 200,
  body: { ok: true, auditId: 'aud_wq', ...body },
});

/* The seed --------------------------------------------------------------------------------------------- */

const COMMON_LOCKED = ['machine', 'firmware', 'secure_boot', 'tpm', 'video'];

function seedConfigs(): Map<string, LvConfig> {
  const m = new Map<string, LvConfig>();
  const put = (server: string, id: string, values: Record<string, string>, extra: Partial<LvConfig> = {}) =>
    m.set(`${server}/${id}`, {
      values,
      pending: {},
      pendingDelete: [],
      restricted: [
        ...COMMON_LOCKED,
        ...Object.keys(values).filter((k) =>
          /^(graphics|hostdev|rng|watchdog|serial|channel|input|sound)\d*$/.test(k),
        ),
      ],
      rev: 1,
      ...extra,
    });
  put(
    WQ_SERVER,
    'libvirt:debian-web',
    {
      name: 'debian-web',
      title: 'Web server (nginx and PHP)',
      description: '',
      vcpus: '4',
      vcpus_max: '8',
      memory_mb: '8192',
      memory_max_mb: '8192',
      autostart: '1',
      boot: 'hd',
      cpu_mode: 'host-model',
      on_poweroff: 'destroy',
      on_reboot: 'restart',
      on_crash: 'restart',
      disk0: `source=default/debian-web.qcow2,bus=virtio,format=qcow2,target=vda,size=${32 * GiB}`,
      disk1: `source=default/debian-web-data.qcow2,bus=virtio,format=qcow2,target=vdb,size=${200 * GiB}`,
      cdrom0: 'source=empty,bus=sata,target=sda',
      net0: 'model=virtio,network=default,mac=52:54:00:51:7e:02,link=up',
      machine: 'pc-q35-10.1',
      firmware: 'bios',
      graphics0: 'type=vnc,listen=127.0.0.1',
      video: 'model=virtio',
      rng0: 'model=virtio,backend=/dev/urandom',
      channel0: 'type=unix,target=org.qemu.guest_agent.0',
    },
    { pending: { memory_max_mb: '16384', memory_mb: '12288' } },
  );
  put(WQ_SERVER, 'libvirt:win11', {
    name: 'win11',
    title: 'Windows 11 desktop',
    description: 'For the tax software and the label printer.',
    vcpus: '8',
    vcpus_max: '8',
    memory_mb: '16384',
    memory_max_mb: '16384',
    autostart: '0',
    boot: 'hd,cdrom',
    cpu_mode: 'host-passthrough',
    on_poweroff: 'destroy',
    on_reboot: 'restart',
    on_crash: 'destroy',
    // A raw LVM volume on `fast`: fast, and no internal snapshots.
    disk0: `source=fast/win11,bus=sata,format=raw,target=sda,size=${120 * GiB}`,
    cdrom0: 'source=isos/Win11_24H2_EnglishInternational_x64.iso,bus=sata,target=sdb',
    cdrom1: 'source=isos/virtio-win-0.1.271.iso,bus=sata,target=sdc',
    net0: 'model=e1000e,network=default,mac=52:54:00:3c:91:0a,link=up',
    machine: 'pc-q35-10.1',
    firmware: 'uefi',
    secure_boot: '1',
    tpm: 'model=tpm-crb,backend=emulator,version=2.0',
    graphics0: 'type=vnc,listen=127.0.0.1',
    video: 'model=virtio',
    input0: 'type=tablet,bus=usb',
    sound0: 'model=ich9',
  });
  put(WQ_SERVER, 'libvirt:pfsense', {
    name: 'pfsense',
    title: 'Firewall',
    description: 'pfSense CE with the second network port passed through as its WAN.',
    vcpus: '2',
    vcpus_max: '2',
    memory_mb: '4096',
    memory_max_mb: '4096',
    autostart: '1',
    boot: 'hd',
    cpu_mode: 'host-passthrough',
    on_poweroff: 'destroy',
    on_reboot: 'restart',
    on_crash: 'restart',
    disk0: `source=fast/pfsense,bus=virtio,format=raw,target=vda,size=${16 * GiB}`,
    net0: 'model=virtio,network=lan,mac=52:54:00:9d:22:14,link=up',
    machine: 'pc-q35-10.1',
    firmware: 'bios',
    graphics0: 'type=vnc,listen=127.0.0.1',
    video: 'model=virtio',
    hostdev0: 'type=pci,address=0000:05:00.0,name=Intel I226-V 2.5 GbE',
  });
  put(WQ_SERVER, 'libvirt:alpine-test', {
    name: 'alpine-test',
    title: '',
    description: '',
    vcpus: '1',
    vcpus_max: '1',
    memory_mb: '512',
    memory_max_mb: '512',
    autostart: '0',
    boot: 'hd,cdrom',
    cpu_mode: 'host-model',
    on_poweroff: 'destroy',
    on_reboot: 'restart',
    on_crash: 'destroy',
    disk0: `source=default/alpine-test.qcow2,bus=virtio,format=qcow2,target=vda,size=${4 * GiB}`,
    cdrom0: 'source=isos/alpine-virt-3.22.1-x86_64.iso,bus=sata,target=sda',
    net0: 'model=virtio,network=default,mac=52:54:00:7a:01:33,link=up',
    machine: 'pc-q35-10.1',
    firmware: 'bios',
    graphics0: 'type=vnc,listen=127.0.0.1',
    video: 'model=virtio',
  });
  put(WQ_SERVER, 'libvirt:nixos-build', {
    name: 'nixos-build',
    title: 'Nix builder',
    description: '',
    vcpus: '8',
    vcpus_max: '16',
    memory_mb: '16384',
    memory_max_mb: '32768',
    autostart: '0',
    boot: 'hd',
    cpu_mode: 'host-passthrough',
    on_poweroff: 'destroy',
    on_reboot: 'restart',
    on_crash: 'destroy',
    disk0: `source=fast/nixos-build,bus=virtio,format=raw,target=vda,size=${200 * GiB}`,
    net0: 'model=virtio,network=default,mac=52:54:00:6e:1b:40,link=up',
    machine: 'pc-q35-10.1',
    firmware: 'uefi',
    secure_boot: '0',
    graphics0: 'type=vnc,listen=127.0.0.1',
    video: 'model=virtio',
  });
  // BlackBox's pbs as `virsh -r dumpxml pbs` showed it (sizes from its files; the guest agent channel, watchdog,
  // RNG and serial console are what the XML has besides).
  put(BB, 'libvirt:pbs', {
    name: 'pbs',
    title: '',
    description: '',
    vcpus: '4',
    vcpus_max: '4',
    memory_mb: '8192',
    memory_max_mb: '8192',
    autostart: '1',
    boot: 'hd',
    cpu_mode: 'host-passthrough',
    on_poweroff: 'destroy',
    on_reboot: 'restart',
    on_crash: 'restart',
    disk0: `source=/mnt/data/PBS-Backup/pbs/pbs-os.qcow2,bus=virtio,format=qcow2,target=vda,size=${32 * GiB}`,
    disk1: `source=/mnt/data/PBS-Backup/pbs/pbs-datastore.raw,bus=virtio,format=raw,target=vdb,size=${2048 * GiB}`,
    disk2:
      'source=/mnt/data/PBS-Backup/pbs/seed.img,bus=virtio,format=raw,target=vdc,size=1048576,readonly=1',
    net0: 'model=virtio,direct=vhost0,mac=52:54:00:8a:e0:c6,link=up',
    machine: 'pc-q35-9.2',
    firmware: 'bios',
    graphics0: 'type=vnc,port=5900,websocket=5700,listen=0.0.0.0',
    video: 'model=qxl,vram=65536',
    watchdog0: 'model=itco,action=reset',
    rng0: 'model=virtio,backend=/dev/urandom',
    serial0: 'type=pty',
    channel0: 'type=unix,target=org.qemu.guest_agent.0',
  });
  return m;
}

function seedGuests(now: number): HostGuest[] {
  const base = {
    serverId: WQ_SERVER,
    serverOnline: true,
    platform: 'libvirt' as const,
    kind: 'vm' as const,
    tags: [],
  };
  const on = { available: true, protocols: ['vnc' as const], defaultProtocol: 'vnc' as const };
  const off = { ...on, available: false };
  return [
    {
      ...base,
      id: 'libvirt:debian-web',
      name: 'debian-web',
      image: 'Debian 13',
      state: 'running',
      vcpu: 4,
      cpuPct: 11.2,
      memoryUsedMb: 6420,
      memoryLimitMb: 8192,
      diskReadMbs: 1.4,
      diskWriteMbs: 3.1,
      netRxMbps: 22,
      netTxMbps: 61,
      uptimeS: 18 * 86_400 + 5 * 3600,
      console: on,
      addresses: ['192.168.122.12'],
      snapshots: 2,
      oldestSnapshot: new Date(now - 40 * DAY).toISOString(),
      pendingChanges: 2,
      autostart: true,
      lastBackup: { result: 'ok', at: new Date(now - 26 * H).toISOString() },
    },
    {
      ...base,
      id: 'libvirt:win11',
      name: 'win11',
      image: 'Windows 11 Pro',
      state: 'running',
      vcpu: 8,
      cpuPct: 6.4,
      memoryUsedMb: 11_240,
      memoryLimitMb: 16_384,
      diskReadMbs: 0.6,
      diskWriteMbs: 0.9,
      netRxMbps: 3,
      netTxMbps: 1,
      uptimeS: 2 * 86_400 + 7 * 3600,
      console: on,
      addresses: ['192.168.122.47'],
      snapshots: 0,
      autostart: false,
      lastBackup: null,
    },
    {
      ...base,
      id: 'libvirt:pfsense',
      name: 'pfsense',
      image: 'pfSense CE 2.8',
      state: 'running',
      vcpu: 2,
      cpuPct: 3.1,
      memoryUsedMb: 1180,
      memoryLimitMb: 4096,
      netRxMbps: 140,
      netTxMbps: 38,
      uptimeS: 18 * 86_400 + 5 * 3600,
      console: on,
      addresses: ['10.100.0.1'],
      snapshots: 0,
      autostart: true,
      lastBackup: null,
    },
    {
      ...base,
      id: 'libvirt:alpine-test',
      name: 'alpine-test',
      image: 'Alpine Linux 3.22',
      state: 'stopped',
      vcpu: 1,
      cpuPct: null,
      memoryUsedMb: null,
      memoryLimitMb: 512,
      uptimeS: null,
      lastExit: 'Shut down 3 days ago',
      console: off,
      snapshots: 0,
      autostart: false,
      lastBackup: null,
    },
    {
      ...base,
      id: 'libvirt:nixos-build',
      name: 'nixos-build',
      image: 'NixOS 25.05',
      state: 'stopped',
      vcpu: 8,
      cpuPct: null,
      memoryUsedMb: null,
      memoryLimitMb: 16_384,
      uptimeS: null,
      lastExit: 'Shut down 9 days ago',
      console: off,
      snapshots: 0,
      autostart: false,
      lastBackup: null,
    },
  ];
}

/** BlackBox's pbs, as stream WU's world has it (added when that world isn't there). */
function pbsGuest(): HostGuest {
  return {
    id: 'libvirt:pbs',
    serverId: BB,
    serverOnline: true,
    name: 'pbs',
    platform: 'libvirt',
    kind: 'vm',
    image: 'Proxmox Backup Server 4',
    state: 'running',
    vcpu: 4,
    cpuPct: 1.2,
    memoryUsedMb: 5900,
    memoryLimitMb: 8192,
    uptimeS: 41 * 86_400,
    console: {
      available: true,
      protocols: ['vnc'],
      defaultProtocol: 'vnc',
      unavailable: { spice: 'Whombat shows VM screens over VNC.' },
    },
    addresses: ['10.100.0.41'],
    tags: [],
    autostart: true,
  };
}

function seedVols(now: number): Vol[] {
  const at = (d: number) => new Date(now - d * DAY).toISOString();
  const v = (pool: string, name: string, gib: number, usedGib: number, format: string, d: number): Vol => ({
    pool,
    name,
    sizeBytes: Math.round(gib * GiB),
    usedBytes: Math.round(usedGib * GiB),
    format,
    created: at(d),
  });
  const iso = (name: string, bytes: number, d: number): Vol => ({
    pool: 'isos',
    name,
    sizeBytes: bytes,
    usedBytes: bytes,
    format: 'raw',
    created: at(d),
  });
  return [
    v('default', 'debian-web.qcow2', 32, 14.2, 'qcow2', 210),
    v('default', 'debian-web-data.qcow2', 200, 121.8, 'qcow2', 180),
    v('default', 'alpine-test.qcow2', 4, 0.3, 'qcow2', 12),
    v('default', 'old-test.qcow2', 20, 3.1, 'qcow2', 300),
    iso('debian-13.1.0-amd64-netinst.iso', 784_334_848, 40),
    iso('Win11_24H2_EnglishInternational_x64.iso', 5_819_484_160, 60),
    iso('virtio-win-0.1.271.iso', 743_440_384, 60),
    iso('ubuntu-24.04.3-live-server-amd64.iso', 3_213_064_192, 90),
    iso('alpine-virt-3.22.1-x86_64.iso', 66_060_288, 12),
    iso('nixos-minimal-25.05-x86_64-linux.iso', 1_181_116_006, 30),
    // LVM volumes on `fast`: raw, their whole size taken.
    v('fast', 'win11', 120, 120, 'raw', 60),
    v('fast', 'pfsense', 16, 16, 'raw', 400),
    v('fast', 'nixos-build', 200, 200, 'raw', 30),
    v('fast', 'scratch', 64, 64, 'raw', 90),
  ];
}

/** Pools: their size and what isn't a volume of their own (other files on the same file system). */
const POOLS = [
  {
    name: 'default',
    type: 'dir',
    path: '/var/lib/libvirt/images',
    totalBytes: 1_769 * GiB,
    otherBytes: 920 * GiB,
    autostart: true,
  },
  {
    name: 'isos',
    type: 'dir',
    path: '/srv/isos',
    totalBytes: 912 * GiB,
    otherBytes: 372 * GiB,
    autostart: true,
  },
  {
    name: 'fast',
    type: 'logical',
    path: '/dev/vg_fast',
    totalBytes: 930 * GiB,
    otherBytes: 422 * GiB,
    autostart: true,
  },
];

/** An LVM pool's volumes are raw block devices without a file ending. */
const isLvm = (pool: string) => POOLS.find((p) => p.name === pool)?.type === 'logical';
const volFile = (pool: string, base: string, format: string) =>
  isLvm(pool) ? base : `${base}.${format === 'raw' ? 'img' : 'qcow2'}`;

const LEASES: HostNetworkLease[] = [
  {
    hostname: 'debian-web',
    address: '192.168.122.12',
    hwaddr: '52:54:00:51:7e:02',
    type: 'ipv4',
    guestId: 'libvirt:debian-web',
  },
  {
    hostname: 'DESKTOP-W11',
    address: '192.168.122.47',
    hwaddr: '52:54:00:3c:91:0a',
    type: 'ipv4',
    guestId: 'libvirt:win11',
  },
  {
    hostname: 'alpine-test',
    address: '192.168.122.83',
    hwaddr: '52:54:00:7a:01:33',
    type: 'ipv4',
    guestId: 'libvirt:alpine-test',
  },
  { hostname: '', address: '192.168.122.150', hwaddr: '52:54:00:aa:10:7f', type: 'ipv4', guestId: null },
];

const QEMU_LOG = (name: string, now: number) => {
  const t = (ms: number) => new Date(now - ms).toISOString().replace('T', ' ').slice(0, 23);
  return [
    `${t(2 * DAY)}+0000: starting up libvirt version: 12.2.0, package: 12.2.0-1 (Debian), qemu version: 10.1.0Debian 1:10.1.0+ds-2, kernel: 6.12.48+deb13-amd64, hostname: kvm-lab`,
    'LC_ALL=C \\',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin \\',
    `HOME=/var/lib/libvirt/qemu/domain-3-${name} \\`,
    `/usr/bin/qemu-system-x86_64 \\`,
    `-name guest=${name},debug-threads=on \\`,
    '-machine pc-q35-10.0,usb=off,vmport=off,smm=on,dump-guest-core=off,memory-backend=pc.ram,hpet=off,acpi=on \\',
    '-accel kvm \\',
    '-cpu host,migratable=on \\',
    '-smp 4,sockets=1,dies=1,clusters=1,cores=4,threads=1 \\',
    '-vnc 127.0.0.1:0 \\',
    '-msg timestamp=on',
    `char device redirected to /dev/pts/3 (label charserial0)`,
    `${t(2 * DAY - 4000)}+0000: Domain id=3 is tainted: host-cpu`,
  ];
};

/* The handler ------------------------------------------------------------------------------------------ */

/** Wrap the hosts fixtures' handler with stream WQ's routes (see the file's comment). */
export function withWq(next: Handle, ctx: WqFixtureContext): Handle {
  const { world, now } = ctx;
  const clock = ctx.clock ?? (() => Date.now());
  const listed = ctx.listed ?? listedFromStorage();
  const configs = seedConfigs();
  const vols = seedVols(now);
  const tasks = new Map<string, FakeTask>();
  const history: HostTask[] = [
    {
      id: 'libvirt:00000000a1b2c3d4',
      type: 'backup',
      platform: 'libvirt',
      guestId: 'libvirt:debian-web',
      node: WQ_SERVER,
      user: 'whombat',
      started: new Date(now - 26 * H).toISOString(),
      ended: new Date(now - 26 * H + 6 * 60_000).toISOString(),
      status: 'ok',
      message: 'OK',
    },
    {
      id: 'libvirt:00000000a1b2c3d5',
      type: 'download',
      platform: 'libvirt',
      guestId: null,
      node: WQ_SERVER,
      user: 'john',
      started: new Date(now - 40 * DAY).toISOString(),
      ended: new Date(now - 40 * DAY + 90_000).toISOString(),
      status: 'ok',
      message: 'OK',
    },
  ];
  const snapshots = new Map<string, HostSnapshot[]>([
    [
      'libvirt:debian-web',
      [
        {
          name: 'before-php84',
          created: new Date(now - 40 * DAY).toISOString(),
          description: 'Before moving to PHP 8.4',
        },
        { name: 'clean-install', created: new Date(now - 200 * DAY).toISOString(), description: '' },
      ],
    ],
  ]);
  const backups: HostBackupVolume[] = [
    {
      volume: stamp(now - 26 * H),
      storage: 'libvirt',
      guest: 'debian-web',
      kind: 'vm',
      sizeBytes: Math.round(71.4 * GiB),
      created: new Date(now - 26 * H).toISOString(),
      format: 'qcow2',
    },
    {
      volume: stamp(now - 8 * DAY - 26 * H),
      storage: 'libvirt',
      guest: 'debian-web',
      kind: 'vm',
      sizeBytes: Math.round(69.9 * GiB),
      created: new Date(now - 8 * DAY - 26 * H).toISOString(),
      format: 'qcow2',
    },
  ];
  const networks: HostLibvirtDetail['networks'] = [
    {
      name: 'default',
      active: true,
      autostart: true,
      bridge: 'virbr0',
      forward: 'nat',
      ipv4: '192.168.122.1/24',
      dhcp: true,
      usedBy: 4,
    },
    {
      name: 'lan',
      active: true,
      autostart: true,
      bridge: 'br0',
      forward: 'bridge',
      ipv4: null,
      dhcp: false,
      usedBy: 0,
    },
  ];
  let seq = 0;
  let rev = 100;

  /* kvm-lab in the world --------------------------------------------------------------------------- */

  const template = world.details.get('the-falcon');
  const templateRow = world.servers.find((s) => s.id === 'the-falcon');
  /** kvm-lab's VMs: in the world when it's listed, else lent to it for kvm-lab's own requests only (below). */
  let kvmGuests = seedGuests(now);
  if (template && templateRow && !world.details.has(WQ_SERVER)) {
    if (listed) world.guests.set(WQ_SERVER, kvmGuests);
    world.settings.set(WQ_SERVER, {
      ...(world.settings.get('the-falcon') ?? {
        id: WQ_SERVER,
        group: 'Home lab',
        location: null,
        remoteControl: { console: true, power: true },
        agentPolicy: { console: true, power: true },
      }),
      id: WQ_SERVER,
      location: 'Office rack, shelf 2',
    });
    if (listed) world.servers.push(serverRow(templateRow, guestsOf(WQ_SERVER)));
    // Its page is worked out from the-falcon's on every read (below); this one lets the main world's routes find it.
    world.details.set(WQ_SERVER, kvmDetail(template));
  }
  // BlackBox's pbs when stream WU's world isn't there to give it.
  const bbList = world.guests.get(BB);
  if (bbList && !bbList.some((g) => g.id === 'libvirt:pbs')) world.guests.set(BB, [...bbList, pbsGuest()]);

  function guestsOf(serverId: string): HostGuest[] {
    if (serverId === WQ_SERVER) return world.guests.get(WQ_SERVER) ?? kvmGuests;
    return world.guests.get(serverId) ?? [];
  }
  const findGuest = (serverId: string, id: string) => guestsOf(serverId).find((g) => g.id === id);
  const setGuests = (serverId: string, list: HostGuest[]) => {
    if (serverId === WQ_SERVER) {
      kvmGuests = list;
      if (world.guests.has(WQ_SERVER)) world.guests.set(WQ_SERVER, list);
      return;
    }
    world.guests.set(serverId, list);
    ctx.refreshServer(serverId);
  };
  const patchGuest = (serverId: string, id: string, patch: Partial<HostGuest>) =>
    setGuests(
      serverId,
      guestsOf(serverId).map((g) => (g.id === id ? { ...g, ...patch } : g)),
    );

  function workload(list: HostGuest[]): HostPlatformWorkload {
    const running = list.filter((g) => g.state === 'running' || g.state === 'unhealthy');
    return {
      running: running.length,
      total: list.length,
      cpuPct: Math.round(running.reduce((a, g) => a + (g.cpuPct ?? 0), 0) * 10) / 10,
      memoryGb: Math.round((running.reduce((a, g) => a + (g.memoryUsedMb ?? 0), 0) / 1024) * 10) / 10,
      vms: list.length,
      guests: list,
    };
  }

  function serverRow(t: HostServer, list: HostGuest[]): HostServer {
    const running = list.filter((g) => g.state === 'running').length;
    return {
      ...t,
      id: WQ_SERVER,
      name: WQ_SERVER,
      status: hintsOf().some((h) => h.severity === 'warning') ? 'warn' : 'ok',
      statusNote: null,
      platform: 'libvirt',
      os: 'Debian 13',
      cpu: { model: 'Ryzen 9 7950X', cores: 16, threads: 32 },
      uptimeS: 18 * 86_400 + 6 * 3600,
      cpuPct: 14,
      memory: { usedPct: 41, usedGb: 52.6, totalGb: 128 },
      storage: { usedPct: 53, usedTb: 2.5, capacityTb: 4.6 },
      temperature: { maxC: 58, limitC: 95 },
      guests: [{ platform: 'libvirt', running, total: list.length }],
      alerts: { critical: 0, warning: 0 },
    };
  }

  function poolDetail(): HostLibvirtDetail['pools'] {
    return POOLS.map((p) => {
      const mine = vols.filter((v) => v.pool === p.name);
      const used = p.otherBytes + mine.reduce((a, v) => a + v.usedBytes, 0);
      return {
        name: p.name,
        type: p.type,
        active: true,
        autostart: p.autostart,
        path: p.path,
        usedBytes: used,
        totalBytes: p.totalBytes,
        availBytes: Math.max(0, p.totalBytes - used),
        volumes: mine.length,
      };
    });
  }

  function libvirtOf(serverId: string): HostLibvirtDetail {
    if (serverId === BB)
      return {
        version: '12.2.0',
        qemu: '10.2.2',
        pools: [],
        networks: [],
        folders: { domains: '/mnt/user/domains/', isos: '/mnt/user/isos/' },
        firmware: { uefi: true, secureBoot: true, tpm: true },
        backupsDir: '/mnt/user/domains/.whombat-backups',
      };
    const usedBy = (name: string) =>
      [...configs.entries()].filter(
        ([k, c]) =>
          k.startsWith(`${WQ_SERVER}/`) && Object.values(c.values).some((v) => v.includes(`network=${name}`)),
      ).length;
    return {
      version: '12.2.0',
      qemu: '10.1.0',
      pools: poolDetail(),
      networks: networks.map((n) => ({ ...n, usedBy: usedBy(n.name) })),
      folders: null,
      firmware: { uefi: true, secureBoot: true, tpm: true },
      backupsDir: '/var/lib/libvirt/images/.whombat-backups',
    };
  }

  function hintsOf(): HostHint[] {
    const out: HostHint[] = [];
    for (const p of poolDetail()) {
      const pct = p.totalBytes ? (p.usedBytes / p.totalBytes) * 100 : 0;
      if (pct >= 85)
        out.push({
          serverId: WQ_SERVER,
          kind: 'libvirt.pool_full',
          severity: 'warning',
          entity: p.name,
          title: `Storage “${p.name}” ${Math.round(pct)}% full`,
          detail: `${Math.round(p.usedBytes / GiB)} of ${Math.round(p.totalBytes / GiB)} GiB used. VMs with disks there stop when it fills up.`,
          section: 'storage',
        });
    }
    const bare = guestsOf(WQ_SERVER).filter(
      (g) =>
        g.state === 'running' &&
        !backups.some((b) => b.guest === g.name && Date.parse(b.created ?? '') > now - 30 * DAY) &&
        !(snapshots.get(g.id) ?? []).some((s) => Date.parse(s.created ?? '') > now - 30 * DAY),
    );
    if (bare.length)
      out.push({
        serverId: WQ_SERVER,
        kind: 'libvirt.no_backup',
        severity: 'info',
        entity: bare.length === 1 ? (bare[0]?.id ?? '') : 'libvirt',
        title:
          bare.length === 1
            ? 'A VM has no backup or snapshot from the last 30 days'
            : `${bare.length} VMs have no backup or snapshot from the last 30 days`,
        detail: bare.map((g) => g.name).join(', '),
        section: 'guests',
      });
    return out;
  }

  function kvmDetail(t: HostServerDetail): HostServerDetail {
    const list = guestsOf(WQ_SERVER);
    const hints = hintsOf();
    return {
      ...t,
      asOf: new Date(now).toISOString(),
      server: {
        ...t.server,
        id: WQ_SERVER,
        status: hints.some((h) => h.severity === 'warning') ? 'warn' : 'ok',
        statusNote: null,
        roles: ['kvm-host'],
        os: { name: 'Debian GNU/Linux', version: '13', kernel: '6.12.48+deb13-amd64' },
        cpu: { model: 'Ryzen 9 7950X', cores: 16, threads: 32 },
        memory: { totalGb: 128, type: 'DDR5' },
        uptimeS: 18 * 86_400 + 6 * 3600,
        lastBoot: new Date(now - 18 * DAY).toISOString(),
        address: '10.100.0.21',
        location: 'Office rack, shelf 2',
        platform: 'libvirt',
      },
      live: t.live
        ? {
            ...t.live,
            cpuPct: 14,
            cpuUserPct: 9.8,
            cpuSystemPct: 3.5,
            cpuIowaitPct: 0.7,
            loadAvg: [2.1, 1.9, 1.7],
            memPct: 41,
            memUsedGb: 52.6,
            memCacheGb: 18.2,
            memFreeGb: 75.4,
          }
        : null,
      banner: null,
      sensors: t.sensors.map((s) =>
        s.id === 'cpu_package'
          ? { ...s, source: 'k10temp · Tctl', nowC: 58, maxC: 66, limitC: 95 }
          : { ...s, nowC: (s.nowC ?? 40) - 6 },
      ),
      disks: [
        {
          device: 'nvme0n1',
          type: 'nvme',
          model: 'WD Black SN850X 1TB',
          role: 'system',
          capacityGb: 1000,
          usedGb: 806,
          wearPct: 4,
          writtenTb: 28,
          ratedTbw: 600,
          tempC: 44,
          powerOnHours: 6_120,
          health: 'healthy',
          smart: { passed: true, mediaErrors: 0, unsafeShutdowns: 1, sparePct: 100, spareThreshold: 10 },
        },
        {
          device: 'sda',
          type: 'hdd',
          model: 'Seagate IronWolf 4TB',
          role: 'data',
          capacityGb: 4000,
          usedGb: 1_740,
          wearPct: null,
          tempC: 36,
          powerOnHours: 14_800,
          health: 'healthy',
          smart: { passed: true, reallocated: 0, pending: 0 },
        },
      ],
      virtualization: {
        stacks: ['libvirt'],
        capabilities: {
          kvm: { enabled: true, module: 'kvm_amd', device: '/dev/kvm' },
          cpuVirtualization: { type: 'AMD-V', flag: 'svm', nestedPaging: true },
          iommu: { enabled: true, groups: 18, vfioPciDevices: 0 },
          nested: { enabled: true, moduleParam: 'nested=1' },
        },
        allocation: {
          vcpuAllocated: 23,
          hostThreads: 32,
          vcpuOvercommitRatio: 0.72,
          guestMemoryAssignedGb: 44.5,
          hostMemoryGb: 128,
          guestMemoryInUseGb: 18.4,
          diskIoMbs: { total: 6, read: 2, write: 4 },
          networkMbps: { total: 87, rx: 25, tx: 62 },
        },
      },
      hints,
      alerts: [],
      health: t.health
        ? {
            ...t.health,
            system: t.health.system
              ? { ...t.health.system, updates: 2, securityUpdates: 0, processes: 412 }
              : t.health.system,
            network: [
              ...(t.health.network ?? [])
                .filter((n) => n.name !== 'virbr0')
                .map((n) =>
                  n.name === 'br0'
                    ? { ...n, addresses: ['10.100.0.21/24'], members: ['enp2s0', 'vnet3'] }
                    : n,
                ),
              {
                name: 'virbr0',
                kind: 'bridge',
                up: true,
                carrier: true,
                speedMbps: null,
                mtu: 1500,
                addresses: ['192.168.122.1/24'],
                master: null,
                members: ['vnet0', 'vnet2'],
                rxMbps: 9,
                txMbps: 31,
                errors: 0,
                drops: 0,
              },
            ],
            volumes: [
              {
                entity: 'fs:/',
                kind: 'fs',
                label: '/',
                usedGb: 806,
                totalGb: 984,
                usedPct: 82,
                fullInDays: 60,
                fsType: 'ext4',
                device: '/dev/nvme0n1p2',
              },
              {
                entity: 'fs:/srv',
                kind: 'fs',
                label: '/srv',
                usedGb: 1_740,
                totalGb: 4_000,
                usedPct: 44,
                fullInDays: null,
                fsType: 'xfs',
                device: '/dev/sda1',
              },
            ],
            arrays: [],
            fans: [],
            tasks: [],
          }
        : t.health,
      workloads: { libvirt: workload(list) },
      proxmox: undefined,
      libvirt: libvirtOf(WQ_SERVER),
    };
  }

  /* Configurations ---------------------------------------------------------------------------------- */

  const cfgKey = (serverId: string, id: string) => `${serverId}/${id}`;

  function disksOf(values: Record<string, string>): NonNullable<HostGuestConfig['disks']> {
    const out: NonNullable<HostGuestConfig['disks']> = [];
    const boot = (values.boot ?? '').split(',')[0];
    let firstDisk = true;
    for (const [k, v] of Object.entries(values)) {
      if (/^disk\d+$/.test(k)) {
        const d = readLvDisk(v);
        out.push({
          key: k,
          storage: d.source.startsWith('/')
            ? d.source.slice(0, d.source.lastIndexOf('/'))
            : d.source.split('/')[0],
          volume: lvFileName(d.source),
          ...(d.sizeBytes != null ? { sizeBytes: d.sizeBytes } : {}),
          media: 'disk',
          path: d.source.startsWith('/')
            ? d.source
            : `${POOLS.find((p) => d.source.startsWith(`${p.name}/`))?.path ?? ''}/${lvFileName(d.source)}`,
          boot: boot === 'hd' && firstDisk,
        });
        firstDisk = false;
      } else if (/^cdrom\d+$/.test(k)) {
        const src = getProp(parseProps(v), 'source') ?? '';
        out.push({ key: k, media: 'cdrom', ...(src && src !== 'empty' ? { volume: lvFileName(src) } : {}) });
      }
    }
    return out;
  }

  function configOf(serverId: string, id: string): HostGuestConfig | null {
    const c = configs.get(cfgKey(serverId, id));
    const g = findGuest(serverId, id);
    if (!c || !g) return null;
    return {
      platform: 'libvirt',
      kind: 'vm',
      digest: `lv-${id.slice(8)}-${c.rev}`,
      running: g.state !== 'stopped',
      values: { ...c.values },
      ...(Object.keys(c.pending).length ? { pending: { ...c.pending } } : {}),
      ...(c.pendingDelete.length ? { pendingDelete: [...c.pendingDelete] } : {}),
      restricted: c.restricted.filter((k) => k in c.values),
      disks: disksOf(c.values),
    };
  }

  /** A stopped VM takes what waited for its next start. */
  function applyPending(serverId: string, id: string) {
    const c = configs.get(cfgKey(serverId, id));
    if (!c || (!Object.keys(c.pending).length && !c.pendingDelete.length)) return;
    const values = { ...c.values, ...c.pending };
    for (const k of c.pendingDelete) delete values[k];
    configs.set(cfgKey(serverId, id), { ...c, values, pending: {}, pendingDelete: [], rev: ++rev });
    patchGuest(serverId, id, {
      pendingChanges: 0,
      memoryLimitMb: Number(values.memory_mb ?? 0) || null,
      vcpu: Number(values.vcpus ?? 0) || null,
    });
  }

  /** Keys a running VM takes at once (contracts 0.84): media, link state, memory and vCPUs up to their maximum. */
  function liveOk(c: LvConfig, k: string, v: string): boolean {
    if (['title', 'description', 'autostart'].includes(k)) return true;
    const was = c.values[k];
    if (/^cdrom\d+$/.test(k) && was !== undefined)
      return editProps(was, { source: getProp(parseProps(v), 'source') }) === v;
    if (/^net\d+$/.test(k) && was !== undefined)
      return editProps(was, { link: getProp(parseProps(v), 'link') }) === v;
    if (k === 'memory_mb') return Number(v) <= Number(c.values.memory_max_mb ?? c.values.memory_mb);
    if (k === 'vcpus') return Number(v) <= Number(c.values.vcpus_max ?? c.values.vcpus);
    return false;
  }

  /** A new disk (`new=20G,storage=default,…`) made into a volume of its pool (or the VM folder on Unraid). */
  function makeDisk(serverId: string, vm: string, key: string, v: string): string {
    const p = parseProps(v);
    const size = Number.parseInt(getProp(p, 'new') ?? '8', 10) * GiB;
    const storage = getProp(p, 'storage') ?? 'default';
    const format = isLvm(storage) ? 'raw' : (getProp(p, 'format') ?? 'qcow2');
    const bus = getProp(p, 'bus') ?? 'virtio';
    const file = volFile(storage, `${vm}-${key}`, format);
    const source =
      serverId === BB || storage.startsWith('folder:')
        ? `/mnt/user/domains/${vm}/${file}`
        : `${storage}/${file}`;
    if (!source.startsWith('/'))
      vols.push({
        pool: storage,
        name: file,
        sizeBytes: size,
        usedBytes: 0.2 * GiB,
        format,
        created: new Date(now).toISOString(),
      });
    return `source=${source},bus=${bus},format=${format},size=${size}`;
  }

  function setConfig(serverId: string, id: string, body: Record<string, unknown>): HostsFixtureAnswer {
    const c = configs.get(cfgKey(serverId, id));
    const cfg = configOf(serverId, id);
    if (!c || !cfg) return problem(404, 'guest_not_found', 'That VM isn’t there.');
    if (body.digest && body.digest !== cfg.digest)
      return problem(409, 'digest_mismatch', 'Changed meanwhile — review again.');
    const p = (body.params ?? {}) as { set?: Record<string, string>; delete?: string[]; revert?: string[] };
    const touched = [...Object.keys(p.set ?? {}), ...(p.delete ?? [])];
    const locked = touched.find((k) => c.restricted.includes(k));
    if (locked)
      return problem(
        403,
        'not_allowed',
        'Whombat doesn’t change that; use the platform’s own screens for it.',
      );
    const bad = Object.entries(p.set ?? {}).find(([k, v]) => /^net\d+$/.test(k) && /network=nowhere/.test(v));
    if (bad)
      return problem(400, 'invalid', 'Fix the marked fields.', {
        [bad[0]]: 'There’s no network called nowhere.',
      });
    const values = { ...c.values };
    const pending = { ...c.pending };
    let pendingDelete = [...c.pendingDelete];
    const changes: { key: string; old?: string; new?: string; pending?: boolean }[] = [];
    const running = cfg.running;
    for (const [k, raw] of Object.entries(p.set ?? {})) {
      const v =
        /^disk\d+$/.test(k) && /(^|,)new=/.test(raw)
          ? makeDisk(serverId, cfg.values.name ?? id, k, raw)
          : raw;
      if (running && !liveOk(c, k, v)) {
        pending[k] = v;
        changes.push({ key: k, old: values[k], new: v, pending: true });
      } else {
        changes.push({ key: k, old: values[k], new: v });
        values[k] = v;
        delete pending[k];
      }
    }
    for (const k of p.delete ?? []) {
      if (running && !/^cdrom/.test(k)) {
        if (!pendingDelete.includes(k)) pendingDelete.push(k);
        changes.push({ key: k, old: values[k], pending: true });
      } else {
        changes.push({ key: k, old: values[k] });
        delete values[k];
      }
    }
    for (const k of p.revert ?? []) {
      delete pending[k];
      pendingDelete = pendingDelete.filter((x) => x !== k);
    }
    configs.set(cfgKey(serverId, id), { ...c, values, pending, pendingDelete, rev: ++rev });
    patchGuest(serverId, id, {
      pendingChanges: Object.keys(pending).length + pendingDelete.length,
      vcpu: Number(values.vcpus ?? 0) || null,
      memoryLimitMb: Number(values.memory_mb ?? 0) || null,
      autostart: values.autostart === '1',
    });
    return ok({ changes });
  }

  /* Tasks ------------------------------------------------------------------------------------------ */

  function startTask(
    serverId: string,
    type: string,
    lines: string[],
    o: {
      guestId?: string;
      steps?: number;
      result?: FakeTask['result'];
      message?: string;
      onDone?: () => void;
      newId?: string;
    } = {},
  ): HostsFixtureAnswer {
    seq += 1;
    const id = `libvirt:${(0x5eed0000 + seq).toString(16).padStart(16, '0')}`;
    tasks.set(id, {
      id,
      serverId,
      ...(o.guestId ? { guestId: o.guestId } : {}),
      type,
      started: clock(),
      reads: 0,
      steps: o.steps ?? 3,
      lines,
      result: o.result ?? 'ok',
      message: o.message ?? 'OK',
      ...(o.onDone ? { onDone: o.onDone } : {}),
    });
    return ok({ task: { id }, ...(o.newId ? { newId: o.newId } : {}) });
  }

  function taskStatus(t: FakeTask, logStart: number): HostTask {
    if (!t.ended) {
      t.reads += 1;
      if (t.reads >= t.steps) {
        t.ended = clock();
        t.onDone?.();
      }
    }
    const shown = t.ended
      ? t.lines.length
      : Math.min(t.lines.length, Math.ceil((t.reads / t.steps) * t.lines.length));
    const from = logStart < 0 ? shown : Math.max(0, Math.min(logStart, shown));
    return {
      id: t.id,
      type: t.type,
      platform: 'libvirt',
      guestId: t.guestId ?? null,
      node: t.serverId,
      user: 'whombat',
      started: new Date(t.started).toISOString(),
      ended: t.ended ? new Date(t.ended).toISOString() : null,
      status: t.ended ? t.result : 'running',
      ...(t.ended ? { message: t.message } : {}),
      log: t.lines.slice(from, shown),
      logNext: shown,
    };
  }

  function taskRows(serverId: string, guestId?: string): HostTask[] {
    const live = [...tasks.values()]
      .filter((t) => t.serverId === serverId)
      .map((t) => {
        const { log: _log, logNext: _next, ...row } = taskStatus({ ...t, reads: t.reads - 1 }, -1);
        return row as HostTask;
      });
    return [...live, ...(serverId === WQ_SERVER ? history : [])]
      .filter((t) => !guestId || t.guestId === guestId)
      .sort((a, b) => b.started.localeCompare(a.started));
  }

  /* Changes ---------------------------------------------------------------------------------------- */

  const macOf = (i: number) =>
    `52:54:00:${(0x40 + seq).toString(16).padStart(2, '0')}:${(0x10 + i).toString(16)}:${(0x20 + (rev % 200)).toString(16).padStart(2, '0')}`;
  const isosOf = (serverId: string) =>
    serverId === BB ? [] : vols.filter((v) => /\.(iso|img)$/i.test(v.name));
  const inUse = (volid: string) =>
    [...configs.values()].some((c) =>
      [...Object.values(c.values), ...Object.values(c.pending)].some(
        (v) => getProp(parseProps(v), 'source') === volid,
      ),
    );

  function newGuest(
    serverId: string,
    name: string,
    values: Record<string, string>,
    image: string,
    start: boolean,
  ) {
    const id = `libvirt:${name}`;
    configs.set(cfgKey(serverId, id), {
      values,
      pending: {},
      pendingDelete: [],
      restricted: [...COMMON_LOCKED, ...Object.keys(values).filter((k) => /^graphics\d+$/.test(k))],
      rev: ++rev,
    });
    const mem = Number(values.memory_mb ?? 1024);
    setGuests(serverId, [
      ...guestsOf(serverId),
      {
        id,
        serverId,
        serverOnline: true,
        name,
        platform: 'libvirt',
        kind: 'vm',
        image,
        state: start ? 'running' : 'stopped',
        vcpu: Number(values.vcpus ?? 1),
        cpuPct: start ? 18 : null,
        memoryUsedMb: start ? Math.round(mem * 0.2) : null,
        memoryLimitMb: mem,
        uptimeS: start ? 20 : null,
        console: { available: start, protocols: ['vnc'], defaultProtocol: 'vnc' },
        tags: [],
        snapshots: 0,
        autostart: values.autostart === '1',
        lastBackup: null,
      },
    ]);
    return id;
  }

  function manage(serverId: string, body: Record<string, unknown>): HostsFixtureAnswer | null {
    const op = String(body.op ?? '');
    const guestId = typeof body.guestId === 'string' ? body.guestId : '';
    const params = (body.params ?? {}) as Record<string, unknown>;
    const lvGuest = guestId.startsWith('libvirt:');
    const lvHost = body.platform === 'libvirt' || params.platform === 'libvirt' || serverId === WQ_SERVER;
    if (!lvGuest && !lvHost) return null;
    const g = lvGuest ? findGuest(serverId, guestId) : undefined;
    if (lvGuest && !g) return problem(404, 'guest_not_found', 'That VM isn’t there.');
    const stoppedOnly = (what: string) =>
      g && g.state !== 'stopped' ? problem(409, 'running', `Shut ${g.name} down first: ${what}`) : null;
    switch (op) {
      case 'config.set':
        return setConfig(serverId, guestId, body);
      case 'disk.resize': {
        const c = configs.get(cfgKey(serverId, guestId));
        const key = String(params.disk ?? '');
        const v = c?.values[key];
        if (!c || !v) return problem(404, 'not_found', 'That disk isn’t there.');
        const m = /^\+?(\d+)G$/.exec(String(params.size ?? ''));
        if (!m) return problem(400, 'invalid', 'Fix the marked fields.', { size: 'Disks only grow.' });
        const d = readLvDisk(v);
        const size = (d.sizeBytes ?? 0) + Number(m[1]) * GiB;
        c.values[key] = editProps(v, { size: String(size) });
        c.rev = ++rev;
        const vol = vols.find((x) => `${x.pool}/${x.name}` === d.source);
        if (vol) vol.sizeBytes = size;
        return ok({ changes: [{ key, old: v, new: c.values[key] }] });
      }
      case 'guest.create': {
        const name = String(params.name ?? '');
        if (guestsOf(serverId).some((x) => x.name === name))
          return problem(409, 'exists', 'Fix the marked fields.', {
            name: 'There’s a VM with that name already.',
          });
        const os = LIBVIRT_OS_VARIANTS.find((o) => o.id === params.osVariant);
        const set = (params.set ?? {}) as Record<string, string>;
        const storage = String(params.storage ?? 'default');
        const gb = Number(params.diskGb ?? 20);
        const win = os?.id.startsWith('win') ?? false;
        const iso = String(params.iso ?? '');
        const link = params.bridge ? `bridge=${params.bridge}` : `network=${params.network ?? 'default'}`;
        const start = params.start === true;
        const raw = isLvm(storage);
        const file = volFile(storage, name, raw ? 'raw' : 'qcow2');
        const source =
          serverId === BB || storage.startsWith('folder:')
            ? `/mnt/user/domains/${name}/vdisk1.img`
            : `${storage}/${file}`;
        const values: Record<string, string> = {
          name,
          title: '',
          description: '',
          vcpus: set.vcpus ?? '2',
          vcpus_max: set.vcpus ?? '2',
          memory_mb: set.memory_mb ?? '2048',
          memory_max_mb: set.memory_mb ?? '2048',
          autostart: set.autostart ?? '0',
          boot: 'hd,cdrom',
          cpu_mode: 'host-passthrough',
          on_poweroff: 'destroy',
          on_reboot: 'restart',
          on_crash: 'destroy',
          disk0: `source=${source},bus=${win ? 'sata' : 'virtio'},format=${source.startsWith('/') || raw ? 'raw' : 'qcow2'},size=${gb * GiB}`,
          cdrom0: `source=${iso || 'empty'},bus=sata`,
          net0: `model=${win ? 'e1000e' : 'virtio'},${link},mac=${macOf(0)},link=up`,
          machine: 'pc-q35-10.0',
          firmware: os?.firmware ?? 'bios',
          ...(os?.firmware === 'uefi' ? { secure_boot: win ? '1' : '0' } : {}),
          ...(os?.tpm ? { tpm: 'model=tpm-crb,backend=emulator,version=2.0' } : {}),
          graphics0: 'type=vnc,listen=127.0.0.1',
          video: 'model=virtio',
        };
        const id = `libvirt:${name}`;
        return startTask(
          serverId,
          'create',
          [
            `Making ${name} (${os?.label ?? 'Other'})`,
            `Creating its ${gb} GiB disk on ${storage}`,
            os?.firmware === 'uefi' ? 'Setting up UEFI firmware (OVMF)' : 'Setting up BIOS firmware',
            ...(os?.tpm ? ['Adding an emulated TPM 2.0 (swtpm)'] : []),
            `Defining ${name} in libvirt`,
            ...(start ? [`Starting ${name}`] : []),
            'Done.',
          ],
          {
            guestId: id,
            newId: id,
            onDone: () => {
              if (!source.startsWith('/'))
                vols.push({
                  pool: storage,
                  name: file,
                  sizeBytes: gb * GiB,
                  usedBytes: raw ? gb * GiB : 0.2 * GiB,
                  format: raw ? 'raw' : 'qcow2',
                  created: new Date(clock()).toISOString(),
                });
              newGuest(serverId, name, values, os?.label ?? 'Other', start);
            },
          },
        );
      }
      case 'guest.clone': {
        const refused = stoppedOnly('libvirt copies a VM’s disks only while it’s stopped.');
        if (refused || !g) return refused;
        const name = String(params.name ?? `${g.name}-copy`);
        if (guestsOf(serverId).some((x) => x.name === name))
          return problem(409, 'exists', 'Fix the marked fields.', {
            name: 'There’s a VM with that name already.',
          });
        const src = configs.get(cfgKey(serverId, guestId));
        const storage = typeof params.storage === 'string' && params.storage ? params.storage : '';
        return startTask(
          serverId,
          'clone',
          [
            `Copying ${g.name}’s disks`,
            '  20 %',
            '  55 %',
            '  100 %',
            'New UUID and MAC addresses',
            `Defining ${name}`,
            'Done.',
          ],
          {
            guestId,
            steps: 4,
            newId: `libvirt:${name}`,
            onDone: () => {
              const values: Record<string, string> = { ...(src?.values ?? {}), name, title: '' };
              let i = 0;
              for (const [k, v] of Object.entries(values)) {
                if (/^disk\d+$/.test(k)) {
                  const d = readLvDisk(v);
                  const pool =
                    storage || (d.source.startsWith('/') ? '' : d.source.split('/')[0] || 'default');
                  const file = pool
                    ? volFile(pool, `${name}-${k}`, d.format)
                    : `${name}-${k}.${d.format === 'raw' ? 'img' : 'qcow2'}`;
                  const source = pool
                    ? `${pool}/${file}`
                    : `${d.source.slice(0, d.source.lastIndexOf('/'))}/${file}`;
                  if (pool)
                    vols.push({
                      pool,
                      name: file,
                      sizeBytes: d.sizeBytes ?? 8 * GiB,
                      usedBytes: (d.sizeBytes ?? 0) * 0.4,
                      format: d.format,
                      created: new Date(clock()).toISOString(),
                    });
                  values[k] = editProps(v, { source });
                }
                if (/^net\d+$/.test(k)) values[k] = editProps(v, { mac: macOf(i++) });
              }
              newGuest(serverId, name, values, g.image, false);
            },
          },
        );
      }
      case 'guest.rename': {
        const refused = stoppedOnly('libvirt renames a VM only while it’s stopped.');
        if (refused || !g) return refused;
        const name = String(params.name ?? '');
        if (guestsOf(serverId).some((x) => x.name === name))
          return problem(409, 'exists', 'Fix the marked fields.', {
            name: 'There’s a VM with that name already.',
          });
        const id = `libvirt:${name}`;
        const c = configs.get(cfgKey(serverId, guestId));
        if (c) {
          configs.delete(cfgKey(serverId, guestId));
          configs.set(cfgKey(serverId, id), { ...c, values: { ...c.values, name }, rev: ++rev });
        }
        for (const b of backups) if (b.guest === g.name) b.guest = name;
        const snaps = snapshots.get(guestId);
        if (snaps) {
          snapshots.delete(guestId);
          snapshots.set(id, snaps);
        }
        setGuests(
          serverId,
          guestsOf(serverId).map((x) => (x.id === guestId ? { ...x, id, name } : x)),
        );
        return ok({ newId: id });
      }
      case 'guest.delete': {
        const refused = stoppedOnly('libvirt deletes a VM only while it’s stopped.');
        if (refused || !g) return refused;
        if (body.confirmName !== g.name) return problem(400, 'confirm_name', 'Type its name to confirm.');
        const c = configs.get(cfgKey(serverId, guestId));
        const purge = params.purge === true;
        return startTask(
          serverId,
          'delete',
          [
            `Removing ${g.name} from libvirt`,
            ...(purge ? ['Deleting its disks and its UEFI settings'] : ['Its disks stay where they are']),
            'Done.',
          ],
          {
            guestId,
            steps: 2,
            onDone: () => {
              if (purge && c)
                for (const [k, v] of Object.entries(c.values)) {
                  if (!/^disk\d+$/.test(k)) continue;
                  const src = readLvDisk(v).source;
                  const at = vols.findIndex((x) => `${x.pool}/${x.name}` === src);
                  if (at >= 0) vols.splice(at, 1);
                }
              configs.delete(cfgKey(serverId, guestId));
              setGuests(
                serverId,
                guestsOf(serverId).filter((x) => x.id !== guestId),
              );
            },
          },
        );
      }
      case 'backup.create': {
        if (!g) return problem(400, 'invalid', 'Which VM?');
        const at = clock();
        const size =
          (configOf(serverId, guestId)?.disks ?? []).reduce((a, d) => a + (d.sizeBytes ?? 0), 0) * 0.55;
        const dir = libvirtOf(serverId).backupsDir;
        return startTask(
          serverId,
          'backup',
          [
            `Backing up ${g.name}${g.state === 'stopped' ? ' (stopped: copying its disks)' : ' while it runs'}`,
            `Into ${dir}/${g.name}/${stamp(at)}/`,
            'domain.xml saved',
            '  12 %',
            '  48 %',
            '  91 %',
            '  100 %',
            params.compress === true ? 'Compressed.' : 'Done.',
          ],
          {
            guestId,
            steps: 5,
            onDone: () => {
              backups.unshift({
                volume: stamp(at),
                storage: 'libvirt',
                guest: g.name,
                kind: 'vm',
                sizeBytes: Math.round(size),
                created: new Date(at).toISOString(),
                format: 'qcow2',
              });
              patchGuest(serverId, guestId, { lastBackup: { result: 'ok', at: new Date(at).toISOString() } });
            },
          },
        );
      }
      case 'backup.restore': {
        const b = backups.find((x) => x.volume === params.volume && x.guest === params.guest);
        if (!b) return problem(404, 'not_found', 'That backup isn’t there any more.');
        const name = String(params.name ?? `${b.guest}-restored`);
        if (guestsOf(serverId).some((x) => x.name === name))
          return problem(409, 'exists', 'Fix the marked fields.', {
            name: 'There’s a VM with that name already.',
          });
        const src = [...configs.entries()].find(
          ([k, c]) => k.startsWith(`${serverId}/`) && c.values.name === b.guest,
        )?.[1];
        const start = params.start === true;
        return startTask(
          serverId,
          'restore',
          [
            `Restoring the backup of ${b.guest} as ${name}`,
            'Copying its disks',
            '  40 %',
            '  100 %',
            'New UUID and MAC addresses',
            `Defining ${name}`,
            ...(start ? [`Starting ${name}`] : []),
            'Done.',
          ],
          {
            steps: 4,
            newId: `libvirt:${name}`,
            onDone: () => {
              const values: Record<string, string> = {
                ...(src?.values ?? { vcpus: '2', memory_mb: '2048' }),
                name,
              };
              let i = 0;
              for (const [k, v] of Object.entries(values)) {
                if (/^disk\d+$/.test(k))
                  values[k] = editProps(v, { source: `${params.storage || 'default'}/${name}-${k}.qcow2` });
                if (/^net\d+$/.test(k)) values[k] = editProps(v, { mac: macOf(i++) });
              }
              newGuest(
                serverId,
                name,
                values,
                findGuest(serverId, `libvirt:${b.guest}`)?.image ?? 'Restored VM',
                start,
              );
            },
          },
        );
      }
      case 'backup.delete': {
        const at = backups.findIndex((x) => x.volume === params.volume && x.guest === params.guest);
        if (at < 0) return problem(404, 'not_found', 'That backup isn’t there any more.');
        backups.splice(at, 1);
        return ok();
      }
      case 'volume.create': {
        const pool = String(params.pool ?? '');
        const name = String(params.name ?? '');
        if (vols.some((v) => v.pool === pool && v.name === name))
          return problem(409, 'exists', 'Fix the marked fields.', {
            name: 'There’s a volume with that name already.',
          });
        const gib = Number.parseInt(String(params.size ?? '1'), 10);
        vols.push({
          pool,
          name,
          sizeBytes: gib * GiB,
          usedBytes: params.format === 'raw' || isLvm(pool) ? gib * GiB : 0.2 * GiB,
          format: isLvm(pool) ? 'raw' : String(params.format ?? 'qcow2'),
          created: new Date(clock()).toISOString(),
        });
        return ok();
      }
      case 'volume.resize': {
        const v = vols.find((x) => x.pool === params.pool && x.name === params.volume);
        if (!v) return problem(404, 'not_found', 'That volume isn’t there.');
        const gib = Number.parseInt(String(params.size ?? '0'), 10);
        if (gib * GiB <= v.sizeBytes)
          return problem(400, 'invalid', 'Fix the marked fields.', { size: 'Volumes only grow.' });
        v.sizeBytes = gib * GiB;
        return ok();
      }
      case 'volume.delete': {
        const at = vols.findIndex((x) => x.pool === params.pool && x.name === params.volume);
        if (at < 0) return problem(404, 'not_found', 'That volume isn’t there.');
        if (inUse(`${params.pool}/${params.volume}`))
          return problem(409, 'in_use', 'It’s still in use, so it can’t be removed.');
        vols.splice(at, 1);
        return ok();
      }
      case 'content.download': {
        const storage = String(params.storage ?? 'default');
        const filename = String(params.filename ?? 'download.iso');
        return startTask(
          serverId,
          'download',
          [`Downloading ${params.url}`, '  9 %', '  37 %', '  74 %', '  100 %', `Saved as ${filename}`],
          {
            steps: 5,
            onDone: () => {
              if (!storage.startsWith('folder:'))
                vols.push({
                  pool: storage,
                  name: filename,
                  sizeBytes: 1_288_490_189,
                  usedBytes: 1_288_490_189,
                  format: 'raw',
                  created: new Date(clock()).toISOString(),
                });
            },
          },
        );
      }
      case 'content.delete': {
        const volid = String(params.volume ?? params.volid ?? '');
        if (inUse(volid)) return problem(409, 'in_use', 'It’s still in use, so it can’t be removed.');
        const at = vols.findIndex((x) => `${x.pool}/${x.name}` === volid);
        if (at >= 0) vols.splice(at, 1);
        return ok();
      }
      case 'task.stop': {
        const t = tasks.get(String(params.task ?? params.taskId ?? params.upid ?? ''));
        if (t && !t.ended) {
          t.ended = clock();
          t.result = 'error';
          t.message = 'Stopped by John.';
          t.lines.push('Stopped.');
        }
        return ok();
      }
      case 'guest.autostart': {
        if (serverId !== WQ_SERVER || !g) return null;
        const c = configs.get(cfgKey(serverId, guestId));
        if (c) c.values.autostart = params.on === true ? '1' : '0';
        patchGuest(serverId, guestId, { autostart: params.on === true });
        return ok();
      }
      default:
        return serverId === WQ_SERVER ? problem(400, 'unsupported', 'libvirt doesn’t do that.') : null;
    }
  }

  function read(serverId: string, query: Record<string, string>): HostsFixtureAnswer | null {
    const guestId = query.guestId ?? '';
    const lv = guestId.startsWith('libvirt:') || query.platform === 'libvirt' || serverId === WQ_SERVER;
    if (!lv) return null;
    switch (query.op) {
      case 'config.get': {
        const cfg = configOf(serverId, guestId);
        return cfg
          ? { status: 200, body: { op: 'config.get', config: cfg } }
          : problem(404, 'guest_not_found', 'That VM isn’t there.');
      }
      case 'choices':
        return { status: 200, body: { op: 'choices', choices: choicesOf(serverId) } };
      case 'backup.list': {
        const g = guestId ? findGuest(serverId, guestId) : undefined;
        const items = serverId === WQ_SERVER ? backups.filter((b) => !g || b.guest === g.name) : [];
        return { status: 200, body: { op: 'backup.list', items } };
      }
      case 'snapshot.list':
        return { status: 200, body: { op: 'snapshot.list', items: snapshots.get(guestId) ?? [] } };
      case 'task.list':
        return { status: 200, body: { op: 'task.list', items: taskRows(serverId, guestId || undefined) } };
      case 'log.get': {
        const g = findGuest(serverId, guestId);
        if (!g) return problem(404, 'guest_not_found', 'That VM isn’t there.');
        const lines = QEMU_LOG(g.name, now);
        return {
          status: 200,
          body: {
            op: 'log.get',
            file: `/var/log/libvirt/qemu/${g.name}.log`,
            lines: lines.slice(-Number(query.lines ?? 500)),
          },
        };
      }
      case 'network.leases':
        return {
          status: 200,
          body: {
            op: 'network.leases',
            items: serverId === WQ_SERVER && query.network === 'default' ? LEASES : [],
          },
        };
      case 'content.list': {
        const storage = query.storage ?? '';
        if (serverId === BB || storage === 'folder:isos')
          return {
            status: 200,
            body: {
              op: 'content.list',
              items:
                storage === 'folder:isos'
                  ? [
                      {
                        volid: '/mnt/user/isos/debian-13-genericcloud-amd64.qcow2',
                        name: 'debian-13-genericcloud-amd64.qcow2',
                        sizeBytes: 339_017_728,
                        format: 'qcow2',
                        usedBy: [],
                        created: '2026-06-04T05:09:00Z',
                      },
                    ]
                  : [],
            },
          };
        const users = (volid: string) =>
          [...configs.entries()]
            .filter(
              ([k, c]) =>
                k.startsWith(`${serverId}/`) &&
                Object.values(c.values).some((v) => getProp(parseProps(v), 'source') === volid),
            )
            .map(([k]) => k.slice(serverId.length + 1));
        const items = vols
          .filter((v) => v.pool === storage)
          .filter((v) => query.content !== 'iso' || /\.(iso|img)$/i.test(v.name))
          .map((v) => ({
            volid: `${v.pool}/${v.name}`,
            name: v.name,
            sizeBytes: v.sizeBytes,
            usedBytes: v.usedBytes,
            format: v.format,
            usedBy: users(`${v.pool}/${v.name}`),
            created: v.created,
          }));
        return { status: 200, body: { op: 'content.list', items } };
      }
      default:
        return null;
    }
  }

  function choicesOf(serverId: string): HostChoices {
    if (serverId === BB)
      return {
        platform: 'libvirt',
        node: BB,
        storages: [
          {
            id: 'folder:domains',
            type: 'dir',
            content: ['images'],
            availBytes: 9.2 * 1024 * GiB,
            totalBytes: 16 * 1024 * GiB,
          },
        ],
        bridges: ['br0'],
        networks: [],
        isos: [],
        osVariants: [...LIBVIRT_OS_VARIANTS],
        firmware: { uefi: true, secureBoot: true, tpm: true },
        download: true,
      };
    return {
      platform: 'libvirt',
      node: WQ_SERVER,
      storages: poolDetail().map((p) => ({
        id: p.name,
        type: p.type,
        content: ['images', 'iso'],
        availBytes: p.availBytes,
        totalBytes: p.totalBytes,
      })),
      bridges: ['br0'],
      networks: networks.filter((n) => n.active).map((n) => n.name),
      isos: isosOf(serverId).map((v) => ({
        volid: `${v.pool}/${v.name}`,
        name: v.name,
        sizeBytes: v.sizeBytes,
      })),
      osVariants: [...LIBVIRT_OS_VARIANTS],
      firmware: { uefi: true, secureBoot: true, tpm: true },
      download: true,
    };
  }

  function handle(req: HostsFixtureRequest): HostsFixtureAnswer | null {
    const { method, path, query, body } = req;
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
    const server = seg[0] === 'servers' ? seg[1] : undefined;
    const ours = server === WQ_SERVER || server === BB;
    if (ours && server) {
      if (method === 'GET' && seg[2] === 'manage' && seg.length === 3) {
        const out = read(server, query);
        if (out) return out;
      }
      if (method === 'POST' && seg[2] === 'manage' && seg.length === 3) {
        const out = manage(server, body);
        if (out) return out;
      }
      if (method === 'GET' && seg[2] === 'tasks' && seg[3]?.startsWith('libvirt:')) {
        const t = tasks.get(seg[3]);
        const old = history.find((x) => x.id === seg[3]);
        if (t) return { status: 200, body: taskStatus(t, Number(query.logStart ?? 0)) };
        if (old) return { status: 200, body: { ...old, log: ['OK'], logNext: 1 } };
        return problem(404, 'task_not_found', 'That task isn’t there any more.');
      }
      // A raw disk can't take an internal snapshot (IU-13): said plainly, before anything happens.
      if (
        method === 'POST' &&
        seg[2] === 'guests' &&
        seg[3]?.startsWith('libvirt:') &&
        seg[4] === 'actions'
      ) {
        const action = String(body.action ?? '');
        const id = seg[3];
        if (action === 'snapshot_create') {
          const cfg = configOf(server, id);
          const raw = Object.entries(cfg?.values ?? {}).find(
            ([k, v]) => /^disk\d+$/.test(k) && readLvDisk(v).format === 'raw',
          );
          if (raw)
            return problem(
              409,
              'snapshot_unsupported',
              `Snapshots need every disk in qcow2: ${lvFileName(readLvDisk(raw[1]).source)} is raw. Back it up instead.`,
            );
          const list = snapshots.get(id) ?? [];
          snapshots.set(id, [
            {
              name: String(body.snapshot ?? `snap-${++seq}`),
              created: new Date(clock()).toISOString(),
              description: String(body.description ?? ''),
            },
            ...list,
          ]);
          patchGuest(server, id, { snapshots: list.length + 1 });
          return { status: 202, body: { actionId: `act_wq_${++seq}` } };
        }
        if (action === 'snapshot_delete') {
          const list = (snapshots.get(id) ?? []).filter((s) => s.name !== body.snapshot);
          snapshots.set(id, list);
          patchGuest(server, id, { snapshots: list.length });
          return { status: 202, body: { actionId: `act_wq_${++seq}` } };
        }
        const out = next(req);
        const after = findGuest(server, id);
        if (after?.state === 'stopped') applyPending(server, id);
        return out;
      }
    }
    const out = next(req);
    if (!server) {
      if (out?.status === 200 && method === 'GET' && path.replace(/^\//, '') === 'fleet') {
        const fleet = out.body as { servers: HostServer[] };
        const t = world.servers.find((s) => s.id === WQ_SERVER);
        return {
          ...out,
          body: {
            ...fleet,
            servers: fleet.servers.map((s) =>
              s.id === WQ_SERVER && t ? serverRow(t, guestsOf(WQ_SERVER)) : s,
            ),
          },
        };
      }
      return out;
    }
    if (out?.status !== 200 || method !== 'GET') return out;
    // A libvirt VM can be changed from Whombat (the Manage switch is on both sides in this world).
    if (seg[2] === 'guests' && seg.length === 4 && seg[3]?.startsWith('libvirt:'))
      return { ...out, body: { ...(out.body as object), manageable: true } };
    if (seg.length !== 2) return out;
    if (server === WQ_SERVER) {
      const t = world.details.get('the-falcon');
      return t ? { ...out, body: kvmDetail(out.body as HostServerDetail) } : out;
    }
    if (server === BB) {
      const d = out.body as HostServerDetail;
      const vms = guestsOf(BB).filter((g) => g.platform === 'libvirt');
      return {
        ...out,
        body: {
          ...d,
          workloads: {
            ...d.workloads,
            libvirt: d.workloads?.libvirt?.guests.length ? d.workloads.libvirt : workload(vms),
          },
          libvirt: libvirtOf(BB),
        },
      };
    }
    return out;
  }

  // Unlisted, kvm-lab's VMs are in the world only while one of its own requests is answered, so the fleet's guests,
  // Home and the servers table stay the mock's.
  return (req) => {
    const seg = req.path.split('/').filter(Boolean);
    const lend = !listed && seg[0] === 'servers' && decodeURIComponent(seg[1] ?? '') === WQ_SERVER;
    if (!lend) return handle(req);
    world.guests.set(WQ_SERVER, kvmGuests);
    try {
      return handle(req);
    } finally {
      kvmGuests = world.guests.get(WQ_SERVER) ?? kvmGuests;
      world.guests.delete(WQ_SERVER);
    }
  };
}

/** A backup folder's name: `20261016-020000` (UTC). */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}
