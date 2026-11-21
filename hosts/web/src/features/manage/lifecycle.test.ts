import { describe, expect, it } from 'vitest';
import type { Choices } from '../../api/manage';
import { taskSeconds, taskTypeLabel } from '../guest/taskLabels';
import { bulkAction, bulkPlan, runLimited } from './bulk';
import { ctDefaults, ctInput, incusDefaults, incusInput, nameError, validateCt, validateVm, vmDefaults, vmInput, withOsType } from './createForm';
import { checksumError, filenameError, filenameFromUrl, urlError } from './download';

const choices: Choices = {
  platform: 'pve',
  next_id: 108,
  storages: [
    { id: 'local', type: 'dir', content: ['iso', 'vztmpl', 'backup'] },
    { id: 'local-zfs', type: 'zfspool', content: ['images', 'rootdir'] },
  ],
  bridges: ['vmbr0', 'vmbr1'],
  isos: [{ volume: 'local:iso/debian-13.iso', storage: 'local', content: 'iso', name: 'debian-13.iso' }],
  ct_templates: [{ volume: 'local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst', storage: 'local', content: 'vztmpl', name: 'debian-13-standard_13.1-1_amd64.tar.zst' }],
  cpu_types: ['host', 'x86-64-v2-AES'],
};

describe('create form', () => {
  it('maps a VM form with the wizard defaults to CreateGuestInput', () => {
    const f = { ...vmDefaults(choices), name: 'web-03' };
    expect(validateVm(f)).toEqual(Object.fromEntries(Object.keys(validateVm(f)).map((k) => [k, undefined])));
    expect(vmInput(f)).toEqual({
      platform: 'pve',
      kind: 'vm',
      new_id: 108,
      name: 'web-03',
      start: false,
      set: {
        ostype: 'l26',
        scsihw: 'virtio-scsi-single',
        scsi0: 'local-zfs:32,iothread=1',
        ide2: 'local:iso/debian-13.iso,media=cdrom',
        boot: 'order=scsi0;ide2;net0',
        cores: '2',
        sockets: '1',
        cpu: 'x86-64-v2-AES',
        memory: '2048',
        net0: 'virtio,bridge=vmbr0,firewall=1',
        agent: '1',
        machine: 'q35',
      },
    });
  });

  it('adds the EFI disk and TPM for UEFI Windows guests, VLAN and no media', () => {
    const f = { ...withOsType(vmDefaults(choices), 'win11'), name: 'win', iso: '', vlan: '20', firewall: false, machine: 'i440fx' as const, vmid: '' };
    const set = vmInput(f).set;
    expect(set).toMatchObject({ ostype: 'win11', bios: 'ovmf', efidisk0: 'local-zfs:1,efitype=4m,pre-enrolled-keys=1', tpmstate0: 'local-zfs:1,version=v2.0', ide2: 'none,media=cdrom', net0: 'virtio,bridge=vmbr0,tag=20' });
    expect(set.machine).toBeUndefined();
    expect(vmInput(f).new_id).toBeUndefined();
    expect(validateVm({ ...f, vlan: '5000', cores: '0' })).toMatchObject({ vlan: expect.any(String), cores: expect.any(String) });
  });

  it('maps a container form: unprivileged, nesting, DHCP or static addresses, secrets only when given', () => {
    const f = { ...ctDefaults(choices), hostname: 'dns-2' };
    expect(ctInput(f)).toEqual({
      platform: 'pve',
      kind: 'container',
      new_id: 108,
      name: 'dns-2',
      start: false,
      set: {
        ostemplate: 'local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst',
        rootfs: 'local-zfs:8',
        cores: '1',
        memory: '512',
        swap: '512',
        net0: 'name=eth0,bridge=vmbr0,firewall=1,ip=dhcp',
        unprivileged: '1',
        features: 'nesting=1',
      },
    });
    const s = { ...f, ipv4: 'static' as const, ip4: '10.0.0.5/24', gw4: '10.0.0.1', ipv6: 'auto' as const, password: 'secret1', sshKeys: 'ssh-ed25519 AAA x\n', nesting: false, vlan: '7' };
    const set = ctInput(s).set;
    expect(set.net0).toBe('name=eth0,bridge=vmbr0,tag=7,firewall=1,ip=10.0.0.5/24,gw=10.0.0.1,ip6=auto');
    expect(set).toMatchObject({ password: 'secret1', 'ssh-public-keys': 'ssh-ed25519 AAA x' });
    expect(set.features).toBeUndefined();
    expect(validateCt({ ...s, ip4: '10.0.0.5', password: 'abc' })).toMatchObject({ ip4: expect.any(String), password: expect.any(String) });
  });

  it('maps an Incus form', () => {
    const c: Choices = { platform: 'incus', storages: [{ id: 'default', type: 'zfs', content: ['images'] }], bridges: ['incusbr0', 'br-lan'], profiles: ['default', 'gpu'], images: [{ fingerprint: 'abc', aliases: ['debian/13'], type: 'container' }] };
    const f = incusDefaults(c);
    expect(incusInput({ ...f, name: 'web' })).toEqual({ platform: 'incus', kind: 'container', name: 'web', image: 'debian/13', profiles: ['default'], set: {}, start: true });
    const full = incusInput({ ...f, name: 'vm1', type: 'vm', image: 'images:nixos/26.05', cpu: '4', memoryMb: '4096', rootGb: '40', network: 'br-lan' });
    expect(full).toMatchObject({ kind: 'vm', image: 'images:nixos/26.05' });
    expect(full.set).toEqual({ 'limits.cpu': '4', 'limits.memory': '4096MiB', 'device.root': 'type=disk,path=/,pool=default,size=40GiB', 'device.eth0': 'type=nic,nictype=bridged,parent=br-lan,name=eth0' });
    expect(incusInput({ ...f, name: 'x', network: 'incusbr0' }).set['device.eth0']).toBe('type=nic,network=incusbr0,name=eth0');
  });

  it('checks names', () => {
    expect(nameError('web-01')).toBeUndefined();
    expect(nameError('web.lab.example')).toBeUndefined();
    expect(nameError('')).toBeTruthy();
    expect(nameError('-web')).toBeTruthy();
    expect(nameError('web_01')).toBeTruthy();
  });
});

describe('download from URL', () => {
  it('fills the file name from the URL path', () => {
    expect(filenameFromUrl('https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-13.1.0-amd64-netinst.iso')).toBe('debian-13.1.0-amd64-netinst.iso');
    expect(filenameFromUrl('https://example.com/dl/Alpine%20Linux%203.22.iso?mirror=1#x')).toBe('Alpine_Linux_3.22.iso');
    expect(filenameFromUrl('https://example.com/')).toBe('');
    expect(filenameFromUrl('not a url')).toBe('');
  });

  it('checks URL, name and checksum', () => {
    expect(urlError('https://example.com/a.iso')).toBeUndefined();
    expect(urlError('ftp://example.com/a.iso')).toBeTruthy();
    expect(urlError('https://user:pw@example.com/a.iso')).toBeTruthy();
    expect(filenameError('a.iso', 'iso')).toBeUndefined();
    expect(filenameError('a.qcow2', 'iso')).toBeTruthy();
    expect(filenameError('debian.tar.zst', 'vztmpl')).toBeUndefined();
    expect(filenameError('a b.iso', 'iso')).toBeTruthy();
    expect(checksumError('', 'sha256')).toBeUndefined();
    expect(checksumError('ab'.repeat(32), 'sha256')).toBeUndefined();
    expect(checksumError('ab'.repeat(20), 'sha256')).toBeTruthy();
    expect(checksumError('zz'.repeat(32), 'sha256')).toBeTruthy();
  });
});

describe('bulk actions', () => {
  const vm = (state: 'running' | 'stopped' | 'paused') => ({ platform: 'pve' as const, kind: 'vm' as const, state });
  const ct = (state: 'running' | 'stopped' | 'paused') => ({ platform: 'incus' as const, kind: 'container' as const, state });

  it('maps each command to the row menu action of the guest', () => {
    expect(bulkAction('start', vm('stopped'))).toBe('start');
    expect(bulkAction('start', vm('running'))).toBeNull();
    expect(bulkAction('shutdown', vm('running'))).toBe('shutdown');
    expect(bulkAction('shutdown', ct('running'))).toBe('stop');
    expect(bulkAction('shutdown', vm('paused'))).toBeNull();
    expect(bulkAction('reboot', vm('running'))).toBe('reboot');
    expect(bulkAction('reboot', ct('running'))).toBe('restart');
    expect(bulkAction('reboot', vm('stopped'))).toBeNull();
    expect(bulkAction('stop', vm('running'))).toBe('force_stop');
    expect(bulkAction('stop', vm('paused'))).toBe('force_stop');
    expect(bulkAction('stop', ct('paused'))).toBe('stop');
    expect(bulkAction('stop', ct('stopped'))).toBeNull();
  });

  it('skips guests without the power permission or a matching state', () => {
    const g = (id: string, state: 'running' | 'stopped', power = true) => ({ server: 's', guest: { id, name: id, ...vm(state) }, power });
    const plan = bulkPlan('start', [g('a', 'stopped'), g('b', 'running'), g('c', 'stopped', false)]);
    expect(plan.run.map((r) => r.item.guest.id)).toEqual(['a']);
    expect(plan.skipped.map((s) => s.guest.id)).toEqual(['b', 'c']);
  });

  it('runs at most three at a time', async () => {
    let live = 0;
    let peak = 0;
    const done: number[] = [];
    await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      done.push(n);
      live--;
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('tasks', () => {
  it('names common task types and keeps unknown ones', () => {
    expect(taskTypeLabel('vzdump')).toBe('Back up');
    expect(taskTypeLabel('qmclone')).toBe('Clone');
    expect(taskTypeLabel('vzcreate')).toBe('Create');
    expect(taskTypeLabel('qmdestroy')).toBe('Delete');
    expect(taskTypeLabel('download')).toBe('Download');
    expect(taskTypeLabel('aptupdate')).toBe('Update package lists');
    expect(taskTypeLabel('hamigrate')).toBe('hamigrate');
  });

  it('measures durations, running ones up to now', () => {
    expect(taskSeconds('2026-10-11T14:00:00Z', '2026-10-11T14:01:30Z', 0)).toBe(90);
    expect(taskSeconds('2026-10-11T14:00:00Z', null, Date.parse('2026-10-11T14:00:20Z'))).toBe(20);
    expect(taskSeconds('bad', null, 0)).toBe(0);
  });
});
