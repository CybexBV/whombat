import {
  type HostChoices,
  type HostGuestConfig,
  HostGuestDetail,
  HostManageReadResult,
  HostServerDetail,
  HostTask,
} from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createHostsFixtures } from './fixtures';
import {
  cpuModeWords,
  existingLvDiskValue,
  firmwareWords,
  forwardWords,
  isLibvirtServer,
  libvirtBackupTime,
  libvirtCreateErrors,
  libvirtCreateParams,
  libvirtDefaults,
  libvirtGuestTabs,
  libvirtIsos,
  libvirtLockPlace,
  libvirtOtherKeys,
  lvBootWords,
  lvCdromWords,
  lvCpuWords,
  lvDiskWords,
  lvFreeKey,
  lvLinkOptions,
  lvMemoryWords,
  lvNicWords,
  newLvDiskValue,
  newLvNicValue,
  osVariantNote,
  parseLibvirtServerTab,
  poolRows,
  readLvNic,
  restoredName,
  snapshotBlocker,
  tpmWords,
  withLvCdrom,
  withOsVariant,
  writeLvNic,
} from './libvirt';

const NOW = Date.parse('2026-10-17T12:00:00Z');

function cfg(values: Record<string, string>, extra: Partial<HostGuestConfig> = {}): HostGuestConfig {
  return { platform: 'libvirt', kind: 'vm', digest: 'd', running: true, values, ...extra };
}

describe('libvirt keys', () => {
  it('changes a network card item by item and keeps what it has no field for', () => {
    const v = 'model=e1000e,network=default,mac=52:54:00:3c:91:0a,link=up,queues=4';
    const was = readLvNic(v);
    expect(was).toEqual({ model: 'e1000e', link: 'network:default', mac: '52:54:00:3c:91:0a', up: true });
    expect(writeLvNic(v, was, was)).toBe(v);
    expect(writeLvNic(v, { ...was, up: false }, was)).toBe(
      'model=e1000e,network=default,mac=52:54:00:3c:91:0a,link=down,queues=4',
    );
    expect(writeLvNic(v, { ...was, link: 'bridge:br0', model: 'virtio' }, was)).toBe(
      'model=virtio,mac=52:54:00:3c:91:0a,link=up,queues=4,bridge=br0',
    );
    expect(lvNicWords(v)).toBe('Intel E1000E on default');
    expect(lvNicWords('model=virtio,direct=vhost0,mac=52:54:00:8a:e0:c6')).toBe(
      'VirtIO on macvtap on vhost0',
    );
    expect(newLvNicValue({ model: 'virtio', link: 'bridge:br0', mac: '', up: true })).toBe(
      'model=virtio,bridge=br0,link=up',
    );
  });

  it('puts a disc in or takes it out without touching the drive', () => {
    const v = 'source=default/Win11.iso,bus=sata,target=sdb';
    expect(withLvCdrom(v, '')).toBe('source=empty,bus=sata,target=sdb');
    expect(withLvCdrom('source=empty,bus=sata', 'default/debian.iso')).toBe(
      'source=default/debian.iso,bus=sata',
    );
    expect(lvCdromWords(v)).toBe('Win11.iso');
    expect(lvCdromWords('source=empty,bus=sata')).toBe('No disc');
  });

  it('words disks, processors, memory, boot, firmware and the TPM', () => {
    expect(lvDiskWords(`source=/mnt/data/pbs/pbs-datastore.raw,bus=virtio,format=raw,size=${2 ** 41}`)).toBe(
      '/mnt/data/pbs/pbs-datastore.raw · VirtIO · raw',
    );
    expect(newLvDiskValue('default', '20', 'virtio', 'qcow2')).toBe(
      'new=20G,storage=default,format=qcow2,bus=virtio',
    );
    expect(existingLvDiskValue('default/old.qcow2', 'sata')).toBe(
      'source=default/old.qcow2,bus=sata,format=qcow2',
    );
    expect(lvCpuWords({ vcpus: '2', vcpus_max: '4', cpu_mode: 'host-model' })).toBe(
      '2 of 4 vCPUs · Host model',
    );
    expect(cpuModeWords('custom:EPYC-v4')).toBe('EPYC-v4');
    expect(lvMemoryWords({ memory_mb: '4096', memory_max_mb: '8192' })).toBe('4 GiB of 8 GiB');
    expect(lvBootWords('hd,cdrom')).toBe('Hard disk → CD/DVD');
    expect(firmwareWords({ firmware: 'uefi', secure_boot: '1' })).toBe('UEFI with Secure Boot');
    expect(firmwareWords({ firmware: 'bios' })).toBe('BIOS (SeaBIOS)');
    expect(tpmWords('model=tpm-crb,backend=emulator,version=2.0')).toBe('TPM 2.0, emulated');
  });

  it('knows when internal snapshots can’t be taken and which keys no row shows', () => {
    const c = cfg({
      disk0: 'source=a.qcow2,format=qcow2',
      disk1: 'source=/x/pbs-datastore.raw,format=raw',
      cdrom0: 'source=empty',
      watchdog0: 'model=itco',
      memory_mb: '1024',
    });
    expect(snapshotBlocker(c)).toBe('pbs-datastore.raw');
    expect(snapshotBlocker(cfg({ disk0: 'source=a.qcow2,format=qcow2' }))).toBeNull();
    expect(libvirtOtherKeys(c)).toEqual(['watchdog0']);
    expect(lvFreeKey(c, 'disk')).toBe('disk2');
    expect(lvFreeKey(cfg({}, { pending: { net0: 'x' } }), 'net')).toBe('net1');
  });

  it('offers networks before bridges and keeps what a card has now', () => {
    expect(
      lvLinkOptions({ networks: ['default'], bridges: ['br0'] }, 'direct:vhost0').map((o) => o.value),
    ).toEqual(['direct:vhost0', 'network:default', 'bridge:br0']);
    expect(forwardWords({ forward: 'nat', bridge: 'virbr0' })).toBe('NAT to the host’s network');
    expect(forwardWords({ forward: null, bridge: null })).toBe('Isolated (only between VMs)');
  });
});

describe('a new VM', () => {
  const choices: HostChoices = {
    platform: 'libvirt',
    storages: [{ id: 'default', type: 'dir', content: ['images'] }],
    bridges: ['br0'],
    networks: ['default'],
    isos: [
      { volid: 'default/virtio-win-0.1.271.iso', name: 'virtio-win-0.1.271.iso' },
      { volid: 'default/Win11_24H2.iso', name: 'Win11_24H2.iso' },
      { volid: 'default/debian-13.1.0-amd64-netinst.iso', name: 'debian-13.1.0-amd64-netinst.iso' },
    ],
  };

  it('starts as Debian on the first pool and network, and Windows 11 picks its ISO and sizes', () => {
    const f = libvirtDefaults(choices);
    expect(f).toMatchObject({
      osVariant: 'debian13',
      storage: 'default',
      link: 'network:default',
      start: true,
    });
    expect(f.iso).toBe('default/debian-13.1.0-amd64-netinst.iso');
    const w = withOsVariant(f, 'win11', libvirtIsos(choices.isos));
    expect(w).toMatchObject({ iso: 'default/Win11_24H2.iso', memoryMb: '8192', diskGb: '80' });
    const changed = withOsVariant({ ...f, memoryMb: '2048' }, 'win11', []);
    expect(changed.memoryMb).toBe('2048');
  });

  it('says what Windows 11 needs, and refuses it without a TPM', () => {
    const win11 = { id: 'win11', label: 'Windows 11', firmware: 'uefi' as const, tpm: true };
    expect(osVariantNote(win11, { uefi: true, secureBoot: true, tpm: true })?.text).toBe(
      'Set up with UEFI, a TPM 2.0 and a SATA CD/DVD drive for the installer.',
    );
    expect(osVariantNote(win11, { uefi: true, secureBoot: true, tpm: false })).toEqual({
      text: 'Windows 11 needs a TPM, and this server has no swtpm installed.',
      blocked: true,
    });
  });

  it('checks the form and sends camelCase params', () => {
    const f = { ...libvirtDefaults(choices), name: 'web 2' };
    expect(libvirtCreateErrors(f).name).toMatch(/Letters/);
    expect(libvirtCreateParams({ ...f, name: 'web-02', link: 'bridge:br0' })).toEqual({
      platform: 'libvirt',
      kind: 'vm',
      name: 'web-02',
      osVariant: 'debian13',
      set: { vcpus: '2', memory_mb: '4096', autostart: '0' },
      storage: 'default',
      diskGb: 32,
      iso: 'default/debian-13.1.0-amd64-netinst.iso',
      bridge: 'br0',
      start: true,
    });
  });
});

describe('server-level pieces', () => {
  it('reads backup folders as times and names restores', () => {
    expect(libvirtBackupTime({ volume: '20261016-020000' })).toBe(Date.parse('2026-10-16T02:00:00Z'));
    expect(restoredName('web', ['web-restored'])).toBe('web-restored-2');
  });

  it('says where locked settings are changed and lists a VM’s tabs by its switches', () => {
    expect(libvirtLockPlace('unraid')).toBe('Unraid’s VM page');
    expect(libvirtLockPlace('libvirt')).toBe('virt-manager');
    expect(libvirtGuestTabs({ power: true }, { manage: true })).toEqual([
      'summary',
      'hardware',
      'options',
      'snapshots',
      'backups',
      'tasks',
      'log',
    ]);
    expect(libvirtGuestTabs({ power: false }, { manage: false })).toEqual(['summary']);
    expect(parseLibvirtServerTab('network')).toBe('network');
    expect(parseLibvirtServerTab('array')).toBe('summary');
  });
});

describe('the fixture world', () => {
  const { handle } = createHostsFixtures(NOW);
  const get = (path: string, query: Record<string, string> = {}) =>
    handle({ method: 'GET', path, query, body: {} });
  const post = (path: string, body: Record<string, unknown>) =>
    handle({ method: 'POST', path, query: {}, body });

  it('has kvm-lab as a QEMU/KVM server with pools, networks and five VMs', () => {
    const d = HostServerDetail.parse(get('/servers/kvm-lab')?.body);
    expect(isLibvirtServer(d)).toBe(true);
    expect(d.libvirt?.pools.map((p) => p.name)).toEqual(['default', 'isos', 'fast']);
    expect(d.workloads?.libvirt?.guests.map((g) => g.name)).toEqual([
      'debian-web',
      'win11',
      'pfsense',
      'alpine-test',
      'nixos-build',
    ]);
    expect(poolRows(d.libvirt).map((r) => r.state)).toEqual(['ok', 'ok', 'warn']);
    expect(d.hints.map((h) => h.kind)).toEqual(['libvirt.pool_full', 'libvirt.no_backup']);
    const g = HostGuestDetail.parse(get('/servers/kvm-lab/guests/libvirt:win11')?.body);
    expect(g.manageable).toBe(true);
    // win11 sits on a raw LVM volume: no internal snapshots.
    expect(
      post('/servers/kvm-lab/guests/libvirt:win11/actions', { action: 'snapshot_create', snapshot: 'x' })
        ?.status,
    ).toBe(409);
  });

  it('gives BlackBox its VM Manager folders and pbs its real configuration', () => {
    const d = HostServerDetail.parse(get('/servers/blackbox')?.body);
    expect(d.libvirt?.folders).toEqual({ domains: '/mnt/user/domains/', isos: '/mnt/user/isos/' });
    const r = HostManageReadResult.parse(
      get('/servers/blackbox/manage', { op: 'config.get', guestId: 'libvirt:pbs', platform: 'libvirt' })
        ?.body,
    );
    if (r.op !== 'config.get') throw new Error(r.op);
    expect(r.config.values.net0).toBe('model=virtio,direct=vhost0,mac=52:54:00:8a:e0:c6,link=up');
    expect(snapshotBlocker(r.config)).toBe('pbs-datastore.raw');
    expect(
      post('/servers/blackbox/guests/libvirt:pbs/actions', { action: 'snapshot_create', snapshot: 'x' })
        ?.status,
    ).toBe(409);
  });

  it('keeps a running VM’s new maximum for its next start and takes a disc at once', () => {
    const read = () => {
      const r = HostManageReadResult.parse(
        get('/servers/kvm-lab/manage', { op: 'config.get', guestId: 'libvirt:win11', platform: 'libvirt' })
          ?.body,
      );
      if (r.op !== 'config.get') throw new Error(r.op);
      return r.config;
    };
    const c = read();
    const out = post('/servers/kvm-lab/manage', {
      op: 'config.set',
      guestId: 'libvirt:win11',
      digest: c.digest,
      params: { set: { cdrom0: withLvCdrom(c.values.cdrom0, ''), memory_max_mb: '32768' } },
    });
    expect(out?.status).toBe(200);
    const after = read();
    expect(after.values.cdrom0).toBe('source=empty,bus=sata,target=sdb');
    expect(after.pending).toEqual({ memory_max_mb: '32768' });
    expect(
      post('/servers/kvm-lab/manage', {
        op: 'config.set',
        guestId: 'libvirt:win11',
        digest: c.digest,
        params: { set: { title: 'x' } },
      })?.status,
    ).toBe(409);
    expect(
      post('/servers/kvm-lab/manage', {
        op: 'config.set',
        guestId: 'libvirt:win11',
        digest: after.digest,
        params: { set: { tpm: 'none' } },
      })?.status,
    ).toBe(403);
  });

  it('runs a backup as a libvirt task that ends and lists it', () => {
    const out = post('/servers/kvm-lab/manage', {
      op: 'backup.create',
      guestId: 'libvirt:win11',
      platform: 'libvirt',
      params: {},
    });
    expect(out?.status).toBe(200);
    const id = (out as { body: { task: { id: string } } }).body.task.id;
    expect(id).toMatch(/^libvirt:[0-9a-f]{16}$/);
    let t = HostTask.parse(get(`/servers/kvm-lab/tasks/${id}`)?.body);
    for (let i = 0; i < 6 && t.status === 'running'; i++)
      t = HostTask.parse(get(`/servers/kvm-lab/tasks/${id}`)?.body);
    expect(t.status).toBe('ok');
    const r = HostManageReadResult.parse(
      get('/servers/kvm-lab/manage', { op: 'backup.list', guestId: 'libvirt:win11', platform: 'libvirt' })
        ?.body,
    );
    expect(r.op === 'backup.list' && r.items.length).toBe(1);
  });

  it('refuses to delete a volume a VM uses and an ISO in a drive', () => {
    expect(
      post('/servers/kvm-lab/manage', {
        op: 'volume.delete',
        platform: 'libvirt',
        params: { pool: 'fast', volume: 'win11' },
        confirm: true,
      })?.status,
    ).toBe(409);
    expect(
      post('/servers/kvm-lab/manage', {
        op: 'content.delete',
        platform: 'libvirt',
        params: { volume: 'isos/virtio-win-0.1.271.iso' },
        confirm: true,
      })?.status,
    ).toBe(409);
  });
});
