/**
 * The Proxmox Servers tools' pure parts (proxmox.md PX-02, PX-05; proxmox-server.md): what `guest_create` sends
 * (Proxmox's wizard defaults), backup volumes and jobs, firewall rules, and every new call in words.
 */
import { catalogEntry } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { HostsError } from './client';
import { hostsErrorText } from './errors';
import { checkArgs, SERVERS_ADAPTER, SERVERS_TOOL_ARGS } from './tools';
import {
  backupGuestId,
  type CreateInput,
  firewallRule,
  incusCreateSet,
  jobWithGuest,
  pveCreateSet,
} from './tools-manage';
import {
  backupNoun,
  scheduleWords,
  serversAskWords,
  serversDoneWords,
  serversTaskWords,
  taskOutcomeText,
  taskTypeWords,
} from './words';

const choices = {
  storages: [
    { id: 'local', type: 'dir', content: ['iso', 'vztmpl', 'backup'] },
    { id: 'local-zfs', type: 'zfspool', content: ['images', 'rootdir'] },
  ],
  bridges: ['vmbr0', 'vmbr1'],
};

const input = (over: Partial<CreateInput>): CreateInput => ({
  kind: 'vm',
  name: 'web',
  id: null,
  cores: null,
  memoryMb: null,
  diskGb: null,
  storage: null,
  bridge: null,
  iso: null,
  template: null,
  password: null,
  sshKeys: null,
  start: false,
  settings: null,
  ...over,
});

describe('guest_create builds what Proxmox’s wizard would', () => {
  it('a VM: SCSI on virtio-scsi-single, x86-64-v2-AES, virtio NIC with firewall, guest agent, ISO as CD-ROM', () => {
    expect(
      pveCreateSet(input({ iso: 'local:iso/debian-13.iso', cores: 2, memoryMb: 4096 }), choices),
    ).toEqual({
      ostype: 'l26',
      scsihw: 'virtio-scsi-single',
      scsi0: 'local-zfs:32,iothread=1',
      ide2: 'local:iso/debian-13.iso,media=cdrom',
      boot: 'order=scsi0;ide2;net0',
      sockets: '1',
      cores: '2',
      cpu: 'x86-64-v2-AES',
      memory: '4096',
      net0: 'virtio,bridge=vmbr0,firewall=1',
      agent: '1',
    });
  });

  it('q35 and an EFI disk only with OVMF; settings go over the defaults', () => {
    const set = pveCreateSet(
      input({
        settings: { bios: 'ovmf', ostype: 'win11', tpmstate0: 'local-zfs:1,version=v2.0' },
        diskGb: 64,
      }),
      choices,
    );
    expect(set).toMatchObject({
      bios: 'ovmf',
      machine: 'q35',
      efidisk0: 'local-zfs:1,efitype=4m,pre-enrolled-keys=1',
      ostype: 'win11',
      scsi0: 'local-zfs:64,iothread=1',
      tpmstate0: 'local-zfs:1,version=v2.0',
    });
    expect(pveCreateSet(input({}), choices).machine).toBeUndefined();
    expect(pveCreateSet(input({}), choices).ide2).toBe('none,media=cdrom');
  });

  it('a container: unprivileged, nesting, DHCP on the first bridge, root disk on the first rootdir storage', () => {
    expect(
      pveCreateSet(
        input({ kind: 'container', name: 'dns', template: 'local:vztmpl/debian-13.tar.zst', password: 'pw' }),
        choices,
      ),
    ).toEqual({
      ostemplate: 'local:vztmpl/debian-13.tar.zst',
      rootfs: 'local-zfs:8',
      cores: '1',
      memory: '512',
      swap: '512',
      net0: 'name=eth0,bridge=vmbr0,firewall=1,ip=dhcp',
      unprivileged: '1',
      features: 'nesting=1',
      password: 'pw',
    });
    // Never privileged, whatever the settings say.
    expect(
      pveCreateSet(
        input({ kind: 'container', template: 't', settings: { unprivileged: '0', bridge: 'x' } }),
        choices,
      ).unprivileged,
    ).toBe('1');
    expect(() => pveCreateSet(input({ kind: 'container' }), choices)).toThrow('template:');
    expect(() => pveCreateSet(input({}), { storages: [], bridges: ['vmbr0'] })).toThrow('storage:');
    expect(() => pveCreateSet(input({}), { storages: choices.storages, bridges: [] })).toThrow('bridge:');
    expect(incusCreateSet(input({ cores: 2, memoryMb: 1024 }))).toEqual({
      'limits.cpu': '2',
      'limits.memory': '1024MiB',
    });
  });
});

describe('backups, jobs and rules', () => {
  it('reads the guest a backup is of', () => {
    expect(backupGuestId('pbs-01:backup/vm/101/2026-10-16T02:00:00Z')).toBe('pve:101');
    expect(backupGuestId('local:backup/vzdump-lxc-203-2026_10_16-02_00_00.tar.zst')).toBe('pve:203');
    expect(backupGuestId('local:iso/x.iso')).toBeNull();
  });

  it('adds a guest to a job, or takes it out, the way the job selects', () => {
    const guests = { selection: 'guests' as const, guests: ['pve:101'], exclude: [], pool: null };
    expect(jobWithGuest(guests, 'pve:102', true)).toEqual({ guests: ['pve:101', 'pve:102'] });
    expect(jobWithGuest(guests, 'pve:101', true)).toEqual({ unchanged: true });
    expect(jobWithGuest(guests, 'pve:101', false)).toEqual({ guests: [] });
    const all = { selection: 'all' as const, guests: [], exclude: ['pve:107'], pool: null };
    expect(jobWithGuest(all, 'pve:107', true)).toEqual({ exclude: [] });
    expect(jobWithGuest(all, 'pve:101', false)).toEqual({ exclude: ['pve:107', 'pve:101'] });
    expect(jobWithGuest(all, 'pve:101', true)).toEqual({ unchanged: true });
    expect(jobWithGuest({ selection: 'pool', guests: [], exclude: [], pool: 'prod' }, 'pve:1', true)).toEqual(
      {
        refused: 'This job backs up the pool prod; add or remove the guest in that pool in Proxmox.',
      },
    );
  });

  it('checks a firewall rule', () => {
    expect(firewallRule({ type: 'in', action: 'ACCEPT', macro: 'SSH', enable: true }, false)).toEqual({
      type: 'in',
      action: 'ACCEPT',
      macro: 'SSH',
      enable: true,
    });
    expect(firewallRule({ enable: false }, true)).toEqual({ enable: false });
    expect(() => firewallRule({ type: 'in' }, false)).toThrow('rule.action');
    expect(() => firewallRule({ type: 'in', action: 'DROP', port: '22' }, false)).toThrow('rule.port');
    expect(() => firewallRule({ enable: 'yes' }, true)).toThrow('rule.enable');
    expect(() => firewallRule({}, true)).toThrow('what to change');
  });

  it('refuses arguments the new tools don’t take', () => {
    expect(() => checkArgs('guest_delete', { server: 'a', guest: 'b', force: true })).toThrow(
      'force: guest_delete doesn’t take it',
    );
    expect(() =>
      checkArgs('backup_job_set', { server: 'a', action: 'create', schedule: '04:00', pool: 'prod' }),
    ).not.toThrow();
  });

  it('says the service’s own sentence for a server-wide refusal', () => {
    const err = new HostsError(
      501,
      'unsupported',
      'this job runs on pve-01 only; run it from that server',
      null,
    );
    expect(hostsErrorText(err, { server: 'pve-02' })).toBe(
      'This job runs on pve-01 only; run it from that server.',
    );
    expect(hostsErrorText(err, { server: 'pve-02', guest: 'web' })).toBe(
      'That isn’t possible on this kind of guest.',
    );
  });
});

describe('the tools as the contract has them', () => {
  const tools = catalogEntry('whombat_servers')?.tools ?? [];

  it('runs every tool and takes exactly the arguments its schema names', () => {
    // A Mac's mac_screen and mac_ui (macos-servers.md): 57.
    expect(tools.length).toBe(57);
    for (const tool of tools) {
      expect(SERVERS_ADAPTER[tool.name], tool.name).toBeTypeOf('function');
      const props = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect([...(SERVERS_TOOL_ARGS[tool.name] ?? [])].sort(), tool.name).toEqual(props.sort());
    }
    expect(Object.keys(SERVERS_ADAPTER).sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it('has words for every change', () => {
    for (const tool of tools.filter((t) => t.access === 'write'))
      expect(
        serversAskWords(tool.name, { server: 'pve-02', guest: 'web', action: 'x' }),
        tool.name,
      ).toBeTruthy();
  });
});

describe('the new calls in words', () => {
  const now = new Date('2026-10-17T10:00:00Z');
  const ask = (tool: string, args: Record<string, unknown>) => serversAskWords(tool, args, now);

  it('names a backup by its day', () => {
    expect(backupNoun('pbs-01:backup/vm/101/2026-10-16T02:00:00Z', now)).toBe('yesterday’s backup');
    expect(backupNoun('pbs-01:backup/vm/101/2026-10-17T02:00:00Z', now)).toBe('today’s backup');
    expect(backupNoun('local:backup/vzdump-qemu-101-2026_10_03-02_00_00.vma.zst', now)).toBe(
      'the 3 October backup',
    );
    expect(backupNoun('pbs-01:backup/vm/101/2025-12-24T02:00:00Z', now)).toBe('the 24 December 2025 backup');
    expect(backupNoun('odd', now)).toBe('a backup');
    expect(scheduleWords('04:00')).toBe('every day at 04:00');
    expect(scheduleWords('sat 2:00')).toBe('on Saturdays at 02:00');
    expect(scheduleWords('mon..fri 21:30')).toBe('Monday to Friday at 21:30');
    expect(scheduleWords('*/15')).toBe('every 15 minutes');
    expect(scheduleWords('2,22:30')).toBe('on the schedule “2,22:30”');
    expect(taskTypeWords('UPID:shale:0001:0002:0003:vzdump:101:root@pam:')).toBe('the backup');
  });

  it('asks like the brief: delete, restore, create, reboot', () => {
    expect(ask('guest_delete', { server: 'pve-02', guest: 'web' })).toBe('delete web on pve-02');
    expect(
      ask('guest_backup', {
        server: 'pve-02',
        guest: 'web',
        action: 'restore',
        backup: 'pbs-01:backup/vm/101/2026-10-16T02:00:00Z',
      }),
    ).toBe('restore web on pve-02 from yesterday’s backup');
    expect(ask('guest_create', { server: 'pve-02', kind: 'container', name: 'dns' })).toBe(
      'create a container called dns on pve-02',
    );
    expect(ask('server_power', { server: 'pve-02', action: 'reboot' })).toBe('reboot pve-02');
    expect(ask('guest_power', { server: 'pve-02', guest: 'web', action: 'pause' })).toBe(
      'pause web on pve-02',
    );
    expect(ask('guest_clone', { server: 'pve-02', guest: 'web', name: 'web-2' })).toBe(
      'clone web on pve-02 as web-2',
    );
    expect(ask('guest_template', { server: 'pve-02', guest: 'web' })).toBe(
      'turn web on pve-02 into a template',
    );
    expect(
      ask('guest_disk', { server: 'pve-02', guest: 'web', action: 'resize', disk: 'scsi0', size: '+10G' }),
    ).toBe('grow the disk scsi0 of web on pve-02 by 10G');
    expect(
      ask('guest_disk', {
        server: 'pve-02',
        guest: 'web',
        action: 'move',
        disk: 'scsi0',
        storage: 'local-zfs',
      }),
    ).toBe('move the disk scsi0 of web on pve-02 to local-zfs');
    expect(
      ask('guest_backup', {
        server: 'pve-02',
        action: 'delete',
        backup: 'pbs-01:backup/vm/101/2026-10-16T02:00:00Z',
      }),
    ).toBe('delete yesterday’s backup on pve-02');
    expect(ask('backup_job_set', { server: 'pve-02', action: 'create', schedule: 'sat 02:00' })).toBe(
      'add a backup job on pve-02 that runs on Saturdays at 02:00',
    );
    expect(
      ask('backup_job_set', { server: 'pve-02', action: 'add_guest', job: 'backup-1', guest: 'web' }),
    ).toBe('add web to a backup job on pve-02');
    expect(
      ask('storage_content', {
        server: 'pve-02',
        action: 'download',
        storage: 'local',
        url: 'https://x.org/debian-13.iso',
      }),
    ).toBe('download debian-13.iso to local on pve-02');
    expect(
      ask('storage_content', {
        server: 'pve-02',
        action: 'delete',
        storage: 'local',
        volume: 'local:iso/a.iso',
      }),
    ).toBe('delete a.iso from local on pve-02');
    expect(ask('task_stop', { server: 'pve-02', task: 'UPID:pve-02:1:2:3:qmclone:101:x:' })).toBe(
      'stop the clone on pve-02',
    );
    expect(
      ask('guest_firewall_set', {
        server: 'pve-02',
        guest: 'web',
        action: 'update_rule',
        pos: 1,
        rule: { enable: false },
      }),
    ).toBe('turn off a firewall rule of web on pve-02');
    expect(ask('guest_ha', { server: 'pve-02', guest: 'web', action: 'set' })).toBe(
      'keep web on pve-02 running with high availability',
    );
    expect(
      ask('guest_replication', { server: 'pve-02', guest: 'web', action: 'add', target: 'pve-01' }),
    ).toBe('replicate web on pve-02 to pve-01');
    expect(
      ask('guest_config_set', { server: 'pve-02', guest: 'web', delete: ['unused0'], confirm: true }),
    ).toBe('delete an unused disk of web on pve-02 for good');
    expect(ask('server_choices', { server: 'pve-02' })).toBeNull();
  });

  it('says what it did, or what it is doing, in one sentence', () => {
    const okResult = { ok: true as const, isError: false, content: '{}' };
    const done = (tool: string, args: Record<string, unknown>) => serversDoneWords(tool, args, okResult, now);
    expect(done('guest_delete', { server: 'pve-02', guest: 'web' })).toBe('Deleting web on pve-02 now.');
    expect(done('server_power', { server: 'pve-02', action: 'reboot' })).toBe('Rebooting pve-02 now.');
    // What a command printed goes to the agent that asked, which explains it (CA-02).
    expect(done('server_command', { server: 'pve-02', command: 'uptime' })).toBeNull();
    expect(
      done('guest_backup', {
        server: 'pve-02',
        guest: 'web',
        action: 'protect',
        backup: 'pbs-01:backup/vm/101/2026-10-16T02:00:00Z',
      }),
    ).toBe('Protected yesterday’s backup of web on pve-02.');
    expect(done('backup_job_set', { server: 'pve-02', action: 'pause', job: 'x' })).toBe(
      'Paused a backup job on pve-02.',
    );
    expect(done('guest_ha', { server: 'pve-02', guest: 'web', action: 'set' })).toBe(
      'web on pve-02 has high availability now.',
    );
    expect(done('guest_config_set', { server: 'pve-02', guest: 'web', set: { memory: '1' } })).toBe(
      'Changed the settings of web on pve-02.',
    );
    expect(
      serversDoneWords(
        'guest_create',
        { server: 'pve-02', kind: 'vm', name: 'web' },
        {
          ok: true,
          isError: true,
          content: '{"error":"pve-02 isn’t connected right now, so it can’t do that."}',
        },
        now,
      ),
    ).toBe(
      'I couldn’t create a VM called web on pve-02: pve-02 isn’t connected right now, so it can’t do that.',
    );
  });

  it('tells how a task ended', () => {
    const backup = serversTaskWords('guest_backup', { action: 'create' }, { server: 'pve-02', guest: 'web' });
    expect(taskOutcomeText(backup as NonNullable<typeof backup>, 'ok', 'OK')).toBe(
      'The backup of web on pve-02 is done.',
    );
    const clone = serversTaskWords(
      'guest_clone',
      { name: 'web-2' },
      { server: 'pve-02', guest: 'web', name: 'web-2' },
    );
    expect(
      taskOutcomeText(clone as NonNullable<typeof clone>, 'error', 'TASK ERROR: no space left on device'),
    ).toBe('Cloning web on pve-02 as web-2 didn’t work: the storage is full.');
    expect(taskOutcomeText(clone as NonNullable<typeof clone>, 'ok', 'OK')).toBe(
      'web-2 is ready on pve-02, cloned from web.',
    );
    const create = serversTaskWords(
      'guest_create',
      { kind: 'container', start: true },
      { server: 'pve-02', name: 'dns' },
    );
    expect(taskOutcomeText(create as NonNullable<typeof create>, 'warning', 'WARNINGS: 2')).toBe(
      'The new container dns on pve-02 finished with 2 warnings.',
    );
    expect(taskOutcomeText(create as NonNullable<typeof create>, 'ok', 'OK')).toBe(
      'The container dns on pve-02 is ready and running.',
    );
    const restore = serversTaskWords(
      'guest_backup',
      { action: 'restore' },
      { server: 'pve-02', guest: 'web', backup: 'yesterday’s backup' },
    );
    expect(taskOutcomeText(restore as NonNullable<typeof restore>, 'ok', 'OK')).toBe(
      'web on pve-02 is back as it was in yesterday’s backup.',
    );
    const run = serversTaskWords(
      'backup_job_set',
      { action: 'run' },
      { server: 'pve-02', name: 'Every night' },
    );
    expect(taskOutcomeText(run as NonNullable<typeof run>, 'ok', 'OK')).toBe(
      'The backup job “Every night” on pve-02 is done.',
    );
    expect(serversTaskWords('backup_job_set', { action: 'pause' }, { server: 'pve-02' })).toBeNull();
  });
});
