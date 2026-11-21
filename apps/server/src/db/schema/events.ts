/**
 * The signed audit log. Append-only: a trigger (migration `events_append_only`) rejects UPDATE, DELETE
 * and TRUNCATE. Each row is an `EventEnvelope` plus `hash`, `sig` and `signer`; optional envelope fields
 * are NULL when absent (they are omitted from the envelope when it is rebuilt for verification).
 */
import type { AuditDecision, AuditKeyRef, AuditKind, JsonObject, LinkRef } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { bigserial, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { burrows } from './tenancy';

export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    seq: integer('seq').notNull(),
    v: integer('v').notNull().default(1),
    prevHash: text('prev_hash').notNull(),
    actorId: text('actor_id').notNull(),
    type: text('type').notNull(),
    kind: text('kind').$type<AuditKind>().notNull(),
    text: text('text'),
    where: text('where'),
    keyUsed: jsonb('key_used').$type<AuditKeyRef>(),
    keyNote: text('key_note'),
    onBehalfOf: text('on_behalf_of'),
    onBehalfOfId: text('on_behalf_of_id'),
    aboutId: text('about_id'),
    decided: jsonb('decided').$type<AuditDecision>(),
    approvalId: text('approval_id'),
    ref: jsonb('ref').$type<LinkRef>(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    createdAt: ts('created_at').notNull(),
    hash: text('hash').notNull(),
    sig: text('sig').notNull(),
    signer: text('signer').notNull(),
  },
  (t) => [
    uniqueIndex('events_chain_idx').on(t.burrowId, t.seq),
    index('events_actor_idx').on(t.burrowId, t.actorId),
    index('events_about_idx').on(t.burrowId, t.aboutId),
    index('events_approval_idx').on(t.approvalId),
    // The audit log's counts per kind (server-efficiency.md SV-09); 0084 also INCLUDEs actor_id and about_id.
    index('events_listed_kind_idx').on(t.burrowId, t.kind).where(sql`${t.text} is not null`),
    // A turn looks up the agent's brief for the message that woke it by that message's id; without this it would read
    // every event about the agent, which grows with every turn.
    index('events_agent_brief_idx')
      .on(t.burrowId, sql`(${t.payload}->>'messageId')`)
      .where(sql`${t.type} = 'message.agent_brief'`),
  ],
);

/**
 * Transactional outbox: realtime frames written in the same transaction as the change, published to the
 * in-process bus after commit. Housekeeping removes rows older than a day.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    burrowId: text('burrow_id'),
    topic: text('topic').notNull(),
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    eventId: text('event_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    publishedAt: ts('published_at'),
  },
  (t) => [index('outbox_unpublished_idx').on(t.publishedAt, t.id)],
);
