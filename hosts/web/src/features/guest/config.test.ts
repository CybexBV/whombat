import { describe, expect, it } from 'vitest';
import type { GuestConfig } from '../../api/manage';
import {
  bootOrder,
  checkNumber,
  current,
  decodeSshKeys,
  draftOf,
  encodeSshKeys,
  flagValue,
  formatIpConfig,
  formatSize,
  freeKey,
  keysOf,
  mibText,
  nicModel,
  parseIpConfig,
  parseSize,
  parseTags,
  pendingKeys,
  reviewRows,
  rowValue,
  sshKeyLabel,
  tagError,
  trimDraft,
  withBootOrder,
  withNicModel,
} from './config';
import { incusDraft } from './useConfigChange';

const cfg = (values: Record<string, string>, extra: Partial<GuestConfig> = {}): GuestConfig => ({ platform: 'pve', kind: 'vm', digest: 'd', running: true, values, ...extra });

describe('configuration values', () => {
  const c = cfg({ memory: '16384', cores: '4', scsi0: 'local-zfs:vm-100-disk-0,size=64G', net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0' }, { pending: { memory: '24576', scsi1: 'local-zfs:vm-100-disk-1,size=8G' }, pending_delete: ['net0'] });

  it('starts edits from the pending value and lists what waits for a restart', () => {
    expect(current(c, 'memory')).toBe('24576');
    expect(current(c, 'net0')).toBeUndefined();
    expect(current(c, 'cores')).toBe('4');
    expect(rowValue(c, 'memory')).toEqual({ value: '16384', next: '24576' });
    expect(rowValue(c, 'net0')).toEqual({ value: c.values.net0, next: '', removed: true });
    expect(pendingKeys(c)).toEqual(['memory', 'net0', 'scsi1']);
  });

  it('reviews a change as key: old → new and sends only what differs', () => {
    const d = draftOf({ memory: '32768', cores: '4', balloon: undefined, vcpus: undefined });
    expect(reviewRows(c, d)).toEqual([{ key: 'memory', old: '24576', new: '32768', op: 'set' }]);
    expect(trimDraft(c, d)).toEqual({ set: { memory: '32768' } });
    expect(reviewRows(c, { revert: ['memory', 'net0'] })).toEqual([
      { key: 'memory', old: '24576', new: '16384', op: 'revert' },
      { key: 'net0', old: '', new: c.values.net0, op: 'revert' },
    ]);
    expect(reviewRows(c, { delete: ['scsi0'] })).toEqual([{ key: 'scsi0', old: c.values.scsi0, op: 'delete' }]);
    // A secret is always sent (its value is masked).
    expect(trimDraft(cfg({ cipassword: '**********' }), { set: { cipassword: '**********' } })).toEqual({ set: { cipassword: '**********' } });
  });

  it('writes flags like Proxmox (defaults leave the key out)', () => {
    expect(flagValue(true)).toBe('1');
    expect(flagValue(false)).toBeUndefined();
    expect(flagValue(false, true)).toBe('0');
    expect(flagValue(true, true)).toBeUndefined();
  });

  it('sends removals to Incus as empty values', () => {
    expect(incusDraft({ set: { 'limits.cpu': '2' }, delete: ['limits.memory'] })).toEqual({ set: { 'limits.cpu': '2', 'limits.memory': '' } });
    expect(incusDraft({ set: { a: '1' } })).toEqual({ set: { a: '1' } });
  });
});

describe('sizes and numbers', () => {
  it('reads Proxmox and Incus sizes', () => {
    expect(parseSize('64G')).toBe(64 * 1024 ** 3);
    expect(parseSize('709474K')).toBe(709474 * 1024);
    expect(parseSize('40GiB')).toBe(40 * 1024 ** 3);
    expect(parseSize('1.5T')).toBe(1.5 * 1024 ** 4);
    expect(parseSize('lots')).toBeUndefined();
    expect(formatSize(64 * 1024 ** 3)).toBe('64 GiB');
    expect(formatSize(1.5 * 1024 ** 4)).toBe('1.5 TiB');
    expect(formatSize(4 * 1024 ** 2)).toBe('4 MiB');
    expect(mibText(16384)).toBe('16 GiB');
    expect(mibText(1536)).toBe('1.5 GiB');
    expect(mibText(512)).toBe('512 MiB');
  });

  it('checks number fields', () => {
    expect(checkNumber('8', { min: 1 })).toEqual({ n: 8, error: null });
    expect(checkNumber('', { optional: true })).toEqual({ n: null, error: null });
    expect(checkNumber('').error).toBe('Required.');
    expect(checkNumber('1.5').error).toBe('Enter a whole number.');
    expect(checkNumber('1.5', { decimal: true }).n).toBe(1.5);
    expect(checkNumber('0', { min: 1 }).error).toBe('At least 1.');
    expect(checkNumber('5000', { max: 4094 }).error).toBe('At most 4094.');
  });
});

describe('devices', () => {
  const c = cfg({ scsi0: 'a', scsi1: 'b', net0: 'x', net2: 'y', ide2: 'none,media=cdrom' }, { pending: { scsi2: 'c' } });

  it('finds free slots and lists keys in natural order', () => {
    expect(freeKey(c, 'scsi', 31)).toBe('scsi3');
    expect(freeKey(c, 'net', 32)).toBe('net1');
    expect(freeKey(cfg({ ide0: 'a', ide1: 'b', ide2: 'c', ide3: 'd' }), 'ide', 4)).toBeNull();
    expect(keysOf(cfg({ scsi10: 'a', scsi2: 'b', scsi1: 'c' }), /^scsi\d+$/)).toEqual(['scsi1', 'scsi2', 'scsi10']);
  });

  it('reads and changes a NIC model, keeping the MAC and options', () => {
    expect(nicModel('virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1')).toEqual({ model: 'virtio', mac: 'BC:24:11:00:00:01' });
    expect(nicModel('e1000,bridge=vmbr0')).toEqual({ model: 'e1000', mac: '' });
    expect(withNicModel('virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1', 'e1000e')).toBe('e1000e=BC:24:11:00:00:01,bridge=vmbr0,firewall=1');
    expect(withNicModel('e1000,bridge=vmbr0', 'virtio')).toBe('virtio,bridge=vmbr0');
  });

  it('reads and writes the boot order', () => {
    expect(bootOrder('order=scsi0;ide2;net0')).toEqual(['scsi0', 'ide2', 'net0']);
    expect(bootOrder('cdn')).toEqual([]);
    expect(withBootOrder('order=scsi0;ide2;net0', ['net0', 'scsi0'])).toBe('order=net0;scsi0');
    expect(withBootOrder('cdn', ['scsi0'])).toBe('order=scsi0');
    expect(withBootOrder(undefined, ['scsi0'])).toBe('order=scsi0');
  });
});

describe('tags and cloud-init', () => {
  it('parses tags and checks Proxmox’s rule', () => {
    expect(parseTags('k3s;prod')).toEqual(['k3s', 'prod']);
    expect(parseTags('a,b c')).toEqual(['a', 'b', 'c']);
    expect(parseTags(undefined)).toEqual([]);
    expect(tagError('web-1.prod+x')).toBeNull();
    expect(tagError('_ok')).toBeNull();
    expect(tagError('-bad')).not.toBeNull();
    expect(tagError('bad!')).not.toBeNull();
  });

  it('encodes SSH keys like Proxmox (%20 for spaces, %0A for newlines)', () => {
    const text = 'ssh-ed25519 AAAA+/= admin@lab\nssh-rsa BBBB ops (team)';
    const enc = encodeSshKeys(text);
    expect(enc).toBe('ssh-ed25519%20AAAA%2B%2F%3D%20admin%40lab%0Assh-rsa%20BBBB%20ops%20%28team%29');
    expect(decodeSshKeys(enc)).toBe(text);
    expect(decodeSshKeys('bad%zz')).toBe('bad%zz');
    expect(sshKeyLabel('ssh-ed25519 AAAA admin@lab')).toBe('ssh-ed25519 admin@lab');
    expect(sshKeyLabel('ssh-rsa AAAA')).toBe('ssh-rsa');
  });

  it('reads and writes IP configs, keeping unknown items', () => {
    expect(parseIpConfig('ip=10.0.0.5/24,gw=10.0.0.1,ip6=auto')).toEqual({ v4: 'static', ip: '10.0.0.5/24', gw: '10.0.0.1', v6: 'auto', ip6: '', gw6: '' });
    expect(parseIpConfig(undefined)).toMatchObject({ v4: 'none', v6: 'none' });
    expect(formatIpConfig({ v4: 'dhcp', ip: '', gw: '', v6: 'none', ip6: '', gw6: '' }, 'ip=10.0.0.5/24,gw=10.0.0.1,x=1')).toBe('ip=dhcp,x=1');
    // A container NIC keeps its other options.
    expect(formatIpConfig({ v4: 'static', ip: '10.0.0.9/24', gw: '10.0.0.1', v6: 'static', ip6: 'fd00::9/64', gw6: '' }, 'name=eth0,bridge=vmbr0,ip=dhcp,type=veth')).toBe(
      'name=eth0,bridge=vmbr0,ip=10.0.0.9/24,type=veth,gw=10.0.0.1,ip6=fd00::9/64',
    );
  });
});
