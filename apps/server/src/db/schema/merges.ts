/** Durable manual/approved GitHub merges. A running or uncertain effect is never sent again. */
import type { KeyId, MergeMethod } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { pullRequests } from './code';
import { ts } from './common';
import { burrows } from './tenancy';

export const mergeIntents = pgTable(
  'merge_intents',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    prId: text('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    actorId: text('actor_id').notNull(),
    headSha: text('head_sha').notNull(),
    baseBranch: text('base_branch').notNull(),
    method: text('method').$type<MergeMethod>().notNull(),
    keyId: text('key_id').$type<KeyId>().notNull(),
    onBehalfOf: jsonb('on_behalf_of').$type<{ text?: string; principalId?: string }>().notNull().default({}),
    state: text('state').$type<'pending' | 'running' | 'merged' | 'refused' | 'unknown'>().notNull(),
    reason: text('reason'),
    mergeSha: text('merge_sha'),
    eventId: text('event_id'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('merge_intents_active_pr_idx')
      .on(t.prId)
      .where(sql`${t.state} in ('pending', 'running', 'unknown')`),
    index('merge_intents_state_idx').on(t.state),
  ],
);
