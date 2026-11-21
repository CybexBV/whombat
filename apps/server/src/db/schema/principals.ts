/**
 * People, the Whombat's one agent and Whombat's own signers (principals) with their signing keys, and the agent's
 * grants (docs/decisions/one-agent.md OA-01, OA-17).
 */
import type {
  AgentFace,
  AgentModelFallback,
  AgentRuntime,
  AgentStatus,
  KeyScope,
  PrincipalKind,
  Tier,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { attachments } from './attachments';
import { ts } from './common';
import { burrows } from './tenancy';

export const principals = pgTable(
  'principals',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    /**
     * `person`, `agent` (the burrow's one agent, OA-01: at most one, `principals_agent_idx`) or `system` (GitHub, an
     * automation, Feedback, the trackers, Servers: Whombat's own signers, never the agent; OA-17).
     */
    kind: text('kind').$type<PrincipalKind>().notNull(),
    name: text('name').notNull(),
    handle: text('handle').notNull(),
    /** Ed25519 public key, hex. */
    publicKey: text('public_key').notNull(),
    /** `xxxx xxxx` */
    fingerprint: text('fingerprint').notNull(),
    /** AES-256-GCM encrypted Ed25519 secret key (`v1:<base64 iv|tag|ciphertext>`), see keys/custody.ts. */
    secretKeyEnc: text('secret_key_enc').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),

    // People
    accountId: text('account_id'),
    shortName: text('short_name'),
    initials: text('initials'),
    tone: text('tone'),
    title: text('title'),
    email: text('email'),
    /**
     * The person's photo (docs/decisions/person-avatars.md PVA-03): a ready attachment in this burrow with no
     * conversation, readable in the whole burrow, and its URL (`Person.avatarUrl`). Both set or both null; a
     * deleted row clears the id (the URL is ignored without it). Null: the initials on `tone`.
     */
    avatarAttachmentId: text('avatar_attachment_id').references((): AnyPgColumn => attachments.id, {
      onDelete: 'set null',
    }),
    avatarUrl: text('avatar_url'),

    // The agent
    /**
     * The face it wears (one-agent.md OA-08): one of the five drawings by name (`dusty`, `banjo`, `neo`, `skipper`,
     * `hazel`); null: Dusty's. The person picks it in setup and Settings → Agent.
     */
    agentFace: text('agent_face').$type<AgentFace>(),
    status: text('status').$type<AgentStatus>(),
    doing: text('doing'),
    job: text('job'),
    runtime: jsonb('runtime').$type<AgentRuntime>(),
    /**
     * The agent's last turn ran on its tool's default because its model wasn't available on that turn's sign-in or AI
     * gateway (docs/decisions/model-effort.md ME-05): `AgentProfile.modelFallback`, plus what the tool said (`detail`, for
     * the log only). Null: its last completed turn ran on its own model, or its model changed since.
     */
    modelFallback: jsonb('model_fallback').$type<StoredModelFallback>(),
    /** Which of Whombat's own signers a `system` principal is (`github`, `automation`, …); they never get dispatches. */
    system: text('system'),
    /** People's order within the burrow (seed order, then join order). */
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('principals_avatar_idx').on(t.avatarAttachmentId).where(sql`${t.avatarAttachmentId} is not null`),
    uniqueIndex('principals_handle_idx').on(t.burrowId, t.handle),
    uniqueIndex('principals_account_idx').on(t.burrowId, t.accountId).where(sql`${t.accountId} is not null`),
    index('principals_account_lookup_idx').on(t.accountId),
    uniqueIndex('principals_agent_idx').on(t.burrowId).where(sql`${t.kind} = 'agent'`),
  ],
);

/** `principals.model_fallback`: the profile's `AgentModelFallback` and the tool's own words. */
export type StoredModelFallback = AgentModelFallback & { detail?: string };

/** A key held by the agent. `key_id` is text (not an enum) so unknown future keys never break reads. */
export const grants = pgTable(
  'grants',
  {
    burrowId: text('burrow_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id),
    keyId: text('key_id').notNull(),
    tier: text('tier').$type<Tier>().notNull(),
    scope: jsonb('scope').$type<KeyScope>(),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.keyId] })],
);
