/**
 * Connectors (docs/decisions/connectors.md CN-02, CN-04): the OAuth app per provider for this Whombat, each
 * account's connections and the pending OAuth sign-ins. These belong to the instance or an account, not a
 * burrow, so they are written by account-level server functions (CN-07), never by the burrow commit pipeline.
 * Secrets are sealed with the master key (`connectors/crypto.ts`).
 */
import type {
  ConnectionCheck,
  ConnectionStatus,
  ConnectorProvider,
  ConnectorService,
  GoogleUserType,
  ImapServerSettings,
  ReauthReason,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { ts } from './common';
import { accounts, burrows } from './tenancy';

/** The OAuth client the person set up on this Whombat, per provider (CN-02). */
export const connectorApps = pgTable('connector_apps', {
  provider: text('provider').$type<ConnectorProvider>().primaryKey(),
  clientId: text('client_id').notNull(),
  /** Sealed with AAD `connector_app:<provider>`. */
  clientSecretEnc: text('client_secret_enc').notNull(),
  userType: text('user_type').$type<GoogleUserType>().notNull(),
  updatedByAccountId: text('updated_by_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * An Email (IMAP) account's servers (connections-more.md CM-19, CM-20; migration 0119): where its mail is read and sent,
 * and whether its provider keeps its own copy of sent mail (CM-26, from the provider hints when it was connected).
 */
export type StoredMailSettings = ImapServerSettings & { savesSent: boolean };

/** A person's connected account (CN-04). One per account and provider for now. */
export const connections = pgTable(
  'connections',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<ConnectorProvider>().notNull(),
    /** The provider's stable user id (Google `sub`). */
    externalId: text('external_id').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull().default(''),
    services: text('services').array().$type<ConnectorService[]>().notNull().default(sql`'{}'::text[]`),
    /** Scopes the provider granted. */
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    /**
     * The long-lived secret: the refresh token, sealed with AAD `connection:<id>:refresh`; for Email (IMAP) the mail
     * password, sealed with AAD `connection:<id>:password` (so nothing reads it as a refresh token, connections-more-mail.md).
     */
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    /** Sealed with AAD `connection:<id>:access`; null until the first refresh after a restart. */
    accessTokenEnc: text('access_token_enc'),
    accessExpiresAt: ts('access_expires_at'),
    /** When the current refresh token was granted (tells an expired Testing grant from a revoked one, CN-05). */
    grantedAt: ts('granted_at').notNull().defaultNow(),
    status: text('status').$type<ConnectionStatus>().notNull().default('active'),
    reauthReason: text('reauth_reason').$type<ReauthReason>(),
    checks: jsonb('checks').$type<ConnectionCheck[]>().notNull().default([]),
    /** When `checks` were last run (IN-29); a token refresh moves `updated_at`, not this. */
    checkedAt: ts('checked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
    /** The last repair message in the person's Chat (AG-13): at most one per connection per 24 hours. */
    repairNotifiedAt: ts('repair_notified_at'),
    /** Email (IMAP) only: its servers (0119); null for Google and Microsoft. */
    mailSettings: jsonb('mail_settings').$type<StoredMailSettings>(),
  },
  (t) => [uniqueIndex('connections_account_provider_idx').on(t.accountId, t.provider)],
);

/** Whether a connected account answered. GitHub is connected for the whole burrow. */
export const accountUptimePoints = pgTable(
  'account_uptime_points',
  {
    connectionId: text('connection_id').references(() => connections.id, { onDelete: 'cascade' }),
    githubBurrowId: text('github_burrow_id').references(() => burrows.id, { onDelete: 'cascade' }),
    at: ts('at').notNull(),
    up: doublePrecision('up').notNull(),
    /** Null for a live reading. An hourly average keeps how many readings it covers. */
    samples: integer('samples'),
  },
  (t) => [
    check('account_uptime_owner', sql`num_nonnulls(${t.connectionId}, ${t.githubBurrowId}) = 1`),
    unique('account_uptime_slot').on(t.connectionId, t.githubBurrowId, t.at).nullsNotDistinct(),
    index('account_uptime_at_idx').on(t.at),
    index('account_uptime_github_at_idx').on(t.githubBurrowId, t.at),
  ],
);

/** A pending OAuth sign-in: `id` is the `state` sent to the provider. Single use, 10 minutes (CN-04). */
export const oauthStates = pgTable(
  'oauth_states',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<ConnectorProvider>().notNull(),
    services: text('services').array().$type<ConnectorService[]>().notNull(),
    /** PKCE verifier (S256); never leaves the server. */
    codeVerifier: text('code_verifier').notNull(),
    /** Where the callback sends the browser back to (a path on this Whombat). */
    returnPath: text('return_path').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('oauth_states_account_idx').on(t.accountId)],
);
