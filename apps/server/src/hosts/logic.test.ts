import type { HostServer } from '@whombat/core';
import { taskLostText } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  ASK_AFTER_MS,
  ASK_EVERY_MS,
  ENDED_KEEP_MS,
  LOST_AFTER_MS,
  type NewFollowedTask,
  type TaskAnswer,
  TaskFollow,
} from './follow';
import { manageCall, manageText, minutesText } from './routes';
import { hintLink, hintWatch, serverThing } from './sources';
import { memoryTaskStore } from './testing/task-store';
import { checkArgs, diagnoseArgs, downsample, hubPowerAction, seriesWanted } from './tools';
import { configDrift, configUndo, powerInverse, powerText, settingsUndo, toolPowerAction } from './undo';
import {
  serversAskWords,
  serversDoneWords,
  serversStartsTask,
  serversTaskWords,
  taskOutcomeText,
  taskReason,
} from './words';

describe('power and its inverse', () => {
  it('puts a guest back the way it was, where there is a way', () => {
    expect(powerInverse('start', 'vm')).toBe('shutdown');
    expect(powerInverse('start', 'container')).toBe('stop');
    expect(powerInverse('force_stop', 'vm')).toBe('start');
    expect(powerInverse('pause', 'vm')).toBe('resume');
    expect(powerInverse('reboot', 'vm')).toBeNull();
    expect(powerInverse('snapshot_create', 'vm')).toBeNull();
    expect(toolPowerAction('force_stop')).toBe('stop');
    expect(toolPowerAction('resume')).toBe('resume');
    expect(toolPowerAction('pause')).toBe('pause');
    expect(toolPowerAction('reboot')).toBeNull();
  });

  it('says it in plain words and maps the tool’s words to the hub’s', () => {
    expect(powerText('reboot', 'web', 'pve-02')).toBe('Restarted web on pve-02');
    expect(powerText('snapshot_restore', 'web', 'pve-02', 'before-update')).toBe(
      'Put web on pve-02 back to its snapshot before-update',
    );
    expect(hubPowerAction('stop', 'vm')).toBe('force_stop');
    expect(hubPowerAction('shutdown', 'container')).toBe('stop');
    expect(hubPowerAction('reboot', 'container')).toBe('restart');
  });
});

describe('configuration undo', () => {
  it('restores old values, removes added keys and never touches masked secrets', () => {
    const undo = configUndo('pve-02', 'pve:101', 'web', {
      changes: [
        { key: 'memory', old: '4096', new: '8192', pending: true },
        { key: 'tags', new: 'prod' },
        { key: 'cipassword', old: '**********', new: '**********' },
      ],
    });
    expect(undo).toEqual({
      serverId: 'pve-02',
      guestId: 'pve:101',
      guestName: 'web',
      set: { memory: '4096' },
      delete: ['tags'],
      expect: { memory: '8192', tags: 'prod' },
    });
    expect(
      configUndo('s', 'g', null, { changes: [{ key: 'cipassword', old: '****', new: '****' }] }),
    ).toBeNull();
    expect(configDrift({ memory: '8192', tags: 'prod' }, undo?.expect ?? {})).toEqual([]);
    expect(configDrift({ memory: '2048' }, undo?.expect ?? {})).toEqual(['memory', 'tags']);
  });

  it('keeps the previous settings of what a patch changes', () => {
    const before = {
      group: 'Lab',
      location: null,
      parent: '',
      remote_control: { console: false, power: true },
    };
    expect(
      settingsUndo('basalt', { group: 'Prod', remoteControl: { console: true, power: true } }, before),
    ).toEqual({
      serverId: 'basalt',
      patch: { group: 'Lab', remoteControl: { console: false } },
    });
    expect(settingsUndo('basalt', { group: 'Lab' }, before)).toBeNull();
  });
});

describe('manage requests', () => {
  it('maps each op to its route with the fields it takes', () => {
    expect(
      manageCall('pve-02', {
        op: 'config.set',
        guestId: 'pve:101',
        params: { set: { memory: '8192' } },
        digest: 'abc',
      }),
    ).toEqual({
      method: 'PUT',
      path: '/api/v1/servers/pve-02/guests/pve:101/config',
      body: { digest: 'abc', set: { memory: '8192' } },
    });
    expect(
      manageCall('pve-02', {
        op: 'guest.delete',
        guestId: 'pve:101',
        params: { purge: true },
        confirmName: 'web',
      }),
    ).toEqual({
      method: 'DELETE',
      path: '/api/v1/servers/pve-02/guests/pve:101',
      query: { confirm_name: 'web', purge: '1' },
    });
    expect(
      manageCall('pve-02', { op: 'disk.resize', guestId: 'pve:101', params: { disk: 'scsi0', size: '+8G' } }),
    ).toMatchObject({
      path: '/api/v1/servers/pve-02/guests/pve:101/disks/scsi0/resize',
      body: { size: '+8G' },
    });
    expect(
      manageCall('pve-02', {
        op: 'guest.migrate',
        guestId: 'pve:101',
        params: { target: 'pve-01', storage: 'local-zfs' },
        confirm: true,
      }),
    ).toMatchObject({ body: { target: 'pve-01', storage: 'local-zfs', confirm: true } });
    expect(
      manageCall('pve-02', {
        op: 'firewall.rule_update',
        guestId: 'pve:101',
        params: { pos: 2, moveTo: 0 },
        digest: 'r1',
      }),
    ).toEqual({
      method: 'PUT',
      path: '/api/v1/servers/pve-02/guests/pve:101/firewall/rules/2',
      body: { digest: 'r1', move_to: 0 },
    });
    expect(
      manageCall('pve-02', {
        op: 'content.download',
        params: {
          platform: 'pve',
          storage: 'local',
          content: 'iso',
          url: 'https://x/y.iso',
          filename: 'y.iso',
        },
      }),
    ).toMatchObject({ path: '/api/v1/servers/pve-02/storage/local/download', body: { content: 'iso' } });
    expect(() => manageCall('pve-02', { op: 'config.set', params: {} })).toThrow('guestId');
    expect(manageText('guest.migrate', 'pve-02', 'web')).toBe('Moved web on pve-02');
    expect(manageText('backup.restore', 'pve-02', 'web')).toBe('Restored web on pve-02 from a backup');
    expect(minutesText(120)).toBe('2 hours');
    expect(minutesText(1440)).toBe('1 day');
    expect(minutesText(45)).toBe('45 minutes');
  });
});

describe('what a manage request may carry (PX-08)', () => {
  it('refuses a param the route doesn’t pass, naming it, instead of dropping it', () => {
    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return err as { code: string; message: string; extra: { fields?: Record<string, string[]> } };
      }
      throw new Error('not refused');
    };
    const migrate = refused(() =>
      manageCall('pve-02', {
        op: 'guest.migrate',
        guestId: 'pve:101',
        params: { target: 'pve-01', online: true },
        confirm: true,
      }),
    );
    expect(migrate.code).toBe('validation_failed');
    expect(migrate.message).toBe('This change doesn’t take “online”.');
    expect(migrate.extra.fields).toEqual({ 'params.online': ['Not taken by this change.'] });
    expect(
      refused(() =>
        manageCall('pve-02', {
          op: 'config.set',
          guestId: 'pve:101',
          params: { set: { memory: '8192' }, extra: 'x' },
        }),
      ).message,
    ).toBe('This change doesn’t take “extra”.');
    // A guest route takes the guest from its path, not its params.
    expect(() =>
      manageCall('pve-02', {
        op: 'backup.create',
        guestId: 'pve:101',
        params: { storage: 'pbs', guest: 'x' },
      }),
    ).toThrow('“guest”');
  });

  it('restores over the request’s guest (it restored as a new guest before)', () => {
    expect(
      manageCall('pve-02', {
        op: 'backup.restore',
        guestId: 'pve:101',
        params: { platform: 'pve', volume: 'pbs:backup/vm/101/2026-10-16T02:00:00Z', start: true },
        confirm: true,
      }),
    ).toEqual({
      method: 'POST',
      path: '/api/v1/servers/pve-02/backups/restore',
      body: {
        platform: 'pve',
        volume: 'pbs:backup/vm/101/2026-10-16T02:00:00Z',
        guest: 'pve:101',
        start: true,
        confirm: true,
      },
    });
    // The web's way (params.guest) still works; two different guests don't.
    expect(
      manageCall('pve-02', {
        op: 'backup.restore',
        params: { volume: 'v', guest: 'pve:101' },
        confirm: true,
      }).body,
    ).toMatchObject({ guest: 'pve:101' });
    expect(() =>
      manageCall('pve-02', {
        op: 'backup.restore',
        guestId: 'pve:101',
        params: { volume: 'v', guest: 'pve:102' },
      }),
    ).toThrow('different guests');
  });
});

describe('the Servers tools’ arguments', () => {
  it('refuses an argument a tool doesn’t take, naming it', () => {
    expect(() => checkArgs('guest_power', { server: 'a', guest: 'b', action: 'start', force: true })).toThrow(
      'force: guest_power doesn’t take it (it takes server, guest, action).',
    );
    expect(() => checkArgs('servers_overview', { server: 'a' })).toThrow(
      'servers_overview takes no arguments',
    );
    expect(() =>
      checkArgs('guest_migrate', { server: 'a', guest: 'b', target: 'c', storage: 'd' }),
    ).not.toThrow();
  });

  it('asks for the service’s series names, mapping the old net_mbps to both directions', () => {
    expect(seriesWanted(undefined)).toEqual([
      'cpu_pct',
      'mem_pct',
      'temp_max_c',
      'net_rx_mbps',
      'net_tx_mbps',
    ]);
    expect(seriesWanted(['cpu_pct', 'net_mbps', 'net_rx_mbps'])).toEqual([
      'cpu_pct',
      'net_rx_mbps',
      'net_tx_mbps',
    ]);
    expect(seriesWanted(['vol_pct:fs:/srv'])).toEqual(['vol_pct:fs:/srv']);
    expect(() => seriesWanted([1])).toThrow('series:');
    expect(() => seriesWanted('cpu_pct')).toThrow('series:');
  });

  it('passes a check’s arguments as strings', () => {
    expect(diagnoseArgs({ unit: 'pveproxy', lines: 200, follow: false })).toEqual({
      unit: 'pveproxy',
      lines: '200',
      follow: 'false',
    });
    expect(diagnoseArgs(undefined)).toBeUndefined();
    expect(diagnoseArgs({})).toBeUndefined();
    expect(() => diagnoseArgs(['x'])).toThrow('args: an object of strings');
    expect(() => diagnoseArgs({ since: { h: 2 } })).toThrow('args.since: a string.');
    expect(() =>
      diagnoseArgs(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`a${i}`, 'x']))),
    ).toThrow('at most 16');
  });
});

describe('long work reports back (PX-05)', () => {
  const words = serversTaskWords('guest_migrate', { target: 'pve-01' }, { server: 'pve-02', guest: 'web' });

  it('says how a task ended in one plain sentence, without ids or logs', () => {
    expect(words).toEqual({
      what: 'The move of web to pve-01',
      doing: 'Moving web from pve-02 to pve-01',
      ok: 'web is on pve-01 now.',
    });
    const w = { what: 'The backup of web on pve-02', doing: 'Backing up web on pve-02' };
    expect(taskOutcomeText(w, 'ok', 'OK')).toBe('The backup of web on pve-02 is done.');
    expect(taskOutcomeText(w, 'warning', 'WARNINGS: 2')).toBe(
      'The backup of web on pve-02 finished with 2 warnings.',
    );
    expect(taskOutcomeText(w, 'warning', 'WARNINGS: 1')).toBe(
      'The backup of web on pve-02 finished with 1 warning.',
    );
    expect(taskOutcomeText(w, 'warning', null)).toBe('The backup of web on pve-02 finished with warnings.');
    expect(taskOutcomeText(w, 'error', 'TASK ERROR: interrupted by signal')).toBe(
      'Backing up web on pve-02 didn’t work: it was stopped before it finished.',
    );
    expect(taskOutcomeText(w, 'error', "command 'vzdump 101' failed: storage 'pbs-01' is not online")).toBe(
      "Backing up web on pve-02 didn’t work: storage 'pbs-01' is not online.",
    );
    expect(taskOutcomeText(w, 'error', '')).toBe('Backing up web on pve-02 didn’t work.');
    expect(taskReason('unable to create VM 105 - VM 105 already exists on node shale')).toBe(
      'something with that name is already there',
    );
    expect(taskReason('UPID:shale:0001:qmclone:101: failed somehow.')).toBe('failed somehow');
    expect(serversTaskWords('servers_overview', {}, { server: 'x' })).toBeNull();
  });

  it('tells once when a followed task ends, also when the end came first, in the thread it was asked in', async () => {
    const store = memoryTaskStore();
    const follow = new TaskFollow({ store, now: () => 1_000_000 });
    const task = (taskId: string): NewFollowedTask => ({
      taskId,
      serverId: 'pve-02',
      serverName: 'pve-02',
      burrowId: 'brw_1',
      conversationId: 'cnv_1',
      threadRootId: 'msg_asked',
      agentId: 'prn_whombat',
      personId: 'prn_mara',
      words: words as NonNullable<typeof words>,
    });
    await follow.remember(task('UPID:a'));
    await follow.finished('pve-01', 'UPID:a', 'ok', null);
    expect(store.told).toHaveLength(0);
    follow.onChange({
      kind: 'task',
      serverId: 'pve-02',
      guestId: 'pve:101',
      data: { event: 'task.finished', task: 'UPID:a', result: 'error', message: 'no space left on device' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.told.map((t) => [t.end.state, t.end.words])).toEqual([
      ['error', 'Moving web from pve-02 to pve-01 didn’t work: the storage is full.'],
    ]);
    // Told once: a repeated event says nothing more.
    await follow.finished('pve-02', 'UPID:a', 'ok', null);
    expect(store.told).toHaveLength(1);
    // The event raced the answer: still told, once.
    await follow.finished('pve-02', 'UPID:b', 'ok', null);
    await follow.remember(task('UPID:b'));
    expect(store.told.at(-1)?.end.words).toBe('web is on pve-01 now.');
    // Both told in the thread they were asked in (task-feedback.md TF-04).
    expect(store.told.map((t) => t.task.threadRootId)).toEqual(['msg_asked', 'msg_asked']);
    // Action events (power) aren't tasks.
    follow.onChange({ kind: 'task', serverId: 'pve-02', guestId: null, data: { event: 'action.finished' } });
    await follow.remember(task('UPID:c'));
    expect(store.running_()).toHaveLength(1);
  });

  it('asks the hub about running tasks: all at start and after a resync, then the older ones; lost after a day (TF-11)', async () => {
    let now = 10_000_000;
    const store = memoryTaskStore();
    const answers = new Map<string, TaskAnswer>();
    const asked: string[] = [];
    const follow = new TaskFollow({
      store,
      now: () => now,
      ask: async (t) => {
        asked.push(t.taskId);
        return answers.get(t.taskId) ?? null;
      },
    });
    const task = (taskId: string): NewFollowedTask => ({
      taskId,
      serverId: 'pve-02',
      serverName: 'PVE-02',
      burrowId: 'b',
      conversationId: 'c',
      threadRootId: null,
      agentId: 'a',
      personId: null,
      words: words as NonNullable<typeof words>,
    });
    await follow.remember(task('UPID:1'));
    await follow.remember(task('UPID:2'));
    answers.set('UPID:1', { status: 'running' });
    answers.set('UPID:2', { status: 'ok', message: 'OK', code: null });
    // At start (a restart re-reads the running rows) every one is asked about; an ended one is told.
    await follow.check(true);
    expect(asked).toEqual(['UPID:1', 'UPID:2']);
    expect(store.told.map((t) => [t.task.taskId, t.end.state])).toEqual([['UPID:2', 'ok']]);
    // The tick asks only about tasks older than 2 minutes, not asked about for 5.
    now += ASK_AFTER_MS + 1;
    await follow.check();
    expect(asked).toHaveLength(2);
    now += ASK_EVERY_MS;
    await follow.check();
    expect(asked).toEqual(['UPID:1', 'UPID:2', 'UPID:1']);
    // A resync asks about all of them again.
    follow.onChange({ kind: 'resync' });
    await follow.check();
    expect(asked.filter((a) => a === 'UPID:1').length).toBeGreaterThanOrEqual(3);
    // The hub can't tell any more: lost once it started more than a day ago, with the words for it.
    answers.delete('UPID:1');
    await follow.check(true);
    expect(store.told).toHaveLength(1);
    now += LOST_AFTER_MS;
    await follow.check(true);
    expect(store.told.at(-1)?.end).toMatchObject({ state: 'lost', words: taskLostText('PVE-02') });
    // Ended ones go after 30 days.
    now += ENDED_KEEP_MS + 1;
    await follow.check(true);
    expect(store.rows.size).toBe(0);
  });
});

describe('which calls start a task Whombat follows (task-feedback.md TF-05)', () => {
  it('knows them from the call alone, before it runs', () => {
    expect(serversStartsTask('server_update', { server: 'pve-02', action: 'install' })).toBe(true);
    expect(serversStartsTask('server_update', { server: 'pve-02', action: 'check' })).toBe(true);
    expect(serversStartsTask('guest_backup', { server: 'pve-02', guest: 'web', action: 'create' })).toBe(
      true,
    );
    expect(serversStartsTask('unraid_array', { server: 'blackbox', action: 'parity_check' })).toBe(true);
    // Done at once, or its output is the agent's to read.
    expect(serversStartsTask('guest_power', { server: 'pve-02', guest: 'web', action: 'reboot' })).toBe(
      false,
    );
    expect(serversStartsTask('unraid_array', { server: 'blackbox', action: 'parity_pause' })).toBe(false);
    expect(serversStartsTask('server_command', { server: 'pve-02', command: 'uptime' })).toBe(false);
  });
});

describe('hints with a way out (PX-07)', () => {
  const guests = [
    { id: 'pve:101', name: 'web' },
    { id: 'pve:102', name: 'dns' },
  ];
  const hint = (kind: string, detail: string, section = 'guests') => ({
    serverId: 'pve-02',
    kind,
    detail,
    section,
  });

  it('links a hint about one guest to that guest, and a folded one to the server’s tab', () => {
    expect(hintLink(hint('guest.no_backup_job', 'web'), guests)).toEqual({
      href: '/things/server%3Apve-02?guest=pve%3A101&gtab=backups',
      wayOut: 'Add it to a backup plan.',
    });
    expect(hintLink(hint('guest.backup_old', 'dns (12 days)'), guests).href).toBe(
      '/things/server%3Apve-02?guest=pve%3A102&gtab=backups',
    );
    expect(hintLink(hint('guest.snapshot_old', 'web (40 days)'), guests).href).toContain('gtab=snapshots');
    expect(hintLink(hint('guest.pending_changes', 'web (2 changes)'), guests).href).toBe(
      '/things/server%3Apve-02?guest=pve%3A101',
    );
    expect(hintLink(hint('guest.no_backup_job', 'web, dns'), guests)).toEqual({
      href: '/things/server%3Apve-02?tab=guests',
      wayOut: 'Add them to a backup plan.',
    });
    expect(hintLink(hint('guest.agent_down', 'gone'), guests).href).toBe(
      '/things/server%3Apve-02?tab=guests',
    );
    expect(hintLink(hint('storage.overcommit', '1.2 TB of guest disks on 1 TB', 'storage'), []).href).toBe(
      '/things/server%3Apve-02?tab=storage',
    );
    expect(hintLink(hint('disk.space', '910 GB of 1 TB used', 'storage'), []).href).toBe(
      '/things/server%3Apve-02?tab=storage',
    );
    expect(hintLink(hint('agent.outdated', 'x', 'agent'), []).href).toBe('/things/server%3Apve-02');
  });

  it('says the way out on Watch', () => {
    const item = hintWatch(
      {
        ...hint('guest.no_backup_job', 'web'),
        severity: 'info',
        entity: 'pve',
        title: '1 guest in no backup job',
      },
      '2026-10-17T10:00:00Z',
      guests,
    );
    expect(item).toMatchObject({
      title: '1 guest in no backup job',
      body: 'web. Add it to a backup plan.',
      href: '/things/server%3Apve-02?guest=pve%3A101&gtab=backups',
      state: 'open',
    });
  });
});

describe('the Servers tools’ words and answers', () => {
  it('asks and reports like a person', () => {
    expect(serversAskWords('guest_power', { server: 'pve-02', guest: 'web', action: 'reboot' })).toBe(
      'restart web on pve-02',
    );
    expect(serversAskWords('server_command', { server: 'basalt', command: 'uptime' })).toBe(
      'run “uptime” on basalt',
    );
    expect(serversAskWords('servers_overview', {})).toBeNull();
    const args = { server: 'pve-02', guest: 'web', action: 'reboot' };
    expect(serversDoneWords('guest_power', args, { ok: true, isError: false, content: '{}' })).toBe(
      'Restarting web on pve-02 now.',
    );
    expect(
      serversDoneWords('guest_power', args, {
        ok: true,
        isError: true,
        content: '{"error":"pve-02 isn’t connected."}',
      }),
    ).toBe('I couldn’t restart web on pve-02: pve-02 isn’t connected.');
    expect(serversDoneWords('guest_power', args, { ok: false, message: 'Couldn’t reach it.' })).toBe(
      'I couldn’t restart web on pve-02: Couldn’t reach it.',
    );
  });

  it('averages a long history into at most 60 points', () => {
    const series = Array.from({ length: 120 }, (_, i) => (i % 2 ? i : null));
    const out = downsample(series);
    expect(out).toHaveLength(60);
    expect(out[0]).toBe(1);
    expect(downsample([1, null, 3])).toEqual([1, null, 3]);
  });
});

describe('a server’s mark (MK-01)', () => {
  const server = (platform: HostServer['platform'], os: string | null) =>
    ({
      id: 'pve-02',
      name: 'pve-02',
      status: 'ok',
      platform,
      os,
      guests: [],
      cpuPct: 10,
      memory: { usedPct: 20 },
      temperature: null,
    }) as unknown as HostServer;

  it('is what it runs: Proxmox, its Linux, else a server', () => {
    expect(serverThing(server('proxmox', 'Debian GNU/Linux 12 (bookworm)')).icon).toBe('proxmox');
    expect(serverThing(server('standard', 'Debian GNU/Linux 13 (trixie)')).icon).toBe('debian');
    expect(serverThing(server('standard', null)).icon).toBe('server');
  });

  it('says why it isn’t fine, from the service’s note (SB-03)', () => {
    const filling = { ...server('standard', null), status: 'warn', statusNote: 'filling up' } as HostServer;
    expect(serverThing(filling).reason).toBe('Filling up');
    expect(serverThing({ ...filling, status: 'ok' } as HostServer).reason).toBeUndefined();
    expect(serverThing({ ...filling, statusNote: null } as HostServer).reason).toBeUndefined();
  });
});
