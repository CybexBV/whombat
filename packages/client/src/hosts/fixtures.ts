/**
 * The servers of the one-Whombat mock as a fixture world (AP-1340): thetitan, pve-01, pve-02 (running hot),
 * blackbox (its disk array failed) and the-falcon, with pve-02's guests, sensors and 24 hours of history as mock 2
 * draws them, Proxmox configurations with a change waiting for a restart, snapshots, backups, firewall rules and tasks,
 * and a server waiting to be added. Shapes are the contracts' (`Host*`), built from Rackoon's sample data and web
 * fixtures (`hosts/docs/handoff/sample-data`, `web/dev/fixtures`) and checked against the schemas in the tests.
 *
 * `createHostsFixtures(now)` answers the REST routes under `/burrows/:burrow/hosts` (reads and the changes, which
 * change the world: power, configuration with digests, snapshots, enrollments, alerts). Deterministic: no clock and
 * no randomness beyond a seeded generator. Not imported by production code (the web's fixture mode and tests only).
 */
import type {
  HostAlert,
  HostAsksFirst,
  HostBackupVolume,
  HostChoices,
  HostConsoleSession,
  HostFirewall,
  HostFleet,
  HostGuest,
  HostGuestConfig,
  HostGuestDetail,
  HostGuestPage,
  HostHint,
  HostPendingEnrollment,
  HostPlatformWorkload,
  HostRemoteControl,
  HostSensor,
  HostSeries,
  HostServer,
  HostServerDetail,
  HostServerSettings,
  HostSnapshot,
  HostsStatus,
  HostTask,
} from '@whombat/core/domain';
import { type MacFixtureContext, withMac } from './fixtures-mac';
import { withRp } from './fixtures-rp';
import { withSa } from './fixtures-sa';
import { withSi } from './fixtures-si';
import { withWaFixtures } from './fixtures-wa';
import { withWb } from './fixtures-wb';
import { handleWc } from './fixtures-wc';
import { withConsoleFixtures } from './fixtures-wd';
import { withWi } from './fixtures-wi';
import { withWindows } from './fixtures-windows';
import { withWq } from './fixtures-wq';
import { withWu } from './fixtures-wu';

export {
  DASHBOARD_FIXTURE_IDS,
  type DashboardFixture,
  type DashboardFixtureId,
  type DashboardFixtures,
  dashboardFixtureAnswer,
  dashboardFixtures,
  withDashboardFixtures,
} from './dashboard-fixtures';
export {
  type AgentUpdatesFixtureWorld,
  createAgentUpdatesFixtureWorld,
  FIXTURE_AGENT_NEW,
  FIXTURE_AGENT_OLD,
  withAgentUpdatesFixtures,
} from './fixtures-au';
export {
  FIND_MY_FIXTURE_BACKGROUND,
  FIND_MY_FIXTURE_READ_MS,
  FIND_MY_PEOPLE,
  type FindMyFixture,
} from './fixtures-findmy';
export {
  FIND_MY_CONNECTION_FIELDS,
  FIND_MY_CONNECTION_ID,
  FIND_MY_THING,
  findMyConnectionPage,
  findMyConnectionThing,
  findMyConnectionView,
} from './fixtures-findmy-connection';
export {
  createFindMyTimelineFixture,
  FIND_MY_TIMELINE_FIXTURE_PACE,
  FIND_MY_TIMELINE_FIXTURE_PEOPLE,
  type FindMyTimelineFixture,
} from './fixtures-findmy-timeline';
export {
  createMacFixture,
  MAC_LOOK_PNG_B64,
  MAC_SERVER,
  type MacFixture,
  type MacScenario,
  macFixtureListed,
  macScenario,
} from './fixtures-mac';
export { type HostsQuietFixtures, withQuietFixtures } from './fixtures-qn';
export { createUpdatesFixtureWorld, type UpdatesFixtureWorld, withUpdatesFixtures } from './fixtures-swu';
export { fixtureConsoleTarget } from './fixtures-wd';

const H = 3600_000;
const DAY = 24 * H;

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function round(v: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

const ALL_ON: HostRemoteControl = {
  console: true,
  power: true,
  hostShell: true,
  hostPower: true,
  manage: true,
  diagnose: true,
};

/* Guests -------------------------------------------------------------------------------------------- */

interface GuestSeed {
  vmid: number;
  name: string;
  kind: 'vm' | 'container';
  state: 'running' | 'stopped';
  cpu: number;
  memUsedGb: number;
  memGb: number;
  tags?: string[];
  pending?: number;
  image?: string;
}

/** pve-02's 23 guests: 6 VMs and 13 containers running (mock 2's busiest four first). */
const PVE02_GUESTS: GuestSeed[] = [
  {
    vmid: 140,
    name: 'cli-proxy-api',
    kind: 'container',
    state: 'running',
    cpu: 13.6,
    memUsedGb: 3.1,
    memGb: 4,
    tags: ['api'],
  },
  {
    vmid: 118,
    name: 'arnica-prod-nest-01',
    kind: 'vm',
    state: 'running',
    cpu: 9.2,
    memUsedGb: 3.8,
    memGb: 4,
    pending: 1,
    tags: ['prod'],
  },
  {
    vmid: 141,
    name: 'AgentDVR',
    kind: 'container',
    state: 'running',
    cpu: 8.7,
    memUsedGb: 1.2,
    memGb: 2,
    tags: ['cameras'],
  },
  {
    vmid: 131,
    name: 'homeassistant',
    kind: 'container',
    state: 'running',
    cpu: 2.4,
    memUsedGb: 1.9,
    memGb: 4,
    tags: ['home'],
  },
  {
    vmid: 119,
    name: 'arnica-prod-nest-02',
    kind: 'vm',
    state: 'running',
    cpu: 2.1,
    memUsedGb: 3.2,
    memGb: 4,
    tags: ['prod'],
  },
  {
    vmid: 120,
    name: 'k3s-master',
    kind: 'vm',
    state: 'running',
    cpu: 1.8,
    memUsedGb: 5.4,
    memGb: 8,
    tags: ['k3s'],
  },
  {
    vmid: 121,
    name: 'k3s-worker-1',
    kind: 'vm',
    state: 'running',
    cpu: 1.6,
    memUsedGb: 9.1,
    memGb: 16,
    tags: ['k3s'],
  },
  {
    vmid: 122,
    name: 'k3s-worker-2',
    kind: 'vm',
    state: 'running',
    cpu: 1.4,
    memUsedGb: 8.7,
    memGb: 16,
    tags: ['k3s'],
  },
  {
    vmid: 132,
    name: 'nextcloud',
    kind: 'container',
    state: 'running',
    cpu: 1.2,
    memUsedGb: 3.3,
    memGb: 4,
    tags: ['files'],
  },
  { vmid: 133, name: 'paperless', kind: 'container', state: 'running', cpu: 0.9, memUsedGb: 1.4, memGb: 2 },
  {
    vmid: 134,
    name: 'jellyfin',
    kind: 'container',
    state: 'running',
    cpu: 0.8,
    memUsedGb: 2.2,
    memGb: 6,
    tags: ['media'],
  },
  {
    vmid: 135,
    name: 'pihole',
    kind: 'container',
    state: 'running',
    cpu: 0.4,
    memUsedGb: 0.3,
    memGb: 0.5,
    tags: ['dns'],
  },
  { vmid: 136, name: 'unifi', kind: 'container', state: 'running', cpu: 0.7, memUsedGb: 1.1, memGb: 2 },
  {
    vmid: 137,
    name: 'mqtt',
    kind: 'container',
    state: 'running',
    cpu: 0.2,
    memUsedGb: 0.1,
    memGb: 0.5,
    tags: ['home'],
  },
  {
    vmid: 138,
    name: 'zigbee2mqtt',
    kind: 'container',
    state: 'running',
    cpu: 0.3,
    memUsedGb: 0.2,
    memGb: 0.5,
    tags: ['home'],
  },
  { vmid: 139, name: 'grafana', kind: 'container', state: 'running', cpu: 0.6, memUsedGb: 0.4, memGb: 1 },
  {
    vmid: 142,
    name: 'vaultwarden',
    kind: 'container',
    state: 'running',
    cpu: 0.1,
    memUsedGb: 0.1,
    memGb: 0.5,
  },
  { vmid: 143, name: 'gitea', kind: 'container', state: 'running', cpu: 0.5, memUsedGb: 0.6, memGb: 2 },
  { vmid: 123, name: 'win11-test', kind: 'vm', state: 'running', cpu: 0.9, memUsedGb: 6.2, memGb: 8 },
  { vmid: 124, name: 'old-wp-staging', kind: 'vm', state: 'stopped', cpu: 0, memUsedGb: 0, memGb: 2 },
  { vmid: 125, name: 'debian-template', kind: 'vm', state: 'stopped', cpu: 0, memUsedGb: 0, memGb: 2 },
  { vmid: 144, name: 'minecraft', kind: 'container', state: 'stopped', cpu: 0, memUsedGb: 0, memGb: 4 },
  { vmid: 145, name: 'test-ct', kind: 'container', state: 'stopped', cpu: 0, memUsedGb: 0, memGb: 1 },
];

function pveGuest(serverId: string, g: GuestSeed, now: number, i: number): HostGuest {
  const on = g.state === 'running';
  return {
    id: `pve:${g.vmid}`,
    serverId,
    serverOnline: true,
    name: g.name,
    platform: 'pve',
    kind: g.kind,
    image: g.kind === 'vm' ? 'Linux 6.x kernel' : 'debian-13-standard',
    state: g.state,
    vcpu: g.kind === 'vm' ? Math.max(2, Math.round(g.memGb / 2)) : 4,
    cpuPct: on ? g.cpu : null,
    memoryUsedMb: on ? Math.round(g.memUsedGb * 1024) : null,
    memoryLimitMb: Math.round(g.memGb * 1024),
    diskReadMbs: on ? round(g.cpu / 10) : null,
    diskWriteMbs: on ? round(g.cpu / 7) : null,
    netRxMbps: on ? round(g.cpu * 1.3) : null,
    netTxMbps: on ? round(g.cpu * 0.9) : null,
    snapshots: g.kind === 'vm' ? 2 : 1,
    uptimeS: on ? 23 * 86_400 - i * 7_200 : null,
    console: {
      available: on,
      protocols: g.kind === 'vm' ? ['vnc', 'serial'] : ['tty', 'shell'],
      defaultProtocol: g.kind === 'vm' ? 'vnc' : 'tty',
      resolution: g.kind === 'vm' ? '1280x800' : null,
      unavailable: g.kind === 'vm' ? { spice: 'Whombat shows VM screens over VNC.' } : undefined,
    },
    vmid: g.vmid,
    node: serverId,
    lastBackup: { result: 'ok', at: new Date(now - (i % 3) * DAY - 12 * H).toISOString() },
    addresses: on ? [`10.100.2.${g.vmid - 100}`] : [],
    tags: g.tags ?? [],
    pendingChanges: g.pending ?? 0,
    guestAgent: g.kind === 'vm' ? (on ? 'running' : null) : null,
    backupJob: true,
    haState: null,
  };
}

function workload(guests: HostGuest[]): HostPlatformWorkload {
  const running = guests.filter((g) => g.state === 'running' || g.state === 'unhealthy');
  return {
    running: running.length,
    total: guests.length,
    cpuPct: round(running.reduce((a, g) => a + (g.cpuPct ?? 0), 0)),
    memoryGb: round(running.reduce((a, g) => a + (g.memoryUsedMb ?? 0), 0) / 1024),
    guests,
  };
}

function dockerGuest(
  serverId: string,
  name: string,
  image: string,
  cpu: number,
  memMb: number,
  state: HostGuest['state'],
  i: number,
): HostGuest {
  const on = state === 'running' || state === 'unhealthy';
  return {
    id: `docker:${name}`,
    serverId,
    serverOnline: true,
    name,
    platform: 'docker',
    kind: 'container',
    image,
    state,
    cpuPct: on ? cpu : null,
    memoryUsedMb: on ? memMb : null,
    memoryLimitMb: null,
    uptimeS: on ? 6 * 86_400 + i * 3_600 : null,
    console: { available: on, protocols: ['shell', 'logs'], defaultProtocol: 'shell' },
    restarts: 0,
    tags: [],
    updateAvailable: i % 5 === 0,
  };
}

/* Servers ------------------------------------------------------------------------------------------- */

interface ServerSeed {
  id: string;
  os: string;
  osName: string;
  osVersion: string;
  cpuModel: string;
  cores: number;
  threads: number;
  cpu: number;
  memUsed: number;
  memTotal: number;
  temp: number;
  limit: number;
  status: HostServer['status'];
  note?: string;
  storageUsedTb: number;
  storageTb: number;
  platform: HostServer['platform'];
  seed: number;
  uptimeDays: number;
  address: string;
}

const SERVERS: ServerSeed[] = [
  {
    id: 'thetitan',
    os: 'Debian 13',
    osName: 'Debian GNU/Linux',
    osVersion: '13',
    cpuModel: 'Threadripper 9970X',
    cores: 32,
    threads: 64,
    cpu: 4,
    memUsed: 78,
    memTotal: 188,
    temp: 49,
    limit: 85,
    status: 'ok',
    storageUsedTb: 3.1,
    storageTb: 8,
    platform: 'standard',
    seed: 13,
    uptimeDays: 41,
    address: '10.100.1.10',
  },
  {
    id: 'pve-01',
    os: 'Proxmox VE 9.2.11',
    osName: 'Proxmox VE',
    osVersion: '9.2.11',
    cpuModel: 'Core i9-13900H',
    cores: 14,
    threads: 20,
    cpu: 1,
    memUsed: 3,
    memTotal: 94,
    temp: 51,
    limit: 82,
    status: 'ok',
    storageUsedTb: 0.4,
    storageTb: 2,
    platform: 'proxmox',
    seed: 7,
    uptimeDays: 23,
    address: '10.100.1.21',
  },
  {
    id: 'pve-02',
    os: 'Proxmox VE 9.2.11',
    osName: 'Proxmox VE',
    osVersion: '9.2.11',
    cpuModel: 'Ryzen AI MAX+ PRO',
    cores: 16,
    threads: 32,
    cpu: 10,
    memUsed: 76,
    memTotal: 118,
    temp: 75,
    limit: 85,
    status: 'warn',
    note: 'running hot',
    storageUsedTb: 0.871,
    storageTb: 2,
    platform: 'proxmox',
    seed: 5,
    uptimeDays: 23,
    address: '10.100.1.22',
  },
  {
    id: 'blackbox',
    os: 'Unraid 7.3',
    osName: 'Unraid',
    osVersion: '7.3',
    cpuModel: 'Xeon W-1250',
    cores: 6,
    threads: 12,
    cpu: 11,
    memUsed: 14,
    memTotal: 63,
    temp: 61,
    limit: 90,
    status: 'bad',
    note: 'disk array failed',
    storageUsedTb: 21.4,
    storageTb: 36,
    platform: 'standard',
    seed: 3,
    uptimeDays: 96,
    address: '10.100.1.30',
  },
  {
    id: 'the-falcon',
    os: 'Debian 13',
    osName: 'Debian GNU/Linux',
    osVersion: '13',
    cpuModel: 'Ryzen 9 9950X3D',
    cores: 16,
    threads: 32,
    cpu: 1,
    memUsed: 14,
    memTotal: 92,
    temp: 65,
    limit: 100,
    status: 'ok',
    storageUsedTb: 1.2,
    storageTb: 4,
    platform: 'standard',
    seed: 11,
    uptimeDays: 9,
    address: '10.100.1.40',
  },
];

const PVE01_GUESTS: GuestSeed[] = [
  {
    vmid: 101,
    name: 'backup-proxy',
    kind: 'container',
    state: 'running',
    cpu: 0.6,
    memUsedGb: 0.4,
    memGb: 1,
  },
  ...Array.from(
    { length: 34 },
    (_, i): GuestSeed => ({
      vmid: 200 + i,
      name: i < 6 ? `lab-vm-${i + 1}` : `template-${i - 5}`,
      kind: i < 6 ? 'vm' : 'container',
      state: 'stopped',
      cpu: 0,
      memUsedGb: 0,
      memGb: 2,
    }),
  ),
];

/** thetitan's 54 guests: 33 running (Docker and Incus). */
function thetitanGuests(): HostGuest[] {
  const names = [
    'postgres',
    'redis',
    'whombat-dev',
    'buildkite',
    'minio',
    'traefik',
    'loki',
    'prometheus',
    'code-server',
    'ollama',
    'registry',
  ];
  const out: HostGuest[] = [];
  for (let i = 0; i < 40; i++) {
    const name = i < names.length ? (names[i] ?? `svc-${i}`) : `svc-${i}`;
    out.push(
      dockerGuest(
        'thetitan',
        name,
        `${name}:latest`,
        round(2.5 / (i + 1), 1),
        120 + i * 37,
        i < 28 ? 'running' : 'stopped',
        i,
      ),
    );
  }
  for (let i = 0; i < 14; i++) {
    const on = i < 5;
    out.push({
      ...dockerGuest(
        'thetitan',
        `incus-${i + 1}`,
        'images:debian/13',
        on ? 0.4 : 0,
        512,
        on ? 'running' : 'stopped',
        i,
      ),
      id: `incus:incus-${i + 1}`,
      platform: 'incus',
      kind: i < 2 ? 'vm' : 'container',
      console: { available: on, protocols: ['shell'], defaultProtocol: 'shell' },
    });
  }
  return out;
}

function blackboxGuests(): HostGuest[] {
  const names = [
    'plex',
    'sonarr',
    'radarr',
    'sabnzbd',
    'nginx-proxy',
    'syncthing',
    'immich',
    'immich-db',
    'photoprism',
    'duplicati',
    'tautulli',
    'overseerr',
    'prowlarr',
  ];
  const out = names.map((n, i) =>
    dockerGuest('blackbox', n, `lscr.io/linuxserver/${n}`, round(3 / (i + 1)), 200 + i * 80, 'running', i),
  );
  for (let i = 0; i < 8; i++)
    out.push(dockerGuest('blackbox', `old-${i + 1}`, 'busybox', 0, 0, 'stopped', i + 20));
  return out;
}

/* History ------------------------------------------------------------------------------------------- */

const POINTS = 96;

function curve(seed: number, n: number, base: number, amp: number, shape: (t: number) => number): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, k) => {
    const t = k / (n - 1);
    return round(shape(t) * amp + base + (r() - 0.5) * amp * 0.35);
  });
}

/**
 * pve-02's CPU package over 24 h as mock 2 draws it: around 60 °C, warm (above 72 °C) from the evening on, 75 °C now.
 */
function pve02Temp(): number[] {
  const r = rng(21);
  return Array.from({ length: POINTS }, (_, k) => {
    const t = k / (POINTS - 1);
    const noise = (r() - 0.5) * 2.4;
    if (t < 0.12) return round(60 + noise * 1.5);
    if (t < 0.28) return round(60 + ((t - 0.12) / 0.16) * 15 + noise);
    return round(Math.max(73, 75.5 + 1.2 * Math.sin(t * 30) + noise));
  }).map((v, i, a) => (i === a.length - 1 ? 75 : v));
}

function seriesFor(serverId: string, keys: readonly string[], now: number, range: string): HostSeries {
  const s = SERVERS.find((x) => x.id === serverId) ?? SERVERS[0];
  const span = RANGE_MS[range] ?? DAY;
  const n = range === '1h' ? 60 : POINTS;
  const step = span / n;
  const timestamps = Array.from({ length: n }, (_, k) => new Date(now - (n - 1 - k) * step).toISOString());
  const series: Record<string, (number | null)[]> = {};
  const seed = s?.seed ?? 1;
  for (const key of keys) {
    if (serverId === 'pve-02' && (key === 'temp_cpu_package_c' || key === 'temp_max_c') && range === '24h')
      series[key] = pve02Temp();
    else if (key.startsWith('temp_')) {
      const t = key === 'temp_max_c' || key.includes('cpu') ? (s?.temp ?? 50) : (s?.temp ?? 50) - 15;
      series[key] = curve(seed + key.length, n, t - 4, 6, (x) => 0.5 + 0.5 * Math.sin(x * 8 + seed));
    } else if (key === 'cpu_pct')
      series[key] = curve(
        seed,
        n,
        (s?.cpu ?? 5) * 0.6,
        (s?.cpu ?? 5) * 0.9 + 1,
        (x) => 0.5 + 0.5 * Math.sin(x * 9 + seed),
      );
    else if (key === 'mem_pct')
      series[key] = curve(seed + 1, n, ((s?.memUsed ?? 1) / (s?.memTotal ?? 1)) * 100 - 2, 4, (x) => x);
    else if (key.startsWith('net_'))
      series[key] = curve(seed + 2, n, 20, 40, (x) => 0.5 + 0.5 * Math.sin(x * 12));
    else if (key === 'load1') series[key] = curve(seed + 3, n, 1, 2, (x) => 0.5 + 0.5 * Math.sin(x * 9));
    else if (key === 'mem_mb') series[key] = curve(seed + 4, n, 3000, 400, (x) => x);
    else series[key] = curve(seed + 5, n, 5, 10, (x) => 0.5 + 0.5 * Math.sin(x * 7));
  }
  return {
    serverId,
    range: range as HostSeries['range'],
    stepSeconds: Math.round(step / 1000),
    asOf: new Date(now).toISOString(),
    timestamps,
    series,
  };
}

const RANGE_MS: Record<string, number> = {
  '1h': H,
  '6h': 6 * H,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
};

/* The world ----------------------------------------------------------------------------------------- */

export interface HostsFixtureWorld {
  status: HostsStatus;
  servers: HostServer[];
  details: Map<string, HostServerDetail>;
  guests: Map<string, HostGuest[]>;
  configs: Map<string, HostGuestConfig>;
  snapshots: Map<string, HostSnapshot[]>;
  backups: HostBackupVolume[];
  firewall: Map<string, HostFirewall>;
  tasks: Map<string, HostTask[]>;
  alerts: HostAlert[];
  hints: HostHint[];
  enrollments: HostPendingEnrollment[];
  settings: Map<string, HostServerSettings>;
  /** “Asks you first” per server, kept by Whombat (server-asks.md SA-04; `fixtures-sa.ts`): absent is `risky`. */
  asks: Map<string, HostAsksFirst>;
  /** The names people gave servers, kept by Whombat (`fixtures-sa.ts`): absent goes by its id. */
  names: Map<string, string>;
}

function sensorsFor(s: ServerSeed): HostSensor[] {
  const out: HostSensor[] = [
    {
      id: 'cpu_package',
      label: 'CPU package',
      group: 'cpu',
      source:
        s.cpuModel.startsWith('Core') || s.cpuModel.startsWith('Xeon')
          ? 'coretemp · Package id 0'
          : 'k10temp · Tctl',
      nowC: s.temp,
      maxC: s.temp + 4,
      limitC: s.limit,
    },
    {
      id: 'nvme0',
      label: 'NVMe, hottest',
      group: 'disk',
      source: 'nvme0n1 · composite',
      nowC: s.temp - 23,
      maxC: s.temp - 17,
      limitC: 75,
    },
    {
      id: 'board',
      label: 'Board',
      group: 'board',
      source: 'acpitz',
      nowC: s.temp - 27,
      maxC: s.temp - 25,
      limitC: 90,
    },
    {
      id: 'dimm',
      label: 'Memory modules',
      group: 'memory',
      source: 'spd5118 · 2 sensors',
      nowC: s.temp - 29,
      maxC: s.temp - 27,
      limitC: 85,
    },
  ];
  return out;
}

function serverRow(s: ServerSeed, guests: HostGuest[], now: number): HostServer {
  const running = guests.filter((g) => g.state === 'running' || g.state === 'unhealthy').length;
  const byPlatform = new Map<string, { running: number; total: number }>();
  for (const g of guests) {
    const c = byPlatform.get(g.platform) ?? { running: 0, total: 0 };
    c.total++;
    if (g.state === 'running' || g.state === 'unhealthy') c.running++;
    byPlatform.set(g.platform, c);
  }
  const cpu24 = curve(s.seed, 48, s.cpu * 0.6, s.cpu * 0.9 + 1, (t) => 0.5 + 0.5 * Math.sin(t * 9 + s.seed));
  void running;
  return {
    id: s.id,
    name: s.id,
    group: 'Home lab',
    status: s.status,
    statusNote: s.note ?? null,
    platform: s.platform,
    os: s.os,
    cpu: { model: s.cpuModel, cores: s.cores, threads: s.threads },
    uptimeS: s.uptimeDays * 86_400 + 4 * 3_600,
    cpuPct: s.cpu,
    memory: { usedPct: round((s.memUsed / s.memTotal) * 100, 0), usedGb: s.memUsed, totalGb: s.memTotal },
    storage: {
      usedPct: round((s.storageUsedTb / s.storageTb) * 100, 0),
      usedTb: s.storageUsedTb,
      capacityTb: s.storageTb,
    },
    temperature: { maxC: s.temp, limitC: s.limit },
    diskWearMaxPct: s.id === 'blackbox' ? 34 : 6,
    guests: [...byPlatform.entries()].map(([platform, c]) => ({
      platform: platform as HostGuest['platform'],
      running: c.running,
      total: c.total,
    })),
    agent: { version: '0.16.0', connected: true },
    lastSeen: new Date(now - 4_000).toISOString(),
    cpu24h: cpu24,
    remoteControl: ALL_ON,
    alerts: { critical: s.status === 'bad' ? 1 : 0, warning: 0 },
    maintenance: null,
    parent: null,
  };
}

function detailFor(
  s: ServerSeed,
  guests: HostGuest[],
  now: number,
  alerts: HostAlert[],
  hints: HostHint[],
): HostServerDetail {
  const proxmox = s.platform === 'proxmox';
  const vms = guests.filter((g) => g.platform === 'pve' && g.kind === 'vm');
  const cts = guests.filter((g) => g.platform === 'pve' && g.kind === 'container');
  const docker = guests.filter((g) => g.platform === 'docker');
  const incus = guests.filter((g) => g.platform === 'incus');
  const tasks: HostTask[] = proxmox
    ? [
        {
          id: `UPID:${s.id}:0001:vzdump`,
          type: 'vzdump',
          platform: 'pve',
          guestId: null,
          node: s.id,
          user: 'whombat@pve',
          started: new Date(now - 12 * H).toISOString(),
          ended: new Date(now - 11.7 * H).toISOString(),
          status: 'ok',
          message: 'Backup of 23 guests',
        },
        {
          id: `UPID:${s.id}:0002:qmigrate`,
          type: 'qmigrate',
          platform: 'pve',
          guestId: 'pve:119',
          node: s.id,
          user: 'john@pam',
          started: new Date(now - 2 * DAY).toISOString(),
          ended: new Date(now - 2 * DAY + 70_000).toISOString(),
          status: 'ok',
        },
      ]
    : [];
  return {
    asOf: new Date(now).toISOString(),
    server: {
      id: s.id,
      group: 'Home lab',
      status: s.status,
      statusNote: s.note ?? null,
      roles: proxmox ? ['proxmox-node', 'kvm-host'] : docker.length ? ['docker-host'] : [],
      os: { name: s.osName, version: s.osVersion, kernel: proxmox ? '6.14.11-2-pve' : '6.12.48-amd64' },
      cpu: { model: s.cpuModel, cores: s.cores, threads: s.threads },
      memory: { totalGb: s.memTotal, type: 'DDR5' },
      uptimeS: s.uptimeDays * 86_400 + 4 * 3_600,
      lastBoot: new Date(now - s.uptimeDays * DAY).toISOString(),
      address: s.address,
      location: 'Office rack',
      agent: { version: '0.16.0', lastSyncSAgo: 4, connected: true, clockSkewS: 0 },
      platform: s.platform,
      remoteControl: ALL_ON,
      collectors: [
        { name: 'sensors', ok: true },
        { name: 'smart', ok: true },
      ],
      maintenance: null,
      parent: null,
    },
    live: {
      refreshIntervalS: 10,
      cpuPct: s.cpu,
      cpuUserPct: round(s.cpu * 0.7),
      cpuSystemPct: round(s.cpu * 0.25),
      cpuIowaitPct: round(s.cpu * 0.05),
      loadAvg: [round(s.cpu / 3), round(s.cpu / 3.2), round(s.cpu / 3.5)],
      memPct: round((s.memUsed / s.memTotal) * 100, 0),
      memUsedGb: s.memUsed,
      memCacheGb: round(s.memTotal * 0.12),
      zfsArcGb: proxmox ? round(s.memTotal * 0.08) : null,
      memFreeGb: s.memTotal - s.memUsed,
      swapUsedGb: 0,
      swapTotalGb: 8,
    },
    banner:
      s.status === 'bad'
        ? {
            severity: 'critical',
            title: 'The disk array has failed',
            detail:
              'Both parity drives dropped out 3 days ago. Your files are still there, but nothing protects them now.',
            section: 'storage',
          }
        : null,
    sensors: sensorsFor(s),
    disks: [
      {
        device: 'nvme0n1',
        type: 'nvme',
        model: 'Samsung 990 PRO 2TB',
        role: proxmox ? undefined : 'system',
        pool: proxmox ? 'rpool' : undefined,
        capacityGb: 2000,
        usedGb: round(s.storageUsedTb * 1000 * 0.6, 0),
        wearPct: 6,
        writtenTb: 41,
        ratedTbw: 1200,
        tempC: s.temp - 23,
        powerOnHours: 9_870,
        health: 'healthy',
        smart: { passed: true, mediaErrors: 0, unsafeShutdowns: 3, sparePct: 100, spareThreshold: 10 },
      },
      ...(s.id === 'blackbox'
        ? [
            {
              device: 'sdb',
              type: 'hdd' as const,
              model: 'WDC WD180EDGZ',
              role: 'parity',
              capacityGb: 18000,
              usedGb: null,
              wearPct: null,
              tempC: null,
              health: 'failing' as const,
              healthReason: 'Dropped out of the array',
              smart: { passed: false, reallocated: 412, pending: 18 },
            },
            {
              device: 'sdc',
              type: 'hdd' as const,
              model: 'WDC WD180EDGZ',
              role: 'parity',
              capacityGb: 18000,
              usedGb: null,
              wearPct: null,
              tempC: null,
              health: 'failing' as const,
              healthReason: 'Dropped out of the array',
              smart: { passed: false, reallocated: 96, pending: 4 },
            },
            {
              device: 'sdd',
              type: 'hdd' as const,
              model: 'WDC WD180EDGZ',
              role: 'data',
              capacityGb: 18000,
              usedGb: 10700,
              wearPct: null,
              tempC: 38,
              health: 'healthy' as const,
              smart: { passed: true },
            },
            {
              device: 'sde',
              type: 'hdd' as const,
              model: 'WDC WD180EDGZ',
              role: 'data',
              capacityGb: 18000,
              usedGb: 10700,
              wearPct: null,
              tempC: 39,
              health: 'healthy' as const,
              smart: { passed: true },
            },
          ]
        : []),
    ],
    virtualization: proxmox
      ? {
          stacks: ['proxmox'],
          capabilities: {
            kvm: {
              enabled: true,
              module: s.cpuModel.startsWith('Core') ? 'kvm_intel' : 'kvm_amd',
              device: '/dev/kvm',
            },
            cpuVirtualization: {
              type: s.cpuModel.startsWith('Core') ? 'VT-x' : 'AMD-V',
              flag: s.cpuModel.startsWith('Core') ? 'vmx' : 'svm',
              nestedPaging: true,
            },
            iommu: { enabled: true, groups: 24, vfioPciDevices: 0 },
            nested: { enabled: true, moduleParam: 'nested=1' },
            ksm: { savedGb: 4.2 },
            ballooning: {
              state: 'active',
              vmsActive: vms.filter((g) => g.state === 'running').length,
              vmsTotal: vms.length,
            },
          },
          allocation: {
            vcpuAllocated: s.id === 'pve-02' ? 52 : 8,
            hostThreads: s.threads,
            vcpuOvercommitRatio: s.id === 'pve-02' ? 1.63 : 0.4,
            guestMemoryAssignedGb: s.id === 'pve-02' ? 96 : 6,
            hostMemoryGb: s.memTotal,
            guestMemoryInUseGb: s.id === 'pve-02' ? 70 : 2,
            diskIoMbs: { total: 18, read: 6, write: 12 },
            networkMbps: { total: 64, rx: 41, tx: 23 },
          },
        }
      : null,
    hints: hints.filter((h) => h.serverId === s.id),
    alerts: alerts.filter((a) => a.serverId === s.id),
    health: {
      system: {
        packageManager: proxmox || s.osName.startsWith('Debian') ? 'apt' : null,
        updates: s.id === 'pve-01' ? 0 : s.id === 'blackbox' ? null : 4,
        securityUpdates: s.id === 'pve-01' ? 0 : s.id === 'blackbox' ? null : 1,
        updatesCheckedAt: new Date(now - 3 * H).toISOString(),
        updatesError: null,
        rebootRequired: false,
        rebootReason: null,
        initSystem: 'systemd',
        failedCount: s.id === 'blackbox' ? 1 : 0,
        failedUnits: s.id === 'blackbox' ? ['mdcmd-check.service'] : [],
        timeSynced: true,
        timeOffsetMs: 2,
        timeSource: 'chrony',
        oomKills: 0,
        processes: 400 + guests.length * 18,
        stealPct: 0,
        pressure: { cpu: round(s.cpu / 10), memory: 0.1, memoryFull: 0, io: 0.4, ioFull: 0.1 },
      },
      network: [
        {
          name: proxmox ? 'vmbr0' : 'br0',
          kind: 'bridge',
          up: true,
          carrier: true,
          speedMbps: 10_000,
          mtu: 1500,
          addresses: [`${s.address}/24`],
          master: null,
          members: ['enp1s0'],
          rxMbps: 41,
          txMbps: 23,
          errors: 0,
          drops: 0,
        },
        {
          name: 'enp1s0',
          kind: 'ethernet',
          up: true,
          carrier: true,
          speedMbps: 10_000,
          mtu: 1500,
          addresses: [],
          master: proxmox ? 'vmbr0' : 'br0',
          members: [],
          rxMbps: 41,
          txMbps: 23,
          errors: 0,
          drops: 0,
        },
      ],
      volumes: proxmox
        ? [
            {
              entity: 'pool:rpool',
              kind: 'pool',
              label: 'rpool',
              usedGb: round(s.storageUsedTb * 1000, 0),
              totalGb: s.storageTb * 1000,
              usedPct: round((s.storageUsedTb / s.storageTb) * 100, 0),
              fullInDays: s.id === 'pve-02' ? 140 : null,
              health: 'ONLINE',
              layout: 'mirror',
              scrub: { state: 'finished', end: new Date(now - 4 * DAY).toISOString(), errors: 0 },
              errors: { read: 0, write: 0, checksum: 0 },
              fragPct: 12,
            },
            {
              entity: 'fs:/',
              kind: 'fs',
              label: '/',
              usedGb: 9,
              totalGb: 94,
              usedPct: 10,
              fullInDays: null,
              fsType: 'zfs',
              device: 'rpool/ROOT/pve-1',
            },
          ]
        : [
            {
              entity: 'fs:/',
              kind: 'fs',
              label: '/',
              usedGb: round(s.storageUsedTb * 1000, 0),
              totalGb: s.storageTb * 1000,
              usedPct: round((s.storageUsedTb / s.storageTb) * 100, 0),
              fullInDays: null,
              fsType: s.id === 'blackbox' ? 'xfs' : 'ext4',
              device: s.id === 'blackbox' ? '/dev/md1' : '/dev/nvme0n1p2',
            },
          ],
      arrays:
        s.id === 'blackbox'
          ? [
              {
                name: 'md1',
                level: 'unraid',
                state: 'degraded',
                devices: 4,
                active: 2,
                members: ['sdb', 'sdc', 'sdd', 'sde'],
                failed: ['sdb', 'sdc'],
                syncPct: null,
                sizeGb: 36_000,
                lastCheck: '2026-10-01',
                checkErrors: 0,
              },
            ]
          : [],
      ups: [],
      gpus:
        s.id === 'pve-02'
          ? [
              {
                index: 0,
                name: 'Radeon 8060S',
                vendor: 'amd',
                utilPct: 3,
                memUsedGb: 0.6,
                memTotalGb: 16,
                tempC: 58,
                powerW: 12,
              },
            ]
          : [],
      fans:
        s.id === 'thetitan'
          ? [
              { label: 'CPU fan', source: 'nct6799', rpm: 1180, minRpm: 300 },
              { label: 'Case fan 1', source: 'nct6799', rpm: 860, minRpm: 300 },
            ]
          : [],
      tasks,
      pveReplication: [],
      ceph: null,
    },
    workloads: proxmox
      ? undefined
      : // The contract's record is exhaustive (zod 4 `z.record` over an enum): every platform, empty when unused.
        { docker: workload(docker), incus: workload(incus), libvirt: workload([]) },
    proxmox: proxmox
      ? {
          cluster: {
            name: 'home',
            quorate: true,
            votes: { have: 2, expected: 2 },
            ha: { resourcesStarted: 0 },
            nodes: [
              {
                name: 'pve-01',
                thisNode: s.id === 'pve-01',
                status: 'online',
                cpuPct: 1,
                memPct: 3,
                vms: 6,
                containers: 29,
                agent: 'connected',
                serverId: 'pve-01',
              },
              {
                name: 'pve-02',
                thisNode: s.id === 'pve-02',
                status: 'online',
                cpuPct: 10,
                memPct: 64,
                vms: 8,
                containers: 15,
                agent: 'connected',
                serverId: 'pve-02',
              },
            ],
            note: null,
          },
          storages: [
            { id: 'local', type: 'dir', content: 'iso,vztmpl,backup', usedGb: 9, capacityGb: 94 },
            {
              id: 'local-zfs',
              type: 'zfspool',
              content: 'images,rootdir',
              usedGb: round(s.storageUsedTb * 1000, 0),
              capacityGb: s.storageTb * 1000,
            },
            { id: 'pbs', type: 'pbs', content: 'backup', usedGb: 1210, capacityGb: 4000 },
          ],
          backups: {
            lastJob: {
              at: new Date(now - 12 * H).toISOString(),
              schedule: 'daily 02:00',
              mode: 'snapshot',
              result: 'ok',
              guestsOk: guests.length,
              guestsTotal: guests.length,
              warnings: 0,
              writtenGb: 41,
              dedupRatio: 12.4,
              durationMin: 18,
              avgDurationMinWeek: 17,
            },
            nextRun: new Date(now + 12 * H).toISOString(),
            target: 'pbs',
          },
          guests: { vm: workload(vms), container: workload(cts) },
        }
      : undefined,
  };
}

function configFor(g: HostGuest): HostGuestConfig {
  const mem = String(g.memoryLimitMb ?? 2048);
  if (g.kind === 'vm') {
    const values: Record<string, string> = {
      name: g.name,
      memory: mem,
      balloon: String(Math.round((g.memoryLimitMb ?? 2048) / 2)),
      cores: String(g.vcpu ?? 2),
      sockets: '1',
      cpu: 'x86-64-v2-AES',
      bios: 'ovmf',
      machine: 'q35',
      scsihw: 'virtio-scsi-single',
      scsi0: `local-zfs:vm-${g.vmid}-disk-0,iothread=1,size=64G`,
      efidisk0: `local-zfs:vm-${g.vmid}-disk-1,efitype=4m,size=1M`,
      ide2: `local-zfs:vm-${g.vmid}-cloudinit,media=cdrom`,
      net0: `virtio=BC:24:11:3A:${String(g.vmid).slice(-2)}:01,bridge=vmbr0,firewall=1`,
      boot: 'order=scsi0;net0',
      onboot: '1',
      agent: '1',
      ostype: 'l26',
      tags: (g.tags ?? []).join(';'),
      ciuser: 'john',
      ipconfig0: 'ip=dhcp',
      nameserver: '10.100.1.1',
      sshkeys: 'ssh-ed25519%20AAAAC3NzaC1lZDI1NTE5AAAAIGq3mQq7Z9%20john%40thetitan%0A',
      description: g.name === 'arnica-prod-nest-01' ? 'Arnica production nest, first of two.' : '',
    };
    return {
      platform: 'pve',
      kind: 'vm',
      digest: `d${g.vmid}a`,
      running: g.state === 'running',
      values,
      pending: g.pendingChanges ? { memory: String(Number(mem) * 2) } : {},
      pendingDelete: [],
      disks: [
        {
          key: 'scsi0',
          storage: 'local-zfs',
          volume: `vm-${g.vmid}-disk-0`,
          sizeBytes: 64 * 1024 ** 3,
          media: 'disk',
          boot: true,
        },
        { key: 'ide2', storage: 'local-zfs', volume: `vm-${g.vmid}-cloudinit`, media: 'cdrom' },
      ],
      ha: null,
      replication: [],
    };
  }
  return {
    platform: 'pve',
    kind: 'container',
    digest: `d${g.vmid}c`,
    running: g.state === 'running',
    values: {
      hostname: g.name,
      memory: mem,
      swap: '512',
      cores: String(g.vcpu ?? 2),
      rootfs: `local-zfs:subvol-${g.vmid}-disk-0,size=16G`,
      net0: `name=eth0,bridge=vmbr0,hwaddr=BC:24:11:5C:${String(g.vmid).slice(-2)}:02,ip=dhcp,type=veth`,
      onboot: '1',
      features: 'nesting=1',
      unprivileged: '1',
      ostype: 'debian',
      arch: 'amd64',
      tags: (g.tags ?? []).join(';'),
      description: '',
    },
    pending: {},
    pendingDelete: [],
    disks: [
      {
        key: 'rootfs',
        storage: 'local-zfs',
        volume: `subvol-${g.vmid}-disk-0`,
        sizeBytes: 16 * 1024 ** 3,
        media: 'disk',
      },
    ],
    ha: null,
    replication: [],
  };
}

export function createHostsWorld(now: number): HostsFixtureWorld {
  const guests = new Map<string, HostGuest[]>([
    ['pve-02', PVE02_GUESTS.map((g, i) => pveGuest('pve-02', g, now, i))],
    ['pve-01', PVE01_GUESTS.map((g, i) => pveGuest('pve-01', g, now, i))],
    ['thetitan', thetitanGuests()],
    ['blackbox', blackboxGuests()],
    ['the-falcon', []],
  ]);
  const alerts: HostAlert[] = [
    {
      id: 'al_blackbox_array',
      serverId: 'blackbox',
      severity: 'critical',
      title: 'The disk array on blackbox has failed',
      detail:
        'Both parity drives dropped out 3 days ago. Your files are still there, but nothing protects them now.',
      openedAt: new Date(now - 3 * DAY).toISOString(),
      rule: 'array.degraded',
      state: 'open',
      section: 'storage',
      acknowledged: null,
      muted: false,
      attention: true,
    },
  ];
  const hints: HostHint[] = [
    {
      serverId: 'pve-02',
      kind: 'sensor.near_limit',
      severity: 'warning',
      entity: 'cpu_package',
      title: 'CPU package at 74 °C',
      detail: 'Limit 90 °C',
      section: 'sensors',
    },
    {
      serverId: 'pve-02',
      kind: 'system.updates',
      severity: 'info',
      entity: 'apt',
      title: '4 updates waiting',
      detail: '1 security update',
      section: 'system',
    },
  ];
  const details = new Map<string, HostServerDetail>();
  for (const s of SERVERS) details.set(s.id, detailFor(s, guests.get(s.id) ?? [], now, alerts, hints));
  const configs = new Map<string, HostGuestConfig>();
  const snapshots = new Map<string, HostSnapshot[]>();
  const firewall = new Map<string, HostFirewall>();
  const tasks = new Map<string, HostTask[]>();
  for (const [serverId, list] of guests) {
    for (const g of list) {
      if (g.platform !== 'pve') continue;
      const key = `${serverId}/${g.id}`;
      configs.set(key, configFor(g));
      snapshots.set(key, [
        {
          name: 'before-upgrade',
          created: new Date(now - 9 * DAY).toISOString(),
          description: 'Before the 9.2 upgrade',
          memory: false,
        },
        ...(g.kind === 'vm'
          ? [
              {
                name: 'weekly',
                created: new Date(now - 2 * DAY).toISOString(),
                parent: 'before-upgrade',
                description: '',
                memory: true,
              },
            ]
          : []),
        {
          name: 'current',
          current: true,
          parent: g.kind === 'vm' ? 'weekly' : 'before-upgrade',
          description: 'You are here',
        },
      ]);
      firewall.set(key, {
        options: { enable: '1', policy_in: 'DROP', policy_out: 'ACCEPT', log_level_in: 'nolog' },
        optionsDigest: `fo${g.vmid}`,
        rules: [
          {
            pos: 0,
            type: 'in',
            action: 'ACCEPT',
            enable: true,
            macro: 'SSH',
            source: '10.100.0.0/16',
            comment: 'SSH from home',
          },
          { pos: 1, type: 'in', action: 'ACCEPT', enable: true, proto: 'tcp', dport: '443', comment: 'Web' },
          {
            pos: 2,
            type: 'in',
            action: 'DROP',
            enable: false,
            proto: 'tcp',
            dport: '8080',
            comment: 'Old admin port',
          },
        ],
        rulesDigest: `fr${g.vmid}`,
        groups: ['webservers'],
        clusterEnabled: true,
      });
      tasks.set(key, [
        {
          id: `UPID:${serverId}:${g.vmid}:vzdump`,
          type: 'vzdump',
          platform: 'pve',
          guestId: g.id,
          node: serverId,
          user: 'whombat@pve',
          started: new Date(now - 12 * H).toISOString(),
          ended: new Date(now - 12 * H + 45_000).toISOString(),
          status: 'ok',
          message: 'Backed up',
        },
        {
          id: `UPID:${serverId}:${g.vmid}:start`,
          type: g.kind === 'vm' ? 'qmstart' : 'vzstart',
          platform: 'pve',
          guestId: g.id,
          node: serverId,
          user: 'john@pam',
          started: new Date(now - 23 * DAY).toISOString(),
          ended: new Date(now - 23 * DAY + 4_000).toISOString(),
          status: 'ok',
        },
      ]);
    }
  }
  const backups: HostBackupVolume[] = [];
  for (const g of guests.get('pve-02') ?? []) {
    for (let d = 0; d < 3; d++) {
      const at = new Date(now - (d * DAY + 12 * H));
      backups.push({
        volume: `pbs:backup/${g.kind === 'vm' ? 'vm' : 'ct'}/${g.vmid}/${at.toISOString().slice(0, 19)}Z`,
        storage: 'pbs',
        guest: String(g.vmid),
        kind: g.kind,
        sizeBytes: Math.round((g.memoryLimitMb ?? 1024) * 1024 * 1024 * (g.kind === 'vm' ? 6 : 1.4)),
        created: at.toISOString(),
        format: 'pbs-vm',
        notes: d === 0 ? `${g.name} nightly` : '',
        protected: d === 2 && g.vmid === 118,
        encrypted: true,
        verified: 'ok',
      });
    }
  }
  const servers = SERVERS.map((s) => serverRow(s, guests.get(s.id) ?? [], now));
  const settings = new Map<string, HostServerSettings>(
    SERVERS.map((s) => [
      s.id,
      {
        id: s.id,
        group: 'Home lab',
        location: 'Office rack',
        remoteControl: {
          console: true,
          power: true,
          hostShell: true,
          hostPower: true,
          manage: true,
          diagnose: true,
        },
        agentPolicy: {
          console: true,
          power: true,
          hostShell: true,
          hostPower: true,
          manage: true,
          diagnose: true,
        },
        parent: '',
        detectedParent: null,
        agent: {
          version: '0.16.0',
          arch: 'amd64',
          install: 'systemd',
          certExpiresAt: new Date(now + 300 * DAY).toISOString(),
          update: { available: false },
        },
      },
    ]),
  );
  return {
    status: {
      present: true,
      healthy: true,
      version: '0.16.0',
      agentUrl: 'wss://10.100.1.5:8443',
      servers: servers.length,
    },
    servers,
    details,
    guests,
    configs,
    snapshots,
    backups,
    firewall,
    tasks,
    alerts,
    hints,
    enrollments: [
      {
        id: 'enr_backup_pi',
        state: 'pending',
        hostname: 'backup-pi',
        os: 'Debian 13',
        address: '10.100.1.61',
        agentVersion: '0.16.0',
        requestedAt: new Date(now - 6 * 60_000).toISOString(),
        createdAt: new Date(now - 9 * 60_000).toISOString(),
        expiresAt: new Date(now + 50 * 60_000).toISOString(),
        serverId: null,
      },
    ],
    settings,
    asks: new Map(),
    names: new Map(),
  };
}

/* Requests ------------------------------------------------------------------------------------------ */

export interface HostsFixtureRequest {
  method: string;
  /** The path under `/burrows/:burrow/hosts` (`/servers/pve-02`). */
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
}

export interface HostsFixtureAnswer {
  status: number;
  body: unknown;
}

function problem(status: number, code: string, message: string): HostsFixtureAnswer {
  return {
    status,
    body: { error: { code: status === 404 ? 'not_found' : 'conflict', message, details: { code } } },
  };
}

const CHOICES: HostChoices = {
  platform: 'pve',
  node: 'pve-02',
  cluster: true,
  nextId: 146,
  storages: [
    {
      id: 'local',
      type: 'dir',
      content: ['iso', 'vztmpl', 'backup'],
      availBytes: 85 * 1024 ** 3,
      totalBytes: 94 * 1024 ** 3,
    },
    {
      id: 'local-zfs',
      type: 'zfspool',
      content: ['images', 'rootdir'],
      availBytes: 1129 * 1024 ** 3,
      totalBytes: 2000 * 1024 ** 3,
      thin: true,
    },
    {
      id: 'pbs',
      type: 'pbs',
      content: ['backup'],
      availBytes: 2790 * 1024 ** 3,
      totalBytes: 4000 * 1024 ** 3,
      shared: true,
    },
  ],
  bridges: ['vmbr0', 'vmbr1'],
  cpuTypes: ['host', 'x86-64-v2-AES', 'x86-64-v3', 'kvm64'],
  nodes: ['pve-01'],
  download: true,
};

/**
 * The hosts routes over the fixture world. `handle` answers a request under `/burrows/:burrow/hosts` or null (not a
 * route of its own); changes change the world, so a screen reads back what it did.
 */
export function createHostsFixtures(
  now: number = Date.now(),
  opts: {
    /** The Mac's scenario and whether it is in the fleet (default: `localStorage['whombat.fixtures.mac']`). */
    mac?: Pick<MacFixtureContext, 'listed' | 'scenario' | 'clock'>;
  } = {},
) {
  const world = createHostsWorld(now);
  let seq = 0;

  const findGuest = (serverId: string, guestId: string) =>
    world.guests.get(serverId)?.find((g) => g.id === guestId);
  const refreshServer = (serverId: string) => {
    const seed = SERVERS.find((s) => s.id === serverId);
    if (!seed) return;
    const list = world.guests.get(serverId) ?? [];
    world.details.set(serverId, detailFor(seed, list, now, world.alerts, world.hints));
    const at = world.servers.findIndex((s) => s.id === serverId);
    if (at >= 0)
      world.servers[at] = { ...serverRow(seed, list, now), status: world.servers[at]?.status ?? seed.status };
  };

  function guestDetail(_serverId: string, g: HostGuest): HostGuestDetail {
    return { ...g, remoteControl: ALL_ON, manageable: g.platform === 'pve' || g.platform === 'incus' };
  }

  function handle(req: HostsFixtureRequest): HostsFixtureAnswer | null {
    const wc = handleWc(req, world, now, refreshServer);
    if (wc) return wc;
    const { method, path, query, body } = req;
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
    const route = `${method} ${seg.map((s, i) => (i % 2 === 1 ? ':' : s)).join('/')}`;
    const [, a, , b, , c] = seg;
    switch (route) {
      case 'GET status':
        return { status: 200, body: { ...world.status, servers: world.servers.length } };
      case 'GET fleet': {
        const online = world.servers.filter((s) => s.status !== 'offline' && s.status !== 'pending');
        const fleet: HostFleet = {
          asOf: new Date(now).toISOString(),
          groups: [{ name: 'Home lab', count: world.servers.length }],
          kpis: {
            serversOnline: online.length,
            serversTotal: world.servers.length,
            cpuAvgPct: round(online.reduce((x, s) => x + (s.cpuPct ?? 0), 0) / Math.max(1, online.length)),
            memoryPct: 37,
            memoryUsedGb: world.servers.reduce((x, s) => x + (s.memory.usedGb ?? 0), 0),
            memoryTotalGb: world.servers.reduce((x, s) => x + (s.memory.totalGb ?? 0), 0),
            storageUsedTb: round(world.servers.reduce((x, s) => x + (s.storage.usedTb ?? 0), 0)),
            storageTotalTb: world.servers.reduce((x, s) => x + (s.storage.capacityTb ?? 0), 0),
            storagePct: 51,
            disksOver75Wear: 0,
            openAlerts: world.alerts.filter((x) => x.state === 'open').length,
            openAlertsCritical: world.alerts.filter((x) => x.state === 'open' && x.severity === 'critical')
              .length,
            openAlertsWarning: world.alerts.filter((x) => x.state === 'open' && x.severity === 'warning')
              .length,
          },
          servers: world.servers,
          alerts: world.alerts,
          hints: world.hints,
          agentsConnected: world.servers.length,
          pendingEnrollments: world.enrollments.filter((e) => e.state === 'pending').length,
        };
        return { status: 200, body: fleet };
      }
      case 'GET servers/:': {
        const d = a ? world.details.get(a) : undefined;
        return d
          ? { status: 200, body: d }
          : problem(404, 'server_not_found', `There’s no server called ${a}.`);
      }
      case 'GET servers/:/metrics': {
        if (!a || !world.details.has(a)) return problem(404, 'server_not_found', 'That server isn’t there.');
        const keys = (query.series ?? 'cpu_pct,mem_pct,temp_max_c').split(',').filter(Boolean);
        return { status: 200, body: seriesFor(a, keys, now, query.range ?? '24h') };
      }
      case 'GET servers/:/settings': {
        const s = a ? world.settings.get(a) : undefined;
        return s ? { status: 200, body: s } : problem(404, 'server_not_found', 'That server isn’t there.');
      }
      case 'PATCH servers/:': {
        const s = a ? world.settings.get(a) : undefined;
        if (!a || !s) return problem(404, 'server_not_found', 'That server isn’t there.');
        const patch = body as {
          group?: string;
          location?: string;
          remoteControl?: Partial<HostServerSettings['remoteControl']>;
        };
        const next = {
          ...s,
          ...(patch.group ? { group: patch.group } : {}),
          ...(patch.location !== undefined ? { location: patch.location } : {}),
          remoteControl: { ...s.remoteControl, ...patch.remoteControl },
        };
        world.settings.set(a, next);
        return { status: 200, body: next };
      }
      case 'DELETE servers/:': {
        world.servers = world.servers.filter((s) => s.id !== a);
        return { status: 200, body: { ok: true } };
      }
      case 'POST servers/:/actions':
        return { status: 202, body: { actionId: `act_${++seq}` } };
      case 'GET guests': {
        const all = query.server ? (world.guests.get(query.server) ?? []) : [...world.guests.values()].flat();
        const list = all.filter((g) => !query.state || g.state === query.state);
        const page: HostGuestPage = {
          guests: list,
          total: list.length,
          nextCursor: null,
          counts: {
            all: all.length,
            running: all.filter((g) => g.state === 'running').length,
            stopped: all.filter((g) => g.state === 'stopped').length,
            unhealthy: all.filter((g) => g.state === 'unhealthy').length,
          },
        };
        return { status: 200, body: page };
      }
      case 'GET servers/:/guests/:': {
        const g = a && b ? findGuest(a, b) : undefined;
        return g && a
          ? { status: 200, body: guestDetail(a, g) }
          : problem(404, 'guest_not_found', 'That guest isn’t there.');
      }
      case 'GET servers/:/guests/:/metrics': {
        if (!a || !b) return null;
        const s = seriesFor(
          a,
          ['cpu_pct', 'mem_mb', 'net_rx_mbps', 'net_tx_mbps'],
          now,
          query.range ?? '24h',
        );
        return { status: 200, body: { ...s, guestId: b } };
      }
      case 'POST servers/:/guests/:/actions': {
        const g = a && b ? findGuest(a, b) : undefined;
        if (!a || !b || !g) return problem(404, 'guest_not_found', 'That guest isn’t there.');
        const action = String(body.action ?? '');
        const key = `${a}/${b}`;
        if (action === 'snapshot_create') {
          const name = String(body.snapshot ?? `snap-${++seq}`);
          const list = world.snapshots.get(key) ?? [];
          const current = list.find((x) => x.current);
          world.snapshots.set(key, [
            ...list.filter((x) => !x.current),
            {
              name,
              created: new Date(now).toISOString(),
              description: String(body.description ?? ''),
              memory: !!body.memory,
              parent: current?.parent,
            },
            ...(current ? [{ ...current, parent: name }] : []),
          ]);
        } else if (action === 'snapshot_delete') {
          world.snapshots.set(
            key,
            (world.snapshots.get(key) ?? []).filter((x) => x.name !== body.snapshot),
          );
        } else if (action !== 'snapshot_restore') {
          const state: HostGuest['state'] =
            action === 'start' || action === 'resume' || action === 'reboot' || action === 'restart'
              ? 'running'
              : action === 'pause'
                ? 'paused'
                : 'stopped';
          const noop = g.state === state && action !== 'reboot' && action !== 'restart';
          world.guests.set(
            a,
            (world.guests.get(a) ?? []).map((x) =>
              x.id === b
                ? {
                    ...x,
                    state,
                    pendingChanges: action === 'reboot' ? 0 : x.pendingChanges,
                    cpuPct: state === 'running' ? (x.cpuPct ?? 0.5) : null,
                    memoryUsedMb: state === 'running' ? (x.memoryUsedMb ?? 256) : null,
                  }
                : x,
            ),
          );
          if (action === 'reboot') {
            const cfg = world.configs.get(key);
            if (cfg)
              world.configs.set(key, {
                ...cfg,
                values: { ...cfg.values, ...cfg.pending },
                pending: {},
                digest: `${cfg.digest}r`,
              });
          }
          refreshServer(a);
          return { status: 202, body: { actionId: `act_${++seq}`, ...(noop ? { noop: true } : {}) } };
        }
        return { status: 202, body: { actionId: `act_${++seq}` } };
      }
      case 'GET servers/:/manage': {
        if (!a) return null;
        const key = `${a}/${query.guestId ?? ''}`;
        switch (query.op) {
          case 'config.get': {
            const cfg = world.configs.get(key);
            return cfg
              ? { status: 200, body: { op: 'config.get', config: cfg } }
              : problem(404, 'guest_not_found', 'That guest isn’t there.');
          }
          case 'choices':
            return {
              status: 200,
              body: {
                op: 'choices',
                choices: { ...CHOICES, node: a, nodes: ['pve-01', 'pve-02'].filter((n) => n !== a) },
              },
            };
          case 'backup.list': {
            const g = query.guestId ? findGuest(a, query.guestId) : undefined;
            const items = g ? world.backups.filter((x) => x.guest === String(g.vmid)) : world.backups;
            return { status: 200, body: { op: 'backup.list', items } };
          }
          case 'snapshot.list':
            return { status: 200, body: { op: 'snapshot.list', items: world.snapshots.get(key) ?? [] } };
          case 'firewall.get': {
            const fw = world.firewall.get(key);
            return fw
              ? { status: 200, body: { op: 'firewall.get', firewall: fw } }
              : problem(404, 'guest_not_found', 'That guest isn’t there.');
          }
          case 'task.list':
            return {
              status: 200,
              body: {
                op: 'task.list',
                items: query.guestId
                  ? (world.tasks.get(key) ?? [])
                  : (world.details.get(a)?.health?.tasks ?? []),
              },
            };
          case 'content.list':
          case 'appliance.list':
            return {
              status: 200,
              body: {
                op: query.op,
                items: [
                  { volid: 'local:iso/debian-13.1.0-amd64-netinst.iso', format: 'iso', size: 784_334_848 },
                  {
                    volid: 'local:iso/ubuntu-24.04.3-live-server-amd64.iso',
                    format: 'iso',
                    size: 3_213_064_192,
                  },
                  {
                    volid: 'local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst',
                    format: 'tzst',
                    size: 123_731_968,
                  },
                ],
              },
            };
          default:
            return problem(400, 'bad_request', 'That isn’t something Whombat reads.');
        }
      }
      case 'POST servers/:/manage': {
        if (!a) return null;
        const op = String(body.op ?? '');
        const guestId = typeof body.guestId === 'string' ? body.guestId : '';
        const key = `${a}/${guestId}`;
        const params = (body.params ?? {}) as {
          set?: Record<string, string>;
          delete?: string[];
          revert?: string[];
        };
        if (op === 'config.set') {
          const cfg = world.configs.get(key);
          if (!cfg) return problem(404, 'guest_not_found', 'That guest isn’t there.');
          if (body.digest && body.digest !== cfg.digest)
            return problem(409, 'digest_mismatch', 'Changed meanwhile — review again.');
          const values = { ...cfg.values };
          const pending = { ...(cfg.pending ?? {}) };
          const changes: { key: string; old?: string; new?: string; pending?: boolean }[] = [];
          const live = new Set([
            'description',
            'tags',
            'onboot',
            'name',
            'hostname',
            'ciuser',
            'ipconfig0',
            'nameserver',
            'sshkeys',
            'protection',
            'startup',
          ]);
          for (const [k, v] of Object.entries(params.set ?? {})) {
            if (cfg.running && !live.has(k)) {
              pending[k] = v;
              changes.push({ key: k, old: values[k], new: v, pending: true });
            } else {
              changes.push({ key: k, old: values[k], new: v });
              values[k] = v;
            }
          }
          for (const k of params.delete ?? []) {
            changes.push({ key: k, old: values[k] });
            delete values[k];
          }
          for (const k of params.revert ?? []) delete pending[k];
          world.configs.set(key, { ...cfg, values, pending, digest: `${cfg.digest}+` });
          world.guests.set(
            a,
            (world.guests.get(a) ?? []).map((g) =>
              g.id === guestId
                ? {
                    ...g,
                    pendingChanges: Object.keys(pending).length,
                    name: values.name ?? values.hostname ?? g.name,
                    tags: (values.tags ?? '').split(';').filter(Boolean),
                  }
                : g,
            ),
          );
          refreshServer(a);
          return { status: 200, body: { ok: true, changes, auditId: `aud_${++seq}` } };
        }
        if (
          op === 'firewall.rule_add' ||
          op === 'firewall.rule_update' ||
          op === 'firewall.rule_delete' ||
          op === 'firewall.options'
        ) {
          const fw = world.firewall.get(key);
          if (!fw) return problem(404, 'guest_not_found', 'That guest isn’t there.');
          const p = body.params as Record<string, unknown>;
          let rules = fw.rules;
          if (op === 'firewall.rule_delete')
            rules = rules.filter((r) => r.pos !== p.pos).map((r, i) => ({ ...r, pos: i }));
          else if (op === 'firewall.rule_update')
            rules = rules.map((r) => (r.pos === p.pos ? { ...r, ...(p.rule as object) } : r));
          else if (op === 'firewall.rule_add')
            rules = [
              { pos: 0, type: 'in', action: 'ACCEPT', enable: true, ...(p.rule as object) },
              ...rules.map((r) => ({ ...r, pos: r.pos + 1 })),
            ];
          world.firewall.set(key, {
            ...fw,
            rules,
            options:
              op === 'firewall.options'
                ? { ...fw.options, ...(p.set as Record<string, string>) }
                : fw.options,
          });
          return { status: 200, body: { ok: true } };
        }
        return { status: 200, body: { ok: true, task: { id: `UPID:${a}:${++seq}:${op}` } } };
      }
      case 'GET servers/:/tasks/:':
        return {
          status: 200,
          body: {
            id: b,
            type: 'task',
            started: new Date(now - 60_000).toISOString(),
            ended: new Date(now).toISOString(),
            status: 'ok',
            log: ['Starting…', 'Done.'],
            logNext: 2,
          },
        };
      case 'GET alerts':
        return {
          status: 200,
          body: { alerts: world.alerts.filter((x) => !query.server || x.serverId === query.server) },
        };
      case 'POST alerts/:/ack': {
        const minutes = Number(body.minutes ?? 0);
        world.alerts = world.alerts.map((x) =>
          x.id === a
            ? {
                ...x,
                attention: false,
                acknowledged: {
                  at: new Date(now).toISOString(),
                  by: 'John',
                  note: String(body.note ?? ''),
                  until: minutes ? new Date(now + minutes * 60_000).toISOString() : null,
                },
              }
            : x,
        );
        const alert = world.alerts.find((x) => x.id === a);
        return alert
          ? { status: 200, body: alert }
          : problem(404, 'alert_not_open', 'That alert isn’t open any more.');
      }
      case 'DELETE alerts/:/ack': {
        world.alerts = world.alerts.map((x) =>
          x.id === a ? { ...x, attention: true, acknowledged: null } : x,
        );
        const alert = world.alerts.find((x) => x.id === a);
        return alert
          ? { status: 200, body: alert }
          : problem(404, 'alert_not_open', 'That alert isn’t open any more.');
      }
      case 'GET maintenance':
        return { status: 200, body: { items: [] } };
      case 'GET checks':
        return { status: 200, body: { checks: [] } };
      case 'POST enrollments': {
        const id = `enr_${++seq}`;
        world.enrollments.push({
          id,
          state: 'issued',
          hostname: null,
          os: null,
          address: null,
          agentVersion: null,
          requestedAt: null,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + H).toISOString(),
          serverId: null,
        });
        return {
          status: 201,
          body: {
            id,
            expiresAt: new Date(now + H).toISOString(),
            installCommand: `curl -fsS --pinnedpubkey 'sha256//Xq3mVb9kQe2s0hWc8oT4uY1pZr7aLd5nJf6gBi0Ck2E=' https://10.100.1.5:8443/install.sh | sudo sh -s -- --enroll ${id.slice(4)}-7Q4M-K2PX`,
          },
        };
      }
      case 'GET enrollments': {
        const state = query.state ?? 'pending';
        return {
          status: 200,
          body: { items: world.enrollments.filter((e) => state === 'all' || e.state === state) },
        };
      }
      case 'POST enrollments/:/approve': {
        const e = world.enrollments.find((x) => x.id === a);
        if (e?.state !== 'pending') return problem(409, 'not_pending', 'It isn’t waiting any more.');
        const serverId = String(body.name ?? e.hostname ?? 'server');
        e.state = 'approved';
        e.serverId = serverId;
        world.servers.push({
          ...(world.servers.find((s) => s.id === 'the-falcon') as HostServer),
          id: serverId,
          name: serverId,
          status: 'pending',
          statusNote: null,
          os: e.os,
          cpu: null,
          cpuPct: null,
          guests: [],
          temperature: null,
        });
        return { status: 200, body: { serverId } };
      }
      case 'POST enrollments/:/reject': {
        const e = world.enrollments.find((x) => x.id === a);
        if (e) e.state = 'rejected';
        return { status: 200, body: { ok: true } };
      }
      case 'POST servers/:/consoles': {
        const session: HostConsoleSession = {
          sessionId: `con_${++seq}`,
          path: `/api/v1/burrows/fixture/hosts/consoles/con_${seq}/ws`,
          token: `tok_${seq}`,
          protocol: (body.protocol as HostConsoleSession['protocol']) ?? (body.guestId ? 'vnc' : 'shell'),
          expiresAt: new Date(now + 30_000).toISOString(),
          idleTimeoutS: 900,
        };
        return { status: 201, body: session };
      }
      case 'DELETE consoles/:':
        return { status: 200, body: { ok: true } };
      case 'GET servers/:/inspect/:':
        return { status: 200, body: inspect(b ?? 'processes', now) };
    }
    void c;
    return null;
  }

  return withConsoleFixtures(
    {
      world,
      handle: withRp(
        withSa(
          withSi(
            // A Mac (macos-servers.md): its page and its screen; a Windows PC (windows-servers.md): its page.
            withMac(
              withWindows(
                withWq(
                  withWi(
                    withWu(withWb(withWaFixtures(world, handle), { world, now, refreshServer }), {
                      world,
                      now,
                      refreshServer,
                    }),
                    { world, now, refreshServer },
                  ),
                  { world, now, refreshServer },
                ),
                { world, now },
              ),
              { world, now, ...opts.mac },
            ),
            { world, now },
          ),
          world,
        ),
        { world, now },
      ),
    },
    now,
  );
}

function inspect(kind: string, now: number) {
  const asOf = new Date(now).toISOString();
  switch (kind) {
    case 'ports':
      return {
        kind,
        asOf,
        truncated: false,
        items: [
          { proto: 'tcp', address: '0.0.0.0', port: 22, pid: 812, process: 'sshd' },
          { proto: 'tcp', address: '0.0.0.0', port: 8006, pid: 1430, process: 'pveproxy' },
          { proto: 'tcp', address: '127.0.0.1', port: 85, pid: 1402, process: 'pvedaemon' },
          { proto: 'udp', address: '0.0.0.0', port: 5405, pid: 1210, process: 'corosync' },
        ],
      };
    case 'services':
      return {
        kind,
        asOf,
        truncated: false,
        items: [
          {
            name: 'pveproxy.service',
            description: 'PVE API Proxy Server',
            active: 'active',
            sub: 'running',
            enabled: 'enabled',
          },
          {
            name: 'pvedaemon.service',
            description: 'PVE API Daemon',
            active: 'active',
            sub: 'running',
            enabled: 'enabled',
          },
          {
            name: 'corosync.service',
            description: 'Corosync Cluster Engine',
            active: 'active',
            sub: 'running',
            enabled: 'enabled',
          },
          {
            name: 'whombat-agent.service',
            description: 'Whombat agent',
            active: 'active',
            sub: 'running',
            enabled: 'enabled',
          },
          {
            name: 'chrony.service',
            description: 'chrony, an NTP client/server',
            active: 'active',
            sub: 'running',
            enabled: 'enabled',
          },
        ],
      };
    case 'updates':
      return {
        kind,
        asOf,
        truncated: false,
        items: [
          {
            name: 'proxmox-kernel-6.14',
            current: '6.14.11-2',
            new: '6.14.11-3',
            source: 'pve-no-subscription',
          },
          {
            name: 'openssl',
            current: '3.5.1-1',
            new: '3.5.1-1+deb13u1',
            security: true,
            source: 'debian-security',
          },
          { name: 'pve-manager', current: '9.2.11', new: '9.2.12', source: 'pve-no-subscription' },
          { name: 'zfsutils-linux', current: '2.3.4-pve1', new: '2.3.4-pve2', source: 'pve-no-subscription' },
        ],
      };
    default:
      return {
        kind: 'processes',
        asOf,
        truncated: false,
        items: [
          {
            pid: 4021,
            user: 'root',
            name: 'kvm',
            command: '/usr/bin/kvm -id 118 -name arnica-prod-nest-01',
            cpuPct: 9.2,
            rssBytes: 4_080_218_112,
            state: 'S',
            threads: 12,
          },
          {
            pid: 3120,
            user: '100000',
            name: 'node',
            command: 'node /srv/cli-proxy-api/server.js',
            cpuPct: 7.4,
            rssBytes: 812_000_000,
            state: 'S',
            container: 'cli-proxy-api',
          },
          {
            pid: 3388,
            user: '100000',
            name: 'AgentDVR',
            command: '/opt/AgentDVR/Agent',
            cpuPct: 6.1,
            rssBytes: 1_100_000_000,
            state: 'S',
            container: 'AgentDVR',
          },
          {
            pid: 1430,
            user: 'www-data',
            name: 'pveproxy',
            command: 'pveproxy worker',
            cpuPct: 0.4,
            rssBytes: 160_000_000,
            state: 'S',
          },
          {
            pid: 1210,
            user: 'root',
            name: 'corosync',
            command: '/usr/sbin/corosync -f',
            cpuPct: 0.3,
            rssBytes: 210_000_000,
            state: 'S',
          },
        ],
      };
  }
}
