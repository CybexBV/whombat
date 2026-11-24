/**
 * Catalog connections (docs/decisions/connections-catalog.md CX-17…CX-19, CX-D01; one-person.md OP-S50): every
 * connection made from the catalog — Home Assistant, Notion, Todoist, Nextcloud, Dropbox, Moneybird, the token services
 * and the Custom entries — the person's, in their Whombat's burrow, used by the agent under the keys. Google and
 * Microsoft keep `connections` (connectors.ts); these rows never mix with them.
 *
 * Secrets are sealed with the master key: `secret_enc` AAD `catalog_connection:<id>:secret`, the OAuth tokens
 * `catalog_connection:<id>:refresh` / `:access`, a registered client `connection_client:<id>`, Fusebox's client key
 * `catalog_connection:<id>:client` (ai-gateway.md AIG-02).
 */
import type {
  CatalogCheckResult,
  CatalogConnectionState,
  CatalogReauthReason,
  ConnectionAccessLevel,
  ConnectionPage,
  ConnectionToolAccess,
  ConnectionToolTier,
  ConnectionTransport,
  SignInKind,
  ThingLogo,
  TokenAuth,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { ToolLimits } from '../../connections/limits';
import type { ConnectionGlance } from '../../home/types';
import { ts } from './common';
import { principals } from './principals';
import { accounts, burrows } from './tenancy';

/** One connection from the catalog (CX-17). */
export const catalogConnections = pgTable(
  'catalog_connections',
  {
    id: text('id').primaryKey(),
    /** A `CatalogId` (not a builtin). */
    catalogId: text('catalog_id').notNull(),
    /** The burrow it belongs to (the Whombat's one). */
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The person who connected it. */
    connectedById: text('connected_by_id').references(() => principals.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    /** How agents name it (CX-05): unique in the burrow. */
    handle: text('handle').notNull(),
    transport: text('transport').$type<ConnectionTransport>().notNull(),
    /** The sign-in method used (`token`, `nextcloud_login`, `ha_oauth`, `mcp_oauth`, `app_oauth`). */
    signIn: text('sign_in').$type<SignInKind>().notNull(),
    /** The resolved base URL (fields filled in). */
    baseUrl: text('base_url').notNull(),
    /** The entry's non-secret field values. */
    fields: jsonb('fields').$type<Record<string, string>>().notNull().default({}),
    /** Token sign-in: how the secret is sent. */
    auth: jsonb('auth').$type<TokenAuth | null>(),
    /** Token kinds: the token or app password. */
    secretEnc: text('secret_enc'),
    /**
     * Fusebox (docs/decisions/ai-gateway.md AIG-02): the client key Whombat made in it with the management key, sealed
     * with AAD `catalog_connection:<id>:client`; its id is the `clientId` field. Null: none (an open Fusebox, and every
     * other entry).
     */
    clientSecretEnc: text('client_secret_enc'),
    /**
     * A session sign-in's trusted-device token (docs/decisions/connection-signin.md SG-09, migration 0128): what the
     * service gave Whombat to skip its two-step code next time (Synology DSM's device id), sealed with AAD
     * `catalog_connection:<id>:remembered`. Dropped with the connection or a new password. Null: none.
     */
    rememberedEnc: text('remembered_enc'),
    /** OAuth kinds. */
    refreshTokenEnc: text('refresh_token_enc'),
    accessTokenEnc: text('access_token_enc'),
    /**
     * When the access token ends: an OAuth or client-credentials token's, a session's (refreshed or signed in again
     * before it). A token kind with no access token (T3 Code, docs/decisions/t3code.md T3-05): when the token itself
     * ends, which nobody renews but the person, with a new pairing code. Null: no known end.
     */
    accessExpiresAt: ts('access_expires_at'),
    /** OAuth kinds: the registered client used (`connection_clients.id`) or the person's own app (null). */
    clientId: text('client_id'),
    /** OAuth kinds: the authorization server's issuer and the MCP resource the token is for. */
    issuer: text('issuer'),
    resource: text('resource'),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    /**
     * OAuth kinds: what a call needed that the service hasn't allowed (its `insufficient_scope`), asked at the next
     * sign-in on top of `scopes`, and dropped once granted.
     */
    scopesWanted: text('scopes_wanted').array().notNull().default(sql`'{}'::text[]`),
    /** Bumped whenever the credential changes, so pooled clients reconnect (CX-32). */
    credentialVersion: integer('credential_version').notNull().default(1),
    /** Who the provider says the credential belongs to (an account name or email), when it says. */
    externalName: text('external_name'),
    status: text('status').$type<CatalogConnectionState>().notNull().default('active'),
    reauthReason: text('reauth_reason').$type<CatalogReauthReason>(),
    checks: jsonb('checks').$type<CatalogCheckResult[]>().notNull().default([]),
    checkedAt: ts('checked_at'),
    toolCount: integer('tool_count').notNull().default(0),
    /** What agents may do with it (connections-setup.md CS-10): `read` refuses every write. */
    access: text('access').$type<ConnectionAccessLevel>().notNull().default('manage'),
    toolsSyncedAt: ts('tools_synced_at'),
    /** The last “needs connecting again” message (CX-15): at most one per 24 hours. */
    repairNotifiedAt: ts('repair_notified_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    /** When a call was last allowed to run, whatever came of it. */
    lastUsedAt: ts('last_used_at'),
    /**
     * When a call of an agent or an automation last worked (`finish_connection_tool`, outcome `done`; migration 0112):
     * Home's “Connected · used today” (`ThingSummary.usedAt`, home-redesign.md HR-45). Null: none yet.
     */
    lastWorkedAt: ts('last_worked_at'),
    /**
     * What the connection health poller last saw (one-whombat-assistant.md, migration 0104): status, a line and a few
     * facts for its tile on Home and in Your things. Null: not looked at yet.
     */
    glance: jsonb('glance').$type<ConnectionGlance>(),
    glanceAt: ts('glance_at'),
    /** The hosts service's check for a Website or address connection. */
    hubCheckId: text('hub_check_id'),
    /** A reading before these probe settings were applied describes a different check. */
    hubCheckChangedAt: ts('hub_check_changed_at'),
    /**
     * What a person said it runs on (connection-pages.md CP-08, migration 0110): `{mode: 'none'}` or a chosen server or
     * guest. Null: Whombat finds it by the connection's address (`things/runs-on.ts`).
     */
    runsOn: jsonb('runs_on').$type<StoredRunsOn | null>(),
    /**
     * A Custom connection's own logo as path shapes, with where it came from (docs/decisions/connection-looks.md).
     * Null: the entry's mark.
     */
    logo: jsonb('logo').$type<StoredLogo | null>(),
    /** A Custom connection's page recipe, the assistant's (connection-looks.md). Null: the generic page. */
    page: jsonb('page').$type<ConnectionPage | null>(),
  },
  (t) => [
    index('catalog_connections_burrow_idx').on(t.burrowId),
    uniqueIndex('catalog_connections_handle_idx').on(t.burrowId, t.handle),
  ],
);

/** A logo kept on a connection: its shapes, where it came from (an address, `mcp`, `site`) and when. */
export interface StoredLogo {
  logo: ThingLogo;
  from: string;
  at: string;
}

/** A person's answer to “What does it run on?” (CP-08): nothing Whombat watches, or a server or one of its guests. */
export type StoredRunsOn = { mode: 'none' } | { mode: 'chosen'; serverId: string; guestId: string | null };

/**
 * 24 hours of figures per connection (connection-pages.md CP-15, migration 0110): the health pass's response time
 * (`rtt_ms`, null when the check failed), UniFi's internet down and up (`wan_rx_mbps`, `wan_tx_mbps`), a device's
 * numeric readings (`r_<key>`). The hourly prune removes older points.
 */
export const connectionPoints = pgTable(
  'connection_points',
  {
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    at: ts('at').notNull(),
    key: text('key').notNull(),
    value: doublePrecision('value'),
  },
  (t) => [
    primaryKey({ name: 'connection_points_pk', columns: [t.connectionId, t.key, t.at] }),
    index('connection_points_at_idx').on(t.at),
  ],
);

/** A connection's tools (CX-18): discovered from its MCP server or defined by its adapter, each with a tier. */
export const connectionTools = pgTable(
  'connection_tools',
  {
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown> | null>(),
    access: text('access').$type<ConnectionToolAccess>().notNull(),
    tier: text('tier').$type<ConnectionToolTier>().notNull(),
    /** Canonical definition hash (an approval binds it, CX-21). */
    hash: text('hash').notNull(),
    isNew: boolean('is_new').notNull().default(false),
    /** Where it came from: `mcp`, `adapter`, `request`. */
    origin: text('origin').notNull(),
    position: integer('position').notNull().default(0),
    /**
     * The person's limits on the tool's arguments (one-whombat-devices.md ONE-DD04, migration 0106): JSON pointers into
     * the arguments with a range, steps or choices, checked before the keys decide (`connections/limits.ts`). Null: none.
     */
    limits: jsonb('limits').$type<ToolLimits | null>(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connection_tools_pk').on(t.connectionId, t.name)],
);

/** OAuth clients registered with an authorization server for MCP sign-in (CX-13, CX-19): one per issuer. */
export const connectionClients = pgTable('connection_clients', {
  id: text('id').primaryKey(),
  issuer: text('issuer').notNull().unique(),
  /** Sealed with AAD `connection_client:<id>`: `{ clientId, clientSecret? }` as JSON. */
  clientEnc: text('client_enc').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  /** `dcr` (dynamic registration) or `metadata` (a client metadata document URL). */
  method: text('method').notNull(),
  registeredAt: ts('registered_at').notNull().defaultNow(),
});

/** A pending OAuth sign-in or Nextcloud login for a catalog connection (CX-11, CX-15): single use, 10 minutes. */
export const connectionPending = pgTable(
  'connection_pending',
  {
    /** The OAuth `state` (or the Nextcloud flow's id). */
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    burrowId: text('burrow_id').references(() => burrows.id, { onDelete: 'cascade' }),
    catalogId: text('catalog_id').notNull(),
    /** A reconnect's connection. */
    connectionId: text('connection_id').references(() => catalogConnections.id, { onDelete: 'cascade' }),
    signIn: text('sign_in').notNull(),
    /** Sealed with AAD `connection_pending:<id>`: verifier, label, fields, issuer, endpoints, the Nextcloud poll token. */
    stateEnc: text('state_enc').notNull(),
    returnPath: text('return_path').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('connection_pending_account_idx').on(t.accountId)],
);

/**
 * Found on your network: a service a manager hid (docs/decisions/connections-setup.md CS-53): the burrow's, by catalog
 * entry and the address it was found at, until someone shows it again.
 */
export const connectionFoundHidden = pgTable(
  'connection_found_hidden',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    catalogId: text('catalog_id').notNull(),
    /** The IPv4 address it was found at. */
    host: text('host').notNull(),
    port: integer('port').notNull(),
    hiddenBy: text('hidden_by').references(() => principals.id, { onDelete: 'set null' }),
    hiddenAt: ts('hidden_at').notNull(),
  },
  (t) => [uniqueIndex('connection_found_hidden_pk').on(t.burrowId, t.catalogId, t.host, t.port)],
);

/**
 * Found on your network as the burrow's own (docs/decisions/desk-found.md DF-02…DF-07, migration 0127): one row per
 * burrow, made by the automatic scans. When its first automatic scan finished (until then the screen shows that scan's
 * progress), when its assistant told the person what was found (once), and when the screen's Not now put the view
 * away (final: the panel and the automatic scans stop).
 */
export const connectionFoundState = pgTable('connection_found_state', {
  burrowId: text('burrow_id')
    .primaryKey()
    .references(() => burrows.id, { onDelete: 'cascade' }),
  firstScanAt: ts('first_scan_at'),
  toldAt: ts('told_at'),
  putAwayAt: ts('put_away_at'),
});
