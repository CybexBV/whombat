/**
 * The person's prompts (docs/decisions/prompts.md): one row per prompt of their own, and one per shipped prompt they
 * changed, removed or ran. A shipped prompt nobody touched has no row and follows `STARTER_PROMPTS` in code; on its row
 * `title` and `text` stay null until the person changes its words, so an unedited one still follows the shipped words.
 * Changed only through the commit pipeline (`prompts/commands.ts`).
 */
import type { PromptAi, PromptRun } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { burrows } from './tenancy';

export const prompts = pgTable(
  'prompts',
  {
    /** `prm_…` for the person's own; a shipped prompt's row has an id of its own too, and is known by `starter_key`. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The shipped prompt this row changes (`STARTER_PROMPTS`' key); null for the person's own. */
    starterKey: text('starter_key'),
    /** Null on a shipped prompt's row while its words are as shipped. */
    title: text('title'),
    text: text('text'),
    onRepository: boolean('on_repository').notNull().default(true),
    ownIt: boolean('own_it').notNull().default(false),
    /** Whombat merges the thread's pull request into the default branch once it is done (`t3_watches.merge`). */
    merge: boolean('merge').notNull().default(false),
    ai: jsonb('ai').$type<PromptAi>(),
    /** A shipped prompt the person removed; it returns when they bring the shipped ones back. */
    hidden: boolean('hidden').notNull().default(false),
    /** Where it ran, the latest first. */
    runs: jsonb('runs').$type<PromptRun[]>().notNull().default(sql`'[]'::jsonb`),
    /** The order of the person's own: the order they were made in. */
    position: integer('position').notNull().default(0),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('prompts_burrow_idx').on(t.burrowId, t.position),
    uniqueIndex('prompts_starter_idx').on(t.burrowId, t.starterKey).where(sql`${t.starterKey} is not null`),
  ],
);

export type PromptRow = typeof prompts.$inferSelect;
