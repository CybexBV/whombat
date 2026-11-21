/**
 * Backup files over REST (contracts 0.79.0, CT-335; Whombat docs/decisions/backup-file.md BF-01…): Settings → Backups'
 * two panels, “Download a backup” and “Restore from a file”. Session ops too (`backups.*`, feature `backup.file`).
 *
 * Who: burrow owners, people only (BF-01) — never agents (no MCP tool, no keys-engine path). Everything else answers
 * `forbidden` with `backup_file.owners_only`. A backup file, an upload and a restore belong to the owner who made them:
 * only they see, download or remove them (other owners hear about a file with sign-ins in their assistant DM, BF-08).
 *
 * Making a file: `backups.estimate` (what each category holds, what stays private) → `backups.create {categories,
 * password}` starts a job (`BackupFileView`, `status: making` with `progress`; `backups.changed` events) → when `ready`,
 * download the bytes from `BACKUP_FILE_TRANSFER.download` (Range, resumable) or a session `download` stream
 * (`DownloadResource {type: 'backup-file'}`). Kept 24 hours (`BACKUP_FILE_TTL_S`) or until `backups.remove`.
 *
 * Restoring: `backups.stage {fileName, size, sha256?}` → upload the bytes in chunks to `BACKUP_FILE_TRANSFER.upload`
 * (`Content-Range`, resumable from `backups.getUpload`'s `received`) or a session `upload` stream (`UploadTarget {type:
 * 'backup-file'}`) → `backups.inspect {password}` (the preview: per category New / Already here / Different) →
 * `backups.restore {password, categories, onDifferent}` starts a job (`BackupRestoreView`; its `summary` when done). The
 * upload is deleted when the restore finishes, after 24 hours, or with `backups.removeUpload`.
 *
 * The password travels only in `create`, `inspect` and `restore` (secret session ops, CT-44): never stored, logged or
 * kept in a receipt (BF-06).
 */
import { z } from 'zod';
import {
  BACKUP_CATEGORY_IDS,
  BackupCategoryEstimate,
  BackupCategoryId,
  BackupCategoryList,
} from '../backup/categories.js';
import { BACKUP_PASSWORD_MAX, BACKUP_PASSWORD_MIN, backupPasswordLength } from '../backup/container.js';
import { BACKUP_FILE_ERROR_TEXT, BackupFileProblem } from '../backup/errors.js';
import { BACKUP_FILE_MAX_BYTES } from '../backup/manifest.js';
import {
  BackupOnDifferent,
  BackupRestorePreview,
  BackupRestoreSummary,
  BackupServersChoice,
} from '../backup/restore.js';
import { Count, Sha256Hex, Timestamp } from '../domain/common.js';
import { BackupFileId, BackupRestoreId, StagedBackupId } from '../ids.js';
import { API_PREFIX, BurrowParam, endpoint } from './endpoint.js';
import { OkResponse } from './errors.js';

/* Limits the server enforces --------------------------------------------------------------------------------- */

/** A made file is kept this long for download (BF-10), then removed (its view goes with it). */
export const BACKUP_FILE_TTL_S = 86_400;
/** A staged upload is kept this long (BF-10), or until its restore finishes. */
export const BACKUP_UPLOAD_TTL_S = 86_400;
/** Backup files kept per burrow at a time, making or ready (`backup_file.too_many`). */
export const BACKUP_FILES_MAX = 5;
/** Staged uploads per person and burrow at a time (`backup_file.too_many`). */
export const BACKUP_UPLOADS_MAX = 3;
/** The chunk a client sends per REST upload request (8 MiB), and the most one may carry (16 MiB). */
export const BACKUP_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const BACKUP_UPLOAD_CHUNK_MAX_BYTES = 16 * 1024 * 1024;
/** Restores `backups.list` shows (the caller's, newest first, from the last 24 hours). */
export const BACKUP_RESTORES_LISTED = 10;

/** A file's password (BF-06): at least `BACKUP_PASSWORD_MIN` characters (code points, NFC). Never stored. */
export const BackupPassword = z
  .string()
  .refine(
    (p) => backupPasswordLength(p) >= BACKUP_PASSWORD_MIN && backupPasswordLength(p) <= BACKUP_PASSWORD_MAX,
    BACKUP_FILE_ERROR_TEXT.password_too_short,
  );

/* Views ----------------------------------------------------------------------------------------------------- */

/** Most categories a list holds (eleven since 0.117). */
const CATEGORIES_MAX = BACKUP_CATEGORY_IDS.length;

/**
 * The burrow's default ticks (BF-09). `custom`: an owner chose them (“Make these the default”); false: the starting ones
 * (`BACKUP_DEFAULT_CATEGORIES`, nine since 0.117, BF-21) this Whombat offers (`backupOfferedDefaults`).
 */
export const BackupDefaults = z.object({
  categories: z.array(BackupCategoryId).max(CATEGORIES_MAX),
  custom: z.boolean(),
  updatedAt: Timestamp.nullable(),
});
export type BackupDefaults = z.infer<typeof BackupDefaults>;

/**
 * What a file would hold, per category, for the caller (`backups.estimate`): every category in order, with its count
 * and estimated bytes (the meta line is `backupCategoryMeta(estimate)`, the size `formatBackupSize(bytes)`, the button
 * `backupDownloadLabel(sum of the ticked)`). `freeBytes`: room on the Whombat for the file (null when unknown).
 */
export const BackupEstimate = z.object({
  categories: z.array(BackupCategoryEstimate).max(CATEGORIES_MAX),
  freeBytes: Count.nullable(),
  maxBytes: Count,
  generatedAt: Timestamp,
});
export type BackupEstimate = z.infer<typeof BackupEstimate>;

/** A job's progress: `done` of `total` steps (records and bytes, the server's measure), the category it is at. */
export const BackupProgress = z.object({
  done: Count,
  total: Count,
  step: BackupCategoryId.nullable(),
});
export type BackupProgress = z.infer<typeof BackupProgress>;

export const BACKUP_FILE_STATUSES = ['making', 'ready', 'failed'] as const;
export const BackupFileStatus = z.enum(BACKUP_FILE_STATUSES);
export type BackupFileStatus = z.infer<typeof BackupFileStatus>;

/**
 * A backup file the caller made. `name`: `lumio-bv-2026-10-11.wbk` (`backupFileName`). `size` and `sha256` once
 * `ready`; `downloadUrl` (`BACKUP_FILE_TRANSFER.download`) then too. `expiresAt`: 24 hours after it was ready. `error`:
 * why making it failed (`backup_file.failed`, `no_room`, …).
 */
export const BackupFileView = z.object({
  id: BackupFileId,
  name: z.string().min(1).max(255),
  status: BackupFileStatus,
  progress: BackupProgress.nullable(),
  categories: z.array(BackupCategoryId).min(1).max(CATEGORIES_MAX),
  includesSecrets: z.boolean(),
  size: Count.nullable(),
  sha256: Sha256Hex.nullable(),
  createdAt: Timestamp,
  readyAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
  error: BackupFileProblem.nullable(),
  downloadUrl: z.string().min(1).max(300).nullable(),
});
export type BackupFileView = z.infer<typeof BackupFileView>;

export const BACKUP_UPLOAD_STATUSES = ['uploading', 'uploaded'] as const;
export const BackupUploadStatus = z.enum(BACKUP_UPLOAD_STATUSES);
export type BackupUploadStatus = z.infer<typeof BackupUploadStatus>;

/**
 * A file the caller is uploading (or uploaded) to restore. `received`: bytes stored so far, where the next chunk
 * starts. `uploadUrl`: `BACKUP_FILE_TRANSFER.upload` for it; `chunkBytes` the chunk to send, at most
 * `maxChunkBytes`.
 */
export const BackupUploadView = z.object({
  id: StagedBackupId,
  fileName: z.string().min(1).max(255),
  size: Count,
  received: Count,
  status: BackupUploadStatus,
  sha256: Sha256Hex.nullable(),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  uploadUrl: z.string().min(1).max(300),
  chunkBytes: Count,
  maxChunkBytes: Count,
});
export type BackupUploadView = z.infer<typeof BackupUploadView>;

export const BACKUP_RESTORE_STATUSES = ['restoring', 'done', 'failed'] as const;
export const BackupRestoreStatus = z.enum(BACKUP_RESTORE_STATUSES);
export type BackupRestoreStatus = z.infer<typeof BackupRestoreStatus>;

/**
 * A restore the caller started. `upload` is null once the upload was deleted (after the restore). `madeAt` and
 * `sourceName` are the file's (for “Restoring the backup made on 11 Oct”). `summary` once `done` (and what a `failed`
 * one got to); `error` why it stopped (`backup_file.restore_failed`, …).
 */
export const BackupRestoreView = z.object({
  id: BackupRestoreId,
  upload: StagedBackupId.nullable(),
  fileName: z.string().min(1).max(255),
  madeAt: Timestamp,
  sourceName: z.string().min(1).max(200),
  categories: z.array(BackupCategoryId).min(1).max(CATEGORIES_MAX),
  onDifferent: BackupOnDifferent,
  status: BackupRestoreStatus,
  progress: BackupProgress.nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  summary: BackupRestoreSummary.nullable(),
  error: BackupFileProblem.nullable(),
});
export type BackupRestoreView = z.infer<typeof BackupRestoreView>;

/* Bodies ---------------------------------------------------------------------------------------------------- */

export const SetBackupDefaultsBody = z.strictObject({ categories: BackupCategoryList });
export type SetBackupDefaultsBody = z.infer<typeof SetBackupDefaultsBody>;

/** `backups.create`. Refusals: `nothing_chosen`, `password_too_short`, `busy`, `too_many`, `no_room`. */
export const CreateBackupFileBody = z.strictObject({
  categories: BackupCategoryList,
  password: BackupPassword,
});
export type CreateBackupFileBody = z.infer<typeof CreateBackupFileBody>;

/**
 * `backups.stage`: the file to upload. `size` at most `BACKUP_FILE_MAX_BYTES` (`too_large`); `sha256` of the whole file,
 * when the client has it (a session upload stream always carries one; the upload must then match it). Refusals:
 * `too_large`, `too_many`, `no_room`.
 */
export const StageBackupUploadBody = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  size: z.number().int().min(1).max(BACKUP_FILE_MAX_BYTES),
  sha256: Sha256Hex.optional(),
});
export type StageBackupUploadBody = z.infer<typeof StageBackupUploadBody>;

/**
 * `backups.inspect`: the password opens the file and the server reads it to its end (every chunk authenticated) before
 * answering. Refusals: `upload_incomplete`, `upload_expired`, `wrong_password`, `damaged`, `newer_format`,
 * `not_backup_file`.
 */
export const InspectBackupBody = z.strictObject({ password: BackupPassword });
export type InspectBackupBody = z.infer<typeof InspectBackupBody>;

/**
 * `backups.restore`: what to bring back (categories the file holds; `not_in_file` otherwise) and, for things that are
 * here and differ, keep or replace. `servers` (0.117, BF-15): the answer to the address question; absent, the servers
 * are pointed here when the preview asked. Refusals as `inspect`, and `restore_running`, `no_room`.
 */
export const RestoreBackupBody = z.strictObject({
  password: BackupPassword,
  categories: BackupCategoryList,
  onDifferent: BackupOnDifferent.default('keep'),
  servers: BackupServersChoice.optional(),
});
export type RestoreBackupBody = z.infer<typeof RestoreBackupBody>;

export const BackupFileResponse = z.object({ file: BackupFileView });
export const BackupUploadResponse = z.object({ upload: BackupUploadView });
export const BackupRestoreResponse = z.object({ restore: BackupRestoreView });
export const BackupListResponse = z.object({
  files: z.array(BackupFileView).max(50),
  uploads: z.array(BackupUploadView).max(50),
  restores: z.array(BackupRestoreView).max(BACKUP_RESTORES_LISTED),
});
export type BackupListResponse = z.infer<typeof BackupListResponse>;

/* Endpoints ------------------------------------------------------------------------------------------------- */

const B = z.object({ burrow: BurrowParam });
const BF = B.extend({ backupFileId: BackupFileId });
const BU = B.extend({ stagedBackupId: StagedBackupId });

export const backupEndpoints = {
  defaults: endpoint({
    id: 'backups.defaults',
    method: 'GET',
    path: '/burrows/:burrow/backups/defaults',
    summary:
      'The burrow’s default ticks for a new backup file (BF-09): the starting ones this Whombat offers until the person chose others.',
    params: B,
    response: BackupDefaults,
  }),
  setDefaults: endpoint({
    id: 'backups.setDefaults',
    method: 'PUT',
    path: '/burrows/:burrow/backups/defaults',
    summary: '“Make these the default”: the categories a new backup file starts with in this burrow.',
    params: B,
    body: SetBackupDefaultsBody,
    response: BackupDefaults,
  }),
  estimate: endpoint({
    id: 'backups.estimate',
    method: 'GET',
    path: '/burrows/:burrow/backups/estimate',
    summary: 'What each category would put in a file made now: counts, estimated bytes, and the room left.',
    params: B,
    response: BackupEstimate,
  }),
  list: endpoint({
    id: 'backups.list',
    method: 'GET',
    path: '/burrows/:burrow/backups',
    summary:
      'The caller’s backup files (making, ready or failed, newest first), uploads waiting for a restore, and restores of the last 24 hours.',
    params: B,
    response: BackupListResponse,
  }),
  create: endpoint({
    id: 'backups.create',
    method: 'POST',
    path: '/burrows/:burrow/backups',
    summary:
      'Start making an encrypted backup file of the chosen categories with this password. A signed event; when it holds sign-ins the other owners are told. Follow `backups.get` or `backups.changed`.',
    params: B,
    body: CreateBackupFileBody,
    response: BackupFileResponse,
    status: 201,
  }),
  get: endpoint({
    id: 'backups.get',
    method: 'GET',
    path: '/burrows/:burrow/backups/:backupFileId',
    summary:
      'One of the caller’s backup files: progress while it is made, then its size, expiry and download link.',
    params: BF,
    response: BackupFileResponse,
  }),
  remove: endpoint({
    id: 'backups.remove',
    method: 'DELETE',
    path: '/burrows/:burrow/backups/:backupFileId',
    summary:
      'Delete one of the caller’s backup files now (stops one being made); otherwise it goes after 24 hours.',
    params: BF,
    response: OkResponse,
  }),
  stage: endpoint({
    id: 'backups.stage',
    method: 'POST',
    path: '/burrows/:burrow/backup-uploads',
    summary:
      'Reserve an upload of a backup file to restore: checks the size and the room, answers where to send the chunks. Also the stage op of a session `upload` stream (`UploadTarget {type: backup-file}`).',
    params: B,
    body: StageBackupUploadBody,
    response: BackupUploadResponse,
    status: 201,
  }),
  getUpload: endpoint({
    id: 'backups.getUpload',
    method: 'GET',
    path: '/burrows/:burrow/backup-uploads/:stagedBackupId',
    summary:
      'One of the caller’s uploads: how many bytes arrived (resume from `received`) and whether it is complete.',
    params: BU,
    response: BackupUploadResponse,
  }),
  removeUpload: endpoint({
    id: 'backups.removeUpload',
    method: 'DELETE',
    path: '/burrows/:burrow/backup-uploads/:stagedBackupId',
    summary:
      '“Cancel” in the restore panel: delete an upload the caller staged (not while its restore runs).',
    params: BU,
    response: OkResponse,
  }),
  inspect: endpoint({
    id: 'backups.inspect',
    method: 'POST',
    path: '/burrows/:burrow/backup-uploads/:stagedBackupId/inspect',
    summary:
      'Open an uploaded file with its password and say what a restore would do: per category new, already here and different, people to invite, notes. Changes nothing.',
    params: BU,
    body: InspectBackupBody,
    response: BackupRestorePreview,
  }),
  restore: endpoint({
    id: 'backups.restore',
    method: 'POST',
    path: '/burrows/:burrow/backup-uploads/:stagedBackupId/restore',
    summary:
      'Start restoring the chosen categories of an uploaded file: adds and updates through the commit pipeline, never deletes; automations come back switched off. A signed event. Follow `backups.getRestore` or `backups.changed`.',
    params: BU,
    body: RestoreBackupBody,
    response: BackupRestoreResponse,
    status: 201,
  }),
  getRestore: endpoint({
    id: 'backups.getRestore',
    method: 'GET',
    path: '/burrows/:burrow/backup-restores/:restoreId',
    summary: 'One of the caller’s restores: progress, then what came back and what needs them.',
    params: B.extend({ restoreId: BackupRestoreId }),
    response: BackupRestoreResponse,
  }),
};

/* Raw transfers --------------------------------------------------------------------------------------------- */

/**
 * `Content-Range` of a chunk upload (`bytes 0-8388607/52428800`), and of a 206 download answer. `end` is exclusive
 * here; the header's last byte is `end - 1`.
 */
export function backupContentRange(start: number, end: number, size: number): string {
  return `bytes ${start}-${end - 1}/${size}`;
}

/** `bytes a-b/n` → `{start: a, end: b + 1, size: n}`, or null. */
export function parseBackupContentRange(header: string): { start: number; end: number; size: number } | null {
  const m = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]) + 1;
  const size = Number(m[3]);
  return start < end && end <= size ? { start, end, size } : null;
}

/** 409 details when a chunk doesn't start where the upload is (`backup_file.upload_mismatch`): resume at `received`. */
export const BackupUploadMismatchDetails = z.object({
  code: z.literal('backup_file.upload_mismatch'),
  received: Count,
});
export type BackupUploadMismatchDetails = z.infer<typeof BackupUploadMismatchDetails>;

/**
 * Byte transfers: raw routes beside the JSON API (like `ATTACHMENT_TRANSFER`), the same owner-only rule.
 *
 * - `download` (GET and HEAD) — the file's bytes while it is `ready` and not expired (410 `backup_file.expired`
 *   otherwise). `Accept-Ranges: bytes`; `Range: bytes=a-` / `bytes=a-b` answers 206 with `Content-Range` (one range only;
 *   416 outside the file); `If-Range` with the ETag. Headers: `Content-Type: application/vnd.whombat.backup`,
 *   `Content-Disposition: attachment; filename="<name>"`, `Content-Length`, `ETag: "<sha256>"`, `X-Whombat-Sha256`
 *   (the whole file), `Cache-Control: private, no-store`. A broken download resumes with a Range from what arrived.
 * - `upload` (PUT) — one chunk of a staged upload: the raw bytes, `Content-Range: bytes <start>-<last>/<size>`
 *   (`backupContentRange`), `Content-Length` = the chunk, at most `BACKUP_UPLOAD_CHUNK_MAX_BYTES`, optionally
 *   `X-Whombat-Sha256` of the chunk (checked: 409 `upload_mismatch`). `start` must be the upload's `received` and
 *   `<size>` its staged size (409 `backup_file.upload_mismatch` with `BackupUploadMismatchDetails` otherwise: resume
 *   there). Answers `BackupUploadResponse` with the new `received`; after the last chunk the server checks the whole
 *   file (its sha256 when staged with one) and the upload is `uploaded`. Repeating a chunk that already arrived (start
 *   below `received`, the same bytes) answers the current state without writing.
 */
export const BACKUP_FILE_TRANSFER = {
  download: {
    method: 'GET',
    base: API_PREFIX,
    path: '/burrows/:burrow/backups/:backupFileId/content',
  },
  upload: {
    method: 'PUT',
    base: API_PREFIX,
    path: '/burrows/:burrow/backup-uploads/:stagedBackupId/content',
    response: BackupUploadResponse,
  },
} as const;

function fill(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
}

/** `/api/v1/burrows/{slug}/backups/{id}/content`: `BackupFileView.downloadUrl`. */
export function backupDownloadUrl(burrow: string, backupFileId: string): string {
  const t = BACKUP_FILE_TRANSFER.download;
  return `${t.base}${fill(t.path, { burrow, backupFileId })}`;
}

/** `/api/v1/burrows/{slug}/backup-uploads/{id}/content`: `BackupUploadView.uploadUrl`. */
export function backupUploadUrl(burrow: string, stagedBackupId: string): string {
  const t = BACKUP_FILE_TRANSFER.upload;
  return `${t.base}${fill(t.path, { burrow, stagedBackupId })}`;
}
