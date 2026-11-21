/**
 * Kept sites (docs/decisions/kept-sites.md): a website the agent asked to stay signed in to between its turns, for a
 * few hours. One row per site (a set of https origins): its cookies sealed with the box's custody key
 * (`kept-site:<id>:cookies`), how many hours it stays kept from its last use, and when it goes. An expired row is never
 * answered and is deleted the next time someone reads the kept sites. Changed only through the commit pipeline
 * (`browser/kept-sites.ts`).
 */
import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { burrows } from './tenancy';

export const keptSites = pgTable(
  'kept_sites',
  {
    /** `kst_…` */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The agent that asked to keep it. */
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** Its https origins, lower case (`https://accounts.hetzner.com`). */
    origins: jsonb('origins').$type<string[]>().notNull(),
    /** The name to show: the host of its first origin. */
    site: text('site').notNull(),
    hours: integer('hours').notNull(),
    /** The cookies as JSON, sealed with the box's custody key. Never logged, never in an event. */
    cookiesSealed: text('cookies_sealed').notNull(),
    keptAt: ts('kept_at').notNull(),
    lastUsedAt: ts('last_used_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    index('kept_sites_burrow_idx').on(t.burrowId, t.expiresAt),
    index('kept_sites_expires_idx').on(t.expiresAt),
  ],
);

export type KeptSiteRow = typeof keptSites.$inferSelect;
