/** An Unraid server on the phone as view models (app docs/decisions/incus-unraid-mobile.md AP-1634…). */
import type { HostGuest, HostUnraidDetail, HostUnraidDisk } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  containerView,
  diskFacts,
  diskRow,
  diskSections,
  notificationRows,
  parityHistoryRows,
  pluginPhoneRows,
  spinnable,
  unraidFacts,
  unraidPoolRows,
  unraidUpdates,
} from './unraid-mobile';

const NOW = Date.parse('2026-10-17T12:02:00Z');
const TZ = 'Europe/Amsterdam';
const DAY = 86_400_000;
const TB = 1e12;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(/ /g, ' '));

const disk = (over: Partial<HostUnraidDisk>): HostUnraidDisk => ({
  name: 'disk1',
  slot: 'data',
  device: 'sdb',
  model: 'WDC WD161KFGX',
  serial: 'X1',
  status: 'ok',
  statusRaw: 'DISK_OK',
  sizeBytes: 16 * TB,
  usedBytes: 11.2 * TB,
  freeBytes: 4.8 * TB,
  fsType: 'xfs',
  tempC: 34,
  spunDown: false,
  errors: 0,
  rotational: true,
  ...over,
});

const unraid = (over: Partial<HostUnraidDetail['array']> = {}): HostUnraidDetail => ({
  version: '7.3.1',
  name: 'BlackBox',
  license: 'Pro',
  osUpdate: { version: '7.3.2' },
  array: {
    state: 'started',
    stateRaw: 'STARTED',
    startOnBoot: true,
    sizeBytes: 16 * TB,
    usedBytes: 11.2 * TB,
    freeBytes: 4.8 * TB,
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
        at: new Date(NOW - 12 * DAY).toISOString(),
        durationS: 9 * 3600 + 720,
        speedMbs: 182,
        errors: 0,
        result: 'ok',
        action: 'check',
      },
      history: [
        {
          at: new Date(NOW - 4 * DAY).toISOString(),
          durationS: 33_000,
          speedMbs: 175.4,
          errors: 3,
          result: 'errors',
          action: 'check',
        },
        {
          at: new Date(NOW - 12 * DAY).toISOString(),
          durationS: 9 * 3600 + 720,
          speedMbs: 182,
          errors: 0,
          result: 'ok',
          action: 'check',
        },
      ],
      schedule: 'Monthly, day 1 at 00:30, no corrections',
    },
    disks: [
      disk({ name: 'parity', slot: 'parity', device: 'sdc', usedBytes: null, freeBytes: null, fsType: null }),
      disk({}),
      disk({ name: 'disk2', device: 'sdd', spunDown: true, tempC: null, errors: 2 }),
    ],
    ...over,
  },
  pools: [
    {
      name: 'apps',
      fsType: 'zfs',
      profile: 'mirror',
      sizeBytes: 1 * TB,
      usedBytes: 0.412 * TB,
      freeBytes: 0.588 * TB,
      disks: [
        disk({ name: 'apps', slot: 'pool', device: 'nvme0n1', rotational: false, fsType: 'zfs' }),
        disk({ name: 'apps2', slot: 'pool', device: 'nvme1n1', rotational: false, fsType: 'zfs' }),
      ],
    },
    {
      name: 'storage',
      fsType: 'zfs',
      profile: null,
      sizeBytes: 8 * TB,
      usedBytes: 7.3 * TB,
      freeBytes: 0.7 * TB,
      disks: [disk({ name: 'storage', slot: 'pool', device: 'sde', fsType: 'zfs' })],
    },
  ],
  flash: disk({
    name: 'flash',
    slot: 'flash',
    device: 'sda',
    model: 'SanDisk Cruzer',
    sizeBytes: 32e9,
    fsType: 'vfat',
  }),
  shares: [],
  plugins: [
    {
      name: 'Unassigned Devices',
      file: 'unassigned.devices.plg',
      version: '2026.09.01',
      update: '2026.10.15',
      author: 'dlandon',
      supportUrl: null,
    },
    {
      name: 'Community Applications',
      file: 'community.applications.plg',
      version: '2026.10.01',
      update: null,
      author: 'Squid',
      supportUrl: null,
    },
  ],
  notifications: [
    {
      id: 'n1',
      at: new Date(NOW - 3600_000).toISOString(),
      importance: 'warning',
      event: 'Docker',
      subject: 'Docker image is 78 % full',
      description: 'Clean up old images.',
    },
    {
      id: 'n2',
      at: new Date(NOW - 60_000).toISOString(),
      importance: 'alert',
      event: 'Array',
      subject: 'Disk 2 has read errors',
      description: '2 errors.',
    },
  ],
  docker: { enabled: true, imageUsedPct: 62 },
  vms: { enabled: true },
});

describe('the parity history', () => {
  it('lists the runs newest first in the web’s words', () => {
    const rows = plain(parityHistoryRows(unraid().array.parity.history, NOW, TZ));
    expect(rows.map((r) => [r.line, r.tone])).toEqual([
      ['Check · took 9 h 10 min · 175 MB/s · 3 errors found', 'bad'],
      ['Check · took 9 h 12 min · 182 MB/s · No errors', 'ok'],
    ]);
    expect(rows[1]?.title).toBe('5 Oct, 14:02');
  });
});

describe('the disks as Unraid’s Main page groups them', () => {
  it('has Parity, Data, each pool and Flash', () => {
    const s = diskSections(unraid());
    expect(s.map((x) => [x.title, x.sub, x.rows.map((r) => r.title)])).toEqual([
      ['Parity', null, ['Parity']],
      ['Data', null, ['Disk 1', 'Disk 2']],
      ['Pool apps', 'zfs mirror · 2 disks', ['Apps', 'Apps 2']],
      ['Pool storage', 'zfs · 1 disk', ['Storage']],
      ['Flash', null, ['Flash']],
    ]);
  });

  it('reads a disk as one row', () => {
    expect(plain(diskRow(disk({})))).toMatchObject({
      title: 'Disk 1',
      line: 'WDC WD161KFGX · sdb',
      meta: '16 TB · 11.2 TB used · xfs',
      status: { text: 'Normal', tone: 'ok' },
      tempText: '34 °C',
      canSpin: true,
    });
    expect(plain(diskRow(disk({ spunDown: true, errors: 2 })))).toMatchObject({
      tempText: 'Spun down',
      meta: '16 TB · 11.2 TB used · xfs · 2 errors',
    });
    expect(diskRow(disk({ status: 'disabled' })).status).toEqual({ text: 'Disabled', tone: 'bad' });
    expect(diskRow(disk({ slot: 'pool', rotational: false })).canSpin).toBe(false);
    expect(diskRow(disk({ name: 'flash', slot: 'flash' })).canSpin).toBe(false);
    expect(plain(diskFacts(disk({ errors: 2 }))).find((f) => f.label === 'Errors')).toEqual({
      label: 'Errors',
      value: '2',
    });
    expect(spinnable(unraid())).toEqual({ up: true, down: true });
  });

  it('says how full each pool is (warn from 90 %)', () => {
    expect(plain(unraidPoolRows(unraid())).map((r) => [r.name, r.line, r.usedText, r.tone])).toEqual([
      ['apps', 'zfs mirror · 2 disks', '412 GB of 1 TB used', null],
      ['storage', 'zfs · 1 disk', '7.3 TB of 8 TB used', 'warn'],
    ]);
  });
});

describe('updates, plugins and notifications', () => {
  it('says what can be updated', () => {
    const guests = [
      { platform: 'docker', updateAvailable: true },
      { platform: 'docker', updateAvailable: false },
    ] as Pick<HostGuest, 'platform' | 'updateAvailable'>[];
    expect(unraidUpdates(unraid(), guests)).toEqual([
      { id: 'os', title: 'Unraid', value: '7.3.1 → 7.3.2', tone: 'warn' },
      { id: 'plugins', title: 'Plugins', value: '1 update ready', tone: 'warn' },
      { id: 'containers', title: 'Containers', value: '1 update ready', tone: 'warn' },
    ]);
  });

  it('lists plugins with an update first', () => {
    expect(pluginPhoneRows(unraid()).map((p) => [p.name, p.line])).toEqual([
      ['Unassigned Devices', 'Version 2026.09.01 → 2026.10.15'],
      ['Community Applications', 'Version 2026.10.01'],
    ]);
  });

  it('lists unread notifications newest first, alerts red', () => {
    const rows = notificationRows(unraid(), NOW, TZ);
    expect(rows.map((r) => [r.id, r.tone, r.meta])).toEqual([
      ['n2', 'bad', 'Today 14:01 · Array'],
      ['n1', 'warn', 'Today 13:02 · Docker'],
    ]);
    expect(rows[0]?.label).toBe('Alert: Disk 2 has read errors. 2 errors. Today 14:01 · Array');
  });

  it('has its facts', () => {
    expect(plain(unraidFacts(unraid()))).toEqual([
      { label: 'Unraid', value: '7.3.1' },
      { label: 'Licence', value: 'Pro' },
      { label: 'Array', value: 'Starts with the server' },
      { label: 'Docker', value: 'On · image 62 % full' },
      { label: 'VMs', value: 'On' },
    ]);
  });
});

describe('a container or VM (IU-05)', () => {
  const g = (over: Partial<HostGuest>): HostGuest =>
    ({
      id: 'docker:plex',
      serverId: 'blackbox',
      name: 'plex',
      platform: 'docker',
      kind: 'container',
      image: 'plexinc/pms-docker',
      state: 'running',
      cpuPct: 1,
      memoryUsedMb: 100,
      memoryLimitMb: null,
      uptimeS: 10,
      console: { available: true },
      ...over,
    }) as HostGuest;

  it('offers Update with a template, the autostart switch and the web page', () => {
    expect(
      containerView(
        g({ updateAvailable: true, template: true, autostart: true, webUi: 'http://10.100.0.40:32400/web' }),
        true,
      ),
    ).toEqual({
      canUpdate: true,
      updateText: 'An update is ready',
      updateTone: 'warn',
      autostart: true,
      autostartLabel: 'Start it when the array starts',
      webUi: 'http://10.100.0.40:32400/web',
    });
    expect(containerView(g({ updateAvailable: true, template: false }), true)?.canUpdate).toBe(false);
    // Docker elsewhere: unchanged (IU-10).
    expect(containerView(g({ updateAvailable: true }), false)).toBeNull();
    expect(containerView(g({ platform: 'libvirt', kind: 'vm', autostart: false }), false)).toMatchObject({
      autostart: false,
      autostartLabel: 'Start it when the server starts',
      canUpdate: false,
      webUi: null,
    });
    expect(containerView(g({ platform: 'incus' }), true)).toBeNull();
  });
});
