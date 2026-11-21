/**
 * The tables of the removed repository manager (docs/decisions/fast-testing.md). Nothing reads or writes them; they
 * stay until a later migration drops them, so no data goes in the same release that removes the feature.
 */
import { boolean, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { burrows } from './tenancy';
import { vaultSshServers } from './vault';

/** A folder on a server of the person's Vault, read over SSH. */
export const repoPlaces = pgTable(
  'repo_places',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The Vault's server it is on; the place goes with the server. */
    serverId: text('server_id')
      .notNull()
      .references(() => vaultSshServers.id, { onDelete: 'cascade' }),
    /** As the person typed it (`~/Code`). */
    folder: text('folder').notNull(),
    /** As the server resolved it at the last read (`/home/alex/Code`). */
    root: text('root'),
    /** What the last read found (`repo-manager/snapshot.ts`), without the files' words. */
    snapshot: jsonb('snapshot').$type<unknown>(),
    readAt: ts('read_at'),
    /** Why the last read didn't work, in plain words. */
    problem: text('problem'),
    addedById: text('added_by_id').references(() => principals.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('repo_places_burrow_idx').on(t.burrowId)],
);
export type RepoPlaceRow = typeof repoPlaces.$inferSelect;

/** How agents work in one repository of a place, as the person saved it. */
export const repoRules = pgTable(
  'repo_rules',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    placeId: text('place_id')
      .notNull()
      .references(() => repoPlaces.id, { onDelete: 'cascade' }),
    /** The repository's folder name in the place. */
    repo: text('repo').notNull(),
    /** Its full path at the time (`/home/alex/Code/Kiwi`): what a T3 Code project's folder is matched with. */
    path: text('path').notNull(),
    rules: jsonb('rules').notNull(),
    /** Existing saved permissions stay active; discovering a folder creates no policy. */
    active: boolean('active').notNull().default(true),
    /** A file-backed change becomes active only once its own checked write succeeds. */
    pending: jsonb('pending'),
    /** Kept in AGENTS.md and CLAUDE.md (false: in Whombat only, given with each hand-over). */
    write: boolean('write').notNull(),
    setById: text('set_by_id').references(() => principals.id, { onDelete: 'set null' }),
    setAt: ts('set_at').notNull(),
    /** How the last write into the files went. */
    lastWrite: jsonb('last_write'),
  },
  (t) => [
    uniqueIndex('repo_rules_place_repo_idx').on(t.placeId, t.repo),
    index('repo_rules_path_idx').on(t.burrowId, t.path),
  ],
);
export type RepoRulesRow = typeof repoRules.$inferSelect;
