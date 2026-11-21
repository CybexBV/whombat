/**
 * The backup place's two lines on a NAS's page (backup-places.md BPL-11): both start off; the cleanup line when it is
 * off, failed or late, the space line when room runs low; none for a place set up by hand.
 */
import { BACKUP_PLACE_TEXT, type BackupPlaceKept } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { KindModule } from '../../things/kinds/registry';
import { nasPlaceChecks, nasPlaceLines, withPlaceLines } from './watch';

const NOW = new Date('2026-11-20T12:00:00Z');
const place = { name: 'Vault', cleanupAt: new Date('2026-11-03T12:00:00Z'), byHand: false };
const kept = (
  over: Partial<BackupPlaceKept['cleanup']> = {},
  free: number | null = 500e9,
): BackupPlaceKept => ({
  usedBytes: 100e9,
  freeBytes: free,
  cleanup: { on: true, keepDays: 90, lastAt: '2026-11-17T03:00:00Z', ok: true, ...over },
  byHand: false,
});
const checks = (lines: { check?: string }[]) => lines.map((l) => l.check);

describe('nasPlaceLines', () => {
  it('nothing while the cleanup runs weekly and there is room', () => {
    expect(nasPlaceLines('truenas', place, kept(), NOW)).toEqual([]);
  });

  it('the cleanup line when it is off, failed or hasn’t run for more than nine days', () => {
    expect(checks(nasPlaceLines('truenas', place, kept({ on: false }), NOW))).toEqual([
      'truenas.backup_cleanup',
    ]);
    expect(checks(nasPlaceLines('synology', place, kept({ ok: false }), NOW))).toEqual([
      'synology.backup_cleanup',
    ]);
    expect(checks(nasPlaceLines('qnap', place, kept({ lastAt: '2026-11-05T00:00:00Z' }), NOW))).toEqual([
      'qnap.backup_cleanup',
    ]);
    // Never ran yet, and set up less than nine days ago: not late.
    const fresh = { ...place, cleanupAt: new Date('2026-11-15T12:00:00Z') };
    expect(nasPlaceLines('qnap', fresh, kept({ lastAt: null, ok: null }), NOW)).toEqual([]);
    const [line] = nasPlaceLines('truenas', place, kept({ on: false }), NOW);
    expect(line?.title).toBe(BACKUP_PLACE_TEXT.watch.cleanupTitle('Vault'));
  });

  it('the space line when room runs low', () => {
    expect(checks(nasPlaceLines('truenas', place, kept({}, 15e9), NOW))).toEqual(['truenas.backup_space']);
    expect(nasPlaceLines('truenas', place, kept({}, null), NOW)).toEqual([]);
  });

  it('nothing for a place set up by hand, or without what it keeps', () => {
    expect(nasPlaceLines('truenas', { ...place, byHand: true }, kept({ on: false }), NOW)).toEqual([]);
    expect(nasPlaceLines('truenas', place, null, NOW)).toEqual([]);
  });
});

describe('the switches', () => {
  it('both start off and are added to the kind’s own', () => {
    expect(nasPlaceChecks('synology').map((c) => c.startsOn)).toEqual([false, false]);
    const module = { page: async () => ({}), checks: [{ check: 'synology.x' }] } as unknown as KindModule;
    expect(withPlaceLines('synology', module).checks?.map((c) => c.check)).toEqual([
      'synology.x',
      'synology.backup_cleanup',
      'synology.backup_space',
    ]);
  });
});
