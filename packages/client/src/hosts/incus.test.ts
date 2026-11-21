import type { HostGuest, HostGuestConfig, HostHint } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  cpuError,
  deviceWords,
  expiryError,
  expiryWords,
  fieldWords,
  hostPowerBody,
  INCUS_GROUPS,
  incusBackupName,
  incusDevices,
  incusGuestId,
  incusGuestTabs,
  incusHintFixes,
  incusImageOptions,
  incusNameError,
  incusNewDefaults,
  incusNewErrors,
  incusNewParams,
  incusOtherKeys,
  incusRef,
  incusSizeBytes,
  incusSizeString,
  memoryError,
  memoryWords,
  nicValue,
  rootDiskBytes,
  scheduleError,
  scheduleWords,
  selfAllowsAction,
  selfAllowsOp,
  serverKind,
  volumeDiskValue,
} from './incus';

const cfg = (values: Record<string, string>, extra: Partial<HostGuestConfig> = {}): HostGuestConfig => ({
  platform: 'incus',
  kind: 'container',
  digest: 'd1',
  running: true,
  values,
  ...extra,
});

describe('Incus values in words', () => {
  it('reads sizes as Incus writes them', () => {
    expect(incusSizeBytes('16GiB')).toBe(16 * 1024 ** 3);
    expect(incusSizeBytes('10GB')).toBe(10e9);
    expect(incusSizeBytes('50%')).toBeNull();
    expect(incusSizeString(48 * 1024 ** 3)).toBe('48GiB');
    expect(incusSizeString(1536 * 1024 ** 2)).toBe('1536MiB');
  });

  it('says CPUs, memory, schedules and expiry plainly', () => {
    expect(fieldWords(INCUS_GROUPS[0]?.fields[0] as never, '4')).toBe('4 CPUs');
    expect(fieldWords(INCUS_GROUPS[0]?.fields[0] as never, undefined)).toBe('All of the server’s');
    expect(memoryWords('16GiB')).toBe('16 GiB');
    expect(memoryWords('50%')).toBe('50 % of the server’s');
    expect(scheduleWords('@daily')).toBe('Every day');
    expect(scheduleWords('30 3 * * *')).toBe('Every day at 03:30');
    expect(scheduleWords('0 */6 * * *')).toBe('Every 6 hours');
    expect(scheduleWords('0 2 * * 1')).toBe('Mondays at 02:00');
    expect(scheduleWords('0 2 1 * *')).toBe('cron 0 2 1 * *');
    expect(expiryWords('2w')).toBe('2 weeks');
    expect(expiryWords('1d 12H')).toBe('1 day 12 hours');
    expect(expiryWords('1m')).toBe('1 month');
  });

  it('checks what is typed the way the hub does', () => {
    expect(cpuError('4')).toBeNull();
    expect(cpuError('0-3,6')).toBeNull();
    expect(cpuError('four')).not.toBeNull();
    expect(memoryError('4GiB')).toBeNull();
    expect(memoryError('50%')).toBeNull();
    expect(memoryError('4')).not.toBeNull();
    expect(scheduleError('0 3 * * *')).toBeNull();
    expect(scheduleError('@weekly')).toBeNull();
    expect(scheduleError('every day')).not.toBeNull();
    expect(expiryError('2w')).toBeNull();
    expect(expiryError('2 weeks')).not.toBeNull();
    expect(incusNameError('web-03')).toBeNull();
    expect(incusNameError('3web')).toBe('Start with a letter.');
    expect(incusNameError('web.lan')).not.toBeNull();
  });
});

describe('an Incus server and its instances', () => {
  it('knows the server kinds, unknown ones as standard', () => {
    expect(serverKind({ platform: 'incus' })).toBe('incus');
    expect(serverKind({ platform: 'unraid' })).toBe('unraid');
    expect(serverKind({ platform: 'nonsense' as never })).toBe('standard');
  });

  it('gives an instance the tabs its switches allow', () => {
    expect(incusGuestTabs({ console: true, power: true, manage: true }, true)).toEqual([
      'summary',
      'config',
      'devices',
      'snapshots',
      'backups',
      'tasks',
      'log',
    ]);
    expect(incusGuestTabs({ console: true, power: true }, false)).toEqual(['summary', 'snapshots']);
    expect(incusGuestTabs({ console: true, power: false }, false)).toEqual(['summary']);
  });

  it('reads project-qualified guest ids', () => {
    expect(incusRef('incus:web')).toEqual({ project: 'default', name: 'web' });
    expect(incusRef('incus:ci-platform/job')).toEqual({ project: 'ci-platform', name: 'job' });
    expect(incusGuestId('default', 'web')).toBe('incus:web');
    expect(incusGuestId('ci', 'job')).toBe('incus:ci/job');
  });

  it('lists devices root disk first, with what only the incus command changes', () => {
    const c = cfg(
      {
        'device.eth0': 'type=nic,nictype=macvlan,parent=enp174s0',
        'device.root': 'type=disk,path=/,pool=default,size=128GiB',
        'device.data': 'type=disk,path=/srv,pool=default,source=data',
        'device.gpu': 'type=gpu,gputype=physical',
      },
      { restricted: ['device.eth0', 'device.gpu'], inherited: ['device.root'] },
    );
    const devs = incusDevices(c);
    expect(devs.map((d) => d.name)).toEqual(['root', 'eth0', 'data', 'gpu']);
    expect(devs[0]?.inherited).toBe(true);
    expect(devs[1]?.restricted).toBe(true);
    expect(deviceWords(devs[0] as never).sub).toBe('128 GiB on pool default');
    expect(deviceWords(devs[1] as never).sub).toBe('macvlan on enp174s0');
    expect(deviceWords(devs[2] as never)).toEqual({ title: 'Volume', sub: 'data on pool default · at /srv' });
    expect(rootDiskBytes(c)).toBe(128 * 1024 ** 3);
  });

  it('writes the devices the hub allows', () => {
    expect(nicValue({ network: 'incusbr0', name: 'eth1' })).toBe('type=nic,name=eth1,network=incusbr0');
    expect(nicValue({ bridge: 'br0', name: 'eth1' })).toBe('type=nic,name=eth1,nictype=bridged,parent=br0');
    expect(volumeDiskValue({ pool: 'default', volume: 'data', path: '/srv' })).toBe(
      'type=disk,path=/srv,pool=default,source=data',
    );
  });

  it('leaves out of Other settings what a group, user.* or a device shows', () => {
    expect(
      incusOtherKeys({
        'limits.cpu': '2',
        'user.owner': 'john',
        'device.root': 'x',
        'raw.qemu': '-x',
        'image.os': 'Debian',
        'security.secureboot': 'false',
      }),
    ).toEqual(['raw.qemu', 'security.secureboot']);
  });
});

describe('the self guest (IU-02)', () => {
  const self = { self: true } as Pick<HostGuest, 'self'>;
  it('allows snapshots, backups and copies, refuses stopping and changing it', () => {
    expect(selfAllowsAction(self, 'snapshot_create')).toBe(true);
    expect(selfAllowsAction(self, 'shutdown')).toBe(false);
    expect(selfAllowsAction(self, 'snapshot_restore')).toBe(false);
    expect(selfAllowsOp(self, 'backup.create')).toBe(true);
    expect(selfAllowsOp(self, 'guest.clone')).toBe(true);
    expect(selfAllowsOp(self, 'config.set')).toBe(false);
    expect(selfAllowsOp(self, 'guest.publish')).toBe(false);
    expect(selfAllowsOp(self, 'backup.restore', true)).toBe(true);
    expect(selfAllowsOp({ self: undefined }, 'config.set')).toBe(true);
  });

  it('says the Whombat goes down with the server it runs on', () => {
    expect(hostPowerBody('host_shutdown', true)).toContain('This Whombat goes down too.');
    expect(hostPowerBody('host_reboot', false)).not.toContain('Whombat goes down');
  });
});

describe('creating an instance', () => {
  const choices = {
    platform: 'incus' as const,
    storages: [{ id: 'default', type: 'zfs', content: ['images'] }],
    bridges: ['incusbr0'],
    profiles: ['default', 'gpu'],
    images: [
      { fingerprint: 'a31a92f119c6abc', aliases: [], description: 'Debian trixie amd64', type: 'container' },
    ],
    projects: ['default', 'ci'],
  };

  it('offers the server’s images first, then the images server’s', () => {
    const opts = incusImageOptions(choices, 'container');
    expect(opts[0]).toMatchObject({ value: 'a31a92f119c6', group: 'On this server' });
    expect(opts.some((o) => o.value === 'images:debian/13/cloud' && o.cloud)).toBe(true);
    expect(incusImageOptions(choices, 'vm').every((o) => o.group !== 'On this server')).toBe(true);
  });

  it('starts from the defaults and sends only what was given', () => {
    const f = { ...incusNewDefaults(choices), name: 'web', project: 'ci', memory: '2GiB', diskGb: '20' };
    expect(incusNewErrors(f)).toEqual({});
    expect(incusNewParams({ ...f, cloudInit: '#cloud-config\n' }, false)).toEqual({
      platform: 'incus',
      kind: 'container',
      name: 'web',
      image: 'a31a92f119c6',
      profiles: ['default'],
      project: 'ci',
      pool: 'default',
      start: true,
      set: { 'limits.memory': '2GiB', 'device.root': 'type=disk,path=/,pool=default,size=20GiB' },
    });
    expect(incusNewParams({ ...f, cloudInit: '#cloud-config\n' }, true).cloudInit).toBe('#cloud-config\n');
    expect(incusNewErrors({ ...f, cloudInit: 'packages: [curl]' }).cloudInit).toBeDefined();
  });

  it('names backups as the hub does', () => {
    expect(incusBackupName(new Date(2026, 9, 17, 14, 5).getTime())).toBe('whombat-20261017-1405');
  });
});

describe('Incus hints with their way out (IU-08)', () => {
  const guests = [
    { id: 'incus:web', name: 'web', platform: 'incus' },
    { id: 'incus:db', name: 'db', platform: 'incus' },
  ] as HostGuest[];
  const hint = (kind: string, detail = ''): HostHint => ({
    serverId: 'thetitan',
    kind,
    severity: 'info',
    entity: 'x',
    title: 't',
    detail,
    section: 'guests',
  });
  it('opens the instances’ Snapshots, Storage or System', () => {
    expect(incusHintFixes(hint('incus.no_snapshots', 'web, db'), guests)?.map((f) => f.label)).toEqual([
      'Set a schedule for web',
      'Set a schedule for db',
    ]);
    expect(incusHintFixes(hint('incus.pool_full'), guests)).toEqual([
      { kind: 'tab', tab: 'storage', label: 'Open Storage' },
    ]);
    expect(incusHintFixes(hint('guest.backup_old'), guests)).toBeNull();
  });
});
