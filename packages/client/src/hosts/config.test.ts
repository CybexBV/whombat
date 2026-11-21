/**
 * Guest editing rules (proxmox-wa.md): property strings round-trip byte for byte, every dialog's writer leaves a value
 * it didn't change exactly as Proxmox wrote it, changes touch only their own sub-keys, and the review and the rows
 * read pending values as Proxmox's own dialogs do.
 */
import type { HostGuestConfig } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  addTags,
  afterRestart,
  attachValue,
  cdromValue,
  cidr6Error,
  cpuType,
  diskOptsWords,
  dnsServersError,
  editProps,
  efiDiskValue,
  formatHotplug,
  formatProps,
  getProp,
  haParams,
  haReviewRows,
  hotplugList,
  ip6Error,
  isCloudInitDrive,
  laterWords,
  macError,
  machineType,
  moveBlocked,
  NEW_DISK,
  NEW_MOUNT,
  newDiskValue,
  newMountValue,
  newNic,
  nicErrors,
  nicWords,
  otherKeys,
  parseProps,
  readAgent,
  readDiskOpts,
  readFeatures,
  readMount,
  readNic,
  readStartup,
  reviewRows,
  rowValue,
  setProp,
  sshKeysError,
  trimDraft,
  typeOf,
  withCdromFile,
  withCpuType,
  withMachineType,
  withNicMac,
  withType,
  writeAgent,
  writeDiskOpts,
  writeFeatures,
  writeMount,
  writeNic,
  writeStartup,
} from './config';

const cfg = (values: Record<string, string>, extra: Partial<HostGuestConfig> = {}): HostGuestConfig => ({
  platform: 'pve',
  kind: 'vm',
  digest: 'd',
  running: true,
  values,
  ...extra,
});

describe('property strings', () => {
  it('parse items in order, the default key for a bare first item', () => {
    expect(parseProps('local-zfs:vm-100-disk-0,iothread=1,size=64G', 'file')).toEqual([
      { key: 'file', value: 'local-zfs:vm-100-disk-0', bare: true },
      { key: 'iothread', value: '1' },
      { key: 'size', value: '64G' },
    ]);
    expect(parseProps('')).toEqual([]);
    expect(getProp(parseProps('virtio=BC:24:11:30:00:00,bridge=vmbr0'), 'virtio')).toBe('BC:24:11:30:00:00');
    // Only the first “=” splits; a later item without “=” continues the value (Incus lists).
    expect(parseProps('args=a=b')).toEqual([{ key: 'args', value: 'a=b' }]);
    expect(getProp(parseProps('type=nic,vlan.tagged=10,20'), 'vlan.tagged')).toBe('10,20');
  });

  it('round-trip any string unchanged (fuzzed)', () => {
    const alphabet = ['a', 'Z', '0', '=', ',', ':', ';', ' ', '/', '%', '-', '.', '+', ''];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 4000; i++) {
      const s = Array.from({ length: rnd(28) }, () => alphabet[rnd(alphabet.length)]).join('');
      for (const dk of ['', 'file', 'type', 'enabled']) expect(formatProps(parseProps(s, dk))).toBe(s);
      const items = parseProps(s, 'file');
      // Setting a new key and taking it out again leaves the rest as it was.
      if (!items.some((x) => x.key === 'zz'))
        expect(formatProps(setProp(setProp(items, 'zz', '1'), 'zz', undefined))).toBe(s);
    }
  });

  it('edit in place, append new keys and keep options Whombat doesn’t know', () => {
    const disk = 'vmdata:vm-101-disk-1,cache=writeback,discard=on,x-unknown=7,size=256G';
    expect(editProps(disk, { discard: 'ignore', ssd: '1' }, 'file')).toBe(
      'vmdata:vm-101-disk-1,cache=writeback,discard=ignore,x-unknown=7,size=256G,ssd=1',
    );
    expect(editProps(disk, { cache: undefined }, 'file')).toBe(
      'vmdata:vm-101-disk-1,discard=on,x-unknown=7,size=256G',
    );
    expect(editProps('none,media=cdrom', { file: 'local:iso/debian.iso' }, 'file')).toBe(
      'local:iso/debian.iso,media=cdrom',
    );
    expect(formatProps(setProp(parseProps('a=1,b=2,a=3'), 'a', '9'))).toBe('a=9,b=2');
  });
});

/** Values as Proxmox writes them: every reader → writer with nothing changed gives them back byte for byte. */
const UNCHANGED: [string, (v: string) => string | undefined][] = [
  ...[
    'local-zfs:vm-118-disk-0,iothread=1,size=64G',
    'local-lvm:vm-100-disk-0,cache=writeback,discard=on,ssd=1,size=32G,x-unknown=7',
    'vmdata:vm-101-disk-1,backup=0,replicate=0,aio=native,size=256G',
    'ceph:vm-102-disk-0,discard=ignore,iothread=0,serial=ABC,wwn=0x5000c500a1b2c3d4,size=1T',
  ].map((v): [string, (v: string) => string] => [
    v,
    (x) => writeDiskOpts(x, readDiskOpts(x), readDiskOpts(x)),
  ]),
  ...[
    'virtio=BC:24:11:3A:18:01,bridge=vmbr0,firewall=1',
    'e1000=BC:24:11:00:00:02,bridge=vmbr1,tag=20,rate=12.5,mtu=1500,queues=4,link_down=1',
    'virtio,bridge=vmbr0',
    'model=virtio,macaddr=BC:24:11:00:00:03,bridge=vmbr0,trunks=10;20',
  ].map((v): [string, (v: string) => string] => [
    v,
    (x) => writeNic(x, readNic(x, 'vm'), readNic(x, 'vm'), 'vm'),
  ]),
  ...[
    'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:5C:31:02,ip=dhcp,type=veth',
    'name=eth1,bridge=vmbr1,firewall=1,gw=10.0.0.1,hwaddr=BC:24:11:00:00:04,ip=10.0.0.5/24,ip6=auto,tag=30,type=veth',
  ].map((v): [string, (v: string) => string] => [
    v,
    (x) => writeNic(x, readNic(x, 'container'), readNic(x, 'container'), 'container'),
  ]),
  ...[
    'local-zfs:subvol-132-disk-1,mp=/mnt/data,backup=1,size=200G',
    'local-zfs:subvol-144-disk-1,mp=/srv,ro=1,replicate=0,acl=1,size=8G',
  ].map((v): [string, (v: string) => string] => [v, (x) => writeMount(x, readMount(x), readMount(x))]),
  ['1,fstrim_cloned_disks=1', (x) => writeAgent(x, readAgent(x), readAgent(x))],
  ['enabled=1,type=isa,freeze-fs-on-backup=0', (x) => writeAgent(x, readAgent(x), readAgent(x))],
  ['nesting=1,keyctl=1,mount=nfs;cifs', (x) => writeFeatures(x, readFeatures(x), readFeatures(x))],
  ['order=2,up=30,down=120', (x) => writeStartup(x, readStartup(x))],
  ['up=30,order=2', (x) => writeStartup(x, readStartup(x))],
  ['host,flags=+aes;-pcid', (x) => withCpuType(x, cpuType(x))],
  ['cputype=x86-64-v2-AES,hidden=1', (x) => withCpuType(x, cpuType(x))],
  ['qxl,memory=32', (x) => withType(x, typeOf(x))],
  ['type=virtio,memory=64', (x) => withType(x, typeOf(x))],
  ['pc-q35-9.2+pve1,viommu=virtio', (x) => withMachineType(x, machineType(x))],
  [
    'local:iso/debian-13.1.0-amd64-netinst.iso,media=cdrom,size=784M',
    (x) => withCdromFile(x, x.split(',')[0] ?? ''),
  ],
];

describe('writers leave what they didn’t change as it was', () => {
  it.each(UNCHANGED)('%s', (v, write) => expect(write(v)).toBe(v));
});

describe('disks', () => {
  it('change one option and keep the rest', () => {
    const v = 'local-lvm:vm-100-disk-0,cache=writeback,size=32G,x-unknown=7';
    const was = readDiskOpts(v);
    expect(was).toEqual({ ...NEW_DISK, iothread: false, cache: 'writeback' });
    expect(writeDiskOpts(v, { ...was, discard: true, backup: false, replicate: false }, was)).toBe(
      'local-lvm:vm-100-disk-0,cache=writeback,size=32G,x-unknown=7,discard=on,backup=0,replicate=0',
    );
    expect(writeDiskOpts(v, { ...was, cache: '' }, was)).toBe('local-lvm:vm-100-disk-0,size=32G,x-unknown=7');
  });

  it('make a new disk with what its bus has', () => {
    expect(newDiskValue('local-zfs', '32', 'scsi', NEW_DISK)).toBe('local-zfs:32,iothread=1');
    expect(newDiskValue('local-zfs', ' 8.5 ', 'virtio', { ...NEW_DISK, ssd: true, discard: true })).toBe(
      'local-zfs:8.5,discard=on,iothread=1',
    );
    expect(newDiskValue('local-zfs', '16', 'sata', { ...NEW_DISK, ssd: true, backup: false })).toBe(
      'local-zfs:16,ssd=1,backup=0',
    );
  });

  it('say its options in words', () => {
    expect(
      diskOptsWords('local-zfs:vm-1-disk-0,iothread=1,discard=on,backup=0,size=8G,aio=io_uring'),
    ).toEqual(['IO thread', 'discard', 'left out of backups', 'aio=io_uring']);
  });

  it('attach an unused volume without its size, and swap a CD', () => {
    expect(attachValue('local-zfs:vm-118-disk-2,size=8G')).toBe('local-zfs:vm-118-disk-2');
    expect(cdromValue('')).toBe('none,media=cdrom');
    expect(withCdromFile('local:iso/a.iso,media=cdrom,size=700M', 'nas:iso/b.iso')).toBe(
      'nas:iso/b.iso,media=cdrom',
    );
    expect(withCdromFile('local:iso/a.iso,media=cdrom,size=700M', '')).toBe('none,media=cdrom');
    expect(efiDiskValue('local-zfs', true)).toBe('local-zfs:1,efitype=4m,pre-enrolled-keys=1');
    expect(isCloudInitDrive('local-zfs:vm-118-cloudinit,media=cdrom')).toBe(true);
    expect(isCloudInitDrive('local:118/vm-118-cloudinit.qcow2,media=cdrom')).toBe(true);
    expect(isCloudInitDrive('local:iso/cloudinit-tools.iso,media=cdrom')).toBe(false);
  });

  it('say why a disk can’t move now', () => {
    const ct = cfg({}, { kind: 'container' });
    expect(moveBlocked(ct, 'rootfs')).toMatch(/^Stop it first/);
    expect(moveBlocked({ ...ct, running: false }, 'rootfs')).toBeNull();
    expect(moveBlocked(cfg({}), 'efidisk0')).toBeNull();
    expect(moveBlocked(cfg({}), 'tpmstate0')).toMatch(/^Shut it down first/);
  });
});

describe('network devices', () => {
  it('change a VM’s model, MAC and network in place', () => {
    const v = 'virtio=BC:24:11:3A:18:01,bridge=vmbr0,firewall=1,queues=4';
    const was = readNic(v, 'vm');
    expect(was).toMatchObject({ model: 'virtio', mac: 'BC:24:11:3A:18:01', bridge: 'vmbr0', firewall: true });
    expect(
      writeNic(v, { ...was, model: 'e1000', tag: '20', firewall: false, linkDown: true }, was, 'vm'),
    ).toBe('e1000=BC:24:11:3A:18:01,bridge=vmbr0,queues=4,tag=20,link_down=1');
    expect(writeNic(v, { ...was, mac: '' }, was, 'vm')).toBe('virtio,bridge=vmbr0,firewall=1,queues=4');
    expect(withNicMac('virtio,bridge=vmbr0', 'BC:24:11:00:00:09')).toBe(
      'virtio=BC:24:11:00:00:09,bridge=vmbr0',
    );
  });

  it('change a container’s name and addresses in place', () => {
    const v = 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:5C:31:02,ip=dhcp,type=veth';
    const was = readNic(v, 'container');
    const next = {
      ...was,
      name: 'lan0',
      ip: { ...was.ip, v4: 'static' as const, ip: '10.0.0.5/24', gw: '10.0.0.1' },
    };
    expect(writeNic(v, next, was, 'container')).toBe(
      'name=lan0,bridge=vmbr0,hwaddr=BC:24:11:5C:31:02,ip=10.0.0.5/24,type=veth,gw=10.0.0.1',
    );
  });

  it('make new ones', () => {
    const blank = readNic('', 'vm');
    expect(writeNic('', newNic('vm', 'net1', 'vmbr0'), blank, 'vm')).toBe('virtio,bridge=vmbr0,firewall=1');
    const ct = newNic('container', 'net1', 'vmbr1');
    expect(ct.name).toBe('eth1');
    expect(writeNic('', ct, readNic('', 'container'), 'container')).toBe(
      'name=eth1,bridge=vmbr1,firewall=1,ip=dhcp,type=veth',
    );
  });

  it('check their fields', () => {
    expect(macError('BC:24:11:00:00:01')).toBeNull();
    expect(macError('01:24:11:00:00:01')).toMatch(/group address/);
    expect(macError('BC:24:11')).toMatch(/^A MAC address/);
    const n = { ...newNic('container', 'net0', 'vmbr0'), tag: '5000', name: '0eth' };
    const e = nicErrors({ ...n, ip: { ...n.ip, v6: 'static', ip6: 'fd00::5' } }, 'container');
    expect(e.tag).toBe('At most 4094.');
    expect(e.name).toMatch(/starting with a letter/);
    expect(e.ip6).toMatch(/prefix/);
    expect(nicWords('name=eth0,bridge=vmbr0,tag=20,ip=dhcp,ip6=auto', 'container')).toBe(
      'eth0 · vmbr0 · VLAN 20 · DHCP, IPv6 automatic',
    );
  });

  it('read IPv6 addresses', () => {
    for (const ok of ['fd00::1', '::', '2001:db8:0:0:0:0:0:1', '::ffff:10.0.0.1', 'fe80::1:2:3:4'])
      expect(ip6Error(ok)).toBeNull();
    for (const bad of ['fd00:::1', '1:2:3:4:5:6:7:8:9', 'fd00::g', '10.0.0.1', 'fd00::1::2'])
      expect(ip6Error(bad)).not.toBeNull();
    expect(cidr6Error('fd00::5/64')).toBeNull();
    expect(cidr6Error('fd00::5/129')).not.toBeNull();
    expect(dnsServersError('10.100.1.1 fd00::53, 1.1.1.1')).toBeNull();
    expect(dnsServersError('10.100.1.1 dns.lan')).toBe('dns.lan isn’t an IP address.');
  });
});

describe('mount points', () => {
  it('change their folder and flags, and make new ones', () => {
    const v = 'local-zfs:subvol-132-disk-1,mp=/mnt/data,backup=1,size=200G';
    const was = readMount(v);
    expect(was).toEqual({ path: '/mnt/data', backup: true, ro: false, replicate: true });
    expect(writeMount(v, { ...was, path: '/srv/data', ro: true }, was)).toBe(
      'local-zfs:subvol-132-disk-1,mp=/srv/data,backup=1,size=200G,ro=1',
    );
    expect(newMountValue('local-zfs', '8', NEW_MOUNT)).toBe('local-zfs:8,mp=/mnt/data,backup=1');
  });
});

describe('options', () => {
  it('keep the guest agent’s other settings (PX-08)', () => {
    const v = '1,fstrim_cloned_disks=1,type=isa';
    const was = readAgent(v);
    expect(writeAgent(v, { ...was, enabled: false }, was)).toBe('0,fstrim_cloned_disks=1,type=isa');
    expect(writeAgent('1', { ...readAgent('1'), enabled: false }, readAgent('1'))).toBeUndefined();
    const off = readAgent(undefined);
    expect(writeAgent(undefined, { ...off, enabled: true, fstrim: true }, off)).toBe(
      '1,fstrim_cloned_disks=1',
    );
  });

  it('change only nesting, keyctl and FUSE among the features', () => {
    const v = 'nesting=1,mount=nfs';
    const was = readFeatures(v);
    expect(writeFeatures(v, { ...was, keyctl: true }, was)).toBe('nesting=1,mount=nfs,keyctl=1');
    expect(
      writeFeatures('nesting=1', { ...readFeatures('nesting=1'), nesting: false }, readFeatures('nesting=1')),
    ).toBeUndefined();
  });

  it('write hotplug, start order, CPU type and machine as Proxmox does', () => {
    expect(hotplugList(undefined)).toEqual(['network', 'disk', 'usb']);
    expect(formatHotplug(['usb', 'disk', 'network'])).toBeUndefined();
    expect(formatHotplug(['network', 'memory', 'cpu'])).toBe('network,memory,cpu');
    expect(formatHotplug([])).toBe('0');
    expect(writeStartup('order=2,up=30', { order: '', up: '30', down: '60' })).toBe('up=30,down=60');
    expect(writeStartup('order=2', { order: '', up: '', down: '' })).toBeUndefined();
    expect(withCpuType('host,flags=+aes', 'x86-64-v3')).toBe('x86-64-v3,flags=+aes');
    expect(withCpuType('host', '')).toBeUndefined();
    expect(withMachineType('q35,viommu=virtio', '')).toBe('pc,viommu=virtio');
    expect(withMachineType('q35', '')).toBeUndefined();
    expect(machineType('pc')).toBe('');
  });

  it('add tags as chips', () => {
    expect(addTags(['prod'], 'k3s;Prod web')).toEqual({ tags: ['prod', 'k3s', 'web'], error: null });
    expect(addTags(['prod'], 'b@d').error).toMatch(/^A tag starts/);
  });

  it('check SSH keys line by line', () => {
    expect(
      sshKeysError('ssh-ed25519 AAAAC3Nza john@lab\n# a comment\n\necdsa-sha2-nistp256 AAAAE2 x'),
    ).toBeNull();
    expect(sshKeysError('ssh-ed25519 AAAAC3Nza john@lab\nhello')).toBe(
      'Line 2 isn’t an SSH public key (its type, the key, a comment).',
    );
  });

  it('review an HA change', () => {
    expect(
      haReviewRows(null, { state: 'started', maxRestart: '1', maxRelocate: '2', comment: '' }).map(
        (r) => r.key,
      ),
    ).toEqual(['state', 'max_restart', 'max_relocate']);
    expect(
      haReviewRows(
        { state: 'started', maxRestart: 1, maxRelocate: 1 },
        { state: 'stopped', maxRestart: '1', maxRelocate: '1', comment: '' },
      ),
    ).toEqual([{ key: 'state', old: 'started', new: 'stopped', op: 'set' }]);
    expect(haParams({ state: 'started', maxRestart: '2', maxRelocate: '0', comment: ' db ' })).toEqual({
      state: 'started',
      maxRestart: 2,
      maxRelocate: 0,
      comment: 'db',
    });
  });
});

describe('rows and the review', () => {
  const c = cfg(
    {
      memory: '16384',
      cores: '4',
      sockets: '1',
      scsi0: 'local-zfs:vm-100-disk-0,size=64G',
      net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0',
      hostpci0: '0000:01:00.0,pcie=1',
      meta: 'creation-qemu=9.2.0',
      ciuser: 'john',
    },
    {
      pending: { memory: '24576', cores: '8', scsi1: 'local-zfs:vm-100-disk-1,size=8G' },
      pendingDelete: ['net0'],
    },
  );

  it('show each key now and after the next restart', () => {
    expect(rowValue(c, 'memory')).toEqual({ value: '16384', next: '24576' });
    expect(rowValue(c, 'net0')).toEqual({ value: c.values.net0, next: '', removed: true });
    expect(rowValue(c, 'sockets')).toEqual({ value: '1' });
    expect(afterRestart(c).net0).toBeUndefined();
    const words = (v: Record<string, string>) => `${v.sockets} × ${v.cores}`;
    expect(laterWords(c, ['sockets', 'cores'], words)).toBe('1 × 8');
    expect(laterWords(c, ['sockets'], words)).toBeUndefined();
  });

  it('review from the pending values and send only what differs', () => {
    expect(reviewRows(c, { set: { memory: '32768', cores: '8' }, delete: ['scsi1', 'balloon'] })).toEqual([
      { key: 'memory', old: '24576', new: '32768', op: 'set' },
      { key: 'scsi1', old: 'local-zfs:vm-100-disk-1,size=8G', op: 'delete' },
    ]);
    expect(trimDraft(c, { set: { cores: '8' }, delete: ['net0'], confirm: true })).toEqual({ confirm: true });
  });

  it('list the keys no tab shows', () => {
    expect(otherKeys(c)).toEqual(['ciuser', 'hostpci0']);
    expect(otherKeys(c, { cloudInit: true })).toEqual(['hostpci0']);
  });
});
