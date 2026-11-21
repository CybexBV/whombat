/**
 * The AI gateway's pool (docs/decisions/ai-gateway.md AIG-11): what the poller last read of each gateway connection —
 * Fusebox's accounts (mapped to `GatewayAccountUsage`, labels as owners see them) and faults, whether it answers, and
 * the alerts posted about it (AIG-14). Operational state like `subscription_usage`: written by the gateway service in
 * account transactions, never signed. The settings Fusebox's management API answers are never stored here (they hold
 * every client key).
 */
import type { GatewayAccountUsage } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { catalogConnections } from './connections-catalog';
import { burrows } from './tenancy';

/** One of Fusebox's faults as the poller keeps it (`GET /api/faults`, the fields Whombat reads). */
export interface StoredGatewayFault {
  /** Fusebox's stable identity: `signin:<id>`, `quota:<id>`, `rate:<id>`, `provider:<provider>` … */
  key: string;
  /** `signin`, `quota`, `rate_limit`, `error`, `failures`, `provider`. */
  kind: string;
  /** `claude`, `codex`, or another of Fusebox's providers. */
  provider: string;
  /** The account it is about (Fusebox's id), null for a whole provider. */
  accountId: string | null;
  /** When it clears by itself. */
  until: string | null;
}

export const gatewayUsage = pgTable(
  'gateway_usage',
  {
    connectionId: text('connection_id')
      .primaryKey()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The pool's Claude and Codex accounts (≤ 64), labels with emails (members get “Claude account 1”). */
    accounts: jsonb('accounts').$type<GatewayAccountUsage[]>().notNull().default(sql`'[]'::jsonb`),
    faults: jsonb('faults').$type<StoredGatewayFault[]>().notNull().default(sql`'[]'::jsonb`),
    /** False after two polls in a row failed (AIG-11). */
    reachable: boolean('reachable').notNull().default(true),
    /** Polls in a row that failed. */
    failures: integer('failures').notNull().default(0),
    /** When it last answered (the accounts are as of then). */
    observedAt: ts('observed_at'),
    /** The last poll, answered or not. */
    checkedAt: ts('checked_at'),
    /** The first failed poll of the current failing run (unreachable for 5 minutes alerts, AIG-14). */
    failingSince: ts('failing_since'),
    /** Why the last poll failed, in Whombat's words; null when it answered. */
    error: text('error'),
    /** The alerts posted and not yet over (`<fault key>|<until>`, `unreachable`), so each goes once (AIG-14). */
    alerts: jsonb('alerts').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('gateway_usage_burrow_idx').on(t.burrowId)],
);
