/** An Incus instance and server on the phone as view models (app docs/decisions/incus-unraid-mobile.md AP-1617…). */
import type { HostBackupVolume, HostGuest, HostGuestConfig, HostIncusDetail } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { followWords, taskWord } from './guest-mobile';
import {
  backupGuestName,
  expiryWords,
  incusBackupRows,
  incusEditDraft,
  incusEditStart,
  incusFacts,
  incusHeadLine,
  incusHintWayOut,
  incusNewNameError,
  incusPoolRows,
  incusReviewLines,
  incusReviewNote,
  incusScheduleLine,
  incusSettingGroups,
  incusValueWords,
  isSelfGuest,
  memoryValue,
  noScheduleGuests,
  phoneIncusTabs,
  scheduleChoices,
  scheduleWordsIncus,
  selfAllowsAction,
  selfAllowsOp,
  stoppedCheck,
  taskPlatform,
  thisWhombatFact,
} from './incus-mobile';

const NOW = Date.parse('2026-10-17T12:02:00Z');
const TZ = 'Europe/Amsterdam';
const DAY = 86_400_000;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(/ /g, ' '));

const guest = (over: Partial<HostGuest> = {}): HostGuest => ({
  id: 'incus:web',
  serverId: 'thetitan',
  name: 'web',
  platform: 'incus',
  kind: 'container',
  image: 'images:debian/13',
  state: 'running',
  cpuPct: 1,
  memoryUsedMb: 300,
  memoryLimitMb: 2048,
  uptimeS: 3600,
  console: { available: true },
  ...over,
});

const cfg = (over: Partial<HostGuestConfig> = {}): HostGuestConfig => ({
  platform: 'incus',
  kind: 'container',
  digest: 'e1',
  running: true,
  values: {
    'limits.memory': '4GiB',
    'limits.cpu': '2',
    'boot.autostart': 'true',
    'snapshots.schedule': '0 3 * * *',
    'snapshots.expiry': '1w',
    description: 'The web server',
    'device.root': 'type=disk,pool=default,path=/,size=20GiB',
  },
  inherited: [],
  restricted: ['security.privileged'],
  profiles: ['default'],
  ...over,
});

describe('the guest this Whombat runs in (IU-02)', () => {
  const self = guest({ id: 'incus:whombat-dev-box', name: 'whombat-dev-box', kind: 'vm', self: true });

  it('hides what would change it and keeps snapshots, backups and a copy', () => {
    expect(isSelfGuest(self)).toBe(true);
    expect(isSelfGuest(guest())).toBe(false);
    for (const a of ['stop', 'shutdown', 'reboot', 'force_stop', 'snapshot_restore'] as const)
      expect(selfAllowsAction(self, a)).toBe(false);
    expect(selfAllowsAction(self, 'snapshot_create')).toBe(true);
    expect(selfAllowsAction(self, 'snapshot_delete')).toBe(true);
    for (const op of ['config.set', 'guest.rename', 'guest.delete', 'guest.autostart'] as const)
      expect(selfAllowsOp(self, op)).toBe(false);
    expect(selfAllowsOp(self, 'backup.create')).toBe(true);
    expect(selfAllowsOp(self, 'guest.clone')).toBe(true);
    expect(selfAllowsOp(self, 'backup.restore')).toBe(false);
    expect(selfAllowsOp(self, 'backup.restore', true)).toBe(true);
    // Any other guest: everything.
    expect(selfAllowsOp(guest(), 'guest.delete')).toBe(true);
  });

  it('says on the server that this Whombat runs there', () => {
    expect(thisWhombatFact(true, [guest(), self])).toEqual({
      label: 'This Whombat',
      value: 'Runs here, in whombat-dev-box',
    });
    expect(thisWhombatFact(true, [])).toEqual({ label: 'This Whombat', value: 'Runs here' });
    expect(thisWhombatFact(false, [guest()])).toBeNull();
  });
});

describe('an Incus instance’s screen (IU-09)', () => {
  it('gets five tabs with Manage on, the Summary alone without', () => {
    expect(phoneIncusTabs({ manageable: true })).toEqual([
      'summary',
      'settings',
      'snapshots',
      'backups',
      'tasks',
    ]);
    expect(phoneIncusTabs({ manageable: false })).toEqual(['summary']);
  });

  it('names its server and a project other than default; the kind is the mark (AP-1810)', () => {
    expect(incusHeadLine(guest())).toBe('thetitan');
    expect(incusHeadLine(guest({ kind: 'vm', project: 'ci-platform' }))).toBe(
      'thetitan · project ci-platform',
    );
    expect(incusHeadLine(guest({ project: 'default' }))).toBe('thetitan');
  });

  it('reads tasks by their platform', () => {
    expect(taskPlatform('incus:2b1c')).toBe('incus');
    expect(taskPlatform('unraid:0123456789abcdef')).toBe('unraid');
    expect(taskPlatform('UPID:pve-02:000:vzdump')).toBe('pve');
  });
});

describe('Incus values in words', () => {
  it('says memory, processors and the schedule in the web’s words', () => {
    expect(plain(incusValueWords('limits.memory', '4GiB'))).toBe('4 GiB');
    expect(plain(incusValueWords('limits.memory', '50%'))).toBe('50 % of the server’s');
    expect(incusValueWords('limits.memory', undefined)).toBe('No limit');
    expect(incusValueWords('limits.cpu', '4')).toBe('4 CPUs');
    expect(incusValueWords('limits.cpu', '0-3')).toBe('CPUs 0-3');
    expect(incusValueWords('limits.cpu', '')).toBe('No limit');
    expect(scheduleWordsIncus('0 3 * * *')).toBe('Every day at 03:00');
    expect(scheduleWordsIncus('30 2 * * 0')).toBe('Sundays at 02:30');
    expect(scheduleWordsIncus('0 */6 * * *')).toBe('Every 6 hours');
    expect(scheduleWordsIncus('')).toBe('None');
    expect(expiryWords('1w')).toBe('kept 1 week');
    expect(expiryWords('1w 2d')).toBe('kept 1 week 2 days');
    expect(expiryWords('')).toBe('kept until removed');
    expect(incusScheduleLine(cfg())).toEqual({ text: 'Every day at 03:00 · kept 1 week', set: true });
    expect(incusScheduleLine(cfg({ values: {} }))).toEqual({ text: 'No schedule', set: false });
  });
});

describe('an Incus instance’s Settings (IU-09)', () => {
  it('reads six groups with the everyday edits, locks and profile keys', () => {
    const groups = plain(
      incusSettingGroups(
        cfg({ inherited: ['limits.cpu'], values: { ...cfg().values, 'security.privileged': 'true' } }),
      ),
    );
    expect(groups.map((g) => g.title)).toEqual([
      'Resources',
      'Boot',
      'Security',
      'Snapshots',
      'Notes',
      'Profiles',
    ]);
    const rows = Object.fromEntries(groups.flatMap((g) => g.rows).map((r) => [r.id, r]));
    expect(rows.memory).toMatchObject({ label: 'Memory', value: '4 GiB', edit: 'memory' });
    expect(rows.cpu).toMatchObject({ value: '2 CPUs', edit: 'cpu', sub: 'From a profile' });
    expect(rows.root).toMatchObject({ label: 'Root disk', value: '20 GiB on default' });
    expect(rows.autostart).toMatchObject({ value: 'Yes', edit: 'autostart' });
    expect(rows.protection).toMatchObject({ value: 'Off', edit: 'protection' });
    expect(rows.nesting).toMatchObject({ value: 'Off' });
    expect(rows.privileged).toMatchObject({ locked: true, sub: 'Change this with the incus command' });
    expect(rows.privileged?.edit).toBeUndefined();
    expect(rows.schedule).toMatchObject({
      value: 'Every day at 03:00',
      sub: 'Kept 1 week',
      edit: 'schedule',
    });
    expect(rows.description).toMatchObject({ value: 'The web server', edit: 'description' });
    expect(rows.profiles).toMatchObject({ value: 'default' });
  });
});

describe('the everyday edits and their review', () => {
  it('writes memory in Incus units and calls the same amount no change', () => {
    const c = cfg();
    expect(incusEditStart(c, 'memory').text).toBe('4096');
    expect(incusEditDraft(c, 'memory', { ...incusEditStart(c, 'memory') }).draft).toEqual({});
    const d = incusEditDraft(c, 'memory', { ...incusEditStart(c, 'memory'), text: '8192' });
    expect(d.draft).toEqual({ set: { 'limits.memory': '8GiB' } });
    expect(plain(incusReviewLines(c, d.draft ?? {}))).toEqual([
      { key: 'limits.memory', label: 'Memory', old: '4 GiB', new: '8 GiB' },
    ]);
    expect(incusEditDraft(c, 'memory', { ...incusEditStart(c, 'memory'), text: '32' }).error).toBe(
      'At least 64.',
    );
    expect(memoryValue(1536)).toBe('1536MiB');
    // Empty: no limit, sent as “” (Incus removes a key set to nothing).
    expect(incusEditDraft(c, 'memory', { ...incusEditStart(c, 'memory'), text: '' }).draft).toEqual({
      set: { 'limits.memory': '' },
    });
  });

  it('sets processors, start with the server and protection', () => {
    const c = cfg();
    expect(incusEditDraft(c, 'cpu', { ...incusEditStart(c, 'cpu'), text: '4' }).draft).toEqual({
      set: { 'limits.cpu': '4' },
    });
    expect(incusEditDraft(c, 'cpu', { ...incusEditStart(c, 'cpu'), text: '0' }).error).toBe('At least 1.');
    expect(incusEditDraft(c, 'autostart', { ...incusEditStart(c, 'autostart'), on: false }).draft).toEqual({
      set: { 'boot.autostart': 'false' },
    });
    // Unset (as it was) and left off: no change.
    const unset = cfg({ values: {} });
    expect(incusEditDraft(unset, 'autostart', incusEditStart(unset, 'autostart')).draft).toEqual({});
    expect(incusEditDraft(c, 'protection', { ...incusEditStart(c, 'protection'), on: true }).draft).toEqual({
      set: { 'security.protection.delete': 'true' },
    });
    const review = incusReviewLines(c, { set: { 'security.protection.delete': 'true' } });
    expect(review).toEqual([
      { key: 'security.protection.delete', label: 'Protection', old: 'Off', new: 'Can’t be deleted' },
    ]);
  });

  it('sets and removes the snapshot schedule', () => {
    const c = cfg();
    const start = incusEditStart(c, 'schedule');
    expect(start).toMatchObject({ schedule: '0 3 * * *', expiry: '1w' });
    expect(incusEditDraft(c, 'schedule', { ...start, schedule: '@hourly', expiry: '1d' }).draft).toEqual({
      set: { 'snapshots.schedule': '@hourly', 'snapshots.expiry': '1d' },
    });
    expect(incusEditDraft(c, 'schedule', { ...start, schedule: '' }).draft).toEqual({
      set: { 'snapshots.schedule': '' },
    });
    expect(incusEditDraft(c, 'schedule', { ...start, expiry: '' }).draft).toEqual({
      set: { 'snapshots.expiry': '' },
    });
    // A schedule from a profile can't be switched off here; another one of its own is kept as a choice.
    expect(scheduleChoices(cfg({ inherited: ['snapshots.schedule'] })).map((c2) => c2.value)).not.toContain(
      '',
    );
    expect(scheduleChoices(cfg({ values: { 'snapshots.schedule': '0 1 * * 1' } }))[0]).toEqual({
      value: '0 1 * * 1',
      label: 'Mondays at 01:00',
    });
  });

  it('notes that a running VM may take memory and processors later', () => {
    const vm = cfg({ kind: 'vm' });
    expect(incusReviewNote(vm, { set: { 'limits.memory': '8GiB' } })).toMatch(/next restart/);
    expect(incusReviewNote(vm, { set: { description: 'x' } })).toBeNull();
    expect(incusReviewNote(cfg(), { set: { 'limits.memory': '8GiB' } })).toBeNull();
  });
});

describe('names, copies and restores', () => {
  it('checks Incus names', () => {
    expect(incusNewNameError('web-2')).toBeNull();
    expect(incusNewNameError('2web')).toBe('Start with a letter.');
    expect(incusNewNameError('web', [], 'web')).toBe('That’s its name now.');
    expect(incusNewNameError('db', ['db'])).toBe('There’s already a guest called db.');
    expect(stoppedCheck(guest())).toBe('Shut web down first.');
    expect(stoppedCheck(guest({ state: 'stopped' }))).toBeNull();
  });
});

describe('Incus backups (IU-04)', () => {
  const b = (d: number, over: Partial<HostBackupVolume> = {}): HostBackupVolume => ({
    volume: `whombat-2026101${7 - d}-0200`,
    storage: 'incus',
    guest: 'incus:web',
    created: new Date(NOW - d * DAY - 10 * 3600_000).toISOString(),
    sizeBytes: 1.2 * 1024 ** 3,
    format: 'optimized',
    expiresAt: new Date(NOW + (7 - d) * DAY).toISOString(),
    ...over,
  });

  it('lists them newest first with size, format and how long they are kept', () => {
    const rows = plain(incusBackupRows([b(2), b(0, { format: 'tar', expiresAt: null })], NOW, TZ));
    expect(rows.map((r) => r.title)).toEqual(['Today 04:02', 'Thu 04:02']);
    expect(rows[0]?.line).toBe('1.2 GiB · kept until deleted');
    expect(rows[1]?.line).toBe('1.2 GiB · expires in 5 days');
    expect(backupGuestName({ guest: 'incus:web' }, [guest()])).toBe('web');
    expect(backupGuestName({ guest: 'runner' }, [])).toBe('runner');
  });
});

describe('tasks and what a change says (IU-07)', () => {
  it('words Incus operations and the new ops', () => {
    expect(taskWord('Backing up instance')).toBe('Backup');
    expect(taskWord('Restoring snapshot')).toBe('Back to a snapshot');
    expect(taskWord('Restarting instance')).toBe('Restart');
    expect(taskWord('guest.rename')).toBe('Rename');
    expect(taskWord('parity.start')).toBe('Parity check');
    expect(taskWord('vzdump')).toBe('Backup');
    expect(taskWord('something')).toBe('something');
  });

  it('says when a rename, a copy and a restore start and end', () => {
    expect(followWords('guest.rename', 'web', 'web-2')).toEqual({
      started: 'Renaming web started.',
      done: 'web is called web-2 now.',
      failed: 'Renaming web didn’t work.',
    });
    expect(followWords('guest.copy', 'web').done).toBe('The copy of web is ready.');
    expect(followWords('backup.restore_new', 'web', 'web-restored').done).toBe('web-restored is ready.');
    expect(followWords('parity.start', 'blackbox').done).toBe('The parity check on blackbox is running.');
    expect(followWords('container.update', 'blackbox', 'plex').done).toBe(
      'plex on blackbox is up to date now.',
    );
    expect(followWords('plugin.update', 'blackbox').done).toBe('blackbox’s plugins are up to date now.');
    expect(followWords('plugin.update', 'blackbox', 'Unassigned Devices').failed).toBe(
      'Updating Unassigned Devices didn’t work.',
    );
    expect(followWords('disk.spin_down', 'blackbox', 'Disk 2').done).toBe('Disk 2 is spun down.');
  });
});

describe('an Incus server', () => {
  const incus: HostIncusDetail = {
    version: '6.0.4',
    clustered: false,
    projects: [
      { name: 'default', description: '', instances: 5, running: 4 },
      { name: 'ci-platform', description: '', instances: 4, running: 2 },
    ],
    pools: [
      {
        name: 'default',
        driver: 'zfs',
        status: 'Created',
        description: '',
        usedBytes: 90 * 1024 ** 3,
        totalBytes: 1.45 * 1024 ** 4,
        volumes: 17,
      },
      {
        name: 'ci-nvme',
        driver: 'zfs',
        status: 'Created',
        description: '',
        usedBytes: 880 * 1024 ** 3,
        totalBytes: 1000 * 1024 ** 3,
        volumes: 19,
      },
    ],
    networks: [
      {
        name: 'incusbr0',
        type: 'bridge',
        managed: true,
        description: '',
        ipv4: '10.62.50.1/24',
        ipv6: null,
        nat: true,
        usedBy: 3,
      },
      {
        name: 'eno1',
        type: 'physical',
        managed: false,
        description: '',
        ipv4: null,
        ipv6: null,
        nat: null,
        usedBy: 0,
      },
    ],
    profiles: [{ name: 'default', project: 'default', description: '', usedBy: 5 }],
    images: [],
    volumes: [],
  };

  it('has its facts and its pools with their use', () => {
    expect(incusFacts(incus)).toEqual([
      { label: 'Incus', value: '6.0.4' },
      { label: 'Projects', value: 'default, ci-platform' },
      { label: 'Images', value: 'None' },
      { label: 'Profiles', value: 'default' },
      { label: 'Networks', value: 'incusbr0' },
    ]);
    const pools = plain(incusPoolRows(incus));
    expect(pools[0]).toMatchObject({ name: 'default', line: 'zfs · 17 volumes', tone: null });
    expect(pools[0]?.usedText).toBe('90 GiB of 1.4 TiB used');
    expect(pools[1]).toMatchObject({ tone: 'warn' });
  });

  it('opens a guest’s Snapshots for “no snapshot schedule”', () => {
    expect(incusHintWayOut('incus.no_snapshots')).toEqual({ label: 'Set a schedule', to: 'snapshots' });
    expect(incusHintWayOut('incus.pool_full')).toBeNull();
    const hints = [
      {
        serverId: 'thetitan',
        kind: 'incus.no_snapshots',
        severity: 'info' as const,
        entity: 'incus:web',
        title: 'web has no snapshot schedule',
        detail: '',
        section: 'guests',
      },
      {
        serverId: 'thetitan',
        kind: 'incus.no_snapshots',
        severity: 'info' as const,
        entity: 'db',
        title: '',
        detail: '',
        section: 'guests',
      },
    ];
    const db = guest({ id: 'incus:db', name: 'db' });
    expect(noScheduleGuests(hints, 'thetitan', [guest(), db]).map((g) => g.name)).toEqual(['web', 'db']);
    expect(noScheduleGuests(hints, 'pve-02', [guest(), db])).toEqual([]);
  });
});
