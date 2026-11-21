/**
 * The list of backups a page at a time (backup-options.md CT-1690) and the one answer after a restore (CT-1692).
 */
import type { BackupCheckpoint } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { answers, cursorOf, pageOf } from './backup-options';

const cp = (i: number): BackupCheckpoint => ({
  id: `ck-${i}`,
  seq: i,
  snapshotId: `s${i}`,
  createdAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
  reason: 'scheduled',
  schemaVersion: 1,
  bytes: 1,
  bytesAdded: null,
  applianceId: 'wb',
  own: true,
  check: null,
});

describe('pages of backups', () => {
  const all = Array.from({ length: 120 }, (_, i) => cp(i));

  it('newest first, a page at a time, to the end', () => {
    const first = pageOf(all, undefined, 50);
    expect(first.total).toBe(120);
    expect(first.checkpoints.map((c) => c.id).slice(0, 2)).toEqual(['ck-119', 'ck-118']);
    const second = pageOf(all, first.nextCursor ?? undefined, 50);
    expect(second.checkpoints[0]?.id).toBe('ck-69');
    const third = pageOf(all, second.nextCursor ?? undefined, 50);
    expect(third.checkpoints).toHaveLength(20);
    expect(third.nextCursor).toBeNull();
  });

  it('a cursor whose backup was cleared meanwhile goes on from its time', () => {
    const cursor = cursorOf(cp(60));
    const without = all.filter((c) => c.id !== 'ck-60');
    expect(pageOf(without, cursor, 5).checkpoints[0]?.id).toBe('ck-59');
  });
});

describe('the one answer after a restore', () => {
  it('lost or stolen rotates; the rest is Whombat’s, with notes the service keeps', () => {
    const lost = answers({ oldWhombat: 'lost' });
    expect(lost.find(([item]) => item === 'old-appliance')?.[1]).toBe('credentials-rotated');
    expect(answers({ oldWhombat: 'gone' }).find(([item]) => item === 'old-appliance')?.[1]).toBe(
      'decommissioned',
    );
    for (const [, , note] of lost) expect(note).toMatch(/^[\x20-\x7e]*$/);
  });
});
