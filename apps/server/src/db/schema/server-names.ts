/**
 * The name a person gave a server (“The Titan” for `the-titan`), kept by Whombat, not by the hosts service: every
 * screen and message calls the server by it, while links, tools and the hosts service keep the id. One row per named
 * server, keyed as `server_asks` (the hosts service's id in lower case); no row is the id. Changed only through the
 * commit pipeline (`servers.rename`); removing a server removes its row. Two servers never share a name, ignoring case.
 */
import { sql } from 'drizzle-orm';
import { pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { burrows } from './tenancy';

export const serverNames = pgTable(
  'server_names',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The hosts service's server id, in lower case. */
    serverId: text('server_id').notNull(),
    name: text('name').notNull(),
    changedById: text('changed_by_id').references(() => principals.id, { onDelete: 'set null' }),
    changedAt: ts('changed_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'server_names_pk', columns: [t.burrowId, t.serverId] }),
    uniqueIndex('server_names_name_uq').on(t.burrowId, sql`lower(${t.name})`),
  ],
);
