/**
 * Backup places (docs/decisions/backup-places.md), migration 0031: one row per NAS or server Whombat set up to keep this
 * Whombat's backups (`server:<id>`, `connection:<id>`). The box's own backups belong to the box, not to a burrow. The
 * row says where the backup app answers (address, port) and under which client name, which repository the box made
 * there (the one in use is the one whose `repository_id` the backup service reports), whether its cleanup was handed
 * the repository password, and for a place set up by hand the REST password waiting for “Check it” (sealed with key
 * custody, AAD `backup_place:<id>:pending`, 24 hours). No other secret is stored here: the REST and repository
 * passwords live in the backup service. Written only through the commit pipeline (`backup-places/store.ts`).
 */
import type { BackupPlaceKind } from '@whombat/core';
import { boolean, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { ts } from './common';

/**
 * What the place's cleanup was last handed (migration 0038; backup-options.md): the keep windows and limit, and whether
 * they went as windows or, for a helper that doesn't report windows, as the longest one in days.
 */
export interface HandedCleanup {
  keep: {
    allDays: number;
    dailyDays: number;
    weeklyWeeks: number;
    monthlyMonths: number;
    limitBytes: number | null;
  };
  windows: boolean;
  /** When (ISO), so an older helper is handed it again now and then. */
  at?: string;
}

export const backupPlaces = pgTable('backup_places', {
  /** The place's id (`server:blackbox`, `connection:con_1`). */
  id: text('id').primaryKey(),
  kind: text('kind').$type<BackupPlaceKind>().notNull(),
  /** As people call it, when it was set up (`BlackBox`). */
  name: text('name').notNull(),
  /** The REST user and folder this Whombat's backups go under (`whombat-home-3fkq`). */
  client: text('client').notNull(),
  /** The numeric LAN address the box's repository names; null until the backup app answered. */
  address: text('address'),
  port: integer('port'),
  /** Set up by hand (BPL-09): Whombat can't change it, and it has no cleanup until the NAS is connected with Manage. */
  byHand: boolean('by_hand').notNull().default(false),
  /**
   * Where on the place the backups are (an Unraid share, a TrueNAS pool, a shared folder; BPL-13), migration 0034; null
   * for a place with no choice or one set up before there was one.
   */
  location: text('location'),
  /** The repository the box made there (the backup service's id); null until the destination was set. */
  repositoryId: text('repository_id'),
  /** When the cleanup was given the repository password; null: no cleanup yet. */
  cleanupAt: ts('cleanup_at'),
  /** What it was handed then, migration 0038; null: nothing handed since (the keep-the-place-right job hands it). */
  cleanupKeep: jsonb('cleanup_keep').$type<HandedCleanup>(),
  /** By hand: the REST password the pasted app was made with, sealed, until `pendingUntil`. */
  pendingPasswordEnc: text('pending_password_enc'),
  pendingUntil: ts('pending_until'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export type BackupPlaceRow = typeof backupPlaces.$inferSelect;
