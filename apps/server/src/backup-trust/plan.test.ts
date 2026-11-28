import { CHANGE_WINDOW_DEFAULT, RESTORE_TEST_TAG } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  agentEnabled,
  agentExpectedOf,
  agentMayAnswer,
  BOOT_WAIT_MS,
  backupNeeds,
  bootVerdict,
  carriesMarker,
  copyMarker,
  copyOwnsDisks,
  copyProblem,
  copyTags,
  eligibleGuests,
  freeCopyId,
  isolationSteps,
  linkDown,
  markedTestId,
  networkDown,
  nextGuest,
  nextTestAt,
  overTime,
  roomNeeded,
  START_WAIT_MS,
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
    expect(testDue(inWindow, CHANGE_WINDOW_DEFAULT, TZ, new Date('2026-11-22T02:10:00Z'))).toBe(true);
    // Never sooner than seven days, though the last one started later in the night.
    expect(testDue(inWindow, CHANGE_WINDOW_DEFAULT, TZ, new Date('2026-11-22T02:30:00Z'))).toBe(false);
    expect(testDue(inWindow, CHANGE_WINDOW_DEFAULT, TZ, new Date('2026-11-23T02:00:00Z'))).toBe(false);
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
      '2026-12-05T02:05:00.000Z',
    );
  });
});

describe('the copy', () => {
  it('takes the first free number in its range', () => {
    expect(freeCopyId([101, 990000, 990001])).toBe(990002);
    expect(freeCopyId([101], 990004)).toBe(990005);
  });

  it('repairs what of the isolation didn’t take, each part on its own, start at boot first', () => {
    const steps = isolationSteps(
      'vm',
      {
        name: 'plex',
        description: copyMarker('rst_0a1b2c'),
        net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0',
        net1: 'ne2k_pci=BC:24:11:00:00:02,bridge=vmbr9,link_down=0',
        onboot: '1',
        protection: '1',
        tags: 'media',
        scsi0: 'local-lvm:vm-990001-disk-0,size=32G',
      },
      'whombat-test-of-plex',
    );
    expect(steps.map((s) => Object.keys(s).sort())).toEqual([
      ['onboot', 'protection'],
      ['net0', 'net1'],
      ['name'],
    ]);
    expect(steps[0]).toEqual({ onboot: '0', protection: '0' });
    // The card stays as it is, whatever its model or bridge: only the cable is pulled.
    expect(steps[1]?.net1).toBe('ne2k_pci=BC:24:11:00:00:02,bridge=vmbr9,link_down=1');
    expect(steps[1]?.net0).toBe('virtio=BC:24:11:00:00:01,bridge=vmbr0,link_down=1');
    // A copy the restore cut off needs nothing more.
    expect(
      isolationSteps(
        'container',
        { hostname: 'x', onboot: '0', net0: 'name=eth0,bridge=vmbr0,link_down=1' },
        'x',
      ),
    ).toEqual([]);
    expect(isolationSteps('container', { hostname: 'pihole' }, 'x')).toEqual([{ hostname: 'x' }]);
    expect(copyTags({ tags: 'media' })).toBe(`media;${RESTORE_TEST_TAG}`);
    expect(copyTags({ tags: `media;${RESTORE_TEST_TAG}` })).toBeNull();
    expect(networkDown({ net0: linkDown('name=eth0,bridge=vmbr0'), memory: '512' })).toBe(true);
    expect(networkDown({ net0: 'name=eth0,bridge=vmbr0' })).toBe(false);
  });

  it('refuses machines that use parts of the server itself', () => {
    expect(usesHostParts({ values: { hostpci0: '0000:01:00.0' } }, 'vm')).toBe(true);
    expect(usesHostParts({ values: { args: '-device vfio-pci,host=01:00.0' } }, 'vm')).toBe(true);
    expect(usesHostParts({ values: { hookscript: 'local:snippets/hook.pl' } }, 'vm')).toBe(true);
    expect(usesHostParts({ values: { usb0: 'host=1234:5678' } }, 'vm')).toBe(true);
    expect(usesHostParts({ values: { mp0: '/srv/media,mp=/media' } }, 'vm')).toBe(true);
    expect(usesHostParts({ values: { ide2: 'cdrom,media=cdrom' } }, 'vm')).toBe(true);
    expect(usesHostParts({ values: {}, restricted: ['lxc.cgroup2.devices.allow'] }, 'vm')).toBe(true);
    expect(usesHostParts({ values: {}, restricted: ['lxc.mount.entry'] }, 'vm')).toBe(true);
    expect(usesHostParts({ values: { ivshmem: 'size=32,name=looking-glass' } }, 'vm')).toBe(true);
    expect(usesHostParts({ values: { virtiofs0: 'media-share' } }, 'vm')).toBe(true);
    expect(usesHostParts({ values: { dev0: '/dev/dri/renderD128' } }, 'vm')).toBe(true);
    expect(usesHostParts({ values: { mp1: 'volume=/mnt/data,mp=/data' } }, 'vm')).toBe(true);
    expect(usesHostParts({ values: { rng0: 'source=/dev/hwrng' } }, 'vm')).toBe(true);
    expect(usesHostParts({ values: { rng0: 'source=/dev/urandom' } }, 'vm')).toBe(false);
    expect(
      usesHostParts(
        {
          values: {
            scsi0: 'local-lvm:vm-101-disk-0',
            ide2: 'local:iso/debian.iso,media=cdrom',
            serial0: 'socket',
          },
        },
        'vm',
      ),
    ).toBe(false);
  });

  it('never tests a container that runs as the server’s own root', () => {
    expect(
      usesHostParts({ values: { rootfs: 'local-zfs:subvol-102-disk-0', unprivileged: '1' } }, 'container'),
    ).toBe(false);
    expect(usesHostParts({ values: { rootfs: 'local-zfs:subvol-102-disk-0' } }, 'container')).toBe(true);
    expect(usesHostParts({ values: { rootfs: 'x', unprivileged: '0' } }, 'container')).toBe(true);
    // The key is a container's: a VM doesn't have it.
    expect(usesHostParts({ values: { scsi0: 'local-lvm:vm-101-disk-0' } }, 'vm')).toBe(false);
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
    expect(copyProblem({ values: ready }, 'vm', 990001, 'rst_0a1b2c')).toBeNull();
    // A person's machine at the number.
    expect(copyProblem({ values: { ...ready, description: '' } }, 'vm', 990001, 'rst_0a1b2c')).toBe(
      'not_ours',
    );
    // The backup still has a hook script, a raw argument or a passed-through device, though the machine doesn't today.
    expect(
      copyProblem({ values: { ...ready, hookscript: 'local:snippets/hook.pl' } }, 'vm', 990001, 'rst_0a1b2c'),
    ).toBe('host_parts');
    expect(
      copyProblem(
        { values: ready, restricted: ['args'], pending: { args: '-x' } },
        'vm',
        990001,
        'rst_0a1b2c',
      ),
    ).toBe('host_parts');
    expect(copyProblem({ values: ready, pending: { usb0: 'host=1-2' } }, 'vm', 990001, 'rst_0a1b2c')).toBe(
      'host_parts',
    );
    expect(
      copyProblem({ values: { ...ready, scsi1: 'local-lvm:vm-101-disk-1' } }, 'vm', 990001, 'rst_0a1b2c'),
    ).toBe('host_parts');
    expect(
      copyProblem(
        { values: { ...ready, net0: 'virtio=BC:24:11:00:00:09,bridge=vmbr0' } },
        'vm',
        990001,
        'rst_0a1b2c',
      ),
    ).toBe('network_kept');
    expect(
      copyProblem({ values: ready, pending: { net1: 'virtio,bridge=vmbr1' } }, 'vm', 990001, 'rst_0a1b2c'),
    ).toBe('network_kept');
    // A container copy that isn't unprivileged (the backup's, though the machine is unprivileged today), also when
    // only a waiting change would make it so.
    const ct = {
      ...ready,
      net0: 'name=eth0,bridge=vmbr0,link_down=1',
      rootfs: 'local-zfs:subvol-990001-disk-0',
    };
    expect(
      copyProblem({ values: { ...ct, unprivileged: '1' } }, 'container', 990001, 'rst_0a1b2c'),
    ).toBeNull();
    expect(copyProblem({ values: ct }, 'container', 990001, 'rst_0a1b2c')).toBe('host_parts');
    expect(
      copyProblem({ values: ct, pending: { unprivileged: '1' } }, 'container', 990001, 'rst_0a1b2c'),
    ).toBe('host_parts');
    // Still starting with the server.
    expect(copyProblem({ values: { ...ready, onboot: '1' } }, 'vm', 990001, 'rst_0a1b2c')).toBe('refused');
    expect(copyProblem({ values: { ...ready, onboot: '0' } }, 'vm', 990001, 'rst_0a1b2c')).toBeNull();
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

describe('what a backup takes', () => {
  it('reads the disks and memory a restore makes from the backup’s own settings', () => {
    expect(
      backupNeeds('vm', {
        memory: '8192',
        scsi0: 'local-lvm:vm-101-disk-0,size=32G',
        scsi1: 'tank:vm-101-disk-1,size=2T',
        efidisk0: 'local-lvm:vm-101-disk-2,efitype=4m,size=4M',
        ide2: 'local:iso/debian.iso,media=cdrom,size=600M',
        ide0: 'none,media=cdrom',
        unused0: 'local-lvm:vm-101-disk-3',
        // Left out of its backups: a restore leaves it out too.
        scsi2: 'tank:vm-101-disk-4,backup=0,size=8T',
      }),
    ).toEqual({ diskBytes: 32 * GIB + 2048 * GIB + 4 * 1024 ** 2, allSized: true, memoryMb: 8192 });
    // A container's mount points are made whatever their backup flag; newer Proxmox writes memory as current=.
    expect(
      backupNeeds('container', {
        memory: 'current=1024',
        rootfs: 'local-zfs:subvol-102-disk-0,size=8G',
        mp0: 'local-zfs:subvol-102-disk-1,mp=/data,backup=0,size=100G',
      }),
    ).toEqual({ diskBytes: 108 * GIB, allSized: true, memoryMb: 1024 });
    // Proxmox's default memory; a disk without a size.
    expect(backupNeeds('vm', { scsi0: 'local-lvm:vm-101-disk-0' })).toEqual({
      diskBytes: 0,
      allSized: false,
      memoryMb: 512,
    });
  });

  it('needs the room of the backup’s disks, else a multiple of the backup, else can’t tell', () => {
    expect(roomNeeded({ diskBytes: 40 * GIB, allSized: true }, 5 * GIB)).toBe(40 * GIB);
    expect(roomNeeded({ diskBytes: 0, allSized: true }, 5 * GIB)).toBe(15 * GIB);
    // A disk without a size: the larger of what is known.
    expect(roomNeeded({ diskBytes: 40 * GIB, allSized: false }, 5 * GIB)).toBe(40 * GIB);
    expect(roomNeeded({ diskBytes: 4 * GIB, allSized: false }, 5 * GIB)).toBe(15 * GIB);
    expect(roomNeeded({ diskBytes: 0, allSized: false }, null)).toBeNull();
  });
});

describe('the guest agent', () => {
  it('is on only where the settings switch it on', () => {
    expect(agentEnabled({ agent: '1' })).toBe(true);
    expect(agentEnabled({ agent: 'enabled=1,fstrim_cloned_disks=1' })).toBe(true);
    expect(agentEnabled({ agent: '0' })).toBe(false);
    expect(agentEnabled({ agent: 'fstrim_cloned_disks=1' })).toBe(false);
    expect(agentEnabled({})).toBe(false);
  });

  it('must answer in the copy when the copy’s own settings have it, unless the real machine shows it missing', () => {
    expect(agentMayAnswer({ state: 'running', agent: true })).toBe(true);
    // Stopped: nothing says it doesn't work.
    expect(agentMayAnswer({ state: 'stopped', agent: false })).toBe(true);
    // Running without an answer: switched on but not installed.
    expect(agentMayAnswer({ state: 'running', agent: false })).toBe(false);
    expect(agentExpectedOf('vm', { agent: '1' }, true)).toBe(true);
    // A backup from before the agent was switched on has none.
    expect(agentExpectedOf('vm', { agent: '0' }, true)).toBe(false);
    expect(agentExpectedOf('vm', {}, true)).toBe(false);
    expect(agentExpectedOf('vm', { agent: '1' }, false)).toBe(false);
    expect(agentExpectedOf('container', { agent: '1' }, true)).toBe(false);
  });
});

describe('overTime', () => {
  const startedAt = new Date('2026-11-29T02:00:00Z');
  const at = (min: number) => new Date(startedAt.getTime() + min * 60_000);

  it('skips a test whose copy wasn’t asked to start within the hour, which says nothing about the backup', () => {
    expect(overTime({ step: 'restoring', startedAt, stepAt: at(1) }, at(59))).toBeNull();
    expect(overTime({ step: 'restoring', startedAt, stepAt: at(1) }, at(61))).toEqual({
      outcome: 'skipped',
      reason: 'too_long',
    });
    expect(overTime({ step: 'configuring', startedAt, stepAt: at(58) }, at(61))?.outcome).toBe('skipped');
    expect(overTime({ step: 'pick', startedAt, stepAt: at(0) }, at(61))).toEqual({
      outcome: 'skipped',
      reason: 'unreachable',
    });
    expect(overTime({ step: 'cleaning', startedAt, stepAt: at(1) }, at(200))).toBeNull();
  });

  it('lets a copy asked to start near the hour finish its own limits before it fails as too long', () => {
    const wait = (START_WAIT_MS + BOOT_WAIT_MS) / 60_000;
    expect(overTime({ step: 'booting', startedAt, stepAt: at(58) }, at(61))).toBeNull();
    expect(overTime({ step: 'booting', startedAt, stepAt: at(58) }, at(58 + wait + 1))).toEqual({
      outcome: 'failed',
      reason: 'too_long',
    });
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
