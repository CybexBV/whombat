/**
 * Backup files (docs/decisions/backup-file.md BF-01…, BF-D01…; contracts CT-335), migration 0103. A file, an upload and
 * a restore belong to the person who made them. No password, key or secret is stored here: the files themselves are in
 * the staging directory under WHOMBAT_HOME (`backups/paths.ts`), encrypted with the maker's password.
 */
import type {
  BackupCategoryId,
  BackupFileProblem,
  BackupOnDifferent,
  BackupProgress,
  BackupRestoreSummary,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import { bigint, boolean, index, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { burrows } from './tenancy';

export type BackupFileState = 'making' | 'ready' | 'failed';
export type BackupUploadState = 'uploading' | 'uploaded' | 'used';
export type BackupRestoreState = 'restoring' | 'done' | 'failed';

/** A backup file the person made: the job while it is made, then the file kept 24 hours for download (BF-10). */
export const backupFiles = pgTable(
  'backup_files',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    madeById: text('made_by_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** `lumio-bv-2026-10-11.wbk` (`backupFileName`). */
    name: text('name').notNull(),
    status: text('status').$type<BackupFileState>().notNull(),
    categories: jsonb('categories').$type<BackupCategoryId[]>().notNull(),
    includesSecrets: boolean('includes_secrets').notNull(),
    progress: jsonb('progress').$type<BackupProgress>(),
    size: bigint('size', { mode: 'number' }),
    sha256: text('sha256'),
    /** The file's name in the staging directory (never a path a request chose). */
    path: text('path'),
    error: jsonb('error').$type<BackupFileProblem>(),
    createdAt: ts('created_at').notNull(),
    readyAt: ts('ready_at'),
    expiresAt: ts('expires_at'),
  },
  (t) => [index('backup_files_burrow_idx').on(t.burrowId, t.createdAt)],
);

/** A file the person uploads to restore: reserved by `backups.stage`, filled by chunks, used by its restore. */
export const backupUploads = pgTable(
  'backup_uploads',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    uploadedById: text('uploaded_by_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    /** The whole file's sha256: announced at stage (checked at the end), else computed once it is all here. */
    sha256: text('sha256'),
    received: bigint('received', { mode: 'number' }).notNull().default(0),
    status: text('status').$type<BackupUploadState>().notNull(),
    /** The file's name in the staging directory. */
    path: text('path').notNull(),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    uploadedAt: ts('uploaded_at'),
  },
  (t) => [index('backup_uploads_burrow_idx').on(t.burrowId, t.uploadedById)],
);

/** A restore the person started from an upload: the job, its progress and what it did. */
export const backupRestores = pgTable(
  'backup_restores',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    restoredById: text('restored_by_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** Null once the upload is gone (after the restore). */
    uploadId: text('upload_id'),
    fileName: text('file_name').notNull(),
    madeAt: ts('made_at').notNull(),
    sourceName: text('source_name').notNull(),
    sourceBurrowId: text('source_burrow_id').notNull(),
    categories: jsonb('categories').$type<BackupCategoryId[]>().notNull(),
    onDifferent: text('on_different').$type<BackupOnDifferent>().notNull(),
    status: text('status').$type<BackupRestoreState>().notNull(),
    progress: jsonb('progress').$type<BackupProgress>(),
    summary: jsonb('summary').$type<BackupRestoreSummary>(),
    error: jsonb('error').$type<BackupFileProblem>(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('backup_restores_burrow_idx').on(t.burrowId, t.startedAt),
    // One restore at a time per burrow (migration 0038): two at once would replay the same rows twice.
    uniqueIndex('backup_restores_one_running').on(t.burrowId).where(sql`${t.status} = 'restoring'`),
  ],
);

/**
 * The restore map (BF-04): a source burrow's id (a person, an agent, a channel, a message …) and the id it has here,
 * found by its portable key or made by a restore. Restoring the same file again finds every pair and adds nothing.
 */
export const backupRestoreMap = pgTable(
  'backup_restore_map',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    sourceBurrowId: text('source_burrow_id').notNull(),
    sourceId: text('source_id').notNull(),
    /** The category (or directory type) that mapped it. */
    category: text('category').notNull(),
    targetId: text('target_id').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [primaryKey({ name: 'backup_restore_map_pk', columns: [t.burrowId, t.sourceBurrowId, t.sourceId] })],
);
