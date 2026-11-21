import { HostChoices } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createHostsFixtures } from './fixtures';
import {
  appliances,
  checksumError,
  contentItems,
  createFieldErrors,
  ctCreateParams,
  ctDefaults,
  ctErrors,
  downloadNameError,
  downloadParams,
  downloadUrlError,
  filenameFromUrl,
  filterAppliances,
  hasContents,
  hasErrors,
  incusCreateParams,
  incusDefaults,
  incusErrors,
  incusNic,
  preferredIso,
  storageContents,
  templateGuest,
  VM_ERROR_FIELDS,
  vmCreateParams,
  vmDefaults,
  vmErrors,
  withBios,
  withOsType,
} from './manage';

const { handle } = createHostsFixtures(Date.parse('2026-10-17T12:02:00Z'));
const read = (server: string, query: Record<string, string>) =>
  handle({ method: 'GET', path: `/servers/${server}/manage`, query, body: {} })?.body as never;
const choices = HostChoices.parse((read('pve-02', { op: 'choices' }) as { choices: unknown }).choices);

describe('the create form for a VM', () => {
  it('starts as Proxmox’s wizard does', () => {
    const f = vmDefaults(choices);
    expect(f).toMatchObject({
      vmid: '146',
      cpu: 'x86-64-v2-AES',
      bios: 'seabios',
      machine: 'i440fx',
      model: 'virtio',
      bridge: 'vmbr0',
      storage: 'local-zfs',
      agent: true,
      firewall: true,
      tpm: false,
    });
    expect(f.iso).toMatch(/\.iso$/);
  });

  it('sends a VirtIO SCSI single disk, the ISO and a VirtIO NIC', () => {
    const p = vmCreateParams({
      ...vmDefaults(choices),
      name: 'web-03',
      iso: 'nas-iso:iso/pbs.iso',
      vlan: '20',
    });
    expect(p).toMatchObject({ platform: 'pve', kind: 'vm', newId: 146, name: 'web-03', start: true });
    expect(p.set).toEqual({
      ostype: 'l26',
      scsihw: 'virtio-scsi-single',
      scsi0: 'local-zfs:32,iothread=1',
      ide2: 'nas-iso:iso/pbs.iso,media=cdrom',
      boot: 'order=scsi0;ide2;net0',
      cores: '2',
      sockets: '1',
      cpu: 'x86-64-v2-AES',
      memory: '2048',
      net0: 'virtio,bridge=vmbr0,tag=20,firewall=1',
      agent: '1',
    });
  });

  it('takes the Windows preset: OVMF with an EFI disk, q35 and a TPM', () => {
    const f = withOsType({ ...vmDefaults(choices), name: 'win-01' }, 'win11');
    expect(f).toMatchObject({ ostype: 'win11', bios: 'ovmf', machine: 'q35', tpm: true });
    const set = vmCreateParams(f).set;
    expect(set).toMatchObject({
      ostype: 'win11',
      scsihw: 'virtio-scsi-single',
      bios: 'ovmf',
      machine: 'q35',
      efidisk0: 'local-zfs:1,efitype=4m,pre-enrolled-keys=1',
      tpmstate0: 'local-zfs:1,version=v2.0',
    });
  });

  it('picks a Windows ISO for Windows, not the driver disc', () => {
    const isos = [
      { volume: 'local:iso/debian.iso', name: 'debian.iso', storage: 'local' },
      { volume: 'nas:iso/virtio-win.iso', name: 'virtio-win.iso', storage: 'nas' },
      { volume: 'local:iso/Win11.iso', name: 'Win11.iso', storage: 'local' },
    ];
    expect(preferredIso(isos, 'win11', 'local:iso/debian.iso')).toBe('local:iso/Win11.iso');
    expect(preferredIso(isos, 'l26', 'local:iso/Win11.iso')).toBe('local:iso/debian.iso');
    expect(preferredIso(isos, 'l26', '')).toBe('');
  });

  it('sets q35 only with OVMF', () => {
    const f = vmDefaults(choices);
    expect(vmCreateParams({ ...f, name: 'a' }).set.machine).toBeUndefined();
    expect(withBios(f, 'ovmf').machine).toBe('q35');
    expect(withBios(withBios(f, 'ovmf'), 'seabios').machine).toBe('i440fx');
  });

  it('checks its fields', () => {
    const e = vmErrors({ ...vmDefaults(choices), name: 'bad name', vmid: '7', vlan: '5000', sockets: '0' });
    expect(Object.keys(e).filter((k) => e[k as keyof typeof e])).toEqual(['vmid', 'name', 'sockets', 'vlan']);
    expect(hasErrors(vmErrors({ ...vmDefaults(choices), name: 'web-03.lab' }))).toBe(false);
  });

  it('puts the platform’s errors on their fields', () => {
    expect(createFieldErrors({ scsi0: 'no space', net0: 'bad bridge', foo: 'x' }, VM_ERROR_FIELDS)).toEqual({
      storage: 'no space',
      bridge: 'bad bridge',
    });
  });

  it('starts on boot when asked', () => {
    expect(vmCreateParams({ ...vmDefaults(choices), name: 'a', onboot: true }).set.onboot).toBe('1');
  });
});

describe('the create form for a container', () => {
  it('starts unprivileged with nesting and DHCP, 1 core, 512 MiB and 512 swap', () => {
    const f = ctDefaults(choices);
    expect(f).toMatchObject({ cores: '1', memoryMb: '512', swapMb: '512', nesting: true, ipv4: 'dhcp' });
    expect(f.template).toMatch(/vztmpl/);
    const p = ctCreateParams({ ...f, hostname: 'dns-2' });
    expect(p.set).toMatchObject({
      rootfs: 'local-zfs:8',
      unprivileged: '1',
      features: 'nesting=1',
      net0: 'name=eth0,bridge=vmbr0,firewall=1,ip=dhcp',
      swap: '512',
    });
  });

  it('sends static addresses, DNS and several SSH keys', () => {
    const p = ctCreateParams({
      ...ctDefaults(choices),
      hostname: 'dns-2',
      vlan: '30',
      ipv4: 'static',
      ip4: '10.100.3.5/24',
      gw4: '10.100.3.1',
      ipv6: 'static',
      ip6: 'fd00::5/64',
      gw6: 'fd00::1',
      nameserver: '10.100.1.1, 1.1.1.1',
      searchdomain: 'home.lan',
      sshKeys: 'ssh-ed25519 AAAA one\n\n  ssh-ed25519 BBBB two  \n',
      password: 'secret',
      nesting: false,
    });
    expect(p.set.net0).toBe(
      'name=eth0,bridge=vmbr0,tag=30,firewall=1,ip=10.100.3.5/24,gw=10.100.3.1,ip6=fd00::5/64,gw6=fd00::1',
    );
    expect(p.set).toMatchObject({
      nameserver: '10.100.1.1 1.1.1.1',
      searchdomain: 'home.lan',
      'ssh-public-keys': 'ssh-ed25519 AAAA one\nssh-ed25519 BBBB two',
      password: 'secret',
    });
    expect(p.set.features).toBeUndefined();
  });

  it('checks addresses only when static', () => {
    const base = { ...ctDefaults(choices), hostname: 'dns-2' };
    expect(hasErrors(ctErrors({ ...base, ip4: 'nonsense' }))).toBe(false);
    const e = ctErrors({ ...base, ipv4: 'static', ip4: '10.0.0.5', ipv6: 'static', ip6: 'fd00::5' });
    expect(e.ip4).toMatch(/prefix/);
    expect(e.ip6).toMatch(/prefix/);
    expect(ctErrors({ ...base, password: 'abc' }).password).toBe('At least 5 characters.');
  });
});

describe('the create form for Incus', () => {
  it('leaves what is empty to the profiles', () => {
    const f = incusDefaults({
      platform: 'incus',
      storages: [{ id: 'default', type: 'zfs', content: [] }],
      bridges: [],
      profiles: ['default'],
    });
    expect(incusCreateParams({ ...f, name: 'web' })).toEqual({
      platform: 'incus',
      kind: 'container',
      name: 'web',
      image: 'images:debian/13',
      profiles: ['default'],
      start: true,
      set: {},
    });
    const p = incusCreateParams({
      ...f,
      name: 'web',
      cpu: '2',
      memoryMb: '1024',
      rootGb: '20',
      network: 'br0',
    });
    expect(p.set).toEqual({
      'limits.cpu': '2',
      'limits.memory': '1024MiB',
      'device.root': 'type=disk,path=/,pool=default,size=20GiB',
      'device.eth0': 'type=nic,nictype=bridged,parent=br0,name=eth0',
    });
    expect(incusNic('incusbr0')).toBe('type=nic,network=incusbr0,name=eth0');
    expect(incusErrors({ ...f, name: 'a.b' }).name).toBe('Incus names have no dots.');
  });
});

describe('templates', () => {
  it('open as stopped Proxmox guests in the guest dialogs', () => {
    expect(choices.templates?.length).toBeGreaterThan(0);
    expect(templateGuest({ id: '9000', name: 'debian-13-cloud', kind: 'vm' })).toEqual({
      id: 'pve:9000',
      name: 'debian-13-cloud',
      kind: 'vm',
      state: 'stopped',
      platform: 'pve',
      vmid: 9000,
    });
  });
});

describe('storage contents', () => {
  it('lists ISO images, templates and imports only', () => {
    expect(storageContents('iso,vztmpl,backup')).toEqual(['iso', 'vztmpl']);
    expect(hasContents(['images', 'rootdir'])).toBe(false);
    expect(hasContents('backup,import')).toBe(true);
  });

  it('reads the hub’s volumes and older ones', () => {
    const items = contentItems(
      read('pve-02', { op: 'content.list', storage: 'local', content: 'iso' }),
      'iso',
    );
    expect(items.map((i) => i.name)).toEqual([
      'debian-13.1.0-amd64-netinst.iso',
      'ubuntu-24.04.3-live-server-amd64.iso',
      'Win11_24H2_English_x64.iso',
    ]);
    expect(items[2]?.sizeBytes).toBe(5_819_484_160);
    expect(
      contentItems(
        {
          op: 'content.list',
          items: [{ volid: 'local:iso/a.iso', size: 3 }, { volid: 'local:vztmpl/b.tar.zst' }],
        },
        'iso',
      ),
    ).toEqual([{ volume: 'local:iso/a.iso', name: 'a.iso', sizeBytes: 3, created: null }]);
  });

  it('finds appliances by words and section', () => {
    const list = appliances(read('pve-02', { op: 'appliance.list' }));
    expect(list.length).toBeGreaterThan(3);
    expect(filterAppliances(list, 'nextcloud', '').map((a) => a.headline)).toEqual(['TurnKey Nextcloud']);
    expect(filterAppliances(list, '', 'mail')).toHaveLength(1);
  });
});

describe('download from a link', () => {
  it('names the file after the link', () => {
    expect(filenameFromUrl('https://cdimage.debian.org/x/debian-13.1.0-amd64-netinst.iso?mirror=1')).toBe(
      'debian-13.1.0-amd64-netinst.iso',
    );
    expect(filenameFromUrl('https://example.com/My%20Image%20(1).iso')).toBe('My_Image_1_.iso');
    expect(filenameFromUrl('not a link')).toBe('');
  });

  it('checks the link, the name and the checksum', () => {
    expect(downloadUrlError('')).toBe('Paste the link to the file.');
    expect(downloadUrlError('ftp://x/y.iso')).toMatch(/https/);
    expect(downloadUrlError('https://me:pw@x/y.iso')).toMatch(/password/);
    expect(downloadUrlError('https://x/y.iso')).toBeUndefined();
    expect(downloadNameError('a.tar.zst', 'iso')).toBe('The name ends in .iso or .img.');
    expect(downloadNameError('a b.iso', 'iso')).toMatch(/only/);
    expect(downloadNameError('haos.qcow2', 'import')).toBeUndefined();
    expect(checksumError('', '')).toBeUndefined();
    expect(checksumError('abc', 'sha256')).toBe('A SHA256 checksum has 64 characters.');
    expect(checksumError('zz', 'md5')).toMatch(/letters a to f/);
    expect(checksumError('a'.repeat(64), 'sha256')).toBeUndefined();
  });

  it('sends the checksum with its algorithm', () => {
    const d = { storage: 'local', content: 'iso' as const, url: ' https://x/y.iso ', filename: 'y.iso' };
    expect(downloadParams({ ...d, algorithm: '', checksum: 'ab' })).toEqual({
      platform: 'pve',
      storage: 'local',
      content: 'iso',
      url: 'https://x/y.iso',
      filename: 'y.iso',
    });
    expect(downloadParams({ ...d, algorithm: 'sha256', checksum: ' AB ' })).toMatchObject({
      checksum: 'ab',
      checksumAlgorithm: 'sha256',
    });
  });
});
