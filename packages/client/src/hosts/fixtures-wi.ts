/**
 * Stream WI's part of the servers' fixture world (Whombat incus-unraid.md IU-02…IU-04, IU-07; app
 * incus-unraid-wi.md AP-1583): `thetitan` becomes the Incus server it is — The Titan as `incus list --all-projects`,
 * `incus storage list`, `incus image list`, `incus profile list` and `incus network list` showed it on 2026-10-17:
 * projects `default` and `ci-platform`, pools `default`, `ci-nvme` and `demo`, `incusbr0` and the CI bridges, the cached
 * Debian and Ubuntu images and the computer base images, four profiles, the dev box's backup volume and the installer
 * ISOs, and `whombat-dev-box` as the guest this Whombat runs in (`self`). `withWi(handle, ctx)` wraps the hosts
 * fixtures' handler: it seeds the world once, answers the Incus reads and changes the hub would (the allowlist,
 * restricted keys and devices, keys from a profile, digests, the self guest's refusals, rename and move only when
 * stopped, profiles and volumes in use) and passes the rest on. Long changes are Incus operations (`incus:<uuid>`) that
 * report progress a few reads long, then end (a download of an alias the images server lacks fails). Not imported by
 * production code.
 */
import {
  type HostBackupVolume,
  type HostGuest,
  type HostGuestAction,
  type HostGuestConfig,
  type HostHint,
  type HostIncusDetail,
  type HostIncusImage,
  type HostIncusProfile,
  type HostManageOp,
  type HostNetworkLease,
  type HostServer,
  type HostServerDetail,
  type HostSnapshot,
  type HostTask,
  selfGuestAllows,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest, HostsFixtureWorld } from './fixtures';
import {
  INCUS_COMMON_IMAGES,
  INCUS_GROUP_KEYS,
  incusGuestId,
  incusRef,
  incusSizeBytes,
  incusSizeString,
  SELF_GUEST_REFUSED,
} from './incus';

const H = 3_600_000;
const DAY = 24 * H;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const SERVER = 'thetitan';

export interface WiFixtureContext {
  world: HostsFixtureWorld;
  now: number;
  refreshServer: (serverId: string) => void;
  /** The wall clock for tasks (tests pass a fixed one). */
  clock?: () => number;
}

type Handle = (req: HostsFixtureRequest) => HostsFixtureAnswer | null;

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
        details: { code },
        ...(fields ? { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, [v]])) } : {}),
      },
    },
  } satisfies HostsFixtureAnswer;
}

const ok = (body: Record<string, unknown> = {}): HostsFixtureAnswer => ({
  status: 200,
  body: { ok: true, auditId: 'aud_wi', ...body },
});

/** The hub's device string: type first, then the options by name. */
function deviceString(dev: Record<string, string>): string {
  const keys = Object.keys(dev)
    .filter((k) => k !== 'type')
    .sort();
  return [...(dev.type ? [`type=${dev.type}`] : []), ...keys.map((k) => `${k}=${dev[k]}`)].join(',');
}

function parseDevice(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last = '';
  for (const item of s.split(',')) {
    const i = item.indexOf('=');
    if (i < 0 && last) out[last] = `${out[last]},${item}`;
    else if (i > 0) {
      last = item.slice(0, i);
      out[last] = item.slice(i + 1);
    }
  }
  return out;
}

/** What the hub refuses to change on a device (MANAGE.md §2.5), or null. */
function deviceProblem(dev: Record<string, string>): string | null {
  if (dev.type === 'nic') {
    if (dev.network && !dev.nictype && !dev.parent) return null;
    if (!dev.network && dev.nictype === 'bridged' && dev.parent) return null;
    return 'only NICs on an Incus network or a host bridge are changed through Whombat';
  }
  if (dev.type === 'disk') {
    if (!dev.pool) return 'disks outside a storage pool (host paths) are not changed through Whombat';
    return null;
  }
  return `${dev.type || 'these'} devices are not changed through Whombat`;
}

/* The Titan ------------------------------------------------------------------------------------------- */

interface Seed {
  name: string;
  project: string;
  kind: 'vm' | 'container';
  state: 'running' | 'stopped';
  vcpu: number;
  cpu: number;
  memUsedMb: number;
  memLimitMb: number;
  image: string;
  addresses: string[];
  profiles: string[];
  config: Record<string, string>;
  devices: Record<string, Record<string, string>>;
  description?: string;
  self?: boolean;
  uptimeH: number;
  /** A restricted key the allowlist leaves out. */
  restricted?: string[];
}

const SEEDS: Seed[] = [
  {
    name: 'whombat-dev-box',
    project: 'default',
    kind: 'vm',
    state: 'running',
    vcpu: 4,
    cpu: 7.2,
    memUsedMb: 3932,
    memLimitMb: 16384,
    image: 'Whombat DEV image',
    addresses: ['10.100.1.160', '10.227.226.1'],
    profiles: ['default'],
    config: {
      'environment.PATH': '/run/wrappers/bin:/run/current-system/sw/bin',
      'limits.cpu': '4',
      'limits.memory': '16GiB',
      'raw.qemu': '-device i6300esb -action watchdog=reset -smbios type=1,serial=WBDEVBOX-A608A08261FE',
      'security.secureboot': 'false',
      'user.whombat.role': 'dev-box',
    },
    devices: {
      backup: { type: 'disk', pool: 'default', source: 'whombat-dev-box-backup' },
      eth0: { type: 'nic', nictype: 'macvlan', parent: 'enp174s0' },
      root: { type: 'disk', path: '/', pool: 'default', size: '128GiB', 'boot.priority': '20' },
    },
    self: true,
    uptimeH: 14 * 24 + 3,
  },
  {
    name: 'whombat-prod-box',
    project: 'default',
    kind: 'vm',
    state: 'running',
    vcpu: 4,
    cpu: 2.1,
    memUsedMb: 5120,
    memLimitMb: 8192,
    image: 'Whombat image (pve-20260929.3)',
    addresses: ['10.100.1.170'],
    profiles: [],
    config: {
      'limits.cpu': '4',
      'limits.memory': '8GiB',
      'boot.autostart': 'true',
      'security.secureboot': 'false',
    },
    devices: {
      eth0: { type: 'nic', nictype: 'macvlan', parent: 'enp174s0' },
      installer: {
        type: 'disk',
        pool: 'default',
        source: 'whombat-installer-pve-20260928.6',
        'boot.priority': '5',
      },
      root: { type: 'disk', path: '/', pool: 'default', size: '64GiB' },
    },
    uptimeH: 19 * 24,
  },
  {
    name: 'dashboard',
    project: 'default',
    kind: 'container',
    state: 'running',
    vcpu: 2,
    cpu: 0.4,
    memUsedMb: 414,
    memLimitMb: 2048,
    image: 'Debian trixie amd64 (cloud)',
    addresses: ['10.62.52.73', '100.64.41.29'],
    profiles: ['default'],
    config: { 'boot.autostart': 'true', 'limits.cpu': '2', 'limits.memory': '2GiB', 'user.owner': 'john' },
    devices: { eth0: { type: 'nic', name: 'eth0', network: 'incusbr0', 'ipv4.address': '10.62.52.73' } },
    description: 'Home dashboard (Homepage) behind Tailscale.',
    uptimeH: 9 * 24 + 6,
  },
  {
    name: 'rackoon',
    project: 'default',
    kind: 'container',
    state: 'stopped',
    vcpu: 2,
    cpu: 0,
    memUsedMb: 0,
    memLimitMb: 2048,
    image: 'Debian trixie amd64',
    addresses: [],
    profiles: ['default'],
    config: { 'limits.memory': '2GiB' },
    devices: {},
    description: 'The old Rackoon, switched off since the one-Whombat move.',
    uptimeH: 0,
  },
  {
    name: 'whombat-link',
    project: 'default',
    kind: 'container',
    state: 'running',
    vcpu: 1,
    cpu: 0.1,
    memUsedMb: 52,
    memLimitMb: 256,
    image: 'Alpine 3.22',
    addresses: ['10.100.1.120'],
    profiles: ['default'],
    config: {
      'boot.autostart': 'true',
      'limits.cpu': '1',
      'limits.memory': '256MiB',
      'security.protection.delete': 'true',
    },
    devices: {
      eth0: { type: 'nic', nictype: 'macvlan', parent: 'enp174s0', name: 'eth0' },
      hub: { type: 'proxy', listen: 'tcp:127.0.0.1:18443', connect: 'tcp:10.100.1.160:8443', bind: 'host' },
    },
    description: 'Lets The Titan reach its own Whombat (IU-01).',
    uptimeH: 3,
  },
  {
    name: 'ci-job-a8791974d2434216a8d6d605430ba24f',
    project: 'ci-platform',
    kind: 'vm',
    state: 'running',
    vcpu: 8,
    cpu: 31.5,
    memUsedMb: 8172,
    memLimitMb: 16384,
    image: 'ci-template-linux',
    addresses: ['10.62.62.19'],
    profiles: [],
    config: { 'limits.cpu': '8', 'limits.memory': '16GiB', 'user.ci.job': 'a8791974' },
    devices: {
      eth0: { type: 'nic', name: 'eth0', network: 'cishared0' },
      root: { type: 'disk', path: '/', pool: 'ci-nvme', size: '64GiB' },
    },
    uptimeH: 0.4,
  },
  ...['android', 'appliance', 'linux', 'tracker'].map(
    (t): Seed => ({
      name: `ci-template-${t}`,
      project: 'ci-platform',
      kind: 'vm',
      state: 'stopped',
      vcpu: 8,
      cpu: 0,
      memUsedMb: 0,
      memLimitMb: 16384,
      image: 'Debian trixie amd64',
      addresses: [],
      profiles: [],
      config: { 'limits.cpu': '8', 'limits.memory': '16GiB' },
      devices: {
        eth0: { type: 'nic', name: 'eth0', network: 'cishared0' },
        root: { type: 'disk', path: '/', pool: 'ci-nvme', size: t === 'appliance' ? '96GiB' : '64GiB' },
      },
      description: `The ${t} CI template (copied for every job).`,
      uptimeH: 0,
    }),
  ),
];

function seedProfiles(): Map<string, HostIncusProfile> {
  const list: Omit<HostIncusProfile, 'usedBy' | 'digest' | 'restricted'>[] = [
    {
      name: 'default',
      project: 'default',
      description: 'Default profile with NAT networking and dir storage',
      config: { 'snapshots.expiry': '14d' },
      devices: {
        eth0: { type: 'nic', name: 'eth0', network: 'incusbr0' },
        root: { type: 'disk', path: '/', pool: 'default' },
      },
    },
    {
      name: 'bench-workstation',
      project: 'default',
      description: '',
      config: { 'limits.cpu': '8', 'limits.memory': '16GiB' },
      devices: { eth0: { type: 'nic', name: 'eth0', network: 'benchbr0' } },
    },
    {
      name: 'demo-arnica-workstation',
      project: 'default',
      description: 'Arnica Virtual Lab workstation',
      config: {
        'limits.cpu': '4',
        'limits.memory': '8GiB',
        'security.nesting': 'true',
        'raw.lxc': 'lxc.apparmor.profile=unconfined',
      },
      devices: {
        eth0: { type: 'nic', name: 'eth0', network: 'arnicabr0' },
        root: { type: 'disk', path: '/', pool: 'demo' },
      },
    },
    {
      name: 'demo-workstation',
      project: 'default',
      description: '',
      config: {},
      devices: { root: { type: 'disk', path: '/', pool: 'demo' } },
    },
  ];
  return new Map(
    list.map((p, i) => [
      `${p.project}/${p.name}`,
      {
        ...p,
        usedBy: [],
        digest: `prof${i}a`,
        restricted: Object.keys(p.config).filter((k) => k.startsWith('raw.')),
      },
    ]),
  );
}

function seedImages(now: number): HostIncusImage[] {
  const img = (
    fingerprint: string,
    aliases: string[],
    description: string,
    type: HostIncusImage['type'],
    mib: number,
    daysAgo: number,
    cached: boolean,
  ): HostIncusImage => ({
    fingerprint,
    aliases,
    description,
    type,
    architecture: 'x86_64',
    sizeBytes: Math.round(mib * MIB),
    uploadedAt: new Date(now - daysAgo * DAY).toISOString(),
    lastUsedAt: cached ? new Date(now - Math.max(0, daysAgo - 1) * DAY).toISOString() : null,
    autoUpdate: cached,
    cached,
    project: 'default',
  });
  return [
    img(
      '2414f095c8799fc2a3943aa45158188ff17683df31282832f534b24896751768',
      ['whombat-computer-base/4-u1000g1000'],
      'Whombat computer base 4-u1000g1000',
      'container',
      722.33,
      15,
      false,
    ),
    img(
      '177431cccc4463e21d5951d3681a0dbc54bb82c97c2b0a25a41c47d32f2c094a',
      ['whombat-computer-base/5-u1000g1000'],
      'Whombat computer base 5-u1000g1000',
      'container',
      1033.46,
      14,
      false,
    ),
    img(
      '6d2c6fde5e02c8ef8d9da0c99fbcc33bfc20c626d693170e02ca50815d9ccf4a',
      [],
      'Debian trixie amd64 (20261016_05:24)',
      'virtual-machine',
      378.07,
      1,
      true,
    ),
    img(
      '44d446930fade067089cf227818b2d70d612d1c80331550f18e18cb84cdb7dd0',
      [],
      'Debian trixie amd64 (20260730_05:24)',
      'virtual-machine',
      377.05,
      78,
      true,
    ),
    img(
      '1950711f78839b17f3c52dd493b8853a86a1b242aba0e0a1feaf5e0a75edb8cd',
      [],
      'Ubuntu noble amd64 (20261016_07:42)',
      'virtual-machine',
      326.94,
      1,
      true,
    ),
    img(
      'a31a92f119c6b3cdf7eaec84c14d1e3c657d336cbfb661a0ab23658c0a6378ec',
      [],
      'Debian trixie amd64 (20261016_05:24)',
      'container',
      100.59,
      1,
      true,
    ),
    img(
      'fa55751c9ee21bcb0bcf5395c1d2070a0634db6efb4a260e36373b8cc0b0e434',
      [],
      'Debian trixie amd64 cloud (20261016_05:24)',
      'virtual-machine',
      347.47,
      1,
      true,
    ),
  ];
}

function seedIncus(now: number): HostIncusDetail {
  return {
    version: '6.0.4',
    clustered: false,
    projects: [
      { name: 'default', description: 'Default Incus project', instances: 0, running: 0 },
      { name: 'ci-platform', description: '', instances: 0, running: 0 },
    ],
    pools: [
      {
        name: 'default',
        driver: 'zfs',
        status: 'Created',
        description: '',
        usedBytes: Math.round(84.25 * GIB),
        totalBytes: Math.round(1.45 * 1024 * GIB),
        volumes: 4,
      },
      {
        name: 'ci-nvme',
        driver: 'zfs',
        status: 'Created',
        description: 'The CI runners’ NVMe',
        usedBytes: Math.round(438.34 * GIB),
        totalBytes: Math.round(1.76 * 1024 * GIB),
        volumes: 0,
      },
      {
        name: 'demo',
        driver: 'zfs',
        status: 'Created',
        description: '',
        usedBytes: Math.round(26.5 * MIB),
        totalBytes: Math.round(1.36 * 1024 * GIB),
        volumes: 0,
      },
    ],
    networks: [
      ...(
        [
          ['incusbr0', '10.62.52.1/24', 4, ''],
          ['cishared0', '10.62.62.1/24', 5, 'The CI runners’ network'],
          ['arnicabr0', '10.62.56.1/24', 1, ''],
          ['benchbr0', '10.62.53.1/24', 1, ''],
          ['testerbr0', '10.62.54.1/24', 0, ''],
          ['readinessbr0', '10.62.55.1/24', 0, ''],
          ['jamesqual0', '10.62.57.1/24', 0, ''],
          ['rebootbr0', '10.62.58.1/24', 0, ''],
        ] as const
      ).map(([name, ipv4, usedBy, description]) => ({
        name,
        type: 'bridge',
        managed: true,
        description,
        ipv4,
        ipv6: null,
        nat: true,
        usedBy,
      })),
      {
        name: 'enp174s0',
        type: 'physical',
        managed: false,
        description: '',
        ipv4: null,
        ipv6: null,
        nat: null,
        usedBy: 3,
      },
      {
        name: 'docker0',
        type: 'bridge',
        managed: false,
        description: '',
        ipv4: null,
        ipv6: null,
        nat: null,
        usedBy: 0,
      },
    ],
    profiles: [],
    images: seedImages(now),
    volumes: [
      {
        pool: 'default',
        name: 'whombat-dev-box-backup',
        project: 'default',
        type: 'custom',
        contentType: 'block',
        sizeBytes: 64 * GIB,
        usedBytes: Math.round(21.7 * GIB),
        usedBy: ['incus:whombat-dev-box'],
        description: 'The DEV box’s backup disk',
      },
      {
        pool: 'default',
        name: 'whombat-dev-box-installer',
        project: 'default',
        type: 'custom',
        contentType: 'iso',
        sizeBytes: Math.round(2.31 * GIB),
        usedBytes: Math.round(2.31 * GIB),
        usedBy: [],
        description: '',
      },
      {
        pool: 'default',
        name: 'whombat-installer-pve-20260928.4',
        project: 'default',
        type: 'custom',
        contentType: 'iso',
        sizeBytes: Math.round(2.28 * GIB),
        usedBytes: Math.round(2.28 * GIB),
        usedBy: [],
        description: '',
      },
      {
        pool: 'default',
        name: 'whombat-installer-pve-20260928.6',
        project: 'default',
        type: 'custom',
        contentType: 'iso',
        sizeBytes: Math.round(2.29 * GIB),
        usedBytes: Math.round(2.29 * GIB),
        usedBy: ['incus:whombat-prod-box'],
        description: '',
      },
    ],
  };
}

interface Backup {
  guestId: string;
  name: string;
  created: number;
  expires: number | null;
  sizeBytes: number;
  optimized: boolean;
  instanceOnly: boolean;
}

interface FakeTask {
  id: string;
  type: string;
  guestId?: string;
  started: number;
  reads: number;
  steps: number;
  lines: string[];
  result: 'ok' | 'error';
  message: string;
  cancellable: boolean;
  ended?: number;
  onDone?: () => void;
}

/** Wrap the hosts fixtures' handler with stream WI's Incus world (see the file's comment). */
export function withWi(next: Handle, ctx: WiFixtureContext): Handle {
  const { world, now, refreshServer } = ctx;
  const clock = ctx.clock ?? (() => Date.now());
  const incus = seedIncus(now);
  const profiles = seedProfiles();
  const backups: Backup[] = [];
  const tasks = new Map<string, FakeTask>();
  /** Operations of the last 48 hours that aren't fake tasks (the seed). */
  const history: HostTask[] = [];
  /** The guests' own config and devices (the expanded ones are worked out from them and their profiles). */
  const own = new Map<
    string,
    {
      config: Record<string, string>;
      devices: Record<string, Record<string, string>>;
      profiles: string[];
      description: string;
      digest: number;
    }
  >();
  let seq = 0;
  const uuid = () => {
    const n = (++seq).toString(16).padStart(4, '0');
    return `5e1f${n}a0-${n}-4c1d-9b2e-${String(now % 1e12).padStart(12, '0')}`.slice(0, 36);
  };

  const guestsOf = () => world.guests.get(SERVER) ?? [];
  const findGuest = (id: string) => guestsOf().find((g) => g.id === id);
  const setGuests = (list: HostGuest[]) => {
    world.guests.set(SERVER, list);
    refreshServer(SERVER);
  };
  const patchGuest = (id: string, patch: Partial<HostGuest>) =>
    setGuests(guestsOf().map((g) => (g.id === id ? { ...g, ...patch } : g)));
  const cfgKey = (id: string) => `${SERVER}/${id}`;

  /** The configuration the hub's config.get answers (MANAGE.md §2.5): expanded, with inherited and restricted keys. */
  function configOf(id: string): HostGuestConfig | null {
    const g = findGuest(id);
    const o = own.get(id);
    if (!g || !o) return null;
    const values: Record<string, string> = {};
    const inherited: string[] = [];
    const restricted: string[] = [];
    const devices: Record<string, Record<string, string>> = {};
    for (const p of o.profiles) {
      const prof = profiles.get(`default/${p}`);
      if (!prof) continue;
      for (const [k, v] of Object.entries(prof.config)) values[k] = v;
      for (const [k, v] of Object.entries(prof.devices)) devices[k] = v;
    }
    for (const k of Object.keys(values)) if (!(k in o.config)) inherited.push(k);
    for (const k of Object.keys(devices)) if (!(k in o.devices)) inherited.push(`device.${k}`);
    Object.assign(values, o.config);
    Object.assign(devices, o.devices);
    for (const k of Object.keys(values))
      if (!INCUS_GROUP_KEYS.has(k) && !k.startsWith('user.') && k !== 'description') restricted.push(k);
    for (const [k, d] of Object.entries(devices)) {
      values[`device.${k}`] = deviceString(d);
      if (deviceProblem(d)) restricted.push(`device.${k}`);
    }
    if (o.description) values.description = o.description;
    const disks = Object.entries(devices)
      .filter(([, d]) => d.type === 'disk')
      .map(([k, d]) => ({
        key: k,
        storage: d.pool,
        volume: d.source,
        path: d.path,
        media: 'disk' as const,
        sizeBytes:
          incusSizeBytes(d.size) ?? (d.path === '/' ? (g.kind === 'vm' ? 10 * GIB : undefined) : undefined),
        boot: d.path === '/' || !!d['boot.priority'],
      }))
      .map((d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) as typeof d);
    return {
      platform: 'incus',
      kind: g.kind,
      digest: `etag-${id}-${o.digest}`,
      running: g.state === 'running',
      values,
      restricted: restricted.sort(),
      inherited: inherited.sort(),
      profiles: [...o.profiles],
      disks,
    };
  }

  /** Recount what depends on the guests: projects, profiles' users, volumes' users, the server's page. */
  function recount() {
    const list = guestsOf().filter((g) => g.platform === 'incus');
    for (const p of incus.projects) {
      const mine = list.filter((g) => incusRef(g.id).project === p.name);
      p.instances = mine.length;
      p.running = mine.filter((g) => g.state === 'running').length;
    }
    for (const p of profiles.values()) {
      p.usedBy = list.filter((g) => own.get(g.id)?.profiles.includes(p.name)).map((g) => g.id);
    }
    incus.profiles = [...profiles.values()].map((p) => ({
      name: p.name,
      project: p.project,
      description: p.description,
      usedBy: p.usedBy.length,
    }));
    for (const v of incus.volumes) {
      v.usedBy = list
        .filter((g) =>
          Object.values(own.get(g.id)?.devices ?? {}).some(
            (d) => d.type === 'disk' && d.pool === v.pool && d.source === v.name,
          ),
        )
        .map((g) => g.id);
    }
    for (const pool of incus.pools) pool.volumes = incus.volumes.filter((v) => v.pool === pool.name).length;
  }

  /* The seed ---------------------------------------------------------------------------------------- */

  const seedGuest = (s: Seed): HostGuest => {
    const on = s.state === 'running';
    const id = incusGuestId(s.project, s.name);
    own.set(id, {
      config: { ...s.config },
      devices: JSON.parse(JSON.stringify(s.devices)),
      profiles: [...s.profiles],
      description: s.description ?? '',
      digest: 1,
    });
    return {
      id,
      serverId: SERVER,
      serverOnline: true,
      name: s.name,
      platform: 'incus',
      kind: s.kind,
      image: s.image,
      state: s.state,
      vcpu: s.vcpu,
      cpuPct: on ? s.cpu : null,
      memoryUsedMb: on ? s.memUsedMb : null,
      memoryLimitMb: s.memLimitMb,
      diskReadMbs: on ? Math.round(s.cpu * 3) / 10 : null,
      diskWriteMbs: on ? Math.round(s.cpu * 5) / 10 : null,
      netRxMbps: on ? Math.round(s.cpu * 13) / 10 : null,
      netTxMbps: on ? Math.round(s.cpu * 7) / 10 : null,
      snapshots: 0,
      uptimeS: on ? Math.round(s.uptimeH * 3600) : null,
      console: {
        available: on,
        protocols: s.kind === 'vm' ? ['vnc', 'serial'] : ['shell'],
        defaultProtocol: s.kind === 'vm' ? 'vnc' : 'shell',
      },
      project: s.project,
      addresses: on ? s.addresses : [],
      lastBackup: null,
      tags: [],
      ...(s.self ? { self: true } : {}),
    };
  };
  const incusGuests = SEEDS.map(seedGuest);
  // The Titan runs 45 Docker containers; the mock's world has 40 (and 54 guests on thetitan): four more, stopped.
  const docker = guestsOf().filter((g) => g.platform === 'docker');
  const spare = docker.find((g) => g.state === 'stopped');
  const extra = spare
    ? ['buildx-cache', 'act-runner', 'mailpit-old', 'renovate'].map((n) => ({
        ...spare,
        id: `docker:${n}`,
        name: n,
        image: `${n}:latest`,
      }))
    : [];
  world.guests.set(SERVER, [...docker, ...extra, ...incusGuests]);

  // Backups: dashboard's two (one Whombat made before an upgrade), the dev box's one (allowed for the self guest).
  backups.push(
    {
      guestId: 'incus:dashboard',
      name: 'whombat-20261014-0210',
      created: now - 3 * DAY - 2 * H,
      expires: now + 4 * DAY - 2 * H,
      sizeBytes: Math.round(612 * MIB),
      optimized: true,
      instanceOnly: false,
    },
    {
      guestId: 'incus:dashboard',
      name: 'before-homepage-1.4',
      created: now - 9 * DAY,
      expires: now + 21 * DAY,
      sizeBytes: Math.round(598 * MIB),
      optimized: false,
      instanceOnly: true,
    },
    {
      guestId: 'incus:whombat-dev-box',
      name: 'whombat-20261016-0300',
      created: now - 1 * DAY - 9 * H,
      expires: now + 6 * DAY - 9 * H,
      sizeBytes: Math.round(18.4 * GIB),
      optimized: true,
      instanceOnly: true,
    },
  );
  // Snapshots: dashboard has a schedule's leftovers; the dev box one Whombat took before an update.
  const snaps = (id: string, list: HostSnapshot[]) => world.snapshots.set(cfgKey(id), list);
  for (const g of incusGuests) snaps(g.id, []);
  snaps('incus:dashboard', [
    { name: 'snap12', created: new Date(now - 2 * DAY).toISOString(), description: '' },
    { name: 'snap13', created: new Date(now - DAY).toISOString(), description: '' },
  ]);
  snaps('incus:whombat-dev-box', [
    {
      name: 'before-0.89.0',
      created: new Date(now - 6 * H).toISOString(),
      description: 'Before the 0.89.0 update',
    },
  ]);
  own.get('incus:dashboard')?.config &&
    Object.assign(own.get('incus:dashboard')?.config ?? {}, { 'snapshots.schedule': '@daily' });
  // Operations of the last two days (the System tab's and each instance's Tasks).
  history.push(
    {
      id: 'incus:3f9a2c41-8d7e-4b1a-9c55-2b7f0e1d6a90',
      type: 'backup.create',
      platform: 'incus',
      guestId: 'incus:whombat-dev-box',
      started: new Date(now - DAY - 9 * H).toISOString(),
      ended: new Date(now - DAY - 9 * H + 7 * 60_000).toISOString(),
      status: 'ok',
      message: 'Backing up instance',
      user: 'whombat',
    },
    {
      id: 'incus:a0c1e7d2-55b3-4f10-8e2a-6c9d4b3e1f07',
      type: 'instance.create',
      platform: 'incus',
      guestId: 'incus:ci-platform/ci-job-a8791974d2434216a8d6d605430ba24f',
      started: new Date(now - 0.4 * H).toISOString(),
      ended: new Date(now - 0.4 * H + 41_000).toISOString(),
      status: 'ok',
      message: 'Copying instance',
      user: 'ci-platform',
    },
    {
      id: 'incus:77d4b0e9-1a2c-4e3f-b5d6-0f9e8d7c6b5a',
      type: 'image.refresh',
      platform: 'incus',
      started: new Date(now - 18 * H).toISOString(),
      ended: new Date(now - 18 * H + 30_000).toISOString(),
      status: 'error',
      message: 'Failed to refresh image: the images server didn’t answer in time',
      user: 'incus',
    },
    {
      id: 'incus:0b7e5f3a-9c2d-4a1b-8e6f-d4c3b2a19f08',
      type: 'snapshot.create',
      platform: 'incus',
      guestId: 'incus:dashboard',
      started: new Date(now - DAY).toISOString(),
      ended: new Date(now - DAY + 3_000).toISOString(),
      status: 'ok',
      message: 'Snapshotting instance',
      user: 'incus',
    },
  );
  const hints: HostHint[] = [
    {
      serverId: SERVER,
      kind: 'incus.no_snapshots',
      severity: 'info',
      entity: 'snapshots',
      title: '2 machines aren’t backed up',
      detail: 'whombat-prod-box, whombat-link · no scheduled snapshots, no backup in 30 days',
      section: 'guests',
    },
    {
      serverId: SERVER,
      kind: 'incus.warning',
      severity: 'info',
      entity: 'apparmor',
      title: 'Incus has 1 warning',
      detail: 'Skipping AppArmor for dnsmasq due to raw.dnsmasq being set (4 networks).',
      section: 'system',
    },
  ];
  world.hints = [...world.hints.filter((h) => h.serverId !== SERVER), ...hints];
  recount();
  refreshServer(SERVER);

  /* Reads -------------------------------------------------------------------------------------------- */

  const iso = (ms: number) => new Date(ms).toISOString();

  function patchServerRow(s: HostServer): HostServer {
    return s.id === SERVER ? { ...s, platform: 'incus', hostsThisWhombat: true } : s;
  }

  function detail(): HostServerDetail | null {
    const d = world.details.get(SERVER);
    if (!d) return null;
    const incusW = d.workloads?.incus;
    const running = (incusW?.guests ?? []).filter((g) => g.state === 'running');
    return {
      ...d,
      server: {
        ...d.server,
        platform: 'incus',
        hostsThisWhombat: true,
        roles: ['incus-host', 'docker-host'],
      },
      virtualization: {
        stacks: ['incus'],
        capabilities: {
          kvm: { enabled: true, module: 'kvm_amd', device: '/dev/kvm' },
          cpuVirtualization: { type: 'AMD-V', flag: 'svm', nestedPaging: true },
          iommu: { enabled: true, groups: 58, vfioPciDevices: 0 },
          nested: { enabled: true, moduleParam: 'nested=1' },
          ksm: null,
          ballooning: null,
        },
        allocation: {
          vcpuAllocated: running.reduce((a, g) => a + (g.vcpu ?? 0), 0),
          hostThreads: d.server.cpu?.threads ?? 64,
          vcpuOvercommitRatio:
            Math.round(
              (running.reduce((a, g) => a + (g.vcpu ?? 0), 0) / (d.server.cpu?.threads ?? 64)) * 100,
            ) / 100,
          guestMemoryAssignedGb: Math.round(running.reduce((a, g) => a + (g.memoryLimitMb ?? 0), 0) / 1024),
          hostMemoryGb: d.server.memory?.totalGb ?? 188,
          guestMemoryInUseGb: Math.round(running.reduce((a, g) => a + (g.memoryUsedMb ?? 0), 0) / 102.4) / 10,
          diskIoMbs: { total: 21, read: 6, write: 15 },
          networkMbps: { total: 58, rx: 37, tx: 21 },
        },
      },
      workloads: {
        ...d.workloads,
        ...(incusW
          ? {
              incus: {
                ...incusW,
                vms: incusW.guests.filter((g) => g.kind === 'vm').length,
                containers: incusW.guests.filter((g) => g.kind === 'container').length,
                warnings: [
                  {
                    type: 'AppArmor',
                    message: 'Skipping AppArmor for dnsmasq due to raw.dnsmasq being set',
                    count: 4,
                    lastSeen: iso(now - 13 * DAY),
                    project: 'default',
                  },
                ],
              },
            }
          : {}),
      },
      incus: JSON.parse(JSON.stringify(incus)) as HostIncusDetail,
    } as HostServerDetail;
  }

  const backupVolume = (b: Backup): HostBackupVolume =>
    ({
      volume: b.name,
      storage: 'incus',
      guest: b.guestId,
      kind: findGuest(b.guestId)?.kind,
      sizeBytes: b.sizeBytes,
      created: iso(b.created),
      format: b.optimized ? 'optimized' : 'tar',
      notes: b.expires ? `expires ${iso(b.expires)}` : '',
      expiresAt: b.expires ? iso(b.expires) : null,
    }) as HostBackupVolume;

  const choices = (project: string) => ({
    platform: 'incus' as const,
    node: SERVER,
    storages: incus.pools.map((p) => ({
      id: p.name,
      type: p.driver,
      content: ['images', 'rootdir'],
      availBytes: (p.totalBytes ?? 0) - (p.usedBytes ?? 0),
      totalBytes: p.totalBytes ?? undefined,
      thin: true,
    })),
    bridges: incus.networks.filter((n) => n.managed).map((n) => n.name),
    profiles: [...profiles.values()].map((p) => p.name),
    images: incus.images
      .filter((i) => i.project === project || project !== 'default')
      .map((i) => ({
        fingerprint: i.fingerprint,
        aliases: i.aliases,
        description: i.description,
        type: i.type,
      })),
    projects: incus.projects.map((p) => p.name),
    remoteImages: INCUS_COMMON_IMAGES.flatMap((alias) => [
      { alias, description: alias, type: 'container' },
      { alias, description: alias, type: 'virtual-machine' },
      { alias: `${alias}/cloud`, description: `${alias} with cloud-init`, type: 'container' },
      { alias: `${alias}/cloud`, description: `${alias} with cloud-init`, type: 'virtual-machine' },
    ]),
  });

  function leases(network: string): HostNetworkLease[] {
    const out: HostNetworkLease[] = [];
    const net = incus.networks.find((n) => n.name === network);
    if (net?.ipv4)
      out.push({
        hostname: `${network}.gw`,
        address: net.ipv4.split('/')[0] ?? '',
        hwaddr: '',
        type: 'gateway',
        guestId: null,
      });
    let host = 20;
    for (const g of guestsOf()) {
      if (g.platform !== 'incus') continue;
      // The profiles' devices, then the instance's own under the same name (the dev box's own eth0 is macvlan).
      const merged: Record<string, Record<string, string>> = {};
      for (const p of own.get(g.id)?.profiles ?? [])
        Object.assign(merged, profiles.get(`default/${p}`)?.devices ?? {});
      Object.assign(merged, own.get(g.id)?.devices ?? {});
      const nic = Object.values(merged).find((d) => d.type === 'nic' && d.network === network);
      if (!nic) continue;
      const fixed = nic['ipv4.address'];
      const base = net?.ipv4?.split('.').slice(0, 3).join('.') ?? '10.0.0';
      out.push({
        hostname: incusRef(g.id).name,
        address: fixed ?? g.addresses?.find((a) => a.startsWith(base)) ?? `${base}.${host++}`,
        hwaddr: `10:66:6a:${(g.name.length * 7).toString(16).padStart(2, '0')}:${(g.name.charCodeAt(0) % 256).toString(16).padStart(2, '0')}:${(g.name.charCodeAt(1) % 256).toString(16).padStart(2, '0')}`,
        type: fixed ? 'static' : 'dynamic',
        guestId: g.id,
      });
    }
    return out;
  }

  function logOf(g: HostGuest, lines: number): { file: string; lines: string[] } {
    const vm = g.kind === 'vm';
    const t0 = now - (g.uptimeS ?? 3600) * 1000;
    const stamp = (s: number) => new Date(t0 + s * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const out = vm
      ? [
          `${stamp(0)} QEMU 9.2.4 monitor - type 'help' for more information`,
          `${stamp(0)} qemu-system-x86_64: -device virtio-net-pci: starting the network card`,
          `${stamp(1)} char device redirected to /dev/pts/4 (label console)`,
          `${stamp(1)} warning: host doesn't support requested feature: CPUID.80000001H:ECX.svm [bit 2]`,
          `${stamp(2)} vfio: no devices to pass through`,
          `${stamp(4)} agent: guest agent connected`,
          ...Array.from({ length: 30 }, (_, i) => `${stamp(60 + i * 3600)} agent: ping ok`),
        ]
      : [
          `lxc ${g.name} ${stamp(0)} INFO     lxccontainer - ../src/lxc/lxccontainer.c:do_lxcapi_start:997 - Starting the container`,
          `lxc ${g.name} ${stamp(0)} INFO     conf - ../src/lxc/conf.c:run_script_argv:340 - Executing script "/proc/2147/exe callhook /var/lib/incus default ${g.name} start" for container "${g.name}"`,
          `lxc ${g.name} ${stamp(1)} INFO     cgfsng - ../src/lxc/cgroups/cgfsng.c:cgfsng_monitor_create:1388 - The monitor process uses "lxc.monitor.${g.name}" as cgroup`,
          `lxc ${g.name} ${stamp(1)} INFO     start - ../src/lxc/start.c:lxc_spawn:1772 - Started "/sbin/init" with pid 4721`,
          `lxc ${g.name} ${stamp(2)} NOTICE   start - ../src/lxc/start.c:post_start:2209 - Started "/sbin/init" with pid 4721`,
          ...Array.from(
            { length: 12 },
            (_, i) =>
              `lxc ${g.name} ${stamp(3600 * (i + 1))} INFO     network - ../src/lxc/network.c:lxc_setup_network_in_child_namespaces:4008 - Network device eth0 is up`,
          ),
        ];
    if (g.state !== 'running') out.push(`${stamp(9)} The instance is stopped.`);
    return { file: vm ? 'qemu.log' : 'lxc.log', lines: out.slice(-Math.max(1, Math.min(2000, lines))) };
  }

  /* Tasks --------------------------------------------------------------------------------------------- */

  function start(t: Omit<FakeTask, 'id' | 'started' | 'reads'>): string {
    const id = `incus:${uuid()}`;
    tasks.set(id, { ...t, id, started: clock(), reads: 0 });
    return id;
  }

  function view(t: FakeTask, logStart: number): HostTask {
    const ended = t.reads >= t.steps;
    const shown = ended
      ? t.lines.length
      : Math.min(t.lines.length, Math.ceil((t.reads / t.steps) * t.lines.length));
    const from = logStart < 0 ? shown : Math.max(0, logStart);
    return {
      id: t.id,
      type: t.type,
      platform: 'incus',
      ...(t.guestId ? { guestId: t.guestId } : {}),
      user: 'whombat',
      started: iso(t.started),
      ended: ended ? iso(t.ended ?? clock()) : null,
      status: ended ? t.result : 'running',
      message: ended ? t.message : (t.lines[Math.max(0, shown - 1)] ?? 'Working'),
      log: t.lines.slice(from, shown),
      logNext: shown,
      ...(!ended && t.cancellable ? ({ cancellable: true } as object) : {}),
    } as HostTask;
  }

  function step(t: FakeTask) {
    if (t.reads >= t.steps) return;
    t.reads++;
    if (t.reads >= t.steps) {
      t.ended = clock();
      if (t.result === 'ok') t.onDone?.();
      recount();
      refreshServer(SERVER);
    }
  }

  const taskList = (guestId?: string): HostTask[] =>
    [...[...tasks.values()].map((t) => view(t, -1)), ...history]
      .filter((t) => !guestId || t.guestId === guestId)
      .sort((a, b) => b.started.localeCompare(a.started));

  /* Changes ------------------------------------------------------------------------------------------- */

  const selfRefusal = () => problem(409, 'self_guest', SELF_GUEST_REFUSED);
  const stoppedOnly = (g: HostGuest, verb: string) =>
    g.state !== 'stopped'
      ? problem(409, 'guest_running', `Stop ${g.name} first: Incus ${verb} only a stopped instance.`)
      : null;

  function bump(id: string) {
    const o = own.get(id);
    if (o) o.digest++;
  }

  function addGuest(
    from: HostGuest | null,
    id: string,
    extra: Partial<HostGuest> & { kind: HostGuest['kind'] },
    cfg: {
      config: Record<string, string>;
      devices: Record<string, Record<string, string>>;
      profiles: string[];
      description: string;
    },
  ) {
    const { project, name } = incusRef(id);
    const g: HostGuest = {
      ...(from ?? (guestsOf().find((x) => x.platform === 'incus') as HostGuest)),
      id,
      name,
      project,
      state: 'stopped',
      cpuPct: null,
      memoryUsedMb: null,
      uptimeS: null,
      addresses: [],
      snapshots: 0,
      lastBackup: null,
      console: { ...(from?.console ?? { available: false }), available: false },
      ...extra,
    };
    delete g.self;
    own.set(id, { ...JSON.parse(JSON.stringify(cfg)), digest: 1 });
    world.snapshots.set(cfgKey(id), []);
    setGuests([...guestsOf(), g]);
  }

  function rekey(from: string, to: string) {
    const o = own.get(from);
    if (o) {
      own.delete(from);
      own.set(to, o);
    }
    const s = world.snapshots.get(cfgKey(from));
    world.snapshots.delete(cfgKey(from));
    world.snapshots.set(cfgKey(to), s ?? []);
    for (const b of backups) if (b.guestId === from) b.guestId = to;
    const { project, name } = incusRef(to);
    setGuests(guestsOf().map((g) => (g.id === from ? { ...g, id: to, name, project } : g)));
  }

  function configSet(g: HostGuest, body: Record<string, unknown>): HostsFixtureAnswer {
    const o = own.get(g.id);
    const cfg = configOf(g.id);
    if (!o || !cfg) return problem(404, 'unknown_guest', 'That instance isn’t there.');
    if (body.digest && body.digest !== cfg.digest)
      return problem(409, 'digest_mismatch', 'Changed meanwhile — review again.');
    const p = (body.params ?? {}) as { set?: Record<string, string>; delete?: string[]; profiles?: string[] };
    const changes: { key: string; old?: string; new?: string }[] = [];
    const fields: Record<string, string> = {};
    const next = JSON.parse(JSON.stringify(o)) as typeof o;
    for (const [k, v] of Object.entries(p.set ?? {})) {
      const old = cfg.values[k];
      if (cfg.restricted?.includes(k))
        return problem(403, 'not_allowed', `${k} is changed with the incus command.`, {
          [k]: 'This is changed with the incus command.',
        });
      if (k === 'description') next.description = v;
      else if (k.startsWith('device.')) {
        const name = k.slice(7);
        if (v === '') {
          if (!(name in next.devices)) {
            fields[k] = 'This device comes from a profile; change the profile.';
            continue;
          }
          delete next.devices[name];
        } else {
          const dev = parseDevice(v);
          const why = deviceProblem(dev);
          if (why) {
            fields[k] = why;
            continue;
          }
          if (dev.network && !incus.networks.some((n) => n.name === dev.network && n.managed)) {
            fields[k] = `There’s no Incus network called ${dev.network}.`;
            continue;
          }
          if (dev.pool && !incus.pools.some((x) => x.name === dev.pool)) {
            fields[k] = `There’s no pool called ${dev.pool}.`;
            continue;
          }
          if (dev.source && !incus.volumes.some((x) => x.pool === dev.pool && x.name === dev.source)) {
            fields[k] = `There’s no volume called ${dev.source} on ${dev.pool}.`;
            continue;
          }
          next.devices[name] = dev;
        }
      } else if (!INCUS_GROUP_KEYS.has(k) && !k.startsWith('user.'))
        return problem(403, 'not_allowed', `${k} is changed with the incus command.`);
      else if (v === '') {
        if (!(k in next.config)) {
          if (k in cfg.values) fields[k] = 'This comes from a profile; change the profile.';
          continue;
        }
        delete next.config[k];
      } else next.config[k] = v;
      changes.push({ key: k, old, ...(v === '' ? {} : { new: v }) });
    }
    if (Array.isArray(p.profiles)) {
      const unknown = p.profiles.find((x) => !profiles.has(`default/${x}`));
      if (unknown) fields.profiles = `There’s no profile called ${unknown}.`;
      else {
        changes.push({ key: 'profiles', old: o.profiles.join(', '), new: p.profiles.join(', ') });
        next.profiles = [...p.profiles];
      }
    }
    if (Object.keys(fields).length) return problem(400, 'invalid_value', 'Some values need a look.', fields);
    own.set(g.id, { ...next, digest: o.digest + 1 });
    const after = configOf(g.id);
    const cpu = after?.values['limits.cpu'];
    patchGuest(g.id, {
      ...(cpu && /^\d+$/.test(cpu) ? { vcpu: Number(cpu) } : {}),
      memoryLimitMb: (() => {
        const b = incusSizeBytes(after?.values['limits.memory']);
        return b ? Math.round(b / MIB) : g.memoryLimitMb;
      })(),
    });
    recount();
    return ok({ changes });
  }

  function manage(body: Record<string, unknown>): HostsFixtureAnswer | null {
    const op = String(body.op ?? '');
    const guestId = typeof body.guestId === 'string' ? body.guestId : '';
    const p = (body.params ?? {}) as Record<string, unknown>;
    const g = guestId ? findGuest(guestId) : undefined;
    if (guestId && !g)
      return guestId.startsWith('incus:')
        ? problem(404, 'unknown_guest', 'That instance isn’t there.')
        : null;
    if (g && g.platform !== 'incus') return null;
    if (
      !g &&
      p.platform !== 'incus' &&
      !op.startsWith('image.') &&
      !op.startsWith('profile.') &&
      !op.startsWith('volume.') &&
      op !== 'guest.create' &&
      op !== 'backup.restore' &&
      op !== 'backup.delete' &&
      op !== 'task.stop'
    )
      return null;
    if (g?.self && !selfGuestAllows({ op: op as HostManageOp, asNew: op === 'backup.restore' }))
      return selfRefusal();
    switch (op) {
      case 'config.set':
        return g ? configSet(g, body) : null;
      case 'disk.resize': {
        if (!g) return null;
        const o = own.get(g.id);
        const cfg = configOf(g.id);
        const disk = String(p.disk ?? 'root');
        const cur = cfg?.disks?.find((d) => d.key === disk)?.sizeBytes ?? 10 * GIB;
        const m = /^(\+)?(\d+)\s*G(iB)?$/i.exec(String(p.size ?? ''));
        if (!m || !o)
          return problem(400, 'invalid_value', 'Give a size like +8G.', { size: 'Give a size like +8G.' });
        const want = m[1] ? cur + Number(m[2]) * GIB : Number(m[2]) * GIB;
        if (want <= cur)
          return problem(400, 'invalid_value', `Disks only grow: it has ${incusSizeString(cur)}.`, {
            size: `Disks only grow: it has ${incusSizeString(cur)}.`,
          });
        const dev = o.devices[disk] ?? {
          ...(profiles.get('default/default')?.devices.root ?? { type: 'disk', path: '/', pool: 'default' }),
        };
        o.devices[disk] = { ...dev, size: incusSizeString(want) };
        bump(g.id);
        return ok({
          changes: [
            {
              key: `device.${disk}`,
              old: deviceString(dev),
              new: deviceString(o.devices[disk] as Record<string, string>),
            },
          ],
        });
      }
      case 'guest.create': {
        const nm = String(p.name ?? '').trim();
        const project = String(p.project ?? 'default');
        const image = String(p.image ?? '');
        const fields: Record<string, string> = {};
        if (!/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(nm))
          fields.name = 'Letters, digits and “-”, starting with a letter.';
        else if (findGuest(incusGuestId(project, nm)))
          fields.name = `There’s already an instance called ${nm}.`;
        if (!image) fields.image = 'Pick an image.';
        if (Object.keys(fields).length)
          return problem(400, 'invalid_value', 'Some fields need a look.', fields);
        const id = incusGuestId(project, nm);
        const remote = image.startsWith('images:');
        const missing =
          remote &&
          !INCUS_COMMON_IMAGES.some((a) => image.replace(/^images:/, '').replace(/\/cloud$/, '') === a);
        const kind = p.kind === 'vm' ? 'vm' : 'container';
        const set = (p.set ?? {}) as Record<string, string>;
        const devices: Record<string, Record<string, string>> = {};
        if (set['device.root']) devices.root = parseDevice(set['device.root']);
        else if (p.pool && p.pool !== 'default')
          devices.root = { type: 'disk', path: '/', pool: String(p.pool) };
        if (p.network) devices.eth0 = { type: 'nic', name: 'eth0', network: String(p.network) };
        const config = Object.fromEntries(Object.entries(set).filter(([k]) => !k.startsWith('device.')));
        if (p.cloudInit) config['cloud-init.user-data'] = String(p.cloudInit);
        const tid = start({
          type: 'instance.create',
          guestId: id,
          steps: 5,
          lines: [
            remote ? `Retrieving image: metadata: 100% (${image})` : `Using the local image ${image}`,
            ...(remote
              ? ['Retrieving image: rootfs: 38% (21.40MB/s)', 'Retrieving image: rootfs: 100% (24.88MB/s)']
              : []),
            'Unpacking image: 100%',
            missing
              ? `Error: Failed getting remote image info: Image "${image.replace(/^images:/, '')}" not found`
              : 'Creating the instance',
            ...(missing
              ? []
              : p.start
                ? ['Starting the instance', 'Instance created and started']
                : ['Instance created']),
          ],
          result: missing ? 'error' : 'ok',
          message: missing
            ? `The images server has no ${image.replace(/^images:/, '')}.`
            : 'Instance created',
          cancellable: true,
          onDone: () => {
            addGuest(
              null,
              id,
              {
                kind,
                image: image.replace(/^images:/, ''),
                state: p.start ? 'running' : 'stopped',
                cpuPct: p.start ? 0.3 : null,
                memoryUsedMb: p.start ? 180 : null,
                uptimeS: p.start ? 5 : null,
                vcpu: Number(set['limits.cpu'] ?? 2) || 2,
                memoryLimitMb: (incusSizeBytes(set['limits.memory']) ?? 2 * GIB) / MIB,
                console: {
                  available: !!p.start,
                  protocols: kind === 'vm' ? ['vnc', 'serial'] : ['shell'],
                  defaultProtocol: kind === 'vm' ? 'vnc' : 'shell',
                },
              },
              {
                config,
                devices,
                profiles: Array.isArray(p.profiles) ? (p.profiles as string[]) : ['default'],
                description: '',
              },
            );
          },
        });
        return ok({ task: { id: tid }, newId: id });
      }
      case 'guest.clone': {
        if (!g) return null;
        const nm = String(p.name ?? '').trim();
        const project = String(p.project ?? incusRef(g.id).project);
        if (!/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(nm))
          return problem(400, 'invalid_value', 'Check the name.', {
            name: 'Letters, digits and “-”, starting with a letter.',
          });
        const id = incusGuestId(project, nm);
        if (findGuest(id))
          return problem(409, 'exists', `There’s already an instance called ${nm}.`, {
            name: `There’s already an instance called ${nm}.`,
          });
        const src = own.get(g.id);
        const tid = start({
          type: 'instance.copy',
          guestId: id,
          steps: 4,
          lines: [
            `Copying ${g.name}${p.instanceOnly ? ' (without its snapshots)' : ''}`,
            'Transferring instance: 41%',
            'Transferring instance: 100%',
            'Instance copied',
          ],
          result: 'ok',
          message: 'Instance copied',
          cancellable: true,
          onDone: () => {
            const devices = JSON.parse(JSON.stringify(src?.devices ?? {})) as Record<
              string,
              Record<string, string>
            >;
            if (p.storage && devices.root) devices.root.pool = String(p.storage);
            else if (p.storage) devices.root = { type: 'disk', path: '/', pool: String(p.storage) };
            addGuest(
              g,
              id,
              { kind: g.kind },
              {
                config: { ...(src?.config ?? {}) },
                devices,
                profiles: [...(src?.profiles ?? [])],
                description: src?.description ?? '',
              },
            );
          },
        });
        return ok({ task: { id: tid }, newId: id });
      }
      case 'guest.rename': {
        if (!g) return null;
        const stopped = stoppedOnly(g, 'renames');
        if (stopped) return stopped;
        const nm = String(p.name ?? '').trim();
        if (!/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(nm))
          return problem(400, 'invalid_value', 'Check the name.', {
            name: 'Letters, digits and “-”, starting with a letter.',
          });
        const id = incusGuestId(incusRef(g.id).project, nm);
        if (findGuest(id))
          return problem(409, 'exists', `There’s already an instance called ${nm}.`, {
            name: `There’s already an instance called ${nm}.`,
          });
        const tid = start({
          type: 'rename',
          guestId: g.id,
          steps: 2,
          lines: [`Renaming ${g.name} to ${nm}`, 'Renamed'],
          result: 'ok',
          message: 'Renamed',
          cancellable: false,
          onDone: () => rekey(g.id, id),
        });
        return ok({ task: { id: tid }, newId: id });
      }
      case 'guest.move': {
        if (!g) return null;
        if (!body.confirm) return problem(400, 'confirm_required', 'Moving needs a yes first.');
        const stopped = stoppedOnly(g, 'moves');
        if (stopped) return stopped;
        const pool = p.pool ? String(p.pool) : undefined;
        const project = p.project ? String(p.project) : incusRef(g.id).project;
        if (pool && !incus.pools.some((x) => x.name === pool))
          return problem(400, 'invalid_value', `There’s no pool called ${pool}.`, {
            pool: `There’s no pool called ${pool}.`,
          });
        const id = incusGuestId(project, g.name);
        if (id !== g.id && findGuest(id))
          return problem(409, 'exists', `${project} already has an instance called ${g.name}.`);
        const tid = start({
          type: 'move',
          guestId: g.id,
          steps: 5,
          lines: [
            `Moving ${g.name}${pool ? ` to the pool ${pool}` : ''}${project !== incusRef(g.id).project ? ` to the project ${project}` : ''}`,
            'Transferring instance: 22%',
            'Transferring instance: 64%',
            'Transferring instance: 100%',
            'Moved',
          ],
          result: 'ok',
          message: 'Moved',
          cancellable: false,
          onDone: () => {
            const o = own.get(g.id);
            if (o && pool) o.devices.root = { ...(o.devices.root ?? { type: 'disk', path: '/' }), pool };
            if (id !== g.id) rekey(g.id, id);
            bump(id);
          },
        });
        return ok({ task: { id: tid }, newId: id });
      }
      case 'guest.publish': {
        if (!g) return null;
        if (!p.snapshot && g.state !== 'stopped')
          return problem(409, 'guest_running', `Stop ${g.name} first, or make the image from a snapshot.`);
        const alias = String(p.alias ?? '').trim();
        if (alias && incus.images.some((i) => i.aliases.includes(alias)))
          return problem(409, 'exists', `There’s already an image called ${alias}.`, {
            alias: `There’s already an image called ${alias}.`,
          });
        const fp =
          `${(g.name.length * 2654435761).toString(16).padStart(8, '0')}${'c0ffee'.repeat(10)}`.slice(0, 64);
        const tid = start({
          type: 'publish',
          guestId: g.id,
          steps: 5,
          lines: [
            `Publishing ${g.name}${p.snapshot ? ` (snapshot ${p.snapshot})` : ''}`,
            'Image pack: 30%',
            'Image pack: 100%',
            'Compressing: 100%',
            `Image published with fingerprint ${fp.slice(0, 12)}`,
          ],
          result: 'ok',
          message: 'Image published',
          cancellable: true,
          onDone: () =>
            incus.images.push({
              fingerprint: fp,
              aliases: alias ? [alias] : [],
              description: String(p.description ?? '') || `${g.name}${p.snapshot ? ` (${p.snapshot})` : ''}`,
              type: g.kind === 'vm' ? 'virtual-machine' : 'container',
              architecture: 'x86_64',
              sizeBytes: Math.round((g.kind === 'vm' ? 1.9 : 0.4) * GIB),
              uploadedAt: iso(clock()),
              lastUsedAt: null,
              autoUpdate: false,
              cached: false,
              project: incusRef(g.id).project,
            }),
        });
        return ok({ task: { id: tid }, newId: fp });
      }
      case 'guest.delete': {
        if (!g) return null;
        const stopped = stoppedOnly(g, 'deletes');
        if (stopped) return stopped;
        if (incusOnOwn(g.id, 'security.protection.delete'))
          return problem(
            409,
            'protected',
            `Protection is on for ${g.name}: turn it off in Configuration first.`,
          );
        const tid = start({
          type: 'delete',
          guestId: g.id,
          steps: 2,
          lines: [`Deleting ${g.name}`, 'Deleted'],
          result: 'ok',
          message: 'Deleted',
          cancellable: false,
          onDone: () => setGuests(guestsOf().filter((x) => x.id !== g.id)),
        });
        return ok({ task: { id: tid } });
      }
      case 'backup.create': {
        if (!g) return null;
        const nm =
          String(p.name ?? '') ||
          `whombat-${new Date(clock())
            .toISOString()
            .slice(0, 16)
            .replace(/[-:T]/g, '')
            .replace(/^(\d{8})(\d{4})$/, '$1-$2')}`;
        if (backups.some((b) => b.guestId === g.id && b.name === nm))
          return problem(409, 'exists', `${g.name} already has a backup called ${nm}.`, {
            name: 'That name is taken.',
          });
        const expires = typeof p.expiresAt === 'string' ? Date.parse(p.expiresAt) : clock() + 7 * DAY;
        const tid = start({
          type: 'backup.create',
          guestId: g.id,
          steps: 4,
          lines: [
            `Backing up ${g.name}${p.instanceOnly ? ' without its snapshots' : ''}`,
            'Backup progress: 35%',
            'Backup progress: 100%',
            `Backup ${nm} done`,
          ],
          result: 'ok',
          message: 'Backed up',
          cancellable: true,
          onDone: () => {
            backups.push({
              guestId: g.id,
              name: nm,
              created: clock(),
              expires: Number.isFinite(expires) ? expires : null,
              sizeBytes: Math.round((g.kind === 'vm' ? 6.4 : 0.6) * GIB),
              optimized: !!p.optimized,
              instanceOnly: !!p.instanceOnly,
            });
            patchGuest(g.id, { lastBackup: { result: 'ok', at: iso(clock()) } });
          },
        });
        return ok({ task: { id: tid } });
      }
      case 'backup.restore': {
        const from = String(p.guest ?? '');
        const src = findGuest(from);
        const b = backups.find((x) => x.guestId === from && x.name === p.volume);
        if (!src || !b) return problem(404, 'not_found', 'That backup isn’t there any more.');
        const nm = String(p.name ?? `${src.name}-restored`).trim();
        if (!/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(nm))
          return problem(400, 'invalid_value', 'Check the name.', {
            name: 'Letters, digits and “-”, starting with a letter.',
          });
        const id = incusGuestId(incusRef(from).project, nm);
        if (findGuest(id))
          return problem(409, 'exists', `There’s already an instance called ${nm}.`, {
            name: `There’s already an instance called ${nm}.`,
          });
        const srcCfg = own.get(from);
        const tid = start({
          type: 'backup.restore',
          guestId: id,
          steps: 4,
          lines: [
            `Restoring ${b.name} of ${src.name} as ${nm}`,
            'Importing backup: 48%',
            'Importing backup: 100%',
            p.start ? 'Started' : 'Restored',
          ],
          result: 'ok',
          message: 'Restored',
          cancellable: false,
          onDone: () => {
            const devices = JSON.parse(JSON.stringify(srcCfg?.devices ?? {})) as Record<
              string,
              Record<string, string>
            >;
            if (p.storage)
              devices.root = { ...(devices.root ?? { type: 'disk', path: '/' }), pool: String(p.storage) };
            addGuest(
              src,
              id,
              { kind: src.kind, state: p.start ? 'running' : 'stopped' },
              {
                config: { ...(srcCfg?.config ?? {}) },
                devices,
                profiles: [...(srcCfg?.profiles ?? [])],
                description: srcCfg?.description ?? '',
              },
            );
          },
        });
        return ok({ task: { id: tid }, newId: id });
      }
      case 'backup.delete': {
        const from = String(p.guest ?? '');
        const at = backups.findIndex((x) => x.guestId === from && x.name === p.volume);
        if (at < 0)
          return from.startsWith('incus:')
            ? problem(404, 'not_found', 'That backup isn’t there any more.')
            : null;
        backups.splice(at, 1);
        return ok();
      }
      case 'task.stop': {
        const t = tasks.get(String(p.task ?? ''));
        if (!t)
          return String(p.task ?? '').startsWith('incus:')
            ? problem(404, 'not_found', 'That task isn’t there.')
            : null;
        if (!t.cancellable) return problem(409, 'not_cancellable', 'Incus can’t cancel that one.');
        if (t.reads < t.steps) {
          t.lines = [
            ...t.lines.slice(0, Math.ceil((t.reads / t.steps) * t.lines.length)),
            'Operation cancelled',
          ];
          t.steps = t.reads + 1;
          t.result = 'error';
          t.message = 'Cancelled';
          t.onDone = undefined;
        }
        return ok();
      }
      case 'image.download': {
        const alias = String(p.alias ?? '')
          .replace(/^images:/, '')
          .trim();
        const type = p.type === 'virtual-machine' ? 'virtual-machine' : 'container';
        const missing = !INCUS_COMMON_IMAGES.some((a) => alias.replace(/\/cloud$/, '') === a);
        const fp =
          `${(alias.length * 40503 + (type === 'container' ? 1 : 2)).toString(16).padStart(6, '0')}${'d0wn1'.repeat(13)}`
            .replace(/[^0-9a-f]/g, 'a')
            .slice(0, 64);
        const tid = start({
          type: 'image.download',
          steps: 5,
          lines: [
            `Downloading images:${alias} (${type === 'container' ? 'container' : 'VM'})`,
            'rootfs: 22% (18.2MB/s)',
            'rootfs: 71% (24.0MB/s)',
            ...(missing ? [`Error: Image "${alias}" not found`] : ['rootfs: 100%', 'Image downloaded']),
          ],
          result: missing ? 'error' : 'ok',
          message: missing ? `The images server has no ${alias}.` : 'Image downloaded',
          cancellable: true,
          onDone: () =>
            incus.images.push({
              fingerprint: fp,
              aliases: [alias],
              description: `${alias} (${new Date(clock()).toISOString().slice(0, 10)})`,
              type,
              architecture: 'x86_64',
              sizeBytes: Math.round((type === 'container' ? 110 : 380) * MIB),
              uploadedAt: iso(clock()),
              lastUsedAt: null,
              autoUpdate: p.autoUpdate !== false,
              cached: false,
              project: String(p.project ?? 'default'),
            }),
        });
        return ok({ task: { id: tid }, newId: fp });
      }
      case 'image.refresh': {
        const fp = String(p.fingerprint ?? p.image ?? '');
        const img = incus.images.find((i) => i.fingerprint === fp || i.fingerprint.startsWith(fp));
        if (!img) return problem(404, 'not_found', 'That image isn’t there any more.');
        const tid = start({
          type: 'image.refresh',
          steps: 3,
          lines: [
            `Refreshing ${img.aliases[0] ?? img.description}`,
            'Checking the images server',
            'Already up to date',
          ],
          result: 'ok',
          message: 'Up to date',
          cancellable: true,
        });
        return ok({ task: { id: tid } });
      }
      case 'image.delete': {
        const fp = String(p.fingerprint ?? p.image ?? '');
        const at = incus.images.findIndex((i) => i.fingerprint === fp || i.fingerprint.startsWith(fp));
        if (at < 0) return problem(404, 'not_found', 'That image isn’t there any more.');
        incus.images.splice(at, 1);
        return ok();
      }
      case 'profile.create': {
        const nm = String(p.name ?? '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nm))
          return problem(400, 'invalid_value', 'Check the name.', {
            name: 'Letters, digits, “.”, “_” and “-”.',
          });
        if (profiles.has(`default/${nm}`))
          return problem(409, 'exists', `There’s already a profile called ${nm}.`, {
            name: `There’s already a profile called ${nm}.`,
          });
        const from = p.copyFrom ? profiles.get(`default/${p.copyFrom}`) : undefined;
        profiles.set(`default/${nm}`, {
          name: nm,
          project: 'default',
          description: String(p.description ?? from?.description ?? ''),
          config: { ...(from?.config ?? {}) },
          devices: JSON.parse(JSON.stringify(from?.devices ?? {})),
          usedBy: [],
          restricted: [...(from?.restricted ?? [])],
          digest: `prof-${nm}-1`,
        });
        recount();
        return ok();
      }
      case 'profile.update': {
        const prof = profiles.get(`default/${p.profile}`);
        if (!prof) return problem(404, 'not_found', 'That profile isn’t there any more.');
        if (p.digest && p.digest !== prof.digest)
          return problem(409, 'digest_mismatch', 'Changed meanwhile — review again.');
        const changes: { key: string; old?: string; new?: string }[] = [];
        for (const [k, v] of Object.entries((p.set ?? {}) as Record<string, string>)) {
          if (prof.restricted.includes(k) || (!INCUS_GROUP_KEYS.has(k) && !k.startsWith('user.')))
            return problem(403, 'not_allowed', `${k} is changed with the incus command.`);
          changes.push({ key: k, old: prof.config[k], new: v });
          prof.config[k] = v;
        }
        for (const k of (p.delete ?? []) as string[]) {
          changes.push({ key: k, old: prof.config[k] });
          delete prof.config[k];
        }
        for (const [k, d] of Object.entries(
          (p.devices ?? {}) as Record<string, Record<string, string> | null>,
        )) {
          changes.push({
            key: `device.${k}`,
            old: prof.devices[k] ? deviceString(prof.devices[k] as Record<string, string>) : undefined,
            ...(d ? { new: deviceString(d) } : {}),
          });
          if (d) prof.devices[k] = d;
          else delete prof.devices[k];
        }
        if (typeof p.description === 'string' && p.description !== prof.description) {
          changes.push({ key: 'description', old: prof.description, new: p.description });
          prof.description = p.description;
        }
        prof.digest = `${prof.digest}+`;
        for (const id of prof.usedBy) bump(id);
        return ok({ changes });
      }
      case 'profile.delete': {
        const prof = profiles.get(`default/${p.profile}`);
        if (!prof) return problem(404, 'not_found', 'That profile isn’t there any more.');
        if (prof.name === 'default') return problem(409, 'not_allowed', 'Incus keeps the default profile.');
        if (prof.usedBy.length)
          return problem(
            409,
            'in_use',
            `${prof.name} is used by ${prof.usedBy.length === 1 ? '1 instance' : `${prof.usedBy.length} instances`}.`,
          );
        profiles.delete(`default/${prof.name}`);
        recount();
        return ok();
      }
      case 'volume.create': {
        const pool = String(p.pool ?? '');
        const nm = String(p.name ?? '').trim();
        if (!incus.pools.some((x) => x.name === pool))
          return problem(400, 'invalid_value', `There’s no pool called ${pool}.`, {
            pool: `There’s no pool called ${pool}.`,
          });
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nm))
          return problem(400, 'invalid_value', 'Check the name.', {
            name: 'Letters, digits, “.”, “_” and “-”.',
          });
        if (incus.volumes.some((v) => v.pool === pool && v.name === nm))
          return problem(409, 'exists', `${pool} already has a volume called ${nm}.`, {
            name: 'That name is taken on this pool.',
          });
        const size = incusSizeBytes(String(p.size ?? ''));
        incus.volumes.push({
          pool,
          name: nm,
          project: String(p.project ?? 'default'),
          type: 'custom',
          contentType: p.contentType === 'block' ? 'block' : 'filesystem',
          sizeBytes: size,
          usedBytes: 0,
          usedBy: [],
          description: String(p.description ?? ''),
        });
        recount();
        return ok();
      }
      case 'volume.resize': {
        const v = incus.volumes.find((x) => x.pool === p.pool && x.name === p.volume);
        if (!v) return problem(404, 'not_found', 'That volume isn’t there any more.');
        const size = incusSizeBytes(String(p.size ?? ''));
        if (!size || (v.sizeBytes != null && size <= v.sizeBytes))
          return problem(400, 'invalid_value', 'Volumes only grow.', {
            size: `Volumes only grow: it has ${incusSizeString(v.sizeBytes ?? 0)}.`,
          });
        v.sizeBytes = size;
        return ok();
      }
      case 'volume.delete': {
        const at = incus.volumes.findIndex((x) => x.pool === p.pool && x.name === p.volume);
        const v = incus.volumes[at];
        if (!v) return problem(404, 'not_found', 'That volume isn’t there any more.');
        if (v.usedBy.length)
          return problem(
            409,
            'in_use',
            `${v.name} is attached to ${v.usedBy.map((id) => incusRef(id).name).join(', ')}.`,
          );
        incus.volumes.splice(at, 1);
        recount();
        return ok();
      }
      default:
        return null;
    }
  }

  function incusOnOwn(id: string, key: string): boolean {
    const v = configOf(id)?.values[key];
    return !!v && /^(true|yes|on|1)$/i.test(v);
  }

  function read(query: Record<string, string>): HostsFixtureAnswer | null {
    const g = query.guestId ? findGuest(query.guestId) : undefined;
    if (query.guestId && g?.platform !== 'incus') return null;
    switch (query.op) {
      case 'config.get': {
        const cfg = g ? configOf(g.id) : null;
        return cfg ? { status: 200, body: { op: 'config.get', config: cfg } } : null;
      }
      case 'choices':
        return { status: 200, body: { op: 'choices', choices: choices(query.project ?? 'default') } };
      case 'backup.list':
        return {
          status: 200,
          body: {
            op: 'backup.list',
            items: backups
              .filter((b) => !g || b.guestId === g.id)
              .filter((b) => b.expires == null || b.expires > clock())
              .map(backupVolume),
          },
        };
      case 'snapshot.list':
        return g
          ? { status: 200, body: { op: 'snapshot.list', items: world.snapshots.get(cfgKey(g.id)) ?? [] } }
          : null;
      case 'task.list':
        return { status: 200, body: { op: 'task.list', items: taskList(g?.id) } };
      case 'profile.get': {
        const prof = profiles.get(`default/${query.profile ?? ''}`);
        return prof
          ? { status: 200, body: { op: 'profile.get', profile: prof } }
          : problem(404, 'not_found', 'That profile isn’t there any more.');
      }
      case 'network.leases':
        return { status: 200, body: { op: 'network.leases', items: leases(query.network ?? '') } };
      case 'log.get':
        return g ? { status: 200, body: { op: 'log.get', ...logOf(g, Number(query.lines ?? 500)) } } : null;
      default:
        return null;
    }
  }

  return (req) => {
    const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    const route = `${req.method} ${seg.map((s, i) => (i % 2 === 1 ? ':' : s)).join('/')}`;
    const serverId = seg[1] ?? '';
    if (route === 'GET fleet') {
      const base = next(req);
      if (base?.status !== 200) return base;
      const b = base.body as { servers: HostServer[] };
      return { status: 200, body: { ...b, servers: b.servers.map(patchServerRow) } };
    }
    if (serverId !== SERVER) return next(req);
    if (route === 'GET servers/:') {
      const d = detail();
      return d ? { status: 200, body: d } : next(req);
    }
    if (route === 'GET servers/:/manage') {
      const incusRead =
        req.query.platform === 'incus' ||
        req.query.guestId?.startsWith('incus:') ||
        ['profile.get', 'network.leases', 'log.get'].includes(req.query.op ?? '') ||
        req.query.op === 'choices';
      return (incusRead ? read(req.query) : null) ?? next(req);
    }
    if (route === 'POST servers/:/manage') return manage(req.body) ?? next(req);
    if (route === 'GET servers/:/tasks/:') {
      const id = seg[3] ?? '';
      const t = tasks.get(id);
      if (t) {
        step(t);
        const logStart = Number(req.query.logStart ?? req.query.log_start ?? 0);
        return { status: 200, body: view(t, Number.isFinite(logStart) ? logStart : 0) };
      }
      const h = history.find((x) => x.id === id);
      if (h) return { status: 200, body: { ...h, log: [h.message ?? ''], logNext: 1 } };
      return next(req);
    }
    if (route === 'POST servers/:/guests/:/actions') {
      const g = findGuest(seg[3] ?? '');
      const action = String(req.body.action ?? '');
      if (g?.self && !selfGuestAllows({ action: action as HostGuestAction })) return selfRefusal();
      const answer = next(req);
      if (g?.platform === 'incus' && action.startsWith('snapshot_')) {
        const list = world.snapshots.get(cfgKey(g.id)) ?? [];
        patchGuest(g.id, { snapshots: list.filter((s) => !s.current).length });
      }
      return answer;
    }
    return next(req);
  };
}
