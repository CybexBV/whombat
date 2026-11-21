/**
 * What the assistant proposes for this Whombat's backups (Whombat first-day.md, backup-places.md BPL-07), and the one
 * Inbox item it makes: the best backup place, a NAS the scan found, else a USB disk; also while backups go only to the
 * box's own disk.
 */
import { NeedsYouItem } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { firstBackupOutcome } from '../backup-places/first-backup';
import { sftpRepository } from '../managed/backup-tool';
import {
  BACKUP_REF,
  BACKUPS_HREF,
  backupProposal,
  backupProposalItem,
  changePasswordItem,
  FINISH_RESTORE_HREF,
  lateBackupItem,
  RESTORE_AGAIN_HREF,
  RESTORE_STOPPED_TEXT,
  restoreStoppedItem,
  restoreWaitingItem,
} from './box-backup';

const blackbox = { id: 'server:blackbox', name: 'BlackBox', state: 'ready' as const, address: '10.100.0.40' };
const synology = {
  id: 'found:192.168.1.40',
  name: 'Synology',
  state: 'connect_first' as const,
  address: '192.168.1.40',
};

describe('the proposal’s words (BPL-07)', () => {
  it('names a ready place, a NAS to connect, or a USB disk', () => {
    expect(backupProposal(blackbox).title).toContain('BlackBox');
    expect(backupProposal(blackbox).yes).toContain('BlackBox');
    expect(backupProposal(synology).title).toContain('Synology at 192.168.1.40');
    expect(backupProposal(synology).body).toContain('connect');
    expect(backupProposal(null).body).toContain('WHOMBAT-BACKUP');
  });

  it('says when backups are only on this Whombat’s own disk', () => {
    const own = backupProposal(blackbox, true);
    expect(own.title).toContain('own disk');
    expect(own.title).toContain('BlackBox');
    expect(backupProposal(null, true).title).toContain('USB disk');
  });

  it('is one item with the proposal, its yes in the person’s words, and where else it is done', () => {
    const item = backupProposalItem(blackbox, '2026-10-30T10:00:00.000Z');
    expect(NeedsYouItem.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      kind: 'backup',
      ref: BACKUP_REF,
      title: expect.stringContaining('BlackBox'),
    });
    expect(item.actions.map((a) => [a.label, a.kind])).toEqual([
      ['Yes, do it', 'ask'],
      ['See other places', 'open'],
    ]);
    expect(item.actions[0]?.text).toContain('BlackBox');
  });
});

describe('the SFTP repository the assistant sets', () => {
  it('uses restic’s two forms', () => {
    expect(sftpRepository('nas-01.lan', '/srv/whombat-backup')).toBe('sftp:nas-01.lan:/srv/whombat-backup');
    expect(sftpRepository('10.0.0.5', '/srv/whombat-backup', 2222)).toBe(
      'sftp://10.0.0.5:2222//srv/whombat-backup',
    );
  });
});

describe('backups failing or late, and a restore waiting (backup-options.md)', () => {
  const NOW = new Date('2026-11-04T12:00:00Z');
  const status = (state: 'protected' | 'failing' | 'stale', over: Record<string, unknown> = {}) => ({
    state,
    destination: { configured: true, kind: 'rest' },
    lastSuccess: { at: '2026-11-04T03:00:00Z' } as never,
    lastFailure: { at: '2026-11-04T11:55:00Z', stage: 'upload', reason: 'The place didn’t answer.' } as never,
    updatedAt: '2026-11-04T11:56:00Z',
    ...over,
  });

  it('says nothing for one failure the service tries again, nor while backups work', () => {
    const minutesAgo = (m: number) => NOW.getTime() - m * 60_000;
    expect(lateBackupItem(status('failing'), minutesAgo(15), NOW)).toBeNull();
    expect(lateBackupItem(status('protected'), null, NOW)).toBeNull();
    // Only this Whombat's own disk: that is the proposal's, not this.
    expect(
      lateBackupItem(status('stale', { destination: { configured: true, kind: 'local' } }), null, NOW),
    ).toBeNull();
  });

  it('one item for backups failing 45 minutes or late, the assistant offered, its curly quotes kept', () => {
    const failing = lateBackupItem(status('failing'), NOW.getTime() - 50 * 60_000, NOW);
    expect(failing && NeedsYouItem.parse(failing)).toEqual(failing);
    expect(failing).toMatchObject({ kind: 'alert', severity: 'bad', nature: 'you', fixable: true });
    expect(failing?.body).toContain('didn’t answer');
    const late = lateBackupItem(status('stale'), null, NOW);
    expect(late).toMatchObject({ severity: 'warn', fixable: true });
    // The same episode is the same item (an Ignore lasts it); a new one after a backup worked is new.
    expect(late?.ref).toEqual(failing?.ref);
    expect(
      lateBackupItem(status('stale', { lastSuccess: { at: '2026-11-04T09:00:00Z' } }), null, NOW)?.ref,
    ).not.toEqual(late?.ref);
  });

  it('a bring back a restart stopped is an item for a day that opens a new try; a refusal is not', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    const stopped = {
      phase: 'failed' as const,
      since: '2026-11-04T10:00:00Z',
      reason: 'interrupted',
      error: 'This Whombat restarted before the restore finished. Try again.',
    };
    const item = restoreStoppedItem(stopped, now);
    expect(item && NeedsYouItem.parse(item)).toEqual(item);
    expect(item?.body).toBe(stopped.error);
    expect(item?.actions[0]).toMatchObject({ kind: 'open', href: RESTORE_AGAIN_HREF });
    expect(restoreStoppedItem({ ...stopped, error: null }, now)?.body).toBe(RESTORE_STOPPED_TEXT.body);
    expect(restoreStoppedItem({ ...stopped, reason: 'no_space' }, now)).toBeNull();
    expect(restoreStoppedItem(stopped, new Date('2026-11-05T11:00:00Z'))).toBeNull();
  });

  it('a restore waiting for its answer is one item that opens where it finishes', () => {
    expect(restoreWaitingItem({ phase: 'released', since: null })).toBeNull();
    const item = restoreWaitingItem({ phase: 'checking', since: '2026-11-04T10:00:00Z' });
    expect(item && NeedsYouItem.parse(item)).toEqual(item);
    expect(item?.actions[0]).toMatchObject({ kind: 'open', href: FINISH_RESTORE_HREF });
  });
});

describe('telling the first backup (backup-options.md)', () => {
  const NOW = new Date('2026-11-04T12:00:00Z');
  const note = { since: '2026-11-04T11:00:00Z' };
  it('done or failed once it ended after the yes; dropped after a day', () => {
    const at = (iso: string) => ({ at: iso }) as never;
    expect(
      firstBackupOutcome(note, { lastSuccess: at('2026-11-04T11:05:00Z'), lastFailure: null }, NOW),
    ).toBe('done');
    expect(
      firstBackupOutcome(
        note,
        { lastSuccess: at('2026-11-04T09:00:00Z'), lastFailure: at('2026-11-04T11:04:00Z') },
        NOW,
      ),
    ).toBe('failed');
    expect(
      firstBackupOutcome(note, { lastSuccess: at('2026-11-04T09:00:00Z'), lastFailure: null }, NOW),
    ).toBeNull();
    expect(firstBackupOutcome(note, null, new Date('2026-11-05T12:00:00Z'))).toBe('drop');
  });
});

describe('a password only the person can change', () => {
  it('one calm item naming the place, that opens Backups; set up by hand says to set it up again', () => {
    const typed = changePasswordItem({
      since: '2026-11-04T12:00:00Z',
      place: '10.0.2.2:8747',
      byHand: false,
    });
    expect(NeedsYouItem.parse(typed)).toBeTruthy();
    expect(typed).toMatchObject({ kind: 'backup', severity: 'info', nature: 'you', href: BACKUPS_HREF });
    expect(typed.title).toContain('10.0.2.2:8747');
    expect(typed.actions).toEqual([expect.objectContaining({ kind: 'open', href: BACKUPS_HREF })]);
    const byHand = changePasswordItem({ since: '2026-11-04T12:00:00Z', place: 'BlackBox', byHand: true });
    expect(byHand.body).toContain('by hand');
    expect(typed.body).not.toContain('by hand');
  });
});
