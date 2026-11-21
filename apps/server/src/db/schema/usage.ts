/**
 * Subscription usage (docs/decisions/ui-improvements.md UI-R09): the latest snapshot per sign-in and provider
 * — no history. Account-level operational state like a sign-in's run signal: written by the usage service
 * (`usage/service.ts`) in account transactions, never by the burrow commit pipeline, and never signed (it records
 * what a provider said, not something anyone did). The alerts the assistant posted about it are ordinary messages.
 */
import type { UsageCredentialKind, UsageProvider, UsageSource, UsageWindow } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { accounts } from './tenancy';

export const subscriptionUsage = pgTable(
  'subscription_usage',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<UsageProvider>().notNull(),
    kind: text('kind').$type<UsageCredentialKind>().notNull().default('subscription'),
    plan: text('plan'),
    windows: jsonb('windows').$type<UsageWindow[]>().notNull().default(sql`'[]'::jsonb`),
    /** When the windows were read (a probe that couldn't read them leaves this and the windows as they were). */
    observedAt: ts('observed_at'),
    source: text('source').$type<UsageSource>(),
    /** Why the last probe couldn't read usage; cleared by the next good reading. */
    error: text('error'),
    /** The last probe attempt, scheduled or asked for (the schedule counts from it). */
    probedAt: ts('probed_at'),
    /** The last probe a person asked for (`usage.refresh`, once a minute). */
    refreshedAt: ts('refreshed_at'),
    /** The last turn that reported this subscription's limits (probed every 15 minutes within 24 hours of it). */
    usedAt: ts('used_at'),
    /** Alert keys the assistant has posted (`usageAlertKey`), newest last, bounded. */
    alerts: jsonb('alerts').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.provider] })],
);
