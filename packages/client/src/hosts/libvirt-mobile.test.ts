/** A libvirt VM and a QEMU/KVM server on the phone as view models (app docs/decisions/incus-unraid-mobile.md AP-1642…). */
import type { HostGuestConfig, HostLibvirtDetail } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { taskPlatform } from './incus-mobile';
import {
  isLibvirtServer,
  isoChoices,
  libvirtBackupRows,
  libvirtEditDraft,
  libvirtEditStart,
  libvirtFacts,
  libvirtHeadLine,
  libvirtHintWayOut,
  libvirtNameError,
  libvirtPoolRows,
  libvirtReviewLines,
  libvirtReviewNote,
  libvirtSettingGroups,
  noBackupGuests,
  phoneLibvirtTabs,
} from './libvirt-mobile';

const NOW = Date.parse('2026-10-17T12:02:00Z');
const TZ = 'Europe/Amsterdam';
const GIB = 1024 ** 3;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(/ /g, ' '));

const cfg = (over: Partial<HostGuestConfig> = {}): HostGuestConfig => ({
  platform: 'libvirt',
  kind: 'vm',
  digest: 'sha-1',
  running: true,
  values: {
    name: 'win11',
    description: '',
    vcpus: '8',
    vcpus_max: '12',
    memory_mb: '16384',
    memory_max_mb: '24576',
    autostart: '0',
    boot: 'hd,cdrom',
    cpu_mode: 'host-passthrough',
    on_crash: 'destroy',
    disk0: `source=vmstore/win11.qcow2,bus=virtio,format=qcow2,target=vda,size=${128 * GIB}`,
    cdrom0: 'source=/srv/isos/virtio-win.iso,bus=sata',
    net0: 'model=virtio,network=default,mac=52:54:00:aa:bb:cc,link=up',
    machine: 'pc-q35-10.1',
    firmware: 'uefi',
    tpm: '1',
  },
  pending: {},
  restricted: ['machine', 'firmware', 'tpm'],
  ...over,
});

describe('a libvirt VM’s screen (IU-13)', () => {
  it('gets the Incus instance’s five tabs and a QEMU/KVM line', () => {
    expect(phoneLibvirtTabs({ manageable: true })).toEqual([
      'summary',
      'settings',
      'snapshots',
      'backups',
      'tasks',
    ]);
    expect(phoneLibvirtTabs({ manageable: false })).toEqual(['summary']);
    expect(libvirtHeadLine({ serverId: 'the-falcon' })).toBe('the-falcon');
    expect(taskPlatform('libvirt:0123456789abcdef')).toBe('libvirt');
  });

  it('reads its settings in groups, hardware locked', () => {
    const groups = plain(libvirtSettingGroups(cfg()));
    expect(groups.map((g) => g.title)).toEqual([
      'Processors',
      'Memory',
      'CD/DVD',
      'Disks',
      'Network',
      'Options',
      'Firmware',
    ]);
    const rows = Object.fromEntries(groups.flatMap((g) => g.rows).map((r) => [r.id, r]));
    expect(rows.vcpus).toMatchObject({ value: '8 vCPUs', edit: 'vcpus' });
    expect(rows.vcpus_max).toMatchObject({ label: 'Up to', value: '12 vCPUs' });
    expect(rows.cpu_mode).toMatchObject({ value: 'The host’s own processor' });
    expect(rows.memory).toMatchObject({ value: '16 GiB', edit: 'memory' });
    expect(rows.cdrom0).toMatchObject({ value: 'virtio-win.iso', edit: 'cdrom', key: 'cdrom0' });
    expect(rows.disk0).toMatchObject({
      label: 'Disk vda',
      value: '128 GiB · virtio · qcow2',
      sub: 'vmstore/win11.qcow2',
    });
    expect(rows.net0).toMatchObject({ value: 'network default', sub: 'virtio · 52:54:00:aa:bb:cc' });
    expect(rows.autostart).toMatchObject({ value: 'No', edit: 'autostart' });
    expect(rows.boot).toMatchObject({ value: 'Disk, then CD/DVD' });
    expect(rows.firmware).toMatchObject({ value: 'UEFI', locked: true });
    expect(rows.firmware?.edit).toBeUndefined();
  });

  it('makes the everyday edits and reviews them', () => {
    const c = cfg();
    const mem = libvirtEditDraft(c, 'memory', { ...libvirtEditStart(c, 'memory'), text: '32768' });
    expect(mem.draft).toEqual({ set: { memory_mb: '32768' } });
    expect(plain(libvirtReviewLines(c, mem.draft ?? {}))).toEqual([
      { key: 'memory_mb', label: 'Memory', old: '16 GiB', new: '32 GiB' },
    ]);
    expect(libvirtReviewNote(c, mem.draft ?? {})).toMatch(/next start/);
    expect(libvirtEditDraft(c, 'vcpus', { ...libvirtEditStart(c, 'vcpus'), text: '0' }).error).toBe(
      'At least 1.',
    );
    expect(libvirtEditDraft(c, 'autostart', { ...libvirtEditStart(c, 'autostart'), on: true }).draft).toEqual(
      {
        set: { autostart: '1' },
      },
    );
    const start = libvirtEditStart(c, 'cdrom', 'cdrom0');
    expect(start.iso).toBe('/srv/isos/virtio-win.iso');
    const eject = libvirtEditDraft(c, 'cdrom', { ...start, iso: '' }, 'cdrom0');
    expect(eject.draft).toEqual({ set: { cdrom0: 'source=empty,bus=sata' } });
    expect(libvirtReviewLines(c, eject.draft ?? {})).toEqual([
      { key: 'cdrom0', label: 'CD/DVD (cdrom0)', old: 'virtio-win.iso', new: 'Empty' },
    ]);
    expect(
      libvirtEditDraft(c, 'description', { ...libvirtEditStart(c, 'description'), text: '' }).draft,
    ).toEqual({});
  });

  it('offers the server’s ISOs, empty first', () => {
    expect(
      isoChoices(
        [{ volid: '/srv/isos/debian.iso', name: 'debian.iso', sizeBytes: 1 }],
        '/srv/isos/virtio-win.iso',
      ),
    ).toEqual([
      { value: '', label: 'Empty' },
      { value: '/srv/isos/debian.iso', label: 'debian.iso' },
      { value: '/srv/isos/virtio-win.iso', label: 'virtio-win.iso' },
    ]);
  });

  it('checks names and lists backups', () => {
    expect(libvirtNameError('win11.copy')).toBeNull();
    expect(libvirtNameError('-x')).toBe('Letters, digits, dots, dashes and “_”.');
    expect(libvirtNameError('w', ['w'])).toBe('There’s already a guest called w.');
    expect(libvirtNameError('w', [], 'w')).toBe('That’s its name now.');
    const rows = plain(
      libvirtBackupRows(
        [
          {
            volume: '20261016-021200',
            storage: 'libvirt',
            guest: 'libvirt:win11',
            created: '2026-10-16T00:12:00Z',
            sizeBytes: 61 * GIB,
          },
          {
            volume: '20261017-021200',
            storage: 'libvirt',
            guest: 'libvirt:win11',
            created: '2026-10-17T00:12:00Z',
            sizeBytes: 62 * GIB,
          },
        ],
        NOW,
        TZ,
      ),
    );
    expect(rows.map((r) => [r.title, r.line])).toEqual([
      ['Today 02:12', '62 GiB'],
      ['Yesterday 02:12', '61 GiB'],
    ]);
  });
});

describe('a QEMU/KVM server (IU-13)', () => {
  const lv: HostLibvirtDetail = {
    version: '12.2.0',
    qemu: '10.1.0',
    pools: [
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
        name: 'old',
        type: 'dir',
        active: false,
        autostart: false,
        path: '/old',
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
        usedBy: 2,
      },
    ],
    folders: null,
    firmware: { uefi: true, secureBoot: false, tpm: true },
    backupsDir: '/var/lib/libvirt/images/.whombat-backups',
  };

  it('is told by its kind or libvirt on a standard host', () => {
    expect(isLibvirtServer({ server: { platform: 'libvirt' } as never })).toBe(true);
    expect(isLibvirtServer({ server: { platform: 'standard' } as never, libvirt: lv })).toBe(true);
    expect(
      isLibvirtServer({ server: { platform: 'unraid' } as never, libvirt: lv, unraid: {} as never }),
    ).toBe(false);
  });

  it('has its facts and pools (warn from 85 %), or unRAID’s folders', () => {
    expect(libvirtFacts(lv)).toEqual([
      { label: 'libvirt', value: '12.2.0' },
      { label: 'QEMU', value: '10.1.0' },
      { label: 'Firmware', value: 'UEFI · TPM' },
      { label: 'Networks', value: 'default' },
      { label: 'Backups to', value: '/var/lib/libvirt/images/.whombat-backups' },
    ]);
    const pools = plain(libvirtPoolRows(lv));
    expect(pools[0]).toMatchObject({
      name: 'vmstore',
      line: 'zfs · 9 volumes',
      usedText: '1.7 TiB of 2 TiB used',
      tone: 'warn',
    });
    expect(pools[1]).toMatchObject({ line: 'Not active', usedText: '', pct: null });
    expect(
      libvirtPoolRows({
        ...lv,
        pools: [],
        folders: { domains: '/mnt/user/domains', isos: '/mnt/user/isos' },
      }).map((r) => [r.name, r.line]),
    ).toEqual([
      ['VM disks', '/mnt/user/domains'],
      ['ISO images', '/mnt/user/isos'],
    ]);
  });

  it('opens a VM’s Backups for “no recent backup”', () => {
    expect(libvirtHintWayOut('libvirt.no_backup')).toEqual({ label: 'Back it up', to: 'backups' });
    expect(libvirtHintWayOut('libvirt.pool_full')).toBeNull();
    const hint = {
      serverId: 'd',
      kind: 'libvirt.no_backup',
      severity: 'info' as const,
      entity: 'router',
      title: '',
      detail: '',
      section: 'guests',
    };
    expect(noBackupGuests([hint], 'd', [{ id: 'libvirt:router', name: 'router' }]).map((g) => g.id)).toEqual([
      'libvirt:router',
    ]);
  });
});
