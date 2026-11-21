import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type CatalogEntry, catalogEntry, SERVERS_TOOLS, sensitiveReason } from './connections-catalog.js';
import {
  HostBackupVolume,
  HostChoices,
  HostGuestConfig,
  HostLibvirtDetail,
  HostManagePlatform,
  HostManageRequest,
  HostServerDetail,
  HostServerPlatform,
  HostTask,
  LIBVIRT_DOMAINS_FOLDER,
  LIBVIRT_ISOS_FOLDER,
  LIBVIRT_NAME_PATTERN,
} from './hosts.js';

const T = '2026-10-17T09:00:00.000Z';
const GiB = 1024 ** 3;

const info = (id: string, platform: string) => ({
  id,
  group: 'Lab',
  status: 'ok',
  roles: [],
  os: { name: 'Debian GNU/Linux', version: '13', kernel: '6.12.48' },
  cpu: null,
  memory: null,
  uptimeS: 3600,
  lastBoot: null,
  address: '10.100.0.50',
  location: null,
  agent: { version: '0.10.0', lastSyncSAgo: 4 },
  platform,
  remoteControl: { console: true, power: true, manage: true },
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

/** A Debian host with libvirt (kvm-lab): a dir pool, the NAT network, UEFI and a TPM (IU-13). */
const LIBVIRT = {
  version: '12.2.0',
  qemu: '10.1.0',
  pools: [
    {
      name: 'default',
      type: 'dir',
      active: true,
      autostart: true,
      path: '/var/lib/libvirt/images',
      usedBytes: 64 * GiB,
      totalBytes: 900 * GiB,
      availBytes: 836 * GiB,
      volumes: 4,
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
  backupsDir: '/var/lib/libvirt/images/.whombat-backups',
};

/** BlackBox's VM Manager: no pools, the domains and ISO folders of /boot/config/domain.cfg. */
const UNRAID_LIBVIRT = {
  version: '11.6.0',
  qemu: '9.2.0',
  pools: [],
  networks: [],
  folders: { domains: '/mnt/user/domains', isos: '/mnt/user/isos' },
  firmware: { uefi: true, secureBoot: false, tpm: true },
  backupsDir: '/mnt/user/domains/.whombat-backups',
};

const servers = (): CatalogEntry => {
  const e = catalogEntry('whombat_servers');
  if (!e) throw new Error('no Servers entry');
  return e;
};
const tool = (name: string) => SERVERS_TOOLS.find((t) => t.name === name);
const schema = (name: string) => z.fromJSONSchema(tool(name)?.inputSchema as never);

describe('QEMU/KVM through libvirt (CT-369, CT-370, 0.84.0)', () => {
  it('appends the libvirt kind and manage platform', () => {
    // Macs (Whombat macos-servers.md) append `macos`.
    expect(HostServerPlatform.options.slice(0, 5)).toEqual([
      'proxmox',
      'standard',
      'incus',
      'unraid',
      'libvirt',
    ]);
    // 0.98 (CT-500) appends `host`.
    expect(HostManagePlatform.options.slice(0, 4)).toEqual(['pve', 'incus', 'unraid', 'libvirt']);
  });

  it('parses a libvirt host’s page with its pools, networks and firmware', () => {
    const detail = HostServerDetail.parse(page(info('kvm-lab', 'libvirt'), { libvirt: LIBVIRT }));
    expect(detail.server.platform).toBe('libvirt');
    expect(detail.libvirt?.pools.map((p) => [p.name, p.active])).toEqual([
      ['default', true],
      ['isos', false],
    ]);
    expect(detail.libvirt?.networks[0]?.forward).toBe('nat');
    expect(detail.libvirt?.firmware).toEqual({ uefi: true, secureBoot: true, tpm: true });
    expect(detail.libvirt?.folders).toBeNull();
    expect(HostServerDetail.parse(page(info('pve-02', 'proxmox'), {})).libvirt).toBeUndefined();
    expect(HostLibvirtDetail.safeParse({ ...LIBVIRT, firmware: { uefi: true } }).success).toBe(false);
  });

  it('parses unRAID’s VM Manager: folders and no pools, next to the unRAID detail', () => {
    const detail = HostServerDetail.parse(page(info('blackbox', 'unraid'), { libvirt: UNRAID_LIBVIRT }));
    expect(detail.libvirt?.pools).toEqual([]);
    expect(detail.libvirt?.folders).toEqual({ domains: '/mnt/user/domains', isos: '/mnt/user/isos' });
    expect(LIBVIRT_DOMAINS_FOLDER).toBe('folder:domains');
    expect(LIBVIRT_ISOS_FOLDER).toBe('folder:isos');
  });

  it('reads a VM’s configuration in Proxmox-like keys and its choices', () => {
    const config = HostGuestConfig.parse({
      platform: 'libvirt',
      kind: 'vm',
      digest: 'ab'.repeat(32),
      running: true,
      values: {
        name: 'pbs',
        title: 'Proxmox Backup Server',
        vcpus: '4',
        memory_mb: '8192',
        autostart: '1',
        boot: 'hd,cdrom',
        cpu_mode: 'host-passthrough',
        on_crash: 'restart',
        disk0: 'source=/mnt/user/domains/pbs/vdisk1.img,bus=virtio,format=raw,target=vda,size=107374182400',
        cdrom0: 'source=empty,bus=sata',
        net0: 'model=virtio,bridge=br0,mac=52:54:00:00:00:01,link=up',
        machine: 'pc-q35-9.2',
        firmware: 'uefi',
      },
      pending: { memory_mb: '16384' },
      restricted: ['machine', 'firmware', 'secure_boot', 'tpm', 'hostdev0', 'graphics0', 'video'],
      disks: [{ key: 'disk0', path: '/mnt/user/domains/pbs/vdisk1.img', sizeBytes: 100 * GiB, boot: true }],
    });
    expect(config.platform).toBe('libvirt');
    const choices = HostChoices.parse({
      platform: 'libvirt',
      storages: [{ id: LIBVIRT_DOMAINS_FOLDER, type: 'folder', content: ['images'] }],
      bridges: ['br0'],
      networks: ['default'],
      isos: [{ volid: '/mnt/user/isos/debian-13.iso', name: 'debian-13.iso', sizeBytes: 700_000_000 }],
      osVariants: [
        { id: 'debian13', label: 'Debian 13', firmware: 'bios', tpm: false },
        { id: 'win11', label: 'Windows 11', firmware: 'uefi', tpm: true },
      ],
      firmware: { uefi: true, secureBoot: false, tpm: true },
    });
    expect(choices.osVariants?.find((v) => v.id === 'win11')?.tpm).toBe(true);
    expect(choices.networks).toEqual(['default']);
    expect(
      HostChoices.safeParse({ ...choices, osVariants: [{ id: 'x', label: 'X', firmware: 'efi' }] }).success,
    ).toBe(false);
  });

  it('takes the reused ops with platform libvirt, and its backups and tasks', () => {
    const create = HostManageRequest.parse({
      op: 'guest.create',
      platform: 'libvirt',
      params: {
        kind: 'vm',
        name: 'win11',
        osVariant: 'win11',
        iso: '/srv/isos/Win11.iso',
        storage: 'default',
        diskGb: 64,
        network: 'default',
        set: { vcpus: '4', memory_mb: '8192' },
        start: true,
      },
    });
    expect(create.platform).toBe('libvirt');
    expect(
      HostBackupVolume.parse({
        volume: '20261017-090000',
        storage: 'libvirt',
        guest: 'libvirt:pbs',
        created: T,
      }).storage,
    ).toBe('libvirt');
    expect(
      HostTask.parse({
        id: `libvirt:${'0a'.repeat(8)}`,
        type: 'backup',
        platform: 'libvirt',
        guestId: 'libvirt:pbs',
        started: T,
        status: 'running',
        cancellable: true,
      }).id,
    ).toMatch(/^libvirt:/);
    expect(LIBVIRT_NAME_PATTERN.test('win11.lab_2')).toBe(true);
    expect(LIBVIRT_NAME_PATTERN.test('.hidden')).toBe(false);
  });
});

describe('the Servers tools on QEMU/KVM (CT-371, 0.84.0)', () => {
  it('adds libvirt_overview and widens the others', () => {
    // 0.85 (CT-378) adds server_add: 51; 0.98 (CT-505) server_updates and server_update: 53; backup places
    // (backup-places.md BPL-12) backup_place_nfs and proxmox_storage_add: 55; Macs (macos-servers.md) mac_screen and
    // mac_ui: 57; what fills a disk, server_disk_usage: 58.
    expect(SERVERS_TOOLS).toHaveLength(58);
    expect(servers().tools).toHaveLength(58);
    const overview = tool('libvirt_overview');
    expect(overview?.access).toBe('read');
    expect(schema('libvirt_overview').safeParse({ server: 'kvm-lab' }).success).toBe(true);
    expect(schema('libvirt_overview').safeParse({ server: 'kvm-lab', extra: 1 }).success).toBe(false);
    for (const name of [
      'guest_config',
      'guest_config_set',
      'guest_create',
      'guest_clone',
      'guest_rename',
      'guest_delete',
      'guest_disk',
      'guest_backup',
      'storage_contents',
      'storage_content',
      'storage_volume',
      'network_leases',
      'guest_log',
      'server_tasks',
      'task_stop',
      'server_choices',
    ])
      expect(`${tool(name)?.description} ${JSON.stringify(tool(name)?.inputSchema)}`, name).toContain(
        'QEMU/KVM',
      );
    for (const t of SERVERS_TOOLS) expect(`${t.title} ${t.description}`, t.name).not.toMatch(/'/);
    expect(servers().guide).toContain('libvirt_overview');
    expect(servers().guide.length).toBeLessThanOrEqual(1500);
  });

  it('takes a QEMU/KVM call as a model would make it', () => {
    const S = { server: 'kvm-lab' };
    const G = { server: 'kvm-lab', guest: 'libvirt:win11' };
    const calls: [string, Record<string, unknown>][] = [
      [
        'guest_create',
        {
          ...S,
          kind: 'vm',
          name: 'win11',
          os_variant: 'win11',
          iso: '/srv/isos/Win11.iso',
          storage: 'default',
          disk_gb: 64,
          cores: 4,
          memory_mb: 8192,
          network: 'default',
          start: true,
        },
      ],
      [
        'guest_create',
        { server: 'blackbox', kind: 'vm', name: 'deb', storage: 'folder:domains', bridge: 'br0' },
      ],
      ['guest_config_set', { ...G, digest: 'd', set: { cdrom0: 'source=empty' } }],
      ['guest_clone', { ...G, name: 'win11-copy', storage: 'default' }],
      ['guest_rename', { ...G, name: 'win11.lab' }],
      ['guest_delete', { ...G, purge: false }],
      ['guest_disk', { ...G, action: 'resize', disk: 'disk0', size: '+20G' }],
      ['guest_backup', { ...G, action: 'create', compress: true }],
      ['guest_backup', { ...G, action: 'restore', backup: '20261017-090000', name: 'win11-restored' }],
      ['storage_contents', { ...S, storage: 'folder:isos', content: 'iso' }],
      [
        'storage_content',
        {
          ...S,
          action: 'download',
          storage: 'default',
          content: 'iso',
          url: 'https://example.org/debian-13.iso',
          filename: 'debian-13.iso',
        },
      ],
      ['storage_volume', { ...S, action: 'create', pool: 'default', volume: 'data.qcow2', size: '20G' }],
      ['network_leases', { ...S, network: 'default' }],
      ['guest_log', { ...G, lines: 100 }],
      ['server_choices', S],
    ];
    for (const [name, args] of calls) expect(schema(name).safeParse(args).success, name).toBe(true);
    expect(schema('guest_rename').safeParse({ ...G, name: 'a b' }).success).toBe(false);
    // What asks on Incus asks on QEMU/KVM too; libvirt_overview only reads.
    expect(
      sensitiveReason(servers(), 'storage_volume', { ...S, action: 'delete', pool: 'default', volume: 'x' }),
    ).not.toBeNull();
    expect(
      sensitiveReason(servers(), 'guest_backup', { ...G, action: 'restore', backup: 'b' }),
    ).not.toBeNull();
    expect(sensitiveReason(servers(), 'libvirt_overview', S)).toBeNull();
  });
});
