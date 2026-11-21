import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { api } from '../contracts/index.js';
import {
  type CatalogEntry,
  catalogEntry,
  SERVERS_SENSITIVE,
  SERVERS_TOOLS,
  sensitiveReason,
  toolAlwaysAsks,
} from './connections-catalog.js';
import {
  HOST_ERROR_WORDS,
  HOST_MANAGE_DESTRUCTIVE_OPS,
  HOST_MANAGE_OPS,
  HOST_MANAGE_READ_OPS,
  HOST_SELF_GUEST_ALLOWED,
  HOST_SELF_SERVER_POWER_TEXT,
  HostBackupVolume,
  HostChoices,
  HostGuest,
  HostManagePlatform,
  HostManageReadResult,
  HostManageRequest,
  HostServer,
  HostServerDetail,
  HostServerPlatform,
  HostTask,
  HostUnraidDetail,
  INCUS_NAME_PATTERN,
  selfGuestAllows,
} from './hosts.js';

const T = '2026-10-17T09:00:00.000Z';
const GiB = 1024 ** 3;
const TB = 1000 ** 4;

const info = (id: string, platform: string) => ({
  id,
  group: 'Home',
  status: 'ok',
  roles: [],
  os: null,
  cpu: null,
  memory: null,
  uptimeS: null,
  lastBoot: null,
  address: '10.100.0.7',
  location: null,
  agent: { version: '0.9.0', lastSyncSAgo: 4 },
  platform,
  remoteControl: { console: true, power: false, manage: false },
});

const page = (server: Record<string, unknown>, extra: Record<string, unknown>) => ({
  asOf: T,
  server,
  live: null,
  banner: null,
  sensors: [],
  disks: [],
  virtualization: null,
  hints: [],
  ...extra,
});

const guest = (over: Record<string, unknown>) => ({
  id: 'incus:whombat-dev-box',
  serverId: 'the-titan',
  name: 'whombat-dev-box',
  platform: 'incus',
  kind: 'vm',
  image: 'nixos',
  state: 'running',
  cpuPct: 12,
  memoryUsedMb: 9000,
  memoryLimitMb: 16384,
  uptimeS: 3600,
  console: { available: true, protocols: ['vnc', 'serial'] },
  ...over,
});

/** The Titan's Incus, as the agent reports it (IU-01, IU-04). */
const INCUS = {
  version: '6.0.4',
  clustered: false,
  projects: [
    { name: 'default', description: 'Default Incus project', instances: 4, running: 3 },
    { name: 'ci-platform', description: 'CI templates', instances: 2, running: 0 },
  ],
  pools: [
    {
      name: 'default',
      driver: 'zfs',
      status: 'Created',
      description: '',
      usedBytes: 412 * GiB,
      totalBytes: 1800 * GiB,
      volumes: 9,
    },
  ],
  networks: [
    {
      name: 'incusbr0',
      type: 'bridge',
      managed: true,
      description: '',
      ipv4: '10.123.45.1/24',
      ipv6: null,
      nat: true,
      usedBy: 3,
    },
    {
      name: 'enp5s0',
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
    { name: 'default', project: 'default', description: 'Default Incus profile', usedBy: 4 },
    { name: 'macvlan', project: 'default', description: 'LAN through macvlan', usedBy: 2 },
  ],
  images: [
    {
      fingerprint: 'a1b2c3d4'.repeat(8),
      aliases: ['debian/13'],
      description: 'Debian trixie amd64 (20261015_05:24)',
      type: 'container',
      architecture: 'x86_64',
      sizeBytes: 98_000_000,
      uploadedAt: T,
      lastUsedAt: null,
      autoUpdate: true,
      cached: true,
      project: 'default',
    },
  ],
  volumes: [
    {
      pool: 'default',
      name: 'link-data',
      project: 'default',
      type: 'custom',
      contentType: 'filesystem',
      sizeBytes: 10 * GiB,
      usedBytes: 120_000_000,
      usedBy: ['incus:whombat-link'],
      description: '',
    },
  ],
};

const disk = (over: Record<string, unknown>) => ({
  name: 'disk1',
  slot: 'data',
  device: 'sdb',
  model: 'WDC WD180EDGZ',
  serial: 'WD-XXXX',
  status: 'ok',
  statusRaw: 'DISK_OK',
  sizeBytes: 18 * TB,
  usedBytes: 11 * TB,
  freeBytes: 7 * TB,
  fsType: 'xfs',
  tempC: 34,
  spunDown: false,
  errors: 0,
  rotational: true,
  ...over,
});

/** BlackBox, unRAID 7.3.1 (IU-05): a started array with one data disk and no parity, three ZFS pools. */
const UNRAID = {
  version: '7.3.1',
  name: 'BlackBox',
  license: 'Pro',
  osUpdate: { version: '7.3.2' },
  array: {
    state: 'started',
    stateRaw: 'STARTED',
    startOnBoot: true,
    sizeBytes: 18 * TB,
    usedBytes: 11 * TB,
    freeBytes: 7 * TB,
    disabled: 0,
    invalid: 0,
    missing: 1,
    moverRunning: false,
    parity: {
      state: 'idle',
      action: null,
      pct: null,
      speedMbs: null,
      etaS: null,
      errors: 0,
      last: null,
      history: [],
      schedule: null,
    },
    disks: [
      disk({
        name: 'parity',
        slot: 'parity',
        device: null,
        model: null,
        serial: null,
        status: 'missing',
        statusRaw: 'DISK_NP_MISSING',
        sizeBytes: 0,
        usedBytes: null,
        freeBytes: null,
        fsType: null,
        tempC: null,
        rotational: null,
      }),
      disk({}),
    ],
  },
  pools: ['apps', 'data', 'storage'].map((name, i) => ({
    name,
    fsType: 'zfs',
    profile: i === 2 ? 'raidz1' : 'mirror',
    sizeBytes: 4 * TB,
    usedBytes: (i + 1) * TB,
    freeBytes: (3 - i) * TB,
    disks: [
      disk({ name, slot: 'pool', device: `nvme${i}n1`, fsType: 'zfs', rotational: false, spunDown: false }),
    ],
  })),
  flash: disk({
    name: 'flash',
    slot: 'flash',
    device: 'sda',
    model: 'SanDisk Cruzer Fit',
    sizeBytes: 32_000_000_000,
    fsType: 'vfat',
    tempC: null,
    rotational: false,
  }),
  shares: [
    {
      name: 'appdata',
      comment: 'Container data',
      usedBytes: 200 * GiB,
      freeBytes: 3 * TB,
      primary: 'apps',
      secondary: null,
      moverAction: null,
      smb: null,
      nfs: false,
      encrypted: false,
    },
    {
      name: 'media',
      comment: '',
      usedBytes: 9 * TB,
      freeBytes: 7 * TB,
      primary: 'storage',
      secondary: 'array',
      moverAction: 'to_array',
      smb: 'private',
      nfs: false,
      encrypted: false,
    },
  ],
  plugins: [
    {
      name: 'Community Applications',
      file: 'community.applications.plg',
      version: '2026.09.30',
      update: '2026.10.12',
      author: 'Squid',
      supportUrl: 'https://forums.unraid.net/topic/38582-plug-in-community-applications/',
    },
    {
      name: 'Unassigned Devices',
      file: 'unassigned.devices.plg',
      version: '2026.09.01',
      update: '2026.10.05',
      author: 'dlandon',
      supportUrl: null,
    },
    {
      name: 'Dynamix File Manager',
      file: 'dynamix.file.manager.plg',
      version: '2026.08.20',
      update: null,
      author: null,
      supportUrl: null,
    },
  ],
  notifications: [
    {
      id: 'BlackBox_1760684400_Array',
      at: T,
      importance: 'alert',
      event: 'Unraid Parity disk error',
      subject: 'Alert [BLACKBOX] - Parity disk missing',
      description: 'No parity disk is assigned',
    },
  ],
  docker: { enabled: true, imageUsedPct: 41 },
  vms: { enabled: true },
};

const servers = (): CatalogEntry => {
  const e = catalogEntry('whombat_servers');
  if (!e) throw new Error('no Servers entry');
  return e;
};

describe('server kinds and the self guest (CT-363, 0.83.0)', () => {
  it('has the Incus and unRAID kinds after the old ones', () => {
    // 0.84 (CT-369) appends libvirt to both.
    expect(HostServerPlatform.options.slice(0, 4)).toEqual(['proxmox', 'standard', 'incus', 'unraid']);
    expect(HostManagePlatform.options.slice(0, 3)).toEqual(['pve', 'incus', 'unraid']);
  });

  it('marks the guest this Whombat runs in and its server', () => {
    const self = HostGuest.parse(guest({ self: true }));
    expect(self.self).toBe(true);
    expect(HostGuest.parse(guest({})).self).toBeUndefined();
    const row = HostServer.parse({
      id: 'the-titan',
      name: 'The Titan',
      group: 'Home',
      status: 'ok',
      platform: 'incus',
      os: 'Debian GNU/Linux 13',
      cpu: null,
      cpuPct: 4,
      memory: { usedPct: 40, totalGb: 64 },
      storage: { usedPct: 23, capacityTb: 2 },
      temperature: null,
      guests: [{ platform: 'incus', running: 3, total: 6 }],
      agent: { version: '0.9.0', connected: true },
      lastSeen: T,
      cpu24h: [],
      remoteControl: { console: true, power: false },
      hostsThisWhombat: true,
    });
    expect(row.hostsThisWhombat).toBe(true);
    expect(info('the-titan', 'incus')).toBeDefined();
  });

  it('allows reads, snapshots and backups of it, nothing that changes it', () => {
    for (const action of ['snapshot_create', 'snapshot_delete', 'start', 'resume'] as const)
      expect(selfGuestAllows({ action }), action).toBe(true);
    for (const action of [
      'stop',
      'shutdown',
      'force_stop',
      'restart',
      'reboot',
      'pause',
      'snapshot_restore',
    ] as const)
      expect(selfGuestAllows({ action }), action).toBe(false);
    for (const op of ['backup.create', 'backup.delete', 'guest.clone', 'task.stop'] as const)
      expect(selfGuestAllows({ op }), op).toBe(true);
    for (const op of [
      'config.set',
      'disk.resize',
      'disk.move',
      'guest.delete',
      'guest.rename',
      'guest.move',
      'guest.template',
      'guest.migrate',
      'guest.publish',
      'guest.autostart',
      'firewall.rule_add',
      'ha.set',
    ] as const)
      expect(selfGuestAllows({ op }), op).toBe(false);
    expect(selfGuestAllows({ op: 'backup.restore' })).toBe(false);
    expect(selfGuestAllows({ op: 'backup.restore', asNew: true })).toBe(true);
    expect(selfGuestAllows({ op: 'guest.delete', asNew: true })).toBe(false);
    for (const op of HOST_SELF_GUEST_ALLOWED.ops) expect(HOST_MANAGE_OPS).toContain(op);
  });

  it('says why in plain, platform-neutral words', () => {
    expect(HOST_ERROR_WORDS.self_guest).toBe('That’s this Whombat itself.');
    expect(HOST_SELF_SERVER_POWER_TEXT).toBe('This Whombat goes down too.');
    for (const words of Object.values(HOST_ERROR_WORDS)) {
      expect(words).toMatch(/^[A-Z].*\.$/);
      expect(words).not.toMatch(/'|Proxmox|Incus|unRAID|Unraid/);
    }
  });
});

describe('full Incus (CT-364, 0.83.0)', () => {
  it('parses The Titan’s page with its Incus objects', () => {
    const detail = HostServerDetail.parse(
      page(
        { ...info('the-titan', 'incus'), hostsThisWhombat: true },
        {
          incus: INCUS,
          workloads: {
            incus: {
              running: 3,
              total: 6,
              cpuPct: 14,
              memoryGb: 24,
              guests: [guest({ self: true, project: 'default' })],
            },
          },
        },
      ),
    );
    expect(detail.server.platform).toBe('incus');
    expect(detail.server.hostsThisWhombat).toBe(true);
    expect(detail.incus?.projects.map((p) => p.name)).toEqual(['default', 'ci-platform']);
    expect(detail.incus?.volumes[0]?.usedBy).toEqual(['incus:whombat-link']);
    expect(detail.workloads?.incus?.guests[0]?.self).toBe(true);
    // A page without it (older hubs, other kinds) still parses.
    expect(HostServerDetail.parse(page(info('pve-02', 'proxmox'), {})).incus).toBeUndefined();
    expect(
      HostServerDetail.safeParse(
        page(info('the-titan', 'incus'), {
          incus: { ...INCUS, images: [{ ...INCUS.images[0], type: 'oci' }] },
        }),
      ).success,
    ).toBe(false);
  });

  it('reads a profile, a network’s leases and an instance’s log', () => {
    expect(HOST_MANAGE_READ_OPS).toEqual(
      expect.arrayContaining(['profile.get', 'network.leases', 'log.get']),
    );
    const query = api.hosts.manageRead.query;
    expect(query?.parse({ op: 'profile.get', profile: 'default', project: 'ci-platform' })).toEqual({
      op: 'profile.get',
      profile: 'default',
      project: 'ci-platform',
    });
    expect(query?.parse({ op: 'log.get', guestId: 'incus:web', lines: '200' })).toEqual({
      op: 'log.get',
      guestId: 'incus:web',
      lines: 200,
    });
    expect(query?.safeParse({ op: 'log.get', lines: '5000' }).success).toBe(false);

    const profile = HostManageReadResult.parse({
      op: 'profile.get',
      profile: {
        name: 'default',
        project: 'default',
        description: 'Default Incus profile',
        config: { 'limits.memory': '2GiB', 'snapshots.schedule': '@daily' },
        devices: {
          eth0: { type: 'nic', network: 'incusbr0', name: 'eth0' },
          root: { type: 'disk', pool: 'default', path: '/' },
        },
        usedBy: ['incus:web', 'incus:whombat-dev-box'],
        restricted: ['raw.lxc'],
        digest: 'f00d'.repeat(16),
      },
    });
    expect(profile.op === 'profile.get' && profile.profile.devices.root?.pool).toBe('default');
    const leases = HostManageReadResult.parse({
      op: 'network.leases',
      items: [
        {
          hostname: 'web',
          address: '10.123.45.10',
          hwaddr: '00:16:3e:aa:bb:cc',
          type: 'dynamic',
          guestId: 'incus:web',
        },
        {
          hostname: 'incusbr0.gw',
          address: '10.123.45.1',
          hwaddr: '00:16:3e:00:00:01',
          type: 'gateway',
          guestId: null,
        },
      ],
    });
    expect(leases.op === 'network.leases' && leases.items[1]?.guestId).toBeNull();
    const log = HostManageReadResult.parse({
      op: 'log.get',
      file: 'qemu.log',
      lines: ['started', 'stopped'],
    });
    expect(log.op === 'log.get' && log.lines).toHaveLength(2);
  });

  it('lists Incus backups with their expiry, operations that can stop, and the create choices', () => {
    const backup = HostBackupVolume.parse({
      volume: 'whombat-20261017-0900',
      storage: 'incus',
      guest: 'incus:web',
      kind: 'container',
      created: T,
      format: 'optimized',
      notes: 'expires 2026-10-24T09:00:00Z',
      expiresAt: '2026-10-24T09:00:00Z',
    });
    expect(backup.expiresAt).toBe('2026-10-24T09:00:00Z');
    expect(HostBackupVolume.parse({ volume: 'b', storage: 'incus', expiresAt: null }).expiresAt).toBeNull();
    const task = HostTask.parse({
      id: 'incus:5c2d0d6e-1f3a-4b8e-9b9e-8f7d6c5b4a39',
      type: 'Backing up instance',
      platform: 'incus',
      guestId: 'incus:web',
      started: T,
      status: 'running',
      cancellable: true,
    });
    expect(task.cancellable).toBe(true);
    const choices = HostChoices.parse({
      platform: 'incus',
      storages: [{ id: 'default', type: 'zfs', content: ['images', 'rootdir'] }],
      bridges: ['incusbr0'],
      profiles: ['default', 'macvlan'],
      projects: ['default', 'ci-platform'],
      remoteImages: [
        { alias: 'debian/13', description: 'Debian 13', type: 'container' },
        { alias: 'debian/13/cloud', description: 'Debian 13 with cloud-init', type: 'virtual-machine' },
      ],
    });
    expect(choices.remoteImages?.[1]?.type).toBe('virtual-machine');
  });

  it('changes instances, images, profiles and volumes through manage', () => {
    const ops = [
      'guest.rename',
      'guest.move',
      'guest.publish',
      'image.download',
      'image.refresh',
      'image.delete',
      'profile.create',
      'profile.update',
      'profile.delete',
      'volume.create',
      'volume.resize',
      'volume.delete',
    ] as const;
    expect(HOST_MANAGE_OPS).toEqual(expect.arrayContaining([...ops]));
    // Appended: the 0.81 ops keep their places.
    expect(HOST_MANAGE_OPS.indexOf('replication.delete')).toBeLessThan(
      HOST_MANAGE_OPS.indexOf('guest.rename'),
    );
    for (const op of ['guest.move', 'profile.delete', 'volume.delete', 'image.delete'] as const)
      expect(HOST_MANAGE_DESTRUCTIVE_OPS).toContain(op);
    for (const op of ['guest.rename', 'guest.publish', 'image.refresh', 'volume.resize'] as const)
      expect(HOST_MANAGE_DESTRUCTIVE_OPS).not.toContain(op);
    const move = HostManageRequest.parse({
      op: 'guest.move',
      guestId: 'incus:web',
      params: { pool: 'fast', project: 'ci-platform' },
      confirm: true,
    });
    expect(move.params).toEqual({ pool: 'fast', project: 'ci-platform' });
    expect(HostManageRequest.parse({ op: 'image.download', platform: 'incus', params: {} }).platform).toBe(
      'incus',
    );
    expect(INCUS_NAME_PATTERN.test('web-02')).toBe(true);
    expect(INCUS_NAME_PATTERN.test('2web')).toBe(false);
    expect(INCUS_NAME_PATTERN.test(`a${'b'.repeat(63)}`)).toBe(false);
  });
});

describe('full unRAID (CT-365, 0.83.0)', () => {
  it('parses BlackBox’s page with its array, pools, shares, plugins and notifications', () => {
    const detail = HostServerDetail.parse(
      page(info('blackbox', 'unraid'), {
        unraid: UNRAID,
        workloads: {
          docker: {
            running: 1,
            total: 1,
            cpuPct: 3,
            memoryGb: 2,
            guests: [
              guest({
                id: 'docker:plex',
                serverId: 'blackbox',
                name: 'plex',
                platform: 'docker',
                kind: 'container',
                image: 'plexinc/pms-docker',
                autostart: true,
                webUi: 'http://10.100.0.40:32400/web',
                template: true,
                updateAvailable: true,
              }),
            ],
          },
          libvirt: {
            running: 1,
            total: 1,
            cpuPct: 5,
            memoryGb: 8,
            guests: [
              guest({
                id: 'libvirt:pbs',
                serverId: 'blackbox',
                name: 'pbs',
                platform: 'libvirt',
                autostart: true,
              }),
            ],
          },
        },
      }),
    );
    const u = detail.unraid;
    expect(u?.array.state).toBe('started');
    expect(u?.array.disks.map((d) => [d.name, d.status])).toEqual([
      ['parity', 'missing'],
      ['disk1', 'ok'],
    ]);
    expect(u?.pools.map((p) => p.name)).toEqual(['apps', 'data', 'storage']);
    expect(u?.plugins.filter((p) => p.update)).toHaveLength(2);
    expect(u?.notifications[0]?.importance).toBe('alert');
    expect(u?.osUpdate?.version).toBe('7.3.2');
    const plex = detail.workloads?.docker?.guests[0];
    expect([plex?.autostart, plex?.template, plex?.webUi]).toEqual([
      true,
      true,
      'http://10.100.0.40:32400/web',
    ]);
    expect(detail.workloads?.libvirt?.guests[0]?.autostart).toBe(true);
  });

  it('parses a running parity check with its history', () => {
    const run = { at: T, durationS: 64_800, speedMbs: 180, errors: 0, result: 'ok', action: 'check' };
    const running = HostUnraidDetail.parse({
      ...UNRAID,
      array: {
        ...UNRAID.array,
        parity: {
          state: 'running',
          action: 'check',
          pct: 42.5,
          speedMbs: 190,
          etaS: 30_000,
          errors: 0,
          last: run,
          history: [run, { ...run, result: 'cancelled', errors: 0, durationS: null, speedMbs: null }],
          schedule: 'Monthly, day 1 at 00:30, no corrections',
        },
      },
    });
    expect(running.array.parity.history[1]?.result).toBe('cancelled');
    expect(
      HostUnraidDetail.safeParse({ ...UNRAID, array: { ...UNRAID.array, state: 'degraded' } }).success,
    ).toBe(false);
  });

  it('runs the array, parity, disks, mover, plugins and containers through manage', () => {
    const ops = [
      'array.start',
      'array.stop',
      'parity.start',
      'parity.pause',
      'parity.resume',
      'parity.cancel',
      'disk.spin_up',
      'disk.spin_down',
      'mover.start',
      'plugin.check',
      'plugin.update',
      'notification.archive',
      'container.update',
      'containers.check',
      'guest.autostart',
    ] as const;
    expect(HOST_MANAGE_OPS).toEqual(expect.arrayContaining([...ops]));
    for (const op of ['array.stop', 'plugin.update', 'container.update', 'parity.cancel'] as const)
      expect(HOST_MANAGE_DESTRUCTIVE_OPS).toContain(op);
    for (const op of ['array.start', 'parity.start', 'mover.start', 'guest.autostart'] as const)
      expect(HOST_MANAGE_DESTRUCTIVE_OPS).not.toContain(op);
    expect(
      HostManageRequest.parse({ op: 'parity.start', platform: 'unraid', params: { correct: false } })
        .platform,
    ).toBe('unraid');
    expect(
      HostManageRequest.parse({ op: 'guest.autostart', guestId: 'docker:plex', params: { on: false } })
        .params,
    ).toEqual({ on: false });
    expect(api.hosts.getTask.query?.parse({ platform: 'unraid' })).toEqual({ platform: 'unraid' });
  });
});

/** One call each new tool takes, as a model would make it. */
const S = { server: 'the-titan' };
const G = { server: 'the-titan', guest: 'incus:web' };
const U = { server: 'blackbox' };
const NEW_EXAMPLES: Record<string, Record<string, unknown>> = {
  incus_overview: S,
  incus_profile: { ...S, profile: 'default', project: 'default' },
  network_leases: { ...S, network: 'incusbr0' },
  guest_log: { ...G, lines: 200 },
  unraid_overview: U,
  guest_rename: { ...G, name: 'web-02' },
  guest_move: { ...G, pool: 'fast', project: 'ci-platform' },
  guest_publish: { ...G, alias: 'web-base', snapshot: 'before-upgrade' },
  incus_image: { ...S, action: 'download', alias: 'debian/13', type: 'virtual-machine' },
  incus_profile_set: {
    ...S,
    action: 'update',
    profile: 'web',
    digest: 'd',
    set: { 'limits.memory': '2GiB' },
    devices: { eth1: { type: 'nic', network: 'incusbr0' }, old: null },
  },
  storage_volume: { ...S, action: 'create', pool: 'default', volume: 'data', size: '10GiB' },
  unraid_array: { ...U, action: 'parity_check', correct: false },
  unraid_plugins: { ...U, action: 'update', plugin: 'community.applications.plg' },
  container_update: { ...U, action: 'update', guest: 'docker:plex' },
  guest_autostart: { ...U, guest: 'docker:plex', on: true },
};

type Prop = { description?: unknown; enum?: unknown[]; default?: unknown };
const tool = (name: string) => SERVERS_TOOLS.find((t) => t.name === name);
const props = (name: string): Record<string, Prop> =>
  ((tool(name)?.inputSchema as { properties?: Record<string, Prop> } | undefined)?.properties ??
    {}) as Record<string, Prop>;

describe('the Servers tools for Incus and unRAID (CT-366, 0.83.0)', () => {
  it('adds the tools of the brief, each with a valid JSON schema', () => {
    // 49 in 0.83; 0.84 (CT-371) adds libvirt_overview.
    expect(SERVERS_TOOLS.length).toBeGreaterThanOrEqual(49);
    expect(new Set(SERVERS_TOOLS.map((t) => t.name)).size).toBe(SERVERS_TOOLS.length);
    expect(servers().tools).toHaveLength(SERVERS_TOOLS.length);
    for (const [name, example] of Object.entries(NEW_EXAMPLES)) {
      const t = tool(name);
      expect(t, name).toBeDefined();
      if (!t) continue;
      const schema = t.inputSchema as {
        type: string;
        properties: Record<string, Prop>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.type, name).toBe('object');
      expect(schema.additionalProperties, name).toBe(false);
      for (const r of schema.required) expect(Object.keys(schema.properties), `${name}.${r}`).toContain(r);
      for (const [key, p] of Object.entries(schema.properties)) {
        expect(typeof p.description === 'string' && p.description.length > 0, `${name}.${key}`).toBe(true);
        expect(p.description as string, `${name}.${key}`).not.toMatch(/'/);
        if (p.default !== undefined)
          expect(z.fromJSONSchema(p as never).safeParse(p.default).success, `${name}.${key} default`).toBe(
            true,
          );
      }
      expect(`${t.title} ${t.description}`, name).not.toMatch(/'|unRAID/);
      expect(t.description, name).toMatch(/Incus|Unraid|libvirt/);
      const validator = z.fromJSONSchema(t.inputSchema as never);
      expect(validator.safeParse(example).success, name).toBe(true);
      expect(validator.safeParse({ ...example, online: true }).success, `${name} extra`).toBe(false);
    }
    expect(
      z.fromJSONSchema(tool('guest_rename')?.inputSchema as never).safeParse({ ...G, name: '-x' }).success,
    ).toBe(false);
  });

  it('takes Incus in the tools that took only Proxmox', () => {
    const calls: [string, Record<string, unknown>][] = [
      [
        'guest_create',
        {
          ...S,
          kind: 'container',
          name: 'web-01',
          template: 'images:debian/13/cloud',
          project: 'default',
          profiles: ['default'],
          pool: 'default',
          network: 'incusbr0',
          cloud_init: '#cloud-config\npackages: [nginx]\n',
          start: true,
        },
      ],
      [
        'guest_clone',
        { ...G, name: 'web-02', storage: 'default', project: 'ci-platform', instance_only: true },
      ],
      [
        'guest_config_set',
        {
          ...G,
          digest: 'd',
          set: { 'snapshots.schedule': '@daily' },
          devices: { data: { type: 'disk', pool: 'default', source: 'data', path: '/data' } },
          profiles: ['default', 'web'],
        },
      ],
      ['guest_disk', { ...G, action: 'resize', disk: 'root', size: '20GiB' }],
      ['guest_backup', { ...G, action: 'create', name: 'before-upgrade', expires_days: 14 }],
      [
        'guest_backup',
        { ...G, action: 'restore', backup: 'before-upgrade', name: 'web-restored', start: true },
      ],
      ['server_choices', { ...S, project: 'ci-platform' }],
    ];
    for (const [name, args] of calls)
      expect(z.fromJSONSchema(tool(name)?.inputSchema as never).safeParse(args).success, name).toBe(true);
    for (const name of [
      'guest_create',
      'guest_clone',
      'guest_delete',
      'guest_disk',
      'guest_backup',
      'task_stop',
    ])
      expect(tool(name)?.description, name).toContain('Incus');
    expect(props('server_tasks').task).toBeDefined();
    expect(tool('server_tasks')?.description).toContain('Unraid');
    expect(servers().guide.length).toBeLessThanOrEqual(1500);
    expect(servers().guide).toContain('unraid_overview');
  });

  it('always asks before what destroys, moves or updates something', () => {
    const asks: [string, Record<string, unknown>][] = [
      ['guest_move', { ...G, pool: 'fast' }],
      ['incus_image', { ...S, action: 'delete', image: 'a1b2' }],
      ['incus_profile_set', { ...S, action: 'delete', profile: 'old' }],
      ['storage_volume', { ...S, action: 'delete', pool: 'default', volume: 'data' }],
      ['unraid_array', { ...U, action: 'stop' }],
      ['unraid_array', { ...U, action: 'parity_cancel' }],
      ['unraid_plugins', { ...U, action: 'update', plugin: 'all' }],
      ['container_update', { ...U, action: 'update', guest: 'docker:plex' }],
      ['guest_backup', { ...G, action: 'restore', backup: 'before-upgrade', name: 'web-restored' }],
    ];
    for (const [t, args] of asks) expect(sensitiveReason(servers(), t, args), t).not.toBeNull();
    expect(toolAlwaysAsks(servers(), 'guest_move')).toBe(true);
    const plain: [string, Record<string, unknown>][] = [
      ['guest_rename', { ...G, name: 'web-02' }],
      ['guest_publish', { ...G, alias: 'delete' }],
      ['incus_image', { ...S, action: 'download', alias: 'debian/13' }],
      ['incus_image', { ...S, action: 'refresh', image: 'a1b2' }],
      [
        'incus_profile_set',
        { ...S, action: 'update', profile: 'delete', digest: 'd', description: 'delete' },
      ],
      ['storage_volume', { ...S, action: 'resize', pool: 'default', volume: 'delete', size: '20GiB' }],
      ['unraid_array', { ...U, action: 'start' }],
      ['unraid_array', { ...U, action: 'parity_check', correct: true }],
      ['unraid_array', { ...U, action: 'spin_down', disk: 'all' }],
      ['unraid_array', { ...U, action: 'archive_notifications' }],
      ['unraid_plugins', { ...U, action: 'check' }],
      ['container_update', { ...U, action: 'check' }],
      ['guest_autostart', { ...U, guest: 'docker:plex', on: false }],
      ['guest_log', G],
    ];
    for (const [t, args] of plain) expect(sensitiveReason(servers(), t, args), t).toBeNull();
    for (const t of [
      'incus_image',
      'incus_profile_set',
      'storage_volume',
      'unraid_array',
      'container_update',
    ])
      expect(toolAlwaysAsks(servers(), t), t).toBe(false);
    for (const r of SERVERS_SENSITIVE) expect(r.arg).toBe('action');
    expect(servers().sensitive.length).toBeLessThanOrEqual(20);
  });
});
