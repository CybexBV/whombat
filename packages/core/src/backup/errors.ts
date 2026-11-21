/**
 * What can go wrong with a backup file, in one plain sentence each (contracts 0.79, CT-335; Whombat backup-file.md).
 *
 * The container and tar code throw `BackupFileError` with one of these codes; the server answers the REST error whose
 * `error.code` is `BACKUP_FILE_ERROR_STATUS[code]` with `error.message` = `backupFileErrorText(code)` and
 * `error.details.code` = `backup_file.<code>` (`backupAppErrorCode`), and a failed job carries `{code, message}` in its
 * view. Clients show the message and branch on the code (`backupFileErrorOf(details)`).
 */
import { z } from 'zod';
import type { ErrorCode } from '../contracts/errors.js';

export const BACKUP_FILE_ERROR_CODES = [
  /** The password is shorter than `BACKUP_PASSWORD_MIN` characters (or longer than the maximum). */
  'password_too_short',
  /** The key check in the header doesn't match: wrong password (or a deliberately altered header). */
  'wrong_password',
  /** A chunk didn't authenticate, the file ends early, the header checksum fails, the tar or a record is broken. */
  'damaged',
  /** A newer container version, format id or schema version than this Whombat reads. */
  'newer_format',
  /** No backup-file magic at the start: some other file. */
  'not_backup_file',
  /** Larger than `BACKUP_FILE_MAX_BYTES`, or than an entry or record may be. */
  'too_large',
  /** Not enough free disk for the file (making) or for the upload and what it restores (restoring). */
  'no_room',
  /** The backup file is past its 24 hours (or was removed) and can't be downloaded any more. */
  'expired',
  /** The staged upload is past its 24 hours, or was used or removed. */
  'upload_expired',
  /** Inspect or restore before the upload finished. */
  'upload_incomplete',
  /** A chunk doesn't continue where the upload is, or the bytes don't match the announced size or sha256. */
  'upload_mismatch',
  /** No category chosen. */
  'nothing_chosen',
  /** A category asked to restore that the file doesn't hold. */
  'not_in_file',
  /** A backup file is being made in this burrow already. */
  'busy',
  /** A restore is running in this burrow already. */
  'restore_running',
  /** Already `BACKUP_FILES_MAX` files (or `BACKUP_UPLOADS_MAX` uploads) kept: remove one first. */
  'too_many',
  /** An agent asked (people-only). */
  'people_only',
  /** Making the file stopped (the job's `error`). */
  'failed',
  /** The restore stopped part-way (the job's `error`); what came back stays. */
  'restore_failed',
] as const;
export const BackupFileErrorCode = z.enum(BACKUP_FILE_ERROR_CODES);
export type BackupFileErrorCode = z.infer<typeof BackupFileErrorCode>;

/** The sentence a person reads for each code (the spec's three verbatim: wrong password, damaged, newer format). */
export const BACKUP_FILE_ERROR_TEXT: Readonly<Record<BackupFileErrorCode, string>> = {
  password_too_short: 'Use a password of at least 10 characters.',
  wrong_password: 'That password doesn’t open this file.',
  damaged: 'This file is damaged or incomplete.',
  newer_format: 'This file was made by a newer Whombat. Update this one first.',
  not_backup_file: 'This isn’t a Whombat backup file.',
  too_large: 'This file is too large for a backup file.',
  no_room: 'There isn’t enough room on this Whombat for that. Free up some space and try again.',
  expired: 'This backup file isn’t here any more. Files are kept for 24 hours, so make a new one.',
  upload_expired: 'That upload isn’t here any more. Upload the file again.',
  upload_incomplete: 'The file hasn’t finished uploading yet.',
  upload_mismatch: 'The upload doesn’t match the file. Upload it again.',
  nothing_chosen: 'Choose at least one thing.',
  not_in_file: 'That isn’t in this file.',
  busy: 'A backup file is being made already. Wait for it to finish.',
  restore_running: 'A restore is running already. Wait for it to finish.',
  too_many: 'There are already too many backup files here. Remove one first.',
  people_only: 'Only you can make or restore backup files, not the agent.',
  failed: 'Something went wrong while making the file. Try again.',
  restore_failed:
    'The restore stopped part-way. What came back stays, and trying again brings back the rest.',
};

/** The REST `error.code` (and so the HTTP status) each code is answered with. */
export const BACKUP_FILE_ERROR_STATUS: Readonly<Record<BackupFileErrorCode, ErrorCode>> = {
  password_too_short: 'validation_failed',
  wrong_password: 'validation_failed',
  damaged: 'bad_request',
  newer_format: 'bad_request',
  not_backup_file: 'bad_request',
  too_large: 'too_large',
  no_room: 'too_large',
  expired: 'expired',
  upload_expired: 'expired',
  upload_incomplete: 'conflict',
  upload_mismatch: 'conflict',
  nothing_chosen: 'validation_failed',
  not_in_file: 'validation_failed',
  busy: 'conflict',
  restore_running: 'conflict',
  too_many: 'conflict',
  people_only: 'forbidden',
  failed: 'internal',
  restore_failed: 'internal',
};

/** Namespace of the codes in `error.details.code` (REST and session). */
export const BACKUP_APP_ERROR_PREFIX = 'backup_file.';

/** `backup_file.wrong_password`: the `error.details.code` for a code. */
export function backupAppErrorCode(code: BackupFileErrorCode): string {
  return `${BACKUP_APP_ERROR_PREFIX}${code}`;
}

/** The code in an error's `details` (`{code: 'backup_file.damaged'}`), or null. */
export function backupFileErrorOf(details: unknown): BackupFileErrorCode | null {
  if (typeof details !== 'object' || details === null) return null;
  const code = (details as { code?: unknown }).code;
  if (typeof code !== 'string' || !code.startsWith(BACKUP_APP_ERROR_PREFIX)) return null;
  const parsed = BackupFileErrorCode.safeParse(code.slice(BACKUP_APP_ERROR_PREFIX.length));
  return parsed.success ? parsed.data : null;
}

/** The sentence for a code. */
export function backupFileErrorText(code: BackupFileErrorCode): string {
  return BACKUP_FILE_ERROR_TEXT[code];
}

/** A job's or an answer's error as views carry it. */
export const BackupFileProblem = z.object({ code: BackupFileErrorCode, message: z.string().max(500) });
export type BackupFileProblem = z.infer<typeof BackupFileProblem>;

/** `{code, message}` for a code. */
export function backupFileProblem(code: BackupFileErrorCode): BackupFileProblem {
  return { code, message: BACKUP_FILE_ERROR_TEXT[code] };
}

/**
 * Thrown by the container, tar and record readers. `detail` is for logs only (never shown: it may name an entry or a
 * byte offset); the person reads `backupFileErrorText(code)`.
 */
export class BackupFileError extends Error {
  constructor(
    readonly code: BackupFileErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `backup file ${code}: ${detail}` : `backup file ${code}`);
    this.name = 'BackupFileError';
  }
}

/** Whether `e` is a `BackupFileError` (also across bundled copies of this module). */
export function isBackupFileError(e: unknown): e is BackupFileError {
  return (
    e instanceof BackupFileError ||
    (typeof e === 'object' &&
      e !== null &&
      (e as { name?: unknown }).name === 'BackupFileError' &&
      BackupFileErrorCode.safeParse((e as { code?: unknown }).code).success)
  );
}
