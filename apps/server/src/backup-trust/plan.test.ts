import { CHANGE_WINDOW_DEFAULT, RESTORE_TEST_TAG } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  bootVerdict,
  CLAIM_WINDOW_MS,
  carriesMarker,
  copyMarker,
  copyOwnsDisks,
  copyProblem,
  copySettings,
  copyTags,
  eligibleGuests,
  freeCopyId,
  linkDown,
  markedTestId,
  networkDown,
  nextGuest,
  nextTestAt,
  restoreProves,
  storageFor,
  storagesOf,
  testDue,
  usesHostParts,
} from './plan';

const TZ = 'Europe/Amsterdam';
const GIB = 1024 ** 3;

describe('eligibleGuests', () => {
  it('keeps Proxmox VMs and containers, never templates, copies, temporary machines or this Whombat', () => {
    const got = eligibleGuests([
      {
        id: 'pve:101',
        name: 'plex',
        platform: 'pve',
        kind: 'vm',
        guest_agent: 'running',
        last_backup: { at: '2026-11-27T02:00:00Z' },
      },
      { id: 'pve:102', name: 'pihole', platform: 'pve', kind: 'container' },
      { id: 'pve:900', name: 'debian-tpl', platform: 'pve', kind: 'vm', template: true },
      { id: 'pve:990001', name: 'whombat-test-of-plex', platform: 'pve', kind: 'vm' },
      { id: 'pve:120', name: 'ci-job-a8791974', platform: 'pve', kind: 'vm' },
      { id: 'pve:130', name: 'whombat', platform: 'pve', kind: 'vm', self: true },
      { id: 'docker:web', name: 'web', platform: 'docker', kind: 'container' },
    ]);
    expect(got.map((g) => g.id)).toEqual(['pve:102', 'pve:101']);
    expect(got.find((g) => g.id === 'pve:101')).toMatchObject({
      agent: true,
      lastBackupAt: '2026-11-27T02:00:00Z',
    });
  });
});

describe('nextGuest', () => {
  const c = (id: string, backup = true) => ({
    id,
    name: id,
    kind: 'vm' as const,
    lastBackupAt: backup ? '2026-11-27T02:00:00Z' : null,
    agent: false,
  });
  it('takes a machine never tested first, then the one tested longest ago, and one with a backup before one without', () => {
    const tested = new Map([
      ['a', new Date('2026-11-20T03:00:00Z')],
      ['b', new Date('2026-11-13T03:00:00Z')],
    ]);
    expect(nextGuest([c('a'), c('b'), c('c')], tested)?.id).toBe('c');
    expect(nextGuest([c('a'), c('b')], tested)?.id).toBe('b');
    expect(nextGuest([c('z', false), c('a')], tested)?.id).toBe('a');
    expect(nextGuest([], tested)).toBeNull();
  });
});

describe('when a test runs', () => {
  // 03:10 in Amsterdam (winter: UTC+1).
  const inWindow = new Date('2026-11-29T02:10:00Z');
  it('starts inside the quiet hours with time left, a week after the last one', () => {
    expect(testDue(inWindow, CHANGE_WINDOW_DEFAULT, TZ, null)).toBe(true);
    expect(testDue(inWindow, CHANGE_WINDOW_DEFAULT, TZ, new Date('2026-11-26T02:10:00Z'))).toBe(false);
    expect(testDue(inWindow, CHANGE_WINDOW_DEFAULT, TZ, new Date('2026-11-22T02:30:00Z'))).toBe(true);
    // 04:40: less than half an hour left.
    expect(testDue(new Date('2026-11-29T03:40:00Z'), CHANGE_WINDOW_DEFAULT, TZ, null)).toBe(false);
    // Midday.
    expect(testDue(new Date('2026-11-29T11:00:00Z'), CHANGE_WINDOW_DEFAULT, TZ, null)).toBe(false);
  });
  it('says when the next one starts', () => {
    const noon = new Date('2026-11-28T11:00:00Z');
    expect(nextTestAt(noon, CHANGE_WINDOW_DEFAULT, TZ, null)?.toISOString()).toBe('2026-11-29T02:00:00.000Z');
    expect(nextTestAt(inWindow, CHANGE_WINDOW_DEFAULT, TZ, null)?.toISOString()).toBe(inWindow.toISOString());
    expect(nextTestAt(noon, CHANGE_WINDOW_DEFAULT, TZ, new Date('2026-11-28T02:05:00Z'))?.toISOString()).toBe(
      '2026-12-04T02:05:00.000Z',
    );
  });
});

describe('the copy', () => {
  it('takes the first free number in its range', () => {
    expect(freeCopyId([101, 990000, 990001])).toBe(990002);
    expect(freeCopyId([101], 990004)).toBe(990005);
  });

  it('marks, pulls every network cable, names and keeps the copy from starting at boot', () => {
    const marker = copyMarker('rst_0a1b2c');
    const set = copySettings(
      'vm',
      {
        name: 'plex',
        description: 'Media server',
        net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0',
        net1: 'virtio=BC:24:11:00:00:02,bridge=vmbr1,link_down=0',
        onboot: '1',
        tags: 'media',
        scsi0: 'local-lvm:vm-990001-disk-0,size=32G',
      },
      'whombat-test-of-plex',
      marker,
    );
    expect(set.net0).toContain('link_down=1');
    expect(set.net1).not.toContain('link_down=0');
    expect(set).toMatchObject({ name: 'whombat-test-of-plex', onboot: '0', description: marker });
    expect(set.scsi0).toBeUndefined();
    expect(set.tags).toBeUndefined();
    expect(copyTags({ tags: 'media' })).toBe(`media;${RESTORE_TEST_TAG}`);
    expect(copyTags({ tags: `media;${RESTORE_TEST_TAG}` })).toBeNull();
    expect(
      copySettings('container', { hostname: 'pihole', net0: 'name=eth0,bridge=vmbr0' }, 'x', marker).hostname,
    ).toBe('x');
    expect(copySettings('vm', { name: 'x', description: marker }, 'x', marker)).toEqual({});
    expect(networkDown({ net0: linkDown('name=eth0,bridge=vmbr0'), memory: '512' })).toBe(true);
    expect(networkDown({ net0: 'name=eth0,bridge=vmbr0' })).toBe(false);
  });

  it('refuses machines that use parts of the server itself', () => {
    expect(usesHostParts({ values: { hostpci0: '0000:01:00.0' } })).toBe(true);
    expect(usesHostParts({ values: { args: '-device vfio-pci,host=01:00.0' } })).toBe(true);
    expect(usesHostParts({ values: { hookscript: 'local:snippets/hook.pl' } })).toBe(true);
    expect(usesHostParts({ values: { usb0: 'host=1234:5678' } })).toBe(true);
    expect(usesHostParts({ values: { mp0: '/srv/media,mp=/media' } })).toBe(true);
    expect(usesHostParts({ values: { ide2: 'cdrom,media=cdrom' } })).toBe(true);
    expect(usesHostParts({ values: {}, restricted: ['lxc.cgroup2.devices.allow'] })).toBe(true);
    expect(
      usesHostParts({
        values: {
          scsi0: 'local-lvm:vm-101-disk-0',
          ide2: 'local:iso/debian.iso,media=cdrom',
          serial0: 'socket',
        },
      }),
    ).toBe(false);
  });

  it('starts only when every disk is its own', () => {
    expect(
      copyOwnsDisks(
        {
          scsi0: 'local-lvm:vm-990001-disk-0,size=32G',
          efidisk0: 'local-lvm:vm-990001-disk-1',
          ide2: 'local:iso/debian.iso,media=cdrom',
          ide0: 'none,media=cdrom',
        },
        990001,
      ),
    ).toBe(true);
    expect(copyOwnsDisks({ rootfs: 'local-zfs:subvol-990001-disk-0,size=8G' }, 990001)).toBe(true);
    expect(copyOwnsDisks({ mp0: 'local-zfs:subvol-101-disk-1,mp=/data' }, 990001)).toBe(false);
    expect(copyOwnsDisks({ scsi1: 'local-lvm:vm-101-disk-1' }, 990001)).toBe(false);
  });

  it('is only ever the copy of the test whose marker it carries', () => {
    const marker = copyMarker('rst_0a1b2c');
    expect(carriesMarker({ description: marker }, 'rst_0a1b2c')).toBe(true);
    expect(carriesMarker({ description: `notes\n${marker}` }, 'rst_0a1b2c')).toBe(true);
    expect(carriesMarker({ description: marker }, 'rst_ffffff')).toBe(false);
    expect(carriesMarker({ description: `${marker}x` }, 'rst_0a1b2c')).toBe(false);
    expect(carriesMarker({ name: 'whombat-test-of-plex', tags: RESTORE_TEST_TAG }, 'rst_0a1b2c')).toBe(false);
    expect(markedTestId({ description: marker })).toBe('rst_0a1b2c');
    expect(markedTestId({ name: 'whombat-test-of-plex', tags: RESTORE_TEST_TAG })).toBeNull();
  });

  it('checks the copy’s own settings before it starts', () => {
    const marker = copyMarker('rst_0a1b2c');
    const ready = {
      description: marker,
      net0: 'virtio=BC:24:11:00:00:09,bridge=vmbr0,link_down=1',
      scsi0: 'local-lvm:vm-990001-disk-0',
    };
    expect(copyProblem({ values: ready }, 990001, 'rst_0a1b2c')).toBeNull();
    // A person's machine at the number.
    expect(copyProblem({ values: { ...ready, description: '' } }, 990001, 'rst_0a1b2c')).toBe('not_ours');
    // The backup still has a hook script, a raw argument or a passed-through device, though the machine doesn't today.
    expect(
      copyProblem({ values: { ...ready, hookscript: 'local:snippets/hook.pl' } }, 990001, 'rst_0a1b2c'),
    ).toBe('host_parts');
    expect(
      copyProblem({ values: ready, restricted: ['args'], pending: { args: '-x' } }, 990001, 'rst_0a1b2c'),
    ).toBe('host_parts');
    expect(copyProblem({ values: ready, pending: { usb0: 'host=1-2' } }, 990001, 'rst_0a1b2c')).toBe(
      'host_parts',
    );
    expect(
      copyProblem({ values: { ...ready, scsi1: 'local-lvm:vm-101-disk-1' } }, 990001, 'rst_0a1b2c'),
    ).toBe('host_parts');
    expect(
      copyProblem(
        { values: { ...ready, net0: 'virtio=BC:24:11:00:00:09,bridge=vmbr0' } },
        990001,
        'rst_0a1b2c',
      ),
    ).toBe('network_kept');
    expect(
      copyProblem({ values: ready, pending: { net1: 'virtio,bridge=vmbr1' } }, 990001, 'rst_0a1b2c'),
    ).toBe('network_kept');
  });

  it('takes the copy only on the proof of the test’s own restore, moments after it finished', () => {
    const began = new Date('2026-11-29T02:00:00Z');
    const after = (min: number) => new Date(began.getTime() + min * 60_000);
    // The server's clock is a day behind: only the restore's length counts.
    const task = {
      type: 'qmrestore',
      guestId: 'pve:990001',
      status: 'ok',
      started: '2026-11-28T02:01:00Z',
      ended: '2026-11-28T02:09:00Z',
    };
    expect(restoreProves(task, 990001, began, after(10))).toBe('yes');
    expect(restoreProves({ ...task, guestId: '990001' }, 990001, began, after(10))).toBe('yes');
    expect(restoreProves({ ...task, status: 'warning' }, 990001, began, after(10))).toBe('yes');
    expect(restoreProves(task, 990001, began, after(8 + CLAIM_WINDOW_MS / 60_000 + 1))).toBe('no');
    expect(restoreProves({ ...task, status: 'running', ended: null }, 990001, began, after(10))).toBe(
      'running',
    );
    // Refused or failed (“already exists”), another number, or not a restore: no proof.
    expect(restoreProves({ ...task, status: 'error' }, 990001, began, after(10))).toBe('no');
    expect(restoreProves(task, 990002, began, after(10))).toBe('no');
    expect(restoreProves({ ...task, type: 'qmstart' }, 990001, began, after(10))).toBe('no');
    expect(restoreProves({ ...task, guestId: null }, 990001, began, after(10))).toBe('no');
    expect(restoreProves({ ...task, ended: null }, 990001, began, after(10))).toBe('no');
  });

  it('goes where there is room, the machine’s own storage first', () => {
    const storages = [
      { id: 'local', content: ['iso', 'backup'], availBytes: 500 * GIB, totalBytes: 600 * GIB },
      { id: 'local-lvm', content: ['images', 'rootdir'], availBytes: 60 * GIB, totalBytes: 120 * GIB },
      { id: 'tank', content: ['images'], availBytes: 900 * GIB, totalBytes: 1000 * GIB },
    ];
    expect(storageFor('vm', storages, ['local-lvm'], 32 * GIB)).toBe('local-lvm');
    expect(storageFor('vm', storages, ['local-lvm'], 64 * GIB)).toBe('tank');
    expect(storageFor('container', storages, [], 64 * GIB)).toBeNull();
    // Over nine tenths full after the copy.
    expect(storageFor('vm', storages, ['tank'], 850 * GIB)).toBeNull();
    expect(
      storagesOf({ scsi0: 'local-lvm:vm-101-disk-0', ide2: 'local:iso/x.iso,media=cdrom', net0: 'x' }),
    ).toEqual(['local-lvm']);
  });
});

describe('bootVerdict', () => {
  const askedAt = new Date('2026-11-29T02:20:00Z');
  const at = (min: number) => new Date(askedAt.getTime() + min * 60_000);
  const base = { kind: 'vm' as const, agentExpected: true, guestAgent: false, askedAt };

  it('waits for the guest agent inside the copy when the real machine has one', () => {
    expect(bootVerdict({ ...base, state: 'running', runningAt: at(1), now: at(3) }).verdict).toBe('wait');
    expect(
      bootVerdict({ ...base, state: 'running', guestAgent: true, runningAt: at(1), now: at(3) }),
    ).toEqual({
      verdict: 'worked',
      booted: true,
    });
    expect(bootVerdict({ ...base, state: 'running', runningAt: at(1), now: at(12) })).toEqual({
      verdict: 'failed',
      reason: 'no_boot',
    });
  });

  it('counts a copy without a guest agent as started once it keeps running', () => {
    const plain = { ...base, agentExpected: false };
    expect(bootVerdict({ ...plain, state: 'running', runningAt: at(1), now: at(2) }).verdict).toBe('wait');
    expect(bootVerdict({ ...plain, state: 'running', runningAt: at(1), now: at(4) })).toEqual({
      verdict: 'worked',
      booted: false,
    });
  });

  it('fails a copy that stops by itself or never starts', () => {
    expect(bootVerdict({ ...base, state: 'stopped', runningAt: at(1), now: at(2) })).toEqual({
      verdict: 'failed',
      reason: 'stopped_by_itself',
    });
    expect(bootVerdict({ ...base, state: 'stopped', runningAt: null, now: at(2) }).verdict).toBe('wait');
    expect(bootVerdict({ ...base, state: 'stopped', runningAt: null, now: at(6) })).toEqual({
      verdict: 'failed',
      reason: 'start_failed',
    });
  });
});
