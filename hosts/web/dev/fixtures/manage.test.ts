import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuestConfig, ManageResult, TaskStatus } from '../../src/api/manage-types';
import { FixtureStore } from './state';
import { browser } from './testkit';

afterEach(() => vi.useRealTimers());

describe('manage fixtures', () => {
  it('reads and changes a configuration with digests and pending values', () => {
    const b = browser(new FixtureStore());
    const cfg = () => b.call('GET', '/servers/shale/guests/pve%3A100/config').json as GuestConfig;
    const c1 = cfg();
    expect(c1.values.memory).toBe('16384');
    expect(c1.running).toBe(true);
    const r = b.call('PUT', '/servers/shale/guests/pve%3A100/config', { digest: c1.digest, set: { memory: '24576', tags: 'k3s;prod;big' } });
    expect(r.status).toBe(200);
    expect((r.json as ManageResult).changes).toEqual([
      { key: 'memory', old: '16384', new: '24576', pending: true },
      { key: 'tags', old: 'k3s;prod', new: 'k3s;prod;big' },
    ]);
    const c2 = cfg();
    expect(c2.pending).toEqual({ memory: '24576' });
    expect(c2.values.tags).toBe('k3s;prod;big');
    expect(b.call('PUT', '/servers/shale/guests/pve%3A100/config', { digest: c1.digest, set: { name: 'x' } }).json).toMatchObject({ status: 409, code: 'digest_mismatch' });
    expect(b.call('PUT', '/servers/shale/guests/pve%3A101/config', { set: { hostpci0: '0000:02:00.0' } }).json).toMatchObject({ status: 403, code: 'not_allowed' });
    expect(cfg().restricted).toEqual(['smbios1', 'vmgenid']);
  });

  it('resizes a disk through a task whose log grows', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-17T10:00:00Z') });
    const b = browser(new FixtureStore());
    const r = b.call('POST', '/servers/shale/guests/pve%3A100/disks/scsi0/resize', { size: '+16G' });
    expect(r.status).toBe(202);
    const id = (r.json as ManageResult).task!.id;
    expect(id).toMatch(/^UPID:shale:.*:qmresize:100:/);
    const status = () => b.call('GET', `/servers/shale/tasks/${encodeURIComponent(id)}?log_start=0`).json as TaskStatus;
    expect(status().status).toBe('running');
    vi.advanceTimersByTime(3000);
    expect(status()).toMatchObject({ status: 'ok', message: 'OK' });
    expect((b.call('GET', '/servers/shale/guests/pve%3A100/config').json as GuestConfig).values.scsi0).toContain('size=80G');
  });

  it('names the fields Proxmox refuses, allocates new disks and masks passwords', () => {
    const b = browser(new FixtureStore());
    const put = (guest: string, body: object) => b.call('PUT', `/servers/shale/guests/${encodeURIComponent(guest)}/config`, body);
    expect(put('pve:107', { set: { name: 'not a name' } }).json).toMatchObject({ status: 400, code: 'invalid_value', field_errors: { name: expect.stringContaining('DNS name') } });
    // Stopped VM: a new volume gets a name and its size; attaching an unused disk takes it off the list.
    expect(put('pve:107', { set: { scsi1: 'local-zfs:32,iothread=1' } }).status).toBe(200);
    const cfg = () => b.call('GET', '/servers/shale/guests/pve%3A103/config').json as GuestConfig;
    expect(put('pve:103', { set: { scsi2: 'vmdata:vm-103-disk-2' } }).status).toBe(200);
    expect(cfg().values.unused0).toBeUndefined();
    const vm107 = b.call('GET', '/servers/shale/guests/pve%3A107/config').json as GuestConfig;
    expect(vm107.values.scsi1).toBe('local-zfs:vm-107-disk-3,iothread=1,size=32G');
    expect(put('pve:102', { set: { cipassword: 'hunter2hunter2' } }).json).toMatchObject({ changes: [{ key: 'cipassword', new: '**********' }] });
    expect((b.call('GET', '/servers/shale/guests/pve%3A102/config').json as GuestConfig).values.cipassword).toBe('**********');
    // Incus: a key set on the instance no longer comes from the profile.
    expect(b.call('PUT', '/servers/basalt/guests/incus%3Aci-runner/config', { set: { 'device.eth0': 'type=nic,network=br-lan,name=eth0' } }).status).toBe(200);
    expect((b.call('GET', '/servers/basalt/guests/incus%3Aci-runner/config').json as GuestConfig).inherited).toEqual([]);
  });

  it('needs the Manage switch', () => {
    const b = browser(new FixtureStore());
    b.call('PATCH', '/servers/shale', { remote_control: { manage: false } });
    expect(b.call('GET', '/servers/shale/guests/pve%3A100/config').json).toMatchObject({ status: 403, code: 'manage_disabled' });
    expect(b.call('GET', '/servers/granite/manage/choices').json).toMatchObject({ status: 403 });
  });
});
