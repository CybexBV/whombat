/**
 * The web's Backups pieces (app backup-options.md AP-6803): what the options dialog's Save sends, the older backups'
 * range and a backup's title.
 */
import { BACKUP_KEEP_90_DAYS, BACKUP_KEEP_YEAR, BACKUP_POLICY_DEFAULT } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { backupWhen, draftInput, draftOf, localRange } from './backupOptionsModel';

describe('the options dialog', () => {
  it('starts from the policy and sends it back unchanged', () => {
    const d = draftOf(BACKUP_POLICY_DEFAULT);
    expect(d.keep).toBe('year');
    expect(draftInput(d)).toEqual({
      frequency: '6h',
      keep: BACKUP_KEEP_YEAR,
      limitBytes: null,
      weeklyCheck: true,
    });
  });

  it('sends Choose…’s fields within bounds and a limit of at least 1 GB', () => {
    const d = draftOf({ ...BACKUP_POLICY_DEFAULT, keep: BACKUP_KEEP_90_DAYS });
    expect(d.keep).toBe('days90');
    const input = draftInput({
      ...d,
      keep: 'custom',
      custom: { allDays: '0', dailyDays: '30', weeklyWeeks: 'x', monthlyMonths: '999' },
      limitOn: true,
      limitGb: '0.2',
    });
    expect(input.keep).toEqual({ allDays: 1, dailyDays: 30, weeklyWeeks: 0, monthlyMonths: 240 });
    expect(input.limitBytes).toBe(1_000_000_000);
  });
});

describe('words', () => {
  it('gives the older backups’ range and a backup’s title', () => {
    expect(localRange({ oldest: '2026-10-20T03:00:00Z', newest: '2026-11-03T03:00:00Z' })).toBe(
      '20 Oct – 3 Nov',
    );
    const now = new Date(2026, 10, 3, 12, 0);
    expect(backupWhen(new Date(2026, 10, 3, 3, 0).toISOString(), now)).toBe('Today, 03:00');
    expect(backupWhen(new Date(2026, 10, 2, 21, 0).toISOString(), now)).toBe('Yesterday, 21:00');
    expect(backupWhen(new Date(2026, 9, 20, 3, 0).toISOString(), now)).toBe('20 October, 03:00');
  });
});
