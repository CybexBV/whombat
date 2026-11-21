/**
 * The passkey as the key to this Whombat's backups (docs/decisions/backup-passkey.md), migration 0039.
 *
 * - `backup_passkey_keys`: one row per (Whombat, passkey): the backup key a passkey touch gave this Whombat
 *   (`kitKeyFromPrf` of the passkey's PRF output for `salt`, bound to the Whombat's PeerId), sealed with key custody
 *   (AAD `backup_passkey_key:<appliance>:<credentialId>`), and the envelope of the backup details last locked with it,
 *   with when control stored it. Rows of another PeerId came with a backup of an earlier Whombat and are never used.
 * - `backup_key_state`: one row per Whombat: where the locked copy next to the backups is, the paper copy saved, and the
 *   Whombat this one was brought back from until control was told.
 *
 * The envelopes aren't secret (only the passkey opens them); digests are SHA-256 of the backup details' secrets and say
 * nothing about them. Written only through the commit pipeline (`managed/backup-key.ts`).
 */
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { accounts } from './tenancy';

export const backupPasskeyKeys = pgTable(
  'backup_passkey_keys',
  {
    /** The Whombat's content PeerId the key is bound to. */
    appliance: text('appliance').notNull(),
    /** The passkey's credential id (base64url), one of `appliance_passkeys`. */
    credentialId: text('credential_id').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The PRF input the key came from (base64url). */
    salt: text('salt').notNull(),
    /** The 32-byte key, base64url, sealed with key custody. */
    keySealed: text('key_sealed').notNull(),
    /** The backup details last locked with it: `wbkit1.…`, their generation and digest, and when. */
    envelope: text('envelope'),
    generation: integer('generation'),
    lockedDigest: text('locked_digest'),
    lockedAt: ts('locked_at'),
    /** When control kept that envelope; null: still to push. */
    storedAt: ts('stored_at'),
    /** A fresh passkey evaluation opened the stored envelope with this unchanged key. */
    verifiedAt: ts('verified_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.appliance, t.credentialId] })],
);

export type BackupPasskeyKeyRow = typeof backupPasskeyKeys.$inferSelect;

export const backupKeyState = pgTable('backup_key_state', {
  /** The Whombat's content PeerId. */
  appliance: text('appliance').primaryKey(),
  /** The Whombat this one was brought back from (its PeerId), until control kept an envelope that said so. */
  adoptedFrom: text('adopted_from'),
  adoptedReportedAt: ts('adopted_reported_at'),
  /** The digest of the backup details' secrets at the last lock (a paper copy with the same digest still opens them). */
  detailsDigest: text('details_digest'),
  /** The paper copy: the repository and generation printed, the digest of its secrets then, and when. */
  paperRepositoryId: text('paper_repository_id'),
  paperGeneration: integer('paper_generation'),
  paperDigest: text('paper_digest'),
  paperAt: ts('paper_at'),
  /** The copy next to the backups: the backup app written to (`host:port`), the details' digest, when. */
  nasAt: ts('nas_at'),
  nasDigest: text('nas_digest'),
  nasWhere: text('nas_where'),
  /** The last try at it, and the last time the place was asked to add the kit user. */
  nasTriedAt: ts('nas_tried_at'),
  kitEnsuredAt: ts('kit_ensured_at'),
  updatedAt: ts('updated_at').notNull(),
});

export type BackupKeyStateRow = typeof backupKeyState.$inferSelect;
