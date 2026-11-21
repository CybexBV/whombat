/**
 * Backup files made before conversations lost their members (docs/decisions/membership.md MB-13) still restore: a
 * `conversation` record that lists its members reads as one without them, so the restore makes the room as any other.
 */
import { parseBackupRecord } from '@whombat/core';
import { describe, expect, it } from 'vitest';

describe('a file with members in it', () => {
  it('reads a conversation record that still lists its members, without them', () => {
    const parsed = parseBackupRecord('messages', {
      type: 'conversation',
      id: 'cnv_feat-a',
      kind: 'branch',
      slug: 'feat-a',
      title: 'feat-a',
      repo: null,
      prNumber: null,
      members: ['prn_mara', 'prn_dusty', 'prn_joris'],
      createdAt: '2026-10-01T09:00:00.000Z',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record).toMatchObject({ type: 'conversation', id: 'cnv_feat-a', kind: 'branch' });
    expect(parsed.record).not.toHaveProperty('members');
  });
});
