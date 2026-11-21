/**
 * The Vault (docs/decisions/vault.md): the person's entries, whether each is switched on for the agent
 * (docs/decisions/vault-simplify.md VLT-10), the record of every use and this Whombat's home network list.
 *
 * Everything hangs off the entry: removing it deletes its tools, servers and uses in the same statement
 * (`on delete cascade`). Sealed values are `KeyCustody.seal` with AAD `vault:<entryId>:secret` (VT-04) and never leave
 * the server.
 */
import type { VaultAuth, VaultCheckOutcome, VaultEntryKind, VaultUseOutcome } from '@whombat/core';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { accounts, burrows } from './tenancy';

export const vaultEntries = pgTable(
  'vault_entries',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    /** The person who saved it: their principal in this burrow (backups and the signed log name them). */
    ownerId: text('owner_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** The person's account: an account deleted takes its entries with it. */
    ownerAccountId: text('owner_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<VaultEntryKind>().notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** The server's URL (`mcp`) or the API's base URL (`http`); null for `secret`. */
    url: text('url'),
    /** How it signs in; null for `secret`. */
    auth: jsonb('auth').$type<VaultAuth>(),
    /** `KeyCustody.seal` with AAD `vault:<id>:secret`; null for an `mcp` entry that signs in with `none`. */
    sealed: text('sealed'),
    secretSetAt: ts('secret_set_at'),
    /**
     * A `login` entry's authenticator key (docs/decisions/vault-simplify.md VLT-46): `vaultTotpCanonical` of it, sealed with
     * AAD `vault:<id>:totp`; null: none. `totp_set_at` says since when (migration 0033).
     */
    totpSealed: text('totp_sealed'),
    totpSetAt: ts('totp_set_at'),
    /** `vaultEntryKey(id)`: the middle of its bridged tools' names (`vt_<key>__<tool>`). */
    toolKey: text('tool_key').notNull(),
    /** Random bytes (base64) keying the owner-only detail's hash in signed payloads (VT-D05). */
    detailSalt: text('detail_salt').notNull(),
    checkStatus: text('check_status')
      .$type<'reached' | 'failing' | 'unchecked'>()
      .notNull()
      .default('unchecked'),
    checkOutcome: text('check_outcome').$type<VaultCheckOutcome>(),
    checkSummary: text('check_summary').notNull().default(''),
    checkHttpStatus: integer('check_http_status'),
    checkedAt: ts('checked_at'),
    /** Tools the server listed at the last check (null for `http` and unchecked entries). */
    toolCount: integer('tool_count'),
    toolsIgnored: integer('tools_ignored').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
    /**
     * Switched on for the agent since then (VLT-10): it reaches the agent in the person's turns. Null: off. A `secret`
     * entry is never on.
     */
    agentOnAt: ts('agent_on_at'),
    /**
     * An `http` entry: the environment variable its value is in for the agent's commands (AC-31); null for the other
     * kinds, and until it is first switched on. Kept while it is off, for when it is switched on again.
     */
    envName: text('env_name'),
    /**
     * An `ssh` entry: the servers the agent may sign in to (`vault_ssh_servers.id`s, VT-S07), null for **All servers**
     * (later ones too). A removed server drops out; a list left empty covers nothing. Kept while it is off.
     */
    agentServers: text('agent_servers').array(),
    /**
     * The person's assistant that saved it from their chat (docs/decisions/vault-self-serve.md VS-04, VS-07; migration
     * 0129): what it saved is scrubbed from everything it writes. Null: the owner saved it (or Whombat made it).
     */
    savedById: text('saved_by_id'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('vault_entries_owner_idx').on(t.burrowId, t.ownerId),
    index('vault_entries_tool_key_idx').on(t.burrowId, t.toolKey),
  ],
);

/** An `mcp` entry's tools as its last check listed them (VT-44): on/off, “New”, the definition hash. */
export const vaultTools = pgTable(
  'vault_tools',
  {
    entryId: text('entry_id')
      .notNull()
      .references(() => vaultEntries.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Cleaned and scrubbed (third-party text, VT-40). */
    description: text('description').notNull().default(''),
    /** The input schema as the server listed it (scrubbed), what agents call it with. */
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>(),
    hash: text('hash').notNull(),
    enabled: boolean('enabled').notNull(),
    isNew: boolean('is_new').notNull(),
    /** `vt_<key>__<tool>`, or null when it doesn't fit and is never offered. */
    mcpName: text('mcp_name'),
    position: integer('position').notNull(),
  },
  (t) => [uniqueIndex('vault_tools_name_idx').on(t.entryId, t.name)],
);

/** Every use of an entry (VT-52): RECENT USE and the audit detail. `agent_id` is the agent that used it. */
export const vaultUses = pgTable(
  'vault_uses',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id').notNull(),
    entryId: text('entry_id')
      .notNull()
      .references(() => vaultEntries.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    requesterId: text('requester_id'),
    dispatchId: text('dispatch_id'),
    /**
     * The tool name, `METHOD /path` without the query, “through {pack} {version} · {tool}”, or for an `ssh` entry
     * `ssh {server} · {command}`, `read {server}:{path}`, `write {server}:{path}` (VT-S11).
     */
    what: text('what').notNull(),
    outcome: text('outcome').$type<VaultUseOutcome>().notNull(),
    status: integer('status'),
    /** `ssh` entries: the server's name as it was at the call (VT-S11). */
    server: text('server'),
    /** `ssh_exec`: the command's exit status (null for a signal, a timeout or no run). */
    exitCode: integer('exit_code'),
    ms: integer('ms').notNull().default(0),
    bytes: integer('bytes'),
    eventId: text('event_id'),
    at: ts('at').notNull(),
  },
  (t) => [index('vault_uses_entry_idx').on(t.entryId, t.at), index('vault_uses_event_idx').on(t.eventId)],
);

/**
 * The servers an `ssh` entry's key signs in to (VT-S04, VT-S05), at most 20 per entry. `name` is the handle agents use,
 * unique per entry. The pinned host key (`host_key_*`, set only by the owner's “Trust this server”) is what every
 * connection verifies; `seen_host_key_*` is a key the last check or connection saw that isn't trusted — unknown, or
 * different from the pin — and blocks agents until the owner trusts it. Changing host or port clears both.
 */
export const vaultSshServers = pgTable(
  'vault_ssh_servers',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id').notNull(),
    entryId: text('entry_id')
      .notNull()
      .references(() => vaultEntries.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Canonical (`parseVaultSshHost`): lowercase name, dotted IPv4, IPv6 without brackets. */
    host: text('host').notNull(),
    port: integer('port').notNull(),
    username: text('username').notNull(),
    /** Production (AC-11): agents' computers can't reach it until a person says yes to a command. */
    production: boolean('production').notNull().default(false),
    hostKeyAlgorithm: text('host_key_algorithm'),
    hostKeyFingerprint: text('host_key_fingerprint'),
    hostKeyTrustedAt: ts('host_key_trusted_at'),
    /**
     * The trusted host key itself (base64 wire blob), kept the first time a turn's commands need it for `known_hosts`
     * (agent-computer.md AC-31). Never trusted on its own: used only while its fingerprint is `host_key_fingerprint`.
     */
    hostKeyBlob: text('host_key_blob'),
    seenHostKeyAlgorithm: text('seen_host_key_algorithm'),
    seenHostKeyFingerprint: text('seen_host_key_fingerprint'),
    seenHostKeyAt: ts('seen_host_key_at'),
    checkStatus: text('check_status')
      .$type<'reached' | 'failing' | 'unchecked'>()
      .notNull()
      .default('unchecked'),
    checkOutcome: text('check_outcome').$type<VaultCheckOutcome>(),
    checkSummary: text('check_summary').notNull().default(''),
    checkedAt: ts('checked_at'),
    /**
     * The server's kept password (docs/decisions/vault-simplify.md VLT-42, “Keep the password”; migration 0033): sealed
     * with AAD `vault:<entryId>:server:<id>:password`, null: the commands sign in with the key alone. Only the `server`
     * card sets it; a new host or port forgets it.
     */
    passwordSealed: text('password_sealed'),
    passwordSetAt: ts('password_set_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('vault_ssh_servers_name_idx').on(t.entryId, t.name)],
);

/** This Whombat's home network list (VT-12), kept by the person. */
export const vaultNetworks = pgTable('vault_networks', {
  id: text('id').primaryKey(),
  /** Canonical CIDR (`canonicalCidr`), unique. */
  cidr: text('cidr').notNull().unique(),
  /** Ascending, 1–16. */
  ports: integer('ports').array().notNull(),
  note: text('note').notNull().default(''),
  addedByAccountId: text('added_by_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  addedAt: ts('added_at').notNull(),
});
