/**
 * Backup files over the session (contracts 0.79, CT-335; Whombat backup-file.md BF-10; feature `backup.file`). The REST
 * contract `api.backups` (`@whombat/core/contracts`) gives the session ops `backups.*`; the bytes move in streams, not
 * in requests (a 64 KiB CONTROL message can't carry them):
 *
 * Download (a file the caller made, `ready` and not expired):
 *   `open{stream, spec: {kind: 'download', resource: {type: 'backup-file', burrow, backupFileId}, range?}}` →
 *   `opened{meta: {kind: 'download', size, range, contentType: 'application/vnd.whombat.backup', name, sha256}}`, the
 *   bytes, `stream_done{size, sha256}`. Resumable: open again with `range.start` = the bytes already kept. Refused
 *   (`stream_refused`, `details.code`): `backup_file.expired` (gone or past its 24 hours), `backup_file.people_only`,
 *   `not_found` (no such file of the caller's).
 *
 * Upload (to restore):
 * 1. `backups.stage {params: {burrow}, body: {fileName, size, sha256}}` → `{upload: {id: stagedBackupId, …}}` (owners;
 *    `backup_file.too_large`, `too_many`, `no_room`). The sha256 is optional.
 * 2. `open{stream, spec: {kind: 'upload', target: {type: 'backup-file', burrow, stagedBackupId}, size, sha256?,
 *    chunkSize}}` with exactly the staged size (and sha256, when staged with one; a box at session minor
 *    `BACKUP_UPLOAD_UNHASHED_MINOR` or later takes it without, and hashes the file itself once it is all there): else `stream_refused`,
 *    `details.code: backup_file.upload_mismatch`. Reopening the same target resumes after the last acknowledged chunk
 *    (`opened.meta.received`), as for attachments. `stream_done.output` is `BackupFileStagedUploadOutput`; the upload is
 *    then `uploaded`. An expired or used upload: `backup_file.upload_expired`.
 * 3. `backups.inspect` (the preview) and `backups.restore` (the job), both secret ops: the password never lands in a
 *    receipt, and neither is resent by a client after a lost answer (`backups.getRestore` / `backups.list` say whether
 *    the restore started).
 */
import { StagedBackupId } from '@whombat/core/ids';
import { z } from 'zod';
import { UPLOAD_MAX_FILE_BYTES } from '../limits.js';

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The session minor from which a box takes a backup file's upload without the whole file's sha256 up front
 * (`StreamSpec.upload.sha256` absent, Whombat backup-options.md CT-1695): the app then reads the file once, not twice.
 */
export const BACKUP_UPLOAD_UNHASHED_MINOR = 7;

/** The session's ceiling for a backup file: the upload protocol's largest file (core's `BACKUP_FILE_MAX_BYTES`). */
export const BACKUP_FILE_SESSION_MAX_BYTES = UPLOAD_MAX_FILE_BYTES;

/** `stream_done.output` of a `backup-file` upload: the file is complete and its sha256 checked. */
export const BackupFileStagedUploadOutput = z.object({
  stagedBackupId: StagedBackupId,
  size: z.number().int().min(1).max(UPLOAD_MAX_FILE_BYTES),
  sha256: Sha256Hex,
});
export type BackupFileStagedUploadOutput = z.infer<typeof BackupFileStagedUploadOutput>;
