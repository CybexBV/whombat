/**
 * Incus and Unraid in the one-Whombat demo world (incus-unraid-mobile.md AP-1640): thetitan is an Incus host (a home
 * lab's: whombat-dev-box is this Whombat itself, whombat-prod-box, the CI templates and jobs in project
 * ci-platform, a stopped rackoon, Docker beside it) and blackbox an Unraid 7.3.1 server (a disabled
 * parity disk, two data disks, the pools apps, data and storage, Plex and the *arr apps, Immich, the PBS VM, plugin
 * updates, unRAID's notifications, a newer Unraid). The world answers their guests' screens and the servers' pages
 * and takes every change of the build: an Incus instance's settings (with its ETag as digest), snapshots, backups,
 * copy, rename, restore as new, delete; the array, parity, disks, mover, plugins, notifications, containers and
 * autostart. Changes that run as a task (`incus:<uuid>`, `unraid:<16 hex>`) end 2.5 seconds later with their
 * `hosts.task` frame. Guests are the world's own map (`assistant.ts`), so lists and screens agree.
 */
import type {
  HostBackupVolume,
  HostGuest,
  HostGuestConfig,
  HostGuestDetail,
  HostHint,
  HostIncusDetail,
  HostLibvirtDetail,
  HostPlatformWorkload,
  HostRemoteControl,
  HostSeries,
  HostServerDetail,
  HostSnapshot,
  HostTask,
  HostUnraidDetail,
  HostUnraidDisk,
  RealtimeEvent,
} from '@whombat/core';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const TB = 1e12;
const GB = 1e9;
const GIB = 1024 ** 3;

/* Guests ------------------------------------------------------------------------------------------------------------ */

interface Seed {
  name: string;
  project?: string;
  kind: HostGuest['kind'];
  state: HostGuest['state'];
  cpu: number;
  mem: [number, number];
  vcpu: number;
  image: string;
  extra?: Partial<HostGuest>;
}

const BEAST_INCUS: Seed[] = [
  {
    name: 'whombat-dev-box',
    kind: 'vm',
    state: 'running',
    cpu: 8.4,
    mem: [9800, 16384],
    vcpu: 8,
    image: 'images:nixos/25.05',
    extra: { self: true, addresses: ['10.100.1.160'], snapshots: 3 },
  },
  {
    name: 'whombat-prod-box',
    kind: 'vm',
    state: 'running',
    cpu: 3.1,
    mem: [5200, 8192],
    vcpu: 4,
    image: 'images:nixos/25.05',
    extra: { addresses: ['10.100.1.162'], snapshots: 2 },
  },
  {
    name: 'whombat-link',
    kind: 'container',
    state: 'running',
    cpu: 0.1,
    mem: [60, 256],
    vcpu: 1,
    image: 'images:alpine/3.22',
    extra: { addresses: ['10.100.1.120'] },
  },
  {
    name: 'dashboard',
    kind: 'container',
    state: 'running',
    cpu: 0.6,
    mem: [180, 1024],
    vcpu: 2,
    image: 'images:debian/13',
    extra: { addresses: ['10.62.50.14'] },
  },
  {
    name: 'rackoon',
    kind: 'container',
    state: 'stopped',
    cpu: 0,
    mem: [0, 2048],
    vcpu: 2,
    image: 'images:debian/12',
  },
  {
    name: 'ci-template-linux',
    project: 'ci-platform',
    kind: 'vm',
    state: 'stopped',
    cpu: 0,
    mem: [0, 8192],
    vcpu: 4,
    image: 'images:debian/13/cloud',
  },
  {
    name: 'ci-template-android',
    project: 'ci-platform',
    kind: 'vm',
    state: 'stopped',
    cpu: 0,
    mem: [0, 16384],
    vcpu: 8,
    image: 'images:ubuntu/24.04/cloud',
  },
  {
    name: 'ci-job-4d67ee4a',
    project: 'ci-platform',
    kind: 'vm',
    state: 'running',
    cpu: 41.2,
    mem: [6100, 8192],
    vcpu: 4,
    image: 'images:debian/13/cloud',
  },
  {
    name: 'ci-job-397636d1',
    project: 'ci-platform',
    kind: 'vm',
    state: 'running',
    cpu: 22.5,
    mem: [4100, 8192],
    vcpu: 4,
    image: 'images:debian/13/cloud',
  },
];

const BEAST_DOCKER: [string, boolean, number, number][] = [
  ['postgres', true, 2.4, 610],
  ['redis', true, 0.4, 48],
  ['traefik', true, 0.8, 92],
  ['minio', true, 1.1, 340],
  ['loki', true, 0.9, 410],
  ['prometheus', true, 1.6, 720],
  ['grafana', true, 0.5, 160],
  ['code-server', true, 0.2, 380],
  ['ollama', false, 0, 0],
  ['registry', false, 0, 0],
  ['buildkite', false, 0, 0],
];

/** blackbox's containers: running, update, template, autostart, web page port. */
const BOX_DOCKER: [string, boolean, boolean, boolean, boolean, number | null, string][] = [
  ['plex', true, true, true, true, 32400, 'plexinc/pms-docker'],
  ['sonarr', true, false, true, true, 8989, 'lscr.io/linuxserver/sonarr'],
  ['radarr', true, false, true, true, 7878, 'lscr.io/linuxserver/radarr'],
  ['immich', true, true, true, true, 2283, 'ghcr.io/immich-app/immich-server'],
  ['immich-db', true, false, true, true, null, 'tensorchord/pgvecto-rs'],
  ['overseerr', false, false, true, false, 5055, 'lscr.io/linuxserver/overseerr'],
  ['tautulli', false, true, false, false, 8181, 'tautulli/tautulli'],
];

const BOX_ADDRESS = '10.100.1.13';

function base(serverId: string, id: string, name: string, s: Partial<HostGuest>): HostGuest {
  const on = s.state === 'running';
  return {
    id,
    serverId,
    serverOnline: true,
    name,
    platform: 'docker',
    kind: 'container',
    image: '',
    state: 'stopped',
    cpuPct: null,
    memoryUsedMb: null,
    memoryLimitMb: null,
    uptimeS: on ? 6 * 86_400 : 0,
    console: { available: on, protocols: ['shell'] },
    ...s,
  } as HostGuest;
}

export function iuGuests(serverId: string): HostGuest[] | null {
  if (serverId === 'thetitan')
    return [
      ...BEAST_INCUS.map((g) => {
        const on = g.state === 'running';
        const id = g.project ? `incus:${g.project}/${g.name}` : `incus:${g.name}`;
        return base(serverId, id, g.name, {
          platform: 'incus',
          kind: g.kind,
          image: g.image,
          state: g.state,
          vcpu: g.vcpu,
          cpuPct: on ? g.cpu : null,
          memoryUsedMb: on ? g.mem[0] : null,
          memoryLimitMb: g.mem[1],
          project: g.project ?? 'default',
          console: { available: on, protocols: g.kind === 'vm' ? ['vnc', 'serial'] : ['shell'] },
          ...g.extra,
        });
      }),
      ...BEAST_DOCKER.map(([name, on, cpu, mem]) =>
        base(serverId, `docker:${name}`, name, {
          image: `${name}:latest`,
          state: on ? 'running' : 'stopped',
          cpuPct: on ? cpu : null,
          memoryUsedMb: on ? mem : null,
        }),
      ),
    ];
  if (serverId === 'blackbox')
    return [
      ...BOX_DOCKER.map(([name, on, update, template, autostart, port, image]) =>
        base(serverId, `docker:${name}`, name, {
          image,
          state: on ? 'running' : 'stopped',
          cpuPct: on ? (name === 'plex' ? 6.8 : 0.7) : null,
          memoryUsedMb: on ? (name === 'plex' ? 2100 : 320) : null,
          updateAvailable: update,
          template,
          autostart,
          webUi: port ? `http://${BOX_ADDRESS}:${port}${name === 'plex' ? '/web' : ''}` : null,
        }),
      ),
      base(serverId, 'libvirt:pbs', 'pbs', {
        platform: 'libvirt',
        kind: 'vm',
        image: 'Proxmox Backup Server 4.0',
        state: 'running',
        vcpu: 4,
        cpuPct: 2.2,
        memoryUsedMb: 3100,
        memoryLimitMb: 8192,
        autostart: true,
        console: { available: true, protocols: ['vnc'] },
        addresses: ['10.100.1.41'],
      }),
      base(serverId, 'libvirt:win11', 'win11', {
        platform: 'libvirt',
        kind: 'vm',
        image: 'Windows 11',
        state: 'stopped',
        vcpu: 8,
        memoryLimitMb: 16384,
        autostart: false,
        console: { available: false, protocols: ['vnc'] },
      }),
    ];
  // the-falcon: a QEMU/KVM host (IU-13, AP-1646) — three VMs and Docker beside them, 5 of 33 running as mock 4.
  if (serverId === 'the-falcon')
    return [
      base(serverId, 'libvirt:win11-gaming', 'win11-gaming', {
        platform: 'libvirt',
        kind: 'vm',
        image: 'Windows 11',
        state: 'running',
        vcpu: 8,
        cpuPct: 12.4,
        memoryUsedMb: 14100,
        memoryLimitMb: 16384,
        autostart: false,
        console: { available: true, protocols: ['vnc'] },
        addresses: ['192.168.122.31'],
      }),
      base(serverId, 'libvirt:home-router', 'home-router', {
        platform: 'libvirt',
        kind: 'vm',
        image: 'OPNsense 25.7',
        state: 'running',
        vcpu: 2,
        cpuPct: 1.8,
        memoryUsedMb: 1500,
        memoryLimitMb: 2048,
        autostart: true,
        console: { available: true, protocols: ['vnc', 'serial'] },
        addresses: ['10.100.1.1'],
      }),
      base(serverId, 'libvirt:debian-test', 'debian-test', {
        platform: 'libvirt',
        kind: 'vm',
        image: 'Debian 13',
        state: 'stopped',
        vcpu: 2,
        memoryLimitMb: 4096,
        autostart: false,
        console: { available: false, protocols: ['vnc', 'serial'] },
      }),
      ...Array.from({ length: 30 }, (_, i) =>
        base(serverId, `docker:svc-${i + 1}`, `svc-${i + 1}`, {
          image: `svc-${i + 1}:latest`,
          state: i < 3 ? 'running' : 'stopped',
          cpuPct: i < 3 ? 0.4 : null,
          memoryUsedMb: i < 3 ? 120 : null,
        }),
      ),
    ];
  return null;
}

/* libvirt (IU-13) ---------------------------------------------------------------------------------------------------- */

function libvirtOf(serverId: string): HostLibvirtDetail {
  if (serverId === 'blackbox')
    return {
      version: '11.10.0',
      qemu: '9.2.4',
      pools: [],
      networks: [
        {
          name: 'default',
          active: true,
          autostart: true,
          bridge: 'virbr0',
          forward: 'nat',
          ipv4: '192.168.122.1/24',
          dhcp: true,
          usedBy: 0,
        },
      ],
      folders: { domains: '/mnt/user/domains', isos: '/mnt/user/isos' },
      firmware: { uefi: true, secureBoot: true, tpm: true },
      backupsDir: '/mnt/user/domains/.whombat-backups',
    };
  return {
    version: '12.2.0',
    qemu: '10.1.0',
    pools: [
      {
        name: 'default',
        type: 'dir',
        active: true,
        autostart: true,
        path: '/var/lib/libvirt/images',
        usedBytes: 212 * GIB,
        totalBytes: 900 * GIB,
        availBytes: 688 * GIB,
        volumes: 6,
      },
      {
        name: 'vmstore',
        type: 'zfs',
        active: true,
        autostart: true,
        path: 'tank/vms',
        usedBytes: 1740 * GIB,
        totalBytes: 2000 * GIB,
        availBytes: 260 * GIB,
        volumes: 9,
      },
      {
        name: 'isos',
        type: 'dir',
        active: true,
        autostart: true,
        path: '/srv/isos',
        usedBytes: 21 * GIB,
        totalBytes: 900 * GIB,
        availBytes: 879 * GIB,
        volumes: 4,
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
        usedBy: 2,
      },
      {
        name: 'lan',
        active: true,
        autostart: true,
        bridge: 'br0',
        forward: 'bridge',
        ipv4: null,
        dhcp: false,
        usedBy: 1,
      },
    ],
    folders: null,
    firmware: { uefi: true, secureBoot: true, tpm: true },
    backupsDir: '/var/lib/libvirt/images/.whombat-backups',
  };
}

function libvirtConfigOf(g: HostGuest, serverId: string): HostGuestConfig {
  const win = g.image.startsWith('Windows');
  const pool = serverId === 'blackbox' ? '/mnt/user/domains' : 'vmstore';
  const sizeGb = win ? 128 : 32;
  return {
    platform: 'libvirt',
    kind: 'vm',
    digest: `sha-${g.name}-1`,
    running: g.state === 'running',
    values: {
      name: g.name,
      ...(win ? { title: 'Gaming PC' } : {}),
      description: g.name === 'home-router' ? 'The house router. Don’t switch it off during the day.' : '',
      vcpus: String(g.vcpu ?? 2),
      vcpus_max: String(Math.max(g.vcpu ?? 2, win ? 12 : 4)),
      memory_mb: String(g.memoryLimitMb ?? 2048),
      memory_max_mb: String((g.memoryLimitMb ?? 2048) * (win ? 1.5 : 2)),
      autostart: g.autostart ? '1' : '0',
      boot: win ? 'hd,cdrom' : 'hd',
      cpu_mode: 'host-passthrough',
      on_poweroff: 'destroy',
      on_reboot: 'restart',
      on_crash: 'destroy',
      disk0: `source=${serverId === 'blackbox' ? `${pool}/${g.name}/vdisk1.img` : `${pool}/${g.name}.qcow2`},bus=virtio,format=${serverId === 'blackbox' ? 'raw' : 'qcow2'},target=vda,size=${sizeGb * GIB}`,
      cdrom0: win ? 'source=/srv/isos/virtio-win-0.1.266.iso,bus=sata' : 'source=empty,bus=sata',
      net0: `model=virtio,${g.name === 'home-router' ? 'bridge=br0' : 'network=default'},mac=52:54:00:${g.name.length.toString(16).padStart(2, '0')}:a1:0${g.vcpu ?? 2},link=up`,
      machine: 'pc-q35-10.1',
      firmware: win ? 'uefi' : 'bios',
      ...(win ? { secure_boot: '1', tpm: '1' } : {}),
    },
    pending: {},
    pendingDelete: [],
    restricted: ['machine', 'firmware', 'secure_boot', 'tpm'],
    disks: [
      {
        key: 'disk0',
        storage: serverId === 'blackbox' ? 'folder:domains' : pool,
        sizeBytes: sizeGb * GIB,
        media: 'disk',
        boot: true,
      },
    ],
  };
}

const LIBVIRT_ISOS = (serverId: string) =>
  (serverId === 'blackbox'
    ? ['debian-13.1.0-amd64-netinst.iso', 'Win11_25H2_English_x64.iso', 'virtio-win-0.1.266.iso']
    : [
        'debian-13.1.0-amd64-netinst.iso',
        'ubuntu-24.04.3-live-server-amd64.iso',
        'virtio-win-0.1.266.iso',
        'OPNsense-25.7-dvd-amd64.iso',
      ]
  ).map((name, i) => ({
    volid: serverId === 'blackbox' ? `/mnt/user/isos/${name}` : `/srv/isos/${name}`,
    name,
    sizeBytes: (i + 1) * 700 * 1024 ** 2,
  }));

/** A server's guest counts by platform, for its fleet row. */
export function iuGuestCounts(
  list: readonly HostGuest[],
): { platform: HostGuest['platform']; running: number; total: number }[] {
  const out = new Map<
    HostGuest['platform'],
    { platform: HostGuest['platform']; running: number; total: number }
  >();
  for (const g of list) {
    const c = out.get(g.platform) ?? { platform: g.platform, running: 0, total: 0 };
    c.total += 1;
    if (g.state === 'running') c.running += 1;
    out.set(g.platform, c);
  }
  return [...out.values()];
}

/* The Unraid server ------------------------------------------------------------------------------------------------- */

const udisk = (over: Partial<HostUnraidDisk> & Pick<HostUnraidDisk, 'name' | 'slot'>): HostUnraidDisk => ({
  device: null,
  model: null,
  serial: null,
  status: 'ok',
  statusRaw: 'DISK_OK',
  sizeBytes: 0,
  usedBytes: null,
  freeBytes: null,
  fsType: null,
  tempC: null,
  spunDown: false,
  errors: 0,
  rotational: true,
  ...over,
});

function unraidOf(now: number): HostUnraidDetail {
  const nvme = (name: string, device: string) =>
    udisk({
      name,
      slot: 'pool',
      device,
      model: 'Samsung SSD 990 PRO 1TB',
      serial: `S7DN${device.slice(-3).toUpperCase()}`,
      sizeBytes: 1 * TB,
      fsType: 'zfs',
      tempC: 41,
      rotational: false,
    });
  const hdd = (name: string, device: string, over: Partial<HostUnraidDisk> = {}) =>
    udisk({
      name,
      slot: 'pool',
      device,
      model: 'WDC WD40EFPX',
      serial: `WD-${device.toUpperCase()}`,
      sizeBytes: 4 * TB,
      fsType: 'zfs',
      tempC: 35,
      ...over,
    });
  return {
    version: '7.3.1',
    name: 'BlackBox',
    license: 'Pro',
    osUpdate: { version: '7.3.2' },
    array: {
      state: 'started',
      stateRaw: 'STARTED',
      startOnBoot: true,
      sizeBytes: 24 * TB,
      usedBytes: 13 * TB,
      freeBytes: 11 * TB,
      disabled: 1,
      invalid: 0,
      missing: 0,
      moverRunning: false,
      parity: {
        state: 'idle',
        action: null,
        pct: null,
        speedMbs: null,
        etaS: null,
        errors: 0,
        last: {
          at: new Date(now - 41 * D).toISOString(),
          durationS: 33_120,
          speedMbs: 182.4,
          errors: 0,
          result: 'ok',
          action: 'check',
        },
        history: [
          {
            at: new Date(now - 41 * D).toISOString(),
            durationS: 33_120,
            speedMbs: 182.4,
            errors: 0,
            result: 'ok',
            action: 'check',
          },
          {
            at: new Date(now - 71 * D).toISOString(),
            durationS: 34_010,
            speedMbs: 177.6,
            errors: 3,
            result: 'errors',
            action: 'check',
          },
          {
            at: new Date(now - 102 * D).toISOString(),
            durationS: 6_300,
            speedMbs: 168,
            errors: 0,
            result: 'cancelled',
            action: 'check',
          },
        ],
        schedule: 'Monthly, day 1 at 00:30, no corrections',
      },
      disks: [
        udisk({
          name: 'parity',
          slot: 'parity',
          device: 'sdc',
          model: 'WDC WD161KFGX',
          serial: 'WD-2CJ8VW1N',
          status: 'disabled',
          statusRaw: 'DISK_DSBL',
          sizeBytes: 16 * TB,
          tempC: 38,
          errors: 128,
        }),
        udisk({
          name: 'disk1',
          slot: 'data',
          device: 'sdb',
          model: 'WDC WD161KFGX',
          serial: 'WD-2CJ7TQZN',
          sizeBytes: 16 * TB,
          usedBytes: 9.8 * TB,
          freeBytes: 6.2 * TB,
          fsType: 'xfs',
          tempC: 36,
        }),
        udisk({
          name: 'disk2',
          slot: 'data',
          device: 'sdd',
          model: 'Seagate ST8000VN004',
          serial: 'ZA1F7K2M',
          sizeBytes: 8 * TB,
          usedBytes: 3.2 * TB,
          freeBytes: 4.8 * TB,
          fsType: 'xfs',
          spunDown: true,
        }),
      ],
    },
    pools: [
      {
        name: 'apps',
        fsType: 'zfs',
        profile: 'mirror',
        sizeBytes: 1 * TB,
        usedBytes: 412 * GB,
        freeBytes: 588 * GB,
        disks: [nvme('apps', 'nvme0n1'), nvme('apps2', 'nvme1n1')],
      },
      {
        name: 'data',
        fsType: 'zfs',
        profile: 'raidz1',
        sizeBytes: 8 * TB,
        usedBytes: 4.1 * TB,
        freeBytes: 3.9 * TB,
        disks: [
          hdd('data', 'sde'),
          hdd('data2', 'sdf'),
          hdd('data3', 'sdg', { spunDown: true, tempC: null }),
        ],
      },
      {
        name: 'storage',
        fsType: 'zfs',
        profile: 'single',
        sizeBytes: 8 * TB,
        usedBytes: 7.3 * TB,
        freeBytes: 0.7 * TB,
        disks: [hdd('storage', 'sdh', { model: 'Seagate ST8000VN004', sizeBytes: 8 * TB, tempC: 39 })],
      },
    ],
    flash: udisk({
      name: 'flash',
      slot: 'flash',
      device: 'sda',
      model: 'SanDisk Cruzer Fit',
      sizeBytes: 32 * GB,
      usedBytes: 1.2 * GB,
      freeBytes: 30.8 * GB,
      fsType: 'vfat',
      rotational: false,
    }),
    shares: [
      ['appdata', 'Containers’ settings', 'apps', null, null],
      ['media', 'Films and series', 'array', 'data', 'to_array'],
      ['photos', 'Immich library', 'data', null, null],
      ['isos', '', 'storage', null, null],
      ['system', 'Docker and VM images', 'apps', null, null],
    ].map(([name, comment, primary, secondary, moverAction]) => ({
      name: name as string,
      comment: comment as string,
      usedBytes: 100 * GB,
      freeBytes: 2 * TB,
      primary: primary as string,
      secondary: secondary as string | null,
      moverAction: moverAction as 'to_array' | null,
      smb: name === 'system' ? null : 'private',
      nfs: false,
      encrypted: false,
    })),
    plugins: [
      ['Unassigned Devices', 'unassigned.devices.plg', '2026.09.01', '2026.10.15', 'dlandon'],
      ['Community Applications', 'community.applications.plg', '2026.10.01', '2026.10.12', 'Squid'],
      ['Dynamix System Temperature', 'dynamix.system.temp.plg', '2026.02.27', null, 'Bergware'],
      ['Fix Common Problems', 'fix.common.problems.plg', '2026.09.20', null, 'Squid'],
      ['Unraid Connect', 'dynamix.unraid.net.plg', '2026.10.02', null, 'Lime Technology'],
    ].map(([name, file, version, update, author]) => ({
      name: name as string,
      file: file as string,
      version: version as string,
      update: update as string | null,
      author: author as string,
      supportUrl: null,
    })),
    notifications: [
      {
        id: 'notify-1760702400-array',
        at: new Date(now - 13 * M).toISOString(),
        importance: 'alert',
        event: 'Unraid Parity disk error',
        subject: 'Parity disk is disabled',
        description: 'WDC_WD161KFGX (sdc) was disabled after 128 write errors.',
      },
      {
        id: 'notify-1760688000-temp',
        at: new Date(now - 4 * H).toISOString(),
        importance: 'warning',
        event: 'Unraid Disk 1 temperature',
        subject: 'Disk 1 is warm: 46 °C',
        description: 'It cooled down again after the mover ran.',
      },
      {
        id: 'notify-1760659200-plugins',
        at: new Date(now - 12 * H).toISOString(),
        importance: 'normal',
        event: 'Plugin updates',
        subject: '2 plugin updates are ready',
        description: 'Unassigned Devices and Community Applications.',
      },
    ],
    docker: { enabled: true, imageUsedPct: 62 },
    vms: { enabled: true },
  };
}

/* The Incus server -------------------------------------------------------------------------------------------------- */

function incusOf(guests: readonly HostGuest[], now: number): HostIncusDetail {
  const incus = guests.filter((g) => g.platform === 'incus');
  const project = (name: string) => incus.filter((g) => (g.project ?? 'default') === name);
  return {
    version: '6.0.4',
    clustered: false,
    projects: ['default', 'ci-platform'].map((name) => ({
      name,
      description: name === 'default' ? 'Default Incus project' : 'CI templates and jobs',
      instances: project(name).length,
      running: project(name).filter((g) => g.state === 'running').length,
    })),
    pools: [
      {
        name: 'default',
        driver: 'zfs',
        status: 'Created',
        description: '',
        usedBytes: 84.2 * GIB,
        totalBytes: 1.45 * 1024 * GIB,
        volumes: 17,
      },
      {
        name: 'ci-nvme',
        driver: 'zfs',
        status: 'Created',
        description: 'CI jobs',
        usedBytes: 880 * GIB,
        totalBytes: 1000 * GIB,
        volumes: 19,
      },
      {
        name: 'demo',
        driver: 'zfs',
        status: 'Created',
        description: '',
        usedBytes: 12 * GIB,
        totalBytes: 200 * GIB,
        volumes: 3,
      },
    ],
    networks: [
      {
        name: 'incusbr0',
        type: 'bridge',
        managed: true,
        description: '',
        ipv4: '10.62.50.1/24',
        ipv6: null,
        nat: true,
        usedBy: 4,
      },
      {
        name: 'arnicabr0',
        type: 'bridge',
        managed: true,
        description: '',
        ipv4: '10.62.56.1/24',
        ipv6: null,
        nat: true,
        usedBy: 1,
      },
      {
        name: 'eno1',
        type: 'physical',
        managed: false,
        description: '',
        ipv4: null,
        ipv6: null,
        nat: null,
        usedBy: 0,
      },
    ],
    profiles: [
      { name: 'default', project: 'default', description: 'Default profile', usedBy: 4 },
      { name: 'demo-workstation', project: 'default', description: '', usedBy: 0 },
      { name: 'ci', project: 'ci-platform', description: 'CI runners', usedBy: 4 },
    ],
    images: [
      {
        fingerprint: '177431cccc4463e21d5951d3681a0dbc54bb82c97c2b0a25a41c47d32f2c094a',
        aliases: ['debian/13'],
        description: 'Debian trixie amd64',
        type: 'container',
        architecture: 'x86_64',
        sizeBytes: 98 * 1024 ** 2,
        uploadedAt: new Date(now - 9 * D).toISOString(),
        lastUsedAt: new Date(now - 2 * D).toISOString(),
        autoUpdate: true,
        cached: true,
        project: 'default',
      },
      {
        fingerprint: '1950711f78839b17f3c52dd493b8853a86a1b242aba0e0a1feaf5e0a75edb8cd',
        aliases: ['nixos/25.05'],
        description: 'NixOS 25.05 amd64 (VM)',
        type: 'virtual-machine',
        architecture: 'x86_64',
        sizeBytes: 640 * 1024 ** 2,
        uploadedAt: new Date(now - 30 * D).toISOString(),
        lastUsedAt: new Date(now - 20 * D).toISOString(),
        autoUpdate: true,
        cached: false,
        project: 'default',
      },
    ],
    volumes: [
      {
        pool: 'default',
        name: 'dashboard-data',
        project: 'default',
        type: 'custom',
        contentType: 'filesystem',
        sizeBytes: 10 * GIB,
        usedBytes: 2.1 * GIB,
        usedBy: ['incus:dashboard'],
        description: 'Dashboard data',
      },
    ],
  };
}

/* Configurations, snapshots, backups, tasks -------------------------------------------------------------------------- */

function configOf(g: HostGuest): HostGuestConfig {
  const mib = g.memoryLimitMb ?? 1024;
  const ci = g.project === 'ci-platform';
  const values: Record<string, string> = {
    'limits.memory': mib % 1024 === 0 ? `${mib / 1024}GiB` : `${mib}MiB`,
    'limits.cpu': String(g.vcpu ?? 2),
    'device.root': `type=disk,pool=${ci ? 'ci-nvme' : 'default'},path=/,size=${g.kind === 'vm' ? 64 : 20}GiB`,
    'device.eth0': `type=nic,network=incusbr0,name=eth0`,
  };
  if (!ci) values['boot.autostart'] = g.name === 'rackoon' ? 'false' : 'true';
  if (g.name.startsWith('whombat-')) values['security.protection.delete'] = 'true';
  if (g.name === 'whombat-prod-box') {
    values['snapshots.schedule'] = '0 3 * * *';
    values['snapshots.expiry'] = '1w';
  }
  if (g.name === 'whombat-dev-box') {
    values['snapshots.schedule'] = '@daily';
    values['snapshots.expiry'] = '2w';
  }
  if (g.name === 'rackoon') values['security.privileged'] = 'true';
  if (g.kind === 'container') values['security.nesting'] = g.name === 'dashboard' ? 'true' : 'false';
  values.description =
    g.name === 'whombat-dev-box'
      ? 'The DEV Whombat.'
      : g.name === 'whombat-prod-box'
        ? 'Production Whombat, second copy.'
        : g.name === 'whombat-link'
          ? 'Links The Titan to its own Whombat.'
          : '';
  return {
    platform: 'incus',
    kind: g.kind,
    digest: `etag-${g.name}-1`,
    running: g.state === 'running',
    values,
    pending: {},
    pendingDelete: [],
    restricted: ['security.privileged'],
    inherited: ['device.eth0'],
    profiles: ci ? ['default', 'ci'] : ['default'],
    disks: [
      {
        key: 'root',
        storage: ci ? 'ci-nvme' : 'default',
        sizeBytes: (g.kind === 'vm' ? 64 : 20) * GIB,
        path: '/',
        boot: true,
      },
    ],
  };
}

function seriesOf(serverId: string, g: HostGuest, now: number): HostSeries {
  const n = 48;
  const ts = Array.from({ length: n }, (_, i) => new Date(now - (n - 1 - i) * 1800_000).toISOString());
  const base0 = g.cpuPct ?? 1;
  const mem = g.memoryUsedMb ?? 256;
  return {
    serverId,
    guestId: g.id,
    range: '24h',
    stepSeconds: 1800,
    asOf: new Date(now).toISOString(),
    timestamps: ts,
    series: {
      cpu_pct: ts.map((_, i) => Math.max(0.1, +(base0 + Math.sin(i / 4) * base0 * 0.3).toFixed(1))),
      mem_mb: ts.map((_, i) => Math.round(mem * (0.92 + 0.08 * Math.sin(i / 6)))),
    },
  } as HostSeries;
}

const ALL_ON: HostRemoteControl = {
  console: true,
  power: true,
  manage: true,
  hostShell: true,
  hostPower: true,
  diagnose: true,
};

/* The module ---------------------------------------------------------------------------------------------------------- */

export interface IuDeps {
  now: () => Date;
  emit: (topic: string, event: RealtimeEvent) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  hostsTopic: string;
  guests: Map<string, HostGuest[]>;
  json: (body: unknown, status?: number) => Response;
  notFound: (text: string) => Response;
  bodyOf: <T>(init: RequestInit | undefined) => Promise<T>;
}

const IU_SERVERS = new Set(['thetitan', 'blackbox', 'the-falcon']);

export function createIuFixtures(deps: IuDeps) {
  const { now, emit, setTimer, hostsTopic, json, notFound, bodyOf } = deps;
  const t0 = () => now().getTime();
  const unraid = unraidOf(t0());
  const configs = new Map<string, HostGuestConfig>();
  const snapshots = new Map<string, HostSnapshot[]>();
  let backups: HostBackupVolume[] = [];
  const tasks = new Map<string, HostTask & { cancellable?: boolean }>();
  let seq = 0;
  const hex = () => (++seq).toString(16).padStart(16, '0').slice(-16);

  const list = (serverId: string) => deps.guests.get(serverId) ?? [];
  const find = (serverId: string, guestId: string) => list(serverId).find((g) => g.id === guestId);
  const replace = (serverId: string, guestId: string, next: (g: HostGuest) => HostGuest | null) => {
    const l = list(serverId);
    const i = l.findIndex((g) => g.id === guestId);
    if (i < 0) return;
    const out = next(l[i] as HostGuest);
    if (out) l[i] = out;
    else l.splice(i, 1);
  };
  const configFor = (g: HostGuest) => {
    const c = configs.get(g.id) ?? configOf(g);
    configs.set(g.id, c);
    return c;
  };
  const snapsFor = (g: HostGuest): HostSnapshot[] => {
    const s =
      snapshots.get(g.id) ??
      (g.name === 'whombat-dev-box' || g.name === 'whombat-prod-box'
        ? [0, 1].map((d) => ({
            name: `snap-${new Date(t0() - (d + 1) * D).toISOString().slice(0, 10)}`,
            created: new Date(t0() - (d + 1) * D + 3 * H).toISOString(),
            description: '',
          }))
        : g.name === 'rackoon'
          ? [{ name: 'before-retire', created: new Date(t0() - 12 * D).toISOString(), description: '' }]
          : g.name === 'win11-gaming'
            ? [
                {
                  name: 'before-25h2',
                  created: new Date(t0() - 20 * D).toISOString(),
                  description: 'Before the 25H2 update',
                },
              ]
            : []);
    snapshots.set(g.id, s);
    return s;
  };

  // Backups: prod-2 every night, dev-box once; dashboard none (its “no snapshot schedule” hint).
  for (const [name, days] of [
    ['whombat-prod-box', [0, 3]],
    ['whombat-dev-box', [5]],
  ] as const)
    for (const d of days) {
      const at = new Date(t0() - d * D - 12 * H);
      const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      backups.push({
        volume: `whombat-${stamp}`,
        storage: 'incus',
        guest: `incus:${name}`,
        kind: 'vm',
        sizeBytes: (name === 'whombat-prod-box' ? 6.4 : 11.8) * GIB,
        created: at.toISOString(),
        format: 'optimized',
        expiresAt: new Date(at.getTime() + 7 * D).toISOString(),
      });
    }

  // libvirt VMs' backups (`storage: libvirt`): the gaming PC twice; the router none (its hint).
  let libvirtBackups: HostBackupVolume[] = [
    ...[1, 8].map((d) => ({
      volume: new Date(t0() - d * D - 10 * H)
        .toISOString()
        .slice(0, 19)
        .replace(/[-:T]/g, '')
        .replace(/^(\d{8})/, '$1-'),
      storage: 'libvirt',
      guest: 'libvirt:win11-gaming',
      kind: 'vm' as const,
      sizeBytes: 61.2 * GIB,
      created: new Date(t0() - d * D - 10 * H).toISOString(),
    })),
    {
      volume: new Date(t0() - 3 * D)
        .toISOString()
        .slice(0, 19)
        .replace(/[-:T]/g, '')
        .replace(/^(\d{8})/, '$1-'),
      storage: 'libvirt',
      guest: 'libvirt:pbs',
      kind: 'vm' as const,
      sizeBytes: 9.4 * GIB,
      created: new Date(t0() - 3 * D).toISOString(),
    },
  ];

  // Past Incus operations, and one a CI job is running that can be cancelled.
  const pastOps = (g: HostGuest): HostTask[] => [
    {
      id: `incus:op-${g.name}-snap`,
      type: 'Snapshotting instance',
      platform: 'incus',
      guestId: g.id,
      started: new Date(t0() - 21 * H).toISOString(),
      ended: new Date(t0() - 21 * H + 4000).toISOString(),
      status: 'ok',
    },
    {
      id: `incus:op-${g.name}-start`,
      type: 'Starting instance',
      platform: 'incus',
      guestId: g.id,
      started: new Date(t0() - 30 * H).toISOString(),
      ended: new Date(t0() - 30 * H + 9000).toISOString(),
      status: 'ok',
    },
  ];
  tasks.set('incus:7b1f3c2e-export', {
    id: 'incus:7b1f3c2e-export',
    type: 'Exporting backup',
    platform: 'incus',
    guestId: 'incus:ci-platform/ci-job-4d67ee4a',
    started: new Date(t0() - 3 * M).toISOString(),
    status: 'running',
    message: '42 % (180 MB/s)',
    cancellable: true,
  });

  /** A change that runs as a task: running now, done 2.5 s later with its `hosts.task` frame. */
  function startTask(
    serverId: string,
    op: string,
    guestId: string | null,
    platform: 'incus' | 'unraid' | 'libvirt',
    then?: () => void,
  ): string {
    const id =
      platform === 'incus' ? `incus:${hex().slice(0, 8)}-${hex().slice(-4)}-${op}` : `${platform}:${hex()}`;
    tasks.set(id, {
      id,
      type: op,
      platform,
      guestId,
      started: new Date(t0()).toISOString(),
      status: 'running',
      log: platform === 'unraid' ? [`${op}: started`] : [],
    });
    setTimer(() => {
      then?.();
      const t = tasks.get(id);
      if (t)
        tasks.set(id, {
          ...t,
          status: 'ok',
          ended: new Date(t0() + 2500).toISOString(),
          log: [...(t.log ?? []), ...(platform === 'unraid' ? ['Done.'] : [])],
        });
      emit(hostsTopic, { type: 'hosts.task', serverId, guestId, taskId: id, op, result: 'ok' });
    }, 2500);
    return id;
  }

  const refusal = (status: number, code: string, message: string) =>
    json(
      { error: { code: status === 409 ? 'conflict' : 'bad_request', message, details: { code } } },
      status,
    );

  const extraHints = (serverId: string): HostHint[] =>
    serverId === 'thetitan'
      ? [
          {
            serverId,
            kind: 'incus.pool_full',
            severity: 'warning',
            entity: 'ci-nvme',
            title: 'Storage “ci-nvme” 88% full',
            detail: 'CI jobs fail when it fills up. Remove old images or grow the pool on the web.',
            section: 'storage',
          },
          ...(find(serverId, 'incus:dashboard')
            ? [
                {
                  serverId,
                  kind: 'incus.no_snapshots',
                  severity: 'info' as const,
                  entity: 'incus:dashboard',
                  title: '1 machine isn’t backed up',
                  detail: 'dashboard · no scheduled snapshots, no backup in 30 days',
                  section: 'guests',
                },
              ]
            : []),
        ]
      : serverId === 'blackbox'
        ? [
            {
              serverId,
              kind: 'unraid.parity_old',
              severity: 'warning',
              entity: 'parity',
              title: 'Parity not checked lately',
              detail: 'A check finds disk problems before they cost you files.',
              section: 'array',
            },
            ...(unraid.pools.some((p) => p.usedBytes / p.sizeBytes >= 0.9)
              ? [
                  {
                    serverId,
                    kind: 'unraid.pool_full',
                    severity: 'warning' as const,
                    entity: 'storage',
                    title: 'Storage “storage” 91% full',
                    detail: 'Move or delete files before it fills up.',
                    section: 'array',
                  },
                ]
              : []),
            ...(unraid.notifications.some((n) => n.id === 'notify-1760688000-temp')
              ? [
                  {
                    serverId,
                    kind: 'unraid.notification',
                    severity: 'info' as const,
                    entity: 'notify-1760688000-temp',
                    title: 'Disk 1 is warm: 46 °C',
                    detail: 'It cooled down again after the mover ran.',
                    section: 'summary',
                  },
                ]
              : []),
            ...(unraid.plugins.some((p) => p.update)
              ? [
                  {
                    serverId,
                    kind: 'unraid.plugin_updates',
                    severity: 'info' as const,
                    entity: 'plugins',
                    title: `${unraid.plugins.filter((p) => p.update).length} plugin updates`,
                    detail: 'Unassigned Devices and Community Applications have new versions.',
                    section: 'plugins',
                  },
                ]
              : []),
            ...(unraid.osUpdate
              ? [
                  {
                    serverId,
                    kind: 'unraid.os_update',
                    severity: 'info' as const,
                    entity: 'os',
                    title: `Unraid ${unraid.osUpdate.version} has come out`,
                    detail: 'It needs a restart, so update it in Unraid when it suits you.',
                    section: 'plugins',
                  },
                ]
              : []),
            ...(find(serverId, 'docker:plex')?.updateAvailable
              ? [
                  {
                    serverId,
                    kind: 'docker.update_available',
                    severity: 'info' as const,
                    entity: 'docker:plex',
                    title: '1 app has an update',
                    detail: 'plex',
                    section: 'guests',
                  },
                ]
              : []),
          ]
        : [];

  const workload = (guests: readonly HostGuest[]): HostPlatformWorkload => ({
    running: guests.filter((g) => g.state === 'running').length,
    total: guests.length,
    cpuPct: null,
    memoryGb: null,
    guests: [...guests],
  });

  /** What a server's page adds for Incus or Unraid (its kind, this Whombat, the detail, hints, workloads). */
  function detailExtras(serverId: string): Partial<HostServerDetail> & { hostsThisWhombat?: boolean } {
    const l = list(serverId);
    const of = (p: HostGuest['platform']) => l.filter((g) => g.platform === p);
    if (serverId === 'thetitan')
      return {
        incus: incusOf(l, t0()),
        workloads: { incus: workload(of('incus')), docker: workload(of('docker')) },
        hints: extraHints(serverId),
        hostsThisWhombat: l.some((g) => g.self),
      };
    if (serverId === 'blackbox') {
      unraid.docker.enabled = true;
      return {
        unraid,
        libvirt: libvirtOf(serverId),
        workloads: { docker: workload(of('docker')), libvirt: workload(of('libvirt')) },
        hints: extraHints(serverId),
      };
    }
    if (serverId === 'the-falcon')
      return {
        libvirt: libvirtOf(serverId),
        workloads: { libvirt: workload(of('libvirt')), docker: workload(of('docker')) },
        hints: [
          {
            serverId,
            kind: 'libvirt.pool_full',
            severity: 'warning',
            entity: 'vmstore',
            title: 'Storage “vmstore” 87% full',
            detail: 'New disks and backups need room. Free some space or grow the pool.',
            section: 'storage',
          },
          ...(libvirtBackups.some((b) => b.guest === 'libvirt:home-router')
            ? []
            : [
                {
                  serverId,
                  kind: 'libvirt.no_backup',
                  severity: 'info' as const,
                  entity: 'home-router',
                  title: 'home-router has no recent backup',
                  detail: 'No backup or snapshot in 30 days.',
                  section: 'guests',
                },
              ]),
        ],
      };
    return {};
  }

  function guestDetail(g: HostGuest): HostGuestDetail {
    return { ...g, remoteControl: ALL_ON, manageable: g.platform === 'incus' || g.platform === 'libvirt' };
  }

  const libvirtConfigFor = (serverId: string, g: HostGuest) => {
    const c = configs.get(g.id) ?? libvirtConfigOf(g, serverId);
    configs.set(g.id, c);
    return c;
  };

  async function handle(
    id: string,
    params: Record<string, string>,
    init: RequestInit | undefined,
    url: URL,
  ): Promise<Response | null> {
    const serverId = params.serverId ?? '';
    if (!IU_SERVERS.has(serverId)) return null;
    switch (id) {
      case 'hosts.getGuest': {
        const g = find(serverId, params.guestId ?? '');
        return g ? json(guestDetail(g)) : notFound(`No guest ${params.guestId}`);
      }
      case 'hosts.guestMetrics': {
        const g = find(serverId, params.guestId ?? '');
        return g ? json(seriesOf(serverId, g, t0())) : notFound(`No guest ${params.guestId}`);
      }
      case 'hosts.getTask': {
        const t = tasks.get(params.taskId ?? '');
        return t ? json(t) : notFound('No such task');
      }
      case 'hosts.guestAction': {
        const g = find(serverId, params.guestId ?? '');
        if (!g) return null;
        const body = await bodyOf<{ action: string; snapshot?: string; description?: string }>(init);
        if (!body.action.startsWith('snapshot_')) return null;
        if (g.self && body.action === 'snapshot_restore')
          return refusal(409, 'self_guest', 'That’s this Whombat itself.');
        const s = snapsFor(g);
        const name = body.snapshot ?? `snap-${++seq}`;
        if (body.action === 'snapshot_create')
          snapshots.set(g.id, [
            ...s,
            { name, created: new Date(t0()).toISOString(), description: body.description ?? '' },
          ]);
        else if (body.action === 'snapshot_delete')
          snapshots.set(
            g.id,
            s.filter((x) => x.name !== name),
          );
        const actionId = `act_${g.name}_${++seq}`;
        setTimer(
          () =>
            emit(hostsTopic, {
              type: 'hosts.task',
              serverId,
              guestId: g.id,
              actionId,
              op: body.action,
              result: 'ok',
            }),
          1500,
        );
        return json({ actionId }, 202);
      }
      case 'hosts.manageRead': {
        const op = url.searchParams.get('op');
        const guestId = url.searchParams.get('guestId');
        const g = guestId ? find(serverId, guestId) : undefined;
        if (guestId && !g) return notFound(`No guest ${guestId}`);
        switch (op) {
          case 'config.get':
            return g?.platform === 'incus'
              ? json({ op, config: configFor(g) })
              : g?.platform === 'libvirt'
                ? json({ op, config: libvirtConfigFor(serverId, g) })
                : null;
          case 'choices':
            if (url.searchParams.get('platform') === 'libvirt') {
              const lv = libvirtOf(serverId);
              return json({
                op,
                choices: {
                  platform: 'libvirt',
                  storages: lv.pools.length
                    ? lv.pools
                        .filter((x) => x.name !== 'isos')
                        .map((x) => ({
                          id: x.name,
                          type: x.type,
                          content: ['images'],
                          availBytes: x.availBytes,
                          totalBytes: x.totalBytes,
                        }))
                    : [{ id: 'folder:domains', type: 'dir', content: ['images'] }],
                  bridges: serverId === 'blackbox' ? ['br0'] : ['br0', 'virbr0'],
                  networks: lv.networks.map((n) => n.name),
                  isos: LIBVIRT_ISOS(serverId),
                },
              });
            }
            return json({
              op,
              choices: {
                platform: 'incus',
                storages: incusOf(list(serverId), t0()).pools.map((p) => ({
                  id: p.name,
                  type: p.driver,
                  content: ['images', 'rootdir'],
                  ...(p.totalBytes != null && p.usedBytes != null
                    ? { availBytes: p.totalBytes - p.usedBytes, totalBytes: p.totalBytes }
                    : {}),
                })),
                bridges: ['incusbr0', 'arnicabr0'],
                profiles: ['default', 'demo-workstation'],
                projects: ['default', 'ci-platform'],
              },
            });
          case 'snapshot.list':
            return g ? json({ op, items: snapsFor(g) }) : null;
          case 'backup.list': {
            const all =
              url.searchParams.get('platform') === 'libvirt' || g?.platform === 'libvirt'
                ? libvirtBackups.filter((b) => list(serverId).some((x) => x.id === b.guest))
                : backups;
            return json({ op, items: g ? all.filter((b) => b.guest === g.id) : all });
          }
          case 'task.list': {
            const own = [...tasks.values()].filter((t) => (g ? t.guestId === g.id : true));
            return json({ op, items: g ? [...own, ...pastOps(g)] : own });
          }
          default:
            return null;
        }
      }
      case 'hosts.manage':
        return manage(serverId, await bodyOf<ManageBody>(init));
      default:
        return null;
    }
  }

  interface ManageBody {
    op: string;
    guestId?: string;
    platform?: string;
    params?: Record<string, unknown>;
    digest?: string;
    confirm?: boolean;
    confirmName?: string;
  }

  function manage(serverId: string, body: ManageBody): Response {
    const g = body.guestId ? find(serverId, body.guestId) : undefined;
    const p = body.params ?? {};
    const task = (op: string, platform: 'incus' | 'unraid' | 'libvirt', then?: () => void) =>
      json({ ok: true, task: { id: startTask(serverId, op, g?.id ?? null, platform, then) } }, 202);
    if (body.platform === 'libvirt' || (g?.platform === 'libvirt' && body.op !== 'guest.autostart'))
      return manageLibvirt(serverId, body, g, task);
    const selfRefused = new Set(['config.set', 'guest.rename', 'guest.delete', 'guest.autostart']);
    if (g?.self && selfRefused.has(body.op)) return refusal(409, 'self_guest', 'That’s this Whombat itself.');
    switch (body.op) {
      /* Incus */
      case 'config.set': {
        if (!g) return notFound('No such guest');
        const cfg = configFor(g);
        if (body.digest && body.digest !== cfg.digest)
          return refusal(409, 'digest_mismatch', 'Changed meanwhile — review again.');
        const set = (p.set ?? {}) as Record<string, string>;
        const values = { ...cfg.values };
        const changes = Object.entries(set).map(([k, v]) => {
          const old = values[k];
          if (v === '') delete values[k];
          else values[k] = v;
          return { key: k, ...(old !== undefined ? { old } : {}), ...(v !== '' ? { new: v } : {}) };
        });
        configs.set(g.id, { ...cfg, values, digest: `${cfg.digest}+` });
        const mem = values['limits.memory'];
        if (set['limits.memory'] !== undefined)
          replace(serverId, g.id, (x) => ({
            ...x,
            memoryLimitMb: mem
              ? Math.round(Number.parseFloat(mem) * (mem.endsWith('GiB') ? 1024 : 1) || 0)
              : null,
          }));
        if (set['limits.cpu'] !== undefined)
          replace(serverId, g.id, (x) => ({
            ...x,
            vcpu: values['limits.cpu'] ? Number(values['limits.cpu']) : null,
          }));
        return json({ ok: true, changes });
      }
      case 'backup.create': {
        if (!g) return notFound('No such guest');
        const name = String(p.name ?? `whombat-${hex().slice(-8)}`);
        return task('backup.create', 'incus', () => {
          backups = [
            ...backups,
            {
              volume: name,
              storage: 'incus',
              guest: g.id,
              kind: g.kind,
              sizeBytes: (g.memoryLimitMb ?? 1024) * 1024 * 1024 * 0.8,
              created: new Date(t0() + 2500).toISOString(),
              format: p.optimized ? 'optimized' : 'tar',
              expiresAt: typeof p.expiresAt === 'string' ? p.expiresAt : new Date(t0() + 7 * D).toISOString(),
            },
          ];
        });
      }
      case 'backup.delete':
        backups = backups.filter((b) => !(b.volume === p.volume && b.guest === p.guest));
        return task('backup.delete', 'incus');
      case 'backup.restore': {
        const src = typeof p.guest === 'string' ? find(serverId, p.guest) : undefined;
        if (!src) return notFound('No such guest');
        const name = String(p.name ?? `${src.name}-restored`);
        if (list(serverId).some((x) => x.name === name))
          return refusal(409, 'exists', `There’s already a guest called ${name}.`);
        return task('backup.restore', 'incus', () => {
          list(serverId).push(copyOf(src, name, !!p.start));
        });
      }
      case 'guest.clone': {
        if (!g) return notFound('No such guest');
        const name = String(p.name ?? `${g.name}-copy`);
        if (list(serverId).some((x) => x.name === name))
          return refusal(409, 'exists', `There’s already a guest called ${name}.`);
        return task('guest.clone', 'incus', () => {
          list(serverId).push(copyOf(g, name, false));
        });
      }
      case 'guest.rename': {
        if (!g) return notFound('No such guest');
        if (g.state !== 'stopped') return refusal(409, 'guest_running', `Shut ${g.name} down first.`);
        const name = String(p.name ?? '');
        const newId = g.id.replace(/[^/:]+$/, name);
        const cfg = configs.get(g.id);
        if (cfg) configs.set(newId, cfg);
        replace(serverId, g.id, (x) => ({ ...x, id: newId, name }));
        return json(
          { ok: true, newId, task: { id: startTask(serverId, 'guest.rename', newId, 'incus') } },
          202,
        );
      }
      case 'guest.delete': {
        if (!g) return notFound('No such guest');
        if (g.state !== 'stopped') return refusal(409, 'guest_running', `Shut ${g.name} down first.`);
        if (body.confirmName !== g.name) return refusal(400, 'confirm_name', 'Type its name to confirm.');
        return task('guest.delete', 'incus', () => {
          replace(serverId, g.id, () => null);
          backups = backups.filter((b) => b.guest !== g.id);
        });
      }
      case 'task.stop': {
        const t = tasks.get(String(p.task ?? ''));
        if (!t) return notFound('No such task');
        tasks.set(t.id, {
          ...t,
          status: 'error',
          ended: new Date(t0()).toISOString(),
          message: 'Cancelled.',
        });
        return json({ ok: true });
      }
      /* Unraid */
      case 'array.start':
        return task('array.start', 'unraid', () => {
          unraid.array.state = 'started';
          unraid.array.stateRaw = 'STARTED';
        });
      case 'array.stop':
        return task('array.stop', 'unraid', () => {
          unraid.array.state = 'stopped';
          unraid.array.stateRaw = 'STOPPED';
        });
      case 'parity.start':
        Object.assign(unraid.array.parity, {
          state: 'running',
          action: p.correct ? 'correct' : 'check',
          pct: 0.4,
          speedMbs: 191.2,
          etaS: 9 * 3600 + 20 * 60,
          errors: 0,
        });
        return task('parity.start', 'unraid');
      case 'parity.pause':
        unraid.array.parity.state = 'paused';
        return task('parity.pause', 'unraid');
      case 'parity.resume':
        unraid.array.parity.state = 'running';
        return task('parity.resume', 'unraid');
      case 'parity.cancel':
        Object.assign(unraid.array.parity, {
          state: 'idle',
          action: null,
          pct: null,
          speedMbs: null,
          etaS: null,
        });
        return task('parity.cancel', 'unraid');
      case 'disk.spin_up':
      case 'disk.spin_down': {
        const down = body.op === 'disk.spin_down';
        const which = String(p.disk ?? 'all');
        for (const d of [...unraid.array.disks, ...unraid.pools.flatMap((x) => x.disks)])
          if ((which === 'all' || d.name === which) && d.rotational !== false) {
            d.spunDown = down;
            d.tempC = down ? null : 35;
          }
        return task(body.op, 'unraid');
      }
      case 'mover.start':
        unraid.array.moverRunning = true;
        return task('mover.start', 'unraid', () => {
          unraid.array.moverRunning = false;
        });
      case 'plugin.check':
      case 'containers.check':
        return task(body.op, 'unraid');
      case 'plugin.update': {
        const file = String(p.plugin ?? '');
        return task('plugin.update', 'unraid', () => {
          for (const x of unraid.plugins)
            if ((file === 'all' || x.file === file) && x.update) {
              x.version = x.update;
              x.update = null;
            }
        });
      }
      case 'notification.archive': {
        const nid = typeof p.id === 'string' ? p.id : null;
        unraid.notifications = unraid.notifications.filter((n) => nid !== null && n.id !== nid);
        return json({ ok: true });
      }
      case 'container.update': {
        if (!g) return notFound('No such guest');
        return task('container.update', 'unraid', () => {
          replace(serverId, g.id, (x) => ({ ...x, updateAvailable: false }));
        });
      }
      case 'guest.autostart': {
        if (!g) return notFound('No such guest');
        replace(serverId, g.id, (x) => ({ ...x, autostart: !!p.on }));
        return json({ ok: true });
      }
      default:
        return json({ ok: true });
    }
  }

  /** A libvirt VM's changes (IU-13): settings with the digest (CD/DVD live, vCPUs and memory past the maximum later). */
  function manageLibvirt(
    serverId: string,
    body: ManageBody,
    g: HostGuest | undefined,
    task: (op: string, platform: 'libvirt', then?: () => void) => Response,
  ): Response {
    const p = body.params ?? {};
    const stopped = (x: HostGuest) =>
      x.state === 'stopped' ? null : refusal(409, 'guest_running', `Shut ${x.name} down first.`);
    switch (body.op) {
      case 'config.set': {
        if (!g) return notFound('No such guest');
        const cfg = libvirtConfigFor(serverId, g);
        if (body.digest && body.digest !== cfg.digest)
          return refusal(409, 'digest_mismatch', 'Changed meanwhile — review again.');
        const set = (p.set ?? {}) as Record<string, string>;
        const values = { ...cfg.values };
        const pending = { ...(cfg.pending ?? {}) };
        const changes: { key: string; old?: string; new?: string; pending?: boolean }[] = [];
        for (const [k, v] of Object.entries(set)) {
          const later =
            cfg.running &&
            ((k === 'vcpus' && Number(v) > Number(values.vcpus_max ?? v)) ||
              (k === 'memory_mb' && Number(v) > Number(values.memory_max_mb ?? v)));
          if (later) pending[k] = v;
          else values[k] = v;
          changes.push({ key: k, old: cfg.values[k], new: v, ...(later ? { pending: true } : {}) });
        }
        for (const k of (p.delete ?? []) as string[]) {
          changes.push({ key: k, old: values[k] });
          delete values[k];
        }
        configs.set(g.id, { ...cfg, values, pending, digest: `${cfg.digest}+` });
        replace(serverId, g.id, (x) => ({
          ...x,
          vcpu: Number(values.vcpus) || x.vcpu,
          memoryLimitMb: Number(values.memory_mb) || x.memoryLimitMb,
          autostart: values.autostart === '1',
        }));
        return json({ ok: true, changes });
      }
      case 'backup.create':
        if (!g) return notFound('No such guest');
        return task('backup.create', 'libvirt', () => {
          const at = new Date(t0() + 2500);
          libvirtBackups = [
            ...libvirtBackups,
            {
              volume: at
                .toISOString()
                .slice(0, 19)
                .replace(/[-:T]/g, '')
                .replace(/^(\d{8})/, '$1-'),
              storage: 'libvirt',
              guest: g.id,
              kind: 'vm',
              sizeBytes: (g.memoryLimitMb ?? 2048) * 1024 * 1024 * 4,
              created: at.toISOString(),
            },
          ];
        });
      case 'backup.delete':
        libvirtBackups = libvirtBackups.filter((b) => !(b.volume === p.volume && b.guest === p.guest));
        return json({ ok: true });
      case 'backup.restore': {
        const src = typeof p.guest === 'string' ? find(serverId, p.guest) : undefined;
        if (!src) return notFound('No such guest');
        const name = String(p.name ?? `${src.name}-restored`);
        if (list(serverId).some((x) => x.name === name))
          return refusal(409, 'exists', `There’s already a guest called ${name}.`);
        return task('backup.restore', 'libvirt', () => {
          list(serverId).push(copyOf(src, name, !!p.start));
        });
      }
      case 'guest.clone': {
        if (!g) return notFound('No such guest');
        const busy = stopped(g);
        if (busy) return busy;
        const name = String(p.name ?? `${g.name}-copy`);
        return task('guest.clone', 'libvirt', () => {
          list(serverId).push(copyOf(g, name, false));
        });
      }
      case 'guest.rename': {
        if (!g) return notFound('No such guest');
        const busy = stopped(g);
        if (busy) return busy;
        const name = String(p.name ?? '');
        const newId = `libvirt:${name}`;
        const cfg = configs.get(g.id);
        if (cfg) configs.set(newId, { ...cfg, values: { ...cfg.values, name } });
        replace(serverId, g.id, (x) => ({ ...x, id: newId, name }));
        return json({ ok: true, newId }, 200);
      }
      case 'guest.delete': {
        if (!g) return notFound('No such guest');
        const busy = stopped(g);
        if (busy) return busy;
        return task('guest.delete', 'libvirt', () => {
          replace(serverId, g.id, () => null);
        });
      }
      case 'task.stop': {
        const t = tasks.get(String(p.task ?? ''));
        if (!t) return notFound('No such task');
        tasks.set(t.id, { ...t, status: 'error', ended: new Date(t0()).toISOString(), message: 'Stopped.' });
        return json({ ok: true });
      }
      default:
        return json({ ok: true });
    }
  }

  function copyOf(src: HostGuest, name: string, start: boolean): HostGuest {
    const id = src.id.replace(/[^/:]+$/, name);
    const cfg = configs.get(src.id) ?? configOf(src);
    configs.set(id, { ...cfg, digest: `etag-${name}-1`, running: start });
    return {
      ...src,
      id,
      name,
      self: undefined,
      state: start ? 'running' : 'stopped',
      cpuPct: start ? 0.3 : null,
      memoryUsedMb: start ? 200 : null,
      addresses: [],
      snapshots: 0,
    } as HostGuest;
  }

  return { handle, detailExtras };
}
