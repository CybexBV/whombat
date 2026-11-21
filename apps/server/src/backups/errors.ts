/**
 * Backup-file refusals as REST/session errors (contracts CT-335): `error.code` from `BACKUP_FILE_ERROR_STATUS`, the
 * sentence from `backupFileErrorText`, `details.code` = `backup_file.<code>`. The container's `detail` (an entry name, a
 * chunk number) goes to the log only.
 */
import {
  BACKUP_FILE_ERROR_STATUS,
  type BackupFileErrorCode,
  type BackupFileProblem,
  backupAppErrorCode,
  backupFileErrorText,
  backupFileProblem,
  isBackupFileError,
  type JsonValue,
} from '@whombat/core';
import { ApiError } from '../lib/errors';

/** The REST error for a backup-file code (extra `details` beside `code`, e.g. `received`). */
export function backupError(code: BackupFileErrorCode, extra: Record<string, JsonValue> = {}): ApiError {
  return new ApiError(BACKUP_FILE_ERROR_STATUS[code], backupFileErrorText(code), {
    details: { code: backupAppErrorCode(code), ...extra },
  });
}

/** A container/tar/record error as the REST error; anything else is rethrown as is. */
export function asBackupError(err: unknown): unknown {
  if (isBackupFileError(err)) return backupError(err.code);
  return err;
}

/** The code behind an error, when it is a backup-file one. */
export function backupCodeOf(err: unknown): BackupFileErrorCode | null {
  if (isBackupFileError(err)) return err.code;
  if (err instanceof ApiError) {
    const details = err.extra.details as { code?: unknown } | undefined;
    if (typeof details?.code === 'string' && details.code.startsWith('backup_file.'))
      return details.code.slice('backup_file.'.length) as BackupFileErrorCode;
  }
  return null;
}

/** A job's `{code, message}`: the error's own code, else `fallback` (`failed`, `restore_failed`). */
export function problemOf(err: unknown, fallback: 'failed' | 'restore_failed'): BackupFileProblem {
  const code = backupCodeOf(err);
  return backupFileProblem(code && code !== 'people_only' ? code : fallback);
}
