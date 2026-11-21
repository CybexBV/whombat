/**
 * John's servers as the dashboards mocks draw them (Whombat dashboards.md DS-09; app dashboards-client.md AP-2020…),
 * for the server Summary's tests and the web's and phone's fixture servers: `pve-02` (Proxmox VE, `server.png`: 14
 * guests with home-assistant as CT 131, local-lvm filling up, last night's backup, the cluster with pve-01),
 * `blackbox` (Unraid, `unraid.png`: three data disks and parity, the NVMe cache pool, 16 containers, the pbs VM),
 * `the-titan` (Incus, with the dev box this Whombat runs in), `kvm-lab` (QEMU/KVM), `the-falcon` (a plain Linux host
 * without sensors or guests, `/srv` filling up) and `raspi` (a Docker host). Figures are made up in the mocks' spirit.
 *
 * History for any range on the hosts service's grid (1 h: 60 × 1 min … 90 d: 120 × 18 h), the same curves at every
 * range: a quiet day with the nightly backup at 03:10 in Amsterdam (01:10 UTC) as the peak of CPU, network, disk and
 * temperatures, storages growing as their forecast says. Deterministic: no clock (pass `now`) and no randomness beyond
 * a hash of the time. `withDashboardFixtures(handle)` answers the hosts routes for these servers before the main
 * fixture world (`createHostsFixtures`). Not imported by production code.
 */
import type {
  HostGuest,
  HostHint,
  HostPlatformWorkload,
  HostRemoteControl,
  HostSensor,
  HostSeries,
  HostSeriesRange,
  HostServerDetail,
  HostUnraidDisk,
  HostVolume,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest } from './fixtures';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const TB = 1e12;
const GB = 1e9;

const ALL_ON: HostRemoteControl = {
  console: true,
  power: true,
  hostShell: true,
  hostPower: true,
  manage: true,
  diagnose: true,
};

export type DashboardFixtureId = 'pve-02' | 'blackbox' | 'the-titan' | 'kvm-lab' | 'the-falcon' | 'raspi';

export const DASHBOARD_FIXTURE_IDS: readonly DashboardFixtureId[] = [
  'pve-02',
  'blackbox',
  'the-titan',
  'kvm-lab',
  'the-falcon',
  'raspi',
];

export interface DashboardFixture {
  id: DashboardFixtureId;
  detail: HostServerDetail;
  /** The server's history on the hosts service's grid for `range` (every series it has, or `keys`). */
  series: (range: HostSeriesRange, keys?: readonly string[]) => HostSeries;
  /** A guest's history (`cpu_pct`, `mem_mb`). */
  guestSeries: (guestId: string, range: HostSeriesRange) => HostSeries;
}

export type DashboardFixtures = Record<DashboardFixtureId, DashboardFixture>;

/* The grid and the curves ---------------------------------------------------------------------------------- */

/** The hosts service's ranges (`store/query.go`): step seconds and points. */
const GRID: Record<HostSeriesRange, { step: number; points: number }> = {
  '1h': { step: 60, points: 60 },
  '6h': { step: 300, points: 72 },
  '24h': { step: 900, points: 96 },
  '7d': { step: 7200, points: 84 },
  '30d': { step: 21600, points: 120 },
  '90d': { step: 64800, points: 120 },
};

/** A number in [0, 1) from a time and a seed: the same at every range. */
function noise(t: number, seed: number): number {
  let x = Math.floor(t / (5 * MIN)) * 2654435761 + seed * 40503;
  x = (x ^ (x >>> 15)) * 2246822519;
  x = (x ^ (x >>> 13)) * 3266489917;
  x ^= x >>> 16;
  return ((x >>> 0) % 10_000) / 10_000;
}

/** How far into the nightly backup (01:10 UTC, about 40 minutes) a time is: 0 outside, up to 1 at its height. */
function backup(t: number): number {
  const into = (((t - 70 * MIN) % DAY) + DAY) % DAY;
  if (into > 40 * MIN) return 0;
  return Math.sin((into / (40 * MIN)) * Math.PI);
}

/** A busier afternoon than night: 0…1 over a day. */
function daytime(t: number): number {
  const hour = (((t / H) % 24) + 24) % 24;
  return Math.max(0, Math.sin(((hour - 6) / 16) * Math.PI));
}

interface Curve {
  /** The value at a time (one sample). */
  at: (t: number) => number | null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** A busy-at-night curve: `base` with `day` more in the afternoon, `peak` during the backup, `jitter` of noise. */
function curve(
  seed: number,
  base: number,
  o: { day?: number; peak?: number; jitter?: number; max?: number },
): Curve {
  return {
    at: (t) => {
      const v =
        base +
        (o.day ?? 0) * daytime(t) +
        (o.peak ?? 0) * backup(t) +
        (noise(t, seed) - 0.5) * (o.jitter ?? 0);
      return Math.max(0, Math.min(o.max ?? Number.POSITIVE_INFINITY, v));
    },
  };
}

/** A volume growing `perDay` points a day, `now` at `pct`. */
function growing(pct: number, perDay: number, now: number): Curve {
  return { at: (t) => Math.min(100, Math.max(0, pct - ((now - t) / DAY) * perDay)) };
}

/** The bucket ending at `end` as the hub stores it: the average of the samples in it (up to 12). */
function bucket(c: Curve, end: number, stepMs: number): number | null {
  const n = Math.max(1, Math.min(12, Math.round(stepMs / (5 * MIN))));
  let sum = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const v = c.at(end - (i * stepMs) / n);
    if (v != null) {
      sum += v;
      k++;
    }
  }
  return k ? round1(sum / k) : null;
}

function makeSeries(
  serverId: string,
  curves: Record<string, Curve>,
  now: number,
  range: HostSeriesRange,
  keys?: readonly string[],
  guestId?: string,
): HostSeries {
  const g = GRID[range];
  const stepMs = g.step * 1000;
  const last = Math.floor(now / stepMs) * stepMs;
  const ends = Array.from({ length: g.points }, (_, i) =>
    i === g.points - 1 ? now : last - (g.points - 1 - i) * stepMs,
  );
  const series: Record<string, (number | null)[]> = {};
  const summary: NonNullable<HostSeries['summary']> = {};
  for (const k of keys ?? Object.keys(curves)) {
    const c = curves[k];
    const values = c ? ends.map((e) => bucket(c, e, stepMs)) : ends.map(() => null);
    series[k] = values;
    let max: number | null = null;
    let maxAt: string | null = null;
    let sum = 0;
    let n = 0;
    values.forEach((v, i) => {
      if (v == null) return;
      sum += v;
      n++;
      if (max == null || v > max) {
        max = v;
        maxAt = new Date(ends[i] ?? now).toISOString();
      }
    });
    summary[k] = n ? { avg: round1(sum / n), max, maxAt } : null;
  }
  return {
    serverId,
    ...(guestId ? { guestId } : {}),
    range,
    stepSeconds: g.step,
    asOf: new Date(now).toISOString(),
    timestamps: ends.map((e) => new Date(e).toISOString()),
    series,
    summary,
  };
}

/* Shared parts --------------------------------------------------------------------------------------------- */

function workload(guests: HostGuest[]): HostPlatformWorkload {
  const on = guests.filter((g) => g.state === 'running' || g.state === 'unhealthy');
  return {
    running: on.length,
    total: guests.length,
    cpuPct: round1(on.reduce((a, g) => a + (g.cpuPct ?? 0), 0)),
    memoryGb: round1(on.reduce((a, g) => a + (g.memoryUsedMb ?? 0), 0) / 1024),
    containers: guests.filter((g) => g.kind === 'container').length,
    vms: guests.filter((g) => g.kind === 'vm').length,
    guests,
  };
}

interface GuestSeed {
  id: string;
  name: string;
  kind: 'vm' | 'container';
  on?: boolean;
  cpu?: number;
  mem?: number;
  limit?: number | null;
  vmid?: number;
  image?: string;
  tags?: string[];
  pending?: number;
  self?: boolean;
  update?: boolean;
}

function guest(serverId: string, platform: HostGuest['platform'], s: GuestSeed, i: number): HostGuest {
  const on = s.on !== false;
  const vm = s.kind === 'vm';
  return {
    id: `${platform}:${s.id}`,
    serverId,
    serverOnline: true,
    name: s.name,
    platform,
    kind: s.kind,
    image: s.image ?? (vm ? 'Debian 13' : 'debian-13-standard'),
    state: on ? 'running' : 'stopped',
    vcpu: vm ? 4 : 2,
    cpuPct: on ? (s.cpu ?? 0.5) : null,
    memoryUsedMb: on ? Math.round((s.mem ?? 0.5) * 1024) : null,
    memoryLimitMb: s.limit === null ? null : Math.round((s.limit ?? 2) * 1024),
    diskReadMbs: on ? round1((s.cpu ?? 0.5) / 4) : null,
    diskWriteMbs: on ? round1((s.cpu ?? 0.5) / 3) : null,
    netRxMbps: on ? round1((s.cpu ?? 0.5) * 1.2) : null,
    netTxMbps: on ? round1((s.cpu ?? 0.5) * 0.6) : null,
    uptimeS: on ? 12 * 86_400 - i * 3600 : null,
    console: {
      available: on,
      protocols: platform === 'docker' ? ['shell', 'logs'] : vm ? ['vnc', 'serial'] : ['tty', 'shell'],
      defaultProtocol: platform === 'docker' ? 'shell' : vm ? 'vnc' : 'tty',
    },
    ...(s.vmid != null ? { vmid: s.vmid, node: serverId } : {}),
    tags: s.tags ?? [],
    ...(s.pending ? { pendingChanges: s.pending } : {}),
    ...(s.self ? { self: true } : {}),
    ...(platform === 'docker' ? { updateAvailable: s.update === true, template: true, autostart: true } : {}),
  };
}

function sensor(
  id: string,
  label: string,
  group: string,
  nowC: number,
  limitC: number | null,
  source = 'hwmon',
): HostSensor {
  return { id, label, group, source, nowC, maxC: nowC + 6, limitC };
}

function volume(
  entity: string,
  label: string,
  usedGb: number,
  totalGb: number,
  o: Partial<HostVolume> = {},
): HostVolume {
  const kind = entity.startsWith('pool:') ? 'pool' : entity.startsWith('storage:') ? 'storage' : 'fs';
  return {
    entity,
    kind,
    label,
    usedGb,
    totalGb,
    usedPct: round1((usedGb / totalGb) * 100),
    fullInDays: null,
    ...o,
  };
}

function info(
  o: Partial<HostServerDetail['server']> & Pick<HostServerDetail['server'], 'id' | 'platform'>,
  now: number,
  uptimeDays: number,
): HostServerDetail['server'] {
  return {
    group: 'Home lab',
    status: 'ok',
    statusNote: null,
    roles: [],
    os: { name: 'Debian GNU/Linux', version: '13', kernel: '6.12.48-amd64' },
    cpu: { model: 'Ryzen 7 5700G', cores: 8, threads: 16 },
    memory: { totalGb: 64, type: 'DDR4' },
    uptimeS: Math.round(uptimeDays * 86_400),
    lastBoot: new Date(now - uptimeDays * DAY).toISOString(),
    address: null,
    location: 'Office rack',
    agent: { version: '0.17.0', lastSyncSAgo: 6, connected: true, clockSkewS: 0 },
    remoteControl: ALL_ON,
    maintenance: null,
    parent: null,
    ...o,
  };
}

/* pve-02: Proxmox VE (server.png) --------------------------------------------------------------------------- */

const PVE02_GUESTS: GuestSeed[] = [
  {
    id: '131',
    vmid: 131,
    name: 'home-assistant',
    kind: 'container',
    cpu: 6.1,
    mem: 3,
    limit: 8,
    tags: ['home'],
  },
  { id: '104', vmid: 104, name: 'nextcloud', kind: 'vm', cpu: 4.8, mem: 6.2, limit: 8 },
  { id: '120', vmid: 120, name: 'unifi', kind: 'container', cpu: 2.9, mem: 1.4, limit: 2 },
  { id: '110', vmid: 110, name: 'frigate', kind: 'vm', cpu: 2.2, mem: 3.1, limit: 4, pending: 1 },
  { id: '101', vmid: 101, name: 'pihole', kind: 'container', cpu: 0.4, mem: 0.2, limit: 1 },
  { id: '106', vmid: 106, name: 'docker-host', kind: 'vm', cpu: 0.3, mem: 2.1, limit: 4 },
  { id: '122', vmid: 122, name: 'paperless', kind: 'container', cpu: 0.3, mem: 1.1, limit: 2 },
  { id: '125', vmid: 125, name: 'jellyfin', kind: 'container', cpu: 0.2, mem: 1.6, limit: 4 },
  { id: '130', vmid: 130, name: 'vaultwarden', kind: 'container', cpu: 0.1, mem: 0.1, limit: 0.5 },
  { id: '132', vmid: 132, name: 'mosquitto', kind: 'container', cpu: 0.1, mem: 0.1, limit: 0.5 },
  { id: '133', vmid: 133, name: 'zigbee2mqtt', kind: 'container', cpu: 0.1, mem: 0.2, limit: 1 },
  { id: '140', vmid: 140, name: 'grafana', kind: 'container', cpu: 0.1, mem: 0.3, limit: 1 },
  { id: '105', vmid: 105, name: 'win11', kind: 'vm', on: false, limit: 8, image: 'Windows 11' },
  { id: '199', vmid: 199, name: 'test-ct', kind: 'container', on: false, limit: 1 },
];

function pve02(now: number): DashboardFixture {
  const id = 'pve-02';
  const guests = PVE02_GUESTS.map((g, i) => guest(id, 'pve', g, i));
  const vms = guests.filter((g) => g.kind === 'vm');
  const cts = guests.filter((g) => g.kind === 'container');
  const hints: HostHint[] = [
    {
      serverId: id,
      kind: 'sensor.near_limit',
      severity: 'warning',
      entity: 'cpu_package',
      title: 'CPU package at 79 °C',
      detail: 'Up to 79 °C during the 03:00 backups.',
      section: 'sensors',
    },
    {
      serverId: id,
      kind: 'disk.full_soon',
      severity: 'info',
      entity: 'storage:local-lvm',
      title: 'Storage “local-lvm” full in about 5 months',
      detail: 'At the rate it filled last week',
      section: 'storage',
    },
    {
      serverId: id,
      kind: 'system.updates',
      severity: 'info',
      entity: 'apt',
      title: '3 updates waiting',
      detail: '',
      section: 'system',
    },
  ];
  const detail: HostServerDetail = {
    asOf: new Date(now).toISOString(),
    server: info(
      {
        id,
        platform: 'proxmox',
        status: 'warn',
        statusNote: 'running warm',
        roles: ['proxmox-node', 'kvm-host'],
        os: { name: 'Proxmox VE', version: '9.0.10', kernel: '6.14.11-2-pve' },
        address: '10.100.0.12',
      },
      now,
      12.17,
    ),
    live: {
      refreshIntervalS: 10,
      cpuPct: 18,
      cpuUserPct: 11.4,
      cpuSystemPct: 4.9,
      cpuIowaitPct: 1.7,
      loadAvg: [2.9, 2.6, 2.4],
      memPct: 64,
      memUsedGb: 41,
      memCacheGb: 3,
      zfsArcGb: 9,
      memFreeGb: 14,
      swapUsedGb: 0,
      swapTotalGb: 8,
    },
    banner: null,
    sensors: [
      sensor('cpu_package', 'CPU package', 'cpu', 71, 85, 'k10temp · Tctl'),
      sensor('nvme_hottest', 'NVMe, hottest', 'nvme', 48, 75, 'nvme0n1 · composite'),
      sensor('board_vrm', 'Board', 'board', 41, null, 'acpitz'),
    ],
    disks: [],
    virtualization: null,
    hints,
    alerts: [],
    health: {
      volumes: [
        volume('storage:local-lvm', 'Storage local-lvm', 660, 930, { fullInDays: 145 }),
        volume('storage:tank', 'Storage tank', 2100, 7200),
        volume('storage:local', 'Storage local', 38, 94),
        volume('pool:tank', 'Pool tank', 2100, 7200, { layout: 'mirror', health: 'ONLINE' }),
      ],
      network: [],
    },
    proxmox: {
      cluster: {
        name: 'home',
        quorate: true,
        votes: { have: 2, expected: 2 },
        ha: { resourcesStarted: 0 },
        nodes: [
          {
            name: 'pve-01',
            thisNode: false,
            status: 'online',
            cpuPct: 6,
            memPct: 38,
            vms: 2,
            containers: 7,
            agent: 'connected',
            serverId: 'pve-01',
          },
          {
            name: 'pve-02',
            thisNode: true,
            status: 'online',
            cpuPct: 18,
            memPct: 64,
            vms: vms.length,
            containers: cts.length,
            agent: 'connected',
            serverId: 'pve-02',
          },
        ],
        note: null,
      },
      storages: [
        { id: 'local-lvm', type: 'lvmthin', content: 'images,rootdir', usedGb: 660, capacityGb: 930 },
        { id: 'tank', type: 'zfspool', content: 'images,rootdir', usedGb: 2100, capacityGb: 7200 },
        { id: 'local', type: 'dir', content: 'iso,vztmpl,backup', usedGb: 38, capacityGb: 94 },
        { id: 'pbs', type: 'pbs', content: 'backup', usedGb: 1200, capacityGb: 4000 },
      ],
      backups: {
        lastJob: {
          at: new Date(now - 15 * H).toISOString(),
          schedule: 'Every day at 03:00',
          mode: 'snapshot',
          result: 'ok',
          guestsOk: 14,
          guestsTotal: 14,
          warnings: 0,
          writtenGb: 38,
          dedupRatio: 12.4,
          durationMin: 41,
          avgDurationMinWeek: 39,
        },
        nextRun: new Date(now + 9 * H).toISOString(),
        target: 'pbs',
      },
      guests: { vm: workload(vms), container: workload(cts) },
    },
  };
  const curves: Record<string, Curve> = {
    cpu_pct: curve(1, 10, { day: 4, peak: 53, jitter: 4, max: 100 }),
    mem_pct: curve(2, 60, { day: 1, peak: 9, jitter: 1, max: 100 }),
    load1: curve(3, 2.2, { day: 0.6, peak: 6, jitter: 0.5 }),
    swap_pct: curve(4, 0, { jitter: 0 }),
    net_rx_mbps: curve(5, 45, { day: 20, peak: 360, jitter: 14 }),
    net_tx_mbps: curve(6, 18, { day: 6, peak: 40, jitter: 6 }),
    disk_read_mbs: curve(7, 9, { day: 3, peak: 70, jitter: 6 }),
    disk_write_mbs: curve(8, 14, { day: 4, peak: 85, jitter: 8 }),
    temp_cpu_package_c: curve(9, 63, { day: 3, peak: 15, jitter: 2 }),
    temp_nvme_hottest_c: curve(10, 45, { day: 2, peak: 7, jitter: 1.5 }),
    temp_board_vrm_c: curve(11, 39, { day: 1.5, peak: 3, jitter: 1 }),
    'vol_pct:storage:local-lvm': growing(71, 0.2, now),
    'vol_pct:storage:tank': growing(29, 0, now),
    'vol_pct:storage:local': growing(40, 0, now),
    'vol_pct:storage:pbs': growing(30, 0.02, now),
    'vol_pct:pool:tank': growing(29, 0, now),
  };
  return withSeries(id, detail, curves, now, guests);
}

/* blackbox: Unraid (unraid.png) ------------------------------------------------------------------------------ */

function udisk(name: string, slot: HostUnraidDisk['slot'], o: Partial<HostUnraidDisk> = {}): HostUnraidDisk {
  return {
    name,
    slot,
    device: `sd${String.fromCharCode(98 + name.length)}`,
    model: 'WD Red 8 TB',
    serial: null,
    status: 'ok',
    statusRaw: 'DISK_OK',
    sizeBytes: 8 * TB,
    usedBytes: null,
    freeBytes: null,
    fsType: slot === 'data' ? 'xfs' : null,
    tempC: 36,
    spunDown: false,
    errors: 0,
    rotational: true,
    ...o,
  };
}

const BLACKBOX_CONTAINERS: GuestSeed[] = [
  {
    id: 'plex',
    name: 'plex',
    kind: 'container',
    cpu: 4.1,
    mem: 2.8,
    limit: null,
    tags: ['media'],
    update: true,
  },
  {
    id: 'sabnzbd',
    name: 'sabnzbd',
    kind: 'container',
    cpu: 2.6,
    mem: 0.9,
    limit: null,
    tags: ['downloads'],
    update: true,
  },
  { id: 'immich', name: 'immich', kind: 'container', cpu: 1.2, mem: 3.4, limit: null, tags: ['photos'] },
  {
    id: 'immich-db',
    name: 'immich-db',
    kind: 'container',
    cpu: 0.8,
    mem: 0.6,
    limit: null,
    tags: ['photos'],
  },
  { id: 'sonarr', name: 'sonarr', kind: 'container', cpu: 0.6, mem: 0.4, limit: null, tags: ['media'] },
  { id: 'radarr', name: 'radarr', kind: 'container', cpu: 0.5, mem: 0.4, limit: null, tags: ['media'] },
  { id: 'prowlarr', name: 'prowlarr', kind: 'container', cpu: 0.3, mem: 0.2, limit: null, tags: ['media'] },
  { id: 'tautulli', name: 'tautulli', kind: 'container', cpu: 0.2, mem: 0.2, limit: null, tags: ['media'] },
  { id: 'overseerr', name: 'overseerr', kind: 'container', cpu: 0.2, mem: 0.3, limit: null, tags: ['media'] },
  { id: 'syncthing', name: 'syncthing', kind: 'container', cpu: 0.2, mem: 0.1, limit: null, tags: ['files'] },
  {
    id: 'nginx-proxy',
    name: 'nginx-proxy',
    kind: 'container',
    cpu: 0.1,
    mem: 0.1,
    limit: null,
    tags: ['web'],
  },
  {
    id: 'duplicati',
    name: 'duplicati',
    kind: 'container',
    cpu: 0.1,
    mem: 0.3,
    limit: null,
    tags: ['backup'],
  },
  { id: 'paperless', name: 'paperless', kind: 'container', cpu: 0.1, mem: 0.5, limit: null, tags: ['files'] },
  {
    id: 'unifi-poller',
    name: 'unifi-poller',
    kind: 'container',
    cpu: 0.1,
    mem: 0.1,
    limit: null,
    tags: ['web'],
  },
  { id: 'photoprism', name: 'photoprism', kind: 'container', on: false, limit: null, tags: ['photos'] },
  { id: 'old-test', name: 'old-test', kind: 'container', on: false, limit: null },
];

function blackbox(now: number): DashboardFixture {
  const id = 'blackbox';
  const docker = BLACKBOX_CONTAINERS.map((g, i) => ({
    ...guest(id, 'docker', g, i),
    image: `lscr.io/linuxserver/${g.name}`,
  }));
  const pbs = {
    ...guest(id, 'libvirt', { id: 'pbs', name: 'pbs', kind: 'vm', cpu: 3, mem: 3.2, limit: 4 }, 0),
    image: 'Proxmox Backup Server',
    autostart: true,
  };
  const disks: HostUnraidDisk[] = [
    udisk('parity', 'parity', { device: 'sdb', tempC: 34 }),
    udisk('disk1', 'data', {
      device: 'sdc',
      usedBytes: 7.1 * TB,
      freeBytes: 0.9 * TB,
      tempC: 33,
      spunDown: true,
    }),
    udisk('disk2', 'data', { device: 'sdd', usedBytes: 6.0 * TB, freeBytes: 2.0 * TB, tempC: 36 }),
    udisk('disk3', 'data', { device: 'sde', usedBytes: 5.1 * TB, freeBytes: 2.9 * TB, tempC: 39 }),
  ];
  const nvme = (name: string, device: string): HostUnraidDisk =>
    udisk(name, 'pool', {
      device,
      model: 'Samsung 980 PRO 1 TB',
      sizeBytes: 1000 * GB,
      fsType: 'btrfs',
      tempC: 41,
      rotational: false,
    });
  const hints: HostHint[] = [
    {
      serverId: id,
      kind: 'disk.space_high',
      severity: 'warning',
      entity: 'fs:/mnt/disk1',
      title: 'Disk 1 is 89 % full',
      detail: 'Unraid fills the other disks first.',
      section: 'storage',
    },
    {
      serverId: id,
      kind: 'docker.update_available',
      severity: 'info',
      entity: 'docker',
      title: '2 apps have an update',
      detail: 'plex, sabnzbd',
      section: 'guests',
    },
  ];
  const detail: HostServerDetail = {
    asOf: new Date(now).toISOString(),
    server: info(
      {
        id,
        platform: 'unraid',
        roles: ['docker-host'],
        os: { name: 'Unraid', version: '7.1.4', kernel: '6.12.24-Unraid' },
        cpu: { model: 'Core i5-12400', cores: 6, threads: 12 },
        memory: { totalGb: 32, type: 'DDR4' },
        address: '10.100.0.40',
        agent: { version: '0.17.0', lastSyncSAgo: 4, connected: true, clockSkewS: 0 },
      },
      now,
      27.2,
    ),
    live: {
      refreshIntervalS: 10,
      cpuPct: 9,
      cpuUserPct: 6.1,
      cpuSystemPct: 2.4,
      cpuIowaitPct: 0.5,
      loadAvg: [1.1, 1.3, 1.2],
      memPct: 44,
      memUsedGb: 14,
      memCacheGb: 11,
      zfsArcGb: null,
      memFreeGb: 7,
      swapUsedGb: 0,
      swapTotalGb: 0,
    },
    banner: null,
    sensors: [
      sensor('cpu_package', 'CPU package', 'cpu', 46, 100, 'coretemp · Package id 0'),
      sensor('hdd_hottest', 'HDD, hottest', 'hdd', 39, 55, 'sde · SMART'),
      sensor('nvme_hottest', 'NVMe, hottest', 'nvme', 41, 75, 'nvme0n1 · composite'),
    ],
    disks: [],
    virtualization: null,
    hints,
    alerts: [],
    health: {
      volumes: [
        volume('fs:/mnt/disk1', '/mnt/disk1', 7100, 8000),
        volume('fs:/mnt/disk2', '/mnt/disk2', 6000, 8000),
        volume('fs:/mnt/disk3', '/mnt/disk3', 5100, 8000),
        volume('fs:/mnt/cache', '/mnt/cache', 310, 1000),
      ],
      network: [],
    },
    workloads: { docker: workload(docker), libvirt: workload([pbs]) },
    unraid: {
      version: '7.1.4',
      name: 'BlackBox',
      license: 'Pro',
      osUpdate: null,
      array: {
        state: 'started',
        stateRaw: 'STARTED',
        startOnBoot: true,
        sizeBytes: 24 * TB,
        usedBytes: 18.2 * TB,
        freeBytes: 5.8 * TB,
        disabled: 0,
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
            at: new Date(now - 17 * DAY).toISOString(),
            durationS: 15 * 3600 + 12 * 60,
            speedMbs: 146,
            errors: 0,
            result: 'ok',
            action: 'check P',
          },
          history: [],
          schedule: 'Monthly, day 1 at 00:30, no corrections',
        },
        disks,
      },
      pools: [
        {
          name: 'cache',
          fsType: 'btrfs',
          profile: 'raid1',
          sizeBytes: 1000 * GB,
          usedBytes: 310 * GB,
          freeBytes: 690 * GB,
          disks: [nvme('cache', 'nvme0n1'), nvme('cache2', 'nvme1n1')],
        },
      ],
      flash: null,
      shares: [],
      plugins: [],
      notifications: [],
      docker: { enabled: true, imageUsedPct: 38 },
      vms: { enabled: true },
    },
    libvirt: {
      version: '11.2.0',
      qemu: '9.2.3',
      pools: [],
      networks: [],
      folders: { domains: '/mnt/user/domains', isos: '/mnt/user/isos' },
      firmware: { uefi: true, secureBoot: false, tpm: true },
      backupsDir: null,
    },
  };
  const curves: Record<string, Curve> = {
    cpu_pct: curve(21, 7, { day: 3, peak: 62, jitter: 3, max: 100 }),
    mem_pct: curve(22, 42, { day: 2, peak: 6, jitter: 1, max: 100 }),
    load1: curve(23, 1, { day: 0.4, peak: 4, jitter: 0.3 }),
    net_rx_mbps: curve(24, 12, { day: 30, peak: 120, jitter: 8 }),
    net_tx_mbps: curve(25, 20, { day: 50, peak: 30, jitter: 10 }),
    disk_read_mbs: curve(26, 6, { day: 12, peak: 140, jitter: 5 }),
    disk_write_mbs: curve(27, 4, { day: 5, peak: 110, jitter: 4 }),
    temp_cpu_package_c: curve(28, 42, { day: 4, peak: 18, jitter: 2 }),
    temp_hdd_hottest_c: curve(29, 37, { day: 1.5, peak: 5, jitter: 1 }),
    temp_nvme_hottest_c: curve(30, 39, { day: 2, peak: 4, jitter: 1 }),
    'vol_pct:fs:/mnt/disk1': growing(88.8, 0.05, now),
    'vol_pct:fs:/mnt/disk2': growing(75, 0.02, now),
    'vol_pct:fs:/mnt/disk3': growing(63.8, 0.02, now),
    'vol_pct:fs:/mnt/cache': growing(31, 0.1, now),
  };
  return withSeries(id, detail, curves, now, [...docker, pbs]);
}

/* the-titan: Incus ---------------------------------------------------------------------------------------- */

function theTitan(now: number): DashboardFixture {
  const id = 'the-titan';
  const guests = [
    {
      id: 'whombat-dev-box',
      name: 'whombat-dev-box',
      kind: 'vm' as const,
      cpu: 14.2,
      mem: 11.8,
      limit: 16,
      self: true,
    },
    { id: 'ci-runner-1', name: 'ci-runner-1', kind: 'container' as const, cpu: 22.5, mem: 3.9, limit: 8 },
    { id: 'ci-runner-2', name: 'ci-runner-2', kind: 'container' as const, cpu: 8.4, mem: 2.2, limit: 8 },
    {
      id: 'computer-banjo',
      name: 'computer-banjo',
      kind: 'container' as const,
      cpu: 3.1,
      mem: 1.4,
      limit: 4,
    },
    {
      id: 'computer-hazel',
      name: 'computer-hazel',
      kind: 'container' as const,
      cpu: 0.6,
      mem: 0.9,
      limit: 4,
    },
    { id: 'win-test', name: 'win-test', kind: 'vm' as const, on: false, limit: 8, image: 'Windows 11' },
  ].map((g, i) => guest(id, 'incus', g, i));
  const detail: HostServerDetail = {
    asOf: new Date(now).toISOString(),
    server: info(
      {
        id,
        platform: 'incus',
        roles: ['incus-host'],
        os: { name: 'Debian GNU/Linux', version: '13', kernel: '6.12.48-amd64' },
        cpu: { model: 'Ryzen 9 7950X', cores: 16, threads: 32 },
        memory: { totalGb: 128, type: 'DDR5' },
        address: '10.100.1.5',
        hostsThisWhombat: true,
      },
      now,
      41.3,
    ),
    live: {
      refreshIntervalS: 10,
      cpuPct: 24,
      cpuUserPct: 17.2,
      cpuSystemPct: 5.1,
      cpuIowaitPct: 1.2,
      loadAvg: [7.8, 7.1, 6.5],
      memPct: 38,
      memUsedGb: 48,
      memCacheGb: 22,
      zfsArcGb: 16,
      memFreeGb: 58,
      swapUsedGb: 0.2,
      swapTotalGb: 16,
    },
    banner: null,
    sensors: [
      sensor('cpu_package', 'CPU package', 'cpu', 64, 95, 'k10temp · Tctl'),
      sensor('nvme_hottest', 'NVMe, hottest', 'nvme', 52, 75, 'nvme1n1 · composite'),
      sensor('board_vrm', 'Board / VRM', 'board', 47, 90, 'nct6799 · SYSTIN'),
      sensor('gpu_hottest', 'GPU, hottest', 'gpu', 44, 90, 'amdgpu · edge'),
    ],
    disks: [],
    virtualization: null,
    hints: [
      {
        serverId: id,
        kind: 'incus.no_snapshots',
        severity: 'info',
        entity: 'incus:computer-hazel',
        title: '1 machine isn’t backed up',
        detail: 'computer-hazel · no scheduled snapshots, no backup in 30 days',
        section: 'guests',
      },
    ],
    alerts: [],
    health: {
      volumes: [
        volume('fs:/', '/', 92, 460),
        volume('pool:default', 'Pool default', 812, 1860, { layout: 'mirror', health: 'ONLINE' }),
        volume('fs:/srv/ci', '/srv/ci', 610, 940, { fullInDays: 38 }),
      ],
      network: [],
    },
    workloads: { incus: workload(guests) },
    incus: {
      version: '6.0.4',
      clustered: false,
      projects: [
        { name: 'default', description: 'Default Incus project', instances: 4, running: 3 },
        { name: 'ci-platform', description: 'CI runners', instances: 2, running: 2 },
      ],
      pools: [
        {
          name: 'default',
          driver: 'zfs',
          status: 'Created',
          description: '',
          usedBytes: 812 * GB,
          totalBytes: 1860 * GB,
          volumes: 17,
        },
        {
          name: 'ci-nvme',
          driver: 'dir',
          status: 'Created',
          description: 'CI scratch',
          usedBytes: 610 * GB,
          totalBytes: 940 * GB,
          volumes: 6,
        },
      ],
      networks: [
        {
          name: 'incusbr0',
          type: 'bridge',
          managed: true,
          description: '',
          ipv4: '10.85.3.1/24',
          ipv6: null,
          nat: true,
          usedBy: 5,
        },
      ],
      profiles: [{ name: 'default', project: 'default', description: 'Default Incus profile', usedBy: 4 }],
      images: [],
      volumes: [],
    },
  };
  const curves: Record<string, Curve> = {
    cpu_pct: curve(41, 18, { day: 14, peak: 20, jitter: 8, max: 100 }),
    mem_pct: curve(42, 35, { day: 5, peak: 3, jitter: 1.5, max: 100 }),
    load1: curve(43, 6, { day: 3, peak: 4, jitter: 1 }),
    swap_pct: curve(44, 1, { jitter: 0.2 }),
    net_rx_mbps: curve(45, 30, { day: 90, peak: 40, jitter: 20 }),
    net_tx_mbps: curve(46, 12, { day: 30, peak: 20, jitter: 8 }),
    disk_read_mbs: curve(47, 20, { day: 60, peak: 40, jitter: 15 }),
    disk_write_mbs: curve(48, 25, { day: 80, peak: 60, jitter: 20 }),
    temp_cpu_package_c: curve(49, 55, { day: 10, peak: 6, jitter: 3 }),
    temp_nvme_hottest_c: curve(50, 47, { day: 5, peak: 3, jitter: 1.5 }),
    temp_board_vrm_c: curve(51, 44, { day: 3, peak: 2, jitter: 1 }),
    temp_gpu_hottest_c: curve(52, 42, { day: 2, peak: 1, jitter: 1 }),
    'vol_pct:fs:/': growing(20, 0, now),
    'vol_pct:pool:default': growing(43.7, 0.05, now),
    'vol_pct:fs:/srv/ci': growing(64.9, 0.9, now),
  };
  return withSeries(id, detail, curves, now, guests);
}

/* kvm-lab: QEMU/KVM ------------------------------------------------------------------------------------------ */

function kvmLab(now: number): DashboardFixture {
  const id = 'kvm-lab';
  const guests = [
    { id: 'debian-web', name: 'debian-web', kind: 'vm' as const, cpu: 7.4, mem: 1.6, limit: 2, pending: 1 },
    { id: 'win11', name: 'win11', kind: 'vm' as const, cpu: 5.2, mem: 6.1, limit: 8, image: 'Windows 11' },
    {
      id: 'pfsense',
      name: 'pfsense',
      kind: 'vm' as const,
      cpu: 1.9,
      mem: 0.9,
      limit: 2,
      image: 'FreeBSD 14',
    },
    {
      id: 'alpine-test',
      name: 'alpine-test',
      kind: 'vm' as const,
      on: false,
      limit: 1,
      image: 'Alpine 3.22',
    },
    {
      id: 'nixos-build',
      name: 'nixos-build',
      kind: 'vm' as const,
      on: false,
      limit: 8,
      image: 'NixOS 25.05',
    },
  ].map((g, i) => guest(id, 'libvirt', g, i));
  const detail: HostServerDetail = {
    asOf: new Date(now).toISOString(),
    server: info(
      {
        id,
        platform: 'libvirt',
        roles: ['kvm-host'],
        cpu: { model: 'Xeon E-2388G', cores: 8, threads: 16 },
        memory: { totalGb: 64, type: 'DDR4 ECC' },
        address: '10.100.0.30',
      },
      now,
      9.4,
    ),
    live: {
      refreshIntervalS: 10,
      cpuPct: 15,
      cpuUserPct: 10.1,
      cpuSystemPct: 3.9,
      cpuIowaitPct: 1,
      loadAvg: [2.4, 2.1, 1.9],
      memPct: 31,
      memUsedGb: 19.8,
      memCacheGb: 12,
      zfsArcGb: null,
      memFreeGb: 32,
      swapUsedGb: 0,
      swapTotalGb: 4,
    },
    banner: null,
    sensors: [sensor('cpu_package', 'CPU package', 'cpu', 58, 100, 'coretemp · Package id 0')],
    disks: [],
    virtualization: null,
    hints: [
      {
        serverId: id,
        kind: 'libvirt.no_backup',
        severity: 'warning',
        entity: 'libvirt:win11',
        title: 'win11 has no recent backup',
        detail: 'No backup or snapshot in the last 30 days',
        section: 'backups',
      },
      {
        serverId: id,
        kind: 'libvirt.pool_full',
        severity: 'warning',
        entity: 'fast',
        title: 'The pool fast is 88 % full',
        detail: 'New VMs and snapshots there may not fit.',
        section: 'storage',
      },
    ],
    alerts: [],
    health: {
      volumes: [volume('fs:/', '/', 41, 230), volume('fs:/var/lib/libvirt', '/var/lib/libvirt', 380, 900)],
      network: [],
    },
    workloads: { libvirt: workload(guests) },
    libvirt: {
      version: '12.2.0',
      qemu: '10.1.0',
      pools: [
        {
          name: 'default',
          type: 'dir',
          active: true,
          autostart: true,
          path: '/var/lib/libvirt/images',
          usedBytes: 380 * GB,
          totalBytes: 900 * GB,
          availBytes: 520 * GB,
          volumes: 7,
        },
        {
          name: 'fast',
          type: 'logical',
          active: true,
          autostart: true,
          path: '/dev/fast',
          usedBytes: 440 * GB,
          totalBytes: 500 * GB,
          availBytes: 60 * GB,
          volumes: 3,
        },
        {
          name: 'isos',
          type: 'dir',
          active: false,
          autostart: false,
          path: '/srv/isos',
          usedBytes: 0,
          totalBytes: 0,
          availBytes: 0,
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
          usedBy: 3,
        },
      ],
      folders: null,
      firmware: { uefi: true, secureBoot: true, tpm: true },
      backupsDir: '/srv/backups/vms',
    },
  };
  const curves: Record<string, Curve> = {
    cpu_pct: curve(61, 11, { day: 6, peak: 30, jitter: 4, max: 100 }),
    mem_pct: curve(62, 30, { day: 2, peak: 2, jitter: 1, max: 100 }),
    load1: curve(63, 2, { day: 0.5, peak: 3, jitter: 0.4 }),
    swap_pct: curve(64, 0, {}),
    net_rx_mbps: curve(65, 8, { day: 12, peak: 30, jitter: 5 }),
    net_tx_mbps: curve(66, 4, { day: 6, peak: 80, jitter: 3 }),
    disk_read_mbs: curve(67, 4, { day: 3, peak: 50, jitter: 3 }),
    disk_write_mbs: curve(68, 6, { day: 4, peak: 40, jitter: 3 }),
    temp_cpu_package_c: curve(69, 52, { day: 5, peak: 9, jitter: 2 }),
    'vol_pct:fs:/': growing(17.8, 0, now),
    'vol_pct:fs:/var/lib/libvirt': growing(42.2, 0.08, now),
  };
  return withSeries(id, detail, curves, now, guests);
}

/* the-falcon: plain Linux without sensors ------------------------------------------------------------------- */

function theFalcon(now: number): DashboardFixture {
  const id = 'the-falcon';
  const detail: HostServerDetail = {
    asOf: new Date(now).toISOString(),
    server: info(
      {
        id,
        platform: 'standard',
        os: { name: 'Ubuntu', version: '24.04.3', kernel: '6.8.0-85-generic' },
        cpu: { model: 'AMD EPYC Processor', cores: 4, threads: 4 },
        memory: { totalGb: 8, type: null },
        address: '203.0.113.44',
        agent: { version: '0.17.0', lastSyncSAgo: 8, connected: true, clockSkewS: 0 },
      },
      now,
      63.1,
    ),
    live: {
      refreshIntervalS: 10,
      cpuPct: 6,
      cpuUserPct: 4.2,
      cpuSystemPct: 1.4,
      cpuIowaitPct: 0.3,
      loadAvg: [0.3, 0.4, 0.4],
      memPct: 52,
      memUsedGb: 4.2,
      memCacheGb: 2.6,
      zfsArcGb: null,
      memFreeGb: 1.2,
      swapUsedGb: 0.4,
      swapTotalGb: 2,
    },
    banner: null,
    sensors: [],
    disks: [],
    virtualization: null,
    hints: [
      {
        serverId: id,
        kind: 'system.updates',
        severity: 'info',
        entity: 'apt',
        title: '12 updates waiting',
        detail: '2 security updates',
        section: 'system',
      },
    ],
    alerts: [
      {
        id: 'al_falcon_srv',
        serverId: id,
        severity: 'warning',
        title: 'Disk “srv” full in about 3 weeks',
        detail: 'At the rate it filled last week',
        openedAt: new Date(now - 2 * DAY).toISOString(),
        rule: 'disk.full_soon',
        state: 'open',
        section: 'storage',
        acknowledged: null,
        muted: false,
        attention: true,
      },
    ],
    health: {
      volumes: [
        volume('fs:/', '/', 31, 76),
        volume('fs:/srv', '/srv', 412, 500, { fullInDays: 22 }),
        volume('fs:/boot/efi', '/boot/efi', 0.01, 0.5),
      ],
      network: [
        {
          name: 'eth0',
          kind: 'ethernet',
          up: true,
          carrier: true,
          speedMbps: 1000,
          mtu: 1500,
          addresses: ['203.0.113.44/32'],
          master: null,
          members: [],
          rxMbps: 3.1,
          txMbps: 1.4,
          errors: 0,
          drops: 0,
        },
      ],
    },
    workloads: {},
  };
  const curves: Record<string, Curve> = {
    cpu_pct: curve(81, 5, { day: 3, peak: 6, jitter: 2, max: 100 }),
    mem_pct: curve(82, 50, { day: 2, peak: 1, jitter: 1, max: 100 }),
    load1: curve(83, 0.3, { day: 0.2, peak: 0.3, jitter: 0.1 }),
    swap_pct: curve(84, 20, { jitter: 1 }),
    net_rx_mbps: curve(85, 2, { day: 3, peak: 5, jitter: 1 }),
    net_tx_mbps: curve(86, 1, { day: 2, peak: 40, jitter: 0.5 }),
    disk_read_mbs: curve(87, 0.4, { day: 0.5, peak: 6, jitter: 0.3 }),
    disk_write_mbs: curve(88, 1.1, { day: 1, peak: 12, jitter: 0.5 }),
    'vol_pct:fs:/': growing(40.8, 0, now),
    'vol_pct:fs:/srv': growing(82.4, 0.8, now),
  };
  return withSeries(id, detail, curves, now, []);
}

/* raspi: a Docker host -------------------------------------------------------------------------------------- */

function raspi(now: number): DashboardFixture {
  const id = 'raspi';
  const docker = [
    { id: 'homebridge', name: 'homebridge', kind: 'container' as const, cpu: 3.2, mem: 0.3, limit: null },
    { id: 'adguard', name: 'adguard', kind: 'container' as const, cpu: 1.4, mem: 0.1, limit: null },
    { id: 'uptime-kuma', name: 'uptime-kuma', kind: 'container' as const, cpu: 0.9, mem: 0.2, limit: null },
    { id: 'node-red', name: 'node-red', kind: 'container' as const, cpu: 0.6, mem: 0.2, limit: null },
    { id: 'old-test', name: 'old-test', kind: 'container' as const, on: false, limit: null },
  ].map((g, i) => ({ ...guest(id, 'docker', g, i), image: `${g.name}:latest` }));
  const detail: HostServerDetail = {
    asOf: new Date(now).toISOString(),
    server: info(
      {
        id,
        platform: 'standard',
        roles: ['docker-host'],
        os: { name: 'Debian GNU/Linux', version: '12', kernel: '6.6.51+rpt-rpi-2712' },
        cpu: { model: 'Cortex-A76', cores: 4, threads: 4 },
        memory: { totalGb: 8, type: 'LPDDR4X' },
        address: '10.100.0.60',
      },
      now,
      18.6,
    ),
    live: {
      refreshIntervalS: 10,
      cpuPct: 8,
      cpuUserPct: 5.5,
      cpuSystemPct: 2.1,
      cpuIowaitPct: 0.4,
      loadAvg: [0.4, 0.5, 0.5],
      memPct: 22,
      memUsedGb: 1.8,
      memCacheGb: 3.1,
      zfsArcGb: null,
      memFreeGb: 3.2,
      swapUsedGb: 0,
      swapTotalGb: 0.5,
    },
    banner: null,
    sensors: [sensor('cpu_package', 'CPU', 'cpu', 52, 85, 'cpu_thermal')],
    disks: [],
    virtualization: null,
    hints: [],
    alerts: [],
    health: { volumes: [volume('fs:/', '/', 22, 58)], network: [] },
    workloads: { docker: workload(docker) },
  };
  const curves: Record<string, Curve> = {
    cpu_pct: curve(91, 6, { day: 3, peak: 4, jitter: 2, max: 100 }),
    mem_pct: curve(92, 21, { day: 1, peak: 1, jitter: 0.5, max: 100 }),
    load1: curve(93, 0.4, { day: 0.2, jitter: 0.1 }),
    swap_pct: curve(94, 0, {}),
    net_rx_mbps: curve(95, 1.5, { day: 2, peak: 1, jitter: 0.6 }),
    net_tx_mbps: curve(96, 0.6, { day: 1, peak: 1, jitter: 0.3 }),
    disk_read_mbs: curve(97, 0.2, { day: 0.2, jitter: 0.1 }),
    disk_write_mbs: curve(98, 0.5, { day: 0.3, peak: 1, jitter: 0.2 }),
    temp_cpu_package_c: curve(99, 49, { day: 4, peak: 2, jitter: 1 }),
    'vol_pct:fs:/': growing(37.9, 0.01, now),
  };
  return withSeries(id, detail, curves, now, docker);
}

/* Putting it together ---------------------------------------------------------------------------------------- */

function withSeries(
  id: DashboardFixtureId,
  detail: HostServerDetail,
  curves: Record<string, Curve>,
  now: number,
  guests: readonly HostGuest[],
): DashboardFixture {
  const guestCurves = new Map(
    guests
      .filter((g) => g.state === 'running' || g.state === 'unhealthy')
      .map((g, i) => [
        g.id,
        {
          cpu_pct: curve(500 + i, (g.cpuPct ?? 1) * 0.8, {
            day: (g.cpuPct ?? 1) * 0.4,
            peak: (g.cpuPct ?? 1) * 1.5,
            jitter: Math.max(0.2, (g.cpuPct ?? 1) * 0.5),
            max: 100,
          }),
          mem_mb: curve(600 + i, g.memoryUsedMb ?? 256, { jitter: (g.memoryUsedMb ?? 256) * 0.05 }),
        } satisfies Record<string, Curve>,
      ]),
  );
  return {
    id,
    detail,
    series: (range, keys) => makeSeries(id, curves, now, range, keys),
    guestSeries: (guestId, range) => {
      const c = guestCurves.get(guestId);
      return makeSeries(id, c ?? {}, now, range, c ? undefined : ['cpu_pct', 'mem_mb'], guestId);
    },
  };
}

/**
 * John's servers for the dashboards (deterministic for a `now`): `pve-02`, `blackbox`, `the-titan`, `kvm-lab`,
 * `the-falcon` and `raspi`, each its page (`hosts.getServer`) and its history at any range.
 */
export function dashboardFixtures(now: number = Date.now()): DashboardFixtures {
  return {
    'pve-02': pve02(now),
    blackbox: blackbox(now),
    'the-titan': theTitan(now),
    'kvm-lab': kvmLab(now),
    'the-falcon': theFalcon(now),
    raspi: raspi(now),
  };
}

function isFixtureId(v: string | undefined, fx: DashboardFixtures): v is DashboardFixtureId {
  return !!v && Object.hasOwn(fx, v);
}

function guestsOf(d: HostServerDetail): HostGuest[] {
  return [
    ...(d.proxmox?.guests.vm?.guests ?? []),
    ...(d.proxmox?.guests.container?.guests ?? []),
    ...(d.workloads?.docker?.guests ?? []),
    ...(d.workloads?.incus?.guests ?? []),
    ...(d.workloads?.libvirt?.guests ?? []),
  ];
}

/**
 * The hosts routes for the dashboard fixtures' servers (`GET servers/<id>`, its `metrics` with `range` and `series`, a
 * guest's `metrics`, `GET guests?server=<id>`), null for anything else.
 */
export function dashboardFixtureAnswer(
  fx: DashboardFixtures,
  req: HostsFixtureRequest,
): HostsFixtureAnswer | null {
  if (req.method !== 'GET') return null;
  const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
  const range = (Object.hasOwn(GRID, req.query.range ?? '') ? req.query.range : '24h') as HostSeriesRange;
  if (seg[0] === 'guests' && seg.length === 1) {
    const id = req.query.server;
    if (!isFixtureId(id, fx)) return null;
    const all = guestsOf(fx[id].detail);
    const list = all.filter((g) => !req.query.state || g.state === req.query.state);
    return {
      status: 200,
      body: {
        guests: list,
        total: list.length,
        nextCursor: null,
        counts: {
          all: all.length,
          running: all.filter((g) => g.state === 'running').length,
          stopped: all.filter((g) => g.state === 'stopped').length,
          unhealthy: all.filter((g) => g.state === 'unhealthy').length,
        },
      },
    };
  }
  if (seg[0] !== 'servers' || !isFixtureId(seg[1], fx)) return null;
  const f = fx[seg[1]];
  if (seg.length === 2) return { status: 200, body: f.detail };
  if (seg.length === 3 && seg[2] === 'metrics') {
    const keys = req.query.series?.split(',').filter(Boolean);
    return { status: 200, body: f.series(range, keys?.length ? keys : undefined) };
  }
  if (seg.length === 5 && seg[2] === 'guests' && seg[4] === 'metrics' && seg[3])
    return { status: 200, body: f.guestSeries(seg[3], range) };
  return null;
}

/**
 * Wrap the hosts fixtures' handler (`createHostsFixtures(now).handle`) so the dashboard fixtures' servers answer from
 * here first (their page, history and guests); everything else passes on. `pve-02` and `blackbox` replace the main
 * world's pages of the same name while wrapped.
 */
export function withDashboardFixtures(
  next: (req: HostsFixtureRequest) => HostsFixtureAnswer | null,
  now: number = Date.now(),
): (req: HostsFixtureRequest) => HostsFixtureAnswer | null {
  const fx = dashboardFixtures(now);
  return (req) => dashboardFixtureAnswer(fx, req) ?? next(req);
}
