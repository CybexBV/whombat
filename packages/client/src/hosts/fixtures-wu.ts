/**
 * Stream WU's part of the servers' fixture world (Whombat incus-unraid.md IU-03, IU-05, IU-07, IU-08; app
 * docs/decisions/incus-unraid-wu.md AP-1606): `blackbox` as the real BlackBox is (Unraid 7.3.1 Pro, read on
 * 2026-10-17 from its `var.ini`, `disks.ini`, `shares.ini`, `/var/log/plugins`, `docker ps` and `virsh list`; no
 * serials, GUIDs or tokens; eight stopped containers keep the mock's 13 of 21 guests running): the array started with one data disk and both parity slots disabled (the mock's “both
 * parity drives dropped out”), three encrypted btrfs pools (`apps`, `data`, `storage`), the flash drive, 17 shares,
 * twelve plugins, the *arr apps, Plex and Immich in Docker with dockerMan's templates and autostart, the PBS VM. Added
 * for review: two plugin updates, a Plex update, three unread notifications and Unraid 7.3.2.
 *
 * `withWu(handle, ctx)` wraps `createHostsFixtures`' handler: BlackBox's page and rows are patched when read (so the
 * main world's refreshes keep them), its Unraid changes answer as the hub does (`unraid:<16 hex>` tasks whose log grows
 * a line per read; `notification.archive` and `guest.autostart` at once) and change the world when they end. A
 * scenario for reviews can be picked before the page loads: `localStorage['whombat.fixtures.unraid']` = `parity-ok`,
 * `parity-running` or `stopped`. Not imported by production code.
 */
import type {
  HostGuest,
  HostHint,
  HostPlatformWorkload,
  HostServerDetail,
  HostTask,
  HostUnraidDetail,
  HostUnraidDisk,
  HostUnraidParityRun,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest, HostsFixtureWorld } from './fixtures';
import { canSpin, spinningDisks, UNRAID_OS_PLUGIN } from './unraid';

const H = 3600_000;
const DAY = 24 * H;
const SERVER = 'blackbox';
const KIB = 1024;
const k = (n: number) => n * KIB;

type Handle = (req: HostsFixtureRequest) => HostsFixtureAnswer | null;

export type WuScenario = 'real' | 'parity-ok' | 'parity-running' | 'stopped';

export interface WuFixtureContext {
  world: HostsFixtureWorld;
  now: number;
  refreshServer: (serverId: string) => void;
  /** The wall clock for tasks and parity progress (tests pass a fixed one). */
  clock?: () => number;
  /** Default: the review scenario in localStorage, else the real BlackBox. */
  scenario?: WuScenario;
}

interface WuTask {
  id: string;
  op: string;
  guestId?: string;
  started: number;
  reads: number;
  lines: string[];
  result: 'ok' | 'error';
  message: string;
  ended?: number;
  onDone?: () => void;
}

function problem(status: number, code: string, message: string): HostsFixtureAnswer {
  const kind =
    status === 404 ? 'not_found' : status === 400 ? 'bad_request' : status === 403 ? 'forbidden' : 'conflict';
  return { status, body: { error: { code: kind, message, details: { code } } } };
}

function scenarioFromStorage(): WuScenario {
  try {
    const v = globalThis.localStorage?.getItem('whombat.fixtures.unraid');
    return v === 'parity-ok' || v === 'parity-running' || v === 'stopped' ? v : 'real';
  } catch {
    return 'real';
  }
}

/* The seed ------------------------------------------------------------------------------------------- */

function disk(name: string, slot: HostUnraidDisk['slot'], o: Partial<HostUnraidDisk> = {}): HostUnraidDisk {
  return {
    name,
    slot,
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
    rotational: null,
    ...o,
  };
}

/** A pool's members as `disks.ini` lists them: the first carries the pool's file system and use. */
function members(
  pool: string,
  devices: readonly string[],
  temps: readonly (number | null)[],
  o: {
    model: string;
    size: number;
    rotational: boolean;
    fs: string;
    used: number;
    free: number;
    down?: boolean;
  },
): HostUnraidDisk[] {
  return devices.map((device, i) =>
    disk(i === 0 ? pool : `${pool}${i + 1}`, 'pool', {
      device,
      model: o.model,
      sizeBytes: k(o.size),
      rotational: o.rotational,
      spunDown: !!o.down,
      tempC: o.down ? null : (temps[i] ?? null),
      ...(i === 0 ? { fsType: o.fs, usedBytes: k(o.used), freeBytes: k(o.free) } : {}),
    }),
  );
}

/** `/boot/config/parity-checks.log`, newest first (date|seconds|bytes/s|exit|errors|action). */
const PARITY_LOG: HostUnraidParityRun[] = [
  {
    at: '2024-07-10T18:32:54Z',
    durationS: 52,
    speedMbs: null,
    errors: 0,
    result: 'cancelled',
    action: 'check P Q',
  },
  {
    at: '2024-06-20T16:35:01Z',
    durationS: 6947,
    speedMbs: 288,
    errors: 0,
    result: 'ok',
    action: 'check P Q',
  },
  {
    at: '2023-11-19T20:59:21Z',
    durationS: 5994,
    speedMbs: 334,
    errors: 0,
    result: 'ok',
    action: 'recon D1 D2',
  },
  {
    at: '2023-11-19T18:56:02Z',
    durationS: 1578,
    speedMbs: null,
    errors: 0,
    result: 'cancelled',
    action: 'check P Q',
  },
  {
    at: '2023-07-26T12:38:49Z',
    durationS: 7067,
    speedMbs: 283,
    errors: 0,
    result: 'ok',
    action: 'check P Q',
  },
];

function seedUnraid(now: number, scenario: WuScenario): HostUnraidDetail {
  const parityOk = scenario === 'parity-ok' || scenario === 'parity-running';
  const parity = parityOk
    ? [
        disk('parity', 'parity', {
          device: 'sdr',
          model: 'ST12000VN0008-2YS101',
          sizeBytes: k(11718885324),
          tempC: 35,
          rotational: true,
        }),
        disk('parity2', 'parity', { status: 'empty', statusRaw: 'DISK_NP' }),
      ]
    : [
        disk('parity', 'parity', { status: 'disabled', statusRaw: 'DISK_NP_DSBL' }),
        disk('parity2', 'parity', { status: 'disabled', statusRaw: 'DISK_NP_DSBL' }),
      ];
  const last: HostUnraidParityRun | null = parityOk
    ? {
        at: new Date(now - 19 * DAY).toISOString(),
        durationS: 13 * 3600 + 22 * 60,
        speedMbs: 243,
        errors: 0,
        result: 'ok',
        action: 'check P',
      }
    : (PARITY_LOG[0] ?? null);
  return {
    version: '7.3.1',
    name: 'BlackBox',
    license: 'Pro',
    osUpdate: { version: '7.3.2' },
    array: {
      state: scenario === 'stopped' ? 'stopped' : 'started',
      stateRaw: scenario === 'stopped' ? 'STOPPED' : 'STARTED',
      startOnBoot: false,
      sizeBytes: k(1952559696),
      usedBytes: k(13646588),
      freeBytes: k(1938913108),
      disabled: parityOk ? 0 : 2,
      invalid: parityOk ? 0 : 2,
      missing: 0,
      moverRunning: false,
      parity: {
        state: scenario === 'parity-running' ? 'running' : 'idle',
        action: scenario === 'parity-running' ? 'check' : null,
        pct: scenario === 'parity-running' ? 42.3 : null,
        speedMbs: scenario === 'parity-running' ? 168 : null,
        etaS: scenario === 'parity-running' ? 7.4 * 3600 : null,
        errors: 0,
        last,
        history: parityOk && last ? [last, ...PARITY_LOG].slice(0, 10) : PARITY_LOG,
        schedule: parityOk ? 'Monthly, day 1 at 00:30, no corrections' : null,
      },
      disks: [
        ...parity,
        disk('disk1', 'data', {
          device: 'sdi',
          model: 'WDC WDS200T1R0A-68A4W0',
          sizeBytes: k(1953513560),
          usedBytes: k(13646588),
          freeBytes: k(1938913108),
          fsType: 'xfs',
          tempC: 31,
          rotational: false,
        }),
      ],
    },
    pools: [
      {
        name: 'apps',
        fsType: 'luks:btrfs',
        profile: 'raid10',
        sizeBytes: k(1953490352),
        usedBytes: k(38192080),
        freeBytes: k(1913922272),
        disks: members('apps', ['sdb', 'sdc', 'sdd', 'sde'], [31, 31, 31, 32], {
          model: 'Samsung SSD 870 EVO 1TB',
          size: 976761560,
          rotational: false,
          fs: 'luks:btrfs',
          used: 38192080,
          free: 1913922272,
        }),
      },
      {
        name: 'data',
        fsType: 'luks:btrfs',
        profile: 'raid6',
        sizeBytes: k(87897783852),
        usedBytes: k(21790528028),
        freeBytes: k(46588457604),
        disks: members(
          'data',
          ['sdj', 'sdk', 'sdl', 'sdm', 'sdn', 'sdo', 'sdp', 'sdf', 'sdg'],
          [34, 34, 33, 33, 34, 34, 34, 37, 37],
          {
            model: 'ST10000NE0008-2PL103',
            size: 9766436812,
            rotational: true,
            fs: 'luks:btrfs',
            used: 21790528028,
            free: 46588457604,
          },
        ),
      },
      {
        name: 'storage',
        fsType: 'luks:btrfs',
        profile: 'raid1',
        sizeBytes: k(11718868940),
        usedBytes: k(1391367936),
        freeBytes: k(10327824016),
        disks: members('storage', ['sdh', 'sdq'], [36, 34], {
          model: 'ST12000VN0008-2YS101',
          size: 11718885324,
          rotational: true,
          fs: 'luks:btrfs',
          used: 1391367936,
          free: 10327824016,
          down: true,
        }),
      },
    ],
    flash: disk('flash', 'flash', {
      device: 'sda',
      model: 'SanDisk 3.2Gen1',
      sizeBytes: k(60087296),
      usedBytes: k(2155936),
      freeBytes: k(57916640),
      fsType: 'vfat',
    }),
    shares: SHARES.map(([name, comment, primary, smb, nfs]) => {
      const space = POOL_SPACE[primary] ?? POOL_SPACE.array;
      return {
        name,
        comment,
        usedBytes: k(space?.[0] ?? 0),
        freeBytes: k(space?.[1] ?? 0),
        primary,
        secondary: null,
        moverAction: null,
        smb,
        nfs,
        encrypted: primary !== 'array',
      };
    }),
    plugins: PLUGINS.map(([name, version, update, author, supportUrl]) => ({
      name,
      file: `${name}.plg`,
      version,
      update,
      author,
      supportUrl,
    })),
    notifications: [
      {
        id: 'Docker_-_Plex_1760680800',
        at: new Date(now - 6 * H).toISOString(),
        importance: 'normal',
        event: 'Docker - Plex',
        subject: 'Notice [BLACKBOX] - Docker update',
        description: 'A new version of plex is available.',
      },
      {
        id: 'Fix_Common_Problems_-_BlackBox_1760659200',
        at: new Date(now - 12 * H).toISOString(),
        importance: 'warning',
        event: 'Fix Common Problems - BlackBox',
        subject: 'Warnings have been found with your server (BlackBox).',
        description: 'Investigate at Settings / User Utilities / Fix Common Problems.',
      },
      ...(parityOk
        ? []
        : [
            {
              id: 'Unraid_Parity_disk_error_1760433000',
              at: new Date(now - 3 * DAY).toISOString(),
              importance: 'alert' as const,
              event: 'Unraid Parity disk error',
              subject: 'Alert [BLACKBOX] - Parity disk in error state (disk dsbl)',
              description: 'No device identification ()',
            },
          ]),
    ],
    docker: { enabled: true, imageUsedPct: 38 },
    vms: { enabled: true },
  };
}

/** `shares.ini` with SMB security from `/boot/config/shares/*.cfg`: name, comment, primary, SMB, NFS. */
const SHARES: readonly [string, string, string, string | null, boolean][] = [
  ['Archief', '', 'data', 'private', false],
  ['Data', '', 'storage', null, false],
  ['Files', '', 'storage', 'private', false],
  ['Media', '', 'data', 'private', false],
  ['PBS-Backup', 'Proxmox Backup Server datastore backing storage', 'data', null, false],
  ['PVE-Backup', '', 'data', 'private', true],
  ['Photos', '', 'storage', 'private', false],
  ['Shadow', '', 'data', null, true],
  ['Torrents', '', 'data', null, false],
  ['Unifi', 'Unifi Backups', 'data', 'private', false],
  ['Usenet', '', 'data', null, true],
  ['appdata', '', 'apps', null, false],
  ['brdisk', '', 'data', 'private', true],
  ['domains', '', 'array', null, false],
  ['isos', '', 'array', null, false],
  ['servers', '', 'data', null, false],
  ['system', '', 'apps', null, false],
];

/** Used and free KiB as `shares.ini` reports them (the pool's or the array's). */
const POOL_SPACE: Record<string, readonly [number, number]> = {
  array: [13646588, 1938913108],
  apps: [38192080, 1913922272],
  data: [21790528028, 46588457604],
  storage: [1391367936, 10327824016],
};

/** `/var/log/plugins/*.plg` (name, version, the newer one in `/tmp/plugins`, author, support). */
const PLUGINS: readonly [string, string, string | null, string | null, string | null][] = [
  [
    'ca.update.applications',
    '2026.04.14',
    null,
    'Andrew Zawadzki',
    'https://forums.unraid.net/topic/51959-plugin-ca-application-auto-update/',
  ],
  [
    'community.applications',
    '2026.07.21',
    '2026.10.15',
    'Lime Technology',
    'https://forums.unraid.net/topic/38582-plug-in-community-applications',
  ],
  [
    'compose.manager',
    '2025.11.01',
    null,
    'dcflachs',
    'https://forums.unraid.net/topic/114415-plugin-docker-compose-manager/',
  ],
  ['fix.common.problems', '2026.10.12', '2026.10.16', 'Lime Technology', null],
  [
    'gpustat',
    '2026.05.19',
    null,
    'SimonFair',
    'https://forums.unraid.net/topic/89453-plugin-gpu-statistics/',
  ],
  [
    'intel-gpu-top',
    '2026.01.13',
    null,
    'ich777',
    'https://forums.unraid.net/topic/92865-support-ich777-nvidiadvb-kernel-helperbuilder-docker/',
  ],
  ['lcd_manager', '2024.11.23', null, 'SimonFair', null],
  [
    'qnap-ec',
    '2023.10.06',
    null,
    'ich777',
    'https://forums.unraid.net/topic/92865-support-ich777-amd-vendor-reset-coraltpu-hpsahba/',
  ],
  ['tailscale', '2026.09.28', null, null, 'https://forums.unraid.net/topic/136889-plugin-tailscale/'],
  ['unassigned.devices', '2026.10.03', null, 'dlandon', null],
  ['unassigned.devices-plus', '2025.09.30', null, 'dlandon', null],
  ['unRAIDServer', '7.3.1', null, 'LimeTech', null],
];

interface Ctr {
  name: string;
  image: string;
  cpu: number;
  memMb: number;
  on: boolean;
  autostart: boolean;
  /** The template's WebUI, `[IP]` filled in; null when it has none. */
  web: string | null;
  template: boolean;
  update?: boolean;
}

const ADDRESS = '10.100.1.30';
const CONTAINERS: Ctr[] = [
  {
    name: 'plex',
    image: 'lscr.io/linuxserver/plex',
    cpu: 3.4,
    memMb: 1480,
    on: true,
    autostart: true,
    web: `http://${ADDRESS}:32400/web`,
    template: true,
    update: true,
  },
  {
    name: 'immich_machine_learning',
    image: 'ghcr.io/immich-app/immich-machine-learning:release',
    cpu: 2.1,
    memMb: 1950,
    on: true,
    autostart: false,
    web: null,
    template: false,
    update: true,
  },
  {
    name: 'sabnzbd',
    image: 'lscr.io/linuxserver/sabnzbd:latest',
    cpu: 1.9,
    memMb: 620,
    on: true,
    autostart: true,
    web: `http://${ADDRESS}:8080`,
    template: true,
  },
  {
    name: 'sonarr',
    image: 'lscr.io/linuxserver/sonarr',
    cpu: 0.8,
    memMb: 410,
    on: true,
    autostart: true,
    web: `http://${ADDRESS}:8989`,
    template: true,
  },
  {
    name: 'immich_postgres',
    image: 'tensorchord/pgvecto-rs:pg14-v0.2.0',
    cpu: 0.7,
    memMb: 520,
    on: true,
    autostart: false,
    web: null,
    template: false,
  },
  {
    name: 'radarr',
    image: 'lscr.io/linuxserver/radarr:latest',
    cpu: 0.6,
    memMb: 380,
    on: true,
    autostart: true,
    web: `http://${ADDRESS}:7878`,
    template: true,
  },
  {
    name: 'resilio-sync',
    image: 'lscr.io/linuxserver/resilio-sync',
    cpu: 0.5,
    memMb: 160,
    on: true,
    autostart: true,
    web: `http://${ADDRESS}:8888`,
    template: true,
  },
  {
    name: 'prowlarr',
    image: 'lscr.io/linuxserver/prowlarr:latest',
    cpu: 0.3,
    memMb: 190,
    on: true,
    autostart: true,
    web: `http://${ADDRESS}:9696`,
    template: true,
  },
  {
    name: 'overseerr',
    image: 'lscr.io/linuxserver/overseerr:latest',
    cpu: 0.2,
    memMb: 240,
    on: true,
    autostart: true,
    web: `http://${ADDRESS}:5055`,
    template: true,
  },
  {
    name: 'dashboard-agent',
    image: 'dashboard-agent:candidate-70373011c8e8',
    cpu: 0.2,
    memMb: 60,
    on: true,
    autostart: false,
    web: null,
    template: false,
  },
  {
    name: 'flaresolverr',
    image: 'flaresolverr/flaresolverr',
    cpu: 0.1,
    memMb: 210,
    on: true,
    autostart: true,
    web: null,
    template: true,
  },
  {
    name: 'immich_redis',
    image: 'redis:6.2-alpine',
    cpu: 0.1,
    memMb: 12,
    on: true,
    autostart: false,
    web: null,
    template: false,
  },
  {
    name: 'tautulli',
    image: 'lscr.io/linuxserver/tautulli',
    cpu: 0,
    memMb: 0,
    on: false,
    autostart: false,
    web: `http://${ADDRESS}:8181`,
    template: true,
  },
  {
    name: 'photoprism',
    image: 'photoprism/photoprism',
    cpu: 0,
    memMb: 0,
    on: false,
    autostart: false,
    web: `http://${ADDRESS}:2342`,
    template: true,
  },
  {
    name: 'syncthing',
    image: 'lscr.io/linuxserver/syncthing',
    cpu: 0,
    memMb: 0,
    on: false,
    autostart: false,
    web: `http://${ADDRESS}:8384`,
    template: true,
  },
  {
    name: 'duplicati',
    image: 'lscr.io/linuxserver/duplicati',
    cpu: 0,
    memMb: 0,
    on: false,
    autostart: false,
    web: `http://${ADDRESS}:8200`,
    template: true,
  },
  {
    name: 'jellyfin',
    image: 'lscr.io/linuxserver/jellyfin',
    cpu: 0,
    memMb: 0,
    on: false,
    autostart: false,
    web: `http://${ADDRESS}:8096`,
    template: true,
  },
  {
    name: 'swag',
    image: 'lscr.io/linuxserver/swag',
    cpu: 0,
    memMb: 0,
    on: false,
    autostart: false,
    web: null,
    template: true,
  },
  {
    name: 'mariadb',
    image: 'lscr.io/linuxserver/mariadb',
    cpu: 0,
    memMb: 0,
    on: false,
    autostart: false,
    web: null,
    template: true,
  },
  {
    name: 'nextcloud',
    image: 'lscr.io/linuxserver/nextcloud',
    cpu: 0,
    memMb: 0,
    on: false,
    autostart: false,
    web: `https://${ADDRESS}:4443`,
    template: true,
  },
];

function seedGuests(now: number, stopped: boolean): HostGuest[] {
  void now;
  const docker = CONTAINERS.map(
    (c, i): HostGuest => ({
      id: `docker:${c.name}`,
      serverId: SERVER,
      serverOnline: true,
      name: c.name,
      platform: 'docker',
      kind: 'container',
      image: c.image,
      state: c.on && !stopped ? 'running' : 'stopped',
      cpuPct: c.on && !stopped ? c.cpu : null,
      memoryUsedMb: c.on && !stopped ? c.memMb : null,
      memoryLimitMb: null,
      uptimeS: c.on && !stopped ? 20 * 3600 + i * 1_800 : null,
      console: { available: c.on && !stopped, protocols: ['shell', 'logs'], defaultProtocol: 'shell' },
      restarts: 0,
      tags: [],
      updateAvailable: c.update === true,
      autostart: c.autostart,
      webUi: c.web,
      template: c.template,
    }),
  );
  const pbs: HostGuest = {
    id: 'libvirt:pbs',
    serverId: SERVER,
    serverOnline: true,
    name: 'pbs',
    platform: 'libvirt',
    kind: 'vm',
    image: 'Proxmox Backup Server 4',
    state: stopped ? 'stopped' : 'running',
    vcpu: 4,
    cpuPct: stopped ? null : 1.2,
    memoryUsedMb: stopped ? null : 5900,
    memoryLimitMb: 8192,
    uptimeS: stopped ? null : 41 * 86_400,
    console: {
      available: !stopped,
      protocols: ['vnc'],
      defaultProtocol: 'vnc',
      unavailable: { spice: 'Whombat shows VM screens over VNC.' },
    },
    tags: [],
    autostart: true,
  };
  return [...docker, pbs];
}

function workload(guests: HostGuest[]): HostPlatformWorkload {
  const running = guests.filter((g) => g.state === 'running' || g.state === 'unhealthy');
  return {
    running: running.length,
    total: guests.length,
    cpuPct: Math.round(running.reduce((a, g) => a + (g.cpuPct ?? 0), 0) * 10) / 10,
    memoryGb: Math.round((running.reduce((a, g) => a + (g.memoryUsedMb ?? 0), 0) / 1024) * 10) / 10,
    guests,
  };
}

/* The handler ---------------------------------------------------------------------------------------- */

/** The hub's hints for BlackBox's Unraid parts (IU-08), from the state now. */
function unraidHints(u: HostUnraidDetail, guests: readonly HostGuest[]): HostHint[] {
  const out: HostHint[] = [];
  const hint = (h: Omit<HostHint, 'serverId'>) => out.push({ serverId: SERVER, ...h });
  if (u.array.state === 'stopped')
    hint({
      kind: 'unraid.array_stopped',
      severity: 'warning',
      entity: 'array',
      title: 'Array stopped',
      detail: 'Shares, Docker and VMs are off until it’s started.',
      section: 'array',
    });
  for (const n of u.notifications.filter((x) => x.importance !== 'normal'))
    hint({
      kind: 'unraid.notification',
      severity: n.importance === 'alert' ? 'warning' : 'info',
      entity: n.id,
      title: n.subject.replace(/^(Alert|Warning|Notice) \[[^\]]*\] - /, ''),
      detail: n.description,
      section: 'summary',
    });
  const updates = u.plugins.filter((p) => p.update && p.file !== UNRAID_OS_PLUGIN);
  if (updates.length)
    hint({
      kind: 'unraid.plugin_updates',
      severity: 'info',
      entity: 'plugins',
      title: updates.length === 1 ? 'A plugin has an update' : `${updates.length} plugins have an update`,
      detail: updates.map((p) => p.name).join(', '),
      section: 'plugins',
    });
  if (u.osUpdate)
    hint({
      kind: 'unraid.os_update',
      severity: 'info',
      entity: 'unRAIDServer',
      title: `Unraid ${u.osUpdate.version} has come out`,
      detail: `BlackBox runs ${u.version}.`,
      section: 'plugins',
    });
  const outdated = guests.filter((g) => g.platform === 'docker' && g.updateAvailable);
  if (outdated.length)
    hint({
      kind: 'docker.update_available',
      severity: 'info',
      entity: 'docker',
      title: outdated.length === 1 ? 'An app has an update' : `${outdated.length} apps have an update`,
      detail: outdated.map((g) => g.name).join(', '),
      section: 'guests',
    });
  return out;
}

export function withWu(next: Handle, ctx: WuFixtureContext): Handle {
  const { world, now, refreshServer } = ctx;
  const clock = ctx.clock ?? (() => Date.now());
  const scenario = ctx.scenario ?? scenarioFromStorage();
  let u = seedUnraid(now, scenario);
  /** When a running parity check was at `parityBase` (its progress moves with the clock). */
  let parityAt = clock();
  let parityBase = u.array.parity.pct ?? 0;
  const tasks = new Map<string, WuTask>();
  let seq = 0;

  world.guests.set(SERVER, seedGuests(now, scenario === 'stopped'));
  refreshServer(SERVER);

  const guests = () => world.guests.get(SERVER) ?? [];
  const patchGuests = (fn: (g: HostGuest) => HostGuest) => {
    world.guests.set(SERVER, guests().map(fn));
    refreshServer(SERVER);
  };
  const setParity = (p: Partial<HostUnraidDetail['array']['parity']>) => {
    u = { ...u, array: { ...u.array, parity: { ...u.array.parity, ...p } } };
  };
  const endParity = (result: HostUnraidParityRun['result']) => {
    const p = u.array.parity;
    const run: HostUnraidParityRun = {
      at: new Date(clock()).toISOString(),
      durationS: Math.round((clock() - parityAt) / 1000) + 600,
      speedMbs: p.speedMbs,
      errors: p.errors,
      result: result === 'ok' && p.errors ? 'errors' : result,
      action: p.action === 'correct' ? 'correct P' : 'check P',
    };
    setParity({
      state: 'idle',
      action: null,
      pct: null,
      speedMbs: null,
      etaS: null,
      errors: 0,
      last: run,
      history: [run, ...p.history].slice(0, 10),
    });
  };
  /** A running check moves on with the clock: about 1 % every 6 s. */
  const advanceParity = () => {
    const p = u.array.parity;
    if (p.state !== 'running') return;
    const pct = Math.min(100, parityBase + (clock() - parityAt) / 6000);
    if (pct >= 100) return endParity('ok');
    setParity({ pct: Math.round(pct * 10) / 10, speedMbs: 168, etaS: Math.round((100 - pct) * 640) });
  };

  const powerAll = (on: boolean) =>
    patchGuests((g) => {
      if (g.platform !== 'docker' && g.platform !== 'libvirt') return g;
      const start = on && g.autostart === true;
      return {
        ...g,
        state: start ? 'running' : 'stopped',
        cpuPct: start ? 0.4 : null,
        memoryUsedMb: start ? (g.memoryLimitMb ?? 256) / 2 : null,
        uptimeS: start ? 60 : null,
        console: { ...g.console, available: start },
      };
    });

  const startTask = (op: string, lines: string[], onDone?: () => void, guestId?: string) => {
    seq += 1;
    const id = `unraid:${(0x3f1a9c00 + seq).toString(16).padStart(16, '0')}`;
    tasks.set(id, {
      id,
      op,
      ...(guestId ? { guestId } : {}),
      started: clock(),
      reads: 0,
      lines,
      result: 'ok',
      message: 'OK',
      ...(onDone ? { onDone } : {}),
    });
    return { status: 202, body: { ok: true, task: { id } } };
  };

  const taskStatus = (t: WuTask, logStart: number): HostTask => {
    t.reads += 1;
    const shown = Math.min(t.lines.length, t.reads);
    if (shown >= t.lines.length && t.ended === undefined) {
      t.ended = clock();
      t.onDone?.();
    }
    const from = logStart < 0 ? shown : Math.max(0, Math.min(logStart, shown));
    return {
      id: t.id,
      type: t.op,
      platform: 'unraid',
      guestId: t.guestId ?? null,
      node: SERVER,
      user: 'whombat',
      started: new Date(t.started).toISOString(),
      ended: t.ended !== undefined ? new Date(t.ended).toISOString() : null,
      status: t.ended !== undefined ? t.result : 'running',
      ...(t.ended !== undefined ? { message: t.message } : {}),
      log: t.lines.slice(from, shown),
      logNext: shown,
    };
  };

  const patchDetail = (d: HostServerDetail): HostServerDetail => {
    advanceParity();
    const list = guests();
    return {
      ...d,
      server: {
        ...d.server,
        platform: 'unraid',
        ...(d.server.os ? { os: { ...d.server.os, version: u.version } } : {}),
      },
      banner: d.banner ? { ...d.banner, section: 'array' } : null,
      alerts: d.alerts?.map((a) => (a.section === 'storage' ? { ...a, section: 'array' } : a)),
      hints: [
        ...d.hints.filter((h) => !h.kind.startsWith('unraid.') && h.kind !== 'docker.update_available'),
        ...unraidHints(u, list),
      ],
      workloads: {
        docker: workload(list.filter((g) => g.platform === 'docker')),
        libvirt: workload(list.filter((g) => g.platform === 'libvirt')),
      },
      health: d.health
        ? {
            ...d.health,
            arrays: [],
            ...(d.health.system
              ? { system: { ...d.health.system, initSystem: null, failedCount: 0, failedUnits: [] } }
              : {}),
          }
        : d.health,
      unraid: u,
    };
  };

  const manage = (body: Record<string, unknown>): HostsFixtureAnswer | null => {
    const op = String(body.op ?? '');
    const params = (body.params ?? {}) as Record<string, unknown>;
    const confirm = body.confirm === true;
    const guestId = typeof body.guestId === 'string' ? body.guestId : '';
    const a = u.array;
    const started = a.state === 'started';
    switch (op) {
      case 'array.start':
        if (a.state !== 'stopped') return problem(409, 'array_started', 'The array is already started.');
        u = { ...u, array: { ...a, state: 'starting', stateRaw: 'STARTING' } };
        return startTask(
          op,
          [
            '/usr/local/sbin/emcmd cmdStart=Start',
            'Mounting disk1 (xfs)…',
            'Mounting the pools apps, data and storage…',
            'Starting Docker and the VMs…',
            'Array started.',
          ],
          () => {
            u = { ...u, array: { ...u.array, state: 'started', stateRaw: 'STARTED' } };
            powerAll(true);
          },
        );
      case 'array.stop':
        if (!confirm) return problem(400, 'confirm_required', 'Stopping the array needs confirm.');
        if (!started) return problem(409, 'array_stopped', 'The array isn’t started.');
        u = { ...u, array: { ...a, state: 'stopping', stateRaw: 'STOPPING' } };
        return startTask(
          op,
          [
            '/usr/local/sbin/emcmd cmdStop=Stop',
            'Stopping Docker and the VMs…',
            'Unmounting the shares and pools…',
            'Array stopped.',
          ],
          () => {
            if (u.array.parity.state !== 'idle') endParity('cancelled');
            u = { ...u, array: { ...u.array, state: 'stopped', stateRaw: 'STOPPED', moverRunning: false } };
            powerAll(false);
          },
        );
      case 'parity.start': {
        if (!started) return problem(409, 'array_stopped', 'Start the array first.');
        if (a.parity.state !== 'idle')
          return problem(409, 'parity_running', 'A parity check is already running.');
        if (a.disks.some((d) => d.slot === 'parity' && d.status !== 'ok' && d.status !== 'empty'))
          return problem(409, 'parity_disabled', 'Parity is disabled, so there’s nothing to check.');
        if (!a.disks.some((d) => d.slot === 'parity' && d.status === 'ok'))
          return problem(409, 'no_parity', 'There’s no parity disk to check.');
        const correct = params.correct === true;
        parityAt = clock();
        parityBase = 0;
        setParity({
          state: 'running',
          action: correct ? 'correct' : 'check',
          pct: 0,
          speedMbs: null,
          etaS: null,
        });
        return startTask(op, [
          `/usr/local/sbin/mdcmd check ${correct ? 'CORRECT' : 'NOCORRECT'}`,
          'Parity check started.',
        ]);
      }
      case 'parity.pause':
        if (a.parity.state !== 'running') return problem(409, 'parity_idle', 'No parity check is running.');
        advanceParity();
        parityBase = u.array.parity.pct ?? 0;
        setParity({ state: 'paused', speedMbs: null, etaS: null });
        return startTask(op, ['/usr/local/sbin/mdcmd nocheck PAUSE', 'Parity check paused.']);
      case 'parity.resume':
        if (a.parity.state !== 'paused')
          return problem(409, 'parity_not_paused', 'The parity check isn’t paused.');
        parityAt = clock();
        setParity({ state: 'running' });
        return startTask(op, ['/usr/local/sbin/mdcmd check RESUME', 'Parity check resumed.']);
      case 'parity.cancel':
        if (!confirm) return problem(400, 'confirm_required', 'Cancelling the check needs confirm.');
        if (a.parity.state === 'idle') return problem(409, 'parity_idle', 'No parity check is running.');
        return startTask(op, ['/usr/local/sbin/mdcmd nocheck CANCEL', 'Parity check cancelled.'], () =>
          endParity('cancelled'),
        );
      case 'disk.spin_up':
      case 'disk.spin_down': {
        const which = String(params.disk ?? '');
        const all = spinningDisks(u);
        if (which !== 'all' && !all.some((d) => d.name === which))
          return problem(400, 'unknown_disk', 'That disk isn’t in this server, or it doesn’t spin.');
        const down = op === 'disk.spin_down';
        const cmd =
          which === 'all'
            ? down
              ? 'cmdSpindownAll=true'
              : 'cmdSpinupAll=true'
            : `${down ? 'cmdSpindown' : 'cmdSpinup'}=${which}`;
        return startTask(op, [`/usr/local/sbin/emcmd ${cmd}`, down ? 'Spun down.' : 'Spun up.'], () => {
          const spin = (d: HostUnraidDisk): HostUnraidDisk =>
            canSpin(d) && (which === 'all' || d.name === which)
              ? { ...d, spunDown: down, tempC: down ? null : (d.tempC ?? 35) }
              : d;
          u = {
            ...u,
            array: { ...u.array, disks: u.array.disks.map(spin) },
            pools: u.pools.map((p) => ({ ...p, disks: p.disks.map(spin) })),
          };
        });
      }
      case 'mover.start':
        if (!started) return problem(409, 'array_stopped', 'Start the array first.');
        if (a.moverRunning) return problem(409, 'mover_running', 'The mover is already running.');
        u = { ...u, array: { ...a, moverRunning: true } };
        return startTask(op, ['/usr/local/sbin/mover start', 'mover: started', 'mover: finished'], () => {
          u = { ...u, array: { ...u.array, moverRunning: false } };
        });
      case 'plugin.check':
        return startTask(op, ['plugin checkall', ...u.plugins.map((p) => `Checking ${p.file}…`), 'Done.']);
      case 'plugin.update': {
        const which = String(params.plugin ?? '');
        if (which === UNRAID_OS_PLUGIN)
          return problem(
            403,
            'not_allowed',
            'Whombat doesn’t change that; use the platform’s own screens for it.',
          );
        if (!confirm) return problem(400, 'confirm_required', 'Updating a plugin needs confirm.');
        const files =
          which === 'all'
            ? u.plugins.filter((p) => p.update && p.file !== UNRAID_OS_PLUGIN)
            : u.plugins.filter((p) => p.file === which);
        if (!files.length) return problem(404, 'unknown_plugin', 'That plugin isn’t installed.');
        return startTask(
          op,
          files.flatMap((p) => [
            `plugin update ${p.file}`,
            `${p.name} ${p.version} → ${p.update ?? p.version}`,
          ]),
          () => {
            u = {
              ...u,
              plugins: u.plugins.map((p) =>
                files.some((f) => f.file === p.file) && p.update
                  ? { ...p, version: p.update, update: null }
                  : p,
              ),
            };
          },
        );
      }
      case 'notification.archive': {
        const id = typeof params.id === 'string' ? params.id : null;
        if (id && !u.notifications.some((n) => n.id === id))
          return problem(404, 'unknown_notification', 'That notification is gone already.');
        u = { ...u, notifications: id ? u.notifications.filter((n) => n.id !== id) : [] };
        return { status: 200, body: { ok: true } };
      }
      case 'containers.check':
        return startTask(op, [
          '/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/dockerupdate check',
          'Done.',
        ]);
      case 'container.update': {
        const g = guests().find((x) => x.id === guestId);
        if (g?.platform !== 'docker') return problem(404, 'guest_not_found', 'That container isn’t there.');
        if (!g.template) return problem(409, 'no_template', 'That container has no template to update from.');
        if (!confirm) return problem(400, 'confirm_required', 'Updating a container needs confirm.');
        return startTask(
          op,
          [
            `update_container ${g.name}`,
            `Pulling image: ${g.image}:latest`,
            'Stopping container…',
            'Removing old container…',
            'Starting the new container…',
            'Done.',
          ],
          () => patchGuests((x) => (x.id === guestId ? { ...x, updateAvailable: false, uptimeS: 30 } : x)),
          guestId,
        );
      }
      case 'guest.autostart': {
        const g = guests().find((x) => x.id === guestId);
        if (!g || (g.platform !== 'docker' && g.platform !== 'libvirt'))
          return problem(404, 'guest_not_found', 'That guest isn’t there.');
        if (typeof params.on !== 'boolean') return problem(400, 'bad_request', 'on: true or false.');
        const on = params.on;
        patchGuests((x) => (x.id === guestId ? { ...x, autostart: on } : x));
        return { status: 200, body: { ok: true } };
      }
      default:
        return null;
    }
  };

  return (req) => {
    const { method, path, query, body } = req;
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
    const server = seg[0] === 'servers' ? seg[1] : undefined;
    if (method === 'POST' && server === SERVER && seg[2] === 'manage' && seg.length === 3) {
      const out = manage(body);
      if (out) return out;
    }
    if (method === 'GET' && server === SERVER && seg[2] === 'tasks' && seg[3]?.startsWith('unraid:')) {
      const t = tasks.get(seg[3]);
      return t
        ? { status: 200, body: taskStatus(t, Number(query.logStart ?? 0)) }
        : problem(404, 'task_not_found', 'That task isn’t there any more.');
    }
    const out = next(req);
    if (out?.status !== 200) return out;
    if (method === 'GET' && server === SERVER && seg.length === 2)
      return { ...out, body: patchDetail(out.body as HostServerDetail) };
    if (method === 'GET' && path.replace(/^\//, '') === 'fleet') {
      const fleet = out.body as { servers: { id: string; platform: string; os: string | null }[] };
      return {
        ...out,
        body: {
          ...fleet,
          servers: fleet.servers.map((s) =>
            s.id === SERVER ? { ...s, platform: 'unraid', os: `Unraid ${u.version}` } : s,
          ),
        },
      };
    }
    return out;
  };
}
