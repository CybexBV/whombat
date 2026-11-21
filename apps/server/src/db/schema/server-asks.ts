/**
 * Whether Whombat asks before its risky calls on a server (docs/decisions/server-asks.md SA-01, SA-04), migration 0107.
 * Kept by Whombat, not by the hosts service; a server without a row acts without asking (`never`). Changed only
 * through the commit pipeline (`servers.setAsks`, or a yes with “Don’t ask again on {server}”); removing a server
 * removes its row.
 */
import type { HostAsksFirst } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { burrows } from './tenancy';

export const serverAsks = pgTable(
  'server_asks',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The hosts service's server id, in lower case (server-asks-server.md SA-S01). */
    serverId: text('server_id').notNull(),
    asksFirst: text('asks_first').$type<HostAsksFirst>().notNull(),
    changedById: text('changed_by_id').references(() => principals.id, { onDelete: 'set null' }),
    changedAt: ts('changed_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'server_asks_pk', columns: [t.burrowId, t.serverId] }),
    check('server_asks_value', sql`${t.asksFirst} IN ('risky', 'never')`),
  ],
);
