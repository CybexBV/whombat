/**
 * The backup summary from the backup service's status (Whombat backup-options.md): the newer service's members
 * (`clearing`, `failedAttempts`, `lastSuccess.incomplete`) are read, never refused, and what a backup left out reaches
 * the summary in plain words.
 */
import { BackupScope, BackupServiceStatus, BackupStatus } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { summarizeBackup } from './summary.js';

const status = {
  kind: 'whombat.backup-status/1',
  state: 'protected',
  protected: true,
  destination: {
    configured: true,
    kind: 'rest',
    display: '10.0.0.4:8747',
    appendOnly: 'verified',
    repositoryId: 'r1',
  },
  lastSuccess: {
    id: 'ck-9',
    at: '2026-11-04T09:00:00Z',
    ageSeconds: 60,
    snapshotId: 'abcd',
    method: 'snapshot',
    quiesceHeldMs: 1,
    durationMs: 1,
    bytesAdded: 1,
    totalBytes: 1,
    files: 1,
    schemaVersion: 1,
    incomplete: {
      attachments: 2,
      servers: true,
      reason: "2 attachments weren't on this Whombat any more, so the backup doesn't have them.",
    },
  },
  lastFailure: null,
  lastAttemptOk: true,
  failedAttempts: 0,
  coverage: [],
  recoverability: { lastDrill: null },
  kitGeneration: 3,
  running: null,
  clearing: { by: 'destination', at: '2026-11-04T09:05:00Z', ok: true, bytes: 1234, overLimit: false },
  updatedAt: '2026-11-04T09:01:00Z',
};

describe('the backup summary (Whombat backup-options.md)', () => {
  it('reads the newer service’s members, and one it doesn’t know of them is no refusal', () => {
    const parsed = BackupServiceStatus.parse(status);
    expect(parsed.clearing?.by).toBe('destination');
    expect(parsed.failedAttempts).toBe(0);
    expect(BackupServiceStatus.safeParse({ ...status, clearing: { by: 'someone-new' } }).success).toBe(true);
    const { failedAttempts: _f, clearing: _c, ...older } = status;
    expect(BackupServiceStatus.safeParse(older).success).toBe(true);
  });

  it('says what the last backup left out, plainly, within the summary’s bounds', () => {
    const summary = summarizeBackup(BackupServiceStatus.parse(status), BackupScope.options);
    expect(BackupStatus.parse(summary)).toEqual(summary);
    expect(summary.incomplete).toEqual({
      reason: status.lastSuccess.incomplete.reason,
      attachments: 2,
      servers: true,
    });
    // Its own whitespace aside, the service's sentence is the summary's.
    const spaced = {
      ...status.lastSuccess,
      incomplete: { servers: true, reason: '  The servers   were left out. ' },
    };
    expect(
      summarizeBackup(BackupServiceStatus.parse({ ...status, lastSuccess: spaced }), BackupScope.options)
        .incomplete,
    ).toEqual({ reason: 'The servers were left out.', servers: true });
    const whole = { ...status.lastSuccess, incomplete: undefined };
    expect(
      summarizeBackup(BackupServiceStatus.parse({ ...status, lastSuccess: whole }), BackupScope.options)
        .incomplete,
    ).toBeUndefined();
  });
});
