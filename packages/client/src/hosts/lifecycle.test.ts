import type { HostGuest } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  addToBackupJobParams,
  backupJobCovers,
  backupJobIncludes,
  backupJobName,
  backupKeepText,
  backupScheduleText,
  guestHints,
  replicationScheduleText,
  ruleSummary,
  taskOutcomeText,
  taskStartedText,
  taskTypeText,
  taskWarnings,
  taskWhat,
} from './lifecycle';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const DAY = 86_400_000;

function guest(extra: Partial<HostGuest> = {}): HostGuest {
  return {
    id: 'pve:118',
    serverId: 'pve-02',
    name: 'web',
    platform: 'pve',
    kind: 'vm',
    image: '',
    state: 'running',
    cpuPct: 1,
    memoryUsedMb: 512,
    memoryLimitMb: 1024,
    uptimeS: 60,
    console: { available: true },
    backupJob: true,
    lastBackup: { result: 'ok', at: new Date(NOW - DAY).toISOString() },
    ...extra,
  };
}

describe('task words', () => {
  it('name a task and say how it went', () => {
    expect(taskTypeText('vzdump')).toBe('Backup');
    expect(taskTypeText('weird')).toBe('weird');
    const what = taskWhat('backup.create', 'web');
    expect(taskStartedText(what)).toBe('Backup of web started.');
    expect(taskOutcomeText(what, 'ok')).toBe('Backup of web finished.');
    expect(taskOutcomeText(what, 'warning', 'WARNINGS: 2')).toBe('Backup of web finished with 2 warnings.');
    expect(taskOutcomeText(what, 'warning', '')).toBe('Backup of web finished with warnings.');
    expect(taskOutcomeText(taskWhat('guest.clone', 'web'), 'error', "storage 'nas' does not exist\n")).toBe(
      "Clone of web failed: storage 'nas' does not exist.",
    );
    expect(taskOutcomeText(taskWhat('guest.clone', 'web'), 'error', '')).toBe('Clone of web failed.');
    expect(taskWarnings('WARNINGS: 1')).toBe(1);
    expect(taskWarnings('OK')).toBeNull();
  });
});

describe('guest hints', () => {
  it('give each Proxmox hint its way out', () => {
    expect(guestHints(guest(), NOW)).toEqual([]);
    expect(guestHints(guest({ backupJob: false }), NOW).map((h) => [h.fix, h.title])).toEqual([
      ['backup_job', 'No backup plan covers web'],
    ]);
    expect(
      guestHints(guest({ lastBackup: { result: 'ok', at: new Date(NOW - 10 * DAY).toISOString() } }), NOW)[0],
    ).toMatchObject({ fix: 'backup_now', title: 'Last backup 10 days ago' });
    expect(
      guestHints(
        guest({
          pendingChanges: 2,
          oldestSnapshot: new Date(NOW - 45 * DAY).toISOString(),
          guestAgent: 'not_running',
        }),
        NOW,
      ).map((h) => [h.fix, h.title]),
    ).toEqual([
      ['restart', '2 changes wait for a restart'],
      ['snapshots', 'A snapshot is 45 days old'],
      ['agent', 'It doesn’t report what’s inside'],
    ]);
    expect(guestHints(guest({ platform: 'docker', backupJob: false }), NOW)).toEqual([]);
  });
});

describe('firewall and replication words', () => {
  it('read a rule and a schedule', () => {
    expect(
      ruleSummary({ type: 'in', action: 'ACCEPT', enable: true, macro: 'SSH', source: '10.0.0.0/16' }),
    ).toBe('SSH from 10.0.0.0/16');
    expect(ruleSummary({ type: 'in', action: 'DROP', enable: true, proto: 'tcp', dport: '443' })).toBe(
      'tcp port 443',
    );
    expect(ruleSummary({ type: 'group', action: 'webservers', enable: true })).toBe(
      'the rules of webservers',
    );
    expect(replicationScheduleText('*/15')).toBe('every 15 min');
    expect(replicationScheduleText('02:00')).toBe('daily at 02:00');
    expect(replicationScheduleText('sat 03:00')).toBe('sat 03:00');
  });
});

describe('backup jobs', () => {
  const job = {
    id: 'backup-1',
    enabled: true,
    schedule: '02:00',
    storage: 'pbs',
    selection: 'all' as const,
    exclude: ['pve:123'],
    mode: 'snapshot' as const,
  };
  it('read a job in words', () => {
    expect(backupScheduleText('02:00')).toBe('Every day at 02:00');
    expect(backupScheduleText('4:30')).toBe('Every day at 04:30');
    expect(backupScheduleText('sun 03:00')).toBe('Sundays at 03:00');
    expect(backupScheduleText('mon..fri 22:00')).toBe('Weekdays at 22:00');
    expect(backupScheduleText('*/2:00')).toBe('*/2:00');
    expect(backupJobName(job)).toBe('Every day at 02:00 to pbs');
    expect(backupJobName({ ...job, comment: 'Nightly' })).toBe('Nightly');
    const names: Record<string, string> = {
      'pve:123': 'win11',
      'pve:1': 'a',
      'pve:2': 'b',
      'pve:3': 'c',
      'pve:4': 'd',
    };
    const nameOf = (id: string) => names[id] ?? id;
    expect(backupJobCovers(job, nameOf)).toBe('All guests but win11');
    expect(backupJobCovers({ ...job, exclude: [], node: 'pve-01' })).toBe('All guests on pve-01');
    expect(
      backupJobCovers({ ...job, selection: 'guests', guests: ['pve:1', 'pve:2', 'pve:3', 'pve:4'] }, nameOf),
    ).toBe('a, b and 2 more');
    expect(backupJobCovers({ ...job, selection: 'pool', pool: 'prod' })).toBe('Pool prod');
    expect(backupKeepText(null)).toBe('The storage decides');
    expect(backupKeepText({ last: 0, daily: 0 })).toBe('Keep every backup');
    expect(backupKeepText({ last: 7, daily: 14, weekly: 8 })).toBe('Last 7 · 14 daily · 8 weekly');
  });
  it('put a guest in a job', () => {
    expect(backupJobIncludes(job, 'pve:123')).toBe(false);
    expect(backupJobIncludes(job, 'pve:118')).toBe(true);
    expect(addToBackupJobParams(job, 'pve:123')).toEqual({ jobId: 'backup-1', exclude: [] });
    expect(addToBackupJobParams({ ...job, selection: 'guests', guests: ['pve:1'] }, 'pve:123')).toEqual({
      jobId: 'backup-1',
      guests: ['pve:1', 'pve:123'],
    });
    expect(addToBackupJobParams({ ...job, selection: 'pool' }, 'pve:123')).toBeNull();
    expect(addToBackupJobParams({ ...job, node: 'pve-01' }, 'pve:123', 'pve-02')).toBeNull();
  });
});
