/**
 * A 1Password vault kept in step with the Vault (docs/decisions/onepassword-sync.md OPW-40): one link per pair of a
 * Vault entry and a 1Password item, and one state row per 1Password connection. Everything a pass needs to decide is
 * here; the worker holds nothing that matters. No value of an entry or an item is stored: the base is an HMAC per field
 * (`vault/onepassword/digests.ts`).
 */
import type {
  OnePasswordDigests,
  OnePasswordNotInVault,
  OnePasswordPassOutcome,
  OnePasswordRemovals,
} from '@whombat/core';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { catalogConnections } from './connections-catalog';
import { burrows } from './tenancy';
import { vaultEntries } from './vault';

/** A link's state: `creating` (an item is being made for it), `synced`, `local_only` (kept only in Whombat). */
export type OnePasswordLinkState = 'creating' | 'synced' | 'local_only';

/**
 * One pair. `entry_id` is set null when the entry is removed in Whombat: the link stays as the marker that its item is
 * to be archived, then goes. `item_id` is null while `creating` and for an entry kept only in Whombat that never had
 * an item. One link per entry and one per item of a connection. A `creating` link remembers its entry's id in
 * `marker_entry_id` too (the id the new item's marker carries), so an entry removed before the answer came still finds
 * the item to archive.
 */
export const vaultOnePasswordLinks = pgTable(
  'vault_onepassword_links',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    entryId: text('entry_id').references(() => vaultEntries.id, { onDelete: 'set null' }),
    vaultId: text('vault_id').notNull(),
    itemId: text('item_id'),
    state: text('state').$type<OnePasswordLinkState>().notNull(),
    /** The item's `version` and `updatedAt` (as 1Password wrote it) when the pass last read or wrote it. */
    itemVersion: integer('item_version'),
    itemUpdatedAt: text('item_updated_at'),
    /** The HMAC of each field both sides last agreed on; null: none (a relinked entry, where 1Password wins). */
    base: jsonb('base').$type<OnePasswordDigests>(),
    /** The item's title was longer than the Vault holds: the shortened name is never written back over it. */
    nameShortened: boolean('name_shortened').notNull().default(false),
    /** Why the pair isn't kept in step now, in the person's words; null: nothing wrong. */
    problem: text('problem'),
    /**
     * The id of the item's one-time password field the pair follows; null: none yet (the first one with a value is
     * taken). A field removed in 1Password is never replaced by another one-time password field of the item.
     */
    totpFieldId: text('totp_field_id'),
    /** The entry id a `creating` link's new item carries in its marker (kept when the entry is removed meanwhile). */
    markerEntryId: text('marker_entry_id'),
    /**
     * The HMACs of Whombat's side that 1Password refused to take (a write that kept failing); null: none. The pair
     * isn't written again until either side changes.
     */
    refused: jsonb('refused').$type<OnePasswordDigests>(),
    syncedAt: ts('synced_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('vault_onepassword_links_entry_idx').on(t.entryId),
    uniqueIndex('vault_onepassword_links_item_idx').on(t.connectionId, t.itemId),
    index('vault_onepassword_links_connection_idx').on(t.connectionId, t.state),
  ],
);

/** An item under “Not in your Vault”, with the `updatedAt` it was read at (not shown: a pass reads it again on change). */
export type OnePasswordNotInVaultRow = OnePasswordNotInVault & { updatedAt: string };

/** One row per 1Password connection: what the last pass saw and how it ended. */
export const vaultOnePasswordState = pgTable('vault_onepassword_state', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => catalogConnections.id, { onDelete: 'cascade' }),
  burrowId: text('burrow_id')
    .notNull()
    .references(() => burrows.id, { onDelete: 'cascade' }),
  /** The vault's name in 1Password; null before a pass read it. */
  vaultTitle: text('vault_title'),
  /** The vault's `contentVersion` the last full pass started from; null: none yet (the next pass lists). */
  contentVersion: integer('content_version'),
  checkedAt: ts('checked_at'),
  outcome: text('outcome').$type<OnePasswordPassOutcome>(),
  /** `failing`: why, in the person's words. */
  problem: text('problem'),
  /** A push found that the token can only read (OPW-04). */
  readOnly: boolean('read_only').notNull().default(false),
  notInVault: jsonb('not_in_vault').$type<OnePasswordNotInVaultRow[]>().notNull().default([]),
  /** The removals the guard holds for the person (OPW-24); null: none. */
  removals: jsonb('removals').$type<OnePasswordRemovals>(),
  /** 1Password's limit (OPW-26): the times in a row it was hit, and when the next pass may try. */
  limitHits: integer('limit_hits').notNull().default(0),
  nextTryAt: ts('next_try_at'),
  /** Passes in a row that couldn't finish: the red card waits for the second. */
  failures: integer('failures').notNull().default(0),
  updatedAt: ts('updated_at').notNull(),
});
