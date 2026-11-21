import { HostGuestConfig } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createHostsFixtures } from './fixtures';

const { handle } = createHostsFixtures(Date.parse('2026-10-17T12:00:00Z'));
const bodyOf = <T>(a: { body: unknown } | null) => (a ? a.body : {}) as T;
const config = (guestId: string) =>
  bodyOf<{ config: HostGuestConfig }>(
    handle({ method: 'GET', path: '/servers/pve-02/manage', query: { op: 'config.get', guestId }, body: {} }),
  ).config;
const manage = (guestId: string, body: Record<string, unknown>) =>
  handle({ method: 'POST', path: '/servers/pve-02/manage', query: {}, body: { guestId, ...body } });

describe('the guest editing fixtures', () => {
  it('answer valid configurations with EFI, TPM, unused disks, mount points, locks and HA', () => {
    for (const id of ['pve:118', 'pve:123', 'pve:124', 'pve:132', 'pve:134', 'pve:144'])
      expect(HostGuestConfig.safeParse(config(id)).error).toBeUndefined();
    expect(config('pve:123').values.tpmstate0).toContain('version=v2.0');
    expect(config('pve:118').ha?.state).toBe('started');
    expect(config('pve:132').restricted).toEqual(['arch', 'mp1', 'ostype', 'unprivileged']);
  });

  it('detach a disk to an unused one, attach it again, and delete it only when confirmed', () => {
    const c = config('pve:124');
    expect(
      manage('pve:124', { op: 'config.set', digest: c.digest, params: { delete: ['scsi0'] } })?.status,
    ).toBe(200);
    const d = config('pve:124');
    expect(d.values.scsi0).toBeUndefined();
    expect(d.values.unused2).toBe('local-zfs:vm-124-disk-0');
    manage('pve:124', {
      op: 'config.set',
      digest: d.digest,
      params: { set: { scsi0: 'local-zfs:vm-124-disk-0' } },
    });
    expect(config('pve:124').values.unused2).toBeUndefined();
    const e = config('pve:124');
    expect(
      manage('pve:124', { op: 'config.set', digest: e.digest, params: { delete: ['unused0'] } })?.status,
    ).toBe(400);
    manage('pve:124', { op: 'config.set', digest: e.digest, params: { delete: ['unused0'] }, confirm: true });
    expect(config('pve:124').values.unused0).toBeUndefined();
  });

  it('name new volumes, refuse locked keys and unknown networks, and keep a running guest’s removals for later', () => {
    const c = config('pve:118');
    manage('pve:118', {
      op: 'config.set',
      digest: c.digest,
      params: { set: { scsi2: 'local-zfs:32,iothread=1' } },
    });
    expect(config('pve:118').values.scsi2).toBe('local-zfs:vm-118-disk-4,iothread=1,size=32G');
    const d = config('pve:118');
    expect(
      manage('pve:118', { op: 'config.set', digest: d.digest, params: { delete: ['hostpci0'] } })?.status,
    ).toBe(403);
    const bad = manage('pve:118', {
      op: 'config.set',
      digest: d.digest,
      params: { set: { net1: 'virtio,bridge=vmbr9' } },
    });
    expect(bodyOf<{ error: { fields: Record<string, string[]> } }>(bad).error.fields.net1).toEqual([
      'vmbr9 isn’t a network on this server.',
    ]);
    manage('pve:118', { op: 'config.set', digest: d.digest, params: { delete: ['vga'] } });
    expect(config('pve:118').pendingDelete).toEqual(['vga']);
  });

  it('change high availability and refuse moving a running container’s disk', () => {
    manage('pve:132', { op: 'ha.set', params: { state: 'stopped', maxRestart: 1, maxRelocate: 0 } });
    expect(config('pve:132').ha).toMatchObject({ state: 'stopped', maxRelocate: 0 });
    manage('pve:132', { op: 'ha.remove', params: {} });
    expect(config('pve:132').ha).toBeNull();
    expect(manage('pve:132', { op: 'disk.move', params: { disk: 'mp0', storage: 'local' } })?.status).toBe(
      409,
    );
  });
});
