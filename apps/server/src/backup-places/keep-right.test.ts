/**
 * The keep-the-place-right job's pure parts (backup-options.md): when a place's cleanup is handed the person's keep
 * again, what a helper reports it keeps, and what an older helper is sent.
 */
import { describe, expect, it } from 'vitest';
import { cleanupBody, keepOfReport } from './hub';
import { longestKeepDays, type PlaceKeep } from './keep';
import { canRotate, cleanupDue, placeWords } from './keep-right';
import type { BackupPlaceRow } from './store';

const YEAR: PlaceKeep = { allDays: 2, dailyDays: 14, weeklyWeeks: 8, monthlyMonths: 12, limitBytes: null };
const NOW = new Date('2026-11-04T12:00:00Z');
const handed = (keep: PlaceKeep, windows: boolean, at = '2026-11-04T11:00:00Z') => ({ keep, windows, at });

describe('when the cleanup is handed the keep again', () => {
  it('when it never was, or was handed other windows or another limit', () => {
    expect(cleanupDue({ want: YEAR, handed: null, report: null, now: NOW })).toEqual({ due: true });
    expect(
      cleanupDue({ want: { ...YEAR, limitBytes: 5e10 }, handed: handed(YEAR, true), report: null, now: NOW })
        .due,
    ).toBe(true);
    expect(
      cleanupDue({ want: { ...YEAR, weeklyWeeks: 4 }, handed: handed(YEAR, true), report: null, now: NOW })
        .due,
    ).toBe(true);
    // The same keep, taken: nothing to do.
    expect(
      cleanupDue({ want: YEAR, handed: handed(YEAR, true), report: { set: true, keep: YEAR }, now: NOW }),
    ).toEqual({
      due: false,
    });
  });

  it('when the place says it has none, or keeps something else', () => {
    expect(
      cleanupDue({ want: YEAR, handed: handed(YEAR, true), report: { set: false, keep: null }, now: NOW }),
    ).toEqual({
      due: true,
      windows: false,
    });
    expect(
      cleanupDue({
        want: YEAR,
        handed: handed(YEAR, true),
        report: { set: true, keep: { ...YEAR, allDays: 90 } },
        now: NOW,
      }),
    ).toEqual({ due: true, windows: true });
  });

  it('an older helper: once a day, and with the windows as soon as it reports them (it was updated)', () => {
    const old = handed(YEAR, false);
    expect(cleanupDue({ want: YEAR, handed: old, report: { set: true, keep: null }, now: NOW }).due).toBe(
      false,
    );
    const dayLater = new Date(NOW.getTime() + 24 * 3_600_000);
    expect(cleanupDue({ want: YEAR, handed: old, report: { set: true, keep: null }, now: dayLater })).toEqual(
      {
        due: true,
        windows: false,
      },
    );
    expect(
      cleanupDue({
        want: YEAR,
        handed: old,
        report: { set: true, keep: { ...YEAR, allDays: 365 } },
        now: NOW,
      }),
    ).toEqual({ due: true, windows: true });
  });
});

describe('what a helper keeps and is sent', () => {
  it('reads the helper’s keep, or nothing from one that doesn’t report it', () => {
    expect(keepOfReport('2,14,56,12,0')).toEqual(YEAR);
    expect(keepOfReport('90')).toEqual({
      allDays: 90,
      dailyDays: 0,
      weeklyWeeks: 0,
      monthlyMonths: 0,
      limitBytes: null,
    });
    expect(keepOfReport('2,14,56,12,50000000000')?.limitBytes).toBe(50_000_000_000);
    expect(keepOfReport('')).toBeNull();
    expect(keepOfReport(null)).toBeNull();
    expect(keepOfReport('2,14')).toBeNull();
    expect(keepOfReport('x')).toBeNull();
  });

  it('an older helper gets the longest window as its days, never the 2 days of every backup', () => {
    expect(longestKeepDays(YEAR)).toBe(365);
    expect(longestKeepDays({ ...YEAR, monthlyMonths: 240 })).toBe(3650);
    expect(cleanupBody('pw', YEAR, false).keep_within_days).toBe(365);
    expect(cleanupBody('pw', YEAR, true)).toEqual({
      repository_password: 'pw',
      keep_within_days: 2,
      keep_daily_days: 14,
      keep_weekly_days: 56,
      keep_monthly_months: 12,
      limit_bytes: 0,
    });
  });
});

describe('who gives the backups a new password after a lost or stolen Whombat', () => {
  const row = (over: Partial<BackupPlaceRow>) =>
    ({ id: 'server:blackbox', name: 'BlackBox', byHand: false, ...over }) as BackupPlaceRow;
  it('Whombat, on a place it set up; never one set up by hand, only found, or none', () => {
    expect(canRotate(row({}))).toBe(true);
    expect(canRotate(row({ byHand: true }))).toBe(false);
    expect(canRotate(row({ id: 'found:192.168.1.40' }))).toBe(false);
    expect(canRotate(null)).toBe(false);
  });
  it('the place goes by its name, else the host and port the backup service shows', () => {
    expect(placeWords(row({}), 'rest:http://10.0.2.2:8747/x/')).toBe('BlackBox');
    expect(placeWords(null, 'rest:http://10.0.2.2:8747/rehearsal/')).toBe('10.0.2.2:8747');
    expect(placeWords(null, 'http://10.0.2.2:8747/rehearsal/')).toBe('10.0.2.2:8747');
    expect(placeWords(null, 'nas')).toBe('nas');
    expect(placeWords(null, null)).toBeNull();
  });
});
