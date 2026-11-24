import { HostBackupJob } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { backupPeriod, backupRhythm, DAY_MS } from './backup-rhythm';
import { backupNotice, machineCard } from './machine';
import { readFailedNotice } from './panels';

const job = HostBackupJob.parse({
  id: 'job-example',
  enabled: true,
  schedule: 'daily',
  storage: 'backups',
  selection: 'all',
  mode: 'snapshot',
});
const now = new Date('2026-11-24T14:02:00Z');
const machine = {
  name: 'Example machine',
  backupJob: true,
  lastBackup: { at: new Date(now.getTime() - 3 * DAY_MS).toISOString(), result: 'ok' },
  cpuPct: null,
  cores: null,
  memoryUsedGb: null,
  memoryTotalGb: null,
  diskUsedGb: null,
  diskTotalGb: null,
  series: null,
};

describe('backup coverage and age', () => {
  it('uses the longest gap in a schedule, and the shortest gap of the jobs that cover the machine', () => {
    expect(backupPeriod('mon..fri 03:00')).toBe(3 * DAY_MS);
    expect(backupPeriod('sat 03:00')).toBe(7 * DAY_MS);
    expect(backupPeriod('daily')).toBe(DAY_MS);
    expect(
      backupRhythm(
        [
          { ...job, enabled: false, schedule: 'hourly' },
          { ...job, node: 'other', schedule: 'hourly' },
          { ...job, schedule: 'hourly', exclude: ['pve:101'] },
          { ...job, schedule: 'weekly' },
          { ...job, selection: 'guests', guests: ['pve:101'] },
        ],
        { id: 'pve:101', node: 'example' },
      ),
    ).toBe(DAY_MS);
    expect(backupPeriod('unparsed')).toBeNull();
  });

  it('shows a fact even without other figures and only warns about covered backups that are overdue', () => {
    expect(machineCard(machine, machine, null, now, [], machine)?.items).toMatchObject([
      { id: 'backup', label: expect.stringContaining('3 days ago') },
    ]);
    const uncovered = { ...machine, backupJob: false, lastBackup: null };
    expect(machineCard(machine, machine, null, now, [], uncovered)?.items).toMatchObject([
      { id: 'backup', label: 'Nothing backs this up' },
    ]);
    expect(backupNotice({ ...machine, backupJob: false }, now)).toBeNull();
    expect(backupNotice({ ...machine, backupRhythmMs: DAY_MS }, now)?.check).toBe('machine.backup_old');
    expect(backupNotice({ ...machine, backupRhythmMs: 7 * DAY_MS }, now)).toBeNull();
    expect(backupNotice(machine, new Date(now.getTime() + 5 * DAY_MS))).toBeNull();
    expect(backupNotice(machine, new Date(now.getTime() + 5 * DAY_MS + 1))?.check).toBe('machine.backup_old');
  });

  it('uses the last successful backup for age and shows when the latest attempt failed', () => {
    const failed = {
      ...machine,
      backupRhythmMs: DAY_MS,
      lastBackup: { at: new Date(now.getTime() - 5 * 3_600_000).toISOString(), result: 'error' },
    };
    expect(machineCard(failed, failed, null, now, [], failed)?.items).toMatchObject([
      { id: 'backup', label: expect.stringContaining('failed 5 h ago') },
    ]);
    expect(backupNotice(failed, now)?.check).toBe('machine.backup_old');
    expect(backupNotice({ ...failed, lastSuccessfulBackupAt: machine.lastBackup.at }, now)?.check).toBe(
      'machine.backup_old',
    );
    expect(backupNotice({ ...failed, lastSuccessfulBackupAt: failed.lastBackup.at }, now)).toBeNull();
  });
});

it('shows prolonged read failure only after a full hour, in the person’s time zone', () => {
  const since = '2026-11-24T13:02:00Z';
  expect(readFailedNotice('Plex', since, new Date(now.getTime() - 1), 'Europe/Amsterdam')).toBeNull();
  expect(readFailedNotice('Plex', since, now, 'Europe/Amsterdam')).toMatchObject({
    check: 'conn.read_failed',
    nature: 'fyi',
    title: expect.stringContaining('14:02'),
  });
  expect(readFailedNotice('Plex', undefined, now, 'UTC')).toBeNull();
});
