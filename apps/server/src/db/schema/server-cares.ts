/**
 * Which servers have had their care plan offered (docs/decisions/care-plan.md), migration 0021: one row per server a
 * Whombat knows, so a server gets its plan once, when it first reports. `known`: there before care plans were made, or
 * one that needs none (a temporary machine, a second copy of the server this Whombat runs on); `offered`: the plan was
 * proposed in its thread. `automations` are the care automations Go ahead turned on for it (step id → automation id),
 * so a later plan doesn't offer them again. Written only through the commit pipeline (`care/commands.ts`).
 */
import type { CareStepId } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { lookResearches } from './home';
import { burrows } from './tenancy';

export const serverCares = pgTable(
  'server_cares',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The hosts service's server id, in lower case. */
    serverId: text('server_id').notNull(),
    state: text('state').$type<'known' | 'offered'>().notNull(),
    /** It is the server this Whombat runs on: its plan is offered once, whatever its id. */
    self: boolean('self').notNull().default(false),
    /** The research that proposed its plan. */
    researchId: text('research_id').references(() => lookResearches.id, { onDelete: 'set null' }),
    automations: jsonb('automations').$type<Partial<Record<CareStepId, string>>>().notNull().default({}),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'server_cares_pk', columns: [t.burrowId, t.serverId] }),
    check('server_cares_state', sql`${t.state} IN ('known', 'offered')`),
  ],
);
