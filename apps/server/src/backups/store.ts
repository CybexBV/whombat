/**
 * Backup files' rows as the contract's views, and who may touch them (docs/decisions/backup-file.md BF-01): the
 * person; a file, an upload and a restore are their maker's alone (anything else reads as not found).
 */
import {
  BACKUP_DEFAULT_CATEGORIES,
  BACKUP_RESTORES_LISTED,
  BACKUP_UPLOAD_CHUNK_BYTES,
  BACKUP_UPLOAD_CHUNK_MAX_BYTES,
  type BackupCategoryId,
  type BackupDefaults,
  type BackupFileView,
  type BackupRestoreView,
  type BackupUploadView,
  backupDownloadUrl,
  backupOfferedDefaults,
  backupUploadUrl,
  ID_PREFIXES,
} from '@whombat/core';
import { and, desc, eq, gt, inArray, isNull, notLike, or } from 'drizzle-orm';
import type { BurrowAccess } from '../auth/request';
import type { BurrowRow } from '../commit/types';
import type { Db } from '../db/client';
import { backupFiles, backupRestores, backupUploads } from '../db/schema/index';
import { notFound } from '../lib/errors';
import { iso } from '../lib/time';
import type { PrincipalRow } from '../read/principals';
import { backupError } from './errors';

/** A look's restore row names the look in place of an upload (`bkl_…`, backup-look.md). */
export const LOOK_PREFIX = `${ID_PREFIXES.backupLook}_`;

export type BackupFileRow = typeof backupFiles.$inferSelect;
export type BackupUploadRow = typeof backupUploads.$inferSelect;
export type BackupRestoreRow = typeof backupRestores.$inferSelect;

/** The caller, when they are a person (BF-01; one-person.md OP-S79); `people_only` otherwise. */
export function requirePerson(access: BurrowAccess): PrincipalRow {
  const p = access.principal;
  if (p.kind !== 'person') throw backupError('people_only');
  return p;
}

/**
 * The burrow's defaults (BF-09, BF-21): its own when the person saved them, else core's (messages and servers on), without
 * the categories this Whombat can't offer it (`offered`, BF-13).
 */
export function toDefaults(
  burrow: Pick<BurrowRow, 'backupDefaults' | 'backupDefaultsAt'>,
  offered: readonly BackupCategoryId[],
): BackupDefaults {
  const custom = Array.isArray(burrow.backupDefaults);
  return {
    categories: backupOfferedDefaults(
      custom ? (burrow.backupDefaults ?? []) : BACKUP_DEFAULT_CATEGORIES,
      offered,
    ),
    custom,
    updatedAt: burrow.backupDefaultsAt ? iso(burrow.backupDefaultsAt) : null,
  };
}

export function toFileView(row: BackupFileRow, burrowSlug: string): BackupFileView {
  const ready = row.status === 'ready';
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    progress: row.status === 'making' ? (row.progress ?? { done: 0, total: 0, step: null }) : null,
    categories: row.categories,
    includesSecrets: row.includesSecrets,
    size: ready ? row.size : null,
    sha256: ready ? row.sha256 : null,
    createdAt: iso(row.createdAt),
    readyAt: row.readyAt ? iso(row.readyAt) : null,
    expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
    error: row.status === 'failed' ? (row.error ?? null) : null,
    downloadUrl: ready ? backupDownloadUrl(burrowSlug, row.id) : null,
  };
}

export function toUploadView(row: BackupUploadRow, burrowSlug: string): BackupUploadView {
  return {
    id: row.id,
    fileName: row.fileName,
    size: row.size,
    received: row.received,
    status: row.status === 'uploading' ? 'uploading' : 'uploaded',
    sha256: row.status === 'uploading' ? (row.sha256 ?? null) : row.sha256,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    uploadUrl: backupUploadUrl(burrowSlug, row.id),
    chunkBytes: BACKUP_UPLOAD_CHUNK_BYTES,
    maxChunkBytes: BACKUP_UPLOAD_CHUNK_MAX_BYTES,
  };
}

export function toRestoreView(row: BackupRestoreRow): BackupRestoreView {
  return {
    id: row.id,
    upload: row.uploadId,
    fileName: row.fileName,
    madeAt: iso(row.madeAt),
    sourceName: row.sourceName,
    categories: row.categories,
    onDifferent: row.onDifferent,
    status: row.status,
    progress: row.status === 'restoring' ? (row.progress ?? { done: 0, total: 0, step: null }) : null,
    startedAt: iso(row.startedAt),
    finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
    summary: row.summary ?? null,
    error: row.status === 'failed' ? (row.error ?? null) : null,
  };
}

/** One of the caller's files in this burrow (anything else: not found). */
export async function ownFile(db: Db, burrowId: string, makerId: string, id: string): Promise<BackupFileRow> {
  const [row] = await db.select().from(backupFiles).where(eq(backupFiles.id, id));
  if (!row || row.burrowId !== burrowId || row.madeById !== makerId) throw notFound('Backup file');
  return row;
}

/** One of the caller's uploads in this burrow (anything else: not found). */
export async function ownUpload(
  db: Db,
  burrowId: string,
  uploaderId: string,
  id: string,
): Promise<BackupUploadRow> {
  const [row] = await db.select().from(backupUploads).where(eq(backupUploads.id, id));
  if (!row || row.burrowId !== burrowId || row.uploadedById !== uploaderId) throw notFound('Upload');
  return row;
}

/** One of the caller's restores in this burrow (anything else: not found). */
export async function ownRestore(
  db: Db,
  burrowId: string,
  restorerId: string,
  id: string,
): Promise<BackupRestoreRow> {
  const [row] = await db.select().from(backupRestores).where(eq(backupRestores.id, id));
  if (!row || row.burrowId !== burrowId || row.restoredById !== restorerId) throw notFound('Restore');
  return row;
}

/** The caller's files (not expired), uploads (not used, not expired) and restores of the last 24 hours. */
export async function listOwn(db: Db, burrowId: string, principalId: string, now: Date) {
  const files = await db
    .select()
    .from(backupFiles)
    .where(and(eq(backupFiles.burrowId, burrowId), eq(backupFiles.madeById, principalId)))
    .orderBy(desc(backupFiles.createdAt))
    .limit(50);
  const uploads = await db
    .select()
    .from(backupUploads)
    .where(
      and(
        eq(backupUploads.burrowId, burrowId),
        eq(backupUploads.uploadedById, principalId),
        inArray(backupUploads.status, ['uploading', 'uploaded']),
        gt(backupUploads.expiresAt, now),
      ),
    )
    .orderBy(desc(backupUploads.createdAt))
    .limit(50);
  const restores = await db
    .select()
    .from(backupRestores)
    .where(
      and(
        eq(backupRestores.burrowId, burrowId),
        eq(backupRestores.restoredById, principalId),
        gt(backupRestores.startedAt, new Date(now.getTime() - 24 * 3600_000)),
        // Things brought back from a backup the box opened for reading aren't a backup file's restore (backup-look.md).
        or(isNull(backupRestores.uploadId), notLike(backupRestores.uploadId, `${LOOK_PREFIX}%`)),
      ),
    )
    .orderBy(desc(backupRestores.startedAt))
    .limit(BACKUP_RESTORES_LISTED);
  return {
    files: files.filter((f) => !f.expiresAt || f.expiresAt > now),
    uploads,
    restores,
  };
}
