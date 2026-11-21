/**
 * Devices Whombat doesn't support yet (docs/decisions/one-whombat.md ONE-16…ONE-19; one-whombat-devices.md ONE-DD…),
 * migration 0106: a device profile Whombat proposed after testing it read-only, and the `device` connection it became.
 */
import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import type { ArgLimit } from '../../connections/limits';
import type { ReadingResult } from '../../devices/driver';
import type { DeviceProfile } from '../../devices/types';
import { ts } from './common';
import { catalogConnections } from './connections-catalog';
import { principals } from './principals';
import { burrows } from './tenancy';

export type DeviceSkillStatus = 'proposed' | 'on' | 'declined' | 'replaced';

/** The person's choice for one action: its tier and limits (ONE-18: stored with the choice, never in the profile). */
export interface DeviceActionChoice {
  tier: 'off' | 'ask' | 'can';
  limits?: ArgLimit;
}

export const deviceSkills = pgTable(
  'device_skills',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The Whombat that proposed it. */
    agentId: text('agent_id').references(() => principals.id, { onDelete: 'set null' }),
    /** The person whose Whombat proposed it (the turn's person). */
    personId: text('person_id').references(() => principals.id, { onDelete: 'set null' }),
    /** Where the card is. */
    conversationId: text('conversation_id'),
    messageId: text('message_id'),
    name: text('name').notNull(),
    profile: jsonb('profile').$type<DeviceProfile>().notNull(),
    /** sha256 of the canonical profile: the person's choices hold for exactly this profile (ONE-18). */
    profileHash: text('profile_hash').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    unitId: integer('unit_id'),
    /** What the read-only test read, value by value. */
    tested: jsonb('tested').$type<ReadingResult[]>().notNull(),
    testedAt: ts('tested_at').notNull(),
    status: text('status').$type<DeviceSkillStatus>().notNull().default('proposed'),
    /** The person's choices by action key, once decided. */
    choices: jsonb('choices').$type<Record<string, DeviceActionChoice> | null>(),
    /** The `device` connection it became once switched on. */
    connectionId: text('connection_id').references(() => catalogConnections.id, { onDelete: 'set null' }),
    decidedById: text('decided_by_id'),
    decidedAt: ts('decided_at'),
    /** The last reading (Home's facts) and when; the error when the last try failed. */
    lastRead: jsonb('last_read').$type<ReadingResult[] | null>(),
    lastReadAt: ts('last_read_at'),
    lastReadError: text('last_read_error'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('device_skills_burrow_idx').on(t.burrowId, t.status),
    index('device_skills_connection_idx').on(t.connectionId),
  ],
);
