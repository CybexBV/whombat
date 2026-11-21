import { BACKUP_FILE_ERROR_CODES, BACKUP_FILE_MAX_BYTES } from '@whombat/core/backup';
import { describe, expect, it } from 'vitest';
import { UPLOAD_MAX_FILE_BYTES } from '../limits.js';
import { BACKUP_FILE_SESSION_MAX_BYTES, BackupFileStagedUploadOutput } from './backup-file.js';
import { APP_ERROR_CODES } from './errors.js';
import { Open, StreamSpec } from './messages.js';
import { OPERATION_SAFETY, resendAfterNotFound } from './operation-safety.js';
import { createOperationAllowlist, SECRET_API_OPS } from './operations.js';

describe('backup files over the session (CT-335)', () => {
  it('fits the upload protocol', () => {
    expect(BACKUP_FILE_MAX_BYTES).toBe(UPLOAD_MAX_FILE_BYTES);
    expect(BACKUP_FILE_SESSION_MAX_BYTES).toBe(UPLOAD_MAX_FILE_BYTES);
  });

  it('downloads and uploads backup files in streams', () => {
    expect(
      StreamSpec.safeParse({
        kind: 'download',
        resource: { type: 'backup-file', burrow: 'lumio-bv', backupFileId: 'bkf_q3Vx9LpA0dZk' },
        range: { start: 1_048_576 },
      }).success,
    ).toBe(true);
    const open = Open.parse({
      t: 'open',
      stream: 5,
      spec: {
        kind: 'upload',
        target: { type: 'backup-file', burrow: 'lumio-bv', stagedBackupId: 'bku_T7mW2bNcYe12' },
        size: 6_442_450_944,
        sha256: 'ab'.repeat(32),
        chunkSize: 4_194_304,
      },
    });
    expect(open.spec.kind).toBe('upload');
    expect(
      StreamSpec.safeParse({
        kind: 'download',
        resource: { type: 'backup-file', burrow: 'lumio-bv', backupFileId: 'att_wrong' },
      }).success,
    ).toBe(false);
    expect(
      BackupFileStagedUploadOutput.safeParse({ stagedBackupId: 'bku_1', size: 10, sha256: 'cd'.repeat(32) })
        .success,
    ).toBe(true);
  });

  it('keeps the password out of receipts and never resends what carries it', () => {
    const allow = createOperationAllowlist();
    for (const op of ['backups.create', 'backups.inspect', 'backups.restore']) {
      expect(SECRET_API_OPS).toContain(op);
      expect(allow.get(op)?.secret, op).toBe(true);
      expect(allow.get(op)?.retry, op).toBe('never');
      expect(resendAfterNotFound(op), op).toBe(false);
    }
    expect(OPERATION_SAFETY['backups.restore'].destructive).toBe(false);
    expect(OPERATION_SAFETY['backups.remove']).toEqual({ destructive: true, retry: 'receipt' });
    expect(OPERATION_SAFETY['backups.removeUpload'].destructive).toBe(true);
    expect(resendAfterNotFound('backups.stage')).toBe(true);
    expect(allow.get('backups.stage')?.source).toBe('api');
  });

  it('names every backup-file error code and the feature', () => {
    for (const code of BACKUP_FILE_ERROR_CODES)
      expect(APP_ERROR_CODES, code).toHaveProperty(`backup_file.${code}`);
  });
});
